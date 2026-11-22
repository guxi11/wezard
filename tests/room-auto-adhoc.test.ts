// 方案 B: chat_ask 点名多个群外 wizard → 自动落 adhoc (daemon/room-auto-adhoc.ts + shared findSetAdhoc)。
import assert from "node:assert/strict";
import { applyOp, findPairAdhoc, findSetAdhoc, judge, whoKey, type RoomState, type Who } from "../shared/room.js";
import { autoAdhocTarget } from "../daemon/room-auto-adhoc.js";
import { H, room, uid, W } from "./room-fixture.js";

const ME = W(uid(1)), A = W(uid(2)), B = W(uid(3)), C = W(uid(4));
const parents: Record<string, string> = {};
let opened: string[] = [];
let states: RoomState[] = [];
const deps = {
  states: () => states,
  open: (me: Who, others: Who[]) => {
    const id = "adhoc:" + (0x100 + opened.length).toString(16).padStart(8, "0");
    states.push(room(id, [me, ...others]));
    opened.push(id);
    return id;
  },
  parentUidOf: (u: string) => parents[u],
};
const reset = () => { opened = []; states = []; for (const k of Object.keys(parents)) delete parents[k]; };

// findSetAdhoc: 顺序无关、恰好相等、多个取最近活跃; findPairAdhoc 行为不变
{
  const x = room("adhoc:00000001", [ME, A, B]);
  const y = room("adhoc:00000002", [B, ME, A]);
  const z = room("adhoc:00000003", [ME, A, B, C]);
  const w = room("adhoc:00000004", [ME, A]);
  assert.equal(findSetAdhoc([x, z, w], [A.id, B.id, ME.id]), "adhoc:00000001");
  assert.equal(findSetAdhoc([x, y], [ME.id, A.id, B.id]) !== undefined, true);
  assert.equal(findSetAdhoc([z], [ME.id, A.id, B.id]), undefined, "多一人不复用");
  assert.equal(findSetAdhoc([x], [ME.id, A.id]), undefined, "少一人不复用");
  assert.equal(findPairAdhoc([x, w], ME.id, A.id), "adhoc:00000004");
  assert.equal(findSetAdhoc([room("dm:x", [ME, A, B])], [ME.id, A.id, B.id]), undefined, "只认 adhoc:");
}

// 多人自动建: 调用方 founder = host, 成员 = {me, A, B}
{
  reset();
  const r = autoAdhocTarget(deps, ME, [A, B], false);
  assert.ok("room" in r);
  const s = states.find((x) => x.id === (r as { room: string }).room)!;
  assert.deepEqual([...s.members.keys()].sort(), [whoKey(ME), whoKey(A), whoKey(B)].sort());
  assert.equal(s.members.get(whoKey(ME))!.ord, 1);
  // 落一条 ask 能过真 judge (to 都是成员)
  const v = judge(s, { author: ME, kind: "ask", text: "查", to: [A, B], origin: "tool" }, { now: 9_000 });
  assert.equal(v.ok, true);
  // 同集合 (顺序不同) 复用, 不再开
  const again = autoAdhocTarget(deps, ME, [B, A], false);
  assert.deepEqual(again, r);
  assert.equal(opened.length, 1);
  // 多一人 / 少一人 → 另开
  const more = autoAdhocTarget(deps, ME, [A, B, C], false);
  const less = autoAdhocTarget(deps, ME, [A, C], false);
  assert.equal(opened.length, 3);
  assert.notDeepEqual(more, r);
  assert.notDeepEqual(less, r);
}

// 缺省是绑定群: 群内 A + 群外 B → 新 adhoc, 群成员不变 (不 invite B)
{
  reset();
  const group = room("chat:wrG", [ME, A]);
  states.push(group);
  const r = autoAdhocTarget(deps, ME, [A, B], false) as { room: string };
  assert.ok(r.room.startsWith("adhoc:"));
  assert.equal(group.members.has(whoKey(B)), false);
  assert.equal(group.members.size, 2);
}

// 含 human → 400; 去掉自己后为空 → 400
{
  reset();
  const r = autoAdhocTarget(deps, ME, [A, H("T1")], false);
  assert.deepEqual("status" in r && r.status, 400);
  assert.equal(opened.length, 0);
  const self = autoAdhocTarget(deps, ME, [ME, ME], false);
  assert.deepEqual("status" in self && self.status, 400);
}

// interrupt: 非直属 parent → 403 (且不开房); 全是直属 parent → 放行
{
  reset();
  parents[A.id] = ME.id;
  const denied = autoAdhocTarget(deps, ME, [A, B], true);
  assert.deepEqual("status" in denied && denied.status, 403);
  assert.match("reason" in denied ? denied.reason : "", /不给 host 打断权/);
  assert.equal(opened.length, 0);
  parents[B.id] = ME.id;
  const ok = autoAdhocTarget(deps, ME, [A, B], true);
  assert.ok("room" in ok);
  // 不带 interrupt 时 parent 关系无关
  parents[A.id] = "w000000000999";
  assert.ok("room" in autoAdhocTarget(deps, ME, [A, B], false));
}

// 显式 room 不自动建: 分支只在 roomTargetOf 无 ref 时进入; 显式 room + 非成员 to → judge 409
{
  reset();
  const s = room("adhoc:0000000a", [ME]);
  const v = judge(s, { author: ME, kind: "ask", text: "x", to: [A, B], origin: "tool" }, { now: 9_000 });
  assert.equal(!v.ok && v.status, 409);
  assert.equal(opened.length, 0);
}

console.log("room-auto-adhoc ok");
