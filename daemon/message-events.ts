import { createHash } from "node:crypto";
import { loadJsonMap } from "../shared/json-map-store.js";
import type { Asker, TurnFrom } from "../shared/detail-store.js";
import type { MirrorDispatchArgs } from "./mirror-bridge.js";
import type { Tell, HeldSeen } from "./dispatch.js";
import type { EventId, FinalVerdict } from "./router.js";

export interface MessageInput {
  id: string;
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
  priority: "normal" | "now" | "urgent";
  deadline: number;
  payload: {
    text: string;
    human?: MirrorDispatchArgs;
    peer?: {
      from: TurnFrom;
      envelope: string;
      tell?: Tell;
      attemptId?: string;
      after?: string[];
      afterSeen?: Readonly<Record<string, HeldSeen>>;
      job: string;
      kind: "task" | "ask" | "fyi";
      role?: "exec" | "reviewer" | "expert";
      free?: boolean;
      held?: boolean;
      spawned?: boolean;
      /** 上游 `re` 一份已交出去的件, 按 delegate 转给了叶子: 不是发话方自己的一件新活 (不进它的挂起账)。 */
      relayed?: boolean;
      /** `return:"transfer"`: 这一笔的 owner 已经改成了收件方, 不是发话方自己在等的一件。 */
      transferred?: boolean;
    };
  };
}
export interface MessageEvent extends MessageInput {
  fingerprint: string;
  at: number;
  execution: "queued" | "dispatching" | "awaiting-result" | "complete" | "canceled" | "uncertain";
  exposure: "none" | "possible" | "submitted" | "consumed";
  attempts: number;
  retryAt?: number;
  reason?: string;
  canceled?: boolean;
  transcript?: string;
  sessionId?: string;
  supersededBy?: string;
  turnClosedAt?: number;
  releasedAt?: number;
  releaseReason?: string;
  releaseSource?: "manual" | "deadline";
  probeAttempts?: number;
  turn?: string;
  finalized?: boolean;
  interjected?: boolean;
  result?: { body: string; revision: string; at: number };
  /** 进终态 (complete / canceled) 的时刻 —— 墓碑化的起点。老行没有, 按已知时刻估。 */
  endedAt?: number;
}
/** 终态行过了 TOMB_AFTER_MS 只剩判重要用的那几样: accept 认 id + fingerprint 判「同一条消息」,
 *  WS 重放 / 收件箱重入 (`rcpt:<event>:<rev>`) 撞上它就是已投过、不再注入; 丢了它就会再投一次。
 *  墓碑再过 TOMB_TTL_MS (自 endedAt 起) 才删 —— 重放窗口远小于它。 */
export interface Tombstone { id: string; fingerprint: string; execution: "complete" | "canceled"; endedAt: number; tomb: true }
type Row = MessageEvent | Tombstone;
const TOMB_AFTER_MS = 24 * 3600_000;
const TOMB_TTL_MS = 7 * 24 * 3600_000;
const isTomb = (x: Row): x is Tombstone => (x as Tombstone).tomb === true;
const terminal = (x: MessageEvent["execution"]): x is Tombstone["execution"] => x === "complete" || x === "canceled";
/** complete 要等 finalized (路由判定补完) 才算了结; canceled 本身就是了结。 */
const settled = (e: MessageEvent): boolean => e.execution === "canceled" || (e.execution === "complete" && !!e.finalized);
const endedAt = (e: MessageEvent): number => e.endedAt ?? Math.max(e.at, e.result?.at ?? 0, e.turnClosedAt ?? 0, e.releasedAt ?? 0);
const entomb = (e: MessageEvent & { execution: Tombstone["execution"] }): Tombstone =>
  ({ id: e.id, fingerprint: e.fingerprint, execution: e.execution, endedAt: endedAt(e), tomb: true });
/** 每次落盘前跑: 了结满一天的行裁成墓碑, 墓碑满七天删掉。 */
export const gcEvents = (now: number) => (rows: Record<string, Row>): Record<string, Row> =>
  Object.fromEntries(Object.entries(rows).flatMap(([id, x]): Array<[string, Row]> =>
    isTomb(x) ? (now - x.endedAt >= TOMB_TTL_MS ? [] : [[id, x]])
    : settled(x) && terminal(x.execution) && now - endedAt(x) >= TOMB_AFTER_MS ? [[id, entomb({ ...x, execution: x.execution })]]
    : [[id, x]]));
export interface DeliveryInput {
  transfer?: { id: string; standalone: boolean };
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
  final?: (event: MessageEvent, verdict: FinalVerdict) => void;
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
export const messageId = (bot: string, chat: string, id: string): string => `h${digest([bot, chat, id])}`;
export const finalId = (event: string, channel: string, revision: string): string => `f${digest([event, channel, revision])}`;
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
const backoff = (n: number): number => Date.now() + Math.min(60_000, 1000 * 2 ** Math.min(n, 6));
const why = (e: unknown): string => e instanceof Error ? e.message : typeof e === "object" ? JSON.stringify(e) : String(e);
// A negative transport ACK proves non-delivery; a timeout or disconnected socket does not.
export const rejectedAck = (e: unknown): boolean => !!e && typeof e === "object"
  && typeof (e as { errcode?: unknown }).errcode === "number" && (e as { errcode: number }).errcode !== 0
  && typeof (e as { errmsg?: unknown }).errmsg === "string" && !!(e as { headers?: unknown }).headers;

export const createMessageEvents = (file: string, io: MessageAdapters) => {
  const db = loadJsonMap<Row>(file, (rows) => gcEvents(Date.now())(rows), { strict: true });
  const outbox = loadJsonMap<FinalDelivery>(`${file}.finals`, undefined, { strict: true });
  Object.entries(db.all()).forEach(([id, e]) => {
    if (e && isTomb(e)) {
      if (e.id !== id || typeof e.fingerprint !== "string" || !terminal(e.execution) || !Number.isFinite(e.endedAt)) throw new Error(`invalid message event tombstone ${id}`);
      return;
    }
    if (!e || e.id !== id || typeof e.fingerprint !== "string" || !e.target || typeof e.speaker !== "string" || typeof e.channel !== "string" || (e.serves !== undefined && typeof e.serves !== "string") || !e.payload || typeof e.payload.text !== "string" || (!e.payload.human === !e.payload.peer) || !Number.isFinite(e.at) || !Number.isFinite(e.attempts) || !Number.isFinite(e.deadline) || !["queued", "dispatching", "awaiting-result", "complete", "canceled", "uncertain"].includes(e.execution)) throw new Error(`invalid message event ${id}`);
  });
  Object.entries(outbox.all()).forEach(([id, d]) => {
    if (!d || d.id !== id || !Array.isArray(d.parts) || d.parts.length !== d.chunks?.length || !d.chunks.every((c) => typeof c === "string") || !d.parts.every((p) => ["pending", "sending", "waiting-ack", "delivered", "uncertain", "failed"].includes(p.state)) || !d.channel) throw new Error(`invalid final delivery ${id}`);
  });
  /** 调度只看活行; 墓碑只给 accept 判重 (与 `known`)。 */
  const live = (id: string): MessageEvent | undefined => { const x = db.get(id); return x && !isTomb(x) ? x : undefined; };
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
  const cancel = (select: (e: MessageEvent) => boolean, reason = "canceled by owner"): number => {
    const rows = liveRows().filter((e) => !["complete", "canceled"].includes(e.execution) && select(e));
    rows.forEach((e) => {
      const next = patch(e.id, { canceled: true, reason, execution: e.exposure === "none" ? "canceled" : "uncertain" });
      io.canceled(next); // Cancellation after exposure never asserts the pane stopped.
    });
    return rows.length;
  };
  const accept = (input: MessageInput): { ok: true; queued: boolean; eventId: string } => {
    if (!accepting) throw new Error("message scheduler is stopped");
    const clean = clone(input);
    // `serves` 是路由元数据, 不参与身份: 同一个 id 重放 (含 reload 后重入箱) 带着同一份
    // 内容就该是同一条消息, 哪怕 serves 的来历变了 —— 它不算内容的一部分。
    const { serves: _routing, ...identified } = clean;
    const fingerprint = digest(identified.identity ? [JSON.parse(identified.identity), identified.speaker, identified.channel] : identified);
    const prior = db.get(input.id);
    if (prior && prior.fingerprint !== fingerprint) throw new Error(`event identity conflict: ${input.id}`);
    // 墓碑 = 早已投过并了结: 重放 / 重入箱到此为止, 不复活、不再注入。
    if (prior && isTomb(prior)) return { ok: true, queued: false, eventId: prior.id };
    let e = prior;
    if (!e) {
      e = { ...clean, fingerprint, at: Date.now(), execution: "queued", exposure: "none", attempts: 0 };
      db.merge({ [e.id]: e });
    }
    if (e.execution === "queued") {
      try { io.accepted(e); }
      catch (error) { patch(e.id, { execution: "uncertain", reason: `acceptance projection failed: ${why(error)}` }); throw error; }
    } // Idempotent adapters restore accounting/receipt intent after a torn cross-store write.
    void pump();
    return { ok: true, queued: e.execution === "queued", eventId: e.id };
  };
  const result = (id: string, body: string, revision: string, turn?: string): void => {
    const e = live(id);
    if (!e || e.result?.revision === revision) return;
    patch(id, { finalized: false, result: { body, revision, at: Date.now() }, execution: "complete", exposure: "consumed", ...(turn ? { turn } : {}) });
    io.final?.(live(id)!, { text: body });
  };
  const delivery = (input: DeliveryInput): string => {
    const old = outbox.get(input.id);
    if (old) {
      if (old.body !== input.body || old.channel !== input.channel || old.revision !== input.revision) throw new Error(`final identity conflict: ${input.id}`);
      return old.id;
    }
    const frozen = clone(io.format?.(input) ?? input);
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
      execution: current.canceled || (evidence.closedAt && !evidence.body) ? "uncertain" : "awaiting-result",
      reason: current.canceled ? current.reason : evidence.closedAt && !evidence.body
        ? "input turn closed without a final assistant answer; delivery remains uncertain and will not be retried" : undefined,
      ...(evidence.closedAt ? { turnClosedAt: evidence.closedAt } : {}), turn: evidence.turn ?? current.turn,
    });
    if (!current.canceled) io.committed(live(e.id)!);
    if (evidence.body !== undefined && evidence.error) {
      // CLI 报错收尾: 那段报错不是定论 (§5), 交路由表落中途态 —— 事件本身不动, 它的执行态
      // 自有 deadline / 续跑那条路管 (与改动前一致)。
      io.final?.(live(e.id)!, { text: evidence.body, error: true });
    } else if (evidence.body !== undefined && evidence.revision) {
      result(e.id, evidence.body, evidence.revision, evidence.turn);
      io.recovered(live(e.id)!);
    }
  };
  /** 收件箱里的回执事件 (`rcpt:<event>:<rev>`): 只有它带路由归属 (serves), 也只有它该合并。 */
  const isRcpt = (e: MessageEvent): boolean => e.id.startsWith("rcpt:") && !!e.serves;
  /** §9.3 Aggregator: 同一个 target、服务同一笔 (`serves` = `receiver.event`) 还排着队的其它回执,
   *  并进这一次注入 —— 扇出的兄弟陆续回来时是一轮, 不是一人一轮。被吸收的那些各自收口
   *  (`execution: complete`, 它们的 id 已终态, 重放不再注入); 结论由这一轮的终句统一交代。
   *  回执的正文与信封是分开的两件 (`payload.text` 不含信封), 所以并的只是正文, 信封留注入那一份。 */
  const absorb = (id: string): void => {
    const e = live(id);
    if (!e || !isRcpt(e)) return;
    const absorbed = liveRows()
      .filter((x) => x.id !== e.id && isRcpt(x) && x.target === e.target && x.serves === e.serves
        && x.execution === "queued" && !x.canceled)
      .sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : 1));
    if (!absorbed.length) return;
    patch(e.id, { payload: { ...e.payload, text: [e.payload.text,
      ...absorbed.map((x) => `（另一份回执 ${x.id} · ${x.speaker}）\n${x.payload.text}`)].join("\n\n") } });
    absorbed.forEach((x) => patch(x.id, { execution: "complete", exposure: "consumed", finalized: true, reason: `merged into ${e.id}` }));
  };
  const inject = async (id: string, resource: string): Promise<void> => {
    const target = live(id)!.target;
    active.add(resource);
    targets.add(target);
    try {
      absorb(id);
      const e = live(id)!;
      if (stopped || e.execution !== "queued" || !io.valid(e)) return;
      io.accepted(e);
      patch(id, { execution: "dispatching", attempts: e.attempts + 1, transcript: io.transcript(e.target) ?? e.transcript });
      const boundary = (phase?: "paste" | "submit", identity?: { sessionId?: string; transcript?: string }): boolean => {
        const current = live(id)!;
        if (stopped || current.canceled || !io.valid(current)) return false;
        if (current.exposure !== "none" && current.transcript && current.transcript !== io.transcript(e.target)) return false;
        if (phase) patch(id, { exposure: "possible", sessionId: identity?.sessionId,
          transcript: identity?.transcript ?? io.transcript(e.target) ?? current.transcript });
        return true;
      };
      let r: EventTransport;
      try { r = await io.inject(live(id)!, boundary); }
      catch (error) { r = { ok: false, uncertain: live(id)!.exposure !== "none", retryable: live(id)!.exposure === "none", reason: why(error) }; }
      const latest = live(id)!;
      if (latest.result || latest.execution === "complete") { if (!latest.canceled) io.committed(latest); return; }
      if (r.ok && !r.uncertain) {
        const committed = patch(id, { execution: latest.canceled ? "uncertain" : "awaiting-result", exposure: "submitted", transcript: latest.transcript ?? io.transcript(e.target) });
        if (!latest.canceled) io.committed(committed);
      } else if (r.gone && !r.uncertain && latest.exposure === "none" && !latest.canceled) {
        // 收方真没了 (绑定按 store 也恢复不了): 退避重投只会空转到期限, 收成 canceled 交给路由层上浮。
        io.gone?.(patch(id, { execution: "canceled", reason: r.reason || "target gone" }));
      } else if (r.retryable && !r.uncertain && !latest.canceled) {
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
    const older = new Set(rows.slice(0, rows.findIndex((x) => x.id === e.id)).map((x) => x.id));
    return rows.find((x) => x.id !== e.id
      && (x.execution === "dispatching"
        || (!direct(e) && ((x.execution === "uncertain" && !x.releasedAt)
          || (e.priority === "normal" && (x.execution === "awaiting-result"
            || (x.execution === "queued" && (x.retryAt ?? 0) <= Date.now() && older.has(x.id)))))))
      && resourceOf(x) === resource);
  });
  /** 全局 4 路并发只限回执 / 派活: 人话之间、人话与别的 pane 都互不相干, 只认同 pane 物理互斥。 */
  const injectable = (e: MessageEvent): boolean =>
    !stopped && e.execution === "queued" && !e.canceled && e.deadline > Date.now() && io.valid(e)
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
        && resourceOf(x) === resource)
      .sort((a, b) => a.at - b.at);
    const pin = pinOf(e);
    const holds = [
      stopped ? "调度器未运行 (daemon 正在启停)" : "",
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
    if (!["awaiting-result", "uncertain"].includes(e.execution) || e.exposure === "none")
      return { ok: false, reason: `event is not an exposed unresolved delivery (${e.execution}/${e.exposure})` };
    if (e.releaseSource === "manual") return { ok: false, event: clone(e), reason: "event already manually released" };
    const next = patch(id, { execution: "uncertain", releasedAt: e.releasedAt ?? Date.now(), releaseSource: "manual", releaseReason: note,
      reason: `manually released from queue; delivery remains uncertain: ${note}` });
    void pump();
    return { ok: true, event: clone(next) };
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
        // Expiration and permission withdrawal are ledger work; a busy or hung
        // probe on this pane must not prevent queued messages from expiring.
        if (e.execution === "queued" && (e.deadline <= Date.now() || !io.valid(e))) {
          cancel((x) => x.id === e.id, e.deadline <= Date.now() ? "deadline expired before submission" : "permission withdrawn");
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
              io.recovered(e);
              // reload 落在 result 与 finalized 之间: 重放这一刻补上路由判定 (幂等 —— 同一条
              // 定论重放只会在表上再写一次同样的 op)。
              io.final?.(e, { text: e.result.body });
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
    accept, pump, resume, result, delivery, cancel, blocker, queue, release,
    running: () => !stopped,
    bind: (id: string, turn: string) => { if (live(id)) patch(id, { turn }); },
    finished: (id: string) => { const e = live(id); if (e && !e.canceled && !e.result) patch(id, { execution: "complete", exposure: "consumed" }); },
    released: (id: string) => { const e = live(id); if (e?.canceled) patch(id, { execution: "canceled", reason: `${e.reason ?? "canceled"}; pane idle confirmed` }); },
    stopped: (target: string, reason: string) => liveRows().filter((e) => e.target === target && e.canceled).forEach((e) => patch(e.id, { execution: "canceled", reason })),
    submission: async (id: string): Promise<EventTransport> => {
      for (;;) {
        const e = live(id);
        if (!e) return { ok: false, retryable: true, reason: "event missing" };
        if (["submitted", "consumed"].includes(e.exposure)) return { ok: true };
        if (e.execution === "uncertain" || stopped) return { ok: false, uncertain: true, reason: e.reason || "scheduler stopped" };
        if (e.execution === "canceled") return { ok: false, reason: e.reason };
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    },
    // Keep ingress durable until WS/HTTP and their in-flight handlers have closed.
    drain: () => { draining = true; stopped = true; clearInterval(timer); timer = undefined; },
    stop: () => { accepting = false; stopped = true; clearInterval(timer); timer = undefined; },
    get: (id: string) => { const e = live(id); return e && clone(e); },
    /** 这个 id 用过没有 (含墓碑): 自己配 id 的调用方 (续问序号 / 交接续答) 据此避开撞号。 */
    known: (id: string) => db.get(id) !== undefined,
    ids: () => Object.keys(db.all()),
    /** 只问执行态 (含墓碑): 判「这份投过没有」的调用方不必在乎它是不是已被裁掉。 */
    executionOf: (id: string) => db.get(id)?.execution,
    status: () => scan(() => {
      const parts = partsByEvent();
      return { events: liveRows().map((e) => view(e, parts.get(e.id) ?? [])), deliveries: Object.values(outbox.all()).map(clone) };
    }),
    /** 一条 event 的 status 视图 —— 轮询单条的调用方 (回归脚本) 不必为它把全表算一遍。 */
    event: (id: string) => { const e = live(id); return e && scan(() => view(e, partsByEvent().get(id) ?? [])); },
    deliveryStatus: (id: string) => outbox.get(id)?.parts.map((p) => p.state),
    reconcile: async (id: string) => { const e = live(id); if (e) await observe(e); return live(id); },
  };
};
export type MessageEvents = ReturnType<typeof createMessageEvents>;
