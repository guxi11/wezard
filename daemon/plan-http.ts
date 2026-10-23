import type { IncomingMessage } from "node:http";
import { PlanInputSchema, PlanUpdateSchema, type PlanOrigin } from "../shared/plan.js";
import { sameBot } from "../shared/session-label.js";
import { ZodError } from "zod";
import type { HttpServer } from "./http.js";
import { json } from "./http.js";
import { PlanError, type PlanStore } from "./plans.js";

const objectOf = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("object required");
  return value as Record<string, unknown>;
};

const inputOf = (body: unknown, omit: readonly string[] = []): Record<string, unknown> => {
  const excluded = new Set(["sessionId", "tmuxPane", "target", ...omit]);
  return Object.fromEntries(Object.entries(objectOf(body)).filter(([key]) => !excluded.has(key)));
};

const errorResponse = (res: Parameters<typeof json>[0], error: unknown, fallback = 400): void => {
  if (error instanceof PlanError) json(res, error.status, { ok: false, reason: error.message });
  else json(res, error instanceof ZodError ? 400 : fallback, { ok: false, reason: (error as Error).message });
};

export const registerPlanRoutes = (http: HttpServer, options: {
  store: PlanStore;
  read: (req: IncomingMessage) => Promise<{ self: string; body: unknown }>;
  resolveOwner: (name: string) => string | undefined;
  origin?: (self: string) => PlanOrigin | undefined;
}): void => {
  http.register("POST /plans/create", async (req, res) => {
    const { self, body } = await options.read(req);
    if (!self) { json(res, 400, { ok: false, reason: "cannot resolve caller" }); return; }
    let raw: Record<string, unknown>;
    try { raw = inputOf(body); } catch (error) { errorResponse(res, error); return; }
    const parsed = PlanInputSchema.safeParse(raw);
    if (!parsed.success) { json(res, 400, { ok: false, reason: parsed.error.message }); return; }
    try { json(res, 200, { ok: true, plan: options.store.create(self, parsed.data, Date.now(), options.origin?.(self)) }); }
    catch (error) { errorResponse(res, error, 409); }
  });

  http.register("POST /plans/get", async (req, res) => {
    const { self, body } = await options.read(req);
    if (!self) { json(res, 400, { ok: false, reason: "cannot resolve caller" }); return; }
    try {
      const input = inputOf(body);
      if (Object.keys(input).some((key) => key !== "planId") || typeof input.planId !== "string" || !input.planId.trim())
        throw new Error("planId required; unknown fields are not allowed");
      const plan = options.store.get(input.planId);
      if (!plan || !sameBot(self, plan.owner)) { json(res, 404, { ok: false, reason: "plan not found" }); return; }
      json(res, 200, { ok: true, plan });
    } catch (error) { errorResponse(res, error); }
  });

  http.register("POST /plans/list", async (req, res) => {
    const { self, body } = await options.read(req);
    if (!self) { json(res, 400, { ok: false, reason: "cannot resolve caller" }); return; }
    try {
      const input = inputOf(body);
      if (Object.keys(input).some((key) => key !== "name") || (input.name !== undefined && typeof input.name !== "string"))
        throw new Error("only the optional name field is allowed");
      const owner = input.name ? options.resolveOwner(input.name) : self;
      if (!owner || !sameBot(self, owner)) { json(res, 404, { ok: false, reason: `unknown wizard '${String(input.name)}'` }); return; }
      json(res, 200, { ok: true, plans: options.store.list(owner) });
    } catch (error) { errorResponse(res, error); }
  });

  http.register("POST /plans/update", async (req, res) => {
    const { self, body } = await options.read(req);
    if (!self) { json(res, 400, { ok: false, reason: "cannot resolve caller" }); return; }
    let record: Record<string, unknown>;
    try { record = inputOf(body); } catch (error) { errorResponse(res, error); return; }
    const planId = record.planId;
    if (typeof planId !== "string" || !planId.trim()) { json(res, 400, { ok: false, reason: "planId required" }); return; }
    const parsed = PlanUpdateSchema.safeParse(inputOf(body, ["planId"]));
    if (!parsed.success) { json(res, 400, { ok: false, reason: parsed.error.message }); return; }
    try { json(res, 200, { ok: true, plan: options.store.update(self, planId, parsed.data) }); }
    catch (error) { errorResponse(res, error, 409); }
  });
};
