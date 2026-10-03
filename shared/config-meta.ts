// Introspection over ConfigSchema: what a config path is, what it says about
// itself (`.describe()`), who may change it (`gate`) and when a change bites
// (`apply`). One source — the schema — for the loader, config_get and config_set;
// the prose a model reads is the schema's own, never a second copy.
import { z } from "zod";

/** hidden = 不可读不可写 (连 config_get 都不列); card = 人点卡才落盘; free = wizard 直接改。 */
export type Gate = "hidden" | "card" | "free";
/** hot = 守护进程每次用时现读, 改完即生效; reload = 启动时读一次。 */
export type Apply = "hot" | "reload";
export interface Knob { gate?: Gate; apply?: Apply }

// zod 3 has no `.meta()`, so knobs live in a side table keyed by schema instance.
// `knob` must be the OUTERMOST call: `.describe()` / `.default()` return a new
// instance and would leave the knob on an object nobody walks through.
const knobs = new WeakMap<z.ZodTypeAny, Knob>();
export const knob = <T extends z.ZodTypeAny>(s: T, k: Knob): T => {
  knobs.set(s, { ...knobs.get(s), ...k });
  return s;
};

export interface Layer {
  /** The type left after stripping default / optional / effects wrappers. */
  core: z.ZodTypeAny;
  /** First description met, outside in. */
  desc: string;
  hasDefault: boolean;
  default?: unknown;
  optional: boolean;
  /** Knobs of every wrapper, the outer one winning. */
  knob: Knob;
}

const peel = (s: z.ZodTypeAny): z.ZodTypeAny | undefined =>
  s instanceof z.ZodDefault || s instanceof z.ZodOptional || s instanceof z.ZodNullable ? s._def.innerType
  : s instanceof z.ZodEffects ? s._def.schema
  : s instanceof z.ZodLazy ? s.schema
  : undefined;

export const unwrap = (
  s: z.ZodTypeAny,
  acc: Layer = { core: s, desc: "", hasDefault: false, optional: false, knob: {} },
): Layer => {
  const here: Layer = {
    ...acc,
    core: s,
    desc: acc.desc || s.description || "",
    ...(!acc.hasDefault && s instanceof z.ZodDefault ? { hasDefault: true, default: s._def.defaultValue() } : {}),
    optional: acc.optional || s instanceof z.ZodOptional,
    knob: { ...knobs.get(s), ...acc.knob },
  };
  const inner = peel(s);
  return inner ? unwrap(inner, here) : here;
};

export const childOf = (core: z.ZodTypeAny, seg: string): z.ZodTypeAny | undefined =>
  core instanceof z.ZodObject ? (core.shape as Record<string, z.ZodTypeAny>)[seg]
  : core instanceof z.ZodRecord ? core._def.valueType
  : core instanceof z.ZodArray && /^\d+$/.test(seg) ? core.element
  : undefined;

/** Named sub-items a reader can descend into (records and arrays are indexed by data, not schema). */
export const childKeys = (core: z.ZodTypeAny): string[] =>
  core instanceof z.ZodObject ? Object.keys(core.shape) : [];

export const isBranch = (core: z.ZodTypeAny): boolean => core instanceof z.ZodObject;

export const parsePath = (path: string | undefined): string[] =>
  (path ?? "").split(".").map((s) => s.trim()).filter(Boolean);

export interface Resolved extends Layer {
  path: string[];
  gate: Gate;
  apply: Apply;
}

// hidden absorbs: a secret's subtree is secret whatever its leaves claim.
const inherit = (up: Required<Knob>, own: Knob): Required<Knob> => ({
  gate: up.gate === "hidden" ? "hidden" : own.gate ?? up.gate,
  apply: own.apply ?? up.apply,
});

const ROOT_KNOB: Required<Knob> = { gate: "free", apply: "reload" };

/** Walk `path` from `root`, carrying gate/apply down; undefined = no such path in the schema. */
export const resolve = (root: z.ZodTypeAny, path: string[]): Resolved | undefined => {
  const go = (s: z.ZodTypeAny, i: number, up: Required<Knob>): Resolved | undefined => {
    const layer = unwrap(s);
    const k = inherit(up, layer.knob);
    if (i === path.length) return { ...layer, path, ...k };
    const next = childOf(layer.core, path[i]!);
    return next ? go(next, i + 1, k) : undefined;
  };
  return go(root, 0, ROOT_KNOB);
};

// `.positive()` is an exclusive min of 0 — read the checks, not just minValue.
const bounds = (n: z.ZodNumber): string => {
  const edge = (kind: "min" | "max", lt: string, le: string): string => {
    const c = n._def.checks.find((x) => x.kind === kind) as { value: number; inclusive: boolean } | undefined;
    return c ? `${c.inclusive ? le : lt}${c.value}` : "";
  };
  return [edge("min", ">", "≥"), edge("max", "<", "≤")].filter(Boolean).map((s) => ` ${s}`).join("");
};

/** Human/model-readable type label. */
export const typeOf = (core: z.ZodTypeAny): string =>
  core instanceof z.ZodString ? "string"
  : core instanceof z.ZodNumber ? `${core.isInt ? "int" : "number"}${bounds(core)}`
  : core instanceof z.ZodBoolean ? "boolean"
  : core instanceof z.ZodEnum ? (core.options as string[]).join("|")
  : core instanceof z.ZodLiteral ? JSON.stringify(core.value)
  : core instanceof z.ZodArray ? `${typeOf(unwrap(core.element).core)}[]`
  : core instanceof z.ZodRecord ? `{<name>: ${typeOf(unwrap(core._def.valueType).core)}}`
  : core instanceof z.ZodObject ? "object"
  : core instanceof z.ZodUnion || core instanceof z.ZodDiscriminatedUnion ? "union"
  : "unknown";

const RANK: Record<Gate, number> = { free: 0, card: 1, hidden: 2 };
const stricter = (a: Gate, b: Gate): Gate => (RANK[a] >= RANK[b] ? a : b);

// Every schema child, including the value type of a record and the element of an array.
const kidsOf = (core: z.ZodTypeAny): z.ZodTypeAny[] =>
  core instanceof z.ZodObject ? Object.values(core.shape as Record<string, z.ZodTypeAny>)
  : core instanceof z.ZodRecord ? [core._def.valueType]
  : core instanceof z.ZodArray ? [core.element]
  : [];

const gateBelow = (s: z.ZodTypeAny, up: Required<Knob>): Gate => {
  const k = inherit(up, unwrap(s).knob);
  return kidsOf(unwrap(s).core).reduce<Gate>((g, c) => stricter(g, gateBelow(c, k)), k.gate);
};

/** The gate a WRITE at `path` answers to: the strictest one in its subtree — writing a
 *  whole branch writes every leaf under it. */
export const writeGate = (r: Resolved): Gate =>
  kidsOf(r.core).reduce<Gate>((g, c) => stricter(g, gateBelow(c, r)), r.gate);

/** jsonc-parser addresses array items by number, object keys by string. */
export const toJsonPath = (root: z.ZodTypeAny, path: string[]): (string | number)[] =>
  path.map((seg, i) => (resolve(root, path.slice(0, i))?.core instanceof z.ZodArray ? Number(seg) : seg));
