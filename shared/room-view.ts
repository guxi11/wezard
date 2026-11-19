// room 的读模型 —— 账本状态 (shared/room.ts 的 fold 结果) → rolepage / room_read 要的形状。
//
// 纯函数, 无 IO: 名字一律由调用方注入 (svr 侧没有 wizard 注册表, 名字随快照带过来;
// daemon 侧从 wizards 表现查)。这一层只做三件事:
//   ① 快照: 每个 room 的成员 / host / 最后一句 / 未决 duty 数 (WorldFacts.rooms);
//   ② 历史: 一个 room 的消息分页 (rolepage 的 room 视图);
//   ③ 视图: 一个 wizard 的 W-1 (它说的 + 指向它的) / W-2 (它所在全部 room 的全部消息);
//   以及给 room_read 的纯文本渲染。
//
// 消息的「出处 / 完成 / 发言权」都在账本行上 (author / status / speak), 这里不再推断任何
// 一样 —— 名字只是把 uid 换成给人看的写法。
import {
  holderOf, openDuties, roomHost, sameWho, whoKey,
  renderMsgLine, type FileRef, type JoinVia, type MsgKind, type MsgOrigin, type MsgRow,
  type ReplyStatus, type RenderNames, type RoomKind, type RoomState, type SpeakBasis, type Who,
  isBoundRoom,
} from "./room.js";
import { stripSigil } from "./session-label.js";

// ── 快照 ───────────────────────────────────────────────────────────────

export interface RoomMemberFact {
  who: Who;
  name: string;
  via: JoinVia;
  since: number;
  ord: number;
  /** 此刻是 host (wizard 成员里加入序最小的那位); 人永不 true。 */
  host: boolean;
}

export interface RoomLastFact { seq: number; at: number; author: Who; authorName: string; preview: string }

/** 一个 room 的一句话快照 —— 关系图节点 / room 头部。 */
export interface RoomFact {
  id: string;
  kind: RoomKind;
  /** 只有 room_open 显式给了才有; 绑定 room 的显示名由 chatNames[id] 给。 */
  title: string;
  /** 绑定了传输 (企微群 / 单聊 / topic 帖 / 微信), 镜像进群。 */
  bound: boolean;
  /** undefined = 没有 wizard 成员 (人兜底 / 待人话触发 onboarding)。 */
  host?: Who;
  members: RoomMemberFact[];
  last?: RoomLastFact;
  /** 未决 duty 数 (读时 fold, 不落盘)。 */
  openDuties: number;
}

const KIND_BY_PREFIX = (id: string): RoomKind =>
  id.startsWith("dm:") ? "dm"
  : id.startsWith("adhoc:") ? "adhoc"
  : id.startsWith("user:") ? "wecom-dm"
  : id.startsWith("chat:wx") ? "wx"
  : "wecom-group";

export const roomKindOf = (s: RoomState): RoomKind => s.kind ?? KIND_BY_PREFIX(s.id);

const stripMd = (t: string): string => t.replace(/[`*_~|#>]/g, "").replace(/\s+/g, " ").trim();

export const buildRoomFact = (s: RoomState, n: RenderNames): RoomFact => {
  const host = roomHost(s);
  const lastRow = s.msgs[s.msgs.length - 1];
  const preview = lastRow && stripMd(lastRow.files?.length && !lastRow.text.trim()
    ? "📎 " + lastRow.files.map((f) => f.name).join(", ")
    : lastRow.text).slice(0, 80);
  return {
    id: s.id,
    kind: roomKindOf(s),
    title: s.title ?? "",
    bound: isBoundRoom(s.id),
    ...(host ? { host } : {}),
    members: [...s.members.values()]
      .sort((a, b) => a.ord - b.ord)
      .map((m) => ({ who: m.who, name: n.nameOf(m.who), via: m.via, since: m.since, ord: m.ord, host: !!host && sameWho(host, m.who) })),
    ...(lastRow && preview ? { last: { seq: lastRow.seq, at: lastRow.at, author: lastRow.author, authorName: n.nameOf(lastRow.author), preview } } : {}),
    openDuties: openDuties(s).length,
  };
};

/** 全部 room 的快照, 最近有动静的在前。 */
export const buildRoomFacts = (states: readonly RoomState[], n: RenderNames): RoomFact[] =>
  states.map((s) => buildRoomFact(s, n)).sort((a, b) => (b.last?.at ?? 0) - (a.last?.at ?? 0) || (a.id < b.id ? -1 : 1));

// ── 历史 ───────────────────────────────────────────────────────────────

/** 一条 room 消息的线上形状 (rolepage / wizard 视图共用)。 */
export interface RoomMsg {
  id: string;
  seq: number;
  at: number;
  room: string;
  author: Who;
  authorName: string;
  /** 作者此刻的加入序 (人 / daemon = 0)。 */
  ord: number;
  speak: SpeakBasis;
  kind: MsgKind;
  text: string;
  to?: Who[];
  re?: string[];
  status?: ReplyStatus;
  files?: FileRef[];
  origin: MsgOrigin;
  sys?: string;
  /** 人话行上的占位气泡 (第一条 re 它的 reply 覆盖它)。 */
  bubble?: boolean;
  /** 产出这条消息的那一轮 (调用方按 author + 时刻补; 没有 = 点不开过程框)。 */
  turn?: string;
}

export const toRoomMsg = (m: MsgRow, n: RenderNames): RoomMsg => ({
  id: m.id, seq: m.seq, at: m.at, room: m.room, author: m.author, authorName: n.nameOf(m.author), ord: m.ord, speak: m.speak,
  kind: m.kind, text: m.text, ...(m.to?.length ? { to: m.to } : {}), ...(m.re?.length ? { re: m.re } : {}),
  ...(m.status ? { status: m.status } : {}), ...(m.files?.length ? { files: m.files } : {}), origin: m.origin,
  ...(m.sys ? { sys: m.sys } : {}), ...(m.bubble ? { bubble: true } : {}),
});

export interface HistoryQuery {
  /** 游标: 只取它之前的 (消息 id 或 seq); 缺省 = 最新的那一页。 */
  before?: string | number;
  limit?: number;
  /** 只看这个人说的。 */
  from?: Who;
  since?: number;
  until?: number;
}

const LIMIT_MAX = 500;

const pickBefore = (msgs: readonly MsgRow[], before: string | number | undefined): MsgRow[] =>
  before === undefined ? [...msgs]
  : typeof before === "number" ? msgs.filter((m) => m.seq < before)
  : (() => { const i = msgs.findIndex((m) => m.id === before); return i < 0 ? msgs.filter((m) => String(m.seq).length && m.id < before) : msgs.slice(0, i); })();

/** 一个 room 的历史分页。earlier = 再往前一页的游标 (没有更早的了就不给)。 */
export const roomHistory = (s: RoomState, q: HistoryQuery, n: RenderNames): { msgs: RoomMsg[]; total: number; earlier?: string } => {
  const limit = Math.max(0, Math.min(q.limit ?? 60, LIMIT_MAX));
  const pool = pickBefore(s.msgs, q.before)
    .filter((m) => (!q.from || sameWho(m.author, q.from)) && (q.since === undefined || m.at >= q.since) && (q.until === undefined || m.at < q.until));
  const page = limit === 0 ? pool : pool.slice(-limit);
  return {
    msgs: page.map((m) => toRoomMsg(m, n)),
    total: pool.length,
    ...(page.length && pool.length > page.length ? { earlier: page[0]!.id } : {}),
  };
};

// ── wizard 视图 (W-1 / W-2) ────────────────────────────────────────────

export interface WizardMsg extends RoomMsg { roomLabel: string }

/** 这条消息「指向」uid: 作者是它, 被点名, 或 re 了它说的某条。 */
export const addressesWho = (s: RoomState, m: MsgRow, uid: string): boolean =>
  (m.author.kind === "wizard" && m.author.id === uid) ||
  !!m.to?.some((t) => t.kind === "wizard" && t.id === uid) ||
  !!m.re?.some((id) => { const r = s.byId.get(id); return !!r && r.author.kind === "wizard" && r.author.id === uid; });

export const everMember = (s: RoomState, uid: string): boolean =>
  [...s.everMembers.values()].some((w) => w.kind === "wizard" && w.id === uid);

export interface WizardQuery {
  /** W-2: 它所在全部 room 的全部消息 (默认 W-1: 它说的 + 指向它的)。 */
  all?: boolean;
  limit?: number;
  /** 游标: 只取它之前的 (跨 room 合并后的位置, 用 orderKey 的形式)。 */
  before?: string;
}

const orderKey = (m: MsgRow): string => m.at + "|" + m.room + "|" + String(m.seq).padStart(9, "0");

/** 跨 room 按时间合并, 每条标出属于哪个 room。 */
export const wizardMessages = (states: readonly RoomState[], uid: string, q: WizardQuery, n: RenderNames): { msgs: WizardMsg[]; total: number; earlier?: string } => {
  const limit = Math.max(0, Math.min(q.limit ?? 60, LIMIT_MAX));
  const rows = states
    .flatMap((s) => (q.all ? (everMember(s, uid) ? s.msgs : []) : s.msgs.filter((m) => addressesWho(s, m, uid))))
    .sort((a, b) => a.at - b.at || (a.room < b.room ? -1 : a.room > b.room ? 1 : 0) || a.seq - b.seq);
  const pool = q.before ? rows.filter((m) => orderKey(m) < q.before!) : rows;
  const page = limit === 0 ? pool : pool.slice(-limit);
  return {
    msgs: page.map((m) => ({ ...toRoomMsg(m, n), roomLabel: n.roomLabel(m.room) })),
    total: pool.length,
    ...(page.length && pool.length > page.length ? { earlier: orderKey(page[0]!) } : {}),
  };
};

// ── room_read 的纯文本 ─────────────────────────────────────────────────

const UNIT_MS = { m: 60_000, h: 3_600_000, d: 86_400_000 } as const;
/** 人怎么说时间就怎么收: 2h / 30m / 3d (多久以前)、14:30 (今天)、
 *  09-30 14:30[:05[.123]] (今年)、或任何 Date 认得的写法。认不出 = undefined。 */
export const parseWhen = (raw: string, now: number): number | undefined => {
  const s = raw.trim();
  const ago = s.match(/^(\d+)\s*([mhd])$/i);
  if (ago) return now - Number(ago[1]) * UNIT_MS[ago[2]!.toLowerCase() as keyof typeof UNIT_MS];
  const hm = s.match(/^(?:(\d{1,2})-(\d{1,2})\s+)?(\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/);
  if (hm) {
    const d = new Date(now);
    if (hm[1]) d.setMonth(Number(hm[1]) - 1, Number(hm[2]));
    d.setHours(Number(hm[3]), Number(hm[4]), Number(hm[5] ?? 0), Number((hm[6] ?? "0").padEnd(3, "0")));
    return d.getTime();
  }
  const t = Date.parse(s);
  return Number.isNaN(t) ? undefined : t;
};
const whenOf = (v: number | string | undefined, now: number): number | undefined =>
  typeof v === "number" ? v : typeof v === "string" && v.trim() ? parseWhen(v, now) : undefined;

const pad = (n: number): string => String(n).padStart(2, "0");
const day = (d: Date): string => pad(d.getMonth() + 1) + "-" + pad(d.getDate());
const clock = (d: Date): string => pad(d.getHours()) + ":" + pad(d.getMinutes());
const stamp = (ts: number, now: number): string => {
  const d = new Date(ts);
  return d.toDateString() === new Date(now).toDateString() ? clock(d) : day(d) + " " + clock(d);
};

export interface RoomReadQuery {
  /** 只读这个 room (调用方给的 states 就是候选集); 不给 = 跨它的 room 合并。 */
  room?: string;
  /** 只看这个人说的 (名字 / uid / human:<id>)。 */
  from?: string;
  since?: number | string;
  until?: number | string;
  limit?: number;
  /** W-2: 全部 room 的全部消息 (默认 W-1: 它说的 + 指向它的)。 */
  all?: boolean;
  /** 单条正文的字数上限。 */
  per?: number;
}

/** room 参数的反向解析: uid / human:<id> / 名字 (带不带点) 都认。 */
export const whoRef = (states: readonly RoomState[], ref: string, n: RenderNames): Who | undefined => {
  const r = stripSigil((ref ?? "").trim());
  if (!r) return undefined;
  const seen = new Map<string, Who>();
  for (const s of states) for (const w of s.everMembers.values()) seen.set(whoKey(w), w);
  for (const w of seen.values()) if (w.id === r || whoKey(w) === ref.trim() || stripSigil(n.nameOf(w)) === r) return w;
  if (r.startsWith("human:")) return { kind: "human", id: r.slice(6) };
  return undefined;
};

/** room_read 的正文 —— 一行一条, 读的是模型: 没有 json, 每个字段名都是它要付的 token。
 *  viewer = 发问的那个 wizard (W-1 的主语)。只读一个 room 时它就是那个 room 的全部消息。 */
export const renderRoomRead = (
  input: RoomState | readonly RoomState[],
  viewer: Who,
  q: RoomReadQuery,
  n: RenderNames,
  now = Date.now(),
): { text: string; shown: number; total: number; earlier?: string } => {
  // 单 room (最常见的 daemon /room/read) 与多 room (跨 room 合并) 同一个入口。
  const states: readonly RoomState[] = Array.isArray(input) ? input : [input as RoomState];
  const since = whenOf(q.since, now);
  const until = whenOf(q.until, now);
  const limit = q.limit ?? 50;
  const per = q.per ?? 500;
  const from = q.from ? whoRef(states, q.from, n) : undefined;
  const pool = q.room ? states.filter((s) => s.id === q.room || n.roomLabel(s.id) === q.room) : states;
  if (!pool.length) return { text: "没有这个 room: " + (q.room ?? ""), shown: 0, total: 0 };
  const one = q.room !== undefined && pool.length === 1;
  const rows = pool
    .flatMap((s) => (q.room === undefined && !q.all ? s.msgs.filter((m) => addressesWho(s, m, viewer.id)) : s.msgs))
    .filter((m) => (!from || sameWho(m.author, from)) && (since === undefined || m.at >= since) && (until === undefined || m.at < until))
    .sort((a, b) => a.at - b.at || (a.room < b.room ? -1 : a.room > b.room ? 1 : 0) || a.seq - b.seq);
  const page = limit > 0 ? rows.slice(-Math.min(limit, LIMIT_MAX)) : rows;
  const prefix = (m: MsgRow): string => "[" + stamp(m.at, now) + (one ? "" : " · " + n.roomLabel(m.room)) + "] ";
  return {
    text: page.map((m) => prefix(m) + renderMsgLine(m, n, per)).join("\n"),
    shown: page.length,
    total: rows.length,
    ...(page.length && rows.length > page.length ? { earlier: orderKey(page[0]!) } : {}),
  };
};

/** 这个 wizard 是否在这个 room 里出现过 (成员 / 说过 / 被点名 / 被 re)。 */
export const roomTouches = (s: RoomState, uid: string): boolean => everMember(s, uid) || s.msgs.some((m) => addressesWho(s, m, uid));

/** duty 的归一化形状 (rolepage 的「未决」胶囊 / room 头部的待办数)。 */
export const dutyFacts = (s: RoomState, n: RenderNames) => openDuties(s).map((d) => ({
  key: d.key, msg: d.msg, seq: d.seq, kind: d.kind, at: d.at,
  asker: d.asker, askerName: n.nameOf(d.asker), holder: holderOf(s, d), slot: d.slot,
  ...(d.last ? { last: d.last } : {}),
}));