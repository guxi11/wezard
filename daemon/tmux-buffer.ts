import { parseTmuxVersion, runTmux } from "./spawn-tmux.js";

type PasteResult = { ok: boolean; reason?: string };
type PasteAttempt = PasteResult & { retryLegacy?: true };

/** One instance per daemon: all mirror/peer/receipt pastes share the legacy lock. */
export const createTmuxBufferPaster = (run: typeof runTmux = runTmux) => {
  let version: ReturnType<typeof runTmux> | undefined;
  let queue: Promise<unknown> = Promise.resolve();
  let seq = 0;
  let legacy = false;
  const namedInFlight = new Set<Promise<PasteAttempt>>();

  const locked = <T>(fn: () => Promise<T>): Promise<T> => {
    const result = queue.then(fn);
    queue = result.then(() => undefined, () => undefined);
    return result;
  };

  return async (target: string, text: string, guard?: () => boolean): Promise<PasteResult> => {
    // Never let an absent target select tmux's current pane implicitly.
    if (!target.trim()) return { ok: false, reason: "tmux paste requires a target pane" };
    const probe = await (version ??= run(["-V"]));
    if (!probe.ok) {
      version = undefined; // A transient probe failure must not poison future deliveries.
      return { ok: false, reason: `tmux version probe failed: ${probe.stderr.trim() || probe.code}` };
    }
    // Match spawn's treatment of next/suffixed versions and unknown version strings.
    const paste = async (named: boolean): Promise<PasteAttempt> => {
      const buffer = named ? ["-b", `wezard-${process.pid}-${++seq}`] : [];
      let consumed = false;
      try {
        const loaded = await run(["load-buffer", ...buffer, "-"], { stdin: text });
        // 1.8 rejects a string buffer index before loading anything. Only this
        // definite pre-paste rejection can override a stale/misreported -V.
        // Timeouts and paste errors may have delivered text: never retry those.
        if (named && !loaded.ok && loaded.code === 1 && loaded.stderr.trim() === "buffer invalid") {
          legacy = true;
          return { ok: false, retryLegacy: true };
        }
        if (!loaded.ok) return { ok: false, reason: `tmux load-buffer failed: ${loaded.stderr.slice(-200) || loaded.code}` };
        if (guard && !guard()) return { ok: false, reason: "paste canceled by dispatch guard" };
        const pasted = await run(["paste-buffer", ...buffer, "-p", "-d", "-t", target]);
        if (!pasted.ok) return { ok: false, reason: `tmux paste-buffer failed: ${pasted.stderr.slice(-200)}` };
        consumed = true;
        return { ok: true };
      } finally {
        // A failed/expired client may have loaded its buffer. Named buffers do
        // not age out; best-effort cleanup must preserve the original error.
        if (named && !consumed) await run(["delete-buffer", ...buffer]).catch(() => undefined);
      }
    };
    // tmux 1.8's -b takes a numeric index, not a custom name. Only legacy
    // load→paste pairs serialize; modern named buffers retain cross-pane concurrency.
    // This lock covers this daemon's writers, not external tmux clipboard clients.
    const pasteLegacy = (): Promise<PasteResult> => locked(async () => {
      // Stop starting named transactions before entering this queue, then drain
      // those already running (including cleanup). Never mix the two modes.
      await Promise.allSettled([...namedInFlight]);
      return paste(false);
    });
    if (legacy || parseTmuxVersion(probe.stdout) < 3.0) return pasteLegacy();
    const pending = paste(true);
    namedInFlight.add(pending);
    let result: PasteAttempt;
    try {
      result = await pending;
    } finally {
      namedInFlight.delete(pending);
    }
    return result.retryLegacy ? pasteLegacy() : result;
  };
};

export const pasteTmuxBuffer = createTmuxBufferPaster();
