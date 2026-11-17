import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigSchema } from "../shared/config.js";
import { chatPolicyOf } from "../daemon/chat-name.js";
import { bindSteward, closeOnboarding, GUIDE_DESC, guideTargetOf, isGuideManifestation, isOnboardingActive, loadOnboardingStore, needsOnboarding, stewardNameInput, validateWorkspace, WIZARD_NAME_RE } from "../daemon/onboarding.js";
import { loadWizardStore } from "../daemon/wizard.js";

// 测试目录用 $HOME 下的真实目录 (macOS /tmp 的 symlink 语义坑, 见工作区记忆)。
const dir = mkdtempSync(join(homedir(), ".tmp-onboarding-"));
try {
  const cfg = ConfigSchema.parse({ bot: { botId: "b", secret: "s" }, daemon: { stateDir: join(dir, "state") } });
  const empty = loadWizardStore(join(dir, "wizards.json"));

  // ── needsOnboarding: 判定矩阵 ─────────────────────────────────────
  cfg.defaultChat = "user:owner";
  assert.equal(needsOnboarding(cfg, empty, "chat:wrNEW"), true, "新群 (无绑定无记录) 要引导");
  assert.equal(needsOnboarding(cfg, empty, "user:owner"), false, "单聊不引导 (私聊默认接待=全局管家)");
  assert.equal(needsOnboarding(cfg, empty, ""), false, "空 base 不引导");

  cfg.chatPolicy = { "chat:wrNEW": { steward: "fix" } };
  assert.equal(needsOnboarding(cfg, empty, "chat:wrNEW"), false, "已绑管家不引导");
  delete cfg.chatPolicy;

  const withDefault = loadWizardStore(join(dir, "wizards2.json"));
  withDefault.upsert("chat:wrOLD", { description: "存量默认会话" });
  assert.equal(needsOnboarding(cfg, withDefault, "chat:wrOLD"), false, "有 untagged 默认会话的存量群不引导");

  cfg.wrc.channel.steward = { topic1: "fix" };
  assert.equal(needsOnboarding(cfg, empty, "chat:topic1"), false, "频道管家绑定不引导");
  delete cfg.wrc.channel.steward;

  const unclaimed = ConfigSchema.parse({ bot: { botId: "b", secret: "s" }, daemon: { stateDir: join(dir, "state") } });
  assert.equal(needsOnboarding(unclaimed, empty, "chat:wrNEW"), false, "未认领的新装机不引导 (先走 claim)");

  // ── validateWorkspace ─────────────────────────────────────────────
  assert.deepEqual(validateWorkspace(homedir()), { ok: true, abs: homedir() }, "存在的目录通过 (含 ~ 展开)");
  assert.equal(validateWorkspace("~").ok, true, "裸 ~ 展开为 home");
  assert.equal(validateWorkspace("relative/path").ok, false, "相对路径拒绝");
  assert.equal(validateWorkspace(join(dir, "nope")).ok, false, "不存在的路径拒绝");
  const aFile = join(dir, "file.txt");
  writeFileSync(aFile, "x");
  assert.equal(validateWorkspace(aFile).ok, false, "文件不是工作区");

  // ── stewardNameInput: @mention 粘连与记号 ─────────────────────────
  assert.equal(stewardNameInput(".fix"), "fix");
  assert.equal(stewardNameInput("🧙‍♂️ fix"), "fix");
  assert.equal(stewardNameInput("teststrict@wezard"), "teststrict", "粘连 mention 截断");
  assert.equal(stewardNameInput("fix @wezard"), "fix", "独立 mention 丢弃");
  assert.equal(stewardNameInput("fix 你来"), "fix", "只取第一个 token");
  assert.equal(stewardNameInput(""), "");
  assert.ok(WIZARD_NAME_RE.test("teststrict"));
  assert.ok(!WIZARD_NAME_RE.test("a b"), "名字不含空格");
  assert.ok(!WIZARD_NAME_RE.test("a#b"), "名字不含地址语法字符");

  // ── onboarding store: 断点续传 ────────────────────────────────────
  const ob = loadOnboardingStore(cfg);
  assert.equal(ob.get("chat:wrNEW"), undefined);
  assert.equal(ob.begin("chat:wrNEW"), "workspace");
  assert.equal(ob.begin("chat:wrNEW"), "workspace", "begin 幂等, 不重置进度");
  ob.setWorkspace("chat:wrNEW", "/Users/x/proj");
  assert.deepEqual(ob.get("chat:wrNEW"), { step: "steward", workspace: "/Users/x/proj" });
  // 落盘可见: 新实例接着读
  const ob2 = loadOnboardingStore(cfg);
  assert.equal(ob2.get("chat:wrNEW")?.workspace, "/Users/x/proj", "状态跨实例 (reload 断点续传)");
  ob.finish("chat:wrNEW");
  assert.equal(ob.get("chat:wrNEW"), undefined);
  assert.equal(loadOnboardingStore(cfg).get("chat:wrNEW"), undefined, "finish 落盘");

  // ── bindSteward: config 热改 + patchJsonc 深路径 ───────────────────
  const src = join(dir, "config.jsonc");
  writeFileSync(src, "{\n  \"bot\": { \"botId\": \"b\" }\n}\n");
  bindSteward(cfg, src, "chat:wrNEW", "fix");
  assert.equal(cfg.chatPolicy?.["chat:wrNEW"]?.steward, "fix", "cfg 热改生效");
  const onDisk = JSON.parse(readFileSync(src, "utf8"));
  assert.equal(onDisk.chatPolicy["chat:wrNEW"].steward, "fix", "patchJsonc 写进盘");
  // 已有策略键时: 内存里其他字段保留, 盘上只落 steward 这一个叶子
  bindSteward(cfg, src, "chat:wrNEW2", "bar");
  cfg.chatPolicy = { ...(cfg.chatPolicy ?? {}), "chat:wrKEEP": { topOnly: false } };
  bindSteward(cfg, src, "chat:wrKEEP", "zoo");
  assert.equal(cfg.chatPolicy["chat:wrKEEP"]?.topOnly, false, "内存里的既有策略字段保留");
  assert.equal(JSON.parse(readFileSync(src, "utf8")).chatPolicy["chat:wrKEEP"].steward, "zoo");

  // ── 引导会话形态 (人 2026-11-17 改口径) ───────────────────────────
  assert.equal(guideTargetOf("chat:wrNEW"), "chat:wrNEW#guide", "引导化身是 tagged slot, 不占 untagged 管家锚点");
  const g1 = loadWizardStore(join(dir, "wizards4.json"));
  assert.equal(isGuideManifestation(g1.upsert("chat:wrNEW#guide", { identity: "chat:wrNEW#guide", kind: "worker", description: GUIDE_DESC, name: "guide" })), true);
  assert.equal(isGuideManifestation(g1.upsert("chat:wrNEW#other", { description: GUIDE_DESC, name: "x" })), false, "slot 不是 guide 不认");
  assert.equal(isGuideManifestation(g1.upsert("chat:wrX#guide", { name: "y" })), false, "没有职责标记不认 (人手开的同名 slot 不误杀)");

  // 在途豁免 (chatPolicyOf): 引导会话要在群里说话, 出站 tracker 却会把新群登记成首见
  // strict —— 在途 (含告别窗口) 一律 implicit, 显式 strict 也不豁免; close 后恢复判定链。
  const obx = loadOnboardingStore(cfg);
  obx.begin("chat:wrEXEMPT");
  assert.equal(isOnboardingActive("chat:wrEXEMPT"), true);
  cfg.chatPolicy = { "chat:wrEXEMPT": { speech: "strict" } };
  assert.equal(chatPolicyOf(cfg, "chat:wrEXEMPT").speech, "implicit", "在途群按 implicit 出站 (引导要能说话)");
  obx.finish("chat:wrEXEMPT");
  assert.equal(isOnboardingActive("chat:wrEXEMPT"), true, "finish 只清状态机, 告别窗口仍豁免");
  closeOnboarding("chat:wrEXEMPT");
  assert.equal(isOnboardingActive("chat:wrEXEMPT"), false);
  assert.equal(chatPolicyOf(cfg, "chat:wrEXEMPT").speech, "strict", "收尾后显式 strict 恢复");
  delete cfg.chatPolicy;

  // ── identityWorkspaceOf (wizard.ts): 锚点 workspace 跨化身可见 ─────
  const store = loadWizardStore(join(dir, "wizards3.json"));
  store.upsert("chat:wrA", { kind: "steward", workspace: "/Users/x/proj", name: "fix" });
  store.upsert("chat:wrA#fix", { identity: "chat:wrA", name: "fix" });
  assert.equal((await import("../daemon/wizard.js")).identityWorkspaceOf(store, "chat:wrA#fix"), "/Users/x/proj", "化身从锚点读到身份工作区");
} finally { rmSync(dir, { recursive: true, force: true }); }
console.log("onboarding.test.ts ok");
