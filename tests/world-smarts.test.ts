// 图节点的 lead 角标与聪明程度: smartsOf 的口径 + buildWorld 把 lead / tier / effort 带到节点上。
import assert from "node:assert/strict";
import { smartsOf, levelOfModel } from "../shared/smarts.js";
import { claudeFamily } from "../shared/pricing.js";
import { buildWorld, EMPTY_FACTS, type WorldFacts } from "../shared/world.js";

// 家族认法: 全名 / 别名 / 网关壳都认, 别家不认。
assert.equal(claudeFamily("claude-opus-5-5[1m]"), "opus");
assert.equal(claudeFamily("us.anthropic.claude-sonnet-4-5-20250929-v1:0"), "sonnet");
assert.equal(claudeFamily("haiku"), "haiku");
assert.equal(claudeFamily("gpt-5"), "");

// 家族定底, effort 抬一级 —— 与默认档位表一一对上。
assert.equal(levelOfModel("claude-haiku-5-5", "low"), 1, "mini");
assert.equal(levelOfModel("claude-sonnet-5-5", "medium"), 2, "light");
assert.equal(levelOfModel("claude-sonnet-5-5", "high"), 3, "standard (本机 sonnet·high)");
assert.equal(levelOfModel("claude-opus-5-5", "high"), 4, "hard");
assert.equal(levelOfModel("claude-opus-5-5", "max"), 5, "ultra");
assert.equal(levelOfModel("claude-fable-5-2", "xhigh"), 5, "fable 归 opus 类");
assert.equal(levelOfModel("claude-opus-5-5"), 4, "没给 effort = 家族底");
assert.equal(levelOfModel("deepseek-v4"), undefined);

// 实际模型优先, 出生档位只做回落 (set_model 换过模型后档位会说谎)。
assert.deepEqual(smartsOf({ model: "claude-sonnet-5-5", effort: "medium", tier: "ultra" }), { level: 2, basis: "model", label: "Sonnet 5.5 · medium" });
assert.deepEqual(smartsOf({ model: "", tier: "hard" }), { level: 4, basis: "tier", label: "档位 hard" }, "冷会话没 model: 回落档位");
assert.deepEqual(smartsOf({ model: "gpt-5", tier: "light" }), { level: 2, basis: "tier", label: "档位 light" }, "别家模型: 回落档位");
assert.equal(smartsOf({ model: "gpt-5" }), undefined, "都认不出 = 不带");
assert.equal(smartsOf({ model: "claude-opus-5-5", effort: "bogus" })?.label, "Opus 5.5", "认不出的 effort 不进 label");

// buildWorld: 节点带 lead / effort / smarts; 老快照 (没这些字段) 不露 undefined。
const w = (x: Partial<WorldFacts["wizards"][number]>) => ({ name: "", description: "", chat: "", cwd: "", model: "", cli: "", busy: false, alive: true, lastActivity: Date.now(), summary: "", ...x }) as WorldFacts["wizards"][number];
const facts: WorldFacts = {
  ...EMPTY_FACTS, absent: undefined,
  wizards: [
    w({ target: "chat:g#lead", name: "L", model: "claude-opus-5-5", effort: "high", tier: "hard", lead: true }),
    w({ target: "chat:g#cold", name: "C", alive: false, tier: "light" }),
    w({ target: "chat:g#old", name: "O" }),
  ],
};
const nodes = buildWorld([], facts, { base: "chat:g", self: "chat:g#lead" }, Date.now()).nodes;
const by = (t: string) => nodes.find((n) => n.target === t)!;
assert.equal(by("chat:g#lead").lead, true);
assert.equal(by("chat:g#lead").effort, "high");
assert.deepEqual(by("chat:g#lead").smarts, { level: 4, basis: "model", label: "Opus 5.5 · high" });
assert.deepEqual(by("chat:g#cold").smarts, { level: 2, basis: "tier", label: "档位 light" });
assert.ok(!("lead" in by("chat:g#cold")), "非 lead 不带字段");
assert.ok(!("smarts" in by("chat:g#old")) && !("effort" in by("chat:g#old")), "老快照: 字段整个缺席, 不是 undefined 值");
console.log("world-smarts: ok");
