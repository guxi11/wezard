// 单元测试: daemon/idle-nudge.ts — 运行: npx tsx tests/idle-nudge.test.ts
import assert from "node:assert";
import { step, type Obs, type Policy, type Watch } from "../daemon/idle-nudge.js";

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
const idle = (o: Partial<Obs> = {}): Obs => ({ state: "working", anchor: 0, idle: true, jobOpen: true, ...o });
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
t("问后需再满一整段才再问, 且到上限停", () => assert.deepStrictEqual(asksAt(run(() => idle(), 30)), [5, 10]));
t("中途忙一下就从头计", () => assert.deepStrictEqual(asksAt(run((m) => idle({ idle: m !== 3 }), 12)), [9]));
t("锚变了 (续问 / 新一句) 从头计", () => assert.deepStrictEqual(asksAt(run((m) => idle({ anchor: m >= 4 ? 4 * MIN : 0 }), 12)), [9]));
t("锚的毫秒抖动不算变", () => assert.deepStrictEqual(asksAt(run((m) => idle({ anchor: m % 2 ? 500 : 0 }), 6)), [5]));
for (const state of ["needs-input", "deferred", "errored", "blocked", "done", "canceled"] as const) {
  t(`${state} 不问`, () => assert.deepStrictEqual(asksAt(run(() => idle({ state }), 20)), []));
}
t("工单收了不问", () => assert.deepStrictEqual(asksAt(run(() => idle({ jobOpen: false }), 20)), []));
t("afterMs=0 = 关", () => assert.deepStrictEqual(asksAt(run(() => idle(), 20, { afterMs: 0, max: 3 })), []));
t("reload 后带着已问次数: 闲置从头计、上限照算", () =>
  assert.deepStrictEqual(asksAt(run(() => idle(), 20, P, { asks: 1, anchor: 0 })), [5]));
t("不可问的状态也保留已问次数", () => {
  const r = step({ asks: 2, anchor: 0, idleSince: 0 }, idle({ state: "needs-input" }), MIN, P);
  assert.deepStrictEqual(r.next, { asks: 2, anchor: 0 });
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
