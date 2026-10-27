import assert from "node:assert/strict";
import { EMPTY, finalReleased, onFinal, ops, step } from "../daemon/router.js";

const opened = step(EMPTY, ops.open({
  event: "receipt-facts",
  owner: "owner",
  receiver: { kind: "chat", channel: "chat:test", message: "message-1" },
  at: 1,
  deadlineAt: 100,
}));
const source = { input: "execution-1", facts: ["fact-b", "fact-a", "fact-a"] };
const first = onFinal(opened, "owner", "receipt-facts", {
  text: "RESULT: first facts",
  result: true,
  source,
});
assert.equal(first.length, 1);
assert.equal(first[0]?.op, "answer");
if (first[0]?.op !== "answer") throw new Error("expected an answer op");
assert.deepEqual(first[0].outcome.report?.source, source, "FinalVerdict.source is preserved in the report");

const settled = step(opened, first[0]);
assert.equal(finalReleased(settled, "owner", "receipt-facts", "RESULT: first facts", source), true);
assert.equal(finalReleased(settled, "owner", "receipt-facts", "RESULT: first facts", { input: "execution-2" }), false,
  "released reports must match the source input that produced the outcome");
assert.deepEqual(onFinal(settled, "owner", "receipt-facts", {
  text: "RESULT: reordered duplicate facts",
  result: true,
  source: { input: "execution-2", facts: ["fact-a", "fact-b"] },
}), [], "same receipt facts deduplicate independent of order, duplicates and input id");

const addedFact = onFinal(settled, "owner", "receipt-facts", {
  text: "RESULT: added fact",
  result: true,
  source: { input: "execution-2", facts: ["fact-a", "fact-b", "fact-c"] },
});
assert.equal(addedFact.length, 1, "a newly covered fact creates a new report");
if (addedFact[0]?.op !== "answer") throw new Error("expected a new answer op");
assert.equal(addedFact[0].outcome.report?.source.facts?.includes("fact-c"), true);
console.log("Router core source: stable verdict source and receipt-facts deduplication passed");
