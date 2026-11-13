// v3 P7-S3 ③ 频道 strict: 终句不包装成评论 (验收数字②: strict 频道终句评论 0 条)、
// 工具面 (sendTopicContent) 按 replyOk 选评论/新帖、判官 prompt 的 strict 段。
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { ConfigSchema, type Config } from "../shared/config.js";
import {
  buildJudgePrompt,
  installChannelEvents,
  installChannelTransport,
  registerTopic,
  sendTopicContent,
} from "../daemon/channel.js";
import { resetKnownChatsCache } from "../daemon/chat-seen.js";

const ROOT = mkdtempSync(join(tmpdir(), "strict-channel-"));
const log = pino({ level: "silent" });

const cfgOf = (speech: "strict" | "implicit"): Config =>
  ConfigSchema.parse({
    bot: { botId: "test", secret: "test" },
    daemon: { stateDir: join(ROOT, "state") },
    chatPolicy: { "chat:topicS": { speech } },
    wrc: { allowFrom: ["user:tester"], channel: { history: { enabled: false } } },
    defaultChat: "user:home",
  });
const cfgStrict = cfgOf("strict");
const cfgImplicit = cfgOf("implicit");

// ── 1. 判官 prompt: strict 段只在 strict 频道出现 ──────────────────────
{
  const base = { topicId: "topicS", postId: "p1", triggerId: "p1", msgid: "m1", recent: [], thread: [], latest: "帮我看个报错", latestAuthor: "user:b" };
  const strictP = buildJudgePrompt(cfgStrict, { ...base, strict: true, members: ["fix", "docs"] });
  assert.ok(strictP.includes("严格模式"), "strict 段: 判官兼管开义务");
  assert.ok(strictP.includes("respond 就相当于「开义务」") || strictP.includes("respond 就等于「开义务」"), "respond=开义务的口径");
  assert.ok(strictP.includes("fix、docs"), "成员名单进 prompt");
  assert.ok(strictP.includes("句首"), "rewrite 句首点名 = 落人");
  const plainP = buildJudgePrompt(cfgImplicit, base);
  assert.ok(!plainP.includes("严格模式"), "implicit 频道不出 strict 段");
}

// ── 2. 出站: strict 频道终句评论 0 条 (sendPost), implicit 对照照旧评论 ──
const calls: Array<{ via: string; cmd?: string; content?: string }> = [];
const emitted: unknown[] = [];
const mkClient = () => {
  const c: any = {
    sendMessage: async (chatid: string, body: any) => { calls.push({ via: "send", cmd: "send:" + chatid, content: body?.markdown?.content }); return {}; },
    replyStream: async (_f: unknown, id: string, content: string) => { calls.push({ via: "stream", content }); return {}; },
    reply: async (_h: unknown, body: unknown, cmd: string) => {
      calls.push({ via: "cmd", cmd, content: JSON.stringify(body) });
      return { body: cmd === "aibot_topic_get_post_list" ? { post_list: [postOf()] } : cmd === "aibot_topic_send_post" ? { post_id: "pnew" } : {} };
    },
    emit: (ev: string, frame: unknown) => { calls.push({ via: "emit", content: ev }); emitted.push(frame); },
    wsManager: { handleFrame: (_f: unknown) => { /* 原链路不需要 */ } },
  };
  return c;
};
const postOf = () => ({ post_id: "pX", content: "频道里求助: 帮我看个报错", creator: { type: 2, userid: "tester" }, create_time: 1700000000 });

const atBotFrame = (topicId: string, postId: string, msgid: string) => ({
  cmd: "aibot_topic_event_callback",
  body: {
    topic_id: topicId, msgid, from: { userid: "tester" }, aibotid: "selfbot0001", create_time: 1700000000,
    event: { eventtype: "topic_at_bot", topic_at_bot: { post_id: postId, reply_id: "" } },
  },
});

const client = mkClient();
installChannelTransport(client, log, cfgStrict);
installChannelEvents(client, cfgStrict, log);
// @ 事件登记 replyOk (strict 频道 topicS: post pS 被 @ 过 → 可以评论)。
(client as any).wsManager.handleFrame(atBotFrame("topicS", "pS", "mS"));
await new Promise((r) => setTimeout(r, 50));
assert.equal(emitted.length, 1, "@ 事件伪装成群消息交给 inbound");

// 终句 (流式最终帧): strict 频道 → 新帖, 不包装成评论。
calls.length = 0;
await (client as any).replyStream(emitted[0], "mS", "🧙‍♂️ fix： 结论", true);
assert.ok(calls.some((c) => c.via === "cmd" && c.cmd === "aibot_topic_send_post"), "strict 终句 → send_post");
assert.ok(!calls.some((c) => c.via === "cmd" && c.cmd === "aibot_topic_send_reply"), "strict 终句评论 0 条");

// 自动 sendMessage (终句退路/notify): strict 频道同样只发新帖。
calls.length = 0;
await client.sendMessage("topicS", { msgtype: "markdown", markdown: { content: "补充结论" } });
assert.ok(calls.some((c) => c.via === "cmd" && c.cmd === "aibot_topic_send_post"), "strict sendMessage → send_post");
assert.ok(!calls.some((c) => c.via === "cmd" && c.cmd === "aibot_topic_send_reply"), "strict sendMessage 评论 0 条");

// ── 3. 工具面 sendTopicContent: strict 不影响, 按 replyOk 选 ──────────
calls.length = 0;
const via = await sendTopicContent(client, log, "topicS", "chat_reply 的交付", "mS");
assert.equal(via, "reply", "msgid 锚定的帖子被 @ 过 → 评论");
assert.ok(calls.some((c) => c.via === "cmd" && c.cmd === "aibot_topic_send_reply"), "工具面走 send_reply");
// 没登记过的频道 (没有任何帖子) → 只能新帖。
calls.length = 0;
const via2 = await sendTopicContent(client, log, "topicFRESH", "chat_say 的主动话");
assert.equal(via2, "post", "没有可评论的帖子 → 新帖");
assert.ok(calls.some((c) => c.via === "cmd" && c.cmd === "aibot_topic_send_post"), "工具面走 send_post");

// ── 4. implicit 对照组: 判官外的行为不变 (replyOk → 评论) ─────────────
// 注意 replyOk / byStream 是模块级共享: 换一个 implicit 的 cfg, 同一 topicS/pS。
const client2 = mkClient();
installChannelTransport(client2, log, cfgImplicit);
installChannelEvents(client2, cfgImplicit, log);
(client2 as any).wsManager.handleFrame(atBotFrame("topicS", "pS", "mI"));
await new Promise((r) => setTimeout(r, 50));
calls.length = 0;
await (client2 as any).replyStream(emitted[emitted.length - 1], "mI", "🧙‍♂️ fix： 结论", true);
assert.ok(calls.some((c) => c.via === "cmd" && c.cmd === "aibot_topic_send_reply"), "implicit 终句照旧评论 (replyOk)");

// isTopicChat 判定面
registerTopic("topicZ");
assert.ok((await import("../daemon/channel.js")).isTopicChat("chat:topicZ"), "chat:<topic> 识别为频道");
assert.ok(!(await import("../daemon/channel.js")).isTopicChat("chat:wrPLAIN"), "普通群不是频道");
assert.ok(!(await import("../daemon/channel.js")).isTopicChat("user:alice"), "单聊不是频道");

resetKnownChatsCache();
console.log("strict-channel: 终句评论 0 条 / 工具面 replyOk / 判官 strict 段 / implicit 对照");
