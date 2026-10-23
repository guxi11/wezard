import { appendFileSync, closeSync, existsSync, ftruncateSync, fsyncSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { expandHome } from "../shared/paths.js";
import { PlanInputSchema, PlanOriginSchema, PlanRecordSchema, PlanUpdateSchema, validatePlan, type PlanInput, type PlanOrigin, type PlanRecord, type PlanUpdate } from "../shared/plan.js";
import { z } from "zod";

const CreateKeySchema = z.object({ id: z.string().min(1), hash: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const JournalEntrySchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("create"), plan: PlanRecordSchema, request: CreateKeySchema.optional() }).strict(),
  z.object({ op: z.literal("update"), plan: PlanRecordSchema }).strict(),
  z.object({ op: z.literal("reminded"), plan: PlanRecordSchema }).strict(),
]);
type JournalEntry = z.infer<typeof JournalEntrySchema>;

export class PlanError extends Error {
  constructor(readonly status: 400 | 403 | 404 | 409 | 503, message: string) { super(message); }
}

const clonePlan = (plan: PlanRecord): PlanRecord => ({
  ...plan,
  tasks: plan.tasks.map((task) => ({ ...task, dependsOn: [...task.dependsOn] })),
  ...(plan.origin ? { origin: { ...plan.origin, ...(plan.origin.asker ? { asker: { ...plan.origin.asker } } : {}) } } : {}),
  ...(plan.reminder ? { reminder: { ...plan.reminder } } : {}),
});
const withoutReminder = (plan: PlanRecord): Omit<PlanRecord, "reminder"> => {
  const { reminder: _reminder, ...core } = plan;
  return core;
};
const requestKey = (owner: string, id: string): string => JSON.stringify([owner, id]);
const inputHash = (input: PlanInput): string => {
  const { requestId: _requestId, ...content } = input;
  return createHash("sha256").update(JSON.stringify(content)).digest("hex");
};
const time = (at: number): void => {
  if (!Number.isFinite(at) || at < 0) throw new PlanError(400, "timestamp must be a finite nonnegative number");
};

const validateRecord = (plan: PlanRecord): void => {
  const error = validatePlan(plan);
  if (error) throw new Error(`invalid plan '${plan.id}': ${error}`);
};

const replay = (line: string, plans: Map<string, PlanRecord>, requests: Map<string, { id: string; hash: string }>): void => {
  const entry = JournalEntrySchema.parse(JSON.parse(line)) as JournalEntry;
  const next = entry.plan;
  validateRecord(next);
  const old = plans.get(next.id);
  if (entry.op === "create") {
    if (old || next.revision !== 1) throw new Error(`duplicate or invalid plan creation '${next.id}'`);
    if (entry.request) {
      const key = requestKey(next.owner, entry.request.id);
      if (requests.has(key)) throw new Error(`duplicate plan creation request '${entry.request.id}'`);
      requests.set(key, { id: next.id, hash: entry.request.hash });
    }
    plans.set(next.id, clonePlan(next));
    return;
  }
  if (!old || old.owner !== next.owner || old.createdAt !== next.createdAt
    || JSON.stringify(old.origin) !== JSON.stringify(next.origin)) throw new Error(`plan journal changes identity '${next.id}'`);
  if (entry.op === "update") {
    if (["completed", "canceled"].includes(old.state) || next.revision !== old.revision + 1 || next.reminder)
      throw new Error(`invalid plan revision '${next.id}'`);
    plans.set(next.id, clonePlan(next));
    return;
  }
  if (["completed", "canceled"].includes(old.state) || next.revision !== old.revision || !next.reminder
    || JSON.stringify(withoutReminder(old)) !== JSON.stringify(withoutReminder(next)))
    throw new Error(`invalid plan reminder journal entry '${next.id}'`);
  plans.set(next.id, clonePlan(next));
};

export const loadPlans = (file: string) => {
  if (!file.trim()) throw new Error("plans file path is required");
  const abs = expandHome(file);
  const plans = new Map<string, PlanRecord>();
  const requests = new Map<string, { id: string; hash: string }>();
  let healthy = true;
  let failureReason: string | undefined;
  try {
    mkdirSync(dirname(abs), { recursive: true, mode: 0o700 });
    const existed = existsSync(abs);
    const fd = openSync(abs, "a+", 0o600);
    try {
      const text = readFileSync(abs, "utf8");
      const end = text.lastIndexOf("\n") + 1;
      const complete = text.slice(0, end);
      for (const line of complete.split("\n").filter(Boolean)) replay(line, plans, requests);
      if (end !== text.length) {
        ftruncateSync(fd, Buffer.byteLength(complete));
        fsyncSync(fd);
      }
      if (!existed) {
        const dir = openSync(dirname(abs), "r");
        try { fsyncSync(dir); } finally { closeSync(dir); }
      }
    } finally { closeSync(fd); }
  } catch (error) {
    healthy = false;
    failureReason = (error as Error).message;
  }

  const ensureHealthy = (): void => {
    if (!healthy) throw new PlanError(503, `plans store unavailable; reload is required: ${failureReason ?? "unknown initialization failure"}`);
  };
  const append = (entry: JournalEntry): void => {
    ensureHealthy();
    try {
      appendFileSync(abs, `${JSON.stringify(entry)}\n`, { encoding: "utf8", mode: 0o600 });
      const fd = openSync(abs, "a");
      try { fsyncSync(fd); } finally { closeSync(fd); }
    } catch (error) {
      healthy = false;
      failureReason = `journal write failed: ${(error as Error).message}`;
      throw new PlanError(503, `plans store unavailable; reload is required: ${failureReason}`);
    }
  };

  const getStored = (id: string): PlanRecord | undefined => plans.get(id);
  const getOwned = (owner: string, id: string): PlanRecord => {
    ensureHealthy();
    const plan = getStored(id);
    if (!plan) throw new PlanError(404, "plan not found");
    if (plan.owner !== owner) throw new PlanError(403, "only the plan owner may update it");
    return plan;
  };

  return {
    all: (): PlanRecord[] => { ensureHealthy(); return [...plans.values()].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id)).map(clonePlan); },
    get: (id: string): PlanRecord | undefined => { ensureHealthy(); const plan = getStored(id); return plan && clonePlan(plan); },
    list: (owner: string): PlanRecord[] => { ensureHealthy(); return [...plans.values()].filter((plan) => plan.owner === owner)
      .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id)).map(clonePlan); },
    create: (owner: string, raw: unknown, at = Date.now(), origin?: PlanOrigin): PlanRecord => {
      ensureHealthy();
      if (!owner) throw new PlanError(400, "plan owner is required");
      time(at);
      const input = PlanInputSchema.parse(raw);
      const taskError = validatePlan({ tasks: input.tasks, state: "active" });
      if (taskError) throw new PlanError(400, taskError);
      const hash = inputHash(input);
      if (input.requestId) {
        const old = requests.get(requestKey(owner, input.requestId));
        if (old) {
          if (old.hash !== hash) throw new PlanError(409, "requestId was already used with different plan content");
          const existing = getStored(old.id);
          if (!existing) throw new PlanError(503, "plan creation index is inconsistent; reload is required");
          return clonePlan(existing);
        }
      }
      const plan = PlanRecordSchema.parse({
        id: randomUUID(), owner, title: input.title, ...(input.description ? { description: input.description } : {}),
        ...(origin ? { origin: PlanOriginSchema.parse(origin) } : {}),
        tasks: input.tasks, state: "active", revision: 1, createdAt: at, updatedAt: at,
      });
      append({ op: "create", plan, ...(input.requestId ? { request: { id: input.requestId, hash } } : {}) });
      plans.set(plan.id, clonePlan(plan));
      if (input.requestId) requests.set(requestKey(owner, input.requestId), { id: plan.id, hash });
      return clonePlan(plan);
    },
    update: (owner: string, id: string, raw: unknown, at = Date.now()): PlanRecord => {
      ensureHealthy();
      time(at);
      const old = getOwned(owner, id);
      const input = PlanUpdateSchema.parse(raw);
      if (input.revision !== old.revision) throw new PlanError(409, `stale plan revision; current revision is ${old.revision}`);
      if (old.state === "completed" || old.state === "canceled") throw new PlanError(409, `plan is already ${old.state}`);
      const state = input.state ?? old.state;
      const tasks = input.tasks ?? old.tasks;
      const next = PlanRecordSchema.parse({
        id: old.id, owner: old.owner, title: input.title ?? old.title,
        ...(old.origin ? { origin: old.origin } : {}),
        ...((input.description === undefined ? old.description : input.description.trim()) ? { description: input.description === undefined ? old.description : input.description.trim() } : {}),
        tasks, state,
        ...(state === "paused" || state === "canceled"
          ? ((input.reason === undefined ? old.reason : input.reason.trim()) ? { reason: input.reason === undefined ? old.reason : input.reason.trim() } : {})
          : {}),
        revision: old.revision + 1, createdAt: old.createdAt, updatedAt: at,
      });
      const error = validatePlan(next);
      if (error) throw new PlanError(409, error);
      append({ op: "update", plan: next });
      plans.set(id, clonePlan(next));
      return clonePlan(next);
    },
    hasUnfinished: (owner: string): boolean => {
      ensureHealthy();
      return [...plans.values()].some((plan) => plan.owner === owner && !["completed", "canceled"].includes(plan.state));
    },
    healthy: (): boolean => healthy,
    reminded: (id: string, revision: number, token: string, eventId: string, at = Date.now()): boolean => {
      ensureHealthy();
      time(at);
      const old = getStored(id);
      if (!old || old.revision !== revision || old.state !== "active") return false;
      if (old.reminder?.revision === revision && old.reminder.token === token) {
        if (old.reminder.eventId !== eventId) throw new PlanError(409, "plan reminder token already belongs to another event");
        return false;
      }
      const next = PlanRecordSchema.parse({ ...old, reminder: { revision, token, eventId, at } });
      append({ op: "reminded", plan: next });
      plans.set(id, clonePlan(next));
      return true;
    },
  };
};

export type PlanStore = ReturnType<typeof loadPlans>;
export type { PlanInput, PlanRecord, PlanState, PlanTask, PlanUpdate } from "../shared/plan.js";
