import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareCodexSession } from "../shared/codex-hooks.js";

// Real Codex CLI, isolated state, no credentials or model turns.
const home = mkdtempSync(join(tmpdir(), "wezard-codex-session-"));
const previous = process.env.CODEX_HOME;
process.env.CODEX_HOME = home;
const bin = process.env.WEZARD_TEST_CODEX_BIN ?? "codex";
try {
  const first = await prepareCodexSession(bin, process.cwd(), "empty", [], {});
  const second = await prepareCodexSession(bin, process.cwd(), "other", [], {});
  assert.notEqual(first.sessionId, second.sessionId, "same cwd sessions stay distinct");
  const resumed = await prepareCodexSession(bin, process.cwd(), "resume", [], { resumeSessionId: first.sessionId });
  assert.equal(resumed.sessionId, first.sessionId);
  const forked = await prepareCodexSession(bin, process.cwd(), "fork", [], { resumeSessionId: first.sessionId, forkSession: true });
  assert.notEqual(forked.sessionId, first.sessionId);
  for (const session of [first, second, resumed, forked]) {
    const records = readFileSync(session.jsonlPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(records[0].type, "session_meta");
    assert.equal(records[0].payload.id, session.sessionId);
    assert.ok(!records.some((r) => r.type === "turn_context" || r.type === "response_item"), "preparation does not start a turn");
  }
  console.log("Codex native empty session/start/resume/fork: passed");
} finally {
  if (previous === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = previous;
  rmSync(home, { recursive: true, force: true });
}
