export class PaneInputError extends Error {
  constructor(readonly code: "timeout" | "canceled", pane: string) {
    super(`pane input ${code}: ${pane}`);
    this.name = "PaneInputError";
  }
}

const tails = new Map<string, Promise<void>>();

/** Serialize a complete input transaction, including verification, by physical
 * pane. A timed-out caller leaves its running action fenced until it exits:
 * releasing early would let a late tmux command overlap the next transaction.
 * Stop/Escape deliberately does not take this lock. */
export const withPaneInput = <T>(
  pane: string,
  action: (live: () => boolean) => Promise<T>,
  opts: { guard?: () => boolean; timeoutMs?: number } = {},
): Promise<T> => {
  let active = true;
  const live = (): boolean => {
    if (active && opts.guard) {
      try { active = opts.guard(); } catch { active = false; }
    }
    return active;
  };
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const result = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  const timer = setTimeout(() => {
    active = false;
    reject(new PaneInputError("timeout", pane));
  }, opts.timeoutMs ?? 90_000);
  const work = (tails.get(pane) ?? Promise.resolve()).then(async () => {
    if (!live()) throw new PaneInputError("canceled", pane);
    return action(live);
  });
  const tail = work.then(resolve, reject).finally(() => {
    active = false;
    clearTimeout(timer);
    if (tails.get(pane) === tail) tails.delete(pane);
  });
  tails.set(pane, tail);
  return result;
};
