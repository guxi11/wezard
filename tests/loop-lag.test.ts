// 事件循环延迟监控: 同步堵一下 → warn 一条 (带 inflight 路由与数字), 并进 /status.eventLoopLagMs。
import assert from "node:assert/strict";
import { startLoopLagMonitor, lagExceeds } from "../daemon/loop-lag.js";
import { statusBody, inflightRoutes } from "../daemon/http.js";

assert.equal(lagExceeds({ p99: 600, max: 10 }, 500, 1000), true, "p99 超线");
assert.equal(lagExceeds({ p99: 10, max: 1500 }, 500, 1000), true, "单发长停顿 (进不了 p99) 也要报");
assert.equal(lagExceeds({ p99: 10, max: 100 }, 500, 1000), false);
assert.deepEqual(inflightRoutes(), [], "没有请求在跑 = 空");

const warns: Array<{ f: Record<string, unknown>; msg: string }> = [];
const mon = startLoopLagMonitor({
  log: { warn: (f, msg) => warns.push({ f, msg }) },
  inflight: () => ["POST /wizard/roster 300ms"],
  windowMs: 400, resolutionMs: 10, p99WarnMs: 100, maxWarnMs: 150,
});
try {
  assert.equal(mon.snapshot().sampledAt, 0, "窗口没走完 = 还没有读数");
  await new Promise((r) => setTimeout(r, 120));
  const t = Date.now();
  while (Date.now() - t < 350); // 同步堵 350ms
  await new Promise((r) => setTimeout(r, 900)); // 让窗口收口
  const s = mon.snapshot();
  assert.ok(s.sampledAt > 0, "窗口收过口");
  assert.ok(s.maxSinceBoot >= 250, `开机以来最大停顿 ≥250ms, got ${s.maxSinceBoot}`);
  assert.ok(s.maxSinceBoot <= 1000, `数字量级正确, got ${s.maxSinceBoot}`);
  assert.ok(s.maxAt > 0);
  assert.ok(warns.length >= 1, "超线必须 warn");
  assert.match(warns[0]!.msg, /event loop lag/);
  assert.ok((warns[0]!.f.maxMs as number) >= 250, JSON.stringify(warns[0]!.f));
  assert.deepEqual(warns[0]!.f.inflight, ["POST /wizard/roster 300ms"], "告警带 inflight 路由");

  // /status: 给了 loopLag 就出现 eventLoopLagMs, 不给就不出现 (兼容旧调用方)。
  const fakeWs = { client: { isConnected: true }, status: () => ({}) } as never;
  const cfg = { wrc: { defaultCli: "claude" }, bot: { botId: "b" }, defaultChat: "", daemon: { logFile: "/tmp/x.log", stateDir: "/tmp/wz-st" } } as never;
  const withLag = statusBody(cfg, fakeWs, "/src", undefined, mon);
  const lag = withLag.eventLoopLagMs as Record<string, number>;
  assert.deepEqual(Object.keys(lag).sort(), ["max", "maxAt", "maxSinceBoot", "p99", "sampledAt"]);
  assert.equal(lag.maxSinceBoot, s.maxSinceBoot, "/status 读的就是监控的快照");
  assert.equal("eventLoopLagMs" in statusBody(cfg, fakeWs, "/src"), false);
  console.log("loop-lag ok");
} finally {
  mon.stop();
}
