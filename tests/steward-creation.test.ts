import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { ConfigSchema } from "../shared/config.js";
import { newStewardSpec } from "../daemon/steward-model.js";
import { stewardTierOf } from "../daemon/chat-name.js";

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
const handoff = extract("daemon/index.ts", "    const restartFresh = (target:", "    // POST /handoff", "restartFresh");
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
  backendForPath: () => ({ name: "codex" }), newStewardSpec, randomUUID: () => "fresh",
  inFlightSids: new Set(), log: { child: () => ({}) }, charterFor: () => "",
  spawnTmuxClaude: async (args: typeof captured[number]) => {
    captured.push(args);
    return { ok: false, reason: "process boundary" };
  },
};
const newSession = new Function(...Object.keys(env), creation)(...Object.values(env));
await newSession("user:test");
recorded = { jsonlPath: "/old.jsonl", model: "gpt-6-luna", effort: "high" };
await newSession("user:test", "test", "claude", { model: "task-model", effort: "low" });
const restartEnv = {
  cfg, primary: { name: "codex" }, stewardTierOf, planContinuationAllowed: () => true,
  displayName: () => "test", tagOfKey: () => "",
  m: { sessionInfo: () => ({ ...recorded, cli: "codex" }), newSession },
};
const restartFresh = new Function(...Object.keys(restartEnv), handoff)(...Object.values(restartEnv));
await restartFresh("user:test");
for (const args of captured) assert.deepEqual({ model: args.model, effort: args.effort, cli: args.cli },
  { model: "gpt-6.1-sol", effort: "medium", cli: "codex" });
assert.equal(captured.length, 3, "first creation, /new and handoff must all reach the correct spawn spec");
await newSession("user:test#child", "child", "codex", { model: "task-model", effort: "low" });
assert.equal(captured.at(-1)?.model, "task-model", "ordinary task model is preserved");
console.log("Steward creation: actual first/new/handoff paths deliver router model and effort to spawn");
