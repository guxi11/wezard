// Wraps @wecom/aibot-node-sdk WSClient. Pure construction + event wiring;
// outbound helpers (text/card) live in `outbound.ts`.
import {
  WSClient,
  WSAuthFailureError,
  WSReconnectExhaustedError,
  type Logger as SdkLogger,
} from "@wecom/aibot-node-sdk";
import type { Logger } from "pino";
import type { Config } from "../shared/config.js";

// SCENE is a numeric channel tag assigned by WeCom for telemetry;
// 0 = generic / unbranded.
const SCENE = 0;
const PLUG_VERSION = "0.0.1";
const HEARTBEAT_MS = 30_000;
// -1 = SDK 原生无限重连 (指数退避封顶 reconnectMaxDelay 30s)。给有限次数是陷阱:
// Mac 睡眠唤醒 / 切网时 DNS 会短暂 ENOTFOUND, 10 次重连累计只撑约 2 分钟就耗尽,
// 此后 SDK 抛 WSReconnectExhaustedError 便彻底躺平 —— 进程活着、HTTP 端口通, 但对
// WeCom 完全失聪, 发不出卡也收不到点击。实测踩到过一次: 笔记本合盖过夜, 次日 DNS 早已
// 恢复, 但 daemon 已耗尽重连额度躺平, 一条等审批的 hook 就这么挂了 9 小时。
// 两个边界不受此值影响: 认证失败走独立的 MAX_AUTH_FAIL 计数器仍 fail-fast; 被服务端
// 踢下线 (别处建了新连接) SDK 置 isManualClose 后本就不重连, 不会两个 daemon 互抢。
const MAX_RECONNECT = -1;
const MAX_AUTH_FAIL = 5;
// SDK 的 connect() 只挂 open/message/close/error 四个回调, 不设握手超时。睡眠唤醒后
// 那条 socket 常是黑洞: TCP 连得上但 upgrade 响应永不返回, 四个回调一个都不触发,
// scheduleReconnect() 再无机会被调用 —— 心跳定时器要认证成功才启动, 也兜不住。
// 于是重连链停在 "Connecting to WebSocket..." 一行上永久静默: 进程活着、HTTP 端口通、
// hook 照常判权限, 但对 WeCom 失聪。2026-08-12 就这么挂了 3 小时, 期间一张审批卡发不出去。
// 注意这跟上面 MAX_RECONNECT 修的不是同一件事: 那个防的是"重连次数耗尽后躺平",
// 这个是第 1 次重连就悬挂, 无限重连救不了单次握手卡死。
// ws 库拿 handshakeTimeout 当 req 的 idle timeout, 超时走 abortHandshake ->
// emitErrorAndClose -> emit 'close' -> SDK close 回调 -> scheduleReconnect, 链路续上。
const HANDSHAKE_TIMEOUT_MS = 15_000;
// SDK 只拿它当媒体下载 (axios) 的超时; 默认 10s 下大图/慢链路时常超时, 图就被丢了。
const MEDIA_TIMEOUT_MS = 60_000;
// ws.handshakeTimeout is an idle timeout, not a deadline for DNS + TLS + auth.
const CONNECT_DEADLINE_MS = 30_000;

const sdkLogger = (log: Logger, onConnect: () => void): SdkLogger => ({
  debug: (msg, ...a) => log.debug({ a }, String(msg)),
  info: (msg, ...a) => {
    if (String(msg).startsWith("Connecting to WebSocket:")) onConnect();
    log.info({ a }, String(msg));
  },
  warn: (msg, ...a) => log.warn({ a }, String(msg)),
  error: (msg, ...a) => log.error({ a }, String(msg)),
});

export interface DaemonWs {
  client: WSClient;
  /** resolves on first authenticated; rejects on fatal auth/reconnect failure */
  ready: Promise<void>;
  /** tear down + rebuild the socket in place (e.g. after a network switch) */
  reconnect: (reason: string) => void;
  shutdown: () => Promise<void>;
  status: () => WsStatus;
}

export interface WsStatus {
  phase: "connecting" | "authenticating" | "authenticated" | "reconnecting" | "failed" | "kicked" | "stopped";
  authenticated: boolean;
  reconnectAttempts: number;
  lastError?: string;
  lastErrorAt?: string;
  authenticatedAt?: string;
}

export const startWs = (cfg: Config, log: Logger): DaemonWs => {
  const { bot } = cfg;
  log.info({ botId: bot.botId, ws: bot.websocketUrl }, "WS init");
  let state: WsStatus = { phase: "connecting", authenticated: false, reconnectAttempts: 0 };
  let connectTimer: NodeJS.Timeout | undefined;
  let cancelRestart: (() => void) | undefined;
  const clearConnectDeadline = (): void => { clearTimeout(connectTimer); connectTimer = undefined; };
  const recordError = (message: string): void => {
    state = { ...state, lastError: message, lastErrorAt: new Date().toISOString() };
  };
  const onConnect = (): void => {
    state = { ...state, phase: "connecting", authenticated: false };
    clearConnectDeadline();
    connectTimer = setTimeout(() => {
      const reason = "WebSocket DNS/TLS/authentication exceeded 30s";
      recordError(reason);
      reconnect(reason);
    }, CONNECT_DEADLINE_MS);
    connectTimer.unref();
  };

  const client = new WSClient({
    botId: bot.botId,
    secret: bot.secret,
    wsUrl: bot.websocketUrl,
    logger: sdkLogger(log, onConnect),
    heartbeatInterval: HEARTBEAT_MS,
    maxReconnectAttempts: MAX_RECONNECT,
    maxAuthFailureAttempts: MAX_AUTH_FAIL,
    wsOptions: { handshakeTimeout: HANDSHAKE_TIMEOUT_MS },
    requestTimeout: MEDIA_TIMEOUT_MS,
    scene: SCENE,
    plug_version: PLUG_VERSION,
  });

  let resolveReady!: () => void;
  let rejectReady!: (e: Error) => void;
  const ready = new Promise<void>((res, rej) => {
    resolveReady = res;
    rejectReady = rej;
  });

  client.on("connected", () => {
    state = { ...state, phase: "authenticating", authenticated: false };
    log.info("WS connected");
  });
  client.on("authenticated", () => {
    clearConnectDeadline();
    state = { phase: "authenticated", authenticated: true, reconnectAttempts: 0, authenticatedAt: new Date().toISOString() };
    log.info("WS authenticated");
    resolveReady();
  });
  client.on("disconnected", (reason) => {
    clearConnectDeadline();
    if (!["kicked", "stopped", "failed"].includes(state.phase)) state = { ...state, phase: "reconnecting", authenticated: false };
    log.warn({ reason }, "WS disconnected");
  });
  client.on("reconnecting", (attempt) => {
    state = { ...state, phase: "reconnecting", authenticated: false, reconnectAttempts: attempt };
    log.info({ attempt }, "WS reconnecting");
  });
  client.on("error", (err) => {
    recordError(err.message);
    log.error({ err: err.message, kind: err.constructor.name }, "WS error");
    if (err instanceof WSAuthFailureError || err instanceof WSReconnectExhaustedError) {
      clearConnectDeadline();
      state = { ...state, phase: "failed", authenticated: false };
      rejectReady(err);
    }
  });
  client.on("event.disconnected_event", () => {
    cancelRestart?.();
    clearConnectDeadline();
    state = { ...state, phase: "kicked", authenticated: false };
    recordError("Another client connected using this bot; automatic reconnect suppressed");
    log.error("WS kicked by server (new connection elsewhere); auto-restart suppressed");
    client.disconnect();
  });

  // 切网后旧 socket 大概率黑洞化: SDK 心跳要连续 miss 数个 30s 周期才判死,
  // HANDSHAKE_TIMEOUT 只兜 connect 阶段, 兜不了已建立连接的静默死亡。强制
  // 原地重建把恢复时间压到秒级。顺序不可颠倒: started=true 时 connect() 是
  // no-op, 必须先 disconnect() (置 started=false + 杀旧 socket + 清重连定时器)。
  const reconnect = (reason: string): void => {
    if (cancelRestart) return;
    clearConnectDeadline();
    state = { ...state, phase: "connecting", authenticated: false };
    log.warn({ reason }, "WS force reconnect");
    // SDK disconnect() terminates asynchronously. Its old close callback clears
    // wsManager.ws; reconnecting before that callback would erase the NEW socket
    // and start a second connection (then WeCom kicks us for duplicate logins).
    let cancelled = false;
    const cleanup = (): void => {
      clearTimeout(waitClose);
      client.off("disconnected", onClosed);
    };
    const onClosed = (): void => {
      cleanup();
      setImmediate(() => {
        if (cancelled) return;
        cancelRestart = undefined;
        client.connect();
      });
    };
    const waitClose = setTimeout(onClosed, 1000); // no old socket during backoff
    cancelRestart = (): void => { cancelled = true; cleanup(); cancelRestart = undefined; };
    client.once("disconnected", onClosed);
    try {
      client.disconnect();
    } catch (e) {
      log.warn({ err: (e as Error).message }, "disconnect threw");
    }
  };

  const shutdown = async (): Promise<void> => {
    cancelRestart?.();
    clearConnectDeadline();
    state = { ...state, phase: "stopped", authenticated: false };
    log.info("WS shutdown");
    try {
      client.disconnect();
    } catch (e) {
      log.warn({ err: (e as Error).message }, "disconnect threw");
    }
  };

  // SDK 构造不自动连接，需显式调用。
  client.connect();

  return { client, ready, reconnect, shutdown, status: () => ({ ...state, authenticated: state.authenticated && client.isConnected }) };
};
