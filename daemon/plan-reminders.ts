import { createHash } from "node:crypto";
import type { PlanRecord } from "../shared/plan.js";
import type { PlanStore } from "./plans.js";

export interface PlanReminderCandidate {
  plan: PlanRecord;
  token: string;
  eventId: string;
  eventIds: string[];
}

export interface PlanReminderDeps {
  store: PlanStore;
  eventIds: (planId: string) => string[];
  hasOutstandingDebt: (planId: string, owner: string) => boolean;
  hasPendingReminder: (owner: string) => boolean;
  idle: (owner: string) => Promise<boolean>;
  handingOff: (owner: string) => boolean;
  enqueue: (candidate: PlanReminderCandidate) => Promise<void>;
  log: { warn: (fields: object, message: string) => void };
  intervalMs?: number;
}

export const reminderToken = (planId: string, revision: number, eventIds: readonly string[]): string =>
  createHash("sha256").update(JSON.stringify([planId, revision, [...new Set(eventIds)].sort()])).digest("hex");

export const reminderEventId = (planId: string, revision: number, token: string): string =>
  `plan-reminder:${planId}:${revision}:${token.slice(0, 24)}`;

export const startPlanReminders = (deps: PlanReminderDeps): (() => void) => {
  const running = new Set<string>();
  let ticking = false;
  const tick = async (): Promise<void> => {
    if (ticking || !deps.store.healthy()) return;
    ticking = true;
    try {
      const owners = new Set<string>();
      for (const plan of deps.store.all()) {
        if (plan.state !== "active" || running.has(plan.owner) || owners.has(plan.owner) || deps.hasPendingReminder(plan.owner)) continue;
        const eventIds = deps.eventIds(plan.id);
        const token = reminderToken(plan.id, plan.revision, eventIds);
        if (plan.reminder?.revision === plan.revision && plan.reminder.token === token) continue;
        if (deps.hasOutstandingDebt(plan.id, plan.owner) || deps.handingOff(plan.owner) || !(await deps.idle(plan.owner))) continue;
        owners.add(plan.owner);
        running.add(plan.owner);
        try {
          await deps.enqueue({ plan, token, eventId: reminderEventId(plan.id, plan.revision, token), eventIds });
        } catch (error) {
          deps.log.warn({ planId: plan.id, owner: plan.owner, err: (error as Error).message }, "plan reminder could not be queued");
        } finally {
          running.delete(plan.owner);
        }
      }
    } catch (error) {
      deps.log.warn({ err: (error as Error).message }, "plan reminder sweep failed");
    } finally {
      ticking = false;
    }
  };
  const timer = setInterval(() => { void tick(); }, deps.intervalMs ?? 30_000);
  timer.unref?.();
  void tick();
  return () => clearInterval(timer);
};
