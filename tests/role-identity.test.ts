// P7 ⑦ 身份页: 同身份多化身在 rolepage 聚成一页 —— canon 收敛、名字解析不再
// last-wins、状态合并 (任一化身活着即活着); 无 identity 的老快照恒等。
//
// room 模型之后消息不再由 turn 记录重建 (见 tests/room-view.test.ts), 这一份只管名录。
import assert from "node:assert/strict";
import { makeDirectory, roleInfo, type Directory } from "../shared/role-view.js";
import type { DetailRecord, TurnDetailRecord } from "../shared/detail-store.js";
import type { WorldFacts } from "../shared/world.js";

const now = Date.now();
const aInGroupA = "chat:wrA#fix", aInGroupB = "chat:wrB#fix", other = "chat:wrA#other";

const mkWizard = (target: string, identity?: string, alive = false) => ({
  target, ...(identity ? { identity } : {}), name: target.includes("#fix") ? "fix" : "other",
  description: "", chat: "", cwd: "", model: "", cli: "", busy: false, alive, lastActivity: 1, summary: "",
});
const facts = (wizards: ReturnType<typeof mkWizard>[]): WorldFacts =>
  ({ wizards, plans: [], schedules: [], chatNames: {} }) as unknown as WorldFacts;

const turn = (id: string, target: string, q: string, body: string, channel = ""): DetailRecord => ({
  kind: "turn", id, createdAt: now - 1000, updatedAt: now, closed: true,
  target, sessionId: "s-" + id, channel, userQuery: q, items: [{ t: "text", body, ts: now, final: true }],
} as TurnDetailRecord);

const f = facts([
  mkWizard(aInGroupA, aInGroupA, true),
  mkWizard(aInGroupB, aInGroupA, false),
  mkWizard(other, other, false),
]);
const records: DetailRecord[] = [
  turn("t1", aInGroupA, "A 群问", "A 群答", "chat:wrA"),
  turn("t2", aInGroupB, "B 群私聊问", "B 群私聊答", ""),
  turn("t3", other, "别的问题", "别的回答", "chat:wrA"),
];

const dir: Directory = makeDirectory(records, f);
assert.equal(dir.canon(aInGroupA), aInGroupA);
assert.equal(dir.canon(aInGroupB), aInGroupA, "B 群化身收敛到身份锚点");
assert.equal(dir.canon(other), other);
assert.equal(dir.resolve(aInGroupB), aInGroupA, "化身链接落到身份页");
assert.equal(dir.resolve("fix"), aInGroupA, "名字 → 身份页");
assert.equal(dir.resolve(other), other);

const st = dir.status(aInGroupA, now)!;
assert.equal(st.alive, true, "任一化身活着, 身份页活着");
assert.equal(st.busy, false);
assert.equal(st.runningUntil, 0);

const info = roleInfo(aInGroupA, dir, f, undefined, now);
assert.equal(info.name, "fix");
assert.equal(info.kind, "wizard");
assert.equal(info.alive, true);

// 老 daemon 快照 (无 identity): 恒等 —— 各化身各一页, 一比一兼容
const oldDir = makeDirectory(records, facts([mkWizard(aInGroupA), mkWizard(aInGroupB)]));
assert.equal(oldDir.canon(aInGroupB), aInGroupB, "无 identity 恒等");
assert.equal(oldDir.resolve(aInGroupB), aInGroupB);

console.log("role-identity: 同身份多化身聚成一页 (canon / 名字 / 状态), 老快照一比一");
