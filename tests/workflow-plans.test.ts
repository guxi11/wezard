import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, renameSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkflowPlanSchema } from "../shared/workflow-plan.js";
import { loadWorkflowPlans } from "../daemon/workflow-plans.js";
import { loadJobStore } from "../daemon/jobs.js";

const dir = mkdtempSync(join(tmpdir(), "workflow-plan-schema-"));
const jobs = loadJobStore(join(dir, "jobs.json"));
const j = jobs.open("chat", "owner", "segment", { maxTurns: 3 });
const spec = { version: 1, job: j.id, cwd: dir, nodes: [
  { id: "collect", task: "Collect fixed facts", tier: "light" },
  { id: "review", task: "Assess facts", tier: "hard", after: ["collect"] },
] };
assert.equal(WorkflowPlanSchema.parse(spec).maxConcurrency, 1);
for (const bad of [
  { ...spec, version: 2 }, { ...spec, maxConcurrency: 2 }, { ...spec, retry: 1 },
  { ...spec, cwd: "." }, { ...spec, nodes: [] },
  { ...spec, nodes: Array.from({ length: 6 }, (_, i) => ({ id: `n${i}`, task: "step", tier: "mini" })) },
  { ...spec, nodes: [{ id: "a", task: " ", tier: "light" }] },
  { ...spec, nodes: [{ id: "a", task: "x" }] },
  { ...spec, nodes: [{ id: "a", task: "x", tier: "invalid" }] },
  { ...spec, nodes: [{ id: "a", task: "x", tier: "light", script: "exec" }] },
  { ...spec, nodes: [{ id: "a", task: "x", tier: "light", after: ["missing"] }] },
  { ...spec, nodes: [{ id: "a", task: "x", tier: "light", after: ["a"] }] },
  { ...spec, nodes: [spec.nodes[0], spec.nodes[0]] },
  { ...spec, nodes: [spec.nodes[0], { ...spec.nodes[1], after: ["collect", "collect"] }] },
  { ...spec, nodes: [{ ...spec.nodes[0], after: ["review"] }, spec.nodes[1]] },
]) assert.equal(WorkflowPlanSchema.safeParse(bad).success, false, JSON.stringify(bad));
const file = join(dir, "plans.json");
let store = loadWorkflowPlans(file, () => undefined);
assert.throws(() => store.create("intruder", spec, { chain: [] }, j, [], false));
assert.throws(() => store.create("owner", spec, { chain: [] }, { ...j, status: "closed" }, [], false));
assert.throws(() => store.create("owner", spec, { chain: [] }, { ...j, turns: 1 }, [], false));
assert.throws(() => store.create("owner", spec, { chain: [] }, { ...j, maxTurns: 1 }, [], false));
assert.throws(() => store.create("owner", spec, { chain: [] }, j, [], true));
const run = store.create("owner", spec, { k: { kind: "peer", from: "lead", turn: "tOriginal" }, asker: { who: "user:x", chat: "chat" }, chain: ["lead"] }, j, [], false);
run.plan.nodes[0]!.task = "mutated snapshot";
assert.equal(store.get(run.id)?.plan.nodes[0]?.task, "Collect fixed facts");
assert.throws(() => store.create("owner", spec, { chain: [] }, j, [], false));
assert.throws(() => store.owned("intruder", run.id));
assert.throws(() => store.node(run.id, "collect", { phase: "observing" }));
assert.equal(store.allowSpawn("owner", j.id), false, "public spawn cannot join reserved job");
const reserved = run.nodes[0]!.name;
assert.equal(store.allowExternal(`owner#${reserved}`), false, "reserve physical key before birth");
assert.equal(store.allowExternal(undefined, `.${reserved}!`), false, "same canonical alias as claimSlot");
assert.equal(store.allowSpawn("owner", "", undefined, reserved + "!"), false);
assert.equal(store.allowExternal("owner#ordinary", "ordinary"), true);
store.node(run.id, "collect", { phase: "spawning" });
store = loadWorkflowPlans(file, () => undefined);
assert.equal(store.get(run.id)?.nodes[0]?.phase, "spawn-unknown", "interrupted birth never resets to waiting");
assert.throws(() => store.node(run.id, "collect", { phase: "spawning" }));
store.end(run.id, "canceled", "cancel unknown spawn");
store.end(run.id, "completed", "late result");
assert.equal(store.get(run.id)?.state, "canceled");
store = loadWorkflowPlans(file, () => undefined);
assert.equal(store.get(run.id)?.state, "canceled");
assert.equal(store.allowExternal(`owner#${reserved}`), false, "terminal cancellation cannot free task ingress");
assert.equal(store.allowExternal(undefined, reserved + "!"), false, "reloaded reservation retains canonical identity");
assert.equal(store.allowTell("owner", j.id, "collect", "worker", run.nodes[0]!.turn), false);
const corrupt = join(dir, "corrupt.json");
writeFileSync(corrupt, "{oops");
assert.throws(() => loadWorkflowPlans(corrupt, () => undefined));
writeFileSync(corrupt, JSON.stringify({ wrongKey: store.get(run.id) }));
assert.throws(() => loadWorkflowPlans(corrupt, () => undefined));
renameSync(file, file + ".backup"); mkdirSync(file);
assert.throws(() => store.node(run.id, "collect", { reason: "storage test" }));
assert.equal(store.healthy(), false, "failed persistence withdraws in-flight capabilities");
assert.equal(JSON.parse(readFileSync(file + ".backup", "utf8"))[run.id].state, "canceled");
console.log("workflow plan schema, immutable ownership, legal transitions, unknown birth and strict storage passed");
