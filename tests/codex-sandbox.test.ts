import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigSchema } from "../shared/config.js";
import { resolve } from "../shared/config-meta.js";
import { codexSandboxMode, codexSandboxLaunchArgs, codexSandboxArgConflict, prepareCodexSession } from "../shared/codex-hooks.js";

const base = { bot: { botId: "test", secret: "test" } };
assert.equal(ConfigSchema.parse(base).wrc.cliBackends.codex.sandbox, false);
assert.equal(ConfigSchema.parse({ ...base, wrc: { cliBackends: { codex: { bin: "/opt/codex" } } } }).wrc.cliBackends.codex.sandbox, false);
assert.equal(resolve(ConfigSchema, "wrc.cliBackends.codex.sandbox".split("."))?.gate, "card");
assert.throws(() => ConfigSchema.parse({ ...base, wrc: { cliBackends: { codex: { sandbox: "false" } } } }));
for (const flag of ["--sandbox", "--sandbox=read-only", "-s", "-sread-only", "--full-auto", "--approve-for-me", "--yolo", "--dangerously-bypass-approvals-and-sandbox"]) {
  assert.equal(codexSandboxArgConflict([flag]), flag);
}
assert.equal(codexSandboxArgConflict(["--search", "--strict-config", "-c", 'sandbox_mode="read-only"', "--ask-for-approval", "on-request"]), undefined);

// A protocol fake checks the actual subprocess argv and start/resume/fork payloads.
const root = mkdtempSync(join(tmpdir(), "wezard-sandbox-"));
const bin = join(root, "codex");
const capture = join(root, "requests.jsonl");
writeFileSync(bin, `#!${process.execPath}
const fs = require('node:fs');
const rl = require('node:readline').createInterface({ input: process.stdin });
fs.appendFileSync(${JSON.stringify(capture)}, JSON.stringify({ argv: process.argv.slice(2) }) + '\\n');
rl.on('line', line => {
  const request = JSON.parse(line);
  fs.appendFileSync(${JSON.stringify(capture)}, line + '\\n');
  if (request.id) console.log(JSON.stringify({ id: request.id, result: request.id === 2 ? { thread: { id: 'test-thread', path: '/test/rollout.jsonl' } } : {} }));
});
`, { mode: 0o755 });
try {
  for (const enabled of [false, true]) {
    const cfg = ConfigSchema.parse({ ...base, wrc: { cliBackends: { codex: { sandbox: enabled } } } });
    assert.equal(cfg.wrc.cliBackends.codex.sandbox, enabled);
    for (const options of [{}, { resumeSessionId: "parent" }, { resumeSessionId: "parent", forkSession: true }]) {
      const args = codexSandboxLaunchArgs(enabled);
      await prepareCodexSession(bin, root, "sandbox-test", args, { ...options, sandboxMode: codexSandboxMode(enabled) });
    }
  }
  const records = readFileSync(capture, "utf8").trim().split("\n").map(line => JSON.parse(line));
  const launches = records.filter(r => r.argv);
  const requests = records.filter(r => r.id === 2);
  assert.deepEqual(requests.map(r => r.method), ["thread/start", "thread/resume", "thread/fork", "thread/start", "thread/resume", "thread/fork"]);
  requests.forEach((r, i) => {
    assert.equal(r.params.sandbox, i < 3 ? "danger-full-access" : "workspace-write");
    assert.equal("approvalPolicy" in r.params, false, "sandbox must not change native approval");
    assert.deepEqual(launches[i].argv, ["app-server", "--enable", "hooks", "-c", `sandbox_mode=${JSON.stringify(r.params.sandbox)}`]);
  });
} finally { rmSync(root, { recursive: true, force: true }); }
console.log("Codex sandbox defaults, validation and start/resume/fork protocol checks passed");
