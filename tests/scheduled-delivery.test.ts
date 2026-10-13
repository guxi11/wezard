import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { deliverScheduled, type ScheduledDispatchOptions } from "../daemon/scheduled-delivery.js";
import { startScheduler } from "../daemon/tasks.js";
import type { TaskRegistry } from "../daemon/task-registry.js";
import type { TaskRecord, TaskState } from "../shared/task-file.js";
import type { WSClient } from "@wecom/aibot-node-sdk";
import type { Logger } from "pino";

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
};
const flush = () => new Promise<void>((r) => setImmediate(r));
const until = async (ready: () => boolean) => {
  for (let i = 0; i < 100 && !ready(); i++) await flush();
  assert(ready(), "event did not arrive");
};

// Execute the production index adapter, not a stub that returns an early ok.
const source = readFileSync(new URL("../daemon/index.ts", import.meta.url), "utf8");
const start = source.indexOf("    scheduledTaskInject = async (target, text, opts) => {");
const end = source.indexOf("    /** 安静任务那一轮的终句:", start);
assert(start >= 0 && end > start);
const code = ts.transpileModule("let scheduledTaskInject;\n" + source.slice(start, end) + "\nglobalThis.inject=scheduledTaskInject;", {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;
const records: TaskRecord[] = [...Array.from({ length: 4 }, (_, n) => [`busy-${n}`, `user:busy-${n}`]), ["same", "user:busy-0"], ["fast", "user:fast"]]
  .map(([id, target]) => ({ id: id!, target: target!, file: "", trigger: { clock: { kind: "once", at: Date.now() - 1000 }, guards: [] },
    when: "once", prompt: id!, note: "", fresh: false, enabled: true, quiet: true, hasGate: false,
    gateTimeoutSec: 5, createdBy: "test", owner: "test" }));
const states = new Map(records.map((r) => [r.id, { createdAt: Date.now() - 2000 } as TaskState]));
const removed: string[] = [], delivered: string[] = [], attempts: string[] = [];
const barriers = new Map(records.slice(0, 4).map((r) => [r.target, deferred()]));
const ready = new Set(["user:fast"]);
let race = true;
const registry = {
  get: (id: string) => records.find((r) => r.id === id),
  list: () => records.filter((r) => !removed.includes(r.id)),
  stateOf: (id: string) => states.get(id)!,
  patchState: (id: string, patch: Partial<TaskState>) => states.set(id, { ...states.get(id), ...patch }),
  remove: (id: string) => { removed.push(id); },
} as unknown as TaskRegistry;
const ctx = vm.createContext({
  deliverScheduled, tasks: registry, ownerOf: () => "user:owner", sameBot: () => true,
  planStore: { allowExternal: () => true }, wizards: { get: () => ({}) }, TASK_POSTPONE_MS: 10_000,
  handedOff: async () => {}, newTurn: () => "turn", baseOfKey: (t: string) => t,
  renderTaskEnvelope: () => "envelope", relayUnlessQuiet: async () => {},
  runTaskInRunner: async () => { assert.fail("must not fall back during controlled readiness waits"); },
  m: {
    idleNow: async (target: string) => ready.has(target),
    untilIdle: async (target: string) => { await barriers.get(target)?.promise; return { idle: true }; },
    injectText: async (target: string, prompt: string, _origin: unknown, opts: { requireIdle: boolean; guard: () => boolean }) => {
      assert.equal(opts.requireIdle, true, "production named injection must recheck idle under the pane lock");
      assert(opts.guard());
      attempts.push(prompt);
      if (target === "user:busy-0" && race) {
        race = false;
        return { ok: false, retryable: true, reason: "busy won under lock" };
      }
      if (!ready.has(target)) return { ok: false, retryable: true };
      delivered.push(prompt);
      return { ok: true };
    },
  },
});
vm.runInContext(code, ctx);
const scheduler = startScheduler({
  client: { sendMessage: async () => ({}) } as unknown as WSClient, registry,
  log: { info() {}, warn() {}, error() {} } as unknown as Logger,
  inject: ctx.inject, fallbackTarget: () => "user:owner",
});
try {
  scheduler.tick();
  await until(() => delivered.includes("fast"));
  assert.equal(delivered.length, 1, "four busy target consumers must not occupy the four injection workers");
  scheduler.tick();
  assert.equal(removed.includes("busy-0"), false, "waiting firing stays in flight");
  ready.add("user:busy-0"); barriers.get("user:busy-0")!.resolve();
  // The first physical attempt is unsent. Task dedup must persist across retry.
  await until(() => attempts.includes("busy-0"));
  scheduler.tick();
  for (let i = 0; i < 100 && !delivered.includes("same"); i++) await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(delivered.filter((s) => ["busy-0", "same"].includes(s)), ["busy-0", "same"]);
  assert.equal(attempts.filter((s) => s === "busy-0").length, 2, "retry exactly the confirmed-unsent attempt");
  scheduler.stop();
  barriers.forEach((b, target) => { ready.add(target); b.resolve(); });
  await flush(); await flush();
  assert.equal(delivered.some((s) => ["busy-1", "busy-2", "busy-3"].includes(s)), false);
  assert.equal(states.get("busy-1")?.lastFired, undefined, "stopped definitely-unsent firing restores its clock");
} finally { scheduler.stop(); barriers.forEach((b) => b.resolve()); }

const c = new AbortController();
const options: ScheduledDispatchOptions = { taskId: "unknown", fresh: false, quiet: true, signal: c.signal,
  guard: () => true, submit: (f) => f() };
let unknownAttempts = 0;
const unknown = await deliverScheduled(options, {
  postponeMs: 1000, handedOff: async () => {}, idleNow: async () => true, untilIdle: async () => ({ idle: true }),
  named: async () => { unknownAttempts++; return { ok: false, uncertain: true, retryable: true }; },
  runner: async () => { assert.fail("uncertain must not fall back or retry"); },
});
assert.equal(unknown.uncertain, true);
assert.equal(unknownAttempts, 1);

// Also exercise the production adapter's submit callback through startScheduler:
// completing one transaction refills a worker without waiting for the batch.
records.splice(0, records.length, ...Array.from({ length: 8 }, (_, n) => ({
  ...records[0]!, id: `bounded-${n}`, prompt: `bounded-${n}`, target: `user:bounded-${n}`,
  trigger: { clock: { kind: "once" as const, at: Date.now() - 1000 }, guards: [] },
})));
removed.splice(0); states.clear();
records.forEach((r) => { states.set(r.id, { createdAt: Date.now() - 2000 }); ready.add(r.target); });
const releases = new Map<string, ReturnType<typeof deferred>>();
let running = 0, maximum = 0;
ctx.m.injectText = async (_target: string, prompt: string, _origin: unknown, o: { guard: () => boolean }) => {
  assert(o.guard());
  const barrier = deferred(); releases.set(prompt, barrier);
  maximum = Math.max(maximum, ++running);
  try { await barrier.promise; return { ok: true }; } finally { running--; }
};
const bounded = startScheduler({ client: { sendMessage: async () => ({}) } as unknown as WSClient, registry,
  log: { info() {}, warn() {}, error() {} } as unknown as Logger, inject: ctx.inject, fallbackTarget: () => "user:owner" });
bounded.tick();
await until(() => releases.size === 4);
assert.equal(maximum, 4);
releases.get("bounded-0")!.resolve();
await until(() => releases.size === 5);
assert.equal(maximum, 4);
bounded.stop(); releases.forEach((r) => r.resolve());
await flush(); await flush();
assert.equal(releases.size, 5, "stop must not begin queued physical transactions");
console.log("production scheduled delivery: busy consumers, target FIFO, unsent retry, cancellation and uncertain fence passed");
