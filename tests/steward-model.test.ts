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
    const spawn = pickTier(cfg, tier, {}, false);
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
  assert.deepEqual(newStewardSpec(cfg, target, "codex"), { model: undefined, effort: undefined });
  assert.deepEqual(resumedStewardSpec(cfg, target, "codex", {}), { model: undefined, effort: undefined });
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
for (const name of [`${target}#child`, INTERNAL_BASE]) {
  // Tagged and internal sessions must not receive a steward tier.
  assert.deepEqual(newStewardSpec(cfg, name, "claude"), { model: undefined, effort: undefined });
  assert.deepEqual(resumedStewardSpec(cfg, name, "claude", {}), { model: undefined, effort: undefined });
  assert.deepEqual(newStewardSpec(cfg, name, "claude", { model: "task", effort: "high" }), { model: "task", effort: "high" });
  assert.deepEqual(resumedStewardSpec(cfg, name, "claude", { model: "recorded", effort: "high" }), { model: "recorded", effort: "high" });
}
console.log("Steward models: router fixed across creation/resume, backend mapping and ordinary wizard overrides passed");
