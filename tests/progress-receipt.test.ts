import assert from "node:assert/strict";
import { EMPTY, finalReleased, onFinal, ops, step, parseOp, foldJournal, type Table } from "../daemon/router.js";
import { parseClosing, stripClosingMark, renderReceiptEnvelope } from "../daemon/peers.js";
import { isTerminal } from "../shared/turn-state.js";
import { parseEnvelope } from "../shared/reminder.js";

// ── 标记解析: PROGRESS 与 NEED/RESULT 同一张桌子, 最后一个有效标记说了算 ──────────
assert.equal(parseClosing("PROGRESS: 阶段一完成, 开始阶段二").kind, "progress");
assert.equal(parseClosing("PROGRESS: 阶段一完成").text, "阶段一完成");
// 小写不认 (与 NEED 同一理由: 普通答话里太常见)
assert.equal(parseClosing("progress: 阶段一完成").kind, "none");
// 无效正文 (无/空) 的 PROGRESS 不算标记
assert.equal(parseClosing("PROGRESS: 无").kind, "none");
// 最后一个有效标记决定收口: RESULT 在前 PROGRESS 在后 → progress; 反之 → result
assert.equal(parseClosing("RESULT: 完成了\nPROGRESS: 还在跑回归").kind, "progress");
assert.equal(parseClosing("PROGRESS: 阶段一完成\nRESULT: 全部完成").kind, "result");
// NEED 与 PROGRESS 共存: 后者胜
assert.equal(parseClosing("NEED: 要密码\nPROGRESS: 先跑能跑的").kind, "progress");
// ARTIFACT 清单照旧; 正文不含 ARTIFACT 行
const withArt = parseClosing("PROGRESS: 阶段一完成\nARTIFACT: /tmp/x.md — 说明");
assert.equal(withArt.kind, "progress");
assert.equal(withArt.text, "阶段一完成");
assert.deepEqual(withArt.artifacts, [{ path: "/tmp/x.md", note: "说明" }]);
// 投递出口剥行首标记
assert.equal(stripClosingMark("PROGRESS: 阶段一完成"), "阶段一完成");

// ── 终态词表: progress 不是 Terminal (不得触发 hand/settle) ─────────────────────
assert.equal(isTerminal("progress"), false);
assert.equal(isTerminal("need"), false);
assert.equal(isTerminal("done"), true);

// ── onFinal: 显式 PROGRESS → mark progress, 行不落定 ─────────────────────────
const openRow = step(EMPTY, ops.open({
  event: "e1", owner: "worker", receiver: { kind: "wizard", to: "lead", event: "e0" },
  at: 1, deadlineAt: Number.MAX_SAFE_INTEGER,
}));
const src = { input: "exec-1", facts: ["f1"] };
const marks = onFinal(openRow, "worker", "e1", { text: "PROGRESS: 阶段一完成", source: src });
assert.equal(marks.length, 1, "explicit PROGRESS produces one op");
assert.equal(marks[0]?.op, "mark");
if (marks[0]?.op !== "mark") throw new Error("expected a mark op");
assert.equal(marks[0].status, "progress");
assert.equal(marks[0].body, "PROGRESS: 阶段一完成");
const rev1 = marks[0].rev!;
assert.ok(rev1, "mark carries the report rev (rcpt:<event>:<rev> idempotency half)");

// step: 行状态不动 (open 还在 open), notice/reports 记上
const progressed = step(openRow, marks[0]);
const row1 = (progressed as Table)["e1"]!;
assert.equal(row1.status, "open", "progress mark does not change row status");
assert.equal(row1.notice?.status, "progress");
assert.equal(row1.notice?.rev, rev1);
assert.ok(row1.reports?.[rev1], "report recorded under its rev");

// rev 判重: 同文同源重放 = 无 op; 换正文 = 新 rev
assert.deepEqual(onFinal(progressed, "worker", "e1", { text: "PROGRESS: 阶段一完成", source: src }), [],
  "same progress text replays to no op");
const marks2 = onFinal(progressed, "worker", "e1", { text: "PROGRESS: 阶段二完成", source: src });
assert.equal(marks2.length, 1);
assert.notEqual(marks2[0]?.rev, rev1, "new content gets a new rev");

// need 状态的行上 PROGRESS: 状态仍是 need (在等 re 的还在等)
const needRow = step(openRow, ops.mark({ event: "e1", status: "need", body: "NEED: 要密码", rev: "r-need", at: 2 }));
const progOnNeed = step(needRow, onFinal(needRow, "worker", "e1", { text: "PROGRESS: 先跑能跑的", source: src })[0]!);
assert.equal((progOnNeed as Table)["e1"]!.status, "need", "progress on a need row keeps need");

// 已落定的行不收 PROGRESS (追述只认 RESULT)
const answered = step(openRow, onFinal(openRow, "worker", "e1", { text: "RESULT: 完成", result: true, source: src })[0]!);
const answeredRow = step(answered, onFinal(answered, "worker", "e1", { text: "RESULT: 完成", result: true, source: src })[0] ?? { op: "row", at: 3, event: "e1", owner: "worker", receiver: { kind: "wizard", to: "lead", event: "e0" }, status: "answered", deadlineAt: Number.MAX_SAFE_INTEGER, seq: 0 } as never);
assert.deepEqual(onFinal(answeredRow, "worker", "e1", { text: "PROGRESS: 又动了动", source: { input: "exec-2" } }), [],
  "no progress marks on a settled row");

// ── journal 往返: mark progress 落盘可重放, parseOp 认这档 ────────────────────
const line = JSON.stringify(marks[0]);
const parsed = parseOp(line);
assert.ok(parsed, "parseOp accepts a progress mark op");
const folded = foldJournal(`${JSON.stringify(ops.open({ event: "e1", owner: "worker", receiver: { kind: "wizard", to: "lead", event: "e0" }, at: 1, deadlineAt: Number.MAX_SAFE_INTEGER }))}\n${line}\n`);
assert.equal((folded.table as Table)["e1"]!.status, "open", "journal replay keeps the row in flight");

// ── 回归: 未标记终句的零投递、RESULT 落定, 前后行为一致 ───────────────────────
assert.deepEqual(onFinal(openRow, "worker", "e1", { text: "好的我开始了", source: src }), [],
  "unmarked final on a wizard-receiver row still delivers nothing");
const done = onFinal(openRow, "worker", "e1", { text: "RESULT: 完成", result: true, source: src });
assert.equal(done[0]?.op, "answer", "RESULT still settles");
const chatRow = step(EMPTY, ops.open({
  event: "e2", owner: "worker", receiver: { kind: "chat", channel: "chat:test", message: "m1" },
  at: 1, deadlineAt: Number.MAX_SAFE_INTEGER,
}));
assert.equal(onFinal(chatRow, "worker", "e2", { text: "干完了", source: src })[0]?.op, "answer",
  "unmarked chat final without children still settles (done)");
const chatProg = onFinal(chatRow, "worker", "e2", { text: "PROGRESS: 阶段一完成", source: src });
assert.equal(chatProg[0]?.op, "mark", "explicit PROGRESS on a chat root keeps the row open");
assert.equal(chatProg[0]?.status, "progress");
assert.equal((step(chatRow, chatProg[0]!) as Table)["e2"]!.status, "open");
// finalReleased: 既有形状不受影响 (wizard 在飞行: 只放 result/need; chat 在飞行无子行: 放)
assert.equal(finalReleased(openRow, "worker", "e1", "好的我开始了", src), false);
assert.equal(finalReleased(openRow, "worker", "e1", "NEED: 要密码", src), true);
assert.equal(finalReleased(chatRow, "worker", "e2", "干完了", src), true);
assert.equal(finalReleased(chatRow, "worker", "e2", "PROGRESS: 阶段一完成", src), true,
  "chat row without waiting children still releases the turn-end bubble");

// ── 回执信封: status=progress 渲染与读回 ─────────────────────────────────────
const env = renderReceiptEnvelope(".worker", undefined, "progress", "e1");
assert.ok(env.includes("进展回执"), "envelope body explains the progress receipt");
assert.ok(env.includes("任务还没落定"), "envelope says the task is still in flight");
// envelopeAttrs 产属性, 原料由 renderReceiptEnvelope 拼装 —— 用渲染好的信封读回
const rendered = renderReceiptEnvelope(".worker", "wezard", "progress", "e1");
const parsed2 = parseEnvelope(`一句话\n${rendered}`);
assert.equal(parsed2?.receipt, true);
assert.equal(parsed2?.status, "progress");
assert.equal(parsed2?.event, "e1");

console.log("PROGRESS receipt: mark/dedup/journal/envelope and closing regressions passed");
