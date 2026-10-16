// Read code-mode transcripts as data. Never evaluate the recorded JavaScript.
import { parse } from "acorn";

export const HINT_TOOL = /(?:^|__)(tell_peer|send_peer|dispatch|clone_wizard|spawn_wizard|open_job|close_job|stop_wizard|schedule_task)$/;
export type Facts = Record<string, unknown>;
export const objectOf = (v: unknown): Facts | undefined =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? v as Facts : undefined;

/** Only transport containers are unwrapped; arbitrary task/reason text is never searched for JSON. */
export const toolReplies = (value: unknown, depth = 0): Facts[] => {
  if (depth > 12) return [];
  if (typeof value === "string") {
    try { return toolReplies(JSON.parse(value), depth + 1); } catch { return []; }
  }
  if (Array.isArray(value)) return value.flatMap((v) => toolReplies(v, depth + 1));
  const o = objectOf(value);
  if (!o) return [];
  if (typeof o.ok === "boolean") return [o];
  if (Array.isArray(o.content)) return toolReplies(o.content, depth + 1);
  if ((o.type === "text" || o.type === "input_text") && typeof o.text === "string") return toolReplies(o.text, depth + 1);
  if (o.status === "fulfilled") return toolReplies(o.value, depth + 1);
  return [];
};

// Acorn nodes have different fields per syntax kind. This local view keeps the reader independent
// of evaluator libraries: only literal values / literal const bindings can become tool arguments.
type Syntax = { type: string; [key: string]: any };
const UNKNOWN = Symbol("not static");
const literal = (n: Syntax | undefined, bindings: Map<string, unknown>): unknown => {
  if (!n) return UNKNOWN;
  if (n.type === "Literal") return n.regex || n.bigint ? UNKNOWN : n.value;
  if (n.type === "Identifier") return bindings.has(n.name) ? bindings.get(n.name) : UNKNOWN;
  if (n.type === "TemplateLiteral" && !n.expressions.length) return n.quasis[0].value.cooked;
  if (n.type === "UnaryExpression" && n.operator === "-" && n.argument.type === "Literal" && typeof n.argument.value === "number") return -n.argument.value;
  if (n.type === "ArrayExpression") {
    const values = n.elements.map((x: Syntax) => literal(x, bindings));
    return values.includes(UNKNOWN) ? UNKNOWN : values;
  }
  if (n.type === "ObjectExpression") {
    const entries: [string, unknown][] = [];
    for (const p of n.properties) {
      if (p.type !== "Property" || p.computed || p.kind !== "init" || p.method) return UNKNOWN;
      const v = literal(p.value, bindings);
      if (v === UNKNOWN) return UNKNOWN;
      entries.push([String(p.key.name ?? p.key.value), v]);
    }
    return Object.fromEntries(entries);
  }
  return UNKNOWN;
};

export interface HintCall { toolName: string; toolInput: Facts }
export const callsInExec = (source: string, accept: (name: string) => boolean = (name) => name.startsWith("mcp__wezard__") && HINT_TOOL.test(name)): HintCall[] => {
  if (source.length > 200_000) return [];
  try {
    const ast = parse(source, { ecmaVersion: "latest", sourceType: "module", allowAwaitOutsideFunction: true }) as Syntax;
    const bindings = new Map<string, unknown>();
    const calls: HintCall[] = [];
    const walk = (n: Syntax): void => {
      // Definitions and conditional execution are not evidence that a tool ran.
      if (/Function|Class|IfStatement|ConditionalExpression|LogicalExpression|For|While|Switch|TryStatement/.test(n.type)) return;
      if (n.type === "BlockStatement") {
        const outer = new Map(bindings);
        n.body.forEach(walk);
        bindings.clear();
        outer.forEach((v, k) => bindings.set(k, v));
        return;
      }
      if (n.type === "VariableDeclaration" && n.kind === "const") {
        for (const d of n.declarations) if (d.id.type === "Identifier") {
          const v = literal(d.init, bindings);
          // const objects can still be mutated; only primitive bindings are immutable facts.
          bindings.set(d.id.name, v !== null && typeof v === "object" ? UNKNOWN : v);
        }
      }
      if (n.type === "CallExpression" && n.callee.type === "MemberExpression" && !n.callee.computed && n.callee.object.type === "Identifier" && n.callee.object.name === "tools") {
        const name = n.callee.property.name;
        const input = n.arguments.length === 0 ? {} : literal(n.arguments[0], bindings);
        if (accept(name) && objectOf(input)) calls.push({ toolName: name, toolInput: input as Facts });
      }
      for (const value of Object.values(n)) {
        if (Array.isArray(value)) value.forEach((x) => { if (x?.type) walk(x); });
        else if (value && typeof value === "object" && value.type) walk(value);
      }
    };
    walk(ast);
    return calls;
  } catch { return []; }
};

const nameOf = (v: unknown): string => typeof v === "string" ? v.replace(/^\./, "") : "";
const matches = (c: HintCall, r: Facts): boolean => {
  const tool = HINT_TOOL.exec(c.toolName)?.[1];
  if (tool === "dispatch") return r.decision === "spawn" || r.decision === "existing";
  if (tool === "tell_peer" || tool === "send_peer") return !r.decision && typeof r.turn === "string" && !r.dispatched;
  if (tool === "spawn_wizard" || tool === "clone_wizard") return !r.decision && typeof r.sessionId === "string";
  if (tool === "open_job" || tool === "close_job") return typeof r.job === "string";
  if (tool === "stop_wizard") return typeof r.name === "string" && typeof r.mode === "string";
  return typeof r.id === "string" && (typeof r.when === "string" || typeof r.next === "string");
};

/** Pair by reply facts, never Promise completion order. Ambiguous pairs produce no invented tips. */
export const execHintCalls = (source: string, output: string): (HintCall & { reply: Facts })[] => {
  const calls = callsInExec(source).filter((c) => !c.toolInput.dryRun);
  if (!calls.length) return [];
  const replies = toolReplies(output).filter((r) => !r.dryRun);
  const candidates = calls.map((c) => {
    const compatible = replies.filter((r) => matches(c, r));
    const requested = nameOf(c.toolInput.to ?? c.toolInput.name ?? c.toolInput.tag);
    const named = compatible.filter((r) => requested && requested === nameOf(r.name));
    const tool = HINT_TOOL.exec(c.toolName)?.[1];
    // dispatch may select someone other than the requested spawn name. A directed message cannot.
    return named.length ? named : requested && (tool === "tell_peer" || tool === "send_peer") ? [] : compatible;
  });
  return calls.flatMap((c, i) => {
    const rs = candidates[i]!;
    return rs.length === 1 && candidates.filter((s) => s.includes(rs[0]!)).length === 1
      ? [{ ...c, reply: rs[0]! }] : [];
  });
};
