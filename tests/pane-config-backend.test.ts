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
  const recordedBackend = resolveCliBackend({ ...cfg.wrc, defaultCli: "claude" });
  assert.equal(recordedBackend.name, "claude");
  assert.equal(recordedBackend.bin, "claude");
} finally { bindCliBackends({}); }
console.log("Pane backend follows configured default; Codex binary remains built in and recorded sessions resolve independently");
