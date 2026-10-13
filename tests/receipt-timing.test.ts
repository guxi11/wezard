import assert from "node:assert/strict";
import pino from "pino";
import { createReceipts, type ReceiptMeta, type Slot, type Tell } from "../daemon/receipts.js";
import type { JsonMap } from "../shared/json-map-store.js";

// Resolve only explicit events: no elapsed-time sleeps, model calls, daemon or tmux.
const drain = async (condition: () => boolean, label: string) => {
  for (let n = 0; n < 500 && !condition(); n++) await Promise.resolve();
  assert.ok(condition(), label);
};
const flush = async () => { for (let n = 0; n < 100; n++) await Promise.resolve(); };
const fixture = () => {
  let rows: Record<string, Slot> = {};
  const store: JsonMap<Slot> = {
    get: (key) => rows[key], set: (key, value) => (rows[key] = structuredClone(value), value),
    drop: (key) => { delete rows[key]; }, merge: (xs) => { rows = { ...rows, ...structuredClone(xs) }; }, all: () => structuredClone(rows),
  };
  const busy = new Set<string>();
  const waits = new Map<string, (() => void)[]>();
  const replies = new Map<string, { at: number; text: string }>();
  const sent: { to: string; body: string; meta: ReceiptMeta }[] = [];
  const errors: unknown[] = [];
  const log = pino({ level: "silent" });
  const r = createReceipts({
    log: { ...log, child: () => ({ ...log, info() {}, warn: (x: unknown) => { errors.push(x); } }), warn: (x: unknown) => { errors.push(x); } } as typeof log,
    store, nameOf: (s) => s, paneLive: async () => true,
    idleNow: async (to) => !busy.has(to),
    untilIdle: async (to) => {
      if (busy.has(to)) await new Promise<void>((resolve) => waits.set(to, [...(waits.get(to) ?? []), resolve]));
      return { idle: true };
    },
    replyFor: (to, _from, since, turn) => {
      const x = replies.get(`${to}:${turn}`);
      return x && x.at >= since ? { text: x.text } : undefined;
    },
    deliver: async (to, body, meta) => {
      // A NEED waits on an explicit continuation event, never a ramp timer.
      if (meta.status === "need") busy.add(meta.from);
      sent.push({ to, body, meta });
      return { ok: true };
    },
  });
  const idle = (to: string) => { busy.delete(to); const xs = waits.get(to) ?? []; waits.delete(to); xs.forEach((f) => f()); };
  const register = (tell: Tell) => { busy.add(tell.to); return r.register(tell); };
  const answer = (to: string, turn: string, text: string) => { replies.set(`${to}:${turn}`, { at: Date.now() + 1, text }); idle(to); };
  const row = (from = "sender", to = "worker") => store.get(`${from}\0${to}`)!;
  return { r, sent, busy, waits, register, answer, idle, row, errors };
};

// The receiver has read NEED; exactly one committed re creates leg 2. Preparing
// it repeatedly cannot spend a leg, and two explicit re calls really do make 3.
for (const continuations of [1, 2]) {
  const f = fixture();
  const first = f.register({ from: "sender", to: "worker", turn: "task", channel: "" });
  await drain(() => f.waits.has("worker"), "first dispatch is running");
  f.answer("worker", first.turn, "NEED: password");
  await drain(() => f.sent.length === 1 && f.waits.has("worker"), "NEED delivered and watcher awaiting re");
  assert.equal(f.sent[0].meta.status, "need");
  assert.equal(f.row().resolved, false);
  assert.equal(f.row().settled, undefined);
  assert.equal(f.row().legs, 1);
  for (let leg = 2; leg <= continuations + 1; leg++) {
    const re = f.r.prepare("sender", "worker", first.turn);
    assert.equal(re.turn, first.turn);
    assert.equal(re.legs, leg);
    assert.deepEqual(f.r.prepare("sender", "worker", first.turn), re);
    assert.equal(f.row().legs, leg - 1);
    f.register({ from: "sender", to: "worker", channel: "", ...re });
    await flush();
  }
  f.answer("worker", first.turn, "RESULT: correct");
  await drain(() => !!f.row().settled, "final receipt settled");
  assert.deepEqual(f.sent.map((s) => s.meta.status), ["need", "done"]);
  assert.equal(f.row().legs, continuations + 1);
  assert.equal(f.row().turn, first.turn);
  assert.equal(f.row().outcome?.body, "RESULT: correct");
  assert.deepEqual(f.errors, []);
}

// When NEED is queued behind a busy sender, re supersedes it before delivery.
// Releasing the old queue must not deliver stale NEED or duplicate the final.
{
  const f = fixture();
  f.busy.add("sender");
  f.register({ from: "sender", to: "worker", turn: "queued", channel: "" });
  await drain(() => f.waits.has("worker"), "worker busy");
  f.answer("worker", "queued", "NEED: password");
  await drain(() => f.waits.has("sender"), "NEED queued at sender");
  assert.equal(f.row().outcome?.status, "need");
  assert.equal(f.row().resolved, false);
  assert.equal(f.sent.length, 0);
  f.register({ from: "sender", to: "worker", channel: "", ...f.r.prepare("sender", "worker", "queued") });
  await drain(() => f.waits.has("worker"), "continuation busy");
  f.idle("sender");
  f.answer("worker", "queued", "RESULT: after re");
  await drain(() => !!f.row().settled, "superseding final settled");
  assert.deepEqual(f.sent.map((s) => s.meta.status), ["done"]);
  assert.equal(f.row().legs, 2);
  assert.deepEqual(f.errors, []);
}

// Handoff transfers two distinct unresolved turns while the old worker is held.
// A separate control schedule closes one old ask first, proving carried=1 cannot
// satisfy the two-owed prerequisite even if both later produce correct values.
for (const oldClosed of [false, true]) {
  const f = fixture();
  const initial = Date.now() - 100;
  const carryAt = Date.now();
  f.register({ from: "root", to: "worker", turn: "root-turn", channel: "", at: initial });
  f.register({ from: "other", to: "worker", turn: "other-turn", channel: "", at: initial });
  await drain(() => f.waits.get("worker")?.length === 2, "both old watchers blocked");
  for (const from of ["root", "other"]) {
    assert.equal(f.row(from).resolved, false);
    assert.equal(f.row(from).claimed, false);
  }
  const carried = f.r.transfer("worker", (s) => oldClosed && s.from === "root" ? "RESULT: old root" : "", carryAt);
  assert.deepEqual(carried.map((s) => [s.from, s.turn]), oldClosed ? [["other", "other-turn"]] : [["root", "root-turn"], ["other", "other-turn"]]);
  assert.equal(f.row("root").at, oldClosed ? initial : carryAt);
  assert.equal(f.row("other").at, carryAt);
  for (const s of carried) assert.ok(s.deadlineAt! >= carryAt + 600_000);
  // Distinct answers keyed by original envelope turn, in either arrival order.
  f.answer("worker", "other-turn", "RESULT: new other");
  f.answer("worker", "root-turn", "RESULT: new root");
  await drain(() => !!f.row("root").settled && !!f.row("other").settled, "both obligations settle");
  assert.equal(f.sent.length, 2);
  for (const [from, turn, body] of [["root", "root-turn", oldClosed ? "RESULT: old root" : "RESULT: new root"], ["other", "other-turn", "RESULT: new other"]]) {
    const xs = f.sent.filter((s) => s.to === from && s.meta.turn === turn);
    assert.equal(xs.length, 1);
    assert.equal(xs[0].meta.status, "done");
    assert.equal(xs[0].body, body);
  }
  assert.deepEqual(f.errors, []);
}
console.log("receipt timing: 5 event-gated NEED/re and two-owed handoff schedules passed");
