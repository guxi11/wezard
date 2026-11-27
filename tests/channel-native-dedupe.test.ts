// 频道 @ 两路入站 (原生帧 compat_info.source=channel + topic_at_bot 事件) 的去重, 以及
// 2026-11-23 起的人话落 room 口径: 桥不再伪造 chatid=topicId 的群帧, 只调 ingest 交人话。
// - 原生帧到了 → 桥不落 room (那条人话由 inbound 落账), 只学配对。
// - 原生帧没到 → 兜底落一行 mention:"bot"。
// 2026-11-27 (docs/evolve/channel-topic-rooms.md): 落点一律是 topicRoomOf —— 新口径 topic:<T>/<P>
// (行不带 post), 不再有「没配对 → 频道 room」; 首触通知 (postTouched) 随首触接待一起删除。
// 删除说明: 旧断言「配对即首触通知」「没配对落频道 room 带 post」「已配对报帖子 base」随新口径改写。
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { ConfigSchema } from "../shared/config.js";
import { installChannelEvents, noteNativeChannelFrame, type ChannelHuman } from "../daemon/channel.js";
import { channelOfPost, postRefOf } from "../daemon/channel-posts.js";

const ROOT = mkdtempSync(join(tmpdir(), "channel-native-"));
const log = pino({ level: "silent" });
const cfg = ConfigSchema.parse({
  bot: { botId: "test", secret: "test" },
  daemon: { stateDir: join(ROOT, "state") },
  wrc: { allowFrom: ["user:tester"], channel: { history: { enabled: false } } },
  defaultChat: "user:home",
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ingested: ChannelHuman[] = [];
const client = {
  wsManager: { handleFrame: (_f: unknown) => {} },
  reply: async (_h: unknown, body: { post_id_list?: string[] }) => ({ body: { post_list: [{ post_id: body.post_id_list?.[0], content: "@wezard hi" }] } }),
};
installChannelEvents(client as never, cfg, log, {
  nativeWaitMs: 400,
  ingest: (e) => ingested.push(e),
});
const atBot = (postId: string, asker = "tester", msgid = "m-" + postId) => client.wsManager.handleFrame({
  cmd: "aibot_topic_event_callback",
  body: { topic_id: "topicT", msgid, from: { userid: asker }, aibotid: "bot", create_time: 1700000000, event: { eventtype: "topic_at_bot", topic_at_bot: { post_id: postId } } },
});

// ① 原生帧先到 → 桥不落行; 只学到配对 (opk → 频道) —— 落点由 inbound 的 sourceRoute 按同一个 topicRoomOf 定。
noteNativeChannelFrame("tester", "chat:opkA");
atBot("p1");
await sleep(700);
assert.deepEqual(ingested, [], "原生帧先到: 桥不落第二行人话");
assert.equal(channelOfPost(cfg, "chat:opkA"), "topicT");
assert.equal(postRefOf(cfg, "chat:opkA")?.post, "p1");

// ② 事件先到, 原生帧 200ms 后到 (实测 0.3–0.8s) → 桥不落行。
atBot("p2");
await sleep(200);
noteNativeChannelFrame("tester", "chat:opkB");
await sleep(600);
assert.deepEqual(ingested, [], "原生帧晚到但在等待窗内: 桥不落行");

// ③ 没有原生帧 → 兜底落到帖子自己的 topic room, 标 mention:"bot"; 行不带 post。
atBot("p3");
await sleep(800);
assert.equal(ingested.length, 1);
assert.equal(ingested[0]!.room, "topic:topicT/p3", "没配对也不落频道: 第一条事件就是它自己的 topic room");
assert.equal((ingested[0] as { post?: string }).post, undefined, "topic room 的行不带 post");
assert.equal(ingested[0]!.mention, "bot");
assert.ok(ingested[0]!.text.includes("@wezard hi"));

// ④ 一帧只抵一个事件: 一条原生帧 + 两个事件 → 一个被认领, 另一个兜底。
noteNativeChannelFrame("tester", "chat:opkC");
atBot("p4");
atBot("p5");
await sleep(900);
assert.equal(ingested.length, 2, "原生帧认领即消耗, 不替别的事件挡投递");

// ⑤ 别人的原生帧不算: 认领按发话人配对。
noteNativeChannelFrame("other", "chat:opkD");
atBot("p6");
await sleep(800);
assert.equal(ingested.length, 3, "别人的原生帧不抵本人的事件");

// ⑥ 已被原生帧配过 opk 的帖子再 @ → 旧 chat:<opk> room 不存在 (默认接线 roomExists=false) → 仍是 topic room;
//    存量帖子 room 已诞生时落旧 room 的断言在 tests/topic-room-of.test.ts (注入 roomFor / roomExists)。
atBot("p1", "tester", "m2-p1");
await sleep(700);
assert.equal(ingested.length, 4);
assert.equal(ingested[3]!.room, "topic:topicT/p1", "已配对但旧帖子 room 没诞生过: 落新口径 topic room");
assert.equal(ingested[3]!.mention, "bot");

// ⑦ 端到端: inbound 的最外层 "message" 回调认出 compat_info.source=channel 并记账。
const { installInboundRouter } = await import("../daemon/inbound.js");
const handlers = new Map<string, (f: unknown) => unknown>();
const bridge = { hasMirrorTarget: () => false, status: () => ({ mirrors: [] }), getCwd: () => ({ runningCwd: "", pendingCwd: "", defaultCwd: "" }), chatRoster: () => [], peers: async () => [] };
installInboundRouter({ on: (e: string, h: (f: unknown) => unknown) => handlers.set(e, h), replyStream: async () => ({}) } as never, cfg, log, bridge as never, join(ROOT, "unused.jsonc"), (() => {}) as never);
handlers.get("message")!({ headers: { req_id: "n7" }, body: { msgid: "n7", chattype: "group", chatid: "opkE", from: { userid: "tester" }, msgtype: "text", text: { content: "@wezard hi" }, compat_info: { source: "channel" } } });
atBot("p7");
await sleep(700);
assert.equal(ingested.length, 4, "inbound 记下的原生频道帧抵掉同一句的 topic_at_bot");
handlers.get("message")!({ headers: { req_id: "n8" }, body: { msgid: "n8", chattype: "group", chatid: "wrG", from: { userid: "tester" }, msgtype: "text", text: { content: "hi" } } });
atBot("p8");
await sleep(800);
assert.equal(ingested.length, 5, "普通群帧 (无 compat_info) 不算频道原生帧");

// ⑧ 新帖 (topic_event) / 评论 (topic_reply_event) 也直接落 topic room, 第一条事件即开 —— 不再要求配对。
const postEv = (postId: string, msgid: string) => client.wsManager.handleFrame({
  cmd: "aibot_topic_event_callback",
  body: { topic_id: "topicT", msgid, from: { userid: "tester" }, create_time: 1700000000, event: { eventtype: "topic_event", topic_event: { type: 1, post_id: postId } } },
});
const replyEv = (postId: string, replyId: string) => client.wsManager.handleFrame({
  cmd: "aibot_topic_event_callback",
  body: { topic_id: "topicT", msgid: "mr-" + replyId, from: { userid: "tester" }, create_time: 1700000000, event: { eventtype: "topic_reply_event", topic_reply_event: { type: 1, post_id: postId, reply_id: replyId } } },
});
const replyClient = client as unknown as { reply: (h: unknown, body: Record<string, unknown>) => Promise<unknown> };
replyClient.reply = async (_h, body) => ({ body: {
  post_list: [{ post_id: (body.post_id_list as string[] | undefined)?.[0], content: "新帖正文" }],
  reply_list: [{ reply_id: (body.reply_id_list as string[] | undefined)?.[0], post_id: body.post_id, content: "评论正文" }],
} });
const before = ingested.length;
postEv("p9", "m-p9");
await sleep(200);
replyEv("p9", "r1");
await sleep(200);
assert.equal(ingested.length, before + 2);
assert.equal(ingested[before]!.room, "topic:topicT/p9", "没 @ 的新帖: 它自己的 topic room");
assert.equal(ingested[before]!.mention, undefined);
assert.equal(ingested[before + 1]!.room, "topic:topicT/p9", "评论: 同一帖子同一个 room (不需要配对出 opk)");

console.log("channel-native-dedupe ok");
