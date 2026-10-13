import assert from "node:assert/strict";
import { mock } from "node:test";
import { withPaneInput, PaneInputError } from "../daemon/pane-input.js";

const latch = () => {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
};
const drain = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
mock.timers.enable({ apis: ["setTimeout"] });
try {
  const held = latch();
  const events: string[] = [];
  const a = withPaneInput("%same", async () => { events.push("a:paste"); await held.promise; events.push("a:enter"); });
  const b = withPaneInput("%same", async () => { events.push("b:paste"); events.push("b:enter"); });
  await withPaneInput("%other", async () => { events.push("other"); });
  assert.deepEqual(events, ["a:paste", "other"]);
  held.release();
  await Promise.all([a, b]);
  assert.deepEqual(events, ["a:paste", "other", "a:enter", "b:paste", "b:enter"]);

  const gate = latch();
  let allowed = true, called = false;
  const first = withPaneInput("%guard", () => gate.promise);
  const queued = withPaneInput("%guard", async () => { called = true; }, { guard: () => allowed });
  const canceled = assert.rejects(queued, (e: unknown) => e instanceof PaneInputError && e.code === "canceled");
  allowed = false;
  gate.release();
  await Promise.all([first, canceled]);
  assert.equal(called, false, "guard is rechecked after acquiring the pane");

  const slow = latch();
  let lateInput = false, nextRan = false, live!: () => boolean;
  const timed = withPaneInput("%timeout", async (check) => {
    live = check;
    await slow.promise;
    if (check()) lateInput = true;
  }, { timeoutMs: 10 });
  const timedOut = assert.rejects(timed, (e: unknown) => e instanceof PaneInputError && e.code === "timeout");
  await drain();
  mock.timers.tick(10);
  await timedOut;
  assert.equal(live(), false);
  const waiting = withPaneInput("%timeout", async () => { nextRan = true; }, { timeoutMs: 10 });
  const queueTimeout = assert.rejects(waiting, (e: unknown) => e instanceof PaneInputError && e.code === "timeout");
  await drain();
  assert.equal(nextRan, false, "timeout must not release a running physical action");
  mock.timers.tick(10);
  await queueTimeout;
  const recovery = withPaneInput("%timeout", async () => { nextRan = true; });
  await withPaneInput("%free", async () => {});
  assert.equal(nextRan, false);
  slow.release();
  await recovery;
  assert.equal(nextRan, true);
  assert.equal(lateInput, false, "late paste/Enter must check the revoked fence");

  let permitted = true;
  await withPaneInput("%withdraw", async (check) => {
    assert.equal(check(), true);
    permitted = false;
    assert.equal(check(), false);
    permitted = true;
    assert.equal(check(), false, "revocation is sticky");
  }, { guard: () => permitted });
  await assert.rejects(withPaneInput("%error", async () => { throw new Error("broken probe"); }), /broken probe/);
  assert.equal(await withPaneInput("%error", async () => 42), 42);
} finally { mock.timers.reset(); }
console.log("pane input: serialization, parallel panes, queued revocation, bounded waits, timeout fencing and recovery passed");
