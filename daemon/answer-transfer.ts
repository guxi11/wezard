import type { JsonMap } from "../shared/json-map-store.js";
import type { Tell, Outcome } from "./receipts.js";

export interface AnswerTransfer {
  id: string;
  source: string;
  target: string;
  sourceTurn: string;
  sourceOpening: number;
  origin: string;
  channel: string;
  prefix: string;
  tell: Tell;
  state: "reserved" | "active" | "delivering" | "delivered" | "uncertain";
  outcome?: Outcome;
}

export const answerRecoveryAction = (row: AnswerTransfer): "cancel-before-send" | "deliver-outcome" | "watch" | "ambiguous" | "settled" =>
  row.state === "reserved" ? "cancel-before-send"
    : row.state === "delivering" ? "ambiguous"
      : row.state === "delivered" || row.state === "uncertain" ? "settled"
        : row.outcome ? "deliver-outcome" : "watch";

export const answerTransferOrigin = (source: string, sourceTurn: string): string => `${source}\0${sourceTurn}`;
export const answerTargetOccupied = (row: AnswerTransfer): boolean => ["reserved", "active", "delivering"].includes(row.state);
export const answerTargetTerminal = (rows: readonly AnswerTransfer[], target: string, turn: string): AnswerTransfer | undefined =>
  rows.find((row) => row.target === target && row.tell.turn === turn && !!row.outcome);
export const answerSourceLost = (rows: readonly AnswerTransfer[], source: string, currentTurn: string | undefined, opening: number | undefined): boolean =>
  rows.some((row) => row.source === source && (currentTurn ? row.sourceTurn === currentTurn : opening !== undefined && row.sourceOpening === opening));

/** The human turn, rather than the wizard pair, is the exclusive ownership key.
 * Strict writes happen before transport; a reservation survives ambiguous paste. */
export const createAnswerTransfers = (store: JsonMap<AnswerTransfer>) => {
  const all = (): AnswerTransfer[] => Object.values(store.all());
  const get = (id: string): AnswerTransfer | undefined => store.get(id);
  const reserve = (row: AnswerTransfer): void => {
    if (get(row.id)) throw new Error("answer transfer id already exists");
    if (all().some((r) => r.origin === row.origin)) throw new Error("this human turn already transferred its answer");
    if (all().some((r) => r.target === row.target && answerTargetOccupied(r))) throw new Error("target has an answer transfer in flight");
    store.set(row.id, row);
  };
  const activate = (id: string): void => {
    const r = get(id);
    if (r?.state === "reserved") store.set(id, { ...r, state: "active" });
  };
  const rollback = (id: string): void => {
    if (get(id)?.state === "reserved") store.drop(id);
  };
  const outcome = (id: string, out: Outcome): AnswerTransfer | undefined => {
    const r = get(id);
    if (!r || r.state === "delivered" || r.state === "uncertain") return undefined;
    if (!r.outcome) store.set(id, { ...r, outcome: out });
    return get(id);
  };
  return {
    all, get, reserve, activate, rollback, outcome,
    source: (target: string, turn: string): boolean => all().some((r) => r.source === target && r.sourceTurn === turn),
    origin: (target: string, origin: string): AnswerTransfer | undefined => all().find((r) => r.source === target && r.origin === origin),
    target: (target: string, turn: string): AnswerTransfer | undefined => all().find((r) => r.target === target && r.tell.turn === turn),
    terminalTarget: (target: string, turn: string): AnswerTransfer | undefined => answerTargetTerminal(all(), target, turn),
    prefix: (id: string, prefix: string): void => { const r = get(id); if (r?.state === "active") store.set(id, { ...r, prefix }); },
    delivering: (id: string): boolean => { const r = get(id); if (!r || r.state !== "active" || !r.outcome) return false; store.set(id, { ...r, state: "delivering" }); return true; },
    delivered: (id: string): void => { const r = get(id); if (r) store.set(id, { ...r, state: "delivered" }); },
    uncertain: (id: string): void => { const r = get(id); if (r?.state === "delivering") store.set(id, { ...r, state: "uncertain" }); },
  };
};
