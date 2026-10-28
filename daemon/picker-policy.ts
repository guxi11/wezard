// Screen-derived approvals have no native sandbox authority. Unknown arguments
// cannot safely participate in command rules or windows; danger exemptions they
// share with the hook path (人 2026-10-28: danger 档下认不出也不出普通卡).
import type { Config } from "../shared/config.js";
import type { CliBackendName } from "../shared/cli-backends.js";
import type { ConfirmContext } from "../shared/modal-pane.js";
import { evaluateAllow, ruleMatchesAny } from "../shared/allow-rules.js";
import { dangerEarlyExit, dangerOf, dangerOfScript, selfConfigWriteOf } from "./danger.js";

export interface PickerPolicy {
  decision: "allow" | "deny" | "manual" | "leave";
  reason: string;
  /** Force a single approval card; a window cannot approve this operation. */
  forceSingle?: string;
  /** 真危险名单命中 (rm / DROP / 强推 …): 卡片打红走「危险」行。 */
  danger?: string;
  /** 必发卡但不是危险 (mode=all 下屏面看不懂 / askRules): 卡片「审核」行的说明。 */
  note?: string;
}

/** 屏面解不出结构时的必发卡说明 (mode=all) —— 是「看不清」, 不是「危险」。 */
const UNREADABLE = "无法完整识别此次操作，请逐次确认";

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
    // mode=skip_all 是「所有审批都不要问」的显式授权, 在 hook 路径上它盲放 (approval.ts 只看
    // !nativePermission), 不依赖入参匹配。真实 CodeBuddy 权限 picker (标题
    // "Hook PreToolUse: … requires confirmation:" / 裸 "Bash command" 正文) 解不出
    // Confirm 头与 toolName/params, complete 恒 false —— skip_all 若被这道闸门挡住,
    // 在哨兵上永远轮空, 调用卡死在原生选择框。代价: 屏面解不出入参时 denyRules 同样
    // 匹配不上 —— 配 skip_all 的人已接受「不再逐条问」。
    if (cfg.approval.mode === "skip_all") return { decision: "allow", reason: "skip_all" };
    // 结构解不出 ≠ 看不出危险: 正文里那段操作 (REPL 包裹的命令 / 被 pane 宽度截断的
    // params) 照样过一遍危险名单。判出 rm -rf 就打红走「危险」行 —— 看不懂的只是
    // 参数全貌, 不是这条命本身。
    const hit = dangerOfScript(cfg, ctx.body ?? "");
    if (hit) return { decision: "manual", reason: hit.rule, forceSingle: hit.rule, danger: hit.rule };
    // danger 档早退 (人 2026-10-28: danger 档下不出普通卡, 「无法完整识别」也不例外):
    // 认不出既不判 danger, 也不是「算出非 danger」的第三态 —— 名单在可见正文上没
    // 命中就跟 hook 路径同一口径放行。代价: 被 pane 截断的不可见尾部判不到, 可见
    // 部分的危险扫描仍照走。代按留 🔓 回执; 该调用若随后仍触发 hook, hook 侧
    // danger_mode_skip 自带 auto-window 记账。
    const early = dangerEarlyExit(cfg, hit, false);
    if (early) return { decision: "allow", reason: early };
    return { decision: "manual", reason: "unknown or interactive context", forceSingle: UNREADABLE, note: UNREADABLE };
  }
  const deny = ruleMatchesAny(cfg.approval.denyRules, ctx.toolName, ctx.toolInput);
  if (deny) return { decision: "deny", reason: `deny_rule:${deny}` };
  if (cfg.approval.mode === "skip_all") return { decision: "allow", reason: "skip_all" };
  const ask = ruleMatchesAny(cfg.approval.askRules, ctx.toolName, ctx.toolInput);
  const self = selfConfigWriteOf(ctx.toolName, ctx.toolInput);
  const danger = self ?? dangerOf(cfg, ctx.toolName, ctx.toolInput);
  // askRules = 人自己配的「每次都要问」, 不是危险; 改全机设置 (self) 才是。
  if (ask) return { decision: "manual", reason: ask, forceSingle: ask, note: `命中 askRules「${ask}」` };
  if (self) return { decision: "manual", reason: self.rule, forceSingle: self.rule, danger: self.rule };
  const early = dangerEarlyExit(cfg, danger, false);
  if (early) return { decision: "allow", reason: early };
  if (danger) return { decision: "manual", reason: danger.rule, forceSingle: danger.rule, danger: danger.rule };
  if (evaluateAllow(cfg.approval.allowRules, ctx.toolName, ctx.toolInput).allowed) {
    return { decision: "allow", reason: "allow_rule" };
  }
  return windowActive
    ? { decision: "allow", reason: "⏱自动窗口" }
    : { decision: "manual", reason: "approval required" };
};
