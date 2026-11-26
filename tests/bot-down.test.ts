// 机器人 WS 断线时 /approve 不放行: 普通工具 / askRules / danger / codex 沙箱权限一律回 "pass"
// (hook 译成不答复, 交回 CLI 自己的权限流), 绝不 allow。运行: npx tsx tests/bot-down.test.ts
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import type { WSClient } from "@wecom/aibot-node-sdk";
import { ConfigSchema } from "../shared/config.js";
import { daemonRequest } from "../shared/daemon-client.js";
import { codexHookOutput } from "../shared/codex-approval.js";
import { makeApproveHandler, botDown } from "../daemon/approval.js";

// 纯函数: botDown 只有一种答案, 与 guard / codex 无关。
assert.deepEqual(botDown("ws_disconnected"), { decision: "pass", reason: "ws_disconnected:no_auto_allow" });

const log = pino({ level: "silent" });
const cfg = ConfigSchema.parse({
  bot: { botId: "test", secret: "test" }, defaultChat: "user:tester",
  approval: { mode: "all", matcher: ".*", batchCoalesceMs: 0, longPollSec: 3, fallbackOnError: "allow", askRules: ["Bash(echo askme*)"] },
});
class Client extends EventEmitter {
  isConnected = false;
  sent: unknown[] = [];
  async sendMessage(_t: string, m: unknown): Promise<unknown> { this.sent.push(m); return {}; }
  async updateTemplateCard(): Promise<void> {}
}
const client = new Client();
const handler = makeApproveHandler({ cfg, log, client: client as unknown as WSClient, getMirrorTarget: () => "user:tester#bot-down" });
const server = createServer((req, res) => { void handler(req, res, new URL(req.url ?? "/", "http://localhost"), {} as never); });
const root = mkdtempSync(join(tmpdir(), "wezard-bot-down-"));
const sock = join(root, "d.sock");
await new Promise<void>((resolve) => server.listen(sock, resolve));
const approve = async (body: Record<string, unknown>) =>
  (await daemonRequest("POST", "/approve", { socketPath: sock, body: { session_id: "s1", cwd: root, ...body }, timeoutMs: 5000 })).json as { decision: string; reason?: string };

try {
  const cases: [string, Record<string, unknown>][] = [
    ["plain tool", { tool_name: "Bash", tool_input: { command: "ls" } }],
    ["askRules hit", { tool_name: "Bash", tool_input: { command: "echo askme now" } }],
    ["danger list", { tool_name: "Bash", tool_input: { command: "git push --force origin main" } }],
    ["codex native permission", { cli_backend: "codex", hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: { command: "touch x" } }],
    ["codex PreToolUse", { cli_backend: "codex", hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "ls" } }],
  ];
  for (const [name, body] of cases) {
    const r = await approve(body);
    assert.equal(r.decision, "pass", `${name}: bot down → pass, got ${JSON.stringify(r)}`);
    assert.match(r.reason ?? "", /^ws_disconnected/, name);
  }
  assert.equal(client.sent.length, 0, "no card goes out while the bot is down");

  // codex 侧: pass 在 PreToolUse 落成 deny (codex 没有 ask), PermissionRequest 落成原生提示 (systemMessage), 都不是 allow。
  const pre = codexHookOutput("PreToolUse", botDown("ws_disconnected")) as any;
  assert.equal(pre.hookSpecificOutput.permissionDecision, "deny");
  const perm = codexHookOutput("PermissionRequest", botDown("ws_disconnected")) as any;
  assert.equal(perm.hookSpecificOutput, undefined);
  assert.match(perm.systemMessage, /ws_disconnected/);
} finally {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(root, { recursive: true, force: true });
}
console.log("bot-down checks passed");
