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
import { parseInjection } from "./inject-view.js";
import { allMessages, inSpan, marksOf, SYSTEM, teammateOf, unwrapMates, type Directory, type Msg, type SessionSpan } from "./role-view.js";
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
  /** 注入行拆出来的账本事实: id / re / status / 所属块的原文 (点开看注入原文) / 头里的提醒。 */
  inj?: { id: string; re?: string[]; status?: string; raw?: string; note?: string };
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
  r.inj ? [r.inj.id, r.inj.status ?? "", (r.inj.re ?? []).join(","), r.inj.raw ?? "", r.inj.note ?? ""].join("\u0001") : "",
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
  const where = (room: string, lb = label(room)) => ({ room, ...(lb ? { roomLabel: lb } : {}) });
  /** 注入原文 → 逐条账本行 (多条注入合在一次输入里时一条一颗气泡)。账本里认得出那一行时
   *  用它的全文与作者: 注入里那一行是压成一行、截断过的。认不出才按注入文本显示 —— room
   *  与作者都从注入头和行里解析, 不落回「系统 → home 群」。原文块挂在每块第一条上
   *  (点开看注入原文),「你要交代」挂在每块最后一条。 */
  const injectionRows = (m: Msg): StreamRow[] => {
    const blocks = parseInjection(m.turn.userQuery ?? "");
    if (!blocks) return [];
    const rows = blocks.flatMap((b) => b.lines.map((ln): StreamRow => {
      const led = q.lookup?.(ln.id);
      // 作者以注入里写的名字为准 (名字就是身份): 账本行只补全文 / re / status。
      // 名字认不出时退回账本行的 uid 节点 (只在 room 里出现过的 wizard 的写法)。
      const named = dir.resolve(ln.author);
      const from = named ?? (led?.author.kind === "wizard" ? "uid:" + led.author.id : led?.author.kind === "human" ? "human:" + led.author.id : SYSTEM);
      const fromName = named ? dir.nameOf(from) : ln.author.replace(/^\./, "") || dir.nameOf(from);
      const fromLabel = named ? dir.labelOf(from) : /^human:/.test(from) ? "👤" : SYSTEM === from ? "🧙‍♂️" : "👤";
      // 收件人 = 这一轮真正的主人 (turn.target), 不被身份折叠后的页 id 带偏。
      const to = m.turn.target ?? m.to;
      const room = led?.room ?? b.room;
      const re = led?.re ?? ln.re;
      const status = led?.status ?? ln.status;
      const tags = [...(ln.files.length ? ["📎 " + ln.files.join(", ")] : []), ...(b.owe.length && ln === b.lines[b.lines.length - 1] ? ["要交代 " + b.owe.join(", ")] : [])];
      return {
        id: m.id + "." + ln.id, kind: "in", ts: m.ts,
        from, fromName, fromLabel,
        to, toName: dir.nameOf(to), toLabel: dir.labelOf(to),
        ...where(room, label(room) || b.label),
        text: (led?.text ?? ln.text).trim(),
        ...(tags.length ? { tags } : {}),
        inj: { id: ln.id, ...(re.length ? { re } : {}), ...(status ? { status } : {}),
          ...(ln === b.lines[0] ? { raw: b.raw } : {}), ...(ln === b.lines[0] && b.notes.length ? { note: b.notes.join(" · ") } : {}) },
      };
    }));
    return rows.map((r, k) => ({ ...r, id: m.id + "#" + k, ts: m.ts + k / 1000 }));
  };
  const turnRows = (m: Msg): StreamRow[] => {
    const r = m.turn;
    const ends = { from: m.from, fromName: dir.nameOf(m.from), fromLabel: dir.labelOf(m.from) };
    const toEnds = { to: m.to, toName: dir.nameOf(m.to), toLabel: dir.labelOf(m.to) };
    if (m.dir === "in") {
      // 注入原文只是账本行的转述: 唤醒它的那几行已经按账本画在前面, 这里不再画一遍。
      if (isInjection(r) && fed.has(r.id)) return [];
      // 注入原文拆成逐条账本行 (有头有行才拆; 拆不出就按原文画, 不猜)。
      const parsed = isInjection(r) ? injectionRows(m) : [];
      if (parsed.length) return parsed;
      const q2 = splitInline(unwrapMates(r.userQuery?.trim() ? r.userQuery : r.rawQuery ?? ""));
      if (!q2.body && !q2.html) return [];
      const tags = inTags(r);
      return [{ id: m.id, kind: "in", ts: m.ts, ...ends, ...toEnds, ...where(m.channel), text: q2.body,
        ...(q2.html ? { rems: q2.html } : {}), ...(tags.length ? { tags } : {}) }];
    }
    const said = saidByTurn.get(r.id) ?? [];
    // 一次只带一个 room 块的注入: 这一轮真正发生在那 个 room 里 —— 轮的 channel 是投递时的
    // 兜底 (home 群), 拿它当头部会把 dm 里说的话挂到群里。
    const blocks = isInjection(r) ? parseInjection(r.userQuery ?? "") : undefined;
    const injRoom = blocks?.length === 1 ? blocks[0]!.room : undefined;
    const era = r.createdAt >= roomFrom || isInjection(r);
    const spoken = spokenTurn(r, said, era);
    const live = !r.closed;
    const first = said[0];
    return [{ id: m.id, kind: "out", ts: m.ts, ...ends,
      // 账本时代的出消息说给谁由气泡 (账本行) 自己交代; 老轮次照旧按派活链推。
      ...(era || said.length ? {} : toEnds),
      ...(first ? where(first.room, first.roomLabel) : where(injRoom ?? m.channel)),
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
