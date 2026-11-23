// 频道级管家 (人 2026-11-17 拍板: 「整个 channel 需要一个管家, 绑定时候也绑定的是 channel 的统一
// 管家, 每个 topic 都复用此管家配置」)。频道里的帖子 (原生帧 base chat:opk…) 经 channel-posts 配上
// 频道键后: 绑定落频道表、同频道其余帖子不再引导且收掉在途引导、帖子级旧绑定收口成频道一条。
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { ConfigSchema } from "../shared/config.js";
import { bindWizardStore, loadWizardStore } from "../daemon/wizard.js";
import { appointedChannelSteward, stewardIdentityOf, stewardRoute } from "../daemon/steward.js";
import { bindSteward, GUIDE_DESC, needsOnboarding, settleChannelSteward } from "../daemon/onboarding.js";
import { channelOf, channelOfPost, learnChannelPost, postsOfChannel } from "../daemon/channel-posts.js";
import { installInboundRouter } from "../daemon/inbound.js";

const ROOT = mkdtempSync(join(tmpdir(), "channel-scope-"));
const cfgOf = (dir: string, chatPolicy: Record<string, { steward: string }> = {}) => ConfigSchema.parse({
  bot: { botId: "test", secret: "test" },
  daemon: { stateDir: join(ROOT, dir) },
  wrc: { allowFrom: ["user:tester"], channel: { history: { enabled: false } } },
  defaultChat: "user:home",
  ...(Object.keys(chatPolicy).length ? { chatPolicy } : {}),
});
const srcOf = (name: string) => { const p = join(ROOT, name + ".jsonc"); writeFileSync(p, "{\n  \"bot\": { \"botId\": \"b\" }\n}\n"); return p; };

// ── ① 配对映射 ───────────────────────────────────────────────────────
const cfg = cfgOf("s1");
assert.equal(learnChannelPost(cfg, "chat:opkA", "T", "pA"), true, "新配对落盘");
assert.equal(learnChannelPost(cfg, "chat:opkA", "T", "pA"), false, "同一对不重写");
learnChannelPost(cfg, "chat:opkB", "T", "pB");
assert.equal(channelOfPost(cfg, "chat:opkA"), "T");
assert.deepEqual(postsOfChannel(cfg, "T").sort(), ["chat:opkA", "chat:opkB"]);
assert.equal(channelOf(cfg, "chat:T"), "T", "桥接帧 base chat:<topic_id> 本身就是频道");
assert.equal(channelOf(cfg, "chat:wrGROUP"), "", "普通群不是频道");
assert.deepEqual(JSON.parse(readFileSync(join(ROOT, "s1", "channel-posts.json"), "utf8")), { "chat:opkA": { channel: "T", post: "pA" }, "chat:opkB": { channel: "T", post: "pB" } }, "映射持久化 (新格式 {channel, post}; reload 后照认)");

// ── ② 帖子里绑定 = 频道绑定, 其余帖子复用 ────────────────────────────
const store = loadWizardStore(join(ROOT, "w1.json"));
store.upsert("chat:opkA", { identity: "chat:opkA", name: "Grace", kind: "steward", workspace: "/ws/org", bornAt: 1 });
assert.equal(needsOnboarding(cfg, loadWizardStore(join(ROOT, "w0.json")), "chat:opkB"), true, "频道未绑: 新帖子要引导");
const src = srcOf("c1");
bindSteward(cfg, src, "chat:opkA", "Grace");
assert.equal(cfg.wrc.channel.steward.T, "Grace", "帖子里的绑定落频道表");
assert.equal(cfg.chatPolicy?.["chat:opkA"]?.steward, undefined, "不再写帖子级 chatPolicy");
assert.match(readFileSync(src, "utf8"), /"steward":\s*\{\s*"T":\s*"Grace"/, "config 文件里是 wrc.channel.steward.T");
assert.equal(needsOnboarding(cfg, loadWizardStore(join(ROOT, "w0.json")), "chat:opkB"), false, "同频道其余帖子不再引导");
assert.equal(appointedChannelSteward(cfg, "chat:opkB"), "Grace");
assert.equal(appointedChannelSteward(cfg, "chat:T"), "Grace", "桥接帧 (判官路径) 也落同一个管家");
assert.equal(stewardIdentityOf(cfg, store, "chat:opkB"), "chat:opkA", "帖子 B 的管家身份 = 频道管家");
const rB = stewardRoute(cfg, store, "chat:opkB");
assert.equal(rB.target, "chat:opkB#Grace", "B 里开同一身份的化身, 出站仍回 B 自己");
assert.equal(rB.fresh?.workspace, "/ws/org", "化身工作区 = 管家身份的工作区");
assert.equal(needsOnboarding(cfg, loadWizardStore(join(ROOT, "w0.json")), "chat:opkZ"), true, "配不上频道的帖子按普通群判 (判据边界)");

// ── ③ 老数据收口: 帖子级绑定升格为频道级, 同频道只剩一个 ──────────────
const cfg2 = cfgOf("s2", { "chat:opkC": { steward: "Old1" }, "chat:opkD": { steward: "Old2" }, "chat:wrX": { steward: "Keep" } });
learnChannelPost(cfg2, "chat:opkC", "T2", "pC");
learnChannelPost(cfg2, "chat:opkD", "T2", "pD");
const store2 = loadWizardStore(join(ROOT, "w2.json"));
store2.upsert("chat:opkC", { identity: "chat:opkC", name: "Old1", kind: "steward", bornAt: 5 });
store2.upsert("chat:opkD", { identity: "chat:opkD", name: "Old2", kind: "steward", bornAt: 3 });
const src2 = srcOf("c2");
const s2 = settleChannelSteward(cfg2, store2, src2, "chat:opkC");
assert.deepEqual(s2 && { ...s2, cleared: s2.cleared.sort() }, { topicId: "T2", name: "Old2", cleared: ["chat:opkC", "chat:opkD"] }, "没绑频道: 最早出生的帖子级管家升格");
assert.equal(cfg2.wrc.channel.steward.T2, "Old2");
assert.equal(cfg2.chatPolicy?.["chat:opkC"]?.steward, undefined, "帖子级绑定清掉");
assert.equal(cfg2.chatPolicy?.["chat:opkD"]?.steward, undefined);
assert.equal(cfg2.chatPolicy?.["chat:wrX"]?.steward, "Keep", "别的群不动");
assert.equal(settleChannelSteward(cfg2, store2, src2, "chat:opkD"), undefined, "收口幂等");
// 频道已绑 + 帖子级残留 → 频道的赢, 残留清掉。
cfg2.chatPolicy = { ...(cfg2.chatPolicy ?? {}), "chat:opkC": { ...(cfg2.chatPolicy?.["chat:opkC"] ?? {}), steward: "Stray" } as never };
assert.equal(settleChannelSteward(cfg2, store2, src2, "chat:opkC")?.name, "Old2", "频道已绑: 帖子级残留不翻案");
assert.equal(cfg2.chatPolicy?.["chat:opkC"]?.steward, undefined);

// ── ④ 端到端: 帖子 A 引导落定 → 帖子 B 在途引导收掉; B 的裸消息落频道管家 ──
const dir3 = "s3";
const cfg3 = cfgOf(dir3);
mkdirSync(join(ROOT, dir3), { recursive: true });
writeFileSync(join(ROOT, dir3, "onboarding.json"), JSON.stringify({ "chat:opkF": { step: "workspace" } }));
learnChannelPost(cfg3, "chat:opkE", "T3", "pE");
learnChannelPost(cfg3, "chat:opkF", "T3", "pF");
const store3 = bindWizardStore(loadWizardStore(join(ROOT, "w3.json")));
store3.upsert("user:home", { identity: "user:home", name: "gsw", kind: "global-steward", bornAt: 1 });
store3.upsert("chat:opkF#guide", { identity: "chat:opkF#guide", name: "guide-2", kind: "worker", description: GUIDE_DESC, bornAt: 2 });
const handlers = new Map<string, (f: unknown) => Promise<void>>();
const killed: string[] = [];
const dispatched: string[] = [];
const attached = new Set<string>();
const bridge = {
  hasMirrorTarget: (t: string) => attached.has(t),
  status: () => ({ mirrors: [] }),
  getCwd: () => ({ runningCwd: "", pendingCwd: "", defaultCwd: "" }),
  sessionInfo: () => undefined,
  newSession: async (target: string, _n: string, opts: { cwd?: string }) => { attached.add(target); return { ok: true, sessionId: "s", cwd: opts.cwd ?? "" }; },
  dispatch: async (a: { principal: string }) => { dispatched.push(a.principal); },
  chatRoster: () => [],
  peers: async () => [],
  killPane: async (t: string) => { killed.push(t); return { ok: true }; },
  interruptPane: async () => ({ ok: true }),
  submitPane: async () => ({ ok: true }),
  retitlePane: async () => undefined,
};
const replies: string[] = [];
const client = { on: (e: string, h: (f: unknown) => Promise<void>) => handlers.set(e, h), replyStream: async (_f: unknown, _id: string, text: string) => { replies.push(text); return {}; } };
const guard = (<T>(write: () => T) => ({ r: write(), note: Promise.resolve("") })) as never;
installInboundRouter(client as never, cfg3, pino({ level: "silent" }), bridge as never, srcOf("c3"), guard);
const native = (chat: string, id: string, text: string) => ({
  headers: { req_id: id },
  body: { msgid: id, chattype: "group", chatid: chat, from: { userid: "tester" }, msgtype: "text", text: { content: text }, compat_info: { source: "channel" } },
});
const wsDir = mkdtempSync(join(tmpdir(), "channel-scope-ws-"));
await handlers.get("message.text")!(native("opkE", "e1", wsDir));
const name = cfg3.wrc.channel.steward.T3 ?? "";
assert.ok(name, "帖子 E 给目录 → 频道 T3 绑定落定");
assert.ok(replies.some((r) => r.includes("引导完成")), "完成确认照发");
assert.ok(killed.includes("chat:opkF#guide"), "同频道帖子 F 的在途引导化身被收掉");
assert.equal(store3.get("chat:opkF#guide"), undefined, "引导记录一并 drop");
assert.equal(JSON.parse(readFileSync(join(ROOT, dir3, "onboarding.json"), "utf8"))["chat:opkF"], undefined, "F 的在途引导状态清掉 (出站豁免随之关)");
await handlers.get("message.text")!(native("opkF", "f1", "hi"));
assert.deepEqual(dispatched, ["chat:opkF#" + name], "F 的裸消息落频道管家在 F 的化身, 不再起引导");
assert.equal(store3.get("chat:opkF#" + name)?.identity, "chat:opkE", "化身归频道管家身份");

console.log("channel-steward-scope ok");
