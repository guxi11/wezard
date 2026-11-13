// 单元测试: rolepage 的 session 分段按 sid 归并、时间窗可以有多段 —— 运行: npx tsx tests/role-session-span.test.ts
//
// 事故 (2026-11-13): 一条 sessionId 为空的轮夹在中间, 同一 sid 被劈成两段两行; spanOf 取第一段,
// 在下拉里选它只剩那一小段窗口 (现场 19 秒), 后面的历史像丢了。
import assert from "node:assert";
import { inSpan, sessionsOf } from "../shared/role-view.js";
import type { TurnDetailRecord } from "../shared/detail-store.js";

let passed = 0;
let failed = 0;
const t = (name: string, fn: () => void): void => {
  try {
    fn();
    passed++;
    console.log(`ok    ${name}`);
  } catch (e) {
    failed++;
    console.error(`FAIL  ${name}: ${(e as Error).message}`);
  }
};

const ROLE = "user:T03880027A#v3p7";
const T0 = 1_794_571_179_000;
const HOUR = 3_600_000;
const turn = (o: Partial<TurnDetailRecord> & { id: string; createdAt: number }): TurnDetailRecord => ({
  kind: "turn", updatedAt: o.createdAt, closed: true, target: ROLE, items: [{ t: "text", body: "…", ts: o.createdAt + 1 }], ...o,
});
const first = turn({ id: "t1", createdAt: T0, sessionId: "sid-a", channel: "" });
const stray = turn({ id: "t2", createdAt: T0 + HOUR / 2, channel: "" });           // 老记录: 没有 sid
const later = turn({ id: "t3", createdAt: T0 + HOUR, sessionId: "sid-a", channel: "" });
const next = turn({ id: "t4", createdAt: T0 + 2 * HOUR, sessionId: "sid-b", channel: "" });

t("同一 sid 被一条无 sid 的轮隔开 → 仍是一行, 两段时间窗", () => {
  const spans = sessionsOf([first, stray, later], ROLE, T0 + 3 * HOUR);
  assert.equal(spans.length, 2, JSON.stringify(spans));
  const a = spans.find((s) => s.sessionId === "sid-a");
  assert.ok(a);
  assert.equal(a.turns, 2);
  assert.equal(a.runs?.length, 2);
  assert.equal(inSpan(a)(T0), true);
  assert.equal(inSpan(a)(T0 + HOUR + 1), true, "同一 sid 的后一段必须落在窗口里");
  assert.equal(inSpan(a)(T0 + HOUR / 2 + 5), false, "被隔开的那段属于别人");
  assert.equal(inSpan(spans.find((s) => s.sessionId === "")!)(T0 + HOUR / 2 + 5), true);
});

t("没有隔断时仍是 [首轮, 下一段首轮), 且不给 runs", () => {
  const spans = sessionsOf([first, next], ROLE, T0 + 3 * HOUR);
  assert.deepEqual(spans.map((s) => [s.sessionId, s.start, s.end, s.turns]), [["sid-a", T0, T0 + 2 * HOUR, 1], ["sid-b", T0 + 2 * HOUR, Infinity, 1]]);
  assert.equal(spans[0]!.runs, undefined);
});

t("外沿 start/end 只是显示用的总范围", () => {
  const spans = sessionsOf([first, stray, later], ROLE, T0 + 3 * HOUR);
  const a = spans.find((s) => s.sessionId === "sid-a")!;
  assert.equal(a.start, T0);
  assert.equal(a.end, Infinity);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
