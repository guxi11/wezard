import assert from "node:assert/strict";
import pino from "pino";
import { ConfigSchema } from "../shared/config.js";
import { bindCliBackends } from "../shared/cli-backends.js";
import { backendFor, spawnTmuxClaude } from "../daemon/spawn-tmux.js";

// A stale process registry must not override the current configuration.
bindCliBackends({ defaultCli: "claude" });
try {
  const cfg = ConfigSchema.parse({ bot: { botId: "test", secret: "test" }, wrc: { defaultCli: "codex" } });
  assert.equal(backendFor(cfg).name, "codex");
  assert.equal(backendFor(cfg).bin, "codex");
  // Reject before launching tmux or sending a foreign session ID to Codex.
  for (const forkSession of [false, true]) {
    const result = await spawnTmuxClaude({ cfg, log: pino({ level: "silent" }), cli: "claude", resumeSessionId: "old-claude-session", forkSession });
    assert.equal(result.ok, false);
    assert.match(result.reason!, /无法跨后端恢复或克隆/);
  }
} finally { bindCliBackends({}); }
console.log("Pane backend follows configuration and rejects foreign resume/fork");
