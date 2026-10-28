import { existsSync } from "node:fs";
import { loadJsonMap } from "../shared/json-map-store.js";
import { expandHome } from "../shared/paths.js";

// Automatic wizard names, strictly lexicographic: one first name per initial A→Y,
// one last name per initial A→Z. The two initials are the coordinates, so a name
// reads back as its ordinal: AliceAdams = #1, BobFord = #32, TessFord = #500.
// Changing either table changes every later address; append-only is not possible
// (the initials are the index), so treat them as frozen.
export const FIRSTNAMES = [
  "Alice", "Bob", "Carol", "David", "Emma", "Frank", "Grace", "Henry", "Iris",
  "Jack", "Kate", "Leo", "Maya", "Noah", "Olive", "Paul", "Quinn", "Rose",
  "Sam", "Tess", "Uma", "Victor", "Wendy", "Xavier", "Yara",
] as const;

export const LASTNAMES = [
  "Adams", "Brown", "Clark", "Davis", "Evans", "Ford", "Green", "Hill", "Irwin",
  "Jones", "King", "Lane", "Miller", "Nash", "Owen", "Price", "Quincy", "Reed",
  "Smith", "Taylor", "Underwood", "Vance", "White", "Xu", "Young", "Zane",
] as const;

/** One lap over every first × last pair. */
export const ROUND = FIRSTNAMES.length * LASTNAMES.length;

const RADIX = 36;
const SUFFIX_RE = /^[0-9A-Z]+$/;

/** Round 0 has no suffix; later rounds count 0…Z, then 00…ZZ, 000… (shortest first). */
const suffixAt = (k: number, len = 1): string =>
  k < RADIX ** len ? k.toString(RADIX).toUpperCase().padStart(len, "0") : suffixAt(k - RADIX ** len, len + 1);
export const roundSuffix = (round: number): string => (round === 0 ? "" : suffixAt(round - 1));

const roundOfSuffix = (s: string): number | undefined => {
  if (!s) return 0;
  if (!SUFFIX_RE.test(s)) return undefined;
  const shorter = Array.from({ length: s.length - 1 }, (_, i) => RADIX ** (i + 1)).reduce((a, b) => a + b, 0);
  return 1 + shorter + parseInt(s, RADIX);
};

export const autoNameAt = (ordinal: number): string => {
  if (!Number.isSafeInteger(ordinal) || ordinal < 0) throw new Error("invalid wizard name ordinal");
  const pair = ordinal % ROUND;
  return `${FIRSTNAMES[Math.floor(pair / LASTNAMES.length)]}${LASTNAMES[pair % LASTNAMES.length]}${roundSuffix(Math.floor(ordinal / ROUND))}`;
};

/** Inverse of autoNameAt (exact spelling); undefined = not an automatic name. */
export const autoOrdinalOf = (name: string): number | undefined => {
  const i = FIRSTNAMES.findIndex((f) => name.startsWith(f));
  const rest = i < 0 ? "" : name.slice(FIRSTNAMES[i]!.length);
  const j = LASTNAMES.findIndex((l) => rest.startsWith(l));
  const round = j < 0 ? undefined : roundOfSuffix(rest.slice(LASTNAMES[j]!.length));
  const ordinal = round === undefined ? undefined : round * ROUND + i * LASTNAMES.length + j;
  return ordinal !== undefined && Number.isSafeInteger(ordinal) ? ordinal : undefined;
};

/** Durable cursor over the sequence. Names are never reused: the cursor only moves forward, so a
 *  forgotten wizard's name (and with it its `base#name` target) never comes back. Occupied names
 *  (already held, e.g. by an explicit spawn) are skipped and consumed alike. The sequence is
 *  unbounded, so there is no exhaustion. Version 2 counted a retired 31×37 diagonal; its cursor
 *  means nothing here, so it restarts at 0 and live holders are skipped by `occupied`. */
export const loadAutoNames = (filePath: string): ((occupied?: (name: string) => boolean) => string) => {
  const existed = existsSync(expandHome(filePath));
  const db = loadJsonMap<number>(filePath, undefined, { strict: true });
  const next = db.get("next");
  const version = db.get("version");
  if (Object.keys(db.all()).some((k) => k !== "next" && k !== "version") || (existed && (next === undefined || version === undefined))
    || (next !== undefined && (!Number.isSafeInteger(next) || next < 0))
    || (version !== undefined && version !== 2 && version !== 3)) throw new Error("invalid wizard name sequence");
  if (version !== 3) db.merge({ version: 3, next: 0 });
  return (occupied = () => false) => {
    let ordinal = db.get("next")!;
    while (occupied(autoNameAt(ordinal))) ordinal++;
    // Consume durably before claiming; a failed birth burns its name.
    db.set("next", ordinal + 1);
    return autoNameAt(ordinal);
  };
};
