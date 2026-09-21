// Keyed JSON file that writes through on every mutation — the shape four
// daemon stores (sessions / mirror attachments / wizards / jobs) had each
// re-derived.
//
// Tolerant at both ends on purpose: a corrupt file reads as empty and a failed
// write is swallowed. Everything kept here is recovery state, so losing it
// costs a re-attach — never a live session.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { expandHome } from "./paths.js";

export interface JsonMap<T> {
  get: (key: string) => T | undefined;
  /** Returns what was stored, so callers can `return db.set(...)`. */
  set: (key: string, value: T) => T;
  drop: (key: string) => void;
  all: () => Record<string, T>;
}

/** `gc` runs just before each write, letting a store expire its own rows. */
export const loadJsonMap = <T>(
  filePath: string,
  gc?: (map: Record<string, T>) => Record<string, T>,
): JsonMap<T> => {
  const abs = expandHome(filePath);
  let map: Record<string, T> = {};
  if (existsSync(abs)) {
    try { map = JSON.parse(readFileSync(abs, "utf8")) as Record<string, T>; } catch { map = {}; }
  } else {
    mkdirSync(dirname(abs), { recursive: true });
  }
  const persist = (): void => {
    if (gc) map = gc(map);
    try { writeFileSync(abs, JSON.stringify(map, null, 2), "utf8"); } catch { /* 存档丢了也不该拖垮会话 */ }
  };
  return {
    get: (k) => map[k],
    set: (k, v) => { map = { ...map, [k]: v }; persist(); return v; },
    drop: (k) => { const { [k]: _gone, ...rest } = map; map = rest; persist(); },
    all: () => ({ ...map }),
  };
};
