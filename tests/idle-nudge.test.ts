// 单元测试: daemon/idle-nudge.ts — 运行: npx tsx tests/idle-nudge.test.ts
import assert from "node:assert";
import { MAX_CYCLES, step, type Obs, type Policy, type Watch } from "../daemon/idle-nudge.js";

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

const MIN = 60_000;
const P: Policy = { afterMs: 5 * MIN, max: 2 };
const idle = (o: Partial<Obs> = {}): Obs => ({ state: "working", anchor: 0, idle: true, ...o });
/** 按分钟逐次巡检, 返回每一刻是否问了。 */
const run = (obs: (min: number) => Obs, mins: number, p = P, w0?: Watch): boolean[] => {
  let w = w0;
  return Array.from({ length: mins + 1 }, (_, i) => {
    const r = step(w, obs(i), i * MIN, p);
    w = r.next;
    return r.ask;
  });
};
const asksAt = (xs: boolean[]): number[] => xs.flatMap((a, i) => (a ? [i] : []));

t("持续闲满阈值才问一次", () => assert.deepStrictEqual(asksAt(run(() => idle(), 7)), [5]));
t("问后需再满一整段才再问, 到上限冷却后新周期再问", () => assert.deepStrictEqual(asksAt(run(() => idle(), 30)), [5, 10, 20, 25]));
t("中途忙一下就从头计", () => assert.deepStrictEqual(asksAt(run((m) => idle({ idle: m !== 3 }), 12)), [9]));
t("锚变了 (续问 / 新一句) 从头计", () => assert.deepStrictEqual(asksAt(run((m) => idle({ anchor: m >= 4 ? 4 * MIN : 0 }), 12)), [9]));
t("锚的毫秒抖动不算变", () => assert.deepStrictEqual(asksAt(run((m) => idle({ anchor: m % 2 ? 500 : 0 }), 6)), [5]));
t("needs-input 满 20m 后按周期追问", () => assert.deepStrictEqual(asksAt(run(() => idle({ state: "needs-input" }), 20)), [5, 10, 20]));
t("errored 满 20m 后按周期追问", () => assert.deepStrictEqual(asksAt(run(() => idle({ state: "errored" }), 20)), [5, 10, 20]));
for (const state of ["deferred", "blocked", "done", "canceled"] as const) {
  t(`${state} 不问`, () => assert.deepStrictEqual(asksAt(run(() => idle({ state }), 20)), []));
}
t("afterMs=0 = 关", () => assert.deepStrictEqual(asksAt(run(() => idle(), 20, { afterMs: 0, max: 3 })), []));
t("reload 后带着已问次数: 闲置从头计、上限照算", () =>
  assert.deepStrictEqual(asksAt(run(() => idle(), 20, P, { asks: 1, anchor: 0 })), [5, 15, 20]));
t("不可问的状态也保留已问次数", () => {
  const r = step({ asks: 1, anchor: 0, idleSince: 0 }, idle({ state: "blocked" }), MIN, P);
  assert.equal(r.next.asks, 1);
  assert(!("idleSince" in r.next));
});

// ─── 追问有尽: 冷却按轮次翻倍, 用满 MAX_CYCLES 轮就闭嘴 ───────────────
const askableState = (s: Obs["state"]): boolean => ["working", "needs-input", "errored"].includes(s);
/** 旧逻辑 (冷却固定 afterMs、忙一下把用满的次数清零) 只为对照打印。 */
const legacyStep = (w: Watch | undefined, o: Obs, now: number, p: Policy): { next: Watch; ask: boolean } => {
  const asks = w?.asks ?? 0;
  const sameAnchor = !!w && Math.abs(w.anchor - o.anchor) < 2000;
  if (!askableState(o.state) || !o.idle) return { next: { asks: asks >= p.max ? 0 : asks, anchor: o.anchor }, ask: false };
  const since = sameAnchor && w.idleSince !== undefined ? w.idleSince : now;
  if (asks >= p.max) {
    const reset = p.afterMs > 0 && now - since >= p.afterMs;
    return { next: { asks: reset ? 0 : asks, anchor: o.anchor, idleSince: reset ? now : since }, ask: false };
  }
  const due = p.afterMs > 0 && asks < p.max && now - since >= p.afterMs;
  return due ? { next: { asks: asks + 1, anchor: o.anchor, idleSince: now }, ask: true } : { next: { asks, anchor: o.anchor, idleSince: since }, ask: false };
};

const P3: Policy = { afterMs: 5 * MIN, max: 3 };

t(`闲 16 天 (max=3) 总追问有界且 ≤ max×MAX_CYCLES (${P3.max * MAX_CYCLES})`, () => {
  const mins = 16 * 24 * 60;
  const mine = asksAt(run(() => idle(), mins, P3)).length;
  let w: Watch | undefined;
  let legacy = 0;
  for (let i = 0; i <= mins; i++) { const r = legacyStep(w, idle(), i * MIN, P3); w = r.next; if (r.ask) legacy++; }
  console.log(`      16 天追问: 旧逻辑 ${legacy} 次 → 新逻辑 ${mine} 次`);
  assert.ok(mine <= P3.max * MAX_CYCLES, `${mine} > ${P3.max * MAX_CYCLES}`);
});

t("忙一下不再把用满的次数清零", () => {
  const r = step({ asks: 3, cycles: 2, anchor: 0, idleSince: 0 }, idle({ idle: false }), 10 * MIN, P3);
  assert.equal(r.next.asks, 3);
  assert.equal(r.next.cycles, 2);
  assert.equal(r.ask, false);
});

t("锚变重置冷却轮次", () => {
  const r = step({ asks: 3, cycles: 4, anchor: 0, idleSince: 0 }, idle({ anchor: 99 * MIN }), 100 * MIN, P3);
  assert.equal(r.next.cycles, 0);
  assert.equal(r.next.asks, 0);
});

t("reload 后带着冷却轮次: 冷却按 2^cycles 放大后再重开", () => {
  assert.deepStrictEqual(asksAt(run(() => idle(), 45, P, { asks: 2, cycles: 2, anchor: 0 })), [25, 30]);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
