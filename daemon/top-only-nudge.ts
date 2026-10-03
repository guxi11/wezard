// 顶层模式门控: 没开顶层模式 (chatPolicy.<chat>.topOnly) 的群里, wizard 之间当着人说话 (公开的
// tell_peer / dispatch) 一多, 群就被它们互相派活的气泡和回复刷屏 —— 提醒那个群的管家问人一句要不要开。
// 只往管家的信箱挂一行 (随它下一次注入到): 不另起一轮、不发气泡, 开不开由人定。
// 计数与冷却落盘扛 reload: 这里 reload 是家常便饭, 纯内存的话每次 reload 都会把「一天只提一次」重置掉。
import type { JsonMap } from "../shared/json-map-store.js";

export interface NudgePolicy { windowMs: number; threshold: number; cooldownMs: number }
/** 一个群的账: 窗口内各次公开往来的时刻, 与上次提醒的时刻。 */
export interface NudgeRow { at: number[]; nudgedAt?: number }

/** 记下 `now` 这一次之后这个群的账, 与这一次是否该提醒 (fire = 窗口内的次数, 0 = 不提)。
 *  提醒过就清空窗口: 冷却期满之后要重新攒够一窗才再提, 而不是冷却一过立刻因为旧账又响一次。 */
export const step = (row: NudgeRow | undefined, now: number, p: NudgePolicy): { row: NudgeRow; fire: number } => {
  const at = [...(row?.at ?? []).filter((t) => now - t < p.windowMs), now];
  const cooling = row?.nudgedAt !== undefined && now - row.nudgedAt < p.cooldownMs;
  const fire = !cooling && at.length >= p.threshold ? at.length : 0;
  const nudgedAt = fire ? now : row?.nudgedAt;
  return { row: { at: fire ? [] : at, ...(nudgedAt !== undefined ? { nudgedAt } : {}) }, fire };
};

/** 七天没动静的群不留账 —— 冷却最长也就按天算。 */
const STALE_MS = 7 * 24 * 60 * 60 * 1000;
export const gcNudge = (rows: Record<string, NudgeRow>, now = Date.now()): Record<string, NudgeRow> =>
  Object.fromEntries(Object.entries(rows).filter(([, r]) => Math.max(r.nudgedAt ?? 0, ...r.at) > now - STALE_MS));

/** config_set 路径里写哪个键: 聊天名好认, 但路径按 `.` 切段 —— 名字里带点就退回 principal。 */
export const policyKeyOf = (name: string, base: string): string => (name && !name.includes(".") ? name : base);

/** 挂进管家信箱的那一行。`chat` = config_set 路径里写的聊天 (名字或 principal)。 */
export const renderNudge = (chat: string, n: number, windowMin: number, cooldownH: number): string =>
  `本群最近 ${windowMin} 分钟有 ${n} 次 wizard 间公开往来 (派活气泡 + 回复都进了群)。人下次在群里跟你说话时顺带问一句要不要开**顶层模式** (人只和你 / 人点名的 wizard 说话, wizard 之间一律私聊、过程只在 rolepage): 人说开 → \`config_set({path:"chatPolicy.${chat}.topOnly", value:true})\`; 人不开就别再提 (${cooldownH} 小时内守护进程不再提醒)`;

/** 公开往来的计数器: `count(chat)` 在每条 wizard 间公开气泡进群时调一次。策略每次现读 (热生效); 阈值或窗口为 0 = 关。 */
export const createTopOnlyNudge = (o: {
  store: JsonMap<NudgeRow>;
  policy: () => NudgePolicy;
  nudge: (chat: string, n: number) => void;
  now?: () => number;
}) => ({
  count: (chat: string): void => {
    const p = o.policy();
    if (p.threshold <= 0 || p.windowMs <= 0) return;
    const { row, fire } = step(o.store.get(chat), (o.now ?? Date.now)(), p);
    o.store.set(chat, row);
    if (fire) o.nudge(chat, fire);
  },
});
