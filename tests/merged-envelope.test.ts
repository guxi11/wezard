import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMessageEvents, receiptFacts, type MessageAdapters, type MessageEvent } from "../daemon/message-events.js";
import { renderPeerEnvelope, renderReceiptEnvelope } from "../daemon/peers.js";
import { parseEnvelope, renderTail, withMsg } from "../shared/reminder.js";

const settle = async (check: () => boolean): Promise<void> => {
  for (let i = 0; i < 100 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(check(), "expected message event transition did not occur");
};

const run = async (kind: "task" | "receipt"): Promise<void> => {
  const dir = mkdtempSync(join(tmpdir(), `wezard-merged-envelope-${kind}-`));
  const file = join(dir, "events.json");
  let ready = false;
  let evidenceOpen = false;
  let events!: ReturnType<typeof createMessageEvents>;
  const injected: Array<{ id: string; parsed: ReturnType<typeof parseEnvelope> }> = [];
  const sender = kind === "task" ? "lead" : "worker";
  const makeFact = (id: string) => ({
    event: `route:${id}`, batch: "batch-one", version: `v-${id}`, status: "done",
    receiver: { kind: "wizard" as const, to: "worker" }, body: `answer ${id}`, speaker: "worker",
    envelope: renderReceiptEnvelope(`stale-${id}`, undefined, "done", `turn-${id}`),
  });
  const input = (id: string, at: number): MessageEvent => {
    const isTask = kind === "task";
    const envelope = isTask ? renderPeerEnvelope("lead") : renderReceiptEnvelope("worker", undefined, "done", `turn-${id}`);
    return {
      id, target: "worker", speaker: isTask ? "lead" : "daemon", channel: "", priority: "normal",
      deadline: Number.MAX_SAFE_INTEGER, ...(isTask ? { serves: "route:work" } : {}),
      payload: {
        text: isTask ? `${renderPeerEnvelope(`stale-${id}`)}\nrequest ${id}` : `${makeFact(id).envelope}\nanswer ${id}`,
        ...(isTask ? {} : { receipts: [makeFact(id)] }),
        peer: { from: { kind: "peer", from: sender, ...(isTask ? {} : { receipt: true }) }, envelope,
          kind: "task", ...(isTask ? { tell: {} as never } : {}) },
      },
      fingerprint: id, at, execution: "queued", exposure: "none", attempts: 0,
    };
  };
  const io = {
    resource: () => "worker-pane", transcript: () => "worker-transcript", sessionId: () => "worker-session",
    ready: async () => ready, valid: () => true, accepted: () => {}, committed: () => {}, canceled: () => {},
    task: (event: MessageEvent) => event.serves,
    inject: async (event: MessageEvent, boundary: (phase?: "paste" | "submit", identity?: { sessionId?: string; transcript?: string }) => boolean) => {
      const peer = event.payload.peer!;
      const payload = `${event.payload.text}${renderTail(withMsg(peer.envelope, event.id))}`;
      const parsed = parseEnvelope(payload);
      injected.push({ id: event.id, parsed });
      boundary("paste", { sessionId: "worker-session", transcript: "worker-transcript" });
      return { ok: true };
    },
    evidence: async (event: MessageEvent) => {
      const seen = injected.find((row) => row.parsed?.eventId === event.id && row.id === event.id);
      return evidenceOpen && seen ? { consumed: true } : { consumed: false };
    },
    recovered: () => {}, send: async () => ({}), error: (error: unknown) => { throw error; }, retain: () => false,
  } as unknown as MessageAdapters;
  events = createMessageEvents(file, io);
  try {
    const first = input(kind === "task" ? "route:carrier" : "rcpt:carrier", 1);
    const second = input(kind === "task" ? "route:supplement" : "rcpt:supplement", 2);
    events.accept(first);
    events.accept(second);
    events.resume();
    await events.pump();
    assert.equal(injected.length, 0, `${kind} waits while ready is closed`);
    ready = true;
    await events.pump();
    await settle(() => injected.length === 1);

    const carrierId = injected[0]!.id;
    const absorbedId = carrierId === first.id ? second.id : first.id;
    const parsed = injected[0]!.parsed;
    assert.equal(parsed?.eventId, carrierId, "the carrier envelope carries the real injected event id");
    assert.equal(parsed?.from, sender, "the appended formal envelope determines the sender");
    assert.equal(!!parsed?.receipt, kind === "receipt");
    assert.equal(events.get(carrierId)?.exposure, "submitted");
    assert.equal(events.exposureOf(absorbedId), undefined, "absorbed rows do not prove their own transcript exposure");
    if (kind === "task") assert.deepEqual(events.get(carrierId)?.inputIds, [first.id, second.id].sort());
    else assert.deepEqual(receiptFacts(events.get(carrierId)!).sort((a, b) => a.event.localeCompare(b.event)),
      [...receiptFacts(first), ...receiptFacts(second)].sort((a, b) => a.event.localeCompare(b.event)));

    await events.reconcile(carrierId);
    assert.equal(events.get(carrierId)?.exposure, "submitted", "missing transcript evidence cannot consume the carrier");
    evidenceOpen = true;
    await events.reconcile(carrierId);
    assert.equal(events.get(carrierId)?.exposure, "consumed", "matching parsed event id plus evidence consumes the carrier");
  } finally {
    events.stop();
    rmSync(dir, { recursive: true, force: true });
  }
};

await run("task");
await run("receipt");
