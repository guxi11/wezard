// 出站按行的目标源分流 (设计稿 docs/room/multi-source-binding.md §3.3 / §4.2, P2):
// reply 跟所 re 那一行的 src (缺省 = 主源 = room id), say / file / notify 回主源;
// 占位气泡盖在人话行的发生源上。src 缺省路径必须逐字节 = P2 之前的现行为。
import assert from "node:assert/strict";
import {
  bubbleSourceOf, outboundSourceOf, planOutbound,
  type MsgRow, type OutboundDeps,
} from "../shared/room.js";

const R = "chat:wrG";                       // 群 room (主源 = 群)
const POST_ROOM = "chat:opkP";              // 帖子 room (主源 = 帖子)
const CHANNEL = "chat:T1";                  // 频道 room (主源 = 频道)
const S_POST = "chat:opkS1";                // 绑进 R 的副源: 帖子
const S_GROUP = "chat:wrOther";             // 绑进 R 的副源: 群
const S_CHAN = "chat:T9";                   // 绑进 R 的副源: 另一条频道

const row = (over: Partial<MsgRow>): MsgRow => ({
  op: "msg", at: 1, room: R, id: "h.1", seq: 1, author: { kind: "human", id: "u1" },
  ord: 0, speak: "human", kind: "say", text: "x", wake: [], origin: "inbound", ...over,
} as MsgRow);

const deps = (o: {
  topic?: string[]; posts?: Record<string, { channel: string; post: string }>; wx?: string[];
  channelAction?: OutboundDeps["channelAction"];
} = {}): OutboundDeps => ({
  wxOwns: (id) => (o.wx ?? []).includes(id),
  isTopic: (base) => (o.topic ?? []).includes(base),
  postRefOf: (base) => o.posts?.[base],
  ...(o.channelAction ? { channelAction: o.channelAction } : {}),
});
const D = deps({
  topic: [CHANNEL, S_CHAN],
  posts: { [S_POST]: { channel: "T1", post: "p9" }, [POST_ROOM]: { channel: "T1", post: "p1" } },
  wx: ["wrWX"],
  channelAction: (r) => (r.re ?? []).includes("h.chan") ? { action: "reply", post: "p2" } : { action: "post" },
});
const byId = (rows: MsgRow[]) => (id: string) => rows.find((r) => r.id === id);

// ① re 到带 src 的行: 目标源 = 那条行的 src, 分流按该源类型走。
{
  const fromPost = row({ room: R, id: "h.post", src: S_POST, post: "p9" });
  const reply = row({ room: R, kind: "reply", id: "r.1", seq: 2, author: { kind: "wizard", id: "w1" }, speak: "member", origin: "tool", re: ["h.post"], status: "done" });
  const { source, fellBack } = outboundSourceOf(reply, byId([fromPost]));
  assert.equal(source, S_POST);
  assert.equal(fellBack, false);
  assert.deepEqual(planOutbound(source, reply, D), { via: "post", channel: "T1", post: "p9" }, "帖子源 → send_reply 评论根帖");

  const fromGroup = row({ room: R, id: "h.grp", src: S_GROUP });
  const replyT = (to: string) => row({ room: R, kind: "reply", id: "r.t", re: [to], origin: "tool" });
  assert.equal(outboundSourceOf(replyT("h.grp"), byId([fromGroup])).source, S_GROUP);
  assert.deepEqual(planOutbound(S_GROUP, reply, D), { via: "group", chatId: "wrOther" }, "群源 → 群消息");

  const fromChan = row({ room: R, id: "h.chan", src: S_CHAN });
  assert.deepEqual(planOutbound(S_CHAN, reply, D), { via: "channel", topicId: "T9", action: "post" }, "频道源 → 频道 (主动说 = 新帖)");

  const fromWx = row({ room: R, id: "h.wx", src: "chat:wrWX" });
  assert.equal(outboundSourceOf(replyT("h.wx"), byId([fromWx])).source, "chat:wrWX");
  assert.deepEqual(planOutbound("chat:wrWX", reply, D), { via: "wx", chatId: "wrWX" }, "wx 自管道优先");

  // 帖子源但 channel-posts 没配对: 不知道回哪条帖, 按群消息落到该源 (与 P2 之前未配对帖子 room 同口径)。
  const unpaired = row({ room: R, id: "h.unp", src: "chat:opkS2" });
  assert.equal(outboundSourceOf(replyT("h.unp"), byId([unpaired])).source, "chat:opkS2");
  assert.deepEqual(planOutbound("chat:opkS2", reply, D), { via: "group", chatId: "opkS2" });
}

// ② re 到无 src 的行 (存量账本): 目标源 = 主源, 现行为逐项不变。
{
  const human = row({ room: R, id: "h.main" });
  const reply = row({ room: R, kind: "reply", id: "r.2", re: ["h.main"], origin: "tool" });
  assert.deepEqual(outboundSourceOf(reply, byId([human])), { source: R, fellBack: false });
  assert.deepEqual(planOutbound(R, reply, D), { via: "group", chatId: "wrG" }, "群 room → 群消息");

  const postHuman = row({ room: POST_ROOM, id: "h.p" });
  const postReply = row({ room: POST_ROOM, kind: "reply", id: "r.3", re: ["h.p"], origin: "tool" });
  assert.deepEqual(planOutbound(outboundSourceOf(postReply, byId([postHuman])).source, postReply, D),
    { via: "post", channel: "T1", post: "p1" }, "帖子 room → 评论根帖");

  const chanHuman = row({ room: CHANNEL, id: "h.chan" });
  const chanReply = row({ room: CHANNEL, kind: "reply", id: "r.4", re: ["h.chan"], origin: "tool" });
  const chanSrc = outboundSourceOf(chanReply, byId([chanHuman])).source;
  assert.equal(chanSrc, CHANNEL);
  assert.deepEqual(planOutbound(chanSrc, chanReply, D), { via: "channel", topicId: "T1", action: "reply", post: "p2" },
    "频道 room 回评论行 → 评论回原帖 (channelOutboundOf 口径不变)");
  assert.deepEqual(planOutbound(CHANNEL, row({ room: CHANNEL, id: "s.1" }), D), { via: "channel", topicId: "T1", action: "post" },
    "频道 room 主动说 → 新帖");

  // re 查不到 (不在本 room 账本): 回落主源并置 fellBack (调用方记日志), 不炸。
  const lost = row({ room: R, kind: "reply", id: "r.5", re: ["nope.9"], origin: "tool" });
  assert.deepEqual(outboundSourceOf(lost, byId([])), { source: R, fellBack: true });
}

// ③ say / file (非 reply) 一律回主源 —— 即使它 re 到了副源的行。
{
  const fromPost = row({ room: R, id: "h.post", src: S_POST });
  const say = row({ room: R, id: "s.2", kind: "say", re: ["h.post"], author: { kind: "wizard", id: "w1" }, speak: "member", origin: "tool" });
  assert.deepEqual(outboundSourceOf(say, byId([fromPost])), { source: R, fellBack: false }, "say 不看 re");
  const file = row({ room: R, id: "f.1", kind: "file", re: ["h.post"], origin: "tool" });
  assert.equal(outboundSourceOf(file, byId([fromPost])).source, R);
  assert.deepEqual(planOutbound(R, say, D), { via: "group", chatId: "wrG" });
}

// ④ 占位气泡盖在人话行的发生源上; 与目标源不同的那条不盖。
{
  const bubble = row({ room: R, id: "h.bub", src: S_POST, bubble: { stream: "s1", expires: 9e12 } });
  const coverReply = row({ room: R, kind: "reply", id: "r.6", re: ["h.bub"], origin: "tool" });
  assert.equal(bubbleSourceOf(bubble), S_POST, "气泡的流属于人话的发生源");
  assert.equal(bubbleSourceOf(row({ room: R, id: "h.main2" })), R, "无 src = 主源");
  const target = outboundSourceOf(coverReply, byId([bubble])).source;
  assert.equal(target, S_POST);
  assert.equal(bubbleSourceOf(bubble) === target, true, "reply 回副源时盖同一条流");
  // 多 re 的边角: 目标源取第一条能查到的 re 行 (h.bub → 副源); 另一条主源行的气泡与之不同源 → 不盖。
  const mainRow = row({ room: R, id: "h.main3" });
  const odd = row({ room: R, kind: "reply", id: "r.7", re: ["h.bub", "h.main3"], origin: "tool" });
  const oddTarget = outboundSourceOf(odd, byId([bubble, mainRow])).source;
  assert.equal(oddTarget, S_POST, "取第一条能查到的 re 行作目标源");
  assert.equal(bubbleSourceOf(bubble) === oddTarget, true);
  assert.equal(bubbleSourceOf(mainRow) === oddTarget, false, "另一条源的气泡不盖");
}

console.log("outbound-src ok (reply 跟所 re 行的 src / 存量无 src = 现行为 / say·file 回主源 / 气泡按发生源 / re 查不到回落主源)");
