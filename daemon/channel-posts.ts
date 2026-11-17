// 频道帖子 → 频道 的映射 (人 2026-11-17 拍板: 「整个 channel 需要一个管家, 绑定时候也绑定的是
// channel 的统一管家, 每个 topic 都复用此管家配置」)。
//
// 企微频道里 @ 机器人的话以原生帧进来时 (compat_info.source=channel), chatid 是**每个帖子自己的**
// opk… 群 id, 帧里没有频道标识 (实测原始帧: msgid/aibotid/chatid/chattype/from/msgtype/text/
// quote/compat_info, quote 正文里只有频道的显示名)。频道标识 (topic_id) 只在同一句话的
// topic_at_bot 事件里 —— channel.ts 按「同一发话人、事件前后几秒内」把两路配对, 配上一次就把
// 帖子 base → topic_id 落进这里, 管家绑定 / 引导 / 接待据此按频道键判 (steward.ts / onboarding.ts)。
// 判据边界: 一个帖子要被 @ 过一次且两路都到 (topic_at_bot 事件与原生帧) 才认得出; 认出之前它
// 只是一个普通群。同一个人几秒内在两个频道各 @ 一次可能配错 (后到的覆盖, 下一次配对自愈)。
import { join } from "node:path";
import type { Config } from "../shared/config.js";
import { loadJsonMap, type JsonMap } from "../shared/json-map-store.js";
import { sleep } from "../shared/std.js";

const stores = new Map<string, JsonMap<string>>();
const storeOf = (cfg: Config): JsonMap<string> => {
  const path = join(cfg.daemon.stateDir, "channel-posts.json");
  const hit = stores.get(path);
  if (hit) return hit;
  const s = loadJsonMap<string>(path);
  stores.set(path, s);
  return s;
};

/** 帖子 base (chat:opk…) 所属频道的裸 topic_id; 没配对过 = ""。 */
export const channelOfPost = (cfg: Config, base: string): string => storeOf(cfg).get(base) ?? "";

/** base 所属频道: 帖子查映射; chat:<topic_id> 本身 (桥接帧的 base) 在映射值或频道管家表里就是频道。 */
export const channelOf = (cfg: Config, base: string): string => {
  const post = channelOfPost(cfg, base);
  if (post || !base.startsWith("chat:")) return post;
  const bare = base.slice("chat:".length);
  const known = bare in (cfg.wrc.channel.steward ?? {}) || Object.values(storeOf(cfg).all()).includes(bare);
  return known ? bare : "";
};

/** 该频道已配对的帖子 base。 */
export const postsOfChannel = (cfg: Config, topicId: string): string[] =>
  Object.entries(storeOf(cfg).all()).filter(([, t]) => t === topicId).map(([b]) => b);

/** 记一对 帖子 → 频道; 新学到或改了返回 true (没变不写盘)。 */
export const learnChannelPost = (cfg: Config, base: string, topicId: string): boolean => {
  if (!base || !topicId || channelOfPost(cfg, base) === topicId) return false;
  storeOf(cfg).set(base, topicId);
  return true;
};

/** 最多等 waitMs 让配对落地 (原生帧可能先于 topic_at_bot 事件到)。 */
export const awaitChannelOfPost = async (cfg: Config, base: string, waitMs: number): Promise<string> => {
  for (let left = waitMs; ; left -= 100) {
    const hit = channelOfPost(cfg, base);
    if (hit || left <= 0) return hit;
    await sleep(100);
  }
};
