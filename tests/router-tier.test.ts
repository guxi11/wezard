import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "jsonc-parser";
import { ConfigSchema, TIERS, loadConfig } from "../shared/config.js";
import { pickRouter, pickTier } from "../shared/model-tiers.js";
import { configGet, planSet, tierEvidence } from "../daemon/config-api.js";
import { patchJsonc } from "../shared/config-writer.js";

const bot = { botId: "test", secret: "test" };
const cfg = ConfigSchema.parse({ bot, wrc: { defaultCli: "codex" } });
assert.equal(cfg.models.router, "standard");
assert(!ConfigSchema.safeParse({ bot, models: { router: { tier: "standard" } } }).success);
assert(!ConfigSchema.safeParse({ bot, models: { router: "unknown" } }).success);
for (const backend of ["claude", "claude-internal", "codebuddy", "codex"] as const) {
  cfg.models.router = "standard";
  const actual = pickRouter(cfg, backend);
  assert.deepEqual(actual, pickTier(cfg, "standard", {}, backend));
  assert(actual.ok);
  assert.equal(actual.cli, backend, "actual backend wins over defaultCli");
  assert.equal(actual.tier, "standard");
}
for (const tier of TIERS.filter((tier) => tier !== "standard")) {
  cfg.models.router = tier;
  const actual = pickRouter(cfg, "codex");
  assert.deepEqual(actual, pickTier(cfg, tier, {}, "codex"));
  assert(actual.ok);
  assert.equal(actual.cli, "codex");
  assert.equal(actual.tier, tier);
}

const custom = ConfigSchema.parse({ bot, models: { backends: {
  claude: { tiers: { standard: { model: "legacy", effort: "high" } } },
  codex: { tiers: { standard: { model: "first", effort: "medium" } } },
} } });
let pick = pickRouter(custom, "claude");
assert(pick.ok);
assert.equal(pick.model, "legacy", "Claude backend uses its configured tier table");
assert.equal(pick.effort, "high");
pick = pickRouter(custom, "claude-internal");
assert(pick.ok);
assert.equal(pick.model, "legacy", "claude-internal shares the configured Claude tier table");
assert.equal(pick.effort, "high");
pick = pickRouter(custom, "codex");
assert(pick.ok);
assert.equal(pick.model, "first");
custom.models.backends.codex.tiers.standard.model = "next";
pick = pickRouter(custom, "codex");
assert(pick.ok);
assert.equal(pick.model, "next", "read the map at creation time, not cached");
custom.models.router = "hard";
custom.models.backends.claude.tiers.hard = { model: "claude-opus", effort: "max" };
custom.models.backends.codex.tiers.hard = { model: "codex-model", effort: "high" };
pick = pickRouter(custom, "codex");
assert(pick.ok);
assert.equal(pick.tier, "hard");
assert.equal(pick.model, "codex-model");
assert.equal(pick.effort, "high");
pick = pickRouter(custom, "claude");
assert(pick.ok);
assert.equal(pick.model, "claude-opus");
assert.equal(pick.effort, "max", "Claude resolves its backend-local hard tier");
pick = pickRouter(custom, "codex", { model: "invocation", effort: "low" });
assert(pick.ok);
assert.equal(pick.model, "invocation");
assert.equal(pick.effort, "low");

const dir = mkdtempSync(join(tmpdir(), "wezard-router-tier-"));
try {
  const file = join(dir, "config.jsonc");
  writeFileSync(file, '// keep this comment\n' + JSON.stringify({ bot, models: { steward: "light" }, other: 42 }));
  const plan = planSet(cfg, file, { path: "models.router", value: "standard" });
  assert(plan.ok);
  assert.equal(plan.apply, "hot");
  patchJsonc(file, [{ path: plan.jsonPath, value: plan.value }]);
  const text = readFileSync(file, "utf8");
  assert(text.includes("// keep this comment"));
  assert.deepEqual(parse(text), { bot, models: { steward: "light", router: "standard" }, other: 42 });
  const shown = configGet(loadConfig(file).config, file, "models.router");
  assert(shown.ok);
  assert(JSON.stringify(shown).includes("standard"));
  assert(JSON.stringify(shown).includes("群管家 (router)"));
  assert(!planSet(cfg, file, { path: "models.router", value: { model: "sonnet", effort: "low" } }).ok);
  writeFileSync(file, JSON.stringify({ bot, models: { router: { model: "sonnet", effort: "low" } } }));
  assert.throws(() => loadConfig(file), /models\.router/, "router accepts a tier name, not the legacy object shape");
  writeFileSync(file, JSON.stringify({ bot, models: { router: "standard" } }));
  const migrate = planSet(loadConfig(file).config, file, { path: "models.router", value: "standard" });
  assert(migrate.ok);
  patchJsonc(file, [{ path: migrate.jsonPath, value: migrate.value }]);
  assert.equal(parse(readFileSync(file, "utf8")).models.router, "standard");
} finally { rmSync(dir, { recursive: true, force: true }); }
const evidence = tierEvidence(ConfigSchema.parse({ bot, models: { router: "standard", steward: "light" } }),
  ["models", "router"], () => ({ today: new Map(), week: new Map() }), () => 0, { tokens: String, cost: String });
assert(evidence.some((line) => line.startsWith("standard (") && line.includes("管家档")));
assert(!evidence.some((line) => line.startsWith("light (")));
console.log("Router tier: single setting, creation-time backend resolution, overrides and persistence passed");
