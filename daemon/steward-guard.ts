// 群管家 (聊天的默认会话) 的手闸。管家跑的是 models.router 那档轻模型, 宪章里「分派, 别亲手干」
// 它一接到活就忘 —— 自己读一片代码、自己改, 全群排在它后面。所以在 PreToolUse 上由守护进程拦:
// 改文件 / 开子代理一律拒; 自己查 (读、搜、跑命令、外部工具) 每轮限 budget 次, 够答一两句话,
// 不够啃完一片代码。拒的理由写成改道说明 —— 模型读 deny reason 就知道下一步是 dispatch。

/** 不占预算: 分派与协作本身 (wezard MCP), 以及不碰工作区的元工具。 */
const FREE = new Set(["ToolSearch", "TodoWrite", "AskUserQuestion", "EnterPlanMode", "ExitPlanMode", "Skill"]);
/** 亲手干活: 管家一次都不做。 */
const HANDS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit", "Agent", "Task"]);

type Kind = "free" | "hands" | "look";
const kindOf = (toolName: string): Kind =>
  FREE.has(toolName) || /wezard/i.test(toolName) ? "free" : HANDS.has(toolName) ? "hands" : "look";

const DISPATCH = "`dispatch({task, name, description})` 交出去 (task 写人的原话加你知道的背景)";
const handsReason = (toolName: string): string =>
  `你是这个群的管家, ${toolName} 是亲手干活 —— 改文件、开子代理管家一律不做, 用 ${DISPATCH}。这是守护进程拦的, 重试结果一样。`;
const budgetReason = (budget: number): string =>
  `这一轮你已经自己查了 ${budget} 次 —— 管家每轮只够看一两眼。还要接着读代码 / 跑命令, 说明这是一件活: 用 ${DISPATCH}, 结论回来再向人交代。这是守护进程拦的, 别重试。`;

/** 一个管家会话本轮已查的次数; 轮次一换就归零。 */
interface Tally { turn: string; used: number }

/** 判一次管家的工具调用: 放行 = undefined, 拒 = 理由。`turn` 换了即新一轮; budget < 0 = 不设闸。 */
export const makeStewardGuard = () => {
  const tallies = new Map<string, Tally>();
  return (a: { sessionId: string; turn: string; toolName: string; budget: number }): string | undefined => {
    if (a.budget < 0) return undefined;
    const kind = kindOf(a.toolName);
    if (kind === "free") return undefined;
    if (kind === "hands") return handsReason(a.toolName);
    const prev = tallies.get(a.sessionId);
    const used = prev?.turn === a.turn ? prev.used : 0;
    if (used >= a.budget) return budgetReason(a.budget);
    tallies.set(a.sessionId, { turn: a.turn, used: used + 1 });
    return undefined;
  };
};
