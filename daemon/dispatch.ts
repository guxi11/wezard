// 派活那一层剩下的类型词汇 (T10: 由退役的回执模块归位过来的)。
//
// 为什么这里只放类型 + 两个入口校验: 旧机制把「这件活欠谁、结论回给谁、第几个来回」分别
// 记在回执槽 / 冻结栈 / 件号里; 路由表 (见 `router.ts`) 只用一条 `receiver` 边表达,
// 于是这里剩下的只有**一次派活的入参**与**回执去向的那四个词**。状态一律现算, 不落盘。
import type { Asker } from "../shared/detail-store.js";
import type { ReceiptStatus } from "../shared/reminder.js";
import type { TurnState } from "../shared/turn-state.js";

/** 一件前置的结论快照 (`after` 放行时原样附给 owner)。 */
export interface HeldSeen { to: string; status: ReceiptStatus; body: string }

/** 一件前置此刻是什么: done / failed 带结论; pending = 还在路上; unknown = 表上查不到。 */
export type Prereq =
  | { state: "done" | "failed"; seen: HeldSeen }
  | { state: "pending" | "unknown" };

/** 一次派活 (`tell_peer` / `dispatch` / 计划节点共用)。
 *
 *  `event` = 这一轮挂在哪一笔上 (§9.4) —— **注入事件的 id 由它算出来** (`route:<event>`,
 *  续问 `route:<event>:r<legs>`), 所以它必须在注入之前就定下: 有这一笔就是子行 / 沿用的
 *  那一笔, 没有就是 detach (行照开, 只是不挂在谁下面)。`legs` 只在续问里 > 1。 */
export interface Tell {
  queued?: boolean;
  /** 一次 tracked dispatch 的稳定键 (续问沿用件、换这个键)。 */
  dispatchKey?: string;
  from: string;
  to: string;
  channel: string;
  /** Explicit reminder association for this event; continuations inherit from the original event. */
  planId?: string;
  /** 发话时刻。注入**之前**取的那个 —— 晚于那一句落盘的话, 回执定位的下界就偏了。 */
  at?: number;
  /** 这一轮服务的那一笔 (路由 event)。 */
  event?: string;
  legs?: number;
  /** Historical bounced text may still be present in recovered receiver events. */
  bounced?: string;
  /** 发话方那一轮的链头 (见 Asker): 回执带回去, 子活再派下去时继承。 */
  asker?: Asker;
}

/** 一个 wizard 手上在飞的活 (名册 / peek 的一行)。`turn` 那一栏是 event id
 *  —— 下游只当字符串展示 (§9.1)。 */
export interface InFlight { from: string; to: string; turn: string; state: TurnState; ageMs: number; fromBlocked?: boolean }

// ── 回执去向 (§3.2 / §9.5) ──────────────────────────────────────────────
// 只有四个词, 旧写法 (`chain:false` / `receipt:false` / `answer:"transfer"`) 自 T10 起下线 ——
// 它们表达的是同一件事的一半, 留着就有第二种说法与第二种实现。

export type ReturnOp = "self" | "transfer" | "detach" | "none";
export const RETURN_OPS: readonly ReturnOp[] = ["self", "transfer", "detach", "none"];

/** `return` → 去向。不给 = `self` (子活交回发话方)。 */
export const returnOpOf = (b: { return?: unknown }):
  { ok: true; op: ReturnOp } | { ok: false; reason: string } =>
  b.return === undefined ? { ok: true, op: "self" }
    : RETURN_OPS.includes(b.return as ReturnOp) ? { ok: true, op: b.return as ReturnOp }
      : { ok: false, reason: `return 只有 ${RETURN_OPS.join(" / ")}` };
