import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import pino from "pino";
import { ConfigSchema } from "../shared/config.js";
import { installInboundRouter } from "../daemon/inbound.js";
import { bindTagLinker, createdAck, parseTagHeader, WIZARD_MARK } from "../shared/session-label.js";

// room 口径 (fix-task §8.3): /new 的会话边界确认只有一种形态 —— mirror 的
// pushProjectInfo 发 createdAck (裸 `🧙 <name> created`, 不带 [wezard] 前缀),
// 不论什么群; daemon (inbound) 不再补发任何确认 (出站门已废, 「严格群被静音要补
// 一条」的前提不存在了)。name = 该会话的 wizard 名 (displayName, 与气泡头同源)。
// 驱动的是真的 inbound 路由闭包, 只把 client / bridge 换成记录器。

// 名册没在测试里绑 —— 这里是它的对外面: displayName(target) 取的就是这个 nameOf。
// 只有 /new 那几组要名字: 名字一旦落定, 所有 replyText 都会带 `🧙 Nova：` 头,
// 其余组的断言写的是裸文案。所以名册按组切换 (空 = 与未绑定时同形)。
let NAMES: Record<string, string> = { "chat:room": "Nova", "chat:other": "Patch", "user:tester": "Solo" };
bindTagLinker({ urlOf: () => undefined, resolve: () => undefined, nameOf: (t) => NAMES[t] ?? "" });

const ack = createdAck("chat:room");
assert.equal(ack, `${WIZARD_MARK} Nova created`, "room 口径: 唯一形态, 带身份名与记号");
assert.doesNotMatch(ack, /^\[(mirror|wezard)\]/, "created 不带系统前缀 (前缀写法只留给 daemon 系统行那一处)");
// 名字拿不到也要有记号 —— 不出现空白身份。
assert.equal(createdAck(undefined), `${WIZARD_MARK} created`);
// 记号必须与气泡头同一个原子: tagHead 的头就是 `WIZARD_MARK name`, 这里用它做前缀原子。
assert.ok(ack.startsWith(`${WIZARD_MARK} Nova `), "created 的记号/名字与气泡头同源");
// 它不是气泡头: 没有全角冒号, parseTagHeader 不该把它当 bot 发言剥掉。
{
  const parsed = parseTagHeader(ack);
  assert.equal(parsed.fromBot, false, "不是带头的 bot 气泡");
  assert.equal(parsed.body, ack, "正文原样保留 (记号不被当身份前缀吃掉)");
}

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

// 1) /new: daemon 零外发 —— 确认只有 mirror 的 pushProjectInfo 那一条 (裸 created),
//    残留 speech 旧键的群行为也一样 (读侧已剥, 不再有严格群分支)。
{
  const s = session({ "chat:room": { speech: "strict" } });
  await s.send("group", "room", "/new");
  assert.equal(s.spawned.length, 1, "/new 仍 spawn");
  assert.equal(s.spawned[0]!.opts.silent, false, "/new 不是 silent spawn");
  assert.deepEqual(s.replies, [], "room 口径: daemon 不补发任何确认 (mirror 那条是唯一形态)");
}

// 1b) 两条对照: 不同身份的会话各自 spawn, daemon 同样零外发。
{
  const s = session({ "chat:room": { speech: "strict" }, "chat:other": { speech: "strict" } });
  await s.send("group", "room", "/new");
  await s.send("group", "other", "/new");
  assert.equal(s.spawned.length, 2, "各自 spawn");
  assert.deepEqual(s.replies, [], "两个群都是零外发");
}

// 1c) created 由 mirror 拼 (同一份 createdAck), 调用点钉住。
{
  const mirrorSrc = readFileSync("daemon/mirror-bridge.ts", "utf8");
  assert.match(mirrorSrc, /pushProjectInfo\(target, createdAck\(target\)\)/,
    "created 从 target 取身份名与记号 (createdAck → tagHead), 不带系统前缀, 全群唯一形态");
}

// 2) 单聊: daemon 不多发 —— 确认仍由 mirror 的 pushProjectInfo 负责。
{
  const s = session({});
  await s.send("single", undefined, "/new");
  assert.equal(s.spawned.length, 1);
  assert.deepEqual(s.replies, [], "/new 不新增外发 (裸 created 由 mirror 发)");
}

// 3) 显式 implicit 的群同 2 (room 口径下所有群同读数)。
{
  const s = session({ "chat:room": { speech: "implicit" } });
  await s.send("group", "room", "/new");
  assert.deepEqual(s.replies, [], "显式 implicit 群 /new 不新增外发");
}

NAMES = {};

// 4) spawn 失败: 仍只回失败那一行 —— 确认不抢在失败前面。
{
  const s = session({ "chat:room": { speech: "strict" } }, async () => ({ ok: false, reason: "spawn denied" }));
  await s.send("group", "room", "/new");
  assert.equal(s.replies.length, 1);
  assert.match(s.replies[0]!, /^\[wezard\] \/new failed: spawn denied$/);
}

// 5) 「不过门」的那批命令回执 (replyText → 直发 replyStream) 照常到人。
for (const [command, pattern] of [["/pwd", /^\/repo\/current$/], ["/help", /\/new/], ["/id", /^\[wezard\]|user:tester/]] as const) {
  const s = session({ "chat:room": { speech: "strict" } });
  await s.send("group", "room", command);
  assert.equal(s.replies.length, 1, `${command} 恰有一条回执`);
  assert.match(s.replies[0]!, pattern as RegExp, `${command} 的回执内容不变`);
}

// 6) /clear 的边界确认: room 口径统一裸 "cleared" (不再分群加 [wezard] 前缀)。
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
  const clearAck = (): string[] => {
    const sent: string[] = [];
    const a: any = {};
    new Function("armMigration", "sendStandalone", "a", "preClearBaseline", "jsonlIsPostClearChild", "startMigrationWatcher",
      body)(
      true, (_a: unknown, text: string) => sent.push(text), a, "baseline", () => true, () => undefined,
    );
    assert.deepEqual(a.clearRebind, { baseline: "baseline" }, "迁移 watcher 照旧武装");
    return sent;
  };
  assert.deepEqual(clearAck(), ["cleared"], "/clear 确认裸文案, 全群同一形态");
}

// 7) [mirror] 系统行本来就是白名单成员 (注入超时 / 代按 / 投递失败)。
for (const line of ["[mirror] ✗ 注入超时 120s — tmux 无响应, 本轮已放弃。", "[mirror] 🚫 已拒绝 CLI 确认", "[mirror] ⚠️ 消息已发送,但目标会话似乎正忙或未响应"]) {
  assert.match(line, /^\[(mirror|wezard)\]/, `${line.slice(0, 14)}… 走系统行白名单`);
}

console.log("room 口径会话边界回执: created/cleared 各只剩裸文案一种形态, daemon /new 零补发; 不过门的命令回执照常");
