// rolepage 的 room 数据面: /api/world (二部图的节点数) · /api/room (历史) · /api/wizard (与它相关的消息) · /api/turn。
//
// 验收口径与前端一致: 图上的节点数 = room 数 + 参与者数; 每个 room 成员都能对到一个节点
// (uidTargets); room 历史的每一条都带 author / status / re。
import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import { URL } from "node:url";
import { createChatRoutes, chatRouteTable, type SimpleHandler } from "../shared/chat-http.js";
import type { DetailStore, DetailRecord, TurnDetailRecord } from "../shared/detail-store.js";
import type { WorldFacts } from "../shared/world.js";
import { buildRoomFacts } from "../shared/room-view.js";
import type { RenderNames } from "../shared/room.js";
import { H, W, room, say, uid } from "./room-fixture.js";

const A = W(uid(1)), B = W(uid(2)), H1 = H("U1");
const G = room("chat:wrG", [A, B, H1]);
const q1 = say(G, { author: H1, kind: "say", text: "谁来搭把手", origin: "inbound" });
say(G, { author: A, kind: "reply", text: "我来", re: [q1.id], origin: "tool" });
const q2 = say(G, { author: A, kind: "ask", to: [B], text: "查一下配置", origin: "tool" });
say(G, { author: B, kind: "reply", text: "查完了", re: [q2.id], origin: "tool" });
const DM = room("dm:" + [A.id, B.id].sort().join("|"), [A, B]);
say(DM, { author: B, kind: "say", text: "私聊一句", origin: "tool" });

const now = Date.now();
const ticket: DetailRecord = { kind: "turn", id: "t-ticket", createdAt: now - 1000, updatedAt: now, closed: true,
  target: "chat:wrG#guide", sessionId: "s1", userQuery: "hi", items: [{ t: "text", body: "hello", ts: now, final: true }] } as TurnDetailRecord;
const store = { get: (id: string) => (id === "t-ticket" ? ticket : undefined), list: () => [ticket] } as unknown as DetailStore;

const wizard = (target: string, name: string, u: string) => ({
  target, name, uid: u, description: "描述", chat: "群G", cwd: "/w", model: "deepseek-v4.1-flash", cli: "codebuddy",
  busy: false, alive: true, bornAt: now - 5000, lastActivity: now - 100, summary: "",
});
const NAMES: RenderNames = {
  nameOf: (w) => w.kind === "human" ? "张三" : w.id === A.id ? "alice" : w.id === B.id ? "bob" : w.id,
  roomLabel: (r) => (r === "chat:wrG" ? "群G" : r),
};
const facts: WorldFacts = {
  wizards: [wizard("chat:wrG#guide", "alice", A.id), wizard("chat:wrG#worker", "bob", B.id)],
  rooms: buildRoomFacts([G, DM], NAMES),
  plans: [], schedules: [],
  chatNames: { "chat:wrG": "群G" },
  names: { [A.id]: "alice", [B.id]: "bob", U1: "张三" },
  humanNames: { "human:U1": "张三" },
};
const rooms = { ids: () => [G.id, DM.id], get: (id: string) => (id === G.id ? G : id === DM.id ? DM : undefined) };

const routes = createChatRoutes(store, () => facts, undefined, rooms);
const get = (handler: SimpleHandler, query: string): Promise<any> => new Promise((resolve, reject) => {
  const res = {
    setHeader() {},
    end: (body: string) => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } },
  } as unknown as ServerResponse;
  handler({ headers: {} } as IncomingMessage, res, new URL("http://x/?" + query));
});

const run = async (): Promise<void> => {
  // ── /api/world: 二部图 ─────────────────────────────────────────────
  const world = await get(routes.world, "id=t-ticket&role=alice");
  assert.equal(world.ok, true);
  assert.equal(world.rooms.length, 2, "两个 room 节点");
  const memberIds = new Set<string>();
  for (const r of world.rooms) for (const m of r.members) memberIds.add(m.who.kind === "wizard" ? world.uidTargets[m.who.id] : "human:" + m.who.id);
  const nodeIds = new Set(world.nodes.map((n: { target: string }) => n.target));
  for (const id of memberIds) assert.ok(nodeIds.has(id!), "每个 room 成员都有节点: " + id);
  // 图上的节点数 = room 数 + 参与者数 (前端按这两份数数)
  assert.equal(world.rooms.length + memberIds.size, 2 + new Set([...memberIds]).size);
  assert.equal(memberIds.size, 3, "alice / bob / 张三");
  assert.equal(world.chatNames["chat:wrG"], "群G", "room 显示名随快照带");
  assert.deepEqual(world.uidTargets[A.id], "chat:wrG#guide");

  // ── /api/room: 历史 ────────────────────────────────────────────────
  const one = await get(routes.room, "id=t-ticket&room=chat:wrG");
  assert.equal(one.ok, true);
  assert.equal(one.label, "群G");
  assert.equal(one.msgs.length, 4);
  assert.deepEqual(one.msgs.map((m: { text: string }) => m.text), ["谁来搭把手", "我来", "查一下配置", "查完了"]);
  assert.equal(one.msgs[1].status, "done");
  assert.deepEqual(one.msgs[1].re, [q1.id]);
  assert.equal(one.room.openDuties, 0);
  assert.deepEqual(one.msgs[0].wakeTo, [{ kind: "wizard", id: A.id }], "人的直接发言 (无 to / re): 收件人 = 行上 wake 记的 host");
  assert.equal(one.msgs[1].wakeTo, undefined, "wizard 的行不带 wakeTo");
  assert.deepEqual(one.members.map((m: { name: string }) => m.name), ["alice", "bob", "张三"]);
  assert.equal(one.earlier, undefined);
  const page = await get(routes.room, "id=t-ticket&room=chat:wrG&limit=2");
  assert.equal(page.msgs.length, 2);
  assert.ok(page.earlier, "更早的还有, 给游标");

  // 没有 room 账本读者的部署 (独立 svr) 明确 503, 不装作空
  const svr = createChatRoutes(store, () => facts);
  await new Promise<void>((resolve) => {
    const res = { setHeader() {}, end: () => resolve() } as unknown as ServerResponse;
    svr.room({ headers: {} } as IncomingMessage, res, new URL("http://x/?id=t-ticket&room=chat:wrG"));
  });

  // ── /api/wizard: 与它相关的消息 ────────────────────────────────────────
  const w1 = await get(routes.wizard, "id=t-ticket&role=alice");
  assert.equal(w1.ok, true);
  assert.equal(w1.role.name, "alice");
  assert.equal(w1.uid, A.id);
  assert.equal(w1.ledger, true);
  assert.ok(!("all" in w1), "「全部消息」已删: 回包不再有 all");
  assert.equal(w1.msgs.length, 3, "说的 + 指向它的");
  assert.ok(w1.msgs.every((m: { roomLabel: string }) => !!m.roomLabel));
  const w2 = await get(routes.wizard, "id=t-ticket&role=alice&all=1");
  assert.equal(w2.msgs.length, 3, "all=1 已不再认: 仍只回与它相关的");
  assert.ok(Array.isArray(w1.sessions), "session 分段仍给 (改名 /clear 之后按它切)");
  assert.equal(w1.landingRoom, "chat:wrG", "票据落点 room: turn 的 channel (chat:wrG#guide → chat:wrG)");

  // ── /api/wizard?card=1: 只回名片 (room 视角下左上角仍是 role) ───────
  const card = await get(routes.wizard, "id=t-ticket&role=alice&card=1");
  assert.equal(card.ok, true);
  assert.equal(card.role.name, "alice", "card=1 仍带 role 名片");
  assert.equal(card.uid, A.id);
  for (const k of ["ledger", "sessions", "session", "stats", "charter", "plans", "schedules", "landingRoom"]) assert.ok(k in card || k === "charter", "card=1 带 " + k);
  assert.equal(card.landingRoom, "chat:wrG");
  for (const k of ["msgs", "stream", "total", "rooms"]) assert.ok(!(k in card), "card=1 不带 " + k + " (省时)");
  // 没有 role 参数 = 票据落点那位 (旧链接 / 只有票据)
  const cardLanding = await get(routes.wizard, "id=t-ticket&card=1");
  assert.equal(cardLanding.role.id, "chat:wrG#guide", "role 空 → 票据落点 role");

  // ── /api/turn: 过程框 ──────────────────────────────────────────────
  const box = await get(routes.turn, "id=t-ticket&turn=t-ticket");
  assert.equal(box.ok, true);
  assert.match(box.html, /class="turn-group/);
  assert.match(box.html, /hello/);

  // ── /api/search: room 名 / 成员 / 消息 ───────────────────────────────
  const s1 = await get(routes.search, "id=t-ticket&q=" + encodeURIComponent("配置"));
  assert.equal(s1.ok, true);
  assert.deepEqual(s1.msgs.map((m: { text?: string; snippet: string }) => m.snippet), ["查一下配置"]);
  assert.equal(s1.msgs[0].room, "chat:wrG");
  assert.equal(s1.msgs[0].roomName, "群G");
  assert.equal(s1.msgs[0].authorName, "alice");
  assert.deepEqual(s1.msgs[0].toNames, ["bob"]);
  assert.equal(s1.msgs[0].group, true, "有人发过话的群 = 群聊");
  const s2 = await get(routes.search, "id=t-ticket&q=" + encodeURIComponent("群"));
  assert.deepEqual(s2.rooms.map((r: { name: string }) => r.name), ["群G"], "room 名按显示名搜 (title > 聊天名)");
  const s3 = await get(routes.search, "id=t-ticket&q=AL");
  assert.deepEqual(s3.members.map((m: { name: string; rooms: number }) => [m.name, m.rooms]), [["alice", 2]], "成员按名字搜, 不分大小写");
  const s4 = await get(routes.search, "id=t-ticket&q=" + encodeURIComponent("私聊"));
  assert.equal(s4.msgs.length, 1);
  assert.equal(s4.msgs[0].group, false, "wizard 之间的 dm = 会话");
  assert.equal(s4.msgs[0].roomName, "alice、bob", "没起名的 dm 用成员名, 不是一排「私聊」");
  const s5 = await get(routes.search, "id=t-ticket&q=" + encodeURIComponent("查 完"));
  assert.deepEqual(s5.msgs.map((m: { snippet: string }) => m.snippet), ["查完了"], "空格分词, 各词都要命中");
  const s0 = await get(routes.search, "id=t-ticket&q=");
  assert.deepEqual([s0.rooms.length, s0.members.length, s0.msgs.length], [0, 0, 0]);

  // ── 路由表: 旧接口不再存在 ──────────────────────────────────────────
  const table = chatRouteTable(routes);
  assert.ok(table["GET /api/room"] && table["GET /api/wizard"]);
  assert.equal(table["GET /api/msgs"], undefined, "旧会话列表接口已删");
  assert.equal(table["GET /api/role"], undefined);
  assert.equal(table["GET /api/role-events"], undefined);
  assert.equal(table["POST /api/seen"], undefined);

  console.log("room-view-api: /api/world 节点数 = room + 参与者; /api/room 历史按账本; W-1/W-2; 旧接口已删");
};

await run();
