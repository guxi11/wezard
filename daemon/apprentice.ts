// v3 §7 学徒: 每 bot 实例唯一、代表人、连续唯一会话 (不是每群一个化身)。
//
// 这里只放判定、落位与巡检装配的纯函数, 不写盘、不 spawn:
//   apprenticeOf / isApprentice   唯一性与判定面 (stop/forget/evict/approval/charter 共用)
//   ensureApprentice              boot 落位: home (defaultChat) 是单聊时建档, 幂等, 不造跨机幽灵
//   handoffLineOf                 学徒的交接提醒线 = handoffAt 打五折 (小步交接, 鼓励先记再交)
//   ensurePatrolTask              自主巡检: boot 时按 config 装配一条 quiet 定时任务 (有界); 宪章学徒章在 wizard.ts (renderApprenticeRules)
//
// 连续会话 × 多群的输入路由不在这一层: 点名 (resolveName) 走 P2 的锚点回落 —— 学徒
// 的唯一记录 (target === identity) 就是锚点, 任何群点名都落它; 每条注入的信封自带
// chat= 属性 (renderHumanEnvelope), 回复按发话群回去 (dispatch.channel)。
import type { Config } from "../shared/config.js";
import { keyOf } from "../shared/session-label.js";
import { handoffAt, type WizardKind, type WizardStore } from "./wizard.js";
import type { TaskRegistry } from "./task-registry.js";
import { parseTrigger } from "../shared/trigger.js";

/** 学徒在名册里的唯一记录 (锚点优先: target === identity); 没有学徒 = undefined。 */
export const apprenticeOf = (store: WizardStore | undefined) =>
  (store?.all() ?? [])
    .filter((w) => w.kind === "apprentice")
    .sort((a, b) => Number(a.target !== a.identity) - Number(b.target !== b.identity) || a.bornAt - b.bornAt)[0];

/** 这个 target 是不是学徒 —— stop/forget/evict/审批豁免/宪章/交接线的共用判定面。 */
export const isApprentice = (store: WizardStore | undefined, target: string): boolean =>
  store?.get(target)?.kind === "apprentice";

export interface ApprenticeAnchor {
  /** 学徒的 target (= 它的身份锚点, 唯一会话挂在这里)。 */
  target: string;
  /** 这次 boot 有没有新建记录。 */
  created: boolean;
  /** 没落位的原因 (home 不是单聊 / 名字空): 留给日志, 不是错误。 */
  skipped?: string;
}

/** boot 落位 (§7): home (defaultChat) 是单聊时保证学徒记录存在, 幂等。
 *  home 不是 user: 形状 (还没认领 / 群为家) 不造幽灵 —— 认领后下一次 boot 自然接上,
 *  与 markGlobalSteward 同一口径。学徒住在 home 单聊的一个 slot 里 (不占默认会话 ——
 *  那是全局管家的锚点)。 */
export const ensureApprentice = (store: WizardStore, home: string, name: string, now = Date.now()): ApprenticeAnchor => {
  const existing = apprenticeOf(store);
  if (existing) return { target: existing.target, created: false };
  const h = home.trim();
  const n = name.trim();
  if (!h.startsWith("user:")) return { target: "", created: false, skipped: "home is not a DM principal" };
  if (!n) return { target: "", created: false, skipped: "empty apprentice name" };
  const target = keyOf(h, "apprentice");
  store.upsert(target, { identity: target, name: n, kind: "apprentice" satisfies WizardKind, bornAt: now });
  return { target, created: true };
};

/** 学徒的交接判断线: handoffAt(model) 打五折 —— 连续身份靠记忆不靠上下文, 小步交接,
 *  别撑到自动压缩才动手。 */
export const handoffLineOf = (store: WizardStore | undefined, target: string, model: string): number =>
  isApprentice(store, target) ? Math.round(handoffAt(model) / 2) : handoffAt(model);

/** 巡检指令: 有界 (每轮 maxItems 条), 产物只进会话/rolepage, 不许无界自转。 */
export const patrolPrompt = (cfg: Config): string => {
  const { maxItems, everyMin } = cfg.wrc.apprentice.patrol;
  return [
    "[学徒巡检] 自主整理一轮 (上限硬性):",
    `1. 最多整理 ${maxItems} 条发现 (挂起事项、名册异常、记忆去重提议、可收的 plan) —— 超过就只挑最重要的 ${maxItems} 条, 其余下轮。`,
    `2. 产物只写进本会话与 rolepage (计划/记忆/消项); 不主动发任何群 —— 要通知人必须显式 notify, 且仅在真需要人拍板时。`,
    `3. 没有值得报的就以 QUIET 一行收尾; 巡检间隔 ${everyMin} 分钟, 这轮没做完的留给下轮, 不要拉长这一轮。`,
  ].join("\n");
};

export const PATROL_TASK_ID = "apprentice-patrol";

/** boot 装配巡检 (幂等, config 是权威): enabled → 确保 id 固定的 quiet 定时任务存在且
 *  间隔/上限与 config 一致 (重建换内容, 状态清零 → 下一次到点是完整间隔后, 不会立刻放枪);
 *  disabled → 删掉。fresh 恒 false: 学徒是连续唯一会话, 定时永远注入它自己。 */
export const ensurePatrolTask = (
  registry: TaskRegistry,
  cfg: Config,
  apprenticeTarget: string,
  now = new Date(),
): { active: boolean; recreated: boolean } => {
  const patrol = cfg.wrc.apprentice.patrol;
  const existing = registry.list().find((t) => t.id === PATROL_TASK_ID);
  if (!patrol.enabled || !apprenticeTarget) {
    if (existing) registry.remove(PATROL_TASK_ID);
    return { active: false, recreated: false };
  }
  const trigger = parseTrigger(`every ${patrol.everyMin}m`, now);
  if (!trigger) return { active: false, recreated: false };
  const prompt = patrolPrompt(cfg);
  if (existing && existing.target === apprenticeTarget && existing.prompt === prompt
    && JSON.stringify(existing.trigger) === JSON.stringify(trigger) && existing.enabled) {
    return { active: true, recreated: false };
  }
  if (existing) registry.remove(PATROL_TASK_ID);
  registry.create({
    id: PATROL_TASK_ID,
    trigger,
    prompt,
    target: apprenticeTarget,
    fresh: false,
    quiet: true,
    note: "学徒自主巡检 (v3 §7; config wrc.apprentice.patrol 是权威, 手改这条会被 boot 覆盖)",
    createdBy: apprenticeTarget,
  });
  return { active: true, recreated: true };
};
