import type { Config } from "../shared/config.js";
import type { CliBackendName } from "../shared/cli-backends.js";
import { parseEffort, type Effort } from "../shared/effort.js";
import { pickRouter, pickTier } from "../shared/model-tiers.js";
import { tagOfKey } from "../shared/session-label.js";
import { stewardTierOf } from "./chat-name.js";

type ModelSpec = { model?: string; effort?: Effort };

/** All steward paths use the same backend compatibility checks as wizard spawning. */
const stewardSpec = (cfg: Config, target: string, backend: CliBackendName): ModelSpec | undefined => {
  if (!stewardTierOf(cfg, target)) return undefined;
  const pick = pickRouter(cfg, backend);
  if (!pick.ok) throw new Error(pick.reason); // Schema already validates steward tiers.
  return { model: pick.model, effort: pick.effort };
};

/** room 的 monitor 是常驻的「读账本 + 一次判断」: 固定吃 wrc.channel.monitor.tier,
 *  首建 / /new / 冷恢复 / 重生都不落回 CLI 默认 (本机 CLI 默认是 standard, 比 monitor 需要的高一档)。
 *  与管家同理: 显式 model / 记录值都不覆盖它。 */
const MONITOR_TAG = "monitor";
const monitorSpec = (cfg: Config, target: string, backend: CliBackendName): ModelSpec | undefined => {
  if (tagOfKey(target) !== MONITOR_TAG) return undefined;
  const pick = pickTier(cfg, cfg.wrc.channel.monitor.tier, {}, backend);
  if (!pick.ok) throw new Error(pick.reason);
  return { model: pick.model, effort: pick.effort };
};

/** Every steward creation takes the router tier, including /new and handoff. */
export const newStewardSpec = (
  cfg: Config, target: string, backend: CliBackendName, explicit: ModelSpec = {}, carriedEffort?: string,
): ModelSpec => {
  return monitorSpec(cfg, target, backend) ?? stewardSpec(cfg, target, backend) ?? {
    model: explicit.model?.trim() || undefined,
    effort: explicit.effort ?? parseEffort(carriedEffort),
  };
};

/** A cold steward also reapplies router; only ordinary wizards carry recorded overrides. */
export const resumedStewardSpec = (
  cfg: Config, target: string, backend: CliBackendName, recorded: { model?: string; effort?: string },
): ModelSpec => {
  return monitorSpec(cfg, target, backend) ?? stewardSpec(cfg, target, backend)
    ?? { model: recorded.model || undefined, effort: parseEffort(recorded.effort) };
};
