// 频道改造 P1 (docs/evolve/channel-topic-rooms.md): 每个帖子一个 topic room。
//   ① topic room id 的拼 / 拆 (shared/topic-room.ts), postRefOf / channelOf / channelRefOf 从 id 直接认频道;
//   ② topicRoomOf 的解析顺序 (§3.1): 存量帖子源 bind → 已诞生的旧 chat:<opk> 帖子 room → 旧配对表反查 → 新口径;
//   ③ 入站四路 (topic_event / topic_reply_event / topic_at_bot 兜底) 都落 topicRoomOf, 存档频道 room 不再收入站;
//   ④ 出站 (planOutbound): topic: 一律评论根帖 (topic / post 从 id 拆); 旧 chat:<opk> 照旧; 存档频道 room 仍走 channelOutboundOf;
//   ⑤ 旧配置键 rooms.binding.decideTimeoutMin 被忽略 (不拒启动)。
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { ConfigSchema } from "../shared/config.js";
import { isTopicRoomId, parseTopicRoomId, topicRoomId, topicRoomLabel } from "../shared/topic-room.js";
import { planOutbound, type MsgRow } from "../shared/room.js";
import {
  channelOf, channelRefOf, knownChannels, learnChannel, learnChannelPost, postRefOf, topicRoomOf, topicRoomsOf,
} from "../daemon/channel-posts.js";
import { channelOutboundOf, installChannelEvents, type ChannelHuman } from "../daemon/channel.js";

const ROOT = mkdtempSync(join(tmpdir(), "topic-room-of-"));
const log = pino({ level: "silent" });
const cfg = ConfigSchema.parse({
  bot: { botId: "test", secret: "test" },
  daemon: { stateDir: join(ROOT, "state") },
  wrc: { allowFrom: ["user:tester"], channel: { history: { enabled: false } } },
  defaultChat: "user:home",
});

// ── ① id 拼 / 拆 ─────────────────────────────────────────────────────────
assert.equal(topicRoomId("T1", "p1"), "topic:T1/p1");
assert.deepEqual(parseTopicRoomId("topic:T1/p1"), { channel: "T1", post: "p1" });
assert.deepEqual(parseTopicRoomId("topic:T1/p1#cc-wecom-2"), { channel: "T1", post: "p1" }, "target key 的 #slot 先剥掉 (baseOfKey 一致)");
for (const bad of ["chat:T1", "topic:T1", "topic:/p1", "topic:T1/", "user:x", ""]) assert.equal(parseTopicRoomId(bad), undefined, "不是 topic room: " + bad);
assert.equal(isTopicRoomId("topic:T1/p1"), true);
assert.equal(isTopicRoomId("chat:opkA"), false);
assert.equal(topicRoomLabel({ channel: "T1abcdefgh", post: "p-123456789" }, ""), "T1abcdef · 帖 456789");
assert.equal(topicRoomLabel({ channel: "T1", post: "p1" }, "研发频道"), "研发频道 · 帖 p1");

// postRefOf / channelOf / channelRefOf: topic room 不查映射, 频道归属就在 id 里。
assert.deepEqual(postRefOf(cfg, "topic:T1/p1"), { channel: "T1", post: "p1" });
assert.equal(channelOf(cfg, "topic:T1/p1"), "T1");
assert.deepEqual(channelRefOf(cfg, "topic:T1/p1"), { channel: "T1", post: "p1" });
assert.equal(channelOf(cfg, "chat:wrGroup"), "", "普通群不是频道");

// ── ② topicRoomOf 解析顺序 ───────────────────────────────────────────────
learnChannelPost(cfg, "chat:opkOld", "T1", "pOld");       // 旧口径配过对
const resolve = (over: Partial<Parameters<typeof topicRoomOf>[0]> = {}) => topicRoomOf({
  cfg, topic: "T1", post: "pNew", roomOfSource: () => undefined, roomExists: () => false, ...over,
});
assert.equal(resolve(), "topic:T1/pNew", "什么存量都没有 = 新口径 (第一条事件就能算出)");
assert.equal(resolve({ opk: "chat:opkNew" }), "topic:T1/pNew", "opk 只是入站别名, 不进 room id");
// 存量: 帖子源曾被 room_bind 进某 room → 继续落那里 (最高优先)。
assert.equal(resolve({ opk: "chat:opkB", roomOfSource: (s) => (s === "chat:opkB" ? "chat:wrTarget" : undefined), roomExists: () => true }), "chat:wrTarget");
// 存量: 已诞生的旧帖子 room (chat:<opk>) 就是这个帖子的 room。
assert.equal(resolve({ opk: "chat:opkOld", post: "pOld", roomExists: (r) => r === "chat:opkOld" }), "chat:opkOld");
// 事件路径没有 opk: 按配对表反查旧帖子 room (它存在才认)。
assert.equal(resolve({ post: "pOld", roomExists: (r) => r === "chat:opkOld" }), "chat:opkOld");
assert.equal(resolve({ post: "pOld" }), "topic:T1/pOld", "配过对但旧帖子 room 从没诞生: 落新口径, 不落一个不存在的 room");
assert.equal(resolve({ opk: "chat:opkOld", post: "pOld" }), "topic:T1/pOld");
// 绑定 > 旧帖子 room > 新口径, 与存在性无关地稳定 (重放确定)。
assert.equal(resolve({ opk: "chat:opkOld", post: "pOld", roomOfSource: () => "chat:wrT2", roomExists: () => true }), "chat:wrT2");

// H1: 旧帖子源 chat:opkB 被 room_bind 进群 room R, 而 chat:opkB room 从没诞生过 —— 不带 opk 的事件 (评论 /
// 没 @ 的 topic_event / 兜底 topic_at_bot) 经配对表反查到 opkB 也要落 R, 不能另开 topic:T1/pB 与原生 @ 帧分家。
learnChannelPost(cfg, "chat:opkB", "T1", "pB");
const boundB = (s: string): string | undefined => (s === "chat:opkB" ? "chat:wrR" : undefined);
assert.equal(resolve({ post: "pB", roomOfSource: boundB }), "chat:wrR", "H1: 无 opk + 配对源已 bind → 落 R (room 存不存在都不影响)");
assert.equal(resolve({ post: "pB", roomOfSource: boundB, roomExists: (r) => r === "chat:opkB" }), "chat:wrR", "H1: 绑定先于「配对源 room 存在」");
assert.equal(resolve({ opk: "chat:opkB", post: "pB", roomOfSource: boundB }), "chat:wrR", "H1: 带 opk 与不带 opk 同一落点");
assert.equal(resolve({ post: "pB" }), "topic:T1/pB", "H1: 没 bind 也没 room → 新口径 (对照)");

// M1: 已存在的 topic:T/P 不能被后来诞生的 chat:<opk> 顶掉 (原生帧 2s 内没配上, inbound 在 chat:<opk> 误生 wecom-group room)。
const kinds: Record<string, string> = { "topic:T1/pM": "topic-post", "chat:opkM": "wecom-group", "chat:opkLeg": "wecom-group", "chat:opkTp": "topic-post" };
const withRooms = (...rooms: string[]) => ({ roomExists: (r: string) => rooms.includes(r), roomKind: (r: string) => kinds[r] });
assert.equal(resolve({ opk: "chat:opkM", post: "pM", ...withRooms("topic:T1/pM", "chat:opkM") }), "topic:T1/pM", "M1: 已存在的 topic room 先于误生的 chat:<opk> 群 room");
assert.equal(resolve({ opk: "chat:opkM", post: "pM", ...withRooms("chat:opkM") }), "topic:T1/pM", "M1: 只有误生的 wecom-group chat:<opk> (没配过对) 不认, 落新口径");
assert.equal(resolve({ opk: "chat:opkTp", post: "pTp", ...withRooms("chat:opkTp") }), "chat:opkTp", "M1: kind 是 topic-post 的旧 chat:<opk> 照认");
learnChannelPost(cfg, "chat:opkLeg", "T1", "pLeg");
assert.equal(resolve({ opk: "chat:opkLeg", post: "pLeg", ...withRooms("chat:opkLeg") }), "chat:opkLeg", "M1: 存量帖子 room 账本里 kind 是 wecom-group, 但配对表里就是这个帖子 → 照认 (不拆存量对话)");
assert.equal(resolve({ post: "pLeg", ...withRooms("chat:opkLeg") }), "chat:opkLeg", "M1: 事件路径 (无 opk) 反查同理");
assert.equal(resolve({ opk: "chat:opkLeg", post: "pLeg", ...withRooms("topic:T1/pLeg", "chat:opkLeg") }), "topic:T1/pLeg", "M1: 已存在的 topic room 连配过对的旧 room 也不让位");
assert.equal(resolve({ opk: "chat:opkM", post: "pM", roomOfSource: (s) => (s === "chat:opkM" ? "chat:wrX" : undefined), ...withRooms("topic:T1/pM") }), "chat:wrX", "M1: bind 仍然最高优先");

// topicRoomsOf: 一个频道名下的 topic room (新 + 旧帖子 room), 不含存档频道 room / 别的频道 / 群。
learnChannel(cfg, "T1");
const ids = ["chat:T1", "chat:opkOld", "topic:T1/pNew", "topic:T2/pX", "chat:wrGroup", "dm:a|b"];
assert.deepEqual(topicRoomsOf(cfg, "T1", ids), ["chat:opkOld", "topic:T1/pNew"]);
assert.deepEqual(topicRoomsOf(cfg, "T2", ids), ["topic:T2/pX"]);
assert.deepEqual(topicRoomsOf(cfg, "T9", ids), []);
assert.ok(knownChannels(cfg).includes("T1"), "learnChannel 记已知频道 (频道没有 room)");
assert.equal(learnChannel(cfg, "T1"), false, "幂等");

// ── ③ 入站四路: 都落 roomFor 给的 topic room; 存档频道 room 不再收入站 ────────
const ingested: ChannelHuman[] = [];
const asked: Array<[string, string, string | undefined]> = [];
const client = {
  wsManager: { handleFrame: (_f: unknown) => {} },
  reply: async (_h: unknown, body: Record<string, unknown>) => ({ body: {
    post_list: [{ post_id: (body.post_id_list as string[] | undefined)?.[0], content: "帖子正文" }],
    reply_list: [{ reply_id: (body.reply_id_list as string[] | undefined)?.[0], post_id: body.post_id, content: "评论正文" }],
  } }),
};
installChannelEvents(client as never, cfg, log, {
  nativeWaitMs: 0,
  selfPost: (p) => p === "pSelf",
  ingest: (e) => ingested.push(e),
  roomFor: (t, p, opk) => { asked.push([t, p, opk]); return topicRoomOf({ cfg, topic: t, post: p, ...(opk ? { opk } : {}), roomOfSource: () => undefined, roomExists: (r) => r === "chat:opkOld" }); },
});
const ev = (eventtype: string, inner: Record<string, unknown>, msgid: string) => client.wsManager.handleFrame({
  cmd: "aibot_topic_event_callback",
  body: { topic_id: "T1", msgid, from: { userid: "tester" }, create_time: 1700000000, event: { eventtype, [eventtype]: inner } },
});
ev("topic_event", { type: 1, post_id: "pNew" }, "e1");
ev("topic_reply_event", { type: 1, post_id: "pNew", reply_id: "r1" }, "e2");
ev("topic_reply_event", { type: 1, post_id: "pOld", reply_id: "r2" }, "e3");
ev("topic_at_bot", { post_id: "pNew" }, "e4");
ev("topic_event", { type: 1, post_id: "pSelf" }, "e5"); // L2: 自己刚发的新帖 (即便回推带了发话人) 不当人话落行
await new Promise((r) => setTimeout(r, 300));
assert.deepEqual(ingested.map((e) => e.room), ["topic:T1/pNew", "topic:T1/pNew", "chat:opkOld", "topic:T1/pNew"],
  "新帖 / 评论 / 存量帖子评论 / @ 兜底 全落 topicRoomOf; 没有任何一条落 chat:T1 (存档频道 room 不再收入站)");
assert.ok(ingested.every((e) => !e.room.includes("pSelf")), "L2: 命中最近自发集合的 topic_event 被跳过");
assert.ok(ingested.every((e) => e.room !== "chat:T1"), "存档频道 room 不再收入站");
assert.ok(ingested.every((e) => (e as { post?: string }).post === undefined), "行不带 post");
assert.equal(ingested[3]!.mention, "bot", "@ 兜底仍标 mention:bot");
assert.equal(ingested[0]!.mention, undefined);
assert.equal(asked.length, 4, "四路都过 roomFor");

// ── ④ 出站 planOutbound ──────────────────────────────────────────────────
const row = (over: Partial<MsgRow> = {}): MsgRow => ({ kind: "say", re: [], room: "topic:T1/pNew", ...over }) as MsgRow;
const deps = {
  wxOwns: () => false,
  isTopic: (b: string) => b === "chat:T1",
  postRefOf: (b: string) => postRefOf(cfg, b),
  channelAction: (r: MsgRow) => channelOutboundOf(r, (id) => (id === "c1" ? "pOld" : undefined)),
};
for (const kind of ["say", "reply", "file", "notify"]) {
  assert.deepEqual(planOutbound("topic:T1/pNew", row({ kind: kind as MsgRow["kind"] }), deps), { via: "post", channel: "T1", post: "pNew" },
    "topic room: " + kind + " 一律评论根帖 (topic / post 从 id 拆)");
}
assert.deepEqual(planOutbound("topic:T1/pNew", row({ kind: "reply", re: ["c1"] }), deps), { via: "post", channel: "T1", post: "pNew" }, "re 到哪条都一样: 评论根帖");
assert.deepEqual(planOutbound("chat:opkOld", row({ room: "chat:opkOld" }), deps), { via: "post", channel: "T1", post: "pOld" }, "旧 chat:<opk> 帖子 room 照旧查映射");
assert.deepEqual(planOutbound("chat:wrGroup", row({ room: "chat:wrGroup" }), deps), { via: "group", chatId: "wrGroup" }, "群不受影响");
// 存档频道 room: 只读存档, 出站沿用 channelOutboundOf (re 到带 post 的存量行 = 评论回原帖; 否则发新帖)。
assert.deepEqual(planOutbound("chat:T1", row({ room: "chat:T1", kind: "reply", re: ["c1"] }), deps), { via: "channel", topicId: "T1", action: "reply", post: "pOld" });
assert.deepEqual(planOutbound("chat:T1", row({ room: "chat:T1", kind: "say" }), deps), { via: "channel", topicId: "T1", action: "post" });

// ── ⑤ 旧配置键被忽略 ─────────────────────────────────────────────────────
const old = ConfigSchema.parse({
  bot: { botId: "test", secret: "test" }, defaultChat: "user:home",
  rooms: { binding: { decideTimeoutMin: 5, simMin: 0.5 } },
});
assert.equal(old.rooms?.binding?.simMin, 0.5, "旧键不拒启动, 其余键照常");
assert.ok("decideTimeoutMin" in (old.rooms?.binding ?? {}), "旧键原样保留 (passthrough), boot 时据此 warn 一次");

console.log("topic-room-of ok");
