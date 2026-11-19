// room 成员列表 (shared/group-members.ts): 读 room 账本的 join 行, 补名册的活体状态与类名。
import assert from "node:assert/strict";
import { isGroupChat, roomMembers } from "../shared/group-members.js";
import type { RoomFact } from "../shared/room-view.js";
import { H, W, uid } from "./room-fixture.js";
import type { WorldFactClass, WorldFactWizard } from "../shared/world.js";
import { uidOf } from "../shared/room.js";

const A = W(uid(1));
const B = W(uid(2));
const G = "chat:wrG";

const wizard = (target: string, name: string, over: Partial<WorldFactWizard> = {}): WorldFactWizard => ({
  target, name, description: "", chat: "", cwd: "", model: "", cli: "",
  busy: false, alive: false, lastActivity: 1, summary: "", ...over,
});
const wA = wizard(G + "#guide", "guide", { uid: A.id, alive: true });
const wB = wizard("chat:wrOther#worker", "worker", { uid: B.id, busy: true, ordinal: 2, identity: "class-1" });

const room: RoomFact = {
  id: G, kind: "wecom-group", title: "", bound: true, host: A,
  members: [
    { who: A, name: "guide", via: "founder", since: 100, ord: 1, host: true },
    { who: H("U1"), name: "张三", via: "inbound", since: 200, ord: 2, host: false },
    { who: B, name: "worker", via: "invite", since: 300, ord: 3, host: false },
  ],
  openDuties: 0,
};
const classes: WorldFactClass[] = [{ id: "class-1", name: "研究", role: "coder", workspace: "/w" }];

// ── 1. 序: host 先, 然后 wizard (加入序), 人最后 ──────────────────────
{
  const ms = roomMembers(room, [wA, wB], classes);
  assert.deepEqual(ms.map((m) => m.name), ["guide", "worker", "张三"]);
  assert.equal(ms[0]!.host, true);
  assert.equal(ms[0]!.kind, "wizard");
  assert.equal(ms[2]!.kind, "human");
  assert.equal(ms[0]!.via, "founder");
  assert.equal(ms[0]!.alive, true, "名册的活体状态跟着走");
  assert.equal(ms[1]!.busy, true);
  assert.equal(ms[1]!.className, "研究", "类实例标出所属类");
  assert.equal(ms[0]!.className, undefined);
  assert.equal(ms[1]!.foreign, true, "实例 home base ≠ 本 room = 从别处加入");
  assert.equal(ms[0]!.foreign, undefined);
}

// ── 2. uid 对不上名册: 名字仍来自 room 账本自己 ─────────────────────
{
  const ghost = { ...room, members: [{ who: W(uid(9)), name: "旧实例", via: "migrate" as const, since: 1, ord: 1, host: false }] };
  const ms = roomMembers(ghost, [], []);
  assert.equal(ms.length, 1);
  assert.equal(ms[0]!.name, "旧实例");
  assert.equal(ms[0]!.alive, undefined, "名册里没有就没有活体状态");
  assert.equal(ms[0]!.foreign, undefined);
}

// ── 3. 不是群就没有成员这一栏; uidOf 与 room 的 uid 同一套 ────────────
{
  assert.equal(isGroupChat("chat:wrG"), true);
  assert.equal(isGroupChat("user:U1"), false);
  assert.equal(isGroupChat("dm:" + A.id + "|" + B.id), false);
  assert.deepEqual(roomMembers({ ...room, members: [] }, [], []), []);
  assert.equal(uidOf({ target: G + "#guide", uid: A.id }), A.id, "已落盘的 uid 只读");
}

console.log("group-members: 成员读 room 账本 (host 先 / 人最后 / 类名 / 外来实例)");
