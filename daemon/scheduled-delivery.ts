import { sleep } from "../shared/std.js";

export interface ScheduledResult { ok: boolean; reason?: string; retryable?: boolean; uncertain?: boolean }
export interface ScheduledDispatchOptions {
  taskId: string;
  fresh: boolean;
  quiet: boolean;
  signal: AbortSignal;
  guard: () => boolean;
  /** Only actual injection/spawn transactions consume the shared worker pool. */
  submit: (action: () => Promise<ScheduledResult>) => Promise<ScheduledResult>;
}
interface DeliveryDeps {
  handedOff: () => Promise<void>;
  idleNow: () => Promise<boolean>;
  untilIdle: (timeoutMs: number, aborted: () => boolean) => Promise<{ idle: boolean }>;
  named: (guard: () => boolean) => Promise<ScheduledResult>;
  runner: (wasBusy: boolean, guard: () => boolean) => Promise<ScheduledResult>;
  postponeMs: number;
  pause?: () => Promise<void>;
}

/** Waiting belongs to a per-target consumer, never to a scarce injection slot.
 * A busy race under the pane lock is definitely unsent and returns to readiness. */
export const deliverScheduled = async (opts: ScheduledDispatchOptions, d: DeliveryDeps): Promise<ScheduledResult> => {
  const live = () => !opts.signal.aborted && opts.guard();
  const canceled = (): ScheduledResult => ({ ok: false, reason: "scheduled delivery withdrawn", retryable: true });
  const wait = <T>(promise: Promise<T>): Promise<T | undefined> => new Promise((resolve, reject) => {
    if (!live()) { void promise.catch(() => undefined); resolve(undefined); return; }
    const clean = () => { opts.signal.removeEventListener("abort", abort); clearInterval(check); };
    const abort = () => { clean(); resolve(undefined); };
    // Task files can be disabled/deleted without emitting an AbortSignal.
    const check = setInterval(() => { if (!live()) abort(); }, 1000);
    opts.signal.addEventListener("abort", abort, { once: true });
    void promise.then((value) => { clean(); resolve(value); }, (error: unknown) => { clean(); reject(error); });
  });
  const submit = (action: (guard: () => boolean) => Promise<ScheduledResult>) =>
    opts.submit(() => live() ? action(live) : Promise.resolve(canceled()));
  if (!live()) return canceled();
  if (opts.fresh) return submit((guard) => d.runner(false, guard));
  const deadline = Date.now() + d.postponeMs;
  await wait(d.handedOff());
  while (live()) {
    const left = deadline - Date.now();
    if (left <= 0) return submit((guard) => d.runner(true, guard));
    const ready = await wait(d.idleNow());
    if (!live()) return canceled();
    if (!ready) {
      const idle = await wait(d.untilIdle(left, () => !live()));
      if (!live()) return canceled();
      if (!idle?.idle) return submit((guard) => d.runner(true, guard));
    }
    if (!live()) return canceled();
    const sent = await submit(d.named);
    if (sent.ok || sent.uncertain || !sent.retryable || !live()) return sent;
    // Avoid a tight loop when the registry is stale/unknown or another sender wins.
    await wait((d.pause ?? (() => sleep(500)))());
  }
  return canceled();
};
