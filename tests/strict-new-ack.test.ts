import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import pino from "pino";
import { ConfigSchema } from "../shared/config.js";
import { installInboundRouter } from "../daemon/inbound.js";
import { bindTagLinker, createdAck } from "../shared/session-label.js";

// 严格群的 /new 确认 (`[wezard] <name> created`) 是 daemon 的系统行, 不是模型发言 ——
// 它必须绕过严格群出站门直达聊天; implicit 群由 mirror 的 pushProjectInfo 发
// `<name> created` (同一份 createdAck), daemon 这边不能多发一条。
// name = 该会话的 wizard 名 (displayName, 与气泡头同源), 不是 pane 名 / chat 名。
// 驱动的是真的 inbound 路由闭包, 只把 client / bridge 换成记录器。

// 名册没在测试里绑 —— 这里是它的对外面: displayName(target) 取的就是这个 nameOf。
// 只有 /new 那几组要名字: 名字一旦落定, 所有 replyText 都会带 `🧙 Nova：` 头,
// 其余组的断言写的是裸文案。所以名册按组切换 (空 = 与未绑定时同形)。
let NAMES: Record<string, string> = { "chat:room": "Nova", "chat:other": "Patch", "user:tester": "Solo" };
bindTagLinker({ urlOf: () => undefined, resolve: () => undefined, nameOf: (t) => NAMES[t] ?? "" });

const strictReply = createdAck("Nova", true);
// mirror-bridge 的 sendStandalone 白名单: 这个前缀就是「系统提示」的判据。
assert.equal(strictReply, "[wezard] Nova created");
assert.match(strictReply, /^\[(mirror|wezard)\]/, "系统行必须带 [wezard]/[mirror] 前缀");
assert.equal(createdAck("Nova", false), "Nova created", "implicit 群: 裸文案带身份名");
assert.doesNotMatch(createdAck("Nova", false), /^\[(mirror|wezard)\]/, "裸 created 不是系统行 (会被严格群出站门拦下)");
assert.equal(createdAck("", false), "created", "拿不到名字时退回旧文案");
assert.equal(createdAck("", true), "[wezard] created");

type Spawn = (target: string, windowName?: string, opts?: { silent?: boolean; model?: string }) => Promise<{ ok: boolean; reason?: string; sessionId?: string }>;

const session = (policy: Record<string, unknown>, spawn: Spawn = async () => ({ ok: true, sessionId: "sid" })) => {
  const handlers = new Map<string, (...args: any[]) => Promise<void>>();
  const replies: string[] = [];
  const spawned: Array<{ target: string; opts: { silent?: boolean; model?: string } }> = [];
  const cfg = ConfigSchema.parse({
    bot: { botId: "test", secret: "test" },
    wrc: { allowFrom: ["user:tester"] },
    ...(Object.keys(policy).length ? { chatPolicy: policy } : {}),
  });
  const client = {
    on: (event: string, handler: any) => handlers.set(event, handler),
    replyStream: async (_frame: unknown, _id: string, text: string) => { replies.push(text); },
    sendMessage: async () => ({ errcode: 0 }),
  };
  const bridge = {
    hasMirrorTarget: () => true,
    status: () => ({ mirrors: [] }),
    getCwd: () => ({ runningCwd: "/repo/current", pendingCwd: "", defaultCwd: "/repo/default" }),
    newSession: async (target: string, _windowName?: string, opts?: { silent?: boolean; model?: string }) => {
      spawned.push({ target, opts: opts ?? {} });
      return spawn(target, _windowName, opts);
    },
    chatRoster: () => [],
    peers: async () => [],
    dispatch: async () => undefined,
  };
  installInboundRouter(client as any, cfg, pino({ level: "silent" }), bridge as any, "/private/tmp/unused-strict-new-ack.jsonc", (() => {}) as any);
  const send = async (chatType: "single" | "group", chatId: string | undefined, text: string): Promise<void> => {
    await handlers.get("message.text")!({ headers: { req_id: text }, body: {
      msgid: text, chattype: chatType, chatid: chatId, from: { userid: "tester" }, msgtype: "text", text: { content: text },
    } });
  };
  return { send, replies, spawned };
};

// 1) 严格群: 恰好一条 `[wezard] <name> created` 外发, 且是正常 spawn。
{
  const s = session({ "chat:room": { speech: "strict" } });
  await s.send("group", "room", "/new");
  assert.equal(s.spawned.length, 1, "严格群 /new 仍 spawn");
  assert.equal(s.spawned[0]!.opts.silent, false, "/new 不是 silent spawn");
  assert.deepEqual(s.replies, [strictReply], "严格群 /new 恰好一条系统行确认");
}

// 1b) 两条对照: 不同身份的会话各拿自己的名字 (同一个 daemon, 两个严格群)。
{
  const s = session({ "chat:room": { speech: "strict" }, "chat:other": { speech: "strict" } });
  await s.send("group", "room", "/new");
  await s.send("group", "other", "/new");
  assert.deepEqual(s.replies, ["[wezard] Nova created", "[wezard] Patch created"], "确认文案跟着身份名走");
}

// 1c) implicit 群的 created 由 mirror 拼 (同一份 createdAck), 调用点钉住。
{
  const mirrorSrc = readFileSync("daemon/mirror-bridge.ts", "utf8");
  assert.match(mirrorSrc, /pushProjectInfo\(target, createdAck\(displayName\(target\), false\)\)/,
    "implicit 群的 created 用身份名拼, 不带系统前缀");
}

// 2) implicit 单聊: daemon 不多发 —— 确认仍由 mirror 的 pushProjectInfo 负责。
{
  const s = session({});
  await s.send("single", undefined, "/new");
  assert.equal(s.spawned.length, 1);
  assert.deepEqual(s.replies, [], "implicit 群 /new 不新增外发 (保持裸 created 的现状)");
}

// 3) 显式 implicit 的群 (拨回口径) 同 2。
{
  const s = session({ "chat:room": { speech: "implicit" } });
  await s.send("group", "room", "/new");
  assert.deepEqual(s.replies, [], "显式 implicit 群 /new 不新增外发");
}

NAMES = {};

// 4) 严格群 spawn 失败: 仍只回失败那一行 —— 系统行不抢在失败前面。
{
  const s = session({ "chat:room": { speech: "strict" } }, async () => ({ ok: false, reason: "spawn denied" }));
  await s.send("group", "room", "/new");
  assert.equal(s.replies.length, 1);
  assert.match(s.replies[0]!, /^\[wezard\] \/new failed: spawn denied$/);
}

// 5) 严格群里「不过门」的那批命令回执 (replyText → 直发 replyStream) 照常到人。
for (const [command, pattern] of [["/pwd", /^\/repo\/current$/], ["/help", /\/new/], ["/id", /^\[wezard\]|user:tester/]] as const) {
  const s = session({ "chat:room": { speech: "strict" } });
  await s.send("group", "room", command);
  assert.equal(s.replies.length, 1, `${command} 在严格群恰有一条回执`);
  assert.match(s.replies[0]!, pattern as RegExp, `${command} 的回执内容不变`);
}

// 6) /clear 的边界确认: strict 带 [wezard] 前缀, implicit 保持裸 "cleared"。
//    /clear 的确认在 mirror 的 dispatch 闭包里 (无 live stream), 抽出来直接跑。
{
  const mirror = readFileSync("daemon/mirror-bridge.ts", "utf8");
  const begin = "        if (armMigration) {";
  const end = "        // Don't await the stream's lifetime";
  const start = mirror.indexOf(begin);
  const stop = mirror.indexOf(end, start);
  assert(start >= 0 && stop > start, "missing /clear ack closure");
  const body = ts.transpileModule(mirror.slice(start, stop), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  const clearAck = (strict: boolean): string[] => {
    const sent: string[] = [];
    const a: any = {};
    new Function("armMigration", "sendStandalone", "a", "preClearBaseline", "jsonlIsPostClearChild", "startMigrationWatcher", "strictChat",
      body)(
      true, (_a: unknown, text: string) => sent.push(text), a, "baseline", () => true, () => undefined, () => strict,
    );
    assert.deepEqual(a.clearRebind, { baseline: "baseline" }, "迁移 watcher 照旧武装");
    return sent;
  };
  assert.deepEqual(clearAck(true), ["[wezard] cleared"], "严格群 /clear 确认带系统前缀");
  assert.deepEqual(clearAck(false), ["cleared"], "implicit 群 /clear 文案零变化");
}

// 7) [mirror] 系统行本来就是白名单成员 (注入超时 / 代按 / 投递失败)。
for (const line of ["[mirror] ✗ 注入超时 120s — tmux 无响应, 本轮已放弃。", "[mirror] 🚫 已拒绝 CLI 确认", "[mirror] ⚠️ 消息已发送,但目标会话似乎正忙或未响应"]) {
  assert.match(line, /^\[(mirror|wezard)\]/, `${line.slice(0, 14)}… 走系统行白名单`);
}

console.log("Strict system receipts: [wezard] created / [wezard] cleared bypass the strict outbound gate; implicit wording unchanged; ungated command replies still reach strict chats");
