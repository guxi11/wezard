// 频道 / 帖子「回复 (评论)」的 quote 是整篇帖子摘要 (不是被回复的那条): 不入 prompt、不入账本正文。
// 素材: daemon.log 2026-11-23 一帧真实回调 (tests/fixtures/channel-post-digest.txt, 1803 字符) ——
// text 只有 "＠wezard 给这个room改名为 'we channel'", quote 是全帖摘要。
// 口径:
// - 频道原生帧 (compat_info.source=channel) 或摘要形状 (^频道：…\n发帖人：) → 不渲染 "> [引用]";
// - 群聊里人真正引用一条气泡 → prompt 照旧带 "> [引用]" (行为不变);
// - 账本人话行只存人自己打的那部分 (dispatch 的 rawText), 引用/摘要不进正文。
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { ConfigSchema } from "../shared/config.js";
import { bindWizardStore, loadWizardStore } from "../daemon/wizard.js";
import { composeInbound, installInboundRouter } from "../daemon/inbound.js";

const DIGEST = readFileSync(join(import.meta.dirname, "fixtures/channel-post-digest.txt"), "utf8");
assert.ok(DIGEST.startsWith("频道：") && DIGEST.length > 1500, "fixture 就是那帧的摘要 (1803 字符)");

const OWN = "给这个room改名为 ‘we channel’";
const frame = (over: Record<string, unknown> = {}) => ({
  msgid: "m-1",
  chattype: "group",
  chatid: "G",
  from: { userid: "tester" },
  msgtype: "text",
  quote: { msgtype: "text", text: { content: DIGEST } },
  ...over,
});
const noCtx = () => false;
const stripAt = (_m: unknown, t: string) => t;
const resolve = (base: string, name: string) => base + "#" + (name || "default");

// ① 频道原生帧 + 摘要 → 不带前缀; spoken = 人的原话。
const chan = composeInbound(
  frame({ compat_info: { source: "channel" } }) as never,
  OWN, noCtx, stripAt as never, resolve,
);
assert.equal(chan.text, OWN, "频道帧: 摘要不贴回 prompt");
assert.equal(chan.spoken, OWN, "频道帧: spoken = 人自己打的字");

// ② 没有 source 标记、但 quote 是摘要形状 (兜底判据) → 同样丢掉。
const shaped = composeInbound(frame() as never, OWN, noCtx, stripAt as never, resolve);
assert.equal(shaped.text, OWN, "摘要形状: 不贴回 prompt");

// ③ 群聊里人真引用了一条气泡 → 照旧带 "> [引用]" (且正文是引用内容 + 人话)。
const botQuote = "🧙‍♂️ fix：重启好了，端口 17890 在听。";
const real = composeInbound(
  frame({ quote: { msgtype: "text", text: { content: botQuote } } }) as never,
  OWN, noCtx, stripAt as never, resolve,
);
assert.ok(real.text.startsWith("> [引用]\n> "), "群聊引用: prompt 照旧带引用前缀");
assert.ok(real.text.includes("17890") && real.text.endsWith(OWN), "群聊引用: 前缀 + 人话");
assert.equal(real.spoken, OWN, "群聊引用: 账本正文仍只是人话");

// ④ 已在 context 里的引用照旧被去重 (老行为不变)。
const deduped = composeInbound(
  frame({ quote: { msgtype: "text", text: { content: botQuote } } }) as never,
  OWN, () => true, stripAt as never, resolve,
);
assert.equal(deduped.text, OWN);

// ── 端到端: 账本行取 rawText (人话), prompt 取 text (带引用) ──────────────
const ROOT = mkdtempSync(join(tmpdir(), "inbound-quote-"));
const log = pino({ level: "silent" });
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
const dispatched: Array<{ text: string; rawText?: string; quoted?: string }> = [];
const bridge = {
  hasMirrorTarget: () => true,
  isOpenBubbleQuote: () => false,
  status: () => ({ mirrors: [] }),
  getCwd: () => ({ runningCwd: "/repo", defaultCwd: "/repo" }),
  newSession: async () => ({ ok: true }),
  dispatch: async (a: { text: string; rawText?: string; quoted?: string }) => { dispatched.push(a); },
  chatRoster: () => [],
  peers: async () => [],
  interruptPane: async () => ({ ok: true }),
  killPane: async () => ({ ok: true }),
  submitPane: async () => ({ ok: true }),
};
const client = { on: (e: string, h: (f: unknown) => Promise<void>) => handlers.set(e, h), replyStream: async () => ({}) };
installInboundRouter(client as never, cfg, log, bridge as never, join(ROOT, "unused.jsonc"), (() => {}) as never);
await handlers.get("message.text")!({
  headers: { req_id: "r1" },
  body: frame({ chatid: "G", quote: { msgtype: "text", text: { content: botQuote } }, text: { content: OWN } }),
});
assert.equal(dispatched.length, 1);
assert.ok(dispatched[0]!.text.includes("> [引用]"), "prompt (text) 带引用");
assert.equal(dispatched[0]!.rawText, OWN, "账本 (rawText) 只有人话");
assert.ok((dispatched[0]!.quoted ?? "").includes("17890"), "引用走 quoted 旁路");

console.log("inbound quote: 频道摘要丢弃 / 群聊引用保留在 prompt / 账本只存人话");
