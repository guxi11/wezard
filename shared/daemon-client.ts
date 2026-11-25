// 访问 daemon 控制面的 TS 客户端: node:http 经 unix socket。
// socket 本身就是「本机、本 uid」的凭据, 所以这里不再有 loopback URL 校验;
// 口令 (x-wezard-token) 由调用方按需放进 headers。
import { request } from "node:http";
import { socketFromEnv } from "./daemon-addr.js";

export interface DaemonRequestOpts {
  body?: unknown;
  headers?: Record<string, string>;
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

/** 一次请求。连不上 / 超时 reject (带 code, 如 ECONNREFUSED / ENOENT); HTTP 状态码不论好坏都 resolve。 */
export const daemonRequest = (method: string, path: string, opts: DaemonRequestOpts = {}): Promise<DaemonResponse> =>
  new Promise((resolve, reject) => {
    const payload = opts.body === undefined ? undefined : Buffer.from(JSON.stringify(opts.body));
    const req = request(
      {
        socketPath: opts.socketPath ?? socketFromEnv(),
        method,
        path,
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
    req.on("timeout", () => req.destroy(Object.assign(new Error(`timeout after ${opts.timeoutMs}ms`), { code: "ETIMEDOUT" })));
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
