// 频道 / 帖子 room 的出站 (§2.3): 频道 room 回话 (reply re 到带 post 的评论) → send_reply 回原帖,
// 主动说 → send_post; 帖子 room 一律 send_reply (评论到根帖)。旧的一次性判官与「按 replyOk 挑帖子」
// 已删; room 路由在 index 的 roomMirror, 这里测传输原语、判定面与出站选择。
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { ConfigSchema } from "../shared/config.js";
import { channelOutboundOf, installChannelEvents, installChannelTransport, isTopicChat, registerTopic, sendTopicPost, sendTopicReply, sendTopicReplyOrPost } from "../daemon/channel.js";
import { channelOfPost, learnChannelPost, postRefOf } from "../daemon/channel-posts.js";

const ROOT = mkdtempSync(join(tmpdir(), "strict-channel-"));
const log = pino({ level: "silent" });
const cfg = ConfigSchema.parse({
  bot: { botId: "test", secret: "test" },
  daemon: { stateDir: join(ROOT, "state") },
  wrc: { allowFrom: ["user:tester"], channel: { history: { enabled: false } } },
  defaultChat: "user:home",
});
const calls: Array<{ via: string; cmd?: string; chatid?: string; content?: string }> = [];
const client: any = {
  sendMessage: async (chatid: string, body: any) => { calls.push({ via: "send", chatid, content: body?.msgtype }); return {}; },
  reply: async (_h: unknown, body: unknown, cmd: string) => {
    calls.push({ via: "cmd", cmd, content: JSON.stringify(body) });
    return { body: cmd === "aibot_topic_send_post" ? { post_id: "pnew" } : {} };
  },
  wsManager: { handleFrame: (_f: unknown) => {} },
};
installChannelTransport(client, log);
installChannelEvents(client, cfg, log, { nativeWaitMs: 0 });

// ① 频道 room → send_post (即使这个频道以前评论过别的帖子)。
registerTopic("topicX");
calls.length = 0;
await client.sendMessage("topicX", { msgtype: "markdown", markdown: { content: "频道新帖" } });
assert.ok(calls.some((c) => c.via === "cmd" && c.cmd === "aibot_topic_send_post" && c.content?.includes("频道新帖")), "频道 room → send_post");
assert.ok(!calls.some((c) => c.cmd === "aibot_topic_send_reply"), "频道 room 不评论任何帖子");

// ② 审批卡改投问话人私聊 (频道没有按钮卡片); 非 markdown 丢弃; 普通 chatid 原样放行。
calls.length = 0;
await client.sendMessage("topicX", { msgtype: "template_card", template_card: {} });
assert.ok(!calls.some((c) => c.via === "cmd"), "无 asker 时整卡丢弃");
assert.ok(!calls.some((c) => c.via === "send" && c.chatid === "topicX"));
calls.length = 0;
await client.sendMessage("topicX", { msgtype: "image", image: {} });
assert.ok(!calls.length, "非 markdown 出站丢弃");
await client.sendMessage("chat:normal", { msgtype: "markdown", markdown: { content: "x" } });
assert.ok(calls.some((c) => c.via === "send" && c.chatid === "chat:normal"), "非频道 chatid 原样放行");

// ③ 传输原语: sendTopicPost 发新帖, sendTopicReply 带 post_id 评论到根帖。
calls.length = 0;
await sendTopicPost(client, log, "topicX", "帖");
assert.ok(calls.some((c) => c.cmd === "aibot_topic_send_post"));
calls.length = 0;
await sendTopicReply(client, log, "topicX", "pX", "评论");
const rep = calls.find((c) => c.cmd === "aibot_topic_send_reply");
assert.ok(rep, "sendTopicReply → aibot_topic_send_reply");
assert.ok(rep!.content!.includes('"topic_id":"topicX"') && rep!.content!.includes('"post_id":"pX"'), "评论带频道与根帖 id");

// ④ 判定面: 频道 room 用 isTopicChat; 帖子 room 用 channel-posts 的 {channel, post}。
assert.ok(isTopicChat("chat:topicX"));
assert.ok(!isTopicChat("chat:wrPLAIN"));
assert.ok(!isTopicChat("user:alice"));
learnChannelPost(cfg, "chat:opkP", "topicX", "pX");
assert.equal(channelOfPost(cfg, "chat:opkP"), "topicX");
assert.deepEqual(postRefOf(cfg, "chat:opkP"), { channel: "topicX", post: "pX" }, "帖子 room 出站要的两个 id 都在映射里");

// ⑤ 频道 room 的出站选择: reply re 到带 post 的评论 → 评论回原帖; 其余 → 新帖。
assert.deepEqual(
  channelOutboundOf({ kind: "reply", re: ["m1"] }, (id) => (id === "m1" ? "pC" : undefined)),
  { action: "reply", post: "pC" }, "回话 → 评论回原帖 (断言用的 post id)");
assert.deepEqual(
  channelOutboundOf({ kind: "reply", re: ["m9"] }, () => undefined),
  { action: "post" }, "re 的原话不带 post (不是评论) → 新帖");
assert.deepEqual(channelOutboundOf({ kind: "say" }, () => "pC"), { action: "post" }, "主动说 → 新帖");
assert.deepEqual(
  channelOutboundOf({ kind: "reply", re: ["m1", "m2"] }, (id) => (id === "m2" ? "pX" : undefined)),
  { action: "reply", post: "pX" }, "按 re 顺序取第一条带 post 的原话行");

// ⑥ 评论被企微拒 (bot 只能评论 @ 过它的帖子) → 回退发新帖, 正文带引用标注; 不再静默丢失。
{
  const sent: Array<{ cmd: string; content: string }> = [];
  const rejecting: any = {
    reply: async (_h: unknown, body: any, cmd: string) => {
      sent.push({ cmd, content: String(body?.content ?? "") });
      return cmd === "aibot_topic_send_reply" ? { errcode: 40058, errmsg: "post not mention bot" } : { post_id: "pnew" };
    },
  };
  const quote = "> 回 张三: 这个帖子怎么处理\n\n";
  const via = await sendTopicReplyOrPost(rejecting, log, "topicX", "pQ", "正文", quote + "正文");
  assert.equal(via, "post", "被拒时回退新帖");
  assert.deepEqual(sent.map((x) => x.cmd), ["aibot_topic_send_reply", "aibot_topic_send_post"], "先评论再回退");
  assert.ok(sent[1]!.content.startsWith(quote) && sent[1]!.content.includes("正文"), "新帖正文带引用标注");
  // 没被拒就只评论, 不发新帖。
  sent.length = 0;
  const okClient: any = { reply: async (_h: unknown, body: any, cmd: string) => { sent.push({ cmd, content: String(body?.content ?? "") }); return {}; } };
  assert.equal(await sendTopicReplyOrPost(okClient, log, "topicX", "pQ", "正文", quote + "正文"), "reply");
  assert.deepEqual(sent.map((x) => x.cmd), ["aibot_topic_send_reply"], "成功时只有评论");
}

console.log("strict-channel (room 口径): 频道回话 → send_reply 回原帖, 主动说 → send_post, 被拒回退新帖, 帖子 → send_reply");
