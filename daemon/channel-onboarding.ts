// 频道引导 (人 2026-11-23 拍板: 「频道没有管家就该由 guide 接待并走引导绑定」)。
//
// 与群引导 (onboarding.ts / inbound.ts guideGate) 同构, 差别只在入口: 群是「bot 被拉进群,
// 第一条人话进 guideGate」, 频道没有这个时刻 —— 频道里的 room 由第一条帖子事件才诞生, 而且每一条
// 人话都可能来得比绑定早。所以判定放在这里, 落盘 / 起会话 / 收尸仍在 index.ts 的 room 块
// (只有它持有 hub 与 mirror), 本文件全是纯函数。
//
// 2026-11-27 (docs/evolve/channel-topic-rooms.md §5): 频道自己没有 room, 每个帖子一个 topic room。
// 引导的**状态键**仍是频道键 chat:<topic_id> (needsOnboarding / onboarding.begin 不需要键是 room),
// 引导化身 chat:<topic_id>#guide **入座人说话的那个 topic room** —— 同频道别的帖子再来人话就 join 那个
// room, 一个频道一条引导, 可同时是多个 topic room 的成员。
//
// 三条硬口径:
//   ① 引导期不建 perceptron —— shared/room.ts 的唤醒规则「有 perceptron 只唤醒它」会把每一条
//      没点名的人话从引导化身手里抢走, 引导就再也接不到话。
//   ② 引导是**频道**粒度: 一个频道一个管家、一条引导。topic room 在绑定前没有 host (人话归引导),
//      绑定后由管家每个 room 各坐一个实例 (settleBoundChannel)。
//   ③ 绑定落 wrc.channel.steward.<topic_id> (bindSteward 经 channelOf 认频道, channel-posts
//      的 learnChannel 保证未配对过帖子的频道也认得出), 落定后对引导所在的每个 topic room 做
//      guideHandoffOps, 各 room 坐本 room 的 steward 实例当 host。
import type { Config } from "../shared/config.js";
import { DAEMON, leaveOps, whoKey, type Draft, type RoomOp, type RoomState, type Who } from "../shared/room.js";
import { channelOf } from "./channel-posts.js";
import { needsOnboarding, guideTargetOf, type OnboardingStore } from "./onboarding.js";
import type { WizardStore } from "./wizard.js";

/** 人话所在 room 的**频道键** (chat:<topic_id>): topic room / 旧帖子 room 经 id 或映射回频道, 频道键
 *  自己 (存档频道 room) 就是自己。认不出 = "" (帖子还没跟频道配过对 —— 连「是不是频道」都不知道,
 *  按老路走)。注意它只是引导 / 绑定的状态键, 不是 room。 */
export const channelKeyOf = (cfg: Config, room: string): string => {
  const topic = channelOf(cfg, room);
  return topic ? "chat:" + topic : "";
};

/** 未绑定频道要引导? 与群同一把尺子 (needsOnboarding), 只是 base 换成频道键。
 *  已绑定 / 已有 untagged 默认会话 = false —— 引导期到此结束。 */
export const channelOnboardingNeeded = (cfg: Config, store: WizardStore | undefined, channelKey: string): boolean =>
  !!channelKey && needsOnboarding(cfg, store, channelKey);

/** 频道要不要 perceptron: 引导期之外都要 (口径①)。判据与引导同一把尺子 —— 已绑定、
 *  或已有 untagged 默认会话 (存量频道) 都算「不在引导期」, 照旧起 perceptron。 */
export const channelMonitorWanted = (cfg: Config, store: WizardStore | undefined, channelKey: string): boolean =>
  !!channelKey && !channelOnboardingNeeded(cfg, store, channelKey);

/** 引导化身进 topic room 的行: room 不在就先开, 引导作 founder; 已有就补一条 join。
 *  空数组 = 它已经在里面。它是最早加入者时自然当 host, 人话就落到它名下。 */
export const channelGuideJoinOps = (s: RoomState | undefined, room: string, guide: Who, at: number): RoomOp[] => {
  if (!s) return [
    { op: "open", at, room, kind: "topic-post", by: DAEMON },
    { op: "join", at, room, who: guide, ord: 1, via: "founder", by: DAEMON },
  ];
  if (s.members.has(whoKey(guide))) return [];
  return [{ op: "join", at, room, who: guide, ord: s.nextOrd, via: "inbound", by: DAEMON }];
};

/** 引导接手前把旧版本给未绑定频道建过的 perceptron 请出 room —— 有 perceptron 时人话只听
 *  它的, 引导就永远接不到 (口径①)。绑定后 ensurePerceptron 会把它请回来。 */
export const channelMonitorLeaveOps = (s: RoomState, at: number): RoomOp[] =>
  [...s.members.values()].filter((m) => m.role === "monitor")
    .flatMap((m) => leaveOps(s, m.who, DAEMON, at, "频道引导期, monitor 退场"));

/** 管家还不在这个 room 里就补一条 join (绑定落定 / 换绑 / boot 自愈用)。 */
export const hostJoinOps = (s: RoomState, who: Who, at: number): RoomOp[] =>
  s.members.has(whoKey(who)) ? [] : [{ op: "join", at, room: s.id, who, ord: s.nextOrd, via: "invite", by: DAEMON }];

/** topic room 诞生的行: 频道已绑定 (有 host 身份在本 room 的实例) 就把它当 founder; 未绑定 / 引导期
 *  只开 room —— 人话此刻归引导, 绑定后落定时补 host (口径②)。 */
export const topicRoomBirthOps = (room: string, founder: Who | undefined, at: number): RoomOp[] => [
  { op: "open", at, room, kind: "topic-post", by: DAEMON },
  ...(founder ? [{ op: "join" as const, at, room, who: founder, ord: 1, via: "founder" as const, by: DAEMON }] : []),
];

/** 未绑定频道的一条人话: 交给引导, 落**人说话的那个 topic room** (引导住的 room)。 */
export interface ChannelGuideTurn {
  /** 频道键 chat:<topic_id> (引导状态键)。 */
  key: string;
  /** 人话所在的 topic room —— 引导化身入座它。 */
  room: string;
  /** 引导化身 target (chat:<topic_id>#guide…)。 */
  guide: string;
  /** 第一次接手 (挂开篇话术) / 续接 (挂重试话术)。 */
  first: boolean;
  /** 人话行 (draft 形状)。 */
  human: Draft;
}

/** 这条人话该不该交给引导、交给谁。undefined = 不需要引导, 调用方走老路
 *  (已绑定 / 认不出频道 / 没有名册)。first 在 begin 之前判 —— 开篇话术只挂一次。 */
export const planChannelGuideTurn = (
  a: { cfg: Config; store: WizardStore | undefined; onboarding: OnboardingStore; room: string },
  e: { author: string; text: string; msgid: string; mention?: "bot" },
): ChannelGuideTurn | undefined => {
  const key = channelKeyOf(a.cfg, a.room);
  if (!key || !a.store || !channelOnboardingNeeded(a.cfg, a.store, key)) return undefined;
  const first = !a.onboarding.get(key);
  a.onboarding.begin(key);
  const guide = guideTargetOf(a.store, key);
  const human: Draft = {
    author: { kind: "human", id: e.author }, kind: "say", text: e.text, origin: "inbound", ext: e.msgid,
    ...(e.mention ? { mention: e.mention } : {}),
  };
  // 引导在 topic room 的入座 (channelGuideJoinOps) 由调用方在 upsert 之后现算 —— 新记录此刻还没有 uid。
  return { key, room: a.room, guide, first, human };
};
