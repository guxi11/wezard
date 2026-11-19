// 契约 §2: 发言权 / status 写入权 / duty 派生 / 覆盖检查 / 唤醒 / 去重 / host / 镜像 / uid。
import assert from "node:assert/strict";
import { applyOp, coversBubble, dmRoomId, hostOf, isUid, mirrors, openDuties, roomHost, uidOf, wakeTargets, msgIdOf, parseMsgId, roomHash, type MsgRow } from "../shared/room.js";
import { H, rejects, room, say, uid, W } from "./room-fixture.js";

const A = W(uid(1)), B = W(uid(2)), C = W(uid(3)), out = W(uid(7)), human = H("T1");

// uid: 已落盘优先; 存量现算确定; bornAt 缺失有确定回退, 不出 undefined
{
  assert.equal(uidOf({ uid: A.id, target: "chat:x#a" }), A.id);
  const u1 = uidOf({ target: "chat:x#a", bornAt: 5 }), u2 = uidOf({ target: "chat:x#a", bornAt: 5 });
  assert.equal(u1, u2);
  assert.ok(isUid(u1));
  const noBirth = uidOf({ target: "chat:x#a" });
  assert.ok(isUid(noBirth) && !noBirth.includes("undefined"));
  assert.equal(noBirth, uidOf({ target: "chat:x#a", bornAt: Number.NaN }));
  assert.notEqual(noBirth, u1);
  assert.throws(() => uidOf({ target: "" }));
  // dm id 只认 uid, 名字 / target 拼不进去
  assert.equal(dmRoomId(B.id, A.id), "dm:" + A.id + "|" + B.id);
  assert.throws(() => dmRoomId("chat:wr#name", A.id));
  assert.throws(() => dmRoomId(A.id, A.id));
  assert.throws(() => dmRoomId(undefined as unknown as string, A.id));
  const id = msgIdOf("chat:wrG", 41);
  assert.deepEqual(parseMsgId(id), { hash: roomHash("chat:wrG"), seq: 41 });
}

// 发言权: 非成员 403 (被拒不成行), 非成员只能 join-req
{
  const s = room("adhoc:00000020", [A, B]);
  rejects(s, { author: out, text: "hi" }, 403);
  assert.equal(s.msgs.length, 0, "被拒的发言不成行");
  const jr = say(s, { author: out, kind: "join-req", text: "让我进" });
  assert.equal(jr.speak, "join-req");
  assert.deepEqual(jr.wake, [A.id], "join-req 唤醒 host");
  rejects(s, { author: A, kind: "system", text: "x" }, 403);
}

// status 写入权: 只有 holder; 别人给 status → 403 (不静默); 不给 status → 普通线程回复
{
  const s = room("adhoc:00000021", [A, B, C]);
  const q = say(s, { author: A, kind: "ask", to: [B], text: "?" });
  for (const st of ["done", "passed", "canceled", "need", "progress"] as const)
    rejects(s, { author: C, kind: "reply", re: [q.id], status: st, statusGiven: true, text: "我替它答" }, 403);
  const plain = say(s, { author: C, kind: "reply", re: [q.id], text: "插一句" });
  assert.equal(plain.status, undefined);
  assert.equal(plain.closes, undefined);
  rejects(s, { author: B, kind: "reply", re: [q.id], status: "error", statusGiven: true, text: "x" }, 403);
  // 数组里混一条不是自己的 → 整行 403
  const q2 = say(s, { author: A, kind: "ask", to: [C], text: "?" });
  const why = rejects(s, { author: B, kind: "reply", re: [q.id, q2.id], status: "done", statusGiven: true, text: "ok" }, 403);
  assert.ok(why.includes(q2.id));
  // need 不关, 唤醒提问者
  const need = say(s, { author: B, kind: "reply", re: [q.id], status: "need", statusGiven: true, text: "要哪个?" });
  assert.deepEqual(need.wake, [A.id]);
  assert.equal(openDuties(s).filter((d) => d.msg === q.id).length, 1);
  // progress 不唤醒
  const prog = say(s, { author: B, kind: "reply", re: [q.id], status: "progress", statusGiven: true, text: "50%" });
  assert.deepEqual(prog.wake, []);
  // 缺省 status: holder 带正文 = done; canceled 也能写
  const done = say(s, { author: B, kind: "reply", re: [q.id], text: "答案" });
  assert.equal(done.status, "done");
  assert.deepEqual(done.closes, [q.id + "@wizard:" + B.id]);
  const cx = say(s, { author: C, kind: "reply", re: [q2.id], status: "canceled", statusGiven: true, text: "不做了" });
  assert.deepEqual(cx.closes, [q2.id + "@wizard:" + C.id]);
  // 人是超集
  const q3 = say(s, { author: A, kind: "ask", to: [B], text: "?" });
  const g = room("chat:wrG", [A, B]);
  void q3; void g;
}

// 覆盖检查: 提问者补充了 holder 没读到的 → 409 先读
{
  const s = room("adhoc:00000022", [A, B]);
  const q = say(s, { author: A, kind: "task", to: [B], text: "做 X" });
  applyOp(s, { op: "seen", at: 1, room: s.id, who: B, seq: q.seq });
  const sup = say(s, { author: A, kind: "say", re: [q.id], text: "补充: 也做 Y" });
  const why = rejects(s, { author: B, kind: "reply", re: [q.id], text: "X 做完了" }, 409);
  assert.ok(why.includes(String(sup.seq)));
  applyOp(s, { op: "seen", at: 1, room: s.id, who: B, seq: sup.seq });
  say(s, { author: B, kind: "reply", re: [q.id], text: "X Y 都做完了" });
  assert.equal(openDuties(s).length, 0);
}

// 绑定 room 的人话: 没点名 → host (读时求值); 点名 → 被点名者; 气泡由第一条 reply 覆盖
{
  const s = room("chat:wrG", [A, B]);
  const m = say(s, { author: human, origin: "inbound", text: "在吗", bubble: { stream: "s1", expires: 9e12 } });
  assert.deepEqual(m.wake, [A.id]);
  assert.equal(mirrors(m), false, "inbound 不回镜");
  const named = say(s, { author: human, origin: "inbound", text: ".b 看下", to: [B] });
  assert.deepEqual(named.wake, [B.id]);
  const r1 = say(s, { author: A, kind: "reply", re: [m.id], text: "在" });
  assert.equal(coversBubble(s, r1), m.id);
  assert.equal(mirrors(r1), true);
  const r2 = say(s, { author: A, kind: "say", re: [m.id], text: "补一句" });
  const r3: MsgRow = { ...r1, id: "x.99", seq: 99, text: "再答" };
  applyOp(s, r3);
  assert.equal(coversBubble(s, r3), undefined, "只有第一条覆盖");
  void r2;
  // 镜像规则: trigger / migrate / 无绑定 room 不镜像
  assert.equal(mirrors({ ...r1, kind: "trigger" }), false);
  assert.equal(mirrors({ ...r1, origin: "migrate" }), false);
  assert.equal(mirrors({ ...r1, room: "dm:" + A.id + "|" + B.id }), false);
  assert.equal(mirrors({ ...r1, origin: "daemon", kind: "system" }), true);
}

// host: 最早加入的 wizard; 人不参与; 退出再进排到队尾
{
  assert.deepEqual(hostOf([{ who: human, ord: 0 }, { who: B, ord: 3 }, { who: A, ord: 2 }]), A);
  assert.equal(hostOf([{ who: human, ord: 1 }]), undefined);
  const s = room("adhoc:00000023", [A, B]);
  applyOp(s, { op: "leave", at: 1, room: s.id, who: A, by: A });
  applyOp(s, { op: "join", at: 2, room: s.id, who: A, ord: s.nextOrd, via: "invite", by: B });
  assert.deepEqual(roomHost(s), B);
}

// 去重: 同作者同文同 re 10 分钟内 → 返回已有行
{
  const s = room("adhoc:00000024", [A, B]);
  const a = say(s, { author: A, text: "同一句" });
  const b = say(s, { author: A, text: "同一句" });
  assert.equal(a.id, b.id);
  assert.equal(s.msgs.length, 1);
}

// after: 前置没 done 不唤醒 holder
{
  const s = room("adhoc:00000025", [A, B, C]);
  const first = say(s, { author: A, kind: "task", to: [B], text: "先" });
  const later = say(s, { author: A, kind: "task", to: [C], text: "后", after: [first.id] });
  assert.deepEqual(later.wake, []);
  say(s, { author: B, kind: "reply", re: [first.id], text: "完" });
  assert.deepEqual(wakeTargets(s, later), [C.id]);
}
console.log("room-duty ok");
