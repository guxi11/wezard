// room 起名: name op 只改显示别名 —— fold 可增量覆盖, 寻址 (id / 成员 / seq) 一律不动,
// 改名的权限只认当前 host (人也不行)。
import assert from "node:assert/strict";
import { canRename, foldRoom, roomHost, type RoomOp } from "../shared/room.js";
import { buildRoomFact } from "../shared/room-view.js";
import { uid, W } from "./room-fixture.js";

const A = uid(1), B = uid(2), C = uid(3);
const room = "adhoc:abcd1234";
const base: RoomOp[] = [
  { op: "open", at: 1, room, kind: "adhoc", by: W(A) },
  { op: "join", at: 1, room, who: W(A), ord: 1, via: "founder", by: W(A) },
  { op: "join", at: 2, room, who: W(B), ord: 2, via: "invite", by: W(A) },
];
const name = (at: number, title: string, by = W(A)): RoomOp => ({ op: "name", at, room, title, by });

// 没起名 = 没有别名; 起名后 buildRoomFact 带上它
{
  const s0 = foldRoom(room, base);
  assert.equal(s0.title, undefined);
  const s1 = foldRoom(room, [...base, name(3, "账单迁移")]);
  assert.equal(s1.title, "账单迁移");
  assert.equal(buildRoomFact(s1, { nameOf: (w) => w.id, roomLabel: (r) => r }).title, "账单迁移");
}

// 改名是覆盖, 不是新 room: id / seq / 成员都不变
{
  const s = foldRoom(room, [...base, name(3, "旧名"), name(4, "新名")]);
  assert.equal(s.title, "新名");
  assert.equal(s.id, room);
  assert.equal(s.seq, 0, "name 不是消息, 不推进 seq");
  assert.equal(s.members.size, 2);
}

// 权限: 只有当前 host; 换 host (原 host 离开) 后跟着换人
{
  const s = foldRoom(room, base);
  assert.equal(roomHost(s)!.id, A);
  assert.ok(canRename(s, W(A)));
  assert.ok(!canRename(s, W(B)), "普通成员不能起名");
  assert.ok(!canRename(s, { kind: "human", id: "T1" }), "人也不能");
  assert.ok(!canRename(s, W(C)), "非成员更不能");

  const after = foldRoom(room, [...base, { op: "leave", at: 5, room, who: W(A), by: W(A) }]);
  assert.equal(roomHost(after)!.id, B);
  assert.ok(canRename(after, W(B)));
  assert.ok(!canRename(after, W(A)), "离开的前 host 不再能改");
}

// 没有 wizard 成员 (人兜底) 时没人能起名
{
  const s = foldRoom(room, [{ op: "open", at: 1, room, kind: "adhoc", by: W(A) }]);
  assert.equal(roomHost(s), undefined);
  assert.ok(!canRename(s, W(A)));
}
console.log("room-name ok");
