// 实例 = 独立节点 + 独立会话页 (人 2026-11-22 拍板): 同身份的两个实例 (wezard-1 / wezard-15)
// 各是各的页 —— target 与名字都解析到它自己, 状态只看自己那一条事实, 消息的 from/to 不改写。
//
// 删掉的旧断言 (P7 ⑦ 身份聚合: fd8da42 的 canon 收敛 / 名字 → 身份锚点 / 状态合并 / 无 identity
// 恒等) 随实现一起下线: 那一版会让「点 wezard-15」落到 wezard-1 的页面, 且页里没有 wezard-15 的轮次。
//
// room 模型之后消息不再由 turn 记录重建 (见 tests/room-view.test.ts), 这一份只管名录与消息归属。
import assert from "node:assert/strict";
import { allMessages, makeDirectory, roleInfo, type Directory } from "../shared/role-view.js";
import type { DetailRecord, TurnDetailRecord } from "../shared/detail-store.js";
import type { WorldFacts } from "../shared/world.js";

const now = Date.now();
const aInGroupA = "chat:wrA#fix-a", bInGroupB = "chat:wrB#fix-b", other = "chat:wrA#other";
const identity = "user:T03880027A";

const mkWizard = (target: string, name: string, alive = false) => ({
  target, identity, name, description: "", chat: "", cwd: "", model: "", cli: "", busy: false, alive,
  lastActivity: 1, summary: "",
});
const facts = (wizards: ReturnType<typeof mkWizard>[]): WorldFacts =>
  ({ wizards, plans: [], schedules: [], chatNames: {} }) as unknown as WorldFacts;

const turn = (id: string, target: string, q: string, body: string, channel = ""): DetailRecord => ({
  kind: "turn", id, createdAt: now - 1000, updatedAt: now, closed: true,
  target, sessionId: "s-" + id, channel, userQuery: q, items: [{ t: "text", body, ts: now, final: true }],
} as TurnDetailRecord);

const f = facts([
  mkWizard(aInGroupA, "fix-a", true),
  mkWizard(bInGroupB, "fix-b", false),
  mkWizard(other, "other", false),
]);
const records: DetailRecord[] = [
  turn("t1", aInGroupA, "A 群问", "A 群答", "chat:wrA"),
  turn("t2", bInGroupB, "B 群私聊问", "B 群私聊答", ""),
  turn("t3", other, "别的问题", "别的回答", "chat:wrA"),
];

const dir: Directory = makeDirectory(records, f);
// 两个同身份实例各进各的页: target 与名字都不改写到另一个实例。
assert.equal(dir.resolve(bInGroupB), bInGroupB, "按 target 点 B 群实例 → 它自己");
assert.equal(dir.resolve(aInGroupA), aInGroupA, "按 target 点 A 群实例 → 它自己");
assert.equal(dir.resolve("fix-b"), bInGroupB, "名字 → 同名的那一个实例");
assert.equal(dir.resolve("fix-a"), aInGroupA);
assert.equal(dir.resolve(other), other);

// 状态只看自己: A 群实例活着不代表 B 群实例活着。
assert.equal(dir.status(aInGroupA, now)!.alive, true);
assert.equal(dir.status(bInGroupB, now)!.alive, false, "同身份不合并状态");

const info = roleInfo(bInGroupB, dir, f, undefined, now);
assert.equal(info.name, "fix-b");
assert.equal(info.kind, "wizard");
assert.equal(info.alive, false);

// 消息的 from/to 是实例自己的 target, 收敛到身份会让两个实例的话混到一页。
const msgs = allMessages(records, now);
const bMsgs = msgs.filter((m) => m.turn && m.turn.id === "t2");
assert.ok(bMsgs.length > 0, "t2 折叠出消息");
assert.ok(bMsgs.every((m) => m.from === bInGroupB || m.to === bInGroupB), "B 群实例的消息两端都不改写");
assert.ok(!bMsgs.some((m) => m.from === aInGroupA), "B 群实例的话不落到 A 群实例名下");

console.log("role-identity: 同身份实例各是各的页 (target / 名字 / 状态 / 消息归属), 互不改写");
