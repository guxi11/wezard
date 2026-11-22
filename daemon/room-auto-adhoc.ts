// chat_ask 点名多个缺省 room 之外的 wizard 时的落点 (方案 B): 成员集合 = {调用方} ∪ to 的 adhoc,
// 同集合复用、没有就新开 (调用方 founder = host)。纯函数, 依赖注入, 供 roomTargetOf 与测试共用。
// 两条守则: ① 绝不扩大绑定群 —— 落点永远是 adhoc, 群外者不被 invite 进缺省群;
// ② 自动建 / 复用的 adhoc 里调用方是 host, judge ⑥ 会放行 host 的 interrupt, 一个调用就能打断
// 任意 wizard —— 所以这条分支里 interrupt 只给每个被点名者的直属 parent。
import { findSetAdhoc, isDirectParent, type RoomState, type Who } from "../shared/room.js";

export interface AutoAdhocDeps {
  states: () => RoomState[];
  open: (me: Who, others: Who[]) => string;
  parentUidOf: (childUid: string) => string | undefined;
}

export const autoAdhocTarget = (
  deps: AutoAdhocDeps, me: Who, to: readonly Who[], interrupt: boolean,
): { room: string } | { status: number; reason: string } => {
  if (to.some((t) => t.kind !== "wizard"))
    return { status: 400, reason: "to 里有人 (human:) 而且不全在缺省 room — 人进不了 adhoc, 先在同一个 room 里说话, 或显式给 room" };
  const others = [...new Map(to.filter((t) => t.id !== me.id).map((t) => [t.id, t])).values()];
  if (!others.length) return { status: 400, reason: "to 里只有你自己" };
  if (interrupt && !others.every((t) => isDirectParent(deps.parentUidOf, me, t)))
    return { status: 403, reason: "自动建的 room 不给 host 打断权: interrupt 只有被点名者的直属 parent 能用 — 先 room_open 自己开一个 room, 或去掉 interrupt" };
  const room = findSetAdhoc(deps.states(), [me.id, ...others.map((t) => t.id)]) ?? deps.open(me, others);
  return { room };
};
