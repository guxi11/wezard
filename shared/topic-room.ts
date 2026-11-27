// 频道帖子 room 的 id (docs/evolve/channel-topic-rooms.md §2.1): `topic:<topic_id>/<post_id>`。
//
// 频道归属从 id 本身读得出 —— 读模型 / 出站 / 引导都不必再查 channel-posts 映射。纯字符串, 不碰盘、
// 不 import daemon (shared/room.ts 的出站规划也要用)。topic_id / post_id 都是企微给的不透明 id, 不含
// `/` 与 `#` (`#` 是 target key 的 slot 分隔, 见 session-label.ts)。
export const TOPIC_ROOM_PREFIX = "topic:";

export interface TopicRoomRef { channel: string; post: string }

/** (频道, 帖子) → room id。 */
export const topicRoomId = (channel: string, post: string): string => TOPIC_ROOM_PREFIX + channel + "/" + post;

/** room id 是 topic room 吗 (只看形状)。 */
export const isTopicRoomId = (id: string): boolean => parseTopicRoomId(id) !== undefined;

/** `topic:<T>/<P>` → {channel: T, post: P}; 带 `#slot` 的 target key 先剥掉 slot; 不是 = undefined。 */
export const parseTopicRoomId = (id: string): TopicRoomRef | undefined => {
  if (!id.startsWith(TOPIC_ROOM_PREFIX)) return undefined;
  const rest = id.slice(TOPIC_ROOM_PREFIX.length).split("#")[0] ?? "";
  const i = rest.indexOf("/");
  if (i <= 0 || i === rest.length - 1) return undefined;
  return { channel: rest.slice(0, i), post: rest.slice(i + 1) };
};

/** topic room 的显示名: 「频道名 · 帖 xxxxxx」(频道没起名用 id 前 8 位; 帖用 post_id 末 6 位区分)。 */
export const topicRoomLabel = (ref: TopicRoomRef, channelName: string): string =>
  (channelName || ref.channel.slice(0, 8)) + " · 帖 " + ref.post.slice(-6);
