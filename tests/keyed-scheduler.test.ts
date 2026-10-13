import assert from "node:assert/strict";
import { createKeyedScheduler } from "../shared/keyed-scheduler.js";

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
};
const flush = () => new Promise<void>((r) => setImmediate(r));

const pool = createKeyedScheduler(2);
const a = deferred(), b = deferred();
const started: string[] = [];
let running = 0, max = 0;
const work = (id: string, gate?: Promise<void>) => async () => {
  started.push(id);
  max = Math.max(max, ++running);
  try { await gate; } finally { running--; }
  return id;
};
const first = pool.schedule("a", "%1", work("a", a.promise))!;
assert.equal(pool.schedule("a", "%2", work("duplicate")), undefined);
const samePane = pool.schedule("a2", "%1", work("a2"))!;
const other = pool.schedule("b", "%2", work("b", b.promise))!;
const next = pool.schedule("c", "%3", work("c"))!;
await flush();
assert.deepEqual(started, ["a", "b"]);
b.resolve();
assert.equal(await other, "b");
assert.equal(await next, "c", "a slow earlier resource must not stall the next free worker");
assert.equal(started.includes("a2"), false, "same pane stays exclusive");
a.resolve();
await first;
await samePane;
assert.deepEqual(started, ["a", "b", "c", "a2"]);
assert.equal(max, 2);

await assert.rejects(pool.schedule("error", "%1", async () => { throw new Error("expected"); })!, /expected/);
assert.equal(await pool.schedule("error", "%1", work("retry")), "retry", "throw must release key and resource");

const fifo = createKeyedScheduler(1), blocked = deferred();
const order: number[] = [];
const head = fifo.schedule("head", "r", async () => { await blocked.promise; });
const queued = [1, 2, 3].map((n) => fifo.schedule(String(n), "r", async () => { order.push(n); }));
blocked.resolve();
await Promise.all([head, ...queued]);
assert.deepEqual(order, [1, 2, 3]);

const stopped = createKeyedScheduler(1), waiting = deferred();
let sideEffects = 0;
const active = stopped.schedule("active", "one", async (signal) => {
  await waiting.promise;
  if (!signal.aborted) sideEffects++;
});
await flush();
const canceled = stopped.schedule("queued", "two", async () => { sideEffects++; });
stopped.stop();
assert.equal(await canceled, undefined, "stop settles pending promises without running them");
assert.equal(stopped.schedule("later", "three", work("later")), undefined);
waiting.resolve();
await active;
assert.equal(sideEffects, 0, "running work observes stop before later side effects");
pool.stop(); fifo.stop();
console.log("keyed scheduler: incremental refill, resource FIFO, dedup, bounds, errors and stop passed");
