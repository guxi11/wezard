// Rolepage SPA —— 从**一个 role 的视角**看它的 IM: 它参与的群聊与单聊, 每一处
// 它说了什么 (靠右)、听到了什么 (靠左)。点气泡对面那片空白就换成对方的视角。
//
//   对话  /api/role (身份 + 会话列表 + session) + /api/msgs (窗口正文) + /api/role-events (SSE)
//   关系  /api/world —— 聚焦当前 role 的家谱与协作网 (轮询)
//   日程  同一份 /api/world, 只列归当前 role 的定时任务与工单
//
// 视角状态 (role / conv / with / session) 全在 URL 里 —— 刷新、转发、从别的聊天点
// 进来, 落点都一样。消息正文是服务端渲染好的 HTML 片段 (diff / ANSI / 高亮只在
// shared/detail-render 实现一次), 这里只包左右与头像, 再做 DOM 增量 reconcile。
//
// 无构建步骤: 保持 var / function 写法, 直接被浏览器加载。
(function () {
  var qs = new URLSearchParams(location.search);
  var TOKEN = qs.get('id') || '';
  // 老链接只有 `target=` —— 服务端两个都认, 这里统一成 role。
  var ROLE = qs.get('role') || qs.get('target') || '';
  var CONV = qs.get('conv') || '';
  var WITH = qs.get('with') || '';
  var SESSION = qs.get('session') || '';
  var TICK_MS = 3000;

  // at / recvAt: 服务端快照时刻与本地收到时刻。所有"现在几点"的判断都换算到
  // 服务端时钟, 否则客户端时钟偏几分钟就会把运行中的会话判成已结束。
  var R = { at: 0, recvAt: 0, role: null, sessions: [], convs: [], relations: false, schedules: 0, stats: null, winStats: null };
  // frags: 当前窗口的原始片段 (id → 片段)。片段不带方向, 换视角时拿它就地重包左右。
  var S = { es: null, pinned: true, gen: 0, frags: {} };
  // 关系/日程两栏共用的世界快照。sel = 当前聚焦的节点, kinds = 边类型开关。
  var W = {
    at: 0, nodes: [], edges: [], chats: [], jobs: [], schedules: [],
    degraded: false, loaded: false, sel: '', onlyRel: false, kinds: { clone: 1, spawn: 1, peer: 1, graph: 1 },
    layout: 'cards',
  };
  // 读法是个人偏好, 记在本地。存储不可用 (隐私窗口 / 老 webview) 就退回默认。
  var LAY_KEY = 'wezard.world.layout';
  try { if (localStorage.getItem(LAY_KEY) === 'force') W.layout = 'force'; } catch (e) { }
  var setLayout = function (v) {
    W.layout = v;
    try { localStorage.setItem(LAY_KEY, v); } catch (e) { }
  };
  var VIEW = 'msgs';
  var $ = function (s) { return document.querySelector(s); };
  var app = $('#app'), thread = $('#thread'), inner = $('#thread-in'), convsEl = $('#convs');
  var wmapEl = $('#wmap'), wscrollEl = $('#wscroll'), wtoolsEl = $('#wtools'), planEl = $('#plan-in');

  var srvNow = function () { return R.at ? R.at + (Date.now() - R.recvAt) : Date.now(); };

  var fmtTok = function (n) {
    if (!n) return '0';
    if (n < 1000) return String(n);
    if (n < 1e6) { var v = n / 1000; return (v >= 10 ? v.toFixed(0) : v.toFixed(1).replace(/\.0$/, '')) + 'k'; }
    return (n / 1e6).toFixed(2).replace(/\.?0+$/, '') + 'M';
  };
  var fmtDur = function (ms) {
    if (ms < 1000) return ms + 'ms';
    var s = Math.round(ms / 1000);
    if (s < 60) return s + 's';
    var m = Math.floor(s / 60);
    if (m < 60) return m + 'm' + (s - m * 60) + 's';
    return Math.floor(m / 60) + 'h' + (m % 60) + 'm';
  };
  var pad = function (n) { return n < 10 ? '0' + n : '' + n; };
  var fmtDay = function (ts) {
    var x = new Date(ts);
    return x.getFullYear() + '-' + pad(x.getMonth() + 1) + '-' + pad(x.getDate()) + ' ' + pad(x.getHours()) + ':' + pad(x.getMinutes());
  };
  // 列表用的相对时间 — 一眼看出"刚刚 / 5 分钟前"。
  var fmtAgo = function (ts) {
    if (!ts) return '';
    var d = srvNow() - ts;
    if (d < 60000) return '刚刚';
    if (d < 3600000) return Math.floor(d / 60000) + '分钟前';
    if (d < 86400000) return Math.floor(d / 3600000) + '小时前';
    var x = new Date(ts);
    return pad(x.getMonth() + 1) + '-' + pad(x.getDate()) + ' ' + pad(x.getHours()) + ':' + pad(x.getMinutes());
  };
  var fmtHM = function (ts) { var x = new Date(ts); return pad(x.getHours()) + ':' + pad(x.getMinutes()); };
  var fmtFull = function (ts) {
    var x = new Date(ts);
    return (x.getMonth() + 1) + '-' + pad(x.getDate()) + ' ' + pad(x.getHours()) + ':' +
      pad(x.getMinutes()) + ':' + pad(x.getSeconds());
  };
  /** 一条消息的时刻 —— 只写在气泡外面这一处, 气泡里不再重复。 */
  var stamp = function (ts) {
    return '<time class="mt" title="' + esc(fmtFull(ts)) + '">' + esc(fmtHM(ts)) + '</time>';
  };
  var esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;';
    });
  };
  var api = function (path, params) {
    var p = new URLSearchParams(params || {}); p.set('id', TOKEN);
    return fetch(path + '?' + p.toString(), { cache: 'no-store' }).then(function (r) { return r.json(); });
  };
  var viewParams = function (extra) {
    var p = { role: ROLE };
    if (CONV) p.conv = CONV;
    if (WITH) p['with'] = WITH;
    if (SESSION) p.session = SESSION;
    Object.keys(extra || {}).forEach(function (k) { p[k] = extra[k]; });
    return p;
  };
  // 视角状态回写 URL (replaceState: 不在历史里留一串中间态)。
  var syncUrl = function () {
    var p = new URLSearchParams({ id: TOKEN });
    Object.keys(viewParams()).forEach(function (k) { p.set(k, viewParams()[k]); });
    ['forceInnerBrowser', 'ww_vw', 'ww_vh', 'ww_uniq'].forEach(function (k) { if (qs.get(k)) p.set(k, qs.get(k)); });
    try { history.replaceState(null, '', location.pathname + '?' + p.toString()); } catch (e) { }
  };

  // ── 名字 ──
  // 一个 role 的名字与头像: 消息片段自带 (fromName/fromLabel), 会话列表与名册兜底。
  var names = {};
  var learn = function (id, name, label) { if (id && name) names[id] = { name: name, label: label || '' }; };
  var kindOf = function (id) {
    return /^task:/.test(id) ? 'task' : id === 'system:' ? 'system' : /^human:/.test(id) ? 'human' : 'wizard';
  };
  var nodeOf = function (target) {
    return W.nodes.filter(function (n) { return n.target === target; })[0];
  };
  var roleName = function (id) {
    var k = names[id] || {}, n = nodeOf(id);
    return k.name || (n && n.name) || id;
  };
  var roleLabel = function (id) {
    var k = names[id] || {}, n = nodeOf(id);
    return k.label || (n && n.label) || ({ human: '👤', task: '⏰', system: '🧙' })[kindOf(id)] || '🧙';
  };
  // `.name` 的点由 CSS 画 —— 人与定时任务没有地址, 不画点。
  var nameOf = function (id) { return (kindOf(id) === 'wizard' ? '.' : '') + roleName(id); };
  var canSwitch = function (id) { return !!id && kindOf(id) !== 'task' && kindOf(id) !== 'system' && id !== 'human:'; };
  // 头像与名字就是进入那个 role 视角的入口 —— 侧栏项、会话头、消息行同一种读法。
  // 是 <span> 不是 <button>: 侧栏里它嵌在整行那颗按钮里。
  var goSpan = function (cls, id, inner) {
    var on = canSwitch(id) && id !== ROLE;
    return '<span class="' + cls + (on ? ' go" data-r="' + esc(id) + '" title="' + esc('切到 ' + nameOf(id) + ' 的视角') : '') + '">' + inner + '</span>';
  };
  var nm = function (id, name, go) {
    var cls = 'nm ' + kindOf(id), txt = esc(name || roleName(id));
    return go ? goSpan(cls, id, txt) : '<span class="' + cls + '">' + txt + '</span>';
  };
  var bindGo = function (root, sel) {
    root.querySelectorAll(sel || '.go[data-r]').forEach(function (b) {
      b.onclick = function (e) {
        e.stopPropagation();
        var row = b.closest('.mrow');
        switchRole(b.getAttribute('data-r'), row && row.getAttribute('data-id'));
      };
    });
  };

  // ── markdown 渲染 (只对未渲染过的节点做, 复用节点不重绘) ──
  var md = null;
  var render = function (scope) {
    if (!window.markdownit) return;
    if (!md) {
      md = window.markdownit({
        html: false, linkify: true, breaks: true, highlight: function (str, lang) {
          if (lang && window.hljs) {
            try { return window.hljs.highlight(str, { language: lang, ignoreIllegals: true }).value; } catch (e) { }
          }
          if (window.hljs) { try { return window.hljs.highlightAuto(str).value; } catch (e) { } }
          return '';
        }
      });
    }
    scope.querySelectorAll('.bubble').forEach(function (b) {
      var src = b.querySelector('script.md-src'), body = b.querySelector('.md-body');
      if (src && body && body.dataset.rendered !== '1') {
        body.innerHTML = md.render(src.textContent || '');
        body.dataset.rendered = '1';
      }
    });
  };

  // ── 增量 reconcile: sig 相同原节点留下; 同为 turn 卡片只换头 + 递归气泡层 ──
  // 一次 tool_result 到达不该重建整张卡片 (滚动位置 / 展开态全部保住)。
  var snapOpen = function (scope) {
    var m = {};
    scope.querySelectorAll('[data-key]').forEach(function (b) {
      var k = b.getAttribute('data-key');
      b.querySelectorAll('details').forEach(function (d, i) { m[k + '#' + i] = d.open; });
    });
    return m;
  };
  var restoreOpen = function (scope, m) {
    scope.querySelectorAll('[data-key]').forEach(function (b) {
      var k = b.getAttribute('data-key');
      b.querySelectorAll('details').forEach(function (d, i) {
        var v = m[k + '#' + i]; if (v !== undefined) d.open = v;
      });
    });
  };
  var childBy = function (el, cls) {
    for (var i = 0; i < el.children.length; i++) if (el.children[i].classList.contains(cls)) return el.children[i];
    return null;
  };
  // 一轮回复 (.tg-head) 与过程框 (.steps-head) 是同一副骨架: 头 + .bubbles。
  var headOf = function (el) { return childBy(el, 'tg-head') || childBy(el, 'steps-head'); };
  var swapHead = function (ex, nc) {
    var eh = headOf(ex), nh = headOf(nc);
    if (eh && nh) eh.innerHTML = nh.innerHTML;
  };
  var reconcile = function (cur, next) {
    var open = snapOpen(cur), existing = {};
    Array.prototype.forEach.call(cur.children, function (c) {
      var k = c.getAttribute('data-key'); if (k) existing[k] = c;
    });
    var nodes = Array.prototype.map.call(next.children, function (nc) {
      var k = nc.getAttribute('data-key'), ex = k ? existing[k] : null;
      if (!ex) return document.importNode(nc, true);
      if (ex.getAttribute('data-sig') === nc.getAttribute('data-sig')) return ex;
      var eb = childBy(ex, 'bubbles'), nb = childBy(nc, 'bubbles');
      if (eb && nb) {
        swapHead(ex, nc);
        // 终句刚到: 过程框收起一次。标记留在节点上, 用户之后再点开不会被下一帧收回去。
        if (nc.hasAttribute('data-fold') && !ex.hasAttribute('data-fold')) {
          ex.setAttribute('data-fold', '');
          ex.classList.add('folded');
        }
        reconcile(eb, nb);
        ex.setAttribute('data-sig', nc.getAttribute('data-sig') || '');
        return ex;
      }
      return document.importNode(nc, true);
    });
    cur.replaceChildren.apply(cur, nodes);
    restoreOpen(cur, open);
    render(cur);
  };
  var frag = function (html) {
    var d = document.createElement('div'); d.innerHTML = html; return d;
  };

  // ── 工具调用正文: 第二级数据, 展开那一刻才取 ──
  // 片段里的 .tool-body 是个空壳 (data-lazy-turn / data-lazy-use), 首屏只带摘要行。
  // toggle 不冒泡, 所以在线程根上用捕获听 —— 用户点开, 和 reconcile 换了新节点后
  // restoreOpen 回填展开态, 走的是同一个事件: 后者正好把「展开着等结果」的那次调用
  // 重取成带结果的正文。取到之后正文就留在节点上, 收起再展开不会重取。
  var loadTool = function (d) {
    var body = childBy(d, 'tool-body');
    if (!body || !body.hasAttribute('data-lazy-turn') || body._busy || body.firstChild) return;
    body._busy = true; body.removeAttribute('data-err');
    api('api/tool', { turn: body.getAttribute('data-lazy-turn'), use: body.getAttribute('data-lazy-use') })
      .then(function (r) {
        if (!r.ok) throw new Error(r.error);
        var stick = S.pinned;
        body.innerHTML = r.html;
        if (stick) toBottom(true);
      })
      // 失败留着空壳 (CSS 给出提示), 再展开一次就是重试。
      .catch(function () { body.setAttribute('data-err', '1'); })
      .then(function () { body._busy = false; });
  };

  // ── 滚动: 默认到底; 用户手动上翻后解除吸附, 回到底部再吸附 ──
  var atBottom = function () { return thread.scrollHeight - thread.scrollTop - thread.clientHeight < 80; };
  var toBottom = function (force) { if (force || S.pinned) thread.scrollTop = thread.scrollHeight; };
  thread.addEventListener('scroll', function () { S.pinned = atBottom(); });
  inner.addEventListener('toggle', function (e) {
    var d = e.target;
    if (d.open && d.classList && d.classList.contains('tool-call')) loadTool(d);
  }, true);

  // 过程框的收起: 框头与框内空白是开关; 落在某一行工具上的点击归那一行自己。
  // 收起态只是节点上的一个 class —— reconcile 认键留节点, 往框里添调用时它跟着留下。
  inner.addEventListener('click', function (e) {
    var s = e.target.closest && e.target.closest('.steps');
    if (!s) return;
    if (e.target.closest('.steps-head') || e.target === s || e.target === childBy(s, 'bubbles')) s.classList.toggle('folded');
  });
  // reminder 块: 摘要 ⇄ 原文。刚划选了一段原文的那次松手不算点击。
  inner.addEventListener('click', function (e) {
    var r = e.target.closest && e.target.closest('.rem');
    if (!r || String(window.getSelection() || '')) return;
    r.classList.toggle('raw');
  });

  // ── 左栏: 当前 role 的名片 + 会话列表 ──
  var convOf = function (key) { return R.convs.filter(function (c) { return c.key === key; })[0]; };

  // 群聊头像 = 参与者头像的拼图 (最多 4 格, 自己排第一)。私聊就是对端自己的头像。
  var membersOf = function (c) {
    var seen = {}, out = [];
    [{ role: ROLE, label: R.role ? R.role.label : '' }].concat(c.subs || []).forEach(function (m) {
      if (m.role && !seen[m.role]) { seen[m.role] = 1; out.push(m); }
    });
    return out;
  };
  // ── 状态: wizard 是否在执行中 ──
  // 服务端只给事实 (busy / alive / runningUntil), 亮不亮在这里按本地时钟判 ——
  // 到点没有新写入就自己熄 (同 expireRows), 不必等下一次推送。
  var ST = { run: '执行中', idle: '空闲', off: '已关闭' };
  var stateOf = function (s) { return wRunning(s) ? 'run' : s.alive ? 'idle' : 'off'; };
  // 侧栏只在执行中时点一盏灯: 列表里安静是常态, 亮着的才值得看一眼。
  var lampOf = function (s) {
    return s && wRunning(s) ? '<i class="live" title="' + ST.run + '"></i>' : '';
  };
  var paintStatus = function () {
    var el = $('#rb-st'), r = R.role;
    if (!el || !r) return;
    var k = stateOf(r);
    el.className = 'st ' + k; el.textContent = ST[k];
  };

  var avatarOf = function (c, extra) {
    if (c.kind !== 'group') return goSpan('av', c.peer, esc(c.label) + (extra || ''));
    var ms = membersOf(c).slice(0, 4);
    return '<span class="av mosaic n' + ms.length + '" aria-hidden="true">' +
      ms.map(function (m) { return '<i>' + esc(m.label || roleLabel(m.role)) + '</i>'; }).join('') + '</span>';
  };

  var line = function (title, ts, pv, lamp, unread) {
    return '<span class="b"><span class="l1"><span class="t">' + title + '</span>' + (lamp || '') +
      '<span class="ts">' + esc(fmtAgo(ts)) + '</span></span>' +
      '<span class="l2"><span class="pv">' + esc(pv) + '</span>' +
      (unread ? '<b class="ub">' + (unread > 99 ? '99+' : unread) + '</b>' : '') + '</span></span>';
  };

  // ── 未读: 页面打开后别人新说完的 final reply 条数 ──
  // 服务端只给累计的 finals, 基线记在这里: 第一次见到某项就以当时为准 (打开前的不算未读),
  // 正在读的那项随到随清。按视角分账 —— 同一个群换个 role 看, 未读是另一回事。
  var SEEN = {};
  var unreadKey = function (key, withRole) { return ROLE + '|' + key + '|' + (withRole || ''); };
  var unreadOf = function (key, withRole, n) {
    var k = unreadKey(key, withRole);
    if (SEEN[k] === undefined) SEEN[k] = n;
    return Math.max(0, n - SEEN[k]);
  };
  var reading = function () { return VIEW === 'msgs' && !document.hidden; };
  // 读整个群 = 群与子项全清; 只读一对 = 清那一项, 群的账同步抵掉这一对新增的那几条。
  var markRead = function (c) {
    if (!reading() || c.key !== CONV) return;
    var gk = unreadKey(c.key);
    var subs = (c.subs || []).filter(function (s) { return !WITH || s.role === WITH; });
    subs.forEach(function (s) {
      var k = unreadKey(c.key, s.role);
      if (WITH && SEEN[gk] !== undefined && SEEN[k] !== undefined) SEEN[gk] += Math.max(0, s.finals - SEEN[k]);
      SEEN[k] = s.finals || 0;
    });
    if (!WITH) SEEN[gk] = c.finals || 0;
    else if (SEEN[gk] > c.finals) SEEN[gk] = c.finals;
  };

  // 展开态按会话各记各的: 点开一个不收起别的, 轮询重画也不动它。
  // OPEN_AT = 已经替它自动展开过的那个 CONV —— 选中新会话时展开一次, 之后折不折由人说了算。
  var OPEN = {}, OPEN_AT = '';
  // 子项默认只露前 SUB_FOLD 个, 其余收在一条展开/折叠条后面; 展开态同样按会话各记各的。
  var SUB_FOLD = 5, MORE = {};
  var reveal = function () {
    if (CONV && CONV !== OPEN_AT) { OPEN[CONV] = true; OPEN_AT = CONV; }
  };
  // 点侧栏项: 没选中它 → 选中 (会话顺带展开); 已选中 → 不再选一遍, 右边的正文一个字不动 ——
  // 会话只折叠/展开, 子项什么都不做。
  var clickItem = function (key, withRole) {
    if (key !== CONV || withRole !== WITH || VIEW !== 'msgs') return selectConv(key, withRole);
    // 窄屏退回列表后再点它是要回去读, 不是要折叠。
    if (!app.classList.contains('reading')) return app.classList.add('reading');
    if (withRole) return;
    OPEN[key] = !OPEN[key];
    renderConvs();
  };

  var convItem = function (c) {
    var on = c.key === CONV;
    var title = c.kind === 'wizard' ? nm(c.peer, c.name, true) : '<span class="nm chat">' + esc(c.name) + '</span>';
    // 只列与我有往来的: 在群里但没和我说过话的人, 点进去也是空的。
    var talked = OPEN[c.key] ? c.subs.filter(function (s) { return s.count; }) : [];
    var hidden = talked.length - SUB_FOLD;
    var bar = hidden > 0
      ? '<button class="si-more" data-more="' + esc(c.key) + '">' + (MORE[c.key] ? '折叠' : '展开更多') + ' × ' + hidden + '</button>'
      : '';
    // 展开条钉在第 SUB_FOLD+1 位, 展开与折叠都不挪: 其余子项展开后接在它下面。
    var sub = function (s) {
      var sel = on && s.role === WITH;
      return '<button class="si' + (sel ? ' on' : '') + '" data-conv="' + esc(c.key) + '" data-with="' + esc(s.role) + '" ' +
        'title="' + esc('我与 ' + nameOf(s.role) + ' 在这里的 ' + s.count + ' 条往来') + '">' +
        goSpan('av', s.role, esc(s.label)) +
        line(nm(s.role, s.name, true), s.lastTs, s.preview, lampOf(s.status), unreadOf(c.key, s.role, s.finals || 0)) + '</button>';
    };
    var rest = MORE[c.key] ? talked.slice(SUB_FOLD).map(sub).join('') : '';
    var subs = talked.length
      ? '<div class="subs">' + talked.slice(0, SUB_FOLD).map(sub).join('') + bar + rest + '</div>'
      : '';
    var sel = on && !WITH;
    return '<button class="ci' + (sel ? ' on' : '') + '" data-conv="' + esc(c.key) + '">' +
        avatarOf(c) + line(title, c.lastTs, c.preview, lampOf(c.status), unreadOf(c.key, '', c.finals || 0)) +
      '</button>' + subs;
  };

  var renderConvs = function () {
    var groups = R.convs.filter(function (c) { return c.kind === 'group'; });
    var dms = R.convs.filter(function (c) { return c.kind !== 'group'; });
    R.convs.forEach(markRead);
    // 空着的那一栏不画 —— 对谁都一样: 人没有私聊只是这条规则的一个特例。
    var sec = function (title, list) {
      return list.length ? '<h2>' + title + '<span>' + list.length + '</span></h2>' + list.map(convItem).join('') : '';
    };
    // 没变就不碰 DOM: 心跳每 3s 来一次, 重建会把列表的滚动与焦点蹭掉。
    var html = sec('群聊', groups) + sec('私聊', dms);
    if (convsEl._html === html) return;
    convsEl._html = html; convsEl.innerHTML = html;
    convsEl.querySelectorAll('[data-conv]').forEach(function (b) {
      var key = b.getAttribute('data-conv'), w = b.getAttribute('data-with') || '';
      b.onclick = function () { clickItem(key, w); };
    });
    convsEl.querySelectorAll('[data-more]').forEach(function (b) {
      var key = b.getAttribute('data-more');
      b.onclick = function () { MORE[key] = !MORE[key]; renderConvs(); };
    });
    bindGo(convsEl);
  };

  var shortCwd = function (p) {
    var seg = String(p).replace(/\/+$/, '').split('/').filter(Boolean);
    return seg.length <= 2 ? p : '…/' + seg.slice(-2).join('/');
  };
  var sessLabel = function (s) {
    return (s.sessionId ? s.sessionId.slice(0, 8) : '(无 id)') + ' · ' + fmtAgo(s.start) + ' · ' + s.turns + ' 轮';
  };

  // session 切换: 原生 <select> 的弹层画不了样式, 换成按钮 + 列表。
  // renderRole 每次刷新都重画, 展开态记在 SESS_OPEN 里才不会被轮询收起。
  var SESS_OPEN = false;
  var sessRow = function (s, on) {
    return '<button class="sp-it' + (on ? ' on' : '') + '" role="option" aria-selected="' + on + '" data-s="' + esc(s.sessionId || '') + '">' +
      '<span class="id">' + esc(s.sessionId ? s.sessionId.slice(0, 8) : '(无 id)') + '</span>' +
      '<span class="ago">' + esc(fmtAgo(s.start)) + '</span>' +
      '<span class="n">' + s.turns + ' 轮</span></button>';
  };
  var sessPicker = function () {
    var cur = R.sessions.filter(function (s) { return s.sessionId === SESSION; })[0];
    var all = '<button class="sp-it all' + (cur ? '' : ' on') + '" role="option" aria-selected="' + !cur + '" data-s="">' +
      '<span class="id">全部 session</span><span class="n">' + R.sessions.length + ' 个</span></button>';
    return '<div class="sp' + (SESS_OPEN ? ' open' : '') + '">' +
      '<button class="sp-btn" aria-haspopup="listbox" aria-expanded="' + SESS_OPEN + '">' +
        '<span class="lb">session</span>' +
        '<span class="v">' + esc(cur ? sessLabel(cur) : '全部 ' + R.sessions.length + ' 个') + '</span>' +
        '<span class="car" aria-hidden="true"></span></button>' +
      '<div class="sp-list" role="listbox">' + all +
        R.sessions.slice().reverse().map(function (s) { return sessRow(s, s.sessionId === SESSION); }).join('') +
      '</div></div>';
  };
  var setSessOpen = function (open) {
    SESS_OPEN = open;
    var sp = $('#rb-sess .sp');
    if (!sp) return;
    sp.classList.toggle('open', open);
    sp.querySelector('.sp-btn').setAttribute('aria-expanded', open);
  };
  var bindSessPicker = function () {
    var sp = $('#rb-sess .sp');
    if (!sp) return;
    sp.querySelector('.sp-btn').onclick = function () { setSessOpen(!SESS_OPEN); };
    sp.querySelectorAll('.sp-it').forEach(function (it) {
      it.onclick = function () { setSessOpen(false); SESSION = it.getAttribute('data-s'); refresh(); };
    });
  };
  document.addEventListener('click', function (e) {
    if (SESS_OPEN && !e.target.closest('#rb-sess .sp')) setSessOpen(false);
  });
  document.addEventListener('keydown', function (e) {
    if (SESS_OPEN && e.key === 'Escape') setSessOpen(false);
  });

  // 名片: 身份 · 出身 · cwd · 出生; 名片下面一排是关系 / 日程入口。
  var renderRole = function () {
    var r = R.role;
    if (!r) return;
    // 名字下面那一行就是出身 —— 有父亲的直接写成「谁的什么」(可点过去), 不再另起一条重复。
    // 分身 = 从父亲某个 session 节点 fork 出来的 (带着那一刻的上下文);
    // 子 wizard = 父亲 spawn 的白板, 只有出身、没有继承。
    // 人不挂身份行 —— 名字本身就够了。
    var kind = r.kind === 'human' ? ''
      : !r.parent ? 'wizard'
      : r.forkedFrom
        ? '<span class="go" data-r="' + esc(r.parent.id) + '" title="从它的 session ' + esc(r.forkedFrom) + ' fork, 开局带着那一刻的上下文">⧉ .' + esc(r.parent.name) + ' 的分身 · @' + esc(r.forkedFrom.slice(0, 8)) + '</span>'
        : '<span class="go" data-r="' + esc(r.parent.id) + '" title="它 spawn 的白板, 没有继承上下文">↳ .' + esc(r.parent.name) + ' 的子 wizard</span>';
    var facts = [];
    if (r.cwd) facts.push('<span title="' + esc(r.cwd) + '">📁 ' + esc(shortCwd(r.cwd)) + '</span>');
    // 生在哪个群、什么时候 —— 一件事, 一行。
    var born = [r.chat, r.bornAt ? fmtAgo(r.bornAt) : ''].filter(Boolean);
    if (born.length) facts.push('<span title="' + esc('创建于' + (r.chat ? ' ' + r.chat : '') + (r.bornAt ? ' · ' + fmtDay(r.bornAt) : '')) + '">🐣 ' + esc(born.join(' · ')) + '</span>');
    var kin = function (xs, what) {
      return xs.length ? '<span title="' + esc(xs.map(function (x) { return '.' + x.name; }).join(' ')) + '">' + xs.length + ' 个' + what + '</span>' : '';
    };
    facts.push(kin(r.clones, '分身'), kin(r.spawns, '子 wizard'));
    $('#rb-who').innerHTML =
      '<div class="id"><span class="av">' + esc(r.label) + '</span>' +
        '<span class="l">' + nm(r.id, r.name) +
          (kind ? '<span class="k">' + kind + (r.kind === 'wizard' ? '<span class="st" id="rb-st"></span>' : '') + '</span>' : '') + '</span></div>' +
      (r.description ? '<p class="job">' + esc(r.description) + '</p>' : '') +
      '<div class="facts">' + facts.join('') + '</div>';
    paintStatus();
    $('#rb-who').querySelectorAll('.go').forEach(function (g) {
      g.onclick = function () { switchRole(g.getAttribute('data-r')); };
    });
    $('#rb-sess').innerHTML = R.sessions.length > 1 ? sessPicker() : '';
    $('#rb-foot').hidden = R.sessions.length < 2;
    bindSessPicker();
    var acts = [];
    // 入口只在有东西可看时出现 —— 挂在名片下、会话列表上, 不挤进名片: 名片的主角是身份。
    if (R.relations) acts.push('<button class="bd' + (VIEW === 'world' ? ' on' : '') + '" data-view="world">关系图</button>');
    if (R.schedules) acts.push('<button class="bd' + (VIEW === 'plan' ? ' on' : '') + '" data-view="plan">日程<b>' + R.schedules + '</b></button>');
    $('#rb-acts').innerHTML = acts.join('');
    $('#rb-acts').querySelectorAll('.bd').forEach(function (b) {
      b.onclick = function () { setView(VIEW === b.getAttribute('data-view') ? 'msgs' : b.getAttribute('data-view')); };
    });
    // 标题就是这一页的主张: 你此刻站在谁的位置上。换视角 → 标题跟着换。
    document.title = nameOf(r.id) + ' 的视角';
  };

  // ── 用量条: 一组轮次的总账 ──
  // usageHTML 只管「一本账长什么样」(TagSummary → 一条), 账是谁的、挂在哪由 renderUsage 定。
  var SEGS = [
    ['input', '输入', '#0a7d6b'], ['cacheRead', '缓存读', '#8250df'],
    ['cacheWrite', '缓存写', '#953800'], ['output', '输出', '#1a7f37'],
  ];
  var TIP = {
    turns: '对话轮数', tools: '工具调用次数', api: 'API 请求次数',
    ctx: '上下文峰值 — 单次请求送入的 input + 缓存 的最高值', time: '累计耗时',
  };
  var liveDur = function (t) {
    var d = (t.usage && t.usage.durationMs) || 0;
    if (!t.runningUntil) return d;
    return d + Math.max(0, Math.min(srvNow(), t.runningUntil) - R.at);
  };
  var usageHTML = function (t) {
    var u = t.usage || {};
    var segs = SEGS.filter(function (s) { return u[s[0]] > 0; });
    var total = segs.reduce(function (a, s) { return a + u[s[0]]; }, 0);
    // 值为 0 = 该指标没有数据 (老记录 / 网关不报 usage), 不占位置。
    var kv = function (k, n, text) {
      return n ? '<span class="kv" title="' + esc(TIP[k] || k) + '"><b>' + esc(text) + '</b>' + k + '</span>' : '';
    };
    // 输出 / 缓存不再单列成指标 —— 它们就是 I/O 图例里的那几格。
    var io = total > 0
      ? '<span class="u-io" title="累计 token I/O · 共 ' + fmtTok(total) + '">' +
          '<span class="bar">' + segs.map(function (s) {
            return '<span class="seg" style="width:' + (u[s[0]] / total * 100).toFixed(2) + '%;background:' +
              s[2] + '" title="' + s[1] + ': ' + fmtTok(u[s[0]]) + '"></span>';
          }).join('') + '</span>' +
          '<span class="leg">' + segs.map(function (s) {
            return '<span class="lg"><i style="background:' + s[2] + '"></i>' + s[1] +
              '<b>' + fmtTok(u[s[0]]) + '</b></span>';
          }).join('') + '</span>' +
        '</span>'
      : '';
    // 条首的标签就是模型名: 这本账是拿什么跑出来的。没有模型记录 (老轮次) 才退回「用量」。
    return '<span class="u-lb" title="' + esc(t.model || '') + '">' +
        esc(t.model ? t.model.replace(/^claude-/, '') : '用量') + '</span>' +
      '<span class="u-kvs">' +
        kv('turns', t.turns, t.turns) + kv('tools', u.tools, u.tools) + kv('api', u.calls, u.calls) +
        kv('ctx', u.ctxPeak, fmtTok(u.ctxPeak)) + kv('time', liveDur(t), fmtDur(liveDur(t))) +
      '</span>' + io;
  };
  // 没变就不碰 DOM: 心跳每 3s 来一次, 重建会把悬停中的 tooltip 蹭掉。
  var putUsage = function (el, t) {
    var html = t ? usageHTML(t) : '';
    // !el: web/ 是热更的, 外壳 HTML 要等 daemon 重启 —— 新脚本可能先遇上没有挂载点的旧外壳。
    if (!el || el._html === html) return;
    el._html = html; el.innerHTML = html; el.hidden = !html;
    // 条的高度挤的是消息区 —— 原本贴底的继续贴底。
    toBottom();
  };
  // wizard: 整页页脚, 它自己跑过的全部轮次 (选了 session 就只算那一段)。
  // 人: 自己不跑轮次 —— 在群里点开某个 wizard 之后, 窗口底下是这段往来的账。
  var renderUsage = function () {
    var wiz = !!R.role && R.role.kind === 'wizard';
    putUsage($('#pg-usage'), wiz ? R.stats : null);
    putUsage($('#ch-usage'), !wiz && WITH && VIEW === 'msgs' ? R.winStats : null);
  };

  // ── 右栏头: 这个群聊 / 私聊是什么 (关系 / 日程视图时是视图名) ──
  var renderHead = function () {
    var who = $('#ch-who'), acts = $('#ch-acts');
    if (VIEW !== 'msgs') {
      who.innerHTML = '<span class="t">' + (VIEW === 'world' ? '关系图' : '日程') + '</span>' +
        '<span class="sub">' + esc(nameOf(ROLE)) + (VIEW === 'world' ? ' 的家谱与协作网' : ' 名下的定时任务与工单') + '</span>';
      acts.innerHTML = '<button class="vb" id="ch-back">‹ 对话</button>';
      $('#ch-back').onclick = function () { setView('msgs'); };
      return;
    }
    var c = convOf(CONV);
    if (!c) { who.innerHTML = ''; acts.innerHTML = ''; return; }
    who.innerHTML = '<span class="t">' + (c.kind === 'wizard' ? nm(c.peer, c.name, true) : esc(c.name)) + '</span>';
    acts.innerHTML = WITH
      ? '<span class="with">只看我与 ' + nm(WITH, '', true) + '</span><button class="vb" id="ch-all">看全部</button>'
      : '';
    bindGo(who); bindGo(acts);
    var x = $('#ch-all');
    if (x) x.onclick = function () { selectConv(CONV, ''); };
  };

  // ── 消息行 ──
  // 同一条消息从发话方看靠右、从收信方看靠左 —— 片段不带方向, 由这里按视角包装。
  // 箭头朝外 = 这条气泡换视角后要去的那一侧; mine 行靠 CSS 翻转。
  var CHEVRON = '<svg class="fc" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M6 3.5 10.5 8 6 12.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  // 行的另一侧是 .flip: 点它 = 换成这条消息的对端 (我发的 → 收信方; 别人发的 → 发话方)。
  var rowHTML = function (m) {
    learn(m.from, m.fromName, m.fromLabel);
    learn(m.to, m.toName, m.toLabel);
    if (m.dir === 'mark') {
      return '<div class="mrow mark" data-id="' + esc(m.id) + '" data-turn="' + esc(m.turnId || m.id) + '" data-ts="' + m.ts + '" data-sig="' + esc(m.sig) + '">' + m.html + '</div>';
    }
    var mine = m.from === ROLE;
    var other = mine ? m.to : m.from;
    // 看 key 而不是会话列表: 换视角就地重包时, 列表还是上一个 role 的。
    var group = CONV.indexOf('p:') !== 0;
    // 群里我不是收信方的那条 (X → Y), 头上写清是说给谁的。
    var to = !mine && m.to !== ROLE && group ? '<span class="to">→ ' + nm(m.to, m.toName, true) + '</span>' : '';
    var priv = !m.channel && group ? '<span class="ch priv">私聊</span>' : '';
    // 本轮的账 (呼吸点 + 模型 / token / 耗时) 跟在时刻后面 —— 片段是服务端渲染好的。
    var stat = m.meta ? '<span class="mstat">' + m.meta + '</span>' : '';
    var who = mine
      ? '<span class="to">' + (m.to && m.to !== 'human:' ? '→ ' + nm(m.to, m.toName, true) : '') + '</span>' + stamp(m.ts) + stat
      : nm(m.from, m.fromName, true) + to + priv + stamp(m.ts) + stat;
    var sw = canSwitch(other);
    var flip = '<button class="flip" data-r="' + esc(other) + '"' + (sw ? '' : ' disabled tabindex="-1"') +
      ' aria-label="' + esc(sw ? '切到 ' + nameOf(other) + ' 的视角' : '') + '">' +
      (sw ? '<span class="fi"><span class="fn">' + esc(nameOf(other)) + '</span>' + CHEVRON + '</span>' : '') + '</button>';
    var av = mine ? '' : '<button class="av' + (canSwitch(m.from) ? ' go' : '') + '" data-r="' + esc(m.from) + '" title="' + esc(nameOf(m.from)) + '"' + (canSwitch(m.from) ? '' : ' disabled') + '>' + esc(m.fromLabel || roleLabel(m.from)) + '</button>';
    return '<div class="mrow ' + (mine ? 'mine' : 'them') + '" data-id="' + esc(m.id) + '" data-turn="' + esc(m.turnId || m.id) + '" data-ts="' + m.ts + '"' +
      (m.ping ? ' data-ping="1" data-ping-who="' + esc(m.dir === 'in' ? m.toName : m.fromName) + '"' : '') + ' data-sig="' + esc(m.sig) + '" data-stale-at="' + (m.staleAt || 0) + '">' +
      '<div class="mcol"><div class="mwho">' + av + who + '</div><div class="mb">' + m.html + '</div></div>' +
      flip +
    '</div>';
  };
  // ── 🏓 保温 ping 的折叠 ──
  // ping 不是对话, 但它是真花销, 从时间轴上抹掉就等于说这段时间什么都没发生。
  // 一次 ping 落成两行 (问 + pong); 相邻的整串收进一条虚线, 展开才见正文。
  // 展开态是整页一个开关 —— 折行没有稳定 id, 而"想看 ping"是个一次性的念头。
  var PING_OPEN = false;
  var unfoldPings = function (root) {
    root.querySelectorAll('.ping-fold').forEach(function (f) {
      var body = f.querySelector('.ping-body');
      while (body && body.firstChild) root.insertBefore(body.firstChild, f);
      f.remove();
    });
  };
  var foldPings = function (root) {
    var run = [];
    var flush = function (before) {
      if (!run.length) { return; }
      // 群窗里几个 wizard 同时挂机, 它们的 ping 会交错成一串 —— 按 wizard 分开计数, 不相加。
      var seen = {}, per = {}, order = [];
      run.forEach(function (r) {
        var t = r.getAttribute('data-turn') || r.getAttribute('data-id');
        var w = r.getAttribute('data-ping-who') || '';
        if (seen[t]) { return; }
        seen[t] = 1;
        if (!per[w]) { per[w] = 0; order.push(w); }
        per[w]++;
      });
      var tally = order.map(function (w) { return (w ? '.' + w + ' ' : '') + '×' + per[w]; }).join(' · ');
      var t0 = Number(run[0].getAttribute('data-ts') || 0);
      var t1 = Number(run[run.length - 1].getAttribute('data-ts') || 0);
      var span = fmtHM(t0) + (fmtHM(t1) !== fmtHM(t0) ? ' – ' + fmtHM(t1) : '');
      var d = document.createElement('details');
      d.className = 'ping-fold';
      d.open = PING_OPEN;
      d.innerHTML = '<summary class="ping-sum"><span class="pb">🏓 ' + esc(tally) + '</span>' +
        '<span class="ps">保温 ping</span><span class="pt">' + esc(span) + '</span></summary>' +
        '<div class="ping-body"></div>';
      root.insertBefore(d, before);
      var body = d.querySelector('.ping-body');
      run.forEach(function (r) { body.appendChild(r); });
      d.addEventListener('toggle', function () { PING_OPEN = d.open; });
      run = [];
    };
    // 先取快照 —— flush 会把行搬进 details, 边遍历边改 children 会漏行。
    [].slice.call(root.children).forEach(function (el) {
      if (el.classList && el.classList.contains('mrow') && el.getAttribute('data-ping') === '1') { run.push(el); return; }
      flush(el);
    });
    flush(null);
  };

  var bindRow = function (el) {
    bindGo(el, '.flip[data-r]:not([disabled]), .mwho .go[data-r]');
  };
  var rowNode = function (id) {
    var list = inner.querySelectorAll('.mrow');
    for (var i = 0; i < list.length; i++) if (list[i].getAttribute('data-id') === id) return list[i];
    return null;
  };

  // land: 换视角时由它来定位 (锚住一条旧消息), 返回 false 才照常吸底。
  var loadMsgs = function (limit, land) {
    var gen = S.gen;
    if (!CONV) { inner.innerHTML = '<div class="empty">选一个会话</div>'; return Promise.resolve(); }
    return api('api/msgs', viewParams(limit ? { limit: limit } : {})).then(function (d) {
      if (!d.ok || gen !== S.gen) return;
      S.frags = {};
      d.msgs.forEach(function (m) { S.frags[m.id] = m; });
      if (!d.msgs.length) { inner.innerHTML = '<div class="empty">这里还没有消息</div>'; return; }
      var more = d.truncated
        ? '<button class="more-btn" id="more">载入更早的 ' + (d.total - d.msgs.length) + ' 条</button>'
        : '';
      inner.innerHTML = more + d.msgs.map(rowHTML).join('');
      var btn = $('#more');
      if (btn) btn.onclick = function () { btn.textContent = '载入中…'; loadMsgs('0'); };
      bindRow(inner);
      render(inner);
      foldPings(inner);
      expireRows();
      if (land && land()) return;
      S.pinned = true; toBottom(true);
      // CDN 字体/代码高亮加载完会改变高度, 再吸一次底。
      setTimeout(function () { toBottom(); }, 60);
    });
  };

  var upsertMsg = function (m) {
    var empty = inner.querySelector('.empty'); if (empty) empty.remove();
    var stick = S.pinned;
    var cur = rowNode(m.id);
    S.frags[m.id] = m;
    if (cur && cur.getAttribute('data-sig') === m.sig) return;
    // 折行会把 .mrow 收进 details, 而下面的按时间插位假定它们都是 inner 的直接子节点。
    unfoldPings(inner);
    var next = frag(rowHTML(m)).firstElementChild;
    if (!cur) {
      // 按时间插: SSE 推来的可能是一条更早的消息 (长轮次的入消息晚于别人的回复落盘)。
      var after = null;
      inner.querySelectorAll('.mrow').forEach(function (r) {
        if (Number(r.getAttribute('data-ts')) > m.ts && !after) after = r;
      });
      inner.insertBefore(next, after);
      bindRow(next); render(next);
    } else {
      var eb = cur.querySelector('.mb'), nb = next.querySelector('.mb');
      var ec = eb && eb.firstElementChild, nc = nb && nb.firstElementChild;
      var ebb = ec && childBy(ec, 'bubbles'), nbb = nc && childBy(nc, 'bubbles');
      if (ebb && nbb) {
        var es = cur.querySelector('.mwho .mstat'), ns = next.querySelector('.mwho .mstat');
        if (es && ns) es.innerHTML = ns.innerHTML;
        reconcile(ebb, nbb);
        ['data-sig', 'data-stale-at'].forEach(function (a) { cur.setAttribute(a, next.getAttribute(a)); });
      } else {
        cur.replaceWith(next); bindRow(next); render(next);
      }
    }
    foldPings(inner);
    if (stick) toBottom(true);
  };

  // 到点了还没有新写入 → 这一轮已经结束: 熄掉呼吸点、移除"正在思考"。
  var expireRows = function () {
    var now = srvNow();
    inner.querySelectorAll('.mrow[data-stale-at]').forEach(function (g) {
      var until = Number(g.getAttribute('data-stale-at') || 0);
      if (!until || now <= until) return;
      g.setAttribute('data-stale-at', '0');
      g.querySelectorAll('.tg-dot').forEach(function (d) { d.classList.remove('live'); });
      g.querySelectorAll('.typing').forEach(function (t) { t.remove(); });
    });
  };

  // ── role 摘要 ──
  var applyRole = function (d) { takeRole(d); paintRole(); };
  // 收下摘要 (视角、会话列表、落地窗口) 与按它画页头侧栏分开: 换视角整窗重拉时, 画要等到新行到手的同一帧。
  var takeRole = function (d) {
    R.at = d.at || Date.now(); R.recvAt = Date.now();
    R.role = d.role; R.sessions = d.sessions || []; R.convs = d.convs || [];
    R.relations = !!d.relations; R.schedules = d.schedules || 0;
    R.stats = d.stats || null; R.winStats = d.winStats || null;
    ROLE = d.role.id;
    learn(d.role.id, d.role.name, d.role.label);
    R.convs.forEach(function (c) {
      if (c.peer) learn(c.peer, c.name, c.label);
      c.subs.forEach(function (s) { learn(s.role, s.name, s.label); });
    });
    // 没带 conv 的链接 (群里点名字进来) 落在服务端挑的窗口上, 连同它挑的「只看我与谁」;
    // 手里的 conv 失效则只退回整个会话。
    if (!CONV || !convOf(CONV)) { WITH = CONV ? '' : d['with'] || ''; CONV = d.conv || ''; }
  };
  var paintRole = function () {
    reveal();
    renderRole(); renderUsage(); renderConvs(); renderHead();
  };

  // 切回标签页时正在读的那项就算读过了。
  document.addEventListener('visibilitychange', function () { if (!document.hidden) renderConvs(); });

  // ── SSE: role 摘要 + 当前窗口的消息增量。断线指数退避重连。 ──
  var backoff = 1000;
  var connect = function () {
    if (S.es) { S.es.close(); S.es = null; }
    var p = new URLSearchParams(viewParams({ id: TOKEN }));
    var es = new EventSource('api/role-events?' + p.toString());
    S.es = es;
    es.addEventListener('role', function (e) { try { applyRole(JSON.parse(e.data)); } catch (err) { } });
    es.addEventListener('msg', function (e) { try { upsertMsg(JSON.parse(e.data)); } catch (err) { } });
    es.onopen = function () { backoff = 1000; };
    es.onerror = function () {
      es.close(); if (S.es === es) S.es = null;
      setTimeout(function () { if (!S.es) connect(); }, backoff);
      backoff = Math.min(backoff * 2, 15000);
    };
  };

  /** 视角或窗口变了: 摘要、正文、SSE 全部按新参数重来。 */
  var refresh = function (land) {
    S.gen++;
    syncUrl();
    // 要做 FLIP 就把旧行留到新行到来 —— 中间闪一下「加载中」就量不到旧位置了。
    if (!land) inner.innerHTML = '<div class="empty">加载中…</div>';
    return api('api/role', viewParams()).then(function (d) {
      if (!d.ok) {
        document.body.innerHTML = '<div class="empty" style="padding:80px">' + esc(d.error || 'not found') + '</div>';
        return;
      }
      // 带 land 的 (换视角) 先不画: 页头换了高度, 旧行会在新行到来前先被顶一下, FLIP 的起点就错了。
      if (land) takeRole(d); else applyRole(d);
      syncUrl();
      if (VIEW === 'world' || VIEW === 'plan') { W.sel = ROLE; loadWorld(); }
      return loadMsgs(undefined, land && function () { paintRole(); return land(); }).then(function () {
        if (land && !inner.querySelector('.mrow')) paintRole();   // 空窗口不走 land, 页头照样要画
        connect();
      });
    });
  };

  var selectConv = function (key, withRole) {
    CONV = key; WITH = withRole || '';
    reveal();
    if (VIEW !== 'msgs') setView('msgs');
    app.classList.add('reading');
    // 上一个窗口的账不属于这个窗口 —— 先收起, 新的随 SSE 的首个 role 事件到。
    R.winStats = null;
    renderConvs(); renderHead(); renderUsage();
    S.gen++;
    syncUrl();
    inner.innerHTML = '<div class="empty">加载中…</div>';
    loadMsgs().then(connect);
  };

  // 换视角: 窗口尽量留在同一个群 —— 从群里的一条消息切过去, 最想看的是对方在这个群
  // 里的样子; 对方不在这个群 (私聊的另一头) 就交给服务端挑它最近的会话。
  // at: 被点的那条消息 —— 换视角后它留在指针底下, 其余的相对它滑动。
  var switchRole = function (id, at) {
    if (!canSwitch(id) || id === ROLE) return;
    var keep = CONV && CONV.indexOf('c:') === 0 ? CONV : '';
    var from = ROLE;
    // 整个频道 / 两人私聊的消息集合与视角无关 —— 只有 with 与 session 按 role 过滤。
    var same = VIEW === 'msgs' && !WITH && !SESSION && (keep || CONV.indexOf('p:') === 0);
    // 群里「只看我与 X」时换过去, 对面看到的是「只看我与 from」—— 同一段往来, 选中只看而不是整个群。
    var withBack = keep && WITH ? from : '';
    ROLE = id; WITH = withBack; SESSION = '';
    CONV = keep || (CONV.indexOf('p:') === 0 ? 'p:' + from : '');
    var snap = VIEW === 'msgs' && !calm() ? snapRows(at) : null;
    if (same) { flipWindow(snap); return; }
    var kept = VIEW === 'msgs' ? keepBodies() : {};
    refresh(function () {
      adoptBodies(kept);
      if (landFlip(snap)) return true;
      // 一条旧消息都不在了 (换到了别的会话): 没有可配对的, 才整列淡入。
      inner.classList.remove('flipping'); void inner.offsetWidth; inner.classList.add('flipping');
      return false;
    });
  };

  // ── 换视角的 FLIP: 按 msgid 记下每条消息各块的位置与底色, 重排后从旧处滑到新处、旧色渐到新色 ──
  // 动的是行里的每一块 (名字行、问句气泡、过程框、终句), 不是整列 .mcol: 换边时块在列里的
  // 相对位置也会变 —— 名字行有没有头像差 6px, 带过程框的列占满整宽、终句在列内从左跳到右,
  // 只挪整列的话这些块都是直接闪过去的。
  // 全量记, 不只记视窗里的: 行高随视角变, 屏外的行会被推进视窗。只在前后有一头落在视窗里时才真动。
  // 回复的外壳 .turn-group 是 overflow:hidden 的 (工具行 nowrap, 不裁会撑出横向滚动)。它一换边就
  // 立刻在新位置, 里面的过程框 / 终句要是按屏上绝对位移平移, 起跑时整个在壳外, 被裁得一干二净 ——
  // 看上去就是对侧空白盖住了气泡。所以壳自己算一块, 壳里的块只补「相对壳」的那点差: 前后都在壳内,
  // 途中也就不出壳。
  var PIECES = '.mwho, .mb > *, .mb > .turn-group > .bubbles > *';
  var BUB = '.bubble.mq, .say > .bubble';
  var calm = function () { return window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches; };
  var rowsById = function () {
    return [].slice.call(inner.querySelectorAll('.mrow:not(.mark)')).reduce(function (acc, r) {
      acc[r.getAttribute('data-id')] = r; return acc;
    }, {});
  };
  var piecesOf = function (row) { return [].slice.call(row.querySelectorAll(PIECES)); };
  // 先把所有矩形读完再读底色 —— 读与读之间没有写, 整次快照只排一次版。
  var snapRows = function (at) {
    var rows = rowsById();
    var shot = Object.keys(rows).reduce(function (acc, id) {
      var rects = piecesOf(rows[id]).map(function (el) { return el.getBoundingClientRect(); });
      if (rects.some(function (b) { return b.height; })) acc[id] = { rects: rects };   // 关着的 ping 组里 = 看不见
      return acc;
    }, {});
    Object.keys(shot).forEach(function (id) {
      shot[id].bubs = [].slice.call(rows[id].querySelectorAll(BUB)).map(function (b) { return getComputedStyle(b).backgroundColor; });
    });
    return { at: at && shot[at] ? at : '', rows: shot };
  };
  // 滚动锚: 优先被点的那条, 否则第一条前后都看得见的; 把它的首块挪回旧的屏上位置。
  var anchorScroll = function (snap, rows) {
    var head = function (id) { var el = rows[id] && rows[id].querySelector(PIECES); return el && el.getBoundingClientRect(); };
    var shown = function (id) { var b = head(id); return b && b.height; };
    var id = snap.at && shown(snap.at) ? snap.at : Object.keys(snap.rows).filter(shown)[0];
    if (!id) return false;
    thread.scrollTop += head(id).top - snap.rows[id].rects[0].top;
    S.pinned = atBottom();
    return true;
  };
  var playFlip = function (snap, rows) {
    var ease = { duration: 340, easing: 'cubic-bezier(.2,.7,.2,1)' };
    var vp = thread.getBoundingClientRect();
    var onScreen = function (b) { return b.height && b.bottom > vp.top && b.top < vp.bottom; };
    // 同样先整批读, 再整批写。宽度变了的块 (别人的气泡被列撑宽, 自己的收回内容宽) 贴着新的
    // 那一侧对齐: 靠右的行比右边缘, 靠左的比左边缘。
    var plan = Object.keys(snap.rows).reduce(function (acc, id) {
      var row = rows[id], was = snap.rows[id];
      if (!row) return acc;
      var right = row.classList.contains('mine');
      var shell = null, lift = [0, 0];   // 这一行 .turn-group 的位移, 壳里的块要减掉它
      piecesOf(row).forEach(function (el, i) {
        var a = was.rects[i], b = el.getBoundingClientRect();
        if (!a || !el.animate) return;
        var dx = right ? a.right - b.right : a.left - b.left, dy = a.top - b.top;
        if (el.classList.contains('turn-group')) { shell = el; lift = [dx, dy]; }
        else if (shell && shell.contains(el)) { dx -= lift[0]; dy -= lift[1]; }
        if (!(onScreen(a) || onScreen(b))) return;
        if (dx || dy) acc.push([el, [{ transform: 'translate(' + dx + 'px,' + dy + 'px)' }, { transform: 'none' }]]);
      });
      var bubs = row.querySelectorAll(BUB);
      was.bubs.forEach(function (from, i) {
        var b = bubs[i], to = b && getComputedStyle(b).backgroundColor;
        if (to && to !== from) acc.push([b, [{ backgroundColor: from }, { backgroundColor: to }]]);
      });
      return acc;
    }, []);
    plan.forEach(function (p) { p[0].animate(p[1], ease); });
    // 对侧那片空白 (.flip) 是立即到新布局的, 它的 sticky 箭头与 hover 底色会画在正滑过来的
    // 气泡上面 —— 滑行期间把它藏起来、把列抬到上层 (chat.css 的 .fl-run), 落定再放出来。
    if (!plan.length) return;
    clearTimeout(S.flRun);
    inner.classList.add('fl-run');
    S.flRun = setTimeout(function () { inner.classList.remove('fl-run'); }, ease.duration);
  };
  // 重排之后: 先锚滚动, 再从旧位置滑过来。没有一条可配对的返回 false。
  var landFlip = function (snap) {
    if (!snap) return false;
    var rows = rowsById();
    if (!anchorScroll(snap, rows)) return false;
    playFlip(snap, rows);
    return true;
  };
  // 整窗重拉会把正文换成服务端的新片段 —— 过程框按「已有终句就收起」重新出生, 点开的工具
  // 与取过的正文全丢, 看上去就是工具那一截在切换中突然没了。sig 没变的行把旧 .mb 整块搬回来,
  // 与 flipWindow 同一个做法: 折叠 / 展开态、懒取的工具正文、已渲染的 markdown 一并保住。
  var keepBodies = function () {
    return [].slice.call(inner.querySelectorAll('.mrow:not(.mark)')).reduce(function (acc, r) {
      var mb = r.querySelector('.mb');
      if (mb) acc[r.getAttribute('data-id')] = { mb: mb, sig: r.getAttribute('data-sig') };
      return acc;
    }, {});
  };
  var adoptBodies = function (kept) {
    Object.keys(kept).forEach(function (id) {
      var row = rowNode(id), k = kept[id];
      var nb = row && row.getAttribute('data-sig') === k.sig && row.querySelector('.mb');
      if (nb) nb.replaceWith(k.mb);
    });
  };
  /** 同一窗口换视角: 拿手里的片段就地重包左右, 已渲染的正文整块搬过去。
   *  先等 role 摘要到手、页头侧栏按新视角画完再重包 —— 页头换了高度 (人没有职责行、有的 wizard 有),
   *  在动画起跑之后才变, 整列就会在半路被顶一下。旧行在这几十毫秒里原样留着。 */
  var flipWindow = function (snap) {
    S.gen++;
    syncUrl();
    var gen = S.gen;
    api('api/role', viewParams()).then(function (d) {
      if (!d.ok || gen !== S.gen) return;
      applyRole(d);
      unfoldPings(inner);
      [].slice.call(inner.querySelectorAll('.mrow')).forEach(function (row) {
        var m = S.frags[row.getAttribute('data-id')];
        // 断点 (/clear /new) 是旧视角 role 自己的, 新视角的由下面补拉。
        if (!m || m.dir === 'mark') { row.remove(); return; }
        var next = frag(rowHTML(m)).firstElementChild;
        var ob = row.querySelector('.mb'), nb = next.querySelector('.mb');
        if (ob && nb) nb.replaceWith(ob);
        row.replaceWith(next);
        bindRow(next);
      });
      foldPings(inner);
      expireRows();
      landFlip(snap);
      connect();
      return api('api/msgs', viewParams());
    }).then(function (d) {
      if (!d || !d.ok || gen !== S.gen) return;
      // 断点晚到, 插在视窗上方会把正在滑的整列顶下去 —— 没吸底时锚住屏上第一条, 插完挪回原处。
      var marks = d.msgs.filter(function (m) { return m.dir === 'mark'; });
      if (!marks.length) return;
      var ref = !S.pinned && firstShown(), top = ref && ref.getBoundingClientRect().top;
      marks.forEach(upsertMsg);
      if (ref && ref.isConnected) thread.scrollTop += ref.getBoundingClientRect().top - top;
    });
  };
  var firstShown = function () {
    var vp = thread.getBoundingClientRect();
    return [].slice.call(inner.querySelectorAll('.mrow:not(.mark)')).filter(function (r) {
      var b = r.getBoundingClientRect(); return b.height && b.bottom > vp.top;
    })[0];
  };

  $('#tb-back').onclick = function () { app.classList.remove('reading'); };

  // ══ 关系视图 ═══════════════════════════════════════════════════════
  // 三层叠在一起:
  //   1. 聊天卡片 (HTML)  —— 归属; 一张卡 = 一个群
  //   2. 家谱缩进 (HTML)  —— 层级; 分身 / 子 wizard 缩在父亲下面, 左侧一道折线
  //   3. 连线   (SVG)     —— 其余的关系; 布局表达不了的那些 (跨卡片的家谱、
  //                         同群与跨群的派活、流水线的一步)
  // 前两层撑起版面 (所以文字永远可读), 第三层才是"图"。
  var EDGE = {
    // 分身: 从父亲某个 session 节点 fork, 带着上下文; 子 wizard: 父亲 spawn 的白板。
    clone: { c: '#8250df', label: '分身', dash: '', tip: '从父亲的某个 session 节点 fork 出来, 开局带着那一刻的上下文' },
    spawn: { c: '#bc4c00', label: '子 wizard', dash: '9 3', tip: '父亲 spawn 的白板 wizard, 只有出身、没有继承上下文' },
    peer: { c: '#0969da', label: '派活', dash: '5 4' },
    graph: { c: '#0a7d6b', label: '流水线', dash: '2 3' },
  };

  // 老 webview 未必有 CSS.escape, 而 target 里带着 `:` 和 `#` —— 不转义选择器
  // 直接抛异常, 整张图就白了。
  var cssEsc = function (v) {
    return window.CSS && CSS.escape
      ? CSS.escape(v)
      : String(v).replace(/[^a-zA-Z0-9_-]/g, function (c) { return '\\' + c; });
  };

  var shortPath = function (p, keep) {
    var seg = String(p || '').replace(/\/+$/, '').split('/').filter(Boolean);
    return seg.length <= keep ? p : '…/' + seg.slice(-keep).join('/');
  };

  var wRunning = function (n) { return n.busy || (!!n.runningUntil && srvNow() < n.runningUntil); };

  // ── 走进一个 wizard ──
  // 任一票据都能看任一 role (见 chat-http), 所以走进谁就是把视角切成谁 —— 不再整页跳。
  var chatOf = function (base) {
    return (W.chats || []).filter(function (c) { return c.base === base; })[0];
  };
  var canOpen = function (n) { return !!n; };
  var openNode = function (target) { if (target) switchRole(target); };

  // 名字全局唯一, 卡片头写的是聊天名, 节点上只写它自己的 `.name`。
  var shortName = function (n) { return '.' + (n.name || n.tag || n.target); };

  // 与 sel 相连的一切 (含 sel 自己)。聚焦时其余的压暗而不是移除 —— 位置稳定,
  // 反复点不同节点时版面不会跳。
  var neighborhood = function (target) {
    var set = {}; set[target] = 1;
    W.edges.forEach(function (e) {
      if (e.from === target) set[e.to] = 1;
      if (e.to === target) set[e.from] = 1;
    });
    return set;
  };

  var edgeOn = function (e) { return !!W.kinds[e.kind]; };

  // 一个节点身上挂了几条 (当前开着的) 边。0 = 它此刻不属于任何协作关系 ——
  // 「只看有关系的」就是把这些收起来, 剩下的才是真正的那张网。
  var degree = function (target) {
    return W.edges.filter(edgeOn).filter(function (e) { return e.from === target || e.to === target; }).length;
  };

  var renderWTools = function () {
    var counts = { clone: 0, spawn: 0, peer: 0, graph: 0 };
    W.edges.forEach(function (e) { counts[e.kind] = (counts[e.kind] || 0) + 1; });
    var cross = W.edges.filter(function (e) { return e.cross; }).length;
    var chips = Object.keys(EDGE).map(function (k) {
      return '<button class="chip' + (W.kinds[k] ? ' on' : '') + '" data-k="' + k + '" ' +
        'style="--c:' + EDGE[k].c + '"' + (EDGE[k].tip ? ' title="' + EDGE[k].tip + '"' : '') + '><i></i>' + EDGE[k].label +
        '<b>' + (counts[k] || 0) + '</b></button>';
    }).join('');
    var force = W.layout === 'force';
    wtoolsEl.innerHTML =
      '<div class="wlegend">' + chips + '</div>' +
      '<div class="wlay">' +
        '<button class="lb' + (force ? '' : ' on') + '" data-lay="cards" ' +
          'title="按聊天分卡, 分身 / 子 wizard 缩在父亲下面 —— 归属与层级最准">▦ 卡片</button>' +
        '<button class="lb' + (force ? ' on' : '') + '" data-lay="force" ' +
          'title="wizard 之间的力导向图, 聊天收进节点 —— 协作关系最直观">🕸 关系网</button>' +
      '</div>' +
      '<div class="wstat">' +
        W.nodes.length + ' 个 wizard · ' + W.chats.length + ' 个聊天' +
        (cross ? ' · <b>' + cross + '</b> 条跨聊天关系' : '') +
        (W.degraded ? ' · <span class="warn" title="注册表不可达 (独立 svr 部署), 只画观测到的往来">名册缺席</span>' : '') +
        '<span class="hint">单击聚焦 · 双击进入' + (force ? ' · 拖动钉住' : ' (外聊天整页跳过去)') + '</span>' +
      '</div>' +
      (force ? '<button class="chip" id="wre" title="松开所有钉住的节点, 重新排一遍">↻ 重排</button>' : '') +
      '<button class="chip only' + (W.onlyRel ? ' on' : '') + '" id="wonly" ' +
        'title="把此刻不属于任何关系的 wizard 收起来 —— 剩下的就是这张协作网本身">' +
        (W.onlyRel ? '☑' : '☐') + ' 只看有关系的</button>' +
      (W.sel ? '<button class="chip clear" id="wclear">✕ 取消聚焦</button>' : '');
    wtoolsEl.querySelectorAll('.lb').forEach(function (b) {
      b.onclick = function () {
        var v = b.getAttribute('data-lay');
        if (v === W.layout) return;
        setLayout(v);
        renderWorld();
      };
    });
    var re = $('#wre');
    if (re) re.onclick = function () { FX.pos = {}; FX.sig = ''; renderForce(); };
    wtoolsEl.querySelectorAll('.chip[data-k]').forEach(function (b) {
      b.onclick = function () {
        var k = b.getAttribute('data-k');
        W.kinds[k] = W.kinds[k] ? 0 : 1;
        renderWTools();
        if (W.layout === 'force') renderForce(); else drawEdges();
      };
    });
    var only = $('#wonly');
    if (only) only.onclick = function () { W.onlyRel = !W.onlyRel; renderWorld(); };
    var cl = $('#wclear');
    if (cl) cl.onclick = function () { W.sel = ''; renderWorld(); };
  };

  var nodeHTML = function (n, depth) {
    var run = wRunning(n), nm = shortName(n);
    var bits = [];
    if (n.model) bits.push(n.model.replace(/^claude-/, ''));
    if (n.cwd) bits.push('📁 ' + shortPath(n.cwd, 1));
    if (n.turns) bits.push(n.turns + ' 轮');
    if (n.taskTurns) bits.push('⏰ ' + n.taskTurns);
    if (n.peerTurns) bits.push('✉ ' + n.peerTurns);
    return '<div class="wnode' + (n.self ? ' self' : '') + (run ? ' run' : '') +
        (n.alive ? '' : ' cold') + (n.target === ROLE ? ' local' : '') + (degree(n.target) ? ' rel' : '') +
        '" data-t="' + esc(n.target) + '" style="margin-left:' + (depth * 16) + 'px">' +
      (depth ? (n.inherited ? '<span class="lin" title="分身"></span>' : '<span class="lin sp" title="子 wizard"></span>') : '') +
      '<span class="wav">' + esc(n.label) + (run ? '<i class="live"></i>' : '') + '</span>' +
      '<span class="wbody">' +
        '<span class="wl1">' +
          '<b class="wname" title="' + esc(n.name || n.target) + '">' + esc(nm) + '</b>' +
          (n.inherited ? '<span class="wih" title="分身: 从父亲的 session 节点 fork, 开局带着那一刻的上下文">⧉</span>' : '') +
          '<span class="wts">' + esc(fmtAgo(n.lastTs)) + '</span>' +
        '</span>' +
        (n.description ? '<span class="wjob">' + esc(n.description) + '</span>' : '') +
        (n.preview ? '<span class="wprev">' + esc(n.preview) + '</span>' : '') +
        (bits.length ? '<span class="wmeta">' + bits.map(esc).join('<span class="sep">·</span>') + '</span>' : '') +
      '</span>' +
    '</div>';
  };

  var renderWMap = function () {
    if (!W.chats.length) {
      wmapEl.innerHTML = '<div class="empty">' + (W.loaded ? '还没有任何 wizard 记录' : '加载中…') + '</div>';
      return;
    }
    var hood = W.sel ? neighborhood(W.sel) : null;
    var cards = W.chats.map(function (c) {
      var shown = c.members.filter(function (mm) { return !W.onlyRel || degree(mm.target); });
      var live = shown.filter(function (mm) {
        var n = nodeOf(mm.target); return n && wRunning(n);
      }).length;
      var rows = shown.map(function (mm) {
        var n = nodeOf(mm.target);
        // 「只看有关系的」会把父亲筛掉而留下孩子 —— 那时的缩进没有参照物, 拉平。
        var d = W.onlyRel ? 0 : mm.depth;
        return n ? nodeHTML(n, d) : '';
      }).join('');
      if (!shown.length) return '';
      return '<section class="wchat' + (c.self ? ' self' : '') + '" data-base="' + esc(c.base) + '">' +
        '<header class="wch">' +
          '<span class="nm">' + esc(c.name || c.base) + '</span>' +
          (c.self ? '<span class="here">当前</span>' : '') +
          '<span class="ct">' + shown.length + (live ? ' · <em>' + live + ' 在跑</em>' : '') + '</span>' +
        '</header>' +
        '<div class="wrows">' + rows + '</div>' +
        (c.hidden || shown.length < c.members.length
          ? '<div class="wmore" title="不在图上的会话 —— 它们还在, 只是此刻既没在跑也没有关系">另有 ' +
              (c.hidden + (c.members.length - shown.length)) + ' 个未显示</div>'
          : '') +
      '</section>';
    }).filter(Boolean).join('');
    wmapEl.innerHTML = '<svg class="wedges" id="wedges"></svg><div class="wgrid">' +
      (cards || '<div class="empty">此刻没有任何协作关系 —— 派活 / 生分身 / 生子 wizard 之后这里就有边了</div>') + '</div>';
    wmapEl.querySelectorAll('.wnode').forEach(function (el) {
      var t = el.getAttribute('data-t');
      if (hood && !hood[t]) el.classList.add('dim');
      if (t === W.sel) el.classList.add('sel');
      if (canOpen(nodeOf(t))) el.classList.add('go');
      el.onclick = function () { W.sel = (W.sel === t ? '' : t); renderWorld(); };
      // 双击 = 走进它: 视角切成它 (见 openNode)。
      el.ondblclick = function () { openNode(t); };
    });
    // 卡片头 = 那个群本身。点它进那个群里最近活跃的那一栏 —— 图上找不到哪个
    // 节点该双击的时候, 这是最直觉的入口。
    wmapEl.querySelectorAll('.wch').forEach(function (h) {
      var c = chatOf(h.parentNode.getAttribute('data-base'));
      var first = c && c.members.filter(function (mm) { return canOpen(nodeOf(mm.target)); })[0];
      if (!first) return;
      h.classList.add('go');
      h.onclick = function () { openNode(first.target); };
    });
  };

  // ── 连线 ──
  // 端点在布局之后才知道 (卡片会换行、文字会折行), 所以连线是一个纯粹的
  // "读版面 → 画路径" 的过程, 每次重排都重来一遍, 不维护任何位置状态。
  var anchorsOf = function (a, b, base) {
    var ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
    var ox = base.left, oy = base.top;
    var A = { l: ra.left - ox, r: ra.right - ox, cy: ra.top - oy + ra.height / 2 };
    var B = { l: rb.left - ox, r: rb.right - ox, cy: rb.top - oy + rb.height / 2 };
    // 同一列 (同一张卡片里) → 两端都走左侧, 从左边的空白处绕出去, 像 git 图的
    // 那条 gutter。左右分列 → 从近的一侧出、近的一侧进。
    if (Math.abs(A.l - B.l) < 60) {
      // 同卡片内的边走卡片自己的左内边距 (.wrows 的 padding-left) —— 那条车道
      // 就是为它留的。拐到卡片外面既会被滚动容器裁掉, 也读不出"这两个是一个群
      // 里的"。room 按最近的卡片左沿算, 没有卡片 (理论上不会) 才退回画布左沿。
      var card = a.closest('.wchat');
      var lane = card ? card.getBoundingClientRect().left - ox + 6 : 4;
      var room = Math.max(6, Math.min(A.l, B.l) - lane);
      var d = Math.min(room, 14 + Math.abs(A.cy - B.cy) * 0.22);
      return {
        d: 'M' + A.l + ',' + A.cy + ' C' + (A.l - d) + ',' + A.cy + ' ' + (B.l - d) + ',' + B.cy + ' ' + B.l + ',' + B.cy,
        head: 'start',
      };
    }
    var right = B.l > A.l;
    var ax = right ? A.r : A.l, bx = right ? B.l : B.r;
    var k = right ? 1 : -1, dd = Math.max(46, Math.abs(bx - ax) * 0.42);
    return {
      d: 'M' + ax + ',' + A.cy + ' C' + (ax + dd * k) + ',' + A.cy + ' ' + (bx - dd * k) + ',' + B.cy + ' ' + bx + ',' + B.cy,
      head: right ? 'end' : 'start',
    };
  };

  var drawEdges = function () {
    var svg = $('#wedges');
    if (!svg) return;
    var base = wmapEl.getBoundingClientRect();
    svg.setAttribute('width', wmapEl.scrollWidth);
    svg.setAttribute('height', wmapEl.scrollHeight);
    svg.setAttribute('viewBox', '0 0 ' + wmapEl.scrollWidth + ' ' + wmapEl.scrollHeight);
    var defs = Object.keys(EDGE).map(function (k) {
      return ['', '-d'].map(function (sfx) {
        return '<marker id="ah-' + k + sfx + '" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" ' +
          'orient="auto-start-reverse"><path d="M0,0 L8,4 L0,8 z" fill="' + EDGE[k].c + '" ' +
          'opacity="' + (sfx ? '.16' : '.85') + '"/></marker>';
      }).join('');
    }).join('');
    var hood = W.sel ? neighborhood(W.sel) : null;
    var paths = W.edges.filter(edgeOn).map(function (e) {
      var a = wmapEl.querySelector('.wnode[data-t="' + cssEsc(e.from) + '"]');
      var b = wmapEl.querySelector('.wnode[data-t="' + cssEsc(e.to) + '"]');
      if (!a || !b) return '';
      var p = anchorsOf(a, b, base);
      // 聚焦时: 不碰 sel 的边压到近乎不可见 —— 删掉它们会让"这张图本来有多密"
      // 这个信息消失, 而那恰恰是判断要不要收几个 wizard 的依据。
      var off = hood && !(e.from === W.sel || e.to === W.sel);
      var w = Math.min(4, 1.1 + Math.log(1 + e.count) * 0.9);
      return '<path d="' + p.d + '" fill="none" stroke="' + EDGE[e.kind].c + '" ' +
        'stroke-width="' + (off ? 1 : w).toFixed(2) + '" ' +
        'stroke-dasharray="' + (EDGE[e.kind].dash || '') + '" ' +
        'opacity="' + (off ? 0.14 : (e.cross ? 0.95 : 0.6)) + '" ' +
        'marker-' + p.head + '="url(#ah-' + e.kind + (off ? '-d' : '') + ')">' +
        '<title>' + esc(nameOf(e.from) + ' → ' + nameOf(e.to)) + ' · ' + EDGE[e.kind].label +
        (e.count > 1 ? ' ×' + e.count : '') + (e.cross ? ' (跨聊天)' : '') +
        (e.jobs && e.jobs.length ? ' · 工单 ' + esc(e.jobs.join(' ')) : '') + '</title></path>';
    }).join('');
    svg.innerHTML = '<defs>' + defs + '</defs>' + paths;
  };

  // ── 力导向布局 ────────────────────────────────────────────────────
  // 卡片布局把「归属」和「层级」交给版面, 代价是聊天必须张张画出来: 一个只出了
  // 一个分身的群也占一整张卡, 而跨聊天那条边得横穿半张图去找对面。
  // 换一种折法 —— 只画 wizard, 聊天收进节点自己 (左侧色条 + 群名一行), 位置交给
  // 力: 同群相吸自然成簇, 家谱 (分身 / 子 wizard) 的边比派活的边短, 家谱于是仍然读得出来。
  // 两种读法各有盲区 (力导向读不出精确的父子层级), 所以是开关不是替换。
  // 绿在这一页已经有主 (在跑), 所以群色不用绿 —— 一道绿色条会被读成「它活着」。
  var CHAT_C = ['#0969da', '#8250df', '#bc4c00', '#bf3989', '#0a7d6b', '#cf222e', '#9a6700', '#4338ca'];
  var hashOf = function (s) {
    var v = String(s), h = 0;
    for (var i = 0; i < v.length; i++) h = (h * 31 + v.charCodeAt(i)) >>> 0;
    return h;
  };
  // 颜色按 base **排序**取位, 而不是按它在列表里的次序取位 —— 列表次序随最近活动
  // 变, 颜色跟着变就没人记得住哪个色是哪个群; 排序是稳定的, 顺带保证 8 个群之内
  // 一个不撞。超过 8 个才退回 hash。
  var chatColor = function (base) {
    return (FX.color || {})[base] || CHAT_C[hashOf(base) % CHAT_C.length];
  };
  // 取位用的是**全部**节点而不是画在图上的那些 —— 拿筛过的集合分色, 一按「只看
  // 有关系的」每个群的颜色就换一轮。
  var fxColors = function () {
    var bases = [];
    W.nodes.forEach(function (n) { if (bases.indexOf(n.base) < 0) bases.push(n.base); });
    return bases.sort().reduce(function (m, b, i) { m[b] = CHAT_C[i % CHAT_C.length]; return m; }, {});
  };

  // pos 按 target 存活: 6 秒一次的轮询重画 DOM, 但坐标沿用, 图不会每轮跳一次。
  var FX = { pos: {}, size: {}, els: {}, paths: [], color: {}, nodes: [], edges: [], w: 0, h: 0, alpha: 0, raf: 0, drag: null, sig: '' };

  var fxNodes = function () {
    return W.nodes.filter(function (n) { return !W.onlyRel || degree(n.target); });
  };

  /** 种子位置: 聊天摆一圈, 成员散在自己那个群周围。确定性 (hash 而不是 random)
   *  —— 同一批 wizard 每次打开这一页, 图的大致形状是同一个。 */
  var fxSeed = function (ns) {
    var bases = [];
    ns.forEach(function (n) { if (bases.indexOf(n.base) < 0) bases.push(n.base); });
    var cx = FX.w / 2, cy = FX.h / 2, R = Math.min(FX.w, FX.h) * 0.28;
    var on = {};
    ns.forEach(function (n) { on[n.target] = 1; });
    Object.keys(FX.pos).forEach(function (t) { if (!on[t]) delete FX.pos[t]; });
    ns.forEach(function (n) {
      if (FX.pos[n.target]) return;
      var i = bases.indexOf(n.base);
      var a = bases.length > 1 ? (i / bases.length) * Math.PI * 2 : 0;
      var bx = bases.length > 1 ? cx + Math.cos(a) * R : cx;
      var by = bases.length > 1 ? cy + Math.sin(a) * R : cy;
      var t = (hashOf(n.target) % 360) * Math.PI / 180;
      FX.pos[n.target] = { x: bx + Math.cos(t) * 46, y: by + Math.sin(t) * 46, vx: 0, vy: 0, pin: 0 };
    });
  };

  var fxTick = function () {
    var ns = FX.nodes, P = FX.pos, n = ns.length;
    if (!n) return;
    var L = Math.max(86, Math.min(190, Math.sqrt(FX.w * FX.h / n) * 0.66));
    var rep = L * L * 1.15;
    var i, j, a, b, dx, dy, d, ux, uy, f;
    // 斥力 —— O(n²), 但这张图按设计就不超过几十个节点 (见 shared/world 的相关性)。
    for (i = 0; i < n; i++) {
      a = P[ns[i].target];
      for (j = i + 1; j < n; j++) {
        b = P[ns[j].target];
        dx = b.x - a.x; dy = b.y - a.y;
        d = Math.sqrt(dx * dx + dy * dy) || 0.01;
        f = rep / (d * d); ux = dx / d; uy = dy / d;
        a.vx -= ux * f; a.vy -= uy * f; b.vx += ux * f; b.vy += uy * f;
      }
    }
    // 弹簧 —— 家谱边的静息长度短于派活的, 于是家谱天然抱成一小团。
    // 静息长度有个下限: 节点是一张一百多像素宽的卡片, 不是一个点。两端贴到一起
    // 时连线被两张卡各自吃掉一半, 剩下的那截连箭头都放不下 —— 图上就成了一条
    // 看不见的边。下限按两张卡的半宽算, 横着摆也留得出一段看得见的线。
    FX.edges.forEach(function (e) {
      var pa = P[e.from], pb = P[e.to];
      if (!pa || !pb) return;
      var za = FX.size[e.from] || { w: 150, h: 36 }, zb = FX.size[e.to] || { w: 150, h: 36 };
      var ex = pb.x - pa.x, ey = pb.y - pa.y;
      var ed = Math.sqrt(ex * ex + ey * ey) || 0.01;
      var kin = e.kind === 'clone' || e.kind === 'spawn';
      var rest = Math.max((za.w + zb.w) / 2 + 30, kin ? L * 0.8 : L * 1.35);
      var k = (kin ? 0.06 : 0.032) * Math.min(2.2, 1 + Math.log(1 + e.count) * 0.45);
      var g = (ed - rest) * k, gx = ex / ed, gy = ey / ed;
      pa.vx += gx * g; pa.vy += gy * g; pb.vx -= gx * g; pb.vy -= gy * g;
    });
    // 同群相吸 + 朝心收 —— 归属在卡片布局里由版面表达, 这里由一股弱引力表达。
    var cen = {};
    ns.forEach(function (nd) {
      var p = P[nd.target], c = cen[nd.base] || (cen[nd.base] = { x: 0, y: 0, n: 0 });
      c.x += p.x; c.y += p.y; c.n++;
    });
    ns.forEach(function (nd) {
      var p = P[nd.target], c = cen[nd.base];
      p.vx += (c.x / c.n - p.x) * 0.022 + (FX.w / 2 - p.x) * 0.006;
      p.vy += (c.y / c.n - p.y) * 0.022 + (FX.h / 2 - p.y) * 0.006;
    });
    // 积分。alpha 同时当步长, 于是"冷却"就是自然停住。
    ns.forEach(function (nd) {
      var p = P[nd.target];
      if (p.pin) { p.vx = 0; p.vy = 0; return; }
      p.vx *= 0.8; p.vy *= 0.8;
      var sp = Math.sqrt(p.vx * p.vx + p.vy * p.vy), cap = 26;
      if (sp > cap) { p.vx *= cap / sp; p.vy *= cap / sp; }
      p.x += p.vx * FX.alpha; p.y += p.vy * FX.alpha;
    });
    // 矩形避让 —— 节点是一行字, 不是一个点。圆形斥力挡不住两张卡横向叠在一起,
    // 而这张图的全部价值就在于那行字读得出来。
    // 它排在积分之后, 所以收边必须排在它之后 —— 反过来的话, 被挤到边上的节点会
    // 被推出画布再也回不来 (弱引力拉不过避让)。
    var pass, pa, pb, sa, sb, mx, my, ox, oy, sh;
    for (pass = 0; pass < 2; pass++) {
      for (i = 0; i < n; i++) {
        for (j = i + 1; j < n; j++) {
          pa = P[ns[i].target]; pb = P[ns[j].target];
          sa = FX.size[ns[i].target]; sb = FX.size[ns[j].target];
          if (!sa || !sb) continue;
          mx = (sa.w + sb.w) / 2 + 18; my = (sa.h + sb.h) / 2 + 10;
          dx = pb.x - pa.x; dy = pb.y - pa.y;
          ox = mx - Math.abs(dx); oy = my - Math.abs(dy);
          if (ox <= 0 || oy <= 0) continue;
          if (ox / mx < oy / my) {
            sh = (dx < 0 ? -1 : 1) * ox;
            if (pa.pin) pb.x += sh; else if (pb.pin) pa.x -= sh;
            else { pa.x -= sh / 2; pb.x += sh / 2; }
          } else {
            sh = (dy < 0 ? -1 : 1) * oy;
            if (pa.pin) pb.y += sh; else if (pb.pin) pa.y -= sh;
            else { pa.y -= sh / 2; pb.y += sh / 2; }
          }
        }
      }
    }
    // 收进画布 —— 钉住的也收, 窗口缩小之后那些被人摆在外面的节点得跟着回来。
    ns.forEach(function (nd) {
      var p = P[nd.target], z = FX.size[nd.target] || { w: 150, h: 36 };
      p.x = Math.max(z.w / 2 + 6, Math.min(FX.w - z.w / 2 - 6, p.x));
      p.y = Math.max(z.h / 2 + 6, Math.min(FX.h - z.h / 2 - 6, p.y));
    });
  };

  /** 中心沿 (ux,uy) 走到卡片矩形的边 —— 箭头要落在卡片外面才看得见。 */
  var fxRim = function (p, s, ux, uy) {
    var hw = (s ? s.w : 150) / 2 + 3, hh = (s ? s.h : 36) / 2 + 3;
    var t = Math.min(ux ? hw / Math.abs(ux) : 1e9, uy ? hh / Math.abs(uy) : 1e9);
    return { x: p.x + ux * t, y: p.y + uy * t };
  };

  /** 连线只在重排时建一次 —— 逐帧重写 innerHTML 会把一张 50 条边的图拖成幻灯片。
   *  之后每帧只改 `d`, 聚焦只改描边 (见 fxClasses)。 */
  var fxEdgesDOM = function () {
    var svg = $('#wedges');
    if (!svg) return;
    var defs = Object.keys(EDGE).map(function (k) {
      return ['', '-d'].map(function (sfx) {
        return '<marker id="ah-' + k + sfx + '" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" ' +
          'orient="auto-start-reverse"><path d="M0,0 L8,4 L0,8 z" fill="' + EDGE[k].c + '" ' +
          'opacity="' + (sfx ? '.16' : '.85') + '"/></marker>';
      }).join('');
    }).join('');
    svg.innerHTML = '<defs>' + defs + '</defs>' + FX.edges.map(function (e) {
      return '<path fill="none" stroke="' + EDGE[e.kind].c + '" ' +
        'stroke-dasharray="' + (EDGE[e.kind].dash || '') + '">' +
        '<title>' + esc(nameOf(e.from) + ' → ' + nameOf(e.to)) + ' · ' + EDGE[e.kind].label +
        (e.count > 1 ? ' ×' + e.count : '') + (e.cross ? ' (跨聊天)' : '') +
        (e.jobs && e.jobs.length ? ' · 工单 ' + esc(e.jobs.join(' ')) : '') + '</title></path>';
    }).join('');
    FX.paths = Array.prototype.slice.call(svg.querySelectorAll('path[stroke]'));
  };

  var fxPaint = function () {
    FX.nodes.forEach(function (n) {
      var p = FX.pos[n.target], el = FX.els[n.target];
      if (el && p) el.style.transform = 'translate(' + p.x.toFixed(1) + 'px,' + p.y.toFixed(1) + 'px) translate(-50%,-50%)';
    });
    FX.edges.forEach(function (e, i) {
      var path = FX.paths[i], pa = FX.pos[e.from], pb = FX.pos[e.to];
      if (!path || !pa || !pb) return;
      var dx = pb.x - pa.x, dy = pb.y - pa.y;
      var d = Math.sqrt(dx * dx + dy * dy) || 0.01, ux = dx / d, uy = dy / d;
      var A = fxRim(pa, FX.size[e.from], ux, uy), B = fxRim(pb, FX.size[e.to], -ux, -uy);
      // 恒向左弓 —— 互相派活的两个 wizard 有两条方向相反的边, 直线会重合成一条。
      var bow = Math.min(30, d * 0.14);
      var qx = (A.x + B.x) / 2 - uy * bow, qy = (A.y + B.y) / 2 + ux * bow;
      path.setAttribute('d', 'M' + A.x.toFixed(1) + ',' + A.y.toFixed(1) +
        ' Q' + qx.toFixed(1) + ',' + qy.toFixed(1) + ' ' + B.x.toFixed(1) + ',' + B.y.toFixed(1));
    });
  };

  var fxLoop = function () {
    FX.raf = 0;
    if (W.layout !== 'force' || VIEW !== 'world') return;
    fxTick();
    fxPaint();
    if (!FX.drag) FX.alpha *= 0.972;
    if (FX.alpha > 0.02 || FX.drag) FX.raf = requestAnimationFrame(fxLoop);
  };

  var fxHeat = function (a) {
    FX.alpha = Math.max(FX.alpha, a === undefined ? 0.9 : a);
    if (!FX.raf) FX.raf = requestAnimationFrame(fxLoop);
  };

  var fxStop = function () {
    if (FX.raf) cancelAnimationFrame(FX.raf);
    FX.raf = 0; FX.drag = null; FX.alpha = 0;
    wscrollEl.classList.remove('fx');
    wmapEl.classList.remove('force');
  };

  var fxClasses = function () {
    var hood = W.sel ? neighborhood(W.sel) : null;
    FX.nodes.forEach(function (n) {
      var el = FX.els[n.target];
      if (!el) return;
      el.classList.toggle('dim', !!(hood && !hood[n.target]));
      el.classList.toggle('sel', n.target === W.sel);
      el.classList.toggle('pin', !!(FX.pos[n.target] || {}).pin);
    });
    // 聚焦时无关的边压到近乎不可见而不是删掉 —— "这张图本来有多密"是判断要不要
    // 收几个 wizard 的依据 (同 drawEdges)。
    FX.edges.forEach(function (e, i) {
      var path = FX.paths[i];
      if (!path) return;
      var off = hood && !(e.from === W.sel || e.to === W.sel);
      var w = Math.min(4, 1.1 + Math.log(1 + e.count) * 0.9);
      path.setAttribute('stroke-width', (off ? 1 : w).toFixed(2));
      path.setAttribute('opacity', off ? 0.12 : (e.cross ? 0.95 : 0.55));
      path.setAttribute('marker-end', 'url(#ah-' + e.kind + (off ? '-d' : '') + ')');
    });
  };

  var fxNodeHTML = function (n) {
    var run = wRunning(n);
    var tip = [n.name, n.description, n.preview, n.cwd ? '📁 ' + n.cwd : '',
      [n.model && n.model.replace(/^claude-/, ''), n.turns ? n.turns + ' 轮' : ''].filter(Boolean).join(' · ')]
      .filter(Boolean).join('\n');
    return '<div class="fxn' + (n.self ? ' self' : '') + (run ? ' run' : '') + (n.alive ? '' : ' cold') +
        (canOpen(n) ? ' go' : '') + '" data-t="' + esc(n.target) + '" style="--c:' + chatColor(n.base) + '" ' +
        'title="' + esc(tip) + '">' +
      '<span class="wav">' + esc(n.label) + (run ? '<i class="live"></i>' : '') + '</span>' +
      '<span class="fxb">' +
        '<b class="wname">' + esc(shortName(n)) + '</b>' +
        '<span class="fxc">' + esc(n.chat || n.base) + (n.self ? ' · 本会话' : '') + '</span>' +
      '</span>' +
    '</div>';
  };

  // 拖动 = 钉住。点一下 (没挪动) 仍然是聚焦 —— 所以判据是位移而不是事件类型。
  var fxBind = function (el, t) {
    el.onpointerdown = function (ev) {
      if (ev.button) return;
      var p = FX.pos[t];
      if (!p) return;
      FX.drag = { t: t, dx: p.x - ev.clientX, dy: p.y - ev.clientY, moved: 0 };
      el.classList.add('drag');
      if (el.setPointerCapture) el.setPointerCapture(ev.pointerId);
      fxHeat(0.3);
      ev.preventDefault();
    };
    el.onpointermove = function (ev) {
      if (!FX.drag || FX.drag.t !== t) return;
      var p = FX.pos[t], nx = ev.clientX + FX.drag.dx, ny = ev.clientY + FX.drag.dy;
      FX.drag.moved += Math.abs(nx - p.x) + Math.abs(ny - p.y);
      p.x = nx; p.y = ny; p.vx = 0; p.vy = 0; p.pin = 1;
    };
    el.onpointerup = function () {
      if (!FX.drag || FX.drag.t !== t) return;
      var moved = FX.drag.moved;
      FX.drag = null;
      el.classList.remove('drag');
      if (moved < 5) {
        FX.pos[t].pin = 0;
        W.sel = (W.sel === t ? '' : t);
        renderWTools(); fxClasses(); fxHeat(0.12);
      } else { fxClasses(); fxHeat(0.2); }
    };
    el.ondblclick = function () { openNode(t); };
  };

  var renderForce = function () {
    var ns = fxNodes();
    wscrollEl.classList.add('fx');
    wmapEl.classList.add('force');
    if (!ns.length) {
      wmapEl.innerHTML = '<div class="empty">' + (W.loaded ? '此刻没有任何 wizard 在图上' : '加载中…') + '</div>';
      return;
    }
    var box = wscrollEl.getBoundingClientRect();
    FX.w = Math.max(320, box.width); FX.h = Math.max(300, box.height);
    FX.nodes = ns;
    FX.color = fxColors();
    fxSeed(ns);
    // 端点被「只看有关系的」筛掉的边没有落脚处 —— 画一根悬空的线只会让人以为漏了谁。
    var on = {};
    ns.forEach(function (n) { on[n.target] = 1; });
    FX.edges = W.edges.filter(edgeOn).filter(function (e) { return on[e.from] && on[e.to]; });
    // 轮询回来的快照通常一模一样 —— 那就只重画文字, 不重新点火, 免得这张图每 6
    // 秒自己抖一下。
    var sig = ns.map(function (n) { return n.target; }).join(',') + '|' +
      FX.edges.map(function (e) { return e.kind + e.from + '>' + e.to; }).join(',');
    var fresh = sig !== FX.sig;
    FX.sig = sig;
    wmapEl.innerHTML = '<svg class="wedges" id="wedges"></svg>' + ns.map(fxNodeHTML).join('');
    FX.els = {};
    wmapEl.querySelectorAll('.fxn').forEach(function (el) {
      var t = el.getAttribute('data-t');
      FX.els[t] = el;
      FX.size[t] = { w: el.offsetWidth, h: el.offsetHeight };
      fxBind(el, t);
    });
    var svg = $('#wedges');
    svg.setAttribute('viewBox', '0 0 ' + FX.w + ' ' + FX.h);
    fxEdgesDOM();
    fxClasses();
    fxPaint();
    fxHeat(fresh ? 0.9 : 0.05);
  };

  var renderWorld = function () {
    renderWTools();
    if (W.layout === 'force') { renderForce(); return; }
    fxStop();
    renderWMap();
    // 连线要等浏览器把卡片排好 —— 同一帧里量到的是上一次的版面。
    requestAnimationFrame(drawEdges);
  };

  // ══ 日程视图 ═══════════════════════════════════════════════════════
  // 定时任务与工单摆在一起, 因为它们回答同一个问题: **什么被安排了**。
  // 区别只在时间的方向 —— 定时指向未来 (下次几点放枪), 工单指向现在 (还开着
  // 的这几路活干完没有)。
  var fmtClock = function (ts) {
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
      esc((n && n.label) || '🧙') + ' ' + esc(nameOf(target)) + '</span>';
  };

  // 未来 12 小时的刻度条: 哪几个钟点会有任务醒来, 一眼看完。超出 12h 的排进下面
  // 的列表但不占刻度 —— 把 24h 压进这么窄的一条, 刻度会密到读不出。
  var HORIZON_H = 12;
  var renderStrip = function (list) {
    var now = srvNow(), span = HORIZON_H * 3600000;
    var soon = list.filter(function (x) { return x.nextAt - now < span; });
    var ticks = [];
    for (var i = 0; i <= HORIZON_H; i += 3) {
      var t = new Date(now + i * 3600000);
      ticks.push('<span class="tk" style="left:' + (i / HORIZON_H * 100) + '%">' +
        (i ? (t.getHours() < 10 ? '0' : '') + t.getHours() + ':00' : '现在') + '</span>');
    }
    var pins = soon.map(function (x) {
      var pct = Math.max(0, Math.min(100, (x.nextAt - now) / span * 100));
      return '<span class="pin" style="left:' + pct.toFixed(2) + '%" data-t="' + esc(x.target) + '" ' +
        'title="' + esc(fmtClock(x.nextAt) + ' · ' + nameOf(x.target) + ' · ' + x.when) + '"></span>';
    }).join('');
    return '<div class="strip"><div class="axis">' + ticks.join('') + '</div>' +
      '<div class="rail">' + pins + '</div>' +
      '<div class="cap">' + (soon.length ? '未来 ' + HORIZON_H + ' 小时内 ' + soon.length + ' 次触发' : '未来 ' + HORIZON_H + ' 小时内没有定时任务') + '</div></div>';
  };

  // 日程跟着 wizard 走: 只列归当前 role 的定时任务, 与它有关的工单 (它开的 / 它在里面)。
  var renderPlan = function () {
    var ss = (W.schedules || []).filter(function (x) { return (x.owner || x.createdBy || x.target) === ROLE; });
    var js = (W.jobs || []).filter(function (j) {
      return j.owner === ROLE || j.members.some(function (mm) { return mm.target === ROLE; });
    });
    var open = js.filter(function (j) { return j.status === 'open'; });
    var closed = js.filter(function (j) { return j.status !== 'open'; });
    var schedRows = ss.length
      ? ss.map(function (x) {
          return '<div class="prow">' +
            '<div class="pl">' +
              '<div class="pwhen">⏰ ' + esc(x.when) + '</div>' +
              '<div class="pnext"><b>' + esc(fmtClock(x.nextAt)) + '</b><span>' + esc(fmtIn(x.nextAt)) + '</span></div>' +
            '</div>' +
            '<div class="pr">' +
              '<div class="ph">' + wizChip(x.target) + (x.note ? '<span class="note">' + esc(x.note) + '</span>' : '') +
                '<span class="pid">' + esc(x.id) + '</span></div>' +
              '<div class="ptext">' + esc(x.prompt.split('\n')[0].slice(0, 160)) + '</div>' +
              '<div class="pfoot">' + (x.lastFired ? '上次 ' + esc(fmtAgo(x.lastFired)) : '还没跑过') + '</div>' +
            '</div>' +
          '</div>';
        }).join('')
      : '<div class="pempty">' + esc(roleName(ROLE)) + ' 名下没有定时任务 —— 让它 schedule_task 排一个</div>';

    var jobRow = function (j) {
      return '<div class="jrow' + (j.status === 'open' ? ' open' : '') + '">' +
        '<div class="jh"><span class="jid">' + esc(j.id) + '</span>' +
          '<span class="jt">' + esc(j.title) + '</span>' +
          '<span class="jst">' + (j.status === 'open' ? '进行中' : '已收工') + '</span>' +
          '<span class="jts">' + esc(fmtAgo(j.closedAt || j.openedAt)) + '</span></div>' +
        '<div class="jm">' + (j.members.length
          ? j.members.map(function (mm) {
              return '<span class="jmm">' + wizChip(mm.target) +
                (mm.spawned ? '<i class="tmp" title="为这个工单临时生的 wizard (分身或子 wizard), 收工时回收">临时</i>' : '') +
                '<em>' + esc((mm.task || '').split('\n')[0].slice(0, 70)) + '</em></span>';
            }).join('')
          : '<span class="jmm none">还没有成员</span>') + '</div>' +
        (j.summary ? '<div class="jsum">' + esc(j.summary.slice(0, 300)) + '</div>' : '') +
      '</div>';
    };

    planEl.innerHTML =
      '<section class="psec">' +
        '<h3>⏰ 定时任务<span>' + ss.length + '</span></h3>' +
        renderStrip(ss) + schedRows +
      '</section>' +
      '<section class="psec">' +
        '<h3>📋 工单<span>' + open.length + ' 开 / ' + closed.length + ' 收</span></h3>' +
        (js.length ? open.concat(closed).map(jobRow).join('') : '<div class="pempty">没有工单 —— 一次派出两个以上 wizard 时 open_job 开一个</div>') +
      '</section>';
    planEl.querySelectorAll('.wchip.go').forEach(function (c) {
      c.onclick = function () { openNode(c.getAttribute('data-t')); };
    });
  };

  // 关系图上随时间变化的只有两样: 呼吸灯该不该亮、"几分钟前"该写几。重建整张图
  // 会把滚动位置、聚焦态和连线一起抖掉, 所以这里只原地改这两处。
  var tickWorld = function () {
    wmapEl.querySelectorAll('.wnode').forEach(function (el) {
      var n = nodeOf(el.getAttribute('data-t'));
      if (!n) return;
      var run = wRunning(n);
      el.classList.toggle('run', run);
      var av = el.querySelector('.wav'), dot = el.querySelector('.wav .live');
      if (run && !dot && av) av.insertAdjacentHTML('beforeend', '<i class="live"></i>');
      if (!run && dot) dot.remove();
      var ts = el.querySelector('.wts');
      if (ts) ts.textContent = fmtAgo(n.lastTs);
    });
  };

  // ══ 视图切换 ═══════════════════════════════════════════════════════
  // 世界快照不走 SSE: 它变动的源头 (spawn / 改职责 / 开收工单 / 排定时) 一条都
  // 不经过 detail store。改成"看得见才轮询": 不在关系/日程栏、或者页面在后台, 就一次都不请求。
  var WORLD_MS = 6000;
  var worldTimer = null;
  var loadWorld = function () {
    return api('api/world', { role: ROLE }).then(function (d) {
      if (!d.ok) return;
      W.at = d.at; W.loaded = true;
      W.nodes = d.nodes || []; W.edges = d.edges || []; W.chats = d.chats || [];
      W.jobs = d.jobs || []; W.schedules = d.schedules || []; W.degraded = !!d.degraded;
      if (VIEW === 'world') renderWorld();
      if (VIEW === 'plan') renderPlan();
    }).catch(function () { });
  };
  var pollWorld = function () {
    if (worldTimer) { clearInterval(worldTimer); worldTimer = null; }
    if (VIEW === 'msgs') return;
    worldTimer = setInterval(function () {
      if (!document.hidden) loadWorld();
    }, WORLD_MS);
  };

  var setView = function (v) {
    VIEW = v;
    thread.hidden = v !== 'msgs';
    $('#pane-world').hidden = v !== 'world';
    $('#pane-plan').hidden = v !== 'plan';
    app.classList.toggle('outer', v !== 'msgs');
    // 手机上关系/日程占满主区 —— 进入即阅读态。
    if (v !== 'msgs') app.classList.add('reading');
    renderRole(); renderHead(); renderUsage();
    if (v === 'msgs') { fxStop(); toBottom(true); renderConvs(); }
    else {
      // 关系图一打开就聚焦在当前 role 身上: 它的邻居亮着, 其余压暗。
      if (v === 'world') W.sel = ROLE;
      if (!W.loaded) { (v === 'world' ? wmapEl : planEl).innerHTML = '<div class="empty">加载中…</div>'; }
      else if (v === 'world') renderWorld();
      else renderPlan();
      loadWorld();
    }
    pollWorld();
  };
  // 卡片换行会改变每个节点的坐标 —— 连线必须跟着重画。
  window.addEventListener('resize', function () {
    if (VIEW !== 'world') return;
    if (W.layout === 'force') renderForce(); else requestAnimationFrame(drawEdges);
  });

  // 本地心跳: 相对时间、运行中判定、耗时都随时间变化, 但服务端没有新事件可推。
  setInterval(function () {
    if (!R.role) return;
    renderUsage();
    expireRows();
    // 侧栏的「几分钟前」与状态灯: 内容没变时 renderConvs 不碰 DOM。
    paintStatus(); renderConvs();
    if (VIEW === 'world') tickWorld();
    else if (VIEW === 'plan') renderPlan();
  }, TICK_MS);

  // ── boot ──
  // 带着 role / conv 来的链接直接进阅读态 (手机上不先落在会话列表)。
  if (ROLE || CONV) app.classList.add('reading');
  refresh();
})();
