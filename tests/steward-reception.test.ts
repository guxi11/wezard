// v3 P3 接待闭环 (inbound 集成): 全新聊天的裸消息 → 管家接待解析 → 新化身注册 →
// 在身份工作区 ensureSession → dispatch 落到该化身。第二条消息不再重复 spawn。
// 存量聊天 (untagged 记录在) 裸消息仍落 base, 且不触发任何 spawn —— 行为零变化。
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { ConfigSchema } from "../shared/config.js";
import { bindWizardStore, loadWizardStore } from "../daemon/wizard.js";
import { installInboundRouter } from "../daemon/inbound.js";

const ROOT = mkdtempSync(join(tmpdir(), "reception-"));
const cfg = ConfigSchema.parse({
  bot: { botId: "test", secret: "test" },
  wrc: { allowFrom: ["user:tester"] },
  defaultChat: "user:home",
});

// 名册: 家的默认会话 = 全局管家 (boot markGlobalSteward 之后的世界); 测试聊天 user:tester 还没有任何记录。
const store = bindWizardStore(loadWizardStore(join(ROOT, "wizards.json")));
store.upsert("user:home", { identity: "user:home", name: "gsw", description: "全局管家", kind: "global-steward", bornAt: 1 });

const handlers = new Map<string, (f: unknown) => Promise<void>>();
const replies: string[] = [];
const spawned: Array<{ target: string; name: string; opts: Record<string, unknown> }> = [];
const dispatched: Array<{ principal: string; text: string }> = [];
let attached = new Set<string>();
const bridge = {
  hasMirrorTarget: (t: string) => attached.has(t),
  status: () => ({ mirrors: [] }),
  // 身份锚点 (user:home) 的工作区; 别的 target 无关紧要。
  getCwd: (t: string) => ({ runningCwd: t === "user:home" ? "/home/ws" : "", pendingCwd: "", defaultCwd: "" }),
  newSession: async (target: string, name: string, opts: Record<string, unknown>) => {
    spawned.push({ target, name, opts });
    attached.add(target);
    return { ok: true, sessionId: "s1", cwd: (opts as { cwd?: string }).cwd ?? "" };
  },
  dispatch: async (a: { principal: string; text: string }) => { dispatched.push({ principal: a.principal, text: a.text }); },
  chatRoster: () => [{ base: "user:tester", name: "", self: true, targets: [] }],
  peers: async () => [],
  interruptPane: async () => ({ ok: true }),
  killPane: async () => ({ ok: true }),
  submitPane: async () => ({ ok: true }),
};
const client = {
  on: (event: string, handler: (f: unknown) => Promise<void>) => handlers.set(event, handler),
  replyStream: async (_f: unknown, _id: string, text: string) => { replies.push(text); },
};
installInboundRouter(client as never, cfg, pino({ level: "silent" }), bridge as never,
  join(ROOT, "unused.jsonc"), (() => {}) as never);

const msgOf = (text: string) => ({
  headers: { req_id: text },
  body: { msgid: text, chattype: "single", from: { userid: "tester" }, msgtype: "text", text: { content: text }, create_time: 1700000000000 },
});
const send = async (text: string): Promise<void> => { await handlers.get("message.text")!(msgOf(text)); };

// ── 新聊天: 裸消息 → 全局管家化身, 起在身份工作区 ──────────────────────────
await send("你好, 帮我看看这个仓库");
const target = "user:tester#gsw";
assert.equal(spawned.length, 1, "第一条裸消息触发一次 spawn");
assert.equal(spawned[0]!.target, target);
assert.equal(spawned[0]!.opts.cwd, "/home/ws", "新化身起在身份工作区, 不是兜底目录");
assert.equal(spawned[0]!.opts.silent, true);
assert.equal(dispatched.length, 1);
assert.equal(dispatched[0]!.principal, target, "消息投给管家化身, 不是 untagged 兜底");
assert.ok(dispatched[0]!.text.includes("你好"), "正文原样");
// 化身记录已注册: 身份/名字/种类对齐全局管家。
const rec = store.get(target);
assert.equal(rec?.identity, "user:home");
assert.equal(rec?.name, "gsw");
assert.equal(rec?.kind, "global-steward");
// untagged 兜底会话没有被创建 —— 新群不再 auto-spawn 默认 wizard。
assert.equal(store.get("user:tester"), undefined);

// ── 第二条裸消息: 化身已附着, 不再 spawn ─────────────────────────────────
await send("继续");
assert.equal(spawned.length, 1, "已附着的化身不重复 spawn");
assert.equal(dispatched.length, 2);
assert.equal(dispatched[1]!.principal, target);

// ── 存量聊天 (untagged 记录在): 裸消息仍落 base, 零 spawn ────────────────
store.upsert("user:oldchat", { identity: "user:oldchat", name: "old", bornAt: 2 });
attached = new Set(["user:oldchat"]);
await handlers.get("message.text")!((() => {
  const m = msgOf("在吗");
  m.body.from = { userid: "oldchat" };
  return m;
})());
assert.equal(dispatched.at(-1)!.principal, "user:oldchat", "存量聊天裸消息仍落 untagged base");
assert.equal(spawned.length, 1, "存量聊天不触发新 spawn");

console.log("reception flow: new-chat global steward manifestation + identity workspace + no-respawn + legacy chat unchanged all passed");
