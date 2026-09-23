// Chat 详情 SPA。三块视图共用一个 `?id=` 凭据:
//
//   线程  /api/chat (侧栏 + 总账) + /api/thread (正文) + /api/events (SSE 增量)
//   关系  /api/world —— 全部 wizard、家谱、跨聊天往来、工单、日程 (轮询)
//   日程  同一份 /api/world, 换一种读法 (按时间而不是按关系)
//
// turn 正文是服务端渲染好的 HTML 片段 —— diff / ANSI / 语法高亮只在
// shared/detail-render 实现一次, 这里只做 DOM 增量 reconcile。
//
// 关系图有两种读法, 工具条上的开关切换 —— 它们折叠的是同一份数据的不同一面:
//   卡片   聊天是卡片、分身按家谱缩进 (归属与层级由 HTML 布局承担), SVG 只画
//          布局表达不了的边。文字永远可读、可省略、可响应式换行。
//   关系网  只画 wizard, 聊天收进节点自己 (色条 + 群名), 位置交给力导向。群多
//          而每群只有一两个 wizard 时, 卡片会把图撑成一堵墙 —— 那时"谁在跟谁
//          协作"比"谁属于哪个群"更值得占位置。
//
// 无构建步骤: 保持 var / function 写法, 直接被浏览器加载。
(function () {
  var qs = new URLSearchParams(location.search);
  var TOKEN = qs.get('id') || '';
  // 链接指定要开在哪个 wizard 那一栏。票据 (`id`) 可能是兄弟会话的 turn —— 它只
  // 决定授权范围 (整个聊天), 落点由这个参数说。
  var WANT = qs.get('target') || '';
  var TICK_MS = 3000;

  // at / recvAt: 服务端快照时刻与本地收到时刻。所有"现在几点"的判断都换算到
  // 服务端时钟, 否则客户端时钟偏几分钟就会把运行中的会话判成已结束。
  var S = { base: '', target: '', tags: [], graphs: [], at: 0, recvAt: 0, es: null, pinned: true };
  // 关系/日程两栏共用的世界快照。sel = 当前聚焦的节点 (空 = 不聚焦, 全图淡显),
  // kinds = 边类型开关。loaded 用来区分"还没拉过"与"拉过但是空的"。
  var W = {
    at: 0, nodes: [], edges: [], chats: [], jobs: [], schedules: [],
    degraded: false, loaded: false, sel: '', onlyRel: false, kinds: { clone: 1, peer: 1, graph: 1 },
    layout: 'cards',
  };
  // 读法是个人偏好, 记在本地。存储不可用 (隐私窗口 / 老 webview) 就退回默认。
  var LAY_KEY = 'wezard.world.layout';
  try { if (localStorage.getItem(LAY_KEY) === 'force') W.layout = 'force'; } catch (e) { }
  var setLayout = function (v) {
    W.layout = v;
    try { localStorage.setItem(LAY_KEY, v); } catch (e) { }
  };
  var VIEW = 'thread';
  var $ = function (s) { return document.querySelector(s); };
  var thread = $('#thread'), tagsEl = $('#tags'), sbEl = $('#sb'), connEl = $('#conn'), gbarEl = $('#gbar');
  var wmapEl = $('#wmap'), wscrollEl = $('#wscroll'), wtoolsEl = $('#wtools'), planEl = $('#plan-in');

  var srvNow = function () { return S.at ? S.at + (Date.now() - S.recvAt) : Date.now(); };

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
  // 聊天列表用的相对时间 — 一眼看出"刚刚 / 5 分钟前"。
  var fmtAgo = function (ts) {
    if (!ts) return '';
    var d = srvNow() - ts;
    if (d < 60000) return '刚刚';
    if (d < 3600000) return Math.floor(d / 60000) + '分钟前';
    if (d < 86400000) return Math.floor(d / 3600000) + '小时前';
    var x = new Date(ts), p = function (n) { return n < 10 ? '0' + n : '' + n; };
    return p(x.getMonth() + 1) + '-' + p(x.getDate()) + ' ' + p(x.getHours()) + ':' + p(x.getMinutes());
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

  // ── 运行状态: 服务端只给"到这个时刻自动算结束", 由客户端定时判定 ──
  // SSE 只在有写入时推送, 一个真正停下来的 turn 不会再产生任何事件 —— 没有本地
  // 判定, 页面上的「运行中 / 正在思考」就永远熄不掉。
  var isRunning = function (t) { return !!t.runningUntil && srvNow() < t.runningUntil; };
  var curTag = function () {
    return S.tags.filter(function (x) { return x.target === S.target; })[0];
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

  // ── 增量 reconcile (与 turn 页同款, 但会递归进 .bubbles) ──
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
  // sig 相同 → 原节点原样留下; 不同但两边都是 turn-group → 只换头 + 递归气泡层,
  // 这样一次 tool_result 到达不会重建整轮 DOM (滚动位置 / 展开态全部保住)。
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
        var eh = childBy(ex, 'tg-head'), nh = childBy(nc, 'tg-head');
        if (eh && nh) eh.innerHTML = nh.innerHTML;
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

  // ── 滚动: 默认到底; 用户手动上翻后解除吸附, 回到底部再吸附 ──
  var atBottom = function () {
    return thread.scrollHeight - thread.scrollTop - thread.clientHeight < 80;
  };
  var toBottom = function (force) {
    if (force || S.pinned) thread.scrollTop = thread.scrollHeight;
  };
  thread.addEventListener('scroll', function () { S.pinned = atBottom(); });

  // ── 侧栏 (聊天列表) ──
  var tagMeta = function (t) {
    var u = t.usage || {};
    var bits = [];
    if (t.turns) bits.push(t.turns + ' 轮');
    if (u.tools) bits.push(u.tools + ' 工具');
    var tok = (u.output || 0) + (u.input || 0);
    if (tok) bits.push(fmtTok(tok) + ' tok');
    // 目录只取最后一段: 兄弟会话常常一个在主仓、一个在 worktree, 差别就在这一段。
    if (t.cwd) bits.push('📁 ' + (t.cwd.replace(/\/+$/, '').split('/').filter(Boolean).pop() || t.cwd));
    // graph 驱动的会话单独标出来 —— 它的 userQuery 长得和真人消息一样, 不标就
    // 分不清是有人在跟它说话, 还是某个 run 在喂它。
    var g = t.origin
      ? '<span class="gtag" title="由 graph ' + esc(t.origin.runId) + ' 驱动">🕸 ' + esc(t.origin.runId) + '</span>'
      : '';
    if (!bits.length && !g) return '';
    return '<div class="tag-meta">' +
      bits.map(esc).join('<span class="sep">·</span>') +
      (g && bits.length ? '<span class="sep">·</span>' : '') + g +
      '</div>';
  };

  // ── graph 运行条 ──
  // 只画最近活跃的那一个 run: 同一 chat 同时跑两张图是罕见情形, 而两条并排的
  // 流水线会把顶栏挤成一团 —— 宁可只讲清楚当前这一条。
  var labelOfTag = function (tag) {
    var hit = S.tags.filter(function (x) { return x.tag === tag; })[0];
    return hit ? hit.label : '•';
  };
  var renderGraph = function () {
    var g = (S.graphs || [])[0];
    if (!g) { gbarEl.hidden = true; gbarEl.innerHTML = ''; return; }
    // 与会话行同一判定: 服务端只给"到这个时刻自动算结束", 熄灯由本地定时判。
    var run = isRunning(g);
    var nodes = g.pipeline.map(function (p) {
      var on = p.step === g.step;
      return '<span class="nd' + (on ? ' on' : '') + (on && run ? ' live' : '') +
        '" data-tag="' + esc(p.tag) + '" title="步 ' + p.step + '/' + g.steps + ' · #' + esc(p.tag) + '">' +
        esc(labelOfTag(p.tag)) + ' ' + esc(p.tag ? '#' + p.tag : 'default') + '</span>';
    }).join('<span class="arw">→</span>');
    gbarEl.hidden = VIEW !== 'thread';
    gbarEl.innerHTML =
      '<span class="gid" title="graph run">🕸 ' + esc(g.runId) + '</span>' +
      '<span class="pipe">' + nodes + '</span>' +
      '<span class="prog' + (run ? '' : ' done') + '">' +
        (run ? '⟳ ' : '✓ ') + '轮 ' + g.round + '/' + g.rounds + '</span>';
    gbarEl.querySelectorAll('.nd').forEach(function (n) {
      n.onclick = function () {
        var tag = n.getAttribute('data-tag');
        var hit = S.tags.filter(function (x) { return x.tag === tag; })[0];
        if (hit) select(hit.target);
      };
    });
  };
  // 一个会话的 wizard 身份 (名字 / 职责 / 家谱) 只有 /api/world 知道 —— 侧栏
  // 因此是两份数据的合流: tag 那份讲"跑了多少", world 那份讲"它是谁"。世界还没
  // 拉回来时退化成原先的 `#tag` 视图, 不阻塞线程的首屏。
  var nodeOf = function (target) {
    return W.nodes.filter(function (n) { return n.target === target; })[0];
  };
  var nameOf = function (target) {
    var n = nodeOf(target);
    return (n && n.name) || (target.indexOf('#') >= 0 ? '#' + target.split('#').pop() : target) || target;
  };

  // 左上角写聊天的名字, 不是「会话列表」—— 一个页面同时开着好几个群的时候,
  // 「这是哪个群」比「这里是一份列表」重要得多。名字只有 /api/world 给
  // (chatNames 在 daemon 的注册表里), 没回来之前退回静态标题, 不闪空白。
  var chatName = function () {
    var c = chatOf(S.base);
    return (c && c.name) || (nodeOf(S.target) || {}).chat || '';
  };
  var sideHead = function () {
    var n = chatName();
    $('#side-t').textContent = n || '会话列表';
    $('#side-t').title = n ? n + ' · ' + S.base : S.base;
    $('#side-n').textContent = S.tags.length ? S.tags.length + ' 个会话' : '';
    $('#side-sub').textContent = S.base || '';
  };

  var renderTags = function () {
    sideHead();
    if (!S.tags.length) {
      tagsEl.innerHTML = '<div class="empty-side">这个 chat 还没有会话记录</div>';
      return;
    }
    tagsEl.replaceChildren.apply(tagsEl, S.tags.map(function (t) {
      var run = isRunning(t), n = nodeOf(t.target) || {};
      var el = document.createElement('div');
      el.className = 'tag-row' + (t.target === S.target ? ' on' : '') + (run ? ' running' : '');
      // 名字在前、地址在后: `#tag` 是地址, wizard 起过名之后人读的是名字。
      var kin = n.parent
        ? '<span class="kin" title="' + esc(nameOf(n.parent)) + ' 的分身' + (n.inherited ? ' (继承了它的上下文)' : '') + '">↳ ' +
            esc(nameOf(n.parent)) + (n.inherited ? ' ⧉' : '') + '</span>'
        : '';
      el.innerHTML =
        '<div class="tag-av">' + esc(t.label) + (run ? '<span class="live"></span>' : '') + '</div>' +
        '<div class="tag-main">' +
          '<div class="tag-l1">' +
            '<span class="tag-name">' + esc(t.tag ? '#' + t.tag : 'default') + '</span>' +
            '<span class="tag-ts">' + esc(fmtAgo(t.lastTs)) + '</span>' +
          '</div>' +
          (n.description ? '<div class="tag-job">' + esc(n.description) + '</div>' : '') +
          (kin ? '<div class="tag-kin">' + kin + '</div>' : '') +
          '<div class="tag-prev">' + esc(t.preview || '(暂无对话)') + '</div>' +
          tagMeta(t) +
        '</div>';
      el.onclick = function () { select(t.target); };
      return el;
    }));
  };

  // cwd 只显示尾部两段 —— 顶栏放不下全路径, 而"哪个项目/哪个 worktree"恰好就在
  // 尾部; 全路径留在 title 里。~ 前缀在服务端不可知, 客户端也无从展开, 原样保留。
  var shortCwd = function (p) {
    var seg = String(p).replace(/\/+$/, '').split('/').filter(Boolean);
    return seg.length <= 2 ? p : '…/' + seg.slice(-2).join('/');
  };

  var topbar = function () {
    var t = curTag(), name = chatName();
    var tag = t ? (t.tag ? '#' + t.tag : 'default') : '';
    $('#tb-em').textContent = t ? t.label : '💬';
    // 群名在前、地址在后。手机上一进来就是阅读态 (侧栏整个隐藏), 顶栏是唯一
    // 还能说清「这是哪个群」的地方。
    $('#tb-h').textContent = name || tag;
    $('#tb-tag').textContent = name ? tag : '';
    var cwdEl = $('#tb-cwd');
    cwdEl.hidden = !(t && t.cwd);
    if (t && t.cwd) { cwdEl.textContent = '📁 ' + shortCwd(t.cwd); cwdEl.title = t.cwd; }
    $('#tb-sub').textContent = S.target;
  };

  // ── 页脚总账 ──
  var COLORS = { input: '#0a7d6b', cacheRead: '#8250df', cacheWrite: '#953800', output: '#1a7f37' };
  // 缩写键本身没有自解释性, 悬停给出中文口径 (尤其 ctx 是峰值、cache 是累计读写)。
  var TIP = {
    turns: '对话轮数', tools: '工具调用次数', api: 'API 请求次数',
    ctx: '上下文峰值 — 单次请求送入的 input + 缓存 的最高值',
    out: '累计输出 token', cache: '累计缓存 token (读 + 写)', time: '累计耗时',
  };
  // 进行中的会话, 耗时要跟着走: durationMs 只统计到快照时刻 at, 之后的补上;
  // runningUntil 一过就冻住, 不会像旧版那样把静默期一路累加成几十小时。
  var liveDur = function (t) {
    var d = (t.usage && t.usage.durationMs) || 0;
    if (!t.runningUntil) return d;
    return d + Math.max(0, Math.min(srvNow(), t.runningUntil) - S.at);
  };
  var renderStatus = function (t) {
    if (!t) { sbEl.innerHTML = ''; return; }
    var u = t.usage || {}, run = isRunning(t);
    var segs = [['input', '输入'], ['cacheRead', '缓存读'], ['cacheWrite', '缓存写'], ['output', '输出']]
      .filter(function (s) { return u[s[0]] > 0; });
    var total = segs.reduce(function (a, s) { return a + u[s[0]]; }, 0);
    // token 一条都没采到就别画那条空槽 —— 空进度条看着像"用了 0%", 是误导。
    // 光有色块看不出哪段是什么 (tooltip 要悬停才知道), 所以条后面always跟图例。
    var io = total > 0
      ? '<span class="sb-io" title="累计 token I/O · 共 ' + fmtTok(total) + '">' +
          '<span class="k">token i/o</span>' +
          '<span class="sb-bar">' + segs.map(function (s) {
            return '<span class="seg" style="width:' + (u[s[0]] / total * 100).toFixed(2) + '%;background:' +
              COLORS[s[0]] + '" title="' + s[1] + ': ' + fmtTok(u[s[0]]) + '"></span>';
          }).join('') + '</span>' +
          '<span class="sb-leg">' + segs.map(function (s) {
            return '<span class="lg"><i style="background:' + COLORS[s[0]] + '"></i>' + s[1] +
              '<b>' + fmtTok(u[s[0]]) + '</b></span>';
          }).join('') + '</span>' +
        '</span>'
      : '';
    // 值为 0 = 该指标没有数据 (老记录 / 网关不报 usage), 压暗成 "–" 与真实的 0 区分。
    var st = function (k, n, text) {
      return '<span class="st' + (n ? '' : ' void') + '" title="' + esc(TIP[k] || k) + '">' +
        '<span class="k">' + k + '</span><span class="v">' + (n ? esc(text) : '–') + '</span></span>';
    };
    var cache = (u.cacheRead || 0) + (u.cacheWrite || 0);
    sbEl.innerHTML =
      '<span class="pill' + (run ? ' run' : '') + '"><span class="d"></span>' + (run ? '进行中' : '空闲') + '</span>' +
      (t.model ? '<span class="model" title="' + esc(t.model) + '">' + esc(t.model) + '</span>' : '') +
      st('turns', t.turns, t.turns) +
      st('tools', u.tools, u.tools) +
      st('api', u.calls, u.calls) +
      st('ctx', u.ctxPeak, fmtTok(u.ctxPeak)) +
      st('out', u.output, fmtTok(u.output)) +
      st('cache', cache, fmtTok(cache)) +
      st('time', liveDur(t), fmtDur(liveDur(t))) +
      io;
  };

  // ── 线程 ──
  var applySummary = function (d) {
    S.base = d.base; S.tags = d.tags || []; S.graphs = d.graphs || [];
    S.at = d.at || Date.now(); S.recvAt = Date.now();
    renderTags(); topbar(); renderStatus(curTag()); renderGraph();
  };

  var loadThread = function (target, limit) {
    return api('api/thread', limit ? { target: target, limit: limit } : { target: target }).then(function (d) {
      if (!d.ok || target !== S.target) return;
      var inner = $('#thread-in');
      if (!d.turns.length) { inner.innerHTML = '<div class="empty">这个会话还没有记录</div>'; return; }
      // 默认只取最近若干轮 (贴底阅读), 更早的按需一次性拉全。
      var more = d.truncated
        ? '<button class="more-btn" id="more">载入更早的 ' + (d.total - d.turns.length) + ' 轮</button>'
        : '';
      inner.innerHTML = more + d.turns.map(function (t) { return t.html; }).join('');
      d.turns.forEach(function (t) { markStale(t); });
      var btn = $('#more');
      if (btn) btn.onclick = function () { btn.textContent = '载入中…'; loadThread(target, '0'); };
      render(inner);
      foldPings();
      expireTurns();
      S.pinned = true; toBottom(true);
      // CDN 字体/代码高亮加载完会改变高度, 再吸一次底。
      setTimeout(function () { toBottom(); }, 60);
    });
  };

  // staleAt 由 JSON 单独送来 (不在 html 里, 否则会打乱服务端的 sig 去重), 落到
  // DOM 上供 expireTurns 定时判定。
  // 't:' = 一轮对话, 'm:' = 上下文断点行。子 agent 的卡片嵌在父轮里面, 所以按
  // 整棵子树找 —— 只扫顶层会把它当成"还没渲染过"而重复插一份。
  var turnNode = function (id) {
    return $('#thread-in').querySelector('[data-key="t:' + id + '"],[data-key="m:' + id + '"]');
  };
  var markStale = function (t) {
    var n = turnNode(t.id);
    if (n) n.setAttribute('data-stale-at', t.staleAt || 0);
  };

  // ── 🏓 keepalive 折叠 ──────────────────────────────────────────────
  // 保温 ping 是机器行为, 不是对话 (服务端只给一个 .ping 标记, 见 chat-view
  // 的 isKeepaliveTurn)。挂机一晚攒出几十轮 ping/pong, 等宽排在时间轴上会把
  // 真正说过的话挤出屏幕 —— 所以连续的一段收成一行 `🏓 ×N`, 点开才是详情。
  //
  // 每次变动都先拆回顶层再整段重折: 追加一轮可能把两段并成一段, 增量维护要
  // 处理的拼接情形更多。折叠只**搬运**既有节点 (不重建 HTML), 所以 markdown
  // 渲染态、工具展开态、data-sig 全都原样留着。
  var pingOpen = {};
  // 摘要行只放时刻: tg-time 是 "YYYY-MM-DD HH:MM:SS", 两份日期会把这一行撑开,
  // 而一段连续的 ping 本来就落在同一天里。
  var stampOf = function (el) {
    var t = el.querySelector('.tg-time');
    return t ? String(t.textContent).split(' ').pop() : '';
  };
  var foldPings = function () {
    var inner = $('#thread-in');
    // 顶层没有散落的 ping = 已经折好了。流式 turn 每 300ms 推一次, 每次都拆开
    // 重折是白搬一趟 DOM, 还会把读者的滚动位置蹭掉。
    var loose = false;
    Array.prototype.forEach.call(inner.children, function (el) {
      if (el.classList.contains('ping')) loose = true;
    });
    if (!loose) return;
    inner.querySelectorAll('.ping-fold').forEach(function (f) {
      var box = f.querySelector('.ping-body');
      while (box.firstChild) inner.insertBefore(box.firstChild, f);
      f.remove();
    });
    // 连续段: 中间夹一轮真对话 (或一道上下文断点) 就断开 —— 那正是要露出来的东西。
    var runs = [], run = null;
    Array.prototype.forEach.call(inner.children, function (el) {
      if (!el.classList.contains('ping')) { run = null; return; }
      if (run) run.push(el); else runs.push(run = [el]);
    });
    runs.forEach(function (r) {
      var key = r[0].getAttribute('data-key') || '';
      var span = r.length > 1 ? stampOf(r[0]) + ' → ' + stampOf(r[r.length - 1]) : stampOf(r[0]);
      var d = document.createElement('details');
      d.className = 'ping-fold';
      d.open = !!pingOpen[key];
      d.innerHTML =
        '<summary class="ping-sum" title="keepalive 保温 ping —— 不是对话, 点开看详情">' +
          '<span class="pb">🏓 ×' + r.length + '</span>' +
          '<span class="ps">keepalive 保温</span>' +
          '<span class="pt">' + esc(span) + '</span>' +
        '</summary><div class="ping-body"></div>';
      d.ontoggle = function () { pingOpen[key] = d.open; };
      inner.insertBefore(d, r[0]);
      var box = d.querySelector('.ping-body');
      r.forEach(function (el) { box.appendChild(el); });
    });
  };

  var upsertTurn = function (t) {
    var inner = $('#thread-in');
    var empty = inner.querySelector('.empty'); if (empty) empty.remove();
    var stick = S.pinned;
    var cur = turnNode(t.id);
    if (!cur) {
      inner.insertAdjacentHTML('beforeend', t.html);
      render(inner);
    } else if (cur.getAttribute('data-sig') !== t.sig) {
      var box = frag(t.html).firstElementChild;
      var eb = childBy(cur, 'bubbles'), nb = box && childBy(box, 'bubbles');
      if (eb && nb) {
        var eh = childBy(cur, 'tg-head'), nh = childBy(box, 'tg-head');
        if (eh && nh) eh.innerHTML = nh.innerHTML;
        reconcile(eb, nb);
        cur.setAttribute('data-sig', t.sig);
      } else if (box) {
        cur.replaceWith(box); render(inner);
      }
    }
    markStale(t);
    foldPings();
    if (stick) toBottom(true);
  };

  // 到点了还没有新写入 → 这一轮已经结束: 熄掉呼吸点、移除"正在思考"。
  var expireTurns = function () {
    var now = srvNow();
    $('#thread-in').querySelectorAll('.turn-group[data-stale-at]').forEach(function (g) {
      var until = Number(g.getAttribute('data-stale-at') || 0);
      if (!until || now <= until) return;
      g.setAttribute('data-stale-at', '0');
      // 连内嵌的子 agent 卡片一起熄灯: 父轮都到点了, 它派出去的必然也停了,
      // 而子卡片没有自己的 data-stale-at (staleAt 只随顶层片段下发)。
      g.querySelectorAll('.tg-dot').forEach(function (d) { d.classList.remove('live'); });
      g.querySelectorAll('.typing').forEach(function (t) { t.remove(); });
    });
  };

  var select = function (target) {
    if (!target) return;
    // 线程以外的栏位里点一个会话 —— 意思是"去读它", 不是"在关系图上标记它"。
    // 不换栏的话 #thread 还 hidden 着, 点上去像什么都没发生。
    if (VIEW !== 'thread') setView('thread');
    S.target = target;
    document.querySelector('.app').classList.add('reading');
    renderTags(); topbar(); renderStatus(curTag());
    $('#thread-in').innerHTML = '<div class="empty">加载中…</div>';
    loadThread(target).then(function () { connect(); });
  };
  $('#tb-back').onclick = function () { document.querySelector('.app').classList.remove('reading'); };

  // ── SSE: chat 摘要 + 当前 tag 的 turn 增量。断线指数退避重连。 ──
  var backoff = 1000;
  var connect = function () {
    if (S.es) { S.es.close(); S.es = null; }
    var p = new URLSearchParams({ id: TOKEN, target: S.target });
    var es = new EventSource('api/events?' + p.toString());
    S.es = es;
    es.addEventListener('chat', function (e) { try { applySummary(JSON.parse(e.data)); } catch (err) { } });
    es.addEventListener('turn', function (e) { try { upsertTurn(JSON.parse(e.data)); } catch (err) { } });
    es.onopen = function () { backoff = 1000; connEl.className = 'conn'; connEl.title = '实时连接'; };
    es.onerror = function () {
      connEl.className = 'conn off'; connEl.title = '连接断开, 重连中';
      es.close(); if (S.es === es) S.es = null;
      setTimeout(function () { if (!S.es) connect(); }, backoff);
      backoff = Math.min(backoff * 2, 15000);
    };
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

  // 本地心跳: 相对时间、运行中判定、耗时都随时间变化, 但服务端没有新事件可推。
  setInterval(function () {
    if (!S.tags.length) return;
    renderTags();
    renderStatus(curTag());
    renderGraph();
    expireTurns();
    if (VIEW === 'world') tickWorld();
    else if (VIEW === 'plan') renderPlan();
  }, TICK_MS);


  // ══ 关系视图 ═══════════════════════════════════════════════════════
  // 三层叠在一起:
  //   1. 聊天卡片 (HTML)  —— 归属; 一张卡 = 一个群
  //   2. 家谱缩进 (HTML)  —— 层级; 分身缩在父亲下面, 左侧一道折线
  //   3. 连线   (SVG)     —— 其余的关系; 布局表达不了的那些 (跨卡片的分身、
  //                         同群与跨群的派活、流水线的一步)
  // 前两层撑起版面 (所以文字永远可读), 第三层才是"图"。
  var EDGE = {
    clone: { c: '#8250df', label: '分身', dash: '' },
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
  // 同聊天的换一栏就到了。外聊天的正文不在本页的授权范围内 (见 chat-http), 但
  // /api/world 给每张卡片带了那个群既有的票据 —— 拿它整页跳过去, 等于从那个群
  // 自己的链接点进来。没有票据 = 那个群还没有任何记录可读, 点了也没有意义。
  var chatOf = function (base) {
    return (W.chats || []).filter(function (c) { return c.base === base; })[0];
  };
  var canOpen = function (n) { return !!n && (n.local || !!(chatOf(n.base) || {}).token); };
  var openNode = function (target) {
    var n = nodeOf(target);
    if (!n) return;
    if (n.local) { setView('thread'); select(target); return; }
    var tok = (chatOf(n.base) || {}).token;
    if (!tok) return;
    // pathname 而不是写死 '/chat': 这一页可能挂在反代的子路径下 (同 api/ 的相对取法)。
    location.href = location.pathname + '?' + new URLSearchParams({ id: tok, target: target }).toString();
  };

  // 卡片里的名字不重复卡片头已经说过的话。默认名是 `聊天名#tag`, 而卡片头写着
  // 聊天名、行尾还挂着 `#tag` —— 三处同一个词。所以: 起过名字就显示名字, 没起过
  // 就只显示 `#tag`; 名字本身已经以 `#tag` 收尾时也不再重复那枚 badge。
  var shortName = function (n) {
    var fallback = n.chat ? (n.tag ? n.chat + '#' + n.tag : n.chat) : n.tag;
    return n.name && n.name !== fallback ? n.name : (n.tag ? '#' + n.tag : '默认');
  };

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
    var counts = { clone: 0, peer: 0, graph: 0 };
    W.edges.forEach(function (e) { counts[e.kind] = (counts[e.kind] || 0) + 1; });
    var cross = W.edges.filter(function (e) { return e.cross; }).length;
    var chips = Object.keys(EDGE).map(function (k) {
      return '<button class="chip' + (W.kinds[k] ? ' on' : '') + '" data-k="' + k + '" ' +
        'style="--c:' + EDGE[k].c + '"><i></i>' + EDGE[k].label +
        '<b>' + (counts[k] || 0) + '</b></button>';
    }).join('');
    var force = W.layout === 'force';
    wtoolsEl.innerHTML =
      '<div class="wlegend">' + chips + '</div>' +
      '<div class="wlay">' +
        '<button class="lb' + (force ? '' : ' on') + '" data-lay="cards" ' +
          'title="按聊天分卡, 分身缩进 —— 归属与层级最准">▦ 卡片</button>' +
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
    var dupTag = !n.tag || nm === '#' + n.tag || nm.slice(-(n.tag.length + 1)) === '#' + n.tag;
    var bits = [];
    if (n.model) bits.push(n.model.replace(/^claude-/, ''));
    if (n.cwd) bits.push('📁 ' + shortPath(n.cwd, 1));
    if (n.turns) bits.push(n.turns + ' 轮');
    if (n.taskTurns) bits.push('⏰ ' + n.taskTurns);
    if (n.peerTurns) bits.push('✉ ' + n.peerTurns);
    return '<div class="wnode' + (n.self ? ' self' : '') + (run ? ' run' : '') +
        (n.alive ? '' : ' cold') + (n.local ? ' local' : '') + (degree(n.target) ? ' rel' : '') +
        '" data-t="' + esc(n.target) + '" style="margin-left:' + (depth * 16) + 'px">' +
      (depth ? '<span class="lin" title="分身"></span>' : '') +
      '<span class="wav">' + esc(n.label) + (run ? '<i class="live"></i>' : '') + '</span>' +
      '<span class="wbody">' +
        '<span class="wl1">' +
          '<b class="wname" title="' + esc(n.name || n.target) + '">' + esc(nm) + '</b>' +
          (dupTag ? '' : '<span class="wtag">#' + esc(n.tag) + '</span>') +
          (n.inherited ? '<span class="wih" title="开局继承了父亲的上下文">⧉</span>' : '') +
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
        // 「只看有关系的」会把父亲筛掉而留下分身 —— 那时的缩进没有参照物, 拉平。
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
      (cards || '<div class="empty">此刻没有任何协作关系 —— 派活 / 生分身之后这里就有边了</div>') + '</div>';
    wmapEl.querySelectorAll('.wnode').forEach(function (el) {
      var t = el.getAttribute('data-t');
      if (hood && !hood[t]) el.classList.add('dim');
      if (t === W.sel) el.classList.add('sel');
      if (canOpen(nodeOf(t))) el.classList.add('go');
      el.onclick = function () { W.sel = (W.sel === t ? '' : t); renderWorld(); };
      // 双击 = 走进它: 同聊天换一栏, 外聊天整页跳到那个群 (见 openNode)。
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
  // 力: 同群相吸自然成簇, 分身的边比派活的边短, 家谱于是仍然读得出来。
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
    // 弹簧 —— 分身的静息长度短于派活的, 于是家谱天然抱成一小团。
    // 静息长度有个下限: 节点是一张一百多像素宽的卡片, 不是一个点。两端贴到一起
    // 时连线被两张卡各自吃掉一半, 剩下的那截连箭头都放不下 —— 图上就成了一条
    // 看不见的边。下限按两张卡的半宽算, 横着摆也留得出一段看得见的线。
    FX.edges.forEach(function (e) {
      var pa = P[e.from], pb = P[e.to];
      if (!pa || !pb) return;
      var za = FX.size[e.from] || { w: 150, h: 36 }, zb = FX.size[e.to] || { w: 150, h: 36 };
      var ex = pb.x - pa.x, ey = pb.y - pa.y;
      var ed = Math.sqrt(ex * ex + ey * ey) || 0.01;
      var rest = Math.max((za.w + zb.w) / 2 + 30, e.kind === 'clone' ? L * 0.8 : L * 1.35);
      var k = (e.kind === 'clone' ? 0.06 : 0.032) * Math.min(2.2, 1 + Math.log(1 + e.count) * 0.45);
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

  var renderPlan = function () {
    var ss = W.schedules || [], js = W.jobs || [];
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
      : '<div class="pempty">没有定时任务 —— schedule_task 排一个</div>';

    var jobRow = function (j) {
      return '<div class="jrow' + (j.status === 'open' ? ' open' : '') + '">' +
        '<div class="jh"><span class="jid">' + esc(j.id) + '</span>' +
          '<span class="jt">' + esc(j.title) + '</span>' +
          '<span class="jst">' + (j.status === 'open' ? '进行中' : '已收工') + '</span>' +
          '<span class="jts">' + esc(fmtAgo(j.closedAt || j.openedAt)) + '</span></div>' +
        '<div class="jm">' + (j.members.length
          ? j.members.map(function (mm) {
              return '<span class="jmm">' + wizChip(mm.target) +
                (mm.spawned ? '<i class="tmp" title="为这个工单临时生的分身, 收工时回收">临时</i>' : '') +
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
        (js.length ? open.concat(closed).map(jobRow).join('') : '<div class="pempty">没有工单 —— 一次派出两个以上分身时 open_job 开一个</div>') +
      '</section>';
    planEl.querySelectorAll('.wchip.go').forEach(function (c) {
      c.onclick = function () { openNode(c.getAttribute('data-t')); };
    });
  };

  // ══ 视图切换 ═══════════════════════════════════════════════════════
  // 世界快照不走 SSE: 它变动的源头 (spawn / 改职责 / 开收工单 / 排定时) 一条都
  // 不经过 detail store, 而给它们各自搭一条事件通路, 换来的只是几秒的新鲜度。
  // 改成"看得见才轮询": 不在关系/日程栏、或者页面在后台, 就一次都不请求。
  var WORLD_MS = 6000;
  var worldTimer = null;
  var loadWorld = function () {
    return api('api/world', {}).then(function (d) {
      if (!d.ok) return;
      W.at = d.at; W.loaded = true;
      W.nodes = d.nodes || []; W.edges = d.edges || []; W.chats = d.chats || [];
      W.jobs = d.jobs || []; W.schedules = d.schedules || []; W.degraded = !!d.degraded;
      // 身份回来了, 侧栏那几行也跟着变 —— 名字/职责/家谱都在这份数据里。
      // 顶栏同理: 群名只在这份快照里, 不跟着 /api/chat 走。
      renderTags(); topbar();
      if (VIEW === 'world') renderWorld();
      if (VIEW === 'plan') renderPlan();
    }).catch(function () { });
  };
  var pollWorld = function () {
    if (worldTimer) { clearInterval(worldTimer); worldTimer = null; }
    if (VIEW === 'thread') return;
    worldTimer = setInterval(function () {
      if (!document.hidden) loadWorld();
    }, WORLD_MS);
  };

  var setView = function (v) {
    VIEW = v;
    $('#views').querySelectorAll('.vb').forEach(function (b) {
      b.classList.toggle('on', b.getAttribute('data-view') === v);
    });
    thread.hidden = v !== 'thread';
    $('#pane-world').hidden = v !== 'world';
    $('#pane-plan').hidden = v !== 'plan';
    // graph 条只对线程有意义 (它讲的是当前这一路被谁驱动)。
    gbarEl.hidden = v !== 'thread' || !(S.graphs || []).length;
    document.querySelector('.app').classList.toggle('wide', v !== 'thread');
    if (v === 'thread') { toBottom(true); }
    else if (!W.loaded) { (v === 'world' ? (wmapEl.innerHTML = '<div class="empty">加载中…</div>') : (planEl.innerHTML = '<div class="empty">加载中…</div>')); loadWorld(); }
    else if (v === 'world') renderWorld();
    else renderPlan();
    pollWorld();
  };
  $('#views').querySelectorAll('.vb').forEach(function (b) {
    b.onclick = function () { setView(b.getAttribute('data-view')); };
  });
  // 卡片换行会改变每个节点的坐标 —— 连线必须跟着重画。
  window.addEventListener('resize', function () {
    if (VIEW !== 'world') return;
    if (W.layout === 'force') renderForce(); else requestAnimationFrame(drawEdges);
  });

  // ── boot ──
  api('api/chat', WANT ? { target: WANT } : {}).then(function (d) {
    if (!d.ok) {
      document.body.innerHTML = '<div class="empty" style="padding:80px">' + esc(d.error || 'not found') + '</div>';
      return;
    }
    applySummary(d);
    // 卡片链接带来的那条 turn 决定默认选中的 tag; 否则取最近活跃的。
    select(d.self && d.self.target ? d.self.target : (S.tags[0] && S.tags[0].target));
  });
  // 与线程并行取: 侧栏那几行的名字 / 职责 / 家谱都在这份快照里, 不该等线程渲染完
  // 才补上。首屏之后就只在关系/日程栏轮询 (见 pollWorld)。
  loadWorld();
})();
