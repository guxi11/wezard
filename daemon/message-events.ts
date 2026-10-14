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
}
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
export interface EventTransport { ok: boolean; uncertain?: boolean; retryable?: boolean; reason?: string }
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
  /** 这一轮有定论了 (result 落定 / 重放恢复 / 读到 CLI 报错收尾): 路由表据此落 mark / answer
   *  (§9.4)。与 `recovered` 并排 —— 后者管投递恢复, 它管路由判定。可选: 没有它的消费者
   *  (测试夹具 / 老装配) 照常跑, 只是不做路由判定。 */
  final?: (event: MessageEvent, verdict: FinalVerdict) => void;
  format?: (delivery: DeliveryInput) => DeliveryInput;
  send: (delivery: FinalDelivery, part: number) => Promise<{ ack?: string; uncertain?: string; queued?: boolean; failed?: string }>;
  deliveryEvidence?: (delivery: FinalDelivery, part: number) => { ack?: string; state: "queued" | "delivered" | "uncertain" | "failed"; reason?: string } | undefined;
  error: (error: unknown) => void;
}
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
  const db = loadJsonMap<MessageEvent>(file, undefined, { strict: true });
  const outbox = loadJsonMap<FinalDelivery>(`${file}.finals`, undefined, { strict: true });
  Object.entries(db.all()).forEach(([id, e]) => {
    if (!e || e.id !== id || typeof e.fingerprint !== "string" || !e.target || typeof e.speaker !== "string" || typeof e.channel !== "string" || (e.serves !== undefined && typeof e.serves !== "string") || !e.payload || typeof e.payload.text !== "string" || (!e.payload.human === !e.payload.peer) || !Number.isFinite(e.at) || !Number.isFinite(e.attempts) || !Number.isFinite(e.deadline) || !["queued", "dispatching", "awaiting-result", "complete", "canceled", "uncertain"].includes(e.execution)) throw new Error(`invalid message event ${id}`);
  });
  Object.entries(outbox.all()).forEach(([id, d]) => {
    if (!d || d.id !== id || !Array.isArray(d.parts) || d.parts.length !== d.chunks?.length || !d.chunks.every((c) => typeof c === "string") || !d.parts.every((p) => ["pending", "sending", "waiting-ack", "delivered", "uncertain", "failed"].includes(p.state)) || !d.channel) throw new Error(`invalid final delivery ${id}`);
  });
  let stopped = true;
  let accepting = true;
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
  // An exposed event belongs to the session that received it, not a replacement
  // pane now bound to the same wizard. Keep its uncertain history for reconciliation.
  const resourceOf = (e: MessageEvent): string => {
    const transcript = io.transcript(e.target);
    const sessionId = io.sessionId(e.target);
    if (e.exposure === "none") return io.resource(e.target);
    if (e.sessionId) return e.sessionId === sessionId ? io.resource(e.target) : `session:${e.sessionId}`;
    if (e.transcript) return e.transcript === transcript ? io.resource(e.target) : `transcript:${e.transcript}`;
    return io.resource(e.target);
  };
  const bounded = <T>(id: string, read: () => Promise<T>): Promise<T> => {
    const e = db.get(id);
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
  const patch = (id: string, p: Partial<MessageEvent>): MessageEvent => db.set(id, { ...db.get(id)!, ...p });
  const part = (id: string, n: number, p: Partial<FinalDelivery["parts"][number]>): void => {
    const d = outbox.get(id)!;
    outbox.set(id, { ...d, parts: d.parts.map((x, i) => i === n ? { ...x, ...p } : x) });
  };
  const cancel = (select: (e: MessageEvent) => boolean, reason = "canceled by owner"): number => {
    const rows = Object.values(db.all()).filter((e) => !["complete", "canceled"].includes(e.execution) && select(e));
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
    const old = db.get(input.id);
    if (old && old.fingerprint !== fingerprint) throw new Error(`event identity conflict: ${input.id}`);
    let e = old;
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
    const e = db.get(id);
    if (!e || e.result?.revision === revision) return;
    patch(id, { finalized: false, result: { body, revision, at: Date.now() }, execution: "complete", exposure: "consumed", ...(turn ? { turn } : {}) });
    io.final?.(db.get(id)!, { text: body });
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
    const current = db.get(e.id)!;
    if (["complete", "canceled"].includes(current.execution)) return;
    if (current.exposure !== "consumed" || (evidence.closedAt && !current.turnClosedAt)) patch(e.id, {
      exposure: "consumed", interjected: evidence.interjected,
      execution: current.canceled || (evidence.closedAt && !evidence.body) ? "uncertain" : "awaiting-result",
      reason: current.canceled ? current.reason : evidence.closedAt && !evidence.body
        ? "input turn closed without a final assistant answer; delivery remains uncertain and will not be retried" : undefined,
      ...(evidence.closedAt ? { turnClosedAt: evidence.closedAt } : {}), turn: evidence.turn ?? current.turn,
    });
    if (!current.canceled) io.committed(db.get(e.id)!);
    if (evidence.body !== undefined && evidence.error) {
      // CLI 报错收尾: 那段报错不是定论 (§5), 交路由表落中途态 —— 事件本身不动, 它的执行态
      // 自有 deadline / 续跑那条路管 (与改动前一致)。
      io.final?.(db.get(e.id)!, { text: evidence.body, error: true });
    } else if (evidence.body !== undefined && evidence.revision) {
      result(e.id, evidence.body, evidence.revision, evidence.turn);
      io.recovered(db.get(e.id)!);
    }
  };
  /** 收件箱里的回执事件 (`rcpt:<event>:<rev>`): 只有它带路由归属 (serves), 也只有它该合并。 */
  const isRcpt = (e: MessageEvent): boolean => e.id.startsWith("rcpt:") && !!e.serves;
  /** §9.3 Aggregator: 同一个 target、服务同一笔 (`serves` = `receiver.event`) 还排着队的其它回执,
   *  并进这一次注入 —— 扇出的兄弟陆续回来时是一轮, 不是一人一轮。被吸收的那些各自收口
   *  (`execution: complete`, 它们的 id 已终态, 重放不再注入); 结论由这一轮的终句统一交代。
   *  回执的正文与信封是分开的两件 (`payload.text` 不含信封), 所以并的只是正文, 信封留注入那一份。 */
  const absorb = (id: string): void => {
    const e = db.get(id);
    if (!e || !isRcpt(e)) return;
    const absorbed = Object.values(db.all())
      .filter((x) => x.id !== e.id && isRcpt(x) && x.target === e.target && x.serves === e.serves
        && x.execution === "queued" && !x.canceled)
      .sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : 1));
    if (!absorbed.length) return;
    patch(e.id, { payload: { ...e.payload, text: [e.payload.text,
      ...absorbed.map((x) => `（另一份回执 ${x.id} · ${x.speaker}）\n${x.payload.text}`)].join("\n\n") } });
    absorbed.forEach((x) => patch(x.id, { execution: "complete", exposure: "consumed", finalized: true, reason: `merged into ${e.id}` }));
  };
  const inject = async (id: string, resource: string): Promise<void> => {
    active.add(resource);
    targets.add(db.get(id)!.target);
    try {
      absorb(id);
      const e = db.get(id)!;
      if (stopped || e.execution !== "queued" || !io.valid(e)) return;
      io.accepted(e);
      patch(id, { execution: "dispatching", attempts: e.attempts + 1, transcript: io.transcript(e.target) ?? e.transcript });
      const boundary = (phase?: "paste" | "submit", identity?: { sessionId?: string; transcript?: string }): boolean => {
        const current = db.get(id)!;
        if (stopped || current.canceled || !io.valid(current)) return false;
        if (current.exposure !== "none" && current.transcript && current.transcript !== io.transcript(e.target)) return false;
        if (phase) patch(id, { exposure: "possible", sessionId: identity?.sessionId,
          transcript: identity?.transcript ?? io.transcript(e.target) ?? current.transcript });
        return true;
      };
      let r: EventTransport;
      try { r = await io.inject(db.get(id)!, boundary); }
      catch (error) { r = { ok: false, uncertain: db.get(id)!.exposure !== "none", retryable: db.get(id)!.exposure === "none", reason: why(error) }; }
      const latest = db.get(id)!;
      if (latest.result || latest.execution === "complete") { if (!latest.canceled) io.committed(latest); return; }
      if (r.ok && !r.uncertain) {
        const committed = patch(id, { execution: latest.canceled ? "uncertain" : "awaiting-result", exposure: "submitted", transcript: latest.transcript ?? io.transcript(e.target) });
        if (!latest.canceled) io.committed(committed);
      } else if (r.retryable && !r.uncertain && !latest.canceled) {
        patch(id, { execution: "queued", exposure: "none", retryAt: backoff(latest.attempts), reason: r.reason });
      } else patch(id, { execution: "uncertain", reason: r.reason || "submission acknowledgement unknown" });
    } catch (e) {
      try { patch(id, { reason: why(e), retryAt: backoff(db.get(id)!.attempts) }); } catch { accepting = false; stopped = true; clearInterval(timer); timer = undefined; }
      io.error(e);
    }
    finally { active.delete(resource); targets.delete(db.get(id)!.target); void pump(); }
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
  const pinOf = (e: MessageEvent): MessageEvent | undefined => {
    const rows = Object.values(db.all()).sort((a, b) => a.at - b.at);
    const resource = io.resource(e.target);
    const older = new Set(rows.slice(0, rows.findIndex((x) => x.id === e.id)).map((x) => x.id));
    return rows.find((x) => x.id !== e.id && resourceOf(x) === resource
      && (x.execution === "dispatching"
        || (!direct(e) && ((x.execution === "uncertain" && !x.releasedAt)
          || (e.priority === "normal" && (x.execution === "awaiting-result"
            || (x.execution === "queued" && (x.retryAt ?? 0) <= Date.now() && older.has(x.id))))))));
  };
  const injectable = (e: MessageEvent): boolean =>
    !stopped && e.execution === "queued" && !e.canceled && e.deadline > Date.now() && io.valid(e)
    && !targets.has(e.target) && !active.has(io.resource(e.target)) && active.size < 4
    && pinOf(e) === undefined;
  const blocker = (id: string): { id: string; execution: MessageEvent["execution"]; reason: string } | undefined => {
    const e = db.get(id);
    if (!e || e.execution !== "queued") return undefined;
    const hit = pinOf(e);
    return hit ? { id: hit.id, execution: hit.execution,
      reason: hit.reason ?? (hit.execution === "uncertain" ? "旧事件投递结果不确定，需对账" : `等待较早事件（${hit.execution}）`) } : undefined;
  };
  const release = (id: string, reason: string): { ok: boolean; event?: MessageEvent; reason?: string } => {
    const e = db.get(id);
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
    try {
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
      const rows = Object.values(db.all()).sort((a, b) => a.at - b.at);
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
        if (probing.has(e.id) || probeTargets.has(resourceOf(e)) || probeCount >= 16) return;
        probeCursor = (rows.findIndex((x) => x.id === e.id) + 1) % Math.max(1, rows.length);
        const failed = (error: unknown): void => {
          const current = db.get(e.id);
          if (!stopped && current && !["complete", "canceled"].includes(current.execution)) {
            const probeAttempts = (current.probeAttempts ?? 0) + 1;
            patch(e.id, { probeAttempts, retryAt: backoff(probeAttempts), reason: `${current.reason ? `${current.reason}; ` : ""}${why(error)}` });
          }
          io.error(error);
        };
        if (["awaiting-result", "uncertain"].includes(e.execution)) {
          if (e.execution === "uncertain" && (e.turnClosedAt || e.releasedAt)) return;
          if ((e.retryAt ?? 0) > Date.now()) return;
          const currentSession = io.sessionId(e.target);
          const currentTranscript = io.transcript(e.target);
          const replaced = e.exposure !== "none" && (e.sessionId
            ? e.sessionId !== currentSession : !!e.transcript && e.transcript !== currentTranscript);
          if (replaced && !e.supersededBy) patch(e.id, { supersededBy: currentSession ?? (currentTranscript ? `transcript:${currentTranscript}` : "replacement-session-unavailable"),
            reason: `${e.reason ? `${e.reason}; ` : ""}session replaced; old execution remains uncertain pending transcript reconciliation` });
          void observe(e).then(() => {
            if (!stopped && e.deadline <= Date.now() && db.get(e.id)!.execution === "awaiting-result")
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
        if ((e.retryAt ?? 0) > Date.now()) return;
        if (injectable(e)) void bounded(e.id, () => io.ready(e)).then((ready) => {
          const current = db.get(e.id)!;
          if (ready && injectable(current)) void inject(e.id, io.resource(current.target));
        }).catch(failed);
      });
    } catch (e) { io.error(e); }
    finally { pumping = false; }
  }
  const resume = (): void => {
    Object.values(db.all()).filter((e) => e.execution === "dispatching").forEach((e) => patch(e.id, {
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
    accept, pump, resume, result, delivery, cancel, blocker, release,
    running: () => !stopped,
    bind: (id: string, turn: string) => { if (db.get(id)) patch(id, { turn }); },
    finished: (id: string) => { const e = db.get(id); if (e && !e.canceled && !e.result) patch(id, { execution: "complete", exposure: "consumed" }); },
    released: (id: string) => { const e = db.get(id); if (e?.canceled) patch(id, { execution: "canceled", reason: `${e.reason ?? "canceled"}; pane idle confirmed` }); },
    stopped: (target: string, reason: string) => Object.values(db.all()).filter((e) => e.target === target && e.canceled).forEach((e) => patch(e.id, { execution: "canceled", reason })),
    submission: async (id: string): Promise<EventTransport> => {
      for (;;) {
        const e = db.get(id);
        if (!e) return { ok: false, retryable: true, reason: "event missing" };
        if (["submitted", "consumed"].includes(e.exposure)) return { ok: true };
        if (e.execution === "uncertain" || stopped) return { ok: false, uncertain: true, reason: e.reason || "scheduler stopped" };
        if (e.execution === "canceled") return { ok: false, reason: e.reason };
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    },
    stop: () => { accepting = false; stopped = true; clearInterval(timer); timer = undefined; },
    get: (id: string) => { const e = db.get(id); return e && clone(e); },
    status: () => ({ events: Object.values(db.all()).map((e) => ({ ...clone(e),
      status: e.execution === "dispatching" ? "executing" : e.execution,
      ...(e.execution === "queued" && blocker(e.id) ? { blockedBy: blocker(e.id) } : {}),
      delivery: (() => { const parts = Object.values(outbox.all()).filter((d) => d.eventId === e.id).flatMap((d) => d.parts);
        return parts.some((p) => p.state === "failed") ? "failed" : parts.some((p) => p.state === "uncertain") ? "uncertain" : parts.some((p) => p.state !== "delivered") ? "delivery-pending" : parts.length ? "delivered" : "none"; })(),
    })), deliveries: Object.values(outbox.all()).map(clone) }),
    deliveryStatus: (id: string) => outbox.get(id)?.parts.map((p) => p.state),
    reconcile: async (id: string) => { const e = db.get(id); if (e) await observe(e); return db.get(id); },
  };
};
export type MessageEvents = ReturnType<typeof createMessageEvents>;
