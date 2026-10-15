import { baseOfKey, keyOf, normalizeTag } from "../shared/session-label.js";
import { randomUUID } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { z } from "zod";
import { loadJsonMap } from "../shared/json-map-store.js";
import { WorkflowPlanSchema, type WorkflowPlan, type WorkflowPlanNode } from "../shared/workflow-plan.js";
import type { Asker } from "../shared/detail-store.js";
import type { JobRecord } from "./jobs.js";
import type { NodeAttempt } from "./workflow-nodes.js";
import type { Prereq } from "./dispatch.js";

const OriginSchema = z.object({
  // 发起者那一笔的路由 event (docs/evolve/receipt-router.md §9.5): 节点开行挂在它下面 (同 tell)。
  // 老 run 没有 —— 节点只能另起一根, 不猜。
  event: z.string().optional(),
  asker: z.object({ who: z.string(), chat: z.string() }).strict().optional(),
  // T10: 老 run 的 k / stack / chain 不再读 (边由 receiver 算), 但照收 —— 已经落盘的 run
  // 不该因为换了一版就加载失败 (`.strict()` 会把不认识的键判成非法)。
  k: z.unknown().optional(),
  stack: z.unknown().optional(),
  chain: z.unknown().optional(),
}).strict();
export interface PlanOrigin { event?: string; asker?: Asker }
const PhaseSchema = z.enum(["waiting", "spawning", "spawn-unknown", "spawned", "dispatching", "observing", "blocked"]);
const NodeStateSchema = z.object({
  id: z.string(), turn: z.string().min(1), name: z.string().min(1), phase: PhaseSchema,
  to: z.string().optional(), reason: z.string().optional(), birth: z.record(z.unknown()).optional(),
}).strict();
export type PlanNodeState = z.infer<typeof NodeStateSchema>;
const RunSchema = z.object({
  id: z.string().min(1), owner: z.string().min(1), plan: WorkflowPlanSchema,
  origin: OriginSchema, at: z.number().finite(),
  state: z.enum(["active", "completed", "failed", "canceled"]), reason: z.string().optional(),
  nodes: z.array(NodeStateSchema),
}).strict();
export type PlanRun = z.infer<typeof RunSchema>;
// Only the runner can supply this capability; HTTP request fields never become it.
export interface PlanPermit { run: string; node: string; turn: string; origin: PlanOrigin; alive: () => boolean }

export const loadWorkflowPlans = (file: string, prereq: (owner: string, turn: string) => Prereq | undefined) => {
  const db = loadJsonMap<PlanRun>(file, undefined, { strict: true });
  let healthy = true;
  const all = (): PlanRun[] => structuredClone(Object.values(db.all()));
  all().forEach((r) => {
    RunSchema.parse(r);
    if (r.nodes.length !== r.plan.nodes.length || r.nodes.some((n, i) => n.id !== r.plan.nodes[i]?.id)
      || new Set(r.nodes.map((n) => n.turn)).size !== r.nodes.length
      || new Set(r.nodes.map((n) => n.name)).size !== r.nodes.length
      || r.nodes.some((n) => ["spawned", "dispatching", "observing"].includes(n.phase) && (!n.to || n.birth?.target !== n.to || n.birth?.name !== n.name))) throw new Error("invalid workflow plan identities");
  });
  if (Object.entries(db.all()).some(([id, r]) => id !== r.id)
    || new Set(all().flatMap((r) => r.nodes.map((n) => n.turn))).size !== all().reduce((sum, r) => sum + r.nodes.length, 0)) throw new Error("duplicate workflow plan run/turn identity");
  if (new Set(all().map((r) => r.plan.job)).size !== all().length) throw new Error("duplicate workflow plan job");
  const write = (r: PlanRun): PlanRun => {
    try { db.set(r.id, r); } catch (e) { healthy = false; throw e; }
    return structuredClone(r);
  };
  const get = (id: string): PlanRun | undefined => { const r = db.get(id); return r && structuredClone(r); };
  const change = (id: string, f: (r: PlanRun) => PlanRun): PlanRun => {
    const r = get(id);
    if (!r) throw new Error("workflow plan not found");
    return write(f(r));
  };
  // A birth may exist even if its result was never committed. Do not create another.
  all().filter((r) => r.nodes.some((n) => n.phase === "spawning")).forEach((r) => write({ ...r, nodes: r.nodes.map((n) => n.phase === "spawning" ? { ...n, phase: "spawn-unknown", reason: "spawn interrupted; reconcile executor by recorded name, then cancel this segment" } : n) }));
  const ofJob = (job: string): PlanRun | undefined => all().find((r) => r.plan.job === job);
  // Reserve logical addresses before birth, and physical keys after reconciliation.
  // Terminal runs retain their reservations: cancellation never frees a pane for
  // untracked task injection or silently resurrects the segment.
  const reservation = (target?: string, name?: string): PlanRun | undefined => all().find((r) => r.nodes.some((n) =>
    n.name === normalizeTag(name) || (!!target && (n.to === target || keyOf(baseOfKey(r.owner), n.name) === target))));
  const owned = (owner: string, id: string): PlanRun => {
    const r = get(id);
    if (!r || r.owner !== owner) throw new Error("workflow plan not found for owner");
    return r;
  };
  const permitted = (owner: string, job: string, p?: PlanPermit): boolean => {
    const r = ofJob(job);
    return healthy && !!r && r.state === "active" && r.owner === owner && !!p && p.run === r.id
      && r.nodes.some((n) => n.id === p.node && n.turn === p.turn) && p.alive();
  };
  return {
    all, get, owned, ofJob, reservation, allowExternal: (target?: string, name?: string): boolean => healthy && !reservation(target, name), healthy: () => healthy,
    create: (owner: string, input: unknown, origin: PlanOrigin, job: JobRecord, attempts: NodeAttempt[], occupied: boolean): PlanRun => {
      const plan = WorkflowPlanSchema.parse(input);
      if (job.id !== plan.job || job.owner !== owner || job.status !== "open") throw new Error("plan requires your open job");
      if (ofJob(plan.job) || job.members.length || (job.turns ?? 0) || attempts.length || occupied) throw new Error("plan requires a dedicated empty job; one immutable segment per job");
      if (job.maxTurns && job.maxTurns < plan.nodes.length) throw new Error("job budget cannot cover this plan");
      if (!statSync(plan.cwd).isDirectory()) throw new Error("cwd must be a directory");
      const id = `w${randomUUID().replace(/-/g, "")}`;
      return write({ id, owner, plan: { ...plan, cwd: realpathSync(plan.cwd) }, origin: OriginSchema.parse(origin), at: Date.now(), state: "active",
        nodes: plan.nodes.map((n, i) => ({ id: n.id, phase: "waiting", turn: `t${randomUUID().replace(/-/g, "")}`, name: `wf-${id.slice(1, 13)}-${i + 1}` })) });
    },
    node: (id: string, node: string, patch: Partial<Omit<PlanNodeState, "id" | "turn" | "name">>): PlanRun => change(id, (r) => {
      const old = r.nodes.find((n) => n.id === node);
      if (!old) throw new Error("plan node not found");
      const moves: Record<PlanNodeState["phase"], string[]> = { waiting: ["spawning"], spawning: ["spawned", "spawn-unknown"], "spawn-unknown": [], spawned: ["dispatching"], dispatching: ["observing", "blocked"], observing: [], blocked: [] };
      if (patch.phase && patch.phase !== old.phase && !moves[old.phase].includes(patch.phase)) throw new Error("illegal plan node transition");
      const next = NodeStateSchema.parse({ ...old, ...patch });
      if (["spawned", "dispatching", "observing"].includes(next.phase) && !next.to) throw new Error("plan node requires executor identity");
      return { ...r, nodes: r.nodes.map((n) => n.id === node ? next : n) };
    }),
    end: (id: string, state: "completed" | "failed" | "canceled", reason: string): PlanRun => change(id, (r) => r.state !== "active" ? r : { ...r, state, reason }),
    allowSpawn: (owner: string, job: string, p?: PlanPermit, name?: string, target?: string): boolean => {
      const reserved = reservation(target, name);
      const r = reserved ?? ofJob(job);
      const node = p && r?.nodes.find((n) => n.id === p.node);
      return !r || (r.plan.job === job && permitted(owner, job, p) && node?.phase === "spawning"
        && (!name || normalizeTag(name) === node.name) && (!target || target === (node.to ?? keyOf(baseOfKey(r.owner), node.name))));
    },
    allowTell: (owner: string, job: string, node: string, target: string, re: string, p?: PlanPermit, name?: string): boolean => {
      const r = reservation(target, name) ?? ofJob(job);
      if (!r) return true;
      if (!healthy || r.state !== "active" || r.owner !== owner || r.plan.job !== job) return false;
      const n = r.nodes.find((n) => n.to === target && n.id === node);
      const depsValid = (r.plan.nodes.find((x) => x.id === node)?.after ?? []).every((id) => prereq(owner, r.nodes.find((n) => n.id === id)!.turn)?.state === "done");
      return !!n && depsValid && (p ? permitted(owner, job, p) && p.node === node && n.phase === "dispatching" : re === n.turn && n.phase === "observing");
    },
  };
};
export type WorkflowPlans = ReturnType<typeof loadWorkflowPlans>;
interface RunnerDeps {
  job: (id: string) => JobRecord | undefined;
  attempt: (owner: string, turn: string) => NodeAttempt | undefined;
  prereq: (owner: string, turn: string) => Prereq | undefined;
  spawn: (run: PlanRun, node: WorkflowPlanNode, state: PlanNodeState, p: PlanPermit) => Promise<{ status: number; body: Record<string, unknown> }>;
  tell: (run: PlanRun, node: WorkflowPlanNode, state: PlanNodeState, after: string[], p: PlanPermit) => Promise<{ status: number; body: Record<string, unknown> }>;
  cancel: (run: PlanRun) => void;
  error: (e: unknown) => void;
}

export const createWorkflowPlanRunner = (store: WorkflowPlans, d: RunnerDeps) => {
  const locks = new Set<string>();
  const dirty = new Set<string>();
  let started = false;
  const attemptOf = (r: PlanRun, n: PlanNodeState) => {
    const a = d.attempt(r.owner, n.turn);
    if (a && (a.node !== n.id || a.job !== r.plan.job || a.to !== n.to)) throw new Error("plan attempt identity mismatch");
    return a;
  };
  const prereqOf = (r: PlanRun, n: PlanNodeState) => {
    attemptOf(r, n);
    return d.prereq(r.owner, n.turn);
  };
  const valid = (r: PlanRun, node: WorkflowPlanNode): boolean => (node.after ?? []).every((id) => {
    const n = r.nodes.find((n) => n.id === id)!;
    return prereqOf(r, n)?.state === "done";
  });
  const alive = (id: string, node: string): boolean => {
    const r = store.get(id);
    return store.healthy() && started && !!r && r.state === "active" && d.job(r.plan.job)?.status === "open" && d.job(r.plan.job)?.owner === r.owner && valid(r, r.plan.nodes.find((n) => n.id === node)!);
  };
  const cancel = (owner: string, id: string, reason: string): PlanRun => {
    const old = store.owned(owner, id);
    if (!["active", "canceled"].includes(old.state)) throw new Error("terminal workflow plan cannot be canceled or resumed");
    const r = store.end(old.id, "canceled", reason);
    d.cancel(r);
    return r;
  };
  const advance = async (id: string): Promise<void> => {
    if (!started || !store.healthy()) return;
    if (locks.has(id)) { dirty.add(id); return; }
    locks.add(id);
    try {
      let r = store.get(id);
      if (!r || r.state !== "active") return;
      const job = d.job(r.plan.job);
      if (job?.status !== "open" || job.owner !== r.owner) { cancel(r.owner, r.id, "job closed or unavailable"); return; }
      const failed = r.nodes.find((n) => prereqOf(r!, n)?.state === "failed");
      if (failed) { store.end(id, "failed", `node ${failed.id} failed/rejected or artifact version changed`); return; }
      if (r.nodes.every((n) => prereqOf(r!, n)?.state === "done")) { store.end(id, "completed", "all nodes explicitly accepted with valid versions"); return; }
      // Reconcile a crash between tell completion and writing the plan pointer.
      for (const n of r.nodes.filter((n) => n.phase === "dispatching")) {
        const a = attemptOf(r, n);
        r = store.node(id, n.id, { phase: a ? "observing" : "blocked", ...(a ? {} : { reason: "dispatch intent has no attempt; no automatic replay" }) });
      }
      const pending = r.nodes.filter((n) => prereqOf(r!, n)?.state !== "done");
      if (pending.some((n) => !["waiting", "spawned"].includes(n.phase))) return;
      const state = pending.find((n) => valid(r!, r!.plan.nodes.find((x) => x.id === n.id)!));
      if (!state) return;
      const node = r.plan.nodes.find((n) => n.id === state.id)!;
      if (job.maxTurns && (job.turns ?? 0) >= job.maxTurns) { store.end(id, "failed", "job dispatch budget exhausted before spawn"); return; }
      const p: PlanPermit = { run: id, node: node.id, turn: state.turn, origin: r.origin, alive: () => alive(id, node.id) };
      if (state.phase === "waiting") {
        r = store.node(id, node.id, { phase: "spawning" });
        const born = await d.spawn(r, node, r.nodes.find((n) => n.id === node.id)!, p);
        if (born.status !== 200 || typeof born.body.target !== "string" || !born.body.target || born.body.dispatched !== false
          || born.body.inherited !== false || born.body.cwd !== r.plan.cwd || born.body.name !== state.name) {
          store.node(id, node.id, { phase: "spawn-unknown", reason: String(born.body.reason ?? "executor creation unconfirmed"), birth: born.body });
          return;
        }
        // Even after cancellation, retain the executor identity for operator cleanup.
        r = store.node(id, node.id, { phase: "spawned", to: born.body.target, birth: born.body });
        if (!p.alive()) return;
      }
      if (!p.alive()) return;
      const current = store.get(id)!.nodes.find((n) => n.id === node.id)!;
      r = store.node(id, node.id, { phase: "dispatching" });
      const after = (node.after ?? []).map((dep) => r!.nodes.find((n) => n.id === dep)!.turn);
      const sent = await d.tell(r, node, current, after, p);
      const a = attemptOf(r, current);
      store.node(id, node.id, { phase: a ? "observing" : "blocked", ...(sent.status === 200 ? {} : { reason: String(sent.body.reason ?? "dispatch unconfirmed") }) });
      // Completion/version failure can happen during transport before its response.
      // Reconcile once after dropping the lock; never re-enter a dispatched node.
      dirty.add(id);
    } catch (e) {
      d.error(e);
      const r = store.get(id);
      if (store.healthy() && r?.state === "active") {
        const n = r.nodes.find((n) => ["spawning", "dispatching"].includes(n.phase));
        if (n) {
          try { store.node(id, n.id, { phase: n.phase === "spawning" ? "spawn-unknown" : d.attempt(r.owner, n.turn) ? "observing" : "blocked", reason: String(e) }); }
          catch (failure) { d.error(failure); }
        }
      }
    }
    finally {
      locks.delete(id);
      if (dirty.delete(id)) queueMicrotask(() => { void advance(id); });
    }
  };
  const kick = (): void => { if (started) store.all().filter((r) => r.state === "active").forEach((r) => { void advance(r.id); }); };
  const status = (owner: string, id: string) => {
    const r = store.owned(owner, id);
    const nodes = r.nodes.map((n) => {
      const a = attemptOf(r, n), prereq = prereqOf(r, n);
      const state = r.state === "canceled" ? "canceled" : prereq?.state === "failed" ? "failed"
        : prereq?.state === "done" ? "succeeded" : a ? a.execution === "terminal" && a.status === "done" ? "validating" : a.execution
          : n.phase === "waiting" ? r.state === "failed" ? "skipped" : valid(r, r.plan.nodes.find((x) => x.id === n.id)!) ? "ready" : "pending" : n.phase;
      return { ...n, state, ...(a ? { attempt: a } : {}), ...(r.state === "canceled" && a ? { physicalStopConfirmed: !!a.stopped } : {}) };
    });
    const versionsValid = r.nodes.every((n) => prereqOf(r, n)?.state === "done");
    return { ...r, state: r.state === "completed" && !versionsValid ? "invalidated" : r.state, recordedState: r.state, nodes, versionsValid, storageHealthy: store.healthy() };
  };
  return { kick, status, cancel, start: () => {
    // Cancellation is committed before touching other stores. Finish a partial
    // cancellation after restart without reopening the run or replaying tasks.
    store.all().filter((r) => r.state === "canceled").forEach((r) => { try { d.cancel(r); } catch (e) { d.error(e); } });
    started = true; kick();
  }, stop: () => { started = false; },
    cancelJob: (owner: string, job: string): void => { const r = store.ofJob(job); if (r?.owner === owner && r.state === "active") cancel(owner, r.id, "job closed"); } };
};
