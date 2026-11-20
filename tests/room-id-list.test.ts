// 请求体里的 id 列表解析: 没给 = []。曾经的写法 [x].map(String) 把 undefined 变成 "undefined",
// chat_ask 不带 after 时账本里落 after:["undefined"] —— 前置永不算满足, 被点名的人永不唤醒
// (2026-11-20 实录: 6b664ebb.252/.255 两条 ask wake 为空)。这里钉住两件事:
// idList 不造出假 id; after 为空列表时这一行照常唤醒被点名的人。
import assert from "node:assert/strict";
import { foldRoom, idList, judge, type RoomOp } from "../shared/room.js";
import { uid, W } from "./room-fixture.js";

const A = uid(1), B = uid(2);
const room = "adhoc:aaaa1111";
const base: RoomOp[] = [
  { op: "open", at: 1, room, kind: "adhoc", by: W(A) },
  { op: "join", at: 1, room, who: W(A), ord: 1, via: "founder", by: W(A) },
  { op: "join", at: 2, room, who: W(B), ord: 2, via: "invite", by: W(A) },
];

// 缺省 / 空数组 / 单个字符串 / 数组: 只有真 id 留下
assert.deepEqual(idList(undefined), []);
assert.deepEqual(idList(null), []);
assert.deepEqual(idList([]), []);
assert.deepEqual(idList("m1"), ["m1"]);
assert.deepEqual(idList(["m1", " m2 ", ""]), ["m1", "m2"]);
assert.deepEqual(idList(undefined).map(String).includes("undefined"), false);

// after 缺省 (= 无前置) 时 ask 唤醒被点名的人; 显式 ["undefined"] 这种假前置会挡掉唤醒
{
  const s = foldRoom(room, base);
  const v = judge(s, { author: W(A), kind: "ask", text: "改个名", to: [W(B)], origin: "tool" }, { now: 10 });
  assert.ok(v.ok);
  assert.deepEqual(v.row.after, undefined);
  assert.deepEqual(v.row.wake, [B]);
}
{
  const s = foldRoom(room, base);
  const v = judge(s, { author: W(A), kind: "ask", text: "改个名", to: [W(B)], origin: "tool", after: idList(undefined) }, { now: 10 });
  assert.ok(v.ok);
  assert.deepEqual(v.row.wake, [B], "空列表 (无前置) 必须照常唤醒");
}

console.log("room-id-list: ok");
