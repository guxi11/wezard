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

type Kind = "free" | "hands" | "read" | "look";
const kindOf = (toolName: string, toolInput: unknown): Kind => {
  if (FREE.has(toolName) || /wezard/i.test(toolName)) return "free";
  if (HANDS.has(toolName)) return "hands";
  if (READS.has(toolName)) return "read";
  const cmd = (toolInput as { command?: unknown } | null)?.command;
  return toolName === "Bash" && typeof cmd === "string" && shellReads(cmd) ? "read" : "look";
};

const DISPATCH = "`dispatch({task, name, description})` 交出去 (task 写人的原话加你知道的背景)";
const handsReason = (toolName: string): string =>
  `你是这个群的管家, ${toolName} 是亲手干活 —— 改文件、开子代理管家一律不做, 用 ${DISPATCH}。这是守护进程拦的, 重试结果一样。`;
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
