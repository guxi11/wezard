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

/** 数据键: 值是路径 / 文件正文 / 检索词 / 给人看的散文, 不是要执行的命令 ——
 *  Edit 的 new_string、Write 的 content、Read 的 file_path、Grep 的 pattern、
 *  Agent 的 prompt…… 内容里出现 "rm " 不等于删文件 (人 2026-10-28 口径: 只有
 *  真会交给 shell 执行的才做命令级判定)。没列到的键按 fail-closed 仍当命令扫:
 *  陌生工具的字符串参数不知道会不会被执行。 */
export const DATA_KEYS = new Set([
  "file_path", "notebook_path", "path", "cwd",
  "content", "old_string", "new_string", "new_source", "cell_id", "cell_type", "edit_mode",
  "pattern", "glob", "url", "query",
  "prompt", "description", "summary", "subject", "text", "markdown", "note", "brief",
  "caption", "title", "name", "activeForm",
]);

// 字面量紧前面的「属性键:」形态; 认不出键 = 裸字面量 (变量赋值 / 拼接 / 数组元素)。
const KEY_BEFORE = /([A-Za-z_$][\w$]*)\s*:\s*$/;

/** 逐字符扫描 REPL 脚本, 按层分离 (人 2026-10-28 口径: 严格校验 code, 分离可
 *  执行部分与注释/描述):
 *   · 注释 (行/块) —— 整段跳过, 永不参与判定; 注释里的引号 (don't) 也不会再
 *     吞掉后面的真代码。
 *   · 字符串/模板字面量 —— 整体消费 (不钻内部), 按紧前的属性键分类: 命令键
 *     (command/cmd/script/shell) 的值、裸字面量 (变量赋值/拼接/裸参数)、陌生键
 *     的值 → 当命令兜底 (fail-closed: 动态拼接、eval、未知工具的参数都解析不出
 *     确定性); 已知数据键 (DATA_KEYS: 路径/正文/检索词/散文) 的值 → 数据, 不判。
 *   · 正则字面量 —— 按表达式位置识别并整体跳过 (里面的引号不是字符串边界)。
 *  返回「可能是命令」的字面量文本, 供危险名单兜底 —— 替代旧的「整段脚本当命令
 *  文本」: 那会把 Edit/Write 的内容、Read 的路径误判成删除动作; 而变量拼的
 *  'rm -rf x' (裸赋值) 仍在这里被抓到。 */
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
      if (!(key && DATA_KEYS.has(key))) {
        const text = unquote(code.slice(start, Math.min(i, n)));
        if (text.trim()) out.push(text);
      }
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
