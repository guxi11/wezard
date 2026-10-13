import type { Config } from "../shared/config.js";
import type { CliBackendName } from "../shared/cli-backends.js";
import { parseEffort, type Effort } from "../shared/effort.js";
import { pickRouter } from "../shared/model-tiers.js";
import { stewardTierOf } from "./chat-name.js";

type ModelSpec = { model?: string; effort?: Effort };

/** All steward paths use the same backend compatibility checks as wizard spawning. */
const stewardSpec = (cfg: Config, target: string, backend: CliBackendName): ModelSpec | undefined => {
  if (!stewardTierOf(cfg, target)) return undefined;
  const pick = pickRouter(cfg, backend);
  if (!pick.ok) throw new Error(pick.reason); // Schema already validates steward tiers.
  return { model: pick.model, effort: pick.effort };
};

/** Every steward creation takes the router tier, including /new and handoff. */
export const newStewardSpec = (
  cfg: Config, target: string, backend: CliBackendName, explicit: ModelSpec = {}, carriedEffort?: string,
): ModelSpec => {
  return stewardSpec(cfg, target, backend) ?? {
    model: explicit.model?.trim() || undefined,
    effort: explicit.effort ?? parseEffort(carriedEffort),
  };
};

/** A cold steward also reapplies router; only ordinary wizards carry recorded overrides. */
export const resumedStewardSpec = (
  cfg: Config, target: string, backend: CliBackendName, recorded: { model?: string; effort?: string },
): ModelSpec => {
  return stewardSpec(cfg, target, backend) ?? { model: recorded.model || undefined, effort: parseEffort(recorded.effort) };
};
