import { z } from "zod";
import type { Asker } from "./detail-store.js";

export const PlanTaskStatusSchema = z.enum(["pending", "in_progress", "completed", "canceled"]);
export const PlanStateSchema = z.enum(["active", "paused", "completed", "canceled"]);
export const PlanOriginSchema = z.object({
  event: z.string().min(1).optional(),
  channel: z.string(),
  asker: z.object({ who: z.string(), chat: z.string() }).strict().optional(),
}).strict();

export const PlanTaskSchema = z.object({
  id: z.string().trim().min(1).max(120),
  title: z.string().trim().min(1).max(500),
  description: z.string().trim().max(20_000).optional(),
  dependsOn: z.array(z.string().trim().min(1).max(120)).default([]),
  status: PlanTaskStatusSchema.default("pending"),
  progress: z.string().trim().max(20_000).optional(),
  result: z.string().trim().max(20_000).optional(),
  /** 执行者: wizard 的全局名字 (.name, 带不带前导点都接受)。可选 —— 由 plan owner 在
   *  plan_update 时自己写; daemon 不自动指派、不默认填充、不迁移旧 journal 行 (缺了就当没有)。
   *  读侧 (rolepage) 按名字解到 wizard 节点, 解不出按 plan owner 展示。 */
  executor: z.string().trim().min(1).max(120).optional().describe("执行者 wizard 的全局名字 (.name, 带不带前导点都行)。可选, 由 plan owner 自己写; 不指派就省略 —— daemon 不自动填。"),
}).strict();

const PlanFields = {
  title: z.string().trim().min(1).max(500),
  description: z.string().trim().max(20_000).optional(),
  tasks: z.array(PlanTaskSchema).default([]),
};

export const PlanInputSchema = z.object({
  requestId: z.string().trim().min(1).max(160).optional(),
  ...PlanFields,
}).strict();

export const PlanUpdateSchema = z.object({
  revision: z.number().int().positive(),
  title: PlanFields.title.optional(),
  description: PlanFields.description,
  tasks: z.array(PlanTaskSchema).optional(),
  state: PlanStateSchema.optional(),
  reason: z.string().trim().max(4_000).optional(),
}).strict().refine((input) => [
  input.title, input.description, input.tasks, input.state, input.reason,
].some((value) => value !== undefined), { message: "at least one plan field must change" });

export const PlanRecordSchema = z.object({
  id: z.string().min(1),
  owner: z.string().min(1),
  origin: PlanOriginSchema.optional(),
  title: PlanFields.title,
  description: PlanFields.description,
  tasks: z.array(PlanTaskSchema),
  state: PlanStateSchema,
  reason: z.string().trim().max(4_000).optional(),
  revision: z.number().int().positive(),
  createdAt: z.number().finite().nonnegative(),
  updatedAt: z.number().finite().nonnegative(),
  reminder: z.object({
    revision: z.number().int().positive(),
    token: z.string().min(1),
    eventId: z.string().min(1),
    at: z.number().finite().nonnegative(),
  }).strict().optional(),
}).strict();

export type PlanTask = z.infer<typeof PlanTaskSchema>;
export type PlanState = z.infer<typeof PlanStateSchema>;
export type PlanOrigin = Omit<z.infer<typeof PlanOriginSchema>, "asker"> & { asker?: Asker };
export type PlanInput = z.infer<typeof PlanInputSchema>;
export type PlanUpdate = z.infer<typeof PlanUpdateSchema>;
export type PlanRecord = z.infer<typeof PlanRecordSchema>;

export const validatePlanTasks = (tasks: readonly PlanTask[]): string | undefined => {
  const byId = new Map<string, PlanTask>();
  for (const task of tasks) {
    if (byId.has(task.id)) return `duplicate task id '${task.id}'`;
    byId.set(task.id, task);
  }

  const dependents = new Map<string, string[]>();
  const remaining = new Map<string, number>();
  for (const task of tasks) {
    if (new Set(task.dependsOn).size !== task.dependsOn.length) return `task '${task.id}' repeats a dependency`;
    for (const dependency of task.dependsOn) {
      const prerequisite = byId.get(dependency);
      if (!prerequisite) return `task '${task.id}' depends on unknown task '${dependency}'`;
      if (dependency === task.id) return `task '${task.id}' cannot depend on itself`;
      if (["in_progress", "completed"].includes(task.status) && prerequisite.status !== "completed")
        return `task '${task.id}' requires completed prerequisite '${dependency}'`;
      dependents.set(dependency, [...(dependents.get(dependency) ?? []), task.id]);
    }
    remaining.set(task.id, task.dependsOn.length);
  }

  const ready = tasks.filter((task) => remaining.get(task.id) === 0).map((task) => task.id);
  let visited = 0;
  for (let i = 0; i < ready.length; i++) {
    visited++;
    for (const id of dependents.get(ready[i]!) ?? []) {
      const left = remaining.get(id)! - 1;
      remaining.set(id, left);
      if (left === 0) ready.push(id);
    }
  }
  return visited === tasks.length ? undefined : "task dependencies must form a directed acyclic graph";
};

export const validatePlan = (plan: Pick<PlanRecord, "tasks" | "state">): string | undefined => {
  const taskError = validatePlanTasks(plan.tasks);
  if (taskError) return taskError;
  if (plan.state === "completed" && plan.tasks.some((task) => !["completed", "canceled"].includes(task.status)))
    return "a plan can complete only when every task is completed or canceled";
  return undefined;
};
