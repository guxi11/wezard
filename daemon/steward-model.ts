import type { Config } from "../shared/config.js";
import type { CliBackendName } from "../shared/cli-backends.js";
import { parseEffort, type Effort } from "../shared/effort.js";
import { pickTier } from "../shared/model-tiers.js";
import { stewardTierOf } from "./chat-name.js";

type ModelSpec = { model?: string; effort?: Effort };

/** All steward paths use the same backend compatibility checks as wizard spawning. */
const stewardSpec = (cfg: Config, target: string, backend: CliBackendName): ModelSpec => {
  const pick = pickTier(cfg, stewardTierOf(cfg, target), {}, false, backend);
  if (!pick.ok) throw new Error(pick.reason); // Schema already validates steward tiers.
  return { model: pick.model, effort: pick.effort };
};

/** Fresh stewards reapply their tier; an explicit model opts out of the whole tier. */
export const newStewardSpec = (
  cfg: Config, target: string, backend: CliBackendName, explicit: ModelSpec = {}, carriedEffort?: string,
): ModelSpec => {
  const tier = explicit.model?.trim() ? undefined : stewardSpec(cfg, target, backend);
  return {
    model: explicit.model?.trim() || tier?.model || undefined,
    effort: explicit.effort ?? tier?.effort ?? parseEffort(carriedEffort),
  };
};

/** Resume keeps recorded overrides, filling missing fields from the compatible steward tier. */
export const resumedStewardSpec = (
  cfg: Config, target: string, backend: CliBackendName, recorded: { model?: string; effort?: string },
): ModelSpec => {
  const tier = stewardSpec(cfg, target, backend);
  return { model: recorded.model || tier.model, effort: parseEffort(recorded.effort) ?? tier.effort };
};
