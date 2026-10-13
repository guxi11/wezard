import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { renderHumanEnvelope, renderPeerEnvelope, renderReceiptEnvelope, replyToPeer, replyClosedBefore } from "../daemon/peers.js";
import { envelopeAttrs, parseEnvelope, parseReminders, renderReminder, askerFromEnvelope } from "../shared/reminder.js";
import { createReceipts, type Slot, type ReceiptMeta } from "../daemon/receipts.js";
import { loadJsonMap } from "../shared/json-map-store.js";

const dir = mkdtempSync(join(tmpdir(), "reply-routing-"));
const path = join(dir, "transcript.jsonl");
const at = Date.now() - 60_000;
const rows: object[] = [];
const add = (role: "user" | "assistant", content: string) => {
  rows.push({ type: role, timestamp: new Date(at + rows.length * 1000).toISOString(), message: { role, content } });
  writeFileSync(path, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
};
const ask = (turn: string) => add("user", `work ${turn}` + renderPeerEnvelope(".root", undefined, { turn }));
const relay = (turn: string, k?: string, replyTo = ".root") => add("user", "child result" + renderReceiptEnvelope(".child", undefined, undefined, "done", turn, { replyTo, ...(k ? { k } : {}) }));
const reply = (turn?: string, since = at) => replyToPeer(path, ".root", since, [], turn)?.text;

// A human envelope needs facts, not a prose instruction to select the channel.
const human = renderHumanEnvelope("alice", "renamed display", "chat:original");
assert.equal(parseReminders(human)[0]!.body, "");
assert.deepEqual(askerFromEnvelope(parseEnvelope(human)!, () => "wrong-home"), { who: "user:alice", chat: "chat:original" });
assert.equal(parseEnvelope(renderHumanEnvelope("alice", "legacy chat"))?.chat, "legacy chat");
const quoted = renderHumanEnvelope("wrong", "wrong");
assert.equal(parseEnvelope(quoted + human)?.from, "alice", "authoritative appended envelope wins");
const receipt = renderReceiptEnvelope(".child", undefined, { job: "job", done: 1, total: 2 }, "need", "child", {
  replyTo: "group", k: "chat:human-A:chat:original", audience: "alice", asker: { who: "user:alice", chat: "chat:original" },
});
assert.deepEqual(parseEnvelope(receipt), {
  kind: "peer", from: ".child", private: true, chat: "", receipt: true, status: "need", turn: "child",
  replyTo: "group", k: "chat:human-A:chat:original", audience: "alice", asker: { who: "user:alice", chat: "chat:original" },
});
assert.equal(parseReminders(receipt)[0]!.attrs.complete, "0");

// quiet is durable transcript data, orthogonal to audience and authorization.
for (const chat of [undefined, "public group"]) {
  const text = renderPeerEnvelope(".root", chat, { turn: "quiet", quiet: true, re: true, deadline: at, asker: { who: "user:alice", chat: "chat:original" } });
  const e = parseEnvelope(text)!;
  assert.equal(e.quiet, true);
  assert.equal(e.private, chat === undefined);
  assert.equal(e.re, "quiet");
  assert.equal(e.asker?.who, "user:alice");
  assert.equal(parseReminders(text)[0]!.attrs.deadline, new Date(at).toISOString());
  assert.doesNotMatch(text, /会自动把结论送回/);
}
assert.equal(envelopeAttrs.peer(".root", undefined, { turn: "fyi", act: "fyi" }).quiet, "1");
assert.equal(parseEnvelope(renderReminder({ wezard: "envelope", kind: "peer", from: ".root", act: "fyi", turn: "old-fyi" }, []))?.quiet, true, "old fyi attrs already express no receipt");
assert.equal(parseEnvelope(renderPeerEnvelope(".root", undefined, { turn: "normal" }))?.quiet, undefined);

ask("A"); add("assistant", "RESULT: direct A");
ask("B"); add("assistant", "RESULT: direct B");
relay("child-A", "peer:A:user:admin#root"); add("assistant", "RESULT: relayed A");
relay("child-B", "peer:B:user:admin#root"); add("assistant", "RESULT: relayed B");
assert.equal(reply("A"), "RESULT: relayed A", "later receipt to same name belongs to another parent turn");
assert.equal(reply("B"), "RESULT: relayed B");
assert.equal(reply("missing"), undefined, "reply-to name cannot invent an unobserved task");
assert.equal(replyClosedBefore(path, ".root", at, at + 100_000, [], "A"), "RESULT: relayed A");
assert.equal(replyClosedBefore(path, ".root", at, at + 100_000, [], "B"), "", "handoff only carries a closed matching round");

for (const k of [undefined, "peer:AB:user:admin#root", "chat:A:chat:original", "peer:A:", "malformed"]) {
  relay("not-A", k); add("assistant", "WRONG receipt");
  assert.equal(reply("A"), "RESULT: relayed A", `reject unrelated/missing parent k: ${k}`);
}
relay("child-other-name", "peer:A:user:admin#other", ".other"); add("assistant", "WRONG audience");
assert.equal(reply("A"), "RESULT: relayed A");
// The relay anchor may have moved past the original ask before restart.
assert.equal(reply("A", at + 4500), "RESULT: relayed A");

add("user", "quiet continuation" + renderPeerEnvelope(".root", undefined, { turn: "A", re: true, quiet: true }));
add("assistant", "QUIET ACK must not become a receipt");
assert.equal(reply("A"), "RESULT: relayed A", "receipt:false continuation cannot replace a watched task");
add("user", "FYI" + renderPeerEnvelope(".root", undefined, { turn: "fyi-only", act: "fyi" }));
add("assistant", "FYI ACK");
assert.equal(reply("fyi-only"), undefined);

// Legacy callers without an original turn retain name-based relay lookup.
relay("legacy-child"); add("assistant", "RESULT: legacy relay");
assert.equal(reply(), "RESULT: legacy relay");
assert.equal(reply("A"), "RESULT: relayed A", "legacy receipt with unknown parent cannot override a known turn");
add("user", "old ask" + renderReminder({}, ["这一轮是 wizard `.legacy` 发来的**私聊**"]));
add("assistant", "RESULT: legacy direct");
assert.equal(replyToPeer(path, ".legacy", at, [], "pre-attrs-task")?.text, "RESULT: legacy direct");
assert.equal(parseEnvelope(renderReminder({}, ["这一轮是 `alice` 在群 **旧群** 里说的"]))?.kind, "human");

// Re-open the on-disk receipt store and consume the persisted original turn.
// The newer B/quiet/legacy rows above must not change A's post-restart answer.
const file = join(dir, "receipts.json");
loadJsonMap<Slot>(file).set("root\0worker", {
  from: "root", to: "worker", turn: "A", channel: "", job: "", at,
  gen: 1, claimed: false, resolved: false, delivered: false,
  k: { kind: "chat", channel: "chat:original", turn: "human-A" },
  asker: { who: "user:alice", chat: "chat:original" },
});
const sent: { to: string; body: string; meta: ReceiptMeta }[] = [];
const deps = {
  log: pino({ level: "silent" }), nameOf: (s: string) => `.${s}`,
  idleNow: async () => true, untilIdle: async () => ({ idle: true }), paneLive: async () => true,
  replyFor: (_to: string, name: string, since: number, turn?: string) => replyToPeer(path, name, since, [], turn),
  deliver: async (to: string, body: string, meta: ReceiptMeta) => { sent.push({ to, body, meta }); return { ok: true }; },
};
createReceipts({ ...deps, store: loadJsonMap<Slot>(file) }).resume();
for (let n = 0; n < 100 && sent.length === 0; n++) await new Promise((resolve) => setTimeout(resolve, 5));
assert.equal(sent.length, 1);
assert.equal(sent[0]!.to, "root");
assert.equal(sent[0]!.body, "RESULT: relayed A");
assert.equal(sent[0]!.meta.channel, "chat:original");
assert.deepEqual(sent[0]!.meta.replyTo, { kind: "chat", channel: "chat:original", turn: "human-A" });
assert.equal(sent[0]!.meta.asker?.who, "user:alice");
await new Promise((resolve) => setTimeout(resolve, 5));
createReceipts({ ...deps, store: loadJsonMap<Slot>(file) }).resume();
await new Promise((resolve) => setTimeout(resolve, 10));
assert.equal(sent.length, 1, "a second restart does not resend settled output");
console.log("reply routing: audience facts, quiet, parallel parent turns, legacy and persisted receipt restart passed");
