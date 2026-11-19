// 契约 §3b (人拍 I-1): interrupt 的四条约束。
import assert from "node:assert/strict";
import { applyOp, openDuties, WAKE_BUDGET, type Who } from "../shared/room.js";
import { H, rejects, room, say, uid, W } from "./room-fixture.js";

const host = W(uid(1)), child = W(uid(2)), peer = W(uid(3)), parentOfChild = W(uid(4));
const isParent = (p: Who, c: Who): boolean => p.id === parentOfChild.id && c.id === child.id;

// ① interrupt 落在行上 (先 Esc 再投由 hub 读这个字段), 计 1 次预算
{
  const s = room("adhoc:00000010", [host, child, peer]);
  const r = say(s, { author: host, kind: "ask", to: [child], text: "停一下", interrupt: true }, { isParent });
  assert.equal(r.interrupt, true);
  assert.deepEqual(r.wake, [child.id]);
}
// ② 限权: 直属 parent / host / 人可以, 普通成员 403
{
  const s = room("adhoc:00000011", [host, child, peer, parentOfChild]);
  rejects(s, { author: peer, kind: "ask", to: [child], text: "停", interrupt: true }, 403, { isParent });
  say(s, { author: parentOfChild, kind: "ask", to: [child], text: "停", interrupt: true }, { isParent });
  say(s, { author: host, kind: "say", to: [child], text: "停一下", interrupt: true }, { isParent });
  const g = room("chat:wrG", [host, child]);
  say(g, { author: H("T1"), origin: "inbound", to: [child], text: "停", interrupt: true });
}
// ③ 计入回合预算 M=20: 超了 409
{
  const s = room("adhoc:00000012", [host, child]);
  for (let i = 0; i < WAKE_BUDGET - 1; i++) say(s, { author: host, kind: "say", to: [child], text: "ping " + i });
  rejects(s, { author: host, kind: "ask", to: [child], text: "停", interrupt: true }, 409, { isParent });
}
// ④ 被打断那一轮的 duty 不关; 之后按游标重投 (未读里仍有它)
{
  const s = room("adhoc:00000013", [host, peer, child]);
  const work = say(s, { author: peer, kind: "task", to: [child], text: "长活" });
  const stop = say(s, { author: host, kind: "ask", to: [child], text: "先停", interrupt: true }, { isParent });
  assert.ok(openDuties(s).some((d) => d.msg === work.id), "被打断的 duty 不关");
  assert.ok(!stop.closes?.length);
  const { unreadFor } = await import("../shared/room.js");
  const unread = unreadFor(s, child).rows.map((m) => m.id);
  assert.ok(unread.includes(work.id) && unread.includes(stop.id), "游标没推进 → 下次唤醒两条都在");
  applyOp(s, { op: "seen", at: 9, room: s.id, who: child, seq: stop.seq });
  assert.equal(unreadFor(s, child).rows.length, 0);
}
console.log("room-interrupt ok");