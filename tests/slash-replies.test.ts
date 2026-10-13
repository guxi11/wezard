import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import pino from "pino";
import { ConfigSchema } from "../shared/config.js";
import { installInboundRouter } from "../daemon/inbound.js";
import { renderSyncReport } from "../daemon/cfg-sync.js";
import { renderAccounts } from "../daemon/weixin-cmd.js";

// Run the production reply closures with controlled transports, avoiding tmux
// or live sessions while checking both legacy slashAckFirstLine settings.
const mirror = readFileSync("daemon/mirror-bridge.ts", "utf8");
const inbound = readFileSync("daemon/inbound.ts", "utf8");
const transpile = (source: string): string => ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;
const closure = (source: string, begin: string, end: string): string => {
  const start = source.indexOf(begin);
  const stop = source.indexOf(end, start);
  assert(start >= 0 && stop > start, `missing production closure ${begin}`);
  return source.slice(start, stop);
};
const newReply = closure(mirror, "  const pushProjectInfo =", "  // Cwd is CHAT-SCOPED");
const clearReply = closure(mirror,
  "        if (armMigration) {\n          sendStandalone",
  "        // Don't await the stream's lifetime");
for (const slashAckFirstLine of [false, true]) {
  const sent: string[] = [];
  const attached = {};
  const cfg = { wrc: { mirror: { slashAckFirstLine } } };
  const push = new Function("cfg", "byTarget", "sendStandalone", "stripPrincipalPrefix", "client", "withTagHeader", "log",
    transpile(`${newReply}\nreturn pushProjectInfo;`))(
      cfg, new Map([["user:tester", attached]]), (_a: unknown, text: string) => sent.push(text),
      (key: string) => key.replace(/^user:/, ""),
      { sendMessage: async (_id: string, body: any) => sent.push(body.markdown.content) },
      (_key: string, text: string) => text, pino({ level: "silent" }),
    );
  push("user:tester", "created");
  push("user:missing", "created");
  push("user:tester");
  assert.deepEqual(sent, ["created", "created"], "/new sends one result and no tip-only message");
  let watched = 0;
  const a: any = {};
  new Function("cfg", "armMigration", "sendStandalone", "a", "preClearBaseline", "startMigrationWatcher", "jsonlIsPostClearChild",
    transpile(clearReply))(cfg, true, (_a: unknown, text: string) => sent.push(text), a, "baseline", () => watched++, () => true);
  assert.equal(sent.at(-1), "cleared");
  assert.deepEqual(a.clearRebind, { baseline: "baseline" });
  assert.equal(watched, 1, "/clear still arms its migration watcher");
}

const handlers = new Map<string, (...args: any[]) => Promise<void>>();
const replies: string[] = [];
const spawned: any[][] = [];
let unconfirmed = false;
const cfg = ConfigSchema.parse({ bot: { botId: "test", secret: "test" }, wrc: { allowFrom: ["user:tester"] } });
const client = {
  on: (event: string, handler: any) => handlers.set(event, handler),
  replyStream: async (_frame: unknown, _id: string, text: string) => replies.push(text),
};
const bridge = {
  hasMirrorTarget: () => true,
  status: () => ({ mirrors: [] }),
  getCwd: () => ({ runningCwd: "/repo/current", pendingCwd: "/repo/next", defaultCwd: "/repo/default" }),
  cwdUnconfirmed: () => unconfirmed,
  newSession: async (...args: any[]) => { spawned.push(args); return { ok: false, reason: "spawn denied" }; },
  chatRoster: () => [{ base: "user:tester", name: "team", self: true, targets: ["user:tester#worker"] }],
  peers: async () => [{ target: "user:tester#worker", cwd: "/repo/current", cli: "codex", label: "🧙", paneAlive: true, busy: false, self: true, summary: "done" }],
};
installInboundRouter(client as any, cfg, pino({ level: "silent" }), bridge as any,
  "/private/tmp/unused-slash-reply-test.jsonc", (() => {}) as any);
const run = async (command: string): Promise<string> => {
  const before = replies.length;
  await handlers.get("message.text")!({ headers: { req_id: command }, body: {
    msgid: command, chattype: "single", from: { userid: "tester" }, msgtype: "text", text: { content: command },
  } });
  assert.equal(replies.length, before + 1, `${command} has one result`);
  return replies.at(-1)!;
};
assert.equal(await run("/pwd"), "[wezard] 📂 当前项目: `/repo/current`\n下次切换: `/repo/next`\n(默认: `/repo/default`)");
unconfirmed = true;
assert.match(await run("/pwd"), /⚠️ 这是默认兜底目录, 还没人确认过$/);
assert.equal(await run("/new codex gpt-6.1-sol"), "[wezard] /new failed: spawn denied");
assert.equal(spawned[0]![2], "codex");
assert.equal(spawned[0]![3].model, "gpt-6.1-sol");
assert.equal(await run("/name"), "[wezard] 本聊天还没起名。");
for (const command of ["/peers", "/chats"]) {
  const text = await run(command);
  assert.match(text, /worker|done|会话/);
  assert.doesNotMatch(text, />|协作：|分身：|起名：|寻址：|💡/);
}
assert.match(await run("/help"), /\/new/);

const sessions = closure(inbound, "const renderSessionsList =", "// /peers —");
const renderSessions = new Function(transpile(`${sessions}\nreturn renderSessionsList;`))();
assert.equal(renderSessions([], ""), "[wezard] 未发现正在运行的 Agent 会话");
assert.equal(renderSessions([{ cli: "codex", label: "🧙", sessionId: "12345678abcdef", cwd: "/repo/current" }], "12345678abcdef"),
  "[wezard] 正在运行的会话：\n🧙 `12345678` current ⬅️ 当前");
const preview = renderSyncReport({ cwd: "/repo", roots: ["claude", "codex"], items: [{ key: "file", status: "copy", targets: ["codex"] }], applied: false } as any);
assert.match(preview, /预演模式,未写入。$/);
assert.doesNotMatch(preview, /执行同步|cfgsync apply/);
assert.equal(renderAccounts(cfg, []), "[wezard] 还没有绑定微信。");
assert.doesNotMatch(renderAccounts(cfg, [{ chatId: "wx_test", state: "live", outbox: [] }] as any), /\/wx bind|\/wx unbind/);
console.log("Slash replies: concise results, preserved errors and actions, no random or instructional tips");
