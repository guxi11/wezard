// v3 P5 (§6 channel 组团化): 频道 = 组团里的一个群。
// Part A: 频道管家表 (wrc.channel.steward) 绑定解析 —— 与 chatPolicy.<chat>.steward 是两张
//         互不覆盖的表, 频道先查自己的; 绑定 → 频道化身 (无则 fresh 描述子); 存量频道零变化;
//         手闸 (isStewardTarget) 跟随频道绑定。
// Part B: 判官邻居感知 —— 职责行取频道管家身份的描述; others 段带 bot: 作者聚合。
// Part C: 主 wizard 注入上下文带「本频道最近活跃的机器人」行 (botAuthors 自身剔除)。
// Part D: 跨 bot 出声面 (安全边界): 只有 send_post / send_reply 会跨 bot 出去;
//         审批卡 (template_card) 与非 markdown 一律不进频道; 非频道 chatid 原样放行。
// Part E: 频道事件 → 伪装群帧 → inbound 接待: 频道消息落 channel 管家化身 (端到端)。
// 全程合成事件 + 假 author, 不打真实跨 bot 网络。
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { ConfigSchema } from "../shared/config.js";
import { bindWizardStore, loadWizardStore } from "../daemon/wizard.js";
import {
  appointedChannelSteward,
  isStewardTarget,
  stewardIdentityOf,
  stewardRoute,
} from "../daemon/steward.js";
import {
  botAuthors,
  installChannelEvents,
  installChannelTransport,
  registerTopic,
  type ChannelHuman,
} from "../daemon/channel.js";
import { formatChannelContext } from "../daemon/channel-context.js";
import { installInboundRouter } from "../daemon/inbound.js";
import type { ChannelMsg } from "../daemon/channel-store.js";

const ROOT = mkdtempSync(join(tmpdir(), "channel-steward-"));
const log = pino({ level: "silent" });
// P7-S3: onTopic 会把 chat:<topic> 登记进 known-chats 册 —— stateDir 必须隔离, 别写真机 state。
const cfgOf = (channelSteward: Record<string, string> = {}, chatSteward: Record<string, string> = {}) =>
  ConfigSchema.parse({
    bot: { botId: "test", secret: "test" },
    daemon: { stateDir: join(ROOT, "state") },
    wrc: { allowFrom: ["user:tester"], channel: { history: { enabled: false }, steward: channelSteward } },
    defaultChat: "user:home",
    ...(Object.keys(chatSteward).length
      ? { chatPolicy: Object.fromEntries(Object.entries(chatSteward).map(([k, v]) => [k, { steward: v }])) }
      : {}),
  });

// ── Part A: 绑定解析 (纯函数) ──────────────────────────────────────────
const store = loadWizardStore(join(ROOT, "wizards.json"));
store.upsert("user:home", { identity: "user:home", name: "gsw", description: "全局管家", kind: "global-steward", bornAt: 1 });
store.upsert("chat:A#fix", { identity: "chat:A#fix", name: "fix", description: "修东西的工人", bornAt: 2 });
store.upsert("chat:topicE", { identity: "chat:topicE", name: "topic-helper", description: "旧频道默认会话", bornAt: 3 });

const cfgChannel = cfgOf({ topicE: "fix" });
assert.equal(appointedChannelSteward(cfgChannel, "chat:topicE"), "fix", "频道表按裸 topic_id 命中");
assert.equal(appointedChannelSteward(cfgChannel, "chat:other"), "", "没绑的频道为空");
assert.equal(appointedChannelSteward(cfgChannel, "user:home"), "", "非 chat: 形状不查频道表");
assert.equal(stewardIdentityOf(cfgChannel, store, "chat:topicE"), "chat:A#fix", "频道绑定 → 绑定身份");

// 两张表互不覆盖: 同一 base 两边都写, 频道表赢 (频道绑定不落 chatPolicy)。
const cfgBoth = cfgOf({ topicE: "fix" }, { "chat:topicE": "gsw" });
assert.equal(appointedChannelSteward(cfgBoth, "chat:topicE"), "fix");
assert.equal(stewardIdentityOf(cfgBoth, store, "chat:topicE"), "chat:A#fix", "频道表优先于 chatPolicy");
// chatPolicy 自己的命名空间不受频道表影响 (群聊绑定照旧)。
const cfgChatOnly = cfgOf({}, { "chat:A": "fix" });
assert.equal(stewardIdentityOf(cfgChatOnly, store, "chat:A"), "chat:A#fix", "群聊绑定不受影响");

// stewardRoute: 绑定频道无化身 → fresh 描述子 (工作区取身份锚点 cwd); 有化身 → 它。
const toChannel = stewardRoute(cfgChannel, store, "chat:topicE", (t) => (t === "chat:A#fix" ? "/repo/fix" : ""));
assert.equal(toChannel.target, "chat:topicE#fix");
assert.deepEqual(toChannel.fresh, { identity: "chat:A#fix", name: "fix", kind: "worker", workspace: "/repo/fix" }, "频道 fresh 描述子带身份工作区");
store.upsert("chat:topicE#fix", { identity: "chat:A#fix", name: "fix", bornAt: 4 });
assert.deepEqual(stewardRoute(cfgChannel, store, "chat:topicE"), { target: "chat:topicE#fix" }, "已有化身 → 稳定落它");

// 存量频道零变化: 未绑定的频道, untagged 默认会话照旧。
const cfgFree = cfgOf();
assert.deepEqual(stewardRoute(cfgFree, store, "chat:topicE"), { target: "chat:topicE" }, "存量频道裸消息仍落 untagged base");
// 新频道 (无绑定无默认会话) → 全局管家接待 (§6: 频道也是组团里的一个群)。
const freshChannel = stewardRoute(cfgFree, store, "chat:topicNEW", (t) => (t === "user:home" ? "/home/ws" : ""));
assert.equal(freshChannel.target, "chat:topicNEW#gsw");
assert.deepEqual(freshChannel.fresh, { identity: "user:home", name: "gsw", kind: "global-steward", workspace: "/home/ws" });

// 手闸跟随频道绑定: 指定化身 arm (虽是 tagged), 旧默认会话不再 arm。
assert.equal(isStewardTarget(cfgChannel, store, "chat:topicE#fix"), true, "绑定的频道化身 arm");
assert.equal(isStewardTarget(cfgChannel, store, "chat:topicE"), false, "换绑后旧频道默认会话不 arm");

// Part B (判官 prompt) 已随一次性判官一起删除 —— 频道里的判断改由 room 的 monitor 做
// (shared/room.ts 的 activate 行, 见 tests/room-monitor.test.ts)。

// ── Part C: 注入上下文的机器人活跃行 + botAuthors 聚合 ─────────────────
const msg = (id: string, author: string, text = "t"): ChannelMsg => ({ id, kind: "post", postId: id, at: 0, author, text });
const bots = botAuthors(
  [msg("1", "user:a"), msg("2", "bot:aaa"), msg("3", "bot:aaa"), msg("4", "bot:bbb12345"), msg("5", "bot:selfbot000")],
  "selfbot0001",
);
assert.deepEqual(bots, [{ id: "bot:aaa", n: 2 }, { id: "bot:bbb12345", n: 1 }], "按条数降序, 自己与 user 作者剔除");
const ctx = formatChannelContext({ topicId: "t", postId: "p", recent: [msg("1", "user:a")], bots, budget: 6000 });
assert.ok(ctx.includes("本频道最近活跃的机器人: bot:aaa (2)、bot:bbb12345 (1)"), "上下文带机器人活跃行");
const ctxNoBots = formatChannelContext({ topicId: "t", postId: "p", recent: [msg("1", "user:a")], budget: 6000 });
assert.ok(!ctxNoBots.includes("最近活跃的机器人"), "没有 bot 不出行");

// ── Part D: 跨 bot 出声面 (安全边界, 合成 client) ──────────────────────
const calls: Array<{ via: string; cmd?: string; chatid?: string; content?: string }> = [];
const mkClient = () => {
  const c: any = {
    sendMessage: async (chatid: string, body: any) => { calls.push({ via: "send", chatid, content: body?.msgtype }); return {}; },
    replyStream: async (_f: unknown, id: string, content: string) => { calls.push({ via: "stream", chatid: id, content }); return {}; },
    reply: async (_h: unknown, body: unknown, cmd: string) => {
      calls.push({ via: "cmd", cmd, content: JSON.stringify(body) });
      return { body: cmd === "aibot_topic_get_post_list" ? { post_list: [postOf()] } : cmd === "aibot_topic_send_post" ? { post_id: "pnew" } : {} };
    },
    wsManager: { handleFrame: (_f: unknown) => { /* 原链路不需要 */ } },
  };
  return c;
};
const postOf = () => ({ post_id: "pE", content: "频道里求助: 帮我看个报错", creator: { type: 2, userid: "tester" }, create_time: 1700000000 });
const client = mkClient();
const ingested: ChannelHuman[] = [];
// transport 必须早于 events 装 (tracker 抓 orig 的顺序), 与 daemon 一致。
installChannelTransport(client, log);
installChannelEvents(client, cfgOf(), log, { nativeWaitMs: 0, ingest: (e) => ingested.push(e) }); // 无原生帧: 测桥兜底投递

// D1 纯传输面: 只有 markdown 正文会跨 bot 出去。
registerTopic("topicD");
await client.sendMessage("topicD", { msgtype: "markdown", markdown: { content: "主动帖" } });
assert.ok(calls.some((c) => c.via === "cmd" && c.cmd === "aibot_topic_send_post" && c.content?.includes("主动帖")), "markdown → send_post");
calls.length = 0;
await client.sendMessage("topicD", { msgtype: "template_card", template_card: {} });
assert.ok(!calls.some((c) => c.via === "cmd"), "审批卡不进频道 (无 asker 时整卡丢弃)");
assert.ok(!calls.some((c) => c.via === "send" && c.chatid === "topicD"), "审批卡也不走群通道");
calls.length = 0;
await client.sendMessage("topicD", { msgtype: "image", image: {} });
assert.ok(!calls.length, "非 markdown 出站丢弃");
await client.sendMessage("chat:normal", { msgtype: "markdown", markdown: { content: "x" } });
assert.ok(calls.some((c) => c.via === "send" && c.chatid === "chat:normal"), "非频道 chatid 原样放行 (不进频道分支)");

// D2 事件 → 人话落 room (ingest): 没有原生帧的 @ 事件兜底落帖子自己的 topic room 并标 mention:"bot"。
// (2026-11-27: 频道没有 room; 旧断言「没配对: 频道 room + post」改为 topic:<T>/<P>, 行不带 post。)
calls.length = 0;
const evFrame = {
  cmd: "aibot_topic_event_callback",
  body: {
    topic_id: "topicE", msgid: "msgE", from: { userid: "tester" }, aibotid: "selfbot0001", create_time: 1700000000,
    event: { eventtype: "topic_at_bot", topic_at_bot: { post_id: "pE", reply_id: "" } },
  },
};
(client as any).wsManager.handleFrame(evFrame);
await new Promise((r) => setTimeout(r, 50));
assert.equal(ingested.length, 1, "@ 事件落一行成年人话 (不再伪造群帧)");
assert.equal(ingested[0]!.room, "topic:topicE/pE", "没配对也是帖子自己的 topic room");
assert.equal((ingested[0] as { post?: string }).post, undefined, "topic room 的行不带 post");
assert.equal(ingested[0]!.mention, "bot", "@ 了机器人 = 点名 host");
assert.ok(ingested[0]!.text.includes("频道里求助"), "正文带原帖");
// 审批卡 → 改投问话人私聊 (lastAsker 由事件记下), 永不进频道。
calls.length = 0;
await client.sendMessage("topicE", { msgtype: "template_card", template_card: {} });
assert.ok(calls.some((c) => c.via === "send" && c.chatid === "tester"), "审批卡改投问话人 DM (lastAsker)");
assert.ok(!calls.some((c) => c.via === "cmd"), "审批卡没有跨 bot 出去");
// topic room 当 chatid (审批 / 通知按 target 的 base 推过来): 卡改投问话人 DM, 正文评论回根帖 (send_reply), 绝不当群 chatid 发。
calls.length = 0;
await client.sendMessage("topic:topicE/pE", { msgtype: "template_card", template_card: {} });
assert.ok(calls.some((c) => c.via === "send" && c.chatid === "tester"), "topic room 的审批卡也改投问话人 DM");
assert.ok(!calls.some((c) => c.via === "send" && c.chatid === "topic:topicE/pE"), "topic room id 不会当群 chatid 发出去");
calls.length = 0;
await client.sendMessage("topic:topicE/pE", { msgtype: "markdown", markdown: { content: "批准结果" } });
const rep1 = calls.find((c) => c.via === "cmd" && c.cmd === "aibot_topic_send_reply");
assert.ok(rep1 && rep1.content?.includes("\"post_id\":\"pE\"") && rep1.content.includes("批准结果"), "topic room 的通知 → 评论根帖 (send_reply, post_id 取自 id)");
assert.ok(!calls.some((c) => c.cmd === "aibot_topic_send_post"), "不发新帖");

// ── Part E: 频道消息落 channel 管家化身 (inbound 端到端, 绑定解析) ─────
const ROOT2 = mkdtempSync(join(tmpdir(), "channel-route-"));
const store2 = bindWizardStore(loadWizardStore(join(ROOT2, "wizards.json")));
store2.upsert("user:home", { identity: "user:home", name: "gsw", description: "全局管家", kind: "global-steward", bornAt: 1 });
store2.upsert("chat:A#fix", { identity: "chat:A#fix", name: "fix", description: "修东西的工人", bornAt: 2 });
const cfgE = cfgOf({ topicF: "fix" });
const handlers = new Map<string, (f: unknown) => Promise<void>>();
const spawned: Array<{ target: string; opts: Record<string, unknown> }> = [];
const dispatchedE: Array<{ principal: string }> = [];
let attachedE = new Set<string>();
const bridge = {
  hasMirrorTarget: (t: string) => attachedE.has(t),
  status: () => ({ mirrors: [] }),
  getCwd: (t: string) => ({ runningCwd: t === "chat:A#fix" ? "/repo/fix" : "", pendingCwd: "", defaultCwd: "" }),
  newSession: async (target: string, _name: string, opts: Record<string, unknown>) => {
    spawned.push({ target, opts });
    attachedE.add(target);
    return { ok: true, sessionId: "s1", cwd: (opts as { cwd?: string }).cwd ?? "" };
  },
  dispatch: async (a: { principal: string }) => { dispatchedE.push({ principal: a.principal }); },
  chatRoster: () => [],
  peers: async () => [],
  interruptPane: async () => ({ ok: true }),
  killPane: async () => ({ ok: true }),
  submitPane: async () => ({ ok: true }),
};
const clientE = { on: (e: string, h: (f: unknown) => Promise<void>) => handlers.set(e, h), replyStream: async () => ({}) };
installInboundRouter(clientE as never, cfgE, log, bridge as never, join(ROOT2, "unused.jsonc"), (() => {}) as never);
// 伪装帧与 channel.ts dispatch() 产出的形状一致: group + 裸 topic_id。
const channelFrame = (text: string) => ({
  headers: { req_id: text },
  body: { msgid: text, chattype: "group", chatid: "topicF", from: { userid: "tester" }, msgtype: "text", text: { content: text }, create_time: 1700000000000 },
});
await handlers.get("message.text")!(channelFrame("[频道上下文] topic=topicF post=p1 msgid=m1\n——\n频道里求助: 帮我看个报错"));
assert.equal(spawned.length, 1, "频道首访触发一次化身 spawn");
assert.equal(spawned[0]!.target, "chat:topicF#fix", "落 channel 管家 (绑定身份) 的频道化身");
assert.equal(spawned[0]!.opts.cwd, "/repo/fix", "化身起在身份工作区, 不落兜底目录");
assert.equal(dispatchedE[0]!.principal, "chat:topicF#fix", "消息投给频道管家化身");
assert.equal(store2.get("chat:topicF")?.identity, undefined, "不再 auto-spawn untagged 频道默认会话");
const recF = store2.get("chat:topicF#fix");
assert.equal(recF?.identity, "chat:A#fix", "化身记录归到绑定身份");
// 第二条: 化身已附着, 不再 spawn。
await handlers.get("message.text")!(channelFrame("继续"));
assert.equal(spawned.length, 1, "已附着不重复 spawn");
assert.equal(dispatchedE.length, 2);
assert.equal(dispatchedE[1]!.principal, "chat:topicF#fix");

console.log("channel-steward ok");
