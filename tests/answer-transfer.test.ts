import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { answerRecoveryAction, answerSourceLost, answerTargetOccupied, answerTransferOrigin, createAnswerTransfers, type AnswerTransfer } from "../daemon/answer-transfer.js";
import { loadJsonMap } from "../shared/json-map-store.js";
import { createReceipts, type Outcome, type Slot } from "../daemon/receipts.js";
import { ConfigSchema } from "../shared/config.js";
import { chatPolicyOf } from "../daemon/chat-name.js";
import { renderCharter, type CharterArgs } from "../daemon/wizard.js";

const dir = mkdtempSync(join(tmpdir(), "answer-transfer-"));
const file = join(dir, "answers.json");
const row: AnswerTransfer = { id: "tOne", source: "router", target: "worker", sourceTurn: "human", sourceOpening: 123, origin: "chat:123:chat:group", channel: "chat:group", prefix: "existing stream", state: "reserved", tell: { from: "router", to: "worker", turn: "tOne", channel: "", at: Date.now(), answerTransfer: "tOne" } };
let a = createAnswerTransfers(loadJsonMap(file, undefined, { strict: true }));
a.reserve(row);
assert.throws(() => a.reserve({ ...row, id: "tTwo", target: "other" }), /already transferred/);
assert.throws(() => a.reserve({ ...row, id: "tThree", origin: "another human" }), /in flight/);
assert.equal(a.source("router", "human"), true);
a.rollback(row.id);
assert.equal(a.source("router", "human"), false);
a.reserve(row); a.activate(row.id); a.rollback(row.id);
assert.equal(a.get(row.id)?.state, "active", "committed ownership cannot roll back");
a.prefix(row.id, "latest visible progress");
a = createAnswerTransfers(loadJsonMap(file, undefined, { strict: true }));
assert.equal(a.get(row.id)?.prefix, "latest visible progress", "latest taken stream prefix survives reload");
assert.equal(answerTransferOrigin("router-A", "turn"), answerTransferOrigin("router-A", "turn"));
assert.notEqual(answerTransferOrigin("router-A", "turn"), answerTransferOrigin("router-B", "turn"), "different sources cannot collide at the same millisecond");
assert.equal(answerSourceLost([row], "router", "human", 123), true);
assert.equal(answerSourceLost([row], "router", "new-human", 123), false, "same-millisecond next turn retains source ownership");
assert.equal(answerTargetOccupied({ ...row, state: "uncertain" }), false, "ambiguous settled delivery releases target for new work");
a.outcome(row.id, { status: "timeout", body: "timed out" });
assert.equal(a.outcome(row.id, { status: "done", body: "late answer" })?.outcome?.status, "timeout", "late answer cannot replace terminal outcome");
a.delivering(row.id); a.delivered(row.id);
assert.equal(a.outcome(row.id, { status: "done", body: "duplicate" }), undefined);
assert.equal(answerRecoveryAction({ ...row, state: "delivering", outcome: { status: "done", body: "sent" } }), "ambiguous");
assert.equal(answerRecoveryAction({ ...row, state: "active", outcome: { status: "done", body: "not attempted" } }), "deliver-outcome");
assert.equal(answerRecoveryAction({ ...row, state: "uncertain", outcome: { status: "done", body: "possibly sent" } }), "settled");
assert.equal(a.delivering(row.id), false, "a settled transfer can never begin another external delivery");
assert.throws(() => a.reserve({ ...row, id: "tFour", target: "other" }), /already transferred/, "human ownership stays exclusive after delivery");

const recoveryRow = { ...row, id: "tCrash", state: "active" as const, outcome: { status: "done" as const, body: "answer" } };
const recoveryStore = loadJsonMap<AnswerTransfer>(join(dir, "recovery.json"), undefined, { strict: true });
const recovery = createAnswerTransfers(recoveryStore); recovery.reserve(recoveryRow); recovery.delivering(recoveryRow.id);
const afterAckCrash = createAnswerTransfers(loadJsonMap<AnswerTransfer>(join(dir, "recovery.json"), undefined, { strict: true }));
assert.equal(answerRecoveryAction(afterAckCrash.get(recoveryRow.id)!), "ambiguous");
afterAckCrash.uncertain(recoveryRow.id);
assert.equal(answerRecoveryAction(afterAckCrash.get(recoveryRow.id)!), "settled", "restart after external ACK never retries automatically");

const cfg = (policies?: Record<string, unknown>) => ConfigSchema.parse({ bot: { botId: "test", secret: "test" }, chats: { wezard: "user:admin", other: "chat:other" }, ...(policies ? { chatPolicy: policies } : {}) });
assert.equal(cfg().chatPolicy.wezard?.topOnly, true);
assert.equal(chatPolicyOf(cfg(), "user:admin#child").topOnly, true);
assert.equal(chatPolicyOf(cfg({}), "user:admin").topOnly, true);
assert.equal(chatPolicyOf(cfg({ wezard: { topOnly: false } }), "user:admin").topOnly, false);
assert.equal(chatPolicyOf(cfg({ "user:admin": { topOnly: false } }), "user:admin").topOnly, false);
assert.equal(chatPolicyOf(cfg(), "chat:other").topOnly, false);
assert.equal(chatPolicyOf(cfg(), "chat:wx_test").topOnly, true);
const charter: CharterArgs = { self: { name: "wezard", address: "wezard", description: "", cwd: dir }, chat: "wezard", principal: "user:admin", inherited: false, cwdUnconfirmed: false, siblings: [], memory: [], chatMemory: "", workspaceMemory: "", steward: true, stewardBudget: 4, lead: false, tiers: [], topOnly: true };
assert.match(renderCharter(charter), /我是这个群的管家/);
assert.match(renderCharter(charter), /answer:"transfer"/);
assert.doesNotMatch(renderCharter({ ...charter, topOnly: false }), /我是这个群的管家|不亲手干活|守护进程替你守着/);
assert.doesNotMatch(renderCharter({ ...charter, steward: false }), /我是这个群的管家/);

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 5));
const awaitEvent = async (f: () => boolean) => { for (let i = 0; i < 100 && !f(); i++) await tick(); assert(f(), "receipt completion missing"); };
for (const status of ["done", "need", "error", "timeout", "canceled", "dead", "silent"] as const) {
  const sent: Outcome[] = [];
  const injected: string[] = [];
  const sfile = join(dir, `${status}.json`);
  const store = loadJsonMap<Slot>(sfile);
  const deps = { log: pino({ level: "silent" }), idleNow: async () => true, untilIdle: async () => ({ idle: true }), paneLive: async () => true,
    replyFor: () => ({ text: status === "need" ? "NEED: which value?" : "answer", ...(status === "error" ? { error: true } : {}) }),
    deliver: async () => { injected.push("sender"); return { ok: true }; }, nameOf: (x: string) => x, store,
    deliverAnswer: async (_id: string, out: Outcome) => { sent.push(out); return true; } };
  const receipts = createReceipts(deps);
  const told = { ...row.tell, at: Date.now(), ...(status === "timeout" ? { deadlineAt: Date.now() - 1 } : {}) };
  if (["canceled", "dead", "silent"].includes(status)) {
    const key = "router\0worker";
    store.set(key, { ...told, job: "", at: Date.now(), gen: 1, claimed: false, resolved: false, delivered: false, outcome: { status, body: "interrupted" } });
    createReceipts(deps).resume();
  } else receipts.register(told);
  await awaitEvent(() => sent.length === 1);
  assert.equal(sent[0]?.status, status);
  if (["timeout", "canceled", "dead", "silent"].includes(status)) {
    assert.doesNotMatch(sent[0]?.body ?? "", /OTHER_HUMAN_PRIVATE_ANSWER/, "transfer failure cannot quote another turn's time-only transcript tail");
  }
  assert.deepEqual(injected, [], "transferred answer never wakes sender");
  createReceipts(deps).resume(); await tick();
  assert.equal(sent.length, 1, "receipt restart does not repeat already settled delivery");
}
for (const ending of ["timeout", "interrupt"] as const) {
  const sent: Outcome[] = [];
  const now = Date.now();
  const deps = { log: pino({ level: "silent" }), idleNow: async () => true,
    untilIdle: async () => ({ idle: true }), paneLive: async () => true,
    replyFor: (_to: string, _from: string, _since: number, turn?: string) => turn === "human-A" ? undefined : { text: "WRONG TURN" },
    lastWords: () => "OTHER_HUMAN_PRIVATE_ANSWER",
    deliver: async () => ({ ok: true }), nameOf: (x: string) => x,
    deliverAnswer: async (_id: string, out: Outcome) => { sent.push(out); return true; } };
  const r = createReceipts(deps);
  const transfer = { ...row.tell, turn: "human-A", answerTransfer: `transfer-${ending}`, at: now,
    ...(ending === "timeout" ? { deadlineAt: now - 1 } : {}) };
  r.register(transfer);
  if (ending === "interrupt") assert.equal(r.cancel("worker", "router", (s) => s.turn === "human-A"), 1);
  await awaitEvent(() => sent.length === 1);
  assert.equal(sent[0]?.status, ending === "timeout" ? "timeout" : "canceled");
  assert.doesNotMatch(sent[0]?.body ?? "", /OTHER_HUMAN_PRIVATE_ANSWER|WRONG TURN/, `${ending} only uses a reply bound to human-A, never the target's other turn`);
}
{
  const sent: Outcome[] = [];
  const r = createReceipts({ log: pino({ level: "silent" }), idleNow: async () => false,
    untilIdle: async () => ({ idle: false }), paneLive: async () => true, replyFor: () => undefined,
    deliver: async () => { assert.fail("interrupt must not wake source"); }, nameOf: (x) => x,
    deliverAnswer: async (_id, out) => { sent.push(out); return true; } });
  r.register(row.tell);
  assert.equal(r.claim("router", "worker"), false, "wait_peer cannot steal transferred ownership");
  assert.equal(r.cancel("worker", "router"), 1, "source interrupt still delivers a human terminal explanation");
  await awaitEvent(() => sent.length === 1);
  assert.equal(sent[0]?.status, "canceled");
  r.cancel("worker", "router"); await tick();
  assert.equal(sent.length, 1);
}
console.log("answer transfer: persistent ownership, terminal immutability, config/prompt, receipt direct delivery and restart passed");
