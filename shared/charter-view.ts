// 宪章视图 —— 一个 wizard 出生时 wezard 压进它系统提示的那份身份, 按小节拆开、标上体量,
// 再配一个实测的开局底座, 让人看得出「这个 wizard 一睁眼就背着多少, 其中多少是 wezard 给的」。
// 纯函数: 输入是 detail store 的记录, daemon 与独立 svr 共用。
import type { CharterRecord, DetailRecord, TurnDetailRecord } from "./detail-store.js";

/** 粗估 token: CJK 约一字一 token, 其余约 3.6 字符一 token。只为看比例, 不冒充计费口径。 */
export const estTokens = (s: string): number => {
  const cjk = (s.match(/[　-鿿＀-￯]/g) ?? []).length;
  return Math.round(cjk * 1.1 + (s.length - cjk) / 3.6);
};

export interface CharterSection { title: string; tokens: number; body: string }

/** 按 `## ` 切节; 第一节是 `# ` 总起那段。 */
export const sectionsOf = (text: string): CharterSection[] =>
  text.split(/^(?=## )/m).filter((x) => x.trim()).map((chunk) => {
    const [head = "", ...rest] = chunk.split("\n");
    return { title: head.replace(/^#+\s*/, "").trim(), tokens: estTokens(chunk), body: rest.join("\n").trim() };
  });

const isCharter = (r: DetailRecord): r is CharterRecord => r.kind === "charter";
const isTurnRec = (r: DetailRecord): r is TurnDetailRecord => r.kind === "turn";

export const charterOf = (records: readonly DetailRecord[], role: string): CharterRecord | undefined =>
  records.filter(isCharter).find((r) => r.target === role);

/** 实测底座: 宪章落下之后这个 wizard 的第一轮 (主会话, 不算子 agent) 第一次调用送入的上下文。
 *  `resumed` = 那一段是 --resume 续上的老会话, 底座里还含着它之前的对话, 不是纯开局。 */
export const baselineOf = (records: readonly DetailRecord[], c: CharterRecord): { ctx: number; at: number; resumed: boolean } | undefined => {
  const turns = records.filter(isTurnRec).filter((t) => t.target === c.target && !t.agent);
  const first = turns.filter((t) => t.createdAt >= c.createdAt).sort((a, b) => a.createdAt - b.createdAt)[0];
  const ctx = first?.usage?.ctxFirst;
  if (!first || !ctx) return undefined;
  return { ctx, at: first.createdAt, resumed: turns.some((t) => t.createdAt < c.createdAt && !!first.sessionId && t.sessionId === first.sessionId) };
};

/** 侧栏入口要的那一点: 有没有、多大、何时。 */
export const charterBrief = (records: readonly DetailRecord[], role: string): { tokens: number; at: number } | undefined => {
  const c = charterOf(records, role);
  return c && { tokens: estTokens(c.text), at: c.createdAt };
};

export const charterView = (records: readonly DetailRecord[], role: string) => {
  const c = charterOf(records, role);
  if (!c) return undefined;
  return { at: c.createdAt, tokens: estTokens(c.text), sections: sectionsOf(c.text), baseline: baselineOf(records, c) };
};
