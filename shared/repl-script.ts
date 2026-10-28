// CodeBuddy REPL (PTC 模式) 把真正的工具调用包在脚本里:
//   REPL({ code: "const w = await Bash({ command: `cd /tmp && rm -rf x` });" })
// 只看顶层入参等于「没有命令」—— 危险名单整条失效, 管家手闸也读不到内层调用。
// 两处都要看内层那条命令, 所以「脚本里哪一段是命令」只写一份: 需要就 import, 别各写一版正则。

/** 内层 Bash 的 command 字面量: 反引号 / 双引号 / 单引号三种写法。 */
export const BASH_CMD = /\bBash\s*\(\s*\{[^{}]*?command\s*:\s*(`(?:[^`\\]|\\.)*`|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/g;

/** 字面量去引号; 双引号按 JSON 转义解 (`\n` → 换行), 其余按反斜杠转义。 */
export const unquote = (lit: string): string => {
  if (lit[0] === '"') { try { return JSON.parse(lit); } catch { return lit.slice(1, -1); } }
  return lit.slice(1, -1).replace(/\\(.)/gs, "$1");
};

/** 脚本里内层 Bash 的命令文本, 顺序同出现顺序。
 *  可能少于 Bash 调用数 —— 命令是变量拼的, 那就认不出这几条 (调用方自己决定保守口径)。 */
export const replBashCommands = (code: string): string[] =>
  [...code.matchAll(BASH_CMD)].map((m) => unquote(m[1] ?? "")).filter(Boolean);

/** 脚本里 Bash 调用形状的总数 (含 command 是变量、认不出字面量的那些)。
 *  与 replBashCommands 的差值 = 认不出的 Bash 调用 —— 白名单侧据此整体拒 (放行方向
 *  必须fail-closed: 一条变量拼的命令就足以让整条 REPL 不可证明安全)。 */
export const replBashCallCount = (code: string): number =>
  [...code.matchAll(/\bBash\s*\(/g)].length;

/** 命令键: 值会被 shell 执行的入参名 (Bash.command, 以及 mcp run_script({script})
 *  这类)。顶层工具入参和 REPL 兜底共用这一份语义。 */
export const COMMAND_KEYS = new Set(["command", "cmd", "script", "shell"]);

// 字面量紧前面的「属性键:」形态; 认不出键 = 裸字面量 (变量赋值 / 拼接 / 数组元素)。
const KEY_BEFORE = /([A-Za-z_$][\w$]*)\s*:\s*$/;

/** 逐字符扫描 REPL 脚本, 按层分离 (人 2026-10-28 口径: 严格校验 code, 分离可
 *  执行部分与注释/描述; **认不出的一律不当命令** —— 无法完整识别的操作不判
 *  danger, danger 必须有看得见的理由):
 *   · 注释 (行/块) —— 整段跳过, 永不参与判定; 注释里的引号 (don't) 也不会再
 *     吞掉后面的真代码。
 *   · 字符串/模板字面量 —— 整体消费 (不钻内部), 只认紧前属性键是**命令键**
 *     (command/cmd/script/shell, 含 mcp run_script({script})) 的值 —— 键本身就
 *     说明这个值会被 shell 执行。其余一律不当命令 (数据键的 file_path/content/
 *     new_string/prompt、陌生键、变量赋值/拼接/裸参数): 认不准不立 danger ——
 *     需要审的交给普通卡。
 *   · 正则字面量 —— 按表达式位置识别并整体跳过 (里面的引号不是字符串边界)。 */
export const replFallbackCommands = (code: string): string[] => {
  const out: string[] = [];
  const n = code.length;
  let i = 0;
  // 上一个有意义的非空白字符 —— 区分 / 是除号还是正则开始。
  let prev = "";
  while (i < n) {
    const ch = code[i]!;
    if (ch === "/" && code[i + 1] === "/") { // 行注释
      while (i < n && code[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && code[i + 1] === "*") { // 块注释 (含 docstring 形态)
      i += 2;
      while (i < n && !(code[i] === "*" && code[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    if (ch === "/" && (!prev || "(,=:[!&|?+-*%^<>~;{}".includes(prev))) { // 正则字面量
      i++;
      while (i < n && code[i] !== "/") { if (code[i] === "\\") i++; i++; }
      i++;
      while (i < n && /[a-z]/i.test(code[i]!)) i++; // flags
      prev = "x";
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") { // 字符串/模板: 整体消费
      const start = i;
      i++;
      while (i < n && code[i] !== ch) { if (code[i] === "\\") i++; i++; }
      i++; // 收引号; 未闭合则吞到结尾, 该段整体按一个字面量处理 (代码已非法, 保守)
      const key = KEY_BEFORE.exec(code.slice(Math.max(0, start - 64), start))?.[1];
      if (!key || !COMMAND_KEYS.has(key)) continue; // 数据键/陌生键/裸字面量: 认不准, 不当命令
      const text = unquote(code.slice(start, Math.min(i, n)));
      if (text.trim()) out.push(text);
      prev = ch;
      continue;
    }
    if (!/\s/.test(ch)) prev = ch;
    i++;
  }
  return out;
};

/** 内层工具调用的名字: 对象字面量直传形态 (await Read({…}) / Write({…}), await 可省)。
 *  排除属性访问 (.map({…}) / String.raw({…})) 与 new X({…}) —— 那是普通 JS 不是工具。
 *  过宽匹配 (本地函数撞了工具名) 只会多问一次卡, 方向安全; 过窄 (非对象直传的
 *  调用形态) 由 Bash 侧的形状计数兜住, 其余工具按 schema 恒为对象入参。 */
const REPL_CALL_NAMES = /(?<![.\w])(?<!new\s)([A-Za-z_][A-Za-z0-9_.]*)\s*\(\s*\{/g;
export const replToolNames = (code: string): string[] =>
  [...code.matchAll(REPL_CALL_NAMES)].map((m) => m[1] ?? "").filter(Boolean);

// ── 内层 AskUserQuestion (codebuddy PTC / REPL) ─────────────────────────
// PTC 模式下提问长这样: REPL({ code: "await AskUserQuestion({ questions: [...] })" })
// —— 顶层工具名是 REPL, 转录里没有独立的 AskUserQuestion 记录。mirror 只认顶层
// 工具名就整张投票卡漏掉, 本地面板成了唯一出口 (2026-10-28 实测: 人被迫回终端作答)。
// 这里把脚本里那个对象字面量读出来喂给 parseAskqInput。
// **不求值** —— 脚本是模型写的任意代码; 读不出 (questions 是变量、模板串带插值、
// spread、简写属性) 就返回 undefined, 退回「不发卡」的旧行为, 不猜。

type ReplLit = string | number | boolean | null | ReplLit[] | { [k: string]: ReplLit };

const skipWs = (s: string, i: number): number => {
  while (i < s.length && /\s/.test(s[i]!)) i++;
  return i;
};

/** 字面量字符串: '…' / "…" / 反引号。模板里带插值就说不出值, 认不出。 */
const readReplString = (s: string, i: number): { v: string; end: number } | undefined => {
  const q = s[i];
  if (q !== '"' && q !== "'" && q !== "`") return undefined;
  let j = i + 1;
  while (j < s.length && s[j] !== q) {
    if (s[j] === "\\") { j += 2; continue; }
    if (q === "`" && s[j] === "$" && s[j + 1] === "{") return undefined;
    j++;
  }
  if (j >= s.length) return undefined;
  return { v: unquote(s.slice(i, j + 1)), end: j + 1 };
};

const readReplValue = (s: string, i0: number): { v: ReplLit; end: number } | undefined => {
  const i = skipWs(s, i0);
  const ch = s[i];
  if (ch === undefined) return undefined;
  if (ch === "{") return readReplObject(s, i);
  if (ch === "[") return readReplArray(s, i);
  const str = readReplString(s, i);
  if (str) return str;
  const num = /^-?\d+(?:\.\d+)?/.exec(s.slice(i));
  if (num) return { v: Number(num[0]), end: i + num[0].length };
  const word = /^(true|false|null)\b/.exec(s.slice(i));
  if (word) return { v: word[0] === "null" ? null : word[0] === "true", end: i + word[0].length };
  return undefined; // 变量 / 常量 / 表达式: 读不出值
};

const readReplObject = (s: string, i: number): { v: { [k: string]: ReplLit }; end: number } | undefined => {
  const out: { [k: string]: ReplLit } = {};
  let j = skipWs(s, i + 1);
  while (j < s.length) {
    if (s[j] === "}") return { v: out, end: j + 1 };
    if (s[j] === ",") { j = skipWs(s, j + 1); continue; }
    const quoted = readReplString(s, j);
    const bare = quoted ? undefined : /^[A-Za-z_$][\w$]*/.exec(s.slice(j));
    const key = quoted ? quoted.v : bare?.[0];
    if (key === undefined) return undefined; // spread / 计算键
    j = skipWs(s, quoted ? quoted.end : j + key.length);
    if (s[j] !== ":") return undefined; // 简写属性 / 方法
    const val = readReplValue(s, j + 1);
    if (!val) return undefined;
    out[key] = val.v;
    j = skipWs(s, val.end);
  }
  return undefined;
};

const readReplArray = (s: string, i: number): { v: ReplLit[]; end: number } | undefined => {
  const out: ReplLit[] = [];
  let j = skipWs(s, i + 1);
  while (j < s.length) {
    if (s[j] === "]") return { v: out, end: j + 1 };
    if (s[j] === ",") { j = skipWs(s, j + 1); continue; }
    const val = readReplValue(s, j);
    if (!val) return undefined;
    out.push(val.v);
    j = skipWs(s, val.end);
  }
  return undefined;
};

/** 脚本里内层 AskUserQuestion 的入参 ({ questions: [...] }); 读不出返回 undefined。 */
export const replAskqInput = (code: unknown): { questions: unknown } | undefined => {
  if (typeof code !== "string") return undefined;
  const head = /\bAskUserQuestion\s*\(\s*\{/.exec(code);
  if (!head) return undefined;
  const obj = readReplObject(code, head.index + head[0].length - 1);
  const questions = obj?.v.questions;
  if (!Array.isArray(questions)) return undefined;
  return { questions };
};
