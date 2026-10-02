// 一件在飞的活此刻是什么状态 —— 名册、peek、工单清单看同一个词。
//
// 只从两处现算, 不落盘: 回执登记 (receipts 的 slot: 落定了没有、反问过没有、挂起等子活
// 没有) 和 pane 的一次探针 (是不是停在审批卡上)。终态就是回执的 status; 其余几种都是
// 「还没定论」的细分 —— 发起者据此判断该等、该答、还是该去点那张卡。
import type { ReceiptStatus } from "./reminder.js";

/** 落定了的那几种 (need / error 是中途的)。 */
export type Terminal = Exclude<ReceiptStatus, "need" | "error">;
export type TurnState = "working" | "blocked" | "needs-input" | "errored" | "deferred" | Terminal;

export interface TurnSlot {
  outcome?: { status: ReceiptStatus };
  resolved: boolean;
  deferred?: boolean;
}

export const turnState = (s: TurnSlot, probe: { parked: boolean }): TurnState => {
  const st = s.outcome?.status;
  return st && s.resolved ? (st as Terminal)
    : st === "need" ? "needs-input"
      : s.deferred ? "deferred"
        : st === "error" ? "errored"
          : probe.parked ? "blocked"
            : "working";
};

const ageOf = (ms: number): string =>
  ms < 60_000 ? `${Math.max(1, Math.round(ms / 1000))}s` : ms < 3_600_000 ? `${Math.round(ms / 60_000)}m` : `${Math.round(ms / 3_600_000)}h`;

/** `working 12m` —— 状态 + 自派出以来多久。 */
export const renderTurnState = (state: TurnState, ageMs: number): string => `${state} ${ageOf(ageMs)}`;

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
