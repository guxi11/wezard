// room-prune: chat room 的成员清理规则 (host / duty / 近期发言 / 默认身份 / 管家 / 订阅 保留,
// 迁移带进来的历史实例与名册已无记录的 uid 离开)。
import assert from "node:assert/strict";
import { applyOp, foldRoom, msgIdOf, openDuties, roomHost, type MsgRow, type RoomState, type Who } from "../shared/room.js";
import { pruneLeaveOps, selectRoomPrune, type PruneCtx } from "../daemon/room-prune.js";
import { H, uid, W } from "./room-fixture.js";

const T0 = 1_000_000_000_000;
const HOUR = 3600_000;
const ROOM = "chat:wrTESTPRUNE0000000000000000000000";

const mk = (members: Who[]): RoomState => {
  const s = foldRoom(ROOM, [{ op: "open", at: T0, room: ROOM, kind: "wecom-group", by: { kind: "daemon", id: "wezard" } }]);
  members.forEach((who, i) => applyOp(s, { op: "join", at: T0 + i, room: ROOM, who, ord: s.nextOrd, via: "migrate", by: { kind: "daemon", id: "wezard" } }));
  return s;
};
const msg = (s: RoomState, author: Who, at: number, extra: Partial<MsgRow> = {}): void => {
  const seq = s.seq + 1;
  applyOp(s, { op: "msg", at, room: ROOM, id: msgIdOf(ROOM, seq), seq, author, ord: 0, speak: author.kind === "human" ? "human" : "member",
    kind: "say", text: "m" + seq, origin: "tool", ...extra } as MsgRow);
};

const defaultW = W(uid(1)), hostW = W(uid(2)), recentW = W(uid(3)), dutyW = W(uid(4));
const staleW = W(uid(5)), ghost = W(uid(6)), watchW = W(uid(7)), stewardW = W(uid(8));
const human = H("T001");
const recs = new Map<string, { target: string; name: string }>([
  [defaultW.id, { target: ROOM, name: "default" }],
  [hostW.id, { target: ROOM + "#old", name: "hostish" }],
  [recentW.id, { target: ROOM + "#worker", name: "recent" }],
  [dutyW.id, { target: ROOM + "#worker", name: "duty" }],
  [staleW.id, { target: ROOM + "#worker", name: "stale" }],
  [watchW.id, { target: ROOM + "#worker", name: "watch" }],
  [stewardW.id, { target: ROOM + "#steward", name: "steward" }],
]);
const ctx = (now: number, stewardUid?: string): PruneCtx => ({ now, keepRecentMs: 48 * HOUR, stewardUid, rec: (u) => recs.get(u) });

// ① 成员盘: 默认身份 / 近期 / duty / 订阅 / 管家 保留; 迁移的旧实例与名册无记录者离开
{
  const s = mk([hostW, defaultW, recentW, dutyW, staleW, ghost, watchW, stewardW, human]);
  msg(s, human, T0 + 10);
  msg(s, recentW, T0 + 60 * HOUR);
  msg(s, staleW, T0 + 60 * HOUR, { origin: "migrate" });     // 迁移行不算它在本 room 说过话
  msg(s, hostW, T0 + 80 * HOUR, { kind: "ask", to: [dutyW], text: "查一下" }); // dutyW 开了账 (host 槽位的人话也归 host)
  applyOp(s, { op: "watch", at: T0 + 90 * HOUR, room: ROOM, who: watchW, on: true });
  const now = T0 + 100 * HOUR;
  const p = selectRoomPrune(s, ctx(now, stewardW.id));
  const kept = new Map(p.keep.map((k) => [k.who.id, k.why]));
  const dropped = p.drop.map((d) => d.who.id);
  assert.equal(p.before, 9);
  assert.deepEqual([...kept.keys()].sort(), [defaultW.id, hostW.id, recentW.id, dutyW.id, watchW.id, stewardW.id, human.id, "wezard"].filter((x) => x !== "wezard").sort());
  assert.deepEqual(dropped.sort(), [staleW.id, ghost.id].sort());
  assert.equal(kept.get(hostW.id), "host");
  assert.equal(kept.get(defaultW.id), "本群默认身份");
  assert.match(kept.get(recentW.id)!, /说过话/);
  assert.match(kept.get(dutyW.id)!, /duty 1/);
  assert.equal(kept.get(stewardW.id), "本群管家");
  assert.equal(kept.get(watchW.id), "订阅中");
  assert.match(p.drop.find((d) => d.who.id === ghost.id)!.why, /名册已无此身份/);
  assert.match(p.drop.find((d) => d.who.id === staleW.id)!.why, /没在本 room 说话/);
}

// ② 落账: 一人一条 leave, seq 连续不撞; fold 后成员减少、host 不变
{
  const s = mk([hostW, recentW, staleW, ghost]);
  msg(s, hostW, T0 + HOUR);
  msg(s, recentW, T0 + 2 * HOUR);
  const p = selectRoomPrune(s, ctx(T0 + 3 * HOUR));
  assert.equal(p.drop.length, 2);
  const ops = pruneLeaveOps(s, p.drop, T0 + 4 * HOUR);
  const seqs = ops.filter((o) => o.op === "msg").map((o) => (o as MsgRow).seq);
  assert.equal(new Set(seqs).size, seqs.length);
  assert.equal(ops.filter((o) => o.op === "leave").length, 2);
  // 调用方的 state 不被改 (pruneLeaveOps 只在克隆上 fold)
  assert.equal(s.members.size, 4);
  const after = foldRoom(ROOM, [
    { op: "open", at: T0, room: ROOM, kind: "wecom-group", by: { kind: "daemon", id: "wezard" } },
    ...[...s.members.values()].map((m, i) => ({ op: "join" as const, at: T0 + i, room: ROOM, who: m.who, ord: m.ord, via: m.via, by: m.by })),
    ...s.msgs, ...ops,
  ]);
  assert.equal(after.members.size, 2);
  assert.deepEqual(roomHost(after), hostW);
  // ③ 幂等: 再规划一次没有可移的人
  assert.equal(selectRoomPrune(after, ctx(T0 + 5 * HOUR)).drop.length, 0);
}

// ④ duty holder 永远不被移 (移了会把它的账取消) —— 即便它既不是 host 也没说过话
{
  const s = mk([hostW, dutyW]);
  msg(s, hostW, T0 + HOUR, { kind: "task", to: [dutyW], text: "做" });
  assert.equal(openDuties(s).length, 1);
  const p = selectRoomPrune(s, ctx(T0 + 100 * HOUR));
  assert.equal(p.drop.length, 0);
}
console.log("room-prune: all assertions passed");
