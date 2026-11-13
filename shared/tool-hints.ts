// Read code-mode transcripts as data. Never evaluate the recorded JavaScript.
import { parse } from "acorn";
import { stripSigil } from "./session-label.js";

export const HINT_TOOL = /(?:^|__)(tell_peer|delegate|clone_wizard|spawn_wizard|stop_wizard|schedule_task)$/;
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
  // CodeBuddy REPL (PTC) 的回包壳: {result, stdout, stderr} —— 回执在 result 里 (JSON 字符串
  // 或对象); 只有 stdout/stderr 的 (Bash 输出) 和 error 形态都不是回执, 不解。
  if (o.result !== undefined && typeof o.stdout === "string" && typeof o.stderr === "string") return toolReplies(o.result, depth + 1);
  // console.log(回包) 而不 return 时壳里只有 stdout, 没有 result (也没有 Bash 返回的 exitCode)。
  // 逐行整行解析 —— 只认「整行就是一个 JSON」的打印, 不在一行文本里搜 JSON 片段。
  if (o.result === undefined && o.exitCode === undefined && typeof o.stdout === "string")
    return o.stdout.split("\n").flatMap((line) => {
      const t = line.trim();
      if (t.length === 0 || !/^[{[]/.test(t)) return [];
      try { JSON.parse(t); } catch { return []; }
      return toolReplies(t, depth + 1);
    });
  return [];
};

// Acorn nodes have different fields per syntax kind. This local view keeps the reader independent
// of evaluator libraries: only literal values / literal const bindings can become tool arguments.
type Syntax = { type: string; [key: string]: any };
const UNKNOWN = Symbol("not static");

/** 静态成员链: `mcp.wezard.tell_peer` / `mcp["wezard"].tell_peer` / `tools.mcp__wezard__x`。
 *  调用结果、下标变量这些算不出名字的段一律返回 undefined —— 认不出就不猜。 */
const memberPath = (n: Syntax | undefined): string | undefined => {
  if (!n) return undefined;
  if (n.type === "Identifier") return n.name;
  if (n.type !== "MemberExpression") return undefined;
  const head = memberPath(n.object);
  const key = n.computed
    ? n.property.type === "Literal" && typeof n.property.value === "string" ? n.property.value : undefined
    : n.property.type === "Identifier" ? n.property.name : undefined;
  return head === undefined || key === undefined ? undefined : head + "." + key;
};
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

/** 记进 transcript 的工具调用有好几种拼写, 归一成一种 (`accept` / HINT_TOOL 只认它):
 *  Claude code-mode 的 `tools.mcp__wezard__x` / `tools.exec_command`, CodeBuddy 的
 *  `mcp_wezard.x` 与 `mcp.wezard.x` (沙箱把命名空间和工具拆成两段)。 */
const TOOL_SPELLINGS = ["mcp__wezard__", "mcp_wezard.", "mcp.wezard."] as const;
const toolNameOf = (path: string): string | undefined => {
  // tools.* 是 code-mode 的容器: 剩下那一段本身就是工具名。
  if (path.startsWith("tools.")) return path.slice("tools.".length);
  const spelling = TOOL_SPELLINGS.find((s) => path.startsWith(s));
  return spelling === undefined ? undefined : "mcp__wezard__" + path.slice(spelling.length);
};

export interface HintCall { toolName: string; toolInput: Facts }
export const callsInExec = (source: string, accept: (name: string) => boolean = (name) => name.startsWith("mcp__wezard__") && HINT_TOOL.test(name)): HintCall[] => {
  if (source.length > 200_000) return [];
  try {
    // allowReturnOutsideFunction: REPL 的 code 是函数体, 顶层 return 是常态 —— 不放开整个解析直接失败。
    const ast = parse(source, { ecmaVersion: "latest", sourceType: "module", allowAwaitOutsideFunction: true, allowReturnOutsideFunction: true }) as Syntax;
    const bindings = new Map<string, unknown>();
    // 名字 → 它绑的成员链 (`const ns = mcp.wezard` / `const {tell_peer: tp} = mcp.wezard`)：
    // 只是换个写法, 不改变调用的身份, 和入参事实分开记。
    const aliases = new Map<string, string>();
    const calls: HintCall[] = [];
    const expand = (path: string): string => {
      const [head, ...rest] = path.split(".");
      const base = aliases.get(head!);
      return base === undefined ? path : [base, ...rest].join(".");
    };
    const walk = (n: Syntax): void => {
      // Definitions and conditional execution are not evidence that a tool ran.
      if (/Function|Class|IfStatement|ConditionalExpression|LogicalExpression|For|While|Switch|TryStatement/.test(n.type)) return;
      if (n.type === "BlockStatement") {
        const outer = new Map(bindings), outerAliases = new Map(aliases);
        n.body.forEach(walk);
        bindings.clear();
        outer.forEach((v, k) => bindings.set(k, v));
        aliases.clear();
        outerAliases.forEach((v, k) => aliases.set(k, v));
        return;
      }
      if (n.type === "VariableDeclaration" && n.kind === "const") {
        for (const d of n.declarations) {
          const binding = memberPath(d.init);
          if (d.id.type === "Identifier") {
            // 绑到工具 / 命名空间的名字不是入参事实, 单独记。
            if (binding !== undefined) aliases.set(d.id.name, binding);
            else {
              const v = literal(d.init, bindings);
              // const objects can still be mutated; only primitive bindings are immutable facts.
              bindings.set(d.id.name, v !== null && typeof v === "object" ? UNKNOWN : v);
            }
          } else if (d.id.type === "ObjectPattern" && binding !== undefined) {
            // const { tell_peer: tp } = mcp.wezard —— 同一个工具换个名字。
            for (const p of d.id.properties) {
              if (p.type !== "Property" || p.computed || p.kind !== "init" || p.value.type !== "Identifier") continue;
              aliases.set(p.value.name, expand(binding + "." + String(p.key.name ?? p.key.value)));
            }
          }
        }
      }
      if (n.type === "CallExpression") {
        // 被调用者先还原成静态成员链, 再归一成一种拼写: `mcp.wezard.tell_peer(…)` 这种两段
        // 命名空间、`const tp = mcp.wezard.tell_peer; tp(…)` 这种先存名字再调, 都落在这一处。
        const path = memberPath(n.callee);
        const name = path === undefined ? undefined : toolNameOf(expand(path));
        const input = n.arguments.length === 0 ? {} : literal(n.arguments[0], bindings);
        if (name !== undefined && accept(name) && objectOf(input)) calls.push({ toolName: name, toolInput: input as Facts });
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

const nameOf = (v: unknown): string => typeof v === "string" ? stripSigil(v) : "";
const matches = (c: HintCall, r: Facts): boolean => {
  const tool = HINT_TOOL.exec(c.toolName)?.[1];
  if (tool === "delegate") return r.decision === "spawn" || r.decision === "existing";
  if (tool === "tell_peer") return r.ok === true && !r.decision && typeof r.eventId === "string" && r.queued === true;
  if (tool === "spawn_wizard" || tool === "clone_wizard")
    return r.ok === true && !r.decision && typeof r.name === "string" && typeof r.cwd === "string" && typeof r.inherited === "boolean";
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
    const requested = nameOf(c.toolInput.to ?? c.toolInput.name);
    const named = compatible.filter((r) => requested && requested === nameOf(r.name));
    // delegate may select someone other than a requested spawn name. A directed tell cannot.
    return named.length ? named : requested && HINT_TOOL.exec(c.toolName)?.[1] === "tell_peer" ? [] : compatible;
  });
  return calls.flatMap((c, i) => {
    const rs = candidates[i]!;
    return rs.length === 1 && candidates.filter((s) => s.includes(rs[0]!)).length === 1
      ? [{ ...c, reply: rs[0]! }] : [];
  });
};
