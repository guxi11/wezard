import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, symlinkSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startupConfirmation, workspaceTrustConfig, workspaceTrustPrompt, codebuddyTrustPrompt } from "../shared/workspace-trust.js";

const cwd = "/private/tmp/authorized-workspace";
// Isolated Claude trust picker; the verified post-confirmation screen reports v2.1.296 (default is No).
const claude = `Accessing workspace:
${cwd}
Quick safety check: Is this a project you created or one you trust?
Claude Code'll be able to read, edit, and execute files here.
Security guide
❯ No, exit
  Yes, I trust this folder
Enter to confirm · Esc to cancel`;
const codex = `Trust this folder? Codex can read, edit, and run files here, subject to your permission settings.
${cwd}
› 1. Trust and continue
  2. Open restricted`;
assert.equal(workspaceTrustPrompt(claude, "claude", cwd)?.choice, 1);
assert.equal(workspaceTrustPrompt(claude, "claude", cwd)?.selected, 0);
assert.equal(workspaceTrustPrompt(claude.replace("❯ No, exit", "No, exit").replace("  Yes,", "❯ Yes,"), "claude", cwd)?.selected, 1);
assert.equal(workspaceTrustPrompt(claude.replace("❯ No, exit", "❯ 1. No, exit").replace("  Yes,", "  2. Yes,"), "claude-internal", cwd)?.choice, 1);
assert.equal(workspaceTrustPrompt(claude, "codebuddy", cwd)?.choice, 1);
assert.equal(workspaceTrustPrompt(codex, "codex", cwd)?.choice, 0);
// Codex 0.162.1 actual startup picker uses Quit rather than Open restricted.
assert.equal(workspaceTrustPrompt(codex.replace("2. Open restricted", "2. Quit"), "codex", cwd)?.choice, 0);
assert.equal(workspaceTrustPrompt(codex, "claude", cwd), undefined);
assert.equal(workspaceTrustPrompt(claude, "codex", cwd), undefined);
for (const screen of [
  claude.replace(cwd, "/other"),
  claude.replace(cwd, `${cwd}/child`),
  claude.replace(cwd, "/"),
  claude.replace(cwd, ".../authorized-workspace"),
  claude.replace("Accessing workspace:", "Would you like to proceed?"),
  claude.replace("Yes, I trust this folder", "Yes, and enable full access"),
  claude.replace("No, exit", "No, continue without these permissions"),
  claude.replace("❯ No, exit", "No, exit"),
  claude.replace("Quick safety check:", "This folder adds /other to the workspace.\nQuick safety check:"),
  claude.replace("Quick safety check:", "This folder pre-approves 2 tool permissions.\nQuick safety check:"),
  claude.replace("Quick safety check:", "This folder runs commands to mint HTTP headers.\nQuick safety check:"),
  `${claude}\n/other`,
  `${claude}\n 3. Yes, disable sandbox`,
  `${claude}\nWould you like to proceed?\n❯ 1. Yes\n 2. No`,
]) assert.equal(workspaceTrustPrompt(screen, "claude", cwd), undefined, screen);
assert.equal(workspaceTrustPrompt(codex + "\nTrusting will apply to the repository root:", "codex", cwd), undefined);
assert.equal(workspaceTrustPrompt(codex.replace(cwd, cwd + "/../authorized-workspace"), "codex", cwd)?.choice, 0);
assert.equal(workspaceTrustPrompt(claude, "claude", cwd, () => { throw new Error("missing path"); }), undefined);
assert.equal(startupConfirmation(claude), true);
assert.equal(startupConfirmation("Would you like to proceed?\n› 1. Yes, proceed once"), true);
assert.equal(startupConfirmation("❯ 2. Bypass permissions"), true);
assert.equal(startupConfirmation("❯ Try \"write a test\""), false);

// CodeBuddy 四选项目录信任选择器 — 2026-10-20 本机实测真屏 (v2.167.0, 200x60, 边框已按 linesOf 剥法保留)。
const cbdCwd = "/Users/zyy/develop/Guxi11/trust-probe";
const cbd = `╭────────────────────────────╮
│ Do you trust the files in this folder?                                                                                                                                                               │
│                                                                                                                                                                                                      │
│ ${cbdCwd}                                                                                                                                                     │
│                                                                                                                                                                                                      │
│ CodeBuddy Code may read, write, or execute files contained in this directory. This can pose security risks, so only use files and bash commands from trusted sources.                                │
│                                                                                                                                                                                                      │
│ Learn more ( https://copilot.tencent.com/docs/cli )                                                                                                                                                  │
│                                                                                                                                                                                                      │
│   > 1. Trust folder only (trust-probe)                                                                                                                                                               │
│     2. Trust parent folder (Guxi11/**)                                                                                                                                                               │
│     3. Trust folder and all subdirectories (trust-probe/**)                                                                                                                                          │
│     4. No, exit (escape)                                                                                                                                                                             │
│                                                                                                                                                                                                      │
│ Enter to confirm • Esc to exit                                                                                                                                                                       │
│                                                                                                                                                                                                      │
╰──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────╯`;
assert.equal(codebuddyTrustPrompt(cbd, cbdCwd)?.selected, 0);
assert.deepEqual(codebuddyTrustPrompt(cbd, cbdCwd)?.labels, [
  "Trust folder only (trust-probe)", "Trust parent folder (Guxi11/**)",
  "Trust folder and all subdirectories (trust-probe/**)", "No, exit (escape)",
]);
// 高亮不在第 1 项: 同一形状仍认, selected 换位 (按键策略由 spawn-tmux 按它分支)。
assert.equal(codebuddyTrustPrompt(cbd.replace("> 1. Trust", "  1. Trust").replace("  2. Trust", "> 2. Trust"), cbdCwd)?.selected, 1);
// devcloud 尾行变体 (圆点 · / (escape))。选项行一律要求数字前缀 —— 真屏形状, 不臆造变体。
assert.equal(codebuddyTrustPrompt(cbd.replace("Enter to confirm • Esc to exit", "Enter to confirm · Esc to cancel (escape)"), cbdCwd)?.selected, 0);
// 任一形状不符 → undefined (退回只通知路径): 别的目录、缺尾行、多出的数字选项、另需授权语义、无高亮。
for (const screen of [
  cbd.replace(cbdCwd, "/Users/zyy/develop/Tencent/other"),
  cbd.replace("Enter to confirm • Esc to exit", ""),
  cbd.replace("│   > 1. Trust folder only (trust-probe)", "│   > 1. Trust folder only (trust-probe)\n│     5. Trust everything and bypass permissions"),
  cbd.replace("Learn more", "Trusting will apply to the repository root"),
  cbd.replace("> 1. Trust", "  1. Trust").replace("  2. Trust", "  2. Trust"),
  cbd.replace("Trust folder only (trust-probe)", "Trust folder only (somewhere-else)"),
  cbd.replace("Trust parent folder (Guxi11/**)", "Trust parent folder (other/**)"),
  cbd + "\n❯ 1. Yes, proceed once",
]) assert.equal(codebuddyTrustPrompt(screen, cbdCwd), undefined, screen);
assert.equal(codebuddyTrustPrompt(cbd, cbdCwd, () => { throw new Error("missing path"); }), undefined);
// 两选项 (claude/codex 形状) 不归四选择器管, 反之亦然。
assert.equal(codebuddyTrustPrompt(claude, cwd), undefined);
assert.equal(workspaceTrustPrompt(cbd, "codebuddy", cbdCwd), undefined);

const fixture = { theme: "dark", projects: {
  [cwd]: { hasClaudeMdExternalIncludesApproved: false, hasClaudeMdExternalIncludesWarningShown: false, allowedTools: ["Read"], thirdParty: 42 },
  "/other": { hasTrustDialogAccepted: false },
} };
const patched = workspaceTrustConfig(JSON.stringify(fixture), cwd);
const value = JSON.parse(patched);
assert.deepEqual(value.projects[cwd], { ...fixture.projects[cwd], hasTrustDialogAccepted: true, projectOnboardingSeenCount: 1 });
assert.deepEqual(value.projects["/other"], fixture.projects["/other"]);
assert.equal(value.theme, "dark");
assert.equal(workspaceTrustConfig(patched, cwd), patched);
assert.equal(JSON.parse(workspaceTrustConfig("{}", cwd)).projects[cwd].hasClaudeMdExternalIncludesApproved, undefined);
for (const text of ["{", "null", "[]", '{"projects":[]}', '{"projects":null}', JSON.stringify({ projects: { [cwd]: null } })]) {
  assert.throws(() => workspaceTrustConfig(text, cwd));
}

const root = mkdtempSync(join(tmpdir(), "wezard-trust-test-"));
try {
  const physical = join(root, "physical");
  const alias = join(root, "alias");
  mkdirSync(physical);
  symlinkSync(physical, alias);
  assert.equal(workspaceTrustPrompt(claude.replace(cwd, physical), "claude", alias, realpathSync)?.choice, 1);
  assert.equal(workspaceTrustPrompt(claude.replace(cwd, root), "claude", alias, realpathSync), undefined);
} finally { rmSync(root, { recursive: true, force: true }); }
console.log("Workspace trust parsing, directory scope, navigation targets and config preservation checks passed");
