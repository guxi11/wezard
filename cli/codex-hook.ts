#!/usr/bin/env node
// Codex's supported hook protocol → wezard's shared approval engine.
import { loadConfig } from "../shared/config.js";
import { codexApprovalRequest, codexHookOutput, codexSelfCallBypass, type CodexApprovalInput, type CodexHookEvent, type ApprovalReply } from "../shared/codex-approval.js";
import { sleep } from "../shared/std.js";
import { recordCodexPaneSession } from "../shared/codex.js";

const requestApproval = async (input: CodexApprovalInput): Promise<ApprovalReply> => {
  const { config: cfg } = loadConfig();
  if (!cfg.approval.enabled) return { decision: "ask", reason: "approval_disabled" };
  const base = process.env.WEZARD_DAEMON_BASE ?? `http://127.0.0.1:${cfg.daemon.port}`;
  // Loopback fetch does not use HTTP_PROXY; do not send hook inputs off-machine.
  const url = new URL("/approve", base);
  if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) throw new Error("Codex approval bridge must use loopback");
  const deadline = Date.now() + cfg.approval.hookTimeoutSec * 1000;
  let resumeId: string | undefined;
  let outageSince: number | undefined;
  while (Date.now() < deadline) {
    try {
      const resp = await fetch(url, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...codexApprovalRequest(input), ...(resumeId ? { resume_req_id: resumeId } : {}) }),
        signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
      });
      if (!resp.ok) throw new Error(`approval HTTP ${resp.status}`);
      const reply = await resp.json() as ApprovalReply;
      outageSince = undefined;
      if (reply.decision !== "retry") return reply;
      if (!reply.req_id) throw new Error("reload response has no request id");
      resumeId = reply.req_id;
      await sleep(1000);
    } catch (e) {
      // Restoring hundreds of mirrors can outlast two retries during reload.
      // Keep the pending card id and bound each outage by the hook budget / 60s.
      outageSince ??= Date.now();
      const remaining = Math.min(deadline, outageSince + 60_000) - Date.now();
      if (remaining <= 0) {
        const error = e as Error & { cause?: { code?: string; message?: string } };
        const cause = error.cause?.code ?? error.cause?.message;
        const why = `bridge unavailable (${url.origin}): ${error.message}${cause ? `: ${cause}` : ""}`;
        // Daemon down: let ordinary tools through; sandbox escalations fall back to Codex's native prompt.
        return input.hook_event_name === "PermissionRequest"
          ? { decision: "ask", reason: why }
          : { decision: "allow", reason: `daemon down, auto-allow: ${why}` };
      }
      await sleep(Math.min(1000, remaining));
    }
  }
  return { decision: "ask", reason: "approval timeout" };
};

const main = async (): Promise<void> => {
  let event: CodexHookEvent = "PreToolUse";
  let sessionStart = false;
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
    const input = JSON.parse(Buffer.concat(chunks).toString("utf8")) as CodexApprovalInput;
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
    console.log(JSON.stringify(!cfg.approval.enabled ? {} : codexHookOutput(event, reply)));
  } catch (e) {
    console.log(JSON.stringify(sessionStart ? { systemMessage: `wezard session registration failed: ${(e as Error).message}` } : codexHookOutput(event, { decision: "ask", reason: (e as Error).message })));
  }
};

await main();
