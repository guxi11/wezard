import type { MemberMode } from "./members.js";

// P7-S2 严格群发言闸的判定核 (纯函数): chat_say / notify / send_file 共用同一道门。
// 判定与记账分离 —— 这里只判「这一次让不让过」, 轮次/窗口的记账在调用方 (daemon/index.ts),
// 判据② (非成员 403 = 100%、mention 无有效 re 的 409 = 100%) 直接对着这张表测。

export interface SayFacts {
  /** 在场方式; undefined = 非成员 (403)。 */
  mode?: MemberMode;
  /** mention 模式时: 是否挂着指向自己、未结的义务 (re 有效)。 */
  hasValidRe: boolean;
  /** 本轮 (同一注入事件) 已用额度。 */
  turnUsed: number;
  /** 本群滚动 60s 窗口内已用额度。 */
  windowCount: number;
}

export type SayVerdict = { status: 403 | 409; reason: string } | undefined;

export const sayVerdict = (f: SayFacts): SayVerdict => {
  if (!f.mode) return { status: 403, reason: "非成员 — 严格群里只有成员能开口; 让人点名你入群, 或由成员用 chat_ask 向你开义务" };
  if (f.mode === "mention" && !f.hasValidRe)
    return { status: 409, reason: "mention 成员只能答指向自己的义务 — 用 chat_reply({re, text}) 交付, 或 chat_say 带有效的 re" };
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
