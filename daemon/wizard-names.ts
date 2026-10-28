import { existsSync } from "node:fs";
import { loadJsonMap } from "../shared/json-map-store.js";
import { expandHome } from "../shared/paths.js";

// Automatic wizard names, in three segments one after another:
//   ① bare first names            Alice, Bob, … Yara                 (25)
//   ② full names, 甲子-style       AliceAdams, BobBrown, CarolClark … (650 per lap)
//   ③ full names + lap index      AliceAdams0 … YaraZaneZ, AliceAdams10 …
// In ② both tables step together; 25 and 26 are coprime, so one lap visits every pair
// exactly once and lands back on AliceAdams. ③ repeats that lap with a base-36 index
// (0…Z, 10…) that only moves when a whole lap is done.
// The initials are the indices, so the tables are frozen: A→Y and A→Z, one name each.
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

const F = FIRSTNAMES.length;
const L = LASTNAMES.length;
/** One 甲子 lap of full names. */
export const LAP = F * L;

/** ② k-th full name of a lap: both indices advance together. */
export const fullNameAt = (k: number): string => `${FIRSTNAMES[k % F]}${LASTNAMES[k % L]}`;
/** Inverse of fullNameAt: k ≡ i (mod 25), k ≡ j (mod 26) → k = i + 25·((i − j) mod 26), since 25 ≡ −1 (mod 26). */
export const lapPosOf = (i: number, j: number): number => i + F * (((i - j) % L + L) % L);

/** ③ lap index as written after the name: plain base 36, upper case. */
const indexText = (n: number): string => n.toString(36).toUpperCase();
const INDEX_RE = /^(?:0|[1-9A-Z][0-9A-Z]*)$/;

/** ordinal → name; segment boundaries at 25 and 25 + 650. */
export const autoNameAt = (ordinal: number): string => {
  if (!Number.isSafeInteger(ordinal) || ordinal < 0) throw new Error("invalid wizard name ordinal");
  if (ordinal < F) return FIRSTNAMES[ordinal]!;
  if (ordinal < F + LAP) return fullNameAt(ordinal - F);
  const rest = ordinal - F - LAP;
  return `${fullNameAt(rest % LAP)}${indexText(Math.floor(rest / LAP))}`;
};

/** Inverse of autoNameAt (exact spelling); undefined = not an automatic name. */
export const autoOrdinalOf = (name: string): number | undefined => {
  const i = FIRSTNAMES.findIndex((f) => name.startsWith(f));
  if (i < 0) return undefined;
  const rest = name.slice(FIRSTNAMES[i]!.length);
  if (!rest) return i;
  const j = LASTNAMES.findIndex((l) => rest.startsWith(l));
  if (j < 0) return undefined;
  const index = rest.slice(LASTNAMES[j]!.length);
  if (!index) return F + lapPosOf(i, j);
  if (!INDEX_RE.test(index)) return undefined;
  const ordinal = F + LAP + parseInt(index, 36) * LAP + lapPosOf(i, j);
  return Number.isSafeInteger(ordinal) ? ordinal : undefined;
};

/** Durable cursor over the sequence. Names are never reused: the cursor only moves forward, so a
 *  forgotten wizard's name (and with it its `base#name` target) never comes back. Occupied names
 *  (already held, e.g. by an explicit spawn or an older scheme) are skipped and consumed alike.
 *  The sequence is unbounded, so there is no exhaustion. Versions 2/3 counted other orders; their
 *  cursor means nothing here, so it restarts at 0 and live holders are skipped by `occupied`. */
export const loadAutoNames = (filePath: string): ((occupied?: (name: string) => boolean) => string) => {
  const existed = existsSync(expandHome(filePath));
  const db = loadJsonMap<number>(filePath, undefined, { strict: true });
  const next = db.get("next");
  const version = db.get("version");
  if (Object.keys(db.all()).some((k) => k !== "next" && k !== "version") || (existed && (next === undefined || version === undefined))
    || (next !== undefined && (!Number.isSafeInteger(next) || next < 0))
    || (version !== undefined && ![2, 3, 4].includes(version))) throw new Error("invalid wizard name sequence");
  if (version !== 4) db.merge({ version: 4, next: 0 });
  return (occupied = () => false) => {
    let ordinal = db.get("next")!;
    while (occupied(autoNameAt(ordinal))) ordinal++;
    // Consume durably before claiming; a failed birth burns its name.
    db.set("next", ordinal + 1);
    return autoNameAt(ordinal);
  };
};
