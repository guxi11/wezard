// 访问 daemon 控制面的 TS 客户端: node:http 经 unix socket。
// socket 本身就是「本机、本 uid」的凭据, 所以这里不再有 loopback URL 校验;
// 口令 (x-wezard-token) 由调用方按需放进 headers。
import { Agent, request } from "node:http";
import { socketFromEnv } from "./daemon-addr.js";

export interface DaemonRequestOpts {
  body?: unknown;
  headers?: Record<string, string>;
  /** socket 空闲超时 (收不到任何字节多久算超时)。缺省 = 不设: 慢路由 (delegate / roster) 可以慢但必须成功。 */
  timeoutMs?: number;
  /** 缺省 = `socketFromEnv()` (env WEZARD_DAEMON_SOCK → stateDir 缺省路径)。 */
  socketPath?: string;
}

export interface DaemonResponse {
  status: number;
  /** 响应体按 JSON 解析; 空体 / 非 JSON → undefined。 */
  json: unknown;
  /** 原文 (非 JSON 的回包要看它)。 */
  text: string;
}

// Node ≥19 的 http.globalAgent 自带 `timeout: 5000`: 不显式传 timeoutMs 的请求, 只要 daemon 5s 内
// 没回半个字节 (事件循环被同步重活堵住时常见) 就会被判超时 —— 路由其实还在跑, 调用方却报错, 于是
// 「已落账但客户端报超时」。这里的专用 agent 把 socket 超时关掉, 超时只由调用方显式给的 timeoutMs 决定。
// keepAlive 关掉: 一次一连, 免得复用到被 daemon 先关掉的空闲连接 (ECONNRESET), 也让 CLI 进程能立刻退出。
const noIdleTimeoutAgent = new Agent({ keepAlive: false, timeout: 0 });

/** 超时文案: 带上真实数字。显式 timeoutMs 写它本身, 否则写实际等了多久 (理论上不会走到, 留作兜底)。 */
export const timeoutMessage = (method: string, path: string, timeoutMs: number | undefined, elapsedMs: number): string =>
  timeoutMs
    ? `timeout after ${timeoutMs}ms (no bytes from daemon; elapsed ${elapsedMs}ms) ${method} ${path}`
    : `timeout after ${elapsedMs}ms (agent default idle timeout, no timeoutMs given) ${method} ${path}`;

/** 一次请求。连不上 / 超时 reject (带 code, 如 ECONNREFUSED / ENOENT); HTTP 状态码不论好坏都 resolve。 */
export const daemonRequest = (method: string, path: string, opts: DaemonRequestOpts = {}): Promise<DaemonResponse> =>
  new Promise((resolve, reject) => {
    const payload = opts.body === undefined ? undefined : Buffer.from(JSON.stringify(opts.body));
    const startedAt = Date.now();
    const req = request(
      {
        socketPath: opts.socketPath ?? socketFromEnv(),
        method,
        path,
        agent: noIdleTimeoutAgent,
        headers: {
          host: "wezard",
          ...(payload ? { "content-type": "application/json", "content-length": String(payload.length) } : {}),
          ...opts.headers,
        },
        ...(opts.timeoutMs ? { timeout: opts.timeoutMs } : {}),
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("error", reject);
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json: unknown;
          try { json = text ? JSON.parse(text) : undefined; } catch { json = undefined; }
          resolve({ status: res.statusCode ?? 0, json, text });
        });
      },
    );
    req.on("timeout", () => req.destroy(Object.assign(new Error(timeoutMessage(method, path, opts.timeoutMs, Date.now() - startedAt)), { code: "ETIMEDOUT" })));
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
