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
const roomFact = (id, kind, members, host, at = T0 + 5000) => ({ id, kind, title: "", bound: id === G, host, members, openDuties: 0, last: { seq: 1, at } });
// 时间用「刚才」—— rolepage 默认时间范围 2d, 下面另一间 3 天前的 room 只在「全部」下出现。
const T0 = Date.now() - 60_000;
const msgs = [
  { id: "aa000001.1", seq: 1, at: T0 + 1000, room: G, author: who("human", "U1"), authorName: "张三", ord: 3, speak: "human", kind: "say", text: "谁来搭把手", origin: "inbound" },
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
const memberViews = ROOMS[0].members.map((m) => ({ id: m.who.id, kind: m.who.kind, name: m.name, label: m.name, via: m.via, ord: m.ord, since: m.since, host: m.host }));
const WORLD = {
  ok: true, at: Date.now(), base: G, self: "chat:wrG#guide",
  rooms: ROOMS,
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
const ROOM = { ok: true, at: Date.now(), room: ROOMS[0], label: "群G", members: memberViews, duties: [], msgs: msgs.filter((m) => m.room === G), total: 4 };
// 搜索的服务端口径在 room-view-api.test.ts 验; 这里只验前端: 面板画得出三组、点一条消息能落到那一行。
const SEARCH = (q) => ({
  ok: true, q,
  rooms: q.includes("群") ? [{ id: G, kind: "wecom-group", name: "群G", group: true, preview: "bob: 查完了", lastAt: T0 + 4000, members: 3 }] : [],
  members: [],
  msgs: q.includes("配置") ? [{ id: "aa000001.3", room: G, roomName: "群G", roomKind: "wecom-group", group: true, author: who("wizard", A), authorName: "alice", toNames: ["bob"], at: T0 + 3000, snippet: "查一下配置", hits: 1 }] : [],
  msgTotal: q.includes("配置") ? 1 : 0,
});
const wizardOf = (role) => {
  const isBob = /worker|bob/.test(role);
  const id = isBob ? "chat:wrG#worker" : "chat:wrG#guide";
  const name = isBob ? "bob" : "alice";
  return { ok: true, at: Date.now(), role: { id, kind: "wizard", name, label: name, description: name + " 的职责", cwd: "/w/" + name, model: "m", bornAt: 1, chat: "群G", clones: [], spawns: [], forkedFrom: "", alive: true, busy: false, runningUntil: 0 },
    uid: isBob ? B : A, ledger: true, sessions: [{ sessionId: "s1", start: T0, end: 0, turns: 2, lastTs: T0 + 4000 }], session: "all", all: false, msgs: msgs.map((m) => ({ ...m, roomLabel: m.room === G ? "群G" : DM })), total: 5, rooms: ROOMS, plans: [], schedules: [], stats: undefined,
    charter: { tokens: 1234, at: T0 } };
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
  if (u.pathname === "/api/search") return send("application/json", JSON.stringify(SEARCH(u.searchParams.get("q") || "")));
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
    directLinks: [...document.querySelectorAll("line.rv-hit")].map((l) => l.getAttribute("data-link")),
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

  // 点一条消息的「过程」→ 服务端渲染的过程框进来
  await page.click(".rv-open");
  await page.waitForSelector(".rv-box .turn-group", { timeout: 5000 });

  // 点 wizard 节点 → 只看与我相关
  await page.click('.rv-person[data-node="chat:wrG#worker"]');
  await page.waitForFunction(() => (document.querySelector(".rv-ttl") || {}).textContent?.includes("bob"), null, { timeout: 5000 });
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
    allBtn: ((document.querySelector("#ch-acts #rv-all") || {}).textContent || "").trim(),
  }));
  assert.equal(side.allBtn, "只看与我相关", "W-1/W-2 代号换成一看就懂的名字: " + side.allBtn);
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
    links: [...document.querySelectorAll("line.rv-hit")].map((l) => l.getAttribute("data-link")),
    people: [...document.querySelectorAll(".rv-person")].map((e) => e.textContent.trim()),
  }));
  assert.ok(g2.roomNodes.includes(HM), "有 human 成员的两人 room 仍画 room 节点: " + JSON.stringify(g2));
  assert.ok(!g2.links.includes(HM), "有 human 成员的 room 不画直连线");
  assert.equal(await page.evaluate((id) => (document.querySelector('.rv-room[data-room="' + id + '"] .rv-un text') || {}).textContent, HM), "1", "room 右上角是未读数量");
  await page.click('.rv-room[data-room="' + HM + '"]');
  await page.waitForFunction((id) => !document.querySelector('.rv-room[data-room="' + id + '"] .rv-un'), HM, { timeout: 5000 });
  assert.ok(g2.people.includes("carol"), "成员不在 world.nodes / 活跃过滤里也补进图: " + JSON.stringify(g2));
  assert.ok(g2.links.includes(DM2), "两 wizard 的 dm 画成直连线: " + JSON.stringify(g2));
  assert.ok(!g2.roomNodes.includes(DM2), "两 wizard 的 dm 没有 room 节点");

  // 节点样式: 人 = 👤 + 名字 / wizard = 圆点; 状态 idle (alice, 缓存热) / stale = 缓存冷 (bob, cacheCold) / asleep = 休眠 (carol, 注册表里没有); host → room 是特殊边。
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
  assert.match(look.bob, /st-stale/, "bob: pane 在、缓存已冷 = stale");
  assert.match(look.carol, /st-asleep/, "carol: pane 不在 = asleep (休眠, 不同于缓存冷)");
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
  await page.click('[data-side="graph"]');
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

  // 移动端 (≤760px): 列表 / 图与 chat detail 二选一; 点进聊天看得到 detail, ‹ 返回列表。
  await page.setViewportSize({ width: 400, height: 760 });
  await page.goto(base + "/role?id=t-ticket", { waitUntil: "load" });
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

  console.log("room-graph.dom: " + JSON.stringify(counts) + " —— 节点数 = room + 参与者, 过程框与 wizard 视图可点开; 左栏名片与深链选中 role 正常");
} finally {
  await browser.close();
  server.close();
}