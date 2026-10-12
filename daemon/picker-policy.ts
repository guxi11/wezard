// Screen-derived approvals have no native sandbox authority. Unknown arguments
// cannot safely participate in command rules, danger exemptions or windows.
import type { Config } from "../shared/config.js";
import type { CliBackendName } from "../shared/cli-backends.js";
import type { ConfirmContext } from "../shared/modal-pane.js";
import { evaluateAllow, ruleMatchesAny } from "../shared/allow-rules.js";
import { dangerEarlyExit, dangerOf, selfConfigWriteOf } from "./danger.js";

export interface PickerPolicy {
  decision: "allow" | "deny" | "manual" | "leave";
  reason: string;
  /** Force a single approval card; a window cannot approve this operation. */
  forceSingle?: string;
}

const requestsNativePermission = (input: unknown): boolean =>
  typeof input === "string"
    ? /\b(?:sandbox_permissions|requested_permissions|additional_permissions)\b["']?\s*[:=]/u.test(input)
    : !!input && typeof input === "object" && Object.entries(input).some(([key, value]) =>
      ["sandbox_permissions", "requested_permissions", "additional_permissions"].includes(key)
      || requestsNativePermission(value));

/** The dispatch boundary owns the absence of effects for native/unknown gates. */
export const dispatchPickerPolicy = async (
  policy: PickerPolicy,
  handlers: Record<"allow" | "deny" | "manual", () => void | Promise<void>>,
): Promise<void> => {
  if (policy.decision === "leave") return;
  await handlers[policy.decision]();
};

export const pickerPolicy = (
  cfg: Config,
  backend: CliBackendName | undefined,
  ctx: ConfirmContext,
  windowActive: boolean,
): PickerPolicy => {
  if (!cfg.approval.enabled || !backend || backend === "codex" || requestsNativePermission(ctx.toolInput)) {
    return { decision: "leave", reason: "native approval outside picker authority" };
  }
  if (/^(?:AskUserQuestion|EnterPlanMode|ExitPlanMode|PermissionRequest)$/u.test(ctx.toolName)) {
    return { decision: "leave", reason: "interactive approval outside picker authority" };
  }
  if (!ctx.complete) {
    return { decision: "manual", reason: "unknown or interactive context", forceSingle: "无法完整识别此次操作，请逐次确认" };
  }
  const deny = ruleMatchesAny(cfg.approval.denyRules, ctx.toolName, ctx.toolInput);
  if (deny) return { decision: "deny", reason: `deny_rule:${deny}` };
  if (cfg.approval.danger.skipAll) return { decision: "allow", reason: "skipAll" };
  const ask = ruleMatchesAny(cfg.approval.askRules, ctx.toolName, ctx.toolInput);
  const self = selfConfigWriteOf(ctx.toolName, ctx.toolInput);
  const danger = self ?? dangerOf(cfg, ctx.toolName, ctx.toolInput);
  const forced = ask ?? self?.rule;
  if (forced) return { decision: "manual", reason: forced, forceSingle: forced };
  const early = dangerEarlyExit(cfg, danger, false);
  if (early) return { decision: "allow", reason: early };
  if (danger) return { decision: "manual", reason: danger.rule, forceSingle: danger.rule };
  if (evaluateAllow(cfg.approval.allowRules, ctx.toolName, ctx.toolInput).allowed) {
    return { decision: "allow", reason: "allow_rule" };
  }
  return windowActive
    ? { decision: "allow", reason: "⏱自动窗口" }
    : { decision: "manual", reason: "approval required" };
};
