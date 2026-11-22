// room? 参数的顺序: 验 room 目标 → 入座 → append (daemon/room-spawn.ts), 用真 judge / 真 fold。
import assert from "node:assert/strict";
import { applyOp, judge, whoKey, type RoomState, type Who } from "../shared/room.js";
import { checkRoomTarget, seatThenAppend } from "../daemon/room-spawn.js";
import { room, uid, W } from "./room-fixture.js";

const ME = W(uid(1)), KID = W(uid(2));
const rooms = new Map<string, RoomState>();
const reset = (members: Who[]) => { rooms.clear(); rooms.set("adhoc:0000000a", room("adhoc:0000000a", members)); };
const deps = {
  resolve: (ref: string) => (rooms.has(ref) ? { room: ref } : { error: "认不出这个 room: " + ref }),
  isMember: (r: string, w: Who) => rooms.get(r)?.members.has(whoKey(w)) ?? false,
};
const join = (r: string) => {
  const s = rooms.get(r)!;
  if (!s.members.has(whoKey(KID))) applyOp(s, { op: "join", at: 5_000, room: r, who: KID, ord: s.nextOrd, via: "spawn", by: ME });
  return { ok: true as const };
};
const append = (r: string) => {
  const s = rooms.get(r)!;
  const v = judge(s, { author: ME, kind: "task", text: "干活", to: [KID], origin: "tool" }, { now: 6_000 });
  if (v.ok) applyOp(s, v.row);
  return v;
};

// (a) 带 room: 先入座再 append 成功, 被派者是成员, task 行落账
{
  reset([ME]);
  const chk = checkRoomTarget(deps, ME, "adhoc:0000000a");
  assert.equal(chk.ok, true);
  const r = seatThenAppend("adhoc:0000000a", join, append);
  assert.equal(r.ok, true);
  const s = rooms.get("adhoc:0000000a")!;
  assert.equal(s.members.has(whoKey(KID)), true);
  assert.equal(s.members.get(whoKey(KID))!.via, "spawn");
  assert.equal(r.ok && r.verdict.row.kind, "task");
}

// (a') 反例: 旧顺序 (先 append) 对非成员必 409 —— 这就是 bug 本身
{
  reset([ME]);
  const v = append("adhoc:0000000a");
  assert.equal(v.ok, false);
  assert.equal(!v.ok && v.status, 409);
}

// (b) room 认不出 / 调用方不是成员 / 调用方没 uid → 拒, 且不碰 join / append
{
  reset([KID]);
  let touched = 0;
  const spyJoin = (r: string) => { touched++; return join(r); };
  const gate = (me: Who | undefined, ref: string) => {
    const c = checkRoomTarget(deps, me, ref);
    if (c.ok) seatThenAppend(c.room, spyJoin, append);
    return c;
  };
  const unknown = gate(ME, "adhoc:ffffffff");
  assert.deepEqual([unknown.ok, !unknown.ok && unknown.status, !unknown.ok && unknown.reason], [false, 404, "认不出这个 room: adhoc:ffffffff"]);
  const notMember = gate(ME, "adhoc:0000000a");
  assert.deepEqual([notMember.ok, !notMember.ok && notMember.status], [false, 403]);
  const noUid = gate(undefined, "adhoc:0000000a");
  assert.deepEqual([noUid.ok, !noUid.ok && noUid.status], [false, 400]);
  assert.equal(touched, 0);
  assert.equal(rooms.get("adhoc:0000000a")!.members.has(whoKey(ME)), false);
}

// (c) 入座失败 → 不 append; append 被拒 → 如实带原因 (调用方据此 dispatched:false / delegate 回收)
{
  reset([ME]);
  let appended = 0;
  const bad = seatThenAppend("adhoc:0000000a", () => ({ ok: false, reason: "boom" }), (r) => { appended++; return append(r); });
  assert.deepEqual([bad.ok, !bad.ok && bad.reason, appended], [false, "入座失败: boom", 0]);

  const rejected = seatThenAppend("adhoc:0000000a", join, () => ({ ok: false as const, status: 409, reason: "被 judge 拒" }));
  assert.deepEqual([rejected.ok, !rejected.ok && rejected.status, !rejected.ok && rejected.reason], [false, 409, "被 judge 拒"]);
}

console.log("room-spawn-join ok");
