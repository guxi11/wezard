// 单元测试: daemon/message-events.ts 的重投原因封顶 — 运行: npx tsx tests/message-reason-cap.test.ts
import assert from "node:assert/strict";
import { REASON_MAX, appendReason, why } from "../daemon/message-events.js";

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

const PROBE = "pane probe exceeded 5s; no transport attempted";
/** 改前的拼法: 无条件 `prev; add`。 */
const legacy = (adds: string[]): string => adds.reduce((p, x) => (p ? `${p}; ${x}` : x), "");
const appendAll = (adds: string[]): string => adds.reduce<string | undefined>((p, x) => appendReason(p, x), undefined)!;

t(`同一原因追加 500 次 → ${PROBE} (×500)`, () => {
  assert.equal(appendAll(Array.from({ length: 500 }, () => PROBE)), `${PROBE} (×500)`);
});

t("交替两种原因 1000 次: 长度封顶、首尾都在", () => {
  const other = "ready=false (前置未落定 / owner 未判闲)";
  const out = appendAll(Array.from({ length: 1000 }, (_, i) => (i % 2 ? other : PROBE)));
  assert.ok(out.length <= REASON_MAX, `length ${out.length} > ${REASON_MAX}`);
  assert.ok(out.startsWith(PROBE), "开头那条原因应保留");
  assert.ok(out.endsWith(other), "最新一条原因应保留");
  assert.ok(out.includes("…[略 "), "中间应有省略标记");
});

t("10KB 老 prev + 新原因: 封顶且首尾都在", () => {
  const prev = `${"x".repeat(10_000)}; tail`;
  const out = appendReason(prev, "pane probe failed 30 times");
  assert.ok(out.length <= REASON_MAX, `length ${out.length} > ${REASON_MAX}`);
  assert.ok(out.startsWith("xxx"), "老原因的开头应保留");
  assert.ok(out.endsWith("pane probe failed 30 times"), "新原因应在末尾");
});

t("why 截到 500 字", () => {
  const out = why(new Error("z".repeat(10_000)));
  assert.equal(out.length, 500);
  assert.ok(out.endsWith("…"));
});

t("不重复的短原因原样堆叠", () => {
  assert.equal(appendReason(appendReason(undefined, "a"), "b"), "a; b");
});

const before = legacy(Array.from({ length: 206 }, () => PROBE));
const after = appendAll(Array.from({ length: 206 }, () => PROBE));
const day16 = appendAll(Array.from({ length: 3171 }, () => PROBE));
console.log(`\n206 次: 改前 ${before.length} 字 → 改后 ${after.length} 字`);
console.log(`3171 次 (事故现场): 改前 ${legacy(Array.from({ length: 3171 }, () => PROBE)).length} 字 → 改后 ${day16.length} 字`);
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
