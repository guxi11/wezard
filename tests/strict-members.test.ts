// room 口径的成员原语 (契约 §2): 成员关系是账本里的 join / leave 行, 不再有 members.json。
// 保住旧 members 表的四条行为: join 升级式 (via/by 刷新、since/ord 保留) / 游标只进不退 /
// 离开从每个 room 摘掉 / 列出来的只是本 room 成员 (资格按 room 隔离)。
import assert from "node:assert/strict";
import { applyOp, foldRoom, leaveOps, whoKey, type RoomOp } from "../shared/room.js";
import { H, room, say, uid, W } from "./room-fixture.js";

const A = W(uid(1)), B = W(uid(2));
const chat = "chat:wrS", other = "chat:wrO";

// join 升级式: 再 join 只刷新 via / by, 保留最早的 since 与加入序 ord
{
  const s = room(chat, [A]);
  const since = s.members.get(whoKey(A))!.since;
  applyOp(s, { op: "join", at: since + 50, room: chat, who: A, ord: s.nextOrd, via: "mention", by: H("u1") });
  assert.equal(s.members.get(whoKey(A))!.via, "mention");
  applyOp(s, { op: "join", at: since + 80, room: chat, who: A, ord: s.nextOrd, via: "approve", by: B });
  const m = s.members.get(whoKey(A))!;
  assert.equal(m.via, "approve", "重复 join 升级方式");
  assert.equal(m.by.kind + ":" + m.by.id, whoKey(B), "by 刷新为带入者");
  assert.equal(m.since, since, "since 保留最早的一次");
  assert.equal(m.ord, 1, "加入序不动 (host 求值靠它)");
}

// 成员资格按 room 隔离: 同一个 wizard 在别的 room 不算成员
{
  const s = room(chat, [A]);
  assert.equal(s.members.has(whoKey(A)), true);
  assert.equal(s.members.has(whoKey(B)), false, "没 join 的不算成员");
}

// 游标 (seen) 只进不退
{
  const s = room(chat, [A]);
  applyOp(s, { op: "seen", at: 1, room: chat, who: A, seq: 7 });
  applyOp(s, { op: "seen", at: 2, room: chat, who: A, seq: 3 });
  assert.equal(s.members.get(whoKey(A))!.seen, 7);
  applyOp(s, { op: "seen", at: 3, room: chat, who: A, seq: 9 });
  assert.equal(s.members.get(whoKey(A))!.seen, 9);
}

// 离开 = 每个 room 各写 leave (leaveOps 只在本 room 有名下 duty 时多写 canceled 行);
// 两处都摘掉, 不影响别人
{
  const s1 = room(chat, [A, B]);
  const s2 = room(other, [A]);
  for (const s of [s1, s2]) for (const o of leaveOps(s, A, A, 9_000)) applyOp(s, o);
  assert.equal(s1.members.has(whoKey(A)), false);
  assert.equal(s2.members.has(whoKey(A)), false);
  assert.equal(s1.members.has(whoKey(B)), true, "别的成员不受影响");
  assert.equal([...s1.members.values()].map((x) => whoKey(x.who)).join(","), whoKey(B), "列出来的只是本 room 成员");
}

// 账本折叠: join / seen / leave 一串行重放出同一个成员表
{
  const s = room(chat, [A, B]);
  const q = say(s, { author: B, kind: "task", to: [A], text: "做" });
  const ops: RoomOp[] = [
    { op: "open", at: 1, room: chat, kind: "wecom-group", by: B },
    ...[...s.everMembers.values()].map((who, i): RoomOp => ({ op: "join", at: 1 + i, room: chat, who, ord: i + 1, via: "founder", by: B })),
    ...s.msgs,
    { op: "seen", at: 5, room: chat, who: A, seq: q.seq },
    ...leaveOps(s, A, A, 9_000),
  ];
  const a = foldRoom(chat, ops), b = foldRoom(chat, ops);
  assert.deepEqual([...a.members.keys()], [...b.members.keys()]);
  assert.deepEqual([...a.members.keys()], [whoKey(B)], "A 走了, B 还在");
}

console.log("strict-members: join 升级式 / 游标只进 / 离开按 room 摘除 / 折叠一致");
