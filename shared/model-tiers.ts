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
  note?: string;
}

/** CLI 只取全局配置; model / effort 才按显式值 > 兼容的档位 > CLI 默认解析。 */
export const pickTier = (
  cfg: Config,
  tier: string | undefined,
  explicit: { cli?: CliBackendName; model?: string; effort?: Effort },
  inherit: boolean,
  backend: CliBackendName = resolveCliBackend(cfg.wrc).name,
): TierPick | Err => {
  const name = (tier ?? "").trim();
  if (name && !(TIERS as readonly string[]).includes(name)) return { ok: false, reason: `tier 只有这几档: ${TIERS.join(" / ")}` };
  const cli = backend;
  const t = name ? tiersForBackend(cfg, cli)[name as TierName] : undefined;
  const one = <T>(x: T | undefined, y: T | undefined): [T | undefined, Via] =>
    x !== undefined ? [x, "explicit"] : y !== undefined ? [y, "tier"] : [undefined, "inherit"];
  // 旧配置的 Claude 档位不能把 opus / sonnet 或 max effort 传给 Codex。
  // 显式 model 仍原样交给 CLI; 不猜用户自定义模型是否有效。
  const foreignTier = !!t && ((!!t.cli && t.cli !== cli)
    || (cli === "codex" && /^(?:claude|opus|sonnet|haiku)\b/i.test(t.model)));
  const [model, viaModel] = one(explicit.model?.trim() || undefined, foreignTier ? undefined : t?.model.trim() || undefined);
  const [effort, viaEffort] = one(explicit.effort, foreignTier ? undefined : parseEffort(t?.effort));
  const ignoredCli = explicit.cli ?? t?.cli;
  const notes = [
    ...(ignoredCli && ignoredCli !== cli ? [`cli (${ignoredCli}) 不覆盖全局 wrc.defaultCli (${cli})`] : []),
    ...(foreignTier ? [`档位 ${name} 属于其他后端, model / effort ${inherit ? "随被克隆会话" : "使用 CLI 默认"}`] : []),
  ];
  return {
    ok: true,
    ...(name ? { tier: name as TierName } : {}),
    cli, model, effort,
    via: { cli: "config", model: viaModel, effort: viaEffort },
    ...(notes.length ? { note: notes.join("; ") } : {}),
  };
};

