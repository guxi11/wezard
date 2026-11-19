// 一条 room 消息点开的过程框 —— 那一轮的工具调用与 CLI 原话, 取自 turn store。
//
// room 账本里的一条消息只有正文与元数据 (author / to / re / status); 它是怎么被产出的
// (调了哪些工具、跑了多久) 在轮次记录里, 两者由消息的作者 + 时刻对上 (见 chat-http 的
// turnLinker, 只为「点开看过程框」服务, 不参与任何语义判定)。
//
// 工具正文照旧懒加载: 片段里只留空壳 (data-lazy-turn / data-lazy-use), 展开时才取
// /api/tool —— 与详情页同一份实现 (shared/detail-render)。
import { renderTurnGroup, type TurnFragment } from "./detail-render.js";
import { isTurn } from "./chat-view.js";
import type { DetailRecord, TurnDetailRecord } from "./detail-store.js";

/** 子 agent 的那几轮 —— 内联在父轮的过程框里 (父轮发起、父轮收口)。 */
const childrenOf = (r: TurnDetailRecord, records: readonly DetailRecord[]): TurnDetailRecord[] =>
  records.filter(isTurn).filter((t) => t.agent?.parentTurnId === r.id).sort((a, b) => a.createdAt - b.createdAt);

export const renderTurnBox = (r: TurnDetailRecord, records: readonly DetailRecord[], now = Date.now()): string => {
  const children: TurnFragment[] = childrenOf(r, records).map((c) => renderTurnGroup(c, now, [], true));
  return renderTurnGroup(r, now, children, false).html;
};
