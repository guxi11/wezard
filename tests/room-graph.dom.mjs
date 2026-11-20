// rolepage 的 DOM 验收: 节点数 = room 数 + 参与者数。
//
// 起一个本地 http 服务 (fixture 的 /api/* + 真实的 web/chat.js), 用 playwright 打开 /role,
// 数 SVG 里的 .rv-room / .rv-person。不碰线上 daemon / svr, 不改仓库依赖:
// playwright 不在 node_modules 里就跳过 (跑法: NODE_PATH=<任意装了 playwright 的 node_modules> node tests/room-graph.dom.mjs)。
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
/** playwright 不是本仓库的依赖 (rolepage 的运行环境用不到它): 本机装了就直接用, 否则跳过。
 *  装了但在别处时给 WZ_PLAYWRIGHT_DIR=<那份 node_modules>。 */
const loadChromium = async () => {
  try { return (await import("playwright")).chromium; } catch { /* 本地没装 */ }
  const dir = process.env.WZ_PLAYWRIGHT_DIR;
  if (!dir) return undefined;
  try { return createRequire(join(dir, "noop.cjs"))("playwright").chromium; } catch { return undefined; }
};
const chromium = await loadChromium();
if (!chromium) {
  console.log("room-graph.dom: 跳过 (playwright 不在 node_modules; 需要时 WZ_PLAYWRIGHT_DIR 指向一份装了它的 node_modules)");
  process.exit(0);
}

const SHELL = readFileSync(join(root, "tests", "fixture-room-graph.html"), "utf8");
const APP = readFileSync(join(root, "web", "chat.js"), "utf8");

// ── fixture 负载 (与 tests/room-view-api.test.ts 同形) ─────────────────
const A = "w" + "1".padStart(12, "0"), B = "w" + "2".padStart(12, "0");
const G = "chat:wrG", DM = "dm:" + [A, B].sort().join("|");
const who = (kind, id) => ({ kind, id });
const roomFact = (id, kind, members, host) => ({ id, kind, title: "", bound: id === G, host, members, openDuties: 0, last: { seq: 1, at: T0 + 5000 } });
// 时间用「刚才」—— rolepage 默认只画近 3 天的 room / 24h 内动过的人。
const T0 = Date.now() - 60_000;
const msgs = [
  { id: "aa000001.1", seq: 1, at: T0 + 1000, room: G, author: who("human", "U1"), authorName: "张三", ord: 3, speak: "human", kind: "say", text: "谁来搭把手", origin: "inbound" },
  { id: "aa000001.2", seq: 2, at: T0 + 2000, room: G, author: who("wizard", A), authorName: "alice", ord: 1, speak: "member", kind: "reply", text: "我来", to: undefined, re: ["aa000001.1"], status: "done", origin: "tool", turn: "t1" },
  { id: "aa000001.3", seq: 3, at: T0 + 3000, room: G, author: who("wizard", A), authorName: "alice", ord: 1, speak: "member", kind: "ask", text: "查一下配置", to: [who("wizard", B)], origin: "tool", turn: "t1" },
  { id: "aa000001.4", seq: 4, at: T0 + 4000, room: G, author: who("wizard", B), authorName: "bob", ord: 2, speak: "member", kind: "reply", text: "查完了", re: ["aa000001.3"], status: "done", origin: "tool", turn: "t2" },
  { id: "bb000002.1", seq: 1, at: T0 + 5000, room: DM, author: who("wizard", B), authorName: "bob", ord: 2, speak: "member", kind: "say", text: "私聊一句", origin: "tool", turn: "t2" },
];
const ROOMS = [
  roomFact(G, "wecom-group", [
    { who: who("wizard", A), name: "alice", via: "founder", since: 1, ord: 1, host: true },
    { who: who("wizard", B), name: "bob", via: "invite", since: 2, ord: 2, host: false },
    { who: who("human", "U1"), name: "张三", via: "inbound", since: 3, ord: 3, host: false },
  ], who("wizard", A)),
  roomFact(DM, "dm", [
    { who: who("wizard", A), name: "alice", via: "founder", since: 4, ord: 1, host: true },
    { who: who("wizard", B), name: "bob", via: "invite", since: 5, ord: 2, host: false },
  ], who("wizard", A)),
];
const memberViews = ROOMS[0].members.map((m) => ({ id: m.who.id, kind: m.who.kind, name: m.name, label: m.name, via: m.via, ord: m.ord, since: m.since, host: m.host }));
const WORLD = {
  ok: true, at: Date.now(), base: G, self: "chat:wrG#guide",
  rooms: ROOMS,
  uidTargets: { [A]: "chat:wrG#guide", [B]: "chat:wrG#worker" },
  nodes: [
    { target: "chat:wrG#guide", kind: "wizard", uid: A, name: "alice", label: "alice", base: G, tag: "guide", chat: "群G", busy: false, alive: true, lastTs: T0 + 4000, rels: [] },
    { target: "chat:wrG#worker", kind: "wizard", uid: B, name: "bob", label: "bob", base: G, tag: "worker", chat: "群G", busy: false, alive: true, lastTs: T0 + 5000, rels: [] },
    { target: "human:U1", kind: "human", name: "张三", label: "👤", base: "", tag: "", chat: "", busy: false, alive: false, lastTs: T0 + 1000, rels: [] },
  ],
  edges: [],
  plans: [], schedules: [],
  chatNames: { [G]: "群G" }, names: { [A]: "alice", [B]: "bob", U1: "张三" }, humanNames: { "human:U1": "张三" },
  degraded: false,
};
const ROOM = { ok: true, at: Date.now(), room: ROOMS[0], label: "群G", members: memberViews, duties: [], msgs: msgs.filter((m) => m.room === G), total: 4 };
const wizardOf = (role) => {
  const isBob = /worker|bob/.test(role);
  const id = isBob ? "chat:wrG#worker" : "chat:wrG#guide";
  const name = isBob ? "bob" : "alice";
  return { ok: true, at: Date.now(), role: { id, kind: "wizard", name, label: name, description: "", cwd: "", model: "m", bornAt: 1, chat: "群G", clones: [], spawns: [], forkedFrom: "", alive: true, busy: false, runningUntil: 0 },
    uid: isBob ? B : A, ledger: true, sessions: [], session: "all", all: false, msgs: msgs.map((m) => ({ ...m, roomLabel: m.room === G ? "群G" : DM })), total: 5, rooms: ROOMS, plans: [], schedules: [], stats: undefined };
};

const server = createServer((req, res) => {
  const u = new URL(req.url || "/", "http://x");
  const send = (type, body) => { res.statusCode = 200; res.setHeader("content-type", type); res.end(body); };
  if (u.pathname === "/role") return send("text/html; charset=utf-8", SHELL);
  if (u.pathname === "/chat/app.js") return send("text/javascript", APP);
  if (u.pathname === "/api/world") return send("application/json", JSON.stringify(WORLD));
  if (u.pathname === "/api/room") return send("application/json", JSON.stringify(ROOM));
  if (u.pathname === "/api/wizard") return send("application/json", JSON.stringify(wizardOf(u.searchParams.get("role") || "")));
  if (u.pathname === "/api/turn") return send("application/json", JSON.stringify({ ok: true, html: '<section class="turn-group" data-key="t:t1">box</section>' }));
  if (u.pathname === "/api/tool") return send("application/json", JSON.stringify({ ok: true, html: "tool" }));
  res.statusCode = 404; res.end("no");
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = "http://127.0.0.1:" + server.address().port;

// 本机的 Chrome 就够 (不为了这一条验收去下载 playwright 配对的 Chromium)。
const browser = await chromium.launch({ channel: "chrome" }).catch(() => chromium.launch());
try {
  const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e)));
  await page.goto(base + "/role?id=t-ticket", { waitUntil: "load" });
  await page.waitForSelector(".rv-person", { timeout: 5000 });
  const counts = await page.evaluate(() => ({
    rooms: document.querySelectorAll(".rv-room").length,
    people: document.querySelectorAll(".rv-person").length,
    msgs: document.querySelectorAll(".rv-msg").length,
    title: (document.querySelector(".rv-ttl") || {}).textContent || "",
  }));
  assert.equal(errs.length, 0, "页面没有脚本错误: " + errs.join(" / "));
  assert.equal(counts.rooms, ROOMS.length, "room 节点数 = room 数");
  assert.equal(counts.people, 3, "参与者节点数 = alice / bob / 张三");
  assert.equal(counts.rooms + counts.people, ROOMS.length + 3, "节点数 = room 数 + 参与者数");
  assert.equal(counts.msgs, 4, "room 历史 4 条");
  assert.match(counts.title, /群G/);

  // 点一条消息的「过程」→ 服务端渲染的过程框进来
  await page.click(".rv-open");
  await page.waitForSelector(".rv-box .turn-group", { timeout: 5000 });

  // 点 wizard 节点 → W-1
  await page.click('.rv-person[data-node="chat:wrG#worker"]');
  await page.waitForFunction(() => (document.querySelector(".rv-ttl") || {}).textContent?.includes("bob"), null, { timeout: 5000 });
  console.log("room-graph.dom: " + JSON.stringify(counts) + " —— 节点数 = room + 参与者, 过程框与 wizard 视图可点开");
} finally {
  await browser.close();
  server.close();
}