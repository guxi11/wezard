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
  // 页面上两个独立的视角: ROLE 是页面视角 (名片、侧栏、标题、关系图中心), 只有点头像 / 名字及其装饰 (⇄ 等) 换它;
  // VIEWPOINT 是 chat detail 的视角 (谁算「自己」靠右、描述行以谁为准), 点卡片 / 会话项的其余地方与详情区里的行设它 ——
  // 关系图卡片 = 被点的那个 role, .far 子项 = 那个 role, 移交行 = 移交人 (派活那一方),
  // 新生 / 被收的提示行 = 那个 wizard; 会话与成对的子项 = 页面视角自己。'' = 与页面视角相同。老链接的 `eye=` 照读。
  var VIEWPOINT = qs.get('viewpoint') || qs.get('eye') || '';
  var viewpointOf = function () { return VIEWPOINT || ROLE; };
  var TICK_MS = 3000;

  // at / recvAt: 服务端快照时刻与本地收到时刻。所有"现在几点"的判断都换算到
  // 服务端时钟, 否则客户端时钟偏几分钟就会把运行中的会话判成已结束。
  var R = { at: 0, recvAt: 0, role: null, sessions: [], convs: [], relations: false, schedules: 0, plan: null, charter: null, stats: null, winStats: null };
  // frags: 当前窗口的原始片段 (id → 片段)。片段不带方向, 换视角时拿它就地重包左右。
  var S = { es: null, pinned: true, gen: 0, frags: {} };
  // 关系/日程两栏共用的世界快照。treeFor = 已把谁滚进过视野。
  var W = {
    at: 0, nodes: [], edges: [], chats: [], jobs: [], schedules: [],
    degraded: false, loaded: false, treeFor: '', glance: {}, gKeys: '',
  };
  var VIEW = 'msgs';
  // 侧栏是会话列表还是关系图 —— 与右边的 VIEW 无关: 关系图下右边照样是选中的那段对话。
  // URL 带了 side 以它为准; 没带 (新链接) 用本地记下的, 见 WORLD_KEY。
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
  // 与服务端 detail-render 的 fmtDuration 同一写法: 走表的那一轮收口后换成服务端写死的值, 不该跳格式。
  var fmtDur = function (ms) {
    if (ms < 1000) return ms + 'ms';
    var s = Math.round(ms / 100) / 10;
    if (s < 60) return s + 's';
    var m = Math.floor(s / 60);
    return m + 'm' + Math.round(s - m * 60) + 's';
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
    if (VIEWPOINT) p.viewpoint = VIEWPOINT;
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
  // 一个 role 的名字与头像, 两路来: 摘要 (名册, 每拍刷新, 为准) 与消息片段 (渲染那一刻的名册, 只在摘要没给时兜底)。
  // svr 刚重启、还没收到 daemon 推来的名册那几秒, 两路回的「名字」都只是 id 本身 (头像也是按 id 算的) ——
  // id 不是名字, 不记; 否则它会钉在已上屏的行里, 名册到了也不改。返回: 这一次记的有没有变。
  var names = {}, fromDir = {};
  var learn = function (id, name, label, dir) {
    if (!id || !name || name === id || (!dir && fromDir[id])) return false;
    if (dir) fromDir[id] = 1;
    var k = names[id];
    if (k && k.name === name && k.label === (label || '')) return false;
    names[id] = { name: name, label: label || '' };
    return true;
  };
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
  var mdReady = function () {
    if (!window.markdownit) return false;
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
    return true;
  };
  var render = function (scope) {
    if (!mdReady()) return;
    // 工单页的开工 / 收工两行不是气泡, 计划与结论同样是 markdown。
    scope.querySelectorAll('.bubble, .tg-job').forEach(function (b) {
      var src = b.querySelector('script.md-src'), body = b.querySelector('.md-body');
      if (src && body && body.dataset.rendered !== '1') {
        // 「发给谁」先挂在空 .md-body 里; 填进 markdown 后把它塞进第一段, 才能和正文第一行同行。
        var to = body.querySelector(':scope > .to-in');
        body.innerHTML = md.render(src.textContent || '');
        if (to) { var p = body.firstElementChild; (p && p.tagName === 'P' ? p : body).prepend(to, ' '); }
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
      b.querySelectorAll('details').forEach(function (d, i) { m[openKey(k, d, i)] = d.open; });
    });
    return m;
  };
  // 展开态按位置记; 移交行单独记一格 —— 它是后来才挂上去的 (公开移交从气泡变成可开合),
  // 跟着位置走会把旁边那个框的开合套到它身上, 默认展开的公开移交被收起、箭头朝右。
  var openKey = function (k, d, i) { return k + '#' + (d.classList.contains('handoff') ? 'ho' : i); };
  var restoreOpen = function (scope, m) {
    scope.querySelectorAll('[data-key]').forEach(function (b) {
      var k = b.getAttribute('data-key');
      b.querySelectorAll('details').forEach(function (d, i) {
        var v = m[openKey(k, d, i)]; if (v !== undefined) d.open = v;
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
        // 下面有了新东西 / 这一轮结束: 过程框收起一次。标记留在节点上, 用户之后再点开不会被下一帧收回去。
        if (nc.hasAttribute('data-fold')) settle(ex);
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
  // 人手点过的过程框: data-key → 是否收起。只由点击写入, 每次换节点 (增量、翻页、换视角
  // 整窗重拉) 之后按它回填 —— 默认态归服务端, 人的选择压过默认态。
  var FOLD = {};
  var settle = function (s) {
    if (s.hasAttribute('data-fold')) return;
    s.setAttribute('data-fold', '');
    s.classList.add('folded');
  };
  // 一轮还在跑, 但线程里它下面已经有了别的消息 —— 它也不再是「最末尾那个」。
  // 这件事只有整条线程知道 (片段按轮缓存, 服务端不看邻居), 所以在客户端补。
  var settleAbove = function () {
    var rows = inner.querySelectorAll('.mrow');
    Array.prototype.slice.call(rows, 0, -1).forEach(function (r) {
      r.querySelectorAll('.steps').forEach(settle);
    });
  };
  var applyFold = function (root) {
    root.querySelectorAll('.steps[data-key]').forEach(function (s) {
      var v = FOLD[s.getAttribute('data-key')];
      if (v !== undefined) s.classList.toggle('folded', v);
    });
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
    if (e.target.closest('.steps-head') || e.target === s || e.target === childBy(s, 'bubbles')) {
      FOLD[s.getAttribute('data-key')] = s.classList.toggle('folded');
    }
  });
  // reminder 块: 摘要 ⇄ 原文。刚划选了一段原文的那次松手不算点击。
  inner.addEventListener('click', function (e) {
    var r = e.target.closest && e.target.closest('.rem');
    if (!r || String(window.getSelection() || '')) return;
    r.classList.toggle('raw');
  });
  inner.addEventListener('click', function (e) {
    var c = e.target.closest && e.target.closest('.mchip.job[data-job], .tg-job .jc[data-job], .jcrumb [data-job]');
    if (c) openJob(c.getAttribute('data-job'));
  });
  // 回执 chip / 移交行的活号: 跳到派活那句 (同一个活号的入消息)。先在眼前这个窗口里找;
  // 不在就按它带来的坐标切到它所在的会话再落点, 同搜索结果 —— 派活那句常在另一个窗口
  // (私聊派的活, 回执落在群里)。会话键随视角: 公开的在那个群; 私聊在视角与对端的私聊里,
  // 视角不是两端之一就开「这两方之间」的往来。服务端找不到那句时不会画成可点的。
  inner.addEventListener('click', function (e) {
    var c = e.target.closest && e.target.closest('[data-goto][data-gid]');
    if (!c) return;
    var q = inner.querySelector('[data-pturn="' + cssEsc(c.getAttribute('data-goto')) + '"]');
    var row = q && q.closest('.mrow');
    if (row && focusRow(row.getAttribute('data-id'))) return;
    var ch = c.getAttribute('data-gch'), from = c.getAttribute('data-gfrom'), to = c.getAttribute('data-gto');
    var conv = ch ? 'c:' + ch : ROLE === from ? 'p:' + to : ROLE === to ? 'p:' + from : 'a:' + from + '|' + to;
    jumpMsg({ conv: conv, id: c.getAttribute('data-gid'), ts: Number(c.getAttribute('data-gts')) });
  });
  // 移交行整行: 侧栏选中移交双方之间的那一项 (群里的一对 / 私聊; 页面视角不是两端之一就开
  // 「这两方之间」的往来), 有派活那句就落在这一行自己的那句上。页面视角不动, 详情区的 viewpoint
  // 换成移交人 (派活那一方)。节点随 reconcile 换, 所以在根上委托。
  // 行尾的 chevron 只管展开原文, 走 <summary> 自己的开合。
  inner.addEventListener('click', function (e) {
    var b = e.target.closest && e.target.closest('.handoff .ho-line[data-hto], .to-in[data-hto]');
    if (!b || e.target.closest('.ho-chev')) return;
    e.preventDefault();   // 行是 <summary>: 不顺带展开原文
    e.stopPropagation();
    var from = b.getAttribute('data-hfrom'), to = b.getAttribute('data-hto'), ch = b.getAttribute('data-hch');
    var peer = ROLE === from ? to : ROLE === to ? from : '';
    var conv = !peer ? 'a:' + from + '|' + to : ch ? 'c:' + ch : 'p:' + peer;
    var w = peer && ch ? peer : '';
    markBack(function () { return VIEW === 'msgs' && CONV === conv && WITH === w; });
    jumpMsg({ conv: conv, with: w, id: b.getAttribute('data-gid'), ts: Number(b.getAttribute('data-gts')), viewpoint: from });
  });

  // 其余 wezard 调用的提示行: 新生 / 被收的 wizard 开它的全部往来、viewpoint 站到它身上 (页面视角不动),
  // 工单行进工单页, 定时行开日程 —— 日程只有页面视角自己的, 别人的定时行不跳 (换页面视角只走头像 / 名字)。
  // 同移交行: 行是 <summary> 就不顺带展开原文, 行尾 chevron 照旧开合。
  inner.addEventListener('click', function (e) {
    var b = e.target.closest && e.target.closest('.handoff .ho-line[data-hrole], .handoff .ho-line[data-job], .handoff .ho-line[data-hplan]');
    if (!b || e.target.closest('.ho-chev')) return;
    e.preventDefault();
    var role = b.getAttribute('data-hrole'), job = b.getAttribute('data-job'), plan = b.getAttribute('data-hplan');
    if (job) return openJob(job);
    if (plan) return plan === ROLE && setView('plan');
    var conv = 'a:' + role;
    markBack(function () { return VIEW === 'msgs' && CONV === conv; });
    selectConv(conv, '', undefined, role);
  });

  // ── 左栏: 当前 role 的名片 + 会话列表 ──
  // `a:<x>` / `a:<x>|<p1>,<p2>` 不在列表里: x 参与的全部对话 / x 与这几个对端之间的, 按时间排开
  // (关系图里点卡片看的就是它, 服务端同一个 talkOf) —— 现造一项, 落地时才不会被当成失效的会话退回默认。
  // 工单的进度: 开着 = 已落定几份 / 一共几份, 收了 = 收工。
  var jobTag = function (j) {
    return j ? '<span class="jtag' + (j.status === 'open' ? ' open' : '') + '">' + (j.status === 'open' ? j.done + '/' + j.total : '收工') + '</span>' : '';
  };
  // 阶段 (daemon 现算后推来): 缺省 (老快照) = 不标。
  var STAGE = { plan: '规划', build: '实施', review: '评审', clarify: '澄清', stalled: '卡住', shelved: '搁置' };
  var stageText = function (j) {
    if (!j) return '';
    if (j.status === 'closed') return j.kind === 'req' ? (j.end === 'cancel' ? '取消' : '归档') : '';
    return j.stage === 'deliver' ? (j.kind === 'req' ? '等验收' : '待收工') : STAGE[j.stage] || '';
  };
  var stageTag = function (j) {
    var t = stageText(j);
    return t ? '<span class="jstage' + (j.stage === 'deliver' || j.stage === 'clarify' || j.stage === 'stalled' ? ' wait' : '') + '">' + t + '</span>' : '';
  };
  // 祖先链 (根在前): 按服务端的账走 parent; 环 / 缺失就停。
  var jobAncestors = function (id) {
    var idx = R.jobIndex || {}, out = [], seen = {}, cur = idx[id] && idx[id].parent;
    while (cur && idx[cur] && !seen[cur]) { seen[cur] = 1; out.unshift(cur); cur = idx[cur].parent; }
    return out;
  };
  var jobCrumbs = function (id) {
    var up = jobAncestors(id);
    return up.length ? '<span class="jcrumb">' + up.map(function (a) {
      return '<button data-job="' + esc(a) + '" title="' + esc(a) + '">' + esc((R.jobIndex[a] || {}).title || a) + '</button>';
    }).join('<i>›</i>') + '<i>›</i></span>' : '';
  };
  // 工单列表的树序: 父在前、子缩进跟在后; 父不在这一段里的当根。
  var jobTreeOrder = function (list) {
    var ids = {}; list.forEach(function (c) { ids[c.job.id] = 1; });
    var kids = function (id) { return list.filter(function (c) { return c.job.parent === id; }); };
    var walk = function (c, d) { return [{ c: c, d: d }].concat(kids(c.job.id).reduce(function (a, k) { return a.concat(walk(k, d + 1)); }, [])); };
    return list.filter(function (c) { return !c.job.parent || !ids[c.job.parent]; }).reduce(function (a, c) { return a.concat(walk(c, 0)); }, []);
  };
  // 工单里有人卡住 (停在审批卡 / 反问待答 / 报错停了) 时标出几份卡着 —— 要人或开单者动手的。
  var stuckTag = function (j) {
    var n = j && j.status === 'open' ? (R.inflight || []).filter(function (x) {
      return x.job === j.id && (x.state === 'blocked' || x.state === 'needs-input' || x.state === 'errored');
    }).length : 0;
    return n ? '<span class="jstuck" title="' + n + ' 份停在审批 / 反问 / 报错上">' + n + ' 卡住</span>' : '';
  };
  // 侧栏一行 / 关系图卡片上的小标记: 这处往来里有归在工单名下的话。
  var jobMark = function (ids) {
    return ids && ids.length ? '<span class="jmk" data-jobs="' + esc(ids.join(' ')) + '" title="' + esc((ids.length > 1 ? ids.length + ' 张工单: ' : '工单 ') + ids.join(' ') + ' —— 点开') + '">📋' + (ids.length > 1 ? '<i>' + ids.length + '</i>' : '') + '</span>' : '';
  };
  // 视角不在里面的工单不在 R.convs 里: 按服务端的账 (R.jobIndex, 全部工单) 现造一项; 账里没有 = 已清掉 (job 为空)。
  var jobConv = function (key) {
    var id = key.slice(2), j = (R.jobIndex || {})[id];
    return {
      key: key, kind: 'job', name: j ? j.title : id, label: '📋', base: j ? j.base : '', subs: [], heard: [],
      lastTs: j ? j.closedAt || j.openedAt : 0, preview: '',
      job: j && { id: id, owner: j.owner, status: j.status, done: j.done, total: j.total, parent: j.parent, kind: j.kind, stage: j.stage },
    };
  };
  /** 一个工单号 → 它的一行: 视角有份的取会话项 (带预览), 其余按账现造。 */
  var jobRowOf = function (id) {
    return jobConvs().filter(function (c) { return c.job.id === id; })[0] || jobConv('j:' + id);
  };
  /** 工单列表此刻列哪些: 从 📋 进来 = 入口带的那几张 (按 id, 不按视角筛); 否则视角开的或参与的。标题的数与列表同出这一份。 */
  var jobListRows = function () {
    return JOB_ONLY ? JOB_ONLY.map(jobRowOf).filter(function (c) { return c.job; }) : jobConvs();
  };
  var jobConvs = function () { return R.convs.filter(function (c) { return c.kind === 'job' && c.job; }); };
  var convOf = function (key) {
    if (key && key.indexOf('a:') === 0) {
      var part = key.slice(2).split('|'), who = part[0], peers = (part[1] || '').split(',').filter(Boolean), chat = part[2] || '';
      var name = chat ? nameOf(who) + ' 在 ' + chatTitle(chat) + ' 的全部记录'
        : nameOf(who) + (peers.length ? ' 与 ' + peers.map(nameOf).join('、') + ' 的对话' : ' 的全部对话');
      return { key: key, kind: 'all', who: who, peers: peers, chat: chat, name: name, subs: [] };
    }
    var hit = R.convs.filter(function (c) { return c.key === key; })[0];
    return hit || (key && key.indexOf('j:') === 0 ? jobConv(key) : undefined);
  };
  var chatTitle = function (base) {
    var c = R.convs.filter(function (x) { return x.key === 'c:' + base; })[0];
    return c ? c.name : base;
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

  var line = function (title, ts, pv, lamp, unread) {
    return '<span class="b"><span class="l1"><span class="t">' + title + '</span>' + (lamp || '') +
      '<span class="ts">' + esc(fmtAgo(ts)) + '</span></span>' +
      '<span class="l2"><span class="pv">' + esc(pv) + '</span>' +
      (unread ? '<b class="ub">' + (unread > 99 ? '99+' : unread) + '</b>' : '') + '</span></span>';
  };

  // ── 未读: 别人说完、我还没读到的话 ──
  // 服务端给每个会话一份 heard = [说完的时刻, 发话方, 收信方], 以及我在群里 / 每一对里
  // 最后开口的时刻 (mine)。说给我的那句属于「我与发话方」那一对。一句话的已读水位 = 它所在那一处
  // 「我最后开口」与「我看过」的较晚者: 属于某一对的看那一对 (群里说过话不等于读过别的线程), 不属于任何一对的看群。
  // 基线是「打开页面这一刻」(BASE, 服务端时钟, 首次拿到快照时定): 此前已有的话不算未读, 之后新说完的才累加,
  // 刷新即重置 —— 所以「看过」只活在内存里, 不落本地。按视角分账 (同一个群换个 role 看, 未读是另一回事)。
  var BASE = 0;
  var READ = { at: {} };
  var readKey = function (key, withRole) { return ROLE + '|' + key + '|' + (withRole || ''); };
  var seenAt = function (key, withRole) { return READ.at[readKey(key, withRole)] || 0; };
  var unreadOf = function (c, withRole) {
    var g = seenAt(c.key);
    var mark = {};
    (c.subs || []).forEach(function (s) { mark[s.role] = Math.max(g, BASE, s.mine || 0, seenAt(c.key, s.role)); });
    var groupMark = Math.max(g, BASE, c.mine || 0);
    return (c.heard || []).filter(function (h) {
      var p = h[2] === ROLE ? h[1] : '';
      if (withRole && p !== withRole) return false;
      return h[0] > (p && mark[p] !== undefined ? mark[p] : groupMark);
    }).length;
  };
  var reading = function () { return VIEW === 'msgs' && !document.hidden; };
  // 窗口是 `a:<x>|<peers>` (关系图卡片) 时, 视角与 p 的往来在不在里面 —— 与服务端 talkOf 同一口径:
  // 一端是 x、另一端是 peers 之一 (peers 空 = 不限), 不分频道。
  var talkCovers = function (p, c) {
    var t = convOf(CONV);
    if (!t || t.kind !== 'all') return false;
    // 限定了频道的窗口 (某 role 在一个群里的全部记录) 只覆盖那个群里的往来。
    if (t.chat && (!c || c.base !== t.chat)) return false;
    var hit = function (a, b) { return t.who === a && (!t.peers.length || t.peers.indexOf(b) >= 0); };
    return hit(ROLE, p) || hit(p, ROLE);
  };
  // 一处会话里这次读到了哪几对 (存水位用的 withRole): 侧栏选中的就是那一项; 关系图卡片打开的
  // 对话横跨会话, 每个会话里落在那段对话里的那几对都算 —— 私聊的那一对记在会话本身 ('')。
  var readPairs = function (c) {
    if (c.key === CONV) return [WITH];
    if (c.kind !== 'group') return c.peer && talkCovers(c.peer, c) ? [''] : [];
    return (c.subs || []).filter(function (s) { return talkCovers(s.role, c); }).map(function (s) { return s.role; });
  };
  // 读整个群 = 群的水位推到此刻 (子项随之全清); 只读一对 = 只推那一对的。
  var markRead = function (c) {
    if (!reading()) return;
    var h = c.heard && c.heard[c.heard.length - 1];
    var hit = readPairs(c).filter(function (w) { return unreadOf(c, w || (c.kind !== 'group' ? c.peer : '')); });
    hit.forEach(function (w) { READ.at[readKey(c.key, w)] = Math.max(R.at, h ? h[0] : 0); });
  };

  // 跨会话通用的个人偏好 (看全部、列表 / 关系、侧栏群节点的展开、session 选择): 记在本地, 刷新后还在。
  // 取不到 / 写不进 (隐私窗口、禁存) 就按默认值, 页面照常。
  var pref = function (key, def) {
    try { var v = localStorage.getItem(key); return v === null ? def : JSON.parse(v); } catch (e) { return def; }
  };
  var setPref = function (key, v) { try { localStorage.setItem(key, JSON.stringify(v)); } catch (e) { } };
  var prefObj = function (key) { var v = pref(key, {}); return v && typeof v === 'object' ? v : {}; };
  var WORLD_KEY = 'wezard.role.world';
  if (!qs.has('side')) WORLD = pref(WORLD_KEY, false) === true;
  // 早先也记过 ping 与日程卡片的展开 (只活在内存里了)、「往来 / 相关 / 全部」开关 (已去掉, 固定看全部 / 相关) —— 旧 key 顺手清掉。
  try { ['wezard.role.pingOpen', 'wezard.role.planOpen', 'wezard.role.showAll', 'wezard.role.subScope'].forEach(function (k) { localStorage.removeItem(k); }); } catch (e) { }

  // 展开态按群各记各的 (键 = 群节点的会话键): 点开一个不收起别的, 轮询重画也不动它。
  // OPEN_AT = 已经替它自动展开过的那个 CONV —— 选中新会话时展开一次, 之后折不折由人说了算; null = 刚载入。
  // 默认只展开选中的那个群; 本地只记偏离默认的: 没选中却展开着的 = true, 选中却被收起的 = false
  // (载入时自动展开要让着它)。回到默认的那一项写的时候就删, 不越存越多。
  var OPEN_KEY = 'wezard.role.groupOpen';
  var OPEN = prefObj(OPEN_KEY), OPEN_AT = null;
  // 子项默认只露前 SUB_FOLD 个, 其余收在一条展开/折叠条后面; 展开态同样按群记, 只留展开着的。
  var MORE_KEY = 'wezard.role.groupMore';
  var SUB_FOLD = 5, MORE = prefObj(MORE_KEY);
  // 某 role 在一个群里的全部记录挂在那个群下: CONV 落在哪个群节点上。
  var groupOf = function (key) { var t = key && convOf(key); return t && t.chat ? 'c:' + t.chat : key; };
  var saveOpen = function () {
    var sel = groupOf(CONV);
    setPref(OPEN_KEY, Object.keys(OPEN).reduce(function (m, k) {
      if (!!OPEN[k] !== (k === sel)) m[k] = !!OPEN[k];
      return m;
    }, {}));
  };
  var setMore = function (key, v) {
    if (v) MORE[key] = true; else delete MORE[key];
    setPref(MORE_KEY, MORE);
  };
  var reveal = function () {
    if (!CONV || CONV === OPEN_AT) return;
    var g = groupOf(CONV);
    if (!(OPEN_AT === null && OPEN[g] === false)) OPEN[g] = true;
    OPEN_AT = CONV;
    saveOpen();
  };
  // 点侧栏项 / 关系图卡片 (两边同一份): 没选中它 → 选中 (会话顺带展开); 已选中再点 → 取消选中, 右边回到
  // 页面视角的全部对话 (`a:<role>`, 即「看全部」那一份), 页面视角不动; 取消的是会话本身就顺带收起它。
  // viewpoint: 站在这一项的主人身上 —— 会话与成对的子项是页面视角自己的, .far 子项与卡片是那个 role 的。
  var clickItem = function (key, withRole, viewpoint) {
    var vp = viewpoint && viewpoint !== ROLE ? viewpoint : '';
    if (key !== CONV || (withRole || '') !== WITH || VIEW !== 'msgs' || VIEWPOINT !== vp) return selectConv(key, withRole, undefined, viewpoint);
    // 窄屏退回列表后再点它是要回去读, 不是要取消。
    if (!app.classList.contains('reading')) return app.classList.add('reading');
    var fold = !withRole && OPEN[key];
    if (fold) OPEN[key] = false;
    selectConv('a:' + ROLE, '', undefined, '');
    if (fold) saveOpen();   // 选中项换过之后再记: 没选中的收着是默认态, 不占一条
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
  // 名字悬停时紧跟一枚 ⇄ —— 同名片上名字悬停露出 ⧉: 点名字做的事, 先亮给人看。
  var SWAP = '<i class="sw" aria-hidden="true">⇄</i>';
  var roleRow = function (id, name, label, g, status, tail, badge) {
    return goSpan('av', id, esc(label)) +
      line(nm(id, name, true, SWAP + (badge || '')) + (tail || ''), g.lastTs, g.preview, stTag(status, true), g.unread);
  };
  // 名字旁的「+N」: 视图外还有 N 个 —— 同一个徽标, 数什么由所在的视图注入 (会话列表数会话, 关系图数关系)。
  var moreTag = function (n, tip) {
    return n ? '<span class="oc" title="' + esc(tip) + '">+' + n + '</span>' : '';
  };
  // 会话列表: 除了这一项 (here = 它的绝对 key), 它还对应 N 个叶子项 (各群里它参与的成对子项 + 它的私聊)。服务端没给这份 = 不知道, 不画。
  var otherChats = function (id, here) {
    var ks = (R.chatKeys || {})[id];
    var n = ks ? ks.filter(function (k) { return k !== here; }).length : 0;
    return moreTag(n, nameOf(id) + ' 在另外 ' + n + ' 处 (群里的一对 / 私聊) 还有往来, 切到它的视角可见');
  };
  // 侧栏的 key 是相对视角的 (p:<对端> / 群 + 选中的对端), 服务端那份是绝对的 (两端排序)。
  var pairKey = function (peer) { return [ROLE, peer].sort().join('|'); };
  var dmKey = function (peer) { return 'p:' + pairKey(peer); };
  var convRow = function (c) {
    if (c.kind === 'wizard') return roleRow(c.peer, c.name, c.label, glance(c), c.status, jobMark(c.jobs), otherChats(c.peer, dmKey(c.peer)));
    if (c.kind === 'job') return '<span class="av">' + esc(c.label) + '</span>' + line('<span class="nm chat">' + esc(c.name) + '</span>' + stageTag(c.job) + jobTag(c.job) + stuckTag(c.job), c.lastTs, c.preview, '', unreadOf(c));
    return avatarOf(c) + line('<span class="nm chat">' + esc(c.name) + '</span>' + jobMark(c.jobs), c.lastTs, c.preview, stTag(c.status, true), unreadOf(c));
  };
  var subRow = function (c, s) { return roleRow(s.role, s.name, s.label, glance(c, s), s.status, jobMark(s.jobs), otherChats(s.role, c.key + '|' + pairKey(s.role))); };

  // 「chat 内全部」下与我无往来的那几项: 一行的数据是它在群里的全部记录 (服务端 whole, 与关系图卡片同一个
  // glanceOfTalk), 点开看的也是那一份 (`a:<它>||<群>`, 对端不限)。没有成对的往来, 也就没有我的未读 —— 同关系图里
  // 视角没有会话项的那张卡片。+N 数它的全部叶子, 这一项本身不是叶子。
  var farKey = function (c, s) { return 'a:' + s.role + '||' + c.base; };
  var farRow = function (s) {
    var w = s.whole;
    return roleRow(s.role, s.name, s.label, { lastTs: w.lastTs, preview: w.preview, unread: 0 }, s.status, '', otherChats(s.role, ''));
  };

  var convItem = function (c) {
    var on = c.key === CONV;
    // 与我有往来的成对子项在前; chat 内其余有记录的接在后面 (.far), 各自按最近排。
    var pairs = c.subs.filter(function (s) { return s.count; }).sort(recentFirst);
    var fars = c.subs.filter(function (s) { return !s.count && s.whole && s.whole.count; })
      .sort(function (a, b) { return recentFirst(a.whole, b.whole); });
    var talked = OPEN[c.key] ? pairs.concat(fars) : [];
    var hidden = talked.length - SUB_FOLD;
    var bar = hidden > 0
      ? '<button class="si-more" data-more="' + esc(c.key) + '">' + (MORE[c.key] ? '折叠' : '展开更多') + ' × ' + hidden + '</button>'
      : '';
    // 展开条钉在第 SUB_FOLD+1 位, 展开与折叠都不挪: 其余子项展开后接在它下面。
    var sub = function (s) {
      if (!s.count) {
        var k = farKey(c, s);
        return '<button class="si far' + (CONV === k ? ' on' : '') + '" data-conv="' + esc(k) + '" data-with="" data-vp="' + esc(s.role) + '" ' +
          'title="' + esc(nameOf(s.role) + ' 在这里的 ' + s.whole.count + ' 条记录 (与我无往来)') + '">' + farRow(s) + '</button>';
      }
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

    // 群聊项特殊处理: 把 chevron 挪到行内部, 在时间左边
    if (c.kind === 'group' && c.subs && c.subs.length) {
      // 不能是 <button>: 嵌在外层 .ci 按钮里会被解析器提前闭合外层, chevron 就掉到卡片外
      var chevron = '<span role="button" class="ci-chevron' + (OPEN[c.key] ? ' on' : '') + '" data-toggle="' + esc(c.key) + '" title="' + (OPEN[c.key] ? '折叠群' : '展开群') + '"></span>';
      var content = avatarOf(c) + '<span class="b"><span class="l1"><span class="t"><span class="nm chat">' + esc(c.name) + '</span>' + jobMark(c.jobs) + '</span>' + chevron + '<span class="ts">' + esc(fmtAgo(c.lastTs)) + '</span></span>' +
        '<span class="l2"><span class="pv">' + esc(c.preview) + '</span>' + (unreadOf(c) ? '<b class="ub">' + (unreadOf(c) > 99 ? '99+' : unreadOf(c)) + '</b>' : '') + '</span></span>';
      return '<button class="ci' + (sel ? ' on' : '') + '" data-conv="' + esc(c.key) + '">' + content + '</button>' + subs;
    }

    return '<button class="ci' + (sel ? ' on' : '') + '" data-conv="' + esc(c.key) + '">' +
        convRow(c) + '</button>' + subs;
  };

  // 搜索入口挂在名片下 —— 侧栏的公共区, 会话列表与关系图下都在。⌘K 见下方「搜索」。
  var MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
  var KBD = MAC ? '⌘K' : 'Ctrl K';
  var SEARCH_SVG = '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="4.6"/><path d="m10.4 10.4 3.6 3.6"/></svg>';
  var sbox = document.createElement('button');
  sbox.className = 'sbox'; sbox.type = 'button';
  sbox.innerHTML = '<span class="ic">' + SEARCH_SVG + '</span><span class="lb">搜索 role、会话、消息</span><kbd>' + KBD + '</kbd>';
  sbox.onclick = function () { openSearch(); };
  $('#rolebar').parentNode.insertBefore(sbox, $('#rolebar').nextSibling);
  // 老外壳 (daemon 未重启) 里还留着名片下那条入口栏 —— 日程已并进名片, 它整条不要了。
  if ($('#rb-acts')) $('#rb-acts').remove();
  var renderConvs = function () {
    var fresh = function (c) { return !WIN || c.lastTs >= winCut(); };
    var groups = R.convs.filter(function (c) { return c.kind === 'group' && fresh(c); }).sort(recentFirst);
    var dms = R.convs.filter(function (c) { return c.kind === 'wizard' && fresh(c); }).sort(recentFirst);
    R.convs.forEach(markRead);
    if (WORLD) return renderWorld();
    // 空着的那一栏不画 —— 对谁都一样: 人没有私聊只是这条规则的一个特例。
    var sec = function (title, list) {
      return list.length ? '<h2>' + title + '<span>' + list.length + '</span></h2>' + list.map(convItem).join('') : '';
    };
    // 没变就不碰 DOM: 心跳每 3s 来一次, 重建会把列表的滚动与焦点蹭掉。
    // 开关挂在第一个标题行的右端; 一个会话都没有也留一行标题给它。
    var html = (sec('群聊', groups) + sec('私聊', dms) || '<h2>会话<span>0</span></h2>').replace('</h2>', winSelect() + worldToggle() + '</h2>');
    if (convsEl._html === html) return;
    convsEl._html = html; convsEl.innerHTML = html;
    convsEl.querySelectorAll('[data-conv]').forEach(function (b) {
      var key = b.getAttribute('data-conv'), w = b.getAttribute('data-with') || '', vp = b.getAttribute('data-vp') || '';
      b.onclick = function () { clickItem(key, w, vp); };
    });
    convsEl.querySelectorAll('[data-more]').forEach(function (b) {
      var key = b.getAttribute('data-more');
      b.onclick = function () { setMore(key, !MORE[key]); renderConvs(); };
    });
    convsEl.querySelectorAll('[data-toggle]').forEach(function (b) {
      var key = b.getAttribute('data-toggle');
      b.onclick = function (e) { e.stopPropagation(); OPEN[key] = !OPEN[key]; saveOpen(); renderConvs(); };
    });
    bindGo(convsEl);
    bindWorldToggle(convsEl); bindWin(convsEl);
  };

  var shortCwd = function (p) {
    var seg = String(p).replace(/\/+$/, '').split('/').filter(Boolean);
    return seg.length <= 2 ? p : '…/' + seg.slice(-2).join('/');
  };
  // session 只靠两样认: 何时开始、跑了几轮。最新那段直接叫「最新」。
  var latestSess = function () { return R.sessions[R.sessions.length - 1]; };
  // 选中的 session 按「role + 会话 (+ 群里的对端)」记; 选回默认 (全部时间, 不切) 就删那一项。
  // 只在 URL 没指定 session 时恢复 —— 落地窗口要等第一份摘要才定, SESS_RESTORE 守到那时。
  var SESS_KEY = 'wezard.role.session';
  var SESS_RESTORE = !qs.get('session');
  var sessKey = function () { return ROLE + '\n' + CONV + (WITH ? '\n' + WITH : ''); };
  var savedSess = function () { return prefObj(SESS_KEY)[sessKey()] || ''; };
  var saveSess = function (sid) {
    var m = prefObj(SESS_KEY);
    if (sid && sid !== 'all') m[sessKey()] = sid; else delete m[sessKey()];
    setPref(SESS_KEY, m);
  };
  // 第一份摘要到手: 记下的那段还在列表里就换过去 (换了要重取一次), 不在了就回默认并删掉。
  var restoreSess = function () {
    if (!SESS_RESTORE) return false;
    SESS_RESTORE = false;
    var want = savedSess();
    if (!want || want === SESSION) return false;
    if (R.sessions.some(function (x) { return x.sessionId === want; })) { SESSION = want; return true; }
    saveSess('');
    return false;
  };
  var sessWhen = function (s) { return s.start ? fmtClock(s.start) : '(无时刻)'; };

  // 自定义下拉: 小号文字触发器 + 浮层列表 (.sp)。名片里的 session 与侧栏标题行的时间范围共用这一份。
  // 宿主每次刷新都重画, 展开的是哪一个记在 DD_OPEN 里 (按 id) 才不会被轮询收起。
  // items: { v, html, on, cls?, tip? }; `ic` = 触发器左侧的图标; `end` = 浮层以触发器右沿为锚向左下展开 (贴着侧栏右沿的那种)。
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

  // session 切换: name 右边那个下拉。
  var sessItem = function (s, on) {
    var last = s === latestSess();
    return { v: s.sessionId || '', on: on, tip: s.sessionId || '',
      html: '<span class="id">' + (last ? '最新 · ' : '') + esc(sessWhen(s)) + '</span><span class="n">' + s.turns + ' 轮</span>' };
  };
  var sessPicker = function () {
    var cur = R.sessions.filter(function (s) { return s.sessionId === SESSION; })[0];
    return dropdown('sess', {
      title: '切换 session',
      label: !cur ? '全部' : cur === latestSess() ? '最新' : sessWhen(cur),
      items: [{ v: 'all', on: !cur, cls: 'all', html: '<span class="id">全部</span><span class="n">' + R.sessions.length + ' 段</span>' }]
        .concat(R.sessions.slice().reverse().map(function (s) { return sessItem(s, s.sessionId === SESSION); })),
    });
  };
  var bindSessPicker = function () {
    bindDropdown($('#rb-sp'), 'sess', function (v) { SESSION = v; saveSess(SESSION); refresh(); });
  };

  // 会话列表 ↔ 关系图: 侧栏第一行右上角同一个小开关, 标的是「点了去哪」。
  var LIST_SVG = '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M3 4h10M3 8h10M3 12h10" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';
  var TREE_SVG = '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M4 3v10M4 6h5M4 11h5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><circle cx="11" cy="6" r="1.6" fill="currentColor"/><circle cx="11" cy="11" r="1.6" fill="currentColor"/></svg>';
  // 时间范围: 只看最近 N 分钟内有动静的 (0 = 全部)。会话列表与关系图共用这一个值。
  var WIN_KEY = 'wezard.role.winMin';
  var WINS = [[0, '全部'], [30, '半小时'], [60, '1小时'], [120, '2小时'], [1440, '1天']];
  var WIN = pref(WIN_KEY, 0);
  if (!WINS.some(function (w) { return w[0] === WIN; })) WIN = 0;
  var winCut = function () { return WIN ? srvNow() - WIN * 60000 : 0; };
  var winSelect = function () {
    return dropdown('win', {
      ic: '⏱', end: true, title: '时间范围: 只看这段时间内有动静的',
      label: (WINS.filter(function (w) { return w[0] === WIN; })[0] || WINS[0])[1],
      items: WINS.map(function (w) { return { v: String(w[0]), on: w[0] === WIN, html: '<span class="id">' + w[1] + '</span>' }; }),
    });
  };
  var bindWin = function (scope) {
    bindDropdown(scope, 'win', function (v) {
      WIN = +v; W.treeFor = ''; setPref(WIN_KEY, WIN);
      convsEl._html = ''; convsEl._tree = '';
      renderConvs();
    });
  };
  var worldToggle = function () {
    return '<button class="vt" data-vt title="' + (WORLD ? '换回会话列表' : '换成关系') + '">' + (WORLD ? LIST_SVG + '列表' : TREE_SVG + '关系') + '</button>';
  };
  var bindWorldToggle = function (scope) {
    var b = scope.querySelector('[data-vt]');
    if (b) b.onclick = function () { setWorld(!WORLD); };
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

  // 名片: 头像 · 名字 (忙闲 / session) · 名字下一行低调的描述 (🏠 home · 🐣 出生 · 📜 宪章大小 · 🗂️ cwd · 📅 日程) · 职责。
  // 身份与出身 (谁的分身 / 子 wizard) 交给关系图 (侧栏标题右端的开关), 名片不写。
  // 日程: 下一枪几点, 定时出错时染红改写出错数; 没有排期就只写条数 (定时 + 工单)。
  var planFact = function () {
    var p = R.plan || {};
    var txt = p.broken ? '日程 ⚠ ' + p.broken + ' 出错' : p.nextAt ? '日程 ' + fmtClock(p.nextAt).replace(/^今天 /, '') : '日程 ' + R.schedules;
    return ['📅', txt, (p.tasks ? p.tasks + ' 条定时 · ' : '') + '点开看日程', 'plan', p.broken ? 'bad' : ''];
  };
  var renderRole = function () {
    var r = R.role;
    if (!r) return;
    // 出生 = 注册表记的 bornAt; 没记 (老 wizard / 人) 就退到最早一段 session 的开始。
    var born = r.bornAt || R.sessions.reduce(function (m, x) { return x.start && (!m || x.start < m) ? x.start : m; }, 0);
    var facts = [
      r.chat ? ['🏠', r.chat, 'home'] : null,
      born ? ['🐣', fmtAgo(born), '出生于 ' + fmtDay(born)] : null,
      // 宪章紧跟出生: 出生时被交代了多少 (≈token), 只写大小; 可点开看全文。
      R.charter ? ['📜', fmtTok(R.charter.tokens), '宪章 ≈' + fmtTok(R.charter.tokens) + ' token · ' + fmtClock(R.charter.at) + ' 压进系统提示 · 点开看全文', 'charter'] : null,
      r.cwd ? ['🗂️', shortCwd(r.cwd), r.cwd] : null,
      // 日程排最后, 可点: 名下排了什么。
      R.schedules ? planFact() : null
    ].filter(Boolean).map(function (f) {
      return '<span' + (f[3] ? ' class="fx' + (VIEW === f[3] ? ' on' : '') + (f[4] ? ' ' + f[4] : '') + '" data-view="' + f[3] + '"' : '') + ' title="' + esc(f[2]) + '">' + f[0] + ' ' + esc(f[1]) + '</span>';
    });
    // 只有一段 session 就没什么可选, 不挂选择器。
    $('#rb-who').innerHTML =
      '<div class="id"><span class="av">' + esc(r.label) + '</span>' +
        '<span class="l"><span class="nl"><span class="cp" title="' + esc('点击复制 ' + nameOf(r.id)) + '">' + nm(r.id, r.name) + '</span>' + (r.kind === 'wizard' ? '<span id="rb-st"></span>' : '') +
          '<span id="rb-sp">' + (R.sessions.length > 1 ? sessPicker() : '') + '</span></span>' +
          (facts.length ? '<span class="facts">' + facts.join('') + '</span>' : '') + '</span></div>' +
      (r.description ? '<p class="job">' + esc(r.description) + '</p>' : '');
    paintStatus();
    $('#rb-who').querySelector('.cp').onclick = function () { copyText(nameOf(r.id)); };
    $('#rb-who').querySelectorAll('.fx').forEach(function (x) {
      x.onclick = function () { var v = x.getAttribute('data-view'); setView(VIEW === v ? 'msgs' : v); };
    });
    $('#rb-who').querySelectorAll('.go').forEach(function (g) {
      g.onclick = function () { switchRole(g.getAttribute('data-r')); };
    });
    // 老外壳的底栏选择框已并进 name 行。
    if ($('#rb-foot')) $('#rb-foot').hidden = true;
    bindSessPicker();
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
  // 按单价从省到贵排, 颜色随之由冷转暖: 缓存读 (约 0.1×, 通常占了大半) 直接用边线色, 色带贴顶时这段就像普通上边线 →
  // 输入 (1×) 沉稳蓝 → 输出 (约 5×, 最贵) 绿 → 缓存写 (1.25×) 红, 与蓝/绿都拉开。注意力留给后三段。
  var SEGS = [
    // in = API 的 input_tokens: 只是没命中缓存、也没写进缓存的那点新输入 (Claude 上每次请求常只有个位数),
    // 不是「送进模型的输入」—— 那是 in + cr + cw, 在 bar 的悬停提示里单列。
    ['cacheRead', '缓存读', 'var(--line)', 'cr'], ['input', '新输入 (未走缓存)', '#4c6fd6', 'in'],
    ['output', '输出', '#2f9e5b', 'out'], ['cacheWrite', '缓存写', '#d64545', 'cw'],
  ];
  var TIP = {
    turns: '对话轮数', tools: '工具调用次数', api: 'API 请求次数',
    ctx: '上下文 — 最近一次请求送入的 input + 缓存',
  };
  var ICON = { cost: '💰', turns: '💬', tools: '🛠️', api: '⇄', ctx: '📄' };
  var fmtUsd = function (n) {
    return n < .01 ? '<$0.01' : '$' + (n < 10 ? n.toFixed(2) : n < 1000 ? n.toFixed(1) : Math.round(n));
  };
  // 费用: 有认不出价格的模型就在数前加「≥」—— 实际只多不少; 一分钱都没算出来就不占位。
  var costKv = function (u) {
    if (!u.cost) return '';
    var txt = (u.unpriced ? '≥' : '') + fmtUsd(u.cost);
    var tip = '估算费用 — 每轮按模型单价 (LiteLLM 价格表快照) 计 input / output / 缓存写 / 缓存读' +
      (u.unpriced ? '\n另有 ' + u.unpriced + ' 次 API 请求的模型不在价格表里, 未计入' : '');
    return '<span class="kv kv-cost" title="' + esc(tip) + '" data-tip="' + esc(ICON.cost + ' ' + txt) +
      '"><i class="u-ic">' + ICON.cost + '</i><b>' + esc(txt) + '</b></span>';
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
    // 输出 / 缓存不再单列成指标 —— 它们就是顶边色带的那几段。
    // I/O 分布: 贴着整条 bar 的顶边 (替代上边线) 画一条横跨整宽的细色带; 各段的量作为图例常显在 bar 里 (占比在悬停提示), 色点与色带同色。
    // 两头留一位小数: 99.9% 不该被四舍五入成 100%, 一丁点也不该成 0%。
    var pct = function (n) {
      var p = n / total * 100;
      return p < .1 ? '<0.1%' : (p < 1 || p > 99 ? p.toFixed(1) : Math.round(p)) + '%';
    };
    var io = total > 0
      ? '<span class="bar" title="' + esc(['累计 token I/O · 共 ' + fmtTok(total),
          '送入合计 (in + cr + cw) ' + fmtTok((u.input || 0) + (u.cacheRead || 0) + (u.cacheWrite || 0))].concat(segs.map(function (s) {
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
        esc(t.modelLabel || t.model || '用量') + '</span>' +
      (t.effort ? '<span class="u-ef" title="effort 档位">' + esc(t.effort) + '</span>' : '') +
      '<span class="u-kvs">' +
        costKv(u) + kv('turns', t.turns, t.turns) + kv('tools', u.tools, u.tools) + kv('api', u.calls, u.calls) +
        kv('ctx', u.ctx, fmtTok(u.ctx)) +
      '</span>' + io;
  };
  // 永远单行: 排不下就按 FOLD 的顺序一级级藏 (消息/工具/API 计数 → 分布文字 → 名字), 宽度回来再按反序放出来。
  // 判定看的是容器自己溢没溢出, 不看视口 —— 同一个组件挂在整页页脚和右栏底, 宽度各不相同。
  var FOLD = ['f-cnt', 'f-leg', 'f-nm'];
  var FOLDED = { 'f-cnt': '.kv-turns, .kv-tools, .kv-api', 'f-leg': '.leg', 'f-nm': '.u-nm' };
  var fitUsage = function (el) {
    if (el.hidden) return;
    var over = function () { return el.scrollWidth > el.clientWidth; };
    FOLD.forEach(function (c) { el.classList.remove(c); });
    var n = 0;
    while (n < FOLD.length && over()) el.classList.add(FOLD[n++]);
    // 藏起来的那几样进整条 bar 的 title, hover 照样读得到。
    el.title = FOLD.slice(0, n).reduce(function (a, c) {
      return a.concat([].map.call(el.querySelectorAll(FOLDED[c]), function (x) { return x.getAttribute('data-tip'); }));
    }, []).filter(Boolean).join('\n');
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
  // 跳走之前在看的那段会话 —— 顶栏的「‹ 回到 …」回这里。on: 在哪些窗口上露出这个按钮;
  // at: 跳走时点的那条消息, 回来落在它上面。进工单页 (只在从非工单的窗口进来时记) 与
  // 移交行 / 提示行点过去都记它, 同一个按钮。点过去会换详情区的 viewpoint, 所以连它一起记 (页面视角不动)。
  var BACK = null;
  var inJobs = function () { return VIEW === 'jobs' || CONV.indexOf('j:') === 0; };
  // 回来 = 原样恢复那一页: 会话、viewpoint、滚动位置 (按视窗顶上那一行的偏移记, 不闪不吸)。吸在底部就不记锚点。
  var markBack = function (on) {
    var r = !atBottom() && firstShown();
    var at = r && { id: r.getAttribute('data-id'), off: r.getBoundingClientRect().top - thread.getBoundingClientRect().top };
    BACK = { conv: CONV, with: WITH, session: SESSION, viewpoint: VIEWPOINT, at: at || null, on: on };
  };
  var restoreAt = function (at) {
    if (!at) return undefined;
    var put = function () {
      var row = rowNode(at.id);
      if (!row) return false;
      thread.scrollTop += row.getBoundingClientRect().top - thread.getBoundingClientRect().top - at.off;
      S.pinned = atBottom();
      return true;
    };
    return function () { if (!put()) loadMsgs('0', put); return true; };
  };
  var openJob = function (id) {
    if (CONV.indexOf('j:') !== 0) markBack(inJobs);
    selectConv('j:' + id, '');
  };
  // 一处标记背后可能有好几张: 一张直接进那张, 多张进工单列表且只列这几张 (JOB_ONLY)。
  var JOB_ONLY = null;
  var openJobs = function (ids) {
    if (ids.length === 1) return openJob(ids[0]);
    if (CONV.indexOf('j:') !== 0) markBack(inJobs);
    JOB_ONLY = ids;
    if (VIEW === 'jobs') renderJobList(); else setView('jobs');
    renderHead();
  };
  // 标记长在会话项 / 关系图卡片这些按钮里: 捕获阶段截下来, 不让外层按钮再打开那段对话。
  document.addEventListener('click', function (e) {
    var m = e.target.closest && e.target.closest('.jmk[data-jobs]');
    if (!m) return;
    e.stopPropagation(); e.preventDefault();
    openJobs(m.getAttribute('data-jobs').split(' ').filter(Boolean));
  }, true);
  // 关系图的 clone 徽标: 开 origin 的全部往来、落到它分叉出这个分身的那一处; viewpoint 站到 origin, 页面视角不动。
  // 同 📋: 长在卡片按钮里, 捕获阶段截下来。
  document.addEventListener('click', function (e) {
    var m = e.target.closest && e.target.closest('.ek.clone[data-cpoint]');
    if (!m) return;
    e.stopPropagation(); e.preventDefault();
    var pt = JSON.parse(m.getAttribute('data-cpoint')), conv = 'a:' + pt.origin;
    markBack(function () { return VIEW === 'msgs' && CONV === conv; });
    jumpMsg({ conv: conv, id: pt.id, use: pt.use, ts: pt.ts, viewpoint: pt.origin });
  }, true);
  var backBtn = function () {
    var c = BACK && BACK.on() && convOf(BACK.conv);
    return c ? '<button class="back jb" id="ch-jback" title="' + esc('回到 ' + (BACK.with ? nameOf(BACK.with) : c.name)) + '" aria-label="返回">‹</button>' : '';
  };
  // 返回钮钉在标题栏最左 (标题前面), 不进右侧的按钮组 —— 标题写好之后再插进去。
  var bindBack = function () {
    var h = backBtn();
    if (h) $('#ch-who').insertAdjacentHTML('afterbegin', h);
    var b = $('#ch-jback');
    if (b) b.onclick = function () { var x = BACK; BACK = null; SESSION = x.session; selectConv(x.conv, x.with, restoreAt(x.at), x.viewpoint); };
  };
  // 一对一的标题: 与关系图卡片窗口 (convOf 的 a:) 同一种写法。
  var pairTitle = function (peer) { return nameOf(ROLE) + ' 与 ' + nameOf(peer) + ' 的对话'; };
  var renderHead = function () {
    var who = $('#ch-who'), acts = $('#ch-acts');
    if (VIEW === 'jobs') {
      who.innerHTML = '<span class="t">工单</span><span class="sub">' + (JOB_ONLY ? '这一处经手的 ' + jobListRows().length + ' 张' : esc(nameOf(ROLE)) + ' 开的或参与的') + ' · 进行中在前</span>';
      acts.innerHTML = '<button class="vb" id="ch-back">‹ 对话</button>';
      bindBack();
      $('#ch-back').onclick = function () { setView('msgs'); };
      return;
    }
    if (VIEW !== 'msgs') {
      who.innerHTML = VIEW === 'charter'
        ? '<span class="t">宪章</span><span class="sub">wezard 出生时压进 ' + esc(nameOf(ROLE)) + ' 系统提示的那份身份</span>'
        : '<span class="t">日程</span><span class="sub">' + esc(nameOf(ROLE)) + ' 名下的定时任务</span>';
      acts.innerHTML = '<button class="vb" id="ch-back">‹ 对话</button>';
      $('#ch-back').onclick = function () { setView('msgs'); };
      return;
    }
    var c = convOf(CONV);
    if (!c) { who.innerHTML = ''; acts.innerHTML = ''; return; }
    // 某 role 在一个群里的全部记录 (「chat 内全部」下与我无往来的子项): 顶栏只写它, 副标题「在 <群> 的全部对话」——
    // 与成对子项 (「我 ⇄ 它」) 一眼分得开。群名点回整个群。
    if (c.kind === 'all' && c.chat) {
      who.innerHTML = '<span class="t">' + nm(c.who, '', true) + '</span>' +
        '<span class="sub">在 <button type="button" class="up" id="ch-up" title="' + esc('看 ' + chatTitle(c.chat) + ' 的全部记录') + '">' + esc(chatTitle(c.chat)) + '</button> 的全部对话</span>';
      acts.innerHTML = '';
      bindGo(who);
      $('#ch-up').onclick = function () { selectConv('c:' + c.chat, ''); };
      return;
    }
    if (c.kind === 'all') {
      who.innerHTML = '<span class="t" title="' + esc(c.name) + '"></span>';
      acts.innerHTML = '';
      bindBack();
      fitTalk(who.querySelector('.t'), c);
      bindGo(who);
      return;
    }
    // 群里选中一个子项: 窗口是「我与它」在这个群里的往来, 顶栏同关系图卡片的窗口写成「我 与 它 的对话」, 不画头像;
    // 群名退到副标题, 点它 = 选回这个群本身 (整个群的视图)。
    if (WITH && c.kind === 'group') {
      var withName = pairTitle(WITH);
      who.innerHTML = '<span class="t" title="' + esc(withName) + '">' + esc(withName) + '</span>' +
        '<span class="sub">在 <button type="button" class="up" id="ch-up" title="' + esc('看 ' + c.name + ' 的全部记录') + '">' + esc(c.name) + '</button></span>';
      acts.innerHTML = '';
      bindBack();
      bindGo(who);
      $('#ch-up').onclick = function () { selectConv(CONV, ''); };
      return;
    }
    if (c.kind === 'job') {
      who.innerHTML = '<span class="av">📋</span><span class="t">' + jobCrumbs(c.key.slice(2)) + esc(c.name) + '</span>' +
        '<span class="sub">' + esc(c.key.slice(2)) + (c.job ? ' · 开单 ' + nm(c.job.owner, '', true) : '') + stageTag(c.job) + jobTag(c.job) + stuckTag(c.job) + '</span>';
      who.querySelectorAll('.jcrumb [data-job]').forEach(function (b) { b.onclick = function () { openJob(b.getAttribute('data-job')); }; });
      acts.innerHTML = '';
      bindBack();
      bindGo(who);
      return;
    }
    // 一对一 (私聊, 或群里「只看我与 X」) 与关系图卡片的窗口同一种写法: 「我 与 它 的对话」, 不画头像。
    var peer = pairPeer(c);
    var pairName = peer && pairTitle(peer);
    who.innerHTML = peer ? '<span class="t" title="' + esc(pairName) + '">' + esc(pairName) + '</span>'
      : '<span class="t">' + (c.kind === 'wizard' ? nm(c.peer, c.name, true) : '<span class="nm chat">' + esc(c.name) + '</span>') + '</span>';
    acts.innerHTML = '';
    bindBack();
    bindGo(who);
  };
  // 多人对话的标题放不下时, 收成「X 与 .a、.b、.c 等 N 个 role 之间的对话」—— 放得下几个列几个, 至少一个。
  // 量的是真宽度: 没上屏 (窄屏还停在列表) 量不出来, 就先给全称, 等 resize / 下一次重画。
  var fitTalk = function (el, c) {
    var n = c.peers.length;
    var at = function (k) {
      return k >= n ? c.name : nameOf(c.who) + ' 与 ' + c.peers.slice(0, k).map(nameOf).join('、') + ' 等 ' + n + ' 个 role 之间的对话';
    };
    var k = n;
    el.textContent = at(k);
    if (!el.clientWidth) return;
    while (k > 1 && el.scrollWidth > el.clientWidth + 1) el.textContent = at(--k);
  };
  window.addEventListener('resize', function () {
    var c = VIEW === 'msgs' && convOf(CONV);
    if (c && c.kind === 'all') renderHead();
  });

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
  // 消息上的工单 badge (服务端只写 data-job): 按此刻的账填成 📋 标题 + 进度, 点了进那张工单页。
  // 工单页自己的消息不挂 —— 点了还是这一页。
  var JOB_CHIP = /<button class="mchip job" data-job="([^"]*)"><\/button>/g;
  var jobChips = function (html) {
    return html.replace(JOB_CHIP, function (_, id) {
      if (CONV === 'j:' + id) return '';
      var c = jobRowOf(id);
      return '<button class="mchip job" data-job="' + id + '" title="' + esc(id + ' · ' + c.name + ' —— 进工单页') + '">📋 <span class="jt">' + esc(c.name) + '</span>' + jobTag(c.job) + '</button>';
    });
  };
  var refillJobChips = function () {
    inner.querySelectorAll('.mchip.job[data-job]').forEach(function (b) {
      b.outerHTML = jobChips('<button class="mchip job" data-job="' + b.getAttribute('data-job') + '"></button>');
    });
  };
  var rowHTML = function (m) {
    learn(m.from, m.fromName, m.fromLabel);
    learn(m.to, m.toName, m.toLabel);
    if (m.dir === 'mark') {
      return '<div class="mrow mark" data-id="' + esc(m.id) + '" data-turn="' + esc(m.turnId || m.id) + '" data-ts="' + m.ts + '" data-sig="' + esc(m.sig) + '">' + signCut(m.html, m.from) + '</div>';
    }
    var me = viewpointOf();
    var mine = m.from === me;
    var other = mine ? m.to : m.from;
    // 看 key 而不是会话列表: 换视角就地重包时, 列表还是上一个 role 的。
    var group = CONV.indexOf('p:') !== 0;
    // 顶栏那个对端是相对 ROLE 的; 详情区的 viewpoint 换成了它时, 它的对端就是 ROLE。
    var peer = group ? pairPeer(convOf(CONV)) : CONV.slice(2);
    if (VIEWPOINT && peer === VIEWPOINT) peer = ROLE;
    // 说给谁: 群里我不是收信方的那条 (X → Y); 我发的那条, 收信方不是顶栏那个对端时
    // (一对一里收信方就是顶栏那个对端, 不再重复写)。
    var dst = mine
      ? (m.to && m.to !== 'human:' && m.to !== peer ? m.to : '')
      : (m.to !== me && group ? m.to : '');
    // 说给谁画进文本泡泡开头 (头像 + 名字); 点它走移交行同一套跳转 (data-hfrom/hto/hch + gid/gts), 不换页面视角。
    var toIn = dst
      ? '<span class="to-in" role="button" tabindex="0" data-hfrom="' + esc(m.from) + '" data-hto="' + esc(m.to) + '" data-hch="' + esc(m.channel || '') +
        '" data-gid="' + esc(m.id) + '" data-gts="' + m.ts + '" title="' + esc('发给 ' + nameOf(m.to) + ' —— 看这段往来') + '"><span class="av">' +
        esc(roleLabel(m.to)) + '</span><span class="nm ' + kindOf(m.to) + '">' + esc(nameOf(m.to)) + '</span></span>'
      : '';
    var withTo = function (html) {
      if (!toIn) return html;
      // 只挂进这条消息自己的正文: 移交体也是 .md-body, 但它发给被移交的那个 wizard, 服务端已挂好它自己的 .to-in。
      var t = document.createElement('template');
      t.innerHTML = html;
      var body = [].find.call(t.content.querySelectorAll('.q-body, .md-body'), function (b) { return !b.closest('.handoff'); });
      if (!body) return '<div class="to-row">' + toIn + '</div>' + html;
      body.insertAdjacentHTML('afterbegin', toIn);
      return t.innerHTML;
    };
    var priv = !m.channel && group ? '<span class="ch priv">私聊</span>' : '';
    // 本轮的账 (呼吸点 + 模型 / 上下文 / 耗时) 跟在时刻后面 —— 片段是服务端渲染好的。
    // 模型 / ctx 只在多方会话里有用 (分得清谁跑的什么模型); 两个 role 之间的对话里整行挂 .two, 头像行 (.mstat)、
    // 终句气泡的时间行 (.say-cap) 与移交行的账 (.ho-acct) 里藏掉这两样, 耗时、呼吸点与回执留着。
    var c = convOf(CONV);
    var two = !group || !!pairPeer(c) || (!!c && c.kind === 'all' && c.peers.length === 1);
    var stat = m.meta ? '<span class="mstat">' + jobChips(m.meta) + '</span>' : '';
    var who = mine
      ? stamp(m.ts) + stat + avBtn(m.from)
      : avBtn(m.from) + nm(m.from, '', true) + priv + stamp(m.ts) + stat;
    var sw = canSwitch(other);
    var flip = '<button class="flip" data-r="' + esc(other) + '"' + (sw ? '' : ' disabled tabindex="-1"') +
      ' aria-label="' + esc(sw ? '切到 ' + nameOf(other) + ' 的视角' : '') + '">' +
      (sw ? '<span class="fi"><span class="fn">' + esc(nameOf(other)) + '</span>' + CHEVRON + '</span>' : '') + '</button>';
    return '<div class="mrow ' + (mine ? 'mine' : 'them') + (two ? ' two' : '') + '" data-id="' + esc(m.id) + '" data-turn="' + esc(m.turnId || m.id) + '" data-ts="' + m.ts + '"' +
      (m.ping ? ' data-ping="1" data-ping-who="' + esc(roleName(m.dir === 'in' ? m.to : m.from)) + '"' : '') + ' data-sig="' + esc(m.sig) + '" data-stale-at="' + (m.staleAt || 0) + '">' +
      '<div class="mcol"><div class="mwho">' + who + '</div><div class="mb">' + jobChips(withTo(m.dir === 'out' ? signCut(m.html, m.from) : m.html)) + '</div></div>' +
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
    bindGo(el, '.flip[data-r]:not([disabled]), .mwho .go[data-r], .tg-cut .go[data-r], .tg-mark .go[data-r], .tg-job .go[data-r]');
    // 定时行开的是页面视角自己的日程: 片段不随视角 (服务端只标发话方), 能不能点在这里按 ROLE 定;
    // 别人的那行不可点, 只剩 chevron 展开 prompt。换视角就地重包时也走这里。
    el.querySelectorAll('.handoff .ho-line[data-hplan]').forEach(function (b) {
      var mine = b.getAttribute('data-hplan') === ROLE;
      b.classList.toggle('plan-go', mine);
      if (mine) b.title = '打开 ' + nameOf(ROLE) + ' 的日程'; else b.removeAttribute('title');
    });
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
      // 游标切不出「之前」(服务端回 reset): 退回整窗全量重载, 视口照旧锚住。
      if (d.reset) return loadMsgs('0', keep);
      var old = $('#more'); if (old) old.remove();
      // 按时刻兜底的那一页可能带回同一毫秒、已经画着的几条 —— 按 id 去重。
      var fresh = d.msgs.filter(function (m) { return !rowNode(m.id); });
      fresh.forEach(function (m) { S.frags[m.id] = m; });
      unfoldPings(inner);
      var page = frag(moreBtn(d) + fresh.map(rowHTML).join(''));
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
      settleAbove();
      applyFold(inner);
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
    settleAbove();
    applyFold(inner);
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
      // 静默到点 = 这一轮结束, 末尾那个过程框也不再是「进行中」。
      g.querySelectorAll('.steps').forEach(settle);
      applyFold(g);
    });
  };

  // ── role 摘要 ──
  var applyRole = function (d) { takeRole(d); paintRole(); };
  // 收下摘要 (视角、会话列表、落地窗口) 与按它画页头侧栏分开: 换视角整窗重拉时, 画要等到新行到手的同一帧。
  var takeRole = function (d) {
    R.at = d.at || Date.now(); R.recvAt = Date.now();
    if (!BASE) BASE = R.at;
    R.role = d.role; R.sessions = d.sessions || []; R.convs = d.convs || []; R.chatKeys = d.chatKeys;
    SESSION = d.session || '';
    R.relations = !!d.relations; R.schedules = d.schedules || 0; R.plan = d.plan || null; R.inflight = d.inflight || [];
    // 工单的账变了 (或比消息晚到): 已上屏的工单 badge 按新账重填一遍 —— 片段里只写了工单号。
    var jx = JSON.stringify(d.jobIndex || {});
    if (jx !== R.jobIndexSig) { R.jobIndexSig = jx; R.jobIndex = d.jobIndex || {}; refillJobChips(); }
    R.charter = d.charter || null;
    R.stats = d.stats || null; R.winStats = d.winStats || null;
    ROLE = d.role.id;
    var renamed = [learn(d.role.id, d.role.name, d.role.label, true)].concat.apply([], R.convs.map(function (c) {
      return [c.peer ? learn(c.peer, c.name, c.label, true) : false].concat(c.subs.map(function (s) { return learn(s.role, s.name, s.label, true); }));
    })).some(Boolean);
    // 名册晚到 (svr 刚起) 或有人改了名: 已上屏的行按新名字就地重包, 正文不动。
    if (renamed && inner.querySelector('.mrow')) rewrapRows(false);
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
      if (restoreSess()) return refresh(land);
      syncUrl();
      if (WORLD || VIEW === 'plan') loadWorld();
      if (VIEW === 'charter') loadCharter();
      return loadMsgs(undefined, land && function () { paintRole(); return land(); }).then(function () {
        if (land && !inner.querySelector('.mrow')) paintRole();   // 空窗口不走 land, 页头照样要画
        connect();
      });
    });
  };

  // land: 见 loadMsgs —— 搜索跳到一条具体消息时由它来定位, 不吸底。
  var selectConv = function (key, withRole, land, viewpoint) {
    CONV = key; WITH = withRole || ''; VIEWPOINT = viewpoint && viewpoint !== ROLE ? viewpoint : '';
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
    // 群里「我与 X」时换到 X, 对面看到的是「X 与 from」—— 同一段往来, 选中这一对而不是整个群。
    var withBack = keep && WITH === id ? from : '';
    // 整个频道 / 两人私聊 / 群里的一对, 消息集合都与视角无关 —— 集合没变就就地翻面。
    var same = VIEW === 'msgs' && (!WITH || withBack) && !SESSION && (keep || CONV.indexOf('p:') === 0);
    ROLE = id; WITH = withBack; SESSION = ''; VIEWPOINT = '';
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
  /** 已上屏的行拿手里的片段就地重包 (左右、署名), 已渲染的正文整块搬过去。dropMarks: 断点一并撤下。 */
  var rewrapRows = function (dropMarks) {
    unfoldPings(inner);
    [].slice.call(inner.querySelectorAll('.mrow')).forEach(function (row) {
      var m = S.frags[row.getAttribute('data-id')];
      if (!m || (dropMarks && m.dir === 'mark')) { if (dropMarks) row.remove(); return; }
      var next = frag(rowHTML(m)).firstElementChild;
      var ob = row.querySelector('.mb'), nb = next.querySelector('.mb');
      if (ob && nb) nb.replaceWith(ob);
      row.replaceWith(next);
      bindRow(next);
    });
    foldPings(inner);
    expireRows();
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
      // 断点 (/clear /new) 是旧视角 role 自己的, 新视角的由下面补拉。
      rewrapRows(true);
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
    // 生它、归它管的那一位下面挂的是 clone (带上下文) 或 spawn (白板) —— 与调用框下的提示行同一套字。
    // clone 徽标点了落到 origin 里的分叉处。
    clone: { mark: 'clone', tip: 'clone_wizard 生的分身: fork 了上下文, 开局带着那一刻读过的一切; 归生它的那位管 —— 点了看它在哪一处分叉' },
    spawn: { mark: 'spawn', tip: 'spawn_wizard / dispatch 白板生的: 不继承上下文, 只是归生它的那位管 (不带 detached)' },
    fork: { mark: '⑂ 上下文', tip: '分身的上下文 fork 自它 —— 生它、归它管的是另一位' },
    peer: { mark: '💬', tip: 'send_peer 发起的对话' },
    job: { mark: '工单', tip: '它开的工单里有这位成员' },
    graph: { mark: '流水线', tip: '流水线里上一步喂给下一步' },
  };
  var LINEAGE = { spawn: 1, clone: 1, fork: 1 };

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
    var cut = winCut();
    return s ? { from: Math.max(s.start, cut), to: s.end || Infinity, s: s } : cut ? { from: cut, to: Infinity, s: null } : null;
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
      return { kind: e.kind, from: e.from, to: e.to, cross: e.cross, jobs: e.jobs || [], ts: e.ts && e.ts.length ? e.ts : [e.lastTs], point: e.point };
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
      if (e.point) p.point = e.point;
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
    // 主父亲: 生它的那位 (spawn / clone) 先于上下文来源 (fork), 再先于派活。
    var weight = function (p) { return (p.kinds.spawn || p.kinds.clone ? 3e6 : p.kinds.fork ? 2e6 : 0) + p.n; };
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
    // 人直接对 wizard 说话的那条边不是它的主父亲 (主父亲多是生它的那位) 时, 在人下面再挂一张它的引用卡:
    // 同一个节点、同一个窗口, 只是承载的是人 → 它这条边; 引用卡不再往下展开 (后代在它的本位上画)。
    var refs = list.filter(function (p) { return kindOf(p.from) === 'human' && pp[p.to] !== p; })
      .reduce(function (m, p) { (m[p.from] = m[p.from] || []).push(p); return m; }, {});
    return { pairs: pairs, inc: inc, pp: pp, kids: kids, refs: refs, roots: roots, ends: ends };
  };

  // F.vis: 只看相关时画哪些 (见 visibleOf); 没有 = 全画。
  var shows = function (F, t) { return !F.vis || !!F.vis[t]; };
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
      // 工单这一种关系由 📋 那一枚说 (可点, 列的就是这几张), 不再另挂「工单 ×N」重复一遍。
      Object.keys(KIND).filter(function (k) { return p.kinds[k] && !(k === 'job' && p.jobs.length); }).map(function (k) {
        return '<span class="ek ' + k + '"' + (k === 'clone' && p.point ? ' data-cpoint="' + esc(JSON.stringify(p.point)) + '"' : '') + ' title="' + KIND[k].tip + '">' + KIND[k].mark +
          (!LINEAGE[k] ? ' ' + p.kinds[k] : '') + '</span>';
      }).join('') +
      (p.cross ? '<span class="ek cross" title="跨群的关系">⇄ 跨群</span>' : '') +
      (p.jobs.length ? '<span class="ek jmk" data-jobs="' + esc(p.jobs.join(' ')) + '" title="' + esc('经手的工单: ' + p.jobs.join(' ') + ' —— 点开') + '">📋' + (p.jobs.length > 1 ? ' ' + p.jobs.length : '') + '</span>' : '') + '</span>';
  };
  // 一条边的主色: 家谱优先, 决定树上那道线的颜色。
  var domKind = function (p) {
    return !p ? 'root' : ['spawn', 'clone', 'fork', 'peer', 'job', 'graph'].filter(function (k) { return p.kinds[k]; })[0] || 'peer';
  };

  // ── 卡片承载指进来的那条边 (主父亲 → 它): 预览取视角与对端在侧栏里现成的那一项 ──
  var edgeEnds = function (F, t, p) { p = p || F.pp[t]; return p ? [p.from, t] : [t]; };
  // 视角 role 与 other 之间的那一项: 私聊优先, 否则挑最近说过话的那个群里的「只看我与它」。
  var pairConv = function (other) {
    if (convOf('p:' + other)) return ['p:' + other, ''];
    var hit = R.convs.filter(function (c) { return c.kind === 'group'; }).map(function (c) {
      return [c, (c.subs || []).filter(function (x) { return x.role === other && x.count; })[0]];
    }).filter(function (x) { return x[1]; }).sort(function (a, b) { return b[1].lastTs - a[1].lastTs; })[0];
    return hit ? [hit[0].key, dmOf(hit[0]) ? '' : other] : null;
  };
  // 视角这一端与边另一端之间、侧栏里现成的那一项 (视角不在边上 / 这段里没说过话 = 没有)。
  var edgeConv = function (F, t, e) {
    var ends = edgeEnds(F, t, e);
    var other = ends.length === 2 && ends.indexOf(ROLE) >= 0 && ends.filter(function (x) { return x !== ROLE; })[0];
    return other ? pairConv(other) : null;
  };
  // 点任何一张卡片 (视角自己也一样) 看的窗口: 它与图上和它相连的那几个 role 之间的对话。整页视角不换,
  // 只有详情区的 viewpoint 站到被点的那个 role 上: 这段往来是它的, 它说的靠右。侧栏子项是页面视角自己与对端的那一对, 不带 viewpoint。
  // links = 这一次画出来的树里, 它的父亲与孩子 (见 linksOf); 一个都没连着 = 它的全部对话。
  var talkKey = function (links, t) {
    var ls = links[t] || [];
    return 'a:' + t + (ls.length ? '|' + ls.join(',') : '');
  };
  // 图上相连 = 画出来的边: 它的父亲 + 它的孩子 + 引用卡两端 (人 ↔ 它), 两端都画出来了才算。
  var linksOf = function (F, shown) {
    var on = shown.reduce(function (m, n) { m[n.target] = 1; return m; }, {});
    var refIn = Object.keys(F.refs).reduce(function (m, h) {
      F.refs[h].forEach(function (p) { (m[p.to] = m[p.to] || []).push(h); });
      return m;
    }, {});
    var refOut = function (t) { return (F.refs[t] || []).map(function (p) { return p.to; }); };
    return shown.reduce(function (m, n) {
      var t = n.target, p = F.pp[t];
      m[t] = (p && on[p.from] ? [p.from] : []).concat(F.kids[t] || [], refIn[t] || [], refOut(t))
        .filter(function (k, i, a) { return on[k] && a.indexOf(k) === i; });
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
  var cardGlance = function (F, t, e) {
    var hit = edgeConv(F, t, e), c = hit && convOf(hit[0]);
    var s = c && hit[1] && (c.subs || []).filter(function (x) { return x.role === hit[1]; })[0];
    var n = nodeOf(t) || {}, p = e || F.pp[t];
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
  // 关系图: 它与 N 个 role 有关系, 但它们的卡片不在这一档画出来的图上 (画着就不算, 连没连线都一样)。
  // 关系 = 服务端裁节点之前的全部对端 (node.rels) ∪ 这段范围里画得出的边 —— 前者补上没下发的节点,
  // 后者兜住老 svr 没给 rels 的情况。F.on = 这一档画出来的卡片, 「相关 | 全部」各算各的。
  var otherRels = function (F, t) {
    var on = F.on || {};
    var all = Object.keys(F.pairs).reduce(function (m, k) {
      var p = F.pairs[k], o = p.from === t ? p.to : p.to === t ? p.from : '';
      if (o) m[o] = 1;
      return m;
    }, ((nodeOf(t) || {}).rels || []).reduce(function (m, o) { m[o] = 1; return m; }, {}));
    var n = Object.keys(all).filter(function (o) { return o !== t && !on[o]; }).length;
    return moreTag(n, nameOf(t) + ' 还和 ' + n + ' 个 role 有关系, 不在这张图上, 切到它的视角可见');
  };
  // e = 引用卡承载的那条边 (人 → 它); 没有 = 本位卡片, 承载主父亲边。
  var tnodeHTML = function (F, n, e) {
    var me = n.target === ROLE;
    var p = e || F.pp[n.target];
    var row = roleRow(n.target, n.name, n.label, cardGlance(F, n.target, e), n, '', otherRels(F, n.target));
    var via = F.vis && F.vis[n.target] === 'via';
    var jin = F.job && (F.job.in[n.target] ? ' jin' : ' jout');
    return '<button class="ci tci' + (me ? ' me' : '') + (e ? ' ref' : '') + (via ? ' via' : '') + (n.ghost ? ' ghost' : '') + (jin || '') + (F.links && CONV === talkKey(F.links, n.target) ? ' on' : '') + '" data-t="' + esc(n.target) + '"' +
      (n.ghost ? ' title="' + esc(nameOf(n.target) + ' 已停且没有记录, 这里只是占位, 代表它挂着下面的后代') + '"' : via ? ' title="' + esc(nameOf(n.target) + ' 和 ' + nameOf(ROLE) + ' 没有直接关系, 留着是为了连到它下面有关系的') + '"' : '') + '>' +
      labelHTML(p) + row + '</button>';
  };

  // 只画 F.vis 里的 (没有 = 全画)。shown 收集画出来的节点。
  var treeHTML = function (F, t, depth, shown, seen, z) {
    var n = nodeOf(t);
    if (!n || seen[t] || depth > 32) return '';
    seen[t] = 1;
    shown.push(n);
    // 孩子 = 本位的主孩子 + 引用卡 (它是人时, 它直接说过话、但主父亲另有其人的 wizard), 一起按卡片时刻排。
    var kids = (F.kids[t] || []).filter(function (k) { return shows(F, k); }).map(function (k) { return { t: k }; })
      .concat((F.refs[t] || []).filter(function (p) { return shows(F, p.to) && nodeOf(p.to); }).map(function (p) { return { t: p.to, e: p }; }))
      .sort(function (a, b) { return recentFirst(cardGlance(F, a.t, a.e), cardGlance(F, b.t, b.e)); });
    // 选中工单时: 两端都是它的当事人 (含开单者) 的那道线才亮。
    var jl = function (u, p) { return F.job ? (F.job.in[u] && p && F.job.in[p.from] ? ' jline' : ' jdim') : ''; };
    var zs = function (z) { return z ? ' style="z-index:' + z + '"' : ''; };
    return '<li class="' + domKind(F.pp[t]) + jl(t, F.pp[t]) + '"' + zs(z) + '>' + tnodeHTML(F, n) +
      // 兄弟的线共用一段竖干, 越往下的越长: 短的叠在上面 (z 随序号递减), 每条线的末段都看得见自己的颜色。
      (kids.length ? '<ul>' + kids.map(function (k, i) {
        return k.e
          ? '<li class="' + domKind(k.e) + jl(k.t, k.e) + '"' + zs(kids.length - i) + '>' + tnodeHTML(F, nodeOf(k.t), k.e) + '</li>'
          : treeHTML(F, k.t, depth + 1, shown, seen, kids.length - i);
      }).join('') + '</ul>' : '') +
      '</li>';
  };
  // 关系图替换的是侧栏的会话列表 —— 右边照旧是选中的那段对话。
  // 只看相关时画谁: 视角自己 + 和视角有直接关系的 (任一种, 任一方向; 'rel'); 它们通向根的主父亲链上
  // 与视角无关的祖先留作连接 ('via', 画淡) —— 抹掉它, 有关系的后代就从家谱上脱开, 成了一棵来历不明的孤树。
  var visibleOf = function (F) {
    // 相关 = 沿关系边 (任一种, 任一方向) 一路走得到的整个连通块, 不止一跳: 间接、多跳的也展开。
    var nbr = Object.keys(F.pairs).reduce(function (m, k) {
      var p = F.pairs[k];
      (m[p.from] = m[p.from] || []).push(p.to);
      (m[p.to] = m[p.to] || []).push(p.from);
      return m;
    }, {});
    var reach = function (seen, frontier) {
      if (!frontier.length) return seen;
      var next = frontier.reduce(function (acc, t) {
        (nbr[t] || []).forEach(function (o) { if (!seen[o]) { seen[o] = 1; acc.push(o); } });
        return acc;
      }, []);
      return reach(seen, next);
    };
    var linked = reach((function (o) { o[ROLE] = 1; return o; })({}), [ROLE]);
    var keep = Object.keys(F.ends).filter(function (t) { return t === ROLE || linked[t]; });
    var vis = keep.reduce(function (m, t) { m[t] = 'rel'; return m; }, {});
    if (!vis[ROLE]) vis[ROLE] = 'rel';
    keep.forEach(function (t) { chainUp(F, t).forEach(function (u) { if (!vis[u]) vis[u] = 'via'; }); });
    return vis;
  };

  // 正在看一张工单 (CONV = j:<id>) 时, 它的当事人; 选中态就是 CONV 本身, 不另记一份。
  var jobOfConv = function () {
    var id = CONV.indexOf('j:') === 0 ? CONV.slice(2) : '';
    var j = id && (W.jobs || []).filter(function (x) { return x.id === id; })[0];
    return j ? { id: id, in: j.members.reduce(function (m, mm) { m[mm.target] = 1; return m; }, (function (o) { o[j.owner] = 1; return o; })({})) } : null;
  };

  var renderWorld = function () {
    if (!WORLD) return;
    if (!W.loaded) { convsEl._tree = ''; convsEl.innerHTML = '<div class="empty">加载中…</div>'; return; }
    var rg = rangeOf();
    var F = forestOf(relations(rg));
    F.job = jobOfConv();
    var me = nodeOf(ROLE);
    // 只画相关的 (visibleOf); 视角不是图上的节点 (没有关系可言) 才全画。
    var all = !me;
    var shown = [];
    var path = me ? chainUp(F, ROLE) : [];
    F.vis = all ? null : visibleOf(F);
    var draw = function (into) {
      return F.roots.filter(function (r) { return shows(F, r); }).sort(function (a, b) {
        var mine = path[0];
        return (b === mine) - (a === mine) || byCard(F)(a, b);
      }).map(function (r) { return treeHTML(F, r, 0, into, {}); }).join('');
    };
    // 两遍: 先量出画了谁 (卡片的窗口要知道它在图上连着谁), 再带着连线画 —— 选中态也就进了 html。
    draw(shown);
    F.links = linksOf(F, shown);
    F.on = shown.reduce(function (m, n) { m[n.target] = 1; return m; }, {});
    var keys = shown.map(function (n) { return talkKey(F.links, n.target); }).join('\n');
    if (keys !== W.gKeys) { W.gKeys = keys; loadGlance(); }
    // 换视角后的第一张新树: 世界快照与摘要都已是新视角的, 才知道它自己那张卡片连着谁。
    if (W.pickSelf === ROLE && W.role === ROLE && R.role && R.role.id === ROLE) {
      W.pickSelf = '';
      var self = talkKey(F.links, ROLE);
      if (CONV !== self) return selectConv(self, '');
    }
    var trees = draw([]);
    var span = rg ? (!rg.s ? '最近' + (WINS.filter(function (w) { return w[0] === WIN; })[0] || [0, ''])[1] : rg.s === R.sessions[R.sessions.length - 1] ? '最新 session' : 'session ' + fmtClock(rg.from)) : '';
    var alone = !all && shown.length < 2;
    var html = '<div class="tview">' +
      '<h2>关系<span title="在名片里的 session 下拉切换范围">' + (span ? esc(span) + ' · ' : '') + (all ? Object.keys(F.ends).length : shown.length) + ' 个</span>' +
        (W.degraded ? '<span class="warn" title="没拿到 wizard 注册表 (svr 还没收到 daemon 的快照), 只画观测到的往来">名册缺席</span>' : '') +
        winSelect() + worldToggle() + '</h2>' +
      (alone ? '<div class="tsolo">' + esc(nameOf(ROLE)) + (rg ? ' 在这段 session 里' : '') + ' 没和谁有关系</div>' : '') +
      (shown.length ? '<ul class="tree' + (all ? ' all' : '') + (F.job ? ' jsel' : '') + '">' + trees + '</ul>' : '<div class="pempty">这段时间里没有任何关系</div>') +
    '</div>';
    // 心跳每 3s 重算一次 (状态灯 / 几分钟前) —— 没变就不碰 DOM, 免得蹭掉悬停与滚动。
    if (convsEl._tree === html && convsEl.querySelector('.tview')) return;
    convsEl._tree = html; convsEl._html = '';
    convsEl.innerHTML = html;
    convsEl.querySelectorAll('.tci').forEach(function (el) {
      el.onclick = function () { var t = el.getAttribute('data-t'); clickItem(talkKey(F.links, t), '', t); };
    });
    bindGo(convsEl);
    bindWorldToggle(convsEl); bindWin(convsEl);
    var cur = convsEl.querySelector('.tci.me:not(.ref)');
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

    var html = stats +
      '<section class="psec">' +
        '<h3>定时任务<span>' + ss.length + '</span></h3>' +
        (ss.length ? renderStrip(ss) + bad.concat(ss.filter(function (x) { return !broken(x); })).map(taskHTML).join('')
          : '<div class="pempty">' + esc(roleName(ROLE)) + ' 名下没有定时任务 —— 让它 schedule_task 排一个</div>') +
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
    if (VIEW !== 'plan' && !WORLD) return;
    worldTimer = setInterval(function () {
      if (!document.hidden) loadWorld();
    }, WORLD_MS);
  };

  var setView = function (v) {
    VIEW = v;
    thread.hidden = v !== 'msgs';
    $('#pane-plan').hidden = v !== 'plan';
    charterPane().hidden = v !== 'charter';
    jobsPane().hidden = v !== 'jobs';
    app.classList.toggle('outer', v !== 'msgs');
    // 手机上关系/日程占满主区 —— 进入即阅读态。
    if (v !== 'msgs') app.classList.add('reading');
    renderRole(); renderHead(); renderUsage();
    if (v === 'msgs') { toBottom(true); renderConvs(); }
    else if (v === 'charter') loadCharter();
    else if (v === 'jobs') renderJobList();
    else {
      if (!W.loaded) { planEl._html = ''; planEl.innerHTML = '<div class="empty">加载中…</div>'; }
      else renderPlan();
      loadWorld();
    }
    pollWorld();
  };
  // ── 宪章: 出生快照, 不轮询 —— 换视角或重新点开时取一次。 ──
  // 面板由脚本挂载: 外壳 HTML 要等服务重启才换, 老外壳里没有这一格。
  var charterPane = function () {
    var p = $('#pane-charter');
    if (p) return p;
    p = document.createElement('div');
    p.className = 'pane'; p.id = 'pane-charter'; p.hidden = true;
    p.innerHTML = '<div class="plan-in" id="charter-in"></div>';
    $('#pane-plan').after(p);
    return p;
  };
  var jobsPane = function () {
    var p = $('#pane-jobs');
    if (p) return p;
    p = document.createElement('div');
    p.className = 'pane'; p.id = 'pane-jobs'; p.hidden = true;
    p.innerHTML = '<div class="plan-in jlist" id="jobs-in"></div>';
    $('#pane-plan').after(p);
    return p;
  };
  // 视角开的或在里面的工单: 进行中 (最近有动静的在前) / 已收工 (淡一档, 最近收的在前)。一行与会话列表同一个 convItem。
  var renderJobList = function () {
    var el = jobsPane().firstChild;
    var js = jobListRows();
    // 视角里没有的祖先也照账补上, 树才连得起来 (JOB_ONLY 是点名的几张, 不补)。
    if (!JOB_ONLY) js = js.concat(js.reduce(function (a, c) {
      return a.concat(jobAncestors(c.job.id).filter(function (id) { return !js.some(function (x) { return x.job.id === id; }); }));
    }, []).filter(function (id, i, a) { return a.indexOf(id) === i; }).map(jobRowOf).filter(function (c) { return c.job; }));
    var open = js.filter(function (c) { return c.job.status === 'open'; }).sort(recentFirst);
    var closed = js.filter(function (c) { return c.job.status !== 'open'; }).sort(recentFirst);
    var sec = function (title, list, cls) {
      return '<h2>' + title + '<span>' + list.length + '</span></h2>' + '<div class="' + cls + '">' + jobTreeOrder(list).map(function (x) { return x.d ? '<div class="jind" style="margin-left:' + (x.d * 16) + 'px">' + convItem(x.c) + '</div>' : convItem(x.c); }).join('') + '</div>';
    };
    var html = js.length
      ? sec('进行中', open, 'jopen') + (closed.length ? sec('已收工', closed, 'jclosed') : '')
      : JOB_ONLY
        ? '<div class="pempty">这几张工单已经不在账上了 (收工满 24 小时会清掉) —— ' + esc(JOB_ONLY.join(' ')) + '</div>'
        : '<div class="pempty">' + esc(nameOf(ROLE)) + ' 没有开过、也不在任何工单里 —— 一次派出两个以上 wizard 时 open_job 开一个 (收工满 24 小时的不再列出)</div>';
    if (el._html === html) return;
    el._html = html; el.innerHTML = html;
    el.querySelectorAll('[data-conv]').forEach(function (b) { b.onclick = function () { selectConv(b.getAttribute('data-conv'), ''); }; });
  };
  var loadCharter = function () {
    var el = charterPane().firstChild, asked = ROLE;
    el.innerHTML = '<div class="empty">加载中…</div>';
    return api('api/charter', { role: asked }).then(function (d) {
      if (asked !== ROLE || VIEW !== 'charter') return;
      el.innerHTML = d.ok && !d.none ? charterHTML(d) : '<div class="empty">' + esc(roleName(asked)) + ' 没有宪章记录 (人, 或在这项记录出现前出生、还没重生过的 wizard)</div>';
      bindCharter(el);
    }).catch(function () { el.innerHTML = '<div class="empty">载入失败</div>'; });
  };
  var charterHTML = function (d) {
    var stat = function (k, v, sub) {
      return '<div class="pst"><span class="k">' + k + '</span><b>' + v + '</b><span class="s" title="' + esc(sub) + '">' + esc(sub) + '</span></div>';
    };
    var b = d.baseline;
    var max = Math.max.apply(null, d.sections.map(function (x) { return x.tokens; }));
    var big = d.sections.filter(function (x) { return x.tokens === max; })[0];
    var pct = function (n) { return Math.round(100 * n / d.tokens) + '%'; };
    var mdOk = mdReady();
    // 组成条: 一节一段, 宽度按体量 —— 一眼看出谁在吃宪章; 最大那节加深, 与下面的行同色。
    var mix = '<div class="cmix">' + d.sections.map(function (x) {
      return '<i class="' + (x === big ? 'top' : '') + '" style="flex:' + x.tokens + '" title="' + esc(x.title + ' ≈' + fmtTok(x.tokens) + ' · ' + pct(x.tokens)) + '"></i>';
    }).join('') + '</div>';
    var sec = function (x) {
      return '<details class="csec' + (x === big ? ' top' : '') + '"><summary><span class="ct">' + esc(x.title) + '</span>' +
        '<span class="cbar"><i style="width:' + Math.round(100 * x.tokens / max) + '%"></i></span>' +
        '<span class="cn">≈' + fmtTok(x.tokens) + '<small>' + pct(x.tokens) + '</small></span></summary>' +
        '<div class="md-body">' + (mdOk ? md.render(x.body) : '<pre>' + esc(x.body) + '</pre>') + '</div></details>';
    };
    // 没有实测底座就不摆一张「—」: 换成最大的那一节, 同样回答「钱花在哪」。
    var right = b
      ? stat('开局实测', fmtTok(b.ctx), (b.resumed ? '续接的老会话, 含此前对话 · ' : '') + '此后首轮第一次调用送入的上下文') +
        stat('宪章占开局', Math.round(100 * d.tokens / b.ctx) + '%', '其余是 CLI 系统提示、工具、CLAUDE.md、skills 与第一句话')
      : stat('最大一节', pct(max), big.title + ' ≈' + fmtTok(max));
    return '<div class="pstats">' +
        stat('宪章', '≈' + fmtTok(d.tokens) + '<small> tokens</small>', fmtClock(d.at) + ' 压进系统提示 · 随进程终身不变') + right +
      '</div>' +
      '<section class="psec"><h3>按节<span>' + d.sections.length + ' 节</span>' +
        '<button class="cx" id="charter-all">全部展开</button></h3>' +
        mix + d.sections.map(sec).join('') + '</section>';
  };
  var bindCharter = function (el) {
    var btn = el.querySelector('#charter-all');
    if (!btn) return;
    var all = function () { return el.querySelectorAll('.csec'); };
    var sync = function () { btn.textContent = [].every.call(all(), function (x) { return x.open; }) ? '全部收起' : '全部展开'; };
    btn.onclick = function () { var open = btn.textContent === '全部展开'; all().forEach(function (x) { x.open = open; }); sync(); };
    all().forEach(function (x) { x.ontoggle = sync; });
  };

  // 侧栏换成关系图 / 换回会话列表。换回时选中的仍是在关系图里点开的那一项, 并把它滚进视野。
  var setWorld = function (on) {
    WORLD = on; W.treeFor = ''; W.pickSelf = '';
    setPref(WORLD_KEY, on);
    convsEl._html = convsEl._tree = '';
    syncUrl();
    // 手机上侧栏与主区二选一 —— 开关在侧栏里, 结果也在侧栏里。
    if (on) app.classList.remove('reading');
    renderRole(); renderHead();
    if (on) { renderWorld(); loadWorld(); }
    else {
      // 选中的子项得露出来: 群展开, 排在折叠条后面的连折叠条一起展开。
      var c = convOf(CONV);
      if (c) {
        OPEN[CONV] = true; OPEN_AT = CONV; saveOpen();
        var rank = c.subs.filter(function (x) { return x.count; }).map(function (x) { return x.role; }).indexOf(WITH);
        if (rank >= SUB_FOLD) setMore(CONV, true);
      }
      renderConvs();
      var sel = convsEl.querySelector('.si.on') || convsEl.querySelector('.ci.on');
      if (sel) sel.scrollIntoView({ block: 'nearest' });
    }
    pollWorld();
  };
  // 进行中那一轮的耗时: 服务端只给开始时刻, 这里每秒按它走表 (取整秒, 免得小数位抖)。
  var tickDur = function () {
    document.querySelectorAll('.tg-dur.live[data-since]').forEach(function (el) {
      var ms = Math.max(0, srvNow() - Number(el.getAttribute('data-since')));
      el.textContent = fmtDur(Math.floor(ms / 1000) * 1000);
    });
  };
  setInterval(tickDur, 1000);
  // 本地心跳: 相对时间、运行中判定、耗时都随时间变化, 但服务端没有新事件可推。
  setInterval(function () {
    if (!R.role) return;
    renderUsage();
    expireRows();
    // 侧栏的「几分钟前」与状态灯: 内容没变时 renderConvs 不碰 DOM。
    paintStatus(); renderConvs();
    if (VIEW === 'plan') renderPlan();
    if (VIEW === 'jobs') renderJobList();
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
        '<span class="tag">' + (c.kind === 'wizard' ? '私聊' : c.kind === 'job' ? '工单' : '群聊') + '</span>' + skTs(c.lastTs) + '</span>' +
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
  // 落到一行里的某一次工具调用 (`use`): 它所在的过程框摊开, 调用框滚到中间闪一下。
  var focusUse = function (id, use) {
    if (!focusRow(id)) return false;
    var b = use && rowNode(id).querySelector('[data-use="' + cssEsc(use) + '"]');
    if (!b) return true;
    var g = b.closest('.steps');
    if (g) { g.classList.remove('folded'); FOLD[g.getAttribute('data-key')] = false; }
    b.scrollIntoView({ block: 'center' });
    S.pinned = atBottom();
    b.classList.remove('hit'); void b.offsetWidth; b.classList.add('hit');
    return true;
  };
  var landOn = function (id, use) {
    return function () {
      if (focusUse(id, use)) return true;
      loadMsgs('0', function () { return focusUse(id, use); });
      return true;
    };
  };
  var jumpMsg = function (h) {
    if ((!h.id || inSession(h.ts)) && convOf(h.conv)) return selectConv(h.conv, h.with || '', h.id ? landOn(h.id, h.use) : undefined, h.viewpoint);
    SESSION = 'all'; CONV = h.conv; WITH = h.with || ''; VIEWPOINT = h.viewpoint && h.viewpoint !== ROLE ? h.viewpoint : '';
    if (VIEW !== 'msgs') setView('msgs');
    app.classList.add('reading');
    reveal();
    refresh(h.id ? landOn(h.id, h.use) : undefined);
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
  // 链接已带着 role 与会话: 记下的 session 先放进第一次请求, 省一次重取 (不在列表里由 restoreSess 收拾)。
  if (SESS_RESTORE && ROLE && CONV && savedSess()) SESSION = savedSess();
  refresh();
})();
