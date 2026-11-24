// 绑定数据模型 (设计稿 docs/room/multi-source-binding.md §3 / §8-P1): 账本 bind/unbind op 是唯一事实,
// fold 出 RoomState.bindings; boot 索引只是缓存, 与逐 room fold 全量对账, 差一笔 fail-closed
// (拒绝绑定写, 路由与读侧回落恒等)。P1 不含任何入站/出站读写路径。
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BindGateClosed, openRoomStore, roomFile } from "../daemon/rooms.js";
import { applyOp, DAEMON, emptyRoom, foldRoom, type MsgRow, type RoomOp } from "../shared/room.js";
import { H, room as mkRoom, say, W } from "./room-fixture.js";

const A = W("w000000000001"), B = W("w000000000002"), U = H("u1");
const R = "chat:wrG", S1 = "chat:opkS1", S2 = "chat:wrOther";

// ① fold: bind 设/覆盖, unbind 删条目; 同一账本重放两次结果一致。
{
  const ops: RoomOp[] = [
    { op: "bind", at: 10, room: R, source: S1, by: A, why: "同一话题" },
    { op: "bind", at: 11, room: R, source: S2, by: DAEMON },
    { op: "bind", at: 12, room: R, source: S1, by: B, why: "改判给自己" },
    { op: "unbind", at: 13, room: R, source: S2, by: DAEMON, why: "绑错了" },
  ];
  const a = foldRoom(R, ops), b = foldRoom(R, ops);
  assert.deepEqual([...a.bindings], [...b.bindings], "重放两次结果一致");
  assert.deepEqual([...a.bindings.keys()], [S1], "bind 覆盖同源不新增条目, unbind 删条目");
  assert.deepEqual(a.bindings.get(S1), { at: 12, by: B, why: "改判给自己" });
  assert.deepEqual([...a.msgs], [], "bind/unbind 不占 seq、不写消息行");
  assert.equal(a.seq, 0);
  // unbind 不存在的源: 幂等, 不影响其他条目
  applyOp(a, { op: "unbind", at: 14, room: R, source: "chat:nope", by: DAEMON });
  assert.deepEqual([...a.bindings.keys()], [S1]);
}

// ② 存量兼容: 无 bind op 的账本, fold 的关键字段与改动前逐项一致 (bindings 恒空)。
{
  const s = mkRoom(R, [A, B]);
  const human = say(s, { author: U, kind: "say", origin: "inbound", text: "在吗" });
  const ask = say(s, { author: A, kind: "ask", text: "你接", to: [B] });
  assert.deepEqual({
    id: s.id, kind: s.kind, title: s.title, openedAt: s.openedAt,
    seq: s.seq, nextOrd: s.nextOrd,
    members: [...s.members.values()].map((m) => [m.who.id, m.ord]),
    msgs: s.msgs.map((m) => [m.id, m.seq, m.kind, m.text]),
    duties: [...s.duties.values()].map((d) => [d.key, d.slot, d.kind]),
    memberLog: s.memberLog.map((e) => [e.op, e.who.id]),
    bindings: [...s.bindings],
  }, {
    id: R, kind: "wecom-group", title: undefined, openedAt: 1_000,
    seq: 2, nextOrd: 3,
    members: [[A.id, 1], [B.id, 2]],
    msgs: [[human.id, 1, "say", "在吗"], [ask.id, 2, "ask", "你接"]],
    duties: [[human.id + "@host", "host", "human"], [ask.id + "@wizard:" + B.id, "wizard:" + B.id, "ask"]],
    memberLog: [["join", A.id], ["join", B.id]],
    bindings: [],
  });
  // src 只在新行上出现: 有则原样保留, 无则键不存在 (读侧回落主源)。
  const mk = (id: string, src?: string): MsgRow => ({
    op: "msg", at: 5, room: R, id, seq: 1, author: U, ord: 0, speak: "human", kind: "say",
    text: "hi", wake: [], origin: "inbound", ...(src ? { src } : {}),
  });
  assert.equal(foldRoom(R, [mk("aaaaaaaa.1", S1)]).msgs[0]!.src, S1);
  assert.equal("src" in foldRoom(R, [mk("aaaaaaaa.2")]).msgs[0]!, false);
}

// ③ store: boot 索引 = 账本重放; append 维护索引; 重启原样重建。
{
  const dir = mkdtempSync(join(tmpdir(), "room-bind-store-"));
  const store = openRoomStore(dir);
  assert.deepEqual(store.bindingGate(), { ok: true });
  assert.equal(store.bindings().size, 0);
  store.ensure(R, { at: 1, kind: "wecom-group", by: DAEMON });
  store.append(R, [{ op: "bind", at: 2, room: R, source: S1, by: A, why: "host 判给自己" }]);
  assert.equal(store.roomOfSource(S1), R);
  assert.equal(store.roomOfSource(S2), undefined, "未绑定 = undefined (调用方回落恒等)");
  assert.deepEqual(store.bindings().get(S1), { room: R, at: 2, by: A, why: "host 判给自己" });
  assert.equal(store.get(R)!.bindings.has(S1), true, "账本 fold 与索引同步");
  store.append(R, [{ op: "unbind", at: 3, room: R, source: S1, by: A }]);
  assert.equal(store.roomOfSource(S1), undefined, "解绑即回落");
  store.append(R, [{ op: "bind", at: 4, room: R, source: S2, by: DAEMON }]);
  const again = openRoomStore(dir);
  assert.deepEqual(again.bindingGate(), { ok: true });
  assert.equal(again.roomOfSource(S2), R, "boot 从账本重建索引");
  assert.equal(again.roomOfSource(S1), undefined, "解绑不进索引");
}

// ④ 对账闸: 两路推导差一笔就 fail-closed; 读侧与普通写不受影响。
const seed = (dir: string, id: string, ops: object[]): void => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(roomFile(dir, id), ops.map((o) => JSON.stringify(o)).join("\n") + "\n");
};
const openOp = (id: string) => ({ op: "open", at: 1, room: id, kind: "wecom-group", by: DAEMON });

// ④a 行上自称的 room ≠ 它所在的账本 (内存态 ≠ 盘上重放)
{
  const dir = mkdtempSync(join(tmpdir(), "room-bind-gate-"));
  seed(dir, R, [openOp(R), { op: "bind", at: 2, room: "chat:elsewhere", source: S1, by: A }]);
  const store = openRoomStore(dir);
  const g = store.bindingGate();
  assert.equal(g.ok, false, "对账失败即闸关");
  assert.match(g.reason ?? "", /bind 行声称 chat:elsewhere, 却在 chat:wrG 的账本里/);
  assert.equal(store.roomOfSource(S1), undefined, "闸关时路由/读侧回落恒等");
  assert.equal(store.get(R)!.bindings.has(S1), true, "读侧不受影响: 容器 fold 里它就是本 room 的绑定");
  assert.throws(() => store.append(R, [{ op: "bind", at: 3, room: R, source: S2, by: A }]),
    (e: unknown) => e instanceof BindGateClosed, "闸关时拒绝 bind 写");
  assert.throws(() => store.append(R, [{ op: "unbind", at: 3, room: R, source: S1, by: A }]),
    (e: unknown) => e instanceof BindGateClosed, "闸关时拒绝 unbind 写");
  assert.doesNotThrow(() => store.append(R, [{ op: "leave", at: 4, room: R, who: A, by: DAEMON }]),
    "普通行照常写");
}

// ④b 同一源被绑进两个 room (一源一 room 的硬约束被账本违反)
{
  const dir = mkdtempSync(join(tmpdir(), "room-bind-gate-"));
  const other = "chat:wrOther";
  seed(dir, R, [openOp(R), { op: "bind", at: 2, room: R, source: S1, by: A }]);
  seed(dir, other, [openOp(other), { op: "bind", at: 3, room: other, source: S1, by: B }]);
  const store = openRoomStore(dir);
  assert.equal(store.bindingGate().ok, false);
  assert.match(store.bindingGate().reason ?? "", /同时绑在/);
  assert.equal(store.roomOfSource(S1), undefined, "索引不可信 → 回落恒等");
  assert.equal(store.get(R)!.bindings.has(S1) && store.get(other)!.bindings.has(S1), true, "两本账都照常可读");
}

console.log("room-bindings ok (fold bind/unbind 终态与重放 / 存量 fold 不变 / boot 索引与重启重建 / 对账闸 fail-closed 且读侧不炸)");
