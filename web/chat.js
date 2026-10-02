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
  // '' = 未指定 (服务端按全部时间, 回包里认领成 'all'); 'all' = 全部时间; 其他 = 那一段的 sid。
  var SESSION = qs.get('session') || '';
  var TICK_MS = 3000;

  // at / recvAt: 服务端快照时刻与本地收到时刻。所有"现在几点"的判断都换算到
  // 服务端时钟, 否则客户端时钟偏几分钟就会把运行中的会话判成已结束。
  var R = { at: 0, recvAt: 0, role: null, sessions: [], convs: [], relations: false, schedules: 0, plan: null, stats: null, winStats: null };
  // frags: 当前窗口的原始片段 (id → 片段)。片段不带方向, 换视角时拿它就地重包左右。
  var S = { es: null, pinned: true, gen: 0, frags: {} };
  // 关系/日程两栏共用的世界快照。treeAll = 关系树展开全部; treeFor = 已把谁滚进过视野。
  var W = {
    at: 0, nodes: [], edges: [], chats: [], jobs: [], schedules: [],
    degraded: false, loaded: false, treeAll: false, treeFor: '', glance: {}, gKeys: '',
  };
  var VIEW = 'msgs';
  // 侧栏是会话列表还是关系图 —— 与右边的 VIEW 无关: 关系图下右边照样是选中的那段对话。
  var WORLD = qs.get('side') === 'world';
  var $ = function (s) { return document.querySelector(s); };
  var app = $('#app'), thread = $('#thread'), inner = $('#thread-in'), convsEl = $('#convs');
  var planEl = $('#plan-in');

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
    if (WORLD) p.side = 'world';
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
  // extra = 跟在名字后、同属一个点击范围的徽标 (原样 html)。
  var nm = function (id, name, go, extra) {
    var cls = 'nm ' + kindOf(id), txt = esc(name || roleName(id)) + (extra || '');
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
  // `a:<x>` / `a:<x>|<p1>,<p2>` 不在列表里: x 参与的全部对话 / x 与这几个对端之间的, 按时间排开
  // (关系图里点卡片看的就是它, 服务端同一个 talkOf) —— 现造一项, 落地时才不会被当成失效的会话退回默认。
  var convOf = function (key) {
    if (key && key.indexOf('a:') === 0) {
      var part = key.slice(2).split('|'), who = part[0], peers = (part[1] || '').split(',').filter(Boolean);
      var name = nameOf(who) + (peers.length ? ' 与 ' + peers.map(nameOf).join('、') + ' 的对话' : ' 的全部对话');
      return { key: key, kind: 'all', who: who, peers: peers, name: name, subs: [] };
    }
    return R.convs.filter(function (c) { return c.key === key; })[0];
  };
  // 人的单聊 (user:…) 在数据上是频道, 但对端只有那一个人时同样是一对一。
  var dmOf = function (c) {
    return c && c.kind === 'group' && c.base.indexOf('user:') === 0 && (c.subs || []).length === 1 ? c.subs[0] : null;
  };
  // 一对一会话的对端 (wizard 私聊 / 人的单聊 / 「只看我与 X」); 不是一对一则空。
  var pairPeer = function (c) {
    if (!c) return WITH || '';
    if (c.kind === 'all') return '';
    var dm = dmOf(c);
    return c.kind !== 'group' ? c.peer : WITH || (dm ? dm.role : '');
  };

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
  var ST = { wait: '等人点', run: '执行中', idle: '空闲', off: '已关闭' };
  // 等人点 (停在审批卡 / 提问卡上) 先于执行中: 审批长轮询期间 pane 照样在转圈。
  var stateOf = function (s) { return s.waiting && s.waiting.length ? 'wait' : wRunning(s) ? 'run' : s.alive ? 'idle' : 'off'; };
  // 忙闲只有这一个渲染点, 永远挂在名字右边 —— 名片 / 关系树 / 侧栏共用。
  // quiet: 只在执行中 / 等人点时出现、只要灯不要字 (侧栏: 列表里安静是常态, 亮着的才值得看一眼)。
  var stTag = function (s, quiet) {
    if (!s) return '';
    var k = stateOf(s);
    if (quiet && k !== 'run' && k !== 'wait') return '';
    var tip = k === 'wait' ? '停在 ' + s.waiting.join(' / ') + ' 上等人点 (审批卡 / 提问卡)' : ST[k];
    return '<span class="wst ' + k + '" title="' + esc(tip) + '">' + (quiet ? '' : esc(k === 'wait' ? ST[k] + ' · ' + s.waiting[0] : ST[k])) + '</span>';
  };
  var paintStatus = function () {
    var el = $('#rb-st');
    if (el && R.role) el.innerHTML = stTag(R.role);
  };

  var avatarOf = function (c, extra) {
    if (c.kind !== 'group') return goSpan('av', c.peer, esc(c.label) + (extra || ''));
    var ms = membersOf(c).slice(0, 4);
    return '<span class="av mosaic n' + ms.length + '" aria-hidden="true">' +
      ms.map(function (m) { return '<i>' + esc(m.label || roleLabel(m.role)) + '</i>'; }).join('') + '</span>';
  };

  // ends = [[id, 已知头像]]; 没带头像的按 role 查。
  var pairOf = function (ends) {
    return '<span class="pair">' + ends.map(function (e) { return goSpan('av', e[0], esc(e[1] || roleLabel(e[0]))); }).join('') + '</span>';
  };

  var line = function (title, ts, pv, lamp, unread) {
    return '<span class="b"><span class="l1"><span class="t">' + title + '</span>' + (lamp || '') +
      '<span class="ts">' + esc(fmtAgo(ts)) + '</span></span>' +
      '<span class="l2"><span class="pv">' + esc(pv) + '</span>' +
      (unread ? '<b class="ub">' + (unread > 99 ? '99+' : unread) + '</b>' : '') + '</span></span>';
  };

  // ── 未读: 别人说完、我还没读到的话 ──
  // 服务端给每个会话一份 heard = [说完的时刻, 属于我与谁的那一对], 以及我在群里 / 每一对里
  // 最后开口的时刻 (mine)。一句话的已读水位 = 它所在那一处「我最后开口」与「我看过」的较晚者:
  // 属于某一对的看那一对 (群里说过话不等于读过别的线程), 不属于任何一对的看群。
  // 「看过」记在本地 (刷新 / 换视角都还在), 按视角分账 —— 同一个群换个 role 看, 未读是另一回事。
  var READ_KEY = 'wezard.role.read';
  var READ = (function () {
    try { var v = JSON.parse(localStorage.getItem(READ_KEY) || '{}'); if (v && v.at) return v; } catch (e) { }
    return { at: {} };
  })();
  var saveRead = function () { try { localStorage.setItem(READ_KEY, JSON.stringify(READ)); } catch (e) { } };
  var readKey = function (key, withRole) { return ROLE + '|' + key + '|' + (withRole || ''); };
  var seenAt = function (key, withRole) { return READ.at[readKey(key, withRole)] || 0; };
  var unreadOf = function (c, withRole) {
    var g = seenAt(c.key);
    var mark = {};
    (c.subs || []).forEach(function (s) { mark[s.role] = Math.max(g, s.mine || 0, seenAt(c.key, s.role)); });
    var groupMark = Math.max(g, c.mine || 0);
    return (c.heard || []).filter(function (h) {
      if (withRole && h[1] !== withRole) return false;
      return h[0] > (h[1] ? (mark[h[1]] !== undefined ? mark[h[1]] : groupMark) : groupMark);
    }).length;
  };
  var reading = function () { return VIEW === 'msgs' && !document.hidden; };
  // 窗口是 `a:<x>|<peers>` (关系图卡片) 时, 视角与 p 的往来在不在里面 —— 与服务端 talkOf 同一口径:
  // 一端是 x、另一端是 peers 之一 (peers 空 = 不限), 不分频道。
  var talkCovers = function (p) {
    var t = convOf(CONV);
    if (!t || t.kind !== 'all') return false;
    var hit = function (a, b) { return t.who === a && (!t.peers.length || t.peers.indexOf(b) >= 0); };
    return hit(ROLE, p) || hit(p, ROLE);
  };
  // 一处会话里这次读到了哪几对 (存水位用的 withRole): 侧栏选中的就是那一项; 关系图卡片打开的
  // 对话横跨会话, 每个会话里落在那段对话里的那几对都算 —— 私聊的那一对记在会话本身 ('')。
  var readPairs = function (c) {
    if (c.key === CONV) return [WITH];
    if (c.kind !== 'group') return c.peer && talkCovers(c.peer) ? [''] : [];
    return (c.subs || []).filter(function (s) { return talkCovers(s.role); }).map(function (s) { return s.role; });
  };
  // 读整个群 = 群的水位推到此刻 (子项随之全清); 只读一对 = 只推那一对的。
  var markRead = function (c) {
    if (!reading()) return;
    var h = c.heard && c.heard[c.heard.length - 1];
    var hit = readPairs(c).filter(function (w) { return unreadOf(c, w || (c.kind !== 'group' ? c.peer : '')); });
    hit.forEach(function (w) { READ.at[readKey(c.key, w)] = Math.max(R.at, h ? h[0] : 0); });
    if (hit.length) saveRead();
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

  // ── 会话项 / 子项 / 关系图卡片共用的三样: 一行的数据 (glance)、一行的画法 (roleRow)、排序 (recentFirst) ──
  // glance = 时刻 · 最近一句 · 未读, 取自会话本身 (子项 = 我与它在这个群里的那一对)。
  var glance = function (c, s) {
    var x = s || c;
    return { lastTs: x.lastTs, preview: x.preview, unread: unreadOf(c, s ? s.role : undefined) };
  };
  // 同层按最近活动排, 有新话就上浮。
  var recentFirst = function (a, b) { return b.lastTs - a.lastTs; };
  // 一个 role 的一行: 头像 · 名字 (+tail) + 忙闲灯 · 时刻 / 最近一句 + 未读。
  var roleRow = function (id, name, label, g, status, tail, badge) {
    return goSpan('av', id, esc(label)) +
      line(nm(id, name, true, badge) + (tail || ''), g.lastTs, g.preview, stTag(status, true), g.unread);
  };
  // 名字旁的「+N」: 它在这里还和 N 个别的 role 说着话, 那几段不在当前视角里。
  var unseenTail = function (id, n) {
    return n ? '<span class="oc" title="' + esc(nameOf(id) + ' 在这里还和 ' + n + ' 个别的 role 说过话, 切到它的视角可见') + '">+' + n + '</span>' : '';
  };
  var convRow = function (c) {
    if (c.kind === 'wizard') return roleRow(c.peer, c.name, c.label, glance(c), c.status, '', unseenTail(c.peer, c.unseen));
    return avatarOf(c) + line('<span class="nm chat">' + esc(c.name) + '</span>', c.lastTs, c.preview, stTag(c.status, true), unreadOf(c));
  };
  var subRow = function (c, s) { return roleRow(s.role, s.name, s.label, glance(c, s), s.status, '', unseenTail(s.role, s.unseen)); };

  var convItem = function (c) {
    var on = c.key === CONV;
    // 只列与我有往来的: 在群里但没和我说过话的人, 点进去也是空的。
    var talked = OPEN[c.key] ? c.subs.filter(function (s) { return s.count; }).sort(recentFirst) : [];
    var hidden = talked.length - SUB_FOLD;
    var bar = hidden > 0
      ? '<button class="si-more" data-more="' + esc(c.key) + '">' + (MORE[c.key] ? '折叠' : '展开更多') + ' × ' + hidden + '</button>'
      : '';
    // 展开条钉在第 SUB_FOLD+1 位, 展开与折叠都不挪: 其余子项展开后接在它下面。
    var sub = function (s) {
      var sel = on && s.role === WITH;
      return '<button class="si' + (sel ? ' on' : '') + '" data-conv="' + esc(c.key) + '" data-with="' + esc(s.role) + '" ' +
        'title="' + esc('我与 ' + nameOf(s.role) + ' 在这里的 ' + s.count + ' 条往来') + '">' +
        subRow(c, s) + '</button>';
    };
    var rest = MORE[c.key] ? talked.slice(SUB_FOLD).map(sub).join('') : '';
    var subs = talked.length
      ? '<div class="subs">' + talked.slice(0, SUB_FOLD).map(sub).join('') + bar + rest + '</div>'
      : '';
    var sel = on && !WITH;
    return '<button class="ci' + (sel ? ' on' : '') + '" data-conv="' + esc(c.key) + '">' +
        convRow(c) + '</button>' + subs;
  };

  // 搜索入口挂在名片与关系/日程入口之间 —— 侧栏的公共区, 会话列表与关系图下都在。⌘K 见下方「搜索」。
  var MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
  var KBD = MAC ? '⌘K' : 'Ctrl K';
  var SEARCH_SVG = '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="4.6"/><path d="m10.4 10.4 3.6 3.6"/></svg>';
  var sbox = document.createElement('button');
  sbox.className = 'sbox'; sbox.type = 'button';
  sbox.innerHTML = '<span class="ic">' + SEARCH_SVG + '</span><span class="lb">搜索 role、会话、消息</span><kbd>' + KBD + '</kbd>';
  sbox.onclick = function () { openSearch(); };
  $('#rb-acts').parentNode.insertBefore(sbox, $('#rb-acts'));
  var renderConvs = function () {
    var groups = R.convs.filter(function (c) { return c.kind === 'group'; }).sort(recentFirst);
    var dms = R.convs.filter(function (c) { return c.kind !== 'group'; }).sort(recentFirst);
    R.convs.forEach(markRead);
    if (WORLD) return renderWorld();
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
  // session 只靠两样认: 何时开始、跑了几轮。最新那段直接叫「最新」。
  var latestSess = function () { return R.sessions[R.sessions.length - 1]; };
  var sessWhen = function (s) { return s.start ? fmtClock(s.start) : '(无时刻)'; };

  // session 切换: name 右边一个小号文字触发器 + 浮层列表。
  // renderRole 每次刷新都重画, 展开态记在 SESS_OPEN 里才不会被轮询收起。
  var SESS_OPEN = false;
  var sessRow = function (s, on) {
    var last = s === latestSess();
    return '<button class="sp-it' + (on ? ' on' : '') + '" role="option" aria-selected="' + on + '" data-s="' + esc(s.sessionId || '') + '" ' +
      'title="' + esc(s.sessionId || '') + '">' +
      '<span class="id">' + (last ? '最新 · ' : '') + esc(sessWhen(s)) + '</span>' +
      '<span class="n">' + s.turns + ' 轮</span></button>';
  };
  var sessPicker = function () {
    var cur = R.sessions.filter(function (s) { return s.sessionId === SESSION; })[0];
    var all = '<button class="sp-it all' + (cur ? '' : ' on') + '" role="option" aria-selected="' + !cur + '" data-s="all">' +
      '<span class="id">全部</span><span class="n">' + R.sessions.length + ' 段</span></button>';
    var v = !cur ? '全部' : cur === latestSess() ? '最新' : sessWhen(cur);
    return '<span class="sp' + (SESS_OPEN ? ' open' : '') + '">' +
      '<button class="sp-btn" aria-haspopup="listbox" aria-expanded="' + SESS_OPEN + '" title="切换 session">' +
        esc(v) + '<span class="car" aria-hidden="true"></span></button>' +
      '<span class="sp-list" role="listbox">' + all +
        R.sessions.slice().reverse().map(function (s) { return sessRow(s, s.sessionId === SESSION); }).join('') +
      '</span></span>';
  };
  var setSessOpen = function (open) {
    SESS_OPEN = open;
    var sp = $('#rb-sp .sp');
    if (!sp) return;
    sp.classList.toggle('open', open);
    sp.querySelector('.sp-btn').setAttribute('aria-expanded', open);
  };
  var bindSessPicker = function () {
    var sp = $('#rb-sp .sp');
    if (!sp) return;
    sp.querySelector('.sp-btn').onclick = function () { setSessOpen(!SESS_OPEN); };
    sp.querySelectorAll('.sp-it').forEach(function (it) {
      it.onclick = function () { setSessOpen(false); SESSION = it.getAttribute('data-s'); refresh(); };
    });
  };
  document.addEventListener('click', function (e) {
    if (SESS_OPEN && !e.target.closest('#rb-sp .sp')) setSessOpen(false);
  });
  document.addEventListener('keydown', function (e) {
    if (SESS_OPEN && e.key === 'Escape') setSessOpen(false);
  });

  // ── 关系 / 日程入口: 名片下一行居中的文字链接, 「｜」分隔 ──
  // 副标题 (家谱计数 / 下一枪) 收进悬停提示; 打开着的染视角色, 定时出错的染红。
  var tile = function (view, label, sub, tone) {
    var on = view === 'world' ? WORLD : VIEW === view;
    return '<button class="bd' + (on ? ' on' : '') + (tone ? ' ' + tone : '') + '" data-view="' + view + '"' +
      (sub ? ' title="' + esc(sub) + '"' : '') + '>' + label + '</button>';
  };
  var relTile = function (r) {
    var sub = [r.clones.length ? r.clones.length + ' 分身' : '', r.spawns.length ? r.spawns.length + ' 子' : ''].filter(Boolean);
    return tile('world', '关系图', sub.join(' · '));
  };
  var planTile = function () {
    var p = R.plan || {};
    var sub = p.broken ? '⚠ ' + p.broken + ' 出错'
      : p.nextAt ? fmtClock(p.nextAt).replace(/^今天 /, '')
      : String(R.schedules);
    return tile('plan', '日程', sub, p.broken ? 'bad' : '');
  };

  // 轻提示: 底部居中一枚, 新的顶掉旧的。
  var toast = (function () {
    var t, el;
    return function (msg) {
      el = el || document.body.appendChild(document.createElement('div'));
      el.className = 'toast on'; el.textContent = msg;
      clearTimeout(t); t = setTimeout(function () { el.className = 'toast'; }, 1600);
    };
  })();
  // navigator.clipboard 只在安全上下文里有 —— 走 http 的远端页退回 execCommand。
  var copyText = function (text) {
    var legacy = function () {
      var ta = document.body.appendChild(document.createElement('textarea'));
      ta.value = text; ta.style.cssText = 'position:fixed;opacity:0'; ta.select();
      var ok = document.execCommand('copy'); ta.remove();
      return ok ? Promise.resolve() : Promise.reject();
    };
    (navigator.clipboard ? navigator.clipboard.writeText(text).catch(legacy) : legacy())
      .then(function () { toast('已复制 ' + text); }, function () { toast('复制失败'); });
  };

  // 截断提示: 被省略号 (或 line-clamp) 截掉的文本, 悬停时给 title 看全文 —— 一处委托管全页,
  // 不必每个渲染点各挂一份。只在真被截断时挂; 元素自带的 title (如「切到 X 的视角」) 不碰。
  var isClipped = function (el, cs) {
    return (cs.textOverflow === 'ellipsis' && el.scrollWidth > el.clientWidth + 1) ||
      (cs.webkitLineClamp !== 'none' && cs.webkitLineClamp !== '' && el.scrollHeight > el.clientHeight + 1);
  };
  var clipTip = function (el) {
    var cs = getComputedStyle(el);
    if (cs.textOverflow !== 'ellipsis' && (cs.webkitLineClamp === 'none' || !cs.webkitLineClamp)) return false;
    var ours = el.hasAttribute('data-cliptip');
    if (el.hasAttribute('title') && !ours) return true;
    if (isClipped(el, cs)) {
      el.title = el.textContent.replace(/\s+/g, ' ').trim();
      el.setAttribute('data-cliptip', '');
    } else if (ours) {
      el.removeAttribute('title'); el.removeAttribute('data-cliptip');
    }
    return true;
  };
  document.addEventListener('mouseover', function (e) {
    for (var el = e.target; el && el.nodeType === 1 && el !== document.body && !clipTip(el); el = el.parentElement);
  });

  // 名片: 头像 · 名字 (忙闲 / session) · 名字下一行低调的描述 (📁 cwd · 🏠 home · 🐣 出生) · 职责;
  // 名片下面一排是关系 / 日程入口。身份与出身 (谁的分身 / 子 wizard) 交给关系图, 名片不写。
  var renderRole = function () {
    var r = R.role;
    if (!r) return;
    // 出生 = 注册表记的 bornAt; 没记 (老 wizard / 人) 就退到最早一段 session 的开始。
    var born = r.bornAt || R.sessions.reduce(function (m, x) { return x.start && (!m || x.start < m) ? x.start : m; }, 0);
    var facts = [
      r.cwd ? ['📁', shortCwd(r.cwd), r.cwd] : null,
      r.chat ? ['🏠', r.chat, 'home'] : null,
      born ? ['🐣', fmtClock(born), '出生于 ' + fmtDay(born)] : null
    ].filter(Boolean).map(function (f) { return '<span title="' + esc(f[2]) + '">' + f[0] + ' ' + esc(f[1]) + '</span>'; });
    // 只有一段 session 也挂选择器 —— 它同时是「现在看的是哪一段」的标签, 不该随段数忽隐忽现。
    $('#rb-who').innerHTML =
      '<div class="id"><span class="av">' + esc(r.label) + '</span>' +
        '<span class="l"><span class="nl"><span class="cp" title="' + esc('复制 ' + nameOf(r.id)) + '">' + nm(r.id, r.name) + '</span>' + (r.kind === 'wizard' ? '<span id="rb-st"></span>' : '') +
          '<span id="rb-sp">' + (R.sessions.length > 1 ? sessPicker() : '') + '</span></span>' +
          (facts.length ? '<span class="facts">' + facts.join('') + '</span>' : '') + '</span></div>' +
      (r.description ? '<p class="job">' + esc(r.description) + '</p>' : '');
    paintStatus();
    $('#rb-who').querySelector('.cp').onclick = function () { copyText(nameOf(r.id)); };
    $('#rb-who').querySelectorAll('.go').forEach(function (g) {
      g.onclick = function () { switchRole(g.getAttribute('data-r')); };
    });
    // 老外壳的底栏选择框已并进 name 行。
    if ($('#rb-foot')) $('#rb-foot').hidden = true;
    bindSessPicker();
    // 入口只在有东西可看时出现 —— 挂在名片下、会话列表上, 不挤进名片: 名片的主角是身份,
    // 家谱计数 (几个分身 / 子 wizard) 属于关系, 写在关系图入口上。
    $('#rb-acts').innerHTML = [R.relations && relTile(r), R.schedules && planTile()].filter(Boolean).join('<span class="sep" aria-hidden="true">｜</span>');
    $('#rb-acts').querySelectorAll('.bd').forEach(function (b) {
      var v = b.getAttribute('data-view');
      b.onclick = function () { v === 'world' ? setWorld(!WORLD) : setView(VIEW === v ? 'msgs' : v); };
    });
    // 标题就是这一页的主张: 你此刻站在谁的位置上。换视角 → 标题与 favicon 跟着换成它的头像。
    document.title = (r.label ? r.label + ' ' : '') + nameOf(r.id) + ' 的视角';
    setFavicon(r.label);
  };

  // favicon = 头像 emoji 画成的 SVG data URI; 没有头像就不动。
  var setFavicon = function (emoji) {
    if (!emoji) return;
    var link = document.querySelector('link[rel="icon"]') || document.head.appendChild(Object.assign(document.createElement('link'), { rel: 'icon' }));
    link.type = 'image/svg+xml';
    link.href = 'data:image/svg+xml,' + encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text x="50" y="50" font-size="86" text-anchor="middle" dominant-baseline="central">' +
      esc(emoji) + '</text></svg>');
  };

  // ── 用量条: 一组轮次的总账 ──
  // usageHTML 只管「一本账长什么样」(TagSummary → 一条), 账是谁的、挂在哪由 renderUsage 定。
  // 按单价从省到贵排, 颜色随之由冷转暖: 缓存读 (约 0.1×, 通常占了大半) 退成浅灰蓝不抢眼 →
  // 输入 (1×) 沉稳蓝 → 缓存写 (1.25×) 琥珀提醒 → 输出 (约 5×, 最贵) 珊瑚红警示。注意力留给后三段。
  var SEGS = [
    ['cacheRead', '缓存读', '#aab7c8', 'cr'], ['input', '输入', '#4c6fd6', 'in'],
    ['cacheWrite', '缓存写', '#e0a030', 'cw'], ['output', '输出', '#e4572e', 'out'],
  ];
  var TIP = {
    turns: '对话轮数', tools: '工具调用次数', api: 'API 请求次数',
    ctx: '上下文峰值 — 单次请求送入的 input + 缓存 的最高值', time: '累计耗时',
  };
  var ICON = { turns: '💬', tools: '🛠️', api: '📡', ctx: '🧠', time: '⏱️' };
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
    // 指标一律 emoji 在前、数字在后, 不挂英文名 (含义在 title 里)。
    // data-tip: 被 fitUsage 藏起来时, 它在整条 bar 的 title 里怎么读。
    var kv = function (k, n, text) {
      return n ? '<span class="kv kv-' + k + '" title="' + esc(TIP[k] || k) + '" data-tip="' + esc(ICON[k] + ' ' + text) +
        '"><i class="u-ic">' + ICON[k] + '</i><b>' + esc(text) + '</b></span>' : '';
    };
    // 输出 / 缓存不再单列成指标 —— 它们就是底边色带的那几段。
    // I/O 分布: 贴着整条 bar 的底边画一条横跨整宽的细色带; 各段的量作为图例常显在 bar 里 (占比在悬停提示), 色点与色带同色。
    // 两头留一位小数: 99.9% 不该被四舍五入成 100%, 一丁点也不该成 0%。
    var pct = function (n) {
      var p = n / total * 100;
      return p < .1 ? '<0.1%' : (p < 1 || p > 99 ? p.toFixed(1) : Math.round(p)) + '%';
    };
    var io = total > 0
      ? '<span class="bar" title="' + esc(['累计 token I/O · 共 ' + fmtTok(total)].concat(segs.map(function (s) {
          return s[1] + ' ' + fmtTok(u[s[0]]) + ' · ' + pct(u[s[0]]);
        })).join('\n')) + '">' + segs.map(function (s) {
          return '<span class="seg" style="flex-grow:' + u[s[0]] + ';background:' + s[2] + '" title="' +
            s[1] + ' ' + fmtTok(u[s[0]]) + ' · ' + pct(u[s[0]]) + '"></span>';
        }).join('') + '</span>' +
        '<span class="leg" data-tip="' + esc(segs.map(function (s) { return s[3] + ' ' + fmtTok(u[s[0]]); }).join(' · ')) + '">' +
        segs.map(function (s) {
          // 常显的是缩写, 全称与占比在 title 里。
          return '<span class="lg" title="' + s[1] + ' ' + fmtTok(u[s[0]]) + ' · ' + pct(u[s[0]]) + '"><i style="background:' +
            s[2] + '"></i>' + s[3] + '<b>' + fmtTok(u[s[0]]) + '</b></span>';
        }).join('') + '</span>'
      : '';
    // 条首先是账的主人 (rolepage 里它的头像 + .名字), 再是模型名: 这本账是谁、拿什么跑出来的。
    // 没有模型记录 (老轮次) 才退回「用量」。
    return '<span class="u-who" title="' + esc(nameOf(t.target)) + '">' + esc(roleLabel(t.target) || t.label) +
        '<span class="u-nm" data-tip="' + esc(nameOf(t.target)) + '">' + esc(nameOf(t.target)) + '</span></span>' +
      '<span class="u-lb" title="' + esc(t.model || '') + '">' +
        esc(t.model ? t.model.replace(/^claude-/, '') : '用量') + '</span>' +
      '<span class="u-kvs">' +
        kv('turns', t.turns, t.turns) + kv('tools', u.tools, u.tools) + kv('api', u.calls, u.calls) +
        kv('ctx', u.ctxPeak, fmtTok(u.ctxPeak)) + kv('time', liveDur(t), fmtDur(liveDur(t))) +
      '</span>' + io;
  };
  // 永远单行: 排不下就按 FOLD 的顺序一级级藏 (分布文字 → 名字 → 耗时), 宽度回来再按反序放出来。
  // 判定看的是容器自己溢没溢出, 不看视口 —— 同一个组件挂在整页页脚和右栏底, 宽度各不相同。
  var FOLD = ['f-leg', 'f-nm', 'f-time'];
  var FOLDED = { 'f-leg': '.leg', 'f-nm': '.u-nm', 'f-time': '.kv-time' };
  var fitUsage = function (el) {
    if (el.hidden) return;
    var over = function () { return el.scrollWidth > el.clientWidth; };
    FOLD.forEach(function (c) { el.classList.remove(c); });
    var n = 0;
    while (n < FOLD.length && over()) el.classList.add(FOLD[n++]);
    // 藏起来的那几样进整条 bar 的 title, hover 照样读得到。
    el.title = FOLD.slice(0, n).map(function (c) {
      var x = el.querySelector(FOLDED[c]);
      return x ? x.getAttribute('data-tip') : '';
    }).filter(Boolean).join('\n');
  };
  var watchUsage = function (el) {
    if (el._ro || typeof ResizeObserver === 'undefined') return;
    // 只在宽度变了时重算: 自己增删 class 不改宽度, 不会自激。
    var w = -1;
    el._ro = new ResizeObserver(function (es) {
      var cw = Math.round(es[0].contentRect.width);
      if (cw !== w) { w = cw; fitUsage(el); }
    });
    el._ro.observe(el);
  };
  // 没变就不碰 DOM: 心跳每 3s 来一次, 重建会把悬停中的 tooltip 蹭掉。
  var putUsage = function (el, t) {
    var html = t ? usageHTML(t) : '';
    // !el: web/ 是热更的, 外壳 HTML 要等 daemon 重启 —— 新脚本可能先遇上没有挂载点的旧外壳。
    if (!el || el._html === html) return;
    el._html = html; el.innerHTML = html; el.hidden = !html;
    watchUsage(el); fitUsage(el);
    // 条的高度挤的是消息区 —— 原本贴底的继续贴底。
    toBottom();
  };
  // wizard: 整页页脚, 它自己跑过的全部轮次 (选了 session 就只算那一段)。
  // 窗口: 对端恰好是一个 wizard 时 (服务端按这个窗口的 talkOf 入参判定, 给不给 winStats 就是答案),
  // 窗口底下是那个 wizard 在这段往来里的账 —— 视角是人还是 wizard 都一样。
  var renderUsage = function () {
    var wiz = !!R.role && R.role.kind === 'wizard';
    putUsage($('#pg-usage'), wiz ? R.stats : null);
    putUsage($('#ch-usage'), VIEW === 'msgs' ? R.winStats : null);
  };

  // ── 右栏头: 这个群聊 / 私聊是什么 (关系 / 日程视图时是视图名) ──
  var renderHead = function () {
    var who = $('#ch-who'), acts = $('#ch-acts');
    if (VIEW !== 'msgs') {
      who.innerHTML = '<span class="t">日程</span><span class="sub">' + esc(nameOf(ROLE)) + ' 名下的定时任务与工单</span>';
      acts.innerHTML = '<button class="vb" id="ch-back">‹ 对话</button>';
      $('#ch-back').onclick = function () { setView('msgs'); };
      return;
    }
    var c = convOf(CONV);
    if (!c) { who.innerHTML = ''; acts.innerHTML = ''; return; }
    if (c.kind === 'all') {
      who.innerHTML = pairOf([[c.who]]) + '<span class="t">' + esc(c.name) + '</span>';
      acts.innerHTML = '';
      bindGo(who);
      return;
    }
    // 一对一 (私聊, 或群里「只看我与 X」) 两端都亮头像: 我在前, 对端在后, 各自是切视角的入口。
    var dm = dmOf(c);
    var peer = pairPeer(c);
    var peerLabel = c.kind !== 'group' ? c.label : dm && peer === dm.role ? dm.label : '';
    who.innerHTML = (peer ? pairOf([[ROLE, R.role && R.role.label], [peer, peerLabel]]) : '') +
      '<span class="t">' + (c.kind === 'wizard' ? nm(c.peer, c.name, true) : esc(c.name)) + '</span>';
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
  // 消息头上的角色头像 (发话方 / 收信方同一种画法), 点它切到那个角色的视角。
  var avBtn = function (id, label) {
    var sw = canSwitch(id) && id !== ROLE;
    return '<button class="av' + (sw ? ' go' : '') + '" data-r="' + esc(id) + '" title="' + esc(nameOf(id)) + '"' + (sw ? '' : ' disabled') + '>' + esc(label || roleLabel(id)) + '</button>';
  };
  // 断点 (/clear /new 轮换) 是某一个 role 的 —— 群窗里几个 wizard 交错时, 不署名就认不出是谁断的。
  // 片段由服务端渲染、不知视角, 名字 (及能否点) 在这里按视角补进断点条的标签前。
  var CUT_L = /(<div class="tg-(?:cut|mark)\b[^>]*>)(<span class="l">)/;
  var signCut = function (html, id, name) {
    return html.replace(CUT_L, function (_, open, l) { return open + nm(id, name, true) + l; });
  };
  var rowHTML = function (m) {
    learn(m.from, m.fromName, m.fromLabel);
    learn(m.to, m.toName, m.toLabel);
    if (m.dir === 'mark') {
      return '<div class="mrow mark" data-id="' + esc(m.id) + '" data-turn="' + esc(m.turnId || m.id) + '" data-ts="' + m.ts + '" data-sig="' + esc(m.sig) + '">' + signCut(m.html, m.from, m.fromName) + '</div>';
    }
    var mine = m.from === ROLE;
    var other = mine ? m.to : m.from;
    // 看 key 而不是会话列表: 换视角就地重包时, 列表还是上一个 role 的。
    var group = CONV.indexOf('p:') !== 0;
    // 说给谁: 群里我不是收信方的那条 (X → Y); 我发的那条, 收信方不是顶栏那个对端时
    // (一对一里收信方就是顶栏那个对端, 不再重复写)。
    var dst = mine
      ? (m.to && m.to !== 'human:' && m.to !== (group ? pairPeer(convOf(CONV)) : CONV.slice(2)) ? m.to : '')
      : (m.to !== ROLE && group ? m.to : '');
    // 宽屏写在气泡对面的空白里 (.dest, 在换视角的门里但不吃点击); 窄屏空白太窄, 退回消息头 (.to)。
    var to = dst ? '<span class="to">→ ' + avBtn(m.to, m.toLabel) + nm(m.to, m.toName, true) + '</span>' : '';
    // 箭头顺着「发话人 → 收件人」: 气泡是发话人, 描述在哪一侧箭头就背着气泡指向哪一侧 ——
    // 我的消息描述在左 (🦉 .x ←), 别人的在右 (→ 🦉 .x)。
    var dest = dst
      ? '<span class="dest" aria-hidden="true">' + (mine ? '' : '<i class="arr">→</i>') +
        '<span class="dav">' + esc(m.toLabel || roleLabel(dst)) + '</span><span class="dn">' + esc(nameOf(dst)) + '</span>' +
        (mine ? '<i class="arr">←</i>' : '') + '</span>'
      : '';
    var priv = !m.channel && group ? '<span class="ch priv">私聊</span>' : '';
    // 本轮的账 (呼吸点 + 模型 / token / 耗时) 跟在时刻后面 —— 片段是服务端渲染好的。
    var stat = m.meta ? '<span class="mstat">' + m.meta + '</span>' : '';
    var who = mine
      ? to + stamp(m.ts) + stat + avBtn(m.from, m.fromLabel)
      : avBtn(m.from, m.fromLabel) + nm(m.from, m.fromName, true) + to + priv + stamp(m.ts) + stat;
    var sw = canSwitch(other);
    var flip = '<button class="flip" data-r="' + esc(other) + '"' + (sw ? '' : ' disabled tabindex="-1"') +
      ' aria-label="' + esc(sw ? '切到 ' + nameOf(other) + ' 的视角' : '') + '">' +
      dest + (sw ? '<span class="fi"><span class="fn">' + esc(nameOf(other)) + '</span>' + CHEVRON + '</span>' : '') + '</button>';
    return '<div class="mrow ' + (mine ? 'mine' : 'them') + '" data-id="' + esc(m.id) + '" data-turn="' + esc(m.turnId || m.id) + '" data-ts="' + m.ts + '"' +
      (m.ping ? ' data-ping="1" data-ping-who="' + esc(m.dir === 'in' ? m.toName : m.fromName) + '"' : '') + ' data-sig="' + esc(m.sig) + '" data-stale-at="' + (m.staleAt || 0) + '">' +
      '<div class="mcol"><div class="mwho">' + who + '</div><div class="mb">' + (m.dir === 'out' ? signCut(m.html, m.from, m.fromName) : m.html) + '</div></div>' +
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
    bindGo(el, '.flip[data-r]:not([disabled]), .mwho .go[data-r], .tg-cut .go[data-r], .tg-mark .go[data-r]');
  };
  var rowNode = function (id) {
    var list = inner.querySelectorAll('.mrow');
    for (var i = 0; i < list.length; i++) if (list[i].getAttribute('data-id') === id) return list[i];
    return null;
  };

  // 载入更早的消息: 锚住此刻视口顶上的那一行, 重绘后原位不动 —— 不吸底。
  var keepView = function () {
    var top = thread.getBoundingClientRect().top;
    var ref = [].filter.call(inner.querySelectorAll('.mrow'), function (r) { return r.getBoundingClientRect().bottom > top; })[0];
    if (!ref) return null;
    var id = ref.getAttribute('data-id'), y = ref.getBoundingClientRect().top;
    return function () {
      var el = rowNode(id);
      if (!el) return false;
      S.pinned = false;
      thread.scrollTop += el.getBoundingClientRect().top - y;
      return true;
    };
  };

  var moreBtn = function (d) {
    return d.truncated ? '<button class="more-btn" id="more">载入更早的 ' + (d.older != null ? d.older : d.total - d.msgs.length) + ' 条</button>' : '';
  };
  var bindMore = function () {
    var btn = $('#more');
    if (btn) btn.onclick = function () { btn.textContent = '载入中…'; btn.disabled = true; loadOlder(); };
  };
  // 载入更早: 以此刻最早那一行为游标往前取一页, 插在最前面; 视口锚住原来顶上那一行。
  var loadOlder = function () {
    var gen = S.gen, first = inner.querySelector('.mrow');
    if (!first) return Promise.resolve();
    var cursor = { before: first.getAttribute('data-id'), beforeTs: first.getAttribute('data-ts') };
    // 失败就把按钮还原, 别让它永远停在「载入中…」; 换了窗口 (gen 变了) 按钮已随旧内容消失。
    var retry = function () {
      var b = $('#more'); if (gen === S.gen && b) { b.disabled = false; b.textContent = '载入失败, 点此重试'; }
    };
    return api('api/msgs', viewParams(cursor)).then(function (d) {
      if (gen !== S.gen) return;
      if (!d.ok) return retry();
      var keep = keepView();
      var old = $('#more'); if (old) old.remove();
      d.msgs.forEach(function (m) { S.frags[m.id] = m; });
      unfoldPings(inner);
      var page = frag(moreBtn(d) + d.msgs.map(rowHTML).join(''));
      bindRow(page); render(page);
      while (page.lastChild) inner.insertBefore(page.lastChild, inner.firstChild);
      bindMore();
      foldPings(inner);
      expireRows();
      if (keep) keep();
    }).catch(retry);
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
      inner.innerHTML = moreBtn(d) + d.msgs.map(rowHTML).join('');
      bindMore();
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
    SESSION = d.session || '';
    R.relations = !!d.relations; R.schedules = d.schedules || 0; R.plan = d.plan || null;
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
      if (WORLD || VIEW === 'plan') loadWorld();
      return loadMsgs(undefined, land && function () { paintRole(); return land(); }).then(function () {
        if (land && !inner.querySelector('.mrow')) paintRole();   // 空窗口不走 land, 页头照样要画
        connect();
      });
    });
  };

  // land: 见 loadMsgs —— 搜索跳到一条具体消息时由它来定位, 不吸底。
  var selectConv = function (key, withRole, land) {
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
    loadMsgs(undefined, land).then(connect);
  };

  // 换视角: 窗口尽量留在同一个群 —— 从群里的一条消息切过去, 最想看的是对方在这个群
  // 里的样子; 对方不在这个群 (私聊的另一头) 就交给服务端挑它最近的会话。
  // at: 被点的那条消息 —— 换视角后它留在指针底下, 其余的相对它滑动。
  var switchRole = function (id, at) {
    if (!canSwitch(id) || id === ROLE) return;
    W.treeFor = '';
    var keep = CONV && CONV.indexOf('c:') === 0 ? CONV : '';
    var from = ROLE;
    // 整个频道 / 两人私聊的消息集合与视角无关 —— 只有 with 与 session 按 role 过滤。
    var same = VIEW === 'msgs' && !WITH && !SESSION && (keep || CONV.indexOf('p:') === 0);
    // 群里「只看我与 X」时换过去, 对面看到的是「只看我与 from」—— 同一段往来, 选中只看而不是整个群。
    var withBack = keep && WITH ? from : '';
    ROLE = id; WITH = withBack; SESSION = '';
    CONV = keep || (CONV.indexOf('p:') === 0 ? 'p:' + from : '');
    // 停在关系图时换视角 = 选中新视角自己那张卡片: 先开它的全部对话 (不留旧选中 / 空白),
    // 新树画出来知道它连着谁后, renderWorld 再收窄成那张卡片的窗口 (W.pickSelf)。
    if (WORLD) { CONV = 'a:' + id; WITH = ''; same = false; W.pickSelf = id; }
    var snap = VIEW === 'msgs' && !calm() ? snapRows(at) : null;
    if (same) { if (WORLD) loadWorld(); flipWindow(snap); return; }
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
  // 家谱 (clone / spawn) 与派活 (send_peer · 工单 · 流水线) 是同一种东西: 一条「谁把谁拉进这件事」的
  // 有向关系。一对 wizard 之间的全部关系合成一条边, 沿方向长成一棵树:
  //   · 每个节点只认一个主父亲 —— 家谱父亲优先, 否则派活次数最多的那位; 其余入边记成节点上的引用
  //   · 环 (互相派活) 在建树时截断: 哪个根都走不到的环, 挑最近活跃的那个当根
  //   · 只算选中 session 时间范围内发生的 —— 边的每次发生都带着时刻 (WorldEdge.ts)
  // 每种关系一种线色 (CSS 里 li.<kind> / .ek.<kind> 同色), 画在树线、卡片入口的 label 与图例上。
  var KIND = {
    spawn: { mark: '子', tip: 'spawn 的白板 wizard, 只有出身、没有继承上下文' },
    clone: { mark: '分身', tip: 'fork 自父亲的 session, 开局带着那一刻的上下文' },
    peer: { mark: '对话', tip: 'send_peer 发起的对话' },
    job: { mark: '工单', tip: '它开的工单里有这位成员' },
    graph: { mark: '流水线', tip: '流水线里上一步喂给下一步' },
  };
  var LINEAGE = { spawn: 1, clone: 1 };

  // 老 webview 未必有 CSS.escape, 而 target 里带着 `:` 和 `#` —— 不转义选择器直接抛异常。
  var cssEsc = function (v) {
    return window.CSS && CSS.escape
      ? CSS.escape(v)
      : String(v).replace(/[^a-zA-Z0-9_-]/g, function (c) { return '\\' + c; });
  };
  var wRunning = function (n) { return n.busy || (!!n.runningUntil && srvNow() < n.runningUntil); };
  // 任一票据都能看任一 role (见 chat-http), 所以走进谁就是把视角切成谁。
  var canOpen = function (n) { return !!n; };
  var openNode = function (target) { if (target) switchRole(target); };

  // ── 时间窗: profile 里选中的 session; 全部 = 不设限 ──
  var rangeOf = function () {
    var s = R.sessions.filter(function (x) { return x.sessionId === SESSION; })[0];
    return s ? { from: s.start, to: s.end || Infinity, s: s } : null;
  };
  var inRange = function (rg, t) { return !rg || (t >= rg.from && t <= rg.to); };

  // 工单归属也是一条关系: 开单的人 → 每个成员。
  var jobEdges = function () {
    return (W.jobs || []).reduce(function (acc, j) {
      var o = nodeOf(j.owner);
      return !o ? acc : acc.concat(j.members.filter(function (mm) { return mm.target !== j.owner && nodeOf(mm.target); }).map(function (mm) {
        return { kind: 'job', from: j.owner, to: mm.target, cross: o.base !== nodeOf(mm.target).base, jobs: [j.id], ts: [j.openedAt] };
      }));
    }, []);
  };

  /** 窗内的关系: 一对有向 (a→b) 一条, kinds = 各种类在窗内发生几次。 */
  var relations = function (rg) {
    var pairs = W.edges.map(function (e) {
      return { kind: e.kind, from: e.from, to: e.to, cross: e.cross, jobs: e.jobs || [], ts: e.ts && e.ts.length ? e.ts : [e.lastTs] };
    }).concat(jobEdges()).reduce(function (m, e) {
      // 家谱是身份, 不是发生在某段 session 里的事 —— 不受时间窗裁剪, 否则切到子 wizard 时
      // 它的出生早于自己的 session, 父亲那条边就被裁掉了。
      var ts = LINEAGE[e.kind] ? e.ts : e.ts.filter(function (t) { return inRange(rg, t); });
      if (!ts.length) return m;
      var k = e.from + '\u0000' + e.to;
      var p = m[k] || (m[k] = { from: e.from, to: e.to, kinds: {}, n: 0, first: Infinity, last: 0, cross: e.cross, jobs: [] });
      p.kinds[e.kind] = (p.kinds[e.kind] || 0) + ts.length;
      if (!LINEAGE[e.kind]) p.n += ts.length;
      p.first = Math.min(p.first, Math.min.apply(null, ts));
      p.last = Math.max(p.last, Math.max.apply(null, ts));
      e.jobs.forEach(function (id) { if (p.jobs.indexOf(id) < 0) p.jobs.push(id); });
      return m;
    }, {});
    // 派活本身带着工单号时, 「工单」标记就是重复的。
    Object.keys(pairs).forEach(function (k) { if (pairs[k].kinds.peer) delete pairs[k].kinds.job; });
    return pairs;
  };

  /** 关系 → 森林: pp = 主父亲那条边, kids = 主孩子, roots = 森林的根。 */
  var forestOf = function (pairs) {
    var list = Object.keys(pairs).map(function (k) { return pairs[k]; });
    var inc = list.reduce(function (m, p) { (m[p.to] = m[p.to] || []).push(p); return m; }, {});
    var weight = function (p) { return (p.kinds.spawn ? 3e6 : p.kinds.clone ? 2e6 : 0) + p.n; };
    var pp = Object.keys(inc).reduce(function (m, t) {
      m[t] = inc[t].slice().sort(function (a, b) { return weight(b) - weight(a) || a.first - b.first; })[0];
      return m;
    }, {});
    var ends = list.reduce(function (m, p) { m[p.from] = 1; m[p.to] = 1; return m; }, {});
    var kidsIn = function () {
      return Object.keys(pp).reduce(function (m, t) { (m[pp[t].from] = m[pp[t].from] || []).push(t); return m; }, {});
    };
    var reach = function (kids, roots) {
      var seen = {};
      var walk = function (t) { if (seen[t]) return; seen[t] = 1; (kids[t] || []).forEach(walk); };
      roots.forEach(walk);
      return seen;
    };
    var roots = Object.keys(ends).filter(function (t) { return !pp[t]; });
    var recent = function (a, b) { return ((nodeOf(b) || {}).lastTs || 0) - ((nodeOf(a) || {}).lastTs || 0); };
    // 从 t 沿主父亲往上走, 直到撞回走过的点 —— 撞上的那一圈就是环。
    var loopFrom = function (t, path) {
      var at = path.indexOf(t);
      return at >= 0 ? path.slice(at) : loopFrom(pp[t].from, path.concat([t]));
    };
    // 环: 只断环上的派活边 (家谱无环, 断它会让子 wizard 丢了父亲), 挑最近活跃的那个当根 —— 直到都走得到。
    var close = function () {
      var seen = reach(kidsIn(), roots);
      var left = Object.keys(ends).filter(function (t) { return !seen[t]; });
      if (!left.length) return;
      var ring = loopFrom(left[0], []);
      var cut = ring.filter(function (t) { return !LINEAGE[domKind(pp[t])]; });
      var pick = (cut.length ? cut : ring).sort(recent)[0];
      delete pp[pick]; roots.push(pick);
      close();
    };
    close();
    // 兄弟的顺序在画的时候定 (按卡片的时刻, 同会话列表), 这里不排。
    var kids = kidsIn();
    return { pairs: pairs, inc: inc, pp: pp, kids: kids, roots: roots, ends: ends };
  };

  // F.vis: 只看相关时画哪些 (见 visibleOf); 没有 = 全画。
  var shows = function (F, t) { return !F.vis || !!F.vis[t]; };
  var countSub = function (F, t) {
    return (F.kids[t] || []).filter(function (k) { return shows(F, k); })
      .reduce(function (n, k) { return n + 1 + countSub(F, k); }, 0);
  };
  var chainUp = function (F, t, seen) {
    seen = seen || {};
    var p = F.pp[t];
    if (!p || seen[p.from]) return [t];
    seen[t] = 1;
    return chainUp(F, p.from, seen).concat([t]);
  };

  // 线接入卡片处的 label: 种类 (家谱不计次, 对话等一律写次数, ×1 也写) + 跨群; 经手的工单号放进悬停提示。
  var labelHTML = function (p) {
    if (!p) return '';
    return '<span class="tlab"' + (p.jobs.length ? ' title="经手的工单: ' + esc(p.jobs.join(' ')) + '"' : '') + '>' +
      Object.keys(KIND).filter(function (k) { return p.kinds[k]; }).map(function (k) {
        return '<span class="ek ' + k + '" title="' + KIND[k].tip + '">' + KIND[k].mark +
          (!LINEAGE[k] ? ' ×' + p.kinds[k] : '') + '</span>';
      }).join('') +
      (p.cross ? '<span class="ek cross" title="跨群的关系">⇄ 跨群</span>' : '') + '</span>';
  };
  // 一条边的主色: 家谱优先, 决定树上那道线的颜色。
  var domKind = function (p) {
    return !p ? 'root' : ['spawn', 'clone', 'peer', 'job', 'graph'].filter(function (k) { return p.kinds[k]; })[0] || 'peer';
  };

  // ── 卡片承载指进来的那条边 (主父亲 → 它): 预览取视角与对端在侧栏里现成的那一项 ──
  var edgeEnds = function (F, t) { var p = F.pp[t]; return p ? [p.from, t] : [t]; };
  // 视角 role 与 other 之间的那一项: 私聊优先, 否则挑最近说过话的那个群里的「只看我与它」。
  var pairConv = function (other) {
    if (convOf('p:' + other)) return ['p:' + other, ''];
    var hit = R.convs.filter(function (c) { return c.kind === 'group'; }).map(function (c) {
      return [c, (c.subs || []).filter(function (x) { return x.role === other && x.count; })[0]];
    }).filter(function (x) { return x[1]; }).sort(function (a, b) { return b[1].lastTs - a[1].lastTs; })[0];
    return hit ? [hit[0].key, dmOf(hit[0]) ? '' : other] : null;
  };
  // 视角这一端与边另一端之间、侧栏里现成的那一项 (视角不在边上 / 这段里没说过话 = 没有)。
  var edgeConv = function (F, t) {
    var ends = edgeEnds(F, t);
    var other = ends.length === 2 && ends.indexOf(ROLE) >= 0 && ends.filter(function (x) { return x !== ROLE; })[0];
    return other ? pairConv(other) : null;
  };
  // 点任何一张卡片 (视角自己也一样) 看的窗口: 它与图上和它相连的那几个 role 之间的对话, 不换视角。
  // links = 这一次画出来的树里, 它的父亲与孩子 (见 linksOf); 一个都没连着 = 它的全部对话。
  var talkKey = function (links, t) {
    var ls = links[t] || [];
    return 'a:' + t + (ls.length ? '|' + ls.join(',') : '');
  };
  // 图上相连 = 画出来的主父亲边: 它的父亲 + 它的孩子, 两端都画出来了才算。
  var linksOf = function (F, shown) {
    var on = shown.reduce(function (m, n) { m[n.target] = 1; return m; }, {});
    return shown.reduce(function (m, n) {
      var t = n.target, p = F.pp[t];
      m[t] = (p && on[p.from] ? [p.from] : []).concat((F.kids[t] || []).filter(function (k) { return on[k]; }));
      return m;
    }, {});
  };

  // 卡片与侧栏会话项同一套 (glance / roleRow / recentFirst)。
  // 视角与对端有会话项 → 一行的数据就是那一项的 glance; 没有 → 取节点, 时刻取这条边最近一次发生,
  // 而不是节点自己最后的动静 —— 卡片承载的是边。
  // 身份 (头像 / 名字 / 状态灯) 永远是卡片自己的节点: 会话项的身份是「视角的对端」, 视角自己那张卡片
  // (边的下端是视角) 的对端是它的父亲 —— 拿会话项的身份去画, 这张卡片就成了父亲的分身。
  // 时刻与最近一句取自卡片自己的窗口 (点它打开的那一份, 服务端 /api/glance 用同一个 talkOf 算, 说话人前缀
  // 也在那里定); 窗口还没取到 (或第一遍量树时) 退回视角与对端的会话项 / 节点。未读跟着视角与对端的会话项走。
  var cardGlance = function (F, t) {
    var hit = edgeConv(F, t), c = hit && convOf(hit[0]);
    var s = c && hit[1] && (c.subs || []).filter(function (x) { return x.role === hit[1]; })[0];
    var n = nodeOf(t) || {}, p = F.pp[t];
    var base = c ? glance(c, s || undefined) : { lastTs: p ? p.last : n.lastTs || 0, preview: n.preview || '', unread: 0 };
    var w = F.links && W.glance[talkKey(F.links, t)];
    return w ? { lastTs: w.lastTs, preview: w.preview, unread: base.unread } : base;
  };
  // 卡片窗口的 glance: 树里画了谁变了就取一次, 世界快照每次轮询也顺带刷新。
  var loadGlance = function () {
    var keys = W.gKeys, role = ROLE;
    if (!keys) return;
    api('api/glance', { role: role, keys: keys }).then(function (d) {
      if (!d.ok || role !== ROLE || keys !== W.gKeys) return;
      W.glance = d.glances || {};
      renderWorld();
    }).catch(function () { });
  };
  var byCard = function (F) {
    return function (a, b) { return recentFirst(cardGlance(F, a), cardGlance(F, b)); };
  };
  var tnodeHTML = function (F, n, folded) {
    var me = n.target === ROLE;
    var tail = folded ? '<span class="tfold" title="它下面还有 ' + folded + ' 个, 切到它的视角可见">+' + folded + '</span>' : '';
    var p = F.pp[n.target];
    var row = roleRow(n.target, n.name, n.label, cardGlance(F, n.target), n, tail);
    var via = F.vis && F.vis[n.target] === 'via';
    return '<button class="ci tci' + (me ? ' me' : '') + (via ? ' via' : '') + (F.links && CONV === talkKey(F.links, n.target) ? ' on' : '') + '" data-t="' + esc(n.target) + '"' +
      (via ? ' title="' + esc(nameOf(n.target) + ' 没和 ' + nameOf(ROLE) + ' 对过话, 留着是为了连到它下面对过话的') + '"' : '') + '>' +
      labelHTML(p) + row + '</button>';
  };

  // keep(父, 孩子) → 'full' 整枝 / 'leaf' 只画它自己 / '' 不画; 不给 keep = 全画。shown 收集画出来的节点。
  var treeHTML = function (F, t, depth, keep, leaf, shown, seen, z) {
    var n = nodeOf(t);
    if (!n || seen[t] || depth > 32) return '';
    seen[t] = 1;
    shown.push(n);
    var kids = leaf ? [] : (F.kids[t] || []).filter(function (k) { return shows(F, k) && (!keep || keep(t, k)); }).sort(byCard(F));
    return '<li class="' + domKind(F.pp[t]) + '"' + (z ? ' style="z-index:' + z + '"' : '') + '>' + tnodeHTML(F, n, leaf ? countSub(F, t) : 0) +
      // 兄弟的线共用一段竖干, 越往下的越长: 短的叠在上面 (z 随序号递减), 每条线的末段都看得见自己的颜色。
      (kids.length ? '<ul>' + kids.map(function (k, i) {
        return treeHTML(F, k, depth + 1, keep, keep && keep(t, k) === 'leaf', shown, seen, kids.length - i);
      }).join('') + '</ul>' : '') +
      '</li>';
  };
  // 只看相关: 主父亲链一条直线下来, 到它自己再整枝展开; 同一个主父亲下的兄弟只画本人。
  var focusKeep = function (path) {
    var on = path.reduce(function (m, t) { m[t] = 1; return m; }, {});
    var parent = path[path.length - 2];
    return function (t, k) {
      if (!on[t] || t === ROLE) return 'full';
      return on[k] ? 'full' : t === parent ? 'leaf' : '';
    };
  };

  // 关系图替换的是侧栏的会话列表 —— 右边照旧是选中的那段对话。
  // 只看相关时画谁: 视角自己 + 和视角对过话的 ('talk'); 它们通向根的主父亲链上没对过话的祖先
  // 留作连接 ('via', 画淡) —— 抹掉它, 有对话的后代就从家谱上脱开, 成了一棵来历不明的孤树。
  var talks = function (F, a, b) {
    var p = F.pairs[a + '\u0000' + b];
    return !!p && !!(p.kinds.peer || p.kinds.graph);
  };
  var visibleOf = function (F) {
    var keep = Object.keys(F.ends).filter(function (t) { return t === ROLE || talks(F, ROLE, t) || talks(F, t, ROLE); });
    var vis = keep.reduce(function (m, t) { m[t] = 'talk'; return m; }, {});
    if (!vis[ROLE]) vis[ROLE] = 'talk';
    keep.forEach(function (t) { chainUp(F, t).forEach(function (u) { if (!vis[u]) vis[u] = 'via'; }); });
    return vis;
  };

  var renderWorld = function () {
    if (!WORLD) return;
    if (!W.loaded) { convsEl._tree = ''; convsEl.innerHTML = '<div class="empty">加载中…</div>'; return; }
    var rg = rangeOf();
    var F = forestOf(relations(rg));
    var me = nodeOf(ROLE);
    var all = W.treeAll || !me;
    var shown = [];
    var path = me ? chainUp(F, ROLE) : [];
    // 和视角之间没有对话的关系只在「看全部」里画。
    F.vis = all ? null : visibleOf(F);
    var draw = function (into) {
      return all
        ? F.roots.slice().sort(function (a, b) {
            var mine = path[0];
            return (b === mine) - (a === mine) || byCard(F)(a, b);
          }).map(function (r) { return treeHTML(F, r, 0, null, false, into, {}); }).join('')
        : treeHTML(F, path[0], 0, focusKeep(path), false, into, {});
    };
    // 两遍: 先量出画了谁 (卡片的窗口要知道它在图上连着谁), 再带着连线画 —— 选中态也就进了 html。
    draw(shown);
    F.links = linksOf(F, shown);
    var keys = shown.map(function (n) { return talkKey(F.links, n.target); }).join('\n');
    if (keys !== W.gKeys) { W.gKeys = keys; loadGlance(); }
    // 换视角后的第一张新树: 世界快照与摘要都已是新视角的, 才知道它自己那张卡片连着谁。
    if (W.pickSelf === ROLE && W.role === ROLE && R.role && R.role.id === ROLE) {
      W.pickSelf = '';
      var self = talkKey(F.links, ROLE);
      if (CONV !== self) return selectConv(self, '');
    }
    var trees = draw([]);
    var span = rg ? (rg.s === R.sessions[R.sessions.length - 1] ? '最新 session' : 'session ' + fmtClock(rg.from)) : '全部时间';
    var alone = !all && shown.length < 2;
    var html = '<div class="tview">' +
      '<h2>关系图<span title="在名片里的 session 下拉切换范围">' + esc(span) + ' · ' + (all ? Object.keys(F.ends).length : shown.length) + ' 个</span>' +
        (W.degraded ? '<span class="warn" title="没拿到 wizard 注册表 (svr 还没收到 daemon 的快照), 只画观测到的往来">名册缺席</span>' : '') +
        (me ? '<button class="tall" title="' + (all ? '只留它的上游链、它自己、它的下游与同源兄弟' : '画出范围内所有有关系的 wizard') + '">' +
          (all ? '只看相关' : '看全部') + '</button>' : '') + '</h2>' +
      (alone ? '<div class="tsolo">' + esc(nameOf(ROLE)) + (rg ? ' 在这段 session 里' : '') + ' 没和谁对过话</div>' : '') +
      (shown.length ? '<ul class="tree' + (all ? ' all' : '') + '">' + trees + '</ul>' : '<div class="pempty">这段时间里没有任何关系</div>') +
    '</div>';
    // 心跳每 3s 重算一次 (状态灯 / 几分钟前) —— 没变就不碰 DOM, 免得蹭掉悬停与滚动。
    if (convsEl._tree === html && convsEl.querySelector('.tview')) return;
    convsEl._tree = html; convsEl._html = '';
    convsEl.innerHTML = html;
    convsEl.querySelectorAll('.tci').forEach(function (el) {
      el.onclick = function () { selectConv(talkKey(F.links, el.getAttribute('data-t')), ''); };
    });
    bindGo(convsEl);
    var tall = convsEl.querySelector('.tall');
    if (tall) tall.onclick = function () { W.treeAll = !W.treeAll; W.treeFor = ''; renderWorld(); };
    var cur = convsEl.querySelector('.tci.me');
    if (cur && W.treeFor !== ROLE) { W.treeFor = ROLE; cur.scrollIntoView({ block: 'nearest' }); }
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
        'title="' + esc(fmtClock(x.nextAt) + ' · ' + (x.note || x.id) + ' · ' + x.when) + '"><span>' + esc(fmtHM(x.nextAt)) + '</span></button>';
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
  var taskHTML = function (x) {
    var lines = String(x.prompt || '').split('\n');
    var head = x.note || lines[0];
    var errs = [
      x.loadError ? '<div class="perr"><b>任务文件加载失败</b> · 仍在跑上一版<code>' + esc(x.loadError.split('\n')[0].slice(0, 240)) + '</code></div>' : '',
      x.lastGate === 'error' ? '<div class="perr"><b>gate 出错</b>' + (x.lastGateAt ? ' · ' + esc(fmtAgo(x.lastGateAt)) : '') +
        ' · 本轮未放枪, 下次照常重试' + (x.lastError ? '<code>' + esc(x.lastError.split('\n')[0].slice(0, 240)) + '</code>' : '') + '</div>' : '',
    ].join('');
    return '<article class="tcard' + (broken(x) ? ' bad' : '') + '" data-id="' + esc(x.id) + '">' +
      '<div class="tc-time"><b>' + esc(fmtHM(x.nextAt)) + '</b><span>' + esc(fmtClock(x.nextAt).replace(/ \d\d:\d\d$/, '')) + '</span>' +
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

  // 日程跟着 wizard 走: 只列归当前 role 的定时任务, 与它有关的工单 (它开的 / 它在里面)。
  var renderPlan = function () {
    var ss = (W.schedules || []).filter(function (x) { return (x.owner || x.createdBy || x.target) === ROLE; });
    var js = (W.jobs || []).filter(function (j) {
      return j.owner === ROLE || j.members.some(function (mm) { return mm.target === ROLE; });
    });
    var open = js.filter(function (j) { return j.status === 'open'; });
    var closed = js.filter(function (j) { return j.status !== 'open'; });
    var bad = ss.filter(broken);
    var next = ss[0];
    var stat = function (k, v, sub, tone) {
      return '<div class="pst' + (tone ? ' ' + tone : '') + '"><span class="k">' + k + '</span><b>' + v + '</b><span class="s">' + sub + '</span></div>';
    };
    var stats = '<div class="pstats">' +
      stat('下一次', next ? esc(fmtHM(next.nextAt)) : '—', next ? esc(fmtIn(next.nextAt) + ' · ' + (next.note || next.id)) : '没有排期') +
      stat('定时任务', ss.length, ss.length ? esc(ss.filter(function (x) { return x.hasGate; }).length + ' 条带 gate') : '—') +
      stat('工单', open.length + '<small> / ' + js.length + '</small>', '进行中 / 全部') +
      (bad.length ? stat('出错', bad.length, '见下方红色卡片', 'bad') : '') +
    '</div>';

    var jobRow = function (j) {
      return '<div class="jrow' + (j.status === 'open' ? ' open' : '') + '">' +
        '<div class="jh"><span class="jst">' + (j.status === 'open' ? '进行中' : '已收工') + '</span>' +
          '<span class="jt">' + esc(j.title) + '</span>' +
          '<span class="jid">' + esc(j.id) + '</span>' +
          '<span class="jts">' + esc(fmtAgo(j.closedAt || j.openedAt)) + '</span></div>' +
        '<div class="jm">' + (j.members.length
          ? j.members.map(function (mm) {
              var n = nodeOf(mm.target);
              return '<span class="jmm">' + wizChip(mm.target) + stTag(n) +
                (mm.spawned ? '<i class="tmp" title="为这个工单临时生的 wizard (分身或子 wizard), 收工时回收">临时</i>' : '') +
                '<em>' + esc((mm.task || '').split('\n')[0].slice(0, 90)) + '</em></span>';
            }).join('')
          : '<span class="jmm none">还没有成员</span>') + '</div>' +
        (j.summary ? '<div class="jsum">' + esc(j.summary.slice(0, 300)) + '</div>' : '') +
      '</div>';
    };

    var html = stats +
      '<section class="psec">' +
        '<h3>定时任务<span>' + ss.length + '</span></h3>' +
        (ss.length ? renderStrip(ss) + bad.concat(ss.filter(function (x) { return !broken(x); })).map(taskHTML).join('')
          : '<div class="pempty">' + esc(roleName(ROLE)) + ' 名下没有定时任务 —— 让它 schedule_task 排一个</div>') +
      '</section>' +
      '<section class="psec">' +
        '<h3>工单<span>' + open.length + ' 开 / ' + closed.length + ' 收</span></h3>' +
        (js.length ? open.concat(closed).map(jobRow).join('') : '<div class="pempty">没有工单 —— 一次派出两个以上 wizard 时 open_job 开一个</div>') +
      '</section>';
    // 心跳每 3s 重画一次 —— 没变就不碰 DOM (展开着的 prompt、悬停的提示都留着)。
    if (planEl._html === html) return;
    planEl._html = html;
    planEl.innerHTML = html;
    planEl.querySelectorAll('.wchip.go').forEach(function (c) {
      c.onclick = function () { openNode(c.getAttribute('data-t')); };
    });
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

  // ══ 视图切换 ═══════════════════════════════════════════════════════
  // 世界快照不走 SSE: 它变动的源头 (spawn / 改职责 / 开收工单 / 排定时) 一条都
  // 不经过 detail store。改成"看得见才轮询": 不在关系/日程栏、或者页面在后台, 就一次都不请求。
  var WORLD_MS = 6000;
  var worldTimer = null;
  // 带上次的 ETag 问: 304 = 名册没变, 不重画 (卡片窗口的 glance 照样顺带刷新)。
  var loadWorld = function () {
    var asked = ROLE;
    var p = new URLSearchParams({ role: asked, id: TOKEN });
    var tag = W.role === asked ? W.etag : '';
    var etag = '';
    return fetch('api/world?' + p.toString(), { cache: 'no-store', headers: tag ? { 'If-None-Match': tag } : {} }).then(function (r) {
      if (r.status === 304) { if (asked === ROLE) loadGlance(); return null; }
      etag = r.headers.get('etag') || '';
      return r.json();
    }).then(function (d) {
      // 迟到的回包 (这期间已换了视角) 丢掉, 免得盖掉新视角的图; etag 与 role 成对记。
      if (!d || !d.ok || asked !== ROLE) return;
      W.at = d.at; W.loaded = true; W.role = asked; W.etag = etag;
      W.nodes = d.nodes || []; W.edges = d.edges || []; W.chats = d.chats || [];
      W.jobs = d.jobs || []; W.schedules = d.schedules || []; W.degraded = !!d.degraded;
      renderWorld();
      loadGlance();
      if (VIEW === 'plan') renderPlan();
    }).catch(function () { });
  };
  var pollWorld = function () {
    if (worldTimer) { clearInterval(worldTimer); worldTimer = null; }
    if (VIEW === 'msgs' && !WORLD) return;
    worldTimer = setInterval(function () {
      if (!document.hidden) loadWorld();
    }, WORLD_MS);
  };

  var setView = function (v) {
    VIEW = v;
    thread.hidden = v !== 'msgs';
    $('#pane-plan').hidden = v !== 'plan';
    app.classList.toggle('outer', v !== 'msgs');
    // 手机上关系/日程占满主区 —— 进入即阅读态。
    if (v !== 'msgs') app.classList.add('reading');
    renderRole(); renderHead(); renderUsage();
    if (v === 'msgs') { toBottom(true); renderConvs(); }
    else {
      if (!W.loaded) { planEl._html = ''; planEl.innerHTML = '<div class="empty">加载中…</div>'; }
      else renderPlan();
      loadWorld();
    }
    pollWorld();
  };
  // 侧栏换成关系图 / 换回会话列表。换回时选中的仍是在关系图里点开的那一项, 并把它滚进视野。
  var setWorld = function (on) {
    WORLD = on; W.treeFor = ''; W.pickSelf = '';
    convsEl._html = convsEl._tree = '';
    syncUrl();
    // 手机上侧栏与主区二选一 —— 开关在侧栏里, 结果也在侧栏里。
    if (on) app.classList.remove('reading');
    renderRole();
    if (on) { renderWorld(); loadWorld(); }
    else {
      // 选中的子项得露出来: 群展开, 排在折叠条后面的连折叠条一起展开。
      var c = convOf(CONV);
      if (c) {
        OPEN[CONV] = true; OPEN_AT = CONV;
        var rank = c.subs.filter(function (x) { return x.count; }).map(function (x) { return x.role; }).indexOf(WITH);
        if (rank >= SUB_FOLD) MORE[CONV] = true;
      }
      renderConvs();
      var sel = convsEl.querySelector('.si.on') || convsEl.querySelector('.ci.on');
      if (sel) sel.scrollIntoView({ block: 'nearest' });
    }
    pollWorld();
  };
  // 本地心跳: 相对时间、运行中判定、耗时都随时间变化, 但服务端没有新事件可推。
  setInterval(function () {
    if (!R.role) return;
    renderUsage();
    expireRows();
    // 侧栏的「几分钟前」与状态灯: 内容没变时 renderConvs 不碰 DOM。
    paintStatus(); renderConvs();
    if (VIEW === 'plan') renderPlan();
  }, TICK_MS);

  // ══ 搜索 (⌘K / Ctrl+K) ═══════════════════════════════════════════════
  // 从当前视角搜三样: role 名字 (→ 切视角)、会话名 (→ 打开)、消息正文 (→ 打开会话并定位到那一句)。
  // 服务端搜全部时间; 那一句不在当前 session 段里就放宽成「全部」再跳。空查询时列出最近的会话,
  // 面板本身就是一个键盘快速切换器。面板由脚本挂载 —— 外壳 HTML 要等 daemon 重启才换。
  var Q = { open: false, q: '', done: null, enter: false, items: [], sel: 0, gen: 0, timer: 0 };
  var sk = document.body.appendChild(document.createElement('div'));
  sk.className = 'sk'; sk.hidden = true;
  sk.innerHTML = '<div class="sk-panel" role="dialog" aria-label="搜索">' +
      '<div class="sk-in"><span class="ic">' + SEARCH_SVG + '</span>' +
        '<input id="sk-q" type="search" autocomplete="off" spellcheck="false" placeholder="搜索 role、会话、消息…" aria-controls="sk-list">' +
        '<kbd>esc</kbd></div>' +
      '<div class="sk-list" id="sk-list" role="listbox"></div>' +
      '<div class="sk-foot"><span><kbd>↑</kbd><kbd>↓</kbd> 选择</span><span><kbd>↵</kbd> 打开</span><span><kbd>esc</kbd> 关闭</span></div>' +
    '</div>';
  var skQ = sk.querySelector('#sk-q'), skList = sk.querySelector('#sk-list');

  var reEsc = function (s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); };
  // 先切再转义: 命中段包 <mark>, 其余照常 esc。
  var hl = function (text, q) {
    var ts = q.toLowerCase().split(/\s+/).filter(Boolean);
    if (!ts.length) return esc(text);
    var re = new RegExp('(' + ts.map(reEsc).join('|') + ')', 'ig');
    return String(text).split(re).map(function (p, i) { return i % 2 ? '<mark>' + esc(p) + '</mark>' : esc(p); }).join('');
  };

  // 一项 = { kind, html, go }: 画什么、回车做什么。
  var roleItem = function (r, q) {
    return {
      kind: 'role',
      html: '<span class="av">' + esc(r.label) + '</span><span class="b"><span class="l1">' +
        '<span class="nm ' + (r.wizard ? 'wizard' : 'human') + '">' + hl(r.name, q) + '</span><span class="k">切到视角</span></span>' +
        (r.description ? '<span class="pv">' + hl(r.description, q) + '</span>' : '') + '</span>',
      go: function () { switchRole(r.id); },
    };
  };
  // 时刻: 列表里写相对的, 悬停给完整的。
  var skTs = function (ts) { return '<time class="ts" title="' + esc(fmtFull(ts)) + '">' + esc(fmtAgo(ts)) + '</time>'; };
  // 会话归属: 群聊带群名, 私聊写明是私聊 —— 结果项第三层, 比发话人与正文都淡。
  var whereOf = function (kind, label, name, q) {
    return '<span class="where' + (kind === 'wizard' ? ' priv' : '') + '"><i>' + esc(label || '💬') + '</i>' +
      (kind === 'wizard' ? '私聊 · ' : '') + hl(name, q || '') + '</span>';
  };
  var convItem_ = function (c, q) {
    var title = c.kind === 'wizard' ? '<span class="nm wizard">' + hl(c.name, q) + '</span>' : '<span class="nm chat">' + hl(c.name, q) + '</span>';
    return {
      kind: 'conv',
      html: '<span class="av">' + esc(c.label) + '</span><span class="b"><span class="l1">' + title +
        '<span class="tag">' + (c.kind === 'wizard' ? '私聊' : '群聊') + '</span>' + skTs(c.lastTs) + '</span>' +
        (c.preview ? '<span class="pv">' + esc(c.preview) + '</span>' : '') + '</span>',
      go: function () { selectConv(c.key, ''); },
    };
  };
  // 三层: 谁 → 对谁 · 何时 / 命中的那一截 / 在哪个会话。
  var msgItem = function (h, q) {
    var to = h.to && h.to !== h.from && h.to !== 'human:'
      ? '<span class="arr">→</span>' + nm(h.to, h.toName) : '';
    return {
      kind: 'msg',
      html: '<span class="av">' + esc(h.fromLabel) + '</span><span class="b"><span class="l1">' +
        nm(h.from, h.fromName) + to + skTs(h.ts) + '</span>' +
        '<span class="sn">' + hl(h.snippet, q) + '</span>' +
        '<span class="l3">' + whereOf(h.convKind, h.convLabel, h.convName) +
          (h.hits > 1 ? '<span class="cnt">' + h.hits + ' 处命中</span>' : '') + '</span></span>',
      go: function () { jumpMsg(h); },
    };
  };

  // 一句消息落在当前 session 段里没有 —— 不在就得放宽成全部才看得见。
  var inSession = function (ts) {
    var s = R.sessions.filter(function (x) { return x.sessionId === SESSION; })[0];
    return !s || (ts >= s.start && (!s.end || ts < s.end));
  };
  // 定位一行: 滚到视口中间, 闪一下。窗口只上屏最近一截, 不在就整窗重取一次再找。
  var focusRow = function (id) {
    var row = rowNode(id);
    if (!row) return false;
    row.scrollIntoView({ block: 'center' });
    S.pinned = atBottom();
    row.classList.remove('hit'); void row.offsetWidth; row.classList.add('hit');
    return true;
  };
  var landOn = function (id) {
    return function () {
      if (focusRow(id)) return true;
      loadMsgs('0', function () { return focusRow(id); });
      return true;
    };
  };
  var jumpMsg = function (h) {
    if (inSession(h.ts) && convOf(h.conv)) return selectConv(h.conv, '', landOn(h.id));
    SESSION = 'all'; CONV = h.conv; WITH = '';
    if (VIEW !== 'msgs') setView('msgs');
    app.classList.add('reading');
    reveal();
    refresh(landOn(h.id));
  };

  var paintSearch = function (sections) {
    Q.items = sections.reduce(function (a, s) { return a.concat(s.items); }, []);
    Q.sel = Math.min(Q.sel, Math.max(0, Q.items.length - 1));
    var n = 0;
    skList.innerHTML = sections.filter(function (s) { return s.items.length || s.empty; }).map(function (s) {
      return '<h3>' + esc(s.title) + (s.count ? '<span>' + s.count + '</span>' : '') + '</h3>' +
        (s.items.length
          ? s.items.map(function (it) {
              var i = n++;
              return '<button class="sk-it ' + it.kind + (i === Q.sel ? ' on' : '') + '" role="option" data-i="' + i + '" aria-selected="' + (i === Q.sel) + '">' + it.html + '</button>';
            }).join('')
          : '<div class="sk-empty">' + esc(s.empty) + '</div>');
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
    paintSearch([{ title: '最近的会话', items: R.convs.slice(0, 8).map(function (c) { return convItem_(c, ''); }), empty: '还没有会话' }]);
  };
  var runSearch = function () {
    var q = skQ.value.trim(), gen = ++Q.gen;
    Q.q = q; Q.sel = 0; Q.done = null;
    if (!q) return recent();
    api('api/search', { role: ROLE, q: q }).then(function (d) {
      if (!d.ok || gen !== Q.gen) return;
      var sections = [
        { title: 'Role', items: d.roles.map(function (r) { return roleItem(r, q); }) },
        { title: '会话', items: d.convs.map(function (c) { return convItem_(c, q); }) },
        { title: '消息', count: d.msgTotal > d.msgs.length ? d.msgs.length + ' / ' + d.msgTotal : d.msgs.length,
          items: d.msgs.map(function (h) { return msgItem(h, q); }) },
      ];
      if (!d.roles.length && !d.convs.length && !d.msgs.length) sections = [{ title: '结果', items: [], empty: '没有找到「' + q + '」' }];
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
      Q.open ? closeSearch() : openSearch();
    } else if (Q.open && e.key === 'Escape') { e.preventDefault(); closeSearch(); }
  });

  // ── boot ──
  // 带着 role / conv 来的链接直接进阅读态 (手机上不先落在会话列表)。
  if ((ROLE || CONV) && !WORLD) app.classList.add('reading');
  refresh();
})();
