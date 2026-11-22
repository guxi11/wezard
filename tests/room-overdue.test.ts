// duty 逾期: 纯判定 (两级阈值 / 0 关 / progress 重置 / daemon 行不重置 / 去重 / join-req 与已关不算)
// + daemon 扫描落账 (trigger 唤醒处理人; group 记账 + 非绑定 room 通知 home 群, 都不唤醒)。
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openRoomStore } from "../daemon/rooms.js";
import { createRoomHub } from "../daemon/room-hub.js";
import { createOverdueScan } from "../daemon/room-overdue.js";
import { applyOp, DAEMON, type MsgRow, type Who } from "../shared/room.js";
import { overdueDue } from "../shared/room-overdue.js";
import { room as mkRoom, say, uid, W } from "./room-fixture.js";

const MIN = 60_000;
const O = { remindMs: 60 * MIN, groupMs: 120 * MIN };
const A = W(uid(1)), B = W(uid(2));
const levels = (s: ReturnType<typeof mkRoom>, now: number, o = O) => overdueDue(s, now, o).map((h) => h.level);
const mk = () => {
  const s = mkRoom("adhoc:x", [A, B]);
  const ask = say(s, { author: A, kind: "ask", to: [B], text: "干活" }, { now: 0 });
  return { s, ask };
};
const sysRow = (s: ReturnType<typeof mkRoom>, sys: string, at: number, re: string): void => {
  applyOp(s, { op: "msg", at, room: s.id, id: "z" + s.seq, seq: s.seq + 1, author: DAEMON, ord: 0, speak: "daemon", kind: "system", text: "t", re: [re], wake: [], origin: "daemon", sys } as MsgRow);
};

// 两级阈值
{
  const { s } = mk();
  assert.deepEqual(levels(s, 59 * MIN), []);
  assert.deepEqual(levels(s, 60 * MIN), ["remind"]);
  assert.deepEqual(levels(s, 119 * MIN), ["remind"]);
  assert.deepEqual(levels(s, 120 * MIN), ["remind", "group"], "同次两级都到: remind 在前");
  assert.deepEqual(levels(s, 120 * MIN, { remindMs: 0, groupMs: 120 * MIN }), ["group"], "0 = 关该级");
  assert.deepEqual(levels(s, 999 * MIN, { remindMs: 0, groupMs: 0 }), []);
}
// progress 重置计时; daemon 行不重置; 去重
{
  const { s, ask } = mk();
  sysRow(s, "overdue-remind", 61 * MIN, ask.id);
  assert.deepEqual(levels(s, 90 * MIN), [], "已给过 remind, 不重复");
  assert.deepEqual(levels(s, 120 * MIN), ["group"], "daemon 行不重置计时, group 照常到点");
  sysRow(s, "overdue-group", 121 * MIN, ask.id);
  assert.deepEqual(levels(s, 500 * MIN), [], "两级都给过");
  say(s, { author: B, kind: "reply", re: [ask.id], status: "progress", statusGiven: true, text: "在做" }, { now: 200 * MIN });
  assert.deepEqual(levels(s, 259 * MIN), [], "progress 重新计时");
  assert.deepEqual(levels(s, 260 * MIN), ["remind"], "新一段空闲会再给");
}
// join-req / 已关 duty 不算
{
  const { s, ask } = mk();
  say(s, { author: B, kind: "reply", re: [ask.id], status: "done", statusGiven: true, text: "好了" }, { now: 5 * MIN });
  assert.deepEqual(levels(s, 999 * MIN), [], "已关");
  const c = W(uid(3));
  say(s, { author: c, kind: "join-req", text: "我想进" }, { now: 6 * MIN });
  assert.deepEqual(levels(s, 999 * MIN), [], "join-req 不算");
}

// ── daemon 扫描 ────────────────────────────────────────────────────────
const dir = mkdtempSync(join(tmpdir(), "room-overdue-"));
const store = openRoomStore(dir);
let clock = 1_000_000;
const names: Record<string, { target: string; name: string }> = {
  [uid(1)]: { target: "chat:wrG", name: "lead" },
  [uid(2)]: { target: "chat:wrG#b", name: "b" },
};
const log = { info: () => {}, warn: () => {}, child: () => log } as never;
const hub = createRoomHub({
  store, log, now: () => clock, wizardOf: (u) => names[u],
  nameOf: (w: Who) => (w.kind === "wizard" ? "." + (names[w.id]?.name ?? w.id) : w.id),
  roomLabel: (r) => r, mirror: async () => true, live: async () => false, idle: async () => true,
  interrupt: async () => {}, paste: async () => "ok",
});
store.ensure("chat:wrG", { at: 1, kind: "wecom-group", by: DAEMON });
hub.write("chat:wrG", [{ op: "join", at: 1, room: "chat:wrG", who: A, ord: 1, via: "founder", by: DAEMON }]);
const dm = "adhoc:g2";
store.ensure(dm, { at: 1, kind: "adhoc", by: DAEMON });
hub.write(dm, [
  { op: "join", at: 1, room: dm, who: A, ord: 1, via: "founder", by: DAEMON },
  { op: "join", at: 2, room: dm, who: B, ord: 2, via: "spawn", by: A },
]);
const ask = hub.append(dm, { author: A, kind: "ask", origin: "tool", to: [B], text: "改 x" });
assert.ok(ask.ok);
const id = ask.ok ? ask.row.id : "";
const askAt = ask.ok ? ask.row.at : 0;
const scan = createOverdueScan({
  log, now: () => clock, thresholds: () => ({ remindMin: 60, groupMin: 120 }), rooms: store.ids,
  stateOf: (r) => store.get(r), append: (r, d) => hub.append(r, d),
  wizardOf: (u) => names[u], nameOf: (w) => (w.kind === "wizard" ? "." + (names[w.id]?.name ?? w.id) : w.id), roomLabel: (r) => r,
});
clock = askAt + 30 * MIN;
assert.deepEqual(scan.scan(), { remind: 0, group: 0, mirrored: 0 });
clock = askAt + 61 * MIN;
assert.deepEqual(scan.scan(), { remind: 1, group: 0, mirrored: 0 });
const trig = store.get(dm)!.msgs.find((m) => m.sys === "overdue-remind")!;
assert.equal(trig.kind, "trigger");
assert.deepEqual(trig.re, [id]);
assert.ok(trig.wake.includes(uid(2)), "trigger 唤醒处理人");
assert.deepEqual(scan.scan(), { remind: 0, group: 0, mirrored: 0 }, "不重复");
clock = askAt + 121 * MIN;
assert.deepEqual(scan.scan(), { remind: 0, group: 1, mirrored: 1 });
const g = store.get(dm)!.msgs.find((m) => m.sys === "overdue-group")!;
assert.equal(g.kind, "system");
assert.deepEqual(g.wake, [], "group 行不唤醒任何人");
const home = store.get("chat:wrG")!.msgs.find((m) => m.sys === "overdue-group")!;
assert.ok(home, "home 群有通知行");
assert.deepEqual(home.wake, []);
assert.match(home.text, /\.b 名下 .* \(来自 \.lead, 在 adhoc:g2\) 已 121 分钟/);
assert.deepEqual(scan.scan(), { remind: 0, group: 0, mirrored: 0 }, "group 也不重复");
console.log("room-overdue ok");
