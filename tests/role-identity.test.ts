import assert from "node:assert/strict";
import { makeDirectory, allMessages, type Directory } from "../shared/role-view.js";
import type { DetailRecord, TurnDetailRecord } from "../shared/detail-store.js";
import type { WorldFacts } from "../shared/world.js";

// P7 ⑦ 身份页: 同身份多化身在 rolepage 聚成一页 —— canon 收敛、名字解析不再
// last-wins、状态合并 (任一化身活着即活着); 无 identity 的老快照恒等 (一比一兼容)。

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

// 两群各一个化身, 同一身份 (identity = chat:wrA#fix); other 是别的身份
const f = facts([
  mkWizard(aInGroupA, aInGroupA, true),   // 锚点化身, 活着
  mkWizard(aInGroupB, aInGroupA, false),  // 另一群的化身, 冷的
  mkWizard(other, other, false),
]);
// 记录: A 群化身一轮、B 群化身一轮 (私聊 peer)、other 一轮
const records: DetailRecord[] = [
  turn("t1", aInGroupA, "A 群问", "A 群答", "chat:wrA"),
  turn("t2", aInGroupB, "B 群私聊问", "B 群私聊答", ""),
  turn("t3", other, "别的问题", "别的回答", "chat:wrA"),
];

const dir: Directory = makeDirectory(records, f);
// canon: 同身份两化身 → 锚点 target; 无关的恒等
assert.equal(dir.canon(aInGroupA), aInGroupA);
assert.equal(dir.canon(aInGroupB), aInGroupA, "B 群化身收敛到身份锚点");
assert.equal(dir.canon(other), other);
// resolve: 老链接里的化身 target → 身份页; 名字解析不再 last-wins
assert.equal(dir.resolve(aInGroupB), aInGroupA, "化身链接落到身份页");
assert.equal(dir.resolve("fix"), aInGroupA, "名字 → 身份页");
assert.equal(dir.resolve(other), other);
// 状态合并: 锚点活着 → 身份页活着
const st = dir.status(aInGroupA, now)!;
assert.equal(st.alive, true, "任一化身活着, 身份页活着");
// 消息双方都收敛: 三轮的出消息里 fix 的两条都归身份页
const msgs = allMessages(records, now, dir.canon);
const outs = msgs.filter((m) => m.dir === "out" && m.from === aInGroupA);
assert.equal(outs.length, 2, "两群两个化身的出消息聚到同一页");
assert.equal(msgs.filter((m) => m.dir === "out" && m.from === other).length, 1);
// 私聊窗口也按身份聚合 (p:<对端> 键里对端是规范 target)
assert.ok(msgs.every((m) => m.from !== aInGroupB && m.to !== aInGroupB), "化身 target 不再出现在消息两端");

// 老 daemon 快照 (无 identity): 恒等 —— 各化身各一页, 一比一兼容
const oldFacts = facts([mkWizard(aInGroupA), mkWizard(aInGroupB)]);
const oldDir = makeDirectory(records, oldFacts);
assert.equal(oldDir.canon(aInGroupB), aInGroupB, "无 identity 恒等");
assert.equal(oldDir.resolve(aInGroupB), aInGroupB);
const oldMsgs = allMessages(records, now, oldDir.canon);
assert.equal(oldMsgs.filter((m) => m.dir === "out" && m.from === aInGroupB).length, 1, "老快照: 各自一页");

console.log("role-identity: 同身份多化身聚成一页 (canon/名字/状态/消息), 老快照一比一");
