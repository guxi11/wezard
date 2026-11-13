// 频道判官是一次性 `-p` 判定: 无会话、无工具、只回一行 JSON。
// 这里钉住三件会悄悄回退的事:
//   1. 一次性参数里不能出现会话参数 (--settings / --session-id / --resume),
//      否则判官的调用会重新长出 transcript + 审批卡;
//   2. 端口 / 帖子 / 回复 / msgid 与每条历史的 id 必须进 prompt —— 判官只判定,
//      目标 agent 靠这些 id 回帖与去重, 丢了就找不回来;
//   3. JSON 契约的措辞放末尾, 且 parseVerdict 要能容下代码围栏 / 多行 JSON。
import assert from "node:assert/strict";
import { ConfigSchema } from "../shared/config.js";
import { CLI_BACKEND_DEFAULTS } from "../shared/cli-backends.js";
import { buildJudgePrompt, parseVerdict } from "../daemon/channel.js";
import type { ChannelMsg } from "../daemon/channel-store.js";

const cfg = ConfigSchema.parse({ bot: { botId: "t", secret: "t" }, wrc: { defaultCli: "codebuddy" } });
assert.equal(cfg.wrc.channel.judge.tier, "mini", "判官默认走最简档");

// ── 一次性参数 ────────────────────────────────────────────────────────
for (const name of ["claude", "claude-internal", "codebuddy"] as const) {
  const build = CLI_BACKEND_DEFAULTS[name].oneShotArgs;
  assert(build, `${name} 必须支持一次性调用`);
  const args = build("PROMPT", { model: "m-1", effort: "low" });
  assert.equal(args[0], "-p");
  assert.equal(args[1], "PROMPT");
  assert.deepEqual(args.slice(args.indexOf("--output-format"), args.indexOf("--output-format") + 2), ["--output-format", "text"]);
  assert.deepEqual(args.slice(args.indexOf("--tools"), args.indexOf("--tools") + 2), ["--tools", ""], "判官不调用工具");
  assert(args.includes("--no-session-persistence"), "判官不能留下可 resume 的会话");
  assert.deepEqual(args.slice(args.indexOf("--model"), args.indexOf("--model") + 2), ["--model", "m-1"]);
  assert.deepEqual(args.slice(args.indexOf("--effort"), args.indexOf("--effort") + 2), ["--effort", "low"]);
  for (const forbidden of ["--settings", "--session-id", "--resume", "--continue", "--mcp-config"]) {
    assert(!args.includes(forbidden), `一次性调用不该带 ${forbidden}`);
  }
}
assert.equal(CLI_BACKEND_DEFAULTS.codex.oneShotArgs, undefined, "codex 没有 -p, 调用方必须回落");
assert.deepEqual(CLI_BACKEND_DEFAULTS.claude.oneShotArgs!("P", {}).filter((a) => a === "--model"), [], "没有 model 就不传 --model");

// ── prompt 带全定位信息 ────────────────────────────────────────────────
const msg = (id: string, kind: "post" | "reply", postId: string, at: number, author: string, text: string): ChannelMsg =>
  ({ id, kind, postId, at, author, text });
const prompt = buildJudgePrompt(cfg, {
  topicId: "topic-1",
  postId: "post-root",
  triggerId: "reply-9",
  msgid: "msg-abc",
  recent: [msg("post-a", "post", "post-a", 0, "user:a", "最近一条")],
  thread: [msg("post-root", "post", "post-root", 0, "user:b", "父帖正文"), msg("reply-9", "reply", "post-root", 0, "user:b", "评论正文")],
  latest: "评论正文",
  latestAuthor: "user:b",
});
for (const id of ["topic-1", "post-root", "reply-9", "msg-abc", "post-a"]) assert(prompt.includes(id), `prompt 丢了 ${id}`);
assert(prompt.includes("post=post-a"), "最近消息带上了它的 post id");
assert(prompt.includes("reply=reply-9"), "线程里的评论带上了 reply id");
assert(/只输出下面这一行 JSON/.test(prompt), "JSON 契约放在末尾");
assert(prompt.lastIndexOf("JSON") > prompt.indexOf("规则："), "最后的指令是输出 JSON, 不是规则");
// 新帖 (trigger == post) 不硬造 reply id
const fresh = buildJudgePrompt(cfg, { topicId: "t", postId: "p", triggerId: "p", msgid: "m", recent: [], thread: [], latest: "x", latestAuthor: "u" });
assert(!fresh.includes("本次消息 reply="), "新帖没有 reply 段");

// ── 判词解析 ──────────────────────────────────────────────────────────
assert.deepEqual(parseVerdict('{"respond":true,"reason":"r","intent":"i","rewrite":"w"}'), { respond: true, reason: "r", intent: "i", rewrite: "w" });
const fenced = "好的：\n```json\n{\n  \"respond\": true,\n  \"reason\": \"多行\",\n  \"rewrite\": \"含 { 花括号 } 的正文\"\n}\n```\n";
assert.deepEqual(parseVerdict(fenced), { respond: true, reason: "多行", rewrite: "含 { 花括号 } 的正文" });
assert.deepEqual(parseVerdict('{"respond":"false","reason":"闲聊","intent":"i","rewrite":"w"}'), { respond: false, reason: "闲聊" }, "respond=false 不采信 intent/rewrite");
assert.equal(parseVerdict("我觉得可以回答"), undefined, "没有 JSON 也没有 yes/no 就是没结论");
assert.deepEqual(parseVerdict("no idea"), { respond: false, reason: "no idea" });
console.log("channel-judge ok");
