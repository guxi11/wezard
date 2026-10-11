import { parse, type ParseError } from "jsonc-parser";
import { z } from "zod";
import { TIERS, configIssues, parseConfigText, tiersForBackend } from "./config.js";
import { EFFORTS } from "./effort.js";
import { patchJsonc, previewPatch, readJsoncText, type JsoncPatch } from "./config-writer.js";

// Deployment chooses model IDs from its own model catalog, never schema defaults.
const Mapping = z.record(z.enum(TIERS), z.object({
  model: z.string().trim().min(1),
  effort: z.enum(EFFORTS),
})).refine((v) => TIERS.every((t) => v[t]), "all five tiers are required");
export type BackendTierMapping = Record<typeof TIERS[number], { model: string; effort: typeof EFFORTS[number] }>;

/** Materialize effective Claude settings and an explicit Codex mapping, preserving unrelated JSONC. */
export const planBackendTiers = (text: string, codex: BackendTierMapping): { patches: JsoncPatch[]; text: string } => {
  const errors: ParseError[] = [];
  parse(text, errors, { allowTrailingComma: true });
  if (errors.length) throw new Error("Invalid JSONC; refusing to migrate model tiers");
  const current = parseConfigText(text);
  if (!current.success) throw new Error(configIssues(current.error));
  const mapping = Mapping.parse(codex);
  const claude = tiersForBackend(current.data, "claude");
  // Leaf patches preserve comments and any other backend/role settings.
  const patches: JsoncPatch[] = (["claude", "codex"] as const).flatMap((backend) =>
    TIERS.flatMap((tier) => {
      const spec = backend === "claude" ? claude[tier] : mapping[tier]!;
      return (["model", "effort", "cli"] as const).map((key) => ({
        path: ["models", "backends", backend, "tiers", tier, key],
        value: key === "cli" ? (backend === "claude" ? claude[tier].cli : undefined) : spec[key],
      }));
    }));
  const next = previewPatch(text, patches);
  const checked = parseConfigText(next);
  if (!checked.success) throw new Error(configIssues(checked.error));
  return { patches, text: next };
};

/** Explicit opt-in write; no default path and no daemon restart or live-config mutation. */
export const materializeBackendTiers = (file: string, codex: BackendTierMapping): void => {
  const before = readJsoncText(file);
  const plan = planBackendTiers(before, codex);
  if (plan.text !== before) patchJsonc(file, plan.patches);
};
