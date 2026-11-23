// 频道帖子 → 频道 的映射 (人 2026-11-17 拍板: 整个 channel 需要统一管家; 2026-11-23 频道/帖子
// 都是 room 之后, 这里还多记一个 post 组件 —— 帖子 room 的出站 (send_reply) 要同时知道频道与根帖)。
//
// 企微频道里 @ 机器人的话以原生帧进来时 (compat_info.source=channel), chatid 是**每个帖子自己的**
// opk… 群 id, 帧里没有频道标识 (实测原始帧: msgid/aibotid/chatid/chattype/from/msgtype/text/
// quote/compat_info, quote 正文里只有频道的显示名)。频道标识 (topic_id) 只在同一句话的
// topic_at_bot 事件里 —— channel.ts 按「同一发话人、事件前后几秒内」把两路配对, 配上一次就把
// 帖子 base → {channel, post} 落进这里, 跟帖 room 的诞生 / 出站 / 管家绑定都据此判。
//
// 落盘格式: 新值 { channel: 裸 topic_id, post: 裸 opk… }, 旧盘上是裸 topic_id 字符串 —— 读侧
// 两种都认 (post 缺省时由 base 反推), 写侧一律新格式。
import { join } from "node:path";
import type { Config } from "../shared/config.js";
import { loadJsonMap, type JsonMap } from "../shared/json-map-store.js";
import { sleep } from "../shared/std.js";

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

/** 帖子 base (chat:opk…) 的配对 {频道, 根帖}; 没配对过 = undefined。 */
export const postRefOf = (cfg: Config, base: string): ChannelPostRef | undefined => refOf(storeOf(cfg).get(base));

/** 帖子 base 所属频道的裸 topic_id; 没配对过 = ""。 */
export const channelOfPost = (cfg: Config, base: string): string => postRefOf(cfg, base)?.channel ?? "";

/** base 所属频道: 帖子查映射; chat:<topic_id> 本身 (频道 room) 在映射值或频道管家表里就是频道。 */
export const channelOf = (cfg: Config, base: string): string => {
  const post = channelOfPost(cfg, base);
  if (post || !base.startsWith("chat:")) return post;
  const bare = base.slice("chat:".length);
  const known = bare in (cfg.wrc.channel.steward ?? {})
    || Object.values(storeOf(cfg).all()).some((v) => refOf(v)?.channel === bare);
  return known ? bare : "";
};

/** 该频道里某个裸 post_id 已经诞生的帖子 room base (chat:opk…); 没有 = undefined。 */
export const postBaseOf = (cfg: Config, topicId: string, postId: string): string | undefined =>
  Object.keys(storeOf(cfg).all())
    .find((b) => { const r = refOf(storeOf(cfg).get(b)); return r?.channel === topicId && !!r.post && r.post === postId; });

/** 该频道已配对的帖子 base (不含频道 room 自己 —— 它由 learnChannelRoom 记进来, 根帖 id 为空)。 */
export const postsOfChannel = (cfg: Config, topicId: string): string[] =>
  Object.keys(storeOf(cfg).all())
    .filter((b) => { const r = refOf(storeOf(cfg).get(b)); return r?.channel === topicId && !!r.post; });

/** 记一个频道 room 本身 (chat:<topic_id>) 为已知频道: 未绑定、还没有帖子配对过的频道也要认得出
 *  —— 引导 / 绑定落 wrc.channel.steward 都要先认出「这是一个频道」。幂等。 */
export const learnChannelRoom = (cfg: Config, topicId: string): boolean =>
  learnChannelPost(cfg, "chat:" + topicId, topicId, "");

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
