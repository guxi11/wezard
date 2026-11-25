// 「聪明程度」: 把 wizard 的档位 (mini..ultra) 折成 1~5 级, 给 rolepage 图节点 / 名片 / 图例用。
//
// 口径 (人 2026-11-26): 聪明度**只由 tier 决定** —— 上层只认档位, 底层实际跑哪个模型 /
// effort 是配置 (models.backends.<cli>.tiers) 的事, 不外露成等级, 也不按模型家族推断。
//   • tier 来自名册记录: 出生时按 spawn 的档位记, 之后 set_model 换模型 / effort 时由
//     shared/model-tiers.ts 的 tierOfModel 反查同一张档位表更新。
//   • 反查不出 (模型不在表里) 就没有 tier: 不猜不回落, 前端不画多边形, 名片写「档位未知」。
//   • 真实在跑的模型 (+effort) 只作附注 (`note`), 不参与定级。
// 纯函数, daemon 与独立 svr 共用。
import { modelLabel } from "./pricing.js";
import { parseEffort } from "./effort.js";

export type SmartsLevel = 1 | 2 | 3 | 4 | 5;
export interface Smarts {
  level: SmartsLevel;
  /** 定级的依据: 档位名 (TIERS 之一)。 */
  tier: string;
  /** 附注: 实际在跑的模型 (+effort); 冷会话 / 不知道时没有。 */
  note?: string;
}

const TIER_LEVEL: Readonly<Record<string, SmartsLevel>> = { mini: 1, light: 2, standard: 3, hard: 4, ultra: 5 };

/** 档位 → 级; 不是档位名 → undefined。 */
export const levelOfTier = (tier: string): SmartsLevel | undefined => TIER_LEVEL[tier.trim()];

export const smartsOf = (x: { tier?: string; model?: string; effort?: string }): Smarts | undefined => {
  const tier = (x.tier ?? "").trim();
  const level = TIER_LEVEL[tier];
  if (!level) return undefined;
  const model = (x.model ?? "").trim();
  const effort = parseEffort(x.effort);
  return { level, tier, ...(model ? { note: modelLabel(model) + (effort ? " · " + effort : "") } : {}) };
};
