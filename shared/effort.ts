// Reasoning-effort levels, in the CLI's own order (its `/effort` slider runs
// left→right through exactly these). One list for the daemon's validation, the
// slider driver's arithmetic and the MCP schema — a level added upstream is
// added here once.
export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORTS)[number];

/** The level `s` names, or undefined — `""` / unknown words are not a level. */
export const parseEffort = (s: unknown): Effort | undefined => {
  const v = String(s ?? "").trim().toLowerCase();
  return (EFFORTS as readonly string[]).includes(v) ? (v as Effort) : undefined;
};
