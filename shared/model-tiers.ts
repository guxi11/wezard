import { TIERS, tiersForBackend, type Config, type TierName } from "./config.js";
import { resolveCliBackend, type CliBackendName } from "./cli-backends.js";
import { EFFORTS, parseEffort, type Effort } from "./effort.js";

type Err = { ok: false; reason: string };

// ── 档位 ────────────────────────────────────────────────────────────────
type Via = "explicit" | "tier" | "inherit";
export interface TierPick {
  ok: true;
  tier?: TierName;
  cli?: CliBackendName;
  model?: string;
  effort?: Effort;
  /** 每个字段的来源; inherit = 不传, spawn 落到 CLI 默认, clone 跟被克隆者。 */
  via: { cli: "config"; model: Via; effort: Via };
}

/** CLI 只取全局配置; model / effort 按显式值 > 后端档位 > CLI 默认解析。 */
export const pickTier = (
  cfg: Config,
  tier: string | undefined,
  explicit: { model?: string; effort?: Effort },
  backend: CliBackendName = resolveCliBackend(cfg.wrc).name,
): TierPick | Err => {
  const name = (tier ?? "").trim();
  if (name && !(TIERS as readonly string[]).includes(name)) return { ok: false, reason: `tier 只有这几档: ${TIERS.join(" / ")}` };
  const cli = backend;
  const t = name ? tiersForBackend(cfg, cli)[name as TierName] : undefined;
  const one = <T>(x: T | undefined, y: T | undefined): [T | undefined, Via] =>
    x !== undefined ? [x, "explicit"] : y !== undefined ? [y, "tier"] : [undefined, "inherit"];
  const [model, viaModel] = one(explicit.model?.trim() || undefined, t?.model.trim() || undefined);
  const [effort, viaEffort] = one(explicit.effort, parseEffort(t?.effort));
  return {
    ok: true,
    ...(name ? { tier: name as TierName } : {}),
    cli, model, effort,
    via: { cli: "config", model: viaModel, effort: viaEffort },
  };
};

// ── 反查: 此刻的模型 + effort → 档位 ───────────────────────────────────
// set_model 换了模型 / effort 之后名册里的 tier 要跟着改 (rolepage 的聪明度只认 tier)。
// 口径 —— 同一后端同一张档位表, 不猜表外的档位:
//   • 模型归一化后严格相等 (id 或 label: "claude-opus-5.5" / "Opus 5.5" 都归一成 opus-5-5):
//     该模型占几档 (light / standard 常常同模型不同 effort) 时取 effort 最近的一档。
//   • 严格对不上、但家族词相同 (opus-4-8 ↔ opus-5-5): 取同家族里 effort 最近的一档, exact:false。
//   • 家族也对不上 (表里没有这个模型): 未知 —— 宁可不画聪明度, 也不拿别的档位猜。
//   • 档位的 model 是空串 (用 CLI 默认模型的后端) 时只和「模型也为空」的请求比, 由 effort 定档。
// 同分时保留 `from` (换档前的那一档) —— 配置里两档同规格 (常见: Claude 默认的 light 与
// standard 都是 sonnet·medium) 时, 模型名反查本身分不出来, 跟着原档位走比随便挑一个稳。
export interface TierProbe {
  tier?: TierName;
  /** 模型与 effort 都严丝合缝; false = 同家族 / 同模型不同 effort 的近似落位。 */
  exact: boolean;
}

const normModel = (s: string): string =>
  s.trim().toLowerCase()
    .replace(/\[1m\]/gu, "")
    .replace(/^claude[-_]/u, "")
    .replace(/[._\s]+/gu, "-")
    .replace(/^-+|-+$/gu, "");

/** 家族词 = 归一化后全部字母段 (版本号不参与): "deepseek-v4-1-flash" → "deepseek flash"。 */
const familyOf = (m: string): string => [...new Set(m.match(/[a-z]+/gu) ?? [])].sort().join(" ");

export const tierOfModel = (
  cfg: Pick<Config, "models" | "wrc">,
  backend: CliBackendName | undefined,
  model: string | undefined,
  effort?: string,
  from?: string,
): TierProbe => {
  const wantModel = normModel(model ?? "");
  const wantEffort = parseEffort(effort);
  if (!wantModel && !wantEffort) return { exact: false };
  const table = tiersForBackend(cfg, backend);
  const fit = (spec: { model: string; effort?: string }): 0 | 1 | 2 => {
    const m = normModel(spec.model);
    if (m === wantModel) return 2;
    if (m && wantModel && familyOf(m) === familyOf(wantModel)) return 1;
    return 0;
  };
  const gap = (spec: { effort?: string }): number => {
    const e = parseEffort(spec.effort);
    if (!e || !wantEffort) return e || wantEffort ? 1 : 0;
    return Math.abs(EFFORTS.indexOf(e) - EFFORTS.indexOf(wantEffort));
  };
  const ranked = TIERS
    .map((name) => ({ name, fit: fit(table[name]), gap: gap(table[name]) }))
    .filter((x) => x.fit > 0)
    .sort((a, b) => b.fit - a.fit || a.gap - b.gap);
  const best = ranked[0];
  if (!best) return { exact: false };
  const tie = ranked.find((x) => x.fit === best.fit && x.gap === best.gap && x.name === (from ?? "").trim());
  const pick = tie ?? best;
  return { tier: pick.name, exact: pick.fit === 2 && pick.gap === 0 };
};

/** Resolve the router (chat steward) tier against the backend being launched. */
export const pickRouter = (
  cfg: Config,
  backend: CliBackendName,
  explicit: { model?: string; effort?: Effort } = {},
): TierPick | Err => pickTier(cfg, cfg.models.router, explicit, backend);
