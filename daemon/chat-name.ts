// 聊天名 — **已冻结的读侧** (人 2026-11-16 拍板: 聊天不需要名字, 一律用 chat id)。
//
// 一个 WeCom 聊天的身份是 `chat:wrkSxxxxx…` 这种不可读 id; chats{} 表曾是
// 「名字 → base principal」的写入侧 (/name / name_chat / 按工作区自动补名)。现在
// 写入侧整体下线: 新群走引导 (onboarding.ts), wizard 名字只剩管家身份名一种
// (/name / wizard_identity), 聊天一律用 principal 标识。
//
// 存量已命名的聊天**保留为纯显示标签**: rolepage / 名册 / 信封里 chatNameOf 照读,
// 让旧往来仍可辨认; 不再增长、不再改写、不再作为寻址的推荐路径 (chatBaseOf 仍能把
// 存量名解析回 principal —— 兼容旧参数, 仅此而已)。表里的键原样留在 config.jsonc。
import { ChatPolicy, type Config, type TierName } from "../shared/config.js";
import { speechDefaultOf } from "./chat-seen.js";
import { isOnboardingActive } from "./onboarding.js";
import { baseOfKey, isInternalKey, tagOfKey } from "../shared/session-label.js";
import { settleName, wizardStore } from "./wizard.js";

/** 一次会动到宪章的写入 (见 index.ts 的宪章守卫): chatPolicy 进宪章, 已在跑的 wizard
 *  看不见, 要 handoff 才换上。`what` 是提醒里点名的改动; `self` = 发起的 wizard (它受影响就在回话里直说);
 *  `byHuman` = 人发起的; `reload` = 守护进程 reload 后才生效; `after` = 写后的宪章 (默认按此刻的活 cfg 渲染)。 */
export interface CharterChange {
  what: string;
  self?: string;
  byHuman?: boolean;
  reload?: boolean;
  after?: (targets: readonly string[]) => Map<string, string>;
}
/** 写前写后各渲染一遍宪章, 变了的 wizard 挂 handoff 提醒。`write` 同步执行 (快照到写完之间不能有 await);
 *  `change` 由写的结果判断这次算不算一次改动 (undefined = 没写, 不比对)。`note` = 给调用方的那段话。 */
export type CharterGuard = <T>(write: () => T, change: (r: T) => CharterChange | undefined) => { r: T; note: Promise<string> };

/** 用户输入的名字: 去引号/空白, 剥掉习惯性前缀的 `@`、`#`、`.`。 */
export const normChatName = (raw: string): string =>
  (raw ?? "").trim().replace(/^[\s'"‘’“”`]+|[\s'"‘’“”`]+$/gu, "").replace(/^[@#.]+/, "");

/** 名字大小写不敏感。存的是原样拼写, 比对走这个折叠。 */
const fold = (s: string): string => s.toLowerCase();

const entries = (cfg: Config): Array<[string, string]> => Object.entries(cfg.chats ?? {});

/** 这个聊天 (或它的某个 tagged 会话) 的名字 (存量冻结标签); 没起过名返回 ""。 */
export const chatNameOf = (cfg: Config, target: string): string => {
  const base = baseOfKey(target);
  return entries(cfg).find(([, p]) => p === base)?.[0] ?? "";
};

/** 当前聊天全名或 canonical principal/target key → base principal; friendly wizard 地址不解析。
 *  名字解析只对存量冻结标签生效 —— 新聊天没有名字, 一律直接给 principal。 */
export const chatBaseOf = (cfg: Config, ref: string): string => {
  const r = normChatName(ref ?? "");
  if (!r) return "";
  if (/^(?:chat|user|group|external_user):[^#/]+(?:#[^#/]+)?$/.test(r)) return baseOfKey(r);
  if (/^(?:chat|user|group|external_user):/.test(r) || /[#/]/.test(r)) return "";
  const f = fold(r);
  return entries(cfg).find(([n]) => fold(n) === f)?.[1] ?? "";
};

/** `target` 所在聊天的群聊级策略 (`chatPolicy`, 键是 base principal)。 */
// topOnly 没写 = **开** (2026-10-15 起): 顶层模式是每个聊天的默认规矩, 只有人显式写 `false` 才关。
// speech 没写 (P7-S3 起) = chat-seen 的缺省判定: S3 后首见的群聊 strict, 存量/单聊 implicit
// (known-chats.json 的 boot 快照; 显式 chatPolicy 永远优先)。
export const chatPolicyOf = (cfg: Config, target: string): ChatPolicy & { topOnly: boolean; speech: "implicit" | "strict" } =>
  ((p) => {
    const base = baseOfKey(target);
    // 引导在途一律 implicit —— 出站 tracker 第一句就会把新群登记成首见 strict, 不豁免
    // 对话式引导就只剩占位。显式 chatPolicy 也不豁免它: 绑定落盘前这个群还谈不上治理;
    // 绑定即收 (onboarding.finish) 后恢复正常判定链。
    return { ...p, topOnly: p.topOnly ?? true, speech: isOnboardingActive(base) ? "implicit" : p.speech ?? speechDefaultOf(cfg, base) };
  })(ChatPolicy.parse(cfg.chatPolicy?.[baseOfKey(target)] ?? {}));

/** 群的默认会话就是 router; 统一取 models.router, 非管家不套档。
 *  内部 key (daemon 内建的记忆整理执行体, `wezard:internal#steward`) 同属管家型: 它带着 slot 名,
 *  但既不属于任何群、也不是谁的分身 —— 不给档它就落 CLI 自己的默认模型, 比 router 那档重得多。真 slot 分身才不套档。 */
export const stewardTierOf = (cfg: Config, target: string): TierName | undefined =>
  isInternalKey(target) || !tagOfKey(target) ? cfg.models.router : undefined;

/** 已命名的聊天 (存量冻结标签), 按名字排序。 */
export const listChatNames = (cfg: Config): Array<{ name: string; base: string }> =>
  entries(cfg)
    .map(([name, base]) => ({ name, base }))
    .sort((a, b) => a.name.localeCompare(b.name));

/** 一个 target key 的地址 —— 它的全局名字, 可直接用于当前 wizard 寻址。 */
export const peerAddress = (cfg: Config, target: string): string =>
  settleName(wizardStore(), chatNameOf(cfg, target), target);
