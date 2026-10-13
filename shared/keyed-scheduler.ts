interface Pending {
  key: string;
  resource: string;
  start: () => void;
  cancel: () => void;
}

/** A slow resource occupies one worker, not a batch. Duplicate keys coalesce;
 * eligible work keeps FIFO order while busy resources are skipped. */
export const createKeyedScheduler = (limit: number) => {
  if (!Number.isInteger(limit) || limit < 1) throw new Error("scheduler limit must be a positive integer");
  const controller = new AbortController();
  const keys = new Set<string>();
  const resources = new Set<string>();
  const pending: Pending[] = [];
  let running = 0;
  const pump = (): void => {
    while (!controller.signal.aborted && running < limit) {
      const i = pending.findIndex((p) => !resources.has(p.resource));
      if (i < 0) return;
      const p = pending.splice(i, 1)[0]!;
      resources.add(p.resource);
      running++;
      p.start();
    }
  };
  const schedule = <T>(key: string, resource: string, work: (signal: AbortSignal) => Promise<T>): Promise<T | undefined> | undefined => {
    if (controller.signal.aborted || keys.has(key)) return undefined;
    keys.add(key);
    const result = new Promise<T | undefined>((resolve, reject) => {
      pending.push({ key, resource, cancel: () => resolve(undefined), start: () => {
        const release = (): void => {
          keys.delete(key);
          resources.delete(resource);
          running--;
          pump();
        };
        void Promise.resolve().then(() => controller.signal.aborted ? undefined : work(controller.signal))
          .then((value) => { release(); resolve(value); }, (error: unknown) => { release(); reject(error); });
      } });
    });
    pump();
    return result;
  };
  return {
    schedule,
    has: (key: string): boolean => keys.has(key),
    signal: controller.signal,
    stop: (): void => {
      controller.abort();
      pending.splice(0).forEach((p) => { keys.delete(p.key); p.cancel(); });
    },
  };
};
