// 群管家 (聊天的默认会话) 的手闸。管家跑的是 models.steward 那档轻模型, 宪章里「分派, 别亲手干」
// 它一接到活就忘 —— 自己改一片代码, 全群排在它后面。所以在 PreToolUse 上由守护进程拦:
// 改文件 / 开子代理一律拒; 读代码放行 (人 2026-10-20 定的口径: 只拦「写」这一面)。
// 其余自己查 (状态命令、外部工具) 每轮限 budget 次。
// 拒的理由写成改道说明 —— 模型读 deny reason 就知道下一步是 dispatch。

/** 不占预算: 分派与协作本身 (wezard MCP)、不碰工作区的元工具, 以及读工作区 ——
 *  Read / Grep / Glob 与 cat / grep / git show 之类只读命令只看不改, 放它看。 */
const FREE = new Set(["ToolSearch", "TodoWrite", "AskUserQuestion", "EnterPlanMode", "ExitPlanMode", "Skill", "Read", "Grep", "Glob", "NotebookRead", "LSP"]);
/** 亲手干活: 管家一次都不做。 */
const HANDS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit", "Agent", "Task"]);

/** 只读的 shell 命令: 只认命令位 (行首或 `;` `&&` `||` `(` `$(` 之后) —— 管道后面的 grep / head 读的是上游输出 (`git log | grep x`), 不算。 */
const SHELL_READ = /(?:^|[;&|(]\s*|\$\(\s*)(?:cat|head|tail|sed|awk|grep|egrep|rg|ag|less|more|bat|nl|xxd|od|git\s+(?:show|diff|blame|grep))\b/;
const shellReads = (cmd: string): boolean =>
  cmd.split(/\n/).some((line) => SHELL_READ.test(line.replace(/\|\|/g, ";").replace(/\|[^|;&]*/g, "")));

// Bash 也能亲手干活: Edit/Write 被拦之后模型会绕到 sed -i / 重定向 / tee。这类判 hands,
// 不算 look —— 否则每轮 budget 次机会足够它把文件改完。`>&2` / `2>&1` / `2>/dev/null`
// 不写工作区, 放行; 引号里的 "-i" 可能误伤, 管家场景下宁严勿宽 (deny 只叫他去 dispatch)。
const REDIRECT = /(?:^|[\s;|&(])\d*>>?\s*([^\s&|]+)/g;
const bashWrites = (command: string): boolean => {
  if (/\bsed\b[^|;&]*\s-\w*i/.test(command)) return true;
  if (/\btee\b/.test(command)) return true;
  for (const m of command.matchAll(REDIRECT)) {
    if (!(m[1] ?? "").startsWith("/dev/")) return true;
  }
  return false;
};

type Kind = "free" | "hands" | "look";

// ── REPL (CodeBuddy PTC 模式) ──────────────────────────────────────────
// CodeBuddy 把一切工具调用 (Read / Bash / MCP) 包进 REPL 这一个工具的 code 参数里,
// 只按 toolName 判会把管家的读和 dispatch 全记成自查看吃配额; 配额一满连 dispatch
// 也被拒 —— 管家唯一合法的出路被自己人堵死 (死锁)。所以 REPL 下钻到内层调用名判:
// 读 / 派活 (mcp_wezard.*) 放行, 写文件 / 开子代理 / 写文件的 Bash 仍按原规则拦。
/** REPL 自带的元调用 (工具发现); ToolSearch 同级, 不碰工作区。 */
const REPL_META = new Set(["REPL.searchTools", "REPL.describeTool", "REPL.describeTools"]);
/** 调用位: 名字前不能是 `.` 或标识符字符 —— rows.map( 不算工具调用。 */
const CALL = /(?<![.\w$])([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*\(/g;
/** REPL 里 Bash 的 command 字面量; 变量拼的认不出 → 保守按 look 计。 */
const BASH_CMD = /\bBash\s*\(\s*\{[^{}]*?command\s*:\s*(`(?:[^`\\]|\\.)*`|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/g;
const unquote = (lit: string): string => {
  if (lit[0] === '"') { try { return JSON.parse(lit); } catch { return lit.slice(1, -1); } }
  return lit.slice(1, -1).replace(/\\(.)/gs, "$1");
};
/** 名字级判级; 不认识的调用不是工具, 返回 undefined 不参与判级。 */
const nameKind = (name: string): Kind | undefined =>
  REPL_META.has(name) || FREE.has(name) || /wezard/i.test(name) ? "free"
  : HANDS.has(name) ? "hands"
  : undefined;
const replKind = (code: string): Kind => {
  const names = [...code.matchAll(CALL)].map((m) => m[1] ?? "").filter(Boolean);
  const bashCalls = names.filter((n) => n === "Bash").length;
  const cmds = [...code.matchAll(BASH_CMD)].map((m) => unquote(m[1] ?? "")).filter(Boolean);
  const kinds = names.map(nameKind).filter((k): k is Kind => k !== undefined);
  if (bashCalls > 0) {
    // Bash 条数对不上字面量条数 = 有 command 是变量拼的, 认不出 → 保守。
    kinds.push(cmds.length < bashCalls ? "look"
      : cmds.some(bashWrites) ? "hands" : cmds.every(shellReads) ? "free" : "look");
  }
  // 又读又写的先算写 (写比读严重); 无可识别调用 = 纯计算, 仍按 look 吃配额。
  if (kinds.includes("hands")) return "hands";
  return kinds.length > 0 && kinds.every((k) => k === "free") ? "free" : "look";
};

const kindOf = (toolName: string, toolInput: unknown): Kind => {
  if (toolName === "REPL") {
    const code = (toolInput as { code?: unknown } | null)?.code;
    return typeof code === "string" ? replKind(code) : "look";
  }
  if (FREE.has(toolName) || /wezard/i.test(toolName)) return "free";
  if (HANDS.has(toolName)) return "hands";
  const cmd = (toolInput as { command?: unknown } | null)?.command;
  if (toolName !== "Bash" || typeof cmd !== "string") return "look";
  // 又读又写的 (sed -i 同时中两条) 先算写 —— 写比读严重, 拒的理由也要说对。
  if (bashWrites(cmd)) return "hands";
  return shellReads(cmd) ? "free" : "look";
};

const DISPATCH = "`dispatch({task, name, description})` 交出去 (task 写人的原话加你知道的背景)";
const handsReason = (toolName: string): string =>
  toolName === "REPL"
    ? `你是这个群的管家, 这段 REPL 在亲手干活 (写文件 / 开子代理) —— 管家一律不做, 用 ${DISPATCH}。这是守护进程拦的, 重试结果一样。`
    : toolName === "Bash"
    ? `你是这个群的管家, 这条 Bash 在写文件 —— 改文件管家一律不做 (sed -i / 重定向 / tee 也算), 用 ${DISPATCH}。这是守护进程拦的, 重试结果一样。`
    : `你是这个群的管家, ${toolName} 是亲手干活 —— 改文件、开子代理管家一律不做, 用 ${DISPATCH}。这是守护进程拦的, 重试结果一样。`;
const budgetReason = (budget: number): string =>
  `这一轮你已经自己跑了 ${budget} 次命令 —— 管家每轮只够看一两眼状态。还要接着查, 说明这是一件活: 用 ${DISPATCH}, 结论回来再向人交代。这是守护进程拦的, 别重试。`;

/** 一个管家会话本轮已查的次数; 轮次一换就归零。 */
interface Tally { turn: string; used: number }

/** 判一次管家的工具调用: 放行 = undefined, 拒 = 理由。`turn` 换了即新一轮; budget < 0 = 不设闸。 */
export const makeStewardGuard = () => {
  const tallies = new Map<string, Tally>();
  return (a: { sessionId: string; turn: string; toolName: string; toolInput: unknown; budget: number }): string | undefined => {
    if (a.budget < 0) return undefined;
    const kind = kindOf(a.toolName, a.toolInput);
    if (kind === "free") return undefined;
    if (kind === "hands") return handsReason(a.toolName);
    const prev = tallies.get(a.sessionId);
    const used = prev?.turn === a.turn ? prev.used : 0;
    if (used >= a.budget) return budgetReason(a.budget);
    tallies.set(a.sessionId, { turn: a.turn, used: used + 1 });
    return undefined;
  };
};
