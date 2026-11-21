// 「聪明程度」: 把一个 wizard 此刻跑的 模型家族 + effort 折成 1~5 级, 给 rolepage 图节点 / 名片 / 图例用。
//
// 口径:
//   • 先认**实际在跑的模型** (transcript 里 assistant 行的 model) —— set_model 换了模型它跟着变;
//     出生档位 (WizardRecord.tier) 只记出生那一刻, 换模型后会说谎, 所以只做回落。
//   • 家族定底: haiku 1 · sonnet 2 · opus / fable / mythos 4; effort 往上抬一级:
//     sonnet 在 high 及以上 = 3, opus 类在 xhigh / max = 5。与默认档位表正好一一对上
//     (mini=haiku·low=1, light=sonnet·medium=2, standard=sonnet·high=3 (本机配置; 出厂 medium 则为 2), hard=opus·high=4, ultra=opus·max=5)。
//   • 认不出家族 (codex / deepseek / CLI 默认没写 model 的冷会话) → 按出生档位名
//     (mini..ultra = 1..5); 档位也没有 → undefined, 前端不画、不露 undefined。
// 纯函数, daemon 与独立 svr 共用。
import { claudeFamily, modelLabel } from "./pricing.js";
import { parseEffort } from "./effort.js";

export type SmartsLevel = 1 | 2 | 3 | 4 | 5;
export interface Smarts {
  level: SmartsLevel;
  /** 依据: model = 实际在跑的模型 (+effort); tier = 出生档位 (模型认不出时的回落)。 */
  basis: "model" | "tier";
  /** 给人看的一行: `Opus 5.5 · high` / `档位 hard`。 */
  label: string;
}

const TIER_LEVEL: Readonly<Record<string, SmartsLevel>> = { mini: 1, light: 2, standard: 3, hard: 4, ultra: 5 };

const HIGHISH = new Set(["high", "xhigh", "max"]);
const TOP = new Set(["xhigh", "max"]);

/** 家族 + effort → 级; 家族认不出 → undefined。 */
export const levelOfModel = (model: string, effort?: string): SmartsLevel | undefined => {
  const fam = claudeFamily(model);
  const e = parseEffort(effort) ?? "";
  if (fam === "haiku") return 1;
  if (fam === "sonnet") return HIGHISH.has(e) ? 3 : 2;
  if (fam === "opus" || fam === "fable" || fam === "mythos") return TOP.has(e) ? 5 : 4;
  return undefined;
};

export const smartsOf = (x: { model?: string; effort?: string; tier?: string }): Smarts | undefined => {
  const model = (x.model ?? "").trim();
  const effort = parseEffort(x.effort);
  const byModel = model ? levelOfModel(model, effort) : undefined;
  if (byModel) return { level: byModel, basis: "model", label: modelLabel(model) + (effort ? " · " + effort : "") };
  const t = (x.tier ?? "").trim();
  const byTier = TIER_LEVEL[t];
  return byTier ? { level: byTier, basis: "tier", label: "档位 " + t } : undefined;
};
