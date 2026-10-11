import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codexSessions, normalizeCodex } from "../shared/codex.js";
import { bindCliBackends, backendForPath, resolveCliBackend } from "../shared/cli-backends.js";
import { submittedSince, probeOf } from "../daemon/cc-session.js";
import { ConfigSchema } from "../shared/config.js";
import { talkRounds } from "../daemon/peers.js";

const wrap = (payload: unknown) => ({ type: "response_item", timestamp: "2026-10-11T00:00:00Z", payload });
assert.equal(normalizeCodex(wrap({ type: "message", role: "developer", content: [] })), null);
assert.equal(normalizeCodex(wrap({ type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] }))?.message?.content, "hello");
const instructions = "# AGENTS.md instructions for /project\n\n<INSTRUCTIONS>Repository rules</INSTRUCTIONS>";
const environment = "<environment_context>cwd: /project</environment_context>";
const userLine = (text: string) => wrap({ type: "message", role: "user", content: [{ type: "input_text", text }] });
for (const context of [instructions, environment, `${instructions}\n${environment}`])
  assert.equal(normalizeCodex(userLine(context))?.isMeta, true);
const peerPrompt = 'Check tiers\n<system-reminder wezard="envelope" kind="peer" from=".wezard-old" scope="private" turn="t123456">Task</system-reminder>';
for (const text of [peerPrompt, `${instructions}\n${peerPrompt}`, `Explain ${environment}`, `${environment}\nhello`])
  assert.notEqual(normalizeCodex(userLine(text))?.isMeta, true);
assert.notEqual(normalizeCodex(wrap({ type: "message", role: "user", content: [{ type: "input_text", text: environment }, { type: "input_image" }] }))?.isMeta, true);
const commentary = normalizeCodex(wrap({ type: "message", role: "assistant", phase: "commentary", content: [{ type: "output_text", text: "working" }] }));
assert.equal(commentary?.message?.stop_reason, undefined);
assert.equal(commentary?.timestamp, "2026-10-11T00:00:00Z");
assert.equal(normalizeCodex(wrap({ type: "message", role: "assistant", phase: "final_answer", content: [] }))?.message?.stop_reason, "end_turn");
const call = normalizeCodex(wrap({ type: "function_call", name: "exec_command", call_id: "c1", arguments: '{"cmd":"pwd"}' }));
assert.deepEqual((call?.message?.content as any[])[0].input, { cmd: "pwd" });
assert.equal((normalizeCodex(wrap({ type: "custom_tool_call_output", call_id: "c1", output: "ok" }))?.message?.content as any[])[0].tool_use_id, "c1");
assert.equal(normalizeCodex({ type: "event_msg", payload: { type: "agent_message", message: "duplicate" } }), null);
assert.equal(normalizeCodex(wrap({ type: "reasoning", encrypted_content: "secret", summary: [] })), null);
assert.equal(normalizeCodex({ type: "turn_context", payload: { model: "gpt-6.1-sol", effort: "high" } })?.message?.model, "gpt-6.1-sol");
assert.deepEqual(normalizeCodex({ type: "token_usage_record", payload: { usage: { input_tokens: 100, cached_input_tokens: 70, output_tokens: 8 } } })?.message?.usage,
  { input_tokens: 100, cache_creation_input_tokens: 0, cache_read_input_tokens: 70, output_tokens: 8 });
assert.equal(normalizeCodex({ type: "event_msg", payload: { type: "token_count", info: {} } }), null);
assert.equal(resolveCliBackend({ defaultCli: "codex", cliBackends: { codex: { bin: "/opt/codex" } } }).bin, "/opt/codex");
assert.equal(resolveCliBackend({ claudeBin: "/opt/codex" }).name, "codex");
const root = mkdtempSync(join(tmpdir(), "wezard-codex-"));
try {
  const dir = join(root, "2026", "10", "11");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "rollout-date-session.jsonl");
  writeFileSync(path, JSON.stringify({ type: "session_meta", payload: { id: "session", cwd: "/project" } }) + "\n");
  writeFileSync(join(dir, "broken.jsonl"), "broken");
  assert.deepEqual(codexSessions(root, "/project"), [{ sessionId: "session", jsonlPath: path }]);
  assert.deepEqual(codexSessions(root, "/other"), []);
  const witness = join(dir, "witness.jsonl");
  writeFileSync(witness, JSON.stringify(wrap({ type: "message", role: "user", content: [{ type: "input_text", text: "hello codex" }] })) + "\n");
  assert.equal(submittedSince([{ path: witness, offset: 0 }], probeOf("hello codex"), Date.parse("2026-10-10T00:00:00Z")), true);
  assert.equal(submittedSince([{ path: witness, offset: 0 }], probeOf("hello codex"), Date.parse("2026-10-12T00:00:00Z")), false);
  bindCliBackends({ defaultCli: "codex", projectsDirOverride: root });
  assert.equal(backendForPath(path).name, "codex");
  writeFileSync(witness, [userLine(`${instructions}\n${environment}`), userLine(peerPrompt), wrap({ type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: "RESULT: checked" }] })].map((r) => JSON.stringify(r)).join("\n") + "\n");
  const rounds = talkRounds(witness, 10);
  assert.equal(rounds.length, 1, "repository context must not create a human conversation");
  assert.equal(rounds[0]?.[0]?.env?.from, ".wezard-old");
  assert.equal(rounds[0]?.[0]?.env?.private, true);
  assert.equal(rounds[0]?.at(-1)?.text, "RESULT: checked");
  assert.equal(ConfigSchema.parse({ bot: { botId: "id", secret: "secret" }, wrc: { defaultCli: "codex" } }).wrc.claudeBin, "codex");
} finally { rmSync(root, { recursive: true, force: true }); bindCliBackends({}); }
console.log("Codex backend checks passed");
