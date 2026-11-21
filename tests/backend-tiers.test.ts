import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigSchema, TIERS, tiersForBackend } from "../shared/config.js";
import { planSet, tierEvidence } from "../daemon/config-api.js";
import { pickTier } from "../shared/model-tiers.js";

const bot = { botId: "test", secret: "test" };
const cfg = ConfigSchema.parse({ bot, wrc: { defaultCli: "codex" }, models: { backends: { claude: { tiers: { hard: { model: "legacy-opus", effort: "high" } } } } } });
assert.equal(tiersForBackend(cfg, "claude").hard.model, "legacy-opus");
assert.equal(tiersForBackend(cfg, "claude-internal").hard.model, "legacy-opus");
assert.equal(tiersForBackend(cfg, "codebuddy").hard.model, "", "codebuddy 有自己的档位表, 不继承 claude 的别名");
for (const [i, tier] of TIERS.entries()) {
  const pick = pickTier(cfg, tier, {});
  assert(pick.ok);
  assert.equal(pick.cli, "codex");
  assert.equal(pick.model, undefined);
  assert.equal(pick.effort, ["low", "medium", "medium", "high", "xhigh"][i]);
}
const custom = ConfigSchema.parse({ bot, wrc: { defaultCli: "codex" }, models: { backends: { codex: { tiers: { hard: { model: "custom-codex", effort: "high" } } }, claude: { tiers: { hard: { model: "custom-claude" } } } } } });
assert.equal(tiersForBackend(custom, "claude-internal").hard.model, "custom-claude");
assert.equal(tiersForBackend(custom).hard.model, "custom-codex");
const override = pickTier(custom, "hard", { model: "explicit", effort: "low" });
assert(override.ok);
assert.equal(override.cli, "codex");
assert.equal(override.model, "explicit");
assert.equal(override.effort, "low");
assert.equal(pickTier(cfg, "unknown", {}).ok, false);
assert.equal(pickTier(cfg, undefined, {}).ok, true);
const actual = pickTier(custom, "hard", {}, "claude");
assert(actual.ok);
assert.equal(actual.cli, "claude");
assert.equal(actual.model, "custom-claude");

for (const backend of ["claude", "claude-internal", "codebuddy", "codex"] as const) {
  for (const tier of TIERS) {
    const pick = pickTier(cfg, tier, {}, backend);
    assert(pick.ok);
    assert.equal(pick.cli, backend);
    assert.equal(pick.model, tiersForBackend(cfg, backend)[tier].model || undefined);
    assert.equal(pick.effort, tiersForBackend(cfg, backend)[tier].effort);
  }
}
const internal = ConfigSchema.parse({ bot, models: { backends: {
  claude: { tiers: { hard: { model: "parent" } } },
  "claude-internal": { tiers: { hard: { model: "internal" } } },
} } });
assert.equal(tiersForBackend(internal, "claude-internal").hard.model, "internal");
const dir = mkdtempSync(join(tmpdir(), "wezard-tiers-"));
try {
  const path = join(dir, "config.jsonc");
  writeFileSync(path, JSON.stringify({ bot }));
  const plan = planSet(cfg, path, { path: "models.backends.claude.tiers.hard.model", value: "configured-opus" });
  assert(plan.ok);
  assert.equal(tiersForBackend(plan.next, "claude").hard.model, "configured-opus");
  const codexPlan = planSet(cfg, path, { path: "models.backends.codex.tiers.ultra.effort", value: "xhigh" });
  assert(codexPlan.ok);
  assert.equal(tiersForBackend(codexPlan.next, "codex").ultra.effort, "xhigh");
} finally { rmSync(dir, { recursive: true, force: true }); }
const evidence = tierEvidence(custom, ["models", "backends", "codex", "tiers", "hard"], () => ({ today: new Map(), week: new Map() }), () => 0, { tokens: String, cost: String });
assert(evidence.some((line) => line.includes("custom-codex")));
console.log("Backend tiers: defaults, overrides and config writes passed");
