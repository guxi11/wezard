// 频道 @ 两路入站去重: 企微把频道里 @ 机器人的话同时推原生帧 (compat_info.source=channel,
// chatid = 帖子群 opk…) 与 topic_at_bot 事件 (topic_id = 频道)。原生帧到了, 桥不再重投
// (否则 chat:<topic_id> 的默认会话也答一遍); 原生帧没到, 桥兜底照投。
// 2026-11-17 test1 频道实录: 帖子绑了 .GraceWhite, .cc-wecom-13 (chat:<topic_id>) 也在答。
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { ConfigSchema } from "../shared/config.js";
import { installChannelEvents, noteNativeChannelFrame } from "../daemon/channel.js";

const ROOT = mkdtempSync(join(tmpdir(), "channel-native-"));
const log = pino({ level: "silent" });
const cfg = ConfigSchema.parse({
  bot: { botId: "test", secret: "test" },
  daemon: { stateDir: join(ROOT, "state") },
  wrc: { allowFrom: ["user:tester"], channel: { history: { enabled: false }, judge: { enabled: false } } },
  defaultChat: "user:home",
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const emitted: string[] = [];
const client = {
  wsManager: { handleFrame: (_f: unknown) => {} },
  reply: async (_h: unknown, body: { post_id_list?: string[] }) => ({ body: { post_list: [{ post_id: body.post_id_list?.[0], content: "@wezard hi" }] } }),
  emit: (e: string, f: { body: { chatid: string } }) => { if (e === "message.text") emitted.push(f.body.chatid); return true; },
};
installChannelEvents(client as never, cfg, log, { nativeWaitMs: 400 });
const atBot = (postId: string, asker = "tester") => client.wsManager.handleFrame({
  cmd: "aibot_topic_event_callback",
  body: { topic_id: "topicT", msgid: "m-" + postId, from: { userid: asker }, aibotid: "bot", create_time: 1700000000, event: { eventtype: "topic_at_bot", topic_at_bot: { post_id: postId } } },
});

// ① 原生帧先到 → 桥不投。
noteNativeChannelFrame("tester", "chat:opkA");
atBot("p1");
await sleep(700);
assert.deepEqual(emitted, [], "原生帧先到: topic_at_bot 不再伪装投递");

// ② 事件先到, 原生帧 200ms 后到 (实测 0.3–0.8s) → 桥不投。
atBot("p2");
await sleep(200);
noteNativeChannelFrame("tester", "chat:opkB");
await sleep(600);
assert.deepEqual(emitted, [], "原生帧晚到但在等待窗内: 桥不投");

// ③ 没有原生帧 → 等满窗口后桥兜底投到 chat:<topic_id>。
atBot("p3");
await sleep(800);
assert.deepEqual(emitted, ["topicT"], "原生帧缺席: 桥兜底照投, 话不丢");

// ④ 一帧只抵一个事件: 一条原生帧 + 两个事件 → 一个被认领, 另一个兜底。
noteNativeChannelFrame("tester", "chat:opkC");
atBot("p4");
atBot("p5");
await sleep(900);
assert.equal(emitted.length, 2, "原生帧认领即消耗, 不替别的事件挡投递");

// ⑤ 别人的原生帧不算: 认领按发话人配对。
noteNativeChannelFrame("other", "chat:opkD");
atBot("p6");
await sleep(800);
assert.equal(emitted.length, 3, "别人的原生帧不抵本人的事件");

// ⑥ 端到端: inbound 的最外层 "message" 回调认出 compat_info.source=channel 并记账。
const { installInboundRouter } = await import("../daemon/inbound.js");
const handlers = new Map<string, (f: unknown) => unknown>();
const bridge = { hasMirrorTarget: () => false, status: () => ({ mirrors: [] }), getCwd: () => ({ runningCwd: "", pendingCwd: "", defaultCwd: "" }), chatRoster: () => [], peers: async () => [] };
installInboundRouter({ on: (e: string, h: (f: unknown) => unknown) => handlers.set(e, h), replyStream: async () => ({}) } as never, cfg, log, bridge as never, join(ROOT, "unused.jsonc"), (() => {}) as never);
handlers.get("message")!({ headers: { req_id: "n7" }, body: { msgid: "n7", chattype: "group", chatid: "opkE", from: { userid: "tester" }, msgtype: "text", text: { content: "@wezard hi" }, compat_info: { source: "channel" } } });
atBot("p7");
await sleep(700);
assert.equal(emitted.length, 3, "inbound 记下的原生频道帧抵掉同一句的 topic_at_bot");
handlers.get("message")!({ headers: { req_id: "n8" }, body: { msgid: "n8", chattype: "group", chatid: "wrG", from: { userid: "tester" }, msgtype: "text", text: { content: "hi" } } });
atBot("p8");
await sleep(800);
assert.equal(emitted.length, 4, "普通群帧 (无 compat_info) 不算频道原生帧");

console.log("channel-native-dedupe ok");