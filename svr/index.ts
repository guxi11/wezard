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
// 为什么要 POST /w: turn 记录里只有"谁跑了一轮", 身份 / 家谱 / plans / 日程全在
// daemon 那侧的注册表里。没有它, 远端浏览的关系图退化成「名册缺席」, 日程栏更是
// 永远空的 —— 而那恰恰是最该被远程看一眼的东西。快照按**来源机器**分开存: 一个
// svr 可能同时接着几台 daemon, 覆盖式写会让先推的那台凭空消失; 读的时候合并,
// 过了 FACTS_TTL_MS 没再推的来源自动淡出 (那台机器下线了)。
//
// 存储直接复用 daemon 的 createDetailStore (append-only JSONL + LRU + 24h TTL)。
// 信任模型: token 相同 = 可写; 读端不签名 (拿到 id 即可读)。id 是 uuid, 不可枚举。
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import pino from "pino";
import { expandHome } from "../shared/paths.js";
import { loadOrCreateSvrToken } from "../shared/svr-token.js";
import { createDetailStore, type DetailRecord } from "../shared/detail-store.js";
import { renderDetailPage, renderNotFound } from "../shared/detail-render.js";
import { createChatRoutes, chatRouteTable, HORIZON_MS, type RoomReader } from "../shared/chat-http.js";
import { applyOp, emptyRoom, type RoomOp, type RoomState } from "../shared/room.js";
import { openSeenLog } from "../shared/seen-log.js";
import { EMPTY_FACTS, type WorldFacts } from "../shared/world.js";
import { resolvePublicHost } from "../shared/lan-ip.js";
import { loadFacts, saveFacts } from "./facts-store.js";
import { loadConfig } from "../shared/config.js";
import { bindMultiBot } from "../shared/session-label.js";
import { roomsDirOf } from "../shared/room.js";
import { canonicalDir } from "../shared/instance-id.js";
import { DEFAULT_PORT_SPAN, EXIT_CONFIG, listenWithFallback, portsFileOf, writePorts } from "../shared/ports.js";

interface Args {
  host: string;
  port: number;
  /** 首选口被占时往上再试几个 (见 shared/ports.ts)。 */
  portSpan: number;
  stateDir: string;
  /** daemon 的 room 账本目录 (只读)。同机部署时 svr 直接读它, 远端浏览器才点得开 room 历史。 */
  roomsDir: string;
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
    portSpan: DEFAULT_PORT_SPAN,
    stateDir: "~/.wezard/svr",
    roomsDir: "~/.wezard/state/rooms",
    tokenFile: "~/.wezard/svr-token",
    logLevel: "info",
  };
  try {
    const { config } = loadConfig();
    // 多机器人隔离 (内部会话不归任何机器人): 与 daemon 同一份配置才对得上。
    bindMultiBot(config.bots.length > 0);
    const s = config.svr;
    return {
      host: s.host || fallback.host,
      port: s.port || fallback.port,
      portSpan: s.portSpan ?? fallback.portSpan,
      stateDir: s.stateDir || fallback.stateDir,
      // 账本目录跟着同一份配置里 daemon 的 stateDir 走 (以前写死 ~/.wezard/state/rooms, daemon 换了 stateDir 就读空)。
      roomsDir: process.env.WEZARD_ROOMS_DIR || s.roomsDir || roomsDirOf(config.daemon.stateDir),
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
      case "--port-span": a.portSpan = Number(v!); i++; break;
      case "--state": a.stateDir = v!; i++; break;
      case "--rooms": a.roomsDir = v!; i++; break;
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
  --port-span <n>    port taken → try +1 … +n (default ${DEFAULT_PORT_SPAN}); all taken → exit ${EXIT_CONFIG}
  --state <dir>      state dir    (default ~/.wezard/svr)
  --rooms <dir>      daemon 的 room 账本 (只读, default <daemon.stateDir>/rooms)
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

/** roomsDir: 推送方 daemon 的账本目录 (规范路径) —— 与本 svr 读的那份对上, 才把本地账本给它的票据用。 */
interface FactsPush { source: string; facts: WorldFacts; roomsDir?: string }

const isFactsPush = (v: unknown): v is FactsPush => {
  if (!v || typeof v !== "object") return false;
  const r = v as Record<string, unknown>;
  const f = r.facts as Record<string, unknown> | undefined;
  if (typeof r.source !== "string" || !r.source || !f) return false;
  return Array.isArray(f.wizards) && Array.isArray(f.plans) && Array.isArray(f.schedules) && !!f.chatNames;
};

/** 几台 daemon 的快照合成一份世界。同一个 key 只可能由它所属的那台机器推出来,
 *  所以合并就是拼接 + 去重 (后来的覆盖, 顺带把同一台机器的重推收敛掉)。 */
const mergeFacts = (fresh: readonly FactsPush[]): WorldFacts => {
  const uniq = <T>(xs: readonly T[], key: (x: T) => string): T[] =>
    [...xs.reduce((m, x) => m.set(key(x), x), new Map<string, T>()).values()];
  return {
    wizards: uniq(fresh.flatMap((p) => [...p.facts.wizards]), (w) => w.target),
    plans: uniq(fresh.flatMap((p) => [...p.facts.plans]), (plan) => plan.id),
    schedules: uniq(fresh.flatMap((p) => [...p.facts.schedules]), (x) => x.id),
    chatNames: Object.assign({}, ...fresh.map((p) => p.facts.chatNames)) as Record<string, string>,
    // 人名 / 微信 / room 账本快照 / 名字表 / 类表 —— 合并时被整个丢掉就等于远端没有这些面。
    ...(fresh.some((p) => p.facts.humanNames) ? { humanNames: Object.assign({}, ...fresh.map((p) => p.facts.humanNames ?? {})) } : {}),
    ...(fresh.some((p) => p.facts.weixin?.length) ? { weixin: uniq(fresh.flatMap((p) => [...(p.facts.weixin ?? [])]), (x) => x.base) } : {}),
    // room 快照按 id 去重: 同一个 room 只可能由它所在的那台机器推出来。
    ...(fresh.some((p) => p.facts.rooms?.length) ? { rooms: uniq(fresh.flatMap((p) => [...(p.facts.rooms ?? [])]), (r) => r.id) } : {}),
    ...(fresh.some((p) => p.facts.names) ? { names: Object.assign({}, ...fresh.map((p) => p.facts.names ?? {})) } : {}),
    ...(fresh.some((p) => p.facts.classes?.length) ? { classes: uniq(fresh.flatMap((p) => [...(p.facts.classes ?? [])]), (c) => c.id) } : {}),
  };
};

const isDetailRecord = (v: unknown): v is DetailRecord => {
  if (!v || typeof v !== "object") return false;
  const r = v as Record<string, unknown>;
  if (typeof r.id !== "string" || !r.id) return false;
  if (r.kind !== "tool" && r.kind !== "approval" && r.kind !== "turn" && r.kind !== "mark" && r.kind !== "post" && r.kind !== "chat" && r.kind !== "charter") return false;
  if (typeof r.createdAt !== "number") return false;
  return true;
};

/** 只读的 room 账本读者: 每次现读文件, 不吃缓存 —— daemon 那边一直在追加, 缓存会看到旧快照。
 *  serves: 多 daemon 共 svr 时这份账本只属于其中一个, 别的 daemon 的票据只看它们推来的 rooms 快照。 */
const roomReaderAt = (dir: string, serves?: RoomReader["serves"]): RoomReader => ({
  ...(serves ? { serves } : {}),
  ids: () => {
    try {
      return readdirSync(dir).filter((f) => f.endsWith(".jsonl"))
        .map((f) => decodeURIComponent(f.slice(0, -6)));
    } catch { return []; }
  },
  get: (id: string): RoomState | undefined => {
    let raw: string;
    try { raw = readFileSync(join(dir, encodeURIComponent(id) + ".jsonl"), "utf8"); }
    catch { return undefined; }
    // 撕裂的尾行 (daemon 写一半) 丢掉; 中段坏行也不该让整张图消失 (这是只读视图)。
    let st = emptyRoom(id);
    for (const ln of raw.split("\n")) {
      if (!ln.trim()) continue;
      try { st = applyOp(st, JSON.parse(ln) as RoomOp); } catch { /* 坏行跳过 */ }
    }
    return st;
  },
});

const main = async (): Promise<void> => {
  const args = parseArgs(process.argv.slice(2));
  const log = pino({ level: args.logLevel, name: "wezard-svr" });
  const stateDir = expandHome(args.stateDir);
  mkdirSync(stateDir, { recursive: true });
  const token = loadOrCreateSvrToken(args.tokenFile, args.token);
  const store = createDetailStore({ stateDir, log });
  // 注册表快照落盘 (facts.json) 并在启动时按 TTL 读回: 否则每次重启后名册 / 关系图要空
  // 到 daemon 下一次推送 (≤30s)。只读回 at 仍在 FACTS_TTL_MS 内的条目, 刚重启时快照
  // 最多旧 30s, 与平时一样新; 停机久了的自然过期, 不会让陈旧名册冒充现状。
  const factsPath = join(stateDir, "facts.json");
  const factsBySource = loadFacts(factsPath, Date.now(), FACTS_TTL_MS);
  // src = 票据的来源 daemon: 只给它自己那一份 (没推过 / 过期了 = 缺席, 不拿别的 daemon 的名册顶上 ——
  // 同机多 daemon 的 target / room id / 名字可能相同, 合并会互相覆盖)。没有 src 的票据 (旧 daemon 签的) 看合并视图。
  const currentFacts = (src?: string): WorldFacts => {
    const cut = Date.now() - FACTS_TTL_MS;
    for (const [k] of [...factsBySource].filter(([, v]) => v.at <= cut)) factsBySource.delete(k);
    const fresh = [...factsBySource].filter(([k]) => !src || k === src);
    return fresh.length ? mergeFacts(fresh.map(([source, v]) => ({ source, facts: v.facts }))) : EMPTY_FACTS;
  };
  // Chat 视图 (SPA + JSON API + SSE) 与 daemon 完全同源 —— svr 侧的记录是 POST /d
  // 推过来的, store.subscribe 一样会触发, 所以远端浏览也是实时的。
  // 已读记录与消息同住 stateDir, 留到视界为止 (再早的话页面上已经看不到)。
  const roomsDir = expandHome(args.roomsDir);
  // 本地账本归谁: 报来的 roomsDir 与它相同的那个来源。还没有任何来源报过 (旧 daemon / 刚重启) 时谁都给 —— 单 daemon 的老行为。
  const ledgerHome = canonicalDir(roomsDir);
  const ledgerServes = (src: string | undefined): boolean => {
    const owners = [...factsBySource].filter(([, v]) => v.roomsDir).map(([k, v]) => [k, v.roomsDir === ledgerHome] as const);
    return !src || !owners.length || owners.some(([k, mine]) => k === src && mine);
  };
  const chat = chatRouteTable(createChatRoutes(store, currentFacts, openSeenLog(join(stateDir, "seen.json"), HORIZON_MS), roomReaderAt(roomsDir, ledgerServes)));

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
        factsBySource.set(parsed.source, { at: Date.now(), facts: parsed.facts, ...(typeof parsed.roomsDir === "string" && parsed.roomsDir ? { roomsDir: parsed.roomsDir } : {}) });
        try { saveFacts(factsPath, factsBySource); }
        catch (e) { log.warn({ err: (e as Error).message }, "persist world facts failed"); }
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

  // 首选口被占就 +1 再试; 全被占 = 配置问题, 再重拉也一样: 一行原因 + 退出码 78, systemd 单元
  // RestartPreventExitStatus=78 停止重拉 (以前是无 error 监听的 listen 崩掉, 每 5s 一次崩溃循环)。
  // launchd 的 KeepAlive 不认退出码 (SuccessfulExit=false 时任何非 0 都重拉), 在它下面以 0 退出。
  const r = await listenWithFallback(server, args.host, args.port, args.portSpan);
  const portsFile = portsFileOf(stateDir);
  if (!r.ok) {
    const last = Math.min(65535, args.port + Math.max(0, args.portSpan));
    // eslint-disable-next-line no-console
    console.error(`[wezard-svr] cannot listen on ${args.host}:${args.port}${last > args.port ? `..${last}` : ""} (${r.code}: ${r.message}); free a port or change svr.port / svr.portSpan`);
    try { writePorts(portsFile, { svr: null }); } catch { /* 起不来时写不了也无妨 */ }
    process.exit(process.env.XPC_SERVICE_NAME && process.env.XPC_SERVICE_NAME !== "0" ? 0 : EXIT_CONFIG);
  }
  const port = r.port;
  try { writePorts(portsFile, { svr: { host: args.host, port, pid: process.pid, at: Date.now() } }); }
  catch (e) { log.warn({ file: portsFile, err: (e as Error).message }, "ports.json write failed"); }
  {
    const displayHost = resolvePublicHost(args.host);
    const base = `http://${displayHost}:${port}`;
    if (port !== args.port) log.warn({ preferred: args.port, port }, "preferred port taken, listening on the next free one");
    // eslint-disable-next-line no-console
    console.log(`[wezard-svr] listening on ${args.host}:${port}`);
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
  }

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
