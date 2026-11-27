// daemonRequest 的超时: (1) 不传 timeoutMs 不再吃 Node 全局 agent 的 5s 空闲超时 (慢路由慢但成功);
// (2) 显式 timeoutMs 照旧生效, 文案带真实数字 (不再是 `timeout after undefinedms`);
// (3) MCP 工具回环的分级超时: 慢路由 60s, 其余 30s。
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { daemonRequest, timeoutMessage } from "../shared/daemon-client.js";
import { timeoutForPath } from "../mcp/tools.js";

const dir = mkdtempSync(join(tmpdir(), "dc-to-"));
const sock = join(dir, "d.sock");
const server = createServer((req, res) => {
  const delay = Number(new URL(req.url ?? "/", "http://x").searchParams.get("delay") ?? 0);
  setTimeout(() => { res.setHeader("content-type", "application/json"); res.end('{"ok":true}'); }, delay);
});
await new Promise<void>((r) => server.listen(sock, r));

try {
  // (1) 7s 才回包: 以前 5012ms 就报错。
  const t0 = Date.now();
  const r = await daemonRequest("POST", "/slow?delay=7000", { socketPath: sock, body: {} });
  const took = Date.now() - t0;
  assert.equal(r.status, 200, "7s 回包照样成功");
  assert.deepEqual(r.json, { ok: true });
  assert.ok(took >= 6900, `确实等满了 7s (took=${took})`);

  // (2) 显式 timeoutMs: 照旧触发, 文案带数字, 不含 undefined。
  const err = await daemonRequest("GET", "/slow?delay=2000", { socketPath: sock, timeoutMs: 300 }).then(() => undefined, (e: Error & { code?: string }) => e);
  assert.ok(err, "显式 300ms 超时必须触发");
  assert.match(err.message, /^timeout after 300ms /, err.message);
  assert.ok(!err.message.includes("undefined"), err.message);
  assert.match(err.message, /elapsed \d+ms/, err.message);
  assert.match(err.message, /GET \/slow\?delay=2000/, "文案带上是哪条请求");
  assert.equal(err.code, "ETIMEDOUT");

  // 文案兜底分支: 没给 timeoutMs 时写实际等了多久, 不写 undefined。
  const fallback = timeoutMessage("POST", "/x", undefined, 5012);
  assert.match(fallback, /^timeout after 5012ms \(agent default idle timeout, no timeoutMs given\) POST \/x$/);
  assert.ok(!fallback.includes("undefined"));

  // (3) 分级。
  for (const p of ["/dispatch", "/wizard/roster", "/wizard/clone", "/wizard/route", "/wizard/stop", "/handoff", "/config/set"]) {
    assert.equal(timeoutForPath(p), 60_000, `${p} 是慢路由`);
  }
  for (const p of ["/peers/peek", "/room/say", "/room/reply", "/plans/get"]) {
    assert.equal(timeoutForPath(p), 30_000, `${p} 走默认`);
  }
  console.log("daemon-client-timeout ok");
} finally {
  server.close();
  server.closeAllConnections();
  rmSync(dir, { recursive: true, force: true });
}
