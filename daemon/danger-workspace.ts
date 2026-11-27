// 危险名单的「workspace 内放行」(admin 2026-11-27 605: 目标都在当前 workspace 里就不弹危险卡)。
//
// 现状: rm / git 丢弃改动早在 2026-11-03 就移出名单, 今天还会因「删除 / 覆盖」弹卡的只剩两条命令规则 ——
// `find … -delete | -exec rm` (批量删除) 与 `truncate` (清空文件)。本模块只回答一件事:
// 「这条命令里每一处命中这两条规则的动作, 它的目标是不是都能**静态确定**地落在 workspace 里」。
// 是 → 调用方把这两条规则摘掉再判其余规则; 有任何一处不确定 → false, 保持原判 (宁可多一张卡)。
//
// 「真解析」的口径 (任何一条过不了就 false):
//   · 词里带 `$` / 反引号 / `*?[` 通配 / `{`: 解不出, 不算;
//   · `~` `$HOME` 之外的变量不展开; 相对路径按会话 cwd 解析, `..` 先 normalize 再比;
//   · 再对最长的已存在前缀做 realpath: 符号链接指到 workspace 外 → 不算; workspace 自身也 realpath;
//   · workspace 根本身 (truncate .)、任何落在 `.git` 里的目标 → 不算; 不在 workspace 的绝对路径 → 不算;
//   · 命令里出现 `$(…)` / 反引号 / 子 shell 括号 / `{ }` / cd·pushd·popd 之后的相对路径 (cwd 变了, 静态不可知) → 不算;
//   · find: 带 -L / -follow (会跟着软链出去) 或 -fprint* / -fls (写任意路径)、-exec 的不是纯 `rm` → 不算;
//     搜索根可以是 workspace 根 (`find . -name '*.pyc' -delete` 是最常见的用法), 但必须带**筛选条件**
//     (-name / -path / -regex / -newer / -mtime / -size / -empty …, 且 -name 不能是纯 `*`) —— 无筛选的
//     `find . -delete` 等于清空整个 workspace 连同 .git。残余风险: 带筛选的 find 从根出发会走进 .git,
//     名字恰好匹配筛选的 .git 内文件也会被删 —— 与「目标是搜索根」同一口径, 在 CHANGELOG 里写明。
import { existsSync, realpathSync } from "node:fs";
import { posix } from "node:path";
import { shellWords } from "./danger-scrub.js";

/** 这两条规则的标签 (danger.ts CMD_RULES 里的名字), 只有它们能被 workspace 放行摘掉。 */
export const WORKSPACE_SCOPED_RULES: ReadonlySet<string> = new Set(["批量删除 find -delete", "清空文件 truncate"]);

const DESTRUCTIVE = /\bfind\b|-delete\b|-exec(?:dir)?\s+rm\b|\btruncate\b/;
const SELECTIVE = new Set([
  "-name", "-iname", "-path", "-ipath", "-wholename", "-iwholename", "-regex", "-iregex", "-lname", "-ilname",
  "-newer", "-anewer", "-cnewer", "-mtime", "-mmin", "-atime", "-amin", "-ctime", "-cmin", "-size", "-empty",
]);
const NAME_TESTS = new Set(["-name", "-iname", "-path", "-ipath", "-wholename", "-iwholename"]);
const FIND_WRITES = /^-f(?:print0?|printf|ls)$/;

const homeOf = (): string => process.env.HOME ?? "";
const expandHome = (p: string): string => p.replace(/^(?:~|\$HOME|\$\{HOME\})(?=\/|$)/, homeOf());
/** 路径词里有动态成分 / 通配: 静态解不出。 */
const unresolvable = (w: string): boolean => /[$`*?[\]{}]/.test(expandHome(w));

/** 最长已存在前缀 realpath + 余下部分拼回 (目标文件可能还不存在, 但它的目录链不能是出口)。 */
const realOf = (abs: string): string => {
  const parts = abs.split("/");
  const tail: string[] = [];
  while (parts.length > 1 && !existsSync(parts.join("/") || "/")) tail.unshift(parts.pop()!);
  try {
    return posix.join(realpathSync(parts.join("/") || "/"), ...tail);
  } catch {
    return abs;
  }
};

const inside = (root: string, p: string, allowRoot: boolean): boolean => {
  const rel = posix.relative(root, p);
  if (rel === "") return allowRoot;
  return !rel.startsWith("..") && !posix.isAbsolute(rel) && !rel.split("/").includes(".git");
};

/** 一个路径词 → workspace 内吗 (cwd 未知时只认绝对路径)。 */
const pathInWorkspace = (w: string, cwd: string | undefined, root: string, allowRoot: boolean): boolean => {
  if (unresolvable(w)) return false;
  const e = expandHome(w);
  const abs = e.startsWith("/") ? posix.normalize(e) : cwd ? posix.normalize(posix.join(cwd, e)) : undefined;
  return abs !== undefined && inside(root, realOf(abs), allowRoot);
};

/** 按命令分隔符切成简单命令 (引号内、反斜杠转义的 `\;` 不算分隔); 返回 undefined = 结构太复杂, 放弃。 */
const simpleCommands = (text: string): string[] | undefined => {
  if (/\$\(|`|<\(|>\(/.test(text)) return undefined;
  const segs: string[] = [];
  let cur = "";
  let q = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (q) { cur += c; if (c === q) q = ""; else if (c === "\\" && q === '"' && i + 1 < text.length) cur += text[++i]; continue; }
    if (c === "\\" && i + 1 < text.length) { cur += c + text[++i]; continue; }
    if (c === "'" || c === '"') { q = c; cur += c; continue; }
    if (c === "(" || c === ")" || c === "{" || c === "}") return undefined; // 子 shell / 命令组: cwd 与范围都不可静态确定 (find 的 `{}` 占位在引号或 `\;` 前, 见下)
    if (c === ";" || c === "&" || c === "|" || c === "\n") { segs.push(cur); cur = ""; continue; }
    cur += c;
  }
  segs.push(cur);
  return q ? undefined : segs.filter((s) => s.trim());
};

/** find 的 `{}` 是占位符, 不是命令组: 切分前先换成无害记号。 */
const maskFindBraces = (text: string): string => text.replace(/(^|\s)\{\}(?=\s|$)/g, "$1__FIND_BRACES__");

/** 去掉重定向 (`>f` / `2>` f / `<f`): 它们不是 find / truncate 的操作数。 */
const redirectFree = (words: readonly string[]): string[] =>
  words.flatMap((w, i) => (/^\d*[<>]/.test(w) || (i > 0 && /^\d*[<>]+&?$/.test(words[i - 1]!)) ? [] : [w]));

const findScoped = (all: readonly string[], cwd: string | undefined, root: string): boolean => {
  const args = redirectFree(all).slice(1).map((w) => (w === "__FIND_BRACES__" ? "{}" : w));
  const lead = args.findIndex((w) => !/^-[HLP]$/.test(w));
  if (args.slice(0, lead < 0 ? args.length : lead).includes("-L")) return false;
  const rest = lead < 0 ? [] : args.slice(lead);
  const exprAt = rest.findIndex((w) => w.startsWith("-") || w === "(" || w === "!");
  const paths = exprAt < 0 ? rest : rest.slice(0, exprAt);
  const expr = exprAt < 0 ? [] : rest.slice(exprAt);
  if (expr.some((w) => w === "-follow" || FIND_WRITES.test(w) || /^-ok(?:dir)?$/.test(w))) return false;
  // -exec / -execdir 只许 `rm [-flags] {}` 且以 `;` / `+` 收尾 (其余命令是未知动作)。
  const execs = expr.flatMap((w, i) => (w === "-exec" || w === "-execdir" ? [i] : []));
  const execOk = execs.every((i) => {
    const end = expr.findIndex((w, j) => j > i && (w === ";" || w === "+"));
    if (end < 0) return false;
    const cmd = expr.slice(i + 1, end);
    return /^(?:.*\/)?rm$/.test(cmd[0] ?? "") && cmd.slice(1).every((a) => /^-[a-zA-Z]+$/.test(a) || a === "{}");
  });
  if (!execOk) return false;
  const selective = expr.some((w, i) => SELECTIVE.has(w) && !(NAME_TESTS.has(w) && /^\*+$/.test(expr[i + 1] ?? "")));
  if (!selective) return false;
  const roots = paths.length ? paths : ["."];
  return roots.every((p) => pathInWorkspace(p, cwd, root, true));
};

const TRUNCATE_ARG_OPTS = new Set(["-s", "--size", "-r", "--reference"]);
const truncateScoped = (all: readonly string[], cwd: string | undefined, root: string): boolean => {
  const args = redirectFree(all).slice(1);
  const targets: string[] = [];
  let ended = false;
  for (let i = 0; i < args.length; i++) {
    const w = args[i]!;
    if (!ended && w === "--") { ended = true; continue; }
    if (!ended && w.startsWith("-") && w !== "-") {
      if (TRUNCATE_ARG_OPTS.has(w)) i++; // 吞掉它的值 (-r 的参照文件只读, 不是目标)
      continue;
    }
    targets.push(w);
  }
  return targets.length > 0 && targets.every((t) => pathInWorkspace(t, cwd, root, false));
};

const headOf = (words: readonly string[]): string => (words[0] ?? "").replace(/^\\/, "").replace(/^.*\//, "");
const CD = /^(?:cd|pushd|popd|chdir)$/;

/**
 * 这条命令里每一处 find 批量删除 / truncate 的目标是否都静态落在 workspace 内。
 * `cwd` 是会话工作目录 (空 = 无从解析, 一律 false)。
 */
export const destructiveWithinWorkspace = (command: string, cwd: string | undefined): boolean => {
  if (!cwd || !cwd.startsWith("/")) return false;
  const root = realOf(posix.normalize(cwd));
  const segs = simpleCommands(maskFindBraces(command));
  if (!segs) return false;
  const cmds = segs.map((s) => shellWords(s));
  const moved = cmds.some((w) => CD.test(headOf(w))); // cd 之后相对路径的基准变了, 只认绝对路径
  const effCwd = moved ? undefined : posix.normalize(cwd);
  return cmds.every((w, i) => {
    const head = headOf(w);
    if (head === "find") return findScoped(w, effCwd, root);
    if (head === "truncate") return truncateScoped(w, effCwd, root);
    return !DESTRUCTIVE.test(segs[i]!); // 别的命令里不许藏 find / -delete / truncate (sh -c '…' / ssh host … / 管道对端)
  });
};
