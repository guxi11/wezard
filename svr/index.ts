#!/usr/bin/env node
// wezard svr — 独立的 detail 中转服务。部署到 chat + cli 都可达的网络机器上,
// cli/daemon 端把 tool/approval 详情 POST 过来, chat 用户点卡片链接直连本机浏览。
//
// 只有三条业务路由:
//   • POST /d           bearer 鉴权, body = DetailRecord JSON → 存入 store
//   • POST /w           bearer 鉴权, body = 一台 daemon 的注册表快照 (WorldFacts)
//   • GET  /detail?id=  从 store 取, 用 shared/detail-render 渲染 HTML
// 加上 GET /healthz 便于反代/监控探活。
//
// 为什么要 POST /w: turn 记录里只有"谁跑了一轮", 身份 / 家谱 / 工单 / 日程全在
// daemon 那侧的注册表里。没有它, 远端浏览的关系图退化成「名册缺席」, 日程栏更是
// 永远空的 —— 而那恰恰是最该被远程看一眼的东西。快照按**来源机器**分开存: 一个
// svr 可能同时接着几台 daemon, 覆盖式写会让先推的那台凭空消失; 读的时候合并,
// 过了 FACTS_TTL_MS 没再推的来源自动淡出 (那台机器下线了)。
//
// 存储直接复用 daemon 的 createDetailStore (append-only JSONL + LRU + 24h TTL)。
// 信任模型: token 相同 = 可写; 读端不签名 (拿到 id 即可读)。id 是 uuid, 不可枚举。
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdirSync } from "node:fs";
import pino from "pino";
import { expandHome } from "../shared/paths.js";
import { loadOrCreateSvrToken } from "../shared/svr-token.js";
import { createDetailStore, type DetailRecord } from "../shared/detail-store.js";
import { renderDetailPage, renderNotFound } from "../shared/detail-render.js";
import { createChatRoutes, chatRouteTable } from "../shared/chat-http.js";
import { EMPTY_FACTS, type WorldFacts } from "../shared/world.js";
import { resolvePublicHost } from "../shared/lan-ip.js";
import { loadConfig } from "../shared/config.js";

interface Args {
  host: string;
  port: number;
  stateDir: string;
  tokenFile: string;
  token?: string;
  logLevel: pino.Level;
}

// Defaults: config.svr.* > 硬编码兜底。CLI 参数在 parseArgs 里再覆盖上去。
// Config 加载失败 (缺 bot.botId 之类) 不该阻塞 svr 启动 —— svr 与 daemon 解耦。
const buildDefaults = (): Args => {
  const fallback: Args = {
    host: "0.0.0.0",
    port: 17891,
    stateDir: "~/.wezard/svr",
    tokenFile: "~/.wezard/svr-token",
    logLevel: "info",
  };
  try {
    const { config } = loadConfig();
    const s = config.svr;
    return {
      host: s.host || fallback.host,
      port: s.port || fallback.port,
      stateDir: s.stateDir || fallback.stateDir,
      tokenFile: s.tokenFile || fallback.tokenFile,
      token: s.token || undefined,
      logLevel: (s.logLevel as pino.Level) || fallback.logLevel,
    };
  } catch {
    return fallback;
  }
};

const parseArgs = (argv: readonly string[]): Args => {
  const a: Args = buildDefaults();
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = argv[i + 1];
    switch (k) {
      case "--host": a.host = v!; i++; break;
      case "--port": a.port = Number(v!); i++; break;
      case "--state": a.stateDir = v!; i++; break;
      case "--token": a.token = v!; i++; break;
      case "--token-file": a.tokenFile = v!; i++; break;
      case "--log-level": a.logLevel = v! as pino.Level; i++; break;
      case "--help": case "-h":
        printHelp();
        process.exit(0);
    }
  }
  return a;
};

const printHelp = (): void => {
  // eslint-disable-next-line no-console
  console.log(`wezard svr — standalone detail relay

Defaults come from ~/.wezard/config.jsonc (svr.*) when present; CLI overrides.

  --host <ip>        bind address (default 0.0.0.0)
  --port <n>         listen port  (default 17891)
  --state <dir>      state dir    (default ~/.wezard/svr)
  --token <t>        bearer token (default: generate + persist to --token-file)
  --token-file <p>   token persist path (default ~/.wezard/svr-token)
  --log-level <lvl>  pino level   (default info)
`);
};

const readBody = async (req: IncomingMessage): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
};

const json = (res: ServerResponse, status: number, body: unknown): void => {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
};

/** 一份快照从推来到失效的窗口。daemon 每 30s 推一次, 给足三次重试的余量 —— 宁可
 *  多显示两分钟略陈的忙闲, 也好过一次网络抖动就把整张名册抹成「缺席」。 */
const FACTS_TTL_MS = 150_000;

interface FactsPush { source: string; facts: WorldFacts }

const isFactsPush = (v: unknown): v is FactsPush => {
  if (!v || typeof v !== "object") return false;
  const r = v as Record<string, unknown>;
  const f = r.facts as Record<string, unknown> | undefined;
  if (typeof r.source !== "string" || !r.source || !f) return false;
  return Array.isArray(f.wizards) && Array.isArray(f.jobs) && Array.isArray(f.schedules) && !!f.chatNames;
};

/** 几台 daemon 的快照合成一份世界。同一个 key 只可能由它所属的那台机器推出来,
 *  所以合并就是拼接 + 去重 (后来的覆盖, 顺带把同一台机器的重推收敛掉)。 */
const mergeFacts = (fresh: readonly FactsPush[]): WorldFacts => {
  const uniq = <T>(xs: readonly T[], key: (x: T) => string): T[] =>
    [...xs.reduce((m, x) => m.set(key(x), x), new Map<string, T>()).values()];
  return {
    wizards: uniq(fresh.flatMap((p) => [...p.facts.wizards]), (w) => w.target),
    jobs: uniq(fresh.flatMap((p) => [...p.facts.jobs]), (j) => j.id),
    schedules: uniq(fresh.flatMap((p) => [...p.facts.schedules]), (x) => x.id),
    chatNames: Object.assign({}, ...fresh.map((p) => p.facts.chatNames)) as Record<string, string>,
  };
};

const isDetailRecord = (v: unknown): v is DetailRecord => {
  if (!v || typeof v !== "object") return false;
  const r = v as Record<string, unknown>;
  if (typeof r.id !== "string" || !r.id) return false;
  if (r.kind !== "tool" && r.kind !== "approval" && r.kind !== "turn" && r.kind !== "mark" && r.kind !== "chat") return false;
  if (typeof r.createdAt !== "number") return false;
  return true;
};

const main = async (): Promise<void> => {
  const args = parseArgs(process.argv.slice(2));
  const log = pino({ level: args.logLevel, name: "wezard-svr" });
  const stateDir = expandHome(args.stateDir);
  mkdirSync(stateDir, { recursive: true });
  const token = loadOrCreateSvrToken(args.tokenFile, args.token);
  const store = createDetailStore({ stateDir, log });
  // 注册表快照只放内存: 它是 daemon 那边的投影, 重启后下一次推送 (≤30s) 就补齐,
  // 落盘只会换来一份过期名册在冷启动那几十秒里冒充现状。
  const factsBySource = new Map<string, { at: number; facts: WorldFacts }>();
  const currentFacts = (): WorldFacts => {
    const cut = Date.now() - FACTS_TTL_MS;
    const fresh = [...factsBySource].filter(([, v]) => v.at > cut);
    for (const [k] of [...factsBySource].filter(([, v]) => v.at <= cut)) factsBySource.delete(k);
    return fresh.length ? mergeFacts(fresh.map(([source, v]) => ({ source, facts: v.facts }))) : EMPTY_FACTS;
  };
  // Chat 视图 (SPA + JSON API + SSE) 与 daemon 完全同源 —— svr 侧的记录是 POST /d
  // 推过来的, store.subscribe 一样会触发, 所以远端浏览也是实时的。
  const chat = chatRouteTable(createChatRoutes(store, currentFacts));

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    try {
      if (req.method === "GET" && url.pathname === "/healthz") {
        json(res, 200, { ok: true });
        return;
      }
      const chatHandler = chat[`${req.method ?? "GET"} ${url.pathname}`];
      if (chatHandler) { chatHandler(req, res, url); return; }
      if (req.method === "GET" && url.pathname === "/detail") {
        const id = url.searchParams.get("id") ?? "";
        if (!id) {
          res.statusCode = 400;
          res.setHeader("content-type", "text/plain; charset=utf-8");
          res.end("missing ?id=");
          return;
        }
        const rec = store.get(id);
        if (!rec) {
          res.statusCode = 404;
          res.setHeader("content-type", "text/html; charset=utf-8");
          res.end(renderNotFound(id));
          return;
        }
        res.statusCode = 200;
        res.setHeader("content-type", "text/html; charset=utf-8");
        res.setHeader("cache-control", "no-store");
        res.end(renderDetailPage(rec));
        return;
      }
      if (req.method === "POST" && url.pathname === "/w") {
        const auth = req.headers.authorization ?? "";
        if (!auth.startsWith("Bearer ") || auth.slice(7) !== token) {
          json(res, 401, { ok: false, error: "unauthorized" });
          return;
        }
        const body = await readBody(req);
        let parsed: unknown;
        try { parsed = JSON.parse(body.toString("utf8")); }
        catch { json(res, 400, { ok: false, error: "invalid json" }); return; }
        if (!isFactsPush(parsed)) { json(res, 400, { ok: false, error: "invalid world facts" }); return; }
        factsBySource.set(parsed.source, { at: Date.now(), facts: parsed.facts });
        log.debug({ source: parsed.source, wizards: parsed.facts.wizards.length }, "world facts stored");
        json(res, 200, { ok: true });
        return;
      }
      if (req.method === "POST" && url.pathname === "/d") {
        const auth = req.headers.authorization ?? "";
        if (!auth.startsWith("Bearer ") || auth.slice(7) !== token) {
          json(res, 401, { ok: false, error: "unauthorized" });
          return;
        }
        const body = await readBody(req);
        let parsed: unknown;
        try { parsed = JSON.parse(body.toString("utf8")); }
        catch { json(res, 400, { ok: false, error: "invalid json" }); return; }
        if (!isDetailRecord(parsed)) {
          json(res, 400, { ok: false, error: "invalid detail record" });
          return;
        }
        store.put(parsed);
        log.debug({ id: parsed.id, kind: parsed.kind }, "record stored");
        json(res, 200, { ok: true, id: parsed.id });
        return;
      }
      res.statusCode = 404;
      res.end("not found");
    } catch (e) {
      log.error({ err: (e as Error).message }, "handler failed");
      try { json(res, 500, { ok: false, error: (e as Error).message }); } catch { /* ignore */ }
    }
  });

  server.listen(args.port, args.host, () => {
    const displayHost = resolvePublicHost(args.host);
    const base = `http://${displayHost}:${args.port}`;
    // eslint-disable-next-line no-console
    console.log(`[wezard-svr] listening on ${args.host}:${args.port}`);
    // eslint-disable-next-line no-console
    console.log(`[wezard-svr] base URL: ${base}`);
    // eslint-disable-next-line no-console
    console.log(`[wezard-svr] token:    ${token}`);
    // eslint-disable-next-line no-console
    console.log(`\nAdd to ~/.wezard/config.jsonc on every daemon host:
  "daemon": {
    "detailRemoteBase":  "${base}",
    "detailRemoteToken": "${token}"
  }
`);
  });

  const shutdown = (sig: string): void => {
    log.info({ sig }, "shutdown");
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
};

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error("[wezard-svr] fatal:", e);
  process.exit(1);
});
