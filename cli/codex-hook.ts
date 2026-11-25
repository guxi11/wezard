#!/usr/bin/env node
// Codex's supported hook protocol → wezard's shared approval engine.
import { loadConfig } from "../shared/config.js";
import { clientSocketPath } from "../shared/daemon-addr.js";
import { daemonRequest } from "../shared/daemon-client.js";
import { codexApprovalRequest, codexHookOutput, codexSelfCallBypass, type CodexApprovalInput, type CodexHookEvent, type ApprovalReply } from "../shared/codex-approval.js";
import { sleep } from "../shared/std.js";
import { recordCodexPaneSession } from "../shared/codex.js";
import { readHookMode } from "../shared/hook-mode.js";

// 每段断连最多等多久 (reload 要恢复几百个镜像, 两三次重试不够); 只给测试缩短用。
const OUTAGE_MS = Number(process.env.WEZARD_CODEX_OUTAGE_MS) || 60_000;

const requestApproval = async (input: CodexApprovalInput): Promise<ApprovalReply> => {
  const { config: cfg } = loadConfig();
  if (!cfg.approval.enabled) return { decision: "ask", reason: "approval_disabled" };
  // `wezard use cli`: 审批权在本地 CLI, 回 ask 让 codex 弹它自己的原生框。
  if (readHookMode(cfg.daemon.stateDir) === "cli") return { decision: "ask", reason: "hook_mode_cli" };
  // The control plane is the daemon's unix socket: it cannot leave the machine or reach another
  // uid, so there is no URL to vet. env WEZARD_DAEMON_SOCK (set by the spawn line) wins over config.
  const socketPath = clientSocketPath(cfg);
  const deadline = Date.now() + cfg.approval.hookTimeoutSec * 1000;
  let resumeId: string | undefined;
  let outageSince: number | undefined;
  while (Date.now() < deadline) {
    try {
      const resp = await daemonRequest("POST", "/approve", {
        socketPath,
        body: { ...codexApprovalRequest(input), ...(resumeId ? { resume_req_id: resumeId } : {}) },
        timeoutMs: Math.max(1, deadline - Date.now()),
      });
      if (resp.status < 200 || resp.status >= 300 || !resp.json) throw new Error(`approval HTTP ${resp.status}`);
      const reply = resp.json as ApprovalReply;
      outageSince = undefined;
      if (reply.decision !== "retry") return reply;
      if (!reply.req_id) throw new Error("reload response has no request id");
      resumeId = reply.req_id;
      await sleep(1000);
    } catch (e) {
      // Restoring hundreds of mirrors can outlast two retries during reload.
      // Keep the pending card id and bound each outage by the hook budget / OUTAGE_MS.
      outageSince ??= Date.now();
      const remaining = Math.min(deadline, outageSince + OUTAGE_MS) - Date.now();
      if (remaining <= 0) {
        const error = e as Error & { code?: string };
        const why = `bridge unavailable (${socketPath}): ${error.message}${error.code ? `: ${error.code}` : ""}`;
        // Daemon down: fail closed. Codex has no PreToolUse "ask", so an unreachable bridge denies the
        // tool (never allow — that would hand the pane every permission while the human believes
        // approval is on); sandbox escalations (PermissionRequest) fall back to Codex's native prompt.
        return input.hook_event_name === "PermissionRequest"
          ? { decision: "ask", reason: why }
          : { decision: "deny", reason: why };
      }
      await sleep(Math.min(1000, remaining));
    }
  }
  return { decision: "ask", reason: "approval timeout" };
};

/** 读干 stdin: 上游还在写 payload 时就退出, 会让它写管道 EPIPE。 */
const drainStdin = async (): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
};

const main = async (): Promise<void> => {
  // 归属闸门: 同 hooks/pre-tool-use.sh —— 这套 handler 是全机注册的 (sync 写进
  // ~/.codex/hooks.json), 人自己开的 codex 会话也会触发。只有 wezard spawn 的
  // 进程带 WEZARD_MANAGED=1。没有标记 = 回 {} (不给裁决), 交回 codex 自己的
  // 权限流程; 回 allow / ask 都会改变别人会话的行为。
  if (process.env.WEZARD_MANAGED !== "1") {
    try { await drainStdin(); } catch { /* payload gone */ }
    console.log("{}");
    return;
  }
  let event: CodexHookEvent = "PreToolUse";
  let sessionStart = false;
  try {
    const input = JSON.parse(await drainStdin()) as CodexApprovalInput;
    if (input.hook_event_name === "SessionStart") {
      sessionStart = true;
      const { config: cfg } = loadConfig();
      if (input.session_id && input.transcript_path && input.cwd) recordCodexPaneSession({
        sessionId: input.session_id, jsonlPath: input.transcript_path, cwd: input.cwd,
        pane: process.env.TMUX_PANE ?? "", startedAt: Date.now(),
      }, cfg.daemon.stateDir);
      console.log("{}");
      return;
    }
    if (input.hook_event_name !== "PreToolUse" && input.hook_event_name !== "PermissionRequest") throw new Error("unsupported Codex hook event");
    event = input.hook_event_name;
    if (!input.session_id || !input.tool_name) throw new Error("missing session_id or tool_name");
    const bypass = codexSelfCallBypass(input);
    if (bypass) {
      console.log(JSON.stringify(codexHookOutput(event, { decision: "allow", reason: bypass })));
      return;
    }
    const { config: cfg } = loadConfig();
    const reply = await requestApproval(input);
    // Disabled hooks should not block ordinary tools, nor approve escalations.
    const passthrough = !cfg.approval.enabled || readHookMode(cfg.daemon.stateDir) === "cli";
    console.log(JSON.stringify(passthrough ? {} : codexHookOutput(event, reply)));
  } catch (e) {
    console.log(JSON.stringify(sessionStart ? { systemMessage: `wezard session registration failed: ${(e as Error).message}` } : codexHookOutput(event, { decision: "ask", reason: (e as Error).message })));
  }
};

await main();
