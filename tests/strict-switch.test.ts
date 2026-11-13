// v3 P7-S3 ② 存量群切换 strict 的命令面: 解析 / 预演计划 / 报告渲染 (纯函数)。
// 「只做不执行」: 命令落地, 但没有任何代码路径会在无显式 /strict apply 时写 chatPolicy。
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigSchema, type Config } from "../shared/config.js";
import { chatPolicyOf } from "../daemon/chat-name.js";
import { resetKnownChatsCache } from "../daemon/chat-seen.js";
import { parseStrictCommand, planStrictSwitch, renderSwitchReport, type SwitchFacts } from "../daemon/strict-switch.js";

const tmp = mkdtempSync(join(tmpdir(), "strict-switch-"));

const mkCfg = (stateDir: string, chatPolicy: Record<string, unknown> = {}): Config =>
  ConfigSchema.parse({ bot: { botId: "t", secret: "t" }, daemon: { stateDir }, chatPolicy });

// 册: chat:wrOLD = 存量 (盘上有记录); chat:wrNEW = 首见 (运行时 record); 其余未在册。
const dir = join(tmp, "state");
mkdirSync(join(dir, "chats"), { recursive: true });
writeFileSync(join(dir, "chats", "chat%3AwrOLD.jsonl"), "{}\n");
const cfg = mkCfg(dir, { "chat:wrEXPLICIT": { speech: "implicit" } });
resetKnownChatsCache();
chatPolicyOf(cfg, "chat:wrNEW"); // 触发 open; 再 record 首见
const { knownChatsOf } = await import("../daemon/chat-seen.js");
knownChatsOf(cfg).record("chat:wrNEW");

const facts: SwitchFacts = {
  chatLabel: (base) => ({ "chat:wrOLD": "old-group", "chat:wrNEW": "new-group" })[base] ?? base,
  wizardsOf: (base) => (base === "chat:wrOLD" ? [".fix", ".docs"] : []),
  stewardOf: (base) => (base === "chat:wrOLD" ? ".fix" : ""),
  memberCount: (base) => (base === "chat:wrOLD" ? 3 : 0),
};
const resolve = (ref: string): string =>
  ({ "old-group": "chat:wrOLD", "new-group": "chat:wrNEW", "chat:wrOLD": "chat:wrOLD", "chat:wrEXPLICIT": "chat:wrEXPLICIT", "chat:wrDM": "user:alice" })[ref] ?? "";

// ── 1. 解析 ──
assert.deepEqual(parseStrictCommand("/strict"), { apply: false, all: false, refs: [] });
assert.deepEqual(parseStrictCommand("  /STRICT  apply  a b "), { apply: true, all: false, refs: ["a", "b"] });
assert.deepEqual(parseStrictCommand("/strict --all"), { apply: false, all: true, refs: [] });
assert.deepEqual(parseStrictCommand("/strict apply --all"), { apply: true, all: true, refs: [] });
assert.equal(parseStrictCommand("/strictly"), undefined, "别的命令不认");
assert.equal(parseStrictCommand("帮我把群切 strict"), undefined);

// ── 2. 预演: 点名存量群 → from implicit / legacy / 受影响清单 (home + 管家去重) ──
{
  const plan = planStrictSwitch(cfg, { refs: ["old-group"], all: false, selfBase: "chat:wrX" }, resolve, facts);
  assert.equal(plan.miss.length, 0);
  const row = plan.rows[0]!;
  assert.equal(row.base, "chat:wrOLD");
  assert.equal(row.from, "implicit");
  assert.equal(row.legacy, true);
  assert.deepEqual(row.wizards, [".fix", ".docs"], "home 名单 + 管家, 去重");
  assert.equal(row.members, 3);
}

// ── 3. 预演: 首见群已是 strict / 显式 strict 不动; 单聊标记 private ──
{
  const plan = planStrictSwitch(cfg, { refs: ["new-group", "chat:wrEXPLICIT", "chat:wrDM"], all: false, selfBase: "chat:wrX" }, resolve, facts);
  assert.equal(plan.rows[0]!.from, "strict", "S3 首见默认 strict");
  assert.equal(plan.rows[0]!.legacy, false);
  assert.equal(plan.rows[1]!.from, "implicit", "显式 implicit 的存量群仍是 implicit");
  assert.equal(plan.rows[2]!.private, true, "单聊不在范围");
  const text = renderSwitchReport(plan, "dry");
  assert.ok(text.includes("dry-run"), "预演头部明示不写");
  assert.ok(text.includes("不动"), "已 strict 的行明示不动");
  assert.ok(text.includes("不在切换范围"), "单聊明示范围外");
}

// ── 4. 认不出的名字进 miss; 不点名 = 本聊天 ──
{
  const miss = planStrictSwitch(cfg, { refs: ["nope"], all: false, selfBase: "chat:wrOLD" }, resolve, facts);
  assert.deepEqual(miss.miss, ["nope"]);
  const self = planStrictSwitch(cfg, { refs: [], all: false, selfBase: "chat:wrOLD" }, resolve, facts);
  assert.equal(self.rows[0]!.base, "chat:wrOLD", "无参 = 本聊天");
}

// ── 5. --all 候选 = 存量 implicit 群 (首见 strict / 显式 strict / 单聊都不进) ──
{
  const plan = planStrictSwitch(cfg, { refs: [], all: true, selfBase: "chat:wrX" }, resolve, facts);
  assert.ok(plan.candidates.includes("chat:wrOLD"), "存量 implicit 群是候选");
  assert.ok(plan.candidates.includes("chat:wrEXPLICIT"), "显式 implicit 的存量群也是候选");
  assert.ok(!plan.candidates.includes("chat:wrNEW"), "首见 strict 不是候选");
  assert.ok(plan.rows.every((r) => r.from === "implicit" && !r.private));
}

// ── 6. 渲染: dry 提示 apply 用法; apply 报告受影响清单 ──
{
  const plan = planStrictSwitch(cfg, { refs: ["old-group"], all: false, selfBase: "chat:wrX" }, resolve, facts);
  const dry = renderSwitchReport(plan, "dry");
  assert.ok(dry.includes("/strict apply"), "dry 尾部给执行入口");
  assert.ok(dry.includes(".fix .docs"), "受影响 wizard 在清单里");
  assert.ok(dry.includes("交接"), "宪章变 → 交接提醒字样");
  const applied = renderSwitchReport(plan, "apply");
  assert.ok(applied.includes("已执行"));
  assert.ok(!applied.includes("执行: /strict apply"), "apply 报告不再给执行入口");
}

rmSync(tmp, { recursive: true, force: true });
resetKnownChatsCache();
console.log("strict-switch: 解析 / 预演计划 (存量·首见·显式·单聊) / --all 候选 / 报告渲染");
