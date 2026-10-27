import assert from "node:assert/strict";
import { ConfigSchema, TIERS } from "../shared/config.js";
import { pickTier } from "../shared/model-tiers.js";
import { INTERNAL_BASE } from "../shared/session-label.js";
import { newStewardSpec, resumedStewardSpec } from "../daemon/steward-model.js";

const bot = { botId: "test", secret: "test" };
const target = "user:test";
for (const backend of ["claude", "claude-internal", "codebuddy", "codex"] as const) {
  for (const tier of TIERS) {
    const cfg = ConfigSchema.parse({ bot, wrc: { defaultCli: backend }, models: { router: tier } });
    const spawn = pickTier(cfg, tier, {}, backend);
    assert(spawn.ok);
    const expected = { model: spawn.model, effort: spawn.effort };
    assert.deepEqual(newStewardSpec(cfg, target, backend), expected);
    assert.deepEqual(resumedStewardSpec(cfg, target, backend, {}), expected);
  }
}
const legacy = ConfigSchema.parse({ bot, models: { router: "hard", tiers: {
  hard: { cli: "claude", model: "opus", effort: "high" },
} } });
assert.deepEqual(newStewardSpec(legacy, target, "claude-internal"), { model: "opus", effort: "high" });
assert.deepEqual(resumedStewardSpec(legacy, target, "claude-internal", {}), { model: "opus", effort: "high" });

for (const hard of [
  { cli: "claude", model: "opus", effort: "max" },
  { cli: "codebuddy", model: "custom", effort: "high" },
  { model: "sonnet", effort: "medium" },
]) {
  const cfg = ConfigSchema.parse({ bot, wrc: { defaultCli: "codex" }, models: {
    router: "hard", backends: { codex: { tiers: { hard } } },
  } });
  assert.deepEqual(newStewardSpec(cfg, target, "codex"), { model: hard.model, effort: hard.effort });
  assert.deepEqual(resumedStewardSpec(cfg, target, "codex", {}), { model: hard.model, effort: hard.effort });
}
const cfg = ConfigSchema.parse({ bot, models: { router: "standard", steward: "hard", backends: {
  codex: { tiers: { standard: { model: "gpt-6.1-sol", effort: "medium" } } },
} }, chatPolicy: { [target]: { steward: "mini" } } });
// Neither legacy steward settings, carried state nor a task's explicit tier may win.
const standard = { model: "gpt-6.1-sol", effort: "medium" };
assert.deepEqual(newStewardSpec(cfg, target, "codex"), standard);
assert.deepEqual(newStewardSpec(cfg, target, "codex", {}, "high"), standard);
assert.deepEqual(newStewardSpec(cfg, target, "codex", { model: "explicit", effort: "low" }, "high"), standard);
assert.deepEqual(resumedStewardSpec(cfg, target, "codex", { model: "gpt-6-luna", effort: "high" }), standard);
// Mapping is resolved at creation time, against the actual backend (not defaultCli).
cfg.models.backends.codex.tiers.standard = { model: "updated", effort: "high" };
assert.deepEqual(newStewardSpec(cfg, target, "codex"), { model: "updated", effort: "high" });
assert.deepEqual(newStewardSpec(cfg, target, "claude"), { model: "sonnet", effort: "medium" });
cfg.models.router = "mini";
assert.deepEqual(newStewardSpec(cfg, target, "claude"), { model: "haiku", effort: "low" });
// slot 分身不是管家: 不套 router 档 (显式 / 记录值照旧生效)。
const slot = `${target}#child`;
assert.deepEqual(newStewardSpec(cfg, slot, "claude"), { model: undefined, effort: undefined });
assert.deepEqual(resumedStewardSpec(cfg, slot, "claude", {}), { model: undefined, effort: undefined });
assert.deepEqual(newStewardSpec(cfg, slot, "claude", { model: "task", effort: "high" }), { model: "task", effort: "high" });
assert.deepEqual(resumedStewardSpec(cfg, slot, "claude", { model: "recorded", effort: "high" }), { model: "recorded", effort: "high" });
// daemon 内建的整理者执行体 (`wezard:internal#steward`) 也是管家型: 固定吃 router 档 ——
// 它不给档就会落 CLI 自己的默认 (本机实测 opus/high), 显式 model / 记录值都不覆盖。
for (const internal of [INTERNAL_BASE, `${INTERNAL_BASE}#steward`]) {
  const want = { model: "haiku", effort: "low" };
  assert.deepEqual(newStewardSpec(cfg, internal, "claude"), want);
  assert.deepEqual(resumedStewardSpec(cfg, internal, "claude", {}), want);
  assert.deepEqual(newStewardSpec(cfg, internal, "claude", { model: "task", effort: "high" }), want);
  assert.deepEqual(resumedStewardSpec(cfg, internal, "claude", { model: "recorded", effort: "high" }), want);
}
console.log("Steward models: router fixed across creation/resume, backend mapping and ordinary wizard overrides passed");
