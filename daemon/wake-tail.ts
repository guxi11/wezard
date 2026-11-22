// 人话唤醒时挂的提醒尾巴: 管家自查 (steward hint) 与点名提示 (mention)。
//
// 它们原先由 inbound 拼好、连同人的原话一起写成账本行 text —— 尾巴于是落进了账本,
// room_read / rolepage 的人话气泡里出现 `<hint>` `<roster>`, 行文本还要和 500 字预算抢位。
// 现在账本行只存人的原话; 尾巴在**唤醒渲染** (room-hub deliver) 那一刻按「被唤醒的 wizard
// + 触发它的人话行」现算, 经 injectText 的 `lead` 挂在这次注入末尾 (与名册增量同一道边界:
// pane 闸放行之后才渲染并记去重; 放行后贴失败 / uncertain 同名册增量, 这次的提示算用掉)。
//
// 只在**触发行里有人话**时才挂: 同伴 / 回执 / 定时那几轮不是新来的活, 也没有 `.x` 可点名。
import type { Config } from "../shared/config.js";
import { isBoundRoom, rowText, type MsgRow } from "../shared/room.js";
import { allNames } from "../shared/session-label.js";
import type { MirrorBridge } from "./mirror-bridge.js";
import { chatNameOf, stewardTierOf } from "./chat-name.js";
import type { Part, WakeTail } from "./notices.js";
import { peerMentionPart, renderStewardHint, type PeerMention } from "./peers.js";
import { wizardStore } from "./wizard.js";

// 人话里的 `.x` 可能是在指另一个 wizard (路由用掉的开头那个 `.name` 已在入站时摘走, 账本行存的
// 就是摘过的)。解析走 bridge 自己的 resolvePeerTag —— peer 工具用的同一套 (全局名册),
// 所以标注出来的地址一定是 peek_peer / chat_ask 打得中的; 解析不到的 `.foo` 与自指静默略过。
export const peerMentionsOf = (bridge: Pick<MirrorBridge, "resolvePeerTag" | "getCwd">, cfg: Config) =>
  (who: string, text: string): PeerMention[] => {
    const seen = new Set<string>();
    return allNames(text).flatMap((name): PeerMention[] => {
      const r = bridge.resolvePeerTag(who, name);
      if (!r.ok || r.target === who || seen.has(r.target)) return [];
      seen.add(r.target);
      const { runningCwd, defaultCwd } = bridge.getCwd(r.target);
      return [{
        tag: name,
        target: r.target,
        chat: chatNameOf(cfg, r.target),
        foreign: r.foreign,
        job: wizardStore()?.get(r.target)?.description ?? "",
        cwd: runningCwd || defaultCwd,
      }];
    });
  };

export interface WakeTailPorts {
  /** 被唤醒的 wizard 是不是某个群的管家 (stewardTierOf)。 */
  isSteward: (target: string) => boolean;
  mentionsOf: (who: string, text: string) => PeerMention[];
  /** 收件人自己的工作区: 同工作区的同伴点名行不重复写 cwd。 */
  cwdOf: (target: string) => string;
}

const byTarget = (ms: readonly PeerMention[]): PeerMention[] =>
  [...new Map(ms.map((m) => [m.target, m] as const)).values()];

/** 触发这次唤醒的行 → 要挂的尾巴; 没有人话行 = undefined (什么也不挂)。 */
export const humanWakeTail = (ports: WakeTailPorts, target: string, triggers: readonly MsgRow[]): WakeTail | undefined => {
  const human = triggers.filter((r) => r.author.kind === "human");
  if (!human.length) return undefined;
  const steward: Part = () => ({ text: renderStewardHint(), keys: [] });
  // rowText: 还没投递的老行 text 末尾可能带着旧尾巴 (名册 / hint 里有 `.name`), 不能当成人在点名。
  const mentions = byTarget(human.flatMap((r) => ports.mentionsOf(target, rowText(r))));
  const last = human.at(-1)!;
  return {
    lead: [...(ports.isSteward(target) ? [steward] : []), peerMentionPart(mentions, ports.cwdOf(target))],
    // 人在哪个群说的 (账本行所在 room, 绑定 room 的 id 就是群的 base principal)。
    via: { human: { channel: last.room } },
    // 这一轮的出处: 与 turn-opening 读回的同一条「最后一条人话」, dm / adhoc 是私下 ""。live 路径靠它 (reload 才读 transcript)。
    channel: isBoundRoom(last.room) ? last.room : "",
    speaker: "user:" + last.author.id,
  };
};

/** room-hub 唤醒贴进 pane 时的 injectText 选项: 一律 requireIdle; 有人话触发行时再带上尾巴与这一轮的出处
 *  (channel / speaker, 与 reload 后 turnOpening 同规则) —— 没有人话触发的唤醒保持缺省 (不传)。 */
export const wakeInjectOpts = (tail: WakeTail | undefined): { requireIdle: true; tail?: WakeTail; channel?: string; speaker?: string } =>
  ({ requireIdle: true, ...(tail ? { tail, channel: tail.channel, speaker: tail.speaker } : {}) });

/** 生产接线: steward 判定 / 点名解析 / 工作区都取自守护进程的真实依赖。 */
export const wakeTailPorts = (cfg: Config, bridge: Pick<MirrorBridge, "resolvePeerTag" | "getCwd">): WakeTailPorts => ({
  isSteward: (t) => !!stewardTierOf(cfg, t),
  mentionsOf: peerMentionsOf(bridge, cfg),
  cwdOf: (t) => ((c) => c.runningCwd || c.defaultCwd)(bridge.getCwd(t)),
});
