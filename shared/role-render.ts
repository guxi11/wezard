// 一条 room 消息点开的过程框 —— 那一轮的工具调用与 CLI 原话, 取自 turn store。
//
// 两种用法, 同一份渲染:
//   • room 视图: 账本行按作者 + 时刻对到一轮 (chat-http 的 turnLinker), 点「过程」才取;
//   • wizard 视图: 每一轮本身就是一条出消息, 过程直接内联 (wizardStream)。
//
// 工具正文照旧懒加载: 片段里只留空壳 (data-lazy-turn / data-lazy-use), 展开时才取
// /api/tool —— 与详情页同一份实现 (shared/detail-render)。
import { renderCutMark, renderTurnGroup, splitReminders, turnUsageChips, type TurnFragment } from "./detail-render.js";
import { isTurn, staleAt } from "./chat-view.js";
import type { DetailRecord, TurnDetailRecord } from "./detail-store.js";
import { allMessages, inSpan, marksOf, unwrapMates, type Directory, type Msg, type SessionSpan } from "./role-view.js";
import type { RoomMsg } from "./room-view.js";

/** 子 agent 的那几轮 —— 内联在父轮的过程框里 (父轮发起、父轮收口)。 */
const childrenOf = (r: TurnDetailRecord, records: readonly DetailRecord[]): TurnDetailRecord[] =>
  records.filter(isTurn).filter((t) => t.agent?.parentTurnId === r.id).sort((a, b) => a.createdAt - b.createdAt);

export const renderTurnBox = (r: TurnDetailRecord, records: readonly DetailRecord[], now = Date.now()): string => {
  const children: TurnFragment[] = childrenOf(r, records).map((c) => renderTurnGroup(c, now, [], true));
  return renderTurnGroup(r, now, children, false).html;
};

// ── wizard 详情的时间轴 ────────────────────────────────────────────────
// 主干是轮次 (入 = 问的那句, 出 = 这一轮的回复 + 过程框), 账本行挂在产出它的那一轮上;
// 没有对应轮次的账本行 (系统行 / 迁移行 / 更远的历史) 仍独立成行 —— 账本里说过的话,
// 轮次记录里不一定有; 反过来轮次里做的事 (工具调用), 账本里一定没有。

/** 一轮真正发进 room 账本的那一行 (chat_say / chat_reply / notify / send_file)。 */
export interface SaidRow { id: string; seq: number; room: string; roomLabel: string; status?: string; text: string }

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
  /** 入消息的正文 (markdown, 客户端渲染; 提醒尾巴已剥)。 */
  text?: string;
  /** 出消息 / 断点的服务端 HTML (气泡 + 过程框)。 */
  html?: string;
  /** 出消息的账 (模型 / ctx / 耗时)。 */
  meta?: string;
  /** 还在跑: 到这个时刻自动算结束; 0 = 已结束。 */
  staleAt?: number;
  /** 这一轮真正写进账本的那几行。 */
  said?: SaidRow[];
  /** 没有对应轮次、只能按账本行原样画时的那一行。 */
  row?: RoomMsg;
}

const queryText = (r: TurnDetailRecord): string =>
  splitReminders(unwrapMates(r.rawQuery?.trim() ? r.rawQuery : r.userQuery ?? "")).body;

const saidOf = (m: RoomMsg, label: string): SaidRow => ({
  id: m.id, seq: m.seq, room: m.room, roomLabel: label,
  ...(m.status ? { status: m.status } : {}),
  text: m.text.replace(/\s+/g, " ").trim().slice(0, 200),
});

export interface StreamQuery {
  /** 视角 role 的一段 session (切换会话时只看这一段)。 */
  span?: SessionSpan;
  /** 该 role 的账本行 (W-1 / W-2 已由调用方选好)。 */
  msgs: readonly (RoomMsg & { roomLabel: string })[];
  /** 频道 base → 显示名 (与账本行同一个口径: host 起的 title > 群名 > 成员)。 */
  roomLabel?: (base: string) => string;
}

/** 一个 wizard 的详情时间轴。调用方给 span (会话窗) 与账本行, 这里只管折叠与渲染。 */
export const wizardStream = (
  records: readonly DetailRecord[],
  role: string,
  dir: Directory,
  now: number,
  q: StreamQuery,
): StreamRow[] => {
  const msgs = allMessages(records, now, dir.canon)
    .filter((m) => m.from === role || m.to === role)
    .filter((m) => inSpan(q.span)(m.ts));
  const label = (base: string): string => (base ? q.roomLabel?.(base) || dir.chatName(base) : "");
  const saidByTurn = q.msgs.reduce<Map<string, SaidRow[]>>(
    (acc, m) => (m.turn ? acc.set(m.turn, [...(acc.get(m.turn) ?? []), saidOf(m, m.roomLabel)]) : acc),
    new Map(),
  );
  const outId = (m: Msg): string => m.turn.id;
  const outTurns = new Set(msgs.filter((m) => m.dir === "out").map(outId));
  const turnRows = (m: Msg): StreamRow[] => {
    const r = m.turn;
    const ends = { from: m.from, fromName: dir.nameOf(m.from), fromLabel: dir.labelOf(m.from),
      to: m.to, toName: dir.nameOf(m.to), toLabel: dir.labelOf(m.to) };
    if (m.dir === "in") {
      const text = queryText(r);
      if (!text) return [];
      return [{ id: m.id, kind: "in", ts: m.ts, ...ends, room: m.channel,
        ...(label(m.channel) ? { roomLabel: label(m.channel) } : {}), text }];
    }
    return [{ id: m.id, kind: "out", ts: m.ts, ...ends, room: m.channel,
      ...(label(m.channel) ? { roomLabel: label(m.channel) } : {}),
      html: renderTurnBox(r, records, now), meta: turnUsageChips(r, now),
      staleAt: r.closed ? 0 : staleAt(r),
      ...(saidByTurn.has(r.id) ? { said: saidByTurn.get(r.id) } : {}) }];
  };
  const marks: StreamRow[] = marksOf(records, role)
    .filter((mk) => inSpan(q.span)(mk.createdAt))
    .map((mk) => ({ id: "m:" + mk.id, kind: "mark", ts: mk.createdAt, from: role, fromName: dir.nameOf(role),
      fromLabel: dir.labelOf(role), html: renderCutMark(mk).html }));
  const loose: StreamRow[] = q.msgs
    .filter((m) => !m.turn || !outTurns.has(m.turn))
    .map((m) => ({ id: "l:" + m.id, kind: "ledger", ts: m.at, room: m.room, roomLabel: m.roomLabel,
      from: m.author.kind === "wizard" ? m.author.id : m.author.kind === "human" ? "human:" + m.author.id : "system:",
      fromName: m.authorName, row: m as RoomMsg }));
  return [...msgs.flatMap(turnRows), ...marks, ...loose].sort((a, b) => a.ts - b.ts);
};
