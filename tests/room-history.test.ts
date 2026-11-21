import assert from "node:assert/strict";
import { applyOp, findPairAdhoc, historyCursor, planDm, seatSeenOps, unreadFor, whoKey } from "../shared/room.js";
import { H, room, say, uid, W } from "./room-fixture.js";

const A = W(uid(1)), B = W(uid(2)), C = W(uid(3)), D = W(uid(4));
const mk = () => {
  const s = room("adhoc:aaaaaaaa", [A, B]);
  for (let i = 0; i < 5; i++) say(s, { author: A, text: "m" + (i + 1) });
  return s;
};
const seat = (s: ReturnType<typeof mk>, who: typeof C, history: unknown) => {
  const seen = seatSeenOps(s, who, 9_000, history);
  assert.ok(Array.isArray(seen), JSON.stringify(seen));
  applyOp(s, { op: "join", at: 9_000, room: s.id, who, ord: s.nextOrd, via: "invite", by: A });
  seen.forEach((o) => applyOp(s, o));
  return unreadFor(s, who).rows.map((r) => r.text);
};

// historyCursor 四种取值
{
  const s = mk();
  assert.equal(historyCursor(s, undefined), null);
  assert.equal(historyCursor(s, "all"), null);
  assert.equal(historyCursor(s, "none"), 5);
  assert.equal(historyCursor(s, 2), 3);
  assert.equal(historyCursor(s, "2"), 3);
  assert.equal(historyCursor(s, 5), null, "不足/恰好 N 条 → 全部");
  assert.equal(historyCursor(s, 99), null);
  assert.equal(historyCursor(s, "from:" + s.msgs[2]!.id), 2);
  // 越界 / 错误
  for (const bad of [0, -1, 1.5, "from:nope.9", "bogus", {}]) {
    const r = historyCursor(s, bad);
    assert.ok(r !== null && typeof r === "object" && "error" in r, "应报错: " + JSON.stringify(bad));
  }
}
// join + seen 后 unreadFor 只列游标之后的行
assert.deepEqual(seat(mk(), C, "none"), []);
assert.deepEqual(seat(mk(), C, 2), ["m4", "m5"]);
{ const s = mk(); assert.deepEqual(seat(s, C, "from:" + s.msgs[1]!.id), ["m2", "m3", "m4", "m5"]); }
assert.deepEqual(seat(mk(), C, "all"), ["m1", "m2", "m3", "m4", "m5"]);
assert.deepEqual(seat(mk(), C, undefined), ["m1", "m2", "m3", "m4", "m5"]);
// 人也一样
assert.deepEqual(seat(mk(), H("u1") as typeof C, 1), ["m5"]);

// planDm
{
  const id = "dm:" + [uid(1), uid(2)].sort().join("|");
  assert.deepEqual(planDm(undefined, uid(1), uid(2)), { kind: "create" });
  assert.deepEqual(planDm(room(id, [A, B]), uid(1), uid(2)), { kind: "use" });
  assert.deepEqual(planDm(room(id, [A]), uid(1), uid(2)), { kind: "rejoin", missing: [uid(2)] });
  assert.deepEqual(planDm(room(id, []), uid(1), uid(2)), { kind: "rejoin", missing: [uid(1), uid(2)] });
  assert.deepEqual(planDm(room(id, [A, B, C]), uid(1), uid(2)), { kind: "pair-adhoc" });
  assert.deepEqual(planDm(room(id, [A, H("h")]), uid(1), uid(2)), { kind: "pair-adhoc" });
}
// findPairAdhoc: 恰好 {A,B}, 多个取最近
{
  const x = room("adhoc:00000001", [A, B], 1_000);
  const y = room("adhoc:00000002", [B, A], 5_000);
  const z = room("adhoc:00000003", [A, B, C], 9_000);
  const w = room("chat:wrx", [A, B], 9_000);
  assert.equal(findPairAdhoc([x, y, z, w], uid(1), uid(2)), "adhoc:00000002");
  say(x, { author: A, text: "late" }, { now: 50_000 });
  assert.equal(findPairAdhoc([x, y, z, w], uid(1), uid(2)), "adhoc:00000001");
  assert.equal(findPairAdhoc([z, w], uid(1), uid(2)), undefined);
  assert.equal(findPairAdhoc([x], uid(1), uid(4)), undefined);
}
void D; void whoKey;
console.log("room-history ok");
