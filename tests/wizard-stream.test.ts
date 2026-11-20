// rolepage wizard 详情的时间轴: 轮次为主线 (入 / 出 + 过程框), 账本行挂到产出它的那一轮。
//
// 验收: 一轮有工具调用 → 出消息的服务端 HTML 里必须有过程框和工具名 (旧版的完整度);
// 同一轮写进账本的那几行不能另起一条, 要挂在那一轮上; 账本行没有对应轮次时仍独立成行;
// 部署的 room 账本晚于路由挂载时, 路由也得读得到 (daemon 的真实故障: 闭包钉死 undefined)。
import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import { URL } from "node:url";
import { createChatRoutes, type SimpleHandler } from "../shared/chat-http.js";
import type { DetailStore, DetailRecord, TurnDetailRecord } from "../shared/detail-store.js";
import type { WorldFacts } from "../shared/world.js";
import { buildRoomFacts } from "../shared/room-view.js";
import { H, W, room, say, uid } from "./room-fixture.js";

const A = W(uid(1)), H1 = H("U1");
const now = Date.now();
const G = room("chat:wrG", [A, H1], now - 5000);
const q1 = say(G, { author: H1, kind: "say", text: "跑个测试", origin: "inbound" }, { now: now - 3500 });

const turn: TurnDetailRecord = {
  kind: "turn", id: "t1", createdAt: now - 3000, updatedAt: now - 1000, closed: true,
  target: "chat:wrG#guide", sessionId: "s1", userQuery: "跑个测试", channel: "chat:wrG",
  items: [
    { t: "tool_use", toolUseId: "u1", toolName: "Bash", toolInput: { command: "ls" }, ts: now - 2500 },
    { t: "tool_result", toolUseId: "u1", body: "a\nb", ts: now - 2400 },
    { t: "text", body: "跑完了", ts: now - 1000, final: true },
  ],
} as TurnDetailRecord;
// 这一轮真写进账本的那一行 (chat_reply) —— 必须挂到 t1 的出消息上, 不另起一条。
const replied = say(G, { author: A, kind: "reply", text: "跑完了", re: [q1.id], origin: "tool" }, { now: now - 1500 });
// 一条对不上轮次的行 (轮次已在 30 分钟之外) —— 独立成行, 不丢。
const far = say(G, { author: A, kind: "say", text: "一小时前说过的一句", origin: "tool" }, { now: now - 3_600_000 });

const store = { get: (id: string) => (id === "t1" ? turn : undefined), list: () => [turn] } as unknown as DetailStore;
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

  assert.deepEqual(late.stream.map((r: { kind: string }) => r.kind), ["ledger", "in", "out"], "独立的账本行 / 入 / 出");
  const inRow = late.stream[1], out = late.stream[2];
  assert.equal(inRow.text, "跑个测试", "入消息是那一轮的问话");
  assert.match(out.html, /class="turn-group/, "出消息是过程框");
  assert.match(out.html, /工具调用|Bash/, "工具调用必须在出消息里 (旧版的完整度)");
  assert.ok(out.meta && out.meta.length > 0, "出消息带本轮用量");
  assert.equal(out.said.length, 1, "写进账本的那一行挂在轮上");
  assert.equal(out.said[0].id, replied.id);
  assert.equal(out.said[0].status, "done");
  assert.equal(late.stream[0].kind, "ledger", "没有对应轮次的行仍独立成行");
  assert.equal(late.stream[0].row.id, far.id);

  // W-2 (它所在 room 的全部消息) 不会把别人的轮次也画成它的: 时间轴仍只折叠它自己的轮次。
  const w2 = await get(routes.wizard, "id=t1&role=alice&all=1");
  assert.ok(w2.stream.length > late.stream.length, "W-2 多出 room 里的其他行");
  assert.equal(w2.stream.filter((r: { kind: string }) => r.kind === "out").length, 1, "别人的话不成轮次卡片");

  console.log("wizard-stream: 入/出 + 过程框 + 账本行挂轮 + 账本晚挂载可读");
};

await run();
