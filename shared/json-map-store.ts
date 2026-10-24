// Keyed JSON file that writes through on every mutation — shared by daemon
// stores for mirror attachments, wizard identities and recovery ledgers.
//
// Tolerant at both ends on purpose: a corrupt file reads as empty and a failed
// write is swallowed. Everything kept here is recovery state, so losing it
// costs a re-attach — never a live session. Strict callers opt into atomic,
// durable writes and reject corrupt data/write failures.
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, openSync, fsyncSync, closeSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { expandHome } from "./paths.js";

export interface JsonMap<T> {
  get: (key: string) => T | undefined;
  /** Returns what was stored, so callers can `return db.set(...)`. */
  set: (key: string, value: T) => T;
  drop: (key: string) => void;
  /** Several keys in one write. */
  merge: (rows: Record<string, T>) => void;
  all: () => Record<string, T>;
}

/** `gc` runs just before each write, letting a store expire its own rows. */
export const loadJsonMap = <T>(
  filePath: string,
  gc?: (map: Record<string, T>) => Record<string, T>,
  opts: { strict?: boolean } = {},
): JsonMap<T> => {
  const abs = expandHome(filePath);
  let map: Record<string, T> = {};
  if (existsSync(abs)) {
    try { map = JSON.parse(readFileSync(abs, "utf8")) as Record<string, T>; } catch (e) { if (opts.strict) throw e; map = {}; }
  } else {
    mkdirSync(dirname(abs), { recursive: true });
  }
  if (opts.strict && (!map || typeof map !== "object" || Array.isArray(map))) throw new Error("invalid keyed JSON store");
  let failed = false;
  const persist = (next: Record<string, T>): void => {
    if (gc) next = gc(next);
    if (opts.strict) {
      if (failed) throw new Error("strict store write previously failed; reload required");
      try {
        const tmp = `${abs}.${randomUUID()}.tmp`;
        writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
        const fd = openSync(tmp, "r");
        try { fsyncSync(fd); } finally { closeSync(fd); }
        renameSync(tmp, abs);
        const dir = openSync(dirname(abs), "r");
        try { fsyncSync(dir); } finally { closeSync(dir); }
        map = next;
      } catch (e) { failed = true; throw e; }
      return;
    }
    map = next;
    try { writeFileSync(abs, JSON.stringify(map, null, 2), "utf8"); } catch { /* 存档丢了也不该拖垮会话 */ }
  };
  return {
    get: (k) => map[k],
    set: (k, v) => { persist({ ...map, [k]: v }); return v; },
    drop: (k) => { const { [k]: _gone, ...rest } = map; persist(rest); },
    merge: (rows) => { persist({ ...map, ...rows }); },
    all: () => ({ ...map }),
  };
};
