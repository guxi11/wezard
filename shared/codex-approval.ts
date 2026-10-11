export type CodexHookEvent = "PreToolUse" | "PermissionRequest";

export interface CodexApprovalInput {
  session_id?: string;
  hook_event_name?: string;
  turn_id?: string;
  tool_use_id?: string;
  tool_name?: string;
  tool_input?: unknown;
  cwd?: string;
  transcript_path?: string | null;
  permission_mode?: string;
}

export interface ApprovalReply {
  decision?: string;
  reason?: string;
  req_id?: string;
  updated_input?: Record<string, unknown>;
}

/** Codex has no PreToolUse 'ask': deny there; preserve native approval fallback. */
export const codexHookOutput = (event: CodexHookEvent, reply: ApprovalReply): Record<string, unknown> => {
  const reason = `wezard: ${reply.reason ?? "approval bridge unavailable"}`;
  if (event === "PermissionRequest") {
    if (reply.decision !== "allow" && reply.decision !== "deny") return { systemMessage: reason };
    return { hookSpecificOutput: { hookEventName: event, decision: {
      behavior: reply.decision, ...(reply.decision === "deny" ? { message: reason } : {}),
    } } };
  }
  // A plain allow is continuation, not a permission override. Codex rejects
  // permissionDecision: "allow" unless it accompanies an input rewrite.
  if (reply.decision === "allow" && !reply.updated_input) return {};
  return { hookSpecificOutput: {
    hookEventName: event,
    permissionDecision: reply.decision === "allow" ? "allow" : "deny",
    permissionDecisionReason: reason,
    ...(reply.decision === "allow" && reply.updated_input ? { updatedInput: reply.updated_input } : {}),
  } };
};

/** Preserve native inputs while exposing patch paths to the existing danger rules. */
export const codexApprovalRequest = (input: CodexApprovalInput): Record<string, unknown> => {
  const toolInput = input.tool_input && typeof input.tool_input === "object" ? input.tool_input as Record<string, unknown> : {};
  const patch = input.tool_name === "apply_patch" && typeof toolInput.command === "string" ? toolInput.command : "";
  const paths = [...patch.matchAll(/^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gm)].map((m) => m[1]!);
  return {
    ...input, cli_backend: "codex", transcript_path: input.transcript_path ?? "",
    tool_input: paths.length ? { ...toolInput, file_paths: paths } : input.tool_input ?? {},
  };
};
