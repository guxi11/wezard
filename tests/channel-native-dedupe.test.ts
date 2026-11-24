// 频道 @ 两路入站 (原生帧 compat_info.source=channel + topic_at_bot 事件) 的去重, 以及
// 2026-11-23 起的人话落 room 口径: 桥不再伪造 chatid=topicId 的群帧, 只调 ingest 交人话。
// - 原生帧到了 → 桥不落 room (那条人话由 inbound 落账), 只学配对 + 通知「帖子源首触」。
//   2026-11-24 (multi-source-binding §4.1): 首触**不再建帖子 room / 开新实例** —— 通知只是
//   让 daemon 知道「这个源来过」, 人话落频道 room 由 host 判定 (room_bind / 超时另起)。
// - 原生帧没到 → 兜底落一行: 帖子已配对 → 帖子 room; 没配对 → 频道 room 并标 mention:"bot"。
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { ConfigSchema } from "../shared/config.js";
import { installChannelEvents, noteNativeChannelFrame, type ChannelHuman } from "../daemon/channel.js";
import { channelOfPost } from "../daemon/channel-posts.js";

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
const touched: Array<[string, string]> = [];
const client = {
  wsManager: { handleFrame: (_f: unknown) => {} },
  reply: async (_h: unknown, body: { post_id_list?: string[] }) => ({ body: { post_list: [{ post_id: body.post_id_list?.[0], content: "@wezard hi" }] } }),
};
installChannelEvents(client as never, cfg, log, {
  nativeWaitMs: 400,
  ingest: (e) => ingested.push(e),
  postTouched: (t, b) => touched.push([t, b]),
});
const atBot = (postId: string, asker = "tester", msgid = "m-" + postId) => client.wsManager.handleFrame({
  cmd: "aibot_topic_event_callback",
  body: { topic_id: "topicT", msgid, from: { userid: asker }, aibotid: "bot", create_time: 1700000000, event: { eventtype: "topic_at_bot", topic_at_bot: { post_id: postId } } },
});

// ① 原生帧先到 → 桥不落行; 学到配对并通知「帖子源首触」(不建 room —— 是否诞生由 host 判定)。
noteNativeChannelFrame("tester", "chat:opkA");
atBot("p1");
await sleep(700);
assert.deepEqual(ingested, [], "原生帧先到: 桥不落第二行人话");
assert.deepEqual(touched, [["topicT", "chat:opkA"]], "配对即首触通知 (帖子 room 不在这一步诞生)");
assert.equal(channelOfPost(cfg, "chat:opkA"), "topicT");

// ② 事件先到, 原生帧 200ms 后到 (实测 0.3–0.8s) → 桥不落行。
atBot("p2");
await sleep(200);
noteNativeChannelFrame("tester", "chat:opkB");
await sleep(600);
assert.deepEqual(ingested, [], "原生帧晚到但在等待窗内: 桥不落行");

// ③ 没有原生帧 → 兜底落到频道 room, 标 mention:"bot"、带 post。
atBot("p3");
await sleep(800);
assert.equal(ingested.length, 1);
assert.equal(ingested[0]!.room, "chat:topicT", "没配对: 频道 room");
assert.equal(ingested[0]!.post, "p3");
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

// ⑥ 已被原生帧配过的帖子再 @ → 兜底仍把「落点」报成帖子 base, 照样标 mention:"bot"; 帖子 room
//    还没诞生时由 daemon 的 channelIngest 回落到频道接待处 (§4.1), 诞生后才是帖子 room 自己。
atBot("p1", "tester", "m2-p1");
await sleep(700);
assert.equal(ingested.length, 4);
assert.equal(ingested[3]!.room, "chat:opkA", "已配对: 落点报帖子 base (room 尚未诞生时 daemon 回落频道接待处)");
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

console.log("channel-native-dedupe ok");
