// Rolepage SPA —— room 模型之后的一页 IM。
//
//   左栏  力导向图: room 胶囊 ↔ 参与者圆点 (点 room 看历史, 点 wizard 看它说的 + 指向它的);
//         家谱 (谁生的谁) 是可切换的一层虚线。
//   右栏  room 历史 (author / to / re / status 都是账本行上的显式字段, 点一条消息可以展开
//         产出它的那一轮的过程框), 或一个 wizard 的 W-1 (默认) / W-2 (全部) 消息。
//
// 数据面 (全部 GET, ?id= 是票据): /api/world · /api/room · /api/wizard · /api/turn · /api/tool
// 没有侧栏会话列表了 —— 会话列表本来是从 turn 记录猜出来的「谁在哪说了什么」, room 账本
// 里那是一个 room 节点。视角状态 (room / role / all) 全在 URL 里。
//
// 无构建步骤: 保持 var / function 写法, 直接被浏览器加载。
(function () {
  var qs = new URLSearchParams(location.search);
  var TOKEN = qs.get('id') || '';
  var ROOM = qs.get('room') || '';
  var ROLE = qs.get('role') || '';
  var TICK_MS = 4000, WORLD_MS = 6000;

  var $ = function (s) { return document.querySelector(s); };
  var convsEl = $('#convs'), thread = $('#thread'), inner = $('#thread-in');
  var membar = $('#membar'), chWho = $('#ch-who'), chActs = $('#ch-acts');

  var W = { at: 0, rooms: [], nodes: [], edges: [], uidTargets: {}, chatNames: {}, names: {}, degraded: false };
  var D = { mode: '', roomId: '', role: '', uid: '', at: 0, msgs: [], total: 0, earlier: '', room: null, label: '', members: [], duties: [], wizard: null, sessions: [], session: 'all', all: qs.get('all') === '1', ledger: true, plans: [], schedules: [] };
  var S = { showTree: false, showAll: false, openTurns: {}, charter: null };
  // 默认只画还在动的东西: room 近 3 天有消息或有未结 duty; 人 24h 内说过话 / 在跑 / 是 host。
  // 「全部」开关恢复成整本账 (迁移带进来的历史成员都在那儿)。
  var ROOM_FRESH_MS = 2 * 86400000, PERSON_FRESH_MS = 12 * 3600000;
  var fresh = function (ts, ms) { return !!ts && Date.now() - ts < ms; };

  var esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };
  var api = function (path, params) {
    var p = new URLSearchParams();
    if (TOKEN) p.set('id', TOKEN);
    Object.keys(params || {}).forEach(function (k) { if (params[k] !== undefined && params[k] !== null && params[k] !== '') p.set(k, params[k]); });
    return fetch(path + '?' + p.toString(), { cache: 'no-store' }).then(function (r) { return r.json(); });
  };
  var syncUrl = function () {
    var p = new URLSearchParams(location.search);
    if (D.mode === 'room') { p.set('room', D.roomId); p.delete('role'); }
    else if (D.mode === 'wizard') { p.set('role', D.role); p.delete('room'); }
    if (D.mode === 'wizard' && D.all) p.set('all', '1'); else p.delete('all');
    history.replaceState(null, '', location.pathname + '?' + p.toString());
  };
  var pad = function (n) { return n < 10 ? '0' + n : '' + n; };
  var fmtDay = function (ts) {
    if (!ts) return '';
    var d = new Date(ts), t = new Date();
    var hm = pad(d.getHours()) + ':' + pad(d.getMinutes());
    return d.toDateString() === t.toDateString() ? hm : pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + hm;
  };
  var md = function (text) {
    try {
      if (window.markdownit) {
        if (!md._i) md._i = window.markdownit({ html: false, linkify: true, breaks: true });
        return md._i.render(String(text || ''));
      }
    } catch (e) { /* 退回纯文本 */ }
    return '<p>' + esc(text).replace(/\n/g, '<br>') + '</p>';
  };

  // ── 名字 / 节点 ────────────────────────────────────────────────────
  var nodeIdOf = function (who) {
    if (!who) return '';
    if (who.kind === 'wizard') return W.uidTargets[who.id] || ('uid:' + who.id);
    if (who.kind === 'human') return 'human:' + who.id;
    return '';
  };
  var nodeOf = function (id) {
    for (var i = 0; i < W.nodes.length; i++) if (W.nodes[i].target === id) return W.nodes[i];
    var uid = id.indexOf('uid:') === 0 ? id.slice(4) : '';
    var human = id.indexOf('human:') === 0;
    var name = uid ? (W.names[uid] || uid) : human ? (W.names[id.slice(6)] || id.slice(6)) : id;
    return { target: id, kind: human ? 'human' : 'wizard', name: name, label: human ? '👤' : '🧙‍♂️', rels: [] };
  };
  var roomLabelOf = function (r) {
    if (!r) return '';
    if (W.chatNames[r.id]) return W.chatNames[r.id];
    if (r.title) return r.title;
    if (r.label) return r.label;
    return (r.members || []).map(function (m) { return m.name; }).join(' ↔ ') || r.id;
  };
  var KIND_IC = { 'wecom-group': '👥', 'wecom-dm': '💬', 'topic-post': '📌', wx: '🟢', dm: '🧙', adhoc: '◎' };
  var cssEsc = function (s) { return String(s).replace(/(["\\])/g, '\\$1'); };

  // ── 二部图 ─────────────────────────────────────────────────────────
  var participants = function (rooms) {
    var seen = {}, hosts = {};
    (rooms || []).forEach(function (r) {
      (r.members || []).forEach(function (m) {
        var id = nodeIdOf(m.who);
        if (!id) return;
        seen[id] = true;
        if (m.host) hosts[id] = true;
      });
    });
    return Object.keys(seen).map(nodeOf).filter(function (n) {
      if (S.showAll || n.kind === 'human' || n.self) return true;
      if (n.alive || n.busy || (n.runningUntil && n.runningUntil > Date.now())) return true;
      if (hosts[n.target]) return true;
      return fresh(n.lastTs, PERSON_FRESH_MS);
    });
  };
  // ── 力导向图 ───────────────────────────────────────────────────────
  //  room = 胶囊, wizard / user = 圆点, 边 = 成员关系 (家谱另开一层虚线)。
  //  无依赖的 FR 式模拟: 斥力 + 弹簧 + 向心 + 碰撞, 冷却到定稿; 拖节点会钉住它并重算,
  //  滚轮缩放 / 拖空白平移只改 viewBox, 不动节点坐标; 双击回到自动适配。
  var G_ITER = 240;
  var buildGraph = function (rooms, people) {
    var nodes = [], index = {};
    // 种子按竖长的椭圆撒 —— 左栏是高窄的一条, 圆形撒点会被压成上半截
    var panelW = Math.max(240, (convsEl.clientWidth || 332) - 12);
    var panelH = Math.max(300, (convsEl.clientHeight || 620) - 30);
    var hw = Math.max(104, Math.min(panelW * 0.46, Math.sqrt(rooms.length + people.length) * 26));
    var hh = hw * Math.max(1.4, Math.min(2.2, panelH / panelW));
    var add = function (n) { index[n.id] = nodes.length; nodes.push(n); };
    rooms.forEach(function (r, i) {
      var w = Math.max(62, Math.min(132, 30 + roomLabelOf(r).length * 6.6));
      add({ id: 'r:' + r.id, ref: r, isRoom: true, w: w, r: Math.max(w, 22) / 2,
        x: Math.cos(i * 2.39996) * hw * 0.9, y: Math.sin(i * 2.39996) * hh * 0.9 });
    });
    people.forEach(function (p, i) {
      add({ id: 'p:' + p.target, ref: p, isRoom: false, w: 0, r: 9,
        x: Math.cos((i + rooms.length) * 2.39996) * hw * 0.8, y: Math.sin((i + rooms.length) * 2.39996) * hh * 0.8 });
    });
    var links = [];
    rooms.forEach(function (r) {
      (r.members || []).forEach(function (m) {
        var pid = 'p:' + nodeIdOf(m.who);
        if (index[pid] === undefined) return;
        links.push({ a: index['r:' + r.id], b: index[pid], tree: false, room: r.id });
      });
    });
    if (S.showTree) {
      (W.edges || []).forEach(function (e) {
        if (index['p:' + e.from] === undefined || index['p:' + e.to] === undefined) return;
        links.push({ a: index['p:' + e.from], b: index['p:' + e.to], tree: true });
      });
    }
    return { nodes: nodes, links: links, index: index, hw: hw, hh: hh };
  };
  var simulateGraph = function (g, iter) {
    var ns = g.nodes, n = ns.length;
    if (!n) return;
    var k = Math.max(46, Math.min(110, 2 * Math.sqrt((g.hw * g.hh) / n)));
    // 椭圆软墙: 模拟空间跟着左栏的长宽比走, 出来的团才填得满那一竖条
    var wall = function (p) {
      var ex = p.x / g.hw, ey = p.y / g.hh, ee = ex * ex + ey * ey;
      if (ee <= 1) return;
      var s = (1 - 1 / Math.sqrt(ee)) * 0.35;
      p.x -= p.x * s;
      p.y -= p.y * s;
    };
    // 宽度不同的胶囊按长边当半径, 免得左右压在一起
    var rOf = function (p) { return p.isRoom ? p.w / 2 : p.r; };
    ns.forEach(function (p) {
      var pin = S.gpos && S.gpos[p.id];
      if (pin) { p.x = pin.x; p.y = pin.y; p.fixed = true; }
    });
    var alpha = 1;
    for (var it = 0; it < iter; it++) {
      var cx = 0, cy = 0;
      for (var i = 0; i < n; i++) { cx += ns[i].x; cy += ns[i].y; }
      cx /= n; cy /= n;
      for (var a = 0; a < n; a++) {
        var p = ns[a];
        for (var b = a + 1; b < n; b++) {
          var q = ns[b];
          var dx = p.x - q.x, dy = p.y - q.y, d2 = dx * dx + dy * dy;
          if (d2 < 0.02) { dx = 0.5 - Math.random(); dy = 0.5 - Math.random(); d2 = 0.02; }
          var d = Math.sqrt(d2), ux = dx / d, uy = dy / d;
          var f = (k * k / d) * alpha * 0.10;
          if (!p.fixed) { p.x += ux * f; p.y += uy * f; }
          if (!q.fixed) { q.x -= ux * f; q.y -= uy * f; }
          var min = rOf(p) + rOf(q) + 8;
          if (d < min) {
            var o = (min - d) * 0.5 * 0.45;
            if (!p.fixed) { p.x += ux * o; p.y += uy * o; }
            if (!q.fixed) { q.x -= ux * o; q.y -= uy * o; }
          }
        }
      }
      g.links.forEach(function (l) {
        var lp = ns[l.a], lq = ns[l.b];
        var sx = lq.x - lp.x, sy = lq.y - lp.y, sd = Math.sqrt(sx * sx + sy * sy) || 0.01;
        var want = l.tree ? k * 1.8 : k * 0.95;
        var sf = ((sd - want) / sd) * (l.tree ? 0.04 : 0.09) * alpha;
        if (!lp.fixed) { lp.x += sx * sf; lp.y += sy * sf; }
        if (!lq.fixed) { lq.x -= sx * sf; lq.y -= sy * sf; }
      });
      ns.forEach(function (p) {
        if (p.fixed) return;
        p.x += (cx - p.x) * 0.010 * alpha;
        p.y += (cy - p.y) * 0.010 * alpha;
        wall(p);
      });
      alpha *= 0.985;
    }
  };
  var gRaf = 0;
  var scheduleGraph = function () {
    if (gRaf) return;
    gRaf = requestAnimationFrame(function () { gRaf = 0; renderGraph(); });
  };
  var bindGraph = function (svg) {
    if (!svg) return;
    var pt = svg.createSVGPoint();
    var toWorld = function (e) {
      var m = svg.getScreenCTM();
      if (!m) return { x: 0, y: 0 };
      pt.x = e.clientX; pt.y = e.clientY;
      var p = pt.matrixTransform(m.inverse());
      return { x: p.x, y: p.y };
    };
    var start = null;
    svg.onpointerdown = function (e) {
      var el = e.target.closest ? e.target.closest('[data-node],[data-room]') : null;
      var node = el && el.getAttribute('data-node'), room = el && el.getAttribute('data-room');
      start = { id: node ? 'p:' + node : room ? 'r:' + room : '', el: el,
        x: e.clientX, y: e.clientY, px: S.gpx || 0, py: S.gpy || 0,
        vb: { x: svg.viewBox.baseVal.x, y: svg.viewBox.baseVal.y,
          w: svg.viewBox.baseVal.width, h: svg.viewBox.baseVal.height } };
      S.gmoved = false;
      // 不能在这里 capture: 指针捕获会把随后的 click 改派给 svg, 节点上的点开就失灵了。
      // 等真的开始拖了再捕获。
    };
    svg.onpointermove = function (e) {
      if (!start) return;
      var dx = e.clientX - start.x, dy = e.clientY - start.y;
      if (!S.gmoved && dx * dx + dy * dy < 16) return;
      if (!S.gmoved) { try { svg.setPointerCapture(e.pointerId); } catch (err) { /* 老浏览器 */ } }
      S.gmoved = true;
      // 拖动期间只改这一处, 不重建 DOM —— 重建会把指针捕获和这次拖拽一起丢掉。
      if (start.id) {
        var w = toWorld(e);
        S.gpos = S.gpos || {};
        S.gpos[start.id] = { x: w.x, y: w.y };
        if (start.el) start.el.setAttribute('transform', 'translate(' + w.x.toFixed(1) + ' ' + w.y.toFixed(1) + ')');
      } else {
        var box = svg.getBoundingClientRect();
        var pxu = start.vb.w / (box.width || 1), pyu = start.vb.h / (box.height || 1);
        S.gpx = start.px - dx * pxu;
        S.gpy = start.py - dy * pyu;
        svg.setAttribute('viewBox', [start.vb.x - dx * pxu, start.vb.y - dy * pyu,
          start.vb.w, start.vb.h].map(function (v) { return v.toFixed(1); }).join(' '));
      }
    };
    var stop = function (e) {
      var moved = S.gmoved;
      start = null;
      try { svg.releasePointerCapture(e.pointerId); } catch (err) { /* 已释放 */ }
      if (moved) scheduleGraph();   // 拖完再按新坐标重排一次
    };
    svg.onpointerup = stop;
    svg.onpointercancel = stop;
    svg.onwheel = function (e) {
      e.preventDefault();
      S.gzoom = Math.max(0.35, Math.min(4, (S.gzoom || 1) * (e.deltaY < 0 ? 1.12 : 0.89)));
      scheduleGraph();
    };
    svg.ondblclick = function () { S.gzoom = 1; S.gpx = 0; S.gpy = 0; S.gpos = {}; renderGraph(); };
    svg.onclick = function () { setTimeout(function () { S.gmoved = false; }, 0); };
  };
  var renderGraph = function () {
    var rooms = (W.rooms || []).slice().sort(function (a, b) { return (b.last ? b.last.at : 0) - (a.last ? a.last.at : 0); });
    if (!S.showAll) rooms = rooms.filter(function (r) { return r.openDuties > 0 || fresh(r.last && r.last.at, ROOM_FRESH_MS); });
    var people = participants(rooms).sort(function (a, b) { return (b.lastTs || 0) - (a.lastTs || 0) || (a.name < b.name ? -1 : 1); });
    var g = buildGraph(rooms, people);
    simulateGraph(g, G_ITER);
    var minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9;
    g.nodes.forEach(function (p) {
      var hw = p.isRoom ? p.w / 2 : p.r + 6, hh = p.isRoom ? 10 : p.r + 14;
      minX = Math.min(minX, p.x - hw); maxX = Math.max(maxX, p.x + hw);
      minY = Math.min(minY, p.y - hh); maxY = Math.max(maxY, p.y + hh);
    });
    if (!g.nodes.length) { minX = minY = maxX = maxY = 0; }
    var pad = 16;
    var cxm = (minX + maxX) / 2 + (S.gpx || 0), cym = (minY + maxY) / 2 + (S.gpy || 0);
    var z = S.gzoom || 1;
    var vw = Math.max(80, maxX - minX + pad * 2) / z, vh = Math.max(80, maxY - minY + pad * 2) / z;
    var width = Math.max(240, (convsEl.clientWidth || 332) - 12);
    // 画布跟着内容的长宽比走 (不再 letterbox): 节点少就是一短块, 多了就往下滚
    var height = Math.max(220, Math.round(width * (vh / vw)));
    var onRoom = function (id) { return D.mode === 'room' && D.roomId === id; };
    var lines = g.links.map(function (l) {
      var p = g.nodes[l.a], q = g.nodes[l.b];
      return '<line x1="' + p.x.toFixed(1) + '" y1="' + p.y.toFixed(1) + '" x2="' + q.x.toFixed(1) + '" y2="' + q.y.toFixed(1) + '"' +
        (l.tree ? ' class="rv-tree"' : ' class="rv-edge' + (onRoom(l.room) ? ' on' : '') + '"') + '/>';
    }).join('');
    var roomNodes = rooms.map(function (r) {
      var p = g.nodes[g.index['r:' + r.id]];
      var dot = r.openDuties ? '<circle cx="' + (p.w / 2 - 6).toFixed(1) + '" cy="-6" r="3.2" class="rv-duty"/>' : '';
      return '<g class="rv-node rv-room' + (onRoom(r.id) ? ' on' : '') + '" data-room="' + esc(r.id) + '" transform="translate(' + p.x.toFixed(1) + ' ' + p.y.toFixed(1) + ')">' +
        '<rect x="' + (-p.w / 2).toFixed(1) + '" y="-10" width="' + p.w.toFixed(1) + '" height="20" rx="7"/>' +
        '<text x="' + (-p.w / 2 + 7).toFixed(1) + '" y="4">' + esc((KIND_IC[r.kind] || '·') + ' ' + roomLabelOf(r).slice(0, 12)) + '</text>' + dot +
        '</g>';
    }).join('');
    var personNodes = people.map(function (n) {
      var p = g.nodes[g.index['p:' + n.target]];
      var busy = n.busy || (n.runningUntil && n.runningUntil > Date.now());
      return '<g class="rv-node rv-person' + (n.kind === 'human' ? ' human' : '') + (D.mode === 'wizard' && D.role === n.target ? ' on' : '') + (n.ghost ? ' ghost' : '') + '" data-node="' + esc(n.target) + '" transform="translate(' + p.x.toFixed(1) + ' ' + p.y.toFixed(1) + ')">' +
        '<circle r="' + p.r + '"' + (busy ? ' class="live"' : '') + '/>' +
        '<text y="' + (p.r + 11) + '" text-anchor="middle">' + esc(n.name.slice(0, 9)) + '</text>' +
        '</g>';
    }).join('');
    convsEl.innerHTML = '<div class="rv-ghead">' + esc(rooms.length + ' 个 room · ' + people.length + ' 位参与者' + (S.showAll ? '' : ' (近 2 天)')) +
      ' <span class="rv-gbtns"><button class="rv-tree-t' + (S.showAll ? ' on' : '') + '" id="rv-all">全部</button>' +
      '<button class="rv-tree-t' + (S.showTree ? ' on' : '') + '" id="rv-tree">家谱</button></span></div>' +
      '<svg class="rv-graph" width="' + width + '" height="' + height + '" viewBox="' +
      [(cxm - vw / 2).toFixed(1), (cym - vh / 2).toFixed(1), vw.toFixed(1), vh.toFixed(1)].join(' ') + '">' +
      '<g class="rv-gedges">' + lines + '</g>' + roomNodes + personNodes + '</svg>';
    var treeBtn = $('#rv-tree');
    if (treeBtn) treeBtn.onclick = function () { S.showTree = !S.showTree; renderGraph(); };
    var allBtn = $('#rv-all');
    if (allBtn) allBtn.onclick = function () { S.showAll = !S.showAll; renderGraph(); };
    bindGraph(convsEl.querySelector('.rv-graph'));
    convsEl.querySelectorAll('[data-room]').forEach(function (el) { el.onclick = function () { if (S.gmoved) return; loadRoom(el.getAttribute('data-room')); }; });
    convsEl.querySelectorAll('[data-node]').forEach(function (el) { el.onclick = function () { if (S.gmoved) return; loadWizard(el.getAttribute('data-node')); }; });
  };

  // ── 右侧 ───────────────────────────────────────────────────────────
  var chip = function (text, cls) { return text ? '<span class="rv-chip' + (cls ? ' ' + cls : '') + '">' + esc(text) + '</span>' : ''; };
  var ST_CLS = { done: 'ok', passed: 'ok', canceled: 'warn', need: 'ask', progress: 'go', error: 'bad' };
  var KIND_TAG = { ask: '问', task: '派', reply: '答', file: '文件', 'join-req': '申请入群', system: '系统', trigger: '定时' };

  var header = function (title, sub, acts) {
    chWho.innerHTML = '<div class="rv-ttl">' + title + '</div>' + (sub ? '<div class="rv-sub">' + sub + '</div>' : '');
    chActs.innerHTML = acts || '';
    var b = $('#rv-charter'); if (b) b.onclick = function () { toggleCharter(); };
    var r = $('#rv-refresh'); if (r) r.onclick = function () { reload(); };
    var s = $('#rv-session'); if (s) s.onchange = function () { D.session = s.value; loadWizard(D.role, true); };
    var a = $('#rv-all'); if (a) a.onclick = function () { D.all = !D.all; syncUrl(); loadWizard(D.role, true); };
  };
  var nodeNameOf = function (who) {
    if (!who) return '';
    for (var i = 0; i < D.members.length; i++) if (D.members[i].id === who.id) return D.members[i].name;
    return nodeOf(nodeIdOf(who)).name || who.id;
  };
  var viaText = function (m) {
    var via = { founder: '建群', invite: '被邀请', approve: '批准入群', mention: '被点名', spawn: '派生', transfer: '移交', inbound: '从聊天加入', migrate: '迁移' }[m.via] || m.via;
    return m.name + ' · ' + via + ' · ' + fmtDay(m.since) + (m.className ? ' · ' + m.className : '');
  };
  var memberBar = function () {
    if (!D.members || !D.members.length) { membar.hidden = true; membar.innerHTML = ''; return; }
    membar.hidden = false;
    var chips = D.members.map(function (m) {
      var cls = 'rv-mem ' + m.kind + (m.busy ? ' busy' : m.alive ? ' alive' : '') + (m.host ? ' host' : '');
      return '<span class="' + cls + '" data-node="' + esc(m.id) + '" title="' + esc(viaText(m)) + '">' + (m.host ? '⭐ ' : '') + esc(m.name) + (m.foreign ? ' ↗' : '') + '</span>';
    }).join('');
    var duties = (D.duties || []).length
      ? '<span class="rv-duties" title="' + esc(D.duties.map(function (d) { return '#' + d.seq + ' ' + d.askerName + ' · ' + d.kind; }).join('\n')) + '">未决 ' + D.duties.length + '</span>'
      : '';
    membar.innerHTML = chips + duties;
    membar.querySelectorAll('[data-node]').forEach(function (el) { el.onclick = function () { loadWizard(el.getAttribute('data-node')); }; });
  };
  var msgHTML = function (m, ctx) {
    var author = nodeIdOf(m.author);
    var me = D.mode === 'wizard' && m.author.kind === 'wizard' && (author === D.role || (D.uid && m.author.id === D.uid));
    var to = (m.to || []).map(function (t) { return '<span class="rv-tag" data-node="' + esc(nodeIdOf(t)) + '">' + esc(nodeNameOf(t)) + '</span>'; }).join(', ');
    var re = (m.re || []).map(function (id) { return chip('↩ ' + String(id).split('.').pop(), 're'); }).join('');
    var room = ctx && m.roomLabel ? '<span class="rv-roomtag" data-jump-room="' + esc(m.room) + '">' + esc(m.roomLabel) + '</span>' : '';
    var files = (m.files || []).map(function (f) { return chip('📎 ' + f.name, 'file'); }).join('');
    var turn = m.turn ? '<button class="rv-open" data-turn="' + esc(m.turn) + '">过程</button>' : '';
    return '<article class="rv-msg' + (me ? ' me' : '') + ' k-' + esc(m.kind) + '" data-id="' + esc(m.id) + '">' +
      '<div class="rv-mh">' + room +
      '<span class="rv-au ' + esc(m.author.kind) + '" data-node="' + esc(author) + '">' + esc(m.authorName) + '</span>' +
      (to ? '<span class="rv-to">→ ' + to + '</span>' : '') +
      chip(KIND_TAG[m.kind] || '', 'kind') +
      (m.status ? chip(m.status, 'st ' + (ST_CLS[m.status] || '')) : '') +
      re + files +
      '<time>' + esc(fmtDay(m.at)) + '</time>' + turn +
      '</div>' +
      '<div class="rv-tx">' + (m.text && m.text.trim() ? md(m.text) : '<p class="rv-empty">(无正文)</p>') + '</div>' +
      '<div class="rv-box" hidden></div>' +
      '</article>';
  };
  var listHTML = function (msgs, ctx) {
    if (!msgs.length) return '<div class="rv-none">这里还没有消息。</div>';
    return msgs.map(function (m) { return msgHTML(m, ctx); }).join('');
  };
  var plansSection = function () {
    var ps = D.plans || [], ss = D.schedules || [];
    if (!ps.length && !ss.length) return '';
    var li = function (x) { return '<li>' + x + '</li>'; };
    return '<section class="rv-plans"><h4>计划</h4><ul>' + ps.map(function (p) { return li(esc(p.state) + ' · ' + esc(p.title || p.id) + ' · ' + (p.tasks || []).length + ' 步'); }).join('') + '</ul>' +
      '<h4>日程</h4><ul>' + ss.map(function (s) { return li('⏰ ' + esc(s.when) + ' · ' + esc(s.note || s.prompt || '').slice(0, 60)); }).join('') + '</ul></section>';
  };

  // ── 载入 / 渲染 ────────────────────────────────────────────────────
  var scrollState = function () {
    return { top: thread.scrollTop, pinned: thread.scrollHeight - thread.scrollTop - thread.clientHeight < 90 };
  };
  var restore = function (st) { thread.scrollTop = st.pinned ? thread.scrollHeight : st.top; };
  var scrollBottom = function () { thread.scrollTop = thread.scrollHeight; };
  var renderRoom = function () {
    var r = D.room || { id: D.roomId, kind: 'wecom-group', members: [], openDuties: 0 };
    var label = D.label || roomLabelOf(r);
    var host = r.host ? nodeOf(nodeIdOf(r.host)).name : '无人 (人兜底)';
    var sub = [chip(KIND_IC[r.kind] || '·', 'kind'), chip('host ' + host), chip(r.openDuties ? '未决 ' + r.openDuties : '无未决', r.openDuties ? 'warn' : ''), chip(r.bound ? '已绑定企微' : '仅 rolepage')].join('');
    header(esc(label), sub, '<button class="rv-act" id="rv-refresh">刷新</button>');
    memberBar();
    var older = D.earlier ? '<button class="rv-older" id="rv-older">‹ 更早</button>' : '';
    inner.innerHTML = older + listHTML(D.msgs, false);
    var o = $('#rv-older'); if (o) o.onclick = function () { olderPage(); };
    restoreOpen();
    renderGraph();
  };
  var renderWizard = function () {
    var w = D.wizard || { name: D.role, label: '🧙‍♂️' };
    var sub = [
      w.description ? '<span class="rv-desc">' + esc(w.description) + '</span>' : '',
      chip(w.model || '模型未记', 'kind'), w.cli ? chip(w.cli, 'kind') : '',
      chip(w.busy ? '执行中' : w.alive ? '在线' : '冷', w.busy ? 'go' : w.alive ? 'ok' : ''),
      w.waiting && w.waiting.length ? chip('等审批: ' + w.waiting.join(','), 'warn') : '',
      w.parent ? chip('来自 ' + (w.parent.name || w.parent.id), 'kind') : '',
    ].join('');
    var sess = '<select id="rv-session" class="rv-sel">' + ['<option value="all">全部会话</option>'].concat((D.sessions || []).map(function (s, i) {
      return '<option value="' + esc(s.sessionId) + '"' + (D.session === s.sessionId ? ' selected' : '') + '>' + esc('#' + (i + 1) + ' · ' + fmtDay(s.start) + ' · ' + s.turns + ' 轮') + '</option>';
    })).join('') + '</select>';
    header('<span class="rv-lb">' + esc(w.label || '🧙‍♂️') + '</span> ' + esc(w.name || D.role) + ' <span class="rv-id">' + esc(D.role) + '</span>', sub,
      sess + '<button class="rv-act' + (D.all ? ' on' : '') + '" id="rv-all">' + (D.all ? 'W-2 全部' : 'W-1 与我相关') + '</button>' +
      '<button class="rv-act" id="rv-charter">宪章</button><button class="rv-act" id="rv-refresh">刷新</button>');
    membar.hidden = true; membar.innerHTML = '';
    var older = D.earlier ? '<button class="rv-older" id="rv-older">‹ 更早</button>' : '';
    var note = D.ledger ? '' : '<div class="rv-note">这个部署没有 room 账本 — 只能看名片, 看不到消息 (要历史请打开 daemon 的 rolepage)。</div>';
    inner.innerHTML = note + older + listHTML(D.msgs, true) + plansSection() + (S.charter ? '<section class="rv-charter">' + S.charter + '</section>' : '');
    var o = $('#rv-older'); if (o) o.onclick = function () { olderPage(); };
    restoreOpen();
    renderGraph();
  };
  var loadRoom = function (id) {
    D.mode = 'room'; D.roomId = id; D.role = ''; S.charter = null; syncUrl();
    return api('api/room', { room: id, limit: 60 }).then(function (r) {
      if (!r.ok) { inner.innerHTML = '<div class="rv-none">' + esc(r.error || '加载失败') + '</div>'; return; }
      D.room = r.room; D.label = r.label || ''; D.members = r.members || []; D.duties = r.duties || [];
      D.msgs = r.msgs || []; D.total = r.total || 0; D.earlier = r.earlier || ''; D.at = r.at;
      renderRoom(); scrollBottom();
    });
  };
  var loadWizard = function (role, keepScroll) {
    D.mode = 'wizard'; D.role = role; D.roomId = ''; syncUrl();
    var st = scrollState();
    return api('api/wizard', { role: role, all: D.all ? '1' : '', session: D.session === 'all' ? '' : D.session, limit: 60 }).then(function (r) {
      if (!r.ok) { inner.innerHTML = '<div class="rv-none">' + esc(r.error || '加载失败') + '</div>'; return; }
      D.wizard = r.role; D.uid = r.uid || ''; D.msgs = r.msgs || []; D.total = r.total || 0; D.earlier = r.earlier || '';
      D.sessions = r.sessions || []; D.session = r.session || 'all'; D.ledger = r.ledger !== false;
      D.plans = r.plans || []; D.schedules = r.schedules || []; D.at = r.at;
      D.members = []; D.duties = [];
      renderWizard();
      if (keepScroll) restore(st); else scrollBottom();
    });
  };
  var reload = function () {
    if (D.mode === 'room') return loadRoom(D.roomId);
    if (D.mode === 'wizard') return loadWizard(D.role, true);
  };
  var olderPage = function () {
    if (!D.earlier) return;
    var before = D.earlier, prevH = thread.scrollHeight, prevTop = thread.scrollTop;
    var p = D.mode === 'room'
      ? api('api/room', { room: D.roomId, before: before, limit: 60 })
      : api('api/wizard', { role: D.role, before: before, all: D.all ? '1' : '', session: D.session === 'all' ? '' : D.session, limit: 60 });
    return p.then(function (r) {
      if (!r.ok) return;
      D.msgs = (r.msgs || []).concat(D.msgs);
      D.earlier = r.earlier || '';
      if (D.mode === 'room') renderRoom(); else renderWizard();
      thread.scrollTop = prevTop + (thread.scrollHeight - prevH);
    });
  };

  // ── 过程框 ─────────────────────────────────────────────────────────
  var restoreOpen = function () {
    Object.keys(S.openTurns).forEach(function (id) {
      var a = inner.querySelector('.rv-msg[data-id="' + cssEsc(id) + '"]');
      if (!a) return;
      var box = a.querySelector('.rv-box');
      if (!box) return;
      box.hidden = false;
      box.innerHTML = S.openTurns[id];
    });
  };
  // 展开态按消息 id 记在 S.openTurns 里, 每次重画都按它回填 —— 4s 的轮询会把 innerHTML
  // 整个换掉, 只写 DOM 的话展开会闪一下就被收起。
  var setBox = function (id, html) {
    S.openTurns[id] = html;
    var a = inner.querySelector('.rv-msg[data-id="' + cssEsc(id) + '"]');
    if (!a) return;
    var box = a.querySelector('.rv-box');
    if (!box) return;
    box.hidden = false;
    box.innerHTML = html;
  };
  /** id = 消息 id (定位那一条的盒子), turnId = 产出它的那一轮 (取过程框)。 */
  var toggleTurn = function (id, turnId) {
    var a = inner.querySelector('.rv-msg[data-id="' + cssEsc(id) + '"]');
    if (!a) return;
    var box = a.querySelector('.rv-box');
    if (!box) return;
    if (!box.hidden) { box.hidden = true; delete S.openTurns[id]; return; }
    if (S.openTurns[id]) { setBox(id, S.openTurns[id]); return; }
    setBox(id, '<div class="rv-none">加载中…</div>');
    api('api/turn', { turn: turnId }).then(function (r) {
      setBox(id, r.ok ? r.html : '<div class="rv-none">' + esc(r.error || '取不到这一轮') + '</div>');
    });
  };
  // 工具调用正文: 过程框里的 .tool-body 是空壳 (data-lazy-turn / data-lazy-use), 展开那一刻才取。
  var loadTool = function (d) {
    var body = d.querySelector('.tool-body');
    if (!body || !body.hasAttribute('data-lazy-turn') || body._busy || body.firstChild) return;
    body._busy = true;
    api('api/tool', { turn: body.getAttribute('data-lazy-turn'), use: body.getAttribute('data-lazy-use') }).then(function (r) {
      body.innerHTML = r.ok ? r.html : esc(r.error || '取不到');
    }).catch(function () { body.setAttribute('data-err', '1'); }).then(function () { body._busy = false; });
  };
  inner.addEventListener('toggle', function (e) {
    var d = e.target;
    if (d.open && d.classList && d.classList.contains('tool-call')) loadTool(d);
  }, true);

  // ── 宪章 ───────────────────────────────────────────────────────────
  var toggleCharter = function () {
    if (S.charter) { S.charter = null; if (D.mode === 'wizard') renderWizard(); return; }
    api('api/charter', { role: D.role }).then(function (r) {
      if (!r.ok) S.charter = '<div class="rv-none">' + esc(r.error || '取不到宪章') + '</div>';
      else if (r.none) S.charter = '<div class="rv-none">这个 wizard 没有留下宪章记录。</div>';
      else S.charter = '<h4>宪章 · ' + esc(r.tokens) + ' tokens · ' + esc(fmtDay(r.at)) + '</h4>' +
        (r.sections || []).map(function (s) { return '<h5>' + esc(s.title || '') + ' · ' + esc(s.tokens) + ' tokens</h5><pre>' + esc(s.body || '') + '</pre>'; }).join('');
      if (D.mode === 'wizard') renderWizard();
    });
  };

  // ── 世界 ───────────────────────────────────────────────────────────
  var worldReq = null;
  var loadWorld = function () {
    if (worldReq) return worldReq;
    worldReq = api('api/world', { role: ROLE || '' }).then(function (r) {
      worldReq = null;
      if (!r.ok) { convsEl.innerHTML = '<div class="rv-none">' + esc(r.error || '世界视图加载失败') + '</div>'; return; }
      W.at = r.at; W.rooms = r.rooms || []; W.nodes = r.nodes || []; W.edges = r.edges || [];
      W.uidTargets = r.uidTargets || {}; W.chatNames = r.chatNames || {}; W.names = r.names || {}; W.degraded = !!r.degraded;
      renderGraph();
      return r;
    }).catch(function () { worldReq = null; });
    return worldReq;
  };

  // ── 事件 / 轮询 ────────────────────────────────────────────────────
  inner.addEventListener('click', function (e) {
    var t = e.target;
    if (!t.closest) return;
    var g = t.closest('[data-node]');
    if (g) { var id = g.getAttribute('data-node'); if (id) { loadWizard(id); return; } }
    var j = t.closest('[data-jump-room]');
    if (j) { loadRoom(j.getAttribute('data-jump-room')); return; }
    var b = t.closest('.rv-open');
    if (b) {
      var msg = t.closest('.rv-msg');
      toggleTurn(msg.getAttribute('data-id'), b.getAttribute('data-turn'));
      return;
    }
  });
  // room 账本没有订阅口子 (daemon 的 store 只管落盘), 页面自己定时取。
  var tick = function () {
    if (document.hidden) return;
    var st = scrollState();
    if (D.mode === 'room') loadRoom(D.roomId).then(function () { restore(st); });
    else if (D.mode === 'wizard') loadWizard(D.role, true);
  };
  setInterval(tick, TICK_MS);
  setInterval(function () { if (!document.hidden) loadWorld(); }, WORLD_MS);

  // ── 启动 ───────────────────────────────────────────────────────────
  var boot = function () {
    loadWorld().then(function () {
      if (ROOM) return loadRoom(ROOM);
      if (ROLE) return loadWizard(ROLE);
      var first = (W.rooms || [])[0];
      if (first) return loadRoom(first.id);
      inner.innerHTML = '<div class="rv-none">还没有 room —— 说一句话, 或者在群里 .name 点名一个 wizard。</div>';
    });
  };
  // ── 样式: 本页新加的 DOM 只在 chat.js 里, 样式也一并带上 (不改 web/chat.css, 无构建) ──
  var CSS = ".convs { overflow: auto; padding: 0 }\n.rv-ghead { display: flex; align-items: center; justify-content: space-between; gap: 6px; padding: 8px 10px 4px; color: var(--faint); font-size: 11.5px }\n.rv-tree-t { border: 1px solid var(--line); background: var(--card); border-radius: 6px; padding: 1px 7px; font-size: 11.5px; cursor: pointer; color: var(--mute) }\n.rv-tree-t.on { color: var(--accent); border-color: var(--accent) }\n.rv-gbtns { display: inline-flex; gap: 4px }\n.rv-graph { display: block; font: 11.5px/1 -apple-system, BlinkMacSystemFont, sans-serif; cursor: grab; touch-action: none; user-select: none }\n.rv-edge { stroke: #c9d2df; stroke-width: 1 }\n.rv-edge.on { stroke: var(--accent); stroke-width: 1.6 }\n.rv-tree { fill: none; stroke: #b9a0e0; stroke-dasharray: 3 3 }\n.rv-node { cursor: grab }\n.rv-room rect { fill: var(--them); stroke: var(--line) }\n.rv-room text { fill: var(--ink) }\n.rv-room.on rect { fill: var(--mine); stroke: var(--accent) }\n.rv-person circle { fill: var(--card); stroke: var(--mute); stroke-width: 1.4 }\n.rv-person circle.live { fill: var(--accent); stroke: var(--accent) }\n.rv-person.human circle { stroke: var(--human) }\n.rv-person text { fill: var(--ink); font-size: 10.5px }\n.rv-room text { font-size: 11px }\n.rv-person.on circle { stroke: var(--accent); stroke-width: 2.4 }\n.rv-person.ghost { opacity: .5 }\n.rv-duty { fill: #cf222e }\n.rv-ttl { font-size: 15.5px; line-height: 22px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap }\n.rv-sub { display: flex; flex-wrap: wrap; gap: 4px 6px; align-items: center; margin-top: 3px; font-size: 11.5px; color: var(--mute) }\n.rv-id { font-size: 11px; color: var(--faint); font-weight: 400 }\n.rv-lb { font-size: 15px }\n.rv-desc { max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap }\n.rv-chip { display: inline-flex; align-items: center; padding: 0 6px; border-radius: 999px; background: var(--them); color: var(--mute); font-size: 11px; line-height: 17px; white-space: nowrap }\n.rv-chip.ok { background: #e8f5ee; color: #1a7f3c }\n.rv-chip.warn { background: #fdf1e3; color: #9a5b10 }\n.rv-chip.ask, .rv-chip.bad { background: #fdecec; color: #b42318 }\n.rv-chip.go { background: var(--mine); color: var(--accent) }\n.rv-chip.file { background: var(--them-soft) }\n.rv-chip.re { background: transparent; color: var(--faint); border: 1px solid var(--line) }\n.rv-act { border: 1px solid var(--line); background: var(--card); border-radius: 7px; padding: 2px 9px; font-size: 12px; cursor: pointer; color: var(--mute) }\n.rv-act:hover, .rv-act.on { color: var(--accent); border-color: var(--accent) }\n.rv-sel { border: 1px solid var(--line); background: var(--card); border-radius: 7px; padding: 2px 4px; font-size: 12px; color: var(--mute); max-width: 190px }\n.ch-acts { display: flex; gap: 6px; align-items: center; flex-wrap: wrap }\n.membar { display: flex; flex-wrap: wrap; gap: 4px 6px; align-items: center; padding: 5px 12px; border-bottom: 1px solid var(--line); background: var(--card); font-size: 11.5px }\n.rv-mem { display: inline-flex; align-items: center; gap: 3px; padding: 0 7px; border-radius: 999px; background: var(--them); color: var(--ink); cursor: pointer; line-height: 18px }\n.rv-mem.host { background: var(--mine); color: var(--accent) }\n.rv-mem.human { color: var(--human) }\n.rv-mem.busy { box-shadow: inset 0 0 0 1px var(--accent) }\n.rv-duties { margin-left: auto; color: #b42318 }\n.rv-older { display: block; margin: 8px auto; border: 1px solid var(--line); background: var(--card); border-radius: 999px; padding: 2px 12px; font-size: 12px; color: var(--mute); cursor: pointer }\n.rv-msg { margin: 8px 12px; padding: 7px 10px; background: var(--card); border: 1px solid var(--line); border-radius: 10px }\n.rv-msg.me { background: var(--mine); border-color: var(--mine-line) }\n.rv-msg.k-system { background: var(--them); border-style: dashed }\n.rv-mh { display: flex; flex-wrap: wrap; gap: 4px 6px; align-items: center; font-size: 11.5px; color: var(--mute) }\n.rv-au { font-weight: 600; color: var(--ink); cursor: pointer }\n.rv-au:hover { text-decoration: underline dotted var(--faint); text-underline-offset: 3px }\n.rv-au.human { color: var(--human) }\n.rv-au.daemon { color: var(--wezard) }\n.rv-tag { color: var(--accent); cursor: pointer }\n.rv-roomtag { color: var(--chat); cursor: pointer; border: 1px solid var(--line); border-radius: 999px; padding: 0 6px }\n.rv-mh time { margin-left: auto; color: var(--faint) }\n.rv-open { border: 1px solid var(--line); background: transparent; border-radius: 6px; padding: 0 6px; font-size: 11px; color: var(--faint); cursor: pointer }\n.rv-open:hover { color: var(--accent); border-color: var(--accent) }\n.rv-tx { margin-top: 4px; font-size: 13.5px; line-height: 1.6; overflow-wrap: anywhere }\n.rv-tx p { margin: 3px 0 }\n.rv-tx pre { background: var(--them); padding: 6px 8px; border-radius: 6px; overflow: auto; font-size: 12px }\n.rv-tx a { color: var(--accent) }\n.rv-empty { color: var(--faint); font-size: 12px; margin: 0 }\n.rv-box { margin-top: 7px; padding-top: 7px; border-top: 1px dashed var(--line) }\n.rv-box .turn-group { margin: 0 }\n.rv-none { padding: 14px; color: var(--faint); font-size: 12.5px }\n.rv-note { margin: 8px 12px; padding: 7px 10px; border-radius: 8px; background: #fdf1e3; color: #9a5b10; font-size: 12px }\n.rv-plans, .rv-charter { margin: 12px; padding: 8px 10px; border: 1px solid var(--line); border-radius: 10px; background: var(--card); font-size: 12px }\n.rv-plans h4, .rv-charter h4 { margin: 6px 0 2px; font-size: 11.5px; color: var(--faint); font-weight: 600 }\n.rv-plans ul { margin: 0; padding-left: 16px }\n.rv-charter h5 { margin: 8px 0 2px; font-size: 11.5px; color: var(--faint) }\n.rv-charter pre { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; font-size: 11.5px; color: var(--mute) }";
  var injectStyle = function () {
    if (document.getElementById('rv-style')) return;
    var s = document.createElement('style');
    s.id = 'rv-style';
    s.textContent = CSS;
    document.head.appendChild(s);
  };
  injectStyle();
  boot();
})();
