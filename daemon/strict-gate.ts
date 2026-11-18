import type { MemberMode } from "./members.js";

// 严格群发言闸的判定核 (纯函数): chat_say / chat_reply / notify / send_file 共用同一道门。
// 判定与记账分离 —— 这里只判「这一次让不让过」, 轮次/窗口的记账在调用方 (daemon/index.ts)。
// 语义 (2026-11-18 放宽, 人拍板「入群即发言权」): 成员 (owner/speaker/mention 任一在场方式)
// 在群里发言不再需要挂某条义务的回包 —— 同一条人话允许多条出站 (派活 ack、进展、结论都合法),
// 出站也不再把义务销账 (只有 chat_reply 的显式答复销账, 接线在 daemon/index.ts)。
// 仍拦的只有两件事: 非成员 403 = 100%、频控额度 (每轮 3 / 每群每分钟 10)。

export interface SayFacts {
  /** 在场方式; undefined = 非成员 (403)。owner/speaker/mention 发言权相同 —— mode 只记录入群方式。 */
  mode?: MemberMode;
  /** 本轮 (同一注入事件) 已用额度。 */
  turnUsed: number;
  /** 本群滚动 60s 窗口内已用额度。 */
  windowCount: number;
}

export type SayVerdict = { status: 403 | 409; reason: string } | undefined;

// topOnly 门 (chat_say 与 notify / send_file / chat_reply 共用同一道): 下层轮 —— 这一轮服务于同伴的活
// (有 serves 行且不直接对人收口) —— 不得在顶层模式群对人说话。判定核只收布尔事实,
// 路由行 / 管家豁免 (该群默认会话) 的接线在 daemon/index.ts 的 topOnlyMuted。
export interface TopOnlyFacts {
  /** 本轮是下层轮: 服务同伴 (有 serves 行且 speaksToHuman=false)。人直说 / CLI 直敲 / 定时任务 = false。 */
  belowTop: boolean;
  /** 目的群开着顶层模式 (chatPolicy.<chat>.topOnly)。 */
  topOnly: boolean;
  /** 调用方豁免: 是该群的默认会话 (untagged 且 base 相同) —— 管家在自己群里。 */
  exempt: boolean;
}

export const topOnlyVerdict = (f: TopOnlyFacts): boolean => f.topOnly && f.belowTop && !f.exempt;

export const sayVerdict = (f: SayFacts): SayVerdict => {
  if (!f.mode) return { status: 403, reason: "非成员 — 严格群里只有成员能开口; 让人点名你入群, 或由成员用 chat_ask 向你开义务" };
  if (f.turnUsed >= 3) return { status: 409, reason: "本轮发言额度 (3) 已用完 — 把要说的合并成一条再发" };
  if (f.windowCount >= 10) return { status: 409, reason: "这个群这一分钟的发言额度 (10) 已用完 — 稍后再发" };
  return undefined;
};

/** 通过即记账: 轮次额度按 (调用方, 当前注入事件) 归零, 窗口按群滚动 60s。 */
export interface SayMeter {
  /** key = 调用方 target + 当前注入事件; 群 = base principal。 */
  check: (caller: string, event: string, chat: string, now?: number) => { turnUsed: number; windowCount: number };
  /** verdict 通过后记一次。 */
  charge: (caller: string, event: string, chat: string, now?: number) => void;
}

export const openSayMeter = (): SayMeter => {
  const turn = new Map<string, { event: string; used: number }>();
  const window = new Map<string, number[]>();
  const prune = (chat: string, now: number): number[] => {
    const win = (window.get(chat) ?? []).filter((t) => now - t < 60_000);
    window.set(chat, win);
    return win;
  };
  return {
    check: (caller, event, chat, now = Date.now()) => {
      const prev = turn.get(caller);
      return { turnUsed: prev?.event === event ? prev.used : 0, windowCount: prune(chat, now).length };
    },
    charge: (caller, event, chat, now = Date.now()) => {
      const prev = turn.get(caller);
      const used = prev?.event === event ? prev.used : 0;
      turn.set(caller, { event, used: used + 1 });
      window.set(chat, [...prune(chat, now), now]);
    },
  };
};
