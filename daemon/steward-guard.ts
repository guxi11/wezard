// 群管家 (聊天的默认会话) 的手闸。管家跑的是 models.steward 那档轻模型, 宪章里「分派, 别亲手干」
// 它一接到活就忘 —— 自己读一片代码、自己改, 全群排在它后面。所以在 PreToolUse 上由守护进程拦:
// 改文件 / 开子代理 / 读代码一律拒; 其余自己查 (状态命令、外部工具) 每轮限 budget 次。
// 读代码也一律拒, 是因为按次数的预算拦不住它: grep 一下、分段 Read 两刀就在预算内读完一个
// 模块, 然后自己答了「机制 / 还会不会…」类的问题 —— 能读就会读完就答, 只能让它读不了。
// 拒的理由写成改道说明 —— 模型读 deny reason 就知道下一步是 dispatch。

/** 不占预算: 分派与协作本身 (wezard MCP), 以及不碰工作区的元工具。 */
const FREE = new Set(["ToolSearch", "TodoWrite", "AskUserQuestion", "EnterPlanMode", "ExitPlanMode", "Skill"]);
/** 亲手干活: 管家一次都不做。 */
const HANDS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit", "Agent", "Task"]);

/** 读工作区内容的工具: 管家也一次都不做。 */
const READS = new Set(["Read", "Grep", "Glob", "NotebookRead", "LSP"]);
/** 读文件内容的 shell 命令: 只认命令位 (行首或 `;` `&&` `||` `(` `$(` 之后) —— 管道后面的 grep / head 读的是上游输出 (`git log | grep x`), 不算读代码。 */
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

type Kind = "free" | "hands" | "read" | "look";
const kindOf = (toolName: string, toolInput: unknown): Kind => {
  if (FREE.has(toolName) || /wezard/i.test(toolName)) return "free";
  if (HANDS.has(toolName)) return "hands";
  if (READS.has(toolName)) return "read";
  const cmd = (toolInput as { command?: unknown } | null)?.command;
  if (toolName !== "Bash" || typeof cmd !== "string") return "look";
  // 又读又写的 (sed -i 同时中两条) 先算写 —— 写比读严重, 拒的理由也要说对。
  if (bashWrites(cmd)) return "hands";
  return shellReads(cmd) ? "read" : "look";
};

const DISPATCH = "`dispatch({task, name, description})` 交出去 (task 写人的原话加你知道的背景)";
const handsReason = (toolName: string): string =>
  toolName === "Bash"
    ? `你是这个群的管家, 这条 Bash 在写文件 —— 改文件管家一律不做 (sed -i / 重定向 / tee 也算), 用 ${DISPATCH}。这是守护进程拦的, 重试结果一样。`
    : `你是这个群的管家, ${toolName} 是亲手干活 —— 改文件、开子代理管家一律不做, 用 ${DISPATCH}。这是守护进程拦的, 重试结果一样。`;
const readReason = (toolName: string): string =>
  `你是这个群的管家, ${toolName} 是在读代码 —— 读代码就是一件活, 管家一次都不读, 哪怕看一眼就像能答 (机制 / 原理 / 「现在还会不会…」/ 方案 / 排查都算): 用 ${DISPATCH}, 结论回来再向人交代。这是守护进程拦的, 别重试、别换工具绕。`;
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
    if (kind === "read") return readReason(a.toolName);
    const prev = tallies.get(a.sessionId);
    const used = prev?.turn === a.turn ? prev.used : 0;
    if (used >= a.budget) return budgetReason(a.budget);
    tallies.set(a.sessionId, { turn: a.turn, used: used + 1 });
    return undefined;
  };
};
