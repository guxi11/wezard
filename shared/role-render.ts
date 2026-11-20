// 一条 room 消息点开的过程框 —— 那一轮的工具调用与 CLI 原话, 取自 turn store。
//
// 两种用法, 同一份渲染:
//   • room 视图: 账本行按作者 + 时刻对到一轮 (chat-http 的 turnLinker), 点「过程」才取;
//   • wizard 视图: 每一轮本身就是一条出消息, 过程直接内联 (wizardStream)。
//
// 工具正文照旧懒加载: 片段里只留空壳 (data-lazy-turn / data-lazy-use), 展开时才取
// /api/tool —— 与详情页同一份实现 (shared/detail-render)。
//
// room 模型下一句话是不是「说出去了」只看账本: 写进账本的行 (chat_reply / chat_say / notify /
// send_file) 才是气泡; CLI 终句零语义, 只是过程框里的一段原话 (aside)。
import { escHtml, hashStr, renderCutMark, renderTurnGroup, splitReminders, turnUsageChips, type HandoffDeco, type HandoffStatus, type TurnFragment } from "./detail-render.js";
import { isTurn, staleAt } from "./chat-view.js";
import type { DetailRecord, TurnDetailRecord } from "./detail-store.js";
import { allMessages, inSpan, marksOf, teammateOf, unwrapMates, type Directory, type Msg, type SessionSpan } from "./role-view.js";
import type { RoomMsg } from "./room-view.js";
import { whoKey, type MsgRow, type Who } from "./room.js";
import { nameHead } from "./session-label.js";

// ── 消息里的特殊内容 ──────────────────────────────────────────────────
// CLI 把多行粘贴包一层 `<pasted_content id=…>` (见 daemon/peers.unwrapPasted), 只是传输痕迹。
const PASTED_TAG_RE = /<pasted_content id="[^"]*">\n?|\n?<\/pasted_content(?:\s+id="[^"]*")?>/g;

/** 正文 + 折叠成标签的 reminder 块 (`<envelope · x>` / `<roster>` …, 点开看原文)。
 *  room 注入把一条消息压成一行, reminder 不一定起头一行: 先把每个块断到行首 —— REMINDER_RE 只认行首。 */
export const splitInline = (text: string): { body: string; html: string } =>
  splitReminders(text.replace(PASTED_TAG_RE, "")
    .replace(/[ \t]*(<system-reminder\b)/g, "\n$1")
    .replace(/(<\/system-reminder>)[ \t]*/g, "$1\n"));

/** 发到 rolepage 的一条账本行: 正文剥掉 reminder (另给折叠 HTML), 没有显式收件人的 reply 补上
 *  它答的那几行的作者 —— 头部的「→ 谁」。 */
export type WireMsg<M extends RoomMsg = RoomMsg> = M & { rems?: string; reTo?: Who[] };

export const wireMsg = (lookup: (id: string) => MsgRow | undefined) => <M extends RoomMsg>(m: M): WireMsg<M> => {
  const q = splitInline(m.text);
  const seen = new Set<string>();
  const reTo = m.to?.length ? [] : (m.re ?? []).map(lookup)
    .flatMap((r) => (r && !seen.has(whoKey(r.author)) && seen.add(whoKey(r.author)) ? [r.author] : []));
  return { ...m, text: q.body, ...(q.html ? { rems: q.html } : {}), ...(reTo.length ? { reTo } : {}) };
};

// ── 提示行的 rolepage 一半 ─────────────────────────────────────────────
/** 回执的 room 版: 一条 ask 的定论 = re 它的那些行上最后一个 status。 */
const DUTY: Readonly<Record<string, HandoffStatus["key"]>> = {
  done: "done", passed: "done", canceled: "fail", need: "need", progress: "run", error: "error",
};
const dutyStatus = (replies: readonly MsgRow[] | undefined): HandoffStatus => {
  if (!replies) return { key: "plain", tip: "" };
  const last = [...replies].reverse().find((r) => r.status);
  return last?.status ? { key: DUTY[last.status] ?? "run", tip: "交代 · " + last.status } : { key: "run", tip: "还没交代" };
};

export interface DecoQuery {
  /** 提示行里「发到哪」的 room 名 (短名: 起的名 / 聊天名 / 代号)。 */
  chatLabel?: (room: string) => string;
  /** re 了这条消息的那些行 (按时刻)。 */
  repliesOf?: (id: string) => readonly MsgRow[];
  /** 账本里有没有这一行 —— 切换前的活号 (route 事件) 不在账本里, 没有「交代」可看。 */
  lookup?: (id: string) => MsgRow | undefined;
}

/** 提示行里的名字可点 (data-node = 图上的节点 id), 去处翻成 room 名, 箭头颜色 = duty 的交代。 */
export const roomDeco = (dir: Directory, q: DecoQuery): HandoffDeco => {
  const at = (name: string): string => {
    const id = dir.resolve(name);
    return id ? ` data-node="${escHtml(id)}" title="${escHtml("看 " + dir.nameOf(id))}"` : "";
  };
  return {
    who: (name) => {
      const id = dir.resolve(name);
      return id
        ? `<span class="ho-who" data-node="${escHtml(id)}">${nameHead(`<span class="av">${escHtml(dir.labelOf(id))}</span>`, `<span class="nm wizard">${escHtml(dir.nameOf(id))}</span>`)}</span>`
        : `<span class="ho-nm">${escHtml(name)}</span>`;
    },
    attrs: (h) => at(h.name),
    role: at,
    status: (h) => dutyStatus(h.turn && q.lookup?.(h.turn) ? q.repliesOf?.(h.turn) ?? [] : undefined),
    pub: () => undefined,
    acct: () => "",
    plan: () => "",
    chat: (c) => (c ? q.chatLabel?.(c) || c : ""),
  };
};

/** 子 agent 的那几轮 —— 内联在父轮的过程框里 (父轮发起、父轮收口)。 */
const childrenOf = (r: TurnDetailRecord, records: readonly DetailRecord[]): TurnDetailRecord[] =>
  records.filter(isTurn).filter((t) => t.agent?.parentTurnId === r.id).sort((a, b) => a.createdAt - b.createdAt);

export const renderTurnBox = (r: TurnDetailRecord, records: readonly DetailRecord[], now = Date.now(), deco?: HandoffDeco): string => {
  const children: TurnFragment[] = childrenOf(r, records).map((c) => renderTurnGroup(c, now, [], true, deco));
  return renderTurnGroup(r, now, children, false, deco).html;
};

const squash = (s: string): string => s.replace(/\s+/g, " ").trim();

/** room 注入的头一行: 【room 名】(room id) —— 这一轮是被账本行唤醒的。 */
const INJECTION_HEAD = /^【[^\n]*】\([^)\n]*\)/;
export const isInjection = (r: TurnDetailRecord): boolean => INJECTION_HEAD.test((r.userQuery ?? "").trimStart());

/** 一轮的话分两种: 写进账本的 (气泡, 客户端按账本行画) 与 CLI 原话 (标 aside, 收进过程框)。
 *  与某一行同文的那句 (迁移进账本的老终句) 并掉, 不画两遍。账本切换之前、也没有账本行的老轮次,
 *  终句当时就是送达的回复 —— 原样不动。 */
export const spokenTurn = (r: TurnDetailRecord, said: readonly { text: string }[], roomEra: boolean): TurnDetailRecord => {
  if (!said.length && !roomEra) return r;
  const same = new Set(said.map((m) => squash(m.text)));
  return { ...r, items: r.items.flatMap((it): TurnDetailRecord["items"] => (it.t !== "text" ? [it] : same.has(squash(it.body)) ? [] : [{ ...it, aside: true }])) };
};

// ── wizard 详情的时间轴 ────────────────────────────────────────────────
// 主干是轮次 (入 = 问的那句, 出 = 这一轮的过程框 + 写进账本的气泡), 账本行挂在产出它的那一轮上;
// 唤醒它的账本行画在那一轮之前 (它们就是那一轮读到的输入, 不再画一遍注入原文);
// 没有对应轮次的账本行 (系统行 / 迁移行 / 更远的历史) 仍独立成行。

export type StreamMsg = WireMsg<RoomMsg & { roomLabel: string }>;

export interface StreamRow {
  id: string;
  kind: "in" | "out" | "mark" | "ledger";
  ts: number;
  from?: string;
  fromName?: string;
  fromLabel?: string;
  to?: string;
  toName?: string;
  toLabel?: string;
  /** 公开频道的 base; "" = 私聊。 */
  room?: string;
  roomLabel?: string;
  /** 入消息的正文 (markdown, 客户端渲染; reminder 已剥, 折叠 HTML 在 rems)。 */
  text?: string;
  rems?: string;
  /** 入消息的出处标签 (定时 / agent team)。 */
  tags?: string[];
  /** 出消息 / 断点的服务端 HTML (过程框)。出消息没有过程可看时为 ""。 */
  html?: string;
  /** 出消息的账 (模型 / ctx / 耗时)。 */
  meta?: string;
  /** 账本切换之后的一轮: 终句零语义, 没写进账本就是没说。 */
  era?: boolean;
  /** 还在跑: 到这个时刻自动算结束; 0 = 已结束。 */
  staleAt?: number;
  /** 这一轮真正写进账本的那几行 (全文) —— 出消息的气泡。 */
  said?: StreamMsg[];
  /** 没有对应轮次、只能按账本行原样画时的那一行。 */
  row?: StreamMsg;
  /** 内容指纹: 前端轮询时没变就不动 DOM (展开态 / 滚动位置)。 */
  sig?: string;
}

const sigOf = (r: StreamRow): string => hashStr([
  r.html ?? "", r.meta ?? "", r.text ?? "", r.rems ?? "",
  ...(r.said ?? []).map((m) => m.id + (m.status ?? "") + m.text),
  r.row ? r.row.id + (r.row.status ?? "") + (r.row.turn ?? "") : "",
].join("\u0000"));

export interface StreamQuery extends DecoQuery {
  /** 频道 base → 显示名 (与账本行同一个口径)。 */
  roomLabel?: (base: string) => string;
  /** 视角 role 的一段 session (切换会话时只看这一段)。 */
  span?: SessionSpan;
  /** 该 role 的账本行 (W-1 / W-2 已由调用方选好, 已过 wireMsg)。 */
  msgs: readonly StreamMsg[];
  /** 唤醒过它的账本行 (群里的人话常常不点名, W-1 收不进来)。 */
  woke?: readonly StreamMsg[];
  /** 账本切换时刻 (第一条非迁移行); 没有账本 = Infinity。 */
  roomFrom?: number;
}

const inTags = (r: TurnDetailRecord): string[] => {
  const mate = teammateOf(r.userQuery);
  return [
    ...(r.from?.kind === "task" ? ["⏰ 定时 " + (r.from.taskId ?? "")] : []),
    ...(mate === undefined ? [] : ["agent team" + (mate ? " · " + mate : "")]),
  ];
};

/** 一个 wizard 的详情时间轴。调用方给 span (会话窗) 与账本行, 这里只管折叠与渲染。 */
export const wizardStream = (
  records: readonly DetailRecord[],
  role: string,
  dir: Directory,
  now: number,
  q: StreamQuery,
): StreamRow[] => {
  const inSpanTs = inSpan(q.span);
  const msgs = allMessages(records, now, dir.canon)
    .filter((m) => m.from === role || m.to === role)
    .filter((m) => inSpanTs(m.ts));
  const label = (base: string): string => (base ? q.roomLabel?.(base) || dir.chatName(base) : "");
  const deco = roomDeco(dir, q);
  const roomFrom = q.roomFrom ?? Infinity;
  const saidByTurn = q.msgs.reduce<Map<string, StreamMsg[]>>(
    (acc, m) => (m.turn ? acc.set(m.turn, [...(acc.get(m.turn) ?? []), m]) : acc),
    new Map(),
  );
  const outTurns = new Set(msgs.filter((m) => m.dir === "out").map((m) => m.turn.id));
  // 唤醒行 → 读到它的那一轮: 该 role 在这一行之后开的第一轮 (投递要等它闲下来才贴)。
  const ownTurns = msgs.filter((m) => m.dir === "in" || m.dir === "out").map((m) => m.turn)
    .filter((t, i, a) => a.findIndex((x) => x.id === t.id) === i).sort((a, b) => a.createdAt - b.createdAt);
  const fed = new Set((q.woke ?? []).flatMap((m) => ownTurns.find((t) => t.createdAt >= m.at)?.id ?? []));
  const turnRows = (m: Msg): StreamRow[] => {
    const r = m.turn;
    const ends = { from: m.from, fromName: dir.nameOf(m.from), fromLabel: dir.labelOf(m.from) };
    const toEnds = { to: m.to, toName: dir.nameOf(m.to), toLabel: dir.labelOf(m.to) };
    const where = (room: string, lb = label(room)) => ({ room, ...(lb ? { roomLabel: lb } : {}) });
    if (m.dir === "in") {
      // 注入原文只是账本行的转述: 唤醒它的那几行已经按账本画在前面, 这里不再画一遍。
      if (isInjection(r) && fed.has(r.id)) return [];
      const q2 = splitInline(unwrapMates(r.userQuery?.trim() ? r.userQuery : r.rawQuery ?? ""));
      if (!q2.body && !q2.html) return [];
      const tags = inTags(r);
      return [{ id: m.id, kind: "in", ts: m.ts, ...ends, ...toEnds, ...where(m.channel), text: q2.body,
        ...(q2.html ? { rems: q2.html } : {}), ...(tags.length ? { tags } : {}) }];
    }
    const said = saidByTurn.get(r.id) ?? [];
    const era = r.createdAt >= roomFrom || isInjection(r);
    const spoken = spokenTurn(r, said, era);
    const live = !r.closed;
    const first = said[0];
    return [{ id: m.id, kind: "out", ts: m.ts, ...ends,
      // 账本时代的出消息说给谁由气泡 (账本行) 自己交代; 老轮次照旧按派活链推。
      ...(era || said.length ? {} : toEnds),
      ...(first ? where(first.room, first.roomLabel) : where(m.channel)),
      html: spoken.items.length || live ? renderTurnBox(spoken, records, now, deco) : "",
      meta: turnUsageChips(r, now),
      ...(era ? { era: true } : {}),
      staleAt: r.closed ? 0 : staleAt(r),
      ...(said.length ? { said } : {}) }];
  };
  const marks: StreamRow[] = marksOf(records, role)
    .filter((mk) => inSpanTs(mk.createdAt))
    .map((mk) => ({ id: "m:" + mk.id, kind: "mark", ts: mk.createdAt, from: role, fromName: dir.nameOf(role),
      fromLabel: dir.labelOf(role), html: renderCutMark(mk).html }));
  const seen = new Set<string>();
  const loose: StreamRow[] = [...q.msgs.filter((m) => !m.turn || !outTurns.has(m.turn)), ...(q.woke ?? [])]
    .filter((m) => inSpanTs(m.at) && !seen.has(m.id) && !!seen.add(m.id))
    .map((m) => ({ id: "l:" + m.id, kind: "ledger", ts: m.at, room: m.room, roomLabel: m.roomLabel,
      from: m.author.kind === "wizard" ? m.author.id : m.author.kind === "human" ? "human:" + m.author.id : "system:",
      fromName: m.authorName, row: m }));
  return [...msgs.flatMap(turnRows), ...marks, ...loose].sort((a, b) => a.ts - b.ts).map((r) => ({ ...r, sig: sigOf(r) }));
};
