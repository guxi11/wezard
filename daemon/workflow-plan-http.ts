import { WorkflowPlanSchema } from "../shared/workflow-plan.js";
import type { PlanOrigin, WorkflowPlans, createWorkflowPlanRunner } from "./workflow-plans.js";
import type { HttpServer } from "./http.js";
import { json } from "./http.js";
import type { IncomingMessage } from "node:http";
import type { JobRecord } from "./jobs.js";
import type { NodeAttempt } from "./workflow-nodes.js";

export const registerWorkflowPlanRoutes = (http: HttpServer, o: {
  read: (req: IncomingMessage) => Promise<{ self: string; body: unknown }>;
  store: WorkflowPlans; runner: ReturnType<typeof createWorkflowPlanRunner>;
  origin: (self: string) => PlanOrigin;
  job: (id: string) => JobRecord | undefined;
  attempts: (self: string, job: string) => NodeAttempt[];
  occupied: (self: string, job: string) => boolean;
  direction: (self: string, job: string, origin: PlanOrigin) => string | undefined;
}) => {
  const inputOf = (body: unknown): Record<string, unknown> => {
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("object required");
    const { sessionId: _sid, tmuxPane: _pane, target: _target, ...input } = body as Record<string, unknown>;
    return input;
  };
  http.register("POST /workflow/plans/create", async (req, res) => {
    const { self, body } = await o.read(req);
    if (!self) { json(res, 400, { ok: false, reason: "cannot resolve caller" }); return; }
    let input;
    try { input = WorkflowPlanSchema.parse(inputOf(body)); }
    catch (e) { json(res, 400, { ok: false, reason: (e as Error).message }); return; }
    const existing = o.store.ofJob(input.job);
    if (existing?.owner === self) {
      json(res, 409, { ok: false, reason: "one immutable segment per job; existing plan unchanged", existingRun: existing.id, hint: "workflow_plan_status({run:existingRun}) recovers a lost create response; this request does not restart or update it" });
      return;
    }
    const job = o.job(input.job);
    if (!job || job.owner !== self || job.status !== "open") { json(res, 409, { ok: false, reason: "plan requires your open job" }); return; }
    const origin = o.origin(self), denied = o.direction(self, job.id, origin);
    if (denied) { json(res, 409, { ok: false, reason: denied, gated: "direction" }); return; }
    try {
      const run = o.store.create(self, input, origin, job, o.attempts(self, job.id), o.occupied(self, job.id));
      o.runner.kick();
      json(res, 200, { ok: true, run: o.runner.status(self, run.id), hint: "immutable segment; owner must explicitly accept every result via workflow_verdict. NEED/error/unknown require reconciliation, never automatic retry. Cancel blocks new work but does not kill executing panes." });
    } catch (e) { json(res, 409, { ok: false, reason: (e as Error).message }); }
  });
  http.register("POST /workflow/plans/status", async (req, res) => {
    const { self, body } = await o.read(req);
    if (!self) { json(res, 400, { ok: false, reason: "cannot resolve caller" }); return; }
    try {
      const b = inputOf(body);
      if (Object.keys(b).some((k) => k !== "run") || typeof b.run !== "string" || !b.run) throw new Error("run required; unknown fields are not allowed");
      const run = o.runner.status(self, b.run);
      json(res, 200, { ok: true, run });
    } catch (e) { json(res, 409, { ok: false, reason: (e as Error).message }); }
  });
  http.register("POST /workflow/plans/cancel", async (req, res) => {
    const { self, body } = await o.read(req);
    if (!self) { json(res, 400, { ok: false, reason: "cannot resolve caller" }); return; }
    try {
      const b = inputOf(body);
      if (Object.keys(b).some((k) => !["run", "reason"].includes(k)) || typeof b.run !== "string" || typeof b.reason !== "string" || !b.reason.trim()) throw new Error("run and nonempty reason required; unknown fields are not allowed");
      o.runner.cancel(self, b.run, b.reason.trim());
      json(res, 200, { ok: true, run: o.runner.status(self, b.run) });
    } catch (e) { json(res, 409, { ok: false, reason: (e as Error).message }); }
  });
};
