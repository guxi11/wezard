// Rolepage 的消息片段 —— 一条消息的正文 HTML, 左右对齐与头像由客户端按视角包装
// (同一条消息, 从发话方看靠右、从收信方看靠左, 服务端不该替它决定)。
//
//   入   发话方说的那句 (userQuery), markdown 由客户端渲染
//   出   该 wizard 这一轮的回复: 复用 renderTurnGroup (文本 + 工具细节 + 本轮用量),
//        去掉问句 —— 问句已经是上面那条入消息了
//   断点 视角 role 自己的 /clear /new
import { renderCutMark, renderTurnGroup, escHtml, hashStr, tagSig, type TurnFragment } from "./detail-render.js";
import { isKeepaliveTurn, isTurn, staleAt, turnDone } from "./chat-view.js";
import type { DetailRecord, MarkDetailRecord, TurnDetailRecord } from "./detail-store.js";
import type { Directory, Msg } from "./role-view.js";

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
  sig: string;
  /** 见 chat-view.staleAt; 0 = 已结束。 */
  staleAt: number;
}

// 入消息顶上的一行归因: 这句话不是人打的字时说清是谁派的。
// 时刻不在这里 —— 它写在气泡外的 .mwho 上 (每条消息只报一次时间), 所以
// 没有归因要说时整行省掉, 免得留下一条空的内边距。
const inMeta = (r: TurnDetailRecord): string => {
  const bits = [
    r.origin ? `<span class="mchip graph" title="graph ${escHtml(r.origin.runId)}">🕸 轮 ${r.origin.round}/${r.origin.rounds} · 步 ${r.origin.step}/${r.origin.steps}</span>` : "",
    r.from?.kind === "task" ? `<span class="mchip task">⏰ 定时 ${escHtml(r.from.taskId ?? "")}</span>` : "",
    r.from?.kind === "peer" && r.from.public ? `<span class="mchip pub">公开</span>` : "",
    r.from?.job ? `<span class="mchip job">📋 ${escHtml(r.from.job)}</span>` : "",
  ].filter(Boolean);
  return bits.length ? `<div class="mmeta">${bits.join("")}</div>` : "";
};

const renderIn = (r: TurnDetailRecord): string =>
  tagSig(`<section class="bubble mq" data-key="${escHtml(r.id)}:in">${inMeta(r)}` +
    `<div class="md-body"></div><script type="text/plain" class="md-src">${escHtml(r.userQuery ?? "")}</script></section>`);

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
  const html = m.dir === "in" ? renderIn(r) : renderTurnGroup(r, now, childrenOf(records, r.id, now), false).html;
  const live = m.dir === "out" && !turnDone(r, now);
  return {
    id: m.id, turnId: r.id, dir: m.dir, ...base(m, dir), ts: m.ts,
    ping: isKeepaliveTurn(r),
    html, sig: hashStr(html),
    staleAt: live ? staleAt(r) : 0,
  };
};

export const renderMark = (mk: MarkDetailRecord, role: string, dir: Directory): MsgFragment => {
  const f = renderCutMark(mk);
  return {
    id: `m:${mk.id}`, turnId: mk.id, dir: "mark", ...base({ from: role, to: role, channel: "" }, dir),
    ts: mk.createdAt, ping: false, html: f.html, sig: f.sig, staleAt: 0,
  };
};
