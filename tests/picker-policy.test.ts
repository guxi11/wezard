import assert from "node:assert/strict";
import { ConfigSchema } from "../shared/config.js";
import { modalFingerprint, parseConfirmContext, parseModalOptions, pickAutoAllowAnswer, isModalPane } from "../shared/modal-pane.js";
import { dispatchPickerPolicy, pickerPolicy } from "../daemon/picker-policy.js";

const cfg = () => ConfigSchema.parse({ bot: { botId: "test", secret: "test" } });
const frame = (command: string, tool = "Bash") => `
╭──────────────────────────────────────────╮
│ Confirm · @worker                        │
│ toolName: "${tool}"                        │
│ params: ${JSON.stringify({ command })}      │
│ Would you like to proceed?               │
│ ❯ 1. Yes                                 │
│   2. Yes, and don't ask again             │
│   3. No                                  │
╰──────────────────────────────────────────╯`;
const context = parseConfirmContext(frame("git status"));
assert.equal(context.complete, true);
assert.equal(context.agent, "@worker");
assert.equal(context.toolName, "Bash");
assert.deepEqual(context.toolInput, { command: "git status" });
assert.equal(pickAutoAllowAnswer(parseModalOptions(frame("git status")))?.label, "Yes");

const config = cfg();
// 默认 mode 已是 danger (2026-10-28: 普通卡不再发); 这一块锁 all 语义的分层。
config.approval.mode = "all";
// 新默认断言: 不配 mode = danger-only (非 danger 不发卡)。
assert.equal(cfg().approval.mode, "danger", "mode 默认应为 danger (普通卡不再发)");
assert.equal(pickerPolicy(cfg(), "codebuddy", context, false).decision, "allow");
assert.equal(pickerPolicy(cfg(), "codebuddy", context, false).reason, "danger_mode_skip");
{
  // 默认档下分层仍硬: deny 照拒、askRules 照卡、danger 照红卡 —— 人只管 danger。
  const d = cfg();
  d.approval.denyRules = ["Bash(git status)"];
  assert.equal(pickerPolicy(d, "codebuddy", context, false).decision, "deny");
  const a = cfg();
  a.approval.askRules = ["Bash(git status)"];
  assert.equal(pickerPolicy(a, "codebuddy", context, false).decision, "manual");
  assert.equal(pickerPolicy(a, "codebuddy", context, false).forceSingle, "Bash(git status)");
  const g = cfg();
  assert.equal(pickerPolicy(g, "codebuddy", parseConfirmContext(frame("rm -rf ~/task")), false).decision, "manual");
  assert.ok(pickerPolicy(g, "codebuddy", parseConfirmContext(frame("rm -rf ~/task")), false).danger);
}
assert.equal(pickerPolicy(config, "codebuddy", context, false).decision, "manual");
assert.equal(pickerPolicy(config, "codebuddy", context, true).decision, "allow");
config.approval.allowRules = ["Bash(git status)"];
assert.equal(pickerPolicy(config, "codebuddy", context, false).reason, "allow_rule");
config.approval.askRules = ["Bash(git status)"];
assert.equal(pickerPolicy(config, "codebuddy", context, true).decision, "manual");
assert.equal(pickerPolicy(config, "codebuddy", context, true).forceSingle, "Bash(git status)");
// askRules = 人自己要求每次问, 不是危险: 走「审核」行, 「危险」行只留给名单真命中。
assert.equal(pickerPolicy(config, "codebuddy", context, true).note, "命中 askRules「Bash(git status)」");
assert.equal(pickerPolicy(config, "codebuddy", context, true).danger, undefined);
config.approval.mode = "skip_all";
assert.equal(pickerPolicy(config, "codebuddy", context, true).decision, "allow");
config.approval.denyRules = ["Bash(git status)"];
assert.equal(pickerPolicy(config, "codebuddy", context, true).decision, "deny");
assert.equal(pickerPolicy(config, "codex", context, true).decision, "leave");
assert.equal(pickerPolicy(config, undefined, context, true).decision, "leave");
config.approval.enabled = false;
assert.equal(pickerPolicy(config, "codebuddy", context, true).decision, "leave");

const mode = cfg();
mode.approval.mode = "danger";
assert.equal(pickerPolicy(mode, "claude", context, false).reason, "danger_mode_skip");
// 危险样例用可解析的非临时区目标: /tmp 下的 rm 走临时区豁免、相对路径解析不出
// 不判 (2026-10-28 口径), 都不再是 danger 命中。
const dangerous = parseConfirmContext(frame("rm -rf ~/task"));
assert.equal(pickerPolicy(mode, "codebuddy", dangerous, true).decision, "manual");
assert.ok(pickerPolicy(mode, "codebuddy", dangerous, true).forceSingle);
// 原 danger.skip=true 的语义 (跳过危险卡) 2026-10-28 收敛为 mode:"skip_all" —— 它
// 压过危险名单与 askRules (承自旧 skipAll), 只想在 danger 档下微调已无此档。
mode.approval.mode = "skip_all";
assert.equal(pickerPolicy(mode, "codebuddy", dangerous, false).reason, "skip_all");
mode.approval.askRules = ["Bash(rm *)"];
assert.equal(pickerPolicy(mode, "codebuddy", dangerous, true).decision, "allow", "skip_all 压过 askRules");
mode.approval.mode = "danger";
mode.approval.askRules = ["Bash(rm *)"];
assert.equal(pickerPolicy(mode, "codebuddy", dangerous, true).decision, "manual");
const self = parseConfirmContext(frame("unused", "mcp__wezard__set_model").replace('{"command":"unused"}', '{"scope":"default"}'));
assert.equal(self.complete, true);
assert.ok(pickerPolicy(mode, "codebuddy", self, true).forceSingle);

const unknown = [
  frame("git status").replace('params: {"command":"git status"}', 'params: {"command":"git status"'),
  frame("git status").replace('params: {"command":"git status"}', 'params: {"command":"git status…"}'),
  frame("git status").replace('params: {"command":"git status"}', 'params: {}'),
  frame("git status").replace("Confirm · @worker", "Output from previous tool"),
  `Bash command\n git status\nWould you like to proceed?\n❯ 1. Yes\n 2. Yes, and don't ask again\n 3. No\nEsc to cancel`,
];
const skip = cfg();
skip.approval.mode = "skip_all";
const allCfg = cfg();
allCfg.approval.mode = "all";
assert.equal(pickerPolicy(skip, "codebuddy", { ...context, toolInput: { command: "git status", sandbox_permissions: "require_escalated" } }, true).decision, "leave");
for (const screen of unknown) {
  const ctx = parseConfirmContext(screen);
  assert.equal(ctx.complete, false, screen);
  // 不完整上下文: danger 档早退放行 (2026-10-28 人口径: 认不出 ≠ 危险, danger 档
  // 下不出普通卡); all 档转审批卡逐次确认; skipAll 与 hook 路径同语义盲放
  // (真实 CodeBuddy 权限 picker 的正文解不出 Confirm 头/toolName, 否则 skipAll 永远轮空)。
  assert.equal(pickerPolicy(cfg(), "codebuddy", ctx, true).decision, "allow", screen);
  assert.equal(pickerPolicy(cfg(), "codebuddy", ctx, true).reason, "danger_mode_skip", screen);
  const carded = pickerPolicy(allCfg, "codebuddy", ctx, true);
  assert.equal(carded.decision, "manual", screen);
  assert.ok(carded.forceSingle, screen);
  assert.equal(pickerPolicy(skip, "codebuddy", ctx, true).decision, "allow", screen);
}

// 真屏回归: 本机 CodeBuddy hook-ask 回退 picker (transcript 0b6b5d46, 2026-10-13)。
// sentinel 链路逐环验收: modal → 裸 Yes → ctx 不完整 → skipAll 下放行。
const realCodebuddyPicker = `∴ Thought
● Bash(ls -la /Users/zyy/.codebuddy/projects/x/memory/)
────────────────────────────────────────────────────────────────────────────────
 Bash command
   ls -la /Users/zyy/.codebuddy/projects/x/memory/
   列出 memory 目录与两个工作区
────────────────────────────────────────────────────────────────────────────────
 Hook PreToolUse: Bash requires confirmation:
   wezard: send_card_fail:invalid chatid, hint: [123]
 > 1. Yes
   2. Yes, and don't ask again for session (shift + tab)
   3. No, and tell CodeBuddy what to do differently (escape)`;
const realV = isModalPane(realCodebuddyPicker);
assert.equal(realV.modal, true);
assert.equal(pickAutoAllowAnswer(parseModalOptions(realCodebuddyPicker))?.label, "Yes");
const realCtx = parseConfirmContext(realCodebuddyPicker);
assert.equal(realCtx.complete, false);
assert.equal(pickerPolicy(skip, "codebuddy", realCtx, false).decision, "allow");

// 解不出结构时 (2026-10-28 二次口径: 无法完整识别不判 danger, danger 档下也不出
// 普通卡): CodeBuddy 的权限框正文只有一段命令, toolName/params 都解不出; 正文里的
// rm 目标解析不出/全在临时区 → 不立 danger → danger 档放行, all 档才走「审核」行。
const rmScreen = [
  " Bash command",
  "   cd /tmp && rm -rf b64chunks && mkdir b64chunks && base64 -i dag5-node.png | tr -d x",
  " Hook PreToolUse: REPL requires confirmation:",
  " > 1. Yes",
  "   2. No",
].join("\n");
const rmCtx = parseConfirmContext(rmScreen);
assert.equal(rmCtx.complete, false);
const rmPolicy = pickerPolicy(cfg(), "codebuddy", rmCtx, true);
assert.equal(rmPolicy.decision, "allow", "danger 档下认不出且名单未命中 → 放行");
assert.equal(rmPolicy.reason, "danger_mode_skip");
const rmCard = pickerPolicy(allCfg, "codebuddy", rmCtx, true);
assert.equal(rmCard.decision, "manual");
assert.equal(rmCard.danger, undefined, "解析不出不立 danger");
assert.equal(rmCard.note, "无法完整识别此次操作，请逐次确认");
// 真机回归 (2026-10-28, .WendyVance 的 pane): danger 档下这张「无法完整识别」普通卡
// 不该存在 —— rm 目标全在 /tmp 临时区, 名单不立 danger, 早退放行。
const evalScreen = [
  " Bash command",
  "   rm -rf /tmp/evaltest2 && mkdir -p /tmp/evaltest2/.codebuddy/skills/test-manager",
  " Hook PreToolUse: Bash requires confirmation:",
  " > 1. Yes",
  "   2. No",
].join("\n");
const evalCtx = parseConfirmContext(evalScreen);
assert.equal(evalCtx.complete, false);
const evalPolicy = pickerPolicy(cfg(), "codebuddy", evalCtx, true);
assert.equal(evalPolicy.decision, "allow");
assert.equal(evalPolicy.reason, "danger_mode_skip");
// 认不出结构但可见正文里有看得懂的非临时区 rm → 照样打红走「危险」行, danger 档不放行。
const outsideScreen = [
  " Bash command",
  "   rm -rf ~/task",
  " Hook PreToolUse: Bash requires confirmation:",
  " > 1. Yes",
  "   2. No",
].join("\n");
const outsidePolicy = pickerPolicy(cfg(), "codebuddy", parseConfirmContext(outsideScreen), true);
assert.equal(outsidePolicy.decision, "manual");
assert.ok(outsidePolicy.danger, "可见正文里的非临时区 rm 仍立 danger");
// 真认不出危险的时候才退回「无法完整识别」, 而且只在 all 档走审核行。
const vagueCtx = parseConfirmContext("Bash command\n   ls -la\nWould you like to proceed?\n > 1. Yes\n  2. No");
const vaguePolicy = pickerPolicy(allCfg, "codebuddy", vagueCtx, true);
assert.equal(vaguePolicy.danger, undefined);
assert.equal(vaguePolicy.note, "无法完整识别此次操作，请逐次确认");
assert.equal(pickerPolicy(cfg(), "codebuddy", vagueCtx, true).decision, "allow");
for (const tool of ["AskUserQuestion", "EnterPlanMode", "ExitPlanMode", "PermissionRequest"]) {
  assert.equal(pickerPolicy(skip, "codebuddy", parseConfirmContext(frame("unused", tool)), true).decision, "leave");
}
assert.equal(modalFingerprint(frame("git status")), modalFingerprint(frame("git status").replace("❯ 1.", "  1.").replace("  3.", "❯ 3.")));
assert.notEqual(modalFingerprint(frame("git status")), modalFingerprint(frame("git diff")));
assert.notEqual(modalFingerprint("  command\n\nnext"), modalFingerprint(" command\nnext"));
const plan = `Would you like to proceed?\n❯ 1. Yes, and auto-accept edits\n 2. Yes, and manually approve edits\n 3. No, keep planning\nEsc to cancel`;
assert.equal(pickAutoAllowAnswer(parseModalOptions(plan)), undefined);

// Exercise the production dispatch boundary, not just the policy label: none
// of these requests may enter a generic card or either key-press callback.
const effects: string[] = [];
const handlers = {
  allow: () => { effects.push("press yes"); },
  deny: () => { effects.push("press no"); },
  manual: () => { effects.push("generic picker card"); },
};
for (const backend of [undefined, "codex"] as const) {
  await dispatchPickerPolicy(pickerPolicy(skip, backend, context, true), handlers);
}
for (const key of ["sandbox_permissions", "requested_permissions", "additional_permissions"]) {
  for (const input of [
    { command: "git status", [key]: "require_escalated" },
    { nested: { [key]: {} } },
    { params: `{"command":"git status","${key}": {` },
  ]) {
    await dispatchPickerPolicy(pickerPolicy(skip, "codebuddy", { ...context, toolInput: input }, true), handlers);
  }
}
await dispatchPickerPolicy(pickerPolicy(skip, "codebuddy", { ...context, toolName: "PermissionRequest" }, true), handlers);
assert.deepEqual(effects, [], "native/unknown requests never dispatch cards or presses");
const allMode = cfg();
allMode.approval.mode = "all"; // 默认已是 danger (非 danger 自动放行), 此处锁 all 语义
await dispatchPickerPolicy(pickerPolicy(allMode, "codebuddy", context, false), handlers);
assert.deepEqual(effects, ["generic picker card"]);
await dispatchPickerPolicy(pickerPolicy(skip, "codebuddy", context, true), handlers);
assert.deepEqual(effects, ["generic picker card", "press yes"]);
const denied = cfg();
denied.approval.denyRules = ["Bash(git status)"];
await dispatchPickerPolicy(pickerPolicy(denied, "codebuddy", context, true), handlers);
assert.deepEqual(effects, ["generic picker card", "press yes", "press no"]);
console.log("Picker policy and complete-context safety checks passed");
