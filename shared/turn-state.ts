// 一件在飞的活的状态词表: 终态 (回执的 Terminal) 加上「还没定论」的几种细分 ——
// 发起者据此判断该等、该答、还是该去点那张卡。世界事实 (world.ts) 与回执路由共用这份词。
import type { ReceiptStatus } from "./reminder.js";

/** Finite persisted sentinel; it must never be passed to Date or a timer. */
export const NO_DEADLINE = Number.MAX_SAFE_INTEGER;
export const hasDeadline = (value: number): boolean => value < NO_DEADLINE;

/** 落定了的那几种 (need / error / progress 都是中途的; passed 是 P7 的「无需答复」了结 ——
 *  定论但不投正文, 与 done 一样是终态)。 */
export type Terminal = Exclude<ReceiptStatus, "need" | "error" | "progress">;
export const isTerminal = (st: ReceiptStatus): st is Terminal => st !== "need" && st !== "error" && st !== "progress";
export type TurnState = "working" | "blocked" | "needs-input" | "errored" | "deferred" | "queued" | Terminal;
