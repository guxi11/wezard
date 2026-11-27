// 频道帖子 → 频道 的映射 (人 2026-11-17 拍板: 整个 channel 需要统一管家; 2026-11-23 频道/帖子
// 都是 room 之后, 这里还多记一个 post 组件 —— 帖子 room 的出站 (send_reply) 要同时知道频道与根帖)。
//
// 企微频道里 @ 机器人的话以原生帧进来时 (compat_info.source=channel), chatid 是**每个帖子自己的**
// opk… 群 id, 帧里没有频道标识 (实测原始帧: msgid/aibotid/chatid/chattype/from/msgtype/text/
// quote/compat_info。注意 quote 不是被回复的那条, 而是整篇帖子摘要: 频道名 / 发帖人 / 发帖时间 /
// 帖子正文 / 回复 1..N —— 里外都没有 topic_id, 也不能当引用用, inbound 按形状丢弃它)。
// 频道标识 (topic_id) 只在同一句话的
// topic_at_bot 事件里 —— channel.ts 按「同一发话人、事件前后几秒内」把两路配对, 配上一次就把
// 帖子 base → {channel, post} 落进这里, 跟帖 room 的诞生 / 出站 / 管家绑定都据此判。
//
// 落盘格式: 新值 { channel: 裸 topic_id, post: 裸 opk… }, 旧盘上是裸 topic_id 字符串 —— 读侧
// 两种都认 (post 缺省时由 base 反推), 写侧一律新格式。
import { join } from "node:path";
import type { Config } from "../shared/config.js";
import { loadJsonMap, type JsonMap } from "../shared/json-map-store.js";
import { sleep } from "../shared/std.js";
import { parseTopicRoomId, topicRoomId } from "../shared/topic-room.js";

export interface ChannelPostRef { channel: string; post: string }

const stores = new Map<string, JsonMap<ChannelPostRef | string>>();
const storeOf = (cfg: Config): JsonMap<ChannelPostRef | string> => {
  const path = join(cfg.daemon.stateDir, "channel-posts.json");
  const hit = stores.get(path);
  if (hit) return hit;
  const s = loadJsonMap<ChannelPostRef | string>(path);
  stores.set(path, s);
  return s;
};

/** 读写兼容: 旧格式 (字符串 = 只有频道) 与 {channel, post} 都认。 */
const refOf = (v: ChannelPostRef | string | undefined): ChannelPostRef | undefined => {
  // 旧格式只有频道, 根帖 id 无从得知 (留空) —— 出站评论要它, 下一次配对自愈。
  if (typeof v === "string") return v ? { channel: v, post: "" } : undefined;
  if (v && typeof v.channel === "string" && v.channel) return { channel: v.channel, post: typeof v.post === "string" ? v.post : "" };
  return undefined;
};

/** 帖子 room 的 {频道, 根帖}: `topic:<T>/<P>` 直接从 id 拆 (2026-11-27 起新建的帖子 room 全是它);
 *  旧帖子 base (chat:opk…) 查配对表; 没配对过 = undefined。 */
export const postRefOf = (cfg: Config, base: string): ChannelPostRef | undefined =>
  parseTopicRoomId(base) ?? refOf(storeOf(cfg).get(base));

/** 帖子 base 所属频道的裸 topic_id; 没配对过 = ""。 */
export const channelOfPost = (cfg: Config, base: string): string => postRefOf(cfg, base)?.channel ?? "";

/** base 所属频道: topic room 从 id 拆, 旧帖子查映射; chat:<topic_id> 本身 (频道键 / 存档频道 room)
 *  在映射值或频道管家表里就是频道。 */
export const channelOf = (cfg: Config, base: string): string => {
  const post = channelOfPost(cfg, base);
  if (post || !base.startsWith("chat:")) return post;
  const bare = base.slice("chat:".length);
  const known = bare in (cfg.wrc.channel.steward ?? {})
    || Object.values(storeOf(cfg).all()).some((v) => refOf(v)?.channel === bare);
  return known ? bare : "";
};

/** 该频道里某个裸 post_id 在**旧口径**下配过对的帖子 base (chat:opk…); 没有 = undefined。 */
export const postBaseOf = (cfg: Config, topicId: string, postId: string): string | undefined =>
  Object.keys(storeOf(cfg).all())
    .find((b) => { const r = refOf(storeOf(cfg).get(b)); return r?.channel === topicId && !!r.post && r.post === postId; });

/** 该频道已配对的旧帖子 base (chat:opk…, 不含频道键自己 —— 它由 learnChannel 记进来, 根帖 id 为空)。 */
export const postsOfChannel = (cfg: Config, topicId: string): string[] =>
  Object.keys(storeOf(cfg).all())
    .filter((b) => { const r = refOf(storeOf(cfg).get(b)); return r?.channel === topicId && !!r.post; });

/** 记一个频道为已知频道 (映射里 chat:<topic_id> → {channel, post:""}): 未绑定、还没有帖子配对过的频道
 *  也要认得出 —— 引导 / 绑定落 wrc.channel.steward 都要先认出「这是一个频道」。幂等。
 *  频道本身没有 room (2026-11-27 起); 这条映射只是「已知频道」名单, 图上框标题 / read_channel 认频道用。 */
export const learnChannel = (cfg: Config, topicId: string): boolean =>
  learnChannelPost(cfg, "chat:" + topicId, topicId, "");

/** 已知频道的裸 topic_id 全集: 映射里出现过的 + 频道管家表里绑过的。 */
export const knownChannels = (cfg: Config): string[] => [...new Set([
  ...Object.values(storeOf(cfg).all()).flatMap((v) => refOf(v)?.channel ?? []),
  ...Object.keys(cfg.wrc.channel.steward ?? {}),
])];

/** 记一对 帖子 → {频道, 根帖}; 新学到或改了返回 true (没变不写盘)。
 *  postId 是频道自己的 post_id (send_reply 要它), 不是帖子群的 chatid (opk…) —— 两者不同。 */
export const learnChannelPost = (cfg: Config, base: string, topicId: string, postId: string): boolean => {
  if (!base || !topicId) return false;
  const cur = postRefOf(cfg, base);
  const next: ChannelPostRef = { channel: topicId, post: postId };
  if (cur && cur.channel === next.channel && cur.post === next.post) return false;
  storeOf(cfg).set(base, next);
  return true;
};

/** 读模型用: room id 是频道还是帖子 (帖子带根帖 id); 都不是 = undefined。
 *  频道 = 映射值里出现过的 topic, 或在频道管家表里绑过的 (chat:<topic_id>)。 */
export const channelRefOf = (cfg: Config, room: string): ChannelPostRef | undefined => {
  const post = postRefOf(cfg, room);
  if (post) return post.post ? post : { ...post, post: "" };
  if (!room.startsWith("chat:")) return undefined;
  const bare = room.slice("chat:".length);
  const known = bare in (cfg.wrc.channel.steward ?? {})
    || Object.values(storeOf(cfg).all()).some((v) => refOf(v)?.channel === bare);
  return known ? { channel: bare, post: "" } : undefined;
};

/** 最多等 waitMs 让配对落地 (原生帧可能先于 topic_at_bot 事件到)。 */
export const awaitChannelOfPost = async (cfg: Config, base: string, waitMs: number): Promise<string> => {
  for (let left = waitMs; ; left -= 100) {
    const hit = channelOfPost(cfg, base);
    if (hit || left <= 0) return hit;
    await sleep(100);
  }
};

/** 入站事件 → 它该落的 topic room (docs/evolve/channel-topic-rooms.md §3.1; 纯, 不开 room)。
 *  顺序 = 存量先: ① 帖子源曾被 room_bind 绑进某 room → 继续落那里 (对话不中途分家, 只读兼容; 原生帧的 opk
 *  与事件路径配对表反查到的旧源都要查, 否则「源已 bind 而 chat:<opk> room 从没诞生」会让没带 opk 的事件另开
 *  `topic:T/P` 与原生 @ 帧落的 R 分家); ② 已存在的 `topic:T/P` 就是这个帖子的 room (后来才诞生的
 *  chat:<opk> 顶不掉它); ③ 已诞生的旧帖子 room (chat:<opk>, **仅 kind 是 topic-post 或配对表里就是这个帖子的** —— 原生帧 2s 内没配上时
 *  inbound 会在 chat:<opk> 误生一个 wecom-group room, 它不是帖子 room) 与旧配对表反查 (事件路径没有 opk) 同理;
 *  都没有 = 新口径 topic:<T>/<P> —— 由 (频道, 帖子) 决定, 第一条事件就能算出, 之后被 @ 也不变。
 *  旧口径只在对应 room 真的存在时才认 (配过对但从没诞生过 room 的帖子不该落进一个不存在的 room)。 */
export const topicRoomOf = (a: {
  cfg: Config;
  topic: string;
  post: string;
  opk?: string;
  roomOfSource: (source: string) => string | undefined;
  roomExists: (room: string) => boolean;
  /** room 的 kind (账本里的 open 行); 缺省 = 不区分 (测试桩 / 旧接线, 存在即认)。 */
  roomKind?: (room: string) => string | undefined;
}): string => {
  const paired = postBaseOf(a.cfg, a.topic, a.post);
  // 存量帖子 room 在账本里记的 kind 是 wecom-group (旧版按群开的), 所以 kind 之外再认「配对表里就是这个帖子的
  // 源」; 没配对过、kind 又不是 topic-post 的 chat:<opk> = 误生的群 room, 不认。
  const legacyPostRoom = (r: string): boolean =>
    a.roomExists(r) && (!a.roomKind || a.roomKind(r) === "topic-post" || r === paired);
  const bound = [a.opk, paired].flatMap((src) => (src ? [a.roomOfSource(src)] : [])).find((r): r is string => !!r);
  if (bound) return bound;
  const fresh = topicRoomId(a.topic, a.post);
  if (a.roomExists(fresh)) return fresh;
  if (a.opk && legacyPostRoom(a.opk)) return a.opk;
  if (paired && legacyPostRoom(paired)) return paired;
  return fresh;
};

/** 一个频道名下所有 topic room (含旧 chat:<opk> 帖子 room); 不含存档频道 room (chat:<topic_id>)。
 *  roomIds 由调用方给 (账本里现有的全部 room id) —— 本模块不持有 room 账本。 */
export const topicRoomsOf = (cfg: Config, topicId: string, roomIds: readonly string[]): string[] =>
  roomIds.filter((r) => { const ref = postRefOf(cfg, r); return !!ref?.post && ref.channel === topicId; });
