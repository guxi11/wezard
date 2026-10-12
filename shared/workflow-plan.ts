// A fixed segment of work; decisions and acceptance remain with its owner.
import { z } from "zod";
import { isAbsolute } from "node:path";
import { TIERS } from "./config.js";

export const WorkflowPlanNodeSchema = z.object({
  id: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,39}$/),
  task: z.string().trim().min(1).max(24000),
  tier: z.enum(TIERS),
  after: z.array(z.string()).max(4).optional(),
  criteria: z.string().trim().min(1).max(4000).optional(),
}).strict();
export const WorkflowPlanInputSchema = z.object({
  version: z.literal(1),
  job: z.string().trim().min(1),
  cwd: z.string().refine(isAbsolute, "cwd must be absolute"),
  maxConcurrency: z.literal(1).default(1),
  nodes: z.array(WorkflowPlanNodeSchema).min(1).max(5),
}).strict();
export const WorkflowPlanSchema = WorkflowPlanInputSchema.superRefine((p, ctx) => {
  // Invalid oversized input must not enter the dependency walk.
  if (p.nodes.length > 5 || p.nodes.some((n) => (n.after?.length ?? 0) > 4)) return;
  const ids = p.nodes.map((n) => n.id);
  if (new Set(ids).size !== ids.length) ctx.addIssue({ code: "custom", message: "duplicate node id" });
  p.nodes.forEach((n) => {
    const deps = n.after ?? [];
    if (new Set(deps).size !== deps.length || deps.some((id) => !ids.includes(id) || id === n.id)) ctx.addIssue({ code: "custom", message: `invalid dependencies for ${n.id}` });
  });
  const cyclic = (id: string, trail: string[]): boolean => trail.includes(id)
    || (p.nodes.find((n) => n.id === id)?.after ?? []).some((dep) => cyclic(dep, [...trail, id]));
  if (ids.some((id) => cyclic(id, []))) ctx.addIssue({ code: "custom", message: "dependency cycle" });
});
export type WorkflowPlan = z.infer<typeof WorkflowPlanSchema>;
export type WorkflowPlanNode = z.infer<typeof WorkflowPlanNodeSchema>;
