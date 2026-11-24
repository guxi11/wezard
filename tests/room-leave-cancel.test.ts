// 契约 §4: 成员离开 → daemon 写 canceled reply (closes 记上), 唤醒提问者; host 槽位随 host 求值落到下一位。
import assert from "node:assert/strict";
import { applyOp, dutiesHeldBy, foldRoom, holderOf, leaveOps, mirrors, openDuties, roomHost, type MsgRow, type RoomOp } from "../shared/room.js";
import { H, room, say, uid, W } from "./room-fixture.js";

const X = W(uid(1)), Y = W(uid(2)), Z = W(uid(3));

// ① X 持有 Y 提的 duty D 时离开
{
  const s = room("adhoc:00000001", [Y, X, Z]);
  const d = say(s, { author: Y, kind: "ask", to: [X], text: "查一下" });
  const ops = leaveOps(s, X, X, 9_000);
  assert.equal(ops.length, 2);
  const r = ops[0] as MsgRow;
  assert.deepEqual({ author: r.author.kind, kind: r.kind, status: r.status, re: r.re, closes: r.closes, wake: r.wake },
    { author: "daemon", kind: "reply", status: "canceled", re: [d.id], closes: [d.id + "@wizard:" + X.id], wake: [Y.id] });
  assert.equal(ops[1]!.op, "leave");
  ops.forEach((o) => applyOp(s, o));
  assert.equal(openDuties(s).length, 0);
  assert.equal(s.members.has("wizard:" + X.id), false);
}

// ② 提问者是人 → 账转给下一位 host (move + trigger 唤醒它), 不写「没有答案了」
{
  const s = room("chat:wrG", [X, Z]);
  const human = H("T1");
  const d = say(s, { author: human, origin: "inbound", text: "帮我看看", to: [X] });
  const ops = leaveOps(s, X, X, 9_000);
  ops.forEach((o) => applyOp(s, o));
  assert.equal(s.members.has("wizard:" + X.id), false);
  const held = dutiesHeldBy(s, Z);
  assert.deepEqual(held.map((x) => x.msg), [d.id], "人的账落到新 host 名下");
  const trig = s.msgs.find((m) => m.sys === "left-handoff")!;
  assert.deepEqual({ kind: trig.kind, to: trig.to, re: trig.re, wake: trig.wake }, { kind: "trigger", to: [Z], re: [d.id], wake: [Z.id] });
  assert.equal(mirrors(trig), false, "转交是内部唤醒, 不进群");
  assert.equal(s.msgs.some((m) => m.status === "canceled"), false);
}

// ②b 提问者是人但没有下一位 host → 只能按老样子取消
{
  const s = room("chat:wrH", [X]);
  const human = H("T1");
  const d = say(s, { author: human, origin: "inbound", text: "帮我看看", to: [X] });
  const r = leaveOps(s, X, X, 9_000)[0] as MsgRow;
  assert.equal(r.status, "canceled");
  assert.deepEqual(r.re, [d.id]);
  assert.deepEqual(r.wake, []);
  assert.equal(mirrors(r), true);
}

// ③ X 是 host 时离开 → 未决 join-req 的 holder 变成下一位
{
  const s = room("adhoc:00000002", [X, Y]);
  const outsider = W(uid(9));
  const jr = say(s, { author: outsider, kind: "join-req", text: "想进" });
  const duty = openDuties(s).find((d) => d.msg === jr.id)!;
  assert.deepEqual(holderOf(s, duty), X);
  const ops = leaveOps(s, X, X, 9_000);
  assert.equal(ops.length, 1, "host 槽位的 duty 不取消");
  ops.forEach((o) => applyOp(s, o));
  assert.deepEqual(roomHost(s), Y);
  assert.deepEqual(holderOf(s, duty), Y);
  assert.equal(openDuties(s).length, 1);
}

// ④ re 里混着别人的 duty → 只关 X 名下的
{
  const s = room("adhoc:00000003", [Y, X, Z]);
  const d = say(s, { author: Y, kind: "ask", to: [X, Z], text: "两位都看看" });
  const ops = leaveOps(s, X, X, 9_000);
  const r = ops[0] as MsgRow;
  assert.deepEqual(r.closes, [d.id + "@wizard:" + X.id]);
  ops.forEach((o) => applyOp(s, o));
  assert.equal(dutiesHeldBy(s, Z).length, 1);
  assert.equal(dutiesHeldBy(s, X).length, 0);
}

// ⑤ 重复 fold 幂等
{
  const s = room("adhoc:00000004", [Y, X]);
  say(s, { author: Y, kind: "task", to: [X], text: "做" });
  const ops = leaveOps(s, X, X, 9_000);
  ops.forEach((o) => applyOp(s, o));
  const all: RoomOp[] = [
    { op: "open", at: 1, room: s.id, kind: "adhoc", by: X },
    ...[...s.everMembers.values()].map((who, i): RoomOp => ({ op: "join", at: 1, room: s.id, who, ord: i + 1, via: "founder", by: who })),
    ...s.msgs,
    ops[1]!,
  ];
  const a = foldRoom(s.id, all), b = foldRoom(s.id, all);
  assert.deepEqual([...a.duties.entries()], [...b.duties.entries()]);
  assert.equal(openDuties(a).length, 0);
}
console.log("room-leave-cancel ok");
