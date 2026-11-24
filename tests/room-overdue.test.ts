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
import { buildDescendantActivity, buildOpenChildDuties, groupSysOf, overdueDue } from "../shared/room-overdue.js";
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
// ⑤ 老账本里的 move 行 (room_transfer 已删, 读侧 fold 照常折叠): 算一次活动, 新 holder 重新收提醒
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
const mkScan = (over: { remindMin?: number; isBusy?: (u: string) => Promise<boolean> | boolean } = {}) => createOverdueScan({
  log, now: () => clock, thresholds: () => ({ remindMin: over.remindMin ?? 60, groupMin: 120 }), rooms: store.ids,
  stateOf: (r) => store.get(r),
  append: (r, d, extra) => { if (failRooms.has(r)) throw new Error("corrupt"); return hub.append(r, d, extra); },
  wizardOf: (u) => names[u], nameOf, roomLabel: (r) => r,
  ...(over.isBusy ? { isBusy: over.isBusy } : {}),
});
const scan = mkScan();
const Z = { remind: 0, group: 0, mirrored: 0 };
const remindsIn = (room: string): number => store.get(room)!.msgs.filter((m) => m.sys === "overdue-remind").length;
clock = askAt + 30 * MIN;
assert.deepEqual(await scan.scan(), Z);
clock = askAt + 61 * MIN;
assert.deepEqual(await scan.scan(), { ...Z, remind: 1 });
const trig = store.get(dm)!.msgs.find((m) => m.sys === "overdue-remind")!;
assert.equal(trig.kind, "trigger");
assert.deepEqual(trig.re, [id]);
assert.ok(trig.wake.includes(uid(2)), "trigger 唤醒处理人");
assert.deepEqual(await scan.scan(), Z, "不重复");
// ① remind 还没被读到 (游标未越过): 120 分钟也不报 group
clock = askAt + 121 * MIN;
assert.deepEqual(await scan.scan(), Z, "B 没读到 remind → group 等着");
store.append(dm, [{ op: "seen", at: clock, room: dm, who: B, seq: trig.seq }]);
assert.deepEqual(await scan.scan(), { ...Z, group: 1, mirrored: 1 });
const g = store.get(dm)!.msgs.find((m) => m.sys?.startsWith("overdue-group"))!;
assert.equal(g.kind, "system");
assert.deepEqual(g.wake, [], "group 行不唤醒任何人");
const home = store.get("chat:wrG")!.msgs.find((m) => m.sys === "overdue-group")!;
assert.ok(home, "home 群有通知行");
assert.deepEqual(home.wake, []);
assert.match(home.text, /\.b 名下 .* \(来自 \.lead, 在 adhoc:g2\) 已 121 分钟/);
assert.deepEqual(await scan.scan(), Z, "group 也不重复");
// 重新 new 一个 scan 实例 (等于 daemon 重启): 去重在账本里, 不重复
assert.deepEqual(await mkScan().scan(), Z, "新实例不重复");

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
  await mkScan().scan();
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
  const out = await mkScan().scan();
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
  await sc.scan();
  const tr = store.get(bound)!.msgs.find((m) => m.sys === "overdue-remind")!;
  assert.ok(tr, "绑定 room 的人话 duty 也提醒");
  store.append(bound, [{ op: "seen", at: clock, room: bound, who: E, seq: tr.seq }]);
  clock += 61 * MIN;
  const homeNotices = (): number => store.get("chat:wrG")!.msgs.filter((m) => m.sys === "overdue-group").length;
  const homeBefore = homeNotices();
  // 只看本 room: scan 现在会 await (探忙), 期间 hub 的泵可能把别的 room 的提醒投出去 → 那边的
  // group 级是否触发取决于投递时刻, 不是这条用例要断言的东西。
  const out2 = await sc.scan();
  assert.equal(out2.remind, 0, "没有新的 remind");
  assert.equal(store.get(bound)!.msgs.filter((m) => m.sys?.startsWith("overdue-group")).length, 1);
  assert.equal(homeNotices(), homeBefore, "绑定 room 不走 home 群");
}
// ⑦ progress 与普通 duty 同一套阈值 (3 分钟): progress 只把计时推到自己那一行, 不豁免、不单独计时
{
  const r = "adhoc:p3";
  store.ensure(r, { at: 1, kind: "adhoc", by: DAEMON });
  hub.write(r, [
    { op: "join", at: 1, room: r, who: A, ord: 1, via: "founder", by: DAEMON },
    { op: "join", at: 2, room: r, who: B, ord: 2, via: "spawn", by: A },
  ]);
  const k = hub.append(r, { author: A, kind: "ask", to: [B], text: "进度账" });
  assert.ok(k.ok);
  const sc3 = mkScan({ remindMin: 3 });
  clock += 10 * MIN;
  hub.append(r, { author: B, kind: "reply", re: [k.ok ? k.row.id : ""], status: "progress", statusGiven: true, text: "做着" });
  const progAt = clock;
  clock = progAt + 2 * MIN;
  await sc3.scan();
  assert.equal(remindsIn(r), 0, "progress 后 2 分钟不催");
  clock = progAt + 3 * MIN;
  await sc3.scan();
  assert.equal(remindsIn(r), 1, "progress duty 满 3 分钟照催");
}
// ⑧ 处理人忙 (跑着这一轮 / 停在审批框上) 不催; 闲下来下一轮再催; 探不出来当忙
{
  const mkAskRoom = (id: string): string => {
    store.ensure(id, { at: 1, kind: "adhoc", by: DAEMON });
    hub.write(id, [
      { op: "join", at: 1, room: id, who: A, ord: 1, via: "founder", by: DAEMON },
      { op: "join", at: 2, room: id, who: B, ord: 2, via: "spawn", by: A },
    ]);
    hub.append(id, { author: A, kind: "ask", to: [B], text: "忙不忙" });
    return id;
  };
  const rBusy = mkAskRoom("adhoc:busy1");
  clock += 3 * MIN;
  await mkScan({ remindMin: 3, isBusy: async () => true }).scan();
  assert.equal(remindsIn(rBusy), 0, "处理人忙 → 不催");
  await mkScan({ remindMin: 3, isBusy: async () => false }).scan();
  assert.equal(remindsIn(rBusy), 1, "闲下来 → 催");
  const rErr = mkAskRoom("adhoc:busy2");
  clock += 3 * MIN;
  await mkScan({ remindMin: 3, isBusy: async () => { throw new Error("tmux 挂了"); } }).scan();
  assert.equal(remindsIn(rErr), 0, "探不出来当忙, 这一轮不催");
}
// ⑨ 跨 room 的下游未关 → 只催下游; 下游关了才催上游 (「执行者已 done、上游没转告人」)
{
  names[uid(3)] = { target: "chat:wrG#c", name: "c" };
  const parent = "adhoc:pchain", childRoom = "adhoc:cchain";
  store.ensure(parent, { at: 1, kind: "adhoc", by: DAEMON });
  hub.write(parent, [
    { op: "join", at: 1, room: parent, who: A, ord: 1, via: "founder", by: DAEMON },
    { op: "join", at: 2, room: parent, who: B, ord: 2, via: "spawn", by: A },
  ]);
  store.ensure(childRoom, { at: 1, kind: "adhoc", by: DAEMON });
  hub.write(childRoom, [
    { op: "join", at: 1, room: childRoom, who: B, ord: 1, via: "spawn", by: A },
    { op: "join", at: 2, room: childRoom, who: C, ord: 2, via: "spawn", by: B },
  ]);
  const up = hub.append(parent, { author: A, kind: "ask", to: [B], text: "上游" });
  assert.ok(up.ok);
  const down = hub.append(childRoom, { author: B, kind: "task", to: [C], for: up.ok ? up.row.id : "", text: "下游" });
  assert.ok(down.ok);
  const sc3 = mkScan({ remindMin: 3 });
  clock += 3 * MIN;
  await sc3.scan();
  assert.equal(remindsIn(childRoom), 1, "先催下游的处理人");
  assert.equal(remindsIn(parent), 0, "下游还开着 → 不催上游");
  hub.append(childRoom, { author: C, kind: "reply", re: [down.ok ? down.row.id : ""], status: "done", text: "交付了" });
  const doneAt = clock;
  clock = doneAt + 2 * MIN;
  await sc3.scan();
  assert.equal(remindsIn(parent), 0, "下游刚关, 上游重新计时");
  clock = doneAt + 3 * MIN;
  await sc3.scan();
  assert.equal(remindsIn(parent), 1, "下游都关了 → 催上游把结果转告人");
}
// ⑥ 派出去的子件 (for 血缘, 可跨 room) 的活动也算 holder 的活动
{
  const dm = (name: string, ms: Who[]) => mkRoom("dm:" + name, ms);
  const { s, ask } = mk(); // A 问 B (room adhoc:x)
  const child = dm("c1", [B, C]);
  const task = say(child, { author: B, kind: "task", to: [C], for: ask.id, text: "子件" }, { now: 10 * MIN });
  const lv = (now: number, states: S[] = [s, child]) => overdueDue(s, now, O, undefined, buildDescendantActivity(states)).map((h) => h.holder.id.slice(-1) + ":" + h.level);
  assert.deepEqual(lv(69 * MIN), [], "派出子件那一刻起算 (子行 at = 10min)");
  assert.deepEqual(lv(70 * MIN), ["2:remind"], "子件也静止满 60 分钟 → 照常提醒");
  assert.deepEqual(levels(s, 70 * MIN), ["2:remind"], "不传索引 = 旧行为");
  say(child, { author: C, kind: "reply", re: [task.id], status: "progress", statusGiven: true, text: "在做" }, { now: 50 * MIN });
  assert.deepEqual(lv(109 * MIN), [], "子件 progress (非 daemon 行) 是活动");
  assert.deepEqual(lv(110 * MIN), ["2:remind"], "子件静止超时后照常");
  daemonRow(child, "overdue-remind", 100 * MIN, task.id, [C]);
  assert.deepEqual(lv(110 * MIN), ["2:remind"], "子件 room 里 daemon 的提醒不算活动");
  say(child, { author: C, kind: "reply", re: [task.id], status: "done", text: "好了" }, { now: 130 * MIN });
  assert.deepEqual(lv(189 * MIN), [], "子件 done 关账那一刻也算活动, 计时从这里重来");
  assert.deepEqual(lv(190 * MIN), ["2:remind"], "轮到 holder 收口: 60 分钟后再提醒");
}
{
  // 孙辈传递: B → C (for ask) → D (for C 的 task)
  const D = W(uid(4));
  const { s, ask } = mk();
  const r1 = mkRoom("dm:c", [B, C]), r2 = mkRoom("dm:d", [C, D]);
  const t1 = say(r1, { author: B, kind: "task", to: [C], for: ask.id, text: "子" }, { now: 5 * MIN });
  const t2 = say(r2, { author: C, kind: "task", to: [D], for: t1.id, text: "孙" }, { now: 6 * MIN });
  const at = (states: S[], now: number) => overdueDue(s, now, O, undefined, buildDescendantActivity(states)).length;
  assert.equal(at([s, r1, r2], 67 * MIN), 1, "孙辈静止 → 提醒");
  say(r2, { author: D, kind: "reply", re: [t2.id], status: "progress", statusGiven: true, text: "孙在做" }, { now: 60 * MIN });
  assert.equal(at([s, r1, r2], 67 * MIN), 0, "孙辈的活动沿血缘传到最上面的 duty");
  assert.equal(at([s, r1], 67 * MIN), 1, "索引里没有孙辈所在 room → 看不到");
  // 深度上限: 链长 7 的最深一环不再向上传
  const rooms = Array.from({ length: 7 }, (_, i) => mkRoom("dm:deep" + i, [B, C]));
  const rows: MsgRow[] = [];
  rooms.forEach((r, i) => rows.push(say(r, { author: B, kind: "task", to: [C], for: i === 0 ? ask.id : rows[i - 1]!.id, text: "链" + i }, { now: 1 * MIN })));
  say(rooms[6]!, { author: C, kind: "reply", re: [rows[6]!.id], status: "progress", statusGiven: true, text: "最深" }, { now: 100 * MIN });
  assert.equal(at([s, ...rooms], 67 * MIN), 1, "超过深度上限 (5) 的远孙辈不再算");
}
{
  // for 写的是名字: 没有任何 msg id 命中它, 忽略; for 成环不死循环
  const { s, ask } = mk();
  const r1 = mkRoom("dm:n", [B, C]);
  say(r1, { author: B, kind: "task", to: [C], for: ".OliveOwen", text: "名字" }, { now: 50 * MIN });
  assert.equal(overdueDue(s, 65 * MIN, O, undefined, buildDescendantActivity([s, r1])).length, 1, "for 是名字 → 不影响");
  const act = buildDescendantActivity([s, r1]);
  assert.equal(act("没有这条"), 0);
  assert.equal(act(ask.id), 0, "没人派出子件 → 0");
}
// ⑦ 递归式: 下游还开着只催下游 (叶子), 上游压住; 下游关掉后上游才按自己的空闲时长收提醒
{
  const { s, ask } = mk(); // A → B
  const child = mkRoom("dm:leaf", [B, C]);
  const task = say(child, { author: B, kind: "task", to: [C], for: ask.id, text: "下游" }, { now: 1 * MIN });
  const O3 = { remindMs: 3 * MIN, groupMs: 120 * MIN };
  const lv = (now: number) => {
    const states = [s, child];
    const open = buildOpenChildDuties(states);
    const idx = buildDescendantActivity(states);
    return [
      ...overdueDue(s, now, O3, undefined, idx, open).map((h) => "p:" + h.holder.id.slice(-1)),
      ...overdueDue(child, now, O3, undefined, idx, open).map((h) => "c:" + h.holder.id.slice(-1)),
    ];
  };
  assert.deepEqual(lv(4 * MIN), ["c:3"], "下游先收, 上游被压住");
  assert.deepEqual(lv(10 * MIN), ["c:3"], "同一空闲周期不重复催; 上游仍压着");
  say(child, { author: C, kind: "reply", re: [task.id], status: "done", text: "好" }, { now: 11 * MIN });
  assert.deepEqual(lv(13 * MIN), [], "下游刚关 (关账那一刻是活动), 上游重新计时");
  assert.deepEqual(lv(14 * MIN), ["p:2"], "下游都关了 → 催上游");
  // 孤儿下游 (处理人不在册) 不拦上游: 催不动它, 再压住上游整条链就静默了
  const { s: s2, ask: ask2 } = mk();
  const orphan = mkRoom("dm:orphan", [B, C]);
  say(orphan, { author: B, kind: "task", to: [C], for: ask2.id, text: "孤儿" }, { now: 1 * MIN });
  assert.equal(buildOpenChildDuties([s2, orphan])(ask2.id), true);
  assert.equal(buildOpenChildDuties([s2, orphan], (u) => u !== C.id)(ask2.id), false, "处理人不在册 → 不算拦住");
}
console.log("room-overdue ok");
