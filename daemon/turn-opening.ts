// reload 后接回「这一轮是谁开口、在哪个频道说的」: 纯函数, 无 IO (mirror-bridge `openingOf` 读完 transcript 后调它)。
//
// 一轮开头那句 user 行有两种形状:
//   · 挂着信封 (`wezard="envelope"`): 定时任务 / 记忆整理在写; 老转录里还有人话与同伴信封 (只读)。
//   · 没有信封: room 唤醒 (人话信封已删)。哪个 room = 唤醒头 `【label】(roomId)`, 谁说的 = 触发行 `[id] <author>:`
//     (作者认形状: `.名字` 是 wizard、`wezard` 是系统, 其余是人, 见 shared/inject-view humanOpening);
//     绑定 room 的 id 就是群的 base principal → channel = 群; dm / adhoc 是私下 → channel `""`。
//     唤醒里没有人话行 (同伴 / 回执 / 定时的 room 行) = undefined, 调用方回落到最近一轮的印章。
import type { TurnFrom } from "../shared/detail-store.js";
import { humanOpening } from "../shared/inject-view.js";
import { isBoundRoom } from "../shared/room.js";
import type { Turn } from "./peers.js";

export interface TurnOpening { channel: string; speaker?: string; from?: TurnFrom; query: string }

/** 回执 / 定时任务信封携带当前 event (事件表已退役, 只认信封自己带的)。 */
const rowOf = (env: { kind: string; receipt?: boolean; event?: string }): string | undefined =>
  env.receipt || env.kind === "task" ? env.event : undefined;

/** `home` = 接话 wizard 的 home 群 (baseOfKey); `peerTarget` = 同伴名 → target (老同伴信封用)。 */
export const turnOpening = (t: Turn | undefined, home: string, peerTarget: (name: string) => string | undefined): TurnOpening | undefined => {
  const env = t?.env;
  if (!t) return undefined;
  if (!env) {
    const h = humanOpening(t.text);
    return h ? { channel: isBoundRoom(h.room) ? h.room : "", speaker: `user:${h.speaker}`, query: t.text } : undefined;
  }
  const handed = false; // transfer 语义已随路由表退役
  const from: TurnFrom | undefined =
    env.kind === "peer" ? { kind: "peer", from: peerTarget(env.from), ...(handed ? { transferred: true } : env.private ? {} : { public: true }), ...(env.receipt ? { receipt: true } : {}), ...(env.status ? { status: env.status } : {}), ...((turn) => (turn ? { turn } : {}))(rowOf(env)), ...(env.asker ? { asker: env.asker } : {}) }
    : env.kind === "task" ? { kind: "task", taskId: env.from.replace(/^定时 /, "") }
    : undefined;
  return {
    channel: env.private ? "" : env.chatKey || home,
    speaker: env.kind === "human" ? `user:${env.from}` : undefined,
    from,
    query: t.text,
  };
};
