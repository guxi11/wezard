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
  for (const tier of TIERS) {
    cfg.models.router = tier;
    const actual = pickRouter(cfg, backend);
    assert.deepEqual(actual, pickTier(cfg, tier, {}, false, backend));
    assert(actual.ok);
    assert.equal(actual.cli, backend, "actual backend wins over defaultCli");
    assert.equal(actual.tier, tier);
  }
}

const custom = ConfigSchema.parse({ bot, models: { tiers: {
  standard: { cli: "claude", model: "legacy", effort: "high" },
}, backends: { codex: { tiers: { standard: { model: "first", effort: "medium" } } } } } });
let pick = pickRouter(custom, "claude-internal");
assert(pick.ok);
assert.equal(pick.model, "legacy", "same-family legacy fallback");
assert.equal(pick.effort, "high");
pick = pickRouter(custom, "codex");
assert(pick.ok);
assert.equal(pick.model, "first");
custom.models.backends.codex.tiers.standard.model = "next";
pick = pickRouter(custom, "codex");
assert(pick.ok);
assert.equal(pick.model, "next", "read the map at creation time, not cached");
custom.models.router = "hard";
pick = pickRouter(custom, "codex");
assert(pick.ok);
assert.equal(pick.tier, "hard");
assert.equal(pick.effort, "high");
assert.equal(pick.model, undefined, "empty tier model defers to CLI");
custom.models.backends.codex.tiers.hard = { cli: "claude", model: "opus", effort: "max" };
pick = pickRouter(custom, "codex");
assert(pick.ok);
assert.equal(pick.model, undefined);
assert.equal(pick.effort, undefined, "incompatible tier falls back as a unit");
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
  assert.equal(loadConfig(file).config.models.router, "standard", "legacy router object must not prevent startup");
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
