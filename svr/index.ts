#!/usr/bin/env node
// wezard svr — 独立的 detail 中转服务。部署到 chat + cli 都可达的网络机器上,
// cli/daemon 端把 tool/approval 详情 POST 过来, chat 用户点卡片链接直连本机浏览。
//
// 只有两条业务路由:
//   • POST /d           bearer 鉴权, body = DetailRecord JSON → 存入 store
//   • GET  /detail?id=  从 store 取, 用 shared/detail-render 渲染 HTML
// 加上 GET /healthz 便于反代/监控探活。
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

const isDetailRecord = (v: unknown): v is DetailRecord => {
  if (!v || typeof v !== "object") return false;
  const r = v as Record<string, unknown>;
  if (typeof r.id !== "string" || !r.id) return false;
  if (r.kind !== "tool" && r.kind !== "approval" && r.kind !== "turn" && r.kind !== "mark") return false;
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
  // Chat 视图 (SPA + JSON API + SSE) 与 daemon 完全同源 —— svr 侧的记录是 POST /d
  // 推过来的, store.subscribe 一样会触发, 所以远端浏览也是实时的。
  const chat = chatRouteTable(createChatRoutes(store));

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
