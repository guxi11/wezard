// spawn / clone / delegate 的 `room` 参数: 「验证 room 目标 → 入座 → append」的顺序。
// 为什么单拎出来: judge 第 ⑤ 条要求 task 的 `to` 必须是成员, 所以被派者得**先**入座再投活;
// 先 append 后入座 (旧顺序) 对新生 / 非成员执行者必 409。依赖全部以参数注入, index.ts 的大闭包
// 之外也能用真 judge / 真 fold 测。三条路径 (delegate 两支 + bearAs 出生即派活) 共用。
import type { Who } from "../shared/room.js";

export interface Refused { ok: false; status: number; reason: string }

export interface RoomTargetDeps {
  /** room 参数 (room id 或聊天名) → room id。 */
  resolve: (ref: string) => { room?: string; error?: string };
  /** 调用方是不是这个 room 的成员 (judge 本来就要求 author 是成员)。 */
  isMember: (room: string, who: Who) => boolean;
}

/** 生 wizard **之前**先验: room 认得出、调用方在里面。不合法回 4xx, 什么都还没生。 */
export const checkRoomTarget = (
  deps: RoomTargetDeps, me: Who | undefined, ref: string,
): { ok: true; room: string } | Refused => {
  if (!me) return { ok: false, status: 400, reason: "caller 不在名册上, 没有 uid" };
  const r = deps.resolve(ref);
  if (!r.room) return { ok: false, status: 404, reason: r.error ?? "认不出这个 room: " + ref };
  if (!deps.isMember(r.room, me)) return { ok: false, status: 403, reason: "你不是 room " + r.room + " 的成员, 不能往里派活 / 拉人入座" };
  return { ok: true, room: r.room };
};

/** 入座的结果: 已在席 / 刚入座都算 ok。 */
export type SeatResult = { ok: true } | { ok: false; reason: string };
/** append 的结果, 结构上就是 hub.append 的 Verdict (多余字段原样带出)。 */
export type AppendResult = { ok: true } | { ok: false; status: number; reason: string };

/** 先入座再 append; 入座失败不 append, append 被拒如实带原因 (调用方据此回 dispatched:false / 回收新生者)。 */
export const seatThenAppend = <V extends AppendResult>(
  room: string,
  join: (room: string) => SeatResult,
  append: (room: string) => V,
): { ok: true; verdict: V & { ok: true } } | Refused => {
  const seat = join(room);
  if (!seat.ok) return { ok: false, status: 409, reason: "入座失败: " + seat.reason };
  const v = append(room);
  return v.ok ? { ok: true, verdict: v as V & { ok: true } } : { ok: false, status: v.status, reason: v.reason };
};
