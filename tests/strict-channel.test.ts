// 频道 (topic) 传输的 room 口径 (fix-task §8.2 改写): strict 频道分支已删 —— 自动出站
// (终句流式最终帧 / sendMessage 退路) 统一按 replyOk 选评论/新帖; 工具面 sendTopicContent
// 照旧。本文件原为 P7-S3 的 strict/implicit 对照, strict 读点 (channel.ts strictTopicOf)
// 删除后行为只剩一种, 保留其中仍有效的那部分。
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { ConfigSchema } from "../shared/config.js";
import {
  installChannelEvents,
  installChannelTransport,
  registerTopic,
  sendTopicContent,
} from "../daemon/channel.js";

const ROOT = mkdtempSync(join(tmpdir(), "strict-channel-"));
const log = pino({ level: "silent" });

const cfg = ConfigSchema.parse({
  bot: { botId: "test", secret: "test" },
  daemon: { stateDir: join(ROOT, "state") },
  wrc: { allowFrom: ["user:tester"], channel: { history: { enabled: false } } },
  defaultChat: "user:home",
});

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
installChannelTransport(client, log, cfg);
installChannelEvents(client, cfg, log, { nativeWaitMs: 0 }); // 无原生帧: 测桥兜底投递
// @ 事件登记 replyOk (post pS 被 @ 过 → 可以评论)。
(client as any).wsManager.handleFrame(atBotFrame("topicS", "pS", "mS"));
await new Promise((r) => setTimeout(r, 50));
assert.equal(emitted.length, 1, "@ 事件伪装成群消息交给 inbound");

// 终句 (流式最终帧): 被回复的帖子登记过 replyOk → 评论 (room 口径: 不再分 strict/implicit)。
calls.length = 0;
await (client as any).replyStream(emitted[0], "mS", "🧙‍♂️ fix： 结论", true);
assert.ok(calls.some((c) => c.via === "cmd" && c.cmd === "aibot_topic_send_reply"), "终句 → 对被 @ 的帖子评论 (replyOk)");
assert.ok(!calls.some((c) => c.via === "cmd" && c.cmd === "aibot_topic_send_post"), "有可评论的帖子就不发新帖");

// 自动 sendMessage (终句退路/notify): 同一规则。
calls.length = 0;
await client.sendMessage("topicS", { msgtype: "markdown", markdown: { content: "补充结论" } });
assert.ok(calls.some((c) => c.via === "cmd" && c.cmd === "aibot_topic_send_reply"), "sendMessage 退路照旧评论 (replyOk)");

// ── 工具面 sendTopicContent: 按 replyOk 选 ──────────────────────────
calls.length = 0;
const via = await sendTopicContent(client, log, "topicS", "chat_reply 的交付", "mS");
assert.equal(via, "reply", "msgid 锚定的帖子被 @ 过 → 评论");
assert.ok(calls.some((c) => c.via === "cmd" && c.cmd === "aibot_topic_send_reply"), "工具面走 send_reply");
// 没登记过的频道 (没有任何帖子) → 只能新帖。
calls.length = 0;
const via2 = await sendTopicContent(client, log, "topicFRESH", "chat_say 的主动话");
assert.equal(via2, "post", "没有可评论的帖子 → 新帖");
assert.ok(calls.some((c) => c.via === "cmd" && c.cmd === "aibot_topic_send_post"), "工具面走 send_post");

// isTopicChat 判定面
registerTopic("topicZ");
assert.ok((await import("../daemon/channel.js")).isTopicChat("chat:topicZ"), "chat:<topic> 识别为频道");
assert.ok(!(await import("../daemon/channel.js")).isTopicChat("chat:wrPLAIN"), "普通群不是频道");
assert.ok(!(await import("../daemon/channel.js")).isTopicChat("user:alice"), "单聊不是频道");

console.log("strict-channel (room 口径): 出站统一按 replyOk 选评论/新帖, 工具面照旧, isTopicChat 不变");
