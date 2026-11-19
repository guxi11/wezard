// 老 routes.jsonl 的只读折叠 —— 只服务迁移 migrate (契约 §6), 不参与运行时。
//
// daemon/router.ts 即将删除, 但「哪几笔活还没了结」只在那份日志里; 迁移要把它变成 room 账本
// 里的一条人话 / 一条 task。所以这里留最小的一份: 行类型 + 逐行 parse + fold + 未结判定。
// 不是 router 的替代品 —— 没有写路径、没有派生查询、没有时钟、没有任何读别的 store 的入口。
// 形态与语义照抄 router (§9.1/§9.2), 认不出的行一律不猜。
import { clipLine } from "./std.js";

export interface LegacyAsker {
  who: string;
  chat: string;
}

/** 与 router.Status 同一套词。 */
export type LegacyStatus = "held" | "open" | "need" | "error" | "answered" | "handed";

/** 定论交给谁: chat = 群里那句人话的答复气泡; wizard = 进它的收件箱。 */
export type LegacyReceiver =
  | { kind: "chat"; channel: string; message: string }
  | { kind: "wizard"; to: string; event?: string };

/** 迁移只看得懂这几样: 谁在干 (owner)、结论往哪去 (receiver)、还欠着没有 (status)、什么时候开的、链头是谁。 */
export interface LegacyRoute {
  event: string;
  mergedInto?: string;
  owner: string;
  receiver: LegacyReceiver;
  status: LegacyStatus;
  at: number;
  seq: number;
  after?: string[];
  asker?: LegacyAsker;
}

export type LegacyOp =
  | { op: "open"; at: number; event: string; owner: string; receiver: LegacyReceiver; status?: "open" | "held"; after?: string[]; asker?: LegacyAsker }
  | { op: "release"; at: number; event: string }
  | { op: "drop"; at: number; event: string }
  | { op: "gc"; at: number; event: string }
  | { op: "mark"; at: number; event: string; status: "open" | "need" | "error" | "progress" }
  | { op: "move"; at: number; event: string; owner: string }
  | { op: "answer"; at: number; event: string }
  | { op: "hand"; at: number; event: string; inbox: string }
  | { op: "merge"; at: number; event: string; into: string }
  | { op: "row"; route: LegacyRoute };

/** 没落定的行: 还在等 owner / 等 re / 等前置 / 报过错等续跑。 */
export const UNSETTLED: ReadonlySet<LegacyStatus> = new Set<LegacyStatus>(["held", "open", "need", "error"]);

const STATUSES: ReadonlySet<string> = new Set(["held", "open", "need", "error", "answered", "handed"]);
// mark 只落中途态 (handed 是墓碑); progress 是只记 notice 的中间回执, 不改行状态。
const MARK_STATUSES: ReadonlySet<string> = new Set(["open", "need", "error", "progress"]);

const nonEmpty = (v: unknown): v is string => typeof v === "string" && v !== "";
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

const receiverOk = (v: unknown): v is LegacyReceiver => {
  const r = v as LegacyReceiver | undefined;
  if (!r) return false;
  return r.kind === "chat"
    ? typeof r.channel === "string" && nonEmpty(r.message)
    : r.kind === "wizard" && nonEmpty(r.to) && (r.event === undefined || typeof r.event === "string");
};

const askerOk = (v: unknown): v is LegacyAsker => {
  const a = v as LegacyAsker | undefined;
  return !!a && nonEmpty(a.who) && typeof a.chat === "string";
};

const afterOf = (v: unknown): string[] | undefined => {
  const list = Array.isArray(v) ? v.filter(nonEmpty) : [];
  return list.length ? list : undefined;
};

/** 一行日志 → 一条 op。认不出 = undefined (调用方据此判撕裂 / 判坏行)。
 *  只核迁移用得到的字段: 半行坏字段 fold 进表就是一行的错, 但 deadline / batch 之类与迁移无关。 */
export const parseLegacyOp = (raw: string): LegacyOp | undefined => {
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return undefined;
  const o = obj as Record<string, unknown>;
  if (!nonEmpty(o.event) || !finite(o.at)) return undefined;
  const event = o.event;
  const at = o.at;
  switch (o.op) {
    case "open": {
      if (!nonEmpty(o.owner) || !receiverOk(o.receiver)) return undefined;
      if (o.status !== undefined && o.status !== "open" && o.status !== "held") return undefined;
      const after = afterOf(o.after);
      return {
        op: "open", at, event, owner: o.owner, receiver: o.receiver,
        ...(o.status ? { status: o.status as "open" | "held" } : {}),
        ...(after ? { after } : {}),
        ...(askerOk(o.asker) ? { asker: o.asker } : {}),
      };
    }
    case "release":
    case "drop":
    case "gc":
      return { op: o.op, at, event };
    case "mark":
      if (!MARK_STATUSES.has(String(o.status))) return undefined;
      return { op: "mark", at, event, status: o.status as "open" | "need" | "error" | "progress" };
    case "move":
      return nonEmpty(o.owner) ? { op: "move", at, event, owner: o.owner } : undefined;
    case "answer":
      return { op: "answer", at, event };
    case "hand":
      return nonEmpty(o.inbox) ? { op: "hand", at, event, inbox: o.inbox } : undefined;
    case "merge":
      return nonEmpty(o.into) ? { op: "merge", at, event, into: o.into } : undefined;
    case "row": {
      if (!nonEmpty(o.owner) || !receiverOk(o.receiver) || !STATUSES.has(String(o.status))) return undefined;
      const after = afterOf(o.after);
      return {
        op: "row",
        route: {
          event, owner: o.owner, receiver: o.receiver, status: o.status as LegacyStatus, at,
          seq: finite(o.seq) ? o.seq : 0,
          ...(nonEmpty(o.mergedInto) ? { mergedInto: o.mergedInto } : {}),
          ...(after ? { after } : {}),
          ...(askerOk(o.asker) ? { asker: o.asker } : {}),
        },
      };
    }
    default:
      return undefined;
  }
};

const unresolved = (t: ReadonlyMap<string, LegacyRoute>, id: string): string => {
  const seen = new Set<string>();
  let cur = id;
  for (;;) {
    const next = t.get(cur)?.mergedInto;
    if (!next || seen.has(cur)) return cur;
    seen.add(cur);
    cur = next;
  }
};

/** 唯一的状态机。表在函数内建、函数内死 (迁移是离线的一次性读)。 */
const step = (t: Map<string, LegacyRoute>, op: LegacyOp): void => {
  if (op.op === "row") {
    t.set(op.route.event, op.route);
    return;
  }
  if (op.op === "open") {
    // 重放同一段日志不该分叉: 同一个 event 只认第一次插行。
    if (t.has(op.event)) return;
    t.set(op.event, {
      event: op.event, owner: op.owner, receiver: op.receiver, status: op.status ?? "open", at: op.at, seq: 0,
      ...(op.after ? { after: op.after } : {}),
      ...(op.asker ? { asker: op.asker } : {}),
    });
    return;
  }
  if (op.op === "gc") {
    t.delete(op.event);
    return;
  }
  if (op.op === "merge") {
    const from = t.get(op.event);
    const into = t.get(op.into);
    if (!from || !into || from.event === into.event) return;
    if (!UNSETTLED.has(from.status) || !UNSETTLED.has(into.status)) return;
    t.set(from.event, { ...from, mergedInto: into.event, status: "handed" });
    return;
  }
  const id = unresolved(t, op.event);
  const row = t.get(id);
  if (!row) return;
  switch (op.op) {
    case "release":
      if (row.status === "held") t.set(id, { ...row, status: "open" });
      return;
    case "mark":
      // 已落定的行只认「追述」(带 rev 的 notice), 行状态不动; progress 同理。迁移只关心
      // 「还欠不欠」, 所以这两类一律不动 —— 宁可少算一笔未结, 也不复活一笔已答的。
      if (row.status === "answered" || row.status === "handed") return;
      if (op.status === "progress" || row.status === op.status) return;
      t.set(id, { ...row, status: op.status });
      return;
    case "move":
      if (row.owner !== op.owner) t.set(id, { ...row, owner: op.owner });
      return;
    case "answer":
      if (row.status === "answered" || row.status === "handed") return;
      t.set(id, { ...row, status: "answered" });
      return;
    case "hand":
      if (row.status === "answered") t.set(id, { ...row, status: "handed" });
      return;
    case "drop":
      if (row.receiver.kind === "wizard") t.set(id, { ...row, receiver: { kind: "wizard", to: row.receiver.to } });
      return;
    default:
      return;
  }
};

/** 日志 → 现存的活行 (不含被 merge 掉的别名), 按 (at, event) 定序。
 *  只有最后一行容许撕裂 (崩溃中途写的半行); 中间行坏 = 表不可信 = 抛错 —— 迁移宁可停下,
 *  也不把一笔没结的活静默丢掉。 */
export const foldLegacyRoutes = (raw: string): LegacyRoute[] => {
  const lines = raw.split("\n").filter((l) => l.trim() !== "");
  const parsed = lines.map(parseLegacyOp);
  const lastAt = parsed.length - 1;
  const bad = parsed.findIndex((op, i) => !op && i !== lastAt);
  if (bad >= 0) {
    throw new Error("routes.jsonl 第 " + (bad + 1) + " 行不是一条合法 op —— 拒绝迁移 (migrate): " + clipLine(lines[bad] ?? "", 120));
  }
  const table = new Map<string, LegacyRoute>();
  for (const op of parsed) if (op) step(table, op);
  return [...table.values()]
    .filter((r) => !r.mergedInto)
    .sort((a, b) => a.at - b.at || (a.event < b.event ? -1 : a.event > b.event ? 1 : 0));
};

/** 迁移要的那一份: 还没了结的路由。 */
export const unsettledRoutes = (raw: string): LegacyRoute[] =>
  foldLegacyRoutes(raw).filter((r) => UNSETTLED.has(r.status));
