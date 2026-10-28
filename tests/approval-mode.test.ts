// 单元测试: approval.mode 枚举收敛 + 老配置迁移 — 运行: npx tsx tests/approval-mode.test.ts
//
// 2026-10-28 人拍板: 原 danger.enabled / danger.skip / danger.skipAll 三个布尔收敛
// 进 mode 枚举 (all | danger | skip_all), danger.enabled 彻底消失 (连「enabled=false
// 回退 all」的隐含规则一起删)。这里钉住: 默认档、迁移映射 (老 key → 新枚举)、
// 显式 mode 优先、老 key 留盘不报错、非法值报错路径。
import assert from "node:assert";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigSchema, migrateApprovalMode } from "../shared/config.js";
import { configGet } from "../daemon/config-api.js";

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

const BOT = { bot: { botId: "t", secret: "t" } } as const;

// ── 枚举与默认 ───────────────────────────────────────────────────────
t("默认 mode = danger (普通卡不再发, 只危险发卡)", () => {
  assert.equal(ConfigSchema.parse(BOT).approval.mode, "danger");
});
t("all / skip_all 显式可配", () => {
  assert.equal(ConfigSchema.parse({ ...BOT, approval: { mode: "all" } }).approval.mode, "all");
  assert.equal(ConfigSchema.parse({ ...BOT, approval: { mode: "skip_all" } }).approval.mode, "skip_all");
});
t("非法值报错, 路径指到 approval.mode", () => {
  const r = ConfigSchema.safeParse({ ...BOT, approval: { mode: "off" } }); // 旧更名前的值也要报错
  assert.ok(!r.success);
  assert.ok(r.error.issues.some((i) => i.path.join(".") === "approval.mode"));
});

// ── 迁移: 未写 mode 时老 key 映射 ────────────────────────────────────
t("danger.skipAll=true → skip_all + 说明", () => {
  const m = migrateApprovalMode({ approval: { danger: { skipAll: true } } });
  assert.equal(m.mode, "skip_all");
  assert.ok(m.note?.includes("skip_all"));
});
t("danger.skip=true → skip_all (连危险卡也不发)", () => {
  assert.equal(migrateApprovalMode({ approval: { danger: { skip: true } } }).mode, "skip_all");
});
t("danger.enabled=false → skip_all (老 key 名义上是关名单, 实效是啥都不拦)", () => {
  assert.equal(migrateApprovalMode({ approval: { danger: { enabled: false } } }).mode, "skip_all");
});
t("无老 key / 都是良性值 → 不迁移 (落默认 danger)", () => {
  assert.equal(migrateApprovalMode({ approval: { danger: { enabled: true, skip: false, skipAll: false } } }).mode, undefined);
  assert.equal(migrateApprovalMode({ approval: {} }).mode, undefined);
  assert.equal(migrateApprovalMode({}).mode, undefined);
});
t("显式 mode 优先, 老 key 忽略", () => {
  assert.equal(migrateApprovalMode({ approval: { mode: "all", danger: { skipAll: true } } }).mode, undefined);
});
t("老 key 留在盘上不报错 (zod 忽略未知键)", () => {
  const r = ConfigSchema.safeParse({ ...BOT, approval: { danger: { skip: true, skipAll: true, enabled: false } } });
  assert.ok(r.success);
  assert.equal(r.data.approval.mode, "danger"); // schema 本身不迁移, 迁移在 loadConfig
});

// ── config_get 里要能看见迁移成了什么 (硬约束) ────────────────────────
const tmp = mkdtempSync(join(tmpdir(), "wezard-mode-mig-"));
try {
  const cfgPath = join(tmp, "config.jsonc");
  writeFileSync(cfgPath, JSON.stringify({ bot: { botId: "t", secret: "t" }, approval: { danger: { skipAll: true } } }));
  const cfg = ConfigSchema.parse({ bot: { botId: "t", secret: "t" }, approval: { mode: "skip_all" } });
  t("config_get approval: 老 key 在盘 → 挂「迁移: …skip_all」一行", () => {
    const text = configGet(cfg, cfgPath, "approval");
    assert.ok(text.ok);
    assert.ok(text.text.includes("迁移:"), "应有迁移说明行");
    assert.ok(text.text.includes("skip_all"));
  });
  t("config_get approval.mode: 迁移行也挂在叶子层", () => {
    const text = configGet(cfg, cfgPath, "approval.mode");
    assert.ok(text.ok);
    assert.ok(text.text.includes("迁移:"));
  });
  t("config_get 无关路径不挂迁移行; 老 key 清掉后自灭", () => {
    const other = configGet(cfg, cfgPath, "approval.matcher");
    assert.ok(other.ok);
    assert.ok(!other.text.includes("迁移:"));
    const clean = join(tmp, "clean.jsonc");
    writeFileSync(clean, JSON.stringify({ bot: { botId: "t", secret: "t" }, approval: { mode: "skip_all" } }));
    const cleanText = configGet(cfg, clean, "approval");
    assert.ok(cleanText.ok);
    assert.ok(!cleanText.text.includes("迁移:"), "老 key 清掉后不再提示");
  });
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
