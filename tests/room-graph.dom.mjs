// rolepage 的 DOM 验收: 节点数 = room 数 + 参与者数。
//
// 起一个本地 http 服务 (fixture 的 /api/* + 真实的 web/chat.js), 用 playwright 打开 /role,
// 数 SVG 里的 .rv-room / .rv-person。不碰线上 daemon / svr, 不改仓库依赖:
// playwright 不在 node_modules 里就跳过 (跑法: NODE_PATH=<任意装了 playwright 的 node_modules> node tests/room-graph.dom.mjs)。
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
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
const roomFact = (id, kind, members, host, at = T0 + 5000) => ({ id, kind, title: "", bound: id === G, host, members, openDuties: 0, last: { seq: 1, at } });
// 时间用「刚才」—— rolepage 默认时间范围 2d, 下面另一间 3 天前的 room 只在「全部」下出现。
const T0 = Date.now() - 60_000;
const msgs = [
  { id: "aa000001.1", seq: 1, at: T0 + 1000, room: G, author: who("human", "U1"), authorName: "张三", ord: 3, speak: "human", kind: "say", text: "谁来搭把手", origin: "inbound", wakeTo: [who("wizard", A)] },
  { id: "aa000001.2", seq: 2, at: T0 + 2000, room: G, author: who("wizard", A), authorName: "alice", ord: 1, speak: "member", kind: "reply", text: "我来", to: undefined, re: ["aa000001.1"], status: "done", origin: "tool", turn: "t1" },
  { id: "aa000001.3", seq: 3, at: T0 + 3000, room: G, author: who("wizard", A), authorName: "alice", ord: 1, speak: "member", kind: "ask", text: "查一下配置", to: [who("wizard", B)], origin: "tool", turn: "t1" },
  { id: "aa000001.4", seq: 4, at: T0 + 4000, room: G, author: who("wizard", B), authorName: "bob", ord: 2, speak: "member", kind: "reply", text: "查完了", re: ["aa000001.3"], status: "done", origin: "tool", turn: "t2" },
  { id: "bb000002.1", seq: 1, at: T0 + 5000, room: DM, author: who("wizard", B), authorName: "bob", ord: 2, speak: "member", kind: "say", text: "私聊一句", origin: "tool", turn: "t2" },
];
const HM = "user:U1";
const OLD = "chat:wrOld";   // 3 天前有动静: 默认 2d 不画, 选「全部」才出来
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
  roomFact(OLD, "wecom-group", [
    { who: who("human", "U2"), name: "李四", via: "inbound", since: 6, ord: 1, host: false },
  ], undefined, T0 - 3 * 86400000),
];
const LAST_AT = { [A]: T0 + 3000, [B]: T0 + 4000, U1: T0 + 1000 };   // 每成员最近发言 (服务端 lastSaidAt)
const memberViews = ROOMS[0].members.map((m) => ({ id: m.who.id, kind: m.who.kind, name: m.name, label: m.name, via: m.via, ord: m.ord, since: m.since, host: m.host, lastAt: LAST_AT[m.who.id] }));
// 待交代: alice 问 bob 的一条 (服务端 dutyFacts: holderName / summary 为只读展示字段)
const DUTIES = [{ key: "aa000001.3@wizard:" + B, msg: "aa000001.3", seq: 3, kind: "ask", at: T0 + 3000, asker: who("wizard", A), askerName: "alice", holder: who("wizard", B), holderName: "bob", slot: "wizard:" + B, summary: "查一下配置", last: { status: "progress", seq: 4 } }];
const WORLD = {
  ok: true, at: Date.now(), base: G, self: "chat:wrG#guide",
  rooms: ROOMS,   // 用例想加 room / 节点: 给 globalThis.__extraRooms / __extraNodes (见 /api/world), 不动这份基线
  uidTargets: { [A]: "chat:wrG#guide", [B]: "chat:wrG#worker" },
  nodes: [
    { target: "chat:wrG#guide", kind: "wizard", uid: A, name: "alice", label: "alice", base: G, tag: "guide", chat: "群G", busy: false, alive: true, lastTs: T0 + 4000, rels: [] },
    { target: "chat:wrG#worker", kind: "wizard", uid: B, name: "bob", label: "bob", base: G, tag: "worker", chat: "群G", busy: false, alive: true, cacheCold: true, lastTs: T0 + 5000, rels: [] },
    { target: "human:U1", kind: "human", name: "张三", label: "👤", base: "", tag: "", chat: "", busy: false, alive: false, lastTs: T0 + 1000, rels: [] },
  ],
  plans: [], schedules: [],
  chatNames: { [G]: "群G", [OLD]: "老群" }, names: { [A]: "alice", [B]: "bob", U1: "张三", U2: "李四" }, humanNames: { "human:U1": "张三", "human:U2": "李四" },
  degraded: false,
};
// 服务端 wireMsg 给的 reQuote (见 tests/re-quote.test.ts): .4 答 .3 (第一条) + .1 + 一条查不到的。
const reQuoteOf = (m) => m.id === "aa000001.4" ? [
  { id: "aa000001.3", author: who("wizard", A), authorName: "alice", snippet: "查一下配置", at: T0 + 3000, room: G },
  { id: "aa000001.1", author: who("human", "U1"), authorName: "张三", snippet: "谁来搭把手", at: T0 + 1000, room: G },
  { id: "zz000000.404", missing: true },
] : undefined;
const ROOM = { ok: true, at: Date.now(), room: ROOMS[0], label: "群G", members: memberViews, duties: DUTIES, createdAt: T0, msgs: msgs.filter((m) => m.room === G).map((m) => (reQuoteOf(m) ? { ...m, reQuote: reQuoteOf(m) } : m)), total: 4 };
// 搜索的服务端口径在 room-view-api.test.ts 验; 这里只验前端: 面板画得出三组、点一条消息能落到那一行。
const SEARCH = (q) => ({
  ok: true, q,
  rooms: q.includes("群") ? [{ id: G, kind: "wecom-group", name: "群G", group: true, preview: "bob: 查完了", lastAt: T0 + 4000, members: 3 }] : [],
  members: [],
  msgs: q.includes("配置") ? [{ id: "aa000001.3", room: G, roomName: "群G", roomKind: "wecom-group", group: true, author: who("wizard", A), authorName: "alice", toNames: ["bob"], at: T0 + 3000, snippet: "查一下配置", hits: 1 }] : [],
  msgTotal: q.includes("配置") ? 1 : 0,
});
const wizardOf = (role, card) => {
  // 人的名片 (role-view.ts: human:<userid> 解析到它自己, kind human): 没有 uid / session / 宪章。
  if (/^human:/.test(role)) {
    const nm = role === "human:U2" ? "李四" : "张三";
    return { ok: true, at: Date.now(), role: { id: role, kind: "human", name: nm, label: "👤", description: "", clones: [], spawns: [], alive: false, busy: false },
      uid: "", ledger: true, sessions: [], session: "all", plans: [], schedules: [], charter: null, ...(card ? {} : { all: false, msgs: [], total: 0, rooms: ROOMS }) };
  }
  const isBob = /worker|bob/.test(role);
  const id = isBob ? "chat:wrG#worker" : "chat:wrG#guide";
  const name = isBob ? "bob" : "alice";
  const full = { ok: true, at: Date.now(), role: { id, kind: "wizard", name, label: name, description: name + " 的职责", cwd: "/w/" + name, model: "m", bornAt: 1, chat: "群G", clones: [], spawns: [], forkedFrom: "", alive: true, busy: false, runningUntil: 0 },
    uid: isBob ? B : A, ledger: true, sessions: [{ sessionId: "s1", start: T0, end: 0, turns: 2, lastTs: T0 + 4000 }], session: "all", all: false, msgs: msgs.map((m) => ({ ...m, roomLabel: m.room === G ? "群G" : DM })), total: 5, rooms: ROOMS, plans: [], schedules: [], stats: undefined,
    charter: { tokens: 1234, at: T0 },
    ...(globalThis.__landing ? { landingRoom: globalThis.__landing } : {}) };
  if (!card) return full;
  // card=1: 只回名片 (与 shared/chat-http.ts 一致: 不带 msgs / total / rooms / stream)。
  const { msgs: _m, total: _t, rooms: _r, all: _a, ...rest } = full;
  return rest;
};

const server = createServer((req, res) => {
  const u = new URL(req.url || "/", "http://x");
  const send0 = (type, body) => { res.statusCode = 200; res.setHeader("content-type", type); res.end(body); };
  // 慢回包 (globalThis.__delay ms): 模拟远端 svr, 请求在路上的那段时间里用户还在滚。
  const send = u.pathname === "/api/room" && globalThis.__delay ? (type, body) => { globalThis.__reqs = (globalThis.__reqs || 0) + 1; setTimeout(() => send0(type, body), globalThis.__delay); } : send0;
  if (u.pathname === "/role") return send("text/html; charset=utf-8", SHELL);
  if (u.pathname === "/chat/app.js") return send("text/javascript", APP);
  if (u.pathname === "/api/world") {
    // 名册缺席 (svr 刚重启): 回包 degraded, 名字全是 id。
    if (globalThis.__degrade) return send("application/json", JSON.stringify({ ...WORLD, degraded: true, names: {}, chatNames: {}, nodes: WORLD.nodes.map((n) => ({ ...n, name: n.target })) }));
    return send("application/json", JSON.stringify({ ...WORLD, rooms: [...WORLD.rooms, ...(globalThis.__extraRooms || [])], nodes: [...WORLD.nodes, ...(globalThis.__extraNodes || [])] }));
  }
  if (u.pathname === "/api/room") {
    // 滚动测试: 一百多条消息, 每次回包最后一条的正文都变 (模拟进行中的一轮 / 新消息), 逼 detail 每 4s 真重渲染一次。
    if (globalThis.__bulk) {
      const base = msgs.filter((m) => m.room === G)[0];
      const many = Array.from({ length: 120 }, (_, i) => ({ ...base, id: "bb" + String(i).padStart(6, "0") + ".1", seq: 100 + i, text: "第 " + i + " 条消息 ".repeat(8) + (i === 119 ? " v" + (globalThis.__bulk++) : "") }));
      return send("application/json", JSON.stringify({ ...ROOM, at: Date.now(), msgs: many, total: 120 }));
    }
    // 用例想让某些成员「窗口外才发过言」: globalThis.__staleMembers = [成员 id …] (lastAt 改成 3 天前)
    if (globalThis.__staleMembers) return send("application/json", JSON.stringify({ ...ROOM, members: ROOM.members.map((m) => globalThis.__staleMembers.includes(m.id) ? { ...m, lastAt: T0 - 3 * 86400000 } : m) }));
    return send("application/json", JSON.stringify(ROOM));
  }
  if (u.pathname === "/api/wizard" && u.searchParams.get("card") === "1" && globalThis.__cardDelay) { globalThis.__cardReqs = (globalThis.__cardReqs || 0) + 1; return setTimeout(() => send0("application/json", JSON.stringify(wizardOf(u.searchParams.get("role") || "", true))), globalThis.__cardDelay); }
  if (u.pathname === "/api/wizard") return send("application/json", JSON.stringify(wizardOf(u.searchParams.get("role") || "", u.searchParams.get("card") === "1")));
  if (u.pathname === "/api/turn") return send("application/json", JSON.stringify({ ok: true, html: '<section class="turn-group" data-key="t:t1">box</section>' }));
  if (u.pathname === "/api/tool") return send("application/json", JSON.stringify({ ok: true, html: "tool" }));
  if (u.pathname === "/api/search") return send("application/json", JSON.stringify(SEARCH(u.searchParams.get("q") || "")));
  res.statusCode = 404; res.end("no");
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = "http://127.0.0.1:" + server.address().port;

// 本机的 Chrome 就够 (不为了这一条验收去下载 playwright 配对的 Chromium)。
// 无桌面机器缺的系统库: scripts/shot-setup.sh 解在 ~/.cache/wezard-shot-libs, 存在就挂进 LD_LIBRARY_PATH (与 shot.mjs 同口径)。
const shotLibs = join(process.env.HOME ?? "", ".cache", "wezard-shot-libs", "root", "usr", "lib", "x86_64-linux-gnu");
const launchOpts = existsSync(shotLibs)
  ? { env: { ...process.env, LD_LIBRARY_PATH: [shotLibs, process.env.LD_LIBRARY_PATH].filter(Boolean).join(":") }, args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"] }
  : {};
const browser = await chromium.launch({ channel: "chrome", ...launchOpts }).catch(() => chromium.launch(launchOpts));
try {
  const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e) + (process.env.WZ_STACK ? "\n" + e.stack : "")));
  // 只有票据 (消息尾部 ✦ 链接) 时开这一轮的主人, 不是一张随机 room。
  await page.goto(base + "/role?id=t-ticket", { waitUntil: "load" });
  // 左栏默认是列表: 「群聊」(有人参与) /「会话」(只有 wizard) 两组, 名片下有搜索入口。
  await page.waitForSelector(".rv-list .ci", { timeout: 5000 });
  const list = await page.evaluate(() => ({
    heads: [...document.querySelectorAll(".rv-list h2")].map((h) => [...h.querySelectorAll(":scope > span:not(.sp)")].map((x) => x.textContent).join("")),
    items: [...document.querySelectorAll(".rv-list .ci")].map((b) => b.getAttribute("data-room")),
    names: [...document.querySelectorAll(".rv-list .ci .t")].map((t) => t.textContent.trim()),
    sbox: !!document.querySelector("#sbox"),
    tabs: [...document.querySelectorAll("[data-side]")].map((b) => b.getAttribute("data-side") + ":" + b.textContent),
    toolsInFirstHead: !!document.querySelector(".rv-list h2:first-child [data-side]"),
    mosaic: document.querySelectorAll(".rv-list .ci .av.mosaic").length,
    chipBound: /已绑定企微/.test((document.querySelector("#rb-who") || {}).textContent || ""),
    // 时间范围: 标题行右端一个下拉, 七档 (1h/2h/6h/12h/1d/2d/全部), 默认 2d。
    win: (() => {
      const sp = document.querySelector(".rv-list h2 .sp[data-dd=win]");
      return sp ? { label: sp.querySelector(".sp-btn").textContent.trim(), items: [...sp.querySelectorAll(".sp-it")].map((b) => b.textContent.trim()) } : null;
    })(),
  }));
  assert.deepEqual(list.heads, ["群聊1", "会话1"], "列表分两组: " + JSON.stringify(list));
  assert.deepEqual(list.items, [G, DM], "群在群聊, dm 在会话");
  assert.equal(list.names[0], "群G", "显示名 = 聊天名");
  assert.equal(list.sbox, true, "名片下有搜索入口");
  assert.deepEqual(list.tabs, ["graph:图"], "列表下只有一个「图」开关 (照 main 的 .vt)");
  assert.equal(list.toolsInFirstHead, true, "开关挂在第一个分组标题右端");
  assert.equal(list.mosaic, 2, "群头像 = 成员头像拼块");
  assert.equal(list.chipBound, false, "名片上不再有「已绑定企微」chip");
  assert.deepEqual(list.win && list.win.items, ["1h", "2h", "6h", "12h", "1d", "2d", "全部"], "时间范围七档: " + JSON.stringify(list.win));
  assert.equal(list.win && list.win.label, "2d", "默认 2d");

  // 换成「全部」: 老 room 出来, 选择记进 localStorage; 再换回 2d 继续后面的验收。
  await page.click(".rv-list h2 .sp[data-dd=win] .sp-btn");
  await page.click('.rv-list .sp[data-dd=win] .sp-it[data-v="0"]');
  await page.waitForFunction(() => document.querySelectorAll(".rv-list .ci").length === 3, null, { timeout: 5000 });
  const all = await page.evaluate(() => ({
    items: [...document.querySelectorAll(".rv-list .ci")].map((b) => b.getAttribute("data-room")),
    label: document.querySelector(".rv-list .sp[data-dd=win] .sp-btn").textContent.trim(),
    saved: localStorage.getItem("wezard.role.winMin"),
  }));
  assert.deepEqual(all.items, [G, OLD, DM], "「全部」= 整本账 (群聊组 G/OLD, 会话组 DM): " + JSON.stringify(all));
  assert.equal(all.label, "全部");
  assert.equal(all.saved, "0", "时间范围记在 localStorage");
  await page.click(".rv-list h2 .sp[data-dd=win] .sp-btn");
  await page.click('.rv-list .sp[data-dd=win] .sp-it[data-v="2880"]');
  await page.waitForFunction(() => document.querySelectorAll(".rv-list .ci").length === 2, null, { timeout: 5000 });
  // 切到图: 视图记在 localStorage, 之后的页面都是图。
  await page.click('[data-side="graph"]');
  await page.waitForSelector(".rv-person", { timeout: 5000 });
  await page.waitForFunction(() => (document.querySelector("#rb-who .nm") || {}).textContent?.trim() === "alice", null, { timeout: 5000 });
  // room 视图另开: 用 ?room= 明说。
  await page.goto(base + "/role?id=t-ticket&room=" + encodeURIComponent(G), { waitUntil: "load" });
  await page.waitForSelector(".rv-msg", { timeout: 5000 });
  const counts = await page.evaluate(() => ({
    rooms: document.querySelectorAll(".rv-room").length,
    directLinks: [...document.querySelectorAll('line.rv-hit[data-edge^="d|"]')].map((l) => l.getAttribute("data-link")),
    people: document.querySelectorAll(".rv-person").length,
    msgs: document.querySelectorAll(".rv-msg").length,
    title: (document.querySelector(".rv-ttl") || {}).textContent || "",
    // 成员列在整页最右 (chat detail 右边), chat detail 里不再有成员条。
    gside: !(document.querySelector("#gside") || {}).hidden,
    members: document.querySelectorAll("#gside .gs-mem").length,
    gsideRight: (() => {
      const g = document.querySelector("#gside"), m = document.querySelector(".main");
      return !!g && !!m && g.getBoundingClientRect().left >= m.getBoundingClientRect().right - 1 && g === g.parentElement.lastElementChild;
    })(),
    // host 标记在名字右边
    hostStar: (() => {
      const b = document.querySelector("#gside .gs-mem.host"), nm = b && b.querySelector(".nm"), st = b && b.querySelector(".gs-host");
      return !!nm && !!st && !nm.textContent.includes("⭐") && st.getBoundingClientRect().left >= nm.getBoundingClientRect().right - 1;
    })(),
    membar: !!document.querySelector("#membar"),
    headActs: (document.querySelector("#ch-acts") || {}).textContent || "",
  }));
  assert.equal(errs.length, 0, "页面没有脚本错误: " + errs.join(" / "));
  // 默认 2d: 3 天前的老 room 不在范围里 (ROOMS 有 3 间, 画 2 间)。
  // 两人 room (DM) 不画节点: alice—bob 之间直接一条可点的线, 点它 = 打开那个 room。
  // room 图标三种: 多人群聊 👥 / 人与 wizard 的单聊 💬 / 只有 wizard 的 room 🧙‍♂️ (图节点 + 图例); 类型文字只在 tooltip。
  const icons = await page.evaluate(() => ({
    nodes: [...document.querySelectorAll(".rv-room text")].map((t) => t.textContent.trim().split(" ")[0]),
    tip: ((document.querySelector(".rv-room title") || {}).textContent || ""),
    legend: [...document.querySelectorAll(".rv-legend .lgemo")].map((e) => e.textContent),
  }));
  assert.deepEqual(icons.nodes, ["👥"], "群 G (多人群聊) 的节点图标 = 👥: " + JSON.stringify(icons));
  assert.match(icons.tip, /群聊 · 企微群/, "类型文字留在 tooltip: " + icons.tip);
  assert.deepEqual(icons.legend.filter((e) => e !== "👤"), ["👥", "💬", "🧙‍♂️"], "图例三种 room 图标: " + JSON.stringify(icons.legend));
  assert.equal(counts.rooms, 1, "room 节点数 = 2d 内有动静的 ≥3 人 room 数 (两人 room 改成连线)");
  assert.deepEqual(counts.directLinks, [DM], "两人 room 画成成员之间的线");
  assert.equal(counts.people, 3, "参与者节点数 = alice / bob / 张三");
  assert.equal(counts.msgs, 4, "room 历史 4 条");
  assert.match(counts.title, /群G/);
  assert.equal(counts.gside, true, "点开 room: 成员列出现");
  assert.equal(counts.gsideRight, true, "成员列在整页最右, chat detail 右边");
  assert.equal(counts.hostStar, true, "host 标记在名字右边");
  assert.equal(counts.members, 3, "成员列 = alice / bob / 张三");
  assert.equal(counts.membar, false, "chat detail 上不再挂成员条");
  assert.ok(counts.headActs.indexOf("刷新") < 0, "右上角不再有刷新: " + counts.headActs);

  // 选中的 room 滑出时间窗 (OLD 3 天前, 默认 2d 本不画): 图与列表同一口径, 选中的那个总在 —— 图里不能只剩 detail 开着而节点没了。
  await page.goto(base + "/role?id=t-ticket&room=" + encodeURIComponent(OLD), { waitUntil: "load" });
  await page.waitForSelector(".rv-msg, .rv-none", { timeout: 5000 });
  await page.waitForSelector('.rv-room[data-room="' + OLD + '"]', { timeout: 5000 });
  const oldG = await page.evaluate((id) => ({ node: document.querySelectorAll('.rv-room[data-room="' + id + '"]').length, rooms: document.querySelectorAll(".rv-room").length, on: !!document.querySelector('.rv-room.on[data-room="' + id + '"]') }), OLD);
  assert.deepEqual(oldG, { node: 1, rooms: 2, on: true }, "图: 选中的老 room 照画 (其余老 room 仍不画): " + JSON.stringify(oldG));
  await page.click('[data-side="list"]');
  await page.waitForSelector(".rv-list .ci", { timeout: 5000 });
  const oldL = await page.evaluate(() => [...document.querySelectorAll(".rv-list .ci")].map((b) => b.getAttribute("data-room")));
  assert.deepEqual(oldL, [G, OLD, DM], "列表: 与图同一口径, 选中的老 room 也在: " + JSON.stringify(oldL));
  await page.click('[data-side="graph"]');
  await page.waitForSelector(".rv-person", { timeout: 5000 });
  await page.goto(base + "/role?id=t-ticket&room=" + encodeURIComponent(G), { waitUntil: "load" });   // 回到 G 接后面的成员栏验收
  await page.waitForSelector(".rv-msg", { timeout: 5000 });

  // 成员栏: 角色 / 状态 / 聪明度·最近发言 / 待交代 (可展开) / 栏头 (成员数 · host · 建于 · 待交代总数)。
  const gs = await page.evaluate(() => {
    const items = [...document.querySelectorAll("#gside .gs-item")].map((it) => ({
      nm: it.querySelector(".nm").textContent, role: (it.querySelector(".gs-host, .gs-lead, .gs-role") || {}).textContent || "",
      st: (it.querySelector(".gs-st") || {}).textContent || "", sub: it.querySelector(".gs-sub").textContent, due: (it.querySelector(".gs-due") || {}).textContent || "",
    }));
    return { items, head: document.querySelector("#gside .gs-head").textContent, meta: document.querySelector("#gside .gs-meta").textContent,
      stCls: [...document.querySelectorAll("#gside .gs-st")].map((e) => e.className.replace(/\s+/g, " ")), openBtn: getComputedStyle(document.querySelector("#gs-open")).display };
  });
  const by = (n) => gs.items.find((x) => x.nm === n);
  assert.match(by("alice").role, /host/, "alice 是 host: " + JSON.stringify(gs.items));
  assert.equal(by("bob").role, "成员"); assert.equal(by("张三").role, "人");
  assert.equal(by("alice").st, "闲", "alice 活着没在跑 = 闲"); assert.equal(by("bob").st, "闲 · 冷", "bob 空闲且缓存冷 = 闲 · 冷"); assert.equal(by("张三").st, "", "人没有状态");
  assert.match(gs.stCls.join("|"), /st-idle/); assert.match(gs.stCls.join("|"), /st-idle cold/, "冷是叠加在 idle 上的 class, 不再是独立的 st-stale");
  assert.match(by("bob").sub, /分钟前发言|刚刚发言/, "最近发言: " + by("bob").sub);
  assert.equal(by("bob").due, "待交代 1", "待交代数挂在处理人 bob 名下"); assert.equal(by("alice").due, "");
  assert.match(gs.head, /成员\s*3/); assert.match(gs.head, /alice/, "栏头写 host");
  assert.match(gs.meta, /建于/); assert.match(gs.meta, /待交代 1/, "栏头有待交代总数");
  assert.equal(gs.openBtn, "none", "宽屏不显示「成员」抽屉入口");
  assert.equal(await page.evaluate(() => !!document.querySelector("#gside .gs-duties")), false, "默认不展开");
  await page.click('#gside .gs-due');
  const dt = await page.evaluate(() => (document.querySelector("#gside .gs-duties .gs-dt") || {}).textContent || "");
  assert.match(dt, /#3/); assert.match(dt, /alice/); assert.match(dt, /问/); assert.match(dt, /查一下配置/, "展开 = #seq · 提问者 · kind · 摘要: " + dt);
  await page.click('#gside .gs-due');
  assert.equal(await page.evaluate(() => !!document.querySelector("#gside .gs-duties")), false, "再点收起");

  // quote: 答的那条画成引用块 (发话人 + 摘要), 头部不再有「答」和裸 id; 多个 re 只画第一条, 其余收成 +N; 点击落到原消息并高亮。
  const qt = await page.evaluate(() => {
    const art = document.querySelector('.rv-msg[data-id="aa000001.4"]');
    return { q: art.querySelector(".rv-bub .rv-quote .rq-it .rq-tx")?.textContent, who: art.querySelector(".rq-who")?.textContent, items: art.querySelectorAll(".rv-quote .rq-it").length, more: art.querySelector(".rq-more")?.textContent, head: art.querySelector(".rv-mh").textContent, restHidden: art.querySelector(".rq-rest").hidden };
  });
  assert.equal(qt.q, "查一下配置"); assert.equal(qt.who, "alice");
  assert.equal(qt.more, "+2", "多 re 折成 +N: " + JSON.stringify(qt));
  assert.ok(!/答/.test(qt.head) && !/↩/.test(qt.head), "头部没有「答」与裸 id: " + qt.head);
  await page.click('.rv-msg[data-id="aa000001.4"] .rq-more');
  assert.equal(await page.evaluate(() => document.querySelector('.rv-msg[data-id="aa000001.4"] .rq-rest').hidden), false, "点 +N 展开其余");
  assert.equal(await page.evaluate(() => document.querySelectorAll('.rv-msg[data-id="aa000001.4"] .rq-rest .rq-gone').length), 1, "查不到的降级成「较早的消息」");
  await page.click('.rv-msg[data-id="aa000001.4"] .rv-quote .rq-it');
  await page.waitForFunction(() => document.querySelector('.rv-msg[data-id="aa000001.3"]').classList.contains("hit"), null, { timeout: 3000 });

  // 点一条消息的「过程」→ 服务端渲染的过程框进来
  await page.click(".rv-open");
  await page.waitForSelector(".rv-box .turn-group", { timeout: 5000 });
  const po = await page.evaluate(() => { const b = document.querySelector(".rv-open"), art = b.closest(".rv-msg"); const kids = [...art.children]; return { on: b.classList.contains("on"), exp: b.getAttribute("aria-expanded"), boxIdx: kids.findIndex((e) => e.classList.contains("rv-box")), headIdx: kids.findIndex((e) => e.classList.contains("rv-mh")), bubIdx: kids.findIndex((e) => e.classList.contains("rv-bub")) }; });
  assert.ok(po.on && po.exp === "true", "展开后「过程」按钮高亮 + aria-expanded: " + JSON.stringify(po));
  assert.ok(po.boxIdx < po.headIdx && po.headIdx < po.bubIdx, "过程框 → 头 → 气泡: " + JSON.stringify(po));
  await page.click(".rv-open");
  assert.equal(await page.evaluate(() => document.querySelector(".rv-open").classList.contains("on")), false, "收起后恢复常态");
  await page.click(".rv-open");
  await page.waitForSelector(".rv-box .turn-group", { timeout: 5000 });

  // 点 wizard 节点 (bob 是 G 的成员): 视角换成 bob, room 选中保留; 再点 ✕ 取消选中 → 看 bob 的全部聊天记录 (只看与我相关)。
  await page.click('.rv-person[data-node="chat:wrG#worker"]');
  await page.waitForFunction(() => (document.querySelector("#rb-who .nm") || {}).textContent?.trim() === "bob", null, { timeout: 5000 });
  assert.equal(await page.evaluate(() => (document.querySelector(".rv-ttl") || {}).textContent), "群G", "成员间换视角: 右栏仍是这个 room");
  await page.click('.rv-room[data-room="' + G + '"]');   // 再点选中的 room 节点 = 取消选中
  await page.waitForFunction(() => (document.querySelector(".rv-ttl") || {}).textContent === "bob 的全部聊天记录", null, { timeout: 5000 });
  // 左栏顶上必须是「这个人」: 名字 / 状态 / 职责 / 宪章入口 —— room 图不是名片的替代品。
  const card = await page.evaluate(() => ({
    name: ((document.querySelector("#rb-who .nm") || {}).textContent || "").trim(),
    job: ((document.querySelector("#rb-who .job") || {}).textContent || "").trim(),
    charter: ((document.querySelector('#rb-who [data-rb="charter"]') || {}).textContent || "").trim(),
    title: document.title,
  }));
  assert.equal(card.name, "bob", "左栏顶上是选中的 wizard: " + JSON.stringify(card));
  assert.match(card.job, /bob 的职责/);
  assert.match(card.charter, /1\.2k/, "宪章入口带体量: " + card.charter);
  assert.match(card.title, /bob 的视角/);
  const side = await page.evaluate(() => ({
    gside: !(document.querySelector("#gside") || {}).hidden,
    // session 下拉在 aa5843a 从 #rv-session 挪进名片的 #rb-sp (旧断言一直红着, 这次一并改过来)。
    sess: !!document.querySelector("#rb-who #rb-sp"),
    charterBtn: !!document.querySelector("#ch-acts #rv-charter"),
    btns: document.querySelectorAll("#ch-acts button:not(.gs-open)").length,
    ttl: (document.querySelector(".rv-ttl") || {}).textContent,
  }));
  assert.equal(side.ttl, "bob 的全部聊天记录", "未选中 room: 标题 =「<role 名> 的全部聊天记录」(不写视角)");
  assert.equal(side.btns, 0, "右栏头没有「只看与我相关 / 全部消息」「取消选中」按钮");
  assert.equal(side.gside, false, "看 wizard 时成员列收起");
  assert.equal(side.sess, true, "全部会话 (session 切换) 在左上名片里");
  assert.equal(side.charterBtn, false, "宪章不再占右栏头");

  // 从群 link 深链打开: role= 带着目标 —— 打开的就是它, 不是第一个 room。
  await page.goto(base + "/role?id=t-ticket&role=" + encodeURIComponent("chat:wrG#guide"), { waitUntil: "load" });
  await page.waitForFunction(() => (document.querySelector("#rb-who .nm") || {}).textContent?.trim() === "alice", null, { timeout: 5000 });
  const deep = await page.evaluate(() => ({ name: ((document.querySelector("#rb-who .nm") || {}).textContent || "").trim(), rows: document.querySelectorAll(".rv-msg").length }));
  assert.equal(deep.name, "alice", "深链选中的就是 role=");
  assert.ok(deep.rows > 0, "深链打开有消息");

  // 切回列表, 再用搜索: 输入 → 三组结果 → 点消息 → 打开那个 room 并落到那一行。
  await page.click('[data-side="list"]');
  await page.waitForSelector(".rv-list .ci", { timeout: 5000 });
  await page.click("#sbox");
  await page.waitForSelector(".sk:not([hidden]) .sk-it", { timeout: 5000 });
  const recentN = await page.evaluate(() => document.querySelectorAll(".sk-it.conv").length);
  assert.equal(recentN, 3, "空查询列最近的 room (搜索不按时间窗裁: fixture 三间都在)");
  await page.fill("#sk-q", "配置");
  await page.waitForSelector(".sk-it.msg", { timeout: 5000 });
  const hit = await page.evaluate(() => ({ sn: document.querySelector(".sk-it.msg .sn").innerHTML, where: document.querySelector(".sk-it.msg .where").textContent }));
  assert.match(hit.sn, /<mark>配置<\/mark>/, "命中词高亮");
  assert.match(hit.where, /群聊 · 群G/);
  await page.click(".sk-it.msg");
  await page.waitForSelector('.rv-msg.hit[data-id="aa000001.3"]', { timeout: 5000 });
  assert.equal(await page.evaluate(() => document.querySelector(".sk").hidden), true, "选中后面板收起");

  // ══ 视角模型: role = 视角 (永远只有一个人), room = 可选的选中态; 点 room 只换选中, 点人才换 role ══
  const TA = "chat:wrG#guide", TB = "chat:wrG#worker", enc = encodeURIComponent;
  const q = () => new URL(page.url()).searchParams;
  const cardName = () => page.evaluate(() => ((document.querySelector("#rb-who .nm") || {}).textContent || "").trim());
  const meAuthors = () => page.evaluate(() => [...document.querySelectorAll("#thread-in .rv-msg.me")].map((m) => m.getAttribute("data-id")));
  const ciOn = () => page.evaluate(() => [...document.querySelectorAll(".rv-list .ci.on")].map((e) => e.getAttribute("data-room")));
  // 头 = 选中 room 时是 room 名, 未选中时是「<role 名> 的全部聊天记录」; 再没有「✕ 取消选中」/「只看与我相关」按钮。
  const ttlIs = (t) => page.waitForFunction((x) => (document.querySelector(".rv-ttl") || {}).textContent === x, t, { timeout: 5000 });
  const viewTab = (v) => page.evaluate((x) => !!document.querySelector('[data-side="' + x + '"]'), v);
  const goListView = async () => { if (await viewTab("list")) await page.click('[data-side="list"]'); await page.waitForSelector(".rv-list .ci", { timeout: 5000 }); };
  const goGraphView = async () => { if (await viewTab("graph")) await page.click('[data-side="graph"]'); await page.waitForSelector(".rv-person", { timeout: 5000 }); };

  // a. ?role=A&room=G: 名片是 A (wizard, 不是 room); 列表高亮 G; detail 是 G, A 说的行靠右 (.me); 头上有取消按钮, 标题行写「A 的视角」。
  await page.goto(base + "/role?id=t-ticket&role=" + enc(TA) + "&room=" + enc(G), { waitUntil: "load" });
  await page.waitForSelector("#thread-in .rv-msg", { timeout: 5000 });
  await page.waitForSelector("#thread-in .rv-msg.me", { timeout: 5000 });
  assert.equal(await cardName(), "alice", "选中 room 时名片仍是 role (wizard 名), 不是 room");
  assert.deepEqual(await ciOn(), [G], "列表高亮选中的 room");
  assert.deepEqual(await meAuthors(), ["aa000001.2", "aa000001.3"], "A 说的两行靠右 (.me)");
  const a1 = await page.evaluate(() => ({ ttl: document.querySelector(".rv-ttl").textContent, sub: !!document.querySelector(".rv-sub"), pov: ((document.querySelector("#ch-who .rv-pov-tag") || {}).textContent || "").trim(),
    clr: (() => { const x = document.querySelector("#ch-who #rv-clr"); if (!x) return null; const r = x.getBoundingClientRect(); return { title: x.title, w: r.width, h: r.height }; })(), btns: document.querySelectorAll("#ch-acts button:not(.gs-open)").length,
    sess: !!document.querySelector("#rb-who #rb-sp .sp"), me: (document.querySelector("#gside .gs-mem.me .nm") || {}).textContent }));
  assert.equal(a1.ttl, "群G", "标题 = room 名");
  // 人在群里直接说的话 (无 to / re): 头上的收件人用账本行的 wakeTo (alice), 不再只剩 `张三 —群G→`。
  const hh = await page.evaluate(() => { const p = document.querySelector('#thread-in .rv-msg[data-id="aa000001.1"] .rv-path'); return { txt: p ? p.textContent : "", to: p ? [...p.querySelectorAll(".rv-tag")].map((e) => e.textContent) : [] }; });
  assert.deepEqual(hh.to, ["alice"], "人话头部有收件人 (wakeTo): " + JSON.stringify(hh));
  assert.equal(a1.sub, false, "头不再写「👁 X 的视角」sub 行");
  assert.equal(a1.btns, 0, "#ch-acts 里没有取消选中按钮 (× 在标题行里, 不在右侧按钮区)");
  assert.equal(a1.pov, "👁 alice", "两者都选: 标题行挂「👁 role 名」(视角的体现), 不在 .rv-ttl 内");
  const ord = await page.evaluate(() => [...document.querySelectorAll("#ch-who .rv-trow > *")].map((e) => e.classList.contains("rv-ttl") ? "ttl" : e.id === "rv-clr" ? "clr" : e.classList.contains("rv-pov-tag") ? "pov" : "?"));
  assert.deepEqual(ord, ["ttl", "clr", "pov"], "标题行顺序: room 名 × 👁 role 名 (× 在两者之间): " + JSON.stringify(ord));
  assert.ok(a1.clr && a1.clr.title === "取消选择 room" && a1.clr.w >= 32 && a1.clr.h >= 32, "标题行有 × (hover 提示「取消选择 room」, 触控区 ≥32px): " + JSON.stringify(a1.clr));
  assert.equal(a1.me, "alice", "成员列里当前视角那行带 .me");
  assert.equal(q().get("role"), TA); assert.equal(q().get("room"), G);
  // a'. 点 ×: 只清 room、保留 role —— 标题回「A 的全部聊天记录」, 标题行不再有 × / 视角标, 列表无高亮, URL room= 空 role 不变。再回到 ?role=A&room=G 接后面的用例。
  await page.click("#ch-who #rv-clr");
  await ttlIs("alice 的全部聊天记录");
  const a2 = await page.evaluate(() => ({ clr: !!document.querySelector("#rv-clr"), pov: !!document.querySelector(".rv-pov-tag"), on: document.querySelectorAll(".rv-list .ci.on").length, card: ((document.querySelector("#rb-who .nm") || {}).textContent || "").trim() }));
  assert.deepEqual(a2, { clr: false, pov: false, on: 0, card: "alice" }, "只选 role: 无 ×, 名片仍是 alice, 无 room 高亮: " + JSON.stringify(a2));
  assert.equal(q().get("room"), ""); assert.equal(q().get("role"), TA);
  await page.goto(base + "/role?id=t-ticket&role=" + enc(TA) + "&room=" + enc(G), { waitUntil: "load" });
  await page.waitForSelector("#thread-in .rv-msg.me", { timeout: 5000 });

  // b. 图: A 节点有视角标记 (.rv-pov); 选中 edge (m|G|p:A) 带 sel, 点它 = 取消选中 (URL room= 空, 无 .on / sel), detail 换成 A 的全部记录; 再点 G 节点 = 重新选中。
  await goGraphView();
  const g1 = await page.evaluate((ta) => ({
    pov: [...document.querySelectorAll(".rv-person")].filter((e) => e.querySelector(".rv-pov")).map((e) => e.getAttribute("data-node")),
    sel: document.querySelectorAll("line.rv-edge.sel").length,
    onEdges: document.querySelectorAll("line.rv-edge.on").length,
    roomOn: !!document.querySelector('.rv-room.on[data-room="' + "chat:wrG" + '"]'),
    legend: /视角/.test((document.querySelector(".rv-legend") || {}).textContent || ""),
    selGeo: (() => { const l = document.querySelector("line.rv-edge.sel"), h = document.querySelector('line.rv-hit[data-edge="m|chat:wrG|p:' + ta + '"]');
      return !!l && !!h && ["x1", "y1", "x2", "y2"].every((k) => l.getAttribute(k) === h.getAttribute(k)); })(),
  }), TA);
  assert.deepEqual(g1.pov, [TA], "只有当前 role 的节点带 .rv-pov: " + JSON.stringify(g1));
  assert.equal(g1.sel, 1, "role → 选中 room 的成员边有 sel (只一条)");
  assert.equal(g1.onEdges, 1, "其余成员边不再高亮: .on 也只有 role→room 那一条 (同一条 sel), 别的保持普通灰");
  assert.equal(g1.selGeo, true, "sel 的就是 m|G|p:A 那条 (与它的点击线同一线段)");
  assert.equal(g1.roomOn, true, "room 节点 .on");
  assert.equal(g1.legend, true, "图例有「视角」一项");
  await page.dispatchEvent('line.rv-hit[data-edge="m|' + G + '|p:' + TA + '"]', "click");
  await ttlIs("alice 的全部聊天记录");
  const g2a = await page.evaluate(() => ({ sel: document.querySelectorAll("line.rv-edge.sel").length, on: document.querySelectorAll(".rv-room.on, line.rv-edge.on").length, ttl: document.querySelector(".rv-ttl").textContent,
    pov: document.querySelectorAll(".rv-pov").length }));
  assert.equal(q().get("room"), "", "取消选中: URL 写 room= 空串 (刷新不会被落点重新选中)"); assert.equal(q().get("role"), TA);
  assert.equal(q().has("room"), true);
  assert.equal(g2a.sel + g2a.on, 0, "取消选中后图上没有 on / sel: " + JSON.stringify(g2a));
  assert.equal(g2a.ttl, "alice 的全部聊天记录", "detail 换成 A 的全部记录");
  assert.equal(g2a.pov, 1, "视角标记仍在 (role 没变)");
  assert.equal(await cardName(), "alice", "取消选中不换名片");
  await page.click('.rv-room[data-room="' + G + '"]');
  await ttlIs("群G");
  await page.waitForFunction(() => document.querySelectorAll("line.rv-edge.sel").length === 1, null, { timeout: 5000 });
  assert.equal(q().get("room"), G, "点 room 节点重新选中");
  // 再点一次选中的 room 节点 = 取消选中 (toggle)
  await page.click('.rv-room[data-room="' + G + '"]');
  await ttlIs("alice 的全部聊天记录");
  await page.click('.rv-room[data-room="' + G + '"]');
  await ttlIs("群G");

  // c. 选中 G 时点 G 的成员 B → room 保留、名片换 B、「我」换人; 点非成员 → room 清空。
  await goListView();
  await page.click('#gside .gs-mem[data-node="' + TB + '"]');
  await page.waitForFunction(() => (document.querySelector("#rb-who .nm") || {}).textContent?.trim() === "bob", null, { timeout: 5000 });
  assert.equal(q().get("room"), G, "成员间换视角: room 保留"); assert.equal(q().get("role"), TB);
  await page.waitForFunction(() => [...document.querySelectorAll("#thread-in .rv-msg.me")].map((m) => m.getAttribute("data-id")).join() === "aa000001.4", null, { timeout: 5000 });
  assert.equal(await page.evaluate(() => (document.querySelector("#gside .gs-mem.me .nm") || {}).textContent), "bob", "成员列的视角标记跟着换");
  assert.deepEqual(await ciOn(), [G]);
  // 非成员: detail 里点一个不在 G 里的名字 (消息里的 data-node 同一条路径) → 选中清空, 看它的全部记录。
  await page.evaluate(([id, name]) => {
    const el = document.createElement("span"); el.className = "rv-au"; el.setAttribute("data-node", id); el.id = "probe-nonmember"; el.textContent = name;
    document.querySelector("#thread-in").appendChild(el);
  }, ["chat:wrNobody#x", "路人"]);
  await page.click("#probe-nonmember");
  await ttlIs("alice 的全部聊天记录");
  assert.equal(q().get("room"), "", "点非成员: room 选中清空"); assert.equal((await ciOn()).length, 0, "列表无高亮");
  await page.goto(base + "/role?id=t-ticket&role=" + enc(TA) + "&room=" + enc(G), { waitUntil: "load" });
  await page.waitForSelector("#thread-in .rv-msg.me", { timeout: 5000 });

  // c2. 换 role 后新名片在路上 (card=1 慢 2.5s): 名片不能还是旧人 —— 占位用新 role 的名字, 回包后才是完整名片。
  await page.goto(base + "/role?id=t-ticket&role=" + enc(TA) + "&room=" + enc(G), { waitUntil: "load" });
  await page.waitForSelector("#thread-in .rv-msg.me", { timeout: 5000 });
  globalThis.__cardDelay = 2500;
  await page.click('#gside .gs-mem[data-node="' + TB + '"]');
  await page.waitForTimeout(600);
  const slow = await page.evaluate(() => ({ name: ((document.querySelector("#rb-who .nm") || {}).textContent || "").trim(), job: !!document.querySelector("#rb-who .job"), sub: (document.querySelector(".rv-sub") || {}).textContent || "" }));
  assert.equal(slow.name, "bob", "新名片在路上时不画旧人 (alice), 先用新 role 的名字占位: " + JSON.stringify(slow));
  assert.equal(slow.job, false, "占位名片没有旧人的职责");
  assert.equal(slow.sub.trim(), "", "头不写视角 sub 行");
  await page.waitForFunction(() => document.querySelector("#rb-who .job"), null, { timeout: 6000 });
  assert.equal(await cardName(), "bob", "名片回包后是完整的新人");
  globalThis.__cardDelay = 0;
  // 选中 room 时 world 每 6s 一拍, 名片只在过了 30s 才跟着刷 (card=1 服务端不便宜): 8s 内不会再发 card 请求。
  globalThis.__cardDelay = 1; globalThis.__cardReqs = 0;
  await page.waitForTimeout(8000);
  assert.equal(globalThis.__cardReqs, 0, "名片不随每拍 world 刷: " + globalThis.__cardReqs);
  globalThis.__cardDelay = 0;

  // d. 旧链接: ?room=G (无 role) → 名片是 wizard (落点 alice 是成员), 选中 G; ?role=<dm id> → 选中该 dm, 名片是 wizard。
  await page.goto(base + "/role?id=t-ticket&room=" + enc(G), { waitUntil: "load" });
  await page.waitForSelector("#thread-in .rv-msg", { timeout: 5000 });
  await page.waitForFunction(() => (document.querySelector("#rb-who .nm") || {}).textContent?.trim() === "alice", null, { timeout: 5000 });
  assert.deepEqual(await ciOn(), [G], "旧链接 ?room=G: 选中 G");
  assert.equal(q().get("role"), TA, "role 补进 URL");
  await page.goto(base + "/role?id=t-ticket&role=" + enc(DM), { waitUntil: "load" });
  await page.waitForFunction((id) => document.querySelector('.rv-list .ci.on[data-room="' + id + '"]'), DM, { timeout: 5000 });
  assert.equal(await cardName(), "alice", "?role=<dm id>: 名片是 wizard 不是 room");
  assert.equal(q().get("room"), DM); assert.equal(q().get("role"), TA, "dm 的成员里落点 alice 在 → 用它");
  // 落点 role 不是该 room 的成员 → 用 host: OLD 里只有一个人 (李四, human) 没有 wizard —— 退到第一个 human 成员。
  await page.goto(base + "/role?id=t-ticket&room=" + enc(OLD), { waitUntil: "load" });
  await page.waitForFunction(() => /^human:/.test(new URL(location.href).searchParams.get("role") || ""), null, { timeout: 5000 });
  assert.equal(q().get("role"), "human:U2", "没有 wizard 成员时用第一个 human 成员: " + page.url());
  assert.equal(q().get("room"), OLD);

  // e. 无 room 参数 + 票据 landingRoom=G 且 role 是成员 → 选中 G (detail link); room= 空 → 不选; 落点 room 不存在 / role 非成员 → 不选。
  globalThis.__landing = G;
  await page.goto(base + "/role?id=t-ticket&role=" + enc(TA), { waitUntil: "load" });
  await page.waitForFunction((id) => document.querySelector('.rv-list .ci.on[data-room="' + id + '"]'), G, { timeout: 5000 });
  assert.equal(await cardName(), "alice"); assert.equal(q().get("room"), G, "落点只在 boot 用一次, 之后 URL 带 room");
  await page.goto(base + "/role?id=t-ticket", { waitUntil: "load" });
  await page.waitForFunction((id) => document.querySelector('.rv-list .ci.on[data-room="' + id + '"]'), G, { timeout: 5000 });
  await page.goto(base + "/role?id=t-ticket&role=" + enc(TA) + "&room=", { waitUntil: "load" });
  await ttlIs("alice 的全部聊天记录");
  assert.deepEqual(await ciOn(), [], "room= 空: 明确不选, 不被落点重新选中");
  assert.equal(q().get("room"), "");
  globalThis.__landing = "chat:wrGone";   // 不存在的 room: 不选
  await page.goto(base + "/role?id=t-ticket&role=" + enc(TA), { waitUntil: "load" });
  await ttlIs("alice 的全部聊天记录");
  assert.deepEqual(await ciOn(), [], "落点 room 不存在: 不选");
  globalThis.__landing = "";

  // f. popstate: detail 里点进别人 → history.back() 恢复原 role + room。
  await page.goto(base + "/role?id=t-ticket&role=" + enc(TA) + "&room=" + enc(G), { waitUntil: "load" });
  await page.waitForSelector("#thread-in .rv-msg.me", { timeout: 5000 });
  await page.click('#thread-in .rv-msg[data-id="aa000001.4"] .rv-au');   // bob 的名字 (在 detail 里点, 压返回栈)
  await page.waitForFunction(() => (document.querySelector("#rb-who .nm") || {}).textContent?.trim() === "bob", null, { timeout: 5000 });
  assert.equal(q().get("role"), TB); assert.equal(q().get("room"), G);
  await page.goBack();
  await page.waitForFunction(() => (document.querySelector("#rb-who .nm") || {}).textContent?.trim() === "alice", null, { timeout: 5000 });
  assert.equal(q().get("role"), TA, "返回: 视角回到 alice"); assert.equal(q().get("room"), G, "返回: room 选中仍是 G");
  assert.deepEqual(await meAuthors(), ["aa000001.2", "aa000001.3"]);
  await goListView();

  // 补两间 room 再看图:
  //  · HM = alice + 人 (张三): 有 human 成员, 仍画 room 节点, 不收成直连线;
  //  · DM2 = alice + C: C 不在 world.nodes 里 (活跃过滤会筛掉的那种), 成员也得补进图, 两 wizard 的 dm 画成直连线。
  const C = "w" + "3".padStart(12, "0");
  const HM = "user:U1", DM2 = "dm:" + [A, C].sort().join("|");
  ROOMS.push(
    { ...roomFact(HM, "wecom-dm", [
      { who: who("wizard", A), name: "alice", via: "founder", since: 7, ord: 1, host: true },
      { who: who("human", "U1"), name: "张三", via: "inbound", since: 8, ord: 2, host: false },
    ], who("wizard", A), T0 + 6000), unread: 1 },
    roomFact(DM2, "dm", [
      { who: who("wizard", A), name: "alice", via: "founder", since: 9, ord: 1, host: true },
      { who: who("wizard", C), name: "carol", via: "invite", since: 10, ord: 3, host: false },
    ], who("wizard", A), T0 + 7000),
  );
  WORLD.names[C] = "carol";
  await page.goto(base + "/role?id=t-ticket", { waitUntil: "load" });
  await page.click('[data-side="graph"]');
  await page.waitForSelector(".rv-person", { timeout: 5000 });
  const g2 = await page.evaluate(() => ({
    roomNodes: [...document.querySelectorAll(".rv-room")].map((e) => e.getAttribute("data-room")),
    links: [...document.querySelectorAll('line.rv-hit[data-edge^="d|"]')].map((l) => l.getAttribute("data-link")),
    // 取名字那行文本: 节点的 textContent 还带着悬浮提示 (<title>), 整串比对会对不上名字。
    people: [...document.querySelectorAll(".rv-person")].map((e) => ([...e.querySelectorAll("text")].pop() || e).textContent.trim()),
  }));
  assert.ok(g2.roomNodes.includes(HM), "有 human 成员的两人 room 仍画 room 节点: " + JSON.stringify(g2));
  assert.ok(!g2.links.includes(HM), "有 human 成员的 room 不画直连线");
  assert.equal(await page.evaluate((id) => (document.querySelector('.rv-room[data-room="' + id + '"] .rv-un text') || {}).textContent, HM), "1", "room 右上角是未读数量");
  await page.click('.rv-room[data-room="' + HM + '"]');
  await page.waitForFunction((id) => !document.querySelector('.rv-room[data-room="' + id + '"] .rv-un'), HM, { timeout: 5000 });
  assert.ok(g2.people.includes("carol"), "成员不在 world.nodes / 活跃过滤里也补进图: " + JSON.stringify(g2));
  assert.ok(g2.links.includes(DM2), "两 wizard 的 dm 画成直连线: " + JSON.stringify(g2));
  assert.ok(!g2.roomNodes.includes(DM2), "两 wizard 的 dm 没有 room 节点");

  // 节点样式: 人 = 👤 + 名字 / wizard = 圆点; 状态 idle (alice, 缓存热) / idle + cold = 空闲且缓存冷 (bob, cacheCold) / asleep = 休眠 (carol, 注册表里没有, 无动静记录 = 冷); host → room 是特殊边。
  const look = await page.evaluate(() => ({
    human: (document.querySelector('.rv-person.human text.rv-emo') || {}).textContent,
    humanName: (document.querySelector('.rv-person.human text.rv-nm') || {}).textContent,
    humanShape: !!document.querySelector('.rv-person.human .sh'),
    alice: document.querySelector('.rv-person[data-node="chat:wrG#guide"]').getAttribute("class"),
    bob: document.querySelector('.rv-person[data-node="chat:wrG#worker"]').getAttribute("class"),
    carol: [...document.querySelectorAll(".rv-person")].find((e) => e.textContent.includes("carol")).getAttribute("class"),
    hostEdges: document.querySelectorAll(".rv-edge.host").length,
    plainEdges: document.querySelectorAll(".rv-edge:not(.host):not(.direct)").length,
  }));
  assert.equal(look.human, "👤", "用户画成 👤 emoji");
  assert.equal(look.humanName, "张三", "emoji 下写着用户名字 (多位用户靠名字分辨)");
  assert.equal(look.humanShape, false, "用户不再是方块 / 圆");
  assert.match(look.alice, /st-idle/, "alice: pane 在、缓存热 = idle");
  assert.match(look.alice, /^(?!.*\bcold\b)/, "alice: 缓存热不带 cold");
  assert.match(look.bob, /st-idle/, "bob: pane 在 = idle");
  assert.match(look.bob, /\bcold\b/, "bob: 缓存已冷 = 叠加 cold (不再是独立的 st-stale)");
  assert.match(look.carol, /st-asleep/, "carol: pane 不在 = asleep");
  assert.ok(look.hostEdges >= 1, "host → room 是特殊边 (.rv-edge.host)");
  assert.ok(look.plainEdges >= 1, "普通成员边仍在");
  // 增量更新: 数据变了 (bob 开始干活) 只改样式, 节点元素与坐标原样保留, 不整图重画。
  const before = await page.evaluate(() => {
    const e = document.querySelector('.rv-person[data-node="chat:wrG#worker"]');
    window.__bobEl = e;
    return e.getAttribute("transform");
  });
  WORLD.nodes[1].busy = true;
  await page.waitForFunction(() => /st-working/.test(document.querySelector('.rv-person[data-node="chat:wrG#worker"]').getAttribute("class")), null, { timeout: 20000 });
  const kept = await page.evaluate(() => window.__bobEl.isConnected && window.__bobEl === document.querySelector('.rv-person[data-node="chat:wrG#worker"]'));
  assert.equal(kept, true, "数据刷新是增量: 同一个节点元素, 没有整图重建");
  assert.ok(before, "节点带坐标");

  // 视窗缩放: graph 区域跟着调尺寸, 节点元素 / 坐标原样保留 (不整图重排)。
  await page.goto(base + "/role?id=t-ticket", { waitUntil: "load" });
  // 左栏视图记在 localStorage: 上一段已经停在图上时按钮是「换成列表」, 不能再点。
  if (!(await page.$(".rv-graph"))) await page.click('[data-side="graph"]');
  await page.waitForSelector(".rv-person", { timeout: 5000 });
  const sz0 = await page.evaluate(() => {
    const sv = document.querySelector(".rv-graph");
    window.__nodeEl = document.querySelector(".rv-person");
    return { w: +sv.getAttribute("width"), h: +sv.getAttribute("height"), tf: window.__nodeEl.getAttribute("transform") };
  });
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.waitForFunction((w) => +document.querySelector(".rv-graph").getAttribute("width") > w + 20, sz0.w, { timeout: 5000 });
  const sz1 = await page.evaluate(() => ({ same: window.__nodeEl === document.querySelector(".rv-person"), h: +document.querySelector(".rv-graph").getAttribute("height") }));
  assert.equal(sz1.same, true, "缩放不重建节点");
  assert.ok(sz1.h > sz0.h, "高度也跟着变大: " + JSON.stringify({ sz0, sz1 }));

  // 名册缺席 (svr 刚重启) 的首屏: 图里不露 id, 名册一到 (2s 重取) 立刻换成真名。
  globalThis.__degrade = true;
  await page.goto(base + "/role?id=t-ticket", { waitUntil: "load" });
  if (!(await page.$(".rv-graph"))) await page.click('[data-side="graph"]');
  await page.waitForSelector(".rv-person", { timeout: 5000 });
  const idLeak = await page.evaluate(() => [...document.querySelectorAll(".rv-graph text")].map((t) => t.textContent).filter((t) => /(?:chat|uid|dm):|w0{6}/.test(t)));
  assert.deepEqual(idLeak, [], "名册缺席时图里不露 id: " + JSON.stringify(idLeak));
  globalThis.__degrade = false;
  await page.waitForFunction(() => [...document.querySelectorAll(".rv-person text.rv-nm")].some((t) => t.textContent === "alice"), null, { timeout: 8000 });

  // detail 的定时刷新不能把滚动位置拽走: 滚到中间, 每 4s 回包都有变化, 等 >10s scrollTop 纹丝不动 (含「用户正滚动时延后」)。
  globalThis.__bulk = 1;
  await page.click('.rv-room[data-room="' + G + '"]');
  await page.waitForFunction(() => document.querySelectorAll("#thread-in .rv-msg").length >= 100, null, { timeout: 8000 });
  const mid = await page.evaluate(() => { const t = document.querySelector("#thread"); t.scrollTop = Math.round((t.scrollHeight - t.clientHeight) / 2); return t.scrollTop; });
  await page.waitForTimeout(10500);
  const mid2 = await page.evaluate(() => ({ top: document.querySelector("#thread").scrollTop, n: window.__ticks }));
  assert.ok(Math.abs(mid2.top - mid) <= 2, "定时刷新后滚动位置不变: " + mid + " → " + mid2.top);
  // 请求在路上时用户又滚了一段: 回包渲染后停在用户滚到的位置, 不被拽回发请求前的位置。
  globalThis.__delay = 1500; globalThis.__reqs = 0;
  await page.waitForFunction(() => true);
  const r0 = globalThis.__reqs;
  await page.waitForFunction(() => document.querySelector("#thread").scrollTop >= 0);
  while (globalThis.__reqs === r0) await new Promise((r) => setTimeout(r, 50));   // 一发刷新请求已出发、回包还要 1.5s
  const moved = await page.evaluate(() => { const t = document.querySelector("#thread"); t.scrollTop = t.scrollTop + 400; return t.scrollTop; });
  await page.waitForTimeout(2600);
  const after = await page.evaluate(() => document.querySelector("#thread").scrollTop);
  assert.ok(Math.abs(after - moved) <= 2, "在途请求回来后不把滚动拽回旧位置: " + moved + " → " + after);
  globalThis.__delay = 0;
  globalThis.__bulk = 0;

  // 侧栏拖拽调宽: 图视角记 wz.sbw.graph (与列表的 wz.sbw.list 互不相干), 图随之重算; 双击恢复默认。
  const sw0 = await page.evaluate(() => ({ side: document.querySelector(".side").getBoundingClientRect().width, svg: +document.querySelector(".rv-graph").getAttribute("width") }));
  assert.ok(Math.abs(sw0.side - 560) < 3, "图视角默认 40% 宽 (1400 * 0.4): " + sw0.side);
  const hb = await (await page.$(".sb-rs")).boundingBox();
  await page.mouse.move(hb.x + hb.width / 2, hb.y + 200);
  await page.mouse.down();
  await page.mouse.move(hb.x + hb.width / 2 + 120, hb.y + 200, { steps: 4 });
  await page.mouse.up();
  const sw1 = await page.evaluate(() => ({ side: document.querySelector(".side").getBoundingClientRect().width, key: localStorage.getItem("wz.sbw.graph"), list: localStorage.getItem("wz.sbw.list") }));
  assert.ok(Math.abs(sw1.side - (sw0.side + 120)) < 3 && Number(sw1.key) === Math.round(sw1.side) && sw1.list === null, "拖动后图视角宽度被记住, 列表那份不动: " + JSON.stringify(sw1));
  await page.waitForFunction((w) => +document.querySelector(".rv-graph").getAttribute("width") > w + 60, sw0.svg, { timeout: 5000 });
  await page.dblclick(".sb-rs");
  const sw2 = await page.evaluate(() => ({ side: document.querySelector(".side").getBoundingClientRect().width, key: localStorage.getItem("wz.sbw.graph") }));
  assert.ok(Math.abs(sw2.side - sw0.side) < 3 && sw2.key === null, "双击恢复默认并清掉记录: " + JSON.stringify(sw2));

  // 移动端 (≤760px): 列表 / 图与 chat detail 二选一; 点进聊天看得到 detail, ‹ 返回列表。
  await page.setViewportSize({ width: 400, height: 760 });
  await page.goto(base + "/role?id=t-ticket", { waitUntil: "load" });
  // 深链进来直接是 detail (窄屏 .reading); 先点 ‹ 回到列表 / 图那一页。
  await page.click("#tb-back");
  await page.click('[data-side="list"]');   // 视图记在 localStorage: 上面停在图
  await page.waitForSelector(".rv-list .ci", { timeout: 5000 });
  const vis = (sel) => page.evaluate((q) => { const e = document.querySelector(q); return !!e && getComputedStyle(e).display !== "none"; }, sel);
  assert.equal(await vis(".side"), true, "窄屏默认看到列表");
  assert.equal(await vis(".main"), false, "窄屏默认不显示 detail");
  await page.click(".rv-list .ci");
  await page.waitForSelector(".rv-msg", { timeout: 5000 });
  assert.equal(await vis(".main"), true, "点进聊天后窄屏能看到 chat detail");
  assert.equal(await vis(".side"), false, "进入 detail 后列表收起");
  await page.click("#tb-back");
  assert.equal(await vis(".side"), true, "‹ 返回列表");
  assert.equal(await vis(".main"), false);

  // 手机: room detail 点返回 (popstate 的 list 格) 后, URL 要跟着当前选中走, 不是压栈时的旧 URL。
  await page.goto(base + "/role?id=t-ticket&role=" + enc(TA) + "&room=", { waitUntil: "load" });
  await ttlIs("alice 的全部聊天记录");
  await page.click("#tb-back");   // history.back → 回列表
  await page.waitForFunction(() => !document.querySelector("#app").classList.contains("reading"), null, { timeout: 5000 });
  await page.click('.rv-list .ci[data-room="' + G + '"]');
  await ttlIs("群G");
  assert.equal(q().get("room"), G);
  await page.goBack();   // 系统返回: 回列表, 选中 (列表高亮) 仍是 G
  await page.waitForFunction(() => !document.querySelector("#app").classList.contains("reading"), null, { timeout: 5000 });
  assert.deepEqual(await ciOn(), [G], "返回列表后选中态没变");
  assert.equal(q().get("room"), G, "URL 与选中态一致 (复制 / 刷新不丢选中): " + page.url());
  // 手机上取消选中的唯一入口: 列表里再点选中的 room = 取消选中并进入 detail (role 的全部记录), 不再是「回 detail 但保持选中」。
  await page.click('.rv-list .ci[data-room="' + G + '"]');
  await ttlIs("alice 的全部聊天记录");
  assert.equal(await page.evaluate(() => document.querySelector("#app").classList.contains("reading")), true, "点选中项: 进入 detail");
  assert.equal(q().get("room"), "", "取消选中: URL room= 空");
  assert.deepEqual(await ciOn(), [], "列表无高亮");

  // 手机: 成员栏默认收着; detail 头右侧「成员 N」入口 (有待交代带红点) 点开 = 同一份成员栏铺成底部抽屉, ✕ 收回, 点待交代条目 = 关抽屉并落到那条消息。
  await page.goto(base + "/role?id=t-ticket&role=" + enc(TA) + "&room=" + enc(G), { waitUntil: "load" });
  await ttlIs("群G");
  const gsVis = () => page.evaluate(() => { const g = document.querySelector("#gside"); return !g.hidden && getComputedStyle(g).display !== "none"; });
  assert.equal(await gsVis(), false, "手机: 成员栏默认不占位");
  assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector("#gs-open")).display !== "none" && !!document.querySelector("#gs-open .gs-pip")), true, "手机: 有「成员」入口, 有待交代带红点");
  await page.click("#gs-open");
  assert.equal(await gsVis(), true, "点入口: 抽屉出来");
  const sheet = await page.evaluate(() => { const r = document.querySelector("#gside").getBoundingClientRect(); return { bottom: Math.round(r.bottom), vh: innerHeight, w: Math.round(r.width), vw: innerWidth, items: document.querySelectorAll("#gside .gs-item").length }; });
  assert.ok(sheet.bottom === sheet.vh && sheet.w === sheet.vw && sheet.items === 3, "抽屉贴底铺满宽, 成员都在: " + JSON.stringify(sheet));
  await page.click("#gside .gs-due");
  await page.click("#gside .gs-dt");
  await page.waitForFunction(() => !document.querySelector("#gside").classList.contains("sheet") && document.querySelector('.rv-msg[data-id="aa000001.3"].hit'), null, { timeout: 5000 });
  await page.click("#gs-open"); await page.click("#gs-x");
  assert.equal(await gsVis(), false, "✕ 收回抽屉");

  // ── 图的单页用例: 全新页面 (没有 localStorage), 加几间 fixture 之外的 room, 直接看图 ─────────────
  const graphOf = async (extra, win) => {
    globalThis.__extraRooms = extra.rooms || []; globalThis.__extraNodes = extra.nodes || [];
    const pg = await browser.newPage({ viewport: { width: 1100, height: 800 } });
    await pg.addInitScript((w) => { localStorage.setItem("wezard.role.side", "graph"); if (w !== undefined) localStorage.setItem("wezard.role.winMin", String(w)); }, win);
    await pg.goto(base + "/role?id=t-ticket&room=", { waitUntil: "load" });
    await pg.waitForSelector(".rv-person", { timeout: 5000 });
    await pg.waitForTimeout(300);
    const read = await pg.evaluate(() => ({
      rooms: [...document.querySelectorAll(".rv-room")].map((n) => n.querySelector("text").textContent.trim()),
      people: [...document.querySelectorAll(".rv-person .rv-nm")].map((t) => t.textContent.trim()).sort(),
      direct: [...document.querySelectorAll('line.rv-hit[data-edge^="d|"]')].map((l) => l.getAttribute("data-link")),
      // 每个 wizard 节点的实际填充 / 描边虚线 (computed): 冷 = 白底, 休眠且冷 = 白底虚线
      fills: Object.fromEntries([...document.querySelectorAll(".rv-person.wizard")].map((e) => {
        const cs = getComputedStyle(e.querySelector(".sh"));
        return [e.querySelector(".rv-nm").textContent.trim(), { fill: cs.fill, dashed: cs.strokeDasharray !== "none", cls: e.getAttribute("class") }];
      })),
    }));
    await pg.close();
    globalThis.__extraRooms = []; globalThis.__extraNodes = [];
    return read;
  };
  // 1) 单聊 (HM: 一个人 + 一个 wizard 的 wecom-dm, 上面已入 ROOMS) = 💬; 多人群 = 👥; 只有 wizard 的 ≥3 人 adhoc = 🧙‍♂️。
  const ADHOC = "adhoc:abc123";
  const adhoc = roomFact(ADHOC, "adhoc", [A, B, C].map((id, i) => ({ who: who("wizard", id), name: "w" + i, via: "invite", since: 9 + i, ord: i + 1, host: i === 0 })), who("wizard", A));
  const icoG = await graphOf({ rooms: [adhoc], nodes: [] });
  assert.deepEqual(icoG.rooms.map((t) => t.split(" ")[0]).sort(), ["👥", "💬", "🧙‍♂️"].sort(), "三种图标各一间 (群 G / 单聊 HM / 三 wizard adhoc): " + JSON.stringify(icoG));

  // 3) LeoLane 形态: 一个 wizard 没加入任何多人群, 只靠一间两人 dm 连着; 那间 dm 的最后动静在窗口外、还挂着一条未决 duty。
  //    窗口内 (默认 2d) 不出现; 选「全部」才出现。对照: 同一间 dm 窗口内有动静则出现; 窗口外但有未决 duty 的 ≥3 人 room 仍留着 (规则只豁免两人 dm)。
  const LEO = "w" + "7".padStart(12, "0");
  const leoNode = { target: "uid:" + LEO, kind: "wizard", uid: LEO, name: "leolane", label: "leolane", base: "", tag: "", chat: "", busy: false, alive: false, lastTs: Date.now() - 3 * 86400000, rels: [] };
  const leoDm = (at, duties) => ({ ...roomFact("dm:" + [A, LEO].sort().join("|"), "dm", [
    { who: who("wizard", A), name: "alice", via: "founder", since: 30, ord: 1, host: true },
    { who: who("wizard", LEO), name: "leolane", via: "invite", since: 31, ord: 2, host: false },
  ], who("wizard", A), at), openDuties: duties });
  const oldAt = Date.now() - 3 * 86400000;
  const leoOld = await graphOf({ rooms: [leoDm(oldAt, 1)], nodes: [leoNode] });
  assert.ok(!leoOld.people.includes("leolane"), "只靠一间窗口外、带未决 duty 的两人 dm 连着的 wizard 不展示: " + JSON.stringify(leoOld));
  assert.ok(!leoOld.direct.some((id) => id.includes(LEO)), "那间 dm 不画直连线: " + JSON.stringify(leoOld));
  const leoAll = await graphOf({ rooms: [leoDm(oldAt, 1)], nodes: [leoNode] }, 0);
  assert.ok(leoAll.people.includes("leolane"), "选「全部」就出现了: " + JSON.stringify(leoAll));
  const leoNew = await graphOf({ rooms: [leoDm(Date.now() - 60_000, 0)], nodes: [leoNode] });
  assert.ok(leoNew.people.includes("leolane"), "dm 窗口内有动静 = 展示: " + JSON.stringify(leoNew));
  const bigOld = roomFact("adhoc:old3", "adhoc", [A, B, LEO].map((id, i) => ({ who: who("wizard", id), name: "n" + i, via: "invite", since: 40 + i, ord: i + 1, host: i === 0 })), who("wizard", A), oldAt);
  const leoBig = await graphOf({ rooms: [{ ...bigOld, openDuties: 1 }], nodes: [leoNode] });
  assert.ok(leoBig.people.includes("leolane"), "窗口外但留着未决 duty 的多人 room 仍在, 成员随 room 一起展示: " + JSON.stringify(leoBig));

  // 2) 缓存冷 = 节点填充变白, 叠加在空闲 / 休眠上; 工作中不受影响。
  const WHITE = "rgb(255, 255, 255)";
  const mk = (i, name, over) => ({ target: "uid:" + "w" + String(40 + i).padStart(12, "0"), kind: "wizard", uid: "w" + String(40 + i).padStart(12, "0"), name, label: name, base: "", tag: "", chat: "", busy: false, alive: true, lastTs: Date.now() - 60_000, rels: [], ...over });
  const coldNodes = [
    mk(1, "idleWarm", { cacheCold: false }), mk(2, "idleCold", { cacheCold: true }),
    mk(3, "sleepWarm", { alive: false, lastTs: Date.now() - 30_000 }), mk(4, "sleepCold", { alive: false, lastTs: Date.now() - 3600_000 }),
    mk(5, "workCold", { busy: true, known: true, cacheCold: true }),
  ];
  const coldRoom = roomFact("adhoc:cold1", "adhoc", coldNodes.map((n, i) => ({ who: who("wizard", n.uid), name: n.name, via: "invite", since: 20 + i, ord: i + 1, host: i === 0 })), who("wizard", coldNodes[0].uid));
  const cold = (await graphOf({ rooms: [coldRoom], nodes: coldNodes })).fills;
  assert.equal(cold.idleWarm.fill, "rgb(228, 231, 236)", "空闲且缓存热 = 灰: " + JSON.stringify(cold.idleWarm));
  assert.equal(cold.idleCold.fill, WHITE, "空闲且冷 = 白底: " + JSON.stringify(cold.idleCold));
  assert.equal(cold.idleCold.dashed, false, "空闲且冷的描边仍是实线");
  assert.equal(cold.sleepWarm.fill, "rgb(246, 247, 249)", "休眠且 (估计) 缓存热 = 休眠灰: " + JSON.stringify(cold.sleepWarm));
  assert.equal(cold.sleepCold.fill, WHITE, "休眠且冷 = 白底: " + JSON.stringify(cold.sleepCold));
  assert.equal(cold.sleepCold.dashed, true, "休眠且冷 = 白底虚线");
  assert.equal(cold.workCold.fill, "rgb(45, 164, 78)", "工作中不受冷影响 (仍是绿): " + JSON.stringify(cold.workCold));

  // 4) 时间范围 A: 成员栏里窗口外才发过言的成员整行淡灰, 窗口内的不灰; 选「全部」后都不灰; 图不动 (同样的节点数)。
  globalThis.__staleMembers = [B];
  const pgA = await browser.newPage({ viewport: { width: 1100, height: 800 } });
  await pgA.goto(base + "/role?id=t-ticket&room=" + encodeURIComponent(G), { waitUntil: "load" });
  await pgA.waitForSelector("#gside .gs-item", { timeout: 5000 });
  const quiet = () => pgA.evaluate(() => [...document.querySelectorAll("#gside .gs-item")].map((it) => [it.querySelector(".nm").textContent, it.classList.contains("out"), getComputedStyle(it.querySelector(".nm")).color]));
  const q2d = await quiet();
  assert.deepEqual(q2d.filter((x) => x[1]).map((x) => x[0]), ["bob"], "2d: 只有 3 天前才发过言的 bob 淡灰: " + JSON.stringify(q2d));
  // (fixture 的外壳没有 chat.css 的 --faint 变量, 算出来的颜色比不了: 灰度由截图验, 这里只验 class 与悬停提示)
  assert.match(await pgA.evaluate(() => document.querySelector("#gside .gs-item.out").getAttribute("title")), /窗口 \(2d\) 内没有发言/, "悬停说明原因");
  await pgA.click('[data-side="graph"]');
  await pgA.waitForSelector(".rv-person", { timeout: 5000 });
  await pgA.click(".convs-h .sp[data-dd=win] .sp-btn");
  await pgA.click('.convs-h .sp[data-dd=win] .sp-it[data-v="0"]');
  await pgA.waitForFunction(() => document.querySelectorAll("#gside .gs-item.out").length === 0, null, { timeout: 5000 });
  await pgA.close();
  globalThis.__staleMembers = undefined;

  assert.equal(errs.length, 0, "全程没有页面脚本错误: " + errs.join(" / "));
  console.log("room-graph.dom: " + JSON.stringify(counts) + " —— 节点数 = room + 参与者, 过程框与 wizard 视图可点开; 左栏名片与深链选中 role 正常");
} finally {
  await browser.close();
  server.close();
}