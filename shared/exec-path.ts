// launchd / systemd --user start the daemon with a stripped PATH that usually
// lacks nvm + homebrew, so every `spawn` from the daemon must widen it or it
// ENOENTs in production while working fine under `npm run dev:daemon`.
// The daemon's own Node bin dir comes first: an nvm-installed `claude` sits
// next to the node that is running us.
import { dirname } from "node:path";

const BASE_EXTRAS = [
  dirname(process.execPath),
  "/opt/homebrew/bin",
  "/usr/local/bin",
  `${process.env.HOME ?? ""}/.local/bin`,
];

/** `orig` first (caller's PATH wins), then the extras, deduped, order-stable. */
export const augmentedPath = (orig: string | undefined, extras: readonly string[] = []): string => {
  const seen = new Set<string>();
  return [orig ?? "", ...BASE_EXTRAS, ...extras]
    .flatMap((p) => p.split(":"))
    .filter((p) => p !== "" && !seen.has(p) && (seen.add(p), true))
    .join(":");
};

// The daemon is a tmux *client* of the pane server, never a process seated in
// one of its panes. Started from a tmux shell (the Linux nohup fallback inherits
// the caller's env), it carries $TMUX / $TMUX_PANE, and then tmux (a) routes
// every command to whatever server $TMUX names instead of the default socket a
// launchd/systemd start sees, and (b) on older servers refuses `new-session`
// even with `-d`: "sessions should be nested with care, unset $TMUX to force".
const TMUX_SEAT = new Set(["TMUX", "TMUX_PANE"]);

/** Child env for anything that may run `tmux`: widened PATH, no tmux seat. */
export const tmuxClientEnv = (env: NodeJS.ProcessEnv, extras: readonly string[] = []): NodeJS.ProcessEnv => ({
  ...Object.fromEntries(Object.entries(env).filter(([k]) => !TMUX_SEAT.has(k))),
  PATH: augmentedPath(env.PATH, extras),
});
