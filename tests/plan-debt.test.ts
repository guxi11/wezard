// plan 闲时提醒抑制: owner 持有 或 作为 asker 派出的、带该 planId 的 open duty 都算欠账。
import assert from "node:assert/strict";
import { planHasOpenDuty } from "../shared/room-view.js";
import { applyOp, type Who } from "../shared/room.js";
import { room as mkRoom, say, uid, W } from "./room-fixture.js";

const A = W(uid(1)), B = W(uid(2)), C = W(uid(3));
const mk = (author: Who, to: Who, planId?: string) => {
  const s = mkRoom("adhoc:x", [A, B, C]);
  const ask = say(s, { author, kind: "ask", to: [to], text: "干活", ...(planId ? { planId } : {}) });
  return { s, ask };
};

{ const { s } = mk(B, A, "p1"); assert.equal(planHasOpenDuty([s], "p1", A.id), true, "owner 持有"); }
{ const { s } = mk(A, B, "p1"); assert.equal(planHasOpenDuty([s], "p1", A.id), true, "owner 派出、对方未关"); }
{
  const { s, ask } = mk(A, B, "p1");
  say(s, { author: B, kind: "reply", re: [ask.id], status: "done", text: "ok" });
  assert.equal(planHasOpenDuty([s], "p1", A.id), false, "对方 done 关账后");
}
{ const { s } = mk(A, B, "p2"); assert.equal(planHasOpenDuty([s], "p1", A.id), false, "planId 不同"); }
{ const { s } = mk(B, C, "p1"); assert.equal(planHasOpenDuty([s], "p1", A.id), false, "别人之间"); }
{ const { s } = mk(A, B); assert.equal(planHasOpenDuty([s], "p1", A.id), false, "无 planId"); }
console.log("plan-debt ok");
