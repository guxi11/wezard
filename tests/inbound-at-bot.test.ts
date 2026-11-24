// @ 了机器人的人话 = 已有确定的接待者 (host / 被点名者): 账本行记 mention:"bot", 不再交给 room 的
// monitor 判决 (人 2026-11-24)。实录: 频道帖子里 @ 机器人那句以原生帧 (compat_info.source=channel)
// 进来, 正文里没有 @token, 于是行上没记 mention → judge 把它交给 monitor, monitor 再判给 host。
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { ConfigSchema } from "../shared/config.js";
import { applyOp } from "../shared/room.js";
import { atBot, installInboundRouter } from "../daemon/inbound.js";
import { bindWizardStore, loadWizardStore } from "../daemon/wizard.js";
import { H, room as mkRoom, say, uid, W } from "./room-fixture.js";

const NAMES = ["wezard"];
const group = (over: Record<string, unknown> = {}) => ({
  msgid: "m-1", chattype: "group", chatid: "G", from: { userid: "tester" }, msgtype: "text", ...over,
});

// ① 判据本身: 频道原生帧 / 正文里的机器人名; 群里随手 @ 一个非机器人 token 不算。
assert.equal(atBot(NAMES, group({ compat_info: { source: "channel" } }) as never, "分析一下"), true,
  "频道原生帧 = 人 @ 了机器人 (企微只为 @ 的那句发原生帧, 正文里反倒没有 @token)");
assert.equal(atBot(NAMES, group() as never, "@wezard 看下"), true, "正文里的机器人名");
assert.equal(atBot(NAMES, group() as never, "看下这个"), false, "没 @ 的群消息");
assert.equal(atBot(NAMES, group() as never, "@src/foo.ts 看下"), false, "路径不是机器人");
assert.equal(atBot(NAMES, group({ chattype: "single" }) as never, "@src/foo.ts 看下"), false, "单聊不认 @token");

// ② 端到端: dispatch 带上 mentionBot (账本行据此记 mention:"bot")。
const ROOT = mkdtempSync(join(tmpdir(), "inbound-at-bot-"));
const cfg = ConfigSchema.parse({
  bot: { botId: "test", secret: "test" },
  daemon: { stateDir: join(ROOT, "state") },
  wrc: { allowFrom: ["user:tester"], channel: { history: { enabled: false } } },
  chatPolicy: { "chat:G": { steward: "fix" } },
  defaultChat: "user:home",
});
const store = bindWizardStore(loadWizardStore(join(ROOT, "wizards.json")));
store.upsert("user:home", { identity: "user:home", name: "gsw", description: "全局管家", kind: "global-steward", bornAt: 1 });
store.upsert("chat:G#fix", { identity: "chat:G#fix", name: "fix", description: "工人", bornAt: 2 });

const handlers = new Map<string, (f: unknown) => Promise<void>>();
const dispatched: Array<{ mentionBot?: boolean }> = [];
const bridge = {
  hasMirrorTarget: () => true, isOpenBubbleQuote: () => false, status: () => ({ mirrors: [] }),
  getCwd: () => ({ runningCwd: "/repo", defaultCwd: "/repo" }),
  newSession: async () => ({ ok: true }),
  dispatch: async (a: { mentionBot?: boolean }) => { dispatched.push(a); },
  chatRoster: () => [], peers: async () => [], interruptPane: async () => ({ ok: true }),
  killPane: async () => ({ ok: true }), submitPane: async () => ({ ok: true }),
};
const client = { on: (e: string, h: (f: unknown) => Promise<void>) => handlers.set(e, h), replyStream: async () => ({}) };
installInboundRouter(client as never, cfg, pino({ level: "silent" }), bridge as never, join(ROOT, "unused.jsonc"), (() => {}) as never);
const text = handlers.get("message.text")!;
await text({ headers: {}, body: group({ compat_info: { source: "channel" }, text: { content: "分析一下" } }) });
await text({ headers: {}, body: group({ text: { content: "@wezard 看下" } }) });
await text({ headers: {}, body: group({ text: { content: "看下这个" } }) });
assert.equal(dispatched.length, 3);
assert.equal(dispatched[0]!.mentionBot, true, "频道原生帧 (帖子里 @ 机器人) 带 mentionBot");
assert.equal(dispatched[1]!.mentionBot, true, "正文 @ 机器人带 mentionBot");
assert.equal(dispatched[2]!.mentionBot, undefined, "没 @ 的话不带 (照旧交给 monitor / host)");

// ③ 账本侧: 带 mention:"bot" 的行跳过 monitor, 直接落 host; 没有它则只唤醒 monitor。
const A = W(uid(1)), M = W(uid(9)), H1 = H("u1");
const withMonitor = () => {
  const s = mkRoom("chat:wrG", [A]);
  applyOp(s, { op: "join", at: 2_000, room: s.id, who: M, ord: s.nextOrd, via: "invite", by: A, role: "monitor" });
  return s;
};
{
  const s = withMonitor();
  const at = say(s, { author: H1, kind: "say", text: "看下这个", mention: "bot" });
  assert.deepEqual(at.wake, [A.id], "@ 了机器人: 直达 host");
  assert.equal(at.monitor, undefined);
  const plain = say(s, { author: H1, kind: "say", text: "这个怎么弄" });
  assert.deepEqual(plain.wake, [M.id], "没 @ 的话照旧交给 monitor");
  assert.equal(plain.monitor, true);
}

console.log("inbound at-bot: 频道原生帧 / 正文 @机器人 记 mention:bot, 不唤醒 monitor");
