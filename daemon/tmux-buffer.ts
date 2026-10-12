import { parseTmuxVersion, runTmux } from "./spawn-tmux.js";

type PasteResult = { ok: boolean; reason?: string };

/** One instance per daemon: all mirror/peer/receipt pastes share the legacy lock. */
export const createTmuxBufferPaster = (run: typeof runTmux = runTmux) => {
  let version: ReturnType<typeof runTmux> | undefined;
  let queue: Promise<unknown> = Promise.resolve();
  let seq = 0;

  const locked = <T>(fn: () => Promise<T>): Promise<T> => {
    const result = queue.then(fn);
    queue = result.then(() => undefined, () => undefined);
    return result;
  };

  return async (target: string, text: string): Promise<PasteResult> => {
    // Never let an absent target select tmux's current pane implicitly.
    if (!target.trim()) return { ok: false, reason: "tmux paste requires a target pane" };
    const probe = await (version ??= run(["-V"]));
    if (!probe.ok) {
      version = undefined; // A transient probe failure must not poison future deliveries.
      return { ok: false, reason: `tmux version probe failed: ${probe.stderr.trim() || probe.code}` };
    }
    // Match spawn's treatment of next/suffixed versions and unknown version strings.
    const named = parseTmuxVersion(probe.stdout) >= 3.0;
    const paste = async (): Promise<PasteResult> => {
      const buffer = named ? ["-b", `wezard-${process.pid}-${++seq}`] : [];
      let consumed = false;
      try {
        const loaded = await run(["load-buffer", ...buffer, "-"], { stdin: text });
        if (!loaded.ok) return { ok: false, reason: `tmux load-buffer failed: ${loaded.stderr.slice(-200) || loaded.code}` };
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
    return named ? paste() : locked(paste);
  };
};

export const pasteTmuxBuffer = createTmuxBufferPaster();
