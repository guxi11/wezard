// 聪明度只认档位: smartsOf 的定级口径 + tierOfModel 的反查 + buildWorld 把 tier / lead / 模型附注带到节点上。
import assert from "node:assert/strict";
import { ConfigSchema } from "../shared/config.js";
import { tierOfModel } from "../shared/model-tiers.js";
import { levelOfTier, smartsOf } from "../shared/smarts.js";
import { buildWorld, EMPTY_FACTS, type WorldFacts } from "../shared/world.js";

// 本机 codebuddy 的档位表: light / standard 同模型不同 effort; ultra = opus·high —— 老口径按
// 「opus + high」推成 4 级, 正是人看到的那个错。现在 ultra 只由档位表决定。
const cfg = ConfigSchema.parse({
  bot: { botId: "t", secret: "t" },
  wrc: { defaultCli: "codebuddy" },
  models: { backends: { codebuddy: { tiers: {
    mini: { model: "hy4-preview-ioa" },
    light: { model: "deepseek-v4.1-flash", effort: "low" },
    standard: { model: "deepseek-v4.1-flash", effort: "high" },
    hard: { model: "glm-5.3-ioa", effort: "high" },
    ultra: { model: "claude-opus-5.5", effort: "high" },
  } } } },
});
const probe = (model: string | undefined, effort?: string, from?: string) => tierOfModel(cfg, "codebuddy", model, effort, from);

// 反查: 模型归一化后严格相等 (id / label 都认), 再看 effort。
assert.deepEqual(probe("claude-opus-5.5", "high"), { tier: "ultra", exact: true }, "本机 ultra = opus·high (不再按家族算 4 级)");
assert.deepEqual(probe("Opus 5.5", "high"), { tier: "ultra", exact: true }, "选择器回的是 label 而不是 id");
assert.deepEqual(probe("deepseek-v4.1-flash", "low"), { tier: "light", exact: true });
assert.deepEqual(probe("deepseek-v4.1-flash", "high"), { tier: "standard", exact: true }, "同一模型按 effort 分档");
assert.deepEqual(probe("deepseek-v4.1-flash", "max"), { tier: "standard", exact: false }, "表里没有 max: 取 effort 最近的一档");
assert.deepEqual(probe("hy4-preview-ioa"), { tier: "mini", exact: true }, "档位没写 effort 时, 没给 effort 就算精确");
assert.deepEqual(probe("claude-opus-4-8", "high"), { tier: "ultra", exact: false }, "同家族不同版本: 近似落位");
assert.deepEqual(probe("gpt-5", "high"), { exact: false }, "表里没有这个模型 = 未知, 不猜");
assert.deepEqual(probe("", undefined), { exact: false }, "模型和 effort 都不知道 = 不反查");

// 两档同规格时分不出来: 跟着原档位走 (否则每次换模型都会把 standard 悄悄挪成 light)。
// 档位表里写的是启动别名 (sonnet), 实际跑的是解析后的 id (claude-sonnet-5-5) —— 同家族, 非精确。
const claude = ConfigSchema.parse({ bot: { botId: "t", secret: "t" }, models: { backends: { claude: { tiers: {} } } } });
assert.deepEqual(tierOfModel(claude, "claude", "claude-sonnet-5-5", "medium", "standard"), { tier: "standard", exact: false });
assert.deepEqual(tierOfModel(claude, "claude", "claude-sonnet-5-5", "medium"), { tier: "light", exact: false }, "没有原档位时按表序取第一个");

// 档位的 model 留空 (用 CLI 默认模型的后端): 只和「模型也为空」的请求比, 由 effort 定档。
const codex = ConfigSchema.parse({ bot: { botId: "t", secret: "t" }, wrc: { defaultCli: "codex" } });
assert.deepEqual(tierOfModel(codex, "codex", "", "xhigh"), { tier: "ultra", exact: true });
assert.deepEqual(tierOfModel(codex, "codex", "gpt-5", "high"), { exact: false }, "配了默认模型的后端: 具体模型名反查不到档位");

// 定级看 tier, 附带真实模型作 note。
assert.equal(levelOfTier("ultra"), 5);
assert.equal(levelOfTier("bogus"), undefined);
assert.deepEqual(smartsOf({ tier: "ultra", model: "claude-opus-5-5", effort: "high" }), { level: 5, tier: "ultra", note: "Opus 5.5 · high" });
assert.deepEqual(smartsOf({ tier: "hard" }), { level: 4, tier: "hard" }, "冷会话没模型: 仍按档位定级, 没有附注");
assert.equal(smartsOf({ model: "claude-opus-5-5", effort: "high" }), undefined, "没有档位就不画 —— 不再按模型家族推断");
assert.equal(smartsOf({ tier: "bogus" }), undefined);
assert.equal(smartsOf({ tier: "light", model: "claude-opus-5-5", effort: "bogus" })?.note, "Opus 5.5", "认不出的 effort 不进附注");

// buildWorld: 节点带 lead / effort / smarts; 老快照 (没这些字段) 不露 undefined。
const w = (x: Partial<WorldFacts["wizards"][number]>) => ({ name: "", description: "", chat: "", cwd: "", model: "", cli: "", busy: false, alive: true, lastActivity: Date.now(), summary: "", ...x }) as WorldFacts["wizards"][number];
const facts: WorldFacts = {
  ...EMPTY_FACTS, absent: undefined,
  wizards: [
    w({ target: "chat:g#lead", name: "L", model: "claude-opus-5-5", effort: "high", tier: "ultra", lead: true }),
    w({ target: "chat:g#cold", name: "C", alive: false, tier: "light" }),
    w({ target: "chat:g#old", name: "O" }),
  ],
};
const nodes = buildWorld([], facts, { base: "chat:g", self: "chat:g#lead" }, Date.now()).nodes;
const by = (t: string) => nodes.find((n) => n.target === t)!;
assert.equal(by("chat:g#lead").lead, true);
assert.equal(by("chat:g#lead").effort, "high");
assert.deepEqual(by("chat:g#lead").smarts, { level: 5, tier: "ultra", note: "Opus 5.5 · high" }, "同样 opus·high, 档位 ultra = 5 级");
assert.deepEqual(by("chat:g#cold").smarts, { level: 2, tier: "light" });
assert.ok(!("lead" in by("chat:g#cold")), "非 lead 不带字段");
assert.ok(!("smarts" in by("chat:g#old")) && !("effort" in by("chat:g#old")), "老快照: 字段整个缺席, 不是 undefined 值");
console.log("world-smarts: ok");
