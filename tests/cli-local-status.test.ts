// 单测: CLI 本地状态消息判据 (shared/cli-local-status.ts)
// 运行: npx tsx tests/cli-local-status.test.ts
//
// 现场 (2026-11-24): 人在 CLI 里切模型, 群里冒出一条 "Switched this session to …" ——
// 老判据只认 "Set model to / Kept model as / Switch model", codebuddy 的回执换了说法就漏网。
import assert from "node:assert/strict";
import { isCliRetryNotice, isCliStateReceipt } from "../shared/cli-local-status.js";

// ── 真机转录里出现过的原文: 全部要吞 ──
const receipts = [
  "Set model to Opus 4.6",                       // claude 2.1
  "Kept model as Opus 4.6",
  "Switch model to Claude-Opus-5.5 (this session only)",
  "Switched model to Claude-Opus-5.5. Model reasoning effort set to `high`.",
  "Switched this session to Claude-Sonnet-5.",   // codebuddy 2.181
  "Switched this session to Claude-Opus-5.5.",
  "Set effort level to high",
  "Kept effort at low",
  "Model reasoning effort set to `low`.",
  "Login successful",
];
for (const t of receipts) assert.equal(isCliStateReceipt(t), true, `应吞: ${t}`);

// 多行回执: 每一行都是状态确认才整段吞。
assert.equal(isCliStateReceipt("Set model to Opus 4.6\nModel reasoning effort set to `high`."), true);
// 有一行不是回执 → 不吞 (宁可多显示, 不吞掉真内容)。
assert.equal(isCliStateReceipt("Set model to Opus 4.6\n这里是别的内容"), false);

// ── 不是状态回执: 必须照常显示 ──
for (const t of [
  "/context panel: Context Usage 45k/200k",
  "Model 返回内容: 我建议先跑单测",
  "Set up the repo and run the build",
  "",
  "   ",
]) assert.equal(isCliStateReceipt(t), false, `不该吞: ${JSON.stringify(t)}`);

// ── 自动重试提示 (CLI 自己的, 不是模型发言) ──
assert.equal(isCliRetryNotice("Model returned no valid response. Retrying automatically..."), true);
// 真失败要留给聊天看: 它是本轮唯一的信号。
assert.equal(isCliRetryNotice("Model returned no valid response. Retry later, switch models with /model, or report it with /feedback."), false);
assert.equal(isCliRetryNotice("Model request paused: the daemon is low on memory"), false);

console.log("cli-local-status: all assertions passed");
