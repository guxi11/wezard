import { sleep } from "../shared/std.js";

export interface IdleResult { idle: boolean; reason?: string }
export interface IdleOpts { rampMs?: number; confirm?: number }

const POLL_MS = 2500;
const RAMP_MS = 20_000;
const IDLE_CONFIRM = 3;

/** Wait for a pane to become quiet, allowing a new input time to start. */
export const waitForIdle = async (
  target: string,
  isBusy: (target: string) => Promise<boolean>,
  timeoutMs: number,
  aborted: () => boolean,
  opts: IdleOpts = {},
): Promise<IdleResult> => {
  const deadline = Date.now() + timeoutMs;
  const rampUntil = Date.now() + (opts.rampMs ?? RAMP_MS);
  const confirmN = Math.max(1, opts.confirm ?? IDLE_CONFIRM);
  let sawBusy = false;
  let quiet = 0;
  while (Date.now() < deadline) {
    if (aborted()) return { idle: false, reason: "stopped" };
    await sleep(POLL_MS);
    const busy = await isBusy(target);
    if (busy) {
      sawBusy = true;
      quiet = 0;
      continue;
    }
    if (!sawBusy && Date.now() < rampUntil) continue;
    if (++quiet >= confirmN) return { idle: true };
  }
  return { idle: false, reason: "idle wait timed out" };
};
