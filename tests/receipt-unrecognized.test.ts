// 单元测试: 弱信号与收口解析矛盾时, 账本必须落定 —— 运行: npx tsx tests/receipt-unrecognized.test.ts
import assert from "node:assert/strict";
import { EMPTY, finalReleased, onFinal, ops, step } from "../daemon/router.js";
import { unrecognizedReceipt } from "../daemon/message-events.js";
import { parseClosing } from "../daemon/peers.js";
import type { Route } from "../daemon/router.js";

const row = (patch: Partial<Route> = {}): Route => ({ event: "e9.1", owner: "chat:x#Sam",
  receiver: { kind: "wizard", to: "chat:x", event: "e9" }, status: "open", at: 1,
  deadlineAt: Number.MAX_SAFE_INTEGER, ...patch } as Route);

// 关键字在句中: 弱信号说「这是回执」, 收口形态认不出 (锚行首)。
const weak = "结论我写在下面了, 详见 RESULT: 两个仓库都干净, 没有新提交";
assert.equal(parseClosing(weak).kind, "none", "句中关键字不算收口形态");
assert.equal(unrecognizedReceipt(weak, row()), true, "挂着 open 的行必须走兜底结算");
assert.equal(unrecognizedReceipt(weak, row({ status: "need" })), true);
assert.equal(unrecognizedReceipt(weak, row({ status: "error" })), true);
assert.equal(unrecognizedReceipt(weak, row({ status: "answered" })), false, "已落定的行不再兜底");
assert.equal(unrecognizedReceipt("普通一句话, 没提收口", row()), false, "没有弱信号不动");
assert.equal(unrecognizedReceipt("RESULT: 有形态", row()), false, "认得出形态走正常路径");
assert.equal(unrecognizedReceipt(weak, undefined), false, "没有服务的行就无处落定");

// 兜底确实把行按终态落定: 一条 answer op, 状态 done。
const table = step(EMPTY, ops.open({ event: "e9.1", owner: "chat:x#Sam",
  receiver: { kind: "wizard", to: "chat:x", event: "e9" }, at: 1, deadlineAt: Number.MAX_SAFE_INTEGER }));
const out = onFinal(table, "chat:x#Sam", "e9.1", { text: weak, result: true, source: { input: "i1" } });
assert.equal(out.length, 1, "兜底必须产出唯一一条 op");
assert.equal(out[0]!.op, "answer");
if (out[0]!.op !== "answer") throw new Error("expected answer");
assert.equal(out[0]!.outcome.status, "done");
assert.equal(out[0]!.outcome.body, weak, "正文原样进回执 (排版由收方自己看)");

// 正文去向没被这条兜底碰过: strict 群的 chat 行照旧不放行 (闸门与账本解耦)。
const strictRow = step(EMPTY, ops.open({ event: "e10.1", owner: "chat:s#Sam",
  receiver: { kind: "chat", channel: "chat:s", message: "m1" }, at: 1, deadlineAt: Number.MAX_SAFE_INTEGER }));
assert.equal(finalReleased(strictRow, "chat:s#Sam", "e10.1", "RESULT: 结论", { input: "i2" }, true), false,
  "strict 群 chat 行: 即使解析认得出, 正文也不许进群");
assert.equal(finalReleased(strictRow, "chat:s#Sam", "e10.1", "RESULT: 结论", { input: "i2" }, false), true,
  "同一个行在 implicit 群照旧放行");

console.log("unrecognized receipt: 弱信号兜底结算 + 正文去向解耦 passed");
