import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NO_DEADLINE } from "../shared/turn-state.js";
import { openRouter, ops } from "../daemon/router.js";
import { canSettleFinal, correctionTaskEvent, coversTaskInputIds, createMessageEvents, eventDeliveryAllowed, eventFinalPublication, peerEventPrerequisitesReady, publishEventFinal, reportSource, resultCorrectionInputs, runEventFinalRecovery, settleAddressedResults, settleUnaddressedResult, servedChatResultFinalAllowed, servedChatResultPublicAllowed, rejectUncoveredServedChatResult, settleServedChatResult, taskInputCoverage, type MessageAdapters, type MessageEvent } from "../daemon/message-events.js";
import { parseEnvelope, renderReminder, renderTail, withMsg } from "../shared/reminder.js";
import { renderPeerEnvelope, renderReceiptEnvelope } from "../daemon/peers.js";

const input = (id: string, overrides: Partial<MessageEvent> = {}): MessageEvent => ({
  id, target: "worker", speaker: "lead", channel: "", priority: "normal", deadline: Number.MAX_SAFE_INTEGER,
  payload: { text: id, peer: { from: { kind: "peer", from: "lead" }, envelope: "task", kind: "task", tell: {} as never } },
  fingerprint: id, at: 1, execution: "awaiting-result", exposure: "consumed", consumedAt: 10,
  sessionId: "session-a", serves: "route:task", attempts: 1, ...overrides,
});

const source: MessageEvent = { ...input("result", { payload: { text: "@.lead RESULT: done", peer: undefined } }),
  result: { body: "@.lead RESULT: done", revision: "r1", at: 100 } };
const original = input("route:original");
const mergeCarrier = input("route:carrier", { inputIds: ["route:original", "route:carrier", "route:absorbed"] });
const absorbed = input("route:absorbed", { execution: "complete", consumedAt: 11 });

const merged = taskInputCoverage([original, mergeCarrier, absorbed], "route:task", source);
assert.deepEqual(merged.inputs, ["route:absorbed", "route:carrier", "route:original"]);
assert.equal(merged.complete, true, "the consumed merge carrier covers the text it actually carried");
const formal = renderReminder({ wezard: "envelope", kind: "peer", from: "lead", scope: "private", msg: "route:carrier" }, []);
for (const kind of ["task", "receipt"] as const) {
  const captured = `${kind} summary\n${formal}`;
  const stamped = withMsg(captured, "route:carrier");
  assert.equal(parseEnvelope(stamped)?.eventId, "route:carrier", `${kind} merge carrier retains its formal message envelope`);
}
assert.equal(taskInputCoverage([original, absorbed], "route:task", source).complete, false,
  "an absorbed complete/consumed row cannot prove its carrier was read");

const lateSupplement = input("route:late", { consumedAt: 101 });
assert.equal(taskInputCoverage([original, mergeCarrier, absorbed, lateSupplement], "route:task", source).complete, false,
  "a supplement consumed after the final remains uncovered");
assert.equal(taskInputCoverage([input("route:handoff-consumed", { sessionId: "session-b" })], "route:task", source).inputs.length, 1,
  "consumed input from before a handoff retains original task coverage semantics");
assert.equal(taskInputCoverage([input("route:unconsumed", { exposure: "submitted", consumedAt: undefined })], "route:task", source).complete, false,
  "submission without consumption evidence cannot cover the result");
assert.equal(coversTaskInputIds([original, lateSupplement], [original.id]), false,
  "frozen coverage cannot silently absorb a later task supplement");
assert.equal(correctionTaskEvent({ event: "route:bound" }, "route:unrelated"), "route:bound",
  "rejection feedback follows the selected durable binding rather than the FYI carrier's serves value");
assert.equal(correctionTaskEvent({ event: null }, "route:unrelated"), undefined,
  "an explicit unresolved binding cannot fall through to a potentially unrelated serves task");
assert.equal(correctionTaskEvent(undefined), undefined, "an unbound FYI without serves still gets orphan feedback");
const correctionSource = input("event:correction", { target: "worker", serves: undefined });
const routeRow = (owner: string, status: "open" | "answered") => ({ event: "route:task", owner,
  receiver: { kind: "wizard" as const, to: "lead" }, status, at: 1, deadlineAt: NO_DEADLINE, seq: 1,
  outcome: status === "answered" ? { status: "done" as const, body: "done", at: 2 } : undefined });
for (const status of ["answered"] as const) {
  const feedback = resultCorrectionInputs(correctionSource, "lead", 0, "rejected", routeRow("worker", status), (x) => x, (x) => x);
  assert.equal(feedback[0]?.serves, undefined, "terminal task corrections are FYI only");
}
const transferFeedback = resultCorrectionInputs(correctionSource, "lead", 0, "rejected", routeRow("owner-now", "open"), (x) => x, (x) => x);
assert.equal(transferFeedback.length, 2, "a live transferred task notifies executor and current owner");
assert.equal(transferFeedback[0]?.target, "worker");
assert.equal(transferFeedback[1]?.target, "owner-now");
assert.equal(transferFeedback[1]?.serves, undefined, "current-owner notice does not attach to the task");
assert.match(transferFeedback[1]?.payload.text ?? "", /执行者.*来源事件.*当前 owner.*私密知会，无需回复，也不要新建任务/);
assert.doesNotMatch(transferFeedback[1]?.payload.text ?? "", /RESULT: <结论>/,
  "current-owner notice does not ask for another result");
assert.deepEqual(transferFeedback.map((x) => x.id), resultCorrectionInputs(correctionSource, "lead", 0,
  "another reason", routeRow("owner-now", "open"), (x) => x, (x) => x).map((x) => x.id),
"transfer correction event identities remain stable across reason changes");
const renamedFeedback = resultCorrectionInputs(correctionSource, "served", 0, "rejected", routeRow("worker", "open"),
  (x) => x === "worker" ? "Worker renamed" : x, (x) => x);
const renamedAgain = resultCorrectionInputs(correctionSource, "served", 0, "rejected again", routeRow("worker", "need" as never),
  (x) => x === "worker" ? "Worker's new display name" : x, (x) => x);
assert.equal(renamedAgain[0]?.id, renamedFeedback[0]?.id, "display-name changes do not change the stable served correction identity");
const heldFeedback = resultCorrectionInputs(correctionSource, "served", 0, "前置尚未就绪",
  { ...routeRow("worker", "open"), status: "held" }, (x) => x,
  (name, fyi) => renderPeerEnvelope(name, undefined, undefined, fyi ? { act: "fyi", quiet: true } : undefined))[0]!;
assert.equal(heldFeedback.serves, undefined, "held-route correction is not attached as a task");
assert.equal(heldFeedback.feedbackRoute, undefined, "held-route correction has no settlement authority");
assert.equal(heldFeedback.payload.peer?.kind, "fyi", "held-route correction is private FYI");
assert.doesNotMatch(heldFeedback.payload.text, /@\.name RESULT|RESULT: <结论>/,
  "held-route correction cannot request an immediate replacement RESULT");

const recoverySideEffects: string[] = [];
const recoverableEvent = input("recovery:valid", { result: { body: "done", revision: "r", at: 2 } });
for (const blocked of [
  { ...recoverableEvent, result: undefined },
  { ...recoverableEvent, quiet: true as const },
  { ...recoverableEvent, canceled: true },
  { ...recoverableEvent, interjected: true },
  recoverableEvent,
]) {
  const ownerAllowed = blocked === recoverableEvent ? false : true;
  assert.doesNotThrow(() => runEventFinalRecovery(blocked, () => ownerAllowed, () => {
    recoverySideEffects.push("claim", "start", "item", "close", "bind");
  }));
}
assert.deepEqual(recoverySideEffects, [], "missing result, quiet/canceled/interjected and non-owner recoveries have zero record/claim side effects");
const realTransferFeedback = resultCorrectionInputs(correctionSource, "lead", 0, "rejected",
  routeRow("owner-now", "open"), (x) => x, (name, fyi) => renderPeerEnvelope(name, undefined, undefined,
    fyi ? { act: "fyi", quiet: true } : undefined));
const ownerTail = renderTail(withMsg(realTransferFeedback[1]!.payload.peer!.envelope, realTransferFeedback[1]!.id));
assert.equal(parseEnvelope(ownerTail)?.eventId, realTransferFeedback[1]!.id);
assert.match(ownerTail, /发话方不收回执/);
assert.match(realTransferFeedback[1]!.payload.text, /任务路由 route:task.*来源事件 event:correction.*当前 owner owner-now/);
let unaddressedCorrection = false;
assert.equal(settleUnaddressedResult(correctionSource, routeRow("worker", "open"), true,
  (_source, _row) => { unaddressedCorrection = true; }), true,
"a task-attached correction cannot settle an unaddressed final");
assert.equal(unaddressedCorrection, true, "the production unaddressed-result gate emits corrective feedback");

const dir = mkdtempSync(join(tmpdir(), "wezard-result-binding-"));
try {
  const file = join(dir, "events.json");
  const taskInput = input("route:task-input", { deadline: NO_DEADLINE });
  const unconsumedSupplement = input("route:unconsumed-supplement", {
    execution: "queued", exposure: "none", consumedAt: undefined, inputIds: undefined, deadline: NO_DEADLINE,
  });
  const sourceEvent = input("event:source", { serves: undefined, payload: { text: "result", peer: {
    from: { kind: "peer", from: "lead" }, envelope: "task", kind: "task",
  } } });
  writeFileSync(file, JSON.stringify({ [sourceEvent.id]: sourceEvent, [taskInput.id]: taskInput,
    [unconsumedSupplement.id]: unconsumedSupplement }));
  const router = openRouter({ file: join(dir, "routes.jsonl") });
  router.commit(ops.open({ event: "route:task", owner: "worker", receiver: { kind: "wizard", to: "lead" }, deadlineAt: NO_DEADLINE }));
  const accepted: MessageEvent[] = [];
  const events = createMessageEvents(file, { retain: () => false, accepted: (event) => accepted.push(event) } as unknown as MessageAdapters);
  const firstRenameAccept = events.accept(renamedFeedback[0]!);
  const replayRenameAccept = events.accept(renamedAgain[0]!);
  assert.equal(firstRenameAccept.eventId, replayRenameAccept.eventId,
    "a replay after display-name change accepts the same durable feedback identity");
  events.bindResultRoute(sourceEvent.id, "0:lead", "lead", "route:task", [taskInput.id]);
  events.bindResultRoute(sourceEvent.id, "0:lead", "lead", "route:task", [taskInput.id]);
  assert.throws(() => events.bindResultRoute(sourceEvent.id, "0:lead", "lead", "route:other", [taskInput.id]),
    /binding changed/, "replayed RESULT cannot retarget its frozen binding");
  const stored = JSON.parse(readFileSync(file, "utf8")) as Record<string, MessageEvent>;
  assert.deepEqual(stored[sourceEvent.id]?.resultRoutes?.["0:lead"], {
    receiver: "lead", event: "route:task", inputs: [taskInput.id],
  });
  const inputs = events.consumedTaskInputs("route:task", sourceEvent);
  assert.deepEqual(inputs, [taskInput.id]);
  assert.equal(events.coversTaskInputs("route:task", sourceEvent, inputs), false,
    "the actual event store rejects a RESULT while an unconsumed supplement remains");
  assert.equal(router.get("route:task")?.status, "open",
    "rejected RESULT coverage leaves the actual route ledger open");
  const [feedback] = resultCorrectionInputs(sourceEvent, "lead", 0, "coverage rejected", router.get("route:task"), (x) => x, (x) => x);
  const first = events.accept(feedback!);
  const changedCandidate = { ...router.get("route:task")!, status: "need" as const };
  const [changedFeedback] = resultCorrectionInputs(sourceEvent, "lead", 0, "different rejection reason", changedCandidate, (x) => x, (x) => x);
  const replay = events.accept(changedFeedback!);
  assert.equal(first.eventId, replay.eventId, "replayed correction uses the same durable event id");
  assert.deepEqual(events.ids().filter((id) => id.startsWith("feedback:")).sort(), [first.eventId, firstRenameAccept.eventId].sort(),
    "replaying correction persists only one feedback event");
  assert.equal(accepted[0]?.speaker, "lead", "correction is attributed to the result submitter");
  assert.equal(accepted[0]?.channel, "", "correction remains private");
  assert.equal(accepted[0]?.serves, "route:task", "feedback stays on the original task route");
  assert.equal(canSettleFinal(accepted[0]!), true, "task-attached correction may answer its own route subject to the production RESULT gate");
  assert.equal(accepted[0]?.payload.peer?.tell, undefined, "feedback does not create a new task ledger entry");
  let transferSettled = false;
  const transferNotices: string[] = [];
  settleAddressedResults(sourceEvent, [{ name: "lead", body: "finished" }], {
    binding: () => ({ receiver: "lead", event: "route:task", inputs: [taskInput.id] }),
    resolve: () => "lead",
    select: () => routeRow("owner-now", "open") as never,
    consumed: () => [taskInput.id], bind: () => {}, covers: () => true,
    reject: (event, section, index, reason, row) => resultCorrectionInputs(event, section.name, index, reason, row, (x) => x, (x) => x)
      .forEach((notice) => { transferNotices.push(notice.id); events.accept(notice); }),
    settle: () => { transferSettled = true; },
  });
  assert.equal(transferSettled, false, "a stale executor cannot settle a transferred route after coverage passes");
  assert.equal(transferNotices.length, 2, "production settlement rejection notifies executor and current route owner");
  assert.equal(new Set(transferNotices).size, 2);
  for (const candidate of [
    { ...routeRow("worker", "open"), status: "held" as const },
    { ...routeRow("worker", "answered"), outcome: { status: "canceled" as const, body: "canceled", at: 2, rev: "canceled" } },
  ]) {
    let rejected = false;
    let settled = false;
    settleAddressedResults(sourceEvent, [{ name: "lead", body: "finished" }], {
      binding: () => ({ receiver: "lead", event: candidate.event, inputs: [taskInput.id] }),
      resolve: () => "lead", select: () => candidate as never, consumed: () => [taskInput.id], bind: () => {},
      covers: () => true, reject: () => { rejected = true; }, settle: () => { settled = true; },
    });
    assert.equal(rejected, true, "held and canceled task outcomes are explicitly rejected");
    assert.equal(settled, false);
  }
  const executorFyi = resultCorrectionInputs(sourceEvent, "lead", 0, "reason after transfer", routeRow("owner-now", "open"), (x) => x, (x) => x);
  assert.equal(events.accept(executorFyi[0]!).eventId, first.eventId,
    "changed owner and reason replay the stable executor correction without identity conflict");
  assert.equal(executorFyi[0]?.serves, undefined, "a transferred route correction does not attach the old executor to the moved task");
  assert.equal(events.accept(executorFyi[1]!).eventId, executorFyi[1]?.id,
    "the newly current owner receives its separately keyed FYI");
  const terminalFeedback = resultCorrectionInputs(sourceEvent, "lead", 0, "terminal replay", routeRow("worker", "answered"), (x) => x, (x) => x);
  assert.equal(events.accept(terminalFeedback[0]!).eventId, first.eventId,
    "terminal replay with changed reason remains idempotent");
  const [orphanFeedback] = resultCorrectionInputs(sourceEvent, "missing", 1, "unknown recipient", undefined, (x) => x, (x) => x);
  const orphan = events.accept(orphanFeedback!);
  assert.ok(events.get(orphan.eventId), "unknown recipient without a task still queues corrective feedback");
  assert.equal(events.get(orphan.eventId)?.channel, "");
  assert.equal(events.get(orphan.eventId)?.speaker, "lead", "orphan feedback preserves the result source identity");
  assert.equal(events.get(orphan.eventId)?.payload.peer?.kind, "fyi", "orphan feedback creates no task route");
  assert.equal(router.get("route:task")?.status, "open", "queued correction does not advance the original task");

  const positive = openRouter({ file: join(dir, "positive-routes.jsonl") });
  positive.commit(ops.open({ event: "route:positive", owner: "worker", receiver: { kind: "wizard", to: "lead" }, deadlineAt: NO_DEADLINE }));
  const carrierSource = input("route:positive-result", { result: { body: "@.lead RESULT: done", revision: "positive", at: 20 } });
  const carrierCoverage = taskInputCoverage([original, mergeCarrier, absorbed], "route:task", carrierSource);
  assert.equal(carrierCoverage.complete, true, "the merged carrier with absorbed ids provides complete frozen input coverage");
  positive.onFinal("worker", "route:positive", { text: "RESULT: done", result: true,
    source: { input: carrierSource.id, facts: [JSON.stringify([carrierSource.id, "route:positive", "0:lead", "lead"])] } }).forEach(positive.commit);
  assert.equal(positive.get("route:positive")?.status, "answered", "a valid explicit RESULT commits the route outcome");
} finally {
  rmSync(dir, { recursive: true, force: true });
}

const runtimeMerge = async (kind: "task" | "receipt"): Promise<void> => {
  const root = mkdtempSync(join(tmpdir(), `wezard-runtime-${kind}-`));
  const file = join(root, "events.json");
  const router = openRouter({ file: join(root, "routes.jsonl") });
  router.commit(ops.open({ event: "route:work", owner: "worker", receiver: { kind: "wizard", to: "lead" }, deadlineAt: NO_DEADLINE }));
  let ready = false;
  let allowConsumption = false;
  let allowLateConsumption = false;
  let events!: ReturnType<typeof createMessageEvents>;
  const captured: Array<{ id: string; payload: string; envelope: string; parsed?: ReturnType<typeof parseEnvelope> }> = [];
  const corrections: string[] = [];
  const fact = (id: string) => ({ event: id, batch: "batch-1", version: `v-${id}`, status: "done", receiver: { kind: "wizard" as const, to: "worker" }, body: `answer ${id}`, speaker: "worker", envelope: renderReminder({ wezard: "envelope", kind: "peer", from: "worker", scope: "private" }, []) });
  const base = (id: string, at: number): MessageEvent => ({
    id, target: "worker", speaker: "lead", channel: "", priority: "normal", deadline: NO_DEADLINE,
    payload: { text: `request ${id}`, peer: { from: { kind: "peer", from: "lead" },
      envelope: kind === "task" ? renderPeerEnvelope("lead") : renderReceiptEnvelope("lead", undefined, "done", `turn-${id}`),
      kind, ...(kind === "task" ? { tell: {} as never } : {}) } },
    fingerprint: id, at, execution: "queued", exposure: "none", attempts: 0,
    ...(kind === "task" ? { serves: "route:work" } : { payload: { text: `request ${id}`, receipts: [fact(id)], peer: {
      from: { kind: "peer" as const, from: "lead", receipt: true },
      envelope: renderReceiptEnvelope("lead", undefined, "done", `turn-${id}`), kind: "task" as const,
    } } }),
  });
  const injectedEvidence = new Map<string, { body?: string; revision?: string }>();
  const io = {
    resource: () => "worker-pane", transcript: () => "transcript", sessionId: () => "session",
    ready: async (event: MessageEvent) => ready && !event.id.startsWith("feedback:"), valid: () => true, accepted: () => {}, committed: () => {}, canceled: () => {},
    inject: async (event: MessageEvent, boundary: (phase?: "paste", identity?: { sessionId?: string; transcript?: string }) => boolean) => {
      const p = event.payload.peer!;
      const stamped = renderTail(withMsg(p.envelope, event.id));
      const payload = `${event.payload.text}${stamped}`;
      const parsed = parseEnvelope(payload);
      captured.push({ id: event.id, payload, envelope: stamped, parsed });
      if (kind === "task" && (captured.length === 1 || event.id === "route:next-source" || event.id === "route:retell-source"))
        injectedEvidence.set(event.id, { body: "@.lead RESULT: completed", revision: `rev-${event.id}` });
      boundary("paste", { sessionId: "session", transcript: "transcript" });
      return { ok: true };
    },
    evidence: async (event: MessageEvent) => {
      const found = captured.find((x) => x.id === event.id);
      if (!found || found.parsed?.eventId !== event.id || kind === "task" && (!allowConsumption
        || event.id === "route:late-supplement" && !allowLateConsumption)) return { consumed: false };
      return { consumed: true, ...(injectedEvidence.get(event.id) ?? {}), turn: `turn-${event.id}` };
    },
    recovered: () => {}, send: async () => ({}), error: (error: unknown) => { throw error; },
    retain: () => false,
    ...(kind === "task" ? { task: (event: MessageEvent) => event.serves } : {}),
    resultBindings: (event: MessageEvent) => kind === "task" ? ({ "0:lead": {
      receiver: "lead", event: "route:work", inputs: events.consumedTaskInputs("route:work", event),
    } }) : undefined,
    final: (event: MessageEvent, verdict: { text: string }) => {
      if (kind !== "task") return;
      settleAddressedResults(event, [{ name: "lead", body: verdict.text.split("RESULT: ").at(-1) ?? "" }], {
        binding: (source, key) => events.get(source.id)?.resultRoutes?.[key],
        resolve: () => "lead",
        select: (_source, _receiver, frozen) => frozen?.event ? router.get(frozen.event) : router.task("worker", { kind: "wizard", to: "lead" }),
        consumed: (task, source) => events.consumedTaskInputs(task, source),
        bind: (source, key, receiver, route, inputs) => events.bindResultRoute(source.id, key, receiver, route, inputs),
        covers: (task, source, inputs) => events.coversTaskInputs(task, source, inputs),
        reject: (source, section, index, reason, row) => {
          resultCorrectionInputs(source, section.name, index, reason, row, (x) => x, (x) => x).forEach((input) => {
          corrections.push(input.id);
          events.accept(input);
          });
        },
        settle: (source, section, index, route) => router.onFinal(source.target, route.event, { text: `RESULT: ${section.body}`, result: true,
          source: { input: source.id, facts: [JSON.stringify([source.id, route.event, `${index}:${section.name}`, route.receiver])] } }).forEach(router.commit),
      });
    },
  } as unknown as MessageAdapters;
  events = createMessageEvents(file, io);
  try {
    events.accept(base(kind === "task" ? "route:carrier" : "rcpt:carrier", 1));
    events.accept(base(kind === "task" ? "route:supplement" : "rcpt:supplement", 2));
    events.resume();
    await events.pump();
    assert.equal(captured.length, 0, `${kind} merge waits behind the ready gate`);
    ready = true;
    await events.pump();
    for (let attempt = 0; attempt < 100 && !captured.length; attempt++) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(captured.length, 1, `${kind} inputs are merged into one carrier injection`);
    const carrier = captured[0]!;
    assert.equal(carrier.parsed?.eventId, carrier.id, `${kind} authoritative envelope is stamped with carrier id`);
    assert.equal(carrier.parsed?.from, "lead", "body source envelopes cannot override the carrier sender");
    const storedCarrier = events.get(carrier.id)!;
    const formalCarrierEnvelope = base(carrier.id, 1).payload.peer!.envelope;
    assert.ok(storedCarrier.payload.peer!.envelope.endsWith(formalCarrierEnvelope),
      `${kind} absorb keeps the carrier's formal envelope authoritative after the summary`);
    if (kind === "task") {
      assert.deepEqual(storedCarrier.inputIds, ["route:carrier", "route:supplement"]);
      const late = base("route:late-supplement", 3);
      events.accept(late);
      allowConsumption = true;
      for (let attempt = 0; attempt < 100 && events.get(carrier.id)?.exposure !== "consumed"; attempt++) {
        await events.reconcile(carrier.id);
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.equal(events.get(carrier.id)?.exposure, "consumed", "the submitted carrier becomes consumed only after matching envelope evidence");
      assert.equal(router.get("route:work")?.status, "open", "a late unconsumed supplement rejects the first RESULT");
      assert.equal(corrections.length, 1, "rejected RESULT queues private correction feedback");
      const frozenInputs = events.get(carrier.id)?.resultRoutes?.["0:lead"]?.inputs;
      assert.deepEqual(frozenInputs, ["route:carrier", "route:supplement"]);
      events.result(carrier.id, "@.lead RESULT: completed", "replay-carrier");
      assert.deepEqual(events.get(carrier.id)?.resultRoutes?.["0:lead"]?.inputs, frozenInputs,
        "replaying old source cannot expand its frozen input coverage");
      assert.equal(router.get("route:work")?.status, "open", "old-source replay cannot settle newly consumed work");
      allowLateConsumption = true;
      for (let attempt = 0; attempt < 100 && !captured.some((x) => x.id === late.id); attempt++) await new Promise((resolve) => setTimeout(resolve, 10));
      assert.ok(captured.some((x) => x.id === late.id), "late supplement is independently injected and evidenced");
      for (let attempt = 0; attempt < 100 && events.get(late.id)?.exposure !== "consumed"; attempt++) {
        await events.reconcile(late.id);
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.equal(events.get(late.id)?.exposure, "consumed");
      const next = base("route:next-source", 4);
      events.accept(next);
      for (let attempt = 0; attempt < 100 && !captured.some((x) => x.id === next.id); attempt++) await new Promise((resolve) => setTimeout(resolve, 10));
      assert.ok(captured.some((x) => x.id === next.id), "a new result source is injected after all task inputs");
      await events.reconcile(next.id);
      assert.deepEqual(events.get(next.id)?.resultRoutes?.["0:lead"]?.inputs,
        ["route:carrier", "route:late-supplement", "route:next-source", "route:supplement"]);
      assert.equal(router.get("route:work")?.status, "answered", "new fully covered result traverses event evidence, coverage gate and router commit");
      const priorCorrectionCount = corrections.length;
      events.result(next.id, "@.lead RESULT: completed", "replay-identical-result");
      assert.equal(router.get("route:work")?.status, "answered", "same-source identical settlement replay stays terminal");
      assert.equal(corrections.length, priorCorrectionCount, "successful settlement replay emits no false un-delivered feedback");
      const retell = base("route:retell-source", 5);
      events.accept(retell);
      for (let attempt = 0; attempt < 100 && !captured.some((x) => x.id === retell.id); attempt++) await new Promise((resolve) => setTimeout(resolve, 10));
      await events.reconcile(retell.id);
      assert.equal(events.get(retell.id)?.exposure, "consumed", "new same-task RESULT source is evidenced independently");
      assert.deepEqual(events.get(retell.id)?.resultRoutes?.["0:lead"]?.inputs,
        ["route:carrier", "route:late-supplement", "route:next-source", "route:retell-source", "route:supplement"],
        "new source freezes the consumed input set for the original route");
      assert.deepEqual(events.get(carrier.id)?.resultRoutes?.["0:lead"]?.inputs, frozenInputs,
        "new-source retell does not mutate the old source's frozen inputs");
      events.result(retell.id, "@.lead RESULT: revised conclusion", "retell-new-result");
      assert.equal(router.get("route:work")?.status, "answered", "same-owner explicit RESULT retells the original route");
      assert.equal(router.get("route:work")?.outcome?.body, "RESULT: revised conclusion");
    } else {
      assert.equal(storedCarrier.payload.receipts?.length, 2, "receipt absorb preserves each fact");
      const absorbedId = carrier.id === "rcpt:carrier" ? "rcpt:supplement" : "rcpt:carrier";
      assert.equal(events.exposureOf(absorbedId), undefined, "absorbed receipt bookkeeping is not consumption evidence");
    }
  } finally {
    events.stop();
    rmSync(root, { recursive: true, force: true });
  }
};

await runtimeMerge("task");
await runtimeMerge("receipt");

const chatCorrectionRoot = mkdtempSync(join(tmpdir(), "wezard-chat-result-gate-"));
try {
  const file = join(chatCorrectionRoot, "events.json");
  const chatRouter = openRouter({ file: join(chatCorrectionRoot, "routes.jsonl") });
  chatRouter.commit(ops.open({ event: "route:human", owner: "worker", receiver: { kind: "chat", channel: "user:admin", message: "question" }, deadlineAt: NO_DEADLINE }));
  const consumed = input("route:human-input", { serves: "route:human", exposure: "consumed", execution: "awaiting-result", consumedAt: 10, deadline: NO_DEADLINE });
  const queued = input("route:human-late", { serves: "route:human", exposure: "none", execution: "queued", consumedAt: undefined, deadline: NO_DEADLINE });
  const sourceEvent = input("result:chat-source", { serves: "route:human", deadline: NO_DEADLINE,
    result: { body: "RESULT: answer", revision: "r-chat", at: 20 },
    resultRoutes: { served: { receiver: "user:admin", event: "route:human", inputs: [consumed.id, "result:chat-source"] } } });
  writeFileSync(file, JSON.stringify({ [sourceEvent.id]: sourceEvent, [consumed.id]: consumed, [queued.id]: queued }));
  const events = createMessageEvents(file, { retain: () => false, accepted: () => {} } as unknown as MessageAdapters);
  const frozen = sourceEvent.resultRoutes!.served!.inputs!;
  const covers = (task: string, event: MessageEvent, inputs: readonly string[]) => events.coversTaskInputs(task, event, inputs);
  assert.equal(covers("route:human", sourceEvent, frozen), false, "the served chat route has an unconsumed tell supplement");
  let feedbackCount = 0;
  assert.equal(rejectUncoveredServedChatResult(sourceEvent, chatRouter.get("route:human"), true, frozen, covers, (event, row) => {
    resultCorrectionInputs(event, "served", 0, "coverage rejected", row, (x) => x,
      (name, fyi) => renderPeerEnvelope(name, undefined, undefined, fyi ? { act: "fyi", quiet: true } : undefined))
      .forEach((correction) => { feedbackCount++; events.accept(correction); });
  }), true, "the production chat RESULT gate rejects uncovered content");
  assert.equal(chatRouter.get("route:human")?.status, "open");
  assert.equal(feedbackCount, 1, "chat rejection creates one private correction");
  const correction = events.get("feedback:result:chat-source:0:served")!;
  assert.equal(correction.channel, "");
  assert.equal(correction.serves, undefined, "chat correction cannot auto-settle the human route");
  assert.equal(canSettleFinal({ ...correction, payload: { ...correction.payload } }), true,
    "chat feedback retains explicit private context for its original task");
  assert.deepEqual(correction.feedbackRoute, { event: "route:human", receiver: "user:admin" });
  assert.equal(correction.payload.peer?.kind, "fyi");
  assert.match(correction.payload.text, /对原任务显式提交 RESULT/,
    "chat correction directs completion to the original route with an explicit RESULT");
  const correctionTail = renderTail(withMsg(correction.payload.peer!.envelope, correction.id));
  assert.equal(parseEnvelope(correctionTail)?.eventId, correction.id);
  assert.match(correctionTail, /发话方不收回执/);
  assert.equal(servedChatResultPublicAllowed(sourceEvent, chatRouter.get("route:human"), true, covers), false,
    "the production event final gate suppresses the same uncovered chat RESULT");
  const aliasBound = { ...sourceEvent, resultRoutes: { served: { ...sourceEvent.resultRoutes!.served!, event: "route:merged-alias" } } };
  assert.equal(servedChatResultFinalAllowed(aliasBound, chatRouter.get("route:human"), chatRouter.get("route:human"), true, covers), false,
    "a frozen alias binding still checks coverage against the canonical chat route");
  assert.equal(servedChatResultFinalAllowed(aliasBound, chatRouter.get("route:human"), chatRouter.get("route:human"), true,
    () => true), true, "a valid alias resolves to and checks the canonical route without a false mismatch rejection");
  assert.equal(servedChatResultPublicAllowed({ ...sourceEvent, resultRoutes: undefined }, chatRouter.get("route:human"), true, covers), false,
    "missing explicit chat coverage binding fails closed");
  assert.equal(chatRouter.finalReleased("worker", "route:human", "RESULT: answer", { input: sourceEvent.id }), true,
    "router finalReleased itself remains unchanged; the event publication gate enforces coverage");
  assert.equal(settleUnaddressedResult(correction, chatRouter.get("route:human"), true, () => false), false,
    "text in orphan chat feedback cannot settle the human route");
} finally {
  rmSync(chatCorrectionRoot, { recursive: true, force: true });
}

const chatRecoveryRoot = mkdtempSync(join(tmpdir(), "wezard-chat-feedback-recovery-"));
const chatRecovery = async (): Promise<void> => {
  const file = join(chatRecoveryRoot, "events.json");
  const router = openRouter({ file: join(chatRecoveryRoot, "routes.jsonl") });
  router.commit(ops.open({ event: "route:human-recovery", owner: "worker", receiver: {
    kind: "chat", channel: "user:admin", message: "original request",
  }, deadlineAt: NO_DEADLINE }));
  const captured = new Map<string, { payload: string; parsed: ReturnType<typeof parseEnvelope> }>();
  const corrections: string[] = [];
  let events!: ReturnType<typeof createMessageEvents>;
  const waitFinalized = async (id: string): Promise<void> => {
    for (let attempt = 0; attempt < 100 && !events.get(id)?.finalized; attempt++) {
      await events.pump();
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(events.get(id)?.finalized, true, `${id} passed the production final recovery callback`);
  };
  const waitConsumed = async (id: string): Promise<void> => {
    for (let attempt = 0; attempt < 100 && events.get(id)?.exposure !== "consumed"; attempt++) {
      await events.pump();
      await events.reconcile(id);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(events.get(id)?.exposure, "consumed", `${id} has matching injected-envelope evidence`);
  };
  const io = {
    resource: () => "worker-pane", transcript: () => "transcript", sessionId: () => "session",
    ready: async () => true, valid: () => true, accepted: () => {}, committed: () => {}, canceled: () => {},
    task: (event: MessageEvent) => {
      const id = event.serves ?? event.feedbackRoute?.event;
      return id ? router.get(id)?.event ?? id : undefined;
    },
    inject: async (event: MessageEvent, boundary: (phase?: "paste", identity?: { sessionId?: string; transcript?: string }) => boolean) => {
      const envelope = renderTail(withMsg(event.payload.peer!.envelope, event.id));
      const payload = `${event.payload.text}\n${envelope}`;
      const parsed = parseEnvelope(payload);
      captured.set(event.id, { payload, parsed });
      boundary("paste", { sessionId: "session", transcript: "transcript" });
      return { ok: true };
    },
    evidence: async (event: MessageEvent) => captured.get(event.id)?.parsed?.eventId === event.id
      ? { consumed: true, turn: `turn:${event.id}` } : { consumed: false },
    recovered: (event: MessageEvent) => {
      const current = events.get(event.id)!;
      publishEventFinal(current, (candidate) => {
        const route = candidate.serves ?? candidate.feedbackRoute?.event;
        return !route || router.get(route)?.owner === candidate.target;
      }, (candidate) => {
        const route = candidate.feedbackRoute?.event ?? candidate.serves;
        if (candidate.feedbackRoute && !parseClosingForTest(current.result?.body ?? "")) return false;
        const binding = current.resultRoutes?.served;
        const sourceRow = route ? router.get(route) : undefined;
        const boundRow = binding?.event ? router.get(binding.event) : undefined;
        return servedChatResultFinalAllowed(current, sourceRow, boundRow, parseClosingForTest(current.result?.body ?? ""),
          (task, source, inputs) => events.coversTaskInputs(task, source, inputs))
          && router.finalReleased(candidate.target, route, current.result?.body ?? "", reportSource(current));
      }, (target, turn, channel, published) => events.delivery({ id: `final:${event.id}`, eventId: event.id, target,
        turn, channel, revision: `revision:${event.id}`, body: published.result!.body, chunks: [published.result!.body] }));
    },
    send: async () => ({}), error: (error: unknown) => { throw error; }, retain: () => false,
    resultBindings: (event: MessageEvent, body: string) => {
      const routeEvent = event.serves ?? event.feedbackRoute?.event;
      const row = routeEvent ? router.get(routeEvent) : undefined;
      return parseClosingForTest(body) && row?.receiver.kind === "chat"
        ? { served: { receiver: event.feedbackRoute?.receiver ?? "user:admin", event: row.event,
          inputs: events.consumedTaskInputs(row.event, event) } } : undefined;
    },
    final: (event: MessageEvent, verdict: { text: string }) => {
      const routeEvent = event.serves ?? event.feedbackRoute?.event;
      const row = routeEvent ? router.get(routeEvent) : undefined;
      if (event.feedbackRoute && !parseClosingForTest(verdict.text)) return;
      if (parseClosingForTest(verdict.text) && row?.receiver.kind === "chat") {
        const binding = events.get(event.id)?.resultRoutes?.served;
        const inputs = binding?.inputs ?? events.consumedTaskInputs(row.event, event);
        if (!binding?.inputs) events.bindResultRoute(event.id, "served", event.feedbackRoute?.receiver ?? "user:admin", row.event, inputs);
        if (settleServedChatResult(event, row, true, inputs,
          (task, source, frozen) => events.coversTaskInputs(task, source, frozen),
          (source, candidate, reason) => resultCorrectionInputs(source, "served", 0, reason, candidate,
            (x) => x, (name, fyi) => renderPeerEnvelope(name, undefined, undefined,
              fyi ? { act: "fyi", quiet: true } : undefined)).forEach((feedback) => {
                corrections.push(feedback.id);
                events.accept(feedback);
              }),
          (source, candidate) => router.onFinal(source.target, candidate.event,
            { text: verdict.text, result: true, source: { input: source.id } }).forEach(router.commit))) return;
      }
      if (!event.feedbackRoute && routeEvent) router.onFinal(event.target, routeEvent,
        { text: verdict.text, source: { input: event.id } }).forEach(router.commit);
    },
  } as unknown as MessageAdapters;
  events = createMessageEvents(file, io);
  try {
    events.resume();
    const tell = (id: string): MessageEvent => input(id, { serves: "route:human-recovery", channel: "user:admin", execution: "queued", exposure: "none",
      consumedAt: undefined, result: undefined, resultRoutes: undefined, deadline: NO_DEADLINE,
      payload: { text: `request ${id}`, peer: { from: { kind: "peer", from: "lead" },
        envelope: renderPeerEnvelope("lead"), kind: "task", tell: {} as never } } });
    const source = tell("chat:initial-result");
    events.accept(source);
    await waitConsumed(source.id);
    const supplement = tell("chat:late-supplement");
    events.accept(supplement);
    events.result(source.id, "RESULT: initial", "initial-result");
    await waitFinalized(source.id);
    assert.equal(router.get("route:human-recovery")?.status, "open", "unconsumed chat supplement blocks initial settlement");
    assert.equal(router.finalReleased("worker", "route:human-recovery", "RESULT: initial", { input: source.id }), true,
      "the router's general gate stays unchanged; production publication gate checks the same frozen input coverage");
    const frozenInitial = events.get(source.id)?.resultRoutes?.served?.inputs;
    assert.ok(frozenInitial?.includes(source.id));
    assert.ok(!frozenInitial?.includes(supplement.id));
    assert.equal(servedChatResultPublicAllowed(events.get(source.id)!, router.get("route:human-recovery"), true,
      (task, candidate, inputs) => events.coversTaskInputs(task, candidate, inputs)), false,
      "production final publication gate suppresses the uncovered chat result");
    assert.equal(existsSync(`${file}.finals`), false,
      "coverage rejection creates no public final outbox delivery");
    assert.deepEqual([...new Set(corrections)], [`feedback:${source.id}:0:served`], "replayed rejection queues one idempotent private correction");
    assert.equal(events.ids().filter((id) => id === `feedback:${source.id}:0:served`).length, 1);
    const feedbackId = `feedback:${source.id}:0:served`;
    const feedback = events.get(feedbackId)!;
    assert.equal(feedback.channel, "");
    assert.equal(feedback.serves, undefined, "chat feedback has no route-serving binding");
    assert.equal(feedback.payload.peer?.kind, "fyi");
    assert.deepEqual(feedback.feedbackRoute, { event: "route:human-recovery", receiver: "user:admin" });
    await waitConsumed(feedbackId);
    const feedbackInjection = captured.get(feedbackId)!;
    assert.equal(feedbackInjection.parsed?.eventId, feedbackId, "real FYI envelope survives renderTail and withMsg");
    assert.match(feedbackInjection.payload, /发话方不收回执/);
    assert.match(feedback.payload.text, /对原任务显式提交 RESULT/);
    events.result(feedbackId, "收到，我继续处理", "confirmation");
    await waitFinalized(feedbackId);
    assert.equal(router.get("route:human-recovery")?.status, "open", "ordinary confirmation from feedback cannot settle the chat route");
    assert.equal(existsSync(`${file}.finals`), false, "ordinary confirmation from private feedback creates no public outbox delivery");
    await waitConsumed(supplement.id);
    events.result(feedbackId, "RESULT: recovered on original task", "recovered-result");
    await waitFinalized(feedbackId);
    assert.deepEqual(events.get(feedbackId)?.resultRoutes?.served?.inputs,
      events.consumedTaskInputs("route:human-recovery", events.get(feedbackId)!),
      "new feedback RESULT freezes the now-consumed inputs for the original chat route");
    assert.equal(router.get("route:human-recovery")?.status, "answered", "the production chat RESULT settlement completes the original human route");
    assert.equal(router.get("route:human-recovery")?.outcome?.body, "RESULT: recovered on original task");
    const finals = Object.values(JSON.parse(readFileSync(`${file}.finals`, "utf8"))) as Array<{ channel: string; target: string; eventId?: string }>;
    assert.equal(finals.length, 1, "successful feedback RESULT creates exactly one durable public delivery");
    assert.equal(finals[0]?.channel, "user:admin", "recovered result is sent to the original chat only");
    assert.equal(finals[0]?.target, "worker");
    assert.equal(finals[0]?.eventId, feedbackId);

    router.commit(ops.open({ event: "route:transferred-chat", owner: "worker", receiver: {
      kind: "chat", channel: "user:admin", message: "transferred" }, deadlineAt: NO_DEADLINE }));
    router.commit(ops.move({ event: "route:transferred-chat", owner: "new-owner" }));
    const movedEvent = { ...feedback, id: "feedback:moved", feedbackRoute: { event: "route:transferred-chat", receiver: "user:admin" },
      result: { body: "RESULT: stale", revision: "stale", at: Date.now() } };
    assert.equal(eventFinalPublication(movedEvent, (candidate) => router.get(candidate.feedbackRoute!.event)?.owner === candidate.target,
      (candidate) => router.finalReleased(candidate.target, candidate.feedbackRoute!.event, candidate.result!.body, reportSource(candidate))),
    undefined, "a stale feedback result after ownership transfer creates no public delivery");
    router.commit(ops.open({ event: "route:canceled-chat", owner: "worker", receiver: {
      kind: "chat", channel: "user:admin", message: "canceled" }, deadlineAt: NO_DEADLINE }));
    router.commit(ops.answer({ event: "route:canceled-chat", outcome: { status: "canceled", body: "canceled", at: Date.now(), rev: "canceled" } }));
    const canceledEvent = { ...feedback, id: "feedback:canceled", feedbackRoute: { event: "route:canceled-chat", receiver: "user:admin" },
      result: { body: "RESULT: stale", revision: "stale", at: Date.now() } };
    assert.equal(eventFinalPublication(canceledEvent, () => true,
      (candidate) => router.finalReleased(candidate.target, candidate.feedbackRoute!.event, candidate.result!.body, reportSource(candidate))),
    undefined, "a canceled chat route blocks feedback publication");
  } finally {
    events.stop();
    rmSync(chatRecoveryRoot, { recursive: true, force: true });
  }
};
const parseClosingForTest = (body: string): boolean => /^\s*RESULT\s*:/i.test(body);
await chatRecovery();

const heldFeedbackRoot = mkdtempSync(join(tmpdir(), "wezard-held-correction-ready-"));
const heldRouter = openRouter({ file: join(heldFeedbackRoot, "routes.jsonl") });
heldRouter.commit(ops.open({ event: "route:held-prerequisite", owner: "worker",
  receiver: { kind: "wizard", to: "other" }, deadlineAt: NO_DEADLINE }));
heldRouter.commit(ops.open({ event: "route:held-task", owner: "worker",
  receiver: { kind: "wizard", to: "lead" }, deadlineAt: NO_DEADLINE,
  after: ["route:held-prerequisite"], status: "held" }));
const heldReadyFeedback = resultCorrectionInputs(input("event:held-rejected", { serves: undefined }), "served", 0,
  "任务前置尚未就绪", heldRouter.get("route:held-task"), (x) => x,
  (name, fyi) => renderPeerEnvelope(name, undefined, undefined, fyi ? { act: "fyi", quiet: true } : undefined))[0]!;
assert.equal(heldReadyFeedback.serves, undefined);
let heldEvents!: ReturnType<typeof createMessageEvents>;
let heldInjected = false;
const heldAdapter = {
  resource: () => "worker-pane", transcript: () => "transcript", sessionId: () => "session",
  ready: async (event: MessageEvent) => {
    const route = event.serves ? heldRouter.get(event.serves) : undefined;
    return peerEventPrerequisitesReady(event, route?.status, false, !(event.payload.peer?.after?.length));
  },
  valid: () => true, accepted: () => {}, committed: () => {}, canceled: () => {}, recovered: () => {},
  inject: async (event: MessageEvent, boundary: (phase?: "paste", identity?: { sessionId?: string; transcript?: string }) => boolean) => {
    const captured = `${event.payload.text}\n${renderTail(withMsg(event.payload.peer!.envelope, event.id))}`;
    heldInjected = parseEnvelope(captured)?.eventId === event.id;
    boundary("paste", { sessionId: "session", transcript: "transcript" });
    return { ok: true };
  },
  evidence: async (event: MessageEvent) => heldInjected && event.serves === undefined
    ? { consumed: true, turn: `turn:${event.id}` } : { consumed: false },
  send: async () => ({}), error: (error: unknown) => { throw error; }, retain: () => false,
} as unknown as MessageAdapters;
heldEvents = createMessageEvents(join(heldFeedbackRoot, "events.json"), heldAdapter);
try {
  heldEvents.resume();
  heldEvents.accept(heldReadyFeedback);
  for (let attempt = 0; attempt < 100 && heldEvents.get(heldReadyFeedback.id)?.exposure !== "consumed"; attempt++) {
    await heldEvents.pump();
    await heldEvents.reconcile(heldReadyFeedback.id);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(heldInjected, true, "the true event pump reaches the private held correction through the route prerequisite gate");
  assert.equal(heldEvents.get(heldReadyFeedback.id)?.exposure, "consumed");
  assert.equal(heldRouter.get("route:held-task")?.status, "held", "feedback delivery does not release the original held task");
} finally {
  heldEvents.stop();
  rmSync(heldFeedbackRoot, { recursive: true, force: true });
}

const cancelSendRoot = mkdtempSync(join(tmpdir(), "wezard-feedback-send-cancel-"));
const cancelSendRouter = openRouter({ file: join(cancelSendRoot, "routes.jsonl") });
cancelSendRouter.commit(ops.open({ event: "route:cancel-before-send", owner: "worker",
  receiver: { kind: "chat", channel: "user:admin", message: "human task" }, deadlineAt: NO_DEADLINE }));
const pendingFeedback = input("feedback:pending-send", { serves: undefined, channel: "", feedbackRoute: {
  event: "route:cancel-before-send", receiver: "user:admin" }, execution: "complete", exposure: "consumed",
  consumedAt: 10, finalized: true, result: { body: "RESULT: stale", revision: "stale", at: 20 },
  payload: { text: "private result", peer: { from: { kind: "peer", from: "lead" },
    envelope: renderPeerEnvelope("lead", undefined, undefined, { act: "fyi", quiet: true }), kind: "fyi" } } });
const cancelEventsFile = join(cancelSendRoot, "events.json");
writeFileSync(cancelEventsFile, JSON.stringify({ [pendingFeedback.id]: pendingFeedback }));
let cancelEvents!: ReturnType<typeof createMessageEvents>;
let sendAttempts = 0;
let transportSends = 0;
const cancelAdapters = {
  resource: () => "worker-pane", transcript: () => "transcript", sessionId: () => "session",
  ready: async () => true, valid: () => true, accepted: () => {}, committed: () => {}, canceled: () => {},
  inject: async () => ({ ok: true }), evidence: async () => ({ consumed: false }), recovered: () => {},
  deliveryEvidence: () => undefined,
  send: async (delivery: { target: string; eventId?: string; purpose?: "progress" | "report" | "cancellation" | "task" }) => {
    sendAttempts++;
    const authority = delivery.eventId ? cancelEvents.authorityOf(delivery.eventId) : undefined;
    const routeId = authority?.serves ?? authority?.feedbackRoute?.event;
    const row = routeId ? cancelSendRouter.get(routeId) : undefined;
    const allowed = eventDeliveryAllowed(authority, delivery.target, delivery.eventId, delivery.purpose,
      (event) => cancelSendRouter.get(event.serves ?? event.feedbackRoute?.event ?? "")?.owner === event.target, row);
    if (!allowed) return { failed: "delivery authority withdrawn before transport" };
    transportSends++;
    return { ack: "sent" };
  },
  error: (error: unknown) => { throw error; }, retain: () => false,
} as unknown as MessageAdapters;
cancelEvents = createMessageEvents(cancelEventsFile, cancelAdapters);
try {
  cancelEvents.delivery({ id: "final:pending-feedback", eventId: pendingFeedback.id, target: "worker", turn: "turn:feedback",
    channel: "user:admin", revision: "final-revision", body: "stale result", chunks: ["stale result"] });
  cancelSendRouter.commit(ops.answer({ event: "route:cancel-before-send", outcome: {
    status: "canceled", body: "human task canceled", at: 30, rev: "canceled" } }));
  cancelEvents.resume();
  for (let attempt = 0; attempt < 100 && cancelEvents.deliveryStatus("final:pending-feedback")?.[0] !== "failed"; attempt++) {
    await cancelEvents.pump();
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(sendAttempts, 1, "persisted feedback final reaches the real send adapter after route cancellation");
  assert.equal(transportSends, 0, "send-boundary authority check withholds the stale original-chat result");
  assert.deepEqual(cancelEvents.deliveryStatus("final:pending-feedback"), ["failed"]);
} finally {
  cancelEvents.stop();
  rmSync(cancelSendRoot, { recursive: true, force: true });
}

console.log("RESULT task input coverage regressions passed");
