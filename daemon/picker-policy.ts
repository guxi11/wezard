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
    // skipAll 是「所有审批都不要问」的显式授权, 在 hook 路径上它盲放 (approval.ts 只看
    // !nativePermission), 不依赖入参匹配。真实 CodeBuddy 权限 picker (标题
    // "Hook PreToolUse: … requires confirmation:" / 裸 "Bash command" 正文) 解不出
    // Confirm 头与 toolName/params, complete 恒 false —— skipAll 若被这道闸门挡住,
    // 在哨兵上永远轮空, 调用卡死在原生选择框。代价: 屏面解不出入参时 denyRules 同样
    // 匹配不上 —— 开 skipAll 的人已接受「不再逐条问」。
    if (cfg.approval.danger.skipAll) return { decision: "allow", reason: "skipAll" };
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
