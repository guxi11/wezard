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
import { groupSysOf, overdueDue } from "../shared/room-overdue.js";
import { room as mkRoom, say, uid, W } from "./room-fixture.js";

const MIN = 60_000;
const O = { remindMs: 60 * MIN, groupMs: 120 * MIN };
const A = W(uid(1)), B = W(uid(2)), C = W(uid(3));
type S = ReturnType<typeof mkRoom>;
const levels = (s: S, now: number, o = O, known?: (u: string) => boolean) => overdueDue(s, now, o, known).map((h) => h.holder.id.slice(-1) + ":" + h.level);
const mk = (to: Who[] = [B], members: Who[] = [A, B, C]) => {
  const s = mkRoom("adhoc:x", members);
  const ask = say(s, { author: A, kind: "ask", to, text: "干活" }, { now: 0 });
  return { s, ask };
};
const daemonRow = (s: S, sys: string, at: number, re: string, to?: Who[]): MsgRow => {
  const row = { op: "msg", at, room: s.id, id: "z" + (s.seq + 1), seq: s.seq + 1, author: DAEMON, ord: 0, speak: "daemon", kind: sys === "overdue-remind" ? "trigger" : "system", text: "t", re: [re], ...(to ? { to } : {}), wake: [], origin: "daemon", sys } as MsgRow;
  applyOp(s, row);
  return row;
};
const seen = (s: S, who: Who, seq: number): void => { applyOp(s, { op: "seen", at: 1, room: s.id, who, seq }); };

// 两级阈值; 同一次判定 group 要等 remind 送到, 所以只给 remind
{
  const { s } = mk();
  assert.deepEqual(levels(s, 59 * MIN), []);
  assert.deepEqual(levels(s, 60 * MIN), ["2:remind"]);
  assert.deepEqual(levels(s, 120 * MIN), ["2:remind"], "remind 还没写 → group 不报");
  assert.deepEqual(levels(s, 120 * MIN, { remindMs: 0, groupMs: 120 * MIN }), ["2:group"], "remind 关 (0) 时 group 只看自己的阈值");
  assert.deepEqual(levels(s, 120 * MIN, { remindMs: 60 * MIN, groupMs: 0 }), ["2:remind"], "group 关");
  assert.deepEqual(levels(s, 999 * MIN, { remindMs: 0, groupMs: 0 }), []);
}
// ① group 等 remind 被 holder 的 seen 越过
{
  const { s, ask } = mk();
  const r = daemonRow(s, "overdue-remind", 61 * MIN, ask.id, [B]);
  assert.deepEqual(levels(s, 130 * MIN), [], "remind 已写但 B 没读到 → 不报 group, 也不重复 remind");
  seen(s, B, r.seq - 1);
  assert.deepEqual(levels(s, 130 * MIN), [], "游标没越过 trigger");
  seen(s, B, r.seq);
  assert.deepEqual(levels(s, 130 * MIN), ["2:group"], "读到了 → group");
  daemonRow(s, groupSysOf(B.id), 131 * MIN, ask.id);
  assert.deepEqual(levels(s, 999 * MIN), [], "两级都给过 (daemon 行不重置计时)");
  say(s, { author: B, kind: "reply", re: [ask.id], status: "progress", statusGiven: true, text: "在做" }, { now: 200 * MIN });
  assert.deepEqual(levels(s, 259 * MIN), [], "progress 重新计时");
  assert.deepEqual(levels(s, 260 * MIN), ["2:remind"], "新一段空闲会再给");
}
// ④ 按 holder 算: B 的 progress 不重置 C; 提醒 to 不含 C 不算给过 C
{
  const { s, ask } = mk([B, C]);
  say(s, { author: B, kind: "reply", re: [ask.id], status: "progress", statusGiven: true, text: "在做" }, { now: 50 * MIN });
  assert.deepEqual(levels(s, 70 * MIN), ["3:remind"], "C 的计时没被 B 重置, B 的被重置");
  daemonRow(s, "overdue-remind", 71 * MIN, ask.id, [C]);
  assert.deepEqual(levels(s, 112 * MIN), ["2:remind"], "给 C 的提醒不算给过 B");
  say(s, { author: A, kind: "say", re: [ask.id], text: "补充" }, { now: 100 * MIN });
  assert.deepEqual(levels(s, 150 * MIN), [], "提问者的补充重置所有 holder");
}
// ⑤ room_transfer: move 算活动, 新 holder 重新收提醒
{
  const { s, ask } = mk();
  daemonRow(s, "overdue-remind", 61 * MIN, ask.id, [B]);
  applyOp(s, { op: "move", at: 100 * MIN, room: s.id, duty: ask.id, from: B, to: C, by: A });
  assert.deepEqual(levels(s, 150 * MIN), [], "转交重新计时");
  assert.deepEqual(levels(s, 160 * MIN), ["3:remind"], "新 holder 收到提醒");
}
// ⑥ 无主 duty 跳过
{
  const { s } = mk([B], [A, B]);
  assert.deepEqual(levels(s, 999 * MIN, O, (u) => u !== B.id), [], "名册上查无此人");
  applyOp(s, { op: "leave", at: 5, room: s.id, who: B, by: A });
  assert.deepEqual(levels(s, 999 * MIN), [], "holder 已不是成员");
}
// join-req / 已关 duty 不算
{
  const { s, ask } = mk();
  say(s, { author: B, kind: "reply", re: [ask.id], status: "done", statusGiven: true, text: "好了" }, { now: 5 * MIN });
  assert.deepEqual(levels(s, 999 * MIN), [], "已关");
  const d = W(uid(4));
  say(s, { author: d, kind: "join-req", text: "我想进" }, { now: 6 * MIN });
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
const nameOf = (w: Who): string => (w.kind === "wizard" ? "." + (names[w.id]?.name ?? w.id) : w.id);
const log = { info: () => {}, warn: () => {}, child: () => log } as never;
const hub = createRoomHub({
  store, log, now: () => clock, wizardOf: (u) => names[u], nameOf,
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
const failRooms = new Set<string>();
const mkScan = () => createOverdueScan({
  log, now: () => clock, thresholds: () => ({ remindMin: 60, groupMin: 120 }), rooms: store.ids,
  stateOf: (r) => store.get(r),
  append: (r, d, extra) => { if (failRooms.has(r)) throw new Error("corrupt"); return hub.append(r, d, extra); },
  wizardOf: (u) => names[u], nameOf, roomLabel: (r) => r,
});
const scan = mkScan();
const Z = { remind: 0, group: 0, mirrored: 0 };
clock = askAt + 30 * MIN;
assert.deepEqual(scan.scan(), Z);
clock = askAt + 61 * MIN;
assert.deepEqual(scan.scan(), { ...Z, remind: 1 });
const trig = store.get(dm)!.msgs.find((m) => m.sys === "overdue-remind")!;
assert.equal(trig.kind, "trigger");
assert.deepEqual(trig.re, [id]);
assert.ok(trig.wake.includes(uid(2)), "trigger 唤醒处理人");
assert.deepEqual(scan.scan(), Z, "不重复");
// ① remind 还没被读到 (游标未越过): 120 分钟也不报 group
clock = askAt + 121 * MIN;
assert.deepEqual(scan.scan(), Z, "B 没读到 remind → group 等着");
store.append(dm, [{ op: "seen", at: clock, room: dm, who: B, seq: trig.seq }]);
assert.deepEqual(scan.scan(), { ...Z, group: 1, mirrored: 1 });
const g = store.get(dm)!.msgs.find((m) => m.sys?.startsWith("overdue-group"))!;
assert.equal(g.kind, "system");
assert.deepEqual(g.wake, [], "group 行不唤醒任何人");
const home = store.get("chat:wrG")!.msgs.find((m) => m.sys === "overdue-group")!;
assert.ok(home, "home 群有通知行");
assert.deepEqual(home.wake, []);
assert.match(home.text, /\.b 名下 .* \(来自 \.lead, 在 adhoc:g2\) 已 121 分钟/);
assert.deepEqual(scan.scan(), Z, "group 也不重复");
// 重新 new 一个 scan 实例 (等于 daemon 重启): 去重在账本里, 不重复
assert.deepEqual(mkScan().scan(), Z, "新实例不重复");

// ② 唤醒预算用尽 (10 分钟内 20 次): remind 仍然真的唤醒
{
  const r2 = "adhoc:g3";
  store.ensure(r2, { at: 1, kind: "adhoc", by: DAEMON });
  hub.write(r2, [
    { op: "join", at: 1, room: r2, who: A, ord: 1, via: "founder", by: DAEMON },
    { op: "join", at: 2, room: r2, who: B, ord: 2, via: "spawn", by: A },
  ]);
  const base = clock;
  const k = hub.append(r2, { author: A, kind: "ask", origin: "tool", to: [B], text: "预算" });
  assert.ok(k.ok);
  for (let i = 0; i < 25; i++) hub.append(r2, { author: A, kind: "say", origin: "tool", to: [B], text: "噪音 " + i });
  clock = base + 61 * MIN;
  mkScan().scan();
  const t2 = store.get(r2)!.msgs.find((m) => m.sys === "overdue-remind")!;
  assert.ok(t2 && t2.wake.includes(uid(2)), "预算用尽 remind 也带 wake");
}

// ③ 失败隔离: 一个 room 抛错不饿死别的 room (坏的 room 先于好的); 绑定 room 的 group 只记一行不走 home
{
  const bound = "chat:wrG";
  const k = hub.append(bound, { author: A, kind: "ask", origin: "tool", to: [A], text: "自己" });
  void k;
  const bad = "adhoc:bad";
  store.ensure(bad, { at: 1, kind: "adhoc", by: DAEMON });
  hub.write(bad, [
    { op: "join", at: 1, room: bad, who: A, ord: 1, via: "founder", by: DAEMON },
    { op: "join", at: 2, room: bad, who: B, ord: 2, via: "spawn", by: A },
  ]);
  hub.append(bad, { author: A, kind: "ask", origin: "tool", to: [B], text: "坏账" });
  failRooms.add(bad);
  const before = store.get(dm)!.msgs.length;
  clock += 300 * MIN;
  const out = mkScan().scan();
  assert.ok(out.remind >= 1, "好 room 的 duty 照常处理: " + JSON.stringify(out));
  assert.ok(store.get(dm)!.msgs.length >= before);
  failRooms.clear();
}
{
  // 绑定 room: 人在群里 @ wizard → 人话 duty; group 行只在本 room 记一行
  const bound = "chat:wrH";
  names[uid(5)] = { target: "chat:wrH", name: "h" };
  const E = W(uid(5));
  store.ensure(bound, { at: 1, kind: "wecom-group", by: DAEMON });
  hub.write(bound, [{ op: "join", at: 1, room: bound, who: E, ord: 1, via: "founder", by: DAEMON }]);
  hub.append(bound, { author: { kind: "human", id: "user:u1" }, kind: "say", origin: "inbound", text: "在吗" });
  const sc = mkScan();
  clock += 61 * MIN;
  sc.scan();
  const tr = store.get(bound)!.msgs.find((m) => m.sys === "overdue-remind")!;
  assert.ok(tr, "绑定 room 的人话 duty 也提醒");
  store.append(bound, [{ op: "seen", at: clock, room: bound, who: E, seq: tr.seq }]);
  clock += 61 * MIN;
  const homeBefore = store.get("chat:wrG")!.msgs.length;
  assert.deepEqual(sc.scan(), { ...Z, group: 1 });
  assert.equal(store.get(bound)!.msgs.filter((m) => m.sys?.startsWith("overdue-group")).length, 1);
  assert.equal(store.get("chat:wrG")!.msgs.length, homeBefore, "绑定 room 不走 home 群");
}
console.log("room-overdue ok");
