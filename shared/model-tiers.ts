import { TIERS, tiersForBackend, type Config, type TierName } from "./config.js";
import { resolveCliBackend, type CliBackendName } from "./cli-backends.js";
import { parseEffort, type Effort } from "./effort.js";

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

/** Resolve the router (chat steward) tier against the backend being launched. */
export const pickRouter = (
  cfg: Config,
  backend: CliBackendName,
  explicit: { model?: string; effort?: Effort } = {},
): TierPick | Err => pickTier(cfg, cfg.models.router, explicit, backend);
