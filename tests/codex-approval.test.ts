import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import pino from "pino";
import type { WSClient } from "@wecom/aibot-node-sdk";
import { ConfigSchema } from "../shared/config.js";
import { codexHookOutput, codexApprovalRequest, codexSelfCallBypass } from "../shared/codex-approval.js";
import { makeApproveHandler, installApprovalEventListener } from "../daemon/approval.js";

for (const event of ["PreToolUse", "PermissionRequest"] as const) {
  const allowed = codexHookOutput(event, { decision: "allow", reason: "allow" }) as any;
  const denied = codexHookOutput(event, { decision: "deny", reason: 'reject "command"' }) as any;
  if (event === "PreToolUse") assert.deepEqual(allowed, {}, "plain allow continues without an unsupported permission override");
  else {
    assert.equal(allowed.hookSpecificOutput.hookEventName, event);
    assert.equal(allowed.hookSpecificOutput.decision.behavior, "allow");
  }
  assert.equal(event === "PreToolUse" ? denied.hookSpecificOutput.permissionDecision : denied.hookSpecificOutput.decision.behavior, "deny");
}
assert.equal((codexHookOutput("PreToolUse", { decision: "ask" }) as any).hookSpecificOutput.permissionDecision, "deny");
assert.deepEqual(codexHookOutput("PreToolUse", { decision: "allow", updated_input: { command: "echo rewritten" } }), {
  hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", permissionDecisionReason: "wezard: approval bridge unavailable", updatedInput: { command: "echo rewritten" } },
});
assert.equal(codexHookOutput("PermissionRequest", { decision: "ask" }).hookSpecificOutput, undefined);
assert.equal((codexHookOutput("PermissionRequest", { decision: "allow", updated_input: { command: "other" } }) as any).hookSpecificOutput.updatedInput, undefined);
const patch = codexApprovalRequest({ tool_name: "apply_patch", tool_input: { command: "*** Begin Patch\n*** Update File: .env\n@@\n-x\n+y\n*** End Patch" } }) as any;
assert.deepEqual(patch.tool_input.file_paths, [".env"]);
for (const tool_name of ["mcp__wezard__dispatch", "mcp__plugin_wezard_wezard__config_set"]) {
  assert.ok(codexSelfCallBypass({ tool_name }));
}
assert.equal(codexSelfCallBypass({ tool_name: "mcp__other__dispatch" }), undefined);
assert.equal(codexSelfCallBypass({ tool_name: "mcp__wezard__set_model", tool_input: { nested: { scope: "default" } } }), undefined);
assert.ok(codexSelfCallBypass({ tool_name: "mcp__wezard__set_model", tool_input: { scope: "session" } }));
for (const command of ["wezard status; rm -rf x", "wezard status\nrm -rf x", "wezard status $(id)", "wezard config set approval.enabled false"]) {
  assert.equal(codexSelfCallBypass({ tool_name: "Bash", tool_input: { command } }), undefined);
}
assert.ok(codexSelfCallBypass({ tool_name: "Bash", tool_input: { command: "/opt/bin/wezard.sh status" } }));

const log = pino({ level: "silent" });
const cfg = ConfigSchema.parse({ bot: { botId: "test", secret: "test" }, defaultChat: "user:tester", approval: {
  mode: "danger", danger: { skip: true, skipAll: true }, matcher: "Nothing", batchCoalesceMs: 0, longPollSec: 3,
} });
class Client extends EventEmitter {
  isConnected = true;
  decision: "allow" | "deny" = "allow";
  sent: any[] = [];
  updates = 0;
  failSend = false;
  async sendMessage(target: string, message: any): Promise<any> {
    if (this.failSend) throw { errcode: 93006, errmsg: "invalid chatid" };
    this.sent.push({ target, message });
    const card = message.template_card;
    const button = card?.button_list?.find((b: any) => this.decision === "deny" ? b.key.includes("deny") : b.key.includes("allow"));
    assert.ok(button, "real approval card contains the decision button");
    setImmediate(() => this.emit("event.template_card_event", {
      headers: { req_id: "click" }, body: { from: { userid: "tester" }, event: { template_card_event: { event_key: button.key, task_id: card.task_id } } },
    }));
    return {};
  }
  async updateTemplateCard(): Promise<void> { this.updates++; }
}
const client = new Client();
installApprovalEventListener(client as unknown as WSClient, log, cfg);
const handler = makeApproveHandler({ cfg, log, client: client as unknown as WSClient, getMirrorTarget: () => "user:tester#codex-test" });
const server = createServer((req, res) => { void handler(req, res, new URL(req.url ?? "/", "http://localhost"), {} as never); });
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const addr = server.address() as { port: number };
const root = mkdtempSync(join(tmpdir(), "wezard-codex-approval-"));
const config = join(root, "config.jsonc");
writeFileSync(config, JSON.stringify({ bot: { botId: "test", secret: "test" }, daemon: { port: addr.port }, approval: { hookTimeoutSec: 5 } }));
const input = { session_id: "codex-session", hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: { command: "printf hello", description: "test sandbox permission" } };
const runHook = (payload: unknown, url = `http://127.0.0.1:${addr.port}`): Promise<any> => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, ["dist/cli/codex-hook.js"], { env: { ...process.env, WEZARD_CONFIG: config, WEZARD_DAEMON_BASE: url }, stdio: ["pipe", "pipe", "pipe"] });
  let out = "", err = "";
  child.stdout.on("data", (b) => { out += b; }); child.stderr.on("data", (b) => { err += b; });
  child.on("error", reject); child.on("exit", (code) => { try { assert.equal(code, 0, err); resolve(JSON.parse(out)); } catch (e) { reject(e); } });
  child.stdin.end(JSON.stringify(payload));
});
try {
  for (const hook_event_name of ["PreToolUse", "PermissionRequest"]) {
    const self = await runHook({ ...input, hook_event_name, tool_name: "mcp__wezard__dispatch", tool_input: { name: "cli-enter-delay" } }, "http://127.0.0.1:1");
    assert.deepEqual(self, hook_event_name === "PreToolUse" ? {} : { hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } } });
    assert.equal(client.sent.length, 0, "self calls bypass cards even when daemon is unavailable");
  }
  const allow = await runHook(input);
  assert.equal(allow.hookSpecificOutput.decision.behavior, "allow");
  assert.equal(client.sent.length, 1, "native permission cannot disappear through matcher/skipAll/danger policies");
  assert.equal(client.sent[0].target, "tester", "card follows mirrored session target");
  assert.ok(JSON.stringify(client.sent[0].message).includes("Codex 沙箱权限请求"));
  client.decision = "deny";
  const deny = await runHook(input);
  assert.equal(deny.hookSpecificOutput.decision.behavior, "deny");
  assert.ok(client.updates >= 2, "card callbacks update the resolved card");
  client.isConnected = false;
  assert.equal((await runHook(input)).hookSpecificOutput, undefined, "native approval remains local on disconnect");
  const before = client.sent.length;
  const pre = await runHook({ ...input, hook_event_name: "PreToolUse" });
  assert.deepEqual(pre, {}, "ordinary approval emits a successful no-op");
  assert.equal(client.sent.length, before, "ordinary tools retain configured policy");
  assert.equal((await runHook({ ...input, hook_event_name: "PreToolUse" }, "http://127.0.0.1:1")).hookSpecificOutput.permissionDecision, "deny", "bridge failure cannot fail open at PreToolUse");
  assert.equal((await runHook(input, "https://untrusted.example")).hookSpecificOutput, undefined, "no hook inputs are sent outside loopback");
  client.isConnected = true;
  client.failSend = true;
  const failedSend = await runHook(input);
  assert.equal(failedSend.hookSpecificOutput, undefined, "card send failure never grants native permission");
  assert.match(failedSend.systemMessage, /send_card_fail:invalid chatid/, "SDK rejection is surfaced instead of reported as approval timeout");
} finally {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(root, { recursive: true, force: true });
}
console.log("Codex allow/deny/card routing/fallback checks passed");
