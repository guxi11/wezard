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
  newSession: async (...args: any[]) => { calls.push(args); return { ok: true }; },
};
const cfg = ConfigSchema.parse({ bot: { botId: "test", secret: "test" }, wrc: { defaultCli: "codex", allowFrom: ["user:tester"] } });
bindCliBackends({ defaultCli: "codex" });
try {
  installInboundRouter(client as any, cfg, pino({ level: "silent" }), bridge as any, "/private/tmp/unused-wezard-test-config.jsonc", (() => {}) as any);
  for (const command of ["/new", "/new claude", "/new codex gpt-6.1-sol"]) {
    await handlers.get("message.text")!({ headers: { req_id: command }, body: { msgid: command, chattype: "single", from: { userid: "tester" }, msgtype: "text", text: { content: command } } });
  }
  assert.deepEqual(calls.map((c) => c[2]), ["codex", "claude", "codex"]);
  assert.equal(calls[2][3].model, "gpt-6.1-sol");
} finally { bindCliBackends({}); }
console.log("Inbound /new defaults to configured backend and preserves explicit overrides");
