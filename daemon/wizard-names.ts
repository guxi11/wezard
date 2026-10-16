import { loadJsonMap } from "../shared/json-map-store.js";
import { existsSync } from "node:fs";
import { expandHome } from "../shared/paths.js";

// Fixed vocabulary: changing order or length would change later addresses.
export const FIRSTNAMES = [
  "Alice", "Bob", "Carol", "David", "Emma", "Frank", "Grace", "Henry",
  "Iris", "Jack", "Kate", "Leo", "Maya", "Noah", "Olive", "Paul",
  "Quinn", "Rose", "Sam", "Tess", "Uma", "Victor", "Wendy", "Xavier",
  "Yara", "Zoe", "Alex", "Blair", "Casey", "Drew", "Eden",
] as const;

export const LASTNAMES = [
  "Smith", "Brown", "Clark", "Davis", "Evans", "Ford", "Green", "Hill",
  "Irwin", "Jones", "King", "Lane", "Miller", "Nash", "Owen", "Price",
  "Reed", "Scott", "Taylor", "Underwood", "Vance", "White", "Young", "Adams",
  "Baker", "Carter", "Dean", "Ellis", "Fisher", "Grant", "Hayes", "Kelly",
  "Lewis", "Moore", "Parker", "Ross", "Stone",
] as const;

const COMBINATIONS = FIRSTNAMES.length * LASTNAMES.length;
const SEQUENCE_END = FIRSTNAMES.length + COMBINATIONS;
const wrapOrdinal = (n: number): number => n < FIRSTNAMES.length ? n : FIRSTNAMES.length + (n - FIRSTNAMES.length) % COMBINATIONS;

export class AutoNameExhausted extends Error {
  constructor() { super("automatic wizard name pool exhausted; release an occupied identity before retrying"); }
}

export const autoNameAt = (ordinal: number): string => {
  if (!Number.isSafeInteger(ordinal) || ordinal < 0) throw new Error("invalid wizard name ordinal");
  if (ordinal < FIRSTNAMES.length) return FIRSTNAMES[ordinal]!;
  const n = ordinal - FIRSTNAMES.length;
  // 31 and 37 are coprime: both indices advance together through all 1147 pairs.
  return `${FIRSTNAMES[n % FIRSTNAMES.length]}${LASTNAMES[n % LASTNAMES.length]}`;
};

export const loadAutoNames = (filePath: string): ((occupied?: (name: string) => boolean) => string) => {
  const existed = existsSync(expandHome(filePath));
  const db = loadJsonMap<number>(filePath, undefined, { strict: true });
  const next = db.get("next");
  const version = db.get("version");
  if (Object.keys(db.all()).some((k) => k !== "next" && k !== "version") || (existed && next === undefined)
    || (next !== undefined && (!Number.isSafeInteger(next) || next < 0))
    || (version !== undefined && (version !== 2 || next === undefined || next >= SEQUENCE_END))) throw new Error("invalid wizard name sequence");
  // Legacy ordinals count attempts, including failed births and earlier numbered
  // generations. Preserve their phase, never infer progress from live identities.
  if (version === undefined) db.merge({ version: 2, next: wrapOrdinal(next ?? 0) });
  return (occupied = () => false) => {
    let ordinal = db.get("next")!;
    const limit = COMBINATIONS + Math.max(0, FIRSTNAMES.length - ordinal);
    for (let scanned = 0; scanned < limit; scanned++) {
      const name = autoNameAt(ordinal);
      ordinal = wrapOrdinal(ordinal + 1);
      if (occupied(name)) continue;
      // Consume durably before claiming; a failed birth waits for the next lap.
      db.set("next", ordinal);
      return name;
    }
    // Even exhaustion consumes any remaining first-pass single names.
    db.set("next", ordinal);
    throw new AutoNameExhausted();
  };
};
