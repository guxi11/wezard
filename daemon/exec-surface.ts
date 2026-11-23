// 代码执行外壳 (CodeBuddy REPL / PTC) 的白名单下钻 —— 引导化身 (onboarding) 与 monitor
// (wizard) 共用这一份 AST 解析: 只按外层工具名判会把工具面整个关死 (CodeBuddy 只暴露 REPL,
// 真正的工具调用写在 code 脚本里), 所以对脚本**每一次调用**都要求是给定白名单里的一件
// (另加纯计算 / REPL 自己的工具发现), 认不出的、new、import、解析失败一律 fail-closed。
import { parse } from "acorn";

/** mcp__wezard__chat_reply → chat_reply (内置工具名原样)。 */
export const shortToolOf = (action: string): string => {
  const i = action.lastIndexOf("__");
  return i >= 0 ? action.slice(i + 2) : action;
};

/** 代码执行外壳的工具名 (只列真的会把整段脚本作为入参的)。 */
export const EXEC_SHELLS: ReadonlySet<string> = new Set(["REPL"]);

/** 脚本里允许的纯计算调用 (不碰工作区 / 不碰会话): 序列化与拼装回包用得上。 */
const SAFE_CALLS: ReadonlySet<string> = new Set([
  "JSON.stringify", "JSON.parse", "String", "Number", "Boolean",
  "Object.keys", "Object.values", "Object.entries", "Array.isArray",
  "Promise.all", "console.log", "console.warn", "console.error",
]);
/** REPL 自带的工具发现 (只读, 无副作用)。 */
const SHELL_META: ReadonlySet<string> = new Set(["REPL.searchTools", "REPL.describeTool", "REPL.describeTools"]);

type Ast = { type: string; [k: string]: any };

/** 静态成员链 (`mcp.wezard.chat_reply` / `mcp["wezard"].x`); 调用结果 / 下标变量认不出 → undefined。 */
const memberPath = (n: Ast | undefined): string | undefined => {
  if (!n) return undefined;
  if (n.type === "Identifier") return n.name as string;
  if (n.type !== "MemberExpression") return undefined;
  const head = memberPath(n.object as Ast);
  const key = n.computed
    ? n.property?.type === "Literal" && typeof n.property.value === "string" ? n.property.value as string : undefined
    : n.property?.type === "Identifier" ? n.property.name as string : undefined;
  return head === undefined || key === undefined ? undefined : head + "." + key;
};
/** 记进脚本的工具调用拼写 → 归一 (与 shared/tool-hints.ts 同一组拼写)。 */
const TOOL_SPELLINGS = ["mcp__wezard__", "mcp_wezard.", "mcp.wezard."] as const;
const toolNameOfPath = (path: string): string | undefined => {
  if (path.startsWith("tools.")) return path.slice("tools.".length);
  const spelling = TOOL_SPELLINGS.find((s) => path.startsWith(s));
  return spelling === undefined ? undefined : "mcp__wezard__" + path.slice(spelling.length);
};

/** 下钻一个 REPL 脚本: 所有调用都必须在 `tools` 白名单里 (纯计算 / 工具发现除外)。
 *  "" = 放行; 否则 = `refuse(what)` 给出的拒绝理由。 */
export const execToolRefusal = (code: unknown, tools: ReadonlySet<string>, refuse: (what: string) => string): string => {
  if (typeof code !== "string" || !code.trim()) return refuse("没有可读的脚本");
  let ast: Ast;
  try {
    ast = parse(code, { ecmaVersion: "latest", sourceType: "module", allowAwaitOutsideFunction: true, allowReturnOutsideFunction: true }) as unknown as Ast;
  } catch { return refuse("脚本解析不了"); }
  const aliases = new Map<string, string>();
  const expand = (path: string): string => {
    const [head, ...rest] = path.split(".");
    const base = aliases.get(head!);
    return base === undefined ? path : [base, ...rest].join(".");
  };
  let bad = "";
  const walk = (n: Ast): void => {
    if (bad) return;
    if (n.type === "VariableDeclarator") {
      const id = n.id as Ast; const init = n.init as Ast | null;
      const binding = memberPath(init ?? undefined);
      if (binding !== undefined) {
        if (id.type === "Identifier") aliases.set(id.name as string, binding);
        else if (id.type === "ObjectPattern") for (const p of (id.properties as Ast[]) ?? []) {
          const v = p.value as Ast;
          if (p.type !== "Property" || p.computed || p.kind !== "init" || v?.type !== "Identifier") continue;
          aliases.set(v.name as string, expand(binding + "." + String((p.key as Ast)?.name ?? (p.key as Ast)?.value)));
        }
      }
    } else if (n.type === "ImportExpression") {
      bad = "import(...)"; return;
    } else if (n.type === "CallExpression" || n.type === "NewExpression" || n.type === "TaggedTemplateExpression") {
      const callee = n.type === "TaggedTemplateExpression" ? n.tag as Ast : n.callee as Ast;
      const path = memberPath(callee);
      const full = path === undefined ? "" : expand(path);
      const tool = full ? toolNameOfPath(full) : undefined;
      const ok = n.type === "CallExpression"
        && ((tool !== undefined && tools.has(shortToolOf(tool))) || (path !== undefined && (SAFE_CALLS.has(full) || SHELL_META.has(full))));
      if (!ok) { bad = (path ? full + "()" : n.type === "NewExpression" ? "new ..." : "认不出的调用"); return; }
    }
    for (const v of Object.values(n)) {
      if (Array.isArray(v)) v.forEach((x) => { if (x && typeof x === "object" && typeof (x as Ast).type === "string") walk(x as Ast); });
      else if (v && typeof v === "object" && typeof (v as Ast).type === "string") walk(v as Ast);
    }
  };
  walk(ast);
  return bad ? refuse(bad) : "";
};
