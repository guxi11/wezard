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
