// Rolepage 的消息片段 —— 一条消息的正文 HTML, 左右对齐与头像由客户端按视角包装
// (同一条消息, 从发话方看靠右、从收信方看靠左, 服务端不该替它决定)。
//
//   入   发话方说的那句 (userQuery), markdown 由客户端渲染
//   出   该 wizard 这一轮的回复: 复用 renderTurnGroup (文本 + 工具细节), 去掉问句 ——
//        问句已经是上面那条入消息了; 本轮用量单独走 `meta`, 客户端写在名字那一行
//   断点 视角 role 自己的 /clear /new
import { renderCutMark, renderTurnGroup, splitReminders, escHtml, hashStr, tagSig, type TurnFragment } from "./detail-render.js";
import { isTurn, staleAt, turnDone } from "./chat-view.js";
import { isKeepaliveTurn } from "./keepalive.js";
import type { DetailRecord, MarkDetailRecord, TurnDetailRecord } from "./detail-store.js";
import { teammateOf, unwrapMates, type Directory, type Msg } from "./role-view.js";

export interface MsgFragment {
  /** `<turnId>:in` / `<turnId>:out` / `m:<markId>`。 */
  id: string;
  turnId: string;
  dir: "in" | "out" | "mark";
  from: string;
  to: string;
  fromName: string;
  fromLabel: string;
  toName: string;
  toLabel: string;
  /** 公开频道 base; "" = 私聊。 */
  channel: string;
  ts: number;
  /** 保温 ping —— 客户端把相邻的几条折成一行, 不当气泡画。 */
  ping: boolean;
  html: string;
  /** 出消息这一轮的账 (呼吸点 + 模型 / token / 耗时) —— 写在气泡外名字那一行; 其余为 ""。 */
  meta: string;
  sig: string;
  /** 见 chat-view.staleAt; 0 = 已结束。 */
  staleAt: number;
}

// 入消息顶上的一行归因: 这句话不是人打的字时说清是谁派的。
// 没有「公开」标记 —— 公开与否是**会话窗口**这一层的事, 不是消息这一层的:
// send_peer 的 channel 就是 `isPublic ? channelOf(self) : ""` (daemon/index.ts),
// convKeyOf 又只按 channel 分窗, 于是公开的一句必在 `c:<base>` 群窗、私聊的必在
// `p:<对端>` 私窗。在群窗里标「公开」等于给每条消息盖一个恒真的章。
// 时刻不在这里 —— 它写在气泡外的 .mwho 上 (每条消息只报一次时间), 所以
// 没有归因要说时整行省掉, 免得留下一条空的内边距。
const mateChip = (mate: string | undefined): string =>
  mate === undefined ? "" : `<span class="mchip sys">agent team${mate ? ` · ${escHtml(mate)}` : ""}</span>`;

const inMeta = (r: TurnDetailRecord): string => {
  const bits = [
    r.origin ? `<span class="mchip graph" title="graph ${escHtml(r.origin.runId)}">🕸 轮 ${r.origin.round}/${r.origin.rounds} · 步 ${r.origin.step}/${r.origin.steps}</span>` : "",
    r.from?.kind === "task" ? `<span class="mchip task">⏰ 定时 ${escHtml(r.from.taskId ?? "")}</span>` : "",
    mateChip(teammateOf(r.userQuery)),
    r.from?.job ? `<span class="mchip job">📋 ${escHtml(r.from.job)}</span>` : "",
  ].filter(Boolean);
  return bits.length ? `<div class="mmeta">${bits.join("")}</div>` : "";
};

// 回执的定论 —— 回执轮没有入消息 (那句话就是同伴的出消息), 所以它写在出消息名字那一行。
const RCPT: Readonly<Record<string, string>> = {
  done: "已交", need: "反问", error: "报错", timeout: "超时", silent: "没答", dead: "失联", canceled: "撤回",
};
/** 回执那一轮的 chip: 定论 + 工单里第几份; 点它跳回派活那句 (按 from.turn 找 data-pturn)。 */
const receiptChip = (r: TurnDetailRecord): string => {
  const f = r.from;
  if (f?.kind !== "peer" || !f.receipt) return "";
  const st = f.status ?? "done";
  const seq = f.job && f.total ? ` · ${escHtml(f.job)} 第 ${f.done ?? 0}/${f.total} 份` : "";
  const tag = f.turn ? "button" : "span";
  return `<${tag} class="mchip rcpt st-${escHtml(st)}"${f.turn ? ` data-goto="${escHtml(f.turn)}" title="跳到派活那句 (${escHtml(f.turn)})"` : ""}>↩ 回执 · ${RCPT[st] ?? escHtml(st)}${seq}</${tag}>`;
};

/** 派活 / 续问那句带上它的活号, 回执凭它定位回来。 */
const pturnAttr = (r: TurnDetailRecord): string =>
  r.from?.kind === "peer" && r.from.turn && !r.from.receipt ? ` data-pturn="${escHtml(r.from.turn)}"` : "";

const renderIn = (r: TurnDetailRecord): string => {
  const q = splitReminders(unwrapMates(r.userQuery ?? ""));
  return tagSig(`<section class="bubble mq" data-key="${escHtml(r.id)}:in"${pturnAttr(r)}>${inMeta(r)}` +
    `<div class="md-body"></div><script type="text/plain" class="md-src">${escHtml(q.body)}</script>${q.html}</section>`);
};

/** 子 agent 的轮次内联进父轮 —— 与旧线程视图同一规则 (见 chat-view.threadEntries)。 */
const childrenOf = (records: readonly DetailRecord[], turnId: string, now: number): TurnFragment[] =>
  records.filter(isTurn)
    .filter((r) => r.agent?.parentTurnId === turnId)
    .sort((a, b) => a.createdAt - b.createdAt)
    .map((c) => renderTurnGroup(c, now));

const base = (m: Pick<Msg, "from" | "to" | "channel">, dir: Directory) => ({
  from: m.from, to: m.to, channel: m.channel,
  fromName: dir.nameOf(m.from), fromLabel: dir.labelOf(m.from),
  toName: dir.nameOf(m.to), toLabel: dir.labelOf(m.to),
});

export const renderMsg = (m: Msg, records: readonly DetailRecord[], dir: Directory, now: number): MsgFragment => {
  const r = m.turn;
  const { html, meta } = m.dir === "in"
    ? { html: renderIn(r), meta: "" }
    : ((g) => ({ html: g.html, meta: receiptChip(r) + g.meta }))(renderTurnGroup(r, now, childrenOf(records, r.id, now), false));
  const live = m.dir === "out" && !turnDone(r, now);
  return {
    id: m.id, turnId: r.id, dir: m.dir, ...base(m, dir), ts: m.ts,
    ping: isKeepaliveTurn(r),
    html, meta, sig: hashStr(html + meta),
    staleAt: live ? staleAt(r) : 0,
  };
};

export const renderMark = (mk: MarkDetailRecord, role: string, dir: Directory): MsgFragment => {
  const f = renderCutMark(mk);
  return {
    id: `m:${mk.id}`, turnId: mk.id, dir: "mark", ...base({ from: role, to: role, channel: "" }, dir),
    ts: mk.createdAt, ping: false, html: f.html, meta: "", sig: f.sig, staleAt: 0,
  };
};
