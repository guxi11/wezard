// 一件在飞的活此刻是什么状态 —— 名册、peek、工单清单看同一个词。
//
// 只从两处现算, 不落盘: 一行状态 (回执路由表: 前置落定了没有 / 交出定论了没有 / 还挂着
// 没落定的子活) 和 pane 的一次探针 (是不是停在审批卡上)。终态就是行上那份定论的 status;
// 其余几种都是「还没定论」的细分 —— 发起者据此判断该等、该答、还是该去点那张卡。
import type { ReceiptStatus } from "./reminder.js";

/** Finite persisted sentinel; it must never be passed to Date or a timer. */
export const NO_DEADLINE = Number.MAX_SAFE_INTEGER;
export const hasDeadline = (value: number): boolean => value < NO_DEADLINE;

/** 落定了的那几种 (need / error / progress 都是中途的)。 */
export type Terminal = Exclude<ReceiptStatus, "need" | "error" | "progress">;
export const isTerminal = (st: ReceiptStatus): st is Terminal => st !== "need" && st !== "error" && st !== "progress";
export type TurnState = "working" | "blocked" | "needs-input" | "errored" | "deferred" | "queued" | Terminal;

/** 路由行 (`daemon/router.ts` 的 Status) 到这一层词表的适配 (§9.5):
 *  `held` (前置没落定) → `queued`, 还挂着没落定的子行 → `deferred`, 定了论的直接报它。 */
export interface TurnSlot {
  status: RouteStatus;
  /** `waiting(event)` 非空 = 它还挂着没落定的子行。 */
  waiting: boolean;
  /** 落了定论的才给 (answered / handed)。 */
  outcome?: Terminal;
}
export type RouteStatus = "held" | "open" | "need" | "error" | "answered" | "handed";

export const turnState = (s: TurnSlot, probe: { parked: boolean }): TurnState => {
  return s.status === "held" ? "queued"
    : s.status === "need" ? "needs-input"
      : s.waiting ? "deferred"
        : s.status === "error" ? "errored"
          : s.status === "answered" || s.status === "handed" ? s.outcome ?? "done"
            : probe.parked ? "blocked"
              : "working";
};

const ageOf = (ms: number): string =>
  ms < 60_000 ? `${Math.max(1, Math.round(ms / 1000))}s` : ms < 3_600_000 ? `${Math.round(ms / 60_000)}m` : `${Math.round(ms / 3_600_000)}h`;

/** `working 12m` —— 状态 + 自派出以来多久。 */
export const renderTurnState = (state: TurnState, ageMs: number): string => `${state === "queued" ? "queued(等前置)" : state} ${ageOf(ageMs)}`;

/** 名册 / peek 的那一行: `target` 在等谁 (它派出去的), 谁在等它 (派给它的)。都没有 = ""。 */
export const renderInFlight = (
  xs: readonly { from: string; to: string; state: TurnState; ageMs: number }[],
  target: string,
  nameOf: (t: string) => string,
): string => {
  const list = (ys: typeof xs, who: (y: (typeof xs)[number]) => string): string =>
    ys.map((y) => `${nameOf(who(y))}(${renderTurnState(y.state, y.ageMs)})`).join(" ");
  const awaits = xs.filter((x) => x.from === target);
  const owes = xs.filter((x) => x.to === target);
  return [
    awaits.length ? `在等: ${list(awaits, (y) => y.to)}` : "",
    owes.length ? `欠着: ${list(owes, (y) => y.from)}` : "",
  ].filter(Boolean).join(" · ");
};
