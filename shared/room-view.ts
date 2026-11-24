// room 的读模型 —— 账本状态 (shared/room.ts 的 fold 结果) → rolepage / room_read 要的形状。
//
// 纯函数, 无 IO: 名字一律由调用方注入 (svr 侧没有 wizard 注册表, 名字随快照带过来;
// daemon 侧从 wizards 表现查)。这一层只做三件事:
//   ① 快照: 每个 room 的成员 / host / 最后一句 / 未决 duty 数 (WorldFacts.rooms);
//   ② 历史: 一个 room 的消息分页 (rolepage 的 room 视图);
//   ③ 视图: 一个 wizard 的「与我相关」(它说的 + 点名它的 + 回它那几条的), 跨 room 按时间合并;
//   以及给 room_read 的纯文本渲染。
//
// 消息的「出处 / 完成 / 发言权」都在账本行上 (author / status / speak), 这里不再推断任何
// 一样 —— 名字只是把 uid 换成给人看的写法。
import {
  holderOf, openDuties, roomHost, sameWho, whoKey,
  renderMsgLine, roomHash, rowText, type FileRef, type MemberEvent, type JoinVia, type MsgKind, type MsgOrigin, type MsgRow,
  type ReplyStatus, type RenderNames, type RoomKind, type RoomState, type SpeakBasis, type Who,
  isBoundRoom,
} from "./room.js";
import { stripSigil } from "./session-label.js";
import { clipLine } from "./std.js";

// ── 快照 ───────────────────────────────────────────────────────────────

export interface RoomMemberFact {
  who: Who;
  name: string;
  via: JoinVia;
  since: number;
  ord: number;
  /** 此刻是 host (wizard 成员里加入序最小的那位); 人永不 true。 */
  host: boolean;
  /** monitor 成员 (不发言 / 不当 host / 不持有 duty; 图上画成单独样式)。 */
  role?: "monitor";
}

export interface RoomLastFact { seq: number; at: number; author: Who; authorName: string; preview: string }

/** 一个 room 的一句话快照 —— 关系图节点 / room 头部。 */
export interface RoomFact {
  id: string;
  kind: RoomKind;
  /** host 起的显示别名 (room_open 的 title 或 room_name 改的); 空 = 没起名, 显示名回落到聊天名 / 成员。 */
  title: string;
  /** 群公告; 空 = 没有。 */
  notice: string;
  /** 绑定了传输 (企微群 / 单聊 / topic 帖 / 微信), 镜像进群。 */
  bound: boolean;
  /** undefined = 没有 wizard 成员 (人兜底 / 待人话触发 onboarding)。 */
  host?: Who;
  members: RoomMemberFact[];
  last?: RoomLastFact;
  /** 未决 duty 数 (读时 fold, 不落盘)。 */
  openDuties: number;
  /** 帖子 room 的归属: 所属频道 (读时由 channel-posts 映射算, 不落账本)。 */
  channel?: { id: string; name: string };
  /** 帖子 room 的根帖 id (send_reply 用)。 */
  rootPost?: string;
  /** 绑进本 room 的副源 (multi-source-binding; fold 出 bindings, unbind 即消失)。 */
  sources: RoomSourceFact[];
}

/** 一条绑定源的显示形状: 群 / 频道帖; 有名用名, 无名用 id 简写。 */
export interface RoomSourceFact {
  id: string;
  name: string;
  kind: "group" | "post";
  at: number;
}

/** 源 id 的简写 (去掉 chat: 前缀, 过长截断) —— 没名字时的回落。 */
const shortSourceId = (id: string): string => {
  const bare = id.replace(/^chat:/, "");
  return bare.length > 10 ? bare.slice(0, 8) + "…" : bare;
};

/** channel-posts 映射的读侧形状 (由调用方注入; shared 不 import daemon)。
 *  channel room → { channel: 裸 topic_id }; 帖子 room → { channel, post: 根帖 id }。 */
export type ChannelRef = { channel: string; post: string };
export type ChannelOf = (room: string) => ChannelRef | undefined;

const KIND_BY_PREFIX = (id: string): RoomKind =>
  id.startsWith("dm:") ? "dm"
  : id.startsWith("adhoc:") ? "adhoc"
  : id.startsWith("user:") ? "wecom-dm"
  : id.startsWith("chat:wx") ? "wx"
  : "wecom-group";

export const roomKindOf = (s: RoomState): RoomKind => s.kind ?? KIND_BY_PREFIX(s.id);

const stripMd = (t: string): string => t.replace(/[`*_~|#>]/g, "").replace(/\s+/g, " ").trim();

export const buildRoomFact = (s: RoomState, n: RenderNames, channelOf?: ChannelOf): RoomFact => {
  const host = roomHost(s);
  // 频道 / 帖子的 kind 读时算 (channel-posts 是唯一判据), 不落账本。
  const chRef = channelOf?.(s.id);
  const kind: RoomKind = chRef ? (chRef.post ? "topic-post" : "channel") : roomKindOf(s);
  const lastRow = s.msgs[s.msgs.length - 1];
  const preview = lastRow && stripMd(lastRow.files?.length && !rowText(lastRow).trim()
    ? "📎 " + lastRow.files.map((f) => f.name).join(", ")
    : rowText(lastRow)).slice(0, 80);
  return {
    id: s.id,
    kind,
    title: s.title ?? "",
    ...(chRef?.post ? { rootPost: chRef.post, channel: { id: chRef.channel, name: n.roomLabel("chat:" + chRef.channel) } } : {}),
    notice: s.notice ?? "",
    bound: isBoundRoom(s.id),
    ...(host ? { host } : {}),
    members: (() => {
      const list = [...s.members.values()].sort((a, b) => a.ord - b.ord)
        .map((m) => ({ who: m.who, name: n.nameOf(m.who), via: m.via, since: m.since, ord: m.ord, host: !!host && sameWho(host, m.who), ...(m.role === "monitor" ? { role: "monitor" as const } : {}) }));
      // 人从来不走 join (没有 join 行): 只在消息里出现。补成参与者, 否则图上没有 user 节点。
      const seen = new Set(list.map((m) => m.who.kind + ":" + m.who.id));
      let ord = list.reduce((mx, m) => Math.max(mx, m.ord), 0);
      const said = new Map<string, { who: Who; at: number }>();
      for (const row of s.msgs) {
        if (row.author.kind !== "human") continue;
        const key = "human:" + row.author.id;
        if (seen.has(key)) continue;
        const hit = said.get(key);
        if (!hit || row.at < hit.at) said.set(key, { who: row.author, at: row.at });
      }
      [...said.values()].sort((a, b) => a.at - b.at).forEach((x) => {
        list.push({ who: x.who, name: n.nameOf(x.who), via: "inbound", since: x.at, ord: ++ord, host: false });
      });
      return list;
    })(),
    sources: [...s.bindings.entries()].sort((a, b) => a[1].at - b[1].at).map(([id, b]) => {
      const label = n.roomLabel(id);
      return { id, name: label && label !== id ? label : shortSourceId(id), kind: channelOf?.(id)?.post ? "post" as const : "group" as const, at: b.at };
    }),
    ...(lastRow && preview ? { last: { seq: lastRow.seq, at: lastRow.at, author: lastRow.author, authorName: n.nameOf(lastRow.author), preview } } : {}),
    openDuties: openDuties(s).length,
  };
};

/** 全部 room 的快照, 最近有动静的在前。 */
export const buildRoomFacts = (states: readonly RoomState[], n: RenderNames, channelOf?: ChannelOf): RoomFact[] =>
  states.map((s) => buildRoomFact(s, n, channelOf)).sort((a, b) => (b.last?.at ?? 0) - (a.last?.at ?? 0) || (a.id < b.id ? -1 : 1));

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
  kind: m.kind, text: rowText(m), ...(m.to?.length ? { to: m.to } : {}), ...(m.re?.length ? { re: m.re } : {}),
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

// ── 成员变动 (系统通知) ───────────────────────────────────────────────

/** 一条成员变动通知的线上形状: 同类连续变动已折成一条 (whos 是全部当事人)。 */
export interface MemberNote {
  id: string;
  room: string;
  at: number;
  kind: "join" | "leave" | "remove";
  text: string;
  whos: Who[];
  /** wizard 视图才有: 属于哪个 room。 */
  roomLabel?: string;
}

/** 不是一次「入群」的入座: 创建者本人 / 迁移批量入座 —— 不报。 (inbound 另判: 人说话时的隐式入座不报, wizard 首次进群要报。) */
const SILENT_VIA: ReadonlySet<JoinVia> = new Set<JoinVia>(["founder", "migrate"]);
/** 折叠: 同一动作的两条变动相隔超过它就各成一条 (期间有人说话也断开)。 */
export const NOTE_GAP_MS = 5 * 60_000;
const NAMES_SHOWN = 3;

/** 名单: 三个以内逐个列, 更多 =「B、C、D 等 N 人」。 */
export const listNames = (names: readonly string[]): string =>
  names.length <= NAMES_SHOWN ? names.join("、") : names.slice(0, NAMES_SHOWN).join("、") + " 等 " + names.length + " 人";

/** 一组同类变动的文案 (纯函数, 测试直接断言): 拿不到操作者 (daemon / 自己) 就省略「A」。 */
export const noteText = (
  a: { op: "join" | "leave"; via?: JoinVia; self: boolean; by: string; why?: string }, names: readonly string[],
): string => {
  const who = listNames(names);
  const why = a.why ? " (" + a.why + ")" : "";
  if (a.op === "leave") return a.self ? who + " 退出了群" + why : a.by ? who + " 被 " + a.by + " 移出群" + why : who + " 被移出群" + why;
  if (a.self || !a.by) return who + " 加入了群";
  switch (a.via) {
    case "approve": return a.by + " 批准了 " + who + " 入群";
    case "spawn": return a.by + " 拉起了 " + who + " 进群";
    case "mention": return a.by + " @ 了 " + who + ", 已加入群";
    case "transfer": return a.by + " 把任务转交给了 " + who + ", 已加入群";
    default: return a.by + " 邀请了 " + who + " 进群";
  }
};

/** 要不要报这条: 静默的入座不报 (人从来不走 join 行, 偶有的 inbound 入座是隐式的); dm 是两个人的对话, 开房那一拍的入座 (与 open 同一刻) 是结构而不是事件。 */
const noteworthy = (s: RoomState, e: MemberEvent): boolean =>
  e.op === "leave" || (!SILENT_VIA.has(e.via ?? "founder") && !(e.via === "inbound" && e.who.kind === "human") && !(s.kind === "dm" && s.openedAt === e.at));

/** 一个 room 的成员变动通知 (按时间序)。involving = 只要这个 uid 当事 (当事人或操作者)。
 *  折叠: 相邻、同动作 (进 / 退 / 被移)、同操作者、同来路、间隔 ≤ NOTE_GAP_MS 且其间没人说过话的合成一条。 */
export const memberNotes = (s: RoomState, n: RenderNames, involving?: string): MemberNote[] => {
  const events = s.memberLog.filter((e) => noteworthy(s, e) && (!involving || e.who.id === involving || e.by.id === involving));
  const key = (e: MemberEvent): string => [e.op, e.via ?? "", sameWho(e.who, e.by) ? "self" : whoKey(e.by), e.why ?? ""].join("|");
  const spoke = (from: number, to: number): boolean => s.msgs.some((m) => m.at > from && m.at < to);
  const groups = events.reduce<MemberEvent[][]>((acc, e) => {
    const g = acc[acc.length - 1];
    const last = g?.[g.length - 1];
    if (g && last && key(last) === key(e) && e.at - last.at <= NOTE_GAP_MS && !spoke(last.at, e.at)) g.push(e);
    else acc.push([e]);
    return acc;
  }, []);
  return groups.map((g) => {
    const e = g[0]!;
    const self = sameWho(e.who, e.by);
    const by = e.by.kind === "daemon" ? "" : n.nameOf(e.by);
    const kind = e.op === "join" ? "join" : self ? "leave" : "remove";
    return {
      id: "mn:" + roomHash(s.id) + ":" + e.at + ":" + whoKey(e.who), room: s.id, at: e.at, kind,
      text: noteText({ op: e.op, ...(e.via ? { via: e.via } : {}), self, by, ...(e.why ? { why: e.why } : {}) }, g.map((x) => n.nameOf(x.who))),
      whos: g.map((x) => x.who),
    };
  });
};

// ── wizard 视图: 与我相关 ──────────────────────────────

export interface WizardMsg extends RoomMsg { roomLabel: string }

/** 这条消息「指向」uid: 作者是它, 被点名, 或 re 了它说的某条。 */
export const addressesWho = (s: RoomState, m: MsgRow, uid: string): boolean =>
  (m.author.kind === "wizard" && m.author.id === uid) ||
  !!m.to?.some((t) => t.kind === "wizard" && t.id === uid) ||
  !!m.re?.some((id) => { const r = s.byId.get(id); return !!r && r.author.kind === "wizard" && r.author.id === uid; });

export interface WizardQuery {
  limit?: number;
  /** 游标: 只取它之前的 (跨 room 合并后的位置, 用 orderKey 的形式)。 */
  before?: string;
}

const orderKey = (m: MsgRow): string => m.at + "|" + m.room + "|" + String(m.seq).padStart(9, "0");

/** 唤醒过 uid 的那些行 (账本行上的 wake) —— 它们就是 uid 某一轮读到的输入, 不论是否点名它
 *  (群里人话没有 to / re, W-1 收不进来; rolepage 要把它们画在那一轮的入口上)。 */
export const wokeRows = (states: readonly RoomState[], uid: string, since: number, n: RenderNames): WizardMsg[] =>
  states.flatMap((s) => s.msgs.filter((m) => m.at >= since && m.wake.includes(uid)))
    .sort((a, b) => a.at - b.at || (a.room < b.room ? -1 : a.room > b.room ? 1 : 0) || a.seq - b.seq)
    .map((m) => ({ ...toRoomMsg(m, n), roomLabel: n.roomLabel(m.room) }));

/** 跨 room 按时间合并, 每条标出属于哪个 room。 */
export const wizardMessages = (states: readonly RoomState[], uid: string, q: WizardQuery, n: RenderNames): { msgs: WizardMsg[]; total: number; earlier?: string } => {
  const limit = Math.max(0, Math.min(q.limit ?? 60, LIMIT_MAX));
  const rows = states
    .flatMap((s) => s.msgs.filter((m) => addressesWho(s, m, uid)))
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
  /** 全部消息: 全部 room 的全部消息 (默认只看与我相关: 它说的 / 点名它的 / 回它那几条的)。 */
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
  // 读的是单个 room 且它有群公告: 头部带一行 (不算进 shown / total)。
  const head = one && pool[0]!.notice ? "📌 群公告: " + pool[0]!.notice + "\n" : "";
  return {
    text: head + page.map((m) => prefix(m) + renderMsgLine(m, n, per)).join("\n"),
    shown: page.length,
    total: rows.length,
    ...(page.length && rows.length > page.length ? { earlier: orderKey(page[0]!) } : {}),
  };
};


/** duty 的归一化形状 (rolepage 的成员栏「待交代」/ room 头部的待办数)。
 *  holderName / summary 只读展示用: 谁手上、开它的那一行的一行摘要 —— 不进账本, 不改任何语义。 */
export const dutyFacts = (s: RoomState, n: RenderNames) => openDuties(s).map((d) => {
  const holder = holderOf(s, d);
  const row = s.byId.get(d.msg);
  const text = row ? stripMd(rowText(row)) : "";
  return {
    key: d.key, msg: d.msg, seq: d.seq, kind: d.kind, at: d.at,
    asker: d.asker, askerName: n.nameOf(d.asker), holder, holderName: holder ? n.nameOf(holder) : "", slot: d.slot,
    summary: clipLine(text || (d.kind === "join-req" ? "申请入群" : row?.files?.length ? "📎 " + row.files.map((f) => f.name).join(", ") : ""), 60),
    ...(d.last ? { last: d.last } : {}),
  };
});

/** 每个人 / wizard 在这个 room 里最近一条 msg 的时刻 (key = whoKey); daemon 系统行 (author=system) 也算它自己的。 */
export const lastSaidAt = (s: RoomState): Map<string, number> =>
  s.msgs.reduce((m, r) => m.set(whoKey(r.author), Math.max(m.get(whoKey(r.author)) ?? 0, r.at)), new Map<string, number>());

/** room 的创建时刻: open 行的时刻, 老账本没有就取第一行 msg。 */
export const roomCreatedAt = (s: RoomState): number => s.openedAt ?? s.msgs[0]?.at ?? 0;
/** plan 闲时提醒的抑制判据: 该 wizard 在任一 room 里「持有」或「作为 asker 派出」一条带此 planId 的未关 duty (join-req 不算)。
 *  只看持有会让 lead 派完活等交代时每次 plan 改 revision 都被提醒。 */
export const planHasOpenDuty = (states: Iterable<RoomState>, planId: string, uid: string): boolean => {
  const me: Who = { kind: "wizard", id: uid };
  for (const s of states) {
    if (openDuties(s).some((d) => d.kind !== "join-req" && d.planId === planId && (sameWho(holderOf(s, d), me) || sameWho(d.asker, me)))) return true;
  }
  return false;
};
