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

/** 内层工具调用的名字: 对象字面量直传形态 (await Read({…}) / Write({…}), await 可省)。
 *  排除属性访问 (.map({…}) / String.raw({…})) 与 new X({…}) —— 那是普通 JS 不是工具。
 *  过宽匹配 (本地函数撞了工具名) 只会多问一次卡, 方向安全; 过窄 (非对象直传的
 *  调用形态) 由 Bash 侧的形状计数兜住, 其余工具按 schema 恒为对象入参。 */
const REPL_CALL_NAMES = /(?<![.\w])(?<!new\s)([A-Za-z_][A-Za-z0-9_.]*)\s*\(\s*\{/g;
export const replToolNames = (code: string): string[] =>
  [...code.matchAll(REPL_CALL_NAMES)].map((m) => m[1] ?? "").filter(Boolean);
