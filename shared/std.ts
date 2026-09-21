// Primitives small enough that every module was re-deriving its own copy.
export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Cut at `max` chars, marking the cut with an ellipsis. */
export const truncate = (s: string, max: number): string => (s.length <= max ? s : `${s.slice(0, max)}…`);

/** Same, but says how much was dropped — for tails a reader may want to chase. */
export const truncateWithCount = (s: string, max: number): string =>
  s.length <= max ? s : `${s.slice(0, max)}…(+${s.length - max})`;

/** Flatten to a single line first — for text going into a one-line bubble. */
export const clipLine = (s: string, max: number): string => truncate(s.replace(/\s+/g, " ").trim(), max);
