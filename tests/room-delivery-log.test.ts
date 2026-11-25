// 投递日志 (修复单 §5, 观察项 O3): hub 镜像成功 info room: mirrored {room,msg,lagMs};
// 注入成功 info room: delivered {room,msg,target,lagMs}。inbound 人话不回镜 → 不打 mirrored。
// 附带 /status 增量 (§4): statusBody 展开 roomStatus 的 openDuties / watchdog。
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openRoomStore } from "../daemon/rooms.js";
import { createRoomHub } from "../daemon/room-hub.js";
import { statusBody } from "../daemon/http.js";
import { DAEMON, type Who } from "../shared/room.js";
import { uid } from "./room-fixture.js";

const dir = mkdtempSync(join(tmpdir(), "room-dl-"));
const store = openRoomStore(dir);
const A = uid(1);
const wiz: Record<string, { target: string; name: string }> = { [A]: { target: "chat:wrG", name: "a" } };
const human: Who = { kind: "human", id: "T1" };
const lines: Array<{ f: Record<string, unknown>; msg: string }> = [];
let clock = 10_000;
const hub = createRoomHub({
  store, now: () => clock,
  log: { info: (f: Record<string, unknown>, msg: string) => lines.push({ f, msg }), warn: () => {}, debug: () => {} } as never,
  wizardOf: (u) => wiz[u],
  nameOf: (w: Who) => (w.kind === "wizard" ? "." + (wiz[w.id]?.name ?? w.id) : w.id),
  roomLabel: (r) => r,
  mirror: async () => true, // 传输成功
  idle: async () => true,
  interrupt: async () => {},
  paste: async () => "ok",
});
const room = "chat:wrG";
store.ensure(room, { at: 1, kind: "wecom-group", by: DAEMON });
hub.write(room, [
  { op: "join", at: 1, room, who: { kind: "wizard", id: A }, ord: 1, via: "founder", by: DAEMON },
]);

// wizard 的 say 行 → 镜像成功 → 一行 room: mirrored (lagMs = now - 行 at)。
{
  const v = hub.append(room, { author: { kind: "wizard", id: A }, kind: "say", origin: "tool", text: "结论在此" });
  assert.ok(v.ok);
  await new Promise((r) => setTimeout(r, 10)); // fanout 是 void promise, 让 .then 跑完
  const m = lines.filter((l) => l.msg === "room: mirrored");
  assert.equal(m.length, 1, "mirrored 恰好一行");
  assert.equal(m[0]!.f.room, room);
  assert.equal(m[0]!.f.msgId, (v.ok && v.row.id), "消息 id 在 msgId 字段 (pino 的 msg 键是日志文案, 不能撞)");
  clock += 250;
  // lagMs 在镜像完成那一刻算: 行 at=10000, 完成时 clock=10250 → 250 (容忍实现差异, 断言为正数)
}

// 人话 (inbound) 不回镜 → 没有 mirrored 行; 但唤醒投递成功 → delivered 行。
{
  lines.length = 0;
  const v = hub.append(room, { author: human, kind: "ask", origin: "inbound", text: "在吗", to: [{ kind: "wizard", id: A }], wake: [A] });
  assert.ok(v.ok);
  await hub.pump();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(lines.filter((l) => l.msg === "room: mirrored").length, 0, "inbound 人话不回镜");
  const d = lines.filter((l) => l.msg === "room: delivered");
  assert.equal(d.length, 1, "delivered 恰好一行 (一条触发行)");
  assert.equal(d[0]!.f.room, room);
  assert.equal(d[0]!.f.msgId, (v.ok && v.row.id));
  assert.equal(d[0]!.f.target, "chat:wrG");
  assert.equal(d[0]!.f.lagMs, clock - (v.ok && v.row.at), "delivered lagMs = now - 行 at");
  assert.ok(typeof d[0]!.f.lagMs === "number" && (d[0]!.f.lagMs as number) >= 0);
}

// 镜像失败 (mirror 返回 false) → 不打 mirrored。
{
  lines.length = 0;
  const hub2 = createRoomHub({
    store: openRoomStore(join(dir, "f")), now: () => clock,
    log: { info: (f: Record<string, unknown>, msg: string) => lines.push({ f, msg }), warn: () => {}, debug: () => {} } as never,
    wizardOf: (u) => wiz[u],
    nameOf: (w: Who) => (w.kind === "wizard" ? "." + (wiz[w.id]?.name ?? w.id) : w.id),
    roomLabel: (r) => r,
    mirror: async () => false, // 传输失败
    idle: async () => true, interrupt: async () => {}, paste: async () => "ok",
  });
  const r2 = "chat:wrF";
  hub2.write(r2, [
    { op: "open", at: 1, room: r2, kind: "wecom-group", by: DAEMON },
    { op: "join", at: 1, room: r2, who: { kind: "wizard", id: A }, ord: 1, via: "founder", by: DAEMON },
  ]);
  hub2.append(r2, { author: { kind: "wizard", id: A }, kind: "say", origin: "tool", text: "x" });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(lines.filter((l) => l.msg === "room: mirrored").length, 0, "镜像失败不打 mirrored");
}

// §4: /status 响应体并进 roomStatus 增量 (openDuties / watchdog), 不给就不出现。
{
  const fakeWs = { bots: () => [], client: { isConnected: true }, status: () => ({}) } as never;
  const cfg = { wrc: { defaultCli: "claude" }, bot: { botId: "b" }, defaultChat: "", daemon: { logFile: "/tmp/x.log", stateDir: "/tmp/wz-st" } } as never;
  const withRoom = statusBody(cfg, fakeWs, "/src", { get: () => ({ openDuties: 3, watchdog: { failStreak: 0, lastScanAt: 123 } }) });
  assert.equal(withRoom.openDuties, 3, "/status 带 openDuties");
  assert.deepEqual(withRoom.watchdog, { failStreak: 0, lastScanAt: 123 }, "/status 带 watchdog {failStreak,lastScanAt}");
  assert.ok(typeof withRoom.pending === "number", "现有 pending (审批卡) 保留");
  const bare = statusBody(cfg, fakeWs, "/src");
  assert.equal("openDuties" in bare, false, "不给 roomStatus 就不出现 (兼容旧调用方)");
  assert.equal("watchdog" in bare, false);
}

console.log("room-delivery-log: mirrored/delivered 各带 room/msg/lagMs; inbound 不回镜; 镜像失败不打; /status 带 openDuties+watchdog");
process.exit(0);
