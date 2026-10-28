// 单元测试: daemon/danger.ts 的 dangerEarlyExit — 运行: npx tsx tests/danger-early-exit.test.ts
//
// 「danger 档(默认)的免卡」与「askRules / `.claude/**` 守卫」的优先级关系, 是本
// fork 与上游合并时反复出错的那一处 —— 把真值表钉在这里, 改坏先炸。
// 2026-10-28 起 danger.enabled/skip/skipAll 收敛进 mode 枚举: 全放行 (off) 由
// approval.ts / picker-policy.ts 的 mode==="off" 专用分支处理 (连 askRules 都压
// 过, 语义承自旧 skipAll), 不经过本函数。
import assert from "node:assert";
import { dangerEarlyExit, type DangerHit } from "../daemon/danger.js";
import type { Config } from "../shared/config.js";

let passed = 0;
let failed = 0;
const t = (name: string, fn: () => void): void => {
  try {
    fn();
    passed++;
    console.log(`ok    ${name}`);
  } catch (e) {
    failed++;
    console.log(`FAIL  ${name}\n      ${(e as Error).message}`);
  }
};

const cfgOf = (o: { mode?: "all" | "danger" | "skip_all" }): Config =>
  ({ approval: { mode: o.mode ?? "danger" } }) as unknown as Config;

const HIT: DangerHit = { rule: "删除文件 rm" };

// ── danger 档 (默认): 名单之外的放行 ─────────────────────────────────
t("mode=danger + 未命中 → danger_mode_skip", () => {
  assert.equal(dangerEarlyExit(cfgOf({ mode: "danger" }), undefined, false), "danger_mode_skip");
});

t("mode=danger + 命中名单 → 不早退 (危险的照样发卡)", () => {
  assert.equal(dangerEarlyExit(cfgOf({ mode: "danger" }), HIT, false), undefined);
});

t("mode=all + 未命中 → 不早退 (全量审批)", () => {
  assert.equal(dangerEarlyExit(cfgOf({ mode: "all" }), undefined, false), undefined);
});

t("mode=skip_all → 不早退 (skip_all 走专用分支, 压过 askRules, 不归这里)", () => {
  assert.equal(dangerEarlyExit(cfgOf({ mode: "skip_all" }), undefined, false), undefined);
  assert.equal(dangerEarlyExit(cfgOf({ mode: "skip_all" }), HIT, false), undefined);
});

// ── 核心: forcedByOthers 压过 danger 档 ─────────────────────────────
t("forcedByOthers 压过 danger_mode_skip", () => {
  assert.equal(dangerEarlyExit(cfgOf({ mode: "danger" }), undefined, true), undefined);
});

// 回归钉子: forcedByOthers 若被误写成 mustCard (danger 命中即为真), 下面两条会变
// "danger_mode_skip" —— askRules / 守卫就被 danger 档顺带关掉了。
t("forcedByOthers=true 时命中/未命中都不早退", () => {
  assert.equal(dangerEarlyExit(cfgOf({ mode: "danger" }), HIT, true), undefined);
  assert.equal(dangerEarlyExit(cfgOf({ mode: "danger" }), undefined, true), undefined);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
