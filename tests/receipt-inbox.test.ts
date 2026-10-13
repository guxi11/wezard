import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { createReceipts, type ReceiptDeps, type ReceiptDelivery, type ReceiptMeta, type Slot } from "../daemon/receipts.js";
import { loadJsonMap } from "../shared/json-map-store.js";

const flush = async () => { for (let i = 0; i < 100; i++) await Promise.resolve(); };
const until = async (f: () => boolean) => {
  for (let i = 0; i < 300 && !f(); i++) await new Promise((r) => setTimeout(r, 1));
  assert.ok(f(), "expected inbox event");
};
const fixture = () => {
  const file = join(mkdtempSync(join(tmpdir(), "receipt-inbox-")), "receipts.json");
  let store = loadJsonMap<Slot>(file, undefined, { strict: true });
  const busy = new Set<string>();
  const dead = new Set<string>();
  const waits = new Map<string, Array<() => void>>();
  const replies = new Map<string, string>();
  const sent: Array<{ to: string; meta: ReceiptMeta; body: string }> = [];
  const accounted: string[] = [];
  let transport: ReceiptDeps["deliver"] = async () => ({ ok: true });
  let failWrite = false;
  const deps: ReceiptDeps = {
    log: pino({ level: "silent" }), retryMs: 1, nameOf: (x) => x,
    store: { ...store, all: () => store.all(), merge: (rows) => { if (failWrite) throw Error("disk failed"); store.merge(rows); } },
    paneLive: async (x) => !dead.has(x), idleNow: async (x) => !busy.has(x),
    untilIdle: async (x) => { if (busy.has(x)) await new Promise<void>((r) => waits.set(x, [...waits.get(x) ?? [], r])); return { idle: true }; },
    replyFor: (to, _from, _at, turn) => replies.has(`${to}:${turn}`) ? { text: replies.get(`${to}:${turn}`)! } : undefined,
    deliver: async (to, body, meta, guard) => { assert.ok(guard?.()); sent.push({ to, meta: structuredClone(meta), body }); return transport(to, body, meta, guard); },
    onOutcome: (s) => { assert.ok(Object.values(store.all()).some((r) => r.turn === s.turn && r.inbox?.length), "inbox durable before outcome accounting"); accounted.push(s.turn!); },
  };
  let r = createReceipts(deps);
  const idle = (x: string) => { busy.delete(x); const xs = waits.get(x) ?? []; waits.delete(x); xs.forEach((f) => f()); };
  const register = (turn: string, from = "asker", to = "worker", extra: Partial<Slot> = {}) => { busy.add(to); r.register({ from, to, turn, channel: "", ...extra }); };
  const answer = (turn: string, to = "worker", text = `RESULT: ${turn}`) => { replies.set(`${to}:${turn}`, text); idle(to); };
  return { get r() { return r; }, get store() { return store; }, busy, dead, waits, sent, accounted, register, answer, idle,
    transport: (f: ReceiptDeps["deliver"]) => { transport = f; }, fail: () => { failWrite = true; },
    restart: () => { r.stop(); store = loadJsonMap<Slot>(file, undefined, { strict: true }); r = createReceipts(deps); r.resume(); },
    close: () => { r.stop(); [...waits.keys()].forEach(idle); },
  };
};

// Completion is durable before busy asker consumption; same pair retains every turn.
{
  const f = fixture(); f.busy.add("asker");
  f.register("one"); await flush(); f.answer("one"); await until(() => f.accounted.length === 1);
  f.register("two"); await flush(); f.answer("two"); await until(() => f.accounted.length === 2);
  assert.deepEqual(f.r.inbox().map((m) => [m.turn, m.state]), [["one", "queued"], ["two", "queued"]].sort());
  assert.equal(f.sent.length, 0);
  assert.equal(f.r.prepare("asker", "worker", "one").turn, "one");
  assert.equal(f.r.sentAt("asker", "worker"), f.store.get("asker\0worker")?.at);
  f.register("independent", "other", "worker2"); await flush(); f.answer("independent", "worker2");
  await until(() => f.sent.length === 1); assert.equal(f.sent[0].to, "other");
  f.restart(); f.idle("asker"); await until(() => f.r.inbox("asker").every((m) => m.state === "delivered"));
  assert.deepEqual(f.sent.filter((m) => m.to === "asker").map((m) => m.meta.turn), ["one", "two"]);
  assert.equal(new Set(f.sent.map((m) => m.meta.eventId)).size, 3);
  f.restart(); await flush(); assert.equal(f.sent.length, 3); f.close();
}

// One asker consumer cannot overlap transport; other panes make progress.
{
  const f = fixture(); let finish!: (r: ReceiptDelivery) => void;
  f.transport(async (to) => to === "asker" && f.sent.length === 1 ? new Promise((r) => { finish = r; }) : { ok: true });
  f.register("one"); await flush(); f.answer("one"); await until(() => !!finish);
  f.register("two"); await flush(); f.answer("two"); await until(() => f.accounted.length === 2);
  assert.equal(f.sent.length, 1); assert.equal(f.r.claim("asker", "worker"), false, "latest pair claim takes queued second result only");
  finish({ ok: true }); await until(() => f.r.inbox().some((m) => m.state === "delivered"));
  assert.equal(f.sent.length, 1); f.close();
}

// Definite unsent retries preserve event identity; an ACK never retries on resume.
{
  const f = fixture(); f.transport(async () => { return f.sent.length === 1 ? { ok: false, retryable: true, reason: "busy under pane lock" } : { ok: true }; });
  f.register("retry"); await flush(); f.answer("retry");
  await until(() => f.r.inbox()[0]?.state === "delivered");
  assert.equal(f.sent.length, 2); assert.equal(f.sent[0].meta.eventId, f.sent[1].meta.eventId);
  assert.equal(f.accounted.length, 1); f.restart(); await flush(); assert.equal(f.sent.length, 2); f.close();
}
for (const result of [{ ok: false }, { ok: false, uncertain: true, retryable: true }, { ok: true, uncertain: true }, "throw"] as const) {
  const f = fixture(); f.transport(async () => { if (result === "throw") throw Error("paste failed after exposure"); return result; });
  f.register("unknown"); await flush(); f.answer("unknown"); await until(() => f.r.inbox()[0]?.state === "uncertain");
  assert.equal(f.r.claim("asker", "worker"), "uncertain"); assert.equal(f.store.get("asker\0worker")?.settled, undefined);
  f.restart(); await flush(); assert.equal(f.sent.length, 1); assert.equal(f.r.inbox()[0].state, "uncertain"); f.close();
}

// Crash while transport is in flight is ambiguous even if no ACK was persisted.
{
  const f = fixture(); let finish!: (r: ReceiptDelivery) => void;
  f.transport(async () => new Promise((r) => { finish = r; }));
  f.register("crash"); await flush(); f.answer("crash"); await until(() => !!finish);
  assert.equal(f.r.claim("asker", "worker"), "uncertain"); f.restart(); finish({ ok: true }); await flush();
  assert.equal(f.sent.length, 1); assert.equal(f.r.inbox()[0].state, "uncertain"); f.close();
}

// Offline queues survive KEEP_MS and restart; they are not marked settled.
{
  const f = fixture(); f.dead.add("asker"); f.register("offline"); await flush(); f.answer("offline");
  await until(() => !!f.r.inbox()[0]?.retryAt);
  const row = f.store.get("asker\0worker")!; f.store.set("asker\0worker", { ...row, at: Date.now() - 48 * 3600_000 });
  f.restart(); assert.equal(f.r.inbox()[0].state, "queued"); assert.equal(f.sent.length, 0);
  f.dead.delete("asker"); await until(() => f.sent.length === 1); f.close();
}

// Last sibling reply ownership is retained through retries, never released early.
{
  const f = fixture(); const k = { kind: "chat" as const, channel: "chat:human", turn: "human" };
  f.busy.add("asker"); f.register("first", "asker", "w1", { k }); f.register("last", "asker", "w2", { k });
  await flush(); f.answer("first", "w1"); await until(() => f.accounted.length === 1);
  f.answer("last", "w2"); await until(() => f.accounted.length === 2);
  f.transport(async () => f.sent.length === 1 ? { ok: false, retryable: true } : { ok: true });
  f.idle("asker"); await until(() => f.r.inbox().every((m) => m.state === "delivered"));
  assert.deepEqual(f.sent.map((s) => !!s.meta.replyTo), [false, false, true]); f.close();
}

// A failed durable outcome write never starts transport or publishes accounting.
{
  const f = fixture(); f.register("disk"); await flush(); f.fail(); f.answer("disk"); await flush();
  assert.equal(f.sent.length, 0); assert.equal(f.accounted.length, 0); f.close();
}

{
  const f = fixture(); f.busy.add("asker"); f.register("old"); await flush(); f.answer("old");
  await until(() => f.accounted.length === 1);
  const re = f.r.prepare("asker", "worker", "old");
  f.register("old", "asker", "worker", { ...re });
  assert.equal(f.r.inbox()[0].state, "queued", "terminal old leg remains queued after re");
  f.idle("asker"); await until(() => f.sent.length === 1);
  assert.equal(f.store.get("asker\0worker")?.resolved, false, "old delivery cannot settle continuation");
  f.answer("old", "worker", "RESULT: new leg"); await until(() => f.r.inbox().length === 2 && f.r.inbox()[1].state === "delivered");
  assert.deepEqual(f.sent.map((m) => m.body), ["RESULT: old", "RESULT: new leg"]); f.close();
}
{
  const f = fixture(); f.register("quiet"); await flush();
  const env = { kind: "peer" as const, from: "asker", private: true, turn: "quiet" };
  assert.deepEqual(f.r.parentOf("worker", env, "", "opening"), { kind: "peer", from: "asker", turn: "quiet" });
  assert.equal(f.r.parentOf("worker", { ...env, quiet: true }, "chat:human", "opening"), undefined);
  f.close();
}

console.log("receipt inbox: durable completion, busy/offline retention, pair FIFO, claim, retries, unknown ACK and restart passed");
