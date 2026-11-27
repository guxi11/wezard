// rolepage 关系图布局的指标回归 (node 直接跑, 不起浏览器): node tests/graph-layout.test.mjs
//
// 从 web/chat.js 抽出图的纯计算段 (「// ── 名字 / 节点」到「// 常驻循环」之间: graphModel / reconcileGraph / gStep / gLayout …),
// 喂一份真实拓扑 (tests/fixture-graph-world.json: 2026-11-21 的 /api/world, id 已匿名, 37 room · 34 参与者,
// 一个度数 24 的枢纽 + 一个二级枢纽 + 两个 room 节点), 在桌面 / 手机两种面板尺寸下量:
//   边交叉数 · 节点 (含名字标签) 包围盒重叠对数 · 同一输入两次结果一致 · 增量加一个 room 后旧节点的位移与交叉。
// 门槛取自换成 stress majorization 时的实测再留一点余量; 旧的斥力 + 交叉力 + 随机多起点在同一份 fixture 上是
// 交叉 4~16 / 重叠 3~15 / 增量位移均值 21~46 —— 改布局时指标只许更好, 变差就是回退。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { demoChannelWorld } from "./fixture-channel-world.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = readFileSync(join(root, "web", "chat.js"), "utf8");
const WORLD = JSON.parse(readFileSync(join(root, "tests", "fixture-graph-world.json"), "utf8"));

const load = (world, panel) => {
  const a = SRC.indexOf("  // ── 名字 / 节点"), b = SRC.indexOf("  // 常驻循环");
  assert.ok(a > 0 && b > a, "web/chat.js 的图段落标记找不到了 (「// ── 名字 / 节点」/「// 常驻循环」)");
  const W = { rooms: world.rooms, nodes: world.nodes, channels: world.channels || [], uidTargets: world.uidTargets || {}, chatNames: world.chatNames || {}, names: world.names || {} };
  const S = { panelBox: { w: panel.w, h: panel.h } };
  const store = { getItem: () => null, setItem: () => {} };
  const names = ["participants", "directPair", "graphModel", "reconcileGraph", "gStep", "gLayout", "roomHasRole", "nodeIdOf", "gFrameBox", "gBox", "frameTitle"];
  const fn = new Function("W", "S", "D", "localStorage", "convsEl", "esc", "isRoleId",
    SRC.slice(a, b) + "\nreturn {" + names.map((n) => n + ":" + n).join(",") + "};");
  return { ...fn(W, S, { role: "", roomId: "" }, store, { querySelector: () => null }, String, () => false), W, S };
};

/** 照 renderGraph 拼 model: 时间窗 2d (now = world.at), 两 wizard 的 dm 收成直连线 */
const model = (L, world) => {
  let rooms = world.rooms.slice().sort((x, y) => (y.last ? y.last.at : 0) - (x.last ? x.last.at : 0))
    .filter((r) => r.openDuties > 0 || (r.last && r.last.at >= world.at - 2880 * 60000));
  const people = L.participants(rooms).sort((x, y) => (y.lastTs || 0) - (x.lastTs || 0) || (x.name < y.name ? -1 : 1));
  const directs = [];
  rooms = rooms.filter((r) => { const pair = L.directPair(r, people); if (pair) directs.push({ room: r, pair }); return !pair; });
  return L.graphModel(rooms, people, directs);
};

/** 帧循环的离线等价: alpha 每帧 ×0.97, 低于 0.012 停帧 */
const settle = (L, g, alpha) => { while (alpha > 0.012) { L.gStep(g, alpha); alpha *= 0.97; } };

const firstLayout = (L, world) => {
  L.S.gnodes = null;
  const g = L.reconcileGraph(model(L, world)).g;
  L.gLayout(g);
  settle(L, g, 0.02);
  return g;
};

const crossings = (links) => {
  const ccw = (p, q, r) => (r.y - p.y) * (q.x - p.x) > (q.y - p.y) * (r.x - p.x);
  let n = 0;
  for (let i = 0; i < links.length; i++) for (let j = i + 1; j < links.length; j++) {
    const a = links[i], b = links[j];
    if (a.s === b.s || a.s === b.t || a.t === b.s || a.t === b.t) continue;
    if (ccw(a.s, b.s, b.t) !== ccw(a.t, b.s, b.t) && ccw(a.s, a.t, b.s) !== ccw(a.s, a.t, b.t)) n++;
  }
  return n;
};

/** 屏幕上的包围盒重叠对数: 节点与名字是固定像素 (名字 12px = web/chat.js 的 GFS, 窄屏最多 9 字 / 宽屏 11 字), 中心按视野缩放 k
 *  (= 把整张图放进画布所需的缩放, 夹在 0.95~1: 同 gView) 换算到屏幕; room = 胶囊 (26px 高)。 */
const overlaps = (g, panel) => {
  const fs = 12, nmax = panel.w <= 420 ? 9 : 11;
  const ext = (p) => p.isRoom ? [p.w / 2, p.w / 2, 13, 13]
    : [Math.max(p.r, Math.min(nmax, (p.ref.name || "").length) * 0.55 * fs / 2), Math.max(p.r, Math.min(nmax, (p.ref.name || "").length) * 0.55 * fs / 2), p.r, p.r + 3 + fs];
  const es = g.nodes.map(ext);
  const xs = g.nodes.map((p) => p.x), ys = g.nodes.map((p) => p.y);
  const W = Math.max(240, panel.w - 12), H = Math.max(260, panel.h - 38 - 24);
  const el = Math.max(...es.map((e) => Math.max(e[0], e[1]))), et = Math.max(...es.map((e) => e[2])), eb = Math.max(...es.map((e) => e[3]));
  const k = Math.max(0.95, Math.min(1, (W - 28 - 2 * el) / (Math.max(...xs) - Math.min(...xs)), (H - 28 - et - eb) / (Math.max(...ys) - Math.min(...ys))));
  const bs = g.nodes.map((p, i) => [p.x * k - es[i][0], p.x * k + es[i][1], p.y * k - es[i][2], p.y * k + es[i][3]]);
  let n = 0;
  for (let i = 0; i < bs.length; i++) for (let j = i + 1; j < bs.length; j++) {
    const A = bs[i], B = bs[j];
    if (A[0] < B[1] - 0.5 && B[0] < A[1] - 0.5 && A[2] < B[3] - 0.5 && B[2] < A[3] - 0.5) n++;
  }
  overlaps.k = k;
  return n;
};

/** 节点压边: 节点圆 (room 取胶囊半高) 碰到一条不以它为端点的边 (投影落在线段内部)。三角形三点共线时就是这种「一条边穿过第三个点、两条边叠在它上面」。 */
const onEdge = (g) => {
  let n = 0;
  g.links.forEach((l) => g.nodes.forEach((p) => {
    if (p === l.s || p === l.t) return;
    const vx = l.t.x - l.s.x, vy = l.t.y - l.s.y, L2 = vx * vx + vy * vy || 1;
    const t = ((p.x - l.s.x) * vx + (p.y - l.s.y) * vy) / L2;
    if (t <= 0.03 || t >= 0.97) return;   // 贴着端点那一小段归碰撞管 (同 gEdgeClear)
    const d = Math.hypot(p.x - (l.s.x + t * vx), p.y - (l.s.y + t * vy));
    if (d < (p.isRoom ? 10 : p.r) + 2) n++;
  }));
  return n;
};

const finite = (g) => g.nodes.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y));

for (const [label, panel] of [["桌面", { w: 575, h: 690 }], ["手机", { w: 390, h: 640 }]]) {
  const L = load(WORLD, panel);
  const g = firstLayout(L, WORLD);
  assert.equal(g.nodes.length, 36, "fixture 应画出 36 个节点");
  assert.equal(g.links.length, 42, "fixture 应画出 42 条边");
  assert.ok(finite(g), `${label}: 坐标出现 NaN / Infinity`);
  const c = crossings(g.links), o = overlaps(g, panel), oe = onEdge(g);
  console.log(`graph-layout ${label}: 间距倍数 ${L.S.gs.toFixed(2)} · 交叉 ${c} · 重叠 ${o} · 压边 ${oe} · 视野缩放 ${overlaps.k.toFixed(2)}`);
  assert.equal(oe, 0, `${label}: ${oe} 处节点压在别的边上`);
  assert.ok(c <= 4, `${label}: 边交叉 ${c} > 4`);
  assert.ok(o <= 3, `${label}: 节点 / 标签重叠 ${o} 对 > 3`);

  // 确定性: 同一份输入重排一次, 坐标一样 (不靠随机多起点)
  const g2 = firstLayout(load(WORLD, panel), WORLD);
  const same = g.nodes.every((p, i) => Math.abs(p.x - g2.nodes[i].x) < 1e-6 && Math.abs(p.y - g2.nodes[i].y) < 1e-6);
  assert.ok(same, `${label}: 同一份拓扑两次排出来不一样`);

  // 增量: 新开一个 3 人 adhoc room (两个已有 wizard + 一个新 wizard), 按刷新路径 reconcile + 加热 0.35 松弛到停帧
  const snap = new Map(g.nodes.map((p) => [p.id, [p.x, p.y]]));
  const dev = WORLD.rooms.find((r) => r.title === "wezard dev");
  const ppl = dev.members.filter((m) => m.who.kind === "wizard").slice(1, 3);
  const nid = "w" + "9".repeat(12);
  const w2 = { ...WORLD, uidTargets: { ...WORLD.uidTargets, [nid]: "wezard:new" },
    rooms: [{ id: "adhoc:zz", kind: "adhoc", title: "新开的临时 room", members: [...ppl, { who: { kind: "wizard", id: nid }, name: "Newbie" }], openDuties: 1, last: { seq: 1, at: WORLD.at } }, ...WORLD.rooms] };
  L.W.rooms = w2.rooms; L.W.uidTargets = w2.uidTargets;
  const rec = L.reconcileGraph(model(L, w2));
  assert.ok(rec.changed, "加了 room 应判为拓扑变化");
  settle(L, rec.g, 0.35);
  assert.ok(finite(rec.g), `${label}: 增量后坐标出现 NaN`);
  // 视野没动过时跟着内容居中 (gView), 整体平移看不出来: 扣掉旧节点的重心平移再量。
  const olds = rec.g.nodes.filter((p) => snap.has(p.id));
  const mx = olds.reduce((a, p) => a + p.x - snap.get(p.id)[0], 0) / olds.length, my = olds.reduce((a, p) => a + p.y - snap.get(p.id)[1], 0) / olds.length;
  const moves = olds.map((p) => Math.hypot(p.x - mx - snap.get(p.id)[0], p.y - my - snap.get(p.id)[1]));
  const mean = moves.reduce((s, v) => s + v, 0) / moves.length, ca = crossings(rec.g.links);
  console.log(`graph-layout ${label} 增量: 旧节点平均位移 ${mean.toFixed(1)} · 最大 ${Math.max(...moves).toFixed(1)} · 交叉 ${ca}`);
  assert.ok(mean <= 20, `${label}: 增量后旧节点平均位移 ${mean.toFixed(1)} > 20 (整图被打乱)`);
  assert.ok(ca <= 8, `${label}: 增量后交叉 ${ca} > 8`);
  assert.equal(onEdge(rec.g), 0, `${label}: 增量后有节点压在边上`);
}

// 退化输入: 空图 / 单个节点 / 两个不连通的块, 不抛错、坐标有限
{
  const L = load(WORLD, { w: 390, h: 640 });
  const wiz = (id, name) => ({ who: { kind: "wizard", id }, name });
  const mk = (rooms) => ({ ...WORLD, rooms: rooms.map((r, i) => ({ id: "adhoc:" + i, kind: "adhoc", title: "r" + i, openDuties: 1, last: { seq: 1, at: WORLD.at }, ...r })) });
  const ids = Object.keys(WORLD.uidTargets);
  for (const world of [
    mk([]),
    mk([{ members: [wiz(ids[0], "a")] }]),
    mk([{ members: [wiz(ids[0], "a"), wiz(ids[1], "b"), wiz(ids[2], "c")] }, { members: [wiz(ids[3], "d"), wiz(ids[4], "e"), wiz(ids[5], "f")] }]),
  ]) {
    L.W.rooms = world.rooms;
    const g = firstLayout(L, world);
    assert.ok(finite(g), "退化输入排出了 NaN");
  }
}

// 三角形 / 共线专用例: 每个 3 人 adhoc room 收成 room 节点, 再叠两两 dm (直连线), 加一个大枢纽把边长拉得悬殊 ——
// 曾出现的退化是第三个点被挤到另两点的连线上, 两条边与之完全重叠。量到 0 才算过。
{
  const panel = { w: 575, h: 690 };   // 桌面画布: 量的是共线退化, 不是手机塞满时的拥挤
  const L = load(WORLD, panel);
  const ids = Object.keys(WORLD.uidTargets);
  const wiz = (i) => ({ who: { kind: "wizard", id: ids[i] }, name: "n" + i });
  const room = (id, ms) => ({ id, kind: "dm", openDuties: 1, last: { seq: 1, at: WORLD.at }, members: ms.map(wiz) });
  const rooms = [];
  for (let i = 1; i < ids.length; i++) rooms.push(room("dm:h" + i, [0, i]));          // 0 号是枢纽, 连所有人
  rooms.push(room("dm:t1", [1, 2]), room("dm:t2", [2, 3]), room("dm:t3", [1, 3]));     // 1-2-3 两两相连 (+ 都连枢纽)
  rooms.push(room("dm:t4", [4, 5]), room("dm:t5", [5, 6]), room("dm:t6", [6, 7]), room("dm:t7", [4, 7]));
  rooms.push({ id: "adhoc:tri", kind: "adhoc", title: "三人", openDuties: 1, last: { seq: 1, at: WORLD.at }, members: [8, 9, 10].map(wiz) }, room("dm:t8", [8, 9]));
  const world = { ...WORLD, rooms };
  L.W.rooms = rooms;
  const g = firstLayout(L, world);
  const oe = onEdge(g), c = crossings(g.links);
  console.log(`graph-layout 三角形用例: ${g.nodes.length} 节点 ${g.links.length} 边 · 压边 ${oe} · 交叉 ${c}`);
  assert.ok(finite(g));
  assert.equal(oe, 0, `三角形用例: ${oe} 处节点压在别的边上`);
}

// 图里点 room 的选中规则用的「关联」判定 (web/chat.js roomHasRole, 与图上的边同一份成员表):
// role 在 room 成员里 = 有关联 (点 room 保留 role); 不在 / room 不存在 = 无关联 (清掉旧 role 选中)。
{
  const L = load(WORLD, { w: 575, h: 690 });
  const ids = Object.keys(WORLD.uidTargets);
  const wiz = (i) => ({ who: { kind: "wizard", id: ids[i] } });
  const room = { id: "dm:x", members: [wiz(0), wiz(1), { who: { kind: "human", id: "alice" } }] };
  const is = (target) => (nid) => nid === target;
  assert.equal(L.roomHasRole(room, is(L.nodeIdOf(wiz(0).who))), true, "wizard 成员 → 有关联");
  assert.equal(L.roomHasRole(room, is("human:alice")), true, "人成员 → 有关联");
  assert.equal(L.roomHasRole(room, is(L.nodeIdOf(wiz(2).who))), false, "不在 room 里的 wizard → 无关联");
  assert.equal(L.roomHasRole({ id: "dm:y", members: [] }, is("human:alice")), false, "空 room → 无关联");
  assert.equal(L.roomHasRole(null, is("human:alice")), false, "room 不存在 → 无关联");
}

// 频道框 (docs/evolve/channel-topic-rooms.md §P2): 一个频道一个框, 框内含它名下的 room 节点 (topic room / 旧帖子 room / 存档频道 room 都算),
// 空频道也有框, 框外的节点 (人 / 别的 room / 别的框) 不压进框里, 框内 room 互不重叠, 不再有指向「频道 room」的弱连线。
for (const [label, panel] of [["桌面", { w: 575, h: 690 }], ["手机", { w: 390, h: 640 }]]) {
  const world = demoChannelWorld();
  const L = load(world, panel);
  const m = model(L, world);
  assert.deepEqual(m.frames.map((f) => f.cid), world.channels.map((c) => c.id).sort(), `${label}: 一个频道一个框 (含空频道)`);
  const by = Object.fromEntries(m.frames.map((f) => [f.cid, f]));
  const c1 = world.channels[0], c2 = world.channels[1];
  assert.equal(c1.rooms.length, 5, "demo: 频道 1 名下 3 个 topic room + 1 个旧帖子 room + 1 个存档频道 room");
  assert.deepEqual(by[c1.id].rooms.slice().sort(), c1.rooms.slice().sort(), `${label}: 框内 = 频道名下全部 room (含存档 room、旧帖子 room)`);
  assert.deepEqual(by[c2.id].rooms, [], `${label}: 空频道的框里没有 room, 但框在`);
  assert.ok(!m.links.some((l) => l.chan), `${label}: 频道弱连线 (chan) 已由框取代`);
  const ids = new Set(m.nodes.map((n) => n.id));
  assert.ok(m.links.every((l) => ids.has(l.a) && ids.has(l.b)), `${label}: 不留指向不存在节点的线`);
  assert.ok(m.nodes.some((n) => n.isRoom && n.ref.kind === "topic-post" && /^topic:/.test(n.ref.id)) && m.nodes.some((n) => n.isRoom && n.ref.id === "chat:DemoC1abcdef"),
    `${label}: 频道名下只有两个 wizard 的 room 也留成 room 节点 (不收成直连线)`);

  L.S.gnodes = null;
  const g = L.reconcileGraph(m).g;
  L.gLayout(g);
  settle(L, g, 0.02);
  assert.ok(finite(g), `${label}: 带框的图坐标出现 NaN`);
  const id = (p) => p.x, idy = (p) => p.y;
  const rects = g.frames.map((f) => ({ f, b: L.gFrameBox(f, id, idy) }));
  const inside = (p, b) => { const x = L.gBox(p); return p.x - x[0] >= b.x0 - 0.5 && p.x + x[0] <= b.x1 + 0.5 && p.y - x[1] >= b.y0 - 0.5 && p.y + x[1] <= b.y1 + 0.5; };
  const hit = (p, b) => { const x = L.gBox(p), cy = p.y + x[2]; return p.x - x[0] < b.x1 - 0.5 && p.x + x[0] > b.x0 + 0.5 && cy - x[1] < b.y1 - 0.5 && cy + x[1] > b.y0 + 0.5; };
  let bad = 0, leak = 0;
  rects.forEach(({ f, b }) => g.nodes.forEach((p) => {
    if (p.hub) return;
    if (f.set[p.id]) { if (!inside(p, b)) bad++; } else if (hit(p, b)) leak++;
  }));
  assert.equal(bad, 0, `${label}: 框没有把它的 room 全框住`);
  assert.equal(leak, 0, `${label}: 框外的节点压进了框里`);
  for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) {
    const A = rects[i].b, B = rects[j].b;
    assert.ok(A.x1 <= B.x0 + 0.5 || B.x1 <= A.x0 + 0.5 || A.y1 <= B.y0 + 0.5 || B.y1 <= A.y0 + 0.5, `${label}: 两个框重叠`);
  }
  const rs = g.nodes.filter((n) => n.isRoom);
  let roomOverlap = 0;
  for (let i = 0; i < rs.length; i++) for (let j = i + 1; j < rs.length; j++) {
    const a = rs[i], b = rs[j], A = L.gBox(a), B = L.gBox(b);
    if (Math.abs(a.x - b.x) < A[0] + B[0] - 0.5 && Math.abs(a.y - b.y) < A[1] + B[1] - 0.5) roomOverlap++;
  }
  assert.equal(roomOverlap, 0, `${label}: 框把 room 节点挤到互相重叠`);
  const empty = rects.find((r) => r.f.cid === c2.id).b;
  assert.ok(empty.x1 - empty.x0 >= L.frameTitle(by[c2.id]).w && Number.isFinite(empty.y0), `${label}: 空框要装得下标题`);
  rects.forEach(({ f, b }) => assert.ok(b.x1 - b.x0 <= panel.w - 12, `${label}: 框「${f.name}」比画布还宽`));
  assert.ok(L.frameTitle(by[c2.id]).tail.includes("未绑 host") && L.frameTitle(by[c1.id]).tail.includes("🎩 HostDe"), `${label}: 标题 = 频道名 + 🎩 host / 未绑 host`);
  console.log(`graph-layout ${label} 频道框: ${g.frames.length} 个框 · ${rs.length} 个 room · 框内 ${by[c1.id].nodes.length} 个`);
}

console.log("graph-layout: ok");
