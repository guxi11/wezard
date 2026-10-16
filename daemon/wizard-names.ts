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

export const autoNameAt = (ordinal: number): string => {
  if (!Number.isSafeInteger(ordinal) || ordinal < 0) throw new Error("invalid wizard name ordinal");
  if (ordinal < FIRSTNAMES.length) return FIRSTNAMES[ordinal]!;
  const n = ordinal - FIRSTNAMES.length;
  // 31 and 37 are coprime: both indices advance together through all 1147 pairs.
  const cycle = Math.floor(n / (FIRSTNAMES.length * LASTNAMES.length));
  return `${FIRSTNAMES[n % FIRSTNAMES.length]}${LASTNAMES[n % LASTNAMES.length]}${cycle ? cycle + 1 : ""}`;
};

export const loadAutoNames = (filePath: string): (() => string) => {
  const existed = existsSync(expandHome(filePath));
  const db = loadJsonMap<number>(filePath, undefined, { strict: true });
  const next = db.get("next");
  if (Object.keys(db.all()).some((k) => k !== "next") || (existed && next === undefined)
    || (next !== undefined && (!Number.isSafeInteger(next) || next < 0))) throw new Error("invalid wizard name sequence");
  return () => {
    const ordinal = db.get("next") ?? 0;
    if (!Number.isSafeInteger(ordinal + 1)) throw new Error("wizard name sequence exhausted");
    // Consume durably before claiming. Failed births leave holes, never rewind.
    db.set("next", ordinal + 1);
    return autoNameAt(ordinal);
  };
};
