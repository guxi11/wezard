import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WSClient } from "@wecom/aibot-node-sdk";
import type { Logger } from "pino";
import type { TaskRecord, TaskState } from "../shared/task-file.js";
import type { TaskRegistry } from "../daemon/task-registry.js";
import { startScheduler } from "../daemon/tasks.js";

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
};
const until = async (ready: () => boolean) => {
  for (let i = 0; i < 250 && !ready(); i++) await new Promise((r) => setTimeout(r, 10));
  assert(ready(), "condition did not become true");
};
const task = (id: string, target = "user:one", patch: Partial<TaskRecord> = {}): TaskRecord => ({
  id, target, file: "", trigger: { clock: { kind: "once", at: Date.now() - 1000 }, guards: [] },
  when: "once", prompt: id, note: "", fresh: false, enabled: true, quiet: true,
  hasGate: false, gateTimeoutSec: 5, createdBy: "test", owner: "test", ...patch,
});
const log = { info() {}, warn() {}, error() {} } as unknown as Logger;
const client = { sendMessage: async () => ({}) } as unknown as WSClient;
const fixture = (records: TaskRecord[], inject: (target: string, prompt: string) => Promise<{ ok: boolean }>) => {
  const states = new Map(records.map((r) => [r.id, { createdAt: Date.now() - 2000 } as TaskState]));
  const removed: string[] = [];
  const registry = {
    list: () => records.filter((r) => !removed.includes(r.id)),
    stateOf: (id: string) => states.get(id)!,
    patchState: (id: string, patch: Partial<TaskState>) => states.set(id, { ...states.get(id), ...patch }),
    remove: (id: string) => { removed.push(id); },
  } as unknown as TaskRegistry;
  return { states, removed, scheduler: startScheduler({ client, registry, log, inject, fallbackTarget: () => "user:one" }) };
};

// More tasks wait on one target than there are gate workers. A new target must
// still advance, and repeated ticks must not duplicate any accepted firing.
const release = deferred(), starts: string[] = [];
const f = fixture([...Array.from({ length: 6 }, (_, n) => task(`same-${n}`)), task("other", "user:two")], async (_target, prompt) => {
  starts.push(prompt);
  if (prompt === "same-0") await release.promise;
  return { ok: true };
});
f.scheduler.tick(); f.scheduler.tick();
await until(() => starts.includes("other"));
assert.deepEqual(starts.filter((s) => s.startsWith("same-")), ["same-0"]);
f.scheduler.tick();
assert.equal(starts.filter((s) => s === "same-0").length, 1);
release.resolve();
await until(() => f.removed.length === 7);
assert.deepEqual(starts.filter((s) => s.startsWith("same-")), Array.from({ length: 6 }, (_, n) => `same-${n}`));
f.scheduler.stop();

const stoppedBeforeStart: string[] = [];
const pending = fixture(Array.from({ length: 8 }, (_, n) => task(`pending-${n}`)), async (_target, prompt) => {
  stoppedBeforeStart.push(prompt); return { ok: true };
});
pending.scheduler.tick();
pending.scheduler.stop();
await new Promise<void>((r) => setImmediate(r));
assert.deepEqual(stoppedBeforeStart, []);
assert.deepEqual(pending.removed, [], "stop must not consume queued once-tasks");
assert([...pending.states.values()].every((s) => s.lastFired === undefined));

let attempts = 0;
const failures = fixture([task("retry", "user:one", { trigger: { clock: { kind: "every", minutes: 1 }, guards: [] } })], async () => {
  attempts++;
  if (attempts === 1) throw new Error("injection failed");
  return { ok: true };
});
failures.states.set("retry", { createdAt: Date.now() - 120_000 });
failures.scheduler.tick();
await until(() => attempts === 1);
await new Promise<void>((r) => setImmediate(r));
failures.states.set("retry", { lastFired: Date.now() - 120_000 });
failures.scheduler.tick();
await until(() => attempts === 2);
failures.scheduler.stop();

// Real isolated gate subprocess, released by a file barrier rather than elapsed
// time. B must inject before A's gate is released; stop blocks A's late injection.
const dir = mkdtempSync(join(tmpdir(), "wezard-task-scheduler-"));
const marker = join(dir, "release"), entered = join(dir, "entered"), gate = join(dir, "slow.task.mjs");
writeFileSync(gate, `import {existsSync,writeFileSync} from 'node:fs';\nexport default {gate:async()=>{writeFileSync(${JSON.stringify(entered)},'yes');while(!existsSync(${JSON.stringify(marker)}))await new Promise(r=>setTimeout(r,10));return true;}};`);
const injected: string[] = [];
const g = fixture([task("slow", "user:one", { file: gate, hasGate: true }), task("fast", "user:two")], async (_target, prompt) => {
  injected.push(prompt); return { ok: true };
});
try {
  g.scheduler.tick();
  await until(() => injected.includes("fast") && existsSync(entered));
  assert.equal(injected.includes("slow"), false);
  g.scheduler.stop();
  writeFileSync(marker, "go");
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(injected.includes("slow"), false);
  assert.equal(g.removed.includes("slow"), false, "stopped in-flight once-task remains recorded");
} finally {
  g.scheduler.stop();
  writeFileSync(marker, "go");
  await new Promise((r) => setTimeout(r, 50));
  rmSync(dir, { recursive: true, force: true });
}
console.log("task scheduler: slow gate isolation, same-target FIFO, task dedup and stop passed");
