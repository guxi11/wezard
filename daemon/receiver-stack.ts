// 回执的金字塔路由 (docs/evolve/receiver-stack.md): 帧 = 一笔欠账, 栈 = 一件活的结论要逐层冒到哪儿去。
//
// 调用者不递栈, 只对自己那一帧下操作 —— `return` (self / transfer / detach / none) 加可选的 `for`
// (挑自己欠着的哪一笔)。栈由 daemon 在派活那一刻物化、随件冻结落盘: 帧是只有 daemon 能证明的
// 欠账, 调用者手写的栈能把回执投进它没在服务的群、伪造链头绕开方向闸。
// 这里只有纯判定; 「欠着哪几笔」「这一帧之上是什么」由调用方从回执登记 / 事件队列读出来注入。
import type { ParentK } from "./receipts.js";

/** 「owner 欠 creditor 一个交代」—— 就是 ParentK, 只是承认它是一笔可被栈引用的欠账。 */
export type Frame = ParentK;
/** 一件子活的 receiver stack: 近的在前, `stack[0]` 就是旧的 `k`。 */
export type Stack = readonly Frame[];
/** 子结论先交发话方 (self), 还是直接顶替发话方对 `stack[0]` 的交代 (transfer)。 */
export type ReturnMode = "self" | "transfer";
export type ReturnOp = ReturnMode | "detach" | "none";
export const RETURN_OPS: readonly ReturnOp[] = ["self", "transfer", "detach", "none"];

/** 一笔欠账: `id` 是 `for` 认的那个 (件号 / 群轮的事件 id)。 */
export interface Owed { frame: Frame; id: string; label: string }

/** 新字段 `return` 与旧写法的合一。旧写法永久接受 (老 MCP 进程会跑很久): `chain:false` → detach,
 *  `receipt:false` / `kind:"fyi"` → none, `answer:"transfer"` → transfer。新旧同给且说的不是一回事 → 拒;
 *  旧写法 transfer 与别的开关同给 → 拒 (改前同样拒); receipt:false 盖过 chain:false (不登记槽, 挂不挂上游无从谈起)。 */
export const returnOpOf = (b: { return?: unknown; chain?: unknown; receipt?: unknown; answer?: unknown; kind?: unknown }):
  { ok: true; op: ReturnOp } | { ok: false; reason: string } => {
  const legacy: ReturnOp[] = [
    ...(b.answer === "transfer" ? ["transfer" as const] : []),
    ...(b.receipt === false || b.kind === "fyi" ? ["none" as const] : []),
    ...(b.chain === false ? ["detach" as const] : []),
  ];
  // 旧写法里 answer:"transfer" 与 receipt:false / fyi / chain:false 同给, 改前一律拒 (移交的前置): 照旧拒, 不悄悄映射成 transfer。
  if (legacy.includes("transfer") && legacy.length > 1) return { ok: false, reason: `answer:"transfer" 不能与 ${legacy.filter((x) => x !== "transfer").map(legacyName).join(", ")} 并用` };
  if (b.return !== undefined) {
    if (!RETURN_OPS.includes(b.return as ReturnOp)) return { ok: false, reason: `return 只有 ${RETURN_OPS.join(" / ")}` };
    const clash = legacy.filter((x) => x !== b.return);
    return clash.length
      ? { ok: false, reason: `return:"${String(b.return)}" 与旧写法 (${clash.map(legacyName).join(", ")}) 矛盾 —— 只用 return 说回执去哪` }
      : { ok: true, op: b.return as ReturnOp };
  }
  return { ok: true, op: legacy.includes("transfer") ? "transfer" : legacy.includes("none") ? "none" : legacy.includes("detach") ? "detach" : "self" };
};
/** 上游 `re` 一份已交出去的件 (转给叶子) 时能说什么: 续问只沿用原件, 改去向 / 换帧 / 再交出都无从谈起 (400);
 *  不要回执 (none / fyi) = 只知会叶子, 不登记 —— 同件号一登记就顶掉叶子那一份, 它对知会的「收到」会被当成定论。 */
export const leafRelayOf = (b: { return?: unknown; for?: unknown; chain?: unknown; receipt?: unknown; answer?: unknown; kind?: unknown }):
  { ok: true; quiet: boolean } | { ok: false; reason: string } => {
  const r = returnOpOf(b);
  if (!r.ok) return r;
  return r.op === "transfer" || r.op === "detach" || b.for !== undefined
    ? { ok: false, reason: "这件已交给接手方, `re` 续问只沿用原件: 不能带 transfer / detach / for" }
    : { ok: true, quiet: r.op === "none" };
};
const legacyName = (op: ReturnOp): string =>
  op === "transfer" ? `answer:"transfer"` : op === "none" ? `receipt:false / kind:"fyi"` : op === "detach" ? "chain:false" : op;

export interface ResolveDeps {
  /** 本轮开头那句信封推出来的那一帧 (receipts.parentOf); 没有 = 私聊轮 / quiet 轮 / 上游不在等。 */
  inferred: () => Frame | undefined;
  /** self 此刻欠着、尚未交代的那几笔 —— `for` 只能挑其中之一。 */
  owed: () => readonly Owed[];
  /** `[f, ...f 那笔欠账自己落盘的栈]`。 */
  stackFor: (f: Frame) => Frame[];
  /** 把 f 交出去时子活的栈: f 本身已是一件被 transfer 来的活 → 它承接的那条 (中间层不经手), 否则同 stackFor。 */
  handover: (f: Frame) => Frame[];
  /** 本轮所服务的那一帧已被 self transfer 出去了 (它对那一帧不再有话语权)。 */
  yielded: () => boolean;
}

/** 已冻结的去向 (停放 / plan / dispatch 先算好的 / 续问沿用原件的)。没有 stack 的老盘行按 `[k]` 兜底 (祖先由 stackFor 现拼)。 */
export interface Origin { stack?: readonly Frame[]; mode?: ReturnMode; k?: Frame }

export type Resolved =
  | {
      ok: true;
      op: ReturnOp;
      mode: ReturnMode;
      /** 子活落盘的栈 (detach / none = [])。 */
      stack: Frame[];
      /** 这件活为之派的那一帧 (detach 也有: 方向闸看的是 self 在服务谁, 与回执挂不挂无关)。 */
      frame?: Frame;
      /** self 所服务那一帧的整条栈 —— 方向闸的 chain 从它读。 */
      served: Frame[];
    }
  | { ok: false; status: 400 | 409; reason: string };

const canonical = (s: string): string => s.replace(/[`\s]/g, "");
const owedList = (xs: readonly Owed[]): string =>
  xs.length ? xs.map((o) => `\`${o.id}\` (${o.label})`).join("; ") : "眼下你没有欠着任何一笔";

/** 一件活的回执去向: 选定帧 → 物化栈。`origin` = 续问 (`re`) 沿用的原件; 冻结的入口不经这里。 */
export const resolveReturn = (deps: ResolveDeps, body: { return?: unknown; for?: unknown; chain?: unknown; receipt?: unknown; answer?: unknown; kind?: unknown }, origin?: Origin): Resolved => {
  const r = returnOpOf(body);
  if (!r.ok) return { ok: false, status: 400, reason: r.reason };
  const want = typeof body.for === "string" ? canonical(body.for) : "";
  if (origin) {
    if (want) return { ok: false, status: 400, reason: "`re` 续问沿用原件的帧, 不能再带 `for`" };
    const frozen = frozenStack(deps, origin);
    // 续问上的 chain:false 照旧生效 (旧行为: 先看 chain 再沿用原件的 k)。
    const off = r.op === "detach" || r.op === "none";
    return { ok: true, op: r.op, mode: off ? "self" : origin.mode ?? "self", stack: off ? [] : frozen, ...(frozen[0] ? { frame: frozen[0] } : {}), served: frozen };
  }
  const owed = want ? deps.owed() : [];
  const hit = want ? owed.find((o) => o.id === want) : undefined;
  // 挂错帧会把别人的交代压住: 查不到就拒, 不像 `re` 那样静默降级成新活。
  if (want && !hit) return { ok: false, status: 400, reason: `for "${want}" 不是你此刻欠着、还没交代的一笔 —— 你欠着的: ${owedList(owed)}` };
  if (!hit && deps.yielded()) return { ok: false, status: 409, reason: "这一轮服务的那一帧你已 transfer 出去了: 它的交代归接手方, 不再由你派活或对人说话 —— 静默收口; 真有与它无关的事, 用 `for` 挂到你欠着的另一笔" };
  const frame = hit?.frame ?? deps.inferred();
  const served = frame ? deps.stackFor(frame) : [];
  const stack = r.op === "transfer" && frame ? deps.handover(frame) : r.op === "self" ? served : [];
  return { ok: true, op: r.op, mode: r.op === "transfer" ? "transfer" : "self", stack, ...(frame ? { frame } : {}), served };
};

/** 冻结入口的栈: 有 stack 就用; 老盘只有 k → `[k, ...现拼的祖先]`。 */
export const frozenStack = (deps: Pick<ResolveDeps, "stackFor">, o: Origin): Frame[] =>
  o.stack ? [...o.stack] : o.k ? deps.stackFor(o.k) : [];

/** 冻结入口 (停放放行 / plan / dispatch 先算好的) 的去向: 原样沿用, 不再读调用方此刻的轮次。 */
export const frozenReturn = (deps: Pick<ResolveDeps, "stackFor">, o: Origin): Extract<Resolved, { ok: true }> => {
  const stack = frozenStack(deps, o);
  const mode = o.mode ?? "self";
  return { ok: true, op: mode, mode, stack, ...(stack[0] ? { frame: stack[0] } : {}), served: stack };
};

/** 落盘的那一组字段: `k` 保留为 `stack[0]` 的冗余, 旧读者照读。 */
export const framing = (stack: readonly Frame[] | undefined, mode: ReturnMode | undefined): { stack?: Frame[]; mode?: ReturnMode; k?: Frame } =>
  stack ? { stack: [...stack], mode: mode ?? "self", ...(stack[0] ? { k: stack[0] } : {}) } : {};
