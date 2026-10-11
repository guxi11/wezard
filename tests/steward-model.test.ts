import assert from "node:assert/strict";
import { ConfigSchema, TIERS } from "../shared/config.js";
import { pickTier } from "../shared/model-tiers.js";
import { INTERNAL_BASE } from "../shared/session-label.js";
import { newStewardSpec, resumedStewardSpec } from "../daemon/steward-model.js";

const bot = { botId: "test", secret: "test" };
const target = "user:test";
for (const backend of ["claude", "claude-internal", "codebuddy", "codex"] as const) {
  for (const tier of TIERS) {
    const cfg = ConfigSchema.parse({ bot, wrc: { defaultCli: backend }, models: { steward: tier } });
    const spawn = pickTier(cfg, tier, {}, false);
    assert(spawn.ok);
    const expected = { model: spawn.model, effort: spawn.effort };
    assert.deepEqual(newStewardSpec(cfg, target, backend), expected);
    assert.deepEqual(resumedStewardSpec(cfg, target, backend, {}), expected);
  }
}
const legacy = ConfigSchema.parse({ bot, models: { steward: "hard", tiers: {
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
    steward: "hard", backends: { codex: { tiers: { hard } } },
  } });
  assert.deepEqual(newStewardSpec(cfg, target, "codex"), { model: undefined, effort: undefined });
  assert.deepEqual(resumedStewardSpec(cfg, target, "codex", {}), { model: undefined, effort: undefined });
}
const cfg = ConfigSchema.parse({ bot, models: { steward: "hard" }, chatPolicy: { [target]: { steward: "mini" } } });
assert.deepEqual(newStewardSpec(cfg, target, "claude"), { model: "haiku", effort: "low" });
assert.deepEqual(newStewardSpec(cfg, target, "claude", {}, "high"), { model: "haiku", effort: "low" });
assert.deepEqual(newStewardSpec(cfg, target, "claude", { model: "explicit" }, "high"), { model: "explicit", effort: "high" });
assert.deepEqual(newStewardSpec(cfg, target, "claude", { effort: "medium" }), { model: "haiku", effort: "medium" });
assert.deepEqual(resumedStewardSpec(cfg, target, "claude", { model: "recorded", effort: "high" }), { model: "recorded", effort: "high" });
assert.deepEqual(resumedStewardSpec(cfg, target, "claude", { model: "recorded" }), { model: "recorded", effort: "low" });
for (const name of [`${target}#child`, INTERNAL_BASE]) {
  // Tagged and internal sessions must not receive a steward tier.
  assert.deepEqual(newStewardSpec(cfg, name, "claude"), { model: undefined, effort: undefined });
  assert.deepEqual(resumedStewardSpec(cfg, name, "claude", {}), { model: undefined, effort: undefined });
}
console.log("Steward models: shared spawn/new/resume compatibility, overrides and chat tier passed");
