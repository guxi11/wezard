import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { startMirrorTail } from "../daemon/mirror-bridge.js";
import { bindCliBackends } from "../shared/cli-backends.js";
import { normalizeCodex } from "../shared/codex.js";
import { createDetailStore, type TurnDetailRecord } from "../shared/detail-store.js";
import { summarizeTag } from "../shared/chat-view.js";
import { roleStats } from "../shared/role-view.js";
import { modelLabel } from "../shared/pricing.js";

const root = mkdtempSync(join(tmpdir(), "wezard-initial-tier-"));
const target = "user:test#tier";
const now = Date.now();
try {
  for (const cli of ["claude", "codex"] as const) {
    const store = createDetailStore({ stateDir: join(root, cli, "details") });
    const initialModel = cli === "claude" ? "opus" : "gpt-6.1-sol";
    const actualModel = cli === "claude" ? "claude-opus-4-6" : "gpt-6-astra";
    const seed = { target, sessionId: cli, cli, initialModel, initialEffort: "medium", createdAt: now };
    store.startTurn({ ...seed, id: "first" });
    const current = () => store.get("first") as TurnDetailRecord;
    const summary = () => summarizeTag(target, store.list().filter((r): r is TurnDetailRecord => r.kind === "turn"), now);
    assert.equal(summary().model, initialModel);
    assert.equal(summary().modelLabel, modelLabel(initialModel));
    assert.equal(summary().effort, "medium");
    assert.equal(current().model, undefined, "placeholder must not be recorded as a billed model");
    assert.equal(summary().usage.calls, 0);
    for (let i = 0; i < 3; i++) {
      store.appendTurnItem("first", { t: "tool_use", toolName: "exec", toolUseId: `early-${i}`, ts: now });
      assert.equal(summary().model, initialModel, "early tools must retain the initial tier");
    }
    const transcript = join(root, cli, "session.jsonl");
    writeFileSync(transcript, "");
    bindCliBackends({ defaultCli: cli, projectsDirOverride: join(root, cli) });
    const tail = startMirrorTail({
      jsonlPath: transcript, sessionId: cli, target, log: pino({ level: "silent" }),
      includeUser: false, includeTools: true, includeToolResults: true,
      toolResultMaxChars: 100, toolUseInlineMaxChars: 100,
      isOwnInject: () => false, detailUrlFor: () => "",
      ...(cli === "codex" ? { normalizeLine: normalizeCodex } : {}),
      onItem: (item) => {
        if (item.kind === "turn_usage") store.addTurnUsage("first", item);
      },
    });
    const append = (record: unknown) => {
      appendFileSync(transcript, JSON.stringify(record) + "\n");
      tail.drain();
    };
    try {
      if (cli === "codex") {
        append({ type: "turn_context", payload: { model: actualModel, effort: "high" } });
        assert.equal(summary().model, actualModel, "Codex context replaces the placeholder before token usage");
        assert.equal(summary().effort, "high");
        assert.equal(current().usage, undefined, "tier metadata must not invent token usage");
        append({ type: "token_usage_record", payload: { response_id: "response", usage: { input_tokens: 100, cached_input_tokens: 70, output_tokens: 8 } } });
      } else {
        append({ type: "assistant", effort: "high", message: { role: "assistant", model: actualModel, id: "response", content: [], usage: { input_tokens: 100, cache_read_input_tokens: 70, output_tokens: 8 } } });
      }
      assert.equal(summary().model, actualModel);
      assert.equal(summary().effort, "high");
      assert.equal(current().modelAlt, undefined, "replacing a placeholder is not a model switch");
      const usage = { ...current().usage };
      store.addTurnUsage("first", { effort: "low" });
      assert.deepEqual(current().usage, usage, "metadata updates preserve token totals and context");
      assert.equal(summary().effort, "low");
      store.addTurnUsage("first", { model: actualModel, messageId: "response", usage: { input: 999, output: 999, cacheRead: 0, cacheWrite: 0, calls: 1 } });
      assert.deepEqual(current().usage, usage, "split assistant lines remain deduplicated");
      store.startTurn({ ...seed, id: "next", createdAt: now + 1 });
      assert.equal(summary().model, actualModel, "a later empty turn must not revert to the startup alias");
      assert.equal(summary().effort, "low");
      store.startTurn({ ...seed, id: "new-session", sessionId: "fresh", initialModel: "new-model", initialEffort: "xhigh", createdAt: now + 2 });
      assert.equal(summary().model, "new-model", "a previous session's actual tier must not replace the new placeholder");
      assert.equal(summary().effort, "xhigh");
      store.startTurn({ id: "subagent", target, sessionId: "fresh", model: "child-model", effort: "low", agent: { id: "child" }, createdAt: now + 3 });
      assert.equal(summary().model, "new-model", "subagents must not overwrite the session placeholder");
      assert.equal(roleStats(store.list(), target, now)?.model, "new-model");
      const replay = createDetailStore({ stateDir: join(root, cli, "details") });
      assert.equal((replay.get("new-session") as TurnDetailRecord).initialModel, "new-model", "placeholder survives daemon reload");
    } finally { tail.stop(); }
  }
  const old: TurnDetailRecord = { kind: "turn", id: "old", target, createdAt: now, updatedAt: now, closed: false, items: [] };
  assert.equal(summarizeTag(target, [old], now).model, undefined, "unspecified tiers retain the legacy fallback");
  console.log("Initial usage tier checks passed");
} finally { rmSync(root, { recursive: true, force: true }); }
