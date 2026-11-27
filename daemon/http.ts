// Local control HTTP — talks to hooks, slash commands, MCP.
// The control plane is a unix domain socket (daemon.socket, default
// <stateDir>/run/daemon.sock, dir 0700 / socket 0600): the kernel keeps every other uid
// out, which a loopback TCP port never did. Routes that write sensitive state — config,
// allowFrom claims, task files the daemon will execute — and the MCP endpoint /mcp still
// require the daemon token (x-wezard-token, ~/.wezard/daemon-token, 0600): the socket
// stops other users, the token stops a model under the same uid from `curl --unix-socket`
// around an approval card.
// A browser cannot dial a unix socket, so an optional TCP listener (daemon.host/port)
// stays — but it only mounts the read-only view routes (rolepage / detail / healthz);
// everything else answers 410 there.
// Endpoints intentionally tiny & sync-friendly.
import { existsSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { URL, fileURLToPath } from "node:url";
import type { Logger } from "pino";
import type { Config } from "../shared/config.js";
import { CHAT_ROUTE_KEYS } from "../shared/chat-http.js";
import { daemonSocketPath } from "../shared/daemon-addr.js";
import { expandHome } from "../shared/paths.js";
import type { DaemonWs } from "./ws.js";
import { bindControlSocket, unlinkIfOwned, stillOwns, type BoundSocket } from "./control-socket.js";
import { drainForReload, listPending } from "./pending.js";
import { listenWithFallback, portsFileOf, writePorts, type PortEntry } from "../shared/ports.js";

interface Ctx {
  cfg: Config;
  ws: DaemonWs;
  log: Logger;
  sourcePath: string;
  /** room 切换后的增量状态 (openDuties / watchdog), index.ts 在 room 模块就绪后改写 get; /status 展开它。 */
  roomStatus?: { get: () => Record<string, unknown> };
  /** 视图监听的结局: 实际口, 或 null (port=0 / 全被占 / 别的错)。链接根据它取口 (见 detail.ts setViewPort)。 */
  onView?: (port: number | null) => void;
  /** 事件循环延迟 (daemon/loop-lag.ts); /status 展开成 eventLoopLagMs。缺省 = 不报。 */
  loopLag?: { snapshot: () => { p99: number; max: number; maxSinceBoot: number; maxAt: number; sampledAt: number } };
}

/** 外部调用方的能力判据 (/status): 按名字查有没有, 别靠盘上目录之类的副作用猜。 */
const CAPABILITIES = ["dispatch.taskFile"] as const;

// 加载时读一次: 报的是正在跑的这份代码的版本, 不是盘上刚 pull 下来的。源码跑 daemon/ → ../,
// 编译后与 npm 安装 dist/daemon/ → ../../ (同 web-assets 的双候选)。
const HERE = dirname(fileURLToPath(import.meta.url));
const VERSION = ((): string => {
  const p = [join(HERE, "..", "package.json"), join(HERE, "..", "..", "package.json")].find(existsSync);
  try { return p ? String(JSON.parse(readFileSync(p, "utf8")).version ?? "") : ""; } catch { return ""; }
})();

// 此刻还在跑的路由 (key → 开始时刻)。事件循环被堵时, 嫌疑人几乎总在这张表里 —— loop-lag 告警带它出来。
// MCP 工具走回环, 所以 `POST /mcp` 旁边会并排出现它真正调的那条路由 (如 POST /wizard/roster)。
const inflight = new Map<symbol, { key: string; at: number }>();
export const inflightRoutes = (now = Date.now()): string[] =>
  [...inflight.values()].sort((a, b) => a.at - b.at).slice(0, 12).map((r) => `${r.key} ${now - r.at}ms`);

type Handler = (req: IncomingMessage, res: ServerResponse, url: URL, ctx: Ctx) => Promise<void> | void;

const json = (res: ServerResponse, status: number, body: unknown): void => {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
};

const readBody = async (req: IncomingMessage): Promise<unknown> => {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return {};
  }
};

/** /status 的响应体 (抽出来给单测: 修复单 §4 的 openDuties / watchdog 增量在这里并进来)。 */
export const statusBody = (
  cfg: Config,
  ws: DaemonWs,
  sourcePath: string,
  roomStatus?: { get: () => Record<string, unknown> },
  loopLag?: Ctx["loopLag"],
): Record<string, unknown> => {
  return {
    ok: true,
    version: VERSION,
    capabilities: CAPABILITIES,
    wsConnected: ws.client.isConnected,
    ws: ws.status(),
    backend: cfg.wrc.defaultCli,
    botId: cfg.bot.botId,
    defaultChat: cfg.defaultChat,
    pending: listPending().length,
    uptimeSec: Math.round(process.uptime()),
    sourcePath,
    socket: daemonSocketPath(cfg),
    logFile: expandHome(cfg.daemon.logFile),
    // room 模型增量 (修复单 §4): openDuties = 全部 room 未结 duty 总数 (pending 是审批卡, 别混);
    // watchdog = { failStreak, lastScanAt } — O1 拿它判「看门狗活着且没停摆」。
    ...(roomStatus ? roomStatus.get() : {}),
    // 事件循环延迟 (ms): p99 / max 是最近一个采样窗口, maxSinceBoot 是开机以来最大的单发停顿。
    ...(loopLag ? { eventLoopLagMs: loopLag.snapshot() } : {}),
  };
};

const routes: Record<string, Handler> = {
  "GET /healthz": (_req, res, _url, { ws }) => {
    json(res, 200, { ok: true, wsConnected: ws.client.isConnected });
  },
  "GET /status": (_req, res, _url, { cfg, ws, sourcePath, roomStatus, loopLag }) => {
    json(res, 200, statusBody(cfg, ws, sourcePath, roomStatus, loopLag));
  },
  "GET /pending": (_req, res) => {
    json(res, 200, { pending: listPending() });
  },
  "POST /reconnect": (_req, res, _url, { ws }) => {
    ws.reconnect("manual reconnect via CLI");
    json(res, 200, { ok: true, ws: ws.status() });
  },
  "POST /shutdown": async (_req, res, _url, { ws, log }) => {
    json(res, 200, { ok: true });
    log.info("shutdown via HTTP");
    // 先了结长轮询再退: 硬杀 socket 会让 hook 走 fallback (本地弹权限框),
    // drain 则把「稍后带 req_id 重来」告诉 hook, 卡片不失效。
    log.info(drainForReload(), "pending drained for reload");
    await ws.shutdown();
    // 200ms 给 drain 的 reject 回调把各自的 HTTP 响应刷出去。
    setTimeout(() => process.exit(0), 200);
  },
  // /approve and /message are wired by callers later (approval, slash).
};

export interface HttpServer {
  close: () => Promise<void>;
  /** Register additional routes after construction (e.g. /approve once approval module loads). */
  register: (key: string, handler: Handler) => void;
  /** 控制面 socket 已绑好; 绑不上 (活 daemon 在听 / 目录不对 / 路径超长) 则 reject —— 调用方应报错退出。 */
  ready: Promise<void>;
  socketPath: string;
}

/** 浏览器视图能碰的路由: rolepage 一族 + 详情页 + 探活。其余一律不在 TCP 上服务。 */
const VIEW_ROUTES: ReadonlySet<string> = new Set([...CHAT_ROUTE_KEYS, "GET /detail", "GET /healthz"]);

const movedReason = (sock: string): string =>
  `wezard 控制面已迁到 unix socket (${sock}); 这个会话起于旧版, 需要重开 (daemon 会在它空闲时自动回收, 下一句话 --resume 重起)`;

/** JSON-RPC 版的同一句话: 旧 http MCP 客户端按 id 收到明确原因, 而不是静默超时 (通知没有 id → 202 空体)。 */
const rpcMoved = (body: unknown, sock: string): unknown => {
  const err = (id: unknown) => ({ jsonrpc: "2.0", id, error: { code: -32000, message: movedReason(sock) } });
  const one = (m: unknown): unknown =>
    m && typeof m === "object" && "id" in m ? err((m as { id: unknown }).id) : undefined;
  return Array.isArray(body) ? body.map(one).filter((x) => x !== undefined) : one(body);
};

/** 视图端口上的非视图路由: 410; POST /mcp 回 JSON-RPC error (HTTP 200, 免得 MCP 客户端只报「传输失败」吞掉原因)。 */
const refuseOnView = async (req: IncomingMessage, res: ServerResponse, key: string, sock: string): Promise<void> => {
  if (key === "POST /mcp") {
    const out = rpcMoved(await readBody(req), sock);
    if (out === undefined || (Array.isArray(out) && out.length === 0)) { res.statusCode = 202; res.end(); return; }
    json(res, 200, out);
    return;
  }
  json(res, 410, { ok: false, reason: movedReason(sock) });
};

export const startHttp = (ctx: Ctx): HttpServer => {
  const dynamic = new Map<string, Handler>();
  const socketPath = daemonSocketPath(ctx.cfg);
  // 进程内 MCP (mcp/tools.ts 的 daemonPost 回打自己) 与 daemon 起的子进程都读它。
  process.env.WEZARD_DAEMON_SOCK = socketPath;

  /** viewOnly: TCP 视图监听 —— 只放行 VIEW_ROUTES, 其余 410。 */
  const listener = (viewOnly: boolean) => async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const key = `${req.method ?? "GET"} ${url.pathname}`;
    if (viewOnly && !VIEW_ROUTES.has(key)) {
      await refuseOnView(req, res, key, socketPath);
      return;
    }
    const handler = dynamic.get(key) ?? routes[key];
    if (!handler) {
      json(res, 404, { error: "not_found", route: key });
      return;
    }
    const token = Symbol(key);
    inflight.set(token, { key, at: Date.now() });
    try {
      await handler(req, res, url, ctx);
    } catch (e) {
      ctx.log.error({ err: (e as Error).message, route: key }, "http handler failed");
      if (!res.headersSent) json(res, 500, { error: "internal", message: (e as Error).message });
    } finally {
      inflight.delete(token);
    }
  };

  const control = createServer(listener(false));
  const view = createServer(listener(true));
  let bound: BoundSocket | undefined;
  let viewUp = false;

  // 视图监听失败 (端口被别人占了 / 没权限) 不致命: 控制面照常, 第二个用户不再崩溃循环。
  // 被占就 +1 再试 (daemon.portSpan); 实际口写进 ports.json —— 链接与本机工具都以它为准, 不再信配置口。
  const portsFile = portsFileOf(ctx.cfg.daemon.stateDir);
  const settleView = (entry: PortEntry | null): void => {
    try { writePorts(portsFile, { view: entry }); }
    catch (e) { ctx.log.warn({ file: portsFile, err: (e as Error).message }, "ports.json write failed"); }
    ctx.onView?.(entry ? entry.port : null);
  };
  const startView = async (): Promise<void> => {
    const { host, port, portSpan } = ctx.cfg.daemon;
    if (port === 0) {
      ctx.log.info("view listener disabled (daemon.port=0)");
      settleView(null);
      return;
    }
    const r = await listenWithFallback(view, host, port, portSpan);
    if (!r.ok) {
      ctx.log.warn({ host, port, tried: r.tried, code: r.code, err: r.message }, "view listener disabled");
      settleView(null);
      return;
    }
    viewUp = true;
    ctx.log.info({ host, port: r.port, ...(r.port !== port ? { preferred: port } : {}) }, "view listening (read-only)");
    settleView({ host, port: r.port, pid: process.pid, at: Date.now() });
  };

  const ready = bindControlSocket(control, socketPath).then((b) => {
    bound = b;
    ctx.log.info({ socket: socketPath }, "HTTP listening (control socket)");
    void startView();
  });

  const closeServer = (s: Server, listening: boolean): Promise<void> =>
    new Promise<void>((resolve) => (listening ? s.close(() => resolve()) : resolve()));

  return {
    close: async () => {
      // libuv 关 pipe server 时无条件 unlink 路径: 路径上已是接手者的 inode 就别 close,
      // 进程马上退出, 内核会回收 fd; 否则正常 close 后再兜一次 (幂等)。
      const owns = bound ? stillOwns(bound) : false;
      await Promise.all([closeServer(control, owns), closeServer(view, viewUp)]);
      if (bound) unlinkIfOwned(bound);
    },
    register: (key, handler) => dynamic.set(key, handler),
    ready,
    socketPath,
  };
};

export type { Handler, Ctx };
export { readBody, json };
