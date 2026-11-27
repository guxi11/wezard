// 频道开新帖 (docs/evolve/channel-topic-rooms.md §3.2 / §9-③): `chat_say({room:"chat:<topic_id>"})` ——
// 频道自己没有 room, 它的 id 在这里只是个「开新帖」的虚地址。流程: send_post → 回包里的 post_id →
// 开 `topic:<T>/<post_id>` → 这条话记进新 room (**不再 mirror**: send_post 本身就是外发)。
//
// 先发后记: 发帖失败 = 不写任何行 (账本里不留一句没说出去的话); 发成功拿不到 post_id = 帖子已经在频道里了,
// 不编造 room, 带 warning 回给调用方。纯编排, 传输 / 账本都由调用方注入, 便于不起 daemon 就测。
import { DAEMON, whoKey, type RoomOp, type RoomState, type Verdict, type Who } from "../shared/room.js";
import { topicRoomId } from "../shared/topic-room.js";
import { hostJoinOps, topicRoomBirthOps } from "./channel-onboarding.js";
import type { TopicPostResult } from "./channel.js";

/** 虚地址: `chat:<T>` 且 T 就是一个已知频道 (旧频道 room 与频道本身); 其余 (含旧 chat:<opk> 帖子 room) = undefined。
 *  channelOf 对帖子 base 也返回频道, 所以要再比一次 id 本身。 */
export const newPostChannelOf = (ref: string | undefined, channelOf: (base: string) => string): string | undefined => {
  const raw = (ref ?? "").trim();
  if (!raw.startsWith("chat:")) return undefined;
  const topic = channelOf(raw);
  return topic && raw === "chat:" + topic ? topic : undefined;
};

/** 调用方给的 room 引用 (全 id / #hash8 / 聊天名) 指到存档频道 room 也算虚地址: 全 id 直接判, 其余先经 resolve
 *  还原成 room id 再判 —— 与写全 id `chat:<T>` 同一口径。 */
export const newPostTopicOfRef = (
  ref: string | undefined, resolve: (ref: string) => string | undefined, channelOf: (base: string) => string,
): string | undefined => newPostChannelOf(ref, channelOf) ?? newPostChannelOf(resolve((ref ?? "").trim()), channelOf);

/** send_post 回包里的 post_id。字段名在真机上没确认过, 常见形状都认: 顶层 / data / post。 */
export const postIdOfBody = (body: unknown): string | undefined => {
  const b = (body ?? {}) as Record<string, any>;
  const hit = [b.post_id, b.postid, b.data?.post_id, b.post?.post_id, b.post?.id, b.data?.post?.post_id]
    .find((v) => (typeof v === "string" && v.trim() !== "") || typeof v === "number");
  return hit === undefined ? undefined : String(hit).trim();
};

/** 发新帖的预检输入 (调用方身份的四个事实, 由 daemon 现查)。 */
export interface NewPostCaller {
  /** perceptron / monitor 身份 (只许 room_activate, 不发言)。 */
  monitor: boolean;
  /** 引导化身 (只在本群 room 说话)。 */
  guide: boolean;
  /** 是该频道 host 类 (`wrc.channel.steward.<T>` 绑的身份) 的某个实例。 */
  hostClass: boolean;
  /** 是存档频道 room `chat:<T>` 的成员。 */
  archiveMember: boolean;
}

export type NewPostGate = { ok: true } | { ok: false; status: 403; reason: string };

/** 开新帖要过的硬门 —— **在 send_post 之前**判 (先发后判 = 帖子已经出去了才被拒, 外发收不回): 拒 monitor / 引导化身;
 *  其余调用方须是该频道 host 类的实例, 或存档频道 room 的成员。judge 管不到这条路 (帖子 room 此刻还没有)。 */
export const newPostGate = (c: NewPostCaller): NewPostGate => {
  if (c.monitor) return { ok: false, status: 403, reason: "perceptron 不发言, 更不开新帖 (它只 room_activate)" };
  if (c.guide) return { ok: false, status: 403, reason: "引导会话不开新帖" };
  if (c.hostClass || c.archiveMember) return { ok: true };
  return { ok: false, status: 403, reason: "不是这个频道的 host (或频道存档 room 的成员), 不能开新帖: 请频道 host 发帖" };
};

/** 新帖 room 的座位行: 诞生时 founder (= host) 取频道 host 身份在**本 room** 的实例, 频道没绑 (founder 缺省) 才退成
 *  调用方; 调用方作为普通成员入座 (账本行仍记它为作者); room 已存在则只保证调用方在里面。 */
export const newPostSeatOps = (s: RoomState | undefined, room: string, founder: Who | undefined, me: Who, at: number): RoomOp[] =>
  s ? hostJoinOps(s, me, at) : [
    ...topicRoomBirthOps(room, founder ?? me, at),
    ...(founder && whoKey(founder) !== whoKey(me) ? [{ op: "join" as const, at, room, who: me, ord: 2, via: "invite" as const, by: DAEMON }] : []),
  ];

/** 最近自己发出的帖子 post_id (内存环, 有上限): 机器人自己发的帖子企微也会回推 topic_event,
 *  asker 为空 (`!asker`) 是主判据, 这是双保险 —— 万一回推带了发话人也不把自己的新帖当人话落成一行。 */
export const createSelfPostLog = (cap = 200): { add: (post: string) => void; has: (post: string) => boolean } => {
  const ring = new Set<string>();
  return {
    add: (post) => { ring.delete(post); ring.add(post); if (ring.size > cap) ring.delete(ring.values().next().value!); },
    has: (post) => ring.has(post),
  };
};

export type NewPostOutcome =
  | { ok: true; room: string; post: string; verdict: Verdict; warning?: string }
  | { ok: true; warning: string }
  | { ok: false; status: number; reason: string };

export interface NewPostDeps {
  /** 调用方身份事实: 预检在 send 之前, 不过 = 403 且零外发。 */
  caller: NewPostCaller;
  /** 真发帖 (传输层抛错 = 发帖失败)。 */
  send: () => Promise<TopicPostResult>;
  /** 新 room 不存在就开 (调用方入座成员, 频道 host 实例照常入座); 已存在则只保证调用方在里面。 */
  ensureRoom: (room: string) => void;
  /** 把这句话记进新 room, 不外发。 */
  record: (room: string) => Verdict;
  /** 帖子发出且拿到 post_id 的一刻 (先于开 room): 记进最近自发集合。 */
  remember?: (post: string) => void;
  /** 一行 info: 真实回包形状 (便于以后真机确认 post_id 字段)。 */
  logShape: (o: { topic: string; keys: string[]; postId: string; errcode?: number }) => void;
}

export const NO_POST_ID_WARNING = "发帖成功但拿不到 post_id, 这帖之后有人 @ 时会作为新 topic room 到来; 要接着说请在已有帖子 room 评论";

const keysOf = (body: unknown): string[] =>
  body && typeof body === "object" ? Object.keys(body as object).slice(0, 12) : [];

export const channelNewPost = async (topic: string, d: NewPostDeps): Promise<NewPostOutcome> => {
  const gate = newPostGate(d.caller);
  if (!gate.ok) return gate;
  let sent: TopicPostResult;
  try { sent = await d.send(); }
  catch (e) { return { ok: false, status: 502, reason: "发新帖失败: " + (e instanceof Error ? e.message : String(e)) }; }
  const postId = postIdOfBody(sent.body);
  d.logShape({ topic, keys: keysOf(sent.body), postId: postId ?? "", ...(sent.errcode ? { errcode: sent.errcode } : {}) });
  if (!sent.ok) return { ok: false, status: 502, reason: "发新帖被企微拒绝: " + (sent.errmsg || "errcode " + sent.errcode) };
  if (!postId) return { ok: true, warning: NO_POST_ID_WARNING };
  d.remember?.(postId);
  const room = topicRoomId(topic, postId);
  try { d.ensureRoom(room); }
  catch (e) { return { ok: true, warning: "帖子已发出 (" + postId + "), 但开 room 失败: " + (e instanceof Error ? e.message : String(e)) }; }
  const verdict = d.record(room);
  return verdict.ok
    ? { ok: true, room, post: postId, verdict }
    : { ok: true, room, post: postId, verdict, warning: "帖子已发出, 但这句话没记进账本: " + verdict.reason };
};
