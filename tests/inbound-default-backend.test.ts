import assert from "node:assert/strict";
import pino from "pino";
import { ConfigSchema } from "../shared/config.js";
import { bindCliBackends } from "../shared/cli-backends.js";
import { installInboundRouter } from "../daemon/inbound.js";

const handlers = new Map<string, (...args: any[]) => Promise<void>>();
const calls: any[][] = [];
const client = { on: (event: string, fn: any) => handlers.set(event, fn), replyStream: async () => {} };
const bridge = {
  hasMirrorTarget: () => true,
  status: () => ({ mirrors: [{ target: "user:tester", jsonlPath: "/Users/tester/.claude/projects/project/old.jsonl" }] }),
  getCwd: () => ({ runningCwd: "/repo/current", defaultCwd: "/repo/default" }),
  newSession: async (...args: any[]) => { calls.push(args); return { ok: true }; },
};
const cfg = ConfigSchema.parse({ bot: { botId: "test", secret: "test" }, wrc: { defaultCli: "codex", allowFrom: ["user:tester"] } });
bindCliBackends({ defaultCli: "codex" });
try {
  installInboundRouter(client as any, cfg, pino({ level: "silent" }), bridge as any, "/private/tmp/unused-wezard-test-config.jsonc", (() => {}) as any);
  // newSession(who, name, {silent, model}): CLI 后端只由全局 defaultCli 决定, /new 里不再有后端槽位;
  // 认得出的模型 token 吃进 model, 其余 (含旧写法的 "claude" / "codex") 整段当第一句话。
  for (const command of ["/new", "/new claude", "/new codex gpt-6.1-sol", "/new gpt-6.1-sol"]) {
    await handlers.get("message.text")!({ headers: { req_id: command }, body: { msgid: command, chattype: "single", from: { userid: "tester" }, msgtype: "text", text: { content: command } } });
  }
  assert.equal(calls.length, 4);
  assert.ok(calls.every((c) => c.length === 3 && !("cli" in c[2])), "newSession 不带 cli");
  assert.deepEqual(calls.map((c) => c[2].model), [undefined, undefined, undefined, "gpt-6.1-sol"]);
} finally { bindCliBackends({}); }
console.log("Inbound /new: backend comes from config only, model token is parsed, legacy backend words are prompt text");
