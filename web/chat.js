// Rolepage SPA —— room 模型之后的一页 IM。
//
//   左栏  力导向图: room 胶囊 ↔ 参与者圆点 (点 room 看历史, 点 wizard 看它说的 + 指向它的);
//         家谱 (谁生的谁) 是可切换的一层虚线。
//   右栏  room 历史 (author / to / re / status 都是账本行上的显式字段, 点一条消息可以展开
//         产出它的那一轮的过程框), 或一个 wizard 的消息: 「只看与我相关」(默认) / 「全部消息」。
//
// 数据面 (全部 GET, ?id= 是票据): /api/world · /api/room · /api/wizard · /api/turn · /api/tool
// 左栏两种视图可切换 (人 2026-11-20): 列表 = room 按「群聊」(有人参与) /「会话」(只有 wizard)
// 两组, 图 = 上面的二部图; 名片下是搜索入口 (⌘K: room 名 / 成员 / 消息)。
// 视角状态 (room / role / all) 全在 URL 里; 左栏视图记在 localStorage。
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
  var gside = $('#gside'), chWho = $('#ch-who'), chActs = $('#ch-acts');

  var W = { at: 0, rooms: [], nodes: [], uidTargets: {}, chatNames: {}, names: {}, degraded: false };
  var D = { mode: '', roomId: '', role: '', uid: '', at: 0, msgs: [], total: 0, earlier: '', room: null, label: '', members: [], duties: [], wizard: null, sessions: [], session: 'all', all: qs.get('all') === '1', ledger: true, plans: [], schedules: [], charterBrief: null, stream: null, streamSig: '', stats: null };
  var S = { openTurns: {}, charter: null, sim: null, gsig: '', gmap: null, elById: null, lines: null, view: 'list' };
  var SIDE_KEY = 'wezard.role.side';
  try { if (localStorage.getItem(SIDE_KEY) === 'graph') S.view = 'graph'; } catch (e) { /* 隐私模式 */ }
  // 时间范围 (列表与图共用): room 的动静与人动过都按这一刀, 有未决 duty 的 room 和活着 / 在跑 / 是 host 的人照旧总在。
  // 选中的那档与左栏视图开关一样记在 localStorage, 默认 2d。
  var WIN_KEY = 'wezard.role.winMin';
  var WINS = [[60, '1h'], [120, '2h'], [360, '6h'], [720, '12h'], [1440, '1d'], [2880, '2d'], [0, '全部']];
  var WIN = 2880;
  try {
    var winSaved = localStorage.getItem(WIN_KEY);
    if (winSaved !== null && WINS.some(function (w) { return String(w[0]) === winSaved; })) WIN = +winSaved;
  } catch (e) { /* 隐私模式 */ }
  var winLabel = function () {
    for (var i = 0; i < WINS.length; i++) if (WINS[i][0] === WIN) return WINS[i][1];
    return '2d';
  };
  var winCut = function () { return WIN ? srvNow() - WIN * 60000 : 0; };
  var inWin = function (ts) { return !WIN || (!!ts && ts >= winCut()); };

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
  var fmtClock = function (ts) {
    var d = new Date(ts);
    return pad(d.getHours()) + ':' + pad(d.getMinutes());
  };
  var fmtAgo = function (ts) {
    if (!ts) return '';
    var s = Math.max(0, (Date.now() - ts) / 1000);
    if (s < 60) return '刚刚';
    if (s < 3600) return Math.floor(s / 60) + ' 分钟前';
    if (s < 86400) return Math.floor(s / 3600) + ' 小时前';
    return Math.floor(s / 86400) + ' 天前';
  };
  var fmtTok = function (n) {
    if (!n) return '0';
    if (n < 1000) return String(n);
    if (n < 1e6) { var v = n / 1000; return (v >= 10 ? v.toFixed(0) : v.toFixed(1).replace(/\.0$/, '')) + 'k'; }
    return (n / 1e6).toFixed(2).replace(/\.?0+$/, '') + 'M';
  };
  var shortCwd = function (p) {
    var seg = String(p || '').split('/').filter(Boolean);
    return seg.length <= 2 ? (p || '') : '…/' + seg.slice(-2).join('/');
  };
  var copyText = function (t) {
    try { if (navigator.clipboard) navigator.clipboard.writeText(t); } catch (e) { /* 忽略: 复制失败不影响看 */ }
  };
  var mdInst = function () {
    if (!window.markdownit) return null;
    if (!mdInst._i) {
      mdInst._i = window.markdownit({ html: false, linkify: true, breaks: true,
        highlight: function (str, lang) {
          if (window.hljs) {
            try {
              return lang
                ? window.hljs.highlight(str, { language: lang, ignoreIllegals: true }).value
                : window.hljs.highlightAuto(str).value;
            } catch (e) { /* 退回落语言的高亮 */ }
          }
          return '';
        } });
    }
    return mdInst._i;
  };
  var md = function (text) {
    var i = null;
    try { i = mdInst(); } catch (e) { /* 退回纯文本 */ }
    if (i) return i.render(String(text || ''));
    return '<p>' + esc(text).replace(/\n/g, '<br>') + '</p>';
  };
  // 服务端渲染的 turn 片段把正文原文放在 <script class=md-src> 里 (免转义歧义),
  // 由页面填进 .md-body —— 711353b 换读侧时把这一步丢了, 气泡只剩空壳。
  var fillMd = function (scope) {
    var i = null;
    try { i = mdInst(); } catch (e) { return; }
    if (!i || !scope) return;
    scope.querySelectorAll('.bubble').forEach(function (b) {
      var src = b.querySelector('script.md-src'), body = b.querySelector('.md-body');
      if (!src || !body || body.dataset.rendered === '1') return;
      var lead = body.querySelector(':scope > .to-in');
      body.innerHTML = i.render(src.textContent || '');
      if (lead) {
        var p = body.firstElementChild;
        (p && p.tagName === 'P' ? p : body).prepend(lead, ' ');
      }
      body.dataset.rendered = '1';
    });
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
  // room 的名字 = 它的显示名 (host 起的 title > 聊天名 > 一个短代号)。
  // 不再用「N 人」或全量成员名当名字 —— 成员是侧栏的事 (gside)。
  var shortRoom = function (id) {
    var s = String(id || '');
    if (/^dm:/.test(s)) return '私聊';
    if (/^adhoc:/.test(s)) return '临时 room';
    var kind = /^user:/.test(s) ? '单聊' : /^chat:wx/.test(s) ? '微信' : '群';
    var tail = s.replace(/^[a-z-]+:/, '').slice(-6);
    return tail ? kind + ' …' + tail : (s || 'room');
  };
  var roomById = function (id) {
    for (var i = 0; i < W.rooms.length; i++) if (W.rooms[i].id === id) return W.rooms[i];
    return null;
  };
  /** 服务端给的 label (可能是成员名拼的) 只在它没有拿成员凑数时才认。 */
  var roomNameOf = function (r, fallback) {
    if (!r) return fallback && fallback.indexOf(' ↔ ') < 0 ? fallback : shortRoom(fallback);
    if (r.title) return r.title;
    if (W.chatNames[r.id]) return W.chatNames[r.id];
    return fallback && fallback.indexOf(' ↔ ') < 0 ? fallback : shortRoom(r.id);
  };
  var roomLabelOf = function (r) {
    return r ? roomNameOf(r, r.label) : '';
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
      if (n.kind === 'human' || n.self) return true;
      if (n.alive || n.busy || (n.runningUntil && n.runningUntil > Date.now())) return true;
      if (hosts[n.target]) return true;
      return inWin(n.lastTs);
    });
  };
  // ── 力导向图 ───────────────────────────────────────────────────────
  //  room = 胶囊, wizard / user = 圆点, 边 = 成员关系 (家谱另开一层虚线)。
  //  无依赖的 FR 式模拟: 斥力 + 弹簧 + 向心 + 碰撞, 冷却到定稿; 拖节点会钉住它并重算,
  //  滚轮缩放 / 拖空白平移只改 viewBox, 不动节点坐标; 双击回到自动适配。
  var G_ITER = 240;
  // 只有两位成员的 room 不占节点: 在两人之间直接连一条线 (点线 = 打开那个 room)。
  var directPair = function (r, people) {
    var ids = {};
    (r.members || []).forEach(function (m) { var id = nodeIdOf(m.who); if (id) ids[id] = true; });
    var ks = Object.keys(ids);
    if (ks.length !== 2) return null;
    var have = {};
    people.forEach(function (p) { have[p.target] = true; });
    return have[ks[0]] && have[ks[1]] ? ks : null;
  };
  var buildGraph = function (rooms, people, directs) {
    var nodes = [], index = {};
    // 种子按竖长的椭圆撒 —— 左栏是高窄的一条, 圆形撒点会被压成上半截
    var panelW = Math.max(240, (convsEl.clientWidth || 332) - 12);
    var panelH = Math.max(300, (convsEl.clientHeight || 620) - 30);
    var hw = Math.max(104, Math.min(panelW * 0.46, Math.sqrt(rooms.length + people.length) * 26));
    var hh = hw * Math.max(1.4, Math.min(2.2, panelH / panelW));
    // 拓扑没变时沿用上一轮的对象: 拖过的位置、速度都留着, 定时刷新不会把图弹回原样。
    var prev = S.gmap || {};
    var add = function (n) {
      var old = prev[n.id];
      if (old) { n.x = old.x; n.y = old.y; n.vx = old.vx; n.vy = old.vy; n.fx = old.fx; n.fy = old.fy; }
      index[n.id] = nodes.length; nodes.push(n);
    };
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
        links.push({ a: index['r:' + r.id], b: index[pid], room: r.id });
      });
    });
    // 两人 room: 线直接落在两个人之间 (room 本身没有节点); 有未决 duty 算未读, 画浅红。
    (directs || []).forEach(function (d) {
      links.push({ a: index['p:' + d.pair[0]], b: index['p:' + d.pair[1]], room: d.room.id, direct: true, unread: d.room.openDuties > 0 });
    });
    return { nodes: nodes, links: links, index: index, hw: hw, hh: hh };
  };
  var simulateGraph = function (g, iter, draw) {
    var ns = g.nodes, n = ns.length;
    if (!n) return null;
    var k = Math.max(46, Math.min(110, 2 * Math.sqrt((g.hw * g.hh) / n)));
    // 随包分发的 d3 (web/d3.min.js → /chat/vendor.js) 在, 就用它的力导向模拟。
    var d3 = window.d3;
    if (d3 && d3.forceSimulation) {
      ns.forEach(function (p) {
        var pin = S.gpos && S.gpos[p.id];
        if (pin) { p.fx = pin.x; p.fy = pin.y; }
      });
      var dl = g.links.map(function (l) { return { source: ns[l.a], target: ns[l.b] }; });
      var sim = d3.forceSimulation(ns)
        .force("link", d3.forceLink(dl).id(function (p) { return p.id; })
          .distance(k * 0.85)
          .strength(0.6))
        .force("charge", d3.forceManyBody().strength(-k * 2).distanceMax(k * 5))
        .force("collide", d3.forceCollide(function (p) {
          return (p.isRoom ? p.w / 2 : Math.max(p.r + 4, Math.min(46, (p.ref.name || "").length * 3.2))) + 6;
        }).iterations(2))
        .force("x", d3.forceX(0).strength(0.12))
        .force("y", d3.forceY(0).strength(0.12))
        .stop();
      if (draw) sim.on("tick", draw);
      sim.tick(iter);
      if (draw) draw();
      return sim;
    }
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
        var want = k * 0.95;
        var sf = ((sd - want) / sd) * 0.09 * alpha;
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
    if (draw) draw();
    return null;
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
      S.gdrag = start.id;
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
        // 直接把 d3 的钉子挪过去并升温: 邻居跟着走, 松手也不会重置布局。
        var node = S.g && S.g.index ? S.g.nodes[S.g.index[start.id]] : null;
        if (node) {
          // 只搬这一个节点: 不升温、不重排 —— 不然整张图会一起漂, 看着就像没抓住。
          node.x = w.x; node.y = w.y; node.fx = w.x; node.fy = w.y;
          if (S.g) drawPos(S.g);
        }
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
      start = null;
      S.gdrag = '';
      try { svg.releasePointerCapture(e.pointerId); } catch (err) { /* 已释放 */ }
      if (S.sim) S.sim.alphaTarget(0);   // 留在原地, 不重新排布
    };
    svg.onpointerup = stop;
    svg.onpointercancel = stop;
    svg.onwheel = function (e) {
      e.preventDefault();
      var z = Math.max(0.35, Math.min(4, (S.gzoom || 1) * (e.deltaY < 0 ? 1.12 : 0.89)));
      var f = (S.gzoom || 1) / z;
      S.gzoom = z;
      var b = svg.viewBox.baseVal;
      svg.setAttribute('viewBox', [(b.x + (b.width * (1 - f)) / 2), (b.y + (b.height * (1 - f)) / 2), b.width * f, b.height * f]
        .map(function (v) { return v.toFixed(1); }).join(' '));
    };
    svg.ondblclick = function () { S.gzoom = 1; S.gpx = 0; S.gpy = 0; S.gpos = {}; S.gsig = ''; renderGraph(); };
    svg.onclick = function () { setTimeout(function () { S.gmoved = false; }, 0); };
  };
  var viewBoxOf = function (g) {
    var minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9;
    g.nodes.forEach(function (p) {
      var hw = p.isRoom ? p.w / 2 + 4 : Math.max(p.r + 6, Math.min(52, (p.ref.name || "").length * 3.4)),
        hh = p.isRoom ? 12 : p.r + 16;
      minX = Math.min(minX, p.x - hw); maxX = Math.max(maxX, p.x + hw);
      minY = Math.min(minY, p.y - hh); maxY = Math.max(maxY, p.y + hh);
    });
    if (!g.nodes.length) { minX = minY = maxX = maxY = 0; }
    var pad = 26;
    var cxm = (minX + maxX) / 2 + (S.gpx || 0), cym = (minY + maxY) / 2 + (S.gpy || 0);
    var z = S.gzoom || 1;
    var vw = Math.max(80, maxX - minX + pad * 2) / z, vh = Math.max(80, maxY - minY + pad * 2) / z;
    var width = Math.max(240, (convsEl.clientWidth || 332) - 12);
    var height = Math.max(260, (convsEl.clientHeight || 620) - 34);
    var aspect = width / height;
    if (vw / vh < aspect) vw = vh * aspect; else vh = vw / aspect;
    return { box: [cxm - vw / 2, cym - vh / 2, vw, vh], width: width, height: height };
  };
  var drawPos = function (g) {
    var el = S.elById || {};
    g.nodes.forEach(function (p) {
      var e = el[p.id];
      if (e) e.setAttribute('transform', 'translate(' + p.x.toFixed(1) + ' ' + p.y.toFixed(1) + ')');
    });
    (S.lines || []).concat(S.hits || []).forEach(function (ln) {
      var l = g.links[+ln.getAttribute('data-i')];
      if (!l) return;
      var a = g.nodes[l.a], b = g.nodes[l.b];
      ln.setAttribute('x1', a.x.toFixed(1)); ln.setAttribute('y1', a.y.toFixed(1));
      ln.setAttribute('x2', b.x.toFixed(1)); ln.setAttribute('y2', b.y.toFixed(1));
    });
  };
  var renderGraph = function () {
    if (S.gdrag) return;    // 正在拖: 定时刷新别来重建 DOM
    var rooms = (W.rooms || []).slice().sort(function (a, b) { return (b.last ? b.last.at : 0) - (a.last ? a.last.at : 0); });
    if (WIN) rooms = rooms.filter(function (r) { return r.openDuties > 0 || inWin(r.last && r.last.at); });
    var people = participants(rooms).sort(function (a, b) { return (b.lastTs || 0) - (a.lastTs || 0) || (a.name < b.name ? -1 : 1); });
    var directs = [];
    rooms = rooms.filter(function (r) {
      var pair = directPair(r, people);
      if (pair) directs.push({ room: r, pair: pair });
      return !pair;
    });
    var g = buildGraph(rooms, people, directs);
    S.g = g;
    S.gmap = {};
    g.nodes.forEach(function (p) { S.gmap[p.id] = p; });
    var sig = rooms.map(function (r) { return r.id; }).join(',') + '|' +
      directs.map(function (d) { return d.room.id; }).join(',') + '|' +
      people.map(function (p) { return p.target; }).join(',');
    var onRoom = function (id) { return D.mode === 'room' && D.roomId === id; };
    var svg = convsEl.querySelector('.rv-graph');
    // 拓扑没变 (定时刷新 / 换选中): 只刷选中态和 viewBox, 不动坐标 —— 图不会跳回原位。
    if (sig === S.gsig && svg && S.sim) {
      g.nodes.forEach(function (p) {
        var e = S.elById[p.id];
        if (!e) return;
        var on = p.isRoom ? (D.mode === 'room' && D.roomId === p.ref.id) : (D.mode === 'wizard' && D.role === p.ref.target);
        if (on) e.classList.add('on'); else e.classList.remove('on');
      });
      var vb0 = viewBoxOf(g);
      svg.setAttribute('viewBox', vb0.box.map(function (v) { return v.toFixed(1); }).join(' '));
      (S.lines || []).forEach(function (ln) {
        var l = g.links[+ln.getAttribute('data-i')];
        if (l) ln.setAttribute('class', 'rv-edge' + (l.direct && l.unread ? ' unread' : '') + (onRoom(l.room) ? ' on' : ''));
      });
      drawPos(g);
      return;
    }
    if (S.sim) { S.sim.on('tick', null); S.sim.stop(); S.sim = null; }
    var lines = g.links.map(function (l, i) {
      var p = g.nodes[l.a], q = g.nodes[l.b];
      var xy = ' x1="' + p.x.toFixed(1) + '" y1="' + p.y.toFixed(1) + '" x2="' + q.x.toFixed(1) + '" y2="' + q.y.toFixed(1) + '"';
      return '<line' + xy + ' data-i="' + i + '" class="rv-edge' + (l.direct && l.unread ? ' unread' : '') + (onRoom(l.room) ? ' on' : '') + '"/>' +
        // 两人 room 的线细, 另叠一条透明粗线当点击区。
        (l.direct ? '<line' + xy + ' data-i="' + i + '" data-link="' + esc(l.room) + '" class="rv-hit"/>' : '');
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
    convsEl._html = '';
    convsEl.innerHTML = sideHead((rooms.length + directs.length) + ' 个 room · ' + people.length + ' 位参与者' + (WIN ? ' (' + winLabel() + ')' : '')) +
      '<svg class="rv-graph"></svg>';
    var svg2 = convsEl.querySelector('.rv-graph');
    var el = {};
    svg2.querySelectorAll('[data-node]').forEach(function (e) { el['p:' + e.getAttribute('data-node')] = e; });
    svg2.querySelectorAll('[data-room]').forEach(function (e) { el['r:' + e.getAttribute('data-room')] = e; });
    // 先填内容再启模拟: tick 直接更新这些元素, 拖动时邻居会跟着动, 不用重建 DOM。
    svg2.innerHTML = '<g class="rv-gedges">' + lines + '</g>' + roomNodes + personNodes;
    el = {};
    svg2.querySelectorAll('[data-node]').forEach(function (e) { el['p:' + e.getAttribute('data-node')] = e; });
    svg2.querySelectorAll('[data-room]').forEach(function (e) { el['r:' + e.getAttribute('data-room')] = e; });
    S.elById = el;
    S.lines = Array.prototype.slice.call(svg2.querySelectorAll('line.rv-edge'));
    S.hits = Array.prototype.slice.call(svg2.querySelectorAll('line.rv-hit'));
    var vb = viewBoxOf(g);
    svg2.setAttribute('width', vb.width);
    svg2.setAttribute('height', vb.height);
    S.sim = simulateGraph(g, G_ITER, function () { drawPos(g); });
    S.gsig = sig;
    svg2.setAttribute('viewBox', vb.box.map(function (v) { return v.toFixed(1); }).join(' '));
    bindHead();
    bindGraph(svg2);
    convsEl.querySelectorAll('[data-room]').forEach(function (e) { e.onclick = function () { if (S.gmoved) return; loadRoom(e.getAttribute('data-room')); }; });
    convsEl.querySelectorAll('[data-link]').forEach(function (e) { e.onclick = function () { if (S.gmoved) return; loadRoom(e.getAttribute('data-link')); }; });
    convsEl.querySelectorAll('[data-node]').forEach(function (e) { e.onclick = function () { if (S.gmoved) return; loadWizard(e.getAttribute('data-node')); }; });
  };

  // ── 左栏: 列表 / 图 ─────────────────────────────────────────────────
  // 有人参与 = 群聊: 绑定企微的群 / 单聊 / topic / 微信, 或账本里有人发过话 (人从不 join, 发过话才进成员);
  // 只有 wizard 的 dm / adhoc = 会话。与服务端 room-search 的 isPeopleRoom 同一口径。
  var isPeopleRoom = function (r) {
    return !!r.bound || (r.kind !== 'dm' && r.kind !== 'adhoc') ||
      (r.members || []).some(function (m) { return m.who && m.who.kind === 'human'; });
  };
  // 与图同一个范围: 按所选时间窗有动静 (或留下未决 duty) 的 room; 「全部」= 整本账, 选中的那个总在。
  var sideRooms = function () {
    var rooms = (W.rooms || []).slice().sort(function (a, b) { return (b.last ? b.last.at : 0) - (a.last ? a.last.at : 0); });
    if (!WIN) return rooms;
    return rooms.filter(function (r) {
      return r.openDuties > 0 || inWin(r.last && r.last.at) || (D.mode === 'room' && D.roomId === r.id);
    });
  };
  // 视图开关照 main 的「聊天 / 关系」小开关 (.vt): 列表下挂在第一个分组标题右端, 图下挂在图的标题行。
  var LIST_SVG = '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M3 4h10M3 8h10M3 12h10" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';
  var TREE_SVG = '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M4 3v10M4 6h5M4 11h5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><circle cx="11" cy="6" r="1.6" fill="currentColor"/><circle cx="11" cy="11" r="1.6" fill="currentColor"/></svg>';
  // 时间范围下拉: 列表与图共用 (main 的 .sp 小下拉), 挂在标题行右端、视图开关左边。
  var winSelect = function () {
    return dropdown('win', {
      ic: '⏱', end: true, title: '时间范围: room 的动静与人动过只看这段时间内的',
      label: winLabel(),
      items: WINS.map(function (w) { return { v: String(w[0]), on: w[0] === WIN, html: '<span class="id">' + w[1] + '</span>' }; }),
    });
  };
  var sideTools = function () {
    var graph = S.view === 'graph';
    return winSelect() +
      '<button class="vt" data-side="' + (graph ? 'list' : 'graph') + '" title="' + (graph ? '换成聊天列表' : '换成关系图') + '">' +
      (graph ? LIST_SVG + '列表' : TREE_SVG + '图') + '</button>';
  };
  var sideHead = function (label) {
    return '<div class="convs-h"><h2><span>' + esc(label) + '</span>' + sideTools() + '</h2></div>';
  };
  var bindHead = function () {
    convsEl.querySelectorAll('[data-side]').forEach(function (b) { b.onclick = function () { setSide(b.getAttribute('data-side')); }; });
    bindDropdown(convsEl, 'win', function (v) {
      WIN = +v;
      try { localStorage.setItem(WIN_KEY, String(WIN)); } catch (e) { /* 隐私模式 */ }
      convsEl._html = '';   // 列表的「没变就不碰 DOM」缓存里还留着旧范围
      renderSide();
    });
  };
  var setSide = function (v) {
    if (v === S.view) return;
    S.view = v === 'graph' ? 'graph' : 'list';
    try { localStorage.setItem(SIDE_KEY, S.view); } catch (e) { /* 隐私模式 */ }
    renderSide();
  };
  // 头像照 main 的群头像: 前 4 位成员的头像拼成一块 (单人 room 就是那一位)。
  var memberLabel = function (m) { return m.who && m.who.kind === 'human' ? '👤' : (nodeOf(nodeIdOf(m.who)).label || '🧙‍♂️'); };
  var roomAvatar = function (r) {
    var ms = (r.members || []).slice(0, 4);
    if (!ms.length) return '<span class="av">' + esc(KIND_IC[r.kind] || '·') + '</span>';
    return '<span class="av mosaic n' + ms.length + '" aria-hidden="true">' + ms.map(function (m) { return '<i>' + esc(memberLabel(m)) + '</i>'; }).join('') + '</span>';
  };
  var roomItem = function (r) {
    var on = D.mode === 'room' && D.roomId === r.id;
    var pv = r.last ? (r.last.authorName ? r.last.authorName + ': ' : '') + r.last.preview : '';
    var nm = r.kind === 'dm' || r.kind === 'adhoc' ? 'wizard' : 'chat';
    return '<button class="ci' + (on ? ' on' : '') + '" data-room="' + esc(r.id) + '" title="' + esc(roomTitle(r) + ' · ' + (r.members || []).length + ' 人') + '">' +
      roomAvatar(r) + '<span class="b">' +
      '<span class="l1"><span class="t"><span class="nm ' + nm + '">' + esc(roomTitle(r)) + '</span></span>' +
        '<span class="ts">' + esc(r.last ? fmtAgo(r.last.at) : '') + '</span></span>' +
      '<span class="l2"><span class="pv">' + esc(pv) + '</span>' +
        (r.openDuties ? '<b class="ub" title="未决 duty ' + r.openDuties + ' 件">' + (r.openDuties > 99 ? '99+' : r.openDuties) + '</b>' : '') + '</span>' +
      '</span></button>';
  };
  var renderList = function () {
    if (S.sim) { S.sim.on('tick', null); S.sim.stop(); S.sim = null; }
    S.gsig = '';
    var rooms = sideRooms();
    var groups = rooms.filter(isPeopleRoom), convs = rooms.filter(function (r) { return !isPeopleRoom(r); });
    // 照 main: 分组标题「群聊 N」「会话 N」, 开关挂在第一个标题的右端; 空着的那一组不画。
    var sec = function (title, tip, list) {
      return list.length ? '<h2 title="' + esc(tip) + '"><span>' + title + '</span><span>' + list.length + '</span></h2>' + list.map(roomItem).join('') : '';
    };
    var body = sec('群聊', '有人参与: 企微群 / 单聊 / topic, 或有人发过话的 room', groups) +
      sec('会话', '只有 wizard: dm / adhoc', convs) || '<h2><span>群聊</span><span>0</span></h2>';
    var html = '<div class="rv-list">' + body.replace('</h2>', sideTools() + '</h2>') + '</div>';
    // 没变就不碰 DOM: 定时刷新会把列表的滚动与焦点蹭掉。
    if (convsEl._html === html) return;
    var top = convsEl.querySelector('.rv-list') ? convsEl.scrollTop : 0;
    convsEl._html = html; convsEl.innerHTML = html;
    convsEl.scrollTop = top;
    bindHead();
    convsEl.querySelectorAll('[data-room]').forEach(function (e) { e.onclick = function () { loadRoom(e.getAttribute('data-room')); }; });
  };
  // 列表不需要图那么宽: 左栏收窄, 把宽度还给 chat detail (图仍占半屏, 力导向要地方)。
  var renderSide = function () {
    var app = $('#app');
    if (app) app.classList.toggle('side-list', S.view !== 'graph');
    if (S.view === 'graph') renderGraph(); else renderList();
  };

  // ── 右侧 ───────────────────────────────────────────────────────────
  var chip = function (text, cls) { return text ? '<span class="rv-chip' + (cls ? ' ' + cls : '') + '">' + esc(text) + '</span>' : ''; };
  var ST_CLS = { done: 'ok', passed: 'ok', canceled: 'warn', need: 'ask', progress: 'go', error: 'bad' };
  var KIND_TAG = { ask: '问', task: '派', reply: '答', file: '文件', 'join-req': '申请入群', system: '系统', trigger: '定时' };

  // 右栏头只管「这是哪个窗口」与「只看与我相关 / 全部消息」; 属于这个 role 的入口 (宪章 / 会话) 都在左上名片。
  var header = function (title, sub, acts) {
    chWho.innerHTML = '<div class="rv-ttl">' + title + '</div>' + (sub ? '<div class="rv-sub">' + sub + '</div>' : '');
    chActs.innerHTML = acts || '';
    var a = $('#rv-all'); if (a) a.onclick = function () { D.all = !D.all; syncUrl(); loadWizard(D.role, true); };
    var b = $('#rv-back'); if (b) b.onclick = function () { setPane('msgs'); };
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
  // 点开一个 room: 整页最右 (chat detail 右边) 多一列成员。
  // 只有 room 视图有成员表; 看某个 wizard 时整列收起, 把宽度还给 chat detail。
  var renderGraphSide = function () {
    if (!gside) return;
    if (D.mode !== 'room' || !(D.members || []).length) { gside.hidden = true; gside.innerHTML = ''; return; }
    gside.hidden = false;
    var rows = D.members.map(function (m) {
      var cls = 'gs-mem ' + m.kind + (m.busy ? ' busy' : m.alive ? ' alive' : '') + (m.host ? ' host' : '');
      return '<button class="' + cls + '" data-node="' + esc(m.id) + '" title="' + esc(viaText(m)) + '">' +
        '<span class="nm">' + esc(m.name) + (m.foreign ? ' ↗' : '') + '</span>' +
        (m.host ? '<span class="gs-host" title="host">⭐</span>' : '') +
        (m.busy ? '<span class="gs-st go">执行中</span>' : m.alive ? '' : '<span class="gs-st">冷</span>') +
        (m.className ? '<span class="gs-cls">' + esc(m.className) + '</span>' : '') + '</button>';
    }).join('');
    var duties = (D.duties || []).length
      ? '<div class="gs-duty" title="' + esc(D.duties.map(function (d) { return '#' + d.seq + ' ' + d.askerName + ' · ' + d.kind; }).join('\n')) + '">未决 ' + D.duties.length + '</div>'
      : '';
    gside.innerHTML = '<div class="gs-head">成员 <b>' + D.members.length + '</b></div>' + duties +
      '<div class="gs-list">' + rows + '</div>';
    gside.querySelectorAll('[data-node]').forEach(function (el) { el.onclick = function () { loadWizard(el.getAttribute('data-node')); }; });
  };
  // 一条消息 = 气泡外的一行头 (谁 → 谁 · 哪个 room · 状态 · 时刻) + 一颗气泡。
  // 头在外面是历史方案: 气泡只装正文, 身份与路由不跟着正文一起被染色。
  // 说给谁: 显式 to; 没写 to 的 reply 就是答它 re 的那几行的作者 (服务端按账本补的 reTo)。
  var recipientsOf = function (m) { return m.to && m.to.length ? m.to : (m.reTo || []); };
  var whoTags = function (list) {
    var seen = {};
    return (list || []).filter(function (w) { var k = w.kind + ':' + w.id; if (seen[k]) return false; seen[k] = 1; return true; })
      .map(function (t) { return '<span class="rv-tag" data-node="' + esc(nodeIdOf(t)) + '">' + esc(nodeNameOf(t)) + '</span>'; }).join(', ');
  };
  // 气泡: 正文 (markdown) + 附件 + 折叠成标签的 reminder (<envelope · x> / <roster> …, 点开看原文)。
  var bubbleHTML = function (m) {
    var files = (m.files || []).map(function (f) { return chip('📎 ' + f.name, 'file'); }).join('');
    var body = m.text && m.text.trim() ? md(m.text) : '';
    if (!body && !files && !m.rems) return '';
    return '<div class="rv-bub">' + (body ? '<div class="rv-tx">' + body + '</div>' : '') +
      (files ? '<div class="rv-files">' + files + '</div>' : '') + (m.rems || '') + '</div>';
  };
  var msgHTML = function (m, ctx) {
    var author = nodeIdOf(m.author);
    var me = D.mode === 'wizard' && m.author.kind === 'wizard' && (author === D.role || (D.uid && m.author.id === D.uid));
    var to = whoTags(recipientsOf(m));
    var re = (m.re || []).map(function (id) { return chip('↩ ' + String(id).split('.').pop(), 're'); }).join('');
    var room = ctx && m.roomLabel ? '<span class="rv-roomtag" data-jump-room="' + esc(m.room) + '">' + esc(roomNameOf(roomById(m.room), m.roomLabel)) + '</span>' : '';
    var turn = m.turn ? '<button class="rv-open" data-turn="' + esc(m.turn) + '">过程</button>' : '';
    var bub = bubbleHTML(m) || '<div class="rv-bub"><p class="rv-empty">(无正文)</p></div>';
    return '<article class="rv-msg ' + (me ? 'me' : 'them') + ' k-' + esc(m.kind) + '" data-id="' + esc(m.id) + '">' +
      '<div class="rv-mh">' + room +
      '<span class="rv-au ' + esc(m.author.kind) + '" data-node="' + esc(author) + '">' + esc(m.authorName) + '</span>' +
      (to ? '<span class="rv-to">→ ' + to + '</span>' : '') +
      '<time>' + esc(fmtDay(m.at)) + '</time>' + turn +
      chip(KIND_TAG[m.kind] || '', 'kind') +
      (m.status ? chip(m.status, 'st ' + (ST_CLS[m.status] || '')) : '') +
      re +
      '</div>' + bub +
      '<div class="rv-box" hidden></div>' +
      '</article>';
  };
  var listHTML = function (msgs, ctx) {
    if (!msgs.length) return '<div class="rv-none">这里还没有消息。</div>';
    return msgs.map(function (m) { return msgHTML(m, ctx); }).join('');
  };
  // ── wizard 时间轴: 轮次为主线 (入 = 问的那句, 出 = 回复 + 过程框), 账本行挂在轮上 ──
  // 出消息的正文/工具调用是服务端渲染好的 HTML (renderTurnGroup), 直接注入 —— 工具正文
  // 仍是空壳, 展开时由 loadTool 去 /api/tool 取。
  var roomTagOf = function (room, label) {
    return '<span class="rv-roomtag" data-jump-room="' + esc(room) + '">' + esc(roomNameOf(roomById(room), label)) + '</span>';
  };
  // 一轮写进账本的那几行 = 这一轮说出去的话, 一行一颗气泡 (CLI 终句只在上面的过程框里)。
  // 只有一行时它的去处 / 定论都在消息头上; 多行 (发到几个 room / 答几个人) 才每颗气泡各带一行小头。
  var spokenHTML = function (list, f) {
    var many = list.length > 1;
    return list.map(function (m) {
      var to = whoTags(recipientsOf(m));
      var sub = many || m.room !== f.room
        ? '<div class="rv-mh rv-smh">' + (m.room !== f.room ? roomTagOf(m.room, m.roomLabel) : '') +
          (to ? '<span class="rv-to">→ ' + to + '</span>' : '') + chip(KIND_TAG[m.kind] || '', 'kind') +
          (m.status ? chip(m.status, 'st ' + (ST_CLS[m.status] || '')) : '') + '<time>' + esc(fmtDay(m.at)) + '</time></div>'
        : '';
      return '<div class="rv-spk" data-said="' + esc(m.id) + '">' + sub + (bubbleHTML(m) || '<div class="rv-bub"><p class="rv-empty">(无正文)</p></div>') + '</div>';
    }).join('');
  };
  var streamHTML = function (rows) {
    if (!rows.length) return '<div class="rv-none">这里还没有消息。</div>';
    var toTag = function (f) {
      if (!f.to) return '';
      return '<span class="rv-to">→ <span class="rv-tag" data-node="' + esc(f.to) + '">' + esc(f.toName || f.to) + '</span></span>';
    };
    return rows.map(function (f) {
      if (f.kind === 'mark') return '<div class="rv-mark" data-id="' + esc(f.id) + '">' + f.html + '</div>';
      if (f.kind === 'ledger') return msgHTML(f.row, true);
      var room = f.roomLabel ? roomTagOf(f.room, f.roomLabel) : '<span class="rv-chip priv">私聊</span>';
      if (f.kind === 'in') {
        var inj = f.inj || null;
        var tags = (f.tags || []).map(function (t) { return chip(t, 'kind'); }).join('');
        // 注入拆出来的行: 账本行 id / 答的哪几行 / 交代状态都在头上一眼看到。
        var injchips = inj
          ? '<span class="rv-chip re" title="账本行">' + esc(inj.id) + '</span>' +
            (inj.re && inj.re.length ? '<span class="rv-chip re" title="答的是">↩ ' + esc(inj.re.join(', ')) + '</span>' : '') +
            (inj.status ? chip(inj.status, 'st ' + (ST_CLS[inj.status] || '')) : '')
          : '';
        // 注入原文一个字节没动: 头部末尾一个小 icon, 点它整条 (头部 + 气泡) 切到原文, 再点切回。
        var raw = inj && inj.raw
          ? '<button type="button" class="rv-rawbtn" data-raw-toggle title="' + esc('注入原文' + (inj.note ? ' · ' + inj.note : '')) + '">⟨/⟩</button>'
          : '';
        var rawBody = inj && inj.raw ? '<pre class="rv-rawpre">' + esc(inj.raw) + '</pre>' : '';
        return '<article class="rv-msg them" data-id="' + esc(f.id) + '">' +
          '<div class="rv-mh">' + room +
          '<span class="rv-au' + (f.from === 'system:' ? ' daemon' : /^human:/.test(f.from || '') ? ' human' : '') + '" data-node="' + esc(f.from === 'system:' ? '' : f.from) + '">' +
          esc(f.fromLabel || '👤') + ' ' + esc(f.fromName || f.from) + '</span>' + toTag(f) +
          '<time>' + esc(fmtDay(f.ts)) + '</time>' + injchips + tags + raw + '</div>' +
          bubbleHTML({ text: f.text, rems: f.rems }) + rawBody + '</article>';
      }
      // 出一侧: 头在外面 (room · 我 → 说给谁), 下面是这一轮的过程框, 再下面是写进账本的气泡。
      var said = f.said || [];
      var one = said.length === 1 ? said[0] : null;
      var rcpt = whoTags([].concat.apply([], said.map(recipientsOf)));
      return '<article class="rv-msg me" data-id="' + esc(f.id) + '">' +
        '<div class="rv-mh">' + room +
        '<span class="rv-au wizard" data-node="' + esc(f.from || '') + '">' + esc(f.fromLabel || '🧙‍♂️') + ' ' + esc(f.fromName || D.role) + '</span>' +
        (rcpt ? '<span class="rv-to">→ ' + rcpt + '</span>' : toTag(f)) +
        '<time>' + esc(fmtDay(f.ts)) + '</time>' +
        (one ? chip(KIND_TAG[one.kind] || '', 'kind') + (one.status ? chip(one.status, 'st ' + (ST_CLS[one.status] || '')) : '') : '') +
        (f.era && !said.length && !f.staleAt ? chip('未发言', '') : '') +
        (f.meta ? '<span class="mstat">' + f.meta + '</span>' : '') + '</div>' +
        (f.html ? '<div class="rv-box rv-turn">' + f.html + '</div>' : '') + spokenHTML(said, f) + '</article>';
    }).join('');
  };
  // 轮询每 4s 重画一次; 时间轴没变就别动 DOM (展开的工具正文 / 滚动位置都会被打断)。
  var streamSig = function (rows) {
    return (rows || []).map(function (f) { return f.id + ':' + (f.sig || f.ts); }).join('|');
  };
  // 真重画时把已展开的工具正文按 (turn, use) 记下来, 重画后重新打开并取正文。
  var openTools = function () {
    var out = [];
    inner.querySelectorAll('details.tool-call[open]').forEach(function (d) {
      var b = d.querySelector('.tool-body');
      if (b && b.hasAttribute('data-lazy-turn')) out.push([b.getAttribute('data-lazy-turn'), b.getAttribute('data-lazy-use')]);
    });
    return out;
  };
  var reopenTools = function (list) {
    list.forEach(function (p) {
      var d = inner.querySelector('details.tool-call > .tool-body[data-lazy-turn="' + cssEsc(p[0]) + '"][data-lazy-use="' + cssEsc(p[1]) + '"]');
      if (!d) return;
      var det = d.closest('details');
      if (det) { det.open = true; loadTool(det); }
    });
  };
  // ── 下拉 (main 的那一份): 小号文字触发器 + 浮层列表 ──────────────────
  // 名片里的 session 切换用它 —— 不用原生 <select>, 样式跟着页面走; 展开的是哪一个按 id 记,
  // 宿主每次轮询都重画也不会被收起。
  var DD_OPEN = '';
  var dropdown = function (id, o) {
    var open = DD_OPEN === id;
    return '<span class="sp' + (o.end ? ' end' : '') + (open ? ' open' : '') + '" data-dd="' + id + '">' +
      (o.ic ? '<span class="sp-ic" aria-hidden="true">' + o.ic + '</span>' : '') +
      '<button class="sp-btn" aria-haspopup="listbox" aria-expanded="' + open + '" title="' + esc(o.title) + '">' +
        esc(o.label) + '<span class="car" aria-hidden="true"></span></button>' +
      '<span class="sp-list" role="listbox">' + o.items.map(function (it) {
        return '<button class="sp-it' + (it.cls ? ' ' + it.cls : '') + (it.on ? ' on' : '') + '" role="option" aria-selected="' + !!it.on + '" data-v="' + esc(it.v) + '"' +
          (it.tip ? ' title="' + esc(it.tip) + '"' : '') + '>' + it.html + '</button>';
      }).join('') + '</span></span>';
  };
  var setDdOpen = function (id) {
    DD_OPEN = id;
    document.querySelectorAll('.sp[data-dd]').forEach(function (sp) {
      var on = sp.getAttribute('data-dd') === id;
      sp.classList.toggle('open', on);
      sp.querySelector('.sp-btn').setAttribute('aria-expanded', on);
    });
  };
  var bindDropdown = function (root, id, pick) {
    var sp = root && root.querySelector('.sp[data-dd="' + id + '"]');
    if (!sp) return;
    sp.querySelector('.sp-btn').onclick = function () { setDdOpen(DD_OPEN === id ? '' : id); };
    sp.querySelectorAll('.sp-it').forEach(function (it) {
      it.onclick = function () { setDdOpen(''); pick(it.getAttribute('data-v')); };
    });
  };
  document.addEventListener('click', function (e) {
    if (DD_OPEN && !e.target.closest('.sp[data-dd="' + DD_OPEN + '"]')) setDdOpen('');
  });
  document.addEventListener('keydown', function (e) {
    if (DD_OPEN && e.key === 'Escape') setDdOpen('');
  });

  // session 切换: name 右边那个下拉。最新那段直接叫「最新」, 其余写开始时刻; 每项带轮数。
  var latestSess = function () { return (D.sessions || [])[D.sessions.length - 1]; };
  var sessWhen = function (s) { return s.start ? fmtDay(s.start) : '(无时刻)'; };
  var sessItem = function (s, on) {
    return { v: s.key, on: on, tip: s.sessionId || '',
      html: '<span class="id">' + (s === latestSess() ? '最新 · ' : '') + esc(sessWhen(s)) + '</span><span class="n">' + s.turns + ' 轮</span>' };
  };
  var sessPicker = function () {
    var cur = (D.sessions || []).filter(function (s) { return s.key === D.session; })[0];
    return dropdown('sess', {
      title: '切换 session',
      label: !cur ? '全部' : cur === latestSess() ? '最新' : sessWhen(cur),
      items: [{ v: 'all', on: !cur, cls: 'all', html: '<span class="id">全部</span><span class="n">' + D.sessions.length + ' 段</span>' }]
        .concat(D.sessions.slice().reverse().map(function (s) { return sessItem(s, s.key === D.session); })),
    });
  };
  var bindSessPicker = function () {
    bindDropdown($('#rb-sp'), 'sess', function (v) { D.session = v || 'all'; loadWizard(D.role, true); });
  };

  // ── 左上名片的「日程与计划」──
  // 名片上那一行 📅 点开就是它 (main 的老交互: 同一个入口再点一次回到对话)。
  // 数据全是当前 role 名下的, 只读; 左栏 (room 列表) 不动, 只换右栏。
  var planEl = $('#plan-in');
  var srvNow = function () { return D.at ? D.at + (Date.now() - (D.recvAt || Date.now())) : Date.now(); };
  var fmtHM = function (ts) { var x = new Date(ts); return pad(x.getHours()) + ':' + pad(x.getMinutes()); };
  var roleNodeName = function () { return (D.wizard && D.wizard.name) || (nodeOf(ROLE) || {}).name || ROLE; };
  var canOpen = function (n) { return !!n; };
  var openNode = function (target) { if (target) loadWizard(target); };
  // 两处数据源都认: 名册快照 (world, 每 6s 一次) 与这一页刚取的名片 (api/wizard)。
  // 同一份 plan 取 revision 大的那版 —— 免得晚到的旧回包把新状态盖回去。
  var plansForRole = function () {
    var by = {};
    (W.plans || []).filter(function (p) { return p.owner === ROLE; }).forEach(function (p) { by[p.id] = p; });
    (D.plans || []).forEach(function (p) {
      var old = by[p.id];
      if (!old || (p.revision || 0) >= (old.revision || 0)) by[p.id] = p;
    });
    return Object.keys(by).map(function (id) { return by[id]; }).sort(function (a, b) { return (b.updatedAt || 0) - (a.updatedAt || 0); });
  };
  // world 快照里有全量定时任务 (带 gate / 出错); 它还没到手时才退回名片里那几列。
  var schedulesForRole = function () {
    var pool = (W.schedules || []).length ? W.schedules : (D.schedules || []);
    return pool.filter(function (x) { return (x.owner || x.createdBy || x.target) === ROLE; })
      .sort(function (a, b) { return (a.nextAt || 0) - (b.nextAt || 0); });
  };
  // 名片那一行字: 下一枪几点 / 几个计划; 定时出错就改写成出错数 (染红)。
  var planFact = function () {
    var ss = schedulesForRole(), ps = plansForRole();
    var bad = ss.filter(broken);
    var txt = [bad.length ? '日程 ⚠ ' + bad.length + ' 出错' : ss.length ? '日程 ' + fmtDayClock(ss[0].nextAt).replace(/^今天 /, '') : '',
      ps.length ? ps.length + ' 个计划' : ''].filter(Boolean).join(' · ') || '日程与计划';
    var detail = [ss.length ? ss.length + ' 条定时' : '', ps.length ? ps.length + ' 个计划' : ''].filter(Boolean).join(' · ');
    return ['📅', txt, (detail ? detail + ' · ' : '') + '点开看日程与计划', 'plan', bad.length ? 'bad' : ''];
  };
  // 对话 / 日程两栏互斥: 日程是当前 role 的另一面, 左栏 (room 列表) 留着。
  var resetPane = function () {
    S.pane = 'msgs';
    thread.hidden = false;
    if (planEl && planEl.parentNode) planEl.parentNode.hidden = true;
    if (taskDetail && taskDetail.classList.contains('on')) hideTaskDetail();
  };
  var setPane = function (v) {
    if (v === 'plan') {
      S.pane = 'plan'; thread.hidden = true;
      if (planEl && planEl.parentNode) planEl.parentNode.hidden = false;
    } else resetPane();
    renderWizard(true);
  };
  if (planEl) planEl.parentNode.hidden = true;

  // ══ 日程视图 ═══════════════════════════════════════════════════════
  // 定时任务与 plans 提供各自 owner 的只读状态。
  var fmtDayClock = function (ts) {
    if (!ts) return '—';
    var d = new Date(ts), p = function (n) { return n < 10 ? '0' + n : '' + n; };
    var today = new Date(srvNow());
    var sameDay = d.toDateString() === today.toDateString();
    return (sameDay ? '今天 ' : (p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ')) + p(d.getHours()) + ':' + p(d.getMinutes());
  };
  var fmtIn = function (ts) {
    var d = ts - srvNow();
    if (d <= 0) return '即将';
    if (d < 3600000) return Math.max(1, Math.round(d / 60000)) + ' 分钟后';
    if (d < 86400000) return Math.round(d / 3600000) + ' 小时后';
    return Math.round(d / 86400000) + ' 天后';
  };

  var wizChip = function (target) {
    var n = nodeOf(target);
    return '<span class="wchip' + (canOpen(n) ? ' go' : '') + '" data-t="' + esc(target) + '">' +
      esc((n && n.label) || '🧙') + ' ' + esc(nodeOf(target).name) + '</span>';
  };

  // 未来 12 小时的刻度条: 哪几个钟点会有任务醒来, 一眼看完。超出 12h 的排进下面
  // 的列表但不占刻度 —— 把 24h 压进这么窄的一条, 刻度会密到读不出。
  var HORIZON_H = 12;
  var broken = function (x) { return x.lastGate === 'error' || !!x.loadError; };
  var renderStrip = function (list) {
    var now = srvNow(), span = HORIZON_H * 3600000;
    var soon = list.filter(function (x) { return x.nextAt - now < span; });
    var ticks = [];
    for (var i = 0; i <= HORIZON_H; i += 3) {
      var t = new Date(now + i * 3600000);
      ticks.push('<span class="tk" style="left:' + (i / HORIZON_H * 100) + '%">' +
        (i ? pad(t.getHours()) + ':00' : '现在') + '</span>');
    }
    var pins = soon.map(function (x) {
      var pct = Math.max(0, Math.min(100, (x.nextAt - now) / span * 100));
      return '<button class="pin' + (broken(x) ? ' bad' : '') + '" style="left:' + pct.toFixed(2) + '%" data-id="' + esc(x.id) + '" ' +
        'title="' + esc(fmtDayClock(x.nextAt) + ' · ' + (x.note || x.id) + ' · ' + x.when) + '"><span>' + esc(fmtHM(x.nextAt)) + '</span></button>';
    }).join('');
    return '<div class="strip"><div class="axis">' + ticks.join('') + '</div>' +
      '<div class="rail">' + pins + '</div>' +
      '<div class="cap">' + (soon.length ? '未来 ' + HORIZON_H + ' 小时内 ' + soon.length + ' 次触发 · 点刻度跳到那条' : '未来 ' + HORIZON_H + ' 小时内没有定时任务') + '</div></div>';
  };

  // 触发规则 = describeTrigger 的人话, 各段以 ` · ` 相接: 第一段是时钟 (什么时候响), 其余是闸 (什么时候不响)。
  var ruleHTML = function (when) {
    return String(when || '').split(' · ').filter(Boolean).map(function (part, i) {
      return '<span class="rl' + (i ? ' guard' : ' clock') + '">' + (i ? '' : '⏱ ') + esc(part) + '</span>';
    }).join('');
  };
  var gateHTML = function (x) {
    if (!x.hasGate) return '<span class="gt none" title="没有 gate: 到点就放">无 gate</span>';
    var at = x.lastGateAt ? ' · ' + fmtAgo(x.lastGateAt) : '';
    return x.lastGate === 'go' ? '<span class="gt go" title="上一轮 gate 放行">gate 放行' + esc(at) + '</span>'
      : x.lastGate === 'skip' ? '<span class="gt skip" title="上一轮 gate 判定没活, 没放枪 (不出声)">gate 挡下' + esc(at) + '</span>'
      : x.lastGate === 'error' ? '<span class="gt err">gate 出错' + esc(at) + '</span>'
      : '<span class="gt none">gate 未跑过</span>';
  };
  var flowHTML = function (x) {
    var own = x.owner || x.createdBy;
    return '<div class="pflow">' +
      (own && own !== x.target ? '<span class="fl">排班</span>' + wizChip(own) + '<span class="ar">→</span>' : '') +
      (x.fresh
        ? '<span class="fl">执行</span><span class="fresh" title="每次到点新起一个白板 wizard, 跑完自动回收">✦ 新起白板</span><span class="fl">在</span>' + wizChip(x.target) + '<span class="fl">名下</span>'
        : '<span class="fl">执行</span>' + wizChip(x.target) + '<span class="fl">注入已有会话</span>') +
    '</div>';
  };
  var PLAN_OPEN = {};
  // plan 节点状态徽标的字形: ○ 未动 / ◔ 进行 / ✓ 完 / ✕ 取消 —— 形状先分态, 颜色只是加强 (色弱可辨)。
  var TASK_BADGE = { pending: '○', in_progress: '◔', completed: '✓', canceled: '✕' };
  var TASK_WORD = { pending: '待处理', in_progress: '进行中', completed: '已完成', canceled: '已取消' };
  var planOwnerNode = function (p) {
    return (W.nodes || []).filter(function (n) { return n.target === p.owner; })[0] || null;
  };
  // 执行者解析: task.executor (wizard 全局名字, 带不带点都行, 大小写不敏感) → world 节点;
  // 没写 → plan owner (owner: true, 展示时淡一档并标 owner); 写了但名册里认不出 → 保留名字纯文本, 不造头像。
  var executorOf = function (t, ownerNode) {
    if (!t.executor) return { node: ownerNode, owner: true, name: '' };
    var want = String(t.executor).replace(/^\./, '').toLowerCase();
    var hit = (W.nodes || []).filter(function (n) { return String(n.name || '').replace(/^\./, '').toLowerCase() === want; })[0] || null;
    return { node: hit, owner: false, name: String(t.executor).replace(/^\./, '') };
  };
  var taskHTML = function (x) {
    var lines = String(x.prompt || '').split('\n');
    var head = x.note || lines[0];
    var errs = [
      x.loadError ? '<div class="perr"><b>任务文件加载失败</b> · 仍在跑上一版<code>' + esc(x.loadError.split('\n')[0].slice(0, 240)) + '</code></div>' : '',
      x.lastGate === 'error' ? '<div class="perr"><b>gate 出错</b>' + (x.lastGateAt ? ' · ' + esc(fmtAgo(x.lastGateAt)) : '') +
        ' · 本轮未放枪, 下次照常重试' + (x.lastError ? '<code>' + esc(x.lastError.split('\n')[0].slice(0, 240)) + '</code>' : '') + '</div>' : '',
    ].join('');
    return '<article class="tcard' + (broken(x) ? ' bad' : '') + '" data-id="' + esc(x.id) + '">' +
      '<div class="tc-time"><b>' + esc(fmtHM(x.nextAt)) + '</b><span>' + esc(fmtDayClock(x.nextAt).replace(/ \d\d:\d\d$/, '')) + '</span>' +
        '<em>' + esc(fmtIn(x.nextAt)) + '</em></div>' +
      '<div class="tc-main">' +
        errs +
        '<div class="prule">' + ruleHTML(x.when) + '</div>' +
        '<div class="ptitle">' + esc(head.slice(0, 120)) + '</div>' +
        flowHTML(x) +
        '<details class="pprompt" data-id="' + esc(x.id) + '"' + (PLAN_OPEN[x.id] ? ' open' : '') + '>' +
          '<summary>prompt<span>' + esc((x.note ? lines[0] : lines.slice(1).join(' ')).slice(0, 90)) + '</span></summary>' +
          '<pre>' + esc(x.prompt) + '</pre></details>' +
        '<div class="pfoot">' + gateHTML(x) +
          '<span>' + (x.lastFired ? '上次触发 ' + esc(fmtAgo(x.lastFired)) : '还没跑过') + '</span>' +
          '<span class="pid" title="' + esc(x.file || '') + '">' + esc(x.id) + '</span></div>' +
      '</div>' +
    '</article>';
  };

  var drawPlanEdges = function (innerGraph) {
    if (!innerGraph) return;
    var svg = innerGraph.querySelector('.plan-edges');
    var nodes = innerGraph.querySelectorAll('.plan-node');
    if (!svg) return;
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    var byId = Object.create(null), bounds = innerGraph.getBoundingClientRect();
    Array.prototype.forEach.call(nodes, function (node) {
      var box = node.getBoundingClientRect();
      // 自上而下: 锚点是节点的下沿/上沿中点 —— 边从上游底部垂到下游顶部。
      byId[node.getAttribute('data-task-id')] = {
        cx: box.left + box.width / 2 - bounds.left,
        bottom: box.bottom - bounds.top,
        top: box.top - bounds.top
      };
    });
    // 尺寸只看 inner 自身 (clientWidth/Height 已含 padding, 且 width:max-content 时就是内容宽):
    // 不能用 scrollWidth —— svg 是 inner 的绝对定位子元素, 它自己的溢出会反过来把 scrollWidth 撑住,
    // 缩窗后 svg 就粘在旧宽度上, 图盒出现一段滚不到底的空白。
    var width = innerGraph.clientWidth;
    var height = innerGraph.clientHeight;
    svg.setAttribute('width', width); svg.setAttribute('height', height); svg.setAttribute('viewBox', '0 0 ' + width + ' ' + height);
    var markerId = 'plan-arrow-' + Array.prototype.indexOf.call(planEl.querySelectorAll('.plan-graph-inner'), innerGraph);
    var defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
    var marker = document.createElementNS('http://www.w3.org/2000/svg', 'marker');
    marker.setAttribute('id', markerId); marker.setAttribute('viewBox', '0 0 8 8'); marker.setAttribute('refX', '7'); marker.setAttribute('refY', '4'); marker.setAttribute('markerWidth', '5.5'); marker.setAttribute('markerHeight', '5.5'); marker.setAttribute('orient', 'auto');
    var tip = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    tip.setAttribute('d', 'M0 0L8 4L0 8Z'); tip.setAttribute('class', 'plan-arrow-tip'); marker.appendChild(tip); defs.appendChild(marker); svg.appendChild(defs);
    Array.prototype.forEach.call(nodes, function (node) {
      var target = byId[node.getAttribute('data-task-id')];
      var dependencies = [];
      try { dependencies = JSON.parse(node.getAttribute('data-depends-on') || '[]'); } catch (e) { }
      dependencies.forEach(function (dependency) {
        var source = byId[dependency];
        if (!source || !target) return;
        var x1 = source.cx, x2 = target.cx, y1 = source.bottom, y2 = target.top, bend = Math.max(18, (y2 - y1) * 0.42);
        var path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', 'M' + x1 + ' ' + y1 + ' C' + x1 + ' ' + (y1 + bend) + ' ' + x2 + ' ' + (y2 - bend) + ' ' + x2 + ' ' + y2);
        path.setAttribute('class', 'plan-edge'); path.setAttribute('marker-end', 'url(#' + markerId + ')'); svg.appendChild(path);
      });
    });
  };
  var planResizeObserver = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(function (entries) {
    entries.forEach(function (entry) { drawPlanEdges(entry.target.querySelector('.plan-graph-inner')); });
  });
  var redrawPlanEdges = function () {
    planEl.querySelectorAll('.plan-graph-inner').forEach(drawPlanEdges);
  };
  window.addEventListener('resize', redrawPlanEdges);

  // ── 任务详情浮层: 卡片被压到一眼可扫, 详尽信息 (描述/依赖/进度/结果/执行者/计划账) 都在这里。
  //    每一节都有真实数据才渲染; 没有的字段整节不出。backdrop / ✕ / Esc 三种关法。 ──
  var taskDetail = null;
  var hideTaskDetail = function () {
    if (!taskDetail || !taskDetail.classList.contains('on')) return;
    taskDetail.classList.remove('on');
    document.removeEventListener('keydown', taskDetail._esc);
  };
  var showTaskDetail = function (p, t) {
    if (!taskDetail) {
      taskDetail = document.createElement('div');
      taskDetail.className = 'task-detail';
      taskDetail.innerHTML = '<div class="td-backdrop"></div><div class="td-card" role="dialog" aria-modal="true" aria-label="任务详情"></div>';
      taskDetail.querySelector('.td-backdrop').onclick = hideTaskDetail;
      document.body.appendChild(taskDetail);
    }
    var badge = function (s) {
      return '<span class="task-badge tb-' + esc(s) + '">' + esc(TASK_BADGE[s] || '•') + ' ' + esc(TASK_WORD[s] || s) + '</span>';
    };
    var tasksById = Object.create(null);
    (p.tasks || []).forEach(function (x) { tasksById[x.id] = x; });
    var known = function (id) { return Object.prototype.hasOwnProperty.call(tasksById, id); };
    var li = function (x) { return '<li>' + badge(x.status) + '<span title="' + esc(x.title) + '">' + esc(x.title) + '</span></li>'; };
    var ups = (t.dependsOn || []).filter(known).map(function (id) { return li(tasksById[id]); });
    var downs = (p.tasks || []).filter(function (x) { return (x.dependsOn || []).indexOf(t.id) >= 0; }).map(li);
    var ex = executorOf(t, planOwnerNode(p));
    var planState = { active: '进行中', paused: '已暂停', completed: '已完成', canceled: '已取消' }[p.state] || p.state;
    var exBody = ex.node
      ? '<div class="td-ex">' + wizChip(ex.node.target) + (ex.owner ? '<i class="ex-mark" title="未指派执行者, 显示 plan owner">· owner</i>' : '') + '</div>' +
        '<div class="td-ex-meta">' + [
          ex.node.model ? '<span title="模型 ' + esc(ex.node.model) + '">' + esc(ex.node.model) + '</span>' : '',
          ex.node.ctx ? '<span title="上下文 — 最近一次请求送入的 input + 缓存">📄 ' + esc(fmtTok(ex.node.ctx)) + '</span>' : '',
        ].filter(Boolean).join('<i class="pn-dot">·</i>') + '</div>'
      : (ex.name ? '<div class="td-ex-plain" title="执行者名字此刻不在 world 名册">' + esc(ex.name) + '</div>' : '');
    var sec = function (h, body) { return body ? '<div class="td-sec"><h5>' + h + '</h5>' + body + '</div>' : ''; };
    taskDetail.querySelector('.td-card').innerHTML =
      '<button class="td-close" aria-label="关闭详情">✕</button>' +
      '<h4 title="' + esc(t.title) + '">' + esc(t.title) + '</h4>' +
      '<div class="td-row">' + badge(t.status) +
        (p.state === 'paused' ? '<span class="td-pause" title="整个 plan 暂停中">计划已暂停' + (p.reason ? ' · ' + esc(p.reason) : '') + '</span>' : '') + '</div>' +
      sec('执行者', exBody) +
      sec('上游依赖', ups.length ? '<ul>' + ups.join('') + '</ul>' : '') +
      sec('下游任务', downs.length ? '<ul>' + downs.join('') + '</ul>' : '') +
      sec('描述', t.description ? '<p>' + esc(t.description) + '</p>' : '') +
      sec('进度', t.progress ? '<p>' + esc(t.progress) + '</p>' : '') +
      sec('结果', t.result ? '<p>' + esc(t.result) + '</p>' : '') +
      '<div class="td-foot" title="task 本身不记时间, 这里是 plan 一级的账">计划 ' + esc(p.title) + ' · ' + esc(planState) + ' · r' + esc(p.revision) +
        ' · 更新 ' + esc(fmtDayClock(p.updatedAt)) + ' · 创建 ' + esc(fmtDayClock(p.createdAt)) + '</div>';
    var card = taskDetail.querySelector('.td-card');
    card.querySelector('.td-close').onclick = hideTaskDetail;
    card.querySelectorAll('.wchip.go').forEach(function (c) {
      c.onclick = function (ev) { ev.stopPropagation(); hideTaskDetail(); openNode(c.getAttribute('data-t')); };
    });
    taskDetail._esc = function (e) { if (e.key === 'Escape') hideTaskDetail(); };
    document.addEventListener('keydown', taskDetail._esc);
    taskDetail.classList.add('on');
  };

  // 日程与只读 plans 跟着 wizard owner 走。
  var renderPlan = function () {
    var ss = schedulesForRole();
    var ps = plansForRole();
    var bad = ss.filter(broken);
    var next = ss[0];
    var stat = function (k, v, sub, tone) {
      return '<div class="pst' + (tone ? ' ' + tone : '') + '"><span class="k">' + k + '</span><b>' + v + '</b><span class="s">' + sub + '</span></div>';
    };
    var stats = '<div class="pstats">' +
      stat('下一次', next ? esc(fmtHM(next.nextAt)) : '—', next ? esc(fmtIn(next.nextAt) + ' · ' + (next.note || next.id)) : '没有排期') +
      stat('定时任务', ss.length, ss.length ? esc(ss.filter(function (x) { return x.hasGate; }).length + ' 条带 gate') : '—') +
      (bad.length ? stat('出错', bad.length, '见下方红色卡片', 'bad') : '') +
    '</div>';

    var planCards = ps.length ? ps.map(function (p) {
      var state = { active: '进行中', paused: '已暂停', completed: '已完成', canceled: '已取消' }[p.state] || p.state;
      var tasks = p.tasks || [];
      var taskTitles = Object.create(null);
      tasks.forEach(function (task) { taskTitles[task.id] = task.title; });
      var completed = tasks.filter(function (task) { return task.status === 'completed'; }).length;
      var canceled = tasks.filter(function (task) { return task.status === 'canceled'; }).length;
      var pending = tasks.filter(function (task) { return task.status === 'pending'; }).length;
      var inProgress = tasks.filter(function (task) { return task.status === 'in_progress'; }).length;
      var outgoing = Object.create(null), degree = Object.create(null), rank = Object.create(null);
      tasks.forEach(function (task) { outgoing[task.id] = []; degree[task.id] = 0; rank[task.id] = 0; });
      tasks.forEach(function (task) {
        (task.dependsOn || []).forEach(function (id) {
          if (!Object.prototype.hasOwnProperty.call(degree, id)) return;
          outgoing[id].push(task.id); degree[task.id]++;
        });
      });
      var ready = tasks.filter(function (task) { return degree[task.id] === 0; }).map(function (task) { return task.id; });
      for (var qi = 0; qi < ready.length; qi++) {
        var id = ready[qi];
        outgoing[id].forEach(function (next) {
          rank[next] = Math.max(rank[next], rank[id] + 1);
          degree[next]--;
          if (!degree[next]) ready.push(next);
        });
      }
      var layers = [];
      tasks.forEach(function (task) { (layers[rank[task.id]] || (layers[rank[task.id]] = [])).push(task); });
      // 节点上的 model / ctx 与执行者: task.executor 优先 (executorOf), 没写 / 解不出退 plan owner;
      // world 节点里没有它、或它没有带 usage 的轮次, 对应项就不渲染, 不造假值。
      var ownerNode = planOwnerNode(p);
      // 同层排序 (barycenter): 节点尽量落在它的上游正下方 —— 边更接近竖直、少交叉少穿字。
      var above = Object.create(null);
      layers.forEach(function (items, li) {
        if (li) {
          var idx = Object.create(null);
          items.forEach(function (t, i) { idx[t.id] = i; });
          var bar = function (t) {
            var ds = (t.dependsOn || []).filter(function (d) { return above[d] !== undefined; });
            return ds.length ? ds.reduce(function (s, d) { return s + above[d]; }, 0) / ds.length : idx[t.id];
          };
          items.sort(function (a, b) { return bar(a) - bar(b) || idx[a.id] - idx[b.id]; });
        }
        items.forEach(function (t, i) { above[t.id] = i; });
      });
      var graph = tasks.length ? '<div class="plan-graph" role="region" aria-label="' + esc(p.title) + ' 任务依赖图，可滚动">' +
        '<div class="plan-graph-inner"><svg class="plan-edges" aria-hidden="true"></svg><div class="plan-layers">' +
        layers.map(function (items) {
          return '<div class="plan-layer">' + items.map(function (t) {
            var status = TASK_WORD[t.status] || t.status;
            var glyph = TASK_BADGE[t.status] || '•';
            var deps = (t.dependsOn || []).filter(function (dep) { return Object.prototype.hasOwnProperty.call(taskTitles, dep); });
            var ex = executorOf(t, ownerNode);
            // 第一行 meta: 徽标 | 执行者 | model·ctx (右对齐, 弹性收缩); 第二行: 标题 (两行截断)。
            var exEl = ex.node
              ? wizChip(ex.node.target) + (ex.owner ? '<i class="ex-mark" title="未指派执行者, 显示 plan owner">· owner</i>' : '')
              : (ex.name ? '<span class="pn-ex-plain" title="执行者名字此刻不在 world 名册">' + esc(ex.name) + '</span>' : '');
            var mcParts = ex.node ? [
              ex.node.model ? '<span class="pn-model">' + esc(ex.node.model) + '</span>' : '',
              ex.node.ctx ? '<span class="pn-ctx">ctx ' + esc(fmtTok(ex.node.ctx)) + '</span>' : '',
            ].filter(Boolean) : [];
            var mcTitle = ex.node ? [
              ex.node.model ? '模型 ' + ex.node.model : '',
              ex.node.ctx ? '上下文 ' + fmtTok(ex.node.ctx) + ' (最近一次请求送入的 input + 缓存)' : '',
            ].filter(Boolean).join(' · ') : '';
            // 卡片只留一眼可扫的两行 —— 其余 (描述/依赖/进度/结果/时间) 在详情浮层。
            return '<article class="plan-node task-' + esc(t.status) + '" data-task-id="' + esc(t.id) + '" data-plan="' + esc(p.id) + '" data-depends-on="' + esc(JSON.stringify(deps)) + '" tabindex="0" role="button" aria-label="查看任务 ' + esc(t.title) + ' 详情">' +
              '<div class="pn-meta">' +
                '<span class="task-badge tb-' + esc(t.status) + '" title="' + esc(status) + '">' + esc(glyph) + ' ' + esc(status) + '</span>' +
                (exEl ? '<span class="pn-ex' + (ex.owner ? ' is-owner' : '') + '">' + exEl + '</span>' : '') +
              '</div>' +
              '<b class="pn-title" title="' + esc(t.title) + '">' + esc(t.title) + '</b>' +
              // footer 永远渲染: 没有 model/ctx 就留空行 —— 空行仍占位 (min-height), 保证同层卡片等高、
              // 注脚分隔线在同层各卡同一高度; 不编占位值。
              '<div class="pn-foot"' + (mcTitle ? ' title="' + esc(mcTitle) + '"' : '') + '>' + (mcParts.length ? mcParts.join('<i class="pn-sep">·</i>') : '') + '</div>' +
            '</article>';
          }).join('') + '</div>';
        }).join('') + '</div></div></div>' : '<div class="pempty plan-graph-empty">任务图为空 · 完成 0 / 0 · 取消 0</div>';
      return '<article class="tcard plan-state-' + esc(p.state) + '"><div class="plan-main"><h3>' + esc(p.title) + '<span class="tag plan-state-tag">' + esc(state) + ' · r' + esc(p.revision) + '</span></h3>' +
        '<div class="pid">' + esc(p.id) + '</div>' +
        (p.description ? '<p>' + esc(p.description) + '</p>' : '') +
        (p.state === 'paused' && p.reason ? '<p class="plan-reason">暂停原因：' + esc(p.reason) + '</p>' : '') +
        '<div class="plan-counts">完成 ' + completed + ' / ' + tasks.length + ' · 取消 ' + canceled + ' · 进行中 ' + inProgress + ' · 待处理 ' + pending + '</div>' +
        '<div class="plan-graph-note">箭头从前置任务指向依赖它的任务 · 根在上、依赖逐层向下 · 点击节点看详情</div>' + graph + '</div></article>';
    }).join('') : '<div class="pempty">' + esc(roleNodeName()) + ' 名下没有 plans</div>';
    var html = stats + '<section class="psec"><h3>Plans<span>' + ps.length + '</span></h3>' + planCards + '</section>' +
      '<section class="psec">' +
        '<h3>定时任务<span>' + ss.length + '</span></h3>' +
        (ss.length ? renderStrip(ss) + bad.concat(ss.filter(function (x) { return !broken(x); })).map(taskHTML).join('')
          : '<div class="pempty">' + esc(roleNodeName()) + ' 名下没有定时任务 —— 让它 schedule_task 排一个</div>') +
      '</section>';
    // 心跳每 3s 重画一次 —— 没变就不碰 DOM (展开着的 prompt、悬停的提示都留着)。
    if (planEl._html === html) return;
    planEl._html = html;
    planEl.innerHTML = html;
    if (planResizeObserver) {
      planResizeObserver.disconnect();
      planEl.querySelectorAll('.plan-graph').forEach(function (graph) { planResizeObserver.observe(graph); });
    }
    planEl.querySelectorAll('.wchip.go').forEach(function (c) {
      c.onclick = function (ev) { ev.stopPropagation(); openNode(c.getAttribute('data-t')); };
    });
    planEl.querySelectorAll('.plan-node').forEach(function (n) {
      n.onclick = function () {
        var p = ps.filter(function (x) { return x.id === n.getAttribute('data-plan'); })[0];
        var t = p && (p.tasks || []).filter(function (x) { return x.id === n.getAttribute('data-task-id'); })[0];
        if (p && t) showTaskDetail(p, t);
      };
    });
    redrawPlanEdges();
    planEl.querySelectorAll('.pprompt').forEach(function (d) {
      d.ontoggle = function () { PLAN_OPEN[d.getAttribute('data-id')] = d.open; planEl._html = ''; };
    });
    planEl.querySelectorAll('.strip .pin').forEach(function (p) {
      p.onclick = function () {
        var card = planEl.querySelector('.tcard[data-id="' + cssEsc(p.getAttribute('data-id')) + '"]');
        if (!card) return;
        card.scrollIntoView({ block: 'center', behavior: 'smooth' });
        card.classList.remove('flash'); void card.offsetWidth; card.classList.add('flash');
      };
    });
  };
  // ── 载入 / 渲染 ────────────────────────────────────────────────────
  var scrollState = function () {
    return { top: thread.scrollTop, pinned: thread.scrollHeight - thread.scrollTop - thread.clientHeight < 90 };
  };
  var restore = function (st) { thread.scrollTop = st.pinned ? thread.scrollHeight : st.top; };
  var scrollBottom = function () { thread.scrollTop = thread.scrollHeight; };
  // 左上角 = 这一页的主张: 站在谁的位置上, 它一睁眼背着什么 (宪章), 家在哪、什么时候出生。
  // room 模式下改成这个 room 的一行摘要 —— 不留空栏。
  var fact = function (ic, txt, tip, attr, tone) {
    var cls = 'fx' + (attr === 'charter' && S.charter ? ' on' : '') + (attr === 'plan' && S.pane === 'plan' ? ' on' : '') + (tone ? ' ' + tone : '');
    return '<span' + (attr ? ' class="' + cls + '" data-rb="' + attr + '"' : '') + ' title="' + esc(tip || txt) + '">' + ic + ' ' + esc(txt) + '</span>';
  };
  // room 没有名字时服务端会把成员名拼起来当 label —— 那是给关系用的, 不能当标题。
  var roomTitle = function (r) {
    if (!r) return D.roomId;
    if (r.title || W.chatNames[r.id]) return r.title || W.chatNames[r.id];
    if (r.kind === 'dm') {
      var two = (r.members || []).slice(0, 2).map(function (m) { return m.name; }).filter(Boolean);
      return two.length ? two.join(' ↔ ') : '私聊';
    }
    // 没起名的 adhoc: 列表里一排「临时 room」认不出谁是谁 —— 带上前几位成员。
    if (r.kind === 'adhoc') {
      var few = (r.members || []).slice(0, 3).map(function (m) { return m.name; }).filter(Boolean);
      return few.length ? '临时 · ' + few.join('、') + ((r.members || []).length > 3 ? ' 等' : '') : shortRoom(r.id);
    }
    return shortRoom(r.id);
  };
  var rolebar = function () {
    var el = $('#rb-who');
    if (!el) return;
    if (D.mode === 'room') {
      var r = D.room || { members: [] };
      var host = r.host ? nodeOf(nodeIdOf(r.host)).name : '无人 (人兜底)';
      el.innerHTML = '<div class="id"><span class="av">' + esc(KIND_IC[r.kind] || '·') + '</span><span class="l">' +
        '<span class="nl"><span class="nm">' + esc(roomTitle(r)) + '</span></span>' +
        '<span class="facts">' + fact('👥', (r.members || []).length + ' 人', '房间成员') +
        fact('⭐', host, 'host = 现存最早加入的 wizard') +
        '</span></span></div>';
      var av = el.querySelector('.av');
      if (av) av.title = (isPeopleRoom(r) ? '群聊' : '会话') + ' · ' + (r.bound ? '已绑定企微, 消息镜像进企微' : '只在 rolepage 里');
      document.title = roomTitle(r) + ' · 对话现场';
      return;
    }
    var w = D.wizard;
    if (!w) { el.innerHTML = ''; return; }
    var born = w.bornAt || (D.sessions || []).reduce(function (m, s) { return s.start && (!m || s.start < m) ? s.start : m; }, 0);
    var cb = D.charterBrief;
    // 链接指的那个化身 (target 的 #tag) 与这一页的规范身份不同时说出来 —— 同身份多化身在
    // rolepage 聚成一页 (见 makeDirectory 的 canon), 不说明会看着像「点错了 / 没选中」。
    var want = ROLE.indexOf("#") > 0 ? ROLE.split("#").pop() : (/^(chat|user):/.test(ROLE) ? ROLE : "");
    var tip = want && want !== (w.name || "") && ROLE !== w.id
      ? fact("🔗", "链接指向 " + want, "链接来自 " + want + "; 它与 " + (w.name || w.id) + " 是同一个身份的化身, 这一页是它的规范页") : "";
    // 日程排最后, 可点: 名下排了什么 (main 的口径 —— 名片是这一栏唯一的入口)。
    var pf = schedulesForRole().length || plansForRole().length ? planFact() : null;
    var facts = [
      tip,
      w.chat ? fact('🏠', w.chat, 'home 群: ' + w.chat) : '',
      born ? fact('🐣', fmtAgo(born), '出生于 ' + fmtDay(born)) : '',
      cb ? fact('📜', '≈' + fmtTok(cb.tokens), '宪章 ≈' + fmtTok(cb.tokens) + ' token · ' + fmtClock(cb.at) + ' 压进系统提示 · 点开看全文', 'charter') : '',
      w.cwd ? fact('🗂️', shortCwd(w.cwd), w.cwd) : '',
      pf ? fact(pf[0], pf[1], pf[2], pf[3], pf[4]) : '',
    ].filter(Boolean).join('');
    var st = w.busy ? '<span class="rv-chip go">执行中</span>'
      : w.waiting && w.waiting.length ? '<span class="rv-chip warn">等审批 ' + esc(w.waiting.join(',')) + '</span>'
      : w.alive ? '<span class="rv-chip ok">在线</span>' : '<span class="rv-chip">冷</span>';
    // 会话切换属于「这个角色」: 放在左上的名片里, 不占右栏头。
    // 会话切换 = main 的那个下拉 (name 右边): 只有一段就没什么可选, 不挂。
    var sess = (D.sessions || []).length > 1 ? sessPicker() : '';
    el.innerHTML = '<div class="id"><span class="av">' + esc(w.label || '🧙‍♂️') + '</span><span class="l">' +
      '<span class="nl"><span class="cp" title="' + esc('点击复制 ' + (w.name || w.id)) + '"><span class="nm">' + esc(w.name || w.id) + '</span></span>' +
      '<span id="rb-st">' + st + '</span><span id="rb-sp">' + sess + '</span></span>' +
      (facts ? '<span class="facts">' + facts + '</span>' : '') +
      '</span></div>' + (w.description ? '<p class="job">' + esc(w.description) + '</p>' : '');
    var cp = el.querySelector('.cp');
    bindSessPicker();
    if (cp) cp.onclick = function () { copyText(w.name || w.id); };
    el.querySelectorAll('[data-rb]').forEach(function (x) {
      var a = x.getAttribute('data-rb');
      x.onclick = a === 'charter' ? function () { toggleCharter(); }
        : function () { setPane(S.pane === 'plan' ? 'msgs' : 'plan'); };
    });
    document.title = (w.label ? w.label + ' ' : '') + (w.name || w.id) + ' 的视角';
    setFavicon(w.label);
  };
  var renderRoom = function () {
    var r = D.room || { id: D.roomId, kind: 'wecom-group', members: [], openDuties: 0 };
    var label = roomTitle(r);
    // 顶栏只管「这是哪个窗口」: host / 成员 / 绑定都在左上名片与成员侧栏。
    header(esc(label), '', '');
    rolebar();
    renderUsage();
    renderGraphSide();
    var older = D.earlier ? '<button class="rv-older" id="rv-older">‹ 更早</button>' : '';
    inner.innerHTML = older + listHTML(D.msgs, false);
    if (S.hit && S.hit.until > Date.now()) { var hr = inner.querySelector('.rv-msg[data-id="' + cssEsc(S.hit.id) + '"]'); if (hr) hr.classList.add('hit'); }
    var o = $('#rv-older'); if (o) o.onclick = function () { olderPage(); };
    restoreOpen();
    renderSide();
  };
  var renderWizard = function (skipBody) {
    var w = D.wizard || { name: D.role, label: '🧙‍♂️' };
    var plan = S.pane === 'plan';
    // 顶栏只有标题与视角切换: 模型 / 在线 / 职责都属于这个 role, 在左上名片 (模型在底部用量条上)。
    // 日程是同一个窗口的另一面 —— 标题改成「谁的日程」, 右上角回对话。
    header(plan ? '<span class="rv-lb">📅</span> 日程与计划'
      : '<span class="rv-lb">' + esc(w.label || '🧙‍♂️') + '</span> ' + esc(w.name || D.role),
      plan ? esc(roleNodeName()) + ' 名下的定时任务与计划' : '',
      plan ? '<button class="rv-act" id="rv-back">‹ 对话</button>'
        : '<button class="rv-act' + (D.all ? ' on' : '') + '" id="rv-all" title="' +
            (D.all ? '只看它说的 / 点名它的 / 回它那几条的' : '它所在的 room 里全部的消息') + '">' +
            (D.all ? '全部消息' : '只看与我相关') + '</button>');
    rolebar();
    renderGraphSide();
    renderUsage();
    if (plan) { renderPlan(); return; }  // 正文在日程栏里, 时间轴的 DOM 原样留着
    if (skipBody) return;  // 时间轴没变: 头更新了, 正文留给 DOM (展开态 / 滚动位置不受打扰)
    var older = '';
    var note = D.ledger ? '' : '<div class="rv-note">这个部署没有 room 账本 — 只能看名片, 看不到消息 (要历史请打开 daemon 的 rolepage)。</div>';
    var ot = openTools();
    inner.innerHTML = note + older + (D.stream ? streamHTML(D.stream) : listHTML(D.msgs, true)) + (S.charter ? '<section class="rv-charter">' + S.charter + '</section>' : '');
    fillMd(inner);
    applyFold(inner);
    reopenTools(ot);
    restoreOpen();
    renderSide();
  };
  var loadRoom = function (id, limit) {
    D.mode = 'room'; D.roomId = id; D.role = ''; D.mode0 = 'room'; S.charter = null; resetPane(); syncUrl();
    // 后发先至: 定时刷新的那一发晚于点开 / 搜索跳转回来时, 丢掉它 (不然会把视图拽回旧 room / 拽回底部)。
    var gen = S.roomGen = (S.roomGen || 0) + 1;
    return api('api/room', { room: id, limit: limit || 60 }).then(function (r) {
      if (gen !== S.roomGen) return false;
      if (!r.ok) { inner.innerHTML = '<div class="rv-none">' + esc(r.error || '加载失败') + '</div>'; if (gside) gside.hidden = true; return; }
      D.room = r.room; D.label = r.label || ''; D.members = r.members || []; D.duties = r.duties || [];
      D.msgs = r.msgs || []; D.total = r.total || 0; D.earlier = r.earlier || ''; D.at = r.at;
      renderRoom(); scrollBottom();
    });
  };
  var loadWizard = function (role, keepScroll) {
    // 换一个人 = 换一段对话: 日程栏只属于刚才那个人, 收回对话面。
    if (role && D.mode === 'wizard' && role !== D.role) resetPane();
    D.mode = 'wizard'; D.role = role || D.role; D.roomId = ''; syncUrl();
    var st = scrollState();
    return api('api/wizard', { role: role, all: D.all ? '1' : '', session: D.session === 'all' ? '' : D.session, limit: 60 }).then(function (r) {
      if (!r.ok) { inner.innerHTML = '<div class="rv-none">' + esc(r.error || '加载失败') + '</div>'; return false; }
      var same = D.mode0 === 'wizard' && D.role0 === role && !!D.stream && D.streamSig === streamSig(r.stream);
      D.mode0 = 'wizard'; D.role0 = role;
      // 没在 URL 里指定视角的老链接 / 只有 id 的票据: 服务端按票据给出落点, 这里认下来并回写 URL。
      if (!role && r.role && r.role.id) { D.role = r.role.id; syncUrl(); }
      D.wizard = r.role; D.uid = r.uid || ''; D.msgs = r.msgs || []; D.total = r.total || 0; D.earlier = r.earlier || '';
      D.stream = r.stream || null; D.streamSig = streamSig(r.stream);
      D.sessions = r.sessions || []; D.session = r.session || 'all'; D.ledger = r.ledger !== false;
      D.plans = r.plans || []; D.schedules = r.schedules || []; D.charterBrief = r.charter || null; D.at = r.at; D.recvAt = Date.now();
      D.stats = r.stats || null;
      D.members = []; D.duties = [];
      renderWizard(same);
      if (!same) { if (keepScroll) restore(st); else scrollBottom(); }
      return true;
    });
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
      fillMd(box);
      applyFold(box);
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
    fillMd(box);
    applyFold(box);
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
      fillMd(body);
    }).catch(function () { body.setAttribute('data-err', '1'); }).then(function () { body._busy = false; });
  };
  inner.addEventListener('toggle', function (e) {
    var d = e.target;
    if (d.open && d.classList && d.classList.contains('tool-call')) loadTool(d);
  }, true);

  // 过程框的收起: 框头与框内空白是开关; 落在某一行工具上的点击归那一行自己。
  // 人手点过的框按 data-key 记下 —— 4s 轮询整段重画后按它回填, 不会被收回去。
  var FOLD = {};
  var childBy = function (el, cls) {
    for (var i = 0; i < el.children.length; i++) if (el.children[i].classList.contains(cls)) return el.children[i];
    return null;
  };
  var applyFold = function (root) {
    root.querySelectorAll('.steps[data-key]').forEach(function (s) {
      var v = FOLD[s.getAttribute('data-key')];
      if (v !== undefined) s.classList.toggle('folded', v);
    });
  };
  inner.addEventListener('click', function (e) {
    var s = e.target.closest && e.target.closest('.steps');
    if (s && (e.target.closest('.steps-head') || e.target === s || e.target === childBy(s, 'bubbles'))) {
      FOLD[s.getAttribute('data-key')] = s.classList.toggle('folded');
      return;
    }
    // reminder 标签: 摘要 ⇄ 原文。刚划选了一段原文的那次松手不算点击。
    var r = e.target.closest && e.target.closest('.rem');
    if (r && !String(window.getSelection() || '')) r.classList.toggle('raw');
  });

  // ── 用量条: 一组轮次的总账 (wizard 的整页页脚; 选了会话段就只算那一段) ──
  // 按单价从省到贵排: 缓存读 (边线色) → 新输入 → 输出 → 缓存写。
  var SEGS = [
    ['cacheRead', '缓存读', 'var(--line)', 'cr'], ['input', '新输入 (未走缓存)', 'var(--accent)', 'in'],
    ['output', '输出', 'var(--human)', 'out'], ['cacheWrite', '缓存写', 'var(--priv)', 'cw'],
  ];
  var TIP = { turns: '对话轮数', tools: '工具调用次数', api: 'API 请求次数', ctx: '上下文 — 最近一次请求送入的 input + 缓存' };
  var ICON = { cost: '💰', turns: '💬', tools: '🛠️', api: '⇄', ctx: '📄' };
  var fmtUsd = function (n) { return n < .01 ? '<$0.01' : '$' + (n < 10 ? n.toFixed(2) : n < 1000 ? n.toFixed(1) : Math.round(n)); };
  var BILL = [['input', 'in', 'in'], ['output', 'out', 'out'], ['cacheWrite', 'cw', 'cacheWrite'], ['cacheRead', 'cr', 'cacheRead']];
  var usd4 = function (n) { return '$' + (n >= 100 ? n.toFixed(2) : n.toFixed(4)); };
  var billLines = function (b) {
    var head = b.label + (b.model && b.model !== b.label ? ' (' + b.model + ')' : '') + ' · ' + b.calls + ' 次请求';
    if (!b.price) return [head, '  价格表里认不出, 未计入'];
    return [head, '  单价 $/百万: ' + BILL.map(function (k) { return k[1] + ' ' + b.price[k[2]]; }).join(' · ')]
      .concat(BILL.filter(function (k) { return b[k[0]] > 0; }).map(function (k) {
        return '  ' + k[1] + ' ' + b[k[0]].toLocaleString('en-US') + ' × $' + b.price[k[2]] + ' / 1M = ' + usd4(b[k[0]] * b.price[k[2]] / 1e6);
      }))
      .concat(['  小计 ' + usd4(b.cost)]);
  };
  var costKv = function (u) {
    if (!u.cost) return '';
    var txt = (u.unpriced ? '≥' : '') + fmtUsd(u.cost);
    var bill = u.bill || [];
    var priced = bill.filter(function (b) { return b.price; });
    var tip = ['估算费用 ' + usd4(u.cost) + ' — 按模型单价 (LiteLLM 价格表快照, USD / 百万 token) 逐项累加', '']
      .concat(bill.reduce(function (a, b) { return a.concat(billLines(b), ['']); }, []))
      .concat(priced.length > 1 ? ['合计 ' + priced.map(function (b) { return usd4(b.cost); }).join(' + ') + ' = ' + usd4(u.cost)] : [])
      .concat(u.unpriced ? ['另有 ' + u.unpriced + ' 次 API 请求的模型不在价格表里, 未计入'] : [])
      .join('\n').replace(/\n+$/, '');
    return '<span class="kv kv-cost" title="' + esc(tip) + '" data-tip="' + esc(ICON.cost + ' ' + txt) + '"><i class="u-ic">' + ICON.cost + '</i><b>' + esc(txt) + '</b></span>';
  };
  var usageHTML = function (t, who) {
    var u = t.usage || {};
    var segs = SEGS.filter(function (s) { return u[s[0]] > 0; });
    var total = segs.reduce(function (a, s) { return a + u[s[0]]; }, 0);
    var kv = function (k, n, text) {
      return n ? '<span class="kv kv-' + k + '" title="' + esc(TIP[k] || k) + '" data-tip="' + esc(ICON[k] + ' ' + text) +
        '"><i class="u-ic">' + ICON[k] + '</i><b>' + esc(text) + '</b></span>' : '';
    };
    var pct = function (n) {
      var p = n / total * 100;
      return p < .1 ? '<0.1%' : (p < 1 || p > 99 ? p.toFixed(1) : Math.round(p)) + '%';
    };
    var io = total > 0
      ? '<span class="bar" title="' + esc(['累计 token I/O · 共 ' + fmtTok(total),
          '送入合计 (in + cr + cw) ' + fmtTok((u.input || 0) + (u.cacheRead || 0) + (u.cacheWrite || 0))].concat(segs.map(function (s) {
          return s[1] + ' ' + fmtTok(u[s[0]]) + ' · ' + pct(u[s[0]]);
        })).join('\n')) + '">' + segs.map(function (s) {
          return '<span class="seg" style="flex-grow:' + u[s[0]] + ';background:' + s[2] + '" title="' + s[1] + ' ' + fmtTok(u[s[0]]) + ' · ' + pct(u[s[0]]) + '"></span>';
        }).join('') + '</span>' +
        '<span class="leg" data-tip="' + esc(segs.map(function (s) { return s[3] + ' ' + fmtTok(u[s[0]]); }).join(' · ')) + '">' +
        segs.map(function (s) {
          return '<span class="lg" title="' + s[1] + ' ' + fmtTok(u[s[0]]) + ' · ' + pct(u[s[0]]) + '"><i style="background:' + s[2] + '"></i>' + s[3] + '<b>' + fmtTok(u[s[0]]) + '</b></span>';
        }).join('') + '</span>'
      : '';
    // 条首是账的主人 (头像 + 名字), 再是模型: 这本账是谁、拿什么跑出来的。
    return '<span class="u-who" title="' + esc(who.name) + '">' + esc(who.label || '🧙‍♂️') +
        '<span class="u-nm" data-tip="' + esc(who.name) + '">' + esc(who.name) + '</span></span>' +
      '<span class="u-lb" title="' + esc(t.model || '') + '">' + esc(t.modelLabel || t.model || '用量') + '</span>' +
      (t.effort ? '<span class="u-ef" title="effort 档位">' + esc(t.effort) + '</span>' : '') +
      '<span class="u-kvs">' + costKv(u) + kv('turns', t.turns, t.turns) + kv('tools', u.tools, u.tools) + kv('api', u.calls, u.calls) +
        kv('ctx', u.ctx, fmtTok(u.ctx)) + '</span>' + io;
  };
  // 永远单行: 排不下就一级级藏 (计数 → 分布文字 → 名字), 宽度回来再放出来; 藏起来的进整条的 title。
  var UFOLD = ['f-cnt', 'f-leg', 'f-nm'];
  var UFOLDED = { 'f-cnt': '.kv-turns, .kv-tools, .kv-api', 'f-leg': '.leg', 'f-nm': '.u-nm' };
  var fitUsage = function (el) {
    if (el.hidden) return;
    var over = function () { return el.scrollWidth > el.clientWidth; };
    UFOLD.forEach(function (c) { el.classList.remove(c); });
    var n = 0;
    while (n < UFOLD.length && over()) el.classList.add(UFOLD[n++]);
    el.title = UFOLD.slice(0, n).reduce(function (a, c) {
      return a.concat([].map.call(el.querySelectorAll(UFOLDED[c]), function (x) { return x.getAttribute('data-tip'); }));
    }, []).filter(Boolean).join('\n');
  };
  var watchUsage = function (el) {
    if (el._ro || typeof ResizeObserver === 'undefined') return;
    var w = -1;
    el._ro = new ResizeObserver(function (es) {
      var cw = Math.round(es[0].contentRect.width);
      if (cw !== w) { w = cw; fitUsage(el); }
    });
    el._ro.observe(el);
  };
  // 没变就不碰 DOM: 轮询每 4s 来一次, 重建会把悬停中的 tooltip 蹭掉。
  var putUsage = function (el, t, who) {
    var html = t ? usageHTML(t, who) : '';
    if (!el || el._html === html) return;
    var pinned = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 90;
    el._html = html; el.innerHTML = html; el.hidden = !html;
    watchUsage(el); fitUsage(el);
    if (pinned) scrollBottom();   // 条的高度挤的是消息区: 原本贴底的继续贴底
  };
  // 账属于 wizard: room 视图没有自己的轮次, 不挂。
  var renderUsage = function () {
    var w = D.wizard;
    putUsage($('#pg-usage'), D.mode === 'wizard' && w && w.kind === 'wizard' ? D.stats : null, { name: w ? w.name || w.id : '', label: w ? w.label : '' });
  };
  // 进行中那一轮的耗时: 服务端只给开始时刻, 这里每秒按它走表 (与服务端 fmtDuration 同一写法)。
  var fmtDur = function (ms) {
    if (ms < 1000) return ms + 'ms';
    var s = Math.round(ms / 100) / 10;
    if (s < 60) return s + 's';
    var m = Math.floor(s / 60);
    return m + 'm' + Math.round(s - m * 60) + 's';
  };
  setInterval(function () {
    var off = D.at ? D.at - (D.recvAt || Date.now()) : 0;
    document.querySelectorAll('.tg-dur.live[data-since]').forEach(function (el) {
      el.textContent = fmtDur(Math.floor(Math.max(0, Date.now() + off - Number(el.getAttribute('data-since'))) / 1000) * 1000);
    });
  }, 1000);
  // favicon = 当前 role 的头像 emoji。
  var setFavicon = function (emoji) {
    if (!emoji) return;
    var link = document.querySelector('link[rel="icon"]') || document.head.appendChild(Object.assign(document.createElement('link'), { rel: 'icon' }));
    link.type = 'image/svg+xml';
    link.href = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text x="50" y="50" font-size="86" text-anchor="middle" dominant-baseline="central">' + esc(emoji) + '</text></svg>');
  };

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
      W.at = r.at; W.rooms = r.rooms || []; W.nodes = r.nodes || [];
      W.uidTargets = r.uidTargets || {}; W.chatNames = r.chatNames || {}; W.names = r.names || {}; W.degraded = !!r.degraded;
      // 日程栏要的 plans / 定时任务: 名册快照里就是全量 (带 gate 与出错), 每 6s 一次, 开着就看得到最新。
      W.plans = r.plans || []; W.schedules = r.schedules || [];
      renderSide();
      if (S.pane === 'plan') { renderPlan(); return r; }
      return r;
    }).catch(function () { worldReq = null; });
    return worldReq;
  };

  // ── 事件 / 轮询 ────────────────────────────────────────────────────
  inner.addEventListener('click', function (e) {
    var t = e.target;
    if (!t.closest) return;
    // 行尾 chevron 只管展开原文; 提示行 (<summary>) 上的名字 / 整行点了换到那个 wizard, 不顺带展开。
    if (t.closest('.ho-chev')) return;
    var g = t.closest('[data-node]');
    if (g) { var id = g.getAttribute('data-node'); if (id) { if (t.closest('summary')) e.preventDefault(); loadWizard(id); return; } }
    var j = t.closest('[data-jump-room]');
    if (j) { loadRoom(j.getAttribute('data-jump-room')); return; }
    var rb = t.closest('[data-raw-toggle]');
    if (rb) { var ra = rb.closest('.rv-msg'); if (ra) { ra.classList.toggle('raw'); rb.classList.toggle('on'); } return; }
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
    if (D.mode === 'room') loadRoom(D.roomId, Math.max(60, D.msgs.length)).then(function (ok) {
      if (ok === false) return;
      var hr = S.hit && S.hit.until > Date.now() && rowEl(S.hit.id);
      if (hr) hr.scrollIntoView({ block: 'center' }); else restore(st);
    });
    else if (D.mode === 'wizard') loadWizard(D.role, true);
  };
  setInterval(tick, TICK_MS);
  var rzTimer = 0;
  window.addEventListener('resize', function () {
    clearTimeout(rzTimer);
    rzTimer = setTimeout(function () { if (W.rooms.length && S.view === 'graph') renderGraph(); }, 200);
  });
  setInterval(function () { if (!document.hidden) loadWorld(); }, WORLD_MS);

  // ══ 搜索 (⌘K / Ctrl+K) ═══════════════════════════════════════════════
  // 照 main 的行为: 名片下一个入口, 点开 / ⌘K 弹居中面板; 一次搜三样 —— room 名 (→ 打开)、成员 (→ 它的视角)、
  // 消息正文 (→ 打开那个 room 并定位到那一句)。空查询列最近的 room, 面板本身就是键盘快速切换器。
  var MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
  var KBD = MAC ? '⌘K' : 'Ctrl K';
  var SEARCH_SVG = '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="4.6"/><path d="m10.4 10.4 3.6 3.6"/></svg>';
  var sbox = document.createElement('button');
  sbox.className = 'sbox'; sbox.type = 'button'; sbox.id = 'sbox';
  sbox.innerHTML = '<span class="ic">' + SEARCH_SVG + '</span><span class="lb">搜索 room、成员、消息</span><kbd>' + KBD + '</kbd>';
  sbox.onclick = function () { openSearch(); };
  if ($('#rolebar')) $('#rolebar').parentNode.insertBefore(sbox, $('#rolebar').nextSibling);

  var Q = { open: false, q: '', done: null, enter: false, items: [], sel: 0, gen: 0, timer: 0 };
  var sk = document.body.appendChild(document.createElement('div'));
  sk.className = 'sk'; sk.hidden = true;
  sk.innerHTML = '<div class="sk-panel" role="dialog" aria-label="搜索">' +
      '<div class="sk-in"><span class="ic">' + SEARCH_SVG + '</span>' +
        '<input id="sk-q" type="search" autocomplete="off" spellcheck="false" placeholder="搜索 room、成员、消息…" aria-controls="sk-list">' +
        '<kbd>esc</kbd></div>' +
      '<div class="sk-list" id="sk-list" role="listbox"></div>' +
      '<div class="sk-foot"><span><kbd>↑</kbd><kbd>↓</kbd> 选择</span><span><kbd>↵</kbd> 打开</span><span><kbd>esc</kbd> 关闭</span></div>' +
    '</div>';
  var skQ = sk.querySelector('#sk-q'), skList = sk.querySelector('#sk-list');

  var reEsc = function (x) { return x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); };
  // 先切再转义: 命中段包 <mark>, 其余照常 esc。
  var hl = function (text, q) {
    var ts = String(q || '').toLowerCase().split(/\s+/).filter(Boolean);
    if (!ts.length) return esc(text);
    var re = new RegExp('(' + ts.map(reEsc).join('|') + ')', 'ig');
    return String(text).split(re).map(function (p, i) { return i % 2 ? '<mark>' + esc(p) + '</mark>' : esc(p); }).join('');
  };
  var skTs = function (ts) { return ts ? '<time class="ts" title="' + esc(fmtDay(ts)) + '">' + esc(fmtAgo(ts)) + '</time>' : ''; };
  var groupTag = function (group) { return '<span class="tag">' + (group ? '群聊' : '会话') + '</span>'; };
  // 一项 = { kind, html, go }: 画什么、回车做什么。
  var roomHitItem = function (r, q) {
    return {
      kind: 'conv',
      html: '<span class="av">' + esc(KIND_IC[r.kind] || '·') + '</span><span class="b"><span class="l1">' +
        '<span class="nm chat">' + hl(r.name, q) + '</span>' + groupTag(r.group) + skTs(r.lastAt) + '</span>' +
        (r.preview ? '<span class="pv">' + esc(r.preview) + '</span>' : '') + '</span>',
      go: function () { loadRoom(r.id); },
    };
  };
  var memberItem = function (m, q) {
    var human = m.who.kind === 'human';
    return {
      kind: 'role',
      html: '<span class="av">' + (human ? '👤' : esc(nodeOf(nodeIdOf(m.who)).label || '🧙‍♂️')) + '</span><span class="b"><span class="l1">' +
        '<span class="nm ' + (human ? 'human' : 'wizard') + '">' + hl(m.name, q) + '</span><span class="k">切到视角</span></span>' +
        '<span class="pv">在 ' + m.rooms + ' 个 room' + (m.lastAt ? ' · 最近 ' + esc(fmtAgo(m.lastAt)) : '') + '</span></span>',
      go: function () { loadWizard(nodeIdOf(m.who)); },
    };
  };
  // 三层: 谁 → 对谁 · 何时 / 命中的那一截 / 在哪个 room。
  var msgItem = function (h, q) {
    var human = h.author.kind === 'human';
    var to = (h.toNames || []).length ? ' → <span class="nm">' + esc(h.toNames.join('、')) + '</span>' : '';
    return {
      kind: 'msg',
      html: '<span class="av">' + (human ? '👤' : esc(nodeOf(nodeIdOf(h.author)).label || '🧙‍♂️')) + '</span><span class="b"><span class="l1">' +
        '<span class="said"><span class="nm ' + (human ? 'human' : 'wizard') + '">' + esc(h.authorName) + '</span>' + to + '</span>' + skTs(h.at) + '</span>' +
        '<span class="sn">' + hl(h.snippet, q) + '</span>' +
        '<span class="l3"><span class="where' + (h.group ? '' : ' priv') + '"><i>' + esc(KIND_IC[h.roomKind] || '·') + '</i>' +
          (h.group ? '群聊' : '会话') + ' · ' + esc(h.roomName) + '</span>' +
          (h.hits > 1 ? '<span class="cnt">' + h.hits + ' 处命中</span>' : '') + '</span></span>',
      go: function () { jumpRow(h); },
    };
  };
  // 定位一行: 打开它的 room; 不在已取的那一截里就往前翻页 (最多 20 页), 滚到中间闪一下。
  var rowEl = function (id) { return inner.querySelector('.rv-msg[data-id="' + cssEsc(id) + '"]'); };
  var jumpRow = function (h) {
    var land = function (left) {
      var row = rowEl(h.id);
      if (row) {
        // 比半屏还高的一条: 居中会把它的开头推出视口, 改成顶对齐。
        row.scrollIntoView({ block: row.offsetHeight > thread.clientHeight * 0.6 ? 'start' : 'center' });
        row.classList.remove('hit'); void row.offsetWidth; row.classList.add('hit');
        // 定时刷新会整段重画 room —— 记住落点, 重画后补回 (闪完为止)。
        S.hit = { id: h.id, until: Date.now() + 2000 };
        return;
      }
      if (left > 0 && D.mode === 'room' && D.roomId === h.room && D.earlier) olderPage().then(function () { land(left - 1); });
    };
    loadRoom(h.room).then(function () { land(20); });
  };

  var paintSearch = function (sections) {
    Q.items = sections.reduce(function (a, x) { return a.concat(x.items); }, []);
    Q.sel = Math.min(Q.sel, Math.max(0, Q.items.length - 1));
    var n = 0;
    skList.innerHTML = sections.filter(function (x) { return x.items.length || x.empty; }).map(function (x) {
      return '<h3>' + esc(x.title) + (x.count ? '<span>' + x.count + '</span>' : '') + '</h3>' +
        (x.items.length
          ? x.items.map(function (it) {
              var i = n++;
              return '<button class="sk-it ' + it.kind + (i === Q.sel ? ' on' : '') + '" role="option" data-i="' + i + '" aria-selected="' + (i === Q.sel) + '">' + it.html + '</button>';
            }).join('')
          : '<div class="sk-empty">' + esc(x.empty) + '</div>');
    }).join('');
  };
  var moveSel = function (d) {
    if (!Q.items.length) return;
    Q.sel = (Q.sel + d + Q.items.length) % Q.items.length;
    skList.querySelectorAll('.sk-it').forEach(function (b) {
      var on = Number(b.getAttribute('data-i')) === Q.sel;
      b.classList.toggle('on', on); b.setAttribute('aria-selected', on);
      if (on) b.scrollIntoView({ block: 'nearest' });
    });
  };
  var pick = function (i) {
    var it = Q.items[i];
    if (!it) return;
    closeSearch();
    it.go();
  };
  var recent = function () {
    Q.done = '';
    var rooms = (W.rooms || []).slice().sort(function (a, b) { return (b.last ? b.last.at : 0) - (a.last ? a.last.at : 0); }).slice(0, 8);
    paintSearch([{ title: '最近的 room', empty: '还没有 room', items: rooms.map(function (r) {
      return roomHitItem({ id: r.id, kind: r.kind, name: roomTitle(r), group: isPeopleRoom(r), lastAt: r.last ? r.last.at : 0,
        preview: r.last ? (r.last.authorName ? r.last.authorName + ': ' : '') + r.last.preview : '' }, '');
    }) }]);
  };
  var runSearch = function () {
    var q = skQ.value.trim(), gen = ++Q.gen;
    Q.q = q; Q.sel = 0; Q.done = null;
    if (!q) return recent();
    api('api/search', { q: q }).then(function (d) {
      if (!d.ok || gen !== Q.gen) return;
      var sections = [
        { title: 'Room', items: d.rooms.map(function (r) { return roomHitItem(r, q); }) },
        { title: '成员', items: d.members.map(function (m) { return memberItem(m, q); }) },
        { title: '消息', count: d.msgTotal > d.msgs.length ? d.msgs.length + ' / ' + d.msgTotal : d.msgs.length,
          items: d.msgs.map(function (h) { return msgItem(h, q); }) },
      ];
      if (!d.rooms.length && !d.members.length && !d.msgs.length) sections = [{ title: '结果', items: [], empty: '没有找到「' + q + '」' }];
      paintSearch(sections);
      Q.done = q;
      // 结果还没回来时按下的回车, 落在回来的第一项上。
      if (Q.enter) { Q.enter = false; pick(Q.sel); }
    }).catch(function () { });
  };
  var openSearch = function () {
    if (Q.open) { skQ.select(); return; }
    Q.open = true; sk.hidden = false;
    skQ.value = Q.q; skQ.focus(); skQ.select();
    runSearch();
  };
  var closeSearch = function () {
    if (!Q.open) return;
    Q.open = false; sk.hidden = true; Q.enter = false;
    clearTimeout(Q.timer);
  };
  skQ.addEventListener('input', function () { clearTimeout(Q.timer); Q.timer = setTimeout(runSearch, 140); });
  skQ.addEventListener('keydown', function (e) {
    if (e.isComposing) return;   // 输入法选词时的回车 / 方向键归输入法
    if (e.key === 'ArrowDown' || (e.ctrlKey && e.key === 'n')) { e.preventDefault(); moveSel(1); }
    else if (e.key === 'ArrowUp' || (e.ctrlKey && e.key === 'p')) { e.preventDefault(); moveSel(-1); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      var v = skQ.value.trim();
      if (Q.done === v) return pick(Q.sel);
      Q.enter = true;
      if (Q.q !== v) { clearTimeout(Q.timer); runSearch(); }
    }
  });
  skList.addEventListener('click', function (e) {
    var b = e.target.closest('.sk-it');
    if (b) pick(Number(b.getAttribute('data-i')));
  });
  skList.addEventListener('mousemove', function (e) {
    var b = e.target.closest('.sk-it');
    if (b && Number(b.getAttribute('data-i')) !== Q.sel) moveSel(Number(b.getAttribute('data-i')) - Q.sel);
  });
  sk.addEventListener('mousedown', function (e) { if (e.target === sk) closeSearch(); });
  document.addEventListener('keydown', function (e) {
    if ((MAC ? e.metaKey : e.ctrlKey) && !e.altKey && !e.shiftKey && (e.key === 'k' || e.key === 'K')) {
      e.preventDefault();
      if (Q.open) closeSearch(); else openSearch();
    } else if (Q.open && e.key === 'Escape') { e.preventDefault(); closeSearch(); }
  });

  // ── 启动 ───────────────────────────────────────────────────────────
  var boot = function () {
    loadWorld().then(function () {
      if (ROOM) return loadRoom(ROOM);
      if (ROLE) return loadWizard(ROLE);
      // 只有票据 (消息尾部的 ✦ 链接): 服务端从这个 id 找回它属于哪个 wizard, 直接开那一页 ——
      // 深链打开时左栏必须是「这个人」, 不是一张随机 room。
      if (TOKEN) return loadWizard('').then(function (ok) { if (!ok) return showFirstRoom(); });
      return showFirstRoom();
    });
  };
  var showFirstRoom = function () {
      var first = (W.rooms || [])[0];
      if (first) return loadRoom(first.id);
      inner.innerHTML = '<div class="rv-none">还没有 room —— 说一句话, 或者在群里 .name 点名一个 wizard。</div>';
  };
  // ── 样式: 本页新加的 DOM 只在 chat.js 里, 样式也一并带上 (不改 web/chat.css, 无构建) ──
  var CSS = ".side-body { flex: 1; min-height: 0; display: flex }\n.convs { flex: 1; min-width: 0; overflow: auto; padding: 0 }\n.rv-ghead { display: flex; align-items: center; justify-content: space-between; gap: 6px; padding: 8px 10px 4px; color: var(--faint); font-size: 11.5px }\n.rv-gbtn { border: 1px solid var(--line); background: var(--card); border-radius: 6px; padding: 1px 7px; font-size: 11.5px; cursor: pointer; color: var(--mute) }\n.rv-gbtn.on { color: var(--accent); border-color: var(--accent) }\n.rv-gbtns { display: inline-flex; gap: 4px; flex: none }\n.rv-glb { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap }\n.rv-seg { display: inline-flex }\n.rv-seg .rv-gbtn { border-radius: 0 }\n.rv-seg .rv-gbtn:first-child { border-radius: 6px 0 0 6px }\n.rv-seg .rv-gbtn:last-child { border-radius: 0 6px 6px 0; margin-left: -1px }\n.rv-seg .rv-gbtn.on { position: relative; z-index: 1 }\n.rv-list { padding: 2px 8px 16px }\n.convs-h { padding: 2px 8px 0 }\n.convs-h h2 { margin-top: 6px }\n.convs h2 > span:nth-of-type(2) { flex: none }\n.convs h2 .vt + .vt { margin-left: 0 }\n.convs h2 .vt.on { color: var(--accent) }\n.convs h2 .vt svg { flex: none }\n@media (min-width: 761px) { .app.side-list .side { width: max(332px, 25vw) } }\n* { scrollbar-width: thin; scrollbar-color: var(--line) transparent }\n::-webkit-scrollbar { width: 8px; height: 8px }\n::-webkit-scrollbar-track { background: transparent }\n::-webkit-scrollbar-thumb { background: var(--line); border-radius: 8px; border: 2px solid transparent; background-clip: padding-box }\n::-webkit-scrollbar-thumb:hover { background-color: var(--faint) }\n::-webkit-scrollbar-corner { background: transparent }\n.thread-in, .gside, .rolebar, .rv-mh { overflow-wrap: anywhere }\n.rv-bub { min-width: 0; overflow-wrap: anywhere }\n.rv-files { min-width: 0 }\n.rv-files .rv-chip { white-space: normal; overflow-wrap: anywhere; max-width: 100%; line-height: 1.45; padding: 1px 7px }\n.rv-mh > * { min-width: 0 }\n.gs-mem .nm { white-space: normal; overflow-wrap: anywhere }\n.gs-cls { min-width: 0; overflow-wrap: anywhere }\n.rv-list .ci .l2 .rv-chip { flex: none }\n.rv-lnone { padding: 4px 10px 8px; color: var(--faint); font-size: 12px }\n.rv-msg.hit .rv-bub { animation: hit 1.6s ease-out }\n.rv-graph { display: block; font: 11.5px/1 -apple-system, BlinkMacSystemFont, sans-serif; cursor: grab; touch-action: none; user-select: none }\n.rv-edge { stroke: #c9d2df; stroke-width: 1 }\n.rv-edge.unread { stroke: #f2a7ad; stroke-width: 1.6 }\n.rv-edge.on { stroke: var(--accent); stroke-width: 1.6 }\n.rv-hit { stroke: transparent; stroke-width: 12; cursor: pointer }\n.rv-node { cursor: grab }\n.rv-room rect { fill: var(--them); stroke: var(--line) }\n.rv-room text { fill: var(--ink) }\n.rv-room.on rect { fill: var(--mine); stroke: var(--accent) }\n.rv-person circle { fill: var(--card); stroke: var(--mute); stroke-width: 1.4 }\n.rv-person circle.live { fill: var(--accent); stroke: var(--accent) }\n.rv-person.human circle { stroke: var(--human) }\n.rv-person text { fill: var(--ink); font-size: 10.5px }\n.rv-room text { font-size: 11px }\n.rv-person.on circle { stroke: var(--accent); stroke-width: 2.4 }\n.rv-person.ghost { opacity: .5 }\n.rv-duty { fill: #cf222e }\n.rv-ttl { font-size: 15.5px; line-height: 22px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap }\n.rv-sub { display: flex; flex-wrap: wrap; gap: 4px 6px; align-items: center; margin-top: 3px; font-size: 11.5px; color: var(--mute) }\n.rv-id { font-size: 11px; color: var(--faint); font-weight: 400 }\n.rv-lb { font-size: 15px }\n.rv-desc { max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap }\n.rv-chip { display: inline-flex; align-items: center; padding: 0 6px; border-radius: 999px; background: var(--them); color: var(--mute); font-size: 11px; line-height: 17px; white-space: nowrap }\n.rv-chip.ok { background: #e8f5ee; color: #1a7f3c }\n.rv-chip.warn { background: #fdf1e3; color: #9a5b10 }\n.rv-chip.ask, .rv-chip.bad { background: #fdecec; color: #b42318 }\n.rv-chip.go { background: var(--mine); color: var(--accent) }\n.rv-chip.file { background: var(--them-soft) }\n.rv-chip.re { background: transparent; color: var(--faint); border: 1px solid var(--line) }\n.rv-act { border: 1px solid var(--line); background: var(--card); border-radius: 7px; padding: 2px 9px; font-size: 12px; cursor: pointer; color: var(--mute) }\n.rv-act:hover, .rv-act.on { color: var(--accent); border-color: var(--accent) }\n.rbacts { display: flex; gap: 6px; align-items: center; margin-top: 2px }\n.rv-sel { border: 1px solid var(--line); background: var(--card); border-radius: 7px; padding: 2px 4px; font-size: 12px; color: var(--mute); max-width: 190px }\n/* 图右侧的成员列: 点开一个 room 才有, 看 wizard 时收起。 */\n.gside { flex: none; width: 208px; min-height: 0; overflow: auto; border-left: 1px solid var(--line); background: var(--card); padding: 8px }\n.gs-host { flex: none; font-size: 11px; line-height: 1 }\n.gside[hidden] { display: none }\n.gs-head { display: flex; justify-content: space-between; gap: 6px; padding: 0 2px 6px; color: var(--faint); font-size: 11px }\n.gs-head b { color: var(--mute); font-weight: 600 }\n.gs-duty { padding: 0 2px 6px; color: #b42318; font-size: 11px }\n.gs-list { display: flex; flex-direction: column; gap: 2px }\n.gs-mem { display: flex; align-items: center; gap: 6px; width: 100%; min-width: 0; padding: 4px 6px; border: 0; border-radius: 6px; background: none; color: var(--ink); text-align: left; cursor: pointer }\n.gs-mem:hover { background: var(--paper) }\n.gs-mem .nm { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px }\n.gs-mem.human .nm { color: var(--human) }\n.gs-mem.busy .nm { color: var(--accent) }\n.gs-st { flex: none; margin-left: auto; color: var(--faint); font-size: 10.5px }\n.gs-st.go { color: var(--accent) }\n.gs-cls { flex: none; color: var(--faint); font-size: 10.5px }\n@media (max-width: 760px) { .gside { display: none } }\n.rv-older { display: block; margin: 8px auto; border: 1px solid var(--line); background: var(--card); border-radius: 999px; padding: 2px 12px; font-size: 12px; color: var(--mute); cursor: pointer }\n/* 一条消息: 头在气泡外 (谁 → 谁 · room · 时刻), 气泡只装正文。 */\n.rv-msg { display: flex; flex-direction: column; gap: 3px; margin: 10px 12px; min-width: 0 }\n.rv-msg > .rv-mh { padding: 0 2px }\n.rv-bub { align-self: flex-start; max-width: min(88%, 720px); padding: 7px 11px; background: var(--them); border: 1px solid var(--them-line); border-radius: 3px 12px 12px 12px }\n.rv-msg.me .rv-bub { align-self: flex-end; background: var(--mine); border-color: var(--mine-line); border-radius: 12px 3px 12px 12px }\n.rv-msg.k-system .rv-bub { border-style: dashed }\n.rv-msg.me .rv-turn .bubbles > .say, .rv-msg.me .rv-said { align-self: flex-end }\n.rv-mh { display: flex; flex-wrap: wrap; gap: 4px 6px; align-items: center; font-size: 11.5px; color: var(--mute) }\n.rv-au { font-weight: 600; color: var(--ink); cursor: pointer }\n.rv-au:hover { text-decoration: underline dotted var(--faint); text-underline-offset: 3px }\n.rv-au.human { color: var(--human) }\n.rv-au.daemon { color: var(--wezard) }\n.rv-tag { color: var(--accent); cursor: pointer }\n.rv-roomtag { color: var(--chat); cursor: pointer; border: 1px solid var(--line); border-radius: 999px; padding: 0 6px }\n.rv-mh time { color: var(--faint) }\n.rv-open { border: 1px solid var(--line); background: transparent; border-radius: 6px; padding: 0 6px; font-size: 11px; color: var(--faint); cursor: pointer }\n.rv-open:hover { color: var(--accent); border-color: var(--accent) }\n.rv-tx { font-size: 13.5px; line-height: 1.6; overflow-wrap: anywhere }\n.rv-tx p { margin: 3px 0 }\n.rv-tx pre { background: var(--them); padding: 6px 8px; border-radius: 6px; overflow: auto; font-size: 12px }\n.rv-tx a { color: var(--accent) }\n.rv-empty { color: var(--faint); font-size: 12px; margin: 0 }\n.rv-box { margin-top: 4px; padding: 8px 10px; border: 1px dashed var(--line); border-radius: 10px; background: var(--card) }\n.rv-box[hidden] { display: none }\n.rv-turn { margin: 0; padding: 0; border: 0; background: none }\n.rv-turn .turn-group { margin: 0 }\n.rv-said { margin-top: 6px; display: flex; flex-direction: column; gap: 3px }\n.rv-saidrow { display: flex; gap: 6px; align-items: baseline; min-width: 0; font-size: 11.5px; color: var(--faint) }\n.rv-saidtx { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap }\n.rv-seq { font-family: ui-monospace, Menlo, monospace }\n.rv-mark { margin: 10px 12px; display: flex; justify-content: center }\n.rv-box .turn-group { margin: 0 }\n.rv-none { padding: 14px; color: var(--faint); font-size: 12.5px }\n.rv-note { margin: 8px 12px; padding: 7px 10px; border-radius: 8px; background: #fdf1e3; color: #9a5b10; font-size: 12px }\n.rv-plans, .rv-charter { margin: 12px; padding: 8px 10px; border: 1px solid var(--line); border-radius: 10px; background: var(--card); font-size: 12px }\n.rv-plans h4, .rv-charter h4 { margin: 6px 0 2px; font-size: 11.5px; color: var(--faint); font-weight: 600 }\n.rv-plans ul { margin: 0; padding-left: 16px }\n.rv-charter h5 { margin: 8px 0 2px; font-size: 11.5px; color: var(--faint) }\n.rv-charter pre { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; font-size: 11.5px; color: var(--mute) }\n/* 一轮写进账本的气泡: 过程框下面, 靠自己那一侧; 多颗时各带一行小头 (去处 / 定论)。 */\n.rv-spk { display: flex; flex-direction: column; gap: 2px; margin-top: 4px; min-width: 0 }\n.rv-msg.me .rv-spk { align-items: flex-end }\n.rv-smh { font-size: 11px }\n.rv-smh time { margin-left: 6px }\n.rv-files { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 4px }\n/* reminder 标签收在气泡底: 默认只露种类, 点开看原文。 */\n.rv-bub .rems { padding: 4px 0 0 }\n.rv-bub .rem-raw { max-height: 360px; overflow: auto }\n.rv-mh .mstat { display: inline-flex; gap: 6px; align-items: center; color: var(--faint) }\n.ho-who[data-node], .ho-line[data-node] { cursor: pointer }";
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
