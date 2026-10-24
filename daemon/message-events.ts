import { NO_DEADLINE } from "../shared/turn-state.js";
import type { ClearAttempt } from "./handoff.js";
import { createHash } from "node:crypto";
import { loadJsonMap } from "../shared/json-map-store.js";
import type { Asker, TurnFrom } from "../shared/detail-store.js";
import type { MirrorDispatchArgs } from "./mirror-bridge.js";
import type { Tell, HeldSeen } from "./dispatch.js";
import type { EventId, Receiver, ReportSource, Report, Route } from "./router.js";
import type { TemplateRef } from "../shared/task-template.js";

export interface ReceiptFact {
  event: EventId;
  batch?: string;
  version: string;
  status: string;
  receiver: Receiver;
  body: string;
  source?: ReportSource;
  speaker: string;
  envelope: string;
}

export interface MessageInput {
  id: string;
  /** Requirements represented in this carrier, including quoted recovery context. */
  inputIds?: string[];
  identity?: string;
  originalAt?: number;
  target: string;
  speaker: string;
  channel: string;
  asker?: Asker;
  /** 这一轮服务路由表上的哪一笔 (§9.4)。人话 = 为它开的根 event; 派活 / 续问 = 新开的子行
   *  event (transfer 就是被 move 的那个); 回执 = `receiver.event`; 缺省 = 不服务任何一笔
   *  (人在 CLI 里直接敲的轮) —— 那一轮派活等同 detach。 */
  serves?: EventId;
  /** Private RESULT correction keeps its original chat task context without serving or opening a route. */
  feedbackRoute?: { event: EventId; receiver: string };
  priority: "normal" | "now" | "urgent";
  deadline: number;
  payload: {
    text: string;
    /** Work plan is reminder metadata; it never changes receiver routing. */
    planId?: string;
    planReminder?: { planId: string; revision: number; token: string };
    receipts?: ReceiptFact[];
    human?: MirrorDispatchArgs;
    /** daemon 内部交接输入, 没有路由任务或外部发话方。 */
    handoff?: { pane: string; sessionId: string; clear?: ClearAttempt };
    peer?: {
      from: TurnFrom;
      envelope: string;
      tell?: Tell;
      after?: string[];
      afterSeen?: Readonly<Record<string, HeldSeen>>;
      kind: "task" | "ask" | "fyi";
      /** 上游 `re` 一份已交出去的件, 按 delegate 转给了叶子: 不是发话方自己的一件新活 (不进它的挂起账)。 */
      relayed?: boolean;
      /** `return:"transfer"`: 这一笔的 owner 已经改成了收件方, 不是发话方自己在等的一件。 */
      transferred?: boolean;
      /** 模板派活 (taskFile) 的回溯指针: rolepage/审计显示「来自模板 x@sha」, 不参与任何判定。 */
      templateRef?: TemplateRef;
    };
  };
}
export interface MessageEvent extends MessageInput {
  fingerprint: string;
  at: number;
  execution: "queued" | "dispatching" | "awaiting-result" | "complete" | "canceled" | "uncertain";
  exposure: "none" | "possible" | "submitted" | "consumed";
  consumedAt?: number;
  attempts: number;
  retryAt?: number;
  /** Durable receipt intent; only an explicit release resumes proven unexposed input. */
  deliveryHold?: "transport-exhausted" | "owner-stop";
  /** Tool-return witness, distinct from CLI exposure/consumption. */
  receiptClaim?: { at: number; via: "wait_peer"; event: string; facts: string[] };
  reason?: string;
  canceled?: boolean;
  transcript?: string;
  sessionId?: string;
  supersededBy?: string;
  turnClosedAt?: number;
  releasedAt?: number;
  releaseReason?: string;
  releaseSource?: "manual" | "deadline" | "pane-missing";
  probeAttempts?: number;
  turn?: string;
  finalized?: boolean;
  /** 自交接切断的旧轮终句: 跨 reload 永久排除路由补判, 失败补偿由 handoff 显式执行。 */
  handoffCut?: boolean;
  /** 失败补偿显式释放的旧轮; 覆盖尚未落补偿完成标记的 handoff 行。 */
  handoffRestored?: boolean;
  interjected?: boolean;
  quiet?: true;
  result?: { body: string; revision: string; at: number };
  failure?: { body: string; at: number };
  /** Explicit RESULT sections are durably tied to their selected route before answer ops. */
  resultRoutes?: Record<string, { receiver: string; event: EventId | null; inputs?: string[] }>;
  /** 进终态 (complete / canceled) 的时刻 —— 墓碑化的起点。当前 writer 显式落盘；缺失时不估算。 */
  endedAt?: number;
}
/** Transcript-observed final before the router boundary adds durable report provenance. */
export interface MessageFinal { text: string; error?: boolean }
/** 终态行过了 TOMB_AFTER_MS 只剩判重要用的那几样: accept 认 id + fingerprint 判「同一条消息」,
 *  WS 重放 / 收件箱重入 (`rcpt:<event>:<rev>`) 撞上它就是已投过、不再注入; 丢了它就会再投一次。
 *  墓碑再过 TOMB_TTL_MS (自 endedAt 起) 才删 —— 重放窗口远小于它。 */
export type EventAuthority = Pick<MessageEvent, "id" | "target" | "serves" | "feedbackRoute" | "at" | "execution" | "canceled" | "interjected" | "handoffCut" | "handoffRestored" | "receiptClaim"> & { unexposedHuman?: true };
export interface Tombstone { id: string; fingerprint: string; execution: "complete" | "canceled"; endedAt: number; tomb: true; authority?: EventAuthority }
type Row = MessageEvent | Tombstone;
const TOMB_AFTER_MS = 24 * 3600_000;
const TOMB_TTL_MS = 7 * 24 * 3600_000;
const isTomb = (x: Row): x is Tombstone => (x as Tombstone).tomb === true;
const terminal = (x: MessageEvent["execution"]): x is Tombstone["execution"] => x === "complete" || x === "canceled";
/** complete 要等 finalized (路由判定补完) 才算了结; canceled 本身就是了结。 */
const settled = (e: MessageEvent): boolean => e.execution === "canceled" || (e.execution === "complete" && !!e.finalized);
const endedAt = (e: MessageEvent): number | undefined =>
  typeof e.endedAt === "number" && Number.isFinite(e.endedAt) ? e.endedAt : undefined;
const authorityOf = (e: MessageEvent): EventAuthority => ({ id: e.id, target: e.target, serves: e.serves,
  feedbackRoute: e.feedbackRoute,
  at: e.at, execution: e.execution, canceled: e.canceled || e.execution === "canceled", interjected: e.interjected,
  handoffCut: e.handoffCut, handoffRestored: e.handoffRestored, receiptClaim: e.receiptClaim,
  ...(e.payload.human && e.exposure === "none" ? { unexposedHuman: true as const } : {}) });
const entomb = (e: MessageEvent & { execution: Tombstone["execution"] }, at: number): Tombstone =>
  ({ id: e.id, fingerprint: e.fingerprint, execution: e.execution, endedAt: at, tomb: true, authority: authorityOf(e) });
/** 每次落盘前跑: 了结满一天的行裁成墓碑, 墓碑满七天删掉。 */
export const gcEvents = (now: number, retain: (e: MessageEvent) => boolean = () => false) => (rows: Record<string, Row>): Record<string, Row> =>
  Object.fromEntries(Object.entries(rows).flatMap(([id, x]): Array<[string, Row]> => {
    if (isTomb(x)) return now - x.endedAt >= TOMB_TTL_MS ? [] : [[id, x]];
    const at = endedAt(x);
    if (retain(x) || !settled(x) || !terminal(x.execution) || at === undefined || now - at < TOMB_AFTER_MS) return [[id, x]];
    return [[id, entomb({ ...x, execution: x.execution }, at)]];
  }));
export interface DeliveryInput {
  transfer?: { id: string; standalone: boolean };
  coverage?: { context: string; facts: string[] };
  purpose?: "progress" | "report" | "cancellation" | "task";
  reportKind?: Report["kind"];
  id: string;
  eventId?: string;
  target: string;
  turn: string;
  channel: string;
  revision: string;
  body: string;
  chunks: string[];
  stream?: { frame: MirrorDispatchArgs["frame"]; id: string; expires: number };
}
export interface FinalDelivery extends DeliveryInput {
  at: number;
  parts: Array<{ state: "pending" | "sending" | "waiting-ack" | "delivered" | "uncertain" | "failed"; attempts: number; reason?: string; ack?: string; retryAt?: number }>;
}
export interface EventTransport { ok: boolean; uncertain?: boolean; retryable?: boolean; reason?: string;
  /** 收方已不存在 (没有绑定, 按 store 恢复也失败): 不是「稍后再试」, 而是这条投不到它了。 */
  gone?: boolean }
export interface EventEvidence { consumed: boolean; interjected?: boolean; body?: string; revision?: string; turn?: string; closedAt?: number;
  /** 这一轮以 CLI 报错收尾 (`isApiErrorMessage`): 没有可当定论的正文 —— `body` 是那段报错
   *  原文, 交给 `final` 落成中途态 error (见 §9.4), 不是 result。 */
  error?: boolean }
export interface MessageAdapters {
  resource: (target: string) => string;
  transcript: (target: string) => string | undefined;
  sessionId: (target: string) => string | undefined;
  ready: (event: MessageEvent) => Promise<boolean>;
  /** A queued event that is intentionally waiting must not pin later normal-priority work. */
  blocksQueue?: (event: MessageEvent) => boolean;
  task?: (event: MessageEvent) => string | undefined;
  retain?: (event: MessageEvent) => boolean;
  resultBindings?: (event: MessageEvent, body: string) => MessageEvent["resultRoutes"];
  valid: (event: MessageEvent) => boolean;
  accepted: (event: MessageEvent) => void;
  committed: (event: MessageEvent) => void;
  canceled: (event: MessageEvent) => void;
  inject: (event: MessageEvent, boundary: (phase?: "paste" | "submit", identity?: { sessionId?: string; transcript?: string }) => boolean) => Promise<EventTransport>;
  evidence: (event: MessageEvent) => Promise<EventEvidence>;
  recovered: (event: MessageEvent) => void;
  /** 注入报收方已不存在 (`EventTransport.gone`), 事件已收成 canceled: 由调用方决定它的结论往哪上浮。 */
  gone?: (event: MessageEvent) => void;
  /** 这一轮有定论了 (result 落定 / 重放恢复 / 读到 CLI 报错收尾): 路由表据此落 mark / answer
   *  (§9.4)。与 `recovered` 并排 —— 后者管投递恢复, 它管路由判定。可选: 没有它的消费者
   *  (测试夹具 / 老装配) 照常跑, 只是不做路由判定。 */
  final?: (event: MessageEvent, verdict: MessageFinal) => void;
  format?: (delivery: DeliveryInput) => DeliveryInput;
  send: (delivery: FinalDelivery, part: number) => Promise<{ ack?: string; uncertain?: string; queued?: boolean; failed?: string }>;
  deliveryEvidence?: (delivery: FinalDelivery, part: number) => { ack?: string; state: "queued" | "delivered" | "uncertain" | "failed"; reason?: string } | undefined;
  /** 回执 / 派活排着却被扣着超过 HOLD_LOG_MS (ready=false / injectable=false / 退避 / 探测位被占):
   *  报一次带原因的日志 —— 扣得没声是这条路最难查的样子。原因变了或扣满 HOLD_RELOG_MS 再报。 */
  held?: (event: MessageEvent, why: string, forMs: number) => void;
  error: (error: unknown) => void;
}
const HOLD_LOG_MS = 30_000;
const HOLD_RELOG_MS = 5 * 60_000;
const canonical = (x: unknown): unknown => Array.isArray(x) ? x.map(canonical)
  : x && typeof x === "object" ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)])) : x;
const digest = (x: unknown): string => createHash("sha256").update(JSON.stringify(canonical(x))).digest("hex");
export const messageId = (bot: string, chat: string, id: string): string => `h${digest([bot, chat, id]).slice(0, 16)}`;
export const finalId = (event: string, channel: string, revision: string): string => `f${digest([event, channel, revision])}`;
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
const backoff = (n: number): number => Date.now() + Math.min(60_000, 1000 * 2 ** Math.min(n, 6));
const why = (e: unknown): string => e instanceof Error ? e.message : typeof e === "object" ? JSON.stringify(e) : String(e);
// A negative transport ACK proves non-delivery; a timeout or disconnected socket does not.
export const rejectedAck = (e: unknown): boolean => !!e && typeof e === "object"
  && typeof (e as { errcode?: unknown }).errcode === "number" && (e as { errcode: number }).errcode !== 0
  && typeof (e as { errmsg?: unknown }).errmsg === "string" && !!(e as { headers?: unknown }).headers;

export const receiptFacts = (e: MessageEvent): ReceiptFact[] => e.payload.receipts ?? [];
/** Receipt QUIET is a whole-message control word, never a suffix of a real answer. */
export const receiptQuiet = (e: MessageEvent, body: string): boolean =>
  !!e.payload.peer?.from.receipt && !e.payload.human && !e.interjected && body.trim() === "QUIET";
export const reportSource = (e: MessageEvent): ReportSource => ({ input: e.id,
  ...(e.turn ? { turn: e.turn } : {}),
  ...(receiptFacts(e).length ? { facts: receiptFacts(e).map((f) => JSON.stringify([f.event, f.version, f.receiver])) } : {}) });
export const taskInputCoverage = (rows: readonly MessageEvent[], task: string, source: MessageEvent,
  taskOf: (event: MessageEvent) => string | undefined = (event) => event.serves): { inputs: string[]; complete: boolean } => {
  const cutoff = source.turnClosedAt ?? source.result?.at ?? Date.now();
  const relevant = rows.filter((e) => e.target === source.target && taskOf(e) === task && !e.canceled);
  const inputs = [...new Set(relevant.filter((e) => e.id === source.id || e.exposure === "consumed"
    && (e.consumedAt ?? e.result?.at ?? e.turnClosedAt ?? Infinity) <= cutoff
    && !(e.execution === "complete" && !e.result))
    .flatMap((e) => e.inputIds ?? [e.id]))].sort();
  return { inputs, complete: coversTaskInputIds(relevant, inputs) };
};
export const coversTaskInputIds = (rows: readonly MessageEvent[], inputs: readonly string[]): boolean => {
  const covered = new Set(inputs);
  return rows.filter((e) => !!e.payload.peer?.tell && !e.canceled).every((e) => covered.has(e.id));
};
export const correctionTaskEvent = (binding: { event: string | null } | undefined, serves?: string): string | undefined =>
  binding ? binding.event ?? undefined : serves;
export const canSettleFinal = (event: MessageEvent): boolean => !event.id.startsWith("feedback:")
  || !!event.serves || !!event.feedbackRoute;
export const eventFinalPublication = (event: MessageEvent, owns: (event: EventAuthority) => boolean,
  allowed: (event: EventAuthority) => boolean): { channel: string; target: string; turn: string } | undefined => {
  if (!event.result || event.quiet || event.canceled || event.interjected || !owns(event) || !allowed(event)) return undefined;
  const channel = event.channel || event.feedbackRoute?.receiver;
  return channel ? { channel, target: event.target, turn: event.turn || event.id } : undefined;
};
export const publishEventFinal = (event: MessageEvent, owns: (event: EventAuthority) => boolean,
  allowed: (event: EventAuthority) => boolean,
  publish: (target: string, turn: string, channel: string, event: MessageEvent) => void): boolean => {
  const destination = eventFinalPublication(event, owns, allowed);
  if (!destination) return false;
  publish(destination.target, destination.turn, destination.channel, event);
  return true;
};
export const eventDeliveryAllowed = (source: EventAuthority | undefined, target: string, eventId: string | undefined,
  purpose: DeliveryInput["purpose"], ownerAllowed: (event: EventAuthority) => boolean,
  row: Route | undefined): boolean => {
  if (!source) return !eventId || purpose === "task";
  const cancellation = purpose === "cancellation" && source.canceled && source.unexposedHuman;
  if (source.feedbackRoute && (!row || row.owner !== source.target || row.receiver.kind !== "chat")) return false;
  return source.target === target && !source.interjected && ownerAllowed(source)
    && (cancellation || !source.canceled && row?.outcome?.status !== "canceled" && row?.status !== "held")
    && (purpose !== "progress" || !!row && ["open", "need", "error"].includes(row.status));
};
export const runEventFinalRecovery = (event: MessageEvent, owns: (event: MessageEvent) => boolean,
  recover: (event: MessageEvent) => void): boolean => {
  if (event.handoffCut || !event.result || event.quiet || event.interjected || event.canceled || !owns(event)) return false;
  recover(event);
  return true;
};
export const peerEventPrerequisitesReady = (event: MessageEvent, routeStatus: Route["status"] | undefined,
  routePrerequisitesReady: boolean, inputPrerequisitesReady: boolean): boolean =>
  !(event.serves && routeStatus === "held" && !routePrerequisitesReady) && inputPrerequisitesReady;
export const resultCorrectionInputs = (source: MessageEvent, section: string, index: number, reason: string,
  candidate: Route | undefined, displayName: (key: string) => string,
  renderEnvelope: (name: string, fyi: boolean) => string): MessageInput[] => {
  const row = candidate;
  const active = row && ["held", "open", "need", "error"].includes(row.status);
  const owned = active && row.status !== "held" && row.owner === source.target;
  const task = !!owned && row.receiver.kind === "wizard";
  const fyiBody = (): string => row && row.owner !== source.target
    ? `执行者 ${displayName(source.target)} 的 RESULT 未被任务路由 ${row.event} 接受（${reason}）。来源事件 ${source.id}，当前 owner ${displayName(row.owner)}。这是私密知会，无需回复，也不要新建任务。`
    : row && row.receiver.kind === "chat" && owned
      ? `本轮 RESULT 未结清人类任务 ${row.event}（${reason}），当前仍 pending。来源事件 ${source.id}。这是绑定原任务的私密纠正；补充读完后，完成时对原任务显式提交 RESULT；普通确认不会结清，也不会新建任务或公开此结果。`
      : `RESULT 未进入有效任务：${reason}。这是私密纠正知会，无需回复，也不要新建任务。`;
  const chatFeedbackRoute = owned && row?.receiver.kind === "chat"
    ? { event: row.event, receiver: row.receiver.channel } : undefined;
  const make = (target: string, recipient: string, serves?: string, asker?: Asker, suffix = "", text?: string,
    feedbackRoute?: { event: EventId; receiver: string }): MessageInput => ({
    id: `feedback:${source.id}:${index}:${section}${suffix}`,
    identity: JSON.stringify(["result-correction", source.id, index, section, target]), target, speaker: recipient, channel: "",
    ...(serves ? { serves, ...(asker ? { asker } : {}) } : {}), ...(feedbackRoute ? { feedbackRoute } : {}),
    priority: "normal", deadline: NO_DEADLINE,
    payload: { text: text ?? (serves
      ? `你的 RESULT 暂未交付：${reason}。请只对匹配收件人提交 \`@.name RESULT: <结论>\`；需要反问时使用 tell_peer({kind:"ask"})。`
      : fyiBody()),
      peer: { from: { kind: "peer", from: recipient, ...(serves ? { event: serves } : {}) },
        envelope: renderEnvelope(displayName(recipient), !serves), kind: serves ? "task" : "fyi" } },
  });
  const executor = make(source.target, source.speaker, task ? row!.event : undefined, task ? row!.asker : undefined,
    "", undefined, chatFeedbackRoute);
  return row && row.owner !== source.target
    ? [make(source.target, source.speaker, undefined, undefined, "", fyiBody()),
      make(row.owner, source.target, undefined, undefined, `:owner:${row.owner}`, fyiBody())]
    : [executor];
};
export interface AddressedResultSection { name: string; body: string }
export const requiresExplicitResultAddress = (source: MessageEvent, row: Route | undefined, isResult: boolean): boolean =>
  isResult && row?.receiver.kind === "wizard";
export const settleUnaddressedResult = (source: MessageEvent, row: Route | undefined, isResult: boolean,
  reject: (source: MessageEvent, row: Route, reason: string) => void): boolean => {
  if (!requiresExplicitResultAddress(source, row, isResult) || !row || row.receiver.kind !== "wizard") return false;
  const reason = row.owner !== source.target ? "任务已移交，旧执行者不能提交结果"
    : row.status === "held" ? "任务前置尚未就绪"
      : row.outcome?.status === "canceled" ? "任务已取消" : "回执必须显式写明收件人";
  reject(source, row, reason);
  return true;
};
export const servedChatResultPublicAllowed = (source: MessageEvent, row: Route | undefined, isResult: boolean,
  covers: (task: string, source: MessageEvent, inputs: readonly string[]) => boolean): boolean => {
  if (!isResult || row?.receiver.kind !== "chat") return true;
  const binding = source.resultRoutes?.served;
  return !!binding?.event && !!binding.inputs && covers(row.event, source, binding.inputs);
};
export const servedChatResultFinalAllowed = (source: MessageEvent, sourceRow: Route | undefined,
  boundRow: Route | undefined, isResult: boolean,
  covers: (task: string, source: MessageEvent, inputs: readonly string[]) => boolean): boolean => {
  const binding = source.resultRoutes?.served;
  if (isResult && binding?.event && (!boundRow || !sourceRow || boundRow.event !== sourceRow.event)) return false;
  return servedChatResultPublicAllowed(source, boundRow ?? sourceRow, isResult, covers);
};
export const rejectUncoveredServedChatResult = (source: MessageEvent, row: Route | undefined, isResult: boolean,
  inputs: readonly string[], covers: (task: string, source: MessageEvent, inputs: readonly string[]) => boolean,
  reject: (source: MessageEvent, row: Route) => void): boolean => {
  if (!isResult || row?.receiver.kind !== "chat" || covers(row.event, source, inputs)) return false;
  reject(source, row);
  return true;
};
export const settleServedChatResult = (source: MessageEvent, row: Route | undefined, isResult: boolean,
  inputs: readonly string[], covers: (task: string, source: MessageEvent, inputs: readonly string[]) => boolean,
  reject: (source: MessageEvent, row: Route, reason: string) => void,
  settle: (source: MessageEvent, row: Route) => void): boolean => {
  if (!isResult || row?.receiver.kind !== "chat") return false;
  if (row.owner !== source.target || row.status === "held" || row.outcome?.status === "canceled") {
    reject(source, row, row.owner !== source.target ? "任务已移交" : row.status === "held" ? "前置尚未就绪" : "任务已取消");
    return true;
  }
  if (!covers(row.event, source, inputs)) {
    reject(source, row, "同一任务还有本次结果未覆盖的补充；读完补充后重新提交结果");
    return true;
  }
  settle(source, row);
  return true;
};
export const settleAddressedResults = (source: MessageEvent, sections: readonly AddressedResultSection[], io: {
  binding: (source: MessageEvent, key: string) => { receiver: string; event: EventId | null; inputs?: string[] } | undefined;
  resolve: (name: string) => string | undefined;
  select: (source: MessageEvent, receiver: string, binding: { receiver: string; event: EventId | null; inputs?: string[] } | undefined) => Route | undefined;
  consumed: (task: string, source: MessageEvent) => string[];
  bind: (source: MessageEvent, key: string, receiver: string, event: EventId | null, inputs: string[]) => void;
  covers: (task: string, source: MessageEvent, inputs: readonly string[]) => boolean;
  reject: (source: MessageEvent, section: AddressedResultSection, index: number, reason: string, row?: Route, key?: string) => void;
  settle: (source: MessageEvent, section: AddressedResultSection, index: number, row: Route) => void;
}): void => {
  sections.forEach((section, index) => {
    const key = `${index}:${section.name}`;
    const binding = io.binding(source, key);
    const receiver = binding?.receiver ?? io.resolve(section.name);
    if (!receiver) {
      if (!binding) io.bind(source, key, section.name, null, []);
      io.reject(source, section, index, `收件人 ${section.name} 不存在`, undefined, key);
      return;
    }
    const selected = io.select(source, receiver, binding);
    const row = selected && (!source.result || selected.at <= source.result.at) ? selected : undefined;
    const inputs = binding?.inputs ?? (row ? io.consumed(row.event, source) : []);
    if (!binding?.inputs) io.bind(source, key, receiver, row?.event ?? null, inputs);
    if (!row) { io.reject(source, section, index, `${section.name} 不是这笔任务的收件人，或你当前没有欠它的未完成任务`, undefined, key); return; }
    if (row.owner !== source.target) {
      io.reject(source, section, index, `任务路由 ${row.event} 已移交，当前不能由你结算`, row, key);
      return;
    }
    if (row.outcome?.status === "canceled" || row.status === "held"
        || !["open", "need", "error", "answered", "handed"].includes(row.status)) {
      io.reject(source, section, index, row.status === "held" ? `任务路由 ${row.event} 的前置尚未就绪` : `任务路由 ${row.event} 已取消或不可结算`, row, key);
      return;
    }
    if (!section.body || !io.covers(row.event, source, inputs)) {
      io.reject(source, section, index, !section.body ? "RESULT 正文为空" : "同一任务还有本次结果未覆盖的补充；读完补充后重新提交结果", row, key);
      return;
    }
    io.settle(source, section, index, row);
  });
};
export const receiptCoverage = (e: MessageEvent, channel = e.channel, question = false, questionText?: string): DeliveryInput["coverage"] => {
  const refs = (facts: ReceiptFact[]): string[] => [...new Set(facts.map((f) => JSON.stringify([f.event, f.version, f.receiver])))].sort();
  const receipts = receiptFacts(e);
  // Publishing one question does not certify that all incoming NEEDs were handled.
  // Claim the generated question version, leaving every input risk fact unclaimed.
  const risks = receipts.some((f) => f.status !== "done");
  const facts = question && receipts.length ? [JSON.stringify(["question", e.serves ?? "", refs(receipts), digest((questionText ?? e.result?.body ?? "").trim())])]
    : [...refs(receipts.filter((f) => f.status === "done")),
      ...(risks ? [JSON.stringify(["summary", e.serves ?? "", refs(receipts)])] : [])];
  return facts.length ? { context: JSON.stringify([e.target, e.serves ?? "", channel]), facts } : undefined;
};

const receiptFactOk = (f: ReceiptFact): boolean => !!f && typeof f.event === "string" && !!f.event
  && (f.batch === undefined || typeof f.batch === "string" && !!f.batch)
  && typeof f.version === "string" && !!f.version && typeof f.body === "string" && typeof f.envelope === "string"
  && typeof f.speaker === "string" && ["done", "need", "error", "timeout", "silent", "dead", "canceled"].includes(f.status)
  && !!f.receiver && (f.receiver.kind === "wizard" ? typeof f.receiver.to === "string"
    && (f.receiver.event === undefined || typeof f.receiver.event === "string")
    : f.receiver.kind === "chat" && typeof f.receiver.channel === "string" && typeof f.receiver.message === "string")
  && (f.source === undefined || !!f.source && typeof f.source.input === "string");
const coverageOk = (c: NonNullable<DeliveryInput["coverage"]>): boolean => !!c && typeof c.context === "string"
  && Array.isArray(c.facts) && c.facts.every((f) => typeof f === "string");

export const createMessageEvents = (file: string, io: MessageAdapters) => {
  const db = loadJsonMap<Row>(file, (rows) => gcEvents(Date.now(), io.retain)(rows), { strict: true });
  const outbox = loadJsonMap<FinalDelivery>(`${file}.finals`, undefined, { strict: true });
  Object.entries(db.all()).forEach(([id, e]) => {
    if (e && isTomb(e)) {
      if (e.id !== id || typeof e.fingerprint !== "string" || !terminal(e.execution) || !Number.isFinite(e.endedAt)) throw new Error(`invalid message event tombstone ${id}`);
      const a = e.authority;
      if (a !== undefined && (!a || a.id !== id || !a.target || typeof a.target !== "string" || !Number.isFinite(a.at)
          || a.execution !== e.execution || (e.execution === "canceled" && a.canceled !== true) || (a.serves !== undefined && typeof a.serves !== "string")
          || (a.feedbackRoute !== undefined && (!a.feedbackRoute || typeof a.feedbackRoute.event !== "string" || !a.feedbackRoute.event || typeof a.feedbackRoute.receiver !== "string"))
          || [a.canceled, a.interjected, a.handoffCut, a.handoffRestored].some((v) => v !== undefined && typeof v !== "boolean")
          || (a.unexposedHuman !== undefined && a.unexposedHuman !== true))) throw new Error(`invalid event authority ${id}`);
      return;
    }
    if (!e || e.id !== id || typeof e.fingerprint !== "string" || !e.target || typeof e.speaker !== "string" || typeof e.channel !== "string" || (e.serves !== undefined && typeof e.serves !== "string") || (e.feedbackRoute !== undefined && (!e.feedbackRoute || typeof e.feedbackRoute.event !== "string" || !e.feedbackRoute.event || typeof e.feedbackRoute.receiver !== "string")) || !e.payload || typeof e.payload.text !== "string" || ([e.payload.human, e.payload.peer, e.payload.handoff].filter(Boolean).length !== 1) || !Number.isFinite(e.at) || !Number.isFinite(e.attempts) || !Number.isFinite(e.deadline) || !["queued", "dispatching", "awaiting-result", "complete", "canceled", "uncertain"].includes(e.execution)) throw new Error(`invalid message event ${id}`);
    if (e.payload.receipts !== undefined && (!e.payload.peer?.from.receipt || !Array.isArray(e.payload.receipts)
        || !e.payload.receipts.every(receiptFactOk))) throw new Error(`invalid receipt facts ${id}`);
    if (e.payload.peer?.from.receipt && !e.finalized && (!Array.isArray(e.payload.receipts) || !e.payload.receipts.length
        || e.payload.receipts.some((f) => !receiptFactOk(f)))) throw new Error(`unsupported legacy receipt event ${id}; refusing to infer durable facts`);
    if (!e.finalized && e.resultRoutes !== undefined && (!e.resultRoutes || typeof e.resultRoutes !== "object"
        || Object.keys(e.resultRoutes).some((key) => key.startsWith("legacy:"))
        || !Object.values(e.resultRoutes).every((b) => !!b && typeof b.receiver === "string" && !!b.receiver
          && (b.event === null || typeof b.event === "string" && !!b.event)
          && Array.isArray(b.inputs) && b.inputs.every((id) => typeof id === "string" && !!id)))) throw new Error(`invalid result bindings ${id}`);
    if (e.inputIds !== undefined && (!Array.isArray(e.inputIds) || !e.inputIds.every((id) => typeof id === "string" && !!id))) throw new Error(`invalid input coverage ${id}`);
    if (e.payload.handoff && (typeof e.payload.handoff.pane !== "string" || !e.payload.handoff.pane || typeof e.payload.handoff.sessionId !== "string" || !e.payload.handoff.sessionId || !e.id.startsWith("handoff:"))) throw new Error(`invalid handoff event ${id}`);
    const clear = e.payload.handoff?.clear;
    if (e.payload.handoff && e.id.endsWith(":carry") && (!clear || clear.pane !== e.payload.handoff.pane || clear.nextSid !== e.payload.handoff.sessionId || !Number.isSafeInteger(clear.pid) || clear.pid <= 0 || !Number.isSafeInteger(clear.panePid) || !clear.panePid)) throw new Error(`invalid handoff clear evidence ${id}`);
  });
  Object.values(db.all()).forEach((e) => {
    if (isTomb(e)) return;
    if (!e.finalized && (e.serves || e.id.startsWith("route:") || e.id.startsWith("rcpt:")) && e.deadline !== NO_DEADLINE)
      throw new Error(`unsupported expiring route event ${e.id}; refusing to migrate legacy event state`);
  });
  Object.entries(outbox.all()).forEach(([id, d]) => {
    if (d?.coverage !== undefined && !coverageOk(d.coverage)) throw new Error(`invalid final coverage ${id}`);
    if (!d || d.id !== id || !Array.isArray(d.parts) || d.parts.length !== d.chunks?.length || !d.chunks.every((c) => typeof c === "string") || !d.parts.every((p) => ["pending", "sending", "waiting-ack", "delivered", "uncertain", "failed"].includes(p.state)) || !d.channel) throw new Error(`invalid final delivery ${id}`);
    if (!d.purpose && d.eventId === `quiet:${d.target}:${d.turn}` && d.parts.some((part) => part.state !== "delivered"))
      throw new Error(`active quiet delivery ${id} has no durable purpose`);
  });
  /** 调度只看活行; 墓碑只给 accept 判重 (与 `known`)。 */
  const live = (id: string): MessageEvent | undefined => { const x = db.get(id); return x && !isTomb(x) ? x : undefined; };
  const sourceOf = (id: string): EventAuthority | undefined => {
    const row = db.get(id);
    return row ? isTomb(row) ? row.authority : authorityOf(row) : undefined;
  };
  const liveRows = (): MessageEvent[] => Object.values(db.all()).filter((x): x is MessageEvent => !isTomb(x));
  let stopped = true;
  let accepting = true;
  let draining = false;
  let pumping = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  const active = new Set<string>();
  const targets = new Set<string>();
  const delivering = new Set<string>();
  const probing = new Map<string, symbol>();
  let deliveryCursor = 0;
  let probeCursor = 0;
  let probeCount = 0;
  const probeTargets = new Map<string, symbol>();
  /** 排队的回执 / 派活从哪一刻起被扣、此刻为什么、上次报到哪 (只在内存: 日志与 status 用)。 */
  const holding = new Map<string, { since: number; why: string; told?: { why: string; at: number } }>();
  const hold = (e: MessageEvent, why: string): void => {
    const now = Date.now();
    const h = { since: now, ...holding.get(e.id), why };
    const due = now - h.since >= HOLD_LOG_MS && (!h.told || h.told.why !== why || now - h.told.at >= HOLD_RELOG_MS);
    holding.set(e.id, due ? { ...h, told: { why, at: now } } : h);
    if (due) io.held?.(e, why, now - h.since);
  };
  /** 一次同步扫描 (pump 的一轮 / status 的一次) 内, 三个适配器按 target 只问一次: 它们读注册表、
   *  读绑定, 每行现问就是 O(行数) 次 I/O, 而 pinOf / queue 又对每行扫全表 —— 那就是 O(R²)。
   *  同一次同步调用里 pane / 会话本来不会变, 快照反而让一次扫描内各行口径一致。扫描外 (异步
   *  回调、注入边界) 不在 scope 里, 照旧现问。 */
  let pass: Map<string, string | undefined> | undefined;
  const scan = <T>(run: () => T): T => {
    if (pass) return run();
    pass = new Map();
    try { return run(); } finally { pass = undefined; }
  };
  const ask = (kind: "resource" | "transcript" | "sessionId", target: string): string | undefined => {
    const key = `${kind}\0${target}`;
    if (pass?.has(key)) return pass.get(key);
    const v = io[kind](target);
    pass?.set(key, v);
    return v;
  };
  const resourceAt = (target: string): string => ask("resource", target)!;
  // An exposed event belongs to the session that received it, not a replacement
  // pane now bound to the same wizard. Keep its uncertain history for reconciliation.
  const resourceOf = (e: MessageEvent): string => {
    if (e.exposure === "none") return resourceAt(e.target);
    if (e.sessionId) return e.sessionId === ask("sessionId", e.target) ? resourceAt(e.target) : `session:${e.sessionId}`;
    if (e.transcript) return e.transcript === ask("transcript", e.target) ? resourceAt(e.target) : `transcript:${e.transcript}`;
    return resourceAt(e.target);
  };
  const bounded = <T>(id: string, read: () => Promise<T>): Promise<T> => {
    const e = live(id);
    const target = e ? resourceOf(e) : id;
    if (probing.has(id) || probeTargets.has(target) || probeCount >= 16) return Promise.reject(new Error("probe already running or probe capacity occupied"));
    const token = Symbol(id);
    probing.set(id, token);
    probeTargets.set(target, token);
    probeCount++;
    const release = (): void => {
      if (probing.get(id) === token) probing.delete(id);
      if (probeTargets.get(target) === token) probeTargets.delete(target);
    };
    let timer: ReturnType<typeof setTimeout>;
    const work = Promise.resolve().then(read);
    void work.finally(release).catch(() => undefined);
    return Promise.race([work, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("pane probe exceeded 5s; no transport attempted")), 5000);
    })]).finally(() => { clearTimeout(timer); probeCount--; release(); });
  };
  const patch = (id: string, p: Partial<MessageEvent>): MessageEvent => {
    const prev = live(id)!;
    const next = { ...prev, ...p };
    return db.set(id, terminal(next.execution) && !terminal(prev.execution) ? { ...next, endedAt: Date.now() } : next) as MessageEvent;
  };
  const part = (id: string, n: number, p: Partial<FinalDelivery["parts"][number]>): void => {
    const d = outbox.get(id)!;
    outbox.set(id, { ...d, parts: d.parts.map((x, i) => i === n ? { ...x, ...p } : x) });
  };
  const claimsOf = (coverage: DeliveryInput["coverage"]): FinalDelivery[] => {
    if (!coverage) return [];
    const rows = Object.values(outbox.all()).filter((d) => d.coverage?.context === coverage.context
      && d.coverage.facts.some((f) => coverage.facts.includes(f)));
    const whole = rows.filter((d) => coverage.facts.every((f) => d.coverage!.facts.includes(f)));
    const best = whole.find((d) => d.parts.every((p) => p.state !== "failed")) ?? whole[0];
    return best ? [best] : rows;
  };
  const holdReceipt = (e: MessageEvent, cause: NonNullable<MessageEvent["deliveryHold"]>, reason: string): void => {
    patch(e.id, { execution: e.exposure === "none" ? "queued" : "uncertain", deliveryHold: cause,
      reason: `${reason}; receipt retained; POST /message-events/release with id and reason after reconciliation`, retryAt: undefined });
  };
  const cancel = (select: (e: MessageEvent) => boolean, reason = "canceled by owner"): number => {
    const rows = liveRows().filter((e) => !["complete", "canceled"].includes(e.execution) && select(e));
    rows.forEach((e) => {
      if (receiptFacts(e).length) { holdReceipt(e, "owner-stop", reason); return; }
      const next = patch(e.id, { canceled: true, reason, execution: e.exposure === "none" ? "canceled" : "uncertain" });
      io.canceled(next); // Cancellation after exposure never asserts the pane stopped.
    });
    return rows.length;
  };
  const claimReceipt = (id: string): { ok: boolean; reason?: string } => {
    const e = live(id);
    if (!e || e.execution !== "queued" || e.exposure !== "none" || e.canceled || e.receiptClaim)
      return { ok: false, reason: "receipt is not an unexposed unclaimed queued input" };
    const facts = receiptFacts(e);
    // wait_peer returns one route outcome, never all the siblings in a merged carrier.
    // Keep mixed carriers intact for explicit release and transcript delivery.
    if (!facts.length || facts.some((f) => f.event !== facts[0]!.event))
      return { ok: false, reason: "merged receipt contains sibling outcomes; reconcile/release the carrier for transcript delivery" };
    const event = facts[0]!.event;
    const rows = liveRows().filter((x) => x.target === e.target && x.execution === "queued" && x.exposure === "none"
      && receiptFacts(x).length && receiptFacts(x).every((f) => f.event === event));
    const at = Date.now();
    db.merge(Object.fromEntries(rows.map((x) => [x.id, { ...x, execution: "complete" as const, finalized: true,
      receiptClaim: { at, via: "wait_peer" as const, event,
        facts: receiptFacts(x).map((f) => JSON.stringify([f.event, f.version, f.receiver])) }, deliveryHold: undefined,
      reason: "receipt taken by wait_peer; CLI consumption not asserted", endedAt: at }])));
    return { ok: true };
  };
  const accept = (input: MessageInput, retire?: string): { ok: true; queued: boolean; eventId: string } => {
    if (!accepting) throw new Error("message scheduler is stopped");
    const clean = clone(input);
    // `serves` 是路由元数据, 不参与身份: 同一个 id 重放 (含 reload 后重入箱) 带着同一份
    // 内容就该是同一条消息, 哪怕 serves 的来历变了 —— 它不算内容的一部分。
    const { serves: _routing, ...identified } = clean;
    const fingerprint = digest(identified.identity ? [JSON.parse(identified.identity), identified.speaker, identified.channel] : identified);
    const prior = db.get(input.id);
    if (prior && prior.fingerprint !== fingerprint) throw new Error(`event identity conflict: ${input.id}`);
    const retired = retire ? live(retire) : undefined;
    if (retire && (!retired || retired.id === input.id || retired.exposure !== "none")) throw new Error("cannot retire an exposed or missing event");
    const stored = prior ?? { ...clean, fingerprint, at: Date.now(), execution: "queued" as const, exposure: "none" as const, attempts: 0 };
    // Replacement and retirement share one store write: recovery can never
    // expose both the original inbox and its replacement to their recipients.
    if (!prior || retired) db.merge({ [stored.id]: stored,
      ...(retired ? { [retired.id]: { ...retired, execution: "canceled" as const, endedAt: Date.now() } } : {}) });
    // 墓碑 = 早已投过并了结: 重放 / 重入箱到此为止, 不复活、不再注入。
    if (isTomb(stored)) return { ok: true, queued: false, eventId: stored.id };
    const e = stored;
    if (e.execution === "queued") {
      try { io.accepted(e); }
      catch (error) {
        patch(e.id, { execution: "queued", retryAt: backoff(e.attempts), reason: `acceptance projection failed before exposure: ${why(error)}` });
        io.error(error);
      }
    } // Idempotent adapters restore accounting/receipt intent after a torn cross-store write.
    void pump();
    return { ok: true, queued: e.execution === "queued", eventId: e.id };
  };
  const result = (id: string, body: string, revision: string, turn?: string): void => {
    const e = live(id);
    if (!e || e.canceled || e.execution === "canceled" || e.result?.revision === revision) return;
    const quiet = receiptQuiet(e, body);
    const resultRoutes = { ...io.resultBindings?.({ ...e, ...(turn ? { turn } : {}) }, body), ...e.resultRoutes };
    patch(id, { finalized: quiet, quiet: quiet ? true : undefined, result: { body, revision, at: Date.now() },
      resultRoutes, execution: "complete", exposure: "consumed", consumedAt: e.consumedAt ?? Date.now(), ...(turn ? { turn } : {}) });
    if (!quiet) io.final?.(live(id)!, { text: body });
  };
  const delivery = (input: DeliveryInput): string => {
    const source = input.eventId ? live(input.eventId) : undefined;
    const coverage = input.coverage ?? (input.purpose !== "progress" && source
      ? receiptCoverage(source, input.channel) ?? (!source.payload.peer?.from.receipt
        ? { context: JSON.stringify([source.target, source.serves ?? "", input.channel]), facts: [JSON.stringify([source.serves ?? "", source.id, input.reportKind ?? "done",
          input.reportKind === "need" || input.reportKind === "error" ? digest(input.body.trim()) : undefined])] } : undefined)
      : undefined);
    const covering = claimsOf(coverage);
    if (coverage && covering?.length) {
      const claimed = new Set(covering.flatMap((d) => d.coverage!.facts));
      if (coverage.facts.every((f) => claimed.has(f))) {
        // An explicit retry reuses the frozen delivery and only retries proven failures.
        // Delivered and uncertain parts retain their original claims and transport identity.
        const retries = covering.filter((d) => d.coverage!.facts.some((f) => coverage.facts.includes(f)) && d.parts.some((p) => p.state === "failed"));
        if (retries.length) outbox.merge(Object.fromEntries(retries.map((d) => [d.id, { ...d,
          parts: d.parts.map((p) => p.state === "failed" ? { ...p, state: "pending" as const, retryAt: undefined } : p) }])));
        void pump();
        return covering[0]!.id;
      }
    }
    const old = outbox.get(input.id);
    if (old) {
      if (old.body !== input.body || old.channel !== input.channel || old.revision !== input.revision) throw new Error(`final identity conflict: ${input.id}`);
      return old.id;
    }
    const covered = { ...input, ...(coverage ? { coverage } : {}) };
    const frozen = clone(io.format?.(covered) ?? covered);
    outbox.set(input.id, { ...frozen, at: Date.now(), parts: frozen.chunks.map(() => ({ state: "pending", attempts: 0 })) });
    void pump();
    return input.id;
  };
  const send = async (id: string): Promise<void> => {
    delivering.add(id);
    try {
      for (let n = 0; n < outbox.get(id)!.parts.length && !stopped; n++) {
        const d = outbox.get(id)!;
        const p = d.parts[n]!;
        const source = d.eventId ? sourceOf(d.eventId) : undefined;
        const cancellation = d.purpose === "cancellation" && source?.canceled && source.unexposedHuman;
        if ((d.eventId && !source && d.purpose !== "task") || (source && source.target !== d.target)
            || ((source?.canceled || source?.interjected || source?.handoffCut && !source.handoffRestored) && !cancellation)) {
          if (p.state === "pending") part(id, n, { state: "failed", reason: "source event canceled or cut before delivery" });
          break;
        }
        if (p.state === "delivered") continue;
        if (p.state !== "pending" || (p.retryAt ?? 0) > Date.now()) break;
        part(id, n, { state: "sending", attempts: p.attempts + 1 });
        try {
          const ack = await io.send(d, n);
          part(id, n, { state: ack.failed ? "failed" : ack.uncertain ? "uncertain" : ack.queued ? "waiting-ack" : "delivered", ack: ack.ack, reason: ack.failed ?? ack.uncertain });
          if (ack.uncertain || ack.queued || ack.failed) break;
        } catch (e) {
          part(id, n, { state: rejectedAck(e) ? "pending" : "uncertain", reason: why(e), retryAt: backoff(p.attempts + 1) });
          break;
        }
      }
    } finally { delivering.delete(id); }
  };
  const observe = async (e: MessageEvent): Promise<void> => {
    const evidence = await bounded(e.id, () => io.evidence(e));
    if (stopped) return;
    if (!evidence.consumed) return;
    const current = live(e.id)!;
    if (["complete", "canceled"].includes(current.execution)) return;
    if (current.exposure !== "consumed" || (evidence.closedAt && !current.turnClosedAt)) patch(e.id, {
      exposure: "consumed", interjected: evidence.interjected,
      consumedAt: current.consumedAt ?? Date.now(),
      execution: current.canceled || (evidence.closedAt && !evidence.body) ? "uncertain" : "awaiting-result",
      reason: current.canceled ? current.reason : evidence.closedAt && !evidence.body
        ? "input turn closed without a final assistant answer; delivery remains uncertain and will not be retried" : undefined,
      ...(evidence.closedAt ? { turnClosedAt: evidence.closedAt } : {}), turn: evidence.turn ?? current.turn,
    });
    if (!current.canceled) io.committed(live(e.id)!);
    if (evidence.body !== undefined && evidence.error) {
      patch(e.id, { execution: "uncertain", turnClosedAt: evidence.closedAt ?? Date.now(),
        failure: { body: evidence.body, at: Date.now() }, finalized: false });
      io.final?.(live(e.id)!, { text: evidence.body, error: true });
      patch(e.id, { finalized: true });
    } else if (evidence.body !== undefined && evidence.revision) {
      result(e.id, evidence.body, evidence.revision, evidence.turn);
      io.recovered(live(e.id)!);
    }
  };
  /** 收件箱里的回执按接收 wizard 的待收批次合并; 不要求旧 receiver.event 关系存在。 */
  const isRcpt = (e: MessageEvent): boolean => e.id.startsWith("rcpt:") && !!e.payload.peer?.from.receipt;
  const isTask = (e: MessageEvent): boolean => e.id.startsWith("route:") && !!e.payload.peer?.tell
    && !e.payload.peer.transferred && !!e.serves;
  /** 同一个 target 的待收回执并进当前批次 —— 扇出的结果是一轮, 不是一人一轮。被吸收的那些各自收口
   *  (`execution: complete`, 它们的 id 已终态, 重放不再注入); 结论由这一轮的终句统一交代。
   *  每项保留独立事实、状态与信封, 合并正文与被吸收行的终态在同一次落盘中提交。 */
  const absorb = (id: string): void => {
    const e = live(id);
    if (!e || (!isRcpt(e) && !isTask(e)) || !io.valid(e)) return;
    const mergeClass = isRcpt(e) ? isRcpt : isTask;
    const batch = isRcpt(e) ? receiptFacts(e)[0]?.batch : undefined;
    if (isRcpt(e) && (receiptFacts(e).some((f) => f.status !== "done") || !batch)) return;
    const absorbed = liveRows()
      .filter((x) => x.id !== e.id && mergeClass(x) && x.target === e.target
        && (isTask(e) ? (io.task?.(x) ?? x.serves) === (io.task?.(e) ?? e.serves) : true)
        && (!isRcpt(e) || receiptFacts(x).length > 0 && receiptFacts(x).every((f) => f.status === "done" && f.batch === batch))
        && x.channel === e.channel && x.execution === "queued" && x.exposure === "none" && !x.canceled && !x.deliveryHold
        && (!isTask(e) || JSON.stringify(x.payload.peer?.after ?? []) === JSON.stringify(e.payload.peer?.after ?? []))
        && x.deadline > Date.now() && io.valid(x))
      .sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
    if (!absorbed.length) return;
    const rows = [e, ...absorbed];
    // Each item keeps its own status and envelope: a NEED must never inherit a sibling's done.
    const receipts = rows.flatMap(receiptFacts);
    const payload = isRcpt(e)
      ? { ...e.payload, receipts, text: receipts.map((f) =>
        `${f.envelope}\n（回执 event=${f.event} version=${f.version} status=${f.status} receiver=${JSON.stringify(f.receiver)}）\n${f.body}`).join("\n\n"),
        peer: { ...e.payload.peer!, envelope: `以下是同一件活的多份回执。逐项读取各自的状态、来源与正文。\n\n${e.payload.peer!.envelope}` } }
      : { ...e.payload, text: [...rows].sort((a, b) => a.at - b.at || a.id.localeCompare(b.id))
        .map((x) => `${x.payload.peer?.envelope ?? ""}\n${x.payload.text}`).join("\n\n"),
        peer: { ...e.payload.peer!, envelope: `以下是同一项任务的补充要求，请合并处理并统一回复。\n\n${e.payload.peer!.envelope}` } };
    // One atomic store write: a crash cannot expose a merged input and an unretired sibling.
    const inputIds = isTask(e) ? [...new Set(rows.flatMap((x) => x.inputIds ?? [x.id]))].sort() : e.inputIds;
    db.merge({ [e.id]: { ...e, payload, ...(inputIds ? { inputIds } : {}) }, ...Object.fromEntries(absorbed.map((x) => [x.id,
      { ...x, execution: "complete", exposure: "consumed", finalized: true, endedAt: Date.now(), reason: `merged into ${e.id}` }])) });
  };
  const inject = async (id: string, resource: string): Promise<void> => {
    const target = live(id)!.target;
    active.add(resource);
    targets.add(target);
    try {
      absorb(id);
      const e = live(id)!;
      if (stopped || e.execution !== "queued" || e.deliveryHold || !io.valid(e)) return;
      io.accepted(e);
      patch(id, { execution: "dispatching", attempts: e.attempts + 1, transcript: io.transcript(e.target) ?? e.transcript });
      const boundary = (phase?: "paste" | "submit", identity?: { sessionId?: string; transcript?: string }): boolean => {
        const current = live(id)!;
        if (stopped || current.canceled || current.deliveryHold || !io.valid(current)) return false;
        // 已收下的输入不再允许迟到的边界回调触碰 pane 或降级消费见证。
        if (current.execution === "complete" || ["submitted", "consumed"].includes(current.exposure)) return false;
        if (current.exposure !== "none" && current.transcript && current.transcript !== io.transcript(e.target)) return false;
        if (phase) patch(id, { exposure: "possible", sessionId: identity?.sessionId ?? current.sessionId,
          transcript: identity?.transcript ?? io.transcript(e.target) ?? current.transcript });
        return true;
      };
      let r: EventTransport;
      try { r = await io.inject(live(id)!, boundary); }
      catch (error) { r = { ok: false, uncertain: live(id)!.exposure !== "none", retryable: live(id)!.exposure === "none", reason: why(error) }; }
      const latest = live(id)!;
      if (latest.result || latest.execution === "complete") { if (!latest.canceled) io.committed(latest); return; }
      // 原生消费/收口证据比迟到的注入 ACK 强；既不降回 submitted，也不覆盖真实的收口原因。
      if (latest.exposure === "consumed") { if (!latest.canceled) io.committed(latest); return; }
      if (latest.deliveryHold) {
        if (r.ok || r.uncertain || latest.exposure !== "none") patch(id, { execution: "uncertain",
          exposure: r.ok ? "submitted" : latest.exposure, reason: `${latest.reason}; late transport outcome requires reconciliation` });
        return;
      }
      if (r.ok && !r.uncertain) {
        const committed = patch(id, { execution: latest.canceled ? "uncertain" : "awaiting-result", exposure: "submitted", transcript: latest.transcript ?? io.transcript(e.target) });
        if (!latest.canceled) io.committed(committed);
      } else if (!!latest.serves && latest.deadline === NO_DEADLINE && !receiptFacts(latest).length
          && !r.uncertain && latest.exposure === "none" && !latest.canceled) {
        // A proven unexposed input is safe to retry after repair; an unlimited
        // task must not become permanently orphaned after five transport failures.
        patch(id, { execution: "queued", exposure: "none", retryAt: backoff(latest.attempts), reason: r.reason });
      } else if (latest.payload.planReminder && r.retryable && !r.uncertain
          && latest.exposure === "none" && !latest.canceled) {
        // Reminder tokens are recorded at enqueue; keep this same event durable
        // across proven-unexposed retries, with backoff capped by backoff().
        patch(id, { execution: "queued", exposure: "none", retryAt: backoff(latest.attempts), reason: r.reason });
      } else if (r.gone && !r.uncertain && latest.exposure === "none" && !latest.canceled
          && (!latest.serves || receiptFacts(latest).length > 0 || latest.deadline !== NO_DEADLINE)) {
        // 收方真没了 (绑定按 store 也恢复不了): 退避重投只会空转到期限, 收成 canceled 交给路由层上浮。
        // Keep replay possible until the replacement inbox is durable.
        const gone = patch(id, { execution: "queued", retryAt: backoff(latest.attempts), reason: r.reason || "target gone" });
        io.gone?.(gone);
        patch(id, { execution: "canceled" });
      } else if (!r.uncertain && latest.exposure === "none" && !latest.canceled && (!r.retryable
          || latest.attempts >= 5 && (!latest.serves || latest.deadline !== NO_DEADLINE))) {
        const reason = `${r.reason || "submission failed"}${r.retryable ? "; retry limit reached" : ""}`;
        if (receiptFacts(latest).length) holdReceipt(latest, "transport-exhausted", reason);
        else cancel((e) => e.id === id, reason);
      } else if ((r.retryable || r.gone && !!latest.serves) && !r.uncertain && latest.exposure === "none" && !latest.canceled) {
        patch(id, { execution: "queued", exposure: "none", retryAt: backoff(latest.attempts), reason: r.reason });
      } else patch(id, { execution: "uncertain", reason: r.reason || "submission acknowledgement unknown" });
    } catch (e) {
      try { patch(id, { reason: why(e), retryAt: backoff(live(id)!.attempts) }); } catch { accepting = false; stopped = true; clearInterval(timer); timer = undefined; }
      io.error(e);
    }
    finally { active.delete(resource); targets.delete(target); void pump(); }
  };
  /** 人说的这一句不受 daemon 的顺序管辖 (§9.1): 只要同一只 pane 上没有正在贴的那一次
   *  (物理互斥), 就贴进去 —— 排在它前面的回执、正在跑的那一轮都不挡它, 顺序交给 backend CLI
   *  自己的输入队列 (贴进运行中的一轮会被记成 queued 轮, 终句照样归到这条 event)。多笔 event
   *  因此天然并行: 人话补一句还是新起一件, 由读它的 LLM 判。回执 (peer) 仍按老规矩排 ——
   *  它要的是结果归属, 不是语义。 */
  const direct = (e: MessageEvent): boolean => !!e.payload.human;
  /** 同一资源上, 排在 `e` 前面且此刻真挡得住它的那一行; 没有 = 它可以贴了。
   *  `retryAt` 未到的行不算挡住 —— 它在退避, 不该把整条 pane 的后来者一起钉住: 队头一次
   *  探测超时 (5s) 就能把一个 target 静音十几分钟, 人话排在后面时是纯损失。
   *  injectable 与 blocker 共用这一条 —— 判据分家过一次, 表现是「对外说没人挡着, 实际谁也进不去」。 */
  // 先判执行态 (纯字段), 再问 resourceOf: 表里九成多是终态行, 不该替它们付 I/O。
  const pinOf = (e: MessageEvent): MessageEvent | undefined => scan(() => {
    const rows = liveRows().sort((a, b) => a.at - b.at);
    const resource = resourceAt(e.target);
    return rows.find((x) => x.id !== e.id
      && (x.execution === "dispatching"
        // A consumed, closed input cannot own the next turn. Keep its unknown
        // result for reconciliation without replaying it or pinning later inputs.
        || (!direct(e) && io.blocksQueue?.(x) !== false && x.execution === "uncertain" && !x.releasedAt
          && !(x.exposure === "consumed" && x.turnClosedAt)))
      && resourceOf(x) === resource);
  });
  /** 全局 4 路并发只限回执 / 派活: 人话之间、人话与别的 pane 都互不相干, 只认同 pane 物理互斥。 */
  const injectable = (e: MessageEvent): boolean =>
    !stopped && e.execution === "queued" && !e.canceled && !e.deliveryHold && e.deadline > Date.now() && io.valid(e)
    && !targets.has(e.target) && !active.has(resourceAt(e.target)) && (direct(e) || active.size < 4)
    && pinOf(e) === undefined;
  type Blocker = { id: string; execution: MessageEvent["execution"]; reason: string };
  const blockerOf = (hit: MessageEvent | undefined): Blocker | undefined => hit && { id: hit.id, execution: hit.execution,
    reason: hit.reason ?? (hit.execution === "uncertain" ? "旧事件投递结果不确定，需对账" : `等待较早事件（${hit.execution}）`) };
  const blocker = (id: string): Blocker | undefined => {
    const e = live(id);
    return e?.execution === "queued" ? blockerOf(pinOf(e)) : undefined;
  };
  /** 一条还没贴出去的 event 此刻的排队全貌: 同 pane 上排在它前面的未了结行, 以及 injectable
   *  的每一条否决项各自落在哪 —— 给人看「卡在谁后面、为什么、几时再试」, 不是一句「已排队」。
   *  `pin` 一并交回, 让 status 不必为 blocker 再扫一遍全表。 */
  const queueOf = (e: MessageEvent): { execution: MessageEvent["execution"]; ahead: MessageEvent[]; holds: string[]; pin?: MessageEvent } => scan(() => {
    const resource = resourceAt(e.target);
    const ahead = liveRows()
      .filter((x) => x.id !== e.id && x.at <= e.at && ["queued", "dispatching", "awaiting-result"].includes(x.execution) && !x.canceled
        && (x.execution !== "awaiting-result" || !x.releasedAt)
        && (x.execution === "dispatching" || io.blocksQueue?.(x) !== false)
        && resourceOf(x) === resource)
      .sort((a, b) => a.at - b.at);
    const pin = pinOf(e);
    const holds = [
      stopped ? "调度器未运行 (daemon 正在启停)" : "",
      e.deliveryHold ? `回执持久待投 (${e.deliveryHold}); POST /message-events/release with id and reason` : "",
      (e.retryAt ?? 0) > Date.now() ? `上次投递失败, ${new Date(e.retryAt!).toTimeString().slice(0, 8)} 重试${e.reason ? `（${e.reason}）` : ""}` : "",
      targets.has(e.target) || active.has(resource) ? "同一 pane 正在贴另一条" : "",
      !direct(e) && active.size >= 4 ? `全局同时投递已满 ${active.size} 路` : "",
      pin ? `挡在前面: ${pin.id.slice(0, 10)}（${pin.execution}${pin.reason ? ` · ${pin.reason}` : ""}）` : "",
    ].filter(Boolean);
    return { execution: e.execution, ahead: ahead.map(clone), holds, pin };
  });
  const queue = (id: string): { execution: MessageEvent["execution"]; ahead: MessageEvent[]; holds: string[] } | undefined => {
    const e = live(id);
    if (!e) return undefined;
    const { pin: _pin, ...q } = queueOf(e);
    return q;
  };
  const partsByEvent = (): Map<string, FinalDelivery["parts"]> => Object.values(outbox.all()).reduce((m, d) =>
    d.eventId ? m.set(d.eventId, [...(m.get(d.eventId) ?? []), ...d.parts]) : m, new Map<string, FinalDelivery["parts"]>());
  const deliveryOf = (parts: FinalDelivery["parts"]): string => parts.some((p) => p.state === "failed") ? "failed"
    : parts.some((p) => p.state === "uncertain") ? "uncertain" : parts.some((p) => p.state !== "delivered") ? "delivery-pending" : parts.length ? "delivered" : "none";
  /** status 里的一行: 排着的行只扫一次队 (blocker 取 queueOf 交回的 pin)。 */
  const view = (e: MessageEvent, parts: FinalDelivery["parts"]) => {
    const q = e.execution === "queued" ? queueOf(e) : undefined;
    const blockedBy = blockerOf(q?.pin);
    const held = holding.get(e.id);
    return { ...clone(e),
      status: e.execution === "dispatching" ? "executing" : e.execution,
      ...(blockedBy ? { blockedBy } : {}),
      // 回执 / 派活排着时把扣住它的每一条都摆出来 (含 ready=false 这种 queue() 看不见的)。
      ...(q && !direct(e) ? { holds: [...q.holds, ...(held ? [`${held.why} · 已扣 ${Math.round((Date.now() - held.since) / 1000)}s`] : [])] } : {}),
      delivery: deliveryOf(parts),
    };
  };
  const release = (id: string, reason: string): { ok: boolean; event?: MessageEvent; reason?: string } => {
    const e = live(id);
    const note = reason.trim().slice(0, 500);
    if (!e) return { ok: false, reason: "unknown event" };
    if (!note) return { ok: false, reason: "a reconciliation reason is required" };
    if (e.deliveryHold && e.execution === "queued" && e.exposure === "none" && !e.canceled) {
      const next = patch(id, { deliveryHold: undefined, attempts: 0, retryAt: undefined,
        deadline: Math.max(e.deadline, Date.now() + 3600_000), reason: `receipt delivery explicitly resumed: ${note}` });
      void pump();
      return { ok: true, event: clone(next) };
    }
    if (e.deliveryHold) return { ok: false, reason: "held receipt has possible exposure; reconcile transcript before any retry" };
    if (!["awaiting-result", "uncertain"].includes(e.execution) || e.exposure === "none")
      return { ok: false, reason: `event is not an exposed unresolved delivery (${e.execution}/${e.exposure})` };
    if (e.releaseSource === "manual") return { ok: false, event: clone(e), reason: "event already manually released" };
    const next = patch(id, { execution: "uncertain", releasedAt: e.releasedAt ?? Date.now(), releaseSource: "manual", releaseReason: note,
      reason: `manually released from queue; delivery remains uncertain: ${note}` });
    void pump();
    return { ok: true, event: clone(next) };
  };
  const releaseMissingPane = (target: string, sessionId: string | undefined, transcript: string | undefined, evidence: string): string[] => {
    const rows = liveRows().filter((e) => e.target === target && ["awaiting-result", "uncertain"].includes(e.execution)
      && e.exposure !== "none" && !e.releasedAt
      && (!e.sessionId || e.sessionId === sessionId) && (!e.transcript || e.transcript === transcript));
    const at = Date.now();
    rows.forEach((e) => patch(e.id, { execution: "uncertain", releasedAt: at, releaseSource: "pane-missing",
      releaseReason: `pane/session disappeared (${evidence}); old execution remains uncertain and will not be replayed`,
      supersededBy: `pane-missing:${evidence}`,
      reason: `${e.reason ? `${e.reason}; ` : ""}pane/session disappeared; queue slot released, old execution remains uncertain` }));
    void pump();
    return rows.map((e) => e.id);
  };
  async function pump(): Promise<void> {
    if (stopped || pumping) return;
    pumping = true;
    try { scan(() => {
      // Scan the first unfinished part; later pending parts cannot jump an uncertain predecessor.
      Object.values(outbox.all()).forEach((d) => d.parts.forEach((p, n) => {
        if (!["waiting-ack", "uncertain"].includes(p.state)) return;
        const evidence = io.deliveryEvidence?.(d, n);
        if (evidence) part(d.id, n, { state: evidence.state === "queued" ? "waiting-ack" : evidence.state, ack: evidence.ack, reason: evidence.reason });
      }));
      const finals = Object.values(outbox.all());
      const rotated = [...finals.slice(deliveryCursor), ...finals.slice(0, deliveryCursor)];
      rotated.filter((d) => { const p = d.parts.find((x) => x.state !== "delivered");
        return !delivering.has(d.id) && p?.state === "pending" && (p.retryAt ?? 0) <= Date.now();
      }).slice(0, Math.max(0, 4 - delivering.size)).forEach((d) => {
        deliveryCursor = (finals.findIndex((x) => x.id === d.id) + 1) % Math.max(1, finals.length);
        void send(d.id).catch(io.error);
      });
      const rows = liveRows().sort((a, b) => a.at - b.at);
      [...holding.keys()].filter((id) => live(id)?.execution !== "queued").forEach((id) => holding.delete(id));
      const fair = [...rows.slice(probeCursor), ...rows.slice(0, probeCursor)];
      fair.forEach((e) => {
        if (stopped) return;
        if (e.execution === "queued" && io.blocksQueue?.(e) === false) return;
        // Expiration and permission withdrawal are ledger work; a busy or hung
        // probe on this pane must not prevent queued messages from expiring.
        if (e.execution === "queued" && e.deliveryHold) return;
        if (e.execution === "queued" && (e.deadline <= Date.now() || !io.valid(e))) {
          const reason = e.deadline <= Date.now() ? "deadline expired before submission" : "permission withdrawn";
          if (receiptFacts(e).length) holdReceipt(e, "transport-exhausted", reason);
          else cancel((x) => x.id === e.id, reason);
          return;
        }
        if (["awaiting-result", "uncertain"].includes(e.execution) && e.deadline <= Date.now() && !e.releasedAt) {
          patch(e.id, { execution: "uncertain", releasedAt: Date.now(),
            releaseSource: "deadline",
            releaseReason: "event deadline elapsed; uncertainty retained and automatic retry withheld",
            reason: `${e.reason ? `${e.reason}; ` : ""}event deadline elapsed; queue released with uncertain delivery` });
          return;
        }
        // 人话的 ready 不碰 pane (只看交接闸), 不必占探测位: 否则同 pane 上一条 awaiting-result
        // 每秒一次的 evidence 探测 (最长 5s) 几乎一直占着 probeTargets, 人话被反复跳过或误判失败退避。
        if (e.execution === "queued" && direct(e)) {
          if ((e.retryAt ?? 0) > Date.now() || !injectable(e)) return;
          void io.ready(e).then((ready) => {
            const current = live(e.id)!;
            if (ready && injectable(current)) void inject(e.id, io.resource(current.target));
          }).catch(io.error);
          return;
        }
        if (probing.has(e.id) || probeTargets.has(resourceOf(e)) || probeCount >= 16) {
          if (e.execution === "queued") hold(e, "探测位被占 (同 pane 上另一条正在探测)");
          return;
        }
        probeCursor = (rows.findIndex((x) => x.id === e.id) + 1) % Math.max(1, rows.length);
        const failed = (error: unknown): void => {
          const current = live(e.id);
          if (!stopped && current && !["complete", "canceled"].includes(current.execution)) {
            const probeAttempts = (current.probeAttempts ?? 0) + 1;
            patch(e.id, { probeAttempts, retryAt: backoff(probeAttempts), reason: `${current.reason ? `${current.reason}; ` : ""}${why(error)}` });
          }
          io.error(error);
        };
        if (["awaiting-result", "uncertain"].includes(e.execution)) {
          if (e.failure && !e.finalized) {
            io.final?.(e, { text: e.failure.body, error: true });
            patch(e.id, { finalized: true });
          }
          if (e.execution === "uncertain" && (e.turnClosedAt || e.releasedAt)) return;
          if ((e.retryAt ?? 0) > Date.now()) return;
          const currentSession = ask("sessionId", e.target);
          const currentTranscript = ask("transcript", e.target);
          const replaced = e.exposure !== "none" && (e.sessionId
            ? e.sessionId !== currentSession : !!e.transcript && e.transcript !== currentTranscript);
          if (replaced && !e.supersededBy) patch(e.id, { supersededBy: currentSession ?? (currentTranscript ? `transcript:${currentTranscript}` : "replacement-session-unavailable"),
            reason: `${e.reason ? `${e.reason}; ` : ""}session replaced; old execution remains uncertain pending transcript reconciliation` });
          void observe(e).then(() => {
            if (!stopped && e.deadline <= Date.now() && live(e.id)!.execution === "awaiting-result")
              patch(e.id, { execution: "uncertain", reason: "deadline exceeded; result/physical completion not confirmed" });
          }).catch(failed);
          return;
        }
        if (e.execution === "complete") {
          if (!e.finalized) {
            if (!e.canceled) io.committed(e);
            if (e.result) {
              // reload 落在 result 与 finalized 之间: 重放这一刻补上路由判定 (幂等 —— 同一条
              // 定论重放只会在表上再写一次同样的 op)。
              io.final?.(e, { text: e.result.body });
              // 先落交接切断标记与路由归属, 再恢复外发; 否则旧 final 会抢在闸前公开。
              io.recovered(live(e.id)!);
            }
            patch(e.id, { finalized: true });
          }
          return;
        }
        if (e.execution !== "queued") return;
        // 原因里不带重试时刻: 每次退避时刻都在变, 带上就成了「原因变了」, 日志每轮重报。
        if ((e.retryAt ?? 0) > Date.now()) { hold(e, `投递失败退避中${e.reason ? `（${e.reason}）` : ""}`); return; }
        if (!injectable(e)) { hold(e, `injectable=false: ${queue(e.id)?.holds.join("; ") || "无效 / 过期"}`); return; }
        void bounded(e.id, () => io.ready(e)).then((ready) => {
          const current = live(e.id)!;
          if (ready && injectable(current)) void inject(e.id, io.resource(current.target));
          else if (current.execution === "queued") hold(current, ready ? "injectable=false (ready 之后)" : "ready=false (前置未落定 / owner 未判闲)");
        }).catch(failed);
      });
    }); } catch (e) { io.error(e); }
    finally { pumping = false; }
  }
  const resume = (): void => {
    // Boot restoration may finish after shutdown has begun; never restart delivery then.
    if (draining) return;
    liveRows().filter((e) => e.execution === "dispatching").forEach((e) => patch(e.id, {
      execution: e.exposure === "none" ? "queued" : "uncertain", reason: "daemon restarted at input boundary; transcript evidence required",
    }));
    Object.values(outbox.all()).forEach((d) => d.parts.forEach((p, n) => {
      if (p.state === "sending") part(d.id, n, { state: "uncertain", reason: "daemon restarted before final ACK was persisted" });
    }));
    stopped = false;
    accepting = true;
    timer ??= setInterval(() => { void pump(); }, 1000);
    timer.unref();
    void pump();
  };
  return {
    accept, pump, resume, result, delivery, cancel, blocker, queue, release, releaseMissingPane, claimReceipt,
    taskInputs: (task: string): MessageEvent[] => liveRows().filter((e) => (io.task?.(e) ?? e.serves) === task).map(clone),
    consumedTaskInputs: (task: string, source: MessageEvent): string[] => taskInputCoverage(liveRows(), task, source,
      (event) => io.task?.(event) ?? event.serves).inputs,
    coversTaskInputs: (task: string, source: MessageEvent, inputs: readonly string[]): boolean => {
      const relevant = liveRows().filter((e) => e.target === source.target && (io.task?.(e) ?? e.serves) === task && !e.canceled);
      return coversTaskInputIds(relevant, inputs);
    },
    running: () => !stopped,
    bind: (id: string, turn: string) => { if (live(id)) patch(id, { turn }); },
    bindResultRoute: (id: string, section: string, receiver: string, event: EventId | null, inputs?: string[]): void => {
      const e = live(id);
      if (!e) return;
      const prior = e.resultRoutes?.[section];
      if (prior && (prior.receiver !== receiver || prior.event !== event)) throw new Error(`RESULT section binding changed for ${id}/${section}`);
      if (prior?.inputs && inputs && JSON.stringify(prior.inputs) !== JSON.stringify(inputs)) throw new Error(`RESULT coverage changed for ${id}/${section}`);
      patch(id, { resultRoutes: { ...e.resultRoutes, [section]: { ...prior, receiver, event, ...(inputs ? { inputs } : {}) } } });
    },
    finished: (id: string) => {
      const e = live(id);
      // Physical completion is not a task answer. Keep the missing outcome
      // visible while allowing the next input to use this pane.
      if (e && !e.canceled && !e.result) patch(id, { execution: "uncertain", exposure: "consumed",
        consumedAt: e.consumedAt ?? Date.now(),
        turnClosedAt: e.turnClosedAt ?? Date.now(),
        reason: "input turn ended without a final assistant answer; automatic retry withheld" });
    },
    released: (id: string) => { const e = live(id); if (e?.canceled) patch(id, { execution: "canceled", reason: `${e.reason ?? "canceled"}; pane idle confirmed` }); },
    stopped: (target: string, reason: string) => liveRows().filter((e) => e.target === target && e.canceled).forEach((e) => patch(e.id, { execution: "canceled", reason })),
    submission: async (id: string): Promise<EventTransport> => {
      for (;;) {
        const e = live(id);
        if (!e) return { ok: false, retryable: true, reason: "event missing" };
        if (["submitted", "consumed"].includes(e.exposure)) return { ok: true };
        if (e.deliveryHold) return { ok: false, retryable: false, uncertain: e.exposure !== "none", reason: e.reason };
        if (e.execution === "uncertain" || stopped) return { ok: false, uncertain: true, reason: e.reason || "scheduler stopped" };
        if (e.execution === "canceled") return { ok: false, reason: e.reason };
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    },
    // Keep ingress durable until WS/HTTP and their in-flight handlers have closed.
    drain: () => { draining = true; stopped = true; clearInterval(timer); timer = undefined; },
    stop: () => { accepting = false; stopped = true; clearInterval(timer); timer = undefined; },
    get: (id: string) => { const e = live(id); return e && clone(e); },
    suppressHandoffFinal: (id: string) => { if (live(id)) patch(id, { handoffCut: true, handoffRestored: false }); },
    restoreHandoffFinal: (id: string) => { if (live(id)) patch(id, { handoffCut: false, handoffRestored: true }); },
    /** 这个 id 用过没有 (含墓碑): 自己配 id 的调用方 (续问序号 / 交接续答) 据此避开撞号。 */
    known: (id: string) => db.get(id) !== undefined,
    ids: () => Object.keys(db.all()),
    /** 只问执行态 (含墓碑): 判「这份投过没有」的调用方不必在乎它是不是已被裁掉。 */
    executionOf: (id: string) => db.get(id)?.execution,
    exposureOf: (id: string) => {
      const e = live(id);
      // Absorbed siblings are complete/consumed before their carrier is injected.
      // Without their own result, that bookkeeping is not consumption evidence.
      return e?.execution === "complete" && !e.result ? undefined : e?.exposure;
    },
    authorityOf: (id: string): EventAuthority | undefined => {
      const authority = sourceOf(id);
      return authority && clone(authority);
    },
    // A transfer moves the route, not the human's original reply stream. Derive the
    // binding from durable inputs so chained transfers and reload use the same bubble.
    latestTransfer: (serves: string): MessageEvent | undefined => {
      const transfers = liveRows().filter((e) => e.serves === serves && e.payload.peer?.transferred && !e.canceled);
      const last = transfers.at(-1);
      return last && clone(last);
    },
    hasReplyDelivery: (streamId: string): boolean => Object.values(outbox.all()).some((d) => d.stream?.id === streamId),
    replyOrigin: (event: MessageEvent): MessageEvent | undefined => {
      const origin = event.payload.human ? live(event.id) : event.serves
        ? liveRows().find((e) => e.serves === event.serves && !!e.payload.human && e.channel === event.channel)
        : undefined;
      return origin && clone(origin);
    },
    status: () => scan(() => {
      const parts = partsByEvent();
      return { events: liveRows().map((e) => view(e, parts.get(e.id) ?? [])), deliveries: Object.values(outbox.all()).map(clone) };
    }),
    /** 一条 event 的 status 视图 —— 轮询单条的调用方 (回归脚本) 不必为它把全表算一遍。 */
    event: (id: string) => { const e = live(id); return e && scan(() => view(e, partsByEvent().get(id) ?? [])); },
    deliveryStatus: (id: string) => outbox.get(id)?.parts.map((p) => p.state),
    deliveryClaims: (coverage: DeliveryInput["coverage"]) => claimsOf(coverage).map((d) => ({ id: d.id, states: d.parts.map((p) => p.state) })),
    // 泵可能正在同一 pane 上取证; 外部交接轮询复用在飞探针, 不能把 busy 当投递失败。
    reconcile: async (id: string) => {
      const e = live(id);
      if (e && !probing.has(id) && !probeTargets.has(resourceOf(e)) && probeCount < 16) await observe(e);
      return live(id);
    },
  };
};
export type MessageEvents = ReturnType<typeof createMessageEvents>;
