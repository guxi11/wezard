import assert from "node:assert/strict";
import { stepObligation, type ObligationWatch } from "../daemon/idle-nudge.js";

// P7-S2 判据⑥ (违约夹具, 纯状态机):
//   提醒恰好 1 次 → 再 idle 未关 → overdue 上报恰好 1 次;
//   假时钟快进 24h 无事件时状态迁移 0;
//   注入 10 分钟未提交只提示 (stalled) 不判超时; 不按墙钟判逾期、不伪造 timeout。

const T = 1_700_000_000_000;
const idle = { delivered: true, idle: true, ageMs: 60_000 };

// 第一次 idle 观测: 提醒恰好 1 次
let w: ObligationWatch | undefined;
let r = stepObligation(w, idle, T);
assert.equal(r.remind, true, "idle 且未关 → 提醒");
assert.equal(r.escalate, false);
assert.equal(r.next.remindedAt, T);
w = r.next;

// 再 idle 未关: overdue 上报恰好 1 次
r = stepObligation(w, idle, T + 30_000);
assert.equal(r.remind, false, "提醒只有一次");
assert.equal(r.escalate, true, "再 idle 未关 → overdue");
assert.equal(r.next.overdue, true);
w = r.next;

// 之后无论多少次巡检 (含假时钟快进 24h, 无事件): 状态迁移 0, 不再有动作
const frozen = JSON.stringify(w);
let transitions = 0;
for (let i = 0; i < 1000; i++) {
  const t = T + 86_400_000 + i * 30_000; // 快进 24h 后继续巡
  const step = stepObligation(w, idle, t);
  if (JSON.stringify(step.next) !== frozen) transitions++;
  assert.equal(step.remind, false);
  assert.equal(step.escalate, false);
  w = step.next;
}
assert.equal(transitions, 0, "假时钟快进 24h 无事件时状态迁移 0");
assert.equal(JSON.stringify(w), frozen, "状态冻结");

// 忙着的 owner: 不提醒不推进
assert.deepEqual(stepObligation(undefined, { delivered: true, idle: false, ageMs: 60_000 }, T),
  { next: {}, remind: false, escalate: false, stalled: false }, "忙时不判");

// 注入未提交: 只提示 (stalled) 不判超时 — 状态不动、无提醒、无 overdue
r = stepObligation(undefined, { delivered: false, idle: true, ageMs: 11 * 60_000 }, T);
assert.equal(r.stalled, true, "10 分钟未注入 → stalled 提示");
assert.equal(r.remind, false, "未提交不提醒");
assert.equal(r.escalate, false, "未提交不上报");
assert.deepEqual(r.next, {}, "未提交不落状态 (不伪造 timeout)");
assert.equal(stepObligation(undefined, { delivered: false, idle: true, ageMs: 9 * 60_000 }, T).stalled, false, "10 分钟内不算 stalled");
// stalled 的义务后来提交了 → 正常进提醒轨道
r = stepObligation(r.next, idle, T + 60_000);
assert.equal(r.remind, true, "提交后照常提醒");

// 落定由行状态负责 (rows 过滤掉 answered/handed), 状态机里没有 timeout 出口 — 不变式:
// stepObligation 永不产生 remind/escalate 之外的副作用, next 里也没有 outcome 概念。
assert.ok(!("outcome" in (w as Record<string, unknown>)), "状态机不伪造定论");

console.log("strict-obligation: 提醒/上报各恰好 1 次 / 24h 快进零迁移 / 未注入只提示");
