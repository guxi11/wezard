import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { ConfigSchema } from "../shared/config.js";
import { newStewardSpec } from "../daemon/steward-model.js";
import { present } from "../mcp/output.js";
import { windowLabel } from "../shared/session-label.js";

// Execute the production creation and handoff functions, stopping at the process boundary.
const extract = (file: string, start: string, end: string, name: string) => {
  const source = readFileSync(file, "utf8");
  const a = source.indexOf(start), b = source.indexOf(end, a);
  assert(a >= 0 && b > a);
  return ts.transpileModule(`${source.slice(a, b)}\nreturn ${name};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
};
const creation = extract("daemon/mirror-bridge.ts", "  const newSession = async (", "  // ── Clone", "newSession");
const handoff = extract("daemon/index.ts", "    const handoffSelf = (self: string, brief: string):", "    http.register(\"POST /handoff\"", "handoffSelf");
const cfg = ConfigSchema.parse({ bot: { botId: "test", secret: "test" }, wrc: { defaultCli: "codex" }, models: {
  router: "standard", steward: "light", backends: { codex: { tiers: {
    standard: { model: "gpt-6.1-sol", effort: "medium" }, light: { model: "gpt-6-luna", effort: "low" },
  } } },
}, chatPolicy: { "user:test": { steward: "mini" } } });
const captured: Array<{ model: string; effort: string; cli: string }> = [];
let recorded: { jsonlPath: string; model: string; effort: string } | undefined;
const env = {
  cfg, byTarget: new Map(), deps: { store: { get: () => recorded } },
  chatCwdFallback: () => ({}), expandHome: (s: string) => s, expandedDefaultCwd: "/tmp",
  baseOfKey: (s: string) => s.split("#")[0], resolveCliBackend: () => ({ name: "codex" }),
  backendForPath: () => ({ name: "codex" }), newStewardSpec, windowLabel, randomUUID: () => "fresh",
  inFlightSids: new Set(), log: { child: () => ({}) }, charterFor: () => "",
  spawnTmuxClaude: async (args: typeof captured[number]) => {
    captured.push(args);
    return { ok: false, reason: "process boundary" };
  },
};
const newSession = new Function(...Object.keys(env), creation)(...Object.values(env));
await newSession("user:test");
recorded = { jsonlPath: "/old.jsonl", model: "gpt-6-luna", effort: "high" };
await newSession("user:test", "test", { model: "task-model", effort: "low" });
const restartEnv = {
  handoffAllowed: () => true,
  m: { sessionInfo: () => ({ ...recorded, cli: "codex", contextTokens: 123 }), getCwd: () => ({}) },
  handoffs: { self: (target: string, brief: string) => ({ ok: target === "user:test" && brief.length >= 40 }) },
};
const handoffSelf = new Function(...Object.keys(restartEnv), handoff)(...Object.values(restartEnv));
const handoffResult = handoffSelf("user:test", "A sufficiently detailed handoff brief for this session.");
assert.equal(handoffResult.status, 200, "self handoff routes through the production handoff coordinator");
assert.equal(handoffResult.body.scheduled, true);
const spawnResponse = present("spawn_wizard", { ok: true, name: "x", model: "m", tierNote: "legacy" }) as Record<string, unknown>;
assert.equal("tierNote" in spawnResponse, false, "spawn_wizard presentation omits the removed tierNote field");
assert.deepEqual(spawnResponse, { ok: true, name: "x", model: "m" }, "spawn_wizard presentation retains normal response fields");
for (const args of captured) assert.deepEqual({ model: args.model, effort: args.effort, cli: args.cli },
  { model: "gpt-6.1-sol", effort: "medium", cli: "codex" });
assert.equal(captured.length, 2, "first creation and /new must reach the correct spawn spec");
await newSession("user:test#child", "child", { model: "task-model", effort: "low" });
assert.equal(captured.at(-1)?.model, "task-model", "ordinary task model is preserved");
console.log("Steward creation: creation model routing, handoff coordination, and spawn response presentation");
