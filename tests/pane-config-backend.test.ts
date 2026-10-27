import assert from "node:assert/strict";
import { ConfigSchema } from "../shared/config.js";
import { bindCliBackends, resolveCliBackend } from "../shared/cli-backends.js";
import { backendFor } from "../daemon/spawn-tmux.js";

// A stale process registry must not override the current configuration.
bindCliBackends({ defaultCli: "claude" });
try {
  const cfg = ConfigSchema.parse({ bot: { botId: "test", secret: "test" }, wrc: {
    defaultCli: "codex", cliBackends: { codex: { bin: "/legacy/custom-codex" } },
  } });
  assert.equal(backendFor(cfg).name, "codex");
  assert.equal(backendFor(cfg).bin, "codex");
  assert.equal("bin" in cfg.wrc.cliBackends.codex, false, "retired Codex bin config is ignored by the schema");
  // Resume and fork both retain the transcript's backend; fork changes the
  // session operation, not backend resolution.
  for (const forkSession of [false, true]) {
    const request = { resumeSessionId: "recorded-claude-session", forkSession, cli: "claude" as const };
    const recordedBackend = request.resumeSessionId && request.cli
      ? resolveCliBackend({ ...cfg.wrc, defaultCli: request.cli })
      : backendFor(cfg);
    assert.equal(recordedBackend.name, "claude", forkSession ? "fork retains transcript backend" : "resume retains transcript backend");
    assert.equal(recordedBackend.bin, "claude");
  }
} finally { bindCliBackends({}); }
console.log("Pane backend follows configured default; Codex binary remains built in and recorded sessions resolve independently");
