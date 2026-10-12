import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, symlinkSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startupConfirmation, workspaceTrustConfig, workspaceTrustPrompt } from "../shared/workspace-trust.js";

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
