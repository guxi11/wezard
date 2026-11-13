// 单元测试: 交接简报那一轮带着被切断那一轮的出处 (from / speaker + channel) —— 运行: npx tsx tests/handoff-carry-from.test.ts
//
// 现场事故 (2026-11-13): self 交接之后 rolepage 看不到交接之后的对话。根因是 carry 注入只带了频道、
// 没带出处, 新会话第一轮 from=∅ → role-view.senderOf 归 system: → 整段落进 p:system: 那一栏。
// 这里钉两件事: ①承载的印章只留「这一场对话是谁的」(不继承那一次投递的 receipt/status/event);
// ②带印章时 convKey 与被切断那一轮同一栏 —— 不带就是事故现场那一栏。
import assert from "node:assert";
import { carrySealOf, type Pending } from "../daemon/handoff.js";
import { allMessages, convKeyOf } from "../shared/role-view.js";
import type { DetailRecord, TurnDetailRecord } from "../shared/detail-store.js";

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

const ASKER = "user:T03880027A";
const ROLE = "user:T03880027A#v3p7";
const T0 = 1_794_571_179_000;
const HOUR = 3_600_000;

const turn = (o: Partial<TurnDetailRecord> & { id: string; createdAt: number }): TurnDetailRecord => ({
  kind: "turn", updatedAt: o.createdAt, closed: true, target: ROLE, items: [], ...o,
});
const text = (body: string, ts: number) => ({ t: "text" as const, body, ts });

/** 被切断那一轮: 同伴私下派活, 它答完就交接了。 */
const before = turn({ id: "t-pre", createdAt: T0, sessionId: "sid-old", channel: "",
  from: { kind: "peer", from: ASKER }, userQuery: "把 S2 收口, 数字要实测", items: [text("收口了。", T0 + 1)] });
/** 交接后新会话的第一轮 —— 修复后它带着上面那一轮的印章。 */
const carry = (id: string, from?: TurnDetailRecord["from"]): TurnDetailRecord => turn({
  id, createdAt: T0 + HOUR, sessionId: "sid-new", channel: "", ...(from ? { from } : {}),
  userQuery: "以下是你自己上一段会话压缩出来的交接简报, 据此无缝接着干:", items: [text("接着干。", T0 + HOUR + 1)],
});

// ── 印章 ────────────────────────────────────────────────────────────────
t("carrySealOf: 频道与出处一起留下", () => {
  const p = { target: ROLE, mode: "self", at: T0, sid: "sid-old", stage: "waiting", timeoutMs: 1, channel: "",
    speaker: ASKER, from: { kind: "peer", from: ASKER } } as Pending;
  assert.deepEqual(carrySealOf(p), { channel: "", speaker: ASKER, from: { kind: "peer", from: ASKER } });
});

t("carrySealOf: 不继承那一次投递的身份 (receipt/status/event/turn)", () => {
  const p = { target: ROLE, mode: "self", at: T0, sid: "sid-old", stage: "waiting", timeoutMs: 1, channel: "user:T03880027A",
    from: { kind: "peer", from: ASKER, receipt: true, status: "done", event: "route:x", turn: "r1", public: true } } as Pending;
  assert.deepEqual(carrySealOf(p), { channel: "user:T03880027A", from: { kind: "peer", from: ASKER, public: true } });
});

t("carrySealOf: 群里人问的那一轮 → speaker 跟着走", () => {
  const p = { target: ROLE, mode: "self", at: T0, sid: "sid-old", stage: "waiting", timeoutMs: 1, channel: "chat:wrkA", speaker: ASKER } as Pending;
  assert.deepEqual(carrySealOf(p), { channel: "chat:wrkA", speaker: ASKER });
});

// ── 落到哪一栏 (对照组 = 事故现场) ───────────────────────────────────────
const convOf = (records: readonly DetailRecord[], id: string): string => {
  const m = allMessages(records, T0 + 2 * HOUR).find((x) => x.turn.id === id && x.dir === "out");
  assert.ok(m, `${id} 没有出消息`);
  return convKeyOf(m, ROLE);
};

t("带出处的交接轮: 落回被切断那一轮同一栏", () => {
  const fixed = [before, carry("t-carry-fixed", { kind: "peer", from: ASKER })];
  assert.equal(convOf(fixed, "t-pre"), "p:user:T03880027A");
  assert.equal(convOf(fixed, "t-carry-fixed"), "p:user:T03880027A");
});

t("对照组 (修复前的数据): 没有出处 → p:system:, 与人看的那一栏分家", () => {
  assert.equal(convOf([before, carry("t-carry-broken")], "t-carry-broken"), "p:system:");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
