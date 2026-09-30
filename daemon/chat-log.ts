// 聊天记录的纯文本渲染 —— 让 wizard 像人翻聊天记录那样读一个群 / 一段私聊。
//
// 来源只有各个会话自己的 transcript (jsonl), 不经过 turn store: 一个群的记录 =
// 每个在里面说过话的 wizard 的「问话 + 终句」, 按时刻并起来。一句话属于哪个频道、
// 是谁说的, 读它挂着的信封 (peers.parseEnvelope); 没挂信封的就是人在这个会话的
// home 聊天里说的。只要正文: 一个来回取问话与终句, 不要工具调用, 不要保温 ping,
// 不回 json —— 读的是模型, 每一个字段名都是它要付的 token。
//
// 选哪些消息是三级收窄, 与 rolepage 同一条轴: role (谁的视角) → chat (哪个群) →
// target (和谁的往来), 每一级都可以不给; 再按时间窗与条数裁。
import { stripSigil } from "../shared/session-label.js";
import { truncateWithCount } from "../shared/std.js";
import { talkRounds } from "./peers.js";

/** 一个要被读的会话。 */
export interface LogSession {
  /** 它在记录里的称呼 (`.name`)。 */
  name: string;
  jsonlPath: string;
  /** home 聊天的名字 —— 没挂信封的话落在这里。 */
  homeChat: string;
  /** home 聊天里说话的人 (单聊就是那个人, 群里不知道是谁)。 */
  homeHuman: string;
  /** 早于这个时刻的不算它的: 分身的 transcript 开头是从父亲那里 fork 来的整段历史。 */
  since: number;
}

export interface ChatLogQuery {
  /** 只留这个 role 说的或听的 (wizard 的 `.name` / 人的 userid)。 */
  role?: string;
  /** 只留这个群 (名字) 里公开说的; 不给 = 公开与私聊都算, 每行标出在哪说的。 */
  chat?: string;
  /** 只留与这个 role 的往来 —— 通常与 `role` 同给, 即两方之间。 */
  target?: string;
  /** 时间窗 [since, until), epoch ms。 */
  since?: number;
  until?: number;
  /** 最多回多少条: 只给了 `since` 就从它往后数, 否则取窗口里最新的。 */
  limit: number;
  /** 单条正文的字数上限。 */
  per: number;
}

interface LogMsg {
  ts: number;
  from: string;
  to: string;
  private: boolean;
  /** 公开轮所在群的名字。 */
  chat: string;
  text: string;
}

const same = (a: string, b: string): boolean => stripSigil(a).toLowerCase() === stripSigil(b).toLowerCase();

/** 一个会话的来回 → 入/出两条消息。最后一个来回还没有回答就如实说, 而不是装作
 *  没人问过。 */
const messagesOf = (s: LogSession, q: ChatLogQuery, pingSigs: readonly string[]): LogMsg[] =>
  talkRounds(s.jsonlPath, q.limit, pingSigs, q)
    .flatMap((round, i, all): LogMsg[] => {
      const ask = round[0]!;
      const answer = round.filter((t) => t.role === "assistant").at(-1);
      const env = ask.env;
      const from = env?.from ?? s.homeHuman;
      const where = { private: !!env?.private, chat: env?.private ? "" : env?.chat || s.homeChat };
      const at = ask.ms ?? 0;
      return [
        { ts: at, from, to: s.name, ...where, text: ask.text },
        ...(answer ? [{ ts: answer.ms ?? at, from: s.name, to: from, ...where, text: answer.text }] : []),
        ...(!answer && i === all.length - 1 ? [{ ts: at + 1, from: s.name, to: from, ...where, text: "(还没有回复)" }] : []),
      ];
    })
    .filter((m) => m.ts >= s.since);

const pad = (n: number): string => String(n).padStart(2, "0");
const clock = (d: Date, sec: boolean): string => `${pad(d.getHours())}:${pad(d.getMinutes())}${sec ? `:${pad(d.getSeconds())}` : ""}`;
const day = (d: Date): string => `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
/** 当天只写时刻, 隔天带上日期 —— 和人看聊天记录时的时间戳一个读法。 */
const stamp = (ts: number, now: number): string => {
  const d = new Date(ts);
  return d.toDateString() === new Date(now).toDateString() ? clock(d, false) : `${day(d)} ${clock(d, false)}`;
};
/** 翻页用的时刻: 带秒, 原样传回 `since` / `until` (parseWhen 认得)。 */
const cursor = (ts: number): string => `${day(new Date(ts))} ${clock(new Date(ts), true)}`;

const UNIT_MS = { m: 60_000, h: 3_600_000, d: 86_400_000 } as const;
/** 人怎么说时间就怎么收: `2h` / `30m` / `3d` (多久以前)、`14:30` (今天)、
 *  `09-30 14:30[:05]` (今年)、或任何 Date 认得的写法。认不出 = undefined。 */
export const parseWhen = (raw: string, now: number): number | undefined => {
  const s = raw.trim();
  const ago = s.match(/^(\d+)\s*([mhd])$/i);
  if (ago) return now - Number(ago[1]) * UNIT_MS[ago[2]!.toLowerCase() as keyof typeof UNIT_MS];
  const hm = s.match(/^(?:(\d{1,2})-(\d{1,2})\s+)?(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (hm) {
    const d = new Date(now);
    if (hm[1]) d.setMonth(Number(hm[1]) - 1, Number(hm[2]));
    d.setHours(Number(hm[3]), Number(hm[4]), Number(hm[5] ?? 0), 0);
    return d.getTime();
  }
  const t = Date.parse(s);
  return Number.isNaN(t) ? undefined : t;
};

export const renderChatLog = (
  sessions: readonly LogSession[],
  q: ChatLogQuery,
  pingSigs: readonly string[],
  now: number,
): { text: string; shown: number; total: number; earlier?: string; later?: string } => {
  const involves = (m: LogMsg, who?: string): boolean => !who || same(who, m.from) || same(who, m.to);
  const hits = sessions
    .flatMap((s) => messagesOf(s, q, pingSigs))
    .filter((m) => (q.chat === undefined || (!m.private && same(m.chat, q.chat))) && involves(m, q.role) && involves(m, q.target))
    .filter((m) => m.ts >= (q.since ?? 0) && m.ts < (q.until ?? Infinity))
    .sort((a, b) => a.ts - b.ts);
  // 只给了 since 是「从那时起往后读」; 其余都是「窗口里最新的那几条」。
  const forward = q.since !== undefined && q.until === undefined;
  const shown = forward ? hits.slice(0, q.limit) : hits.slice(-q.limit);
  const where = (m: LogMsg): string => (q.chat !== undefined ? "" : m.private ? " · 私聊" : ` · 群 ${m.chat}`);
  const cut = hits.length > shown.length;
  return {
    text: shown.map((m) => `[${stamp(m.ts, now)}${where(m)}] ${m.from} → ${m.to}: ${truncateWithCount(m.text, q.per)}`).join("\n"),
    shown: shown.length,
    total: hits.length,
    // 每个会话只往回读到攒够 limit 个来回, 所以「更早的」永远可能还有 —— 有显示就给游标。
    ...(shown.length && !forward ? { earlier: cursor(shown[0]!.ts) } : {}),
    ...(forward && cut ? { later: cursor(shown[shown.length - 1]!.ts + 1000) } : {}),
  };
};
