// rolepage wizard 详情的时间轴: 轮次为主线 (入 / 出 + 过程框), 账本行挂到产出它的那一轮。
//
// 验收: 一轮有工具调用 → 出消息的服务端 HTML 里必须有过程框和工具名 (旧版的完整度);
// 同一轮写进账本的那几行不能另起一条, 要挂在那一轮上; 账本行没有对应轮次时仍独立成行;
// 部署的 room 账本晚于路由挂载时, 路由也得读得到 (daemon 的真实故障: 闭包钉死 undefined)。
// room 模型 (对照 main 补齐): 气泡 = 写进账本的那一行 (全文), CLI 终句只进过程框 (aside);
// 唤醒它的账本行按账本画, 不再画一遍注入原文; 行里的 <system-reminder> 剥成折叠标签。
import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import { URL } from "node:url";
import { createChatRoutes, type SimpleHandler } from "../shared/chat-http.js";
import type { DetailStore, DetailRecord, TurnDetailRecord } from "../shared/detail-store.js";
import type { WorldFacts } from "../shared/world.js";
import { buildRoomFacts } from "../shared/room-view.js";
import { H, W, room, say, uid } from "./room-fixture.js";

const A = W(uid(1)), B = W(uid(2)), H1 = H("U1");
const now = Date.now();
const G = room("chat:wrG", [A, H1, B], now - 5000);
const q1 = say(G, { author: H1, kind: "say", text: "跑个测试\n<system-reminder wezard=\"envelope\" kind=\"human\" from=\"U1\">\n</system-reminder>", origin: "inbound" }, { now: now - 3500 });

const turn: TurnDetailRecord = {
  kind: "turn", id: "t1", createdAt: now - 3000, updatedAt: now - 1000, closed: true,
  target: "chat:wrG#guide", sessionId: "s1", channel: "chat:wrG",
  // room 注入: 头一行【room】(id), 下面一行一条账本行 (reminder 被压进同一行)。
  userQuery: `【群G】(chat:wrG)\n[${q1.id}] 张三: 跑个测试 <system-reminder wezard="envelope" kind="human" from="U1"> </system-reminder>`,
  items: [
    { t: "tool_use", toolUseId: "u1", toolName: "Bash", toolInput: { command: "ls" }, ts: now - 2500 },
    { t: "tool_result", toolUseId: "u1", body: "a\nb", ts: now - 2400 },
    { t: "text", body: "跑完了", ts: now - 1000, final: true },
  ],
} as TurnDetailRecord;
// 同 room 里别人的一句, 不点名、不唤醒 A: 不进 A 的「与它相关」视图。
const other = say(G, { author: B, kind: "say", text: "别人的话", origin: "tool" }, { now: now - 2000 });
assert.ok(!other.wake.includes(A.id), "fixture: 别人的话不唤醒 A");
// 这一轮真写进账本的那一行 (chat_reply) —— 必须挂到 t1 的出消息上, 不另起一条。
const replied = say(G, { author: A, kind: "reply", text: "跑完了", re: [q1.id], origin: "tool" }, { now: now - 1500 });
// 一条对不上轮次的行 (轮次已在 30 分钟之外) —— 独立成行, 不丢。
const far = say(G, { author: A, kind: "say", text: "一小时前说过的一句", origin: "tool" }, { now: now - 3_600_000 });

// 账本时代的一轮, 只有 CLI 终句、没写进账本: 没说出去 —— 终句进过程框, 没有气泡。
const quiet: TurnDetailRecord = {
  kind: "turn", id: "t2", createdAt: now - 900, updatedAt: now - 800, closed: true,
  target: "chat:wrG#guide", sessionId: "s1", channel: "chat:wrG", userQuery: "[wezard] 你这一轮被唤醒处理的 x 还没交代",
  items: [{ t: "text", body: "自言自语", ts: now - 850, final: true }],
} as TurnDetailRecord;
const store = { get: (id: string) => (id === "t1" ? turn : id === "t2" ? quiet : undefined), list: () => [turn, quiet] } as unknown as DetailStore;
const NAMES = { nameOf: () => "alice", roomLabel: () => "群G" };
const facts: WorldFacts = {
  wizards: [{ target: "chat:wrG#guide", name: "alice", uid: A.id, description: "", chat: "群G", cwd: "/w",
    model: "deepseek-v4.1-flash", cli: "codebuddy", busy: false, alive: true, bornAt: now - 9000, lastActivity: now, summary: "" }],
  rooms: buildRoomFacts([G], NAMES), plans: [], schedules: [],
  chatNames: { "chat:wrG": "群G" }, names: { [A.id]: "alice" }, humanNames: { "human:U1": "张三" },
} as WorldFacts;

const get = (handler: SimpleHandler, query: string): Promise<any> => new Promise((resolve) => {
  const res = { setHeader() {}, end: (body: string) => resolve(JSON.parse(body)) } as unknown as ServerResponse;
  handler({ headers: {} } as IncomingMessage, res, new URL("http://x/?" + query));
});

const run = async (): Promise<void> => {
  // 账本晚于路由挂载: ready 先是 false, 之后才 true —— 路由必须现读, 不能把 undefined 钉死。
  let live = false;
  const lazy = { ids: () => (live ? [G.id] : []), get: (id: string) => (live && id === G.id ? G : undefined), ready: () => live };
  const routes = createChatRoutes(store, () => facts, undefined, lazy);
  const early = await get(routes.wizard, "id=t1&role=alice");
  assert.equal(early.ledger, false, "账本还没开: 不装作有");
  live = true;
  const late = await get(routes.wizard, "id=t1&role=alice");
  assert.equal(late.ledger, true, "账本开了之后路由要读得到 (闭包钉死是旧故障)");

  assert.deepEqual(late.stream.map((r: { kind: string }) => r.kind), ["ledger", "ledger", "out", "in", "out"], "独立的账本行 / 唤醒行 / 出 / 入 / 出");
  const woke = late.stream[1], out = late.stream[2];
  assert.equal(woke.row.id, q1.id, "唤醒它的人话按账本画 (注入原文不再画一遍)");
  assert.equal(woke.row.text, "跑个测试", "账本行正文剥掉 reminder");
  assert.match(woke.row.rems, /rem-tag[^>]*>&lt;envelope · U1&gt;/, "reminder 收成按种类命名的折叠标签");
  assert.ok(!late.stream.some((r: { id: string }) => r.id === "t1:in"), "注入那一轮的入消息不重复画");
  assert.match(out.html, /class="turn-group/, "出消息是过程框");
  assert.match(out.html, /工具调用|Bash/, "工具调用必须在出消息里 (旧版的完整度)");
  assert.match(out.html, /data-lazy-turn="t1"/, "工具正文懒加载 (展开时取 /api/tool)");
  assert.ok(!/class="say"/.test(out.html), "与账本行同文的 CLI 终句并掉, 不当气泡");
  assert.ok(out.meta && out.meta.length > 0, "出消息带本轮用量");
  assert.equal(out.era, true, "账本时代的一轮");
  assert.equal(out.said.length, 1, "写进账本的那一行挂在轮上");
  assert.equal(out.said[0].id, replied.id);
  assert.equal(out.said[0].status, "done");
  assert.equal(out.said[0].text, "跑完了", "气泡是账本行全文");
  assert.deepEqual(out.said[0].reTo, [H1], "没写 to 的 reply: 说给它答的那一行的作者");
  const quietOut = late.stream[4];
  assert.equal(quietOut.id, "t2:out");
  assert.match(quietOut.html, /note aside/, "没写进账本的 CLI 终句只进过程框");
  assert.ok(!/class="say"/.test(quietOut.html) && !quietOut.said, "没说出去就没有气泡");
  assert.equal(late.stream[3].text, "[wezard] 你这一轮被唤醒处理的 x 还没交代", "不是 room 注入的入消息照常画");
  assert.equal(late.stream[0].kind, "ledger", "没有对应轮次的行仍独立成行");
  assert.equal(late.stream[0].row.id, far.id);

  // W-2「全部消息」已在 762482b 退役: all=1 不再被认, 页面只给「与它相关」那一份, 时间轴只折叠它自己的轮次。
  const w2 = await get(routes.wizard, "id=t1&role=alice&all=1");
  assert.equal(w2.stream.length, late.stream.length, "all=1 被忽略, 与默认视图同一份");
  assert.ok(!JSON.stringify(late.stream).includes("别人的话"), "别人不点名的话不进它的视图");
  assert.equal(w2.stream.filter((r: { kind: string }) => r.kind === "out").length, 2, "别人的话不成轮次卡片 (只有它自己的 t1 / t2)");

  console.log("wizard-stream: 入/出 + 过程框 + 账本行挂轮 + 账本晚挂载可读");
};

await run();
