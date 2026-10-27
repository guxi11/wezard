import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "jsonc-parser";
import { ConfigSchema, TIERS, tiersForBackend } from "../shared/config.js";
import { materializeBackendTiers, planBackendTiers, type BackendTierMapping } from "../shared/model-tier-migration.js";
import { pickTier } from "../shared/model-tiers.js";

const codex: BackendTierMapping = {
  mini: { model: "gpt-6-luna", effort: "low" },
  light: { model: "gpt-6-luna", effort: "medium" },
  standard: { model: "gpt-6.1-sol", effort: "medium" },
  hard: { model: "gpt-6-astra", effort: "high" },
  ultra: { model: "gpt-6-astra", effort: "xhigh" },
};
const text = `{
  // keep this unrelated comment
  "bot": {"botId":"test","secret":"test"},
  "wrc": {"defaultCli":"codex"},
  "customUnrecognized": {"keep":true},
  "models": {
    "steward":"light",
    "tiers": {"standard":{"model":"opus 5.5","effort":"medium"}},
    "backends": {
      "claude-internal":{"tiers":{"hard":{"model":"internal"}}},
      "codex":{"tiers":{"hard":{"cli":"claude","model":"opus","effort":"max"}}}
    }
  }
}`;
const dir = mkdtempSync(join(tmpdir(), "wezard-tier-migration-"));
try {
  const file = join(dir, "config.jsonc");
  writeFileSync(file, text);
  const preview = planBackendTiers(text, codex);
  assert.equal(readFileSync(file, "utf8"), text, "planning is pure");
  materializeBackendTiers(file, codex);
  const after = readFileSync(file, "utf8");
  assert.equal(after.trimEnd(), preview.text.trimEnd());
  assert(after.includes("// keep this unrelated comment"));
  const raw = parse(after);
  const original = parse(text);
  assert.deepEqual(raw.customUnrecognized, original.customUnrecognized);
  assert.deepEqual(raw.models.tiers, original.models.tiers);
  assert.deepEqual(raw.models.backends["claude-internal"], original.models.backends["claude-internal"]);
  assert.equal(raw.models.steward, "light");
  for (const backend of ["claude", "codex"] as const) assert.deepEqual(Object.keys(raw.models.backends[backend].tiers).sort(), [...TIERS].sort());
  assert.deepEqual(raw.models.backends.codex.tiers, codex);
  const cfg = ConfigSchema.parse(raw);
  assert.equal(tiersForBackend(cfg, "claude").standard.model, "opus 5.5");
  assert.equal(tiersForBackend(cfg, "claude-internal").hard.model, "internal");
  for (const tier of TIERS) {
    const pick = pickTier(cfg, tier, {}, "codex");
    assert(pick.ok);
    assert.equal(pick.model, codex[tier].model);
    assert.equal(pick.effort, codex[tier].effort);
  }
  materializeBackendTiers(file, codex);
  assert.equal(readFileSync(file, "utf8"), after, "migration is idempotent");
  assert.throws(() => planBackendTiers('{broken', codex), /Invalid JSONC/);
  assert.throws(() => materializeBackendTiers(file, { mini: codex.mini } as BackendTierMapping));
  assert.equal(readFileSync(file, "utf8"), after, "invalid mapping cannot partially write");
  const customClaude = JSON.stringify({ ...original, models: { ...original.models,
    backends: { claude: { tiers: { light: { model: "custom", effort: "high" } } } },
  } });
  const preserved = parse(planBackendTiers(customClaude, codex).text);
  assert.deepEqual(preserved.models.backends.claude.tiers.light, { model: "custom", effort: "high" });
} finally { rmSync(dir, { recursive: true, force: true }); }
console.log("Model tier migration: explicit maps, legacy/custom preservation, validation and idempotency passed");
