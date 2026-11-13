import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLI_BACKEND_DEFAULTS } from "../shared/cli-backends.js";
import { charterFacts, charterPreamble, charterToRearm, shouldRearmCharter } from "../shared/charter-rearm.js";
import { loadMirrorStore, type MirrorAttachment } from "../daemon/mirror-store.js";

const claude = CLI_BACKEND_DEFAULTS.claude.normalizeTranscriptLine;
const codebuddy = CLI_BACKEND_DEFAULTS.codebuddy.normalizeTranscriptLine;
const CH = charterPreamble("我是 BobSmith");

// claude: {"type":"user","message":{"content":…}}; codebuddy: {"type":"message","role":"user",…}
const claudeUser = (text: string) => JSON.stringify({ type: "user", message: { role: "user", content: text } });
const cbUser = (text: string) => JSON.stringify({ type: "message", role: "user", content: [{ type: "input_text", text }] });
const claudeAssistant = (text: string) => JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } });
const cbAssistant = (text: string) => JSON.stringify({ type: "message", role: "assistant", content: [{ type: "output_text", text }] });
const cbMeta = () => JSON.stringify({ type: "file-history-snapshot", snapshot: {} });

// ── 纯解析: 两种方言各认一遍 ─────────────────────────────────────────
assert.deepEqual(charterFacts([claudeUser(CH + "在吗")].join("\n"), claude), { spoke: true, delivered: true });
assert.deepEqual(charterFacts([cbMeta(), cbUser(CH + "在吗")].join("\n"), codebuddy), { spoke: true, delivered: true });
// 宪章块在正文中间也算 (注入时 preamble 可以跟在引用的旧信封后面)
assert.deepEqual(charterFacts([claudeUser("先说一句\n" + CH)].join("\n"), claude), { spoke: true, delivered: true });
// assistant 行里的字面量不是送达
assert.deepEqual(
  charterFacts([claudeUser("你好"), claudeAssistant(CH + "复述宪章")].join("\n"), claude),
  { spoke: true, delivered: false },
);
assert.deepEqual(
  charterFacts([cbUser("你好"), cbAssistant(CH)].join("\n"), codebuddy),
  { spoke: true, delivered: false },
);
// 工具结果 (user 形状的 tool_result 行) 里的字面量也不是送达, 也不算开口
const toolResult = JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: CH }] } });
assert.deepEqual(charterFacts([toolResult].join("\n"), claude), { spoke: false, delivered: false });
// 空文件
assert.deepEqual(charterFacts("", claude), { spoke: false, delivered: false });

// ── 判据各分支 (走真文件 + 真后端解析) ───────────────────────────────
const dir = mkdtempSync(join(tmpdir(), "wezard-charter-rearm-"));
const at = (name: string, lines: string[]): string => {
  const path = join(dir, name);
  writeFileSync(path, lines.length ? lines.join("\n") + "\n" : "");
  return path;
};
const check = (label: string, input: { cli?: string; owed?: boolean; jsonlPath: string }, want: boolean): void => {
  assert.equal(shouldRearmCharter(input), want, label);
};

// codex: 宪章在 developer_instructions, 永远不武装 (连文件都不读)
check("codex 恒 false", { cli: "codex", owed: true, jsonlPath: join(dir, "nope.jsonl") }, false);
// transcript 不存在 = 新起没开口
check("无文件 → 武装", { cli: "claude", owed: false, jsonlPath: join(dir, "missing.jsonl") }, true);
// 只有 session-meta = 新起没开口
check("无 user 行 → 武装", { cli: "claude", jsonlPath: at("meta-only.jsonl", [cbMeta()]) }, true);
// 落盘标记 true = 挂上过没送达
const spokeOnly = at("spoke-only.jsonl", [claudeUser("帮我看看这个 bug")]);
check("标记 true → 武装", { cli: "claude", owed: true, jsonlPath: spokeOnly }, true);
// 老会话 (2.9.0 之前的 system prompt 宪章): 有 user 行、无宪章块、无标记
check("老会话 → 不武装", { cli: "claude", owed: false, jsonlPath: spokeOnly }, false);
// 已送达 (user 行里带宪章块): 即便标记还在也不再发
const delivered = at("delivered.jsonl", [claudeUser(CH + "在吗")]);
check("已送达 → 不武装", { cli: "claude", owed: true, jsonlPath: delivered }, false);
// 字面量只在 assistant 行: 不算送达, 标记说了算
const assistantOnly = at("assistant-only.jsonl", [claudeUser("你好"), claudeAssistant(CH)]);
check("assistant 字面量不算送达 (标记 true) → 武装", { cli: "claude", owed: true, jsonlPath: assistantOnly }, true);
check("assistant 字面量不算送达 (无标记, 有 user 行) → 不武装", { cli: "claude", owed: false, jsonlPath: assistantOnly }, false);
// codebuddy 方言的已送达
check("codebuddy 已送达 → 不武装", { cli: "codebuddy", owed: true, jsonlPath: at("cb-delivered.jsonl", [cbMeta(), cbUser(CH + "在吗")]) }, false);
// 首条 user 行只是斜杠命令: 宪章还没来 → 标记决定
check("只有 /clear 行 (无标记) → 不武装", { cli: "claude", owed: false, jsonlPath: at("slash.jsonl", [claudeUser("<command-name>/clear</command-name>")]) }, false);
check("只有 /clear 行 (标记 true) → 武装", { cli: "claude", owed: true, jsonlPath: at("slash2.jsonl", [claudeUser("<command-name>/clear</command-name>")]) }, true);

// ── 夹具: 新起/领用 → reload → 首条消息 ─────────────────────────────
const transcript = join(dir, "fresh-session.jsonl");
writeFileSync(transcript, cbMeta() + "\n"); // codebuddy 新会话: 只有 session-meta, 还没开口
const storePath = join(dir, "mirror-attachments.json");
const record = (owed?: boolean): MirrorAttachment => ({
  sessionId: "11111111-2222-3333-4444-555555555555",
  jsonlPath: transcript,
  tmuxSession: "wezard",
  tmuxPane: "%42",
  cwd: "/tmp",
  ...(owed ? { charterOwed: true } : {}),
});
loadMirrorStore(storePath).set("chat:reload-case", record(true));

// reload: 进程内状态全丢, 只剩盘上的记录
const afterReload = loadMirrorStore(storePath).get("chat:reload-case");
assert.equal(afterReload?.charterOwed, true, "标记必须活过 reload");

const armed = charterToRearm({
  cli: "codebuddy",
  owed: afterReload?.charterOwed,
  jsonlPath: transcript,
  render: () => "我是 BobSmith",
});
assert.ok(armed, "reload 后首条消息必须重新武装宪章");
const firstInject = charterPreamble(armed!) + "在吗";
assert.ok(firstInject.startsWith('<system-reminder wezard="charter">'), "首条注入必须以宪章块开头");

// 注入落地 (CLI 把这句话连同 preamble 写进 transcript), 注入方确认 ok → 清标记
appendFileSync(transcript, cbUser(firstInject) + "\n");
const store = loadMirrorStore(storePath);
store.set("chat:reload-case", record(undefined));
const afterInject = loadMirrorStore(storePath).get("chat:reload-case");
assert.equal(afterInject?.charterOwed, undefined, "注入 ok 后标记必须清掉");
const secondArmed = charterToRearm({ cli: "codebuddy", owed: afterInject?.charterOwed, jsonlPath: transcript, render: () => "我是 BobSmith" });
assert.equal(secondArmed, undefined, "第二条消息不再带宪章");
assert.ok(!((secondArmed ? charterPreamble(secondArmed) : "") + "第二条").includes('wezard="charter"'));

// 同一份转录再 reload 一次也不会补发 (已送达的硬证据)
assert.equal(
  charterToRearm({ cli: "codebuddy", owed: loadMirrorStore(storePath).get("chat:reload-case")?.charterOwed, jsonlPath: transcript, render: () => "我是 BobSmith" }),
  undefined,
);

rmSync(dir, { recursive: true, force: true });
console.log("Charter rearm predicate and reload fixture passed");
