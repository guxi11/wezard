import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, appendFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "jsonc-parser";
import { inspectCodexHooks, codexHookLaunchArgs, codexHookCommand } from "../shared/codex-hooks.js";
import { syncCodexHooks } from "../cli/codex-sync.js";

const root = mkdtempSync(join(tmpdir(), "wezard-codex-hooks-"));
const path = join(root, "hooks.json");
const bin = process.env.WEZARD_TEST_CODEX_BIN ?? "codex";
const cwd = process.cwd();
const command = codexHookCommand(join(root, "wezard.jsonc"), "http://127.0.0.1:17890", join(cwd, "dist/cli/codex-hook.js"));
writeFileSync(join(root, "config.toml"), "");
writeFileSync(path, JSON.stringify({ description: "third-party hook stays untouched", hooks: { PreToolUse: [{ matcher: "Read", hooks: [{ type: "command", command: "/bin/echo third-party", timeout: 10 }, { type: "command", command: "/bin/echo trusted-third-party", timeout: 10 }] }] } }));
try {
  await syncCodexHooks(path, bin, cwd, command, 43220, false);
  let hooks = await inspectCodexHooks(bin, cwd, [], root);
  assert.equal(hooks.filter((h) => h.command === command && h.trustStatus === "trusted").length, 3);
  assert.equal(hooks.find((h) => h.command === "/bin/echo third-party")?.trustStatus, "untrusted");
  const trusted = hooks.find((h) => h.command === "/bin/echo trusted-third-party")!;
  appendFileSync(join(root, "config.toml"), `\n[hooks.state.${JSON.stringify(trusted.key)}]\ntrusted_hash = ${JSON.stringify(trusted.currentHash)}\nenabled = true\n`);
  await syncCodexHooks(path, bin, cwd, command, 43220, false);
  hooks = await inspectCodexHooks(bin, cwd, [], root);
  assert.equal(hooks.filter((h) => h.command === command).length, 3, "sync is idempotent");
  const originalHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = root;
  try {
    const args = await codexHookLaunchArgs(bin, cwd, command, 43220);
    const launched = await inspectCodexHooks(bin, cwd, args, root);
    const active = launched.filter((h: any) => h.enabled && h.command === command);
    assert.equal(active.length, 3, "global + session hooks cannot cause duplicate cards");
    assert.ok(active.every((h) => h.trustStatus === "trusted"));
    assert.equal(launched.find((h) => h.command === "/bin/echo third-party")?.trustStatus, "untrusted");
    assert.equal(launched.find((h) => h.command === "/bin/echo trusted-third-party")?.trustStatus, "trusted", "invocation overrides preserve existing third-party trust");
  } finally { if (originalHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = originalHome; }
  await syncCodexHooks(path, bin, cwd, command, 43220, true);
  const final = parse(readFileSync(path, "utf8"));
  assert.equal(final.description, "third-party hook stays untouched");
  hooks = await inspectCodexHooks(bin, cwd, [], root);
  assert.equal(hooks.filter((h) => h.command === command).length, 0);
  assert.equal(hooks.find((h) => h.command === "/bin/echo third-party")?.trustStatus, "untrusted");
  assert.equal(hooks.find((h) => h.command === "/bin/echo trusted-third-party")?.trustStatus, "trusted");
} finally { rmSync(root, { recursive: true, force: true }); }
console.log("Real Codex hook parsing/trust/idempotence/remove checks passed");
