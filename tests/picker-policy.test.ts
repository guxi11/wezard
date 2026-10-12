import assert from "node:assert/strict";
import { ConfigSchema } from "../shared/config.js";
import { modalFingerprint, parseConfirmContext, parseModalOptions, pickAutoAllowAnswer } from "../shared/modal-pane.js";
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
assert.equal(pickerPolicy(config, "codebuddy", context, false).decision, "manual");
assert.equal(pickerPolicy(config, "codebuddy", context, true).decision, "allow");
config.approval.allowRules = ["Bash(git status)"];
assert.equal(pickerPolicy(config, "codebuddy", context, false).reason, "allow_rule");
config.approval.askRules = ["Bash(git status)"];
assert.equal(pickerPolicy(config, "codebuddy", context, true).decision, "manual");
assert.equal(pickerPolicy(config, "codebuddy", context, true).forceSingle, "Bash(git status)");
config.approval.danger.skipAll = true;
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
const dangerous = parseConfirmContext(frame("rm -rf /tmp/task"));
assert.equal(pickerPolicy(mode, "codebuddy", dangerous, true).decision, "manual");
assert.ok(pickerPolicy(mode, "codebuddy", dangerous, true).forceSingle);
mode.approval.danger.skip = true;
assert.equal(pickerPolicy(mode, "codebuddy", dangerous, false).reason, "danger_skip");
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
skip.approval.danger.skipAll = true;
assert.equal(pickerPolicy(skip, "codebuddy", { ...context, toolInput: { command: "git status", sandbox_permissions: "require_escalated" } }, true).decision, "leave");
for (const screen of unknown) {
  const ctx = parseConfirmContext(screen);
  assert.equal(ctx.complete, false, screen);
  assert.equal(pickerPolicy(skip, "codebuddy", ctx, true).decision, "manual");
  assert.ok(pickerPolicy(skip, "codebuddy", ctx, true).forceSingle);
}
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
await dispatchPickerPolicy(pickerPolicy(cfg(), "codebuddy", context, false), handlers);
assert.deepEqual(effects, ["generic picker card"]);
await dispatchPickerPolicy(pickerPolicy(skip, "codebuddy", context, true), handlers);
assert.deepEqual(effects, ["generic picker card", "press yes"]);
const denied = cfg();
denied.approval.denyRules = ["Bash(git status)"];
await dispatchPickerPolicy(pickerPolicy(denied, "codebuddy", context, true), handlers);
assert.deepEqual(effects, ["generic picker card", "press yes", "press no"]);
console.log("Picker policy and complete-context safety checks passed");
