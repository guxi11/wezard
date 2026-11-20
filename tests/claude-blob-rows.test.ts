// Claude Code 2.1.3xx 的 api-request-blob 行带 message.content 但不是对话轮:
// 当成轮读, 一个找不到配对 tool_result 的 blob tool_use 让 openToolUses 永远报「悬着」,
// 闲着的 wizard 被 isBusy 判忙, room 泵把给它的回执一直压着。
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeClaude } from "../shared/cli-backends.js";
import { openToolUses } from "../daemon/peers.js";

const blob = (role: string, content: unknown[]) => ({ type: "api-request-blob", sessionId: "s", hash: "h" + Math.random(), message: { role, content } });
assert.equal(normalizeClaude(blob("assistant", [{ type: "tool_use", id: "t1", name: "Bash" }])), null);
const turn = { type: "assistant", uuid: "u", message: { role: "assistant", content: [{ type: "text", text: "hi" }] } };
assert.deepEqual(normalizeClaude(turn), turn);
assert.equal(normalizeClaude(null), null);

const home = mkdtempSync(join(tmpdir(), "wz-blob-"));
try {
  const dir = join(home, ".claude", "projects", "-p");
  mkdirSync(dir, { recursive: true });
  const jsonl = join(dir, "s.jsonl");
  const rows = [
    { type: "user", uuid: "1", message: { role: "user", content: "do it" } },
    blob("assistant", [{ type: "tool_use", id: "orphan", name: "Bash" }]),
    { type: "assistant", uuid: "2", message: { role: "assistant", content: [{ type: "tool_use", id: "t2", name: "Read" }] } },
    { type: "user", uuid: "3", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t2" }] } },
    { type: "assistant", uuid: "4", message: { role: "assistant", content: [{ type: "text", text: "done" }] } },
  ];
  writeFileSync(jsonl, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  assert.deepEqual(openToolUses(jsonl), []);
  // 真悬着的调用照旧报出来
  writeFileSync(jsonl, rows.slice(0, 3).map((r) => JSON.stringify(r)).join("\n") + "\n");
  assert.deepEqual(openToolUses(jsonl), ["Read"]);
} finally { rmSync(home, { recursive: true, force: true }); }
console.log("claude-blob-rows ok");
