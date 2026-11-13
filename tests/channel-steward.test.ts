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
  buildJudgePrompt,
  installChannelEvents,
  installChannelTransport,
  registerTopic,
} from "../daemon/channel.js";
import { formatChannelContext } from "../daemon/channel-context.js";
import { installInboundRouter } from "../daemon/inbound.js";
import type { ChannelMsg } from "../daemon/channel-store.js";

const ROOT = mkdtempSync(join(tmpdir(), "channel-steward-"));
const log = pino({ level: "silent" });
const cfgOf = (channelSteward: Record<string, string> = {}, chatSteward: Record<string, string> = {}) =>
  ConfigSchema.parse({
    bot: { botId: "test", secret: "test" },
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

// ── Part B: 判官邻居感知 ───────────────────────────────────────────────
bindWizardStore(store);
const judgeCfg = cfgOf({ topicE: "fix" });
const jp = buildJudgePrompt(judgeCfg, {
  topicId: "topicE", postId: "p1", triggerId: "p1", msgid: "m1",
  recent: [], thread: [], latest: "x", latestAuthor: "user:b",
  bots: [{ id: "bot:aaa", n: 2 }, { id: "bot:bbb12345", n: 1 }],
});
assert.ok(jp.includes("你的职责：修东西的工人"), "职责行取频道管家身份 (锚点) 的描述");
assert.ok(jp.includes("bot:aaa（2 条）"), "others 段带 bot 作者计数");
assert.ok(jp.includes("跨 bot 身份只认 bot:<id>"), "bot 身份映射口径进 prompt");
// 未绑定的存量频道: 职责行回落频道默认会话描述 (行为不变)。
const jpLegacy = buildJudgePrompt(cfgFree, {
  topicId: "topicE", postId: "p1", triggerId: "p1", msgid: "m1",
  recent: [], thread: [], latest: "x", latestAuthor: "user:b",
});
assert.ok(jpLegacy.includes("你的职责：旧频道默认会话"), "未绑定频道职责行 = 默认会话描述");
assert.ok(!jpLegacy.includes("最近活跃的其他机器人"), "没有 bot 作者就不出机器人聚合行");
// 全新频道 (连默认会话都没有): 职责行 = 全局管家描述。
const jpNew = buildJudgePrompt(cfgFree, {
  topicId: "topicNEW", postId: "p1", triggerId: "p1", msgid: "m1",
  recent: [], thread: [], latest: "x", latestAuthor: "user:b",
});
assert.ok(jpNew.includes("你的职责：全局管家"), "新频道职责行 = 全局管家描述");

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
    emit: (ev: string, frame: unknown) => { calls.push({ via: "emit", content: ev + ":" + JSON.stringify((frame as any)?.body?.chatid) }); emitted.push(frame); },
    wsManager: { handleFrame: (_f: unknown) => { /* 原链路不需要 */ } },
  };
  return c;
};
const postOf = () => ({ post_id: "pE", content: "频道里求助: 帮我看个报错", creator: { type: 2, userid: "tester" }, create_time: 1700000000 });
const emitted: unknown[] = [];
const client = mkClient();
// transport 必须早于 events 装 (tracker 抓 orig 的顺序), 与 daemon 一致。
installChannelTransport(client, log);
installChannelEvents(client, cfgOf(), log);

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

// D2 事件 → 伪装群帧 → 频道出站: @ 事件直达 (不走判官), 合成 frame + 假 author。
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
assert.equal(emitted.length, 1, "@ 事件伪装成一条群消息交给 inbound");
const fake = (emitted[0] as { body: any }).body;
assert.equal(fake.chattype, "group");
assert.equal(fake.chatid, "topicE", "chatid = 裸 topic_id → principal = chat:<topic_id> (频道即群)");
assert.equal(fake.from.userid, "tester");
assert.ok(fake.text.content.includes("频道里求助"), "正文带原帖");
// 被回复的帖子 replyOk: 最终帧走 send_reply (跨 bot 出声), 中间帧丢。
calls.length = 0;
await client.replyStream(emitted[0], "msgE", "thinking...", false);
assert.ok(!calls.length, "中间帧不出频道");
await client.replyStream(emitted[0], "msgE", "🧙‍♂️ fix： 已处理", true);
assert.ok(calls.some((c) => c.via === "cmd" && c.cmd === "aibot_topic_send_reply" && c.content?.includes("已处理")), "最终帧 → send_reply, 头是跨 bot 自称名");
// 主动 markdown 到已 replyOk 的频道 → 评论而非新帖。
calls.length = 0;
await client.sendMessage("topicE", { msgtype: "markdown", markdown: { content: "补充" } });
assert.ok(calls.some((c) => c.via === "cmd" && c.cmd === "aibot_topic_send_reply"), "replyOk 的帖子走评论");
// 审批卡 → 改投问话人私聊, 永不进频道。
calls.length = 0;
await client.sendMessage("topicE", { msgtype: "template_card", template_card: {} });
assert.ok(calls.some((c) => c.via === "send" && c.chatid === "tester"), "审批卡改投问话人 DM (lastAsker)");
assert.ok(!calls.some((c) => c.via === "cmd"), "审批卡没有跨 bot 出去");

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
