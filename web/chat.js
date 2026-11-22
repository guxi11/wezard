// Rolepage SPA —— room 模型之后的一页 IM。
//
//   左栏  力导向图: room 胶囊 ↔ 参与者圆点 (点 room 看历史, 点 wizard 看它说的 + 指向它的);
//         家谱 (谁生的谁) 是可切换的一层虚线。
//   右栏  room 历史 (author / to / re / status 都是账本行上的显式字段, 点一条消息可以展开
//         产出它的那一轮的过程框), 或一个 wizard 与它相关的消息 (它说的 / 点名它的 / 回它那几条的)。
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
  var D = { mode: '', roomId: '', role: '', uid: '', at: 0, msgs: [], total: 0, earlier: '', room: null, label: '', members: [], duties: [], wizard: null, sessions: [], session: 'all', ledger: true, plans: [], schedules: [], charterBrief: null, stream: null, streamSig: '', stats: null };
  var S = { openTurns: {}, charter: null, sim: null, gsig: '', gmap: null, elById: null, lines: null, view: 'list' };
  var SIDE_KEY = 'wezard.role.side';
  try { if (localStorage.getItem(SIDE_KEY) === 'graph') S.view = 'graph'; } catch (e) { /* 隐私模式 */ }
  // 时间范围 (列表与图共用, 见 roomInScope): 只按 room 的最后动静切 —— 有未决 duty / 有未读的 room 与正在看的 room 照旧总在; 成员不单独过窗口, 跟着 room 走。
  // 图上另有自己的口径 (见 renderGraph): 只看 room 最后一条消息是否在窗口内, 不带未读 / duty 例外。
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
  // 列表与图「画哪些 room」的唯一口径: 窗口内有动静 / 正在看的那个 (滑出窗口也不能从眼前消失) / 视角有未读 / 留着未决 duty。
  // 成员不单独过窗口: 成员跟着 room 走 (见 participants), 否则 room 的成员边画不出来。未读 = 与列表角标 / 图上红点同一个数, 见 unreadOf。
  var roomInScope = function (r) {
    return !WIN || inWin(r.last && r.last.at) || (!!D.roomId && D.roomId === r.id) || unreadOf(r) > 0 || r.openDuties > 0;
  };
  var scopedRooms = function () {
    return (W.rooms || []).slice().sort(function (a, b) { return (b.last ? b.last.at : 0) - (a.last ? a.last.at : 0); }).filter(roomInScope);
  };

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
    // role (视角) 只要已知就写; room (选中态) 永远写, 没选中写空串: 缺省 = 用票据落点, 空 = 明确不选 (刷新后不会被落点重新选中)。
    var p = new URLSearchParams(location.search);
    if (D.role) p.set('role', D.role);
    p.set('room', D.roomId || '');
    p.delete('all');   // 「全部消息」已删: 老链接里的 all=1 在第一次同步时抹掉
    history.replaceState(null, '', location.pathname + '?' + p.toString());
  };
  // 站在谁的位置上: 这个 id 是不是当前视角 (规范身份 / uid 形态都认; 名片还没跟上新 role 时不拿旧名片的 id 充数)。
  var isRoleId = function (id) {
    if (!id || !D.role) return false;
    if (id === D.role) return true;
    if (D.wizard && D.cardRole === D.role && id === D.wizard.id) return true;
    if (!D.uid || D.cardRole !== D.role) return false;
    // role 是 uid 形态 (只在 room 里露过面的 wizard) 时, 别处的节点 id 是它的注册 target: 经名册对回 uid 再比。
    return id === 'uid:' + D.uid || (id.indexOf('uid:') !== 0 && id.indexOf('human:') !== 0 && nodeOf(id).uid === D.uid);
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
  // 名册还没到 (svr 刚重启, 下一次推送最长 30s 才来) / 名字取不到时, 服务端会拿 id 当名字: 会话 key、uid、room id 永远不是名字。
  // 与 shared/session-label.ts 的 displayName 同一条回落: 有 `#slot` 就用 slot, 否则宁可显示省略号占位也不露 id。
  var ID_LIKE = /^(?:uid|user|chat|group|wezard|dm|adhoc):|^w[0-9a-f]{12}$/;
  var safeName = function (s) {
    s = String(s == null ? '' : s);
    if (!ID_LIKE.test(s)) return s;
    var h = s.indexOf('#');
    return h >= 0 && h < s.length - 1 ? s.slice(h + 1) : '…';
  };
  // W.nodes 一次拉一份新数组: 按引用建一张 target → node 表, 列表 31 行 × 4 头像不再各扫一遍 57 个节点。
  var nodeIdx = null, nodeIdxOf = null;
  var nodeOf = function (id) {
    if (nodeIdxOf !== W.nodes) { nodeIdxOf = W.nodes; nodeIdx = {}; W.nodes.forEach(function (n) { if (!(n.target in nodeIdx)) nodeIdx[n.target] = n; }); }
    if (nodeIdx[id]) return nodeIdx[id];
    var uid = id.indexOf('uid:') === 0 ? id.slice(4) : '';
    var human = id.indexOf('human:') === 0;
    var name = uid ? (W.names[uid] || uid) : human ? (W.names[id.slice(6)] || id.slice(6)) : id;
    return { target: id, kind: human ? 'human' : 'wizard', name: safeName(name), label: human ? '👤' : '🧙‍♂️', rels: [] };
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
  // room 图标三种: 多人群聊 👥 / 人与 wizard 的单聊 💬 / 只有 wizard 的 room 🧙‍♂️ (与 wizard 默认头像同一个 emoji)。
  // 先分「有没有人参与」(isPeopleRoom, 与列表的「群聊 / 会话」分组、搜索的 group 同一口径: 绑定企微 / topic / 微信的 room 不管有没有人发过话都算有人);
  // 有人的再分单聊 / 群聊: 单聊 = 恰好两位参与者、其中一位是人、且不是企微群 / topic 帖 (即绑定的 wecom-dm 那种: 一个人 + 一个 wizard) —— 这是唯一保留 💬 的特例;
  // 其余有人的 (企微群 / topic / 多人 adhoc / 人 + 多个 wizard …) 一律 👥。按 kind 细分的图标一律不要, 类型只留在 tooltip 的文字里 (KIND_WORD)。
  var isSoloChat = function (r) {
    var ms = r.members || [];
    return ms.length === 2 && ms.filter(function (m) { return m.who && m.who.kind === 'human'; }).length === 1 &&
      r.kind !== 'wecom-group' && r.kind !== 'topic-post';
  };
  var roomIcon = function (r) { return !isPeopleRoom(r) ? '🧙‍♂️' : isSoloChat(r) ? '💬' : '👥'; };
  // 搜索命中只带 id + group 布尔: 能在 W.rooms 里找到就走同一套三分, 找不到 (没拉到的老 room) 退回「群聊 / wizard」两分。
  var roomIconOf = function (id, group) { var r = roomById(id); return r ? roomIcon(r) : group ? '👥' : '🧙‍♂️'; };
  var KIND_WORD = { 'wecom-group': '企微群', 'wecom-dm': '企微单聊', 'topic-post': 'topic 帖', wx: '微信', dm: 'wizard 两人会话', adhoc: '临时多人 room' };
  var roomKindWord = function (r) { return (isPeopleRoom(r) ? '群聊' : '会话') + ' · ' + (KIND_WORD[r.kind] || r.kind || ''); };
  var cssEsc = function (s) { return String(s).replace(/(["\\])/g, '\\$1'); };

  // ── 二部图 ─────────────────────────────────────────────────────────
  var participants = function (rooms) {
    var seen = {};
    (rooms || []).forEach(function (r) {
      (r.members || []).forEach(function (m) {
        var id = nodeIdOf(m.who);
        if (id) seen[id] = true;
      });
    });
    // 画在图上的 room, 它的成员一个都不能缺: 以前这里按活跃度 / 时间窗再筛一遍成员,
    // 被筛掉的成员没有节点, room 的成员边画不出来, 两人 dm 就剩一个孤零零的 room 胶囊。
    // room 本身已经按时间窗 / 未决 duty 取舍过, 成员跟着 room 走。
    return Object.keys(seen).map(nodeOf);
  };
  // ── 力导向图 ───────────────────────────────────────────────────────
  //  room = 胶囊, 人 = 方块, wizard = 圆点 (填色 / 外圈示意 working · idle · warm · cold)。
  //  边三种: 成员 (细灰) / host → room (橙色加粗) / 两个 wizard 的 dm 收成的直连线 (点线 = 打开那个 room)。
  //  布局 = stress majorization (无依赖, 见 gStep): 初次出图从径向树起点一次排到收敛,
  //  之后在帧循环里继续松弛; 拖节点会升温, 邻居跟着走, 松手后放开它继续排布。
  //  数据刷新只做增量: 节点对象 (坐标 / 速度) 常驻在 S.gnodes, 新来的落在邻居旁, 没了的删掉,
  //  其余只改样式 / 文字 —— 不整图重建、不重排; 只有节点或边真的增减才给模拟补一点热量。
  // 有人 (human) 的 room 始终画 room 节点; 只有恰好两个 wizard 才收成直连线。
  var directPair = function (r, people) {
    var ids = {}, human = false;
    (r.members || []).forEach(function (m) {
      var id = nodeIdOf(m.who);
      if (!id) return;
      ids[id] = true;
      if (m.who.kind !== 'wizard') human = true;
    });
    var ks = Object.keys(ids);
    if (human || ks.length !== 2) return null;
    var have = {};
    people.forEach(function (p) { have[p.target] = true; });
    return have[ks[0]] && have[ks[1]] ? ks : null;
  };
  // 节点状态 (wizard), 四选一 + 一个叠加属性:
  //  asleep  pane 不在 —— 休眠, 下一句话会由 daemon 重新拉起。
  //  blocked 轮没结束却停在本地审批框 / 弹窗上等人点 (服务端 parked): 在等人, 不在干活。
  //  working 真在跑。有注册表事实的 (known) 只认服务端的 busy (registry status / pane 转圈, 已排除 parked);
  //          只有没有事实的 (只在 room / 轮次里露过面的) 才退回转录推算的 runningUntil —— 它静默久了会误熄、也会因悬着的轮误亮。
  //  idle    pane 在、没在跑。
  //  冷 (coldOfNode) 不是状态而是叠加在 idle / asleep 上的属性: 提示缓存已超 TTL, 下一句要整段重写缓存 —— 节点填充变白 (空闲且冷 = 白底实线, 休眠且冷 = 白底虚线);
  //          working / blocked 不受影响 (它们正在用缓存 / 刚用过)。
  var stateOfNode = function (n) {
    if (n.kind === 'human') return '';
    if (!n.alive) return 'asleep';
    if (n.parked) return 'blocked';
    var busy = n.known ? n.busy : (n.busy || (n.runningUntil && n.runningUntil > Date.now()));
    return busy ? 'working' : 'idle';
  };
  // 与 wizard_roster / tell_peer 冷门控同一口径 (服务端 cacheCold)。服务端只给 pane 在的 wizard 报 cacheCold; 休眠的没有这个事实,
  // 退回前端估计: 最近动静 (lastTs) 超过 5 分钟 (提示缓存最短的 TTL) 或根本没有动静记录 = 冷。
  var COLD_MS = 5 * 60000;
  var coldOfNode = function (n) {
    var st = stateOfNode(n);
    if (st !== 'idle' && st !== 'asleep') return false;
    if (n.cacheCold !== undefined) return !!n.cacheCold;
    return st === 'asleep' && (!n.lastTs || Date.now() - n.lastTs > COLD_MS);
  };
  var ST_WORD = { working: '工作中', blocked: '等人审批 (停在审批框)', idle: '空闲', asleep: '休眠 (pane 不在, 下一句会重新拉起)' };
  var COLD_WORD = '缓存已冷 (下一句要重写缓存)';
  // 未读 = 服务端按当前查看 role 在该 room 的游标算的条数 (r.unread), 点开该 room 后在本机清零 (seenSeq 记下当时的 seq),
  // 之后只数点开之后新来的。正开着的 room 恒为 0。
  var SEEN_KEY = 'wezard.role.seenSeq';
  var seenSeq = (function () { try { return JSON.parse(localStorage.getItem(SEEN_KEY) || '{}') || {}; } catch (e) { return {}; } })();
  var markSeen = function (id) {
    var r = roomById(id), q = r && r.last ? r.last.seq : 0;
    if (q > (seenSeq[id] || 0)) { seenSeq[id] = q; try { localStorage.setItem(SEEN_KEY, JSON.stringify(seenSeq)); } catch (e) { /* 无痕 */ } }
  };
  // 视角不在这间 room 里就没有「未读」: 服务端对非成员的游标是 0, 会把整本账都数成未读 (别人的 dm 也一屏红点), 前端只认视角自己是成员的 room。
  var viewerIn = function (r) {
    return (r.members || []).some(function (m) { return isRoleId(nodeIdOf(m.who)); });
  };
  var unreadOf = function (r) {
    if (D.roomId === r.id) { markSeen(r.id); return 0; }
    if (!viewerIn(r)) return 0;
    var n = r.unread || 0;
    return n ? Math.max(0, Math.min(n, (r.last ? r.last.seq : 0) - (seenSeq[r.id] || 0))) : 0;
  };
  var SVGNS = 'http://www.w3.org/2000/svg';
  // 节点统一大小 (外接圆半径 NODE_R), 聪明程度不再靠大小, 改用多边形边数 (见 polySides / polyPts): 半径进力模拟 (rOf) 与帽子的落点。
  var NODE_R = 10;
  var nodeR = function (p) { return NODE_R; };
  // 聪明程度 (服务端 shared/smarts.ts 折好的 1~5 级) → 边数: 1 级三角形 · 2 级四边形 · 3 级五边形 · 4 级六边形 · 5 级 (ultra) 圆 = 边数的极限 (0 = 画圆)。
  // 不知道 (老快照 / 别家模型又没档位) = 五边形 (中号, 与以前「都没有 = 中号」同口径)。
  var polySides = function (p) {
    var lv = p.smarts && p.smarts.level;
    return lv >= 1 && lv <= 4 ? lv + 2 : lv === 5 ? 0 : 5;
  };
  // 正 n 边形顶点串: 奇数边尖朝上, 偶数边平顶朝上 (四边形 = 正放的方块, 不是菱形), 外接圆半径 r。
  var polyPts = function (n, r) {
    var off = n % 2 ? -90 : -90 + 180 / n;
    return Array.apply(null, Array(n)).map(function (_, i) {
      var a = (off + 360 * i / n) * Math.PI / 180;
      return (r * Math.cos(a)).toFixed(1) + ',' + (r * Math.sin(a)).toFixed(1);
    }).join(' ');
  };
  // 帽子要戴的「头顶」半径: 奇数边是尖 (外接圆半径), 偶数边是平顶 (内切圆半径 = r·cos(π/n)), 圆就是圆。
  var topR = function (n, r) { return n && n % 2 === 0 ? r * Math.cos(Math.PI / n) : r; };
  // 多边形元素串 (图 / 图例 / profile / 成员栏共用): sides=0 画圆; cls 可空。
  var polyEl = function (sides, r, cls) {
    var c = cls ? ' class="' + cls + '"' : '';
    return sides ? '<polygon' + c + ' points="' + polyPts(sides, r) + '"/>' : '<circle' + c + ' r="' + r + '"/>';
  };
  // 行内小图标: 聪明程度 = 边数, 无 smarts 同图规则画五边形; 学历文字 (+ 状态文字) 进 title。
  // st / cold 给了就按关系图节点同一套状态着色 (.smi.st-* / .cold, 样式与 .rv-person .sh 一致): 成员栏用它取代原来的状态点; 不给 (profile facts 行) 就是中性灰。
  var smartsIcon = function (sm, st, cold, extra) {
    var t = [extra, smartsWord(sm)].filter(Boolean).join(' · ');
    var cls = 'smi' + (st ? ' st-' + st : '') + (cold ? ' cold' : '') + (st === 'working' ? ' go' : '');
    return '<svg class="' + cls + '" viewBox="-6 -6 12 12" width="16" height="16" role="img"' + (t ? ' aria-label="' + esc(t) + '"' : '') + '>' + (t ? '<title>' + esc(t) + '</title>' : '') + polyEl(polySides({ smarts: sm }), 5.2) + '</svg>';
  };
  var SMART_BASIS = { model: '实际模型', tier: '出生档位 (认不出实际模型)' };
  // 聪明程度 1~5 用学历梯度表达 (小学生 … 专家教授), 不再露 `3/5`; 档位定义仍在 shared/smarts.ts, 这里只管展示。
  var EDU = { 1: ['🧒', '小学生'], 2: ['🎒', '初中生'], 3: ['🎓', '大学生'], 4: ['🔬', '研究生'], 5: ['👨‍🏫', '专家教授'] };
  var eduOf = function (sm) { return sm && EDU[sm.level] ? EDU[sm.level] : null; };
  var smartsWord = function (sm) { var e = eduOf(sm); return e ? e[0] + ' ' + e[1] + ' · ' + sm.label + ' (依据: ' + (SMART_BASIS[sm.basis] || sm.basis) + ')' : ''; };
  // 这一轮想画的图 (纯数据, 不碰坐标): 节点 + 边, 边按身份去重。
  var graphModel = function (rooms, people, directs) {
    var nodes = [], links = [], seen = {}, have = {};
    rooms.forEach(function (r) {
      // 胶囊宽按 12pt (16px) 字估: 图标 + 名字 (最多 gNameMax 个字) 每字 ~9.3px, 两侧各留 8。
      // 选中的 room 名字加粗 (见 CSS .rv-room.on > text), 每字再宽 ~16%, 胶囊跟着撑开, 免得字溢出边框、压到两侧 chevron。
      var w = Math.max(70, 40 + Math.min(gNameMax() + 1, roomLabelOf(r).length) * (!!D.roomId && D.roomId === r.id ? 10.8 : 9.3));
      nodes.push({ id: 'r:' + r.id, ref: r, isRoom: true, w: w, r: Math.max(w, 22) / 2 });
    });
    people.forEach(function (p) {
      have['p:' + p.target] = true;
      nodes.push({ id: 'p:' + p.target, ref: p, isRoom: false, w: 0, r: nodeR(p) });
    });
    var add = function (l) { if (!seen[l.key]) { seen[l.key] = true; links.push(l); } };
    rooms.forEach(function (r) {
      (r.members || []).forEach(function (m) {
        var pid = 'p:' + nodeIdOf(m.who);
        // host 边方向 = room → host (线从 room 出发, 箭头落在 host 的圆点边上); 普通成员边无向、同样粗细。
        if (have[pid]) add({ key: 'm|' + r.id + '|' + pid, a: 'r:' + r.id, b: pid, room: r.id, host: !!m.host });
      });
    });
    // 节点级 host: 在任一 room 里是 host 就戴礼帽 (边上不再有箭头)。
    var hostIds = {};
    links.forEach(function (l) { if (l.host) hostIds[l.b] = true; });
    nodes.forEach(function (n) { if (hostIds[n.id]) n.host = true; });
    (directs || []).forEach(function (d) {
      add({ key: 'd|' + d.room.id, a: 'p:' + d.pair[0], b: 'p:' + d.pair[1], room: d.room.id, direct: true, unread: unreadOf(d.room) > 0 });
    });
    return { nodes: nodes, links: links };
  };
  // 把 model 并进常驻节点表: 已有的沿用对象 (坐标 / 速度 / 钉子都在), 新的落在已就位邻居的旁边。
  // 图所在面板的尺寸: 每次 reconcile / viewBox 都现读 clientWidth 会把刚改的 DOM 强制同步排版一遍 (点 room 一次两趟, 24~116ms)。
  // 缓存一份, 由 ResizeObserver (尺寸真变了才触发) 刷新; 还没有缓存时读一次。
  var panelBox = function () {
    if (!S.panelBox) S.panelBox = { w: convsEl.clientWidth, h: convsEl.clientHeight };
    return S.panelBox;
  };
  // 图例的高度: 窄屏上它折成两行, 写死的余量会让第二行 (lead / 大小) 被压到底栏下面。量一次缓存, 面板尺寸变了 (panelBox 作废) 再量。
  var legendH = function () {
    if (S.lgBox !== S.panelBox || !S.lgH) {
      var e = convsEl.querySelector('.rv-legend');
      S.lgH = e ? e.offsetHeight : 0; S.lgBox = S.panelBox;
    }
    return S.lgH || 24;
  };
  var reconcileGraph = function (model) {
    var old = S.gnodes || {}, next = {}, fresh = [];
    var nb = {};
    model.links.forEach(function (l) { (nb[l.a] = nb[l.a] || []).push(l.b); (nb[l.b] = nb[l.b] || []).push(l.a); });
    model.nodes.forEach(function (n) {
      var o = old[n.id];
      if (o) { o.ref = n.ref; o.w = n.w; o.r = n.r; next[n.id] = o; } else { next[n.id] = n; fresh.push(n); }
    });
    var panelW = Math.max(240, (panelBox().w || 332) - 12);
    var panelH = Math.max(300, (panelBox().h || 620) - 30);
    var hw = Math.max(104, Math.min(panelW * 0.46, Math.sqrt(model.nodes.length) * 26));
    var hh = hw * Math.max(1.4, Math.min(2.2, panelH / panelW));
    fresh.forEach(function (n, i) {
      var ps = (nb[n.id] || []).map(function (id) { return next[id]; }).filter(function (p) { return p && p.x !== undefined; });
      var ang = (Object.keys(old).length + i) * 2.39996;
      if (ps.length) {
        var cx = 0, cy = 0;
        ps.forEach(function (p) { cx += p.x; cy += p.y; });
        n.x = cx / ps.length + Math.cos(ang) * 42; n.y = cy / ps.length + Math.sin(ang) * 42;
      } else { n.x = Math.cos(ang) * hw * 0.85; n.y = Math.sin(ang) * hh * 0.85; }
    });
    var gone = Object.keys(old).filter(function (id) { return !next[id]; }).length;
    S.gnodes = next;
    var links = model.links.map(function (l) { l.s = next[l.a]; l.t = next[l.b]; return l; });
    var lsig = links.map(function (l) { return l.key; }).sort().join(',');
    var changed = fresh.length > 0 || gone > 0 || lsig !== S.glsig;
    S.glsig = lsig;
    return { g: { nodes: model.nodes.map(function (n) { return next[n.id]; }), links: links, hw: hw, hh: hh }, changed: changed };
  };
  // 布局 = stress majorization (局部 SMACOF, 即 Graphviz neato 的做法): 任意两点的目标距离 = 图上的带权最短路,
  // 每一步把每个点挪到「让它与所有点的距离最接近目标」的位置 (权 1/d², 近处的关系说了算)。比之前的
  // 斥力 + 弹簧 + 交叉力 + 椭圆墙 + 随机多起点 (几项互相打架, 真实拓扑上 10~30 条交叉、叶子叠成一团、每次增量整图挪动)
  // 少了所有调不平的魔数: 一份确定的起点 (径向树) 跑到收敛就是结果, 增量从当前位置接着收敛, 只动该动的。
  // 节点不重叠由一个包围盒碰撞项单独负责 (含名字标签, 按缩放后的字号算)。
  var GK = 70;   // 一条普通边的目标长度 (像素, 间距倍数 S.gs = 1 时): 名字是 16px 字, 一个名字 ~70~100px 宽, 边要比它长一截
  var gDeg = function (g) {
    if (g._deg) return g._deg;
    var d = {};
    g.links.forEach(function (l) { d[l.s.id] = (d[l.s.id] || 0) + 1; d[l.t.id] = (d[l.t.id] || 0) + 1; });
    return (g._deg = d);
  };
  // 边的目标长度: 枢纽的边要长到一圈放得下它所有的邻居 (每个邻居约占 44px 弧长, 名字上下错开), 否则叶子只能叠在一起;
  // room 胶囊比圆点宽, 边从胶囊中心出发, 补上胶囊的半宽; host 边略短, 让 host 贴着自己的 room。
  var gLen = function (g, l) {
    var dg = gDeg(g), m = Math.max(dg[l.s.id] || 1, dg[l.t.id] || 1);
    var ex = (l.s.isRoom ? l.s.w / 2 - 10 : 0) + (l.t.isRoom ? l.t.w / 2 - 10 : 0);
    return (Math.max(GK, m * 44 / (2 * Math.PI)) * (l.host ? 0.85 : 1) + ex) * (S.gs || 1);
  };
  // 目标距离矩阵 (Floyd, n ≤ 一两百时几毫秒): 拓扑或 room 宽度没变就沿用上一份。不连通的块按「比最远还远一点」摆在旁边。
  var gPrep = function (g) {
    if (g._D) return g._D;
    var ns = g.nodes, n = ns.length, ix = {}, i, j, k;
    var key = ns.map(function (p) { return p.id + ':' + (p.w || 0); }).join('|') + '#' + S.glsig + '@' + (S.gs || 1);
    if (S.gD && S.gD.key === key) return (g._D = S.gD.D);
    var D = new Float64Array(n * n).fill(Infinity);
    ns.forEach(function (p, i) { ix[p.id] = i; D[i * n + i] = 0; });
    g.links.forEach(function (l) {
      var a = ix[l.s.id], b = ix[l.t.id], L = gLen(g, l);
      if (a !== b && L < D[a * n + b]) { D[a * n + b] = L; D[b * n + a] = L; }
    });
    var E = D.slice();   // 直接相连的两点
    for (k = 0; k < n; k++) for (i = 0; i < n; i++) {
      var dik = D[i * n + k];
      if (dik === Infinity) continue;
      for (j = 0; j < n; j++) { var v = dik + D[k * n + j]; if (v < D[i * n + j]) D[i * n + j] = v; }
    }
    // 相连的两点按自己那条边的长度, 不让最短路改短: 否则 A–B 的边比 A–C–B 绕路还长时, 目标距离会被压成
    // 「C 正好在 A、B 连线上」, 三角形塌成一条线, 两条边叠在第三条上。
    for (i = 0; i < n * n; i++) if (E[i] !== Infinity && E[i] > D[i]) D[i] = E[i];
    var mx = 0;
    for (i = 0; i < n * n; i++) if (D[i] !== Infinity && D[i] > mx) mx = D[i];
    for (i = 0; i < n * n; i++) if (D[i] === Infinity) D[i] = mx * 0.6 + GK * 2;
    S.gD = { key: key, D: D };
    return (g._D = D);
  };
  // 布局坐标就是屏幕像素 (视野缩放 k = 1 时): 节点半径、名字字号都是固定像素 (GFS = 12pt = 16px, 见 nodeHtml),
  // 不随画布缩放; 画布大小只改变间距 —— 首排按面板大小把目标边长整体乘 S.gs (gFitScale)。
  var GFS = 16;
  var gNameMax = function () { return (panelBox().w || 332) <= 420 ? 9 : 11; };   // 名字最多几个字, 再长省略号 (窄屏更短)
  // 包围盒 [半宽, 半高, 中心下移] (像素): 人 = 圆点 + 下方名字, 圆点上方留 4 (选中环 / 视角箭头在左右); room = 胶囊。
  var gBox = function (p) {
    if (p.isRoom) return [p.w / 2 + 3, 16, 0];
    var hw = Math.max(p.r + 12, Math.min(gNameMax(), String((p.ref && p.ref.name) || '').length) * 0.29 * GFS + 3);
    var top = p.r + 4, bot = p.r + 5 + GFS;
    return [hw, (top + bot) / 2, (bot - top) / 2];
  };
  // 碰撞: 两个包围盒相交就沿穿透最浅的轴各退一半 (被钉住的不动, 另一个退全程)。
  var gCollide = function (g, s) {
    var ns = g.nodes, n = ns.length;
    var bs = ns.map(gBox);
    for (var a = 0; a < n; a++) for (var b = a + 1; b < n; b++) {
      var p = ns[a], q = ns[b], A = bs[a], B = bs[b];
      var dx = q.x - p.x, dy = (q.y + B[2]) - (p.y + A[2]);
      var ox = A[0] + B[0] - Math.abs(dx), oy = A[1] + B[1] - Math.abs(dy);
      if (ox <= 0 || oy <= 0) continue;
      var fp = p.fx == null, fq = q.fx == null;
      if (!fp && !fq) continue;
      var wp = fp && fq ? 0.5 : fp ? 1 : 0;
      if (ox < oy) { var mx = ox * s * (dx < 0 ? -1 : 1); p.x -= mx * wp; q.x += mx * (1 - wp); }
      else { var my = oy * s * (dy < 0 ? -1 : 1); p.y -= my * wp; q.y += my * (1 - wp); }
    }
  };
  // 边让点: 一个点离一条不以它为端点的边太近 (投影在线段内部) 就沿法线推到够远 —— stress 只管点对点的距离,
  // 不管点压在边上; 三角形挤扁时第三个点会躺在对边上, 边和点完全重叠看不出连着谁。只推点, 不动边的两端:
  // 枢纽是几十条边的端点, 每条都让它退一点会把整张图推着走。正好共线 (距离 0) 时按点的序号奇偶定往哪边推, 保持确定性。
  // 推离一条边可能又推到另一条边上 (点夹在两条边之间): 最多来回三遍, 直到一遍里没人再动。
  var gEdgeClear = function (g) {
    var ns = g.nodes, ls = g.links, moved = true;
    for (var pass = 0; pass < 3 && moved; pass++) {
      moved = false;
      for (var li = 0; li < ls.length; li++) {
        var l = ls[li], A = l.s, B = l.t, vx = B.x - A.x, vy = B.y - A.y, L2 = vx * vx + vy * vy;
        if (L2 < 1) continue;
        var Ln = Math.sqrt(L2), nx = -vy / Ln, ny = vx / Ln;
        for (var i = 0; i < ns.length; i++) {
          var p = ns[i];
          if (p === A || p === B || p.fx != null) continue;
          var t = ((p.x - A.x) * vx + (p.y - A.y) * vy) / L2;
          if (t <= 0.03 || t >= 0.97) continue;
          var d = (p.x - A.x - t * vx) * nx + (p.y - A.y - t * vy) * ny;
          var gap = (p.isRoom ? 13 : p.r) + 6 - Math.abs(d);
          if (gap <= 0) continue;
          var m = gap * (d > 0.01 ? 1 : d < -0.01 ? -1 : (i % 2 ? 1 : -1));
          p.x += nx * m; p.y += ny * m; moved = true;
        }
      }
    }
  };
  // 一步: 每个点一次局部 SMACOF 更新 (Gauss–Seidel, 就地), alpha 决定这一步走多远; 被钉住 (拖动中) 的 fx/fy 不动。
  // g.anchor (拖动时): 每个点额外拴在拖动开始时的位置上, 权重 = 它全部 stress 权重 —— 离被拖点越远越不动;
  // 不拴的话 stress 只认相对距离, 拖一个点整张图会跟着平移。cs = 碰撞力度 (缺省随 alpha); rough = 不做边让点 (首排的粗排阶段, 先让 stress 把大形状排开, 早推会把点推过别的边)。返回这一步最大的位移, 供收敛判断。
  var gStep = function (g, alpha, cs, rough) {
    var ns = g.nodes, n = ns.length, mv = 0;
    if (n < 2) return 0;
    var D = gPrep(g), t = Math.min(1, alpha * 2.5), an = g.anchor;
    for (var i = 0; i < n; i++) {
      var p = ns[i];
      if (p.fx != null) { p.x = p.fx; p.y = p.fy; continue; }
      var sx = 0, sy = 0, sw = 0;
      for (var j = 0; j < n; j++) {
        if (j === i) continue;
        var q = ns[j], d = D[i * n + j], w = 1 / (d * d);
        var dx = p.x - q.x, dy = p.y - q.y, e = Math.sqrt(dx * dx + dy * dy);
        if (e < 0.01) { dx = 0.5 - Math.random(); dy = 0.5 - Math.random(); e = Math.sqrt(dx * dx + dy * dy); }
        sx += w * (q.x + d * dx / e); sy += w * (q.y + d * dy / e); sw += w;
      }
      if (an && an[p.id]) { sx += sw * an[p.id][0]; sy += sw * an[p.id][1]; sw *= 2; }
      var mx = (sx / sw - p.x) * t, my = (sy / sw - p.y) * t;
      p.x += mx; p.y += my;
      mv = Math.max(mv, Math.abs(mx), Math.abs(my));
    }
    gCollide(g, cs == null ? 1 : cs);
    // 边让点是硬约束 (每步把压边的点整段推出去), 不随热量衰减: 软的话热量小时 stress 每帧往回拉一点, 又慢慢压回边上。
    if (!rough) gEdgeClear(g);
    return mv;
  };
  // 径向树起点: 每个连通块从度数最大的点 BFS, 子树按叶子数分扇区、按目标边长外推 —— 树上零交叉, stress 只需微调。
  var gRadialInit = function (g) {
    var ns = g.nodes, dg = gDeg(g), adj = {}, done = {}, offX = 0;
    g.links.forEach(function (l) { (adj[l.s.id] = adj[l.s.id] || []).push(l); (adj[l.t.id] = adj[l.t.id] || []).push(l); });
    var other = function (l, u) { return l.s === u ? l.t : l.s; };
    ns.slice().sort(function (a, b) { return (dg[b.id] || 0) - (dg[a.id] || 0) || (a.id < b.id ? -1 : 1); }).forEach(function (root) {
      if (done[root.id]) return;
      var kids = {}, q = [root], comp = [], leaves = {}, R = 0;
      done[root.id] = true;
      while (q.length) {
        var u = q.shift();
        comp.push(u); kids[u.id] = [];
        (adj[u.id] || []).slice().sort(function (a, b) { return (dg[other(a, u).id] || 0) - (dg[other(b, u).id] || 0); }).forEach(function (l) {
          var v = other(l, u);
          if (done[v.id]) return;
          done[v.id] = true; kids[u.id].push({ v: v, len: gLen(g, l) }); q.push(v);
        });
      }
      var count = function (u) { var k = kids[u.id]; return (leaves[u.id] = k.length ? k.reduce(function (s, c) { return s + count(c.v); }, 0) : 1); };
      var place = function (u, a0, a1, rad) {
        var at = a0;
        kids[u.id].forEach(function (c) {
          var w = (a1 - a0) * leaves[c.v.id] / leaves[u.id], mid = at + w / 2, r = rad + c.len;
          c.v.x = Math.cos(mid) * r; c.v.y = Math.sin(mid) * r; R = Math.max(R, r);
          place(c.v, at, at + w, r); at += w;
        });
      };
      count(root);
      root.x = 0; root.y = 0;
      place(root, -Math.PI, Math.PI, 0);
      comp.forEach(function (p) { p.x += offX + R; });
      offX += 2 * R + GK * 2;
    });
    var cx = 0;
    ns.forEach(function (p) { cx += p.x; });
    cx /= ns.length || 1;
    ns.forEach(function (p) { p.x -= cx; });
  };
  // 主轴转到面板的长边方向: 只转不缩, 距离一概不变 (左栏竖条 / 宽屏都填得满)。
  var gAlign = function (g) {
    var ns = g.nodes, n = ns.length;
    if (n < 3) return;
    var cx = 0, cy = 0, sxx = 0, syy = 0, sxy = 0;
    ns.forEach(function (p) { cx += p.x; cy += p.y; });
    cx /= n; cy /= n;
    ns.forEach(function (p) { var x = p.x - cx, y = p.y - cy; sxx += x * x; syy += y * y; sxy += x * y; });
    var rot = (g.hh >= g.hw ? Math.PI / 2 : 0) - 0.5 * Math.atan2(2 * sxy, sxx - syy), c = Math.cos(rot), s = Math.sin(rot);
    ns.forEach(function (p) { var x = p.x - cx, y = p.y - cy; p.x = x * c - y * s; p.y = x * s + y * c; });
  };
  // 图的画布 (像素): 面板减去标题行与图例 (legendH 量图例实际高度: 窄屏折两行时第二行不被压到底栏下)。
  var gPanel = function () {
    return { w: Math.max(240, (panelBox().w || 332) - 12), h: Math.max(260, (panelBox().h || 620) - 38 - legendH()) };
  };
  // 要多大的缩放才能把整张图 (节点中心 ± 各自的像素包围盒) 放进画布: 节点大小不缩, 只缩中心之间的距离。
  var gFitK = function (g, pn) {
    var x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9, el = 0, er = 0, et = 0, eb = 0;
    g.nodes.forEach(function (p) {
      var b = gBox(p);
      x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y);
      el = Math.max(el, b[0]); er = el; et = Math.max(et, b[1] - b[2]); eb = Math.max(eb, b[1] + b[2]);
    });
    if (!g.nodes.length) return { k: 1, cx: 0, cy: 0 };
    var pad = 14, kx = (pn.w - 2 * pad - el - er) / Math.max(1, x1 - x0), ky = (pn.h - 2 * pad - et - eb) / Math.max(1, y1 - y0);
    return { k: Math.max(0.05, Math.min(kx, ky)), cx: (x0 + x1) / 2, cy: (y0 + y1) / 2 };
  };
  // 间距随画布: 把整张图 (连同目标边长) 按「恰好放满画布」等比缩放, 夹在 0.8~2 倍之间 —— 再小就宁可让图溢出画布 (拖背景平移),
  // 也不把点挤到名字压在一起; 节点本身不缩放。
  var gFitScale = function (g) {
    var f = gFitK(g, gPanel()), s0 = S.gs || 1, s1 = Math.max(0.8, Math.min(2, s0 * f.k)), r = s1 / s0;
    if (Math.abs(r - 1) < 0.02) return false;
    g.nodes.forEach(function (p) { p.x = f.cx + (p.x - f.cx) * r; p.y = f.cy + (p.y - f.cy) * r; });
    S.gs = s1; g._D = null;
    return true;
  };
  // 首次出图: 径向树起点 → stress 跑到收敛 → 主轴对齐面板 → 按估计的标签尺寸再收一段 (碰撞跟上)。确定性, 同一张图每次一样。
  var gLayout = function (g) {
    if (g.nodes.length < 2) { g.nodes.forEach(function (p) { p.x = 0; p.y = 0; }); return; }
    S.gs = 1; g._D = null;
    gRadialInit(g);
    for (var i = 0; i < 300; i++) if (gStep(g, 0.4, undefined, true) < 0.05 && i > 20) break;
    gAlign(g);
    // 按画布定间距: 缩放 → 带碰撞排一段 (碰撞会把图撑大) → 再按画布缩放, 来回三轮, 让「放满画布」时名字不压在一起。
    for (var it = 0; it < 3; it++) {
      gFitScale(g);
      for (var k = 0; k < 60; k++) gStep(g, 0.4 * Math.pow(0.95, k), 0.5);
    }
    // 收尾: stress 步子逐渐收小, 碰撞保持全力 —— 最后由碰撞说了算, 名字标签不压在一起。
    for (var j = 0; j < 80; j++) gStep(g, 0.4 * Math.pow(0.95, j), 0.5);
  };
  // 常驻循环: alpha 逐帧衰减, 衰减到几乎为 0 就停帧; 拖动时 gtarget 把热量吊在 0.3 上。
  // 视野是否还是「整张图」(没缩放 / 平移过): 是的话 drawPos 每帧让视野跟着内容走 (见 gView)。
  var gUntouched = function () { return (S.gzoom || 1) === 1 && !S.gpx && !S.gpy; };
  var gLoop = function () {
    S.graf = 0;
    var g = S.g;
    if (!g || !S.gdom) return;
    gStep(g, Math.max(S.galpha || 0, S.gtarget || 0));
    S.galpha = (S.galpha || 0) * 0.97;
    drawPos(g);
    if (S.galpha > 0.012 || S.gtarget) S.graf = requestAnimationFrame(gLoop);
  };
  var gKick = function (alpha, hold) {
    S.galpha = Math.max(S.galpha || 0, alpha);
    if (hold) S.gtarget = alpha;
    if (!S.graf && S.gdom) S.graf = requestAnimationFrame(gLoop);
  };
  // 换到列表 / 离开图: 停帧, DOM 引用作废; 节点坐标留在 S.gnodes, 回到图时接着用。
  var gStop = function () {
    if (S.graf) cancelAnimationFrame(S.graf);
    S.graf = 0; S.gtarget = 0; S.gdom = null; S.gdrag = '';
  };
  var nodeOn = function (n) {
    return n.isRoom ? (!!D.roomId && D.roomId === n.ref.id) : isRoleId(n.ref.target);
  };
  var nodeCls = function (n) {
    if (n.isRoom) return 'rv-node rv-room' + (nodeOn(n) ? ' on' : '');
    var human = n.ref.kind === 'human';
    return 'rv-node rv-person ' + (human ? 'human' : 'wizard st-' + stateOfNode(n.ref) + (coldOfNode(n.ref) ? ' cold' : '')) + (nodeOn(n) ? ' on' : '') + (n.ref.ghost ? ' ghost' : '');
  };
  // 名字过长用省略号收尾 (全名在节点 <title> 悬停里), 不再硬截成 `DavidDavi` 这种半截词。
  var clipName = function (t, n) { t = String(t); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
  // 帽子底边 y: 戴在「节点圆本身」(不是选中环) 头上 —— 底边两角落在圆弧上 (x = 偏移 + 半宽, 夹在 0.8r 内防小圆开方为负), 中段略陷进圆里, 所以按每个节点自己的半径算、无缝隙。
  var gearY = function (rr, dx, hw) {
    var x = Math.min(Math.abs(dx || 0) + hw, rr * 0.8);
    return -Math.sqrt(rr * rr - x * x);
  };
  // lead: 金色皇冠 (不再用 ★, 免得和 host 的 ⭐ 混) 戴在节点圆的头顶: 底边贴圆上沿 (见 gearY)、选中环从帽下穿过、水平居中, 固定像素 (不随圆大小); 画在 .rv-body 外面, 不跟呼吸动画缩放。
  var leadCrown = function (rr, dx) {
    var k = 1.15, y = gearY(rr, dx, 4.6 * k) - 3.6 * k;
    return '<path class="rv-lead" transform="translate(' + (dx || 0) + ' ' + y.toFixed(1) + ') scale(' + k + ')" d="M-4.6 3.6L-4.6 -2.4L-2.3 0L0 -3.9L2.3 0L4.6 -2.4L4.6 3.6Z"/>';
  };
  // host: 紫色礼帽 (替掉原来 room→host 边上的金色箭头), 与金色皇冠同一行头顶、同样固定像素; 既是 host 又是 lead 时两顶并排 (礼帽左、皇冠右), 各偏 ±6.5 不互相遮。
  var hostHat = function (rr, dx) {
    var k = 1.1, y = gearY(rr, dx, 5.2 * k) - 3.6 * k;
    return '<g class="rv-hosthat" transform="translate(' + (dx || 0) + ' ' + y.toFixed(1) + ') scale(' + k + ')"><path class="hh" d="M-3.3 2L-3.3 -3.9L3.3 -3.9L3.3 2Z"/><path class="hb" d="M-3.3 .4L3.3 .4L3.3 2L-3.3 2Z"/><path class="hh" d="M-5.2 3.6L-5.2 2L5.2 2L5.2 3.6Z"/></g>';
  };
  var headGear = function (rr, host, lead) {
    return (host ? hostHat(rr, lead ? -6.5 : 0) : '') + (lead ? leadCrown(rr, host ? 6.5 : 0) : '');
  };
  var nodeHtml = function (n) {
    if (n.isRoom) {
      var r = n.ref;
      var un = unreadOf(r);
      var dot = un ? '<g class="rv-un"><circle cx="' + (n.w / 2 - 2).toFixed(1) + '" cy="-13" r="' + (un > 9 ? 8 : 7) + '"/><text x="' + (n.w / 2 - 2).toFixed(1) + '" y="-10" text-anchor="middle">' + (un > 99 ? '99+' : un) + '</text></g>' : '';
      return '<title>' + esc(roomLabelOf(r) + ' · ' + roomKindWord(r) + (un ? ' · 未读 ' + un + ' 条' : '') + (r.openDuties ? ' · 未决 duty ' + r.openDuties + ' 件' : '')) + '</title><rect x="' + (-n.w / 2).toFixed(1) + '" y="-13" width="' + n.w.toFixed(1) + '" height="26" rx="9"/>' +
        '<text x="' + (-n.w / 2 + 8).toFixed(1) + '" y="5.5">' + esc(roomIcon(r) + ' ' + clipName(roomLabelOf(r), gNameMax())) + '</text>' + dot;
    }
    var p = n.ref, human = p.kind === 'human', st = stateOfNode(p), rr = n.r;
    var sides = human ? 0 : polySides(p);
    // 本体 (sh) 按聪明程度画 n 边形 (n=0 → 圆), 填色 / 虚线 / 白底都走同一个 .sh 样式, 与形状无关; 选中不再有圆环也不改描边, 只靠名字蓝色加粗 (.on)。
    var shape = function (cls, grow) {
      return polyEl(sides, rr + grow, cls);
    };
    // 用户不画圆: 一个 👤 emoji + 名字 (多位用户靠名字分辨); 选中与否只靠名字蓝色加粗 (.on)。
    if (human) return '<title>' + esc(p.name + ' · 用户') + '</title>' +
      '<g class="rv-body"><text class="rv-emo" y="5.5" text-anchor="middle">👤</text></g>' +
      '<text class="rv-nm" y="' + (rr + 15) + '" text-anchor="middle">' + esc(clipName(p.name, gNameMax())) + '</text>';
    var tip = [p.name, ST_WORD[st], coldOfNode(p) ? COLD_WORD : '', n.host ? '🎩 host' : '', p.lead ? '👑 lead' : '', smartsWord(p.smarts)].filter(Boolean).join(' · ');
    return '<title>' + esc(tip) + '</title>' +
      '<g class="rv-body">' + shape('sh', 0) + '</g>' + headGear(topR(sides, rr), n.host, p.lead) +
      '<text class="rv-nm" y="' + (rr + 15) + '" text-anchor="middle">' + esc(clipName(p.name, gNameMax())) + '</text>';
  };
  // 选中 room 时只有「当前 role → 该 room」那条 (直连线则是它自己) 是 .on.sel; 该 room 的其余成员边保持普通灰, 不抢「哪条是选中的 edge」。
  // role 不是成员 (旧链接) 时没有这条边, 只有 room 节点 .on。
  var edgeCls = function (l) {
    var sel = !!D.roomId && D.roomId === l.room && (l.direct || isRoleId(String(l.b).slice(2)));
    return 'rv-edge' + (l.host ? ' host' : '') + (l.direct ? ' direct' : '') + (l.direct && l.unread ? ' unread' : '') +
      (sel ? ' on sel' : '');
  };
  // 增量同步 DOM: 没了的删, 新的建, 其余只在内容 / class 变了时才写。
  var syncGraphDom = function (svg, g) {
    var dom = S.gdom;
    var layer = function (c) { return svg.querySelector('.' + c); };
    var ids = {}, ks = {};
    g.nodes.forEach(function (n) { ids[n.id] = true; });
    g.links.forEach(function (l) { ks[l.key] = true; });
    Object.keys(dom.nodes).forEach(function (id) { if (!ids[id]) { dom.nodes[id].remove(); delete dom.nodes[id]; } });
    Object.keys(dom.edges).forEach(function (k) {
      if (ks[k]) return;
      dom.edges[k].ln.remove(); if (dom.edges[k].hit) dom.edges[k].hit.remove();
      delete dom.edges[k];
    });
    g.links.forEach(function (l) {
      var d = dom.edges[l.key];
      if (!d) {
        d = { ln: document.createElementNS(SVGNS, 'line'), hit: null };
        layer('rv-gedges').appendChild(d.ln);
        // 每条边 (成员边 / 直连线) 都叠一条透明粗线当点击区: 点边 = 切换这个 room 的选中 (选中的再点 = 取消选中)。
        d.hit = document.createElementNS(SVGNS, 'line');
        d.hit.setAttribute('class', 'rv-hit');
        d.hit.setAttribute('data-link', l.room);
        d.hit.setAttribute('data-edge', l.key);
        d.hit.onclick = function () { if (S.gmoved) return; toggleRoom(l.room); };
        layer('rv-ghits').appendChild(d.hit);
        dom.edges[l.key] = d;
      }
      d.l = l;
      var c = edgeCls(l);
      if (d.ln.getAttribute('class') !== c) d.ln.setAttribute('class', c);
    });
    g.nodes.forEach(function (n) {
      var e = dom.nodes[n.id];
      if (!e) {
        e = document.createElementNS(SVGNS, 'g');
        if (n.isRoom) { e.setAttribute('data-room', n.ref.id); e.onclick = function () { if (S.gmoved) return; toggleRoom(n.ref.id); }; }
        else { e.setAttribute('data-node', n.ref.target); e.onclick = function () { if (S.gmoved) return; goRole(n.ref.target); }; }
        layer('rv-gnodes').appendChild(e);
        dom.nodes[n.id] = e;
      }
      var c = nodeCls(n);
      if (e.getAttribute('class') !== c) e.setAttribute('class', c);
      var h = nodeHtml(n);
      if (e._h !== h) { e._h = h; e.innerHTML = h; }
    });
    // 选中的节点 (含它两侧的 < >) 提到最上层: 邻近节点名字的白色描边 (paint-order: stroke) 否则会盖住 chevron 的一截。
    // 只在有选中节点后面还跟着别的节点时才挪 (新节点按创建顺序排在后面), 平时不动 DOM。
    var nodesLayer = layer('rv-gnodes'), picked = g.nodes.filter(nodeOn).map(function (n) { return dom.nodes[n.id]; }).filter(Boolean);
    var buried = picked.some(function (e) { var nx = e.nextElementSibling; return !!nx && picked.indexOf(nx) < 0; });
    if (buried) picked.forEach(function (e) { nodesLayer.appendChild(e); });
  };
  var bindGraph = function (svg) {
    if (!svg) return;
    // 指针 → 布局坐标: drawPos 的逆 (viewBox 与像素 1:1, 只需扣掉 svg 的位置)。
    var toWorld = function (e) {
      var v = S.gvNow, rc = svg.getBoundingClientRect();
      if (!v) return { x: 0, y: 0 };
      return { x: (e.clientX - rc.left - v.ox) / v.k + v.cx, y: (e.clientY - rc.top - v.oy) / v.k + v.cy };
    };
    var start = null;
    svg.onpointerdown = function (e) {
      var el = e.target.closest ? e.target.closest('[data-node],[data-room]') : null;
      var node = el && el.getAttribute('data-node'), room = el && el.getAttribute('data-room');
      start = { id: node ? 'p:' + node : room ? 'r:' + room : '', el: el,
        x: e.clientX, y: e.clientY, px: S.gpx || 0, py: S.gpy || 0 };
      S.gmoved = false;
      S.gdrag = start.id;
      // 不能在这里 capture: 指针捕获会把随后的 click 改派给 svg, 节点上的点开就失灵了。
      // 等真的开始拖了再捕获。
    };
    svg.onpointermove = function (e) {
      if (!start) return;
      var dx = e.clientX - start.x, dy = e.clientY - start.y;
      if (!S.gmoved && dx * dx + dy * dy < 16) return;
      if (!S.gmoved) {
        try { svg.setPointerCapture(e.pointerId); } catch (err) { /* 老浏览器 */ }
        // 拖节点: 其余点拴在此刻的位置上 (见 gStep 的 anchor), 只有近邻被带着走。
        if (start.id && S.g) { var an = {}; S.g.nodes.forEach(function (p) { an[p.id] = [p.x, p.y]; }); S.g.anchor = an; }
      }
      S.gmoved = true;
      // 拖动期间只改这一处, 不重建 DOM —— 重建会把指针捕获和这次拖拽一起丢掉。
      if (start.id) {
        var w = toWorld(e);
        // 抓住的节点钉在指针上, 热量吊在 0.3: 邻居被弹簧 / 斥力带着走; 松手后放开它继续松弛。
        var node = S.gnodes && S.gnodes[start.id];
        if (node) {
          node.x = w.x; node.y = w.y; node.fx = w.x; node.fy = w.y;
          gKick(0.3, true);
        }
      } else {
        // 平移: 像素直接加到平移量上 (viewBox 与像素 1:1)。
        S.gpx = start.px + dx || 0.001;   // 拖回原点也算动过 (0 会被当成「没平移」, 视野又开始跟内容)
        S.gpy = start.py + dy;
        if (S.g) drawPos(S.g);
      }
    };
    var stop = function (e) {
      var held = start && start.id && S.gnodes && S.gnodes[start.id];
      start = null;
      S.gdrag = '';
      try { svg.releasePointerCapture(e.pointerId); } catch (err) { /* 已释放 */ }
      // 放开钉子, 热量不再吊着: 它和邻居在力的作用下自然落定。
      if (held) { held.fx = null; held.fy = null; }
      if (S.g) S.g.anchor = null;
      S.gtarget = 0;
      gKick(0.15);
    };
    svg.onpointerup = stop;
    svg.onpointercancel = stop;
    svg.onwheel = function (e) {
      e.preventDefault();
      var z = Math.max(0.35, Math.min(4, (S.gzoom || 1) * (e.deltaY < 0 ? 1.12 : 0.89)));
      // 以画布中点为不动点缩放: 平移量跟着同比缩放。只缩放中心之间的距离, 节点 / 字号不变。
      var f = z / (S.gzoom || 1);
      S.gzoom = z; S.gpx = (S.gpx || 0) * f; S.gpy = (S.gpy || 0) * f;
      if (S.g) drawPos(S.g);
    };
    // 双击 = 复位视野并整图重排 (拖乱了 / 增量攒多了时回到确定的那一份)。
    svg.ondblclick = function () { S.gzoom = 1; S.gpx = 0; S.gpy = 0; S.gfit = true; S.grelayout = true; renderGraph(); };
    svg.onclick = function () { setTimeout(function () { S.gmoved = false; }, 0); };
  };
  // 视野: svg 的 viewBox 恒等于它的像素尺寸 (1 单位 = 1 像素), 节点半径 / 名字字号 / 线宽 / 箭头都是固定像素;
  // 视野缩放 (k) 与平移只作用在节点中心的坐标上 —— 屏幕坐标 = (布局坐标 − 中心) × k + 画布中点 + 平移。
  // 没缩放 / 平移过时 k 与中心每帧按内容重算, 增量长出来的节点不会落在框外。k 夹在 0.95~1: 不放大, 也几乎不缩 ——
  // 节点和字是固定像素, 再缩只会把名字压到一起; 画布实在放不下 (手机上三十几个节点) 就溢出, 拖背景平移看其余部分;

  // 动过之后 (或正在拖) 冻结在那一刻, 只叠加用户的缩放 (S.gzoom) 与平移 (S.gpx / S.gpy, 像素)。
  var gView = function (g) {
    var pn = gPanel();
    if (!S.gv0 || (gUntouched() && !S.gdrag)) { var f = gFitK(g, pn); S.gv0 = { k: Math.max(0.95, Math.min(1, f.k)), cx: f.cx, cy: f.cy }; }
    var v0 = S.gv0;
    return { w: pn.w, h: pn.h, k: v0.k * (S.gzoom || 1), cx: v0.cx, cy: v0.cy, ox: pn.w / 2 + (S.gpx || 0), oy: pn.h / 2 + (S.gpy || 0) };
  };
  var drawPos = function (g) {
    var dom = S.gdom, svg = convsEl.querySelector('.rv-graph');
    if (!dom || !svg) return;
    var v = gView(g), box = '0 0 ' + v.w + ' ' + v.h;
    if (svg.getAttribute('width') !== String(v.w)) svg.setAttribute('width', v.w);
    if (svg.getAttribute('height') !== String(v.h)) svg.setAttribute('height', v.h);
    if (svg.getAttribute('viewBox') !== box) svg.setAttribute('viewBox', box);
    S.gvNow = v;
    var X = function (p) { return (p.x - v.cx) * v.k + v.ox; }, Y = function (p) { return (p.y - v.cy) * v.k + v.oy; };
    g.nodes.forEach(function (p) {
      var e = dom.nodes[p.id];
      if (e) e.setAttribute('transform', 'translate(' + X(p).toFixed(1) + ' ' + Y(p).toFixed(1) + ')');
    });
    Object.keys(dom.edges).forEach(function (k) {
      var d = dom.edges[k], l = d.l;
      if (!l || !l.s || !l.t) return;
      var sx = X(l.s), sy = Y(l.s), ex = X(l.t), ey = Y(l.t);
      [d.ln, d.hit].forEach(function (ln) {
        if (!ln) return;
        ln.setAttribute('x1', sx.toFixed(1)); ln.setAttribute('y1', sy.toFixed(1));
        ln.setAttribute('x2', ex.toFixed(1)); ln.setAttribute('y2', ey.toFixed(1));
      });
    });
  };
  // 面板尺寸变了 (窗口缩放 / 旋转屏 / 左栏宽度变): 画布跟着撑满, 间距按新画布重定 (gFitScale, 节点大小不变),
  // 补一点热量让碰撞 / 边让点重新落定; 不重排、不重建。
  var fitToPanel = function (g) {
    var pn = gPanel(), key = pn.w + 'x' + pn.h;
    if (S.gpanel === key) return false;
    var had = !!S.gpanel;
    S.gpanel = key;
    if (had && gFitScale(g)) gKick(0.2);
    return true;
  };
  var GRAPH_LEGEND = '<div class="rv-legend">' +
    '<span><i class="lg wz working"></i>工作中</span><span title="停在审批框 / 弹窗上等人点"><i class="lg wz blocked"></i>等审批</span>' +
    '<span><i class="lg wz idle"></i>空闲</span><span title="pane 不在, 下一句话会重新拉起"><i class="lg wz asleep"></i>休眠</span>' +
    '<span title="叠加属性: 提示缓存已超 TTL, 下一句要重写缓存。空闲 / 休眠的节点都会变白 (休眠的服务端不报缓存, 按最近动静超过 5 分钟估); 工作中 / 等审批不受影响"><i class="lg wz cold"></i>缓存冷 = 白色填充</span>' +
    '<span><span class="lgemo">👤</span>用户</span><span title="room 图标: 多人群聊 (企微群 / topic / 多人 room, 有人参与)"><span class="lgemo">👥</span>群聊</span><span title="room 图标: 人与 wizard 的单聊 (绑定的企微单聊)"><span class="lgemo">💬</span>单聊</span><span title="room 图标: 只有 wizard 的 room (dm / 临时多人)"><span class="lgemo">🧙‍♂️</span>wizard room</span><span title="room 的 host: 本 room 里加入序最小的 wizard"><svg class="lghost" viewBox="-6 -5 12 10" width="13" height="11" aria-hidden="true"><path d="M-3.3 2L-3.3 -3.9L3.3 -3.9L3.3 2Z"/><path class="hb" d="M-3.3 .4L3.3 .4L3.3 2L-3.3 2Z"/><path d="M-5.2 3.6L-5.2 2L5.2 2L5.2 3.6Z"/></svg>host</span>' +
    '<span title="被派来领一件复杂活的 lead (daemon 在 lead 派活时记下, 不能自封)"><svg class="lglead" viewBox="-5 -5 10 10" width="11" height="11" aria-hidden="true"><path d="M-4.6 3.6L-4.6 -2.4L-2.3 0L0 -3.9L2.3 0L4.6 -2.4L4.6 3.6Z"/></svg>lead</span>' +
    '<span title="聪明程度 = 实际在跑的模型 + effort: 三角形 🧒小学生 (haiku) · 四边形 🎒初中生 (sonnet) · 五边形 🎓大学生 (sonnet high 起) · 六边形 🔬研究生 (opus) · 圆 👨‍🏫专家教授 (opus xhigh/max); 认不出模型时按出生档位 mini..ultra; 都没有 = 五边形"><svg class="lgpoly" viewBox="-6 -6 12 12" width="12" height="12" aria-hidden="true">'+polyEl(3,5.2)+'</svg><svg class="lgpoly" viewBox="-6 -6 12 12" width="12" height="12" aria-hidden="true">'+polyEl(0,5.2)+'</svg>边数 = 聪明程度</span>' +
    '</div>';
  // 选中的 role 不在任何可见 room 里 (时间范围把它所有 room 都筛掉了, 或点进了一个只在隐藏 room 里的人 / 只剩一间过期两人 dm 的 wizard) 时,
  // 图里仍要有它 —— 视角总得在图上看得见 (👁 标记照常按 isRoleId 画): 作为没有任何边的孤立节点补进 people。
  // 只补名册里有的 (W.nodes) 或 human: / uid: 形态的 id; 认不出的 id 不凭空造节点。
  var povLoneNode = function (people) {
    if (!D.role || people.some(function (p) { return isRoleId(p.target); })) return null;
    var hit = (W.nodes || []).filter(function (n) { return isRoleId(n.target); })[0];
    if (hit) return hit;
    return /^(human|uid):/.test(D.role) ? nodeOf(D.role) : null;
  };
  var renderGraph = function () {
    if (S.gdrag) return;    // 正在拖: 定时刷新别来动节点
    var rooms = (W.rooms || []).filter(function (r) { return !WIN || inWin(r.last && r.last.at) || (!!D.roomId && D.roomId === r.id); });
    // 谁出现在图上 (admin: 「时间范围筛选有消息的 room, 并展示 room 中成员」): 一条规则 —— 窗口内有消息的 room (最后一条消息在窗口内; 「全部」= 所有 room) → 它的成员 (wizard + 人) 及连线。
    // 不在任何这种 room 里的会话不显示, 没有「活跃 / 在跑 / 未读 / 未决 duty」的例外; 唯一保留的是正在看的那个 room (滑出窗口也不能从眼前消失, 与列表同口径), 视角自己不在图里时由 povLoneNode 补孤立节点。
    var people = participants(rooms).sort(function (a, b) { return (b.lastTs || 0) - (a.lastTs || 0) || (a.name < b.name ? -1 : 1); });
    var lone = povLoneNode(people);
    if (lone) people.push(lone);
    var directs = [];
    rooms = rooms.filter(function (r) {
      var pair = directPair(r, people);
      if (pair) directs.push({ room: r, pair: pair });
      return !pair;
    });
    var rec = reconcileGraph(graphModel(rooms, people, directs));
    var g = rec.g;
    S.g = g;
    var head = sideHead((rooms.length + directs.length) + ' 个 room · ' + people.length + ' 位参与者' + (WIN ? ' (' + winLabel() + ')' : ''));
    var svg = convsEl.querySelector('.rv-graph');
    var first = !svg || !S.gdom;
    if (first) {
      convsEl.innerHTML = head +
        '<svg class="rv-graph"><g class="rv-gedges"></g><g class="rv-ghits"></g><g class="rv-gnodes"></g></svg>' + GRAPH_LEGEND;
      convsEl._html = ''; convsEl._gh = head;
      svg = convsEl.querySelector('.rv-graph');
      S.gdom = { nodes: {}, edges: {} };
      bindHead();
      bindGraph(svg);
    } else if (convsEl._gh !== head) {
      // 只换标题行 (时间窗 / 计数变了), 图原样不动。
      convsEl._gh = head;
      var h = convsEl.querySelector('.convs-h');
      if (h) { h.outerHTML = head; bindHead(); }
    }
    syncGraphDom(svg, g);
    // 整图排一次只在还没排过时 (首次出图 / 双击重排); 从列表切回图沿用常驻坐标, 拖过的位置不丢。
    var lay = first && !S.glaid || S.grelayout;
    if (lay) { gLayout(g); S.glaid = true; S.grelayout = false; S.gpanel = gPanel().w + 'x' + gPanel().h; }
    else fitToPanel(g);
    if (first || S.gfit) { S.gv0 = null; S.gfit = false; }
    drawPos(g);
    if (lay) gKick(0.02);
    else if (rec.changed) gKick(0.35);
    else if (first) gKick(0.05);
  };

  // ── 左栏: 列表 / 图 ─────────────────────────────────────────────────
  // 有人参与 = 群聊: 绑定企微的群 / 单聊 / topic / 微信, 或账本里有人发过话 (人从不 join, 发过话才进成员);
  // 只有 wizard 的 dm / adhoc = 会话。与服务端 room-search 的 isPeopleRoom 同一口径。
  var isDirectRoom = function (r) { return !isPeopleRoom(r) && (r.members || []).length === 2; };
  var isPeopleRoom = function (r) {
    return !!r.bound || (r.kind !== 'dm' && r.kind !== 'adhoc') ||
      (r.members || []).some(function (m) { return m.who && m.who.kind === 'human'; });
  };
  // 视图开关照 main 的「聊天 / 关系」小开关 (.vt): 列表下挂在第一个分组标题右端, 图下挂在图的标题行。
  // 一对图标: 同一套 14px 线描 (stroke 1.5, 圆头), 列表 = 三行带点的条目, 图 = 三个节点连成一张网。
  var LIST_SVG = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="3" cy="4" r=".9" fill="currentColor" stroke="none"/><circle cx="3" cy="8" r=".9" fill="currentColor" stroke="none"/><circle cx="3" cy="12" r=".9" fill="currentColor" stroke="none"/><path d="M6.5 4H14M6.5 8H14M6.5 12H14"/></svg>';
  var TREE_SVG = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M8 5.2 4.6 10.8M8 5.2l3.4 5.6M5.6 12.4h4.8"/><circle cx="8" cy="4" r="2" fill="var(--card)"/><circle cx="3.8" cy="12.4" r="2" fill="var(--card)"/><circle cx="12.2" cy="12.4" r="2" fill="var(--card)"/></svg>';
  // 时间范围下拉: 列表与图共用 (main 的 .sp 小下拉), 挂在标题行右端、视图开关左边。
  var winSelect = function () {
    return dropdown('win', {
      ic: '⏱', end: true, title: '时间范围: 只列这段时间内有动静的 room (正在看的 room、有未读的 room、留着待交代 duty 的 room 照常显示); 图上只画这段时间内有消息的 room 及其成员',
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
      renderGraphSide();   // 成员栏的「窗口外淡灰」跟着范围走
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
    if (!ms.length) return '<span class="av">' + esc(roomIcon(r)) + '</span>';
    return '<span class="av mosaic n' + ms.length + '" aria-hidden="true">' + ms.map(function (m) { return '<i>' + esc(memberLabel(m)) + '</i>'; }).join('') + '</span>';
  };
  var roomItem = function (r) {
    // 选中态不进 HTML (切 room 时整张列表因此重建 ~25-80ms): 由 syncListSel 单独切 class。
    var pv = r.last ? (r.last.authorName ? r.last.authorName + ': ' : '') + r.last.preview : '';
    var nm = r.kind === 'dm' || r.kind === 'adhoc' ? 'wizard' : 'chat';
    // 角标 = 未读数 (与图上红点同一个数, 见 unreadOf); 原来角标上的「未决 duty 数」挪进悬停提示, 成员栏的「待交代」仍在。
    var un = unreadOf(r);
    return '<button class="ci" data-room="' + esc(r.id) + '" title="' + esc(roomTitle(r) + ' · ' + roomKindWord(r) + ' · ' + (r.members || []).length + ' 人' + (un ? ' · 未读 ' + un + ' 条' : '') + (r.openDuties ? ' · 未决 duty ' + r.openDuties + ' 件' : '')) + '">' +
      roomAvatar(r) + '<span class="b">' +
      '<span class="l1"><span class="t"><span class="nm ' + nm + '">' + esc(roomTitle(r)) + '</span></span>' +
        '<span class="ts">' + esc(r.last ? fmtAgo(r.last.at) : '') + '</span></span>' +
      '<span class="l2"><span class="pv">' + esc(pv) + '</span>' +
        (un ? '<b class="ub" title="' + esc('未读 ' + un + ' 条' + (r.openDuties ? ' · 未决 duty ' + r.openDuties + ' 件' : '')) + '">' + (un > 99 ? '99+' : un) + '</b>' : '') + '</span>' +
      '</span></button>';
  };
  var renderList = function () {
    gStop();
    var rooms = scopedRooms();
    var groups = rooms.filter(isPeopleRoom), convs = rooms.filter(function (r) { return !isPeopleRoom(r); });
    // 照 main: 分组标题「群聊 N」「会话 N」, 开关挂在第一个标题的右端; 空着的那一组不画。
    var sec = function (title, tip, list) {
      return list.length ? '<h2 title="' + esc(tip) + '"><span>' + title + '</span><span>' + list.length + '</span></h2>' + list.map(roomItem).join('') : '';
    };
    var body = sec('群聊', '有人参与: 企微群 / 单聊 / topic, 或有人发过话的 room', groups) +
      sec('会话', '只有 wizard: dm / adhoc', convs) || '<h2><span>群聊</span><span>0</span></h2>';
    var html = '<div class="rv-list">' + body.replace('</h2>', sideTools() + '</h2>') + '</div>';
    // 没变就不碰 DOM: 定时刷新会把列表的滚动与焦点蹭掉。
    if (convsEl._html !== html) {
      var top = convsEl.querySelector('.rv-list') ? convsEl.scrollTop : 0;
      convsEl._html = html; convsEl.innerHTML = html;
      convsEl.scrollTop = top;
      bindHead();
      convsEl.querySelectorAll('[data-room]').forEach(function (e) { e.onclick = function () { toggleRoom(e.getAttribute('data-room')); }; });
    }
    syncListSel();
  };
  var syncListSel = function () {
    var cur = D.roomId;
    convsEl.querySelectorAll('.ci').forEach(function (e) {
      var on = !!cur && e.getAttribute('data-room') === cur;
      if (e.classList.contains('on') !== on) e.classList.toggle('on', on);
    });
  };
  // 列表不需要图那么宽: 左栏收窄, 把宽度还给 chat detail (图仍占半屏, 力导向要地方)。
  // ── 侧栏宽度: 拖右缘调, 「列表」与「图」两种视角各记各的 (localStorage wz.sbw.list / wz.sbw.graph); 双击恢复默认; 窄屏不启用。
  var narrow = function () { return !!(window.matchMedia && window.matchMedia('(max-width: 760px)').matches); };
  var SBW_MIN = 220, SBW_MAX = 0.7;
  var sbwKey = function () { return 'wz.sbw.' + (S.view === 'graph' ? 'graph' : 'list'); };
  var sbwClamp = function (w) { return Math.round(Math.max(SBW_MIN, Math.min(w, window.innerWidth * SBW_MAX))); };
  var sbwStored = function () { try { return Number(localStorage.getItem(sbwKey())) || 0; } catch (e) { return 0; } };
  var sideEl = document.querySelector('.side');
  var applySbw = function () {
    if (!sideEl) return;
    var w = sbwStored();
    sideEl.style.width = w && !narrow() ? sbwClamp(w) + 'px' : '';
  };
  if (sideEl && !sideEl.querySelector('.sb-rs')) {
    var rs = document.createElement('div');
    rs.className = 'sb-rs'; rs.title = '拖动调整宽度 · 双击恢复默认'; rs.setAttribute('role', 'separator'); rs.setAttribute('aria-orientation', 'vertical');
    sideEl.appendChild(rs);
    rs.onpointerdown = function (e) {
      if (narrow()) return;
      e.preventDefault();
      var x0 = e.clientX, w0 = sideEl.getBoundingClientRect().width;
      rs.setPointerCapture(e.pointerId); rs.classList.add('drag'); document.body.classList.add('sb-dragging');
      rs.onpointermove = function (ev) { sideEl.style.width = sbwClamp(w0 + ev.clientX - x0) + 'px'; };
      var done = function () {
        rs.onpointermove = rs.onpointerup = rs.onpointercancel = null;
        rs.classList.remove('drag'); document.body.classList.remove('sb-dragging');
        try { localStorage.setItem(sbwKey(), String(Math.round(sideEl.getBoundingClientRect().width))); } catch (er) { /* 无痕 */ }
      };
      rs.onpointerup = rs.onpointercancel = done;
    };
    rs.ondblclick = function () { try { localStorage.removeItem(sbwKey()); } catch (e) { /* 无痕 */ } applySbw(); };
    window.addEventListener('resize', applySbw);
  }
  var renderSide = function () {
    var app = $('#app');
    if (app) app.classList.toggle('side-list', S.view !== 'graph');
    applySbw();
    if (S.pbView !== S.view) { S.pbView = S.view; S.panelBox = null; }   // 列表 / 图两种视角的侧栏宽度不同: 换视角后重读一次面板尺寸
    if (S.view === 'graph') renderGraph(); else renderList();
  };

  // ── 右侧 ───────────────────────────────────────────────────────────
  var chip = function (text, cls) { return text ? '<span class="rv-chip' + (cls ? ' ' + cls : '') + '">' + esc(text) + '</span>' : ''; };
  var ST_CLS = { done: 'ok', passed: 'ok', canceled: 'warn', need: 'ask', progress: 'go', error: 'bad' };
  var KIND_TAG = { ask: '问', task: '派', reply: '答', file: '文件', 'join-req': '申请入群', system: '系统', trigger: '定时' };

  // 右栏头只管「这是哪个窗口」: detail = f(选中的 room, 当前 role)。
  //   只有 role   → 「<role 名> 的全部聊天记录」;
  //   选中 room   → room 名; 有 role 时同一行写成「room 名 × 👁 role 名」: × 夹在两者之间, 语义是「消除前者」(只清掉 room、保留 role), 淡色「👁 role 名」是视角的体现 (不另起副行);
  // 属于这个 role 的入口 (宪章 / 会话) 都在左上名片。取消选中 room 的入口: 这个 ×, 以及再点一次选中的 room (列表 / 图节点 / 图上的边)。
  var CLR_SVG = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M4 4l8 8M12 4l-8 8"/></svg>';
  var header = function (title, sub, acts, clearRoomBtn, pov) {
    chWho.innerHTML = '<div class="rv-trow"><div class="rv-ttl">' + title + '</div>' +
      (clearRoomBtn ? '<button type="button" class="rv-clr" id="rv-clr" title="取消选择 room" aria-label="取消选择 room">' + CLR_SVG + '</button>' : '') + (pov || '') + '</div>' +
      (sub ? '<div class="rv-sub">' + sub + '</div>' : '');
    chActs.innerHTML = acts || '';
    var b = $('#rv-back'); if (b) b.onclick = function () { setPane('msgs'); };
    var x = $('#rv-clr'); if (x) x.onclick = function () { if (D.roomId) toggleRoom(D.roomId); };
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
  // 每成员: 名字 · 角色 (⭐ host / 👑 lead / 人 / 成员) · 状态 (忙 / 闲 / 冷 / 等审批, 色同关系图) ; 下一行 聪明度 · 最近发言;
  // 名下有「待交代」(= 本 room 账本里 chat_ask / 派活 / 人话开出、他还没 chat_reply done|passed|canceled 的 duty) 的挂一枚可展开的红标。
  // 窄屏 (≤760px) 没有第三列的位置: detail 头右侧一个「成员 N」入口, 把同一份 HTML 当底部抽屉铺出来。
  var GS_ST = { working: '忙', blocked: '等审批', idle: '闲', asleep: '休眠' };
  var DUTY_KIND = { ask: '问', task: '派', human: '人话', need: '反问', 'join-req': '入群申请' };
  S.gsOpen = S.gsOpen || {}; S.gsNotice = S.gsNotice || {}; S.gsSheet = false;
  var memberKey = function (m) { return m.kind + ':' + m.id; };
  // 状态与图同口径 (stateOfNode); 名册还没到的占位节点没有 alive, 退回成员视图自带的 alive / busy。
  var memberState = function (m, nd) {
    if (m.kind === 'human') return '';
    if (nd && nd.alive !== undefined) return stateOfNode(nd);
    return m.busy ? 'working' : m.alive ? 'idle' : 'asleep';
  };
  var memberCold = function (m, nd) { return m.kind !== 'human' && !!nd && nd.alive !== undefined && coldOfNode(nd); };
  var dutyHTML = function (d) {
    return '<button type="button" class="gs-dt" data-jump-msg="' + esc(d.msg) + '" title="' + esc('#' + d.seq + ' · ' + (d.askerName || '?') + ' · ' + (DUTY_KIND[d.kind] || d.kind) + (d.last ? ' · 对方回过 ' + d.last.status : '') + '\n' + (d.summary || '') + '\n点击定位到这条') + '">' +
      '<span class="gs-dq"><b>#' + d.seq + '</b> ' + esc(safeName(d.askerName || '?')) + ' · ' + esc(DUTY_KIND[d.kind] || d.kind) + (d.last ? ' · ' + esc(d.last.status) : '') + ' · ' + esc(fmtAgo(d.at)) + '</span>' +
      (d.summary ? '<span class="gs-ds">' + esc(d.summary) + '</span>' : '') + '</button>';
  };
  var renderGraphSide = function () {
    if (!gside) return;
    if (!D.roomId || S.pane === 'plan' || !(D.members || []).length) { gside.hidden = true; gside.innerHTML = ''; S.gsSheet = false; gside.classList.remove('sheet'); return; }
    gside.hidden = false;
    var duties = D.duties || [], byHolder = {};
    duties.forEach(function (d) { if (d.holder) (byHolder[d.holder.kind + ':' + d.holder.id] = byHolder[d.holder.kind + ':' + d.holder.id] || []).push(d); });
    var held = 0;
    // 排序: 人在前; wizard 按 host → 在干活 (忙 / 等审批) → 最近发言 → 名字。人与 wizard 之间一条细线分组, 不另写组标题。
    var wzRank = function (m) {
      var st = memberState(m, nodeOf(nodeIdOf({ kind: m.kind, id: m.id })));
      return (m.host ? 0 : 4) + (st === 'working' || st === 'blocked' ? 0 : 2);
    };
    var ordered = D.members.slice().sort(function (a, b) {
      if ((a.kind === 'human') !== (b.kind === 'human')) return a.kind === 'human' ? -1 : 1;
      if (a.kind === 'human') return (b.lastAt || 0) - (a.lastAt || 0) || (a.name < b.name ? -1 : 1);
      return wzRank(a) - wzRank(b) || (b.lastAt || 0) - (a.lastAt || 0) || (a.name < b.name ? -1 : 1);
    });
    var firstWz = -1;
    ordered.forEach(function (m, i) { if (firstWz < 0 && m.kind !== 'human' && i > 0) firstWz = i; });
    var rows = ordered.map(function (m, idx) {
      // 成员视图里的 id 是 uid / userid; 视角与点击用的是节点 id (target / uid:… / human:…)。
      var nid = nodeIdOf({ kind: m.kind, id: m.id }), me = isRoleId(nid), nd = nodeOf(nid), st = memberState(m, nd), cold = memberCold(m, nd);
      var mine = byHolder[memberKey(m)] || [], open = !!S.gsOpen[memberKey(m)] && mine.length;
      held += mine.length;
      var cls = 'gs-mem ' + m.kind + (m.busy ? ' busy' : m.alive ? ' alive' : '') + (m.host ? ' host' : '') + (me ? ' me' : '');
      // 一行: 状态点 · 名字 · 视角 / host / lead 图标 · (待交代) · 最近发言。学历 / 后端 / 入群方式进 tooltip; 「成员」这种默认值不写。
      var badges = (me ? '<span class="gs-pov" title="当前视角">👁</span>' : '') +
        (m.host ? '<span class="gs-host" title="host: 本 room 里加入序最小的 wizard; 没点名的人话先唤醒它">⭐</span>' : '') +
        (nd.lead ? '<span class="gs-lead" title="被派来领一件复杂活的 lead">👑</span>' : '');
      // 最左边的图标: 人 = 👤; wizard = 按状态着色的聪明程度多边形 (与关系图节点同一套 fill / 虚线), 状态文字进 hover。
      var stWord = st ? (ST_WORD[st] || '') + (cold ? ' · ' + COLD_WORD : '') : '';
      var lead = m.kind === 'human' ? '<span class="gs-role" title="人">👤</span>' : smartsIcon(nd.smarts, st, cold, stWord) + (st === 'blocked' ? '<b class="gs-blk">等审批</b>' : '');
      var tip = [(ST_WORD[st] || '') + (cold ? ' · ' + COLD_WORD : ''), smartsWord(nd.smarts)].filter(Boolean).join(' · ');
      var tipAll = viaText(m) + (tip ? '\n' + tip : '') + (me ? '\n当前视角' : '');
      var ago = m.lastAt ? '<span class="gs-ago" data-node="' + esc(nid) + '" title="本 room 最近一条发言: ' + esc(fmtDay(m.lastAt)) + '">' + esc(fmtAgo(m.lastAt).replace(' ', '')) + '</span>' : '<span class="gs-ago none" data-node="' + esc(nid) + '" title="还没发言">—</span>';
      var due = mine.length
        ? '<button type="button" class="gs-due' + (open ? ' on' : '') + '" data-due="' + esc(memberKey(m)) + '" aria-expanded="' + (open ? 'true' : 'false') + '" title="本 room 里开给 ta、ta 还没 chat_reply 交代 (done / passed / canceled) 的 duty">待交代 ' + mine.length + '<i class="gs-ch"></i></button>' : '';
      // 时间范围 A: 本 room 里最近一次发言落在所选范围之外 (含还没发言) 的成员, 整行文字淡灰 —— 只是提示「这位在窗口里没动静」, 图不动。
      var quiet = !!WIN && !inWin(m.lastAt);
      return '<div class="gs-item' + (quiet ? ' out' : '') + (idx === firstWz ? ' grp' : '') + '"' + (quiet ? ' title="' + esc('窗口 (' + winLabel() + ') 内没有发言') + '"' : '') + '>' +
        '<div class="gs-row"><button class="' + cls + '" data-node="' + esc(nid) + '" title="' + esc(tipAll) + '">' + lead +
        '<span class="nm">' + esc(m.name) + (m.foreign ? ' ↗' : '') + '</span>' + badges + '</button>' + due + ago + '</div>' +
        (open ? '<div class="gs-duties">' + mine.map(dutyHTML).join('') + '</div>' : '') + '</div>';
    }).join('');
    var orphan = duties.length - held;
    // 群公告 (host / 人 /notice 写的): 默认最多两行, 点开展开全文; 空的不显示。
    var rf = roomById(D.roomId), notice = String((D.room && D.room.notice) || (rf && rf.notice) || '').trim();
    var noticeOpen = !!S.gsNotice[D.roomId];
    var noticeEl = notice ? '<button type="button" class="gs-notice' + (noticeOpen ? ' on' : '') + '" id="gs-notice" aria-expanded="' + (noticeOpen ? 'true' : 'false') + '" title="群公告 · 点击' + (noticeOpen ? '收起' : '展开全文') + '"><span class="gs-np">📌</span><span class="gs-nt">' + esc(notice) + '</span></button>' : '';
    gside.innerHTML = noticeEl + '<div class="gs-head"><span class="gs-hl"' + (D.createdAt ? ' title="' + esc('建于 ' + fmtDay(D.createdAt)) + '"' : '') + '>成员 <b>' + D.members.length + '</b>' +
      (duties.length ? ' · <span class="gs-duty" title="本 room 里还开着的 duty 总数: chat_ask / 派活 / 人话开出、处理人还没 chat_reply done · passed · canceled">待交代 ' + duties.length + '</span>' : '') + '</span>' +
      '<button type="button" class="gs-x" id="gs-x" aria-label="关闭成员栏">✕</button></div>' +
      (orphan > 0 ? '<div class="gs-meta"><span>另有 ' + orphan + ' 条在已离开的成员名下</span></div>' : '') +
      '<div class="gs-list">' + rows + '</div>';
    gside.classList.toggle('sheet', S.gsSheet);
    gside.querySelectorAll('[data-node]').forEach(function (el) { el.onclick = function () { setGsSheet(false); goRole(el.getAttribute('data-node')); }; });
    gside.querySelectorAll('[data-due]').forEach(function (el) { el.onclick = function () { var k = el.getAttribute('data-due'); S.gsOpen[k] = !S.gsOpen[k]; renderGraphSide(); }; });
    gside.querySelectorAll('[data-jump-msg]').forEach(function (el) { el.onclick = function () { setGsSheet(false); jumpRow({ id: el.getAttribute('data-jump-msg'), room: D.roomId }); }; });
    var gx = $('#gs-x'); if (gx) gx.onclick = function () { setGsSheet(false); };
    var gn = $('#gs-notice'); if (gn) gn.onclick = function () { S.gsNotice[D.roomId] = !S.gsNotice[D.roomId]; renderGraphSide(); };
  };
  var setGsSheet = function (on) { S.gsSheet = !!on; if (gside) gside.classList.toggle('sheet', S.gsSheet); };
  // 窄屏入口: detail 头右侧「成员 N」(有待交代时带红点); 宽屏 CSS 把它藏起来。
  var membersBtn = function () {
    var n = (D.members || []).length;
    return n ? '<button type="button" class="rv-act gs-open" id="gs-open" aria-label="成员栏">👥 ' + n + ((D.duties || []).length ? '<i class="gs-pip"></i>' : '') + '</button>' : '';
  };
  // 一条消息 = 气泡外的一行头 (谁 → 谁 · 哪个 room · 状态 · 时刻) + 一颗气泡。
  // 头在外面是历史方案: 气泡只装正文, 身份与路由不跟着正文一起被染色。
  // 说给谁: 显式 to; 没写 to 的 reply 就是答它 re 的那几行的作者 (服务端按账本补的 reTo)。
  // 显式 to → 服务端按 re 补的 reTo → 人话的 wakeTo (账本行 wake: 这一行当时唤醒了谁); 都空才只画 `发送人 —room→`。
  var recipientsOf = function (m) { return m.to && m.to.length ? m.to : (m.reTo && m.reTo.length ? m.reTo : (m.wakeTo || [])); };
  var whoTags = function (list) {
    var seen = {};
    return (list || []).filter(function (w) { var k = w.kind + ':' + w.id; if (seen[k]) return false; seen[k] = 1; return true; })
      .map(function (t) { return '<span class="rv-tag" data-node="' + esc(nodeIdOf(t)) + '">' + esc(nodeNameOf(t)) + '</span>'; }).join(', ');
  };
  // 气泡: 正文 (markdown) + 附件 + 折叠成标签的 reminder (<envelope · x> / <roster> …, 点开看原文)。
  // 引用块: 这条消息答的是哪一条 (re) —— 发话人 + 首行摘要, 点击跳到原消息。取代头部的「答」小标与裸 id; 只在 chat detail 里, 企微侧不变。
  // 多个 re 只画第一条, 其余收成「+N」(点开看全); 服务端 lookup 不到的 (较早已裁掉) 降级成「↩ 较早的消息」。
  var quoteItem = function (q) {
    var who = q.missing ? '' : '<span class="rq-who ' + (q.author && q.author.kind === 'human' ? 'human' : 'wizard') + '">' + esc(safeName(q.authorName || '')) + '</span>';
    var tx = q.missing ? '<span class="rq-tx rq-gone">↩ 较早的消息</span>' : '<span class="rq-tx">' + esc(q.snippet || '(无正文)') + '</span>';
    return '<button type="button" class="rq-it" data-qid="' + esc(q.id) + '" data-qroom="' + esc(q.room || '') + '"' + (q.missing ? ' data-qgone="1"' : '') + '>' + who + tx + '</button>';
  };
  var quoteHTML = function (m) {
    var qs = m.reQuote;
    if (!qs || !qs.length) return '';
    var rest = qs.slice(1);
    return '<div class="rv-quote">' + quoteItem(qs[0]) +
      (rest.length ? '<button type="button" class="rq-more" aria-expanded="false" title="还引用了另外 ' + rest.length + ' 条">+' + rest.length + '</button>' : '') +
      (rest.length ? '<div class="rq-rest" hidden>' + rest.map(quoteItem).join('') + '</div>' : '') + '</div>';
  };
  // 头部尾巴: 「答」「done」是引用块 / 常态本身已说明的, 不再画小标; 留有语义的状态 (progress / need / error / canceled / passed) 与其它 kind (问 / 派 / 系统 …)。
  var kindStatusTail = function (m) {
    var k = m.kind === 'reply' ? '' : (KIND_TAG[m.kind] || '');
    var st = m.status && m.status !== 'done' ? chip(m.status, 'st ' + (ST_CLS[m.status] || '')) : '';
    return chip(k, 'kind') + st;
  };
  var bubbleHTML = function (m) {
    var quote = quoteHTML(m);
    var files = (m.files || []).map(function (f) { return chip('📎 ' + f.name, 'file'); }).join('');
    var body = m.text && m.text.trim() ? md(m.text) : '';
    if (!body && !files && !m.rems && !quote) return '';
    return '<div class="rv-bub">' + quote + (body ? '<div class="rv-tx">' + body + '</div>' : '') +
      (files ? '<div class="rv-files">' + files + '</div>' : '') + (m.rems || '') + '</div>';
  };
  // 消息头 = 一条「去向」, 整条只有一个箭头: 私聊 `发送人 → 收件人`; 群聊 `发送人 —room→ 收件人`, room 名朴素地嵌在箭头线上 (可点跳转)。
  // 缺收件人时群聊只画 `发送人 —room→`。DOM 永远按阅读顺序排, 靠 CSS 镜像:
  // .me (气泡靠右) 整行 row-reverse + 箭头翻成 ←, 发送人总是贴着气泡的那一侧; 窄屏折行而不是溢出。
  var routeHead = function (o) {
    var arrow = o.room ? '<span class="rv-arr rv-via">' + o.room + '</span>' : '<span class="rv-arr" aria-hidden="true"></span>';
    var path = [o.au, o.to].filter(Boolean).join(arrow);
    if (!o.to && o.room) path += arrow;
    return '<div class="rv-mh' + (o.cls ? ' ' + o.cls : '') + '"><span class="rv-path">' + path + '</span>' + (o.tail || '') + '</div>';
  };
  var msgHTML = function (m, ctx) {
    var author = nodeIdOf(m.author);
    // 「我」= 当前视角 (role): 它说的行靠右, 其余靠左 —— room 选中与否都一样。
    var me = m.author.kind === 'human' ? author === D.role
      : m.author.kind === 'wizard' && (isRoleId(author) || (!!D.uid && m.author.id === D.uid));
    var to = whoTags(recipientsOf(m));
    // 有引用块时不再画裸 id 小标 (↩ 166); 没有 reQuote (老回包) 才退回。
    var re = m.reQuote ? '' : (m.re || []).map(function (id) { return chip('↩ ' + String(id).split('.').pop(), 're'); }).join('');
    var room = ctx && m.roomLabel ? roomTagOf(m.room, m.roomLabel) : '';
    var turn = m.turn ? '<button class="rv-open" data-turn="' + esc(m.turn) + '" aria-expanded="false" title="展开 / 收起这一轮的过程">过程<i class="rv-och" aria-hidden="true"></i></button>' : '';
    var bub = bubbleHTML(m) || '<div class="rv-bub"><p class="rv-empty">(无正文)</p></div>';
    return '<article class="rv-msg ' + (me ? 'me' : 'them') + ' k-' + esc(m.kind) + '" data-id="' + esc(m.id) + '">' +
      // 过程发生在这句话之前: 过程框排在头与气泡之上 (框 → 头 → 气泡), 与一轮里「先过程、后回复」的时间顺序一致。
      '<div class="rv-box" hidden></div>' +
      routeHead({
        au: '<span class="rv-au ' + esc(m.author.kind) + '" data-node="' + esc(author) + '">' + esc(m.authorName) + '</span>',
        room: room, to: to,
        tail: '<time>' + esc(fmtDay(m.at)) + '</time>' + turn + kindStatusTail(m) + re
      }) + bub +
      '</article>';
  };
  var listHTML = function (msgs, ctx) {
    if (!msgs.length) return '<div class="rv-none">这里还没有消息。</div>';
    return msgs.map(function (m) { return msgHTML(m, ctx); }).join('');
  };
  // ── wizard 时间轴: 轮次为主线 (入 = 问的那句, 出 = 回复 + 过程框), 账本行挂在轮上 ──
  // 出消息的正文/工具调用是服务端渲染好的 HTML (renderTurnGroup), 直接注入 —— 工具正文
  // 仍是空壳, 展开时由 loadTool 去 /api/tool 取。
  // 私聊 (dm / adhoc, 不绑定传输) 在任何页面都只画单箭头 `A → B`, 不带 room 名; 只有绑定企微的群才把 room 嵌进箭头线。
  var roomTagOf = function (room, label) {
    if (/^(?:dm|adhoc):/.test(String(room))) return '';
    return '<span class="rv-roomtag" data-jump-room="' + esc(room) + '">' + esc(roomNameOf(roomById(room), label)) + '</span>';
  };
  // 一轮写进账本的那几行 = 这一轮说出去的话, 一行一颗气泡 (CLI 终句只在上面的过程框里)。
  // 每颗气泡头顶自带「我 → 群 → 收件人」: 过程框里发消息的调用不再重复这些, 所以一行也不省。
  // 这一轮的耗时 / token 统计 (f.meta) 只挂在第一颗的头上。
  var spokenHTML = function (list, f) {
    return list.map(function (m, i) {
      var to = whoTags(recipientsOf(m)) || toTagOf(f);
      var head = routeHead({
        cls: 'rv-smh', au: auOf(f), room: roomTagOf(m.room, m.roomLabel || m.room), to: to,
        tail: kindStatusTail(m) +
          '<time>' + esc(fmtDay(m.at)) + '</time>' + (i === 0 && f.meta ? '<span class="mstat">' + f.meta + '</span>' : '')
      });
      return '<div class="rv-spk" data-said="' + esc(m.id) + '">' + head + (bubbleHTML(m) || '<div class="rv-bub"><p class="rv-empty">(无正文)</p></div>') + '</div>';
    }).join('');
  };
  var toTagOf = function (f) {
    return f.to ? '<span class="rv-tag" data-node="' + esc(f.to) + '">' + esc(f.toName || f.to) + '</span>' : '';
  };
  var auOf = function (f) {
    return '<span class="rv-au wizard" data-node="' + esc(f.from || '') + '">' + esc(f.fromLabel || '🧙‍♂️') + ' ' + esc(f.fromName || D.role) + '</span>';
  };
  var streamHTML = function (rows) {
    if (!rows.length) return '<div class="rv-none">这里还没有消息。</div>';
    return rows.map(function (f) {
      if (f.kind === 'mark') return '<div class="rv-mark" data-id="' + esc(f.id) + '">' + f.html + '</div>';
      if (f.kind === 'ledger') return msgHTML(f.row, true);
      var room = f.roomLabel ? roomTagOf(f.room, f.roomLabel) : '';
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
          routeHead({
            au: '<span class="rv-au' + (f.from === 'system:' ? ' daemon' : /^human:/.test(f.from || '') ? ' human' : '') + '" data-node="' + esc(f.from === 'system:' ? '' : f.from) + '">' +
              esc(f.fromLabel || '👤') + ' ' + esc(f.fromName || f.from) + '</span>',
            room: room, to: toTagOf(f),
            tail: '<time>' + esc(fmtDay(f.ts)) + '</time>' + injchips + tags + raw
          }) +
          bubbleHTML({ text: f.text, rems: f.rems }) + rawBody + '</article>';
      }
      // 出一侧: 过程框在上, 写进账本的气泡在下, 每颗气泡头顶自带「我 → 群 → 说给谁」(见 spokenHTML)。
      // 过程框本身不挂头; 只有这一轮什么都没说出去时才在框上留一行头 (去向 = 私聊 / 谁), 否则框就无主了。
      var said = f.said || [];
      var head = said.length ? '' : routeHead({
        au: auOf(f), room: room, to: toTagOf(f),
        tail: '<time>' + esc(fmtDay(f.ts)) + '</time>' + (f.era && !f.staleAt ? chip('未发言', '') : '') +
          (f.meta ? '<span class="mstat">' + f.meta + '</span>' : '')
      });
      return '<article class="rv-msg me" data-id="' + esc(f.id) + '">' + head +
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
  var roleNodeName = function () { return (D.wizard && D.cardRole === D.role && D.wizard.name) || (nodeOf(D.role) || {}).name || D.role; };
  var canOpen = function (n) { return !!n; };
  var openNode = function (target) { if (target) goRole(target); };
  // 两处数据源都认: 名册快照 (world, 每 6s 一次) 与这一页刚取的名片 (api/wizard)。
  // 同一份 plan 取 revision 大的那版 —— 免得晚到的旧回包把新状态盖回去。
  var plansForRole = function () {
    var by = {};
    (W.plans || []).filter(function (p) { return isRoleId(p.owner); }).forEach(function (p) { by[p.id] = p; });
    (D.plans || []).forEach(function (p) {
      var old = by[p.id];
      if (!old || (p.revision || 0) >= (old.revision || 0)) by[p.id] = p;
    });
    return Object.keys(by).map(function (id) { return by[id]; }).sort(function (a, b) { return (b.updatedAt || 0) - (a.updatedAt || 0); });
  };
  // world 快照里有全量定时任务 (带 gate / 出错); 它还没到手时才退回名片里那几列。
  var schedulesForRole = function () {
    var pool = (W.schedules || []).length ? W.schedules : (D.schedules || []);
    return pool.filter(function (x) { return isRoleId(x.owner || x.createdBy || x.target); })
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
    if (D.roomId && S.pane !== 'plan') renderRoom(); else renderWizard(true);
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
    if (!planEl) return;   // 没有日程栏的壳 (测试 fixture) 里窗口缩放也不该抛错
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
  // 左上角 = 这一页的主张: 站在谁的位置上 (role, 视角), 它一睁眼背着什么 (宪章), 家在哪、什么时候出生。
  // 永远是 role 的名片: 选中 room 只换右侧的 detail, 不换名片。
  var fact = function (ic, txt, tip, attr, tone) {
    var cls = 'fx' + (attr === 'charter' && S.charter ? ' on' : '') + (attr === 'plan' && S.pane === 'plan' ? ' on' : '') + (tone ? ' ' + tone : '');
    return '<span' + (attr ? ' class="' + cls + '" data-rb="' + attr + '"' : '') + ' title="' + esc(tip || txt) + '">' + ic + ' ' + esc(txt) + '</span>';
  };
  // room 没有名字时服务端会把成员名拼起来当 label —— 那是给关系用的, 不能当标题。
  var roomTitle = function (r) {
    if (!r) return D.roomId;
    if (r.title || W.chatNames[r.id]) return r.title || W.chatNames[r.id];
    if (r.kind === 'dm') {
      // dm 拉进第三人后是多人 room: 列全员 (两人时就是原来的「A、B」)。
      var all = (r.members || []).map(function (m) { return m.name; }).filter(Boolean);
      return all.length ? all.join('、') : '私聊';
    }
    // 没起名的 adhoc: 列表里一排「临时 room」认不出谁是谁 —— 带上前几位成员。
    if (r.kind === 'adhoc') {
      var few = (r.members || []).slice(0, 3).map(function (m) { return m.name; }).filter(Boolean);
      return few.length ? '临时 · ' + few.join('、') + ((r.members || []).length > 3 ? ' 等' : '') : shortRoom(r.id);
    }
    return shortRoom(r.id);
  };
  // 🏠 = 这个 wizard 的主群: target key 的 base principal 那个聊天 (不是创建者 —— 创建者另起「👤 创建者」)。
  // 名字取 room 列表里显示的那个 (host 起的别名优先), 没有才用服务端给的聊天名; 都没有就不画, 不拿 id 凑数。
  var homeFact = function (w) {
    var hr = w.chatId ? roomById(w.chatId) : null, nm = hr ? roomNameOf(hr, w.chat) : w.chat;
    return nm ? fact('🏠', '主群 ' + nm, '主群: ' + nm + ' (这个 wizard 常驻的聊天; ' + (w.chatId || '') + ')') : '';
  };
  var rolebar = function () {
    var el = $('#rb-who');
    if (!el) return;
    var w = D.wizard;
    // 名片还是上一个 role 的 (刚换 role、新名片在路上 / 取失败): 不画旧人, 先用名册里的名字占位 —— 否则顶栏已是「新人的视角」名片却还是旧人。
    if (!w || D.cardRole !== D.role) {
      if (!D.role) { el.innerHTML = ''; return; }
      var ph = nodeOf(D.role);
      el.innerHTML = '<div class="id"><span class="av">' + esc(ph.label || '🧙‍♂️') + '</span><span class="l"><span class="nl"><span class="nm">' + esc(ph.name || D.role) + '</span></span></span></div>';
      return;
    }
    var born = w.bornAt || (D.sessions || []).reduce(function (m, s) { return s.start && (!m || s.start < m) ? s.start : m; }, 0);
    var cb = D.charterBrief;
    // 链接指的那个化身 (target 的 #tag) 与这一页的规范身份不同时说出来 —— 同身份多化身在
    // rolepage 聚成一页 (见 makeDirectory 的 canon), 不说明会看着像「点错了 / 没选中」。
    // 只在还停在链接指的那个 role 上时才提示; 点开别人之后这句就不属于眼前这一页了。
    var want = S.roleMoved ? '' : ROLE.indexOf("#") > 0 ? ROLE.split("#").pop() : (/^(chat|user):/.test(ROLE) ? ROLE : "");
    var tip = want && want !== (w.name || "") && ROLE !== w.id
      ? fact("🔗", "链接指向 " + want, "链接来自 " + want + "; 它与 " + (w.name || w.id) + " 是同一个身份的化身, 这一页是它的规范页") : "";
    // 日程排最后, 可点: 名下排了什么 (main 的口径 —— 名片是这一栏唯一的入口)。
    var pf = schedulesForRole().length || plansForRole().length ? planFact() : null;
    // lead / 聪明程度在名册快照 (world) 的节点上; 快照还没到 (svr 刚重启) 时 nodeOf 给的占位没有这两项, 名片就不画。
    var nd = nodeOf(w.id);
    var facts = [
      tip,
      homeFact(w),
      w.parent && w.parent.name ? fact('👤', '创建者 ' + w.parent.name, '创建者: ' + w.parent.name + ' (spawn / clone 出它的 wizard, 管理上的 parent)') : '',
      born ? fact('🐣', fmtAgo(born), '出生于 ' + fmtDay(born)) : '',
      nd.kind !== 'human' ? '<span class="fx-smi" title="' + esc(smartsWord(nd.smarts)) + '">' + smartsIcon(nd.smarts) + '</span>' : '',
      cb ? fact('📜', '≈' + fmtTok(cb.tokens), '宪章 ≈' + fmtTok(cb.tokens) + ' token · ' + fmtClock(cb.at) + ' 压进系统提示 · 点开看全文', 'charter') : '',
      w.cwd ? fact('🗂️', shortCwd(w.cwd), w.cwd) : '',
      pf ? fact(pf[0], pf[1], pf[2], pf[3], pf[4]) : '',
      nd.lead ? '<span class="lead" title="被派来领一件复杂活的 lead (daemon 在 lead 派活时记下, 不能自封)">👑 lead</span>' : '',
    ].filter(Boolean).join('');
    var st = w.busy ? '<span class="rv-chip go">执行中</span>'
      : w.waiting && w.waiting.length ? '<span class="rv-chip warn">等审批 ' + esc(w.waiting.join(',')) + '</span>'
      : w.alive ? '<span class="rv-chip ok">在线</span>' : '<span class="rv-chip">冷</span>';
    // 会话切换属于「这个角色」: 放在左上的名片里, 不占右栏头。
    // 会话切换 = main 的那个下拉 (name 右边): 只有一段就没什么可选, 不挂。
    // 选中 room 时不挂: session 只作用于「全部记录」那一页。
    var sess = !D.roomId && (D.sessions || []).length > 1 ? sessPicker() : '';
    el.innerHTML = '<div class="id"><span class="av">' + esc(w.label || '🧙‍♂️') + '</span><span class="l">' +
      '<span class="nl"><span class="cp" title="' + esc('点击复制 ' + (w.name || w.id)) + '"><span class="nm">' + esc(w.name || w.id) + '</span></span>' +
      '<span id="rb-st">' + st + '</span><span id="rb-sp">' + sess + '</span></span>' +
      (facts ? '<span class="facts">' + facts + '</span>' : '') +
      '</span></div>' + (w.description ? '<p class="job">' + esc(w.description) + '</p>' : '');
    var jb = el.querySelector('.job');
    if (jb) {
      if (jb.scrollHeight > jb.clientHeight + 1) { jb.classList.add('more'); jb.title = '点击展开 / 收起'; }
      jb.onclick = function () { if (jb.classList.contains('more')) jb.classList.toggle('open'); };
    }
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
    if (S.pane === 'plan') return renderWizard(true);   // 日程是 role 的另一面: 选中着 room 也照样画它
    var r = D.room || { id: D.roomId, kind: 'wecom-group', members: [], openDuties: 0 };
    var label = roomTitle(r);
    // 顶栏 = room 名 (+ 有 role 时一枚「👁 role 名」与 ×): 视角的详情在左上名片; host / 成员 / 绑定在成员侧栏。
    header(esc(label), '', membersBtn(), !!D.role,
      D.role ? '<span class="rv-pov-tag" title="' + esc('当前视角: ' + roleNodeName() + ' (消息按 ta 的位置排左右, 自己说的靠右)') + '">👁 ' + esc(roleNodeName()) + '</span>' : '');
    var gso = $('#gs-open'); if (gso) gso.onclick = function () { setGsSheet(!S.gsSheet); };
    rolebar();
    renderUsage();
    renderGraphSide();
    var older = D.earlier ? '<button class="rv-older" id="rv-older">‹ 更早</button>' : '';
    inner.innerHTML = older + listHTML(D.msgs, false) + (S.charter ? '<section class="rv-charter">' + S.charter + '</section>' : '');
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
    // 没选中 room 时标题 =「<role 名> 的全部聊天记录」: 这一页 = 这个 role 在所有 room 里的记录 (不写「视角」)。
    header(plan ? '<span class="rv-lb">📅</span> 日程与计划' : esc(roleNodeName()) + ' 的全部聊天记录',
      plan ? esc(roleNodeName()) + ' 名下的定时任务与计划' : '',
      plan ? '<button class="rv-act" id="rv-back">‹ 对话</button>' : '');
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
  // 服务端回包 → D: 名册缺席时拿 id 当名字 (成员 / 发话人), 一律过一遍 safeName, 名册到了下一轮取回来就是真名。
  var applyRoom = function (r) {
    var fixM = function (ms) { return (ms || []).map(function (m) { return m && m.name && ID_LIKE.test(m.name) ? Object.assign({}, m, { name: safeName(m.name) }) : m; }); };
    if (r.room && r.room.members) r.room = Object.assign({}, r.room, { members: fixM(r.room.members) });
    D.room = r.room; D.label = r.label || ''; D.members = fixM(r.members); D.duties = r.duties || []; D.createdAt = r.createdAt || 0;
    D.msgs = (r.msgs || []).map(function (m) { return m && m.authorName && ID_LIKE.test(m.authorName) ? Object.assign({}, m, { authorName: safeName(m.authorName) }) : m; });
    D.total = r.total || 0; D.earlier = r.earlier || ''; D.at = r.at;
  };
  // 每个 room 最近一次的回包: 点开时先用它即时渲染 (不等网络), 后台照常取新的盖上去。只存 60 条的首页, 最多 12 个 room。
  var roomCache = {}, roomCacheOrder = [];
  var cacheRoom = function (id, r) {
    if (!roomCache[id]) { roomCacheOrder.push(id); if (roomCacheOrder.length > 12) delete roomCache[roomCacheOrder.shift()]; }
    roomCache[id] = r;
  };
  // poll = 定时刷新 (tick), 区别于人点开: 回包与上一份没有差别就一个字也不碰 DOM; 有差别时滚动位置在「替换 innerHTML 的那一刻」现取现还
  // (旧写法在发请求前取、回包后还: 请求在路上时用户滚过的距离被拽回去 —— 远端 svr 上每 4s 一次、可见), 只有贴底才跟随新内容。
  var loadRoom = function (id, limit, instant, poll) {
    // room = 选中态, role 不动 (名片 / 宪章属于 role); 名片没跟上这个 role 就补取一次。
    if (!poll) { D.mode = 'room'; D.roomId = id; D.mode0 = 'room'; resetPane(); syncUrl(); if (D.cardRole !== D.role) loadCard(); }
    // 后发先至: 定时刷新的那一发晚于点开 / 搜索跳转回来时, 丢掉它 (不然会把视图拽回旧 room / 拽回底部)。
    var gen = poll ? S.roomGen : (S.roomGen = (S.roomGen || 0) + 1);
    var shown = false;
    if (instant && roomCache[id] && roomCache[id].ok) { applyRoom(roomCache[id]); renderRoom(); scrollBottom(); shown = true; S.roomSig = ''; }
    return api('api/room', { room: id, limit: limit || 60 }).then(function (r) {
      if (gen !== S.roomGen || D.roomId !== id) return false;
      if (!r.ok) { inner.innerHTML = '<div class="rv-none">' + esc(r.error || '加载失败') + '</div>'; if (gside) gside.hidden = true; return; }
      if (!limit || limit <= 60) cacheRoom(id, r);
      var sig = id + '|' + JSON.stringify(Object.assign({}, r, { at: 0 }));
      if (poll && sig === S.roomSig) { D.at = r.at; return false; }
      S.roomSig = sig;
      var st = scrollState();
      applyRoom(r);
      renderRoom();
      if (poll || shown) {
        var hr = S.hit && S.hit.until > Date.now() && rowEl(S.hit.id);
        if (hr) hr.scrollIntoView({ block: 'center' }); else restore(st);
      } else scrollBottom();
    });
  };
  // 名片 (api/wizard?card=1): role 的身份 / 用量 / 日程 / 宪章摘要, 不带消息与时间轴。两种视角共用: 全部记录由 loadWizard 带回同一份,
  // 选中 room 时消息来自 /api/room, 名片仍要 role 的 —— 只取这一份。D.cardRole = 这份名片属于哪个 role。
  var applyCard = function (r) {
    D.wizard = r.role; D.uid = r.uid || ''; D.ledger = r.ledger !== false;
    D.plans = r.plans || []; D.schedules = r.schedules || []; D.charterBrief = r.charter || null; D.stats = r.stats || null;
    D.sessions = r.sessions || []; D.at = r.at; D.recvAt = Date.now(); D.cardRole = D.role; S.cardAt = Date.now();
  };
  var loadCard = function () {
    var role = D.role;
    if (!role) return Promise.resolve(false);
    return api('api/wizard', { role: role, card: '1' }).then(function (r) {
      if (!r.ok || role !== D.role) return false;
      var fresh = D.cardRole !== ((r.role && r.role.id) || role);
      if (r.role && r.role.id && r.role.id !== D.role) { D.role = r.role.id; syncUrl(); }
      applyCard(r);
      if (D.roomId && D.mode === 'room') {
        // 名片到手: 「我」(D.uid) 与顶栏的视角名才算得准, 第一次到要把 room 重画一遍 (滚动位置不动); 之后 6s 一刷只换名片与用量, 不碰消息。
        rolebar(); renderUsage();
        if (fresh) { var st = scrollState(); renderRoom(); restore(st); }
      }
      return true;
    }).catch(function () { return false; });
  };
  var loadWizard = function (role, keepScroll) {
    // 换一个人 = 换一段对话: 日程栏 / 宪章只属于刚才那个人, 收回对话面。
    if (role && role !== D.role) { S.charter = null; resetPane(); }
    D.mode = 'wizard'; D.role = role || D.role; D.roomId = ''; syncUrl();
    return api('api/wizard', { role: role, session: D.session === 'all' ? '' : D.session, limit: 60 }).then(function (r) {
      if (!r.ok) { inner.innerHTML = '<div class="rv-none">' + esc(r.error || '加载失败') + '</div>'; return false; }
      // 回包回来时已经换成选中 room / 换了别人: 这一份作废 (定时刷新的那一发常这样迟到)。
      if (D.mode !== 'wizard' || (role && D.role !== role && !(r.role && D.role === r.role.id))) return false;
      var rid = (r.role && r.role.id) || D.role;
      var same = D.mode0 === 'wizard' && D.role0 === rid && !!D.stream && D.streamSig === streamSig(r.stream);
      D.mode0 = 'wizard'; D.role0 = rid;
      // 没在 URL 里指定视角的老链接 / 只有 id 的票据 / 用名字点进来的: 认下规范身份并回写 URL。
      if (rid !== D.role) { D.role = rid; syncUrl(); }
      D.msgs = r.msgs || []; D.total = r.total || 0; D.earlier = r.earlier || '';
      D.stream = r.stream || null; D.streamSig = streamSig(r.stream);
      D.session = r.session || 'all'; applyCard(r);
      D.members = []; D.duties = []; D.createdAt = 0;
      var st = scrollState();   // 替换 DOM 的那一刻现取, 不是发请求前
      renderWizard(same);
      if (!same) { if (keepScroll) restore(st); else scrollBottom(); }
      return true;
    });
  };
  // 窄屏 (≤760px) 是「列表 / 图」与「chat detail」二选一的两页: CSS 默认只显示 .side, 加了 .app.reading 才换成 .main。
  // 这个 class 曾经没有任何代码会加 —— 窄屏点进聊天后 detail 一直被 display:none, 只看得到列表 / 图。
  // 人主动点开 (列表 / 图 / 搜索 / 成员 / 深链) 才进 detail; 定时刷新直接调 loadRoom / loadWizard, 不翻页。
  var appEl = $('#app');
  var setReading = function (on) { if (appEl) appEl.classList.toggle('reading', !!on); };
  // ── 返回栈: detail 里点进别的 role / room 时压一格 (连同滚动位置), 顶栏出 ← 回去; 同时压一条浏览器历史,
  // 手机的系统返回手势 / 浏览器后退走同一条路 (popstate)。窄屏从列表 / 图点进 detail 也压一格 'list', 返回 = 回列表。
  // 只有「从 detail 区里发起」的跳转才压 view 格 —— 侧栏 / 图里点来点去是平级切换, 不堆栈。
  S.stack = []; S.fromMain = false;
  document.addEventListener('click', function (e) { S.fromMain = !!(e.target && e.target.closest && e.target.closest('.main')); }, true);
  var chatheadEl = $('#chathead');
  var BACK_SVG = '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10 3 5 8l5 5"/></svg>';
  var tbb = $('#tb-back');
  if (tbb && !tbb.querySelector('svg')) tbb.innerHTML = BACK_SVG;
  var syncJb = function () {
    if (!chatheadEl) return;
    var top = S.stack[S.stack.length - 1], on = !!top && top.k === 'view', jb = chatheadEl.querySelector('#tb-jb');
    if (!on) { if (jb) jb.remove(); return; }
    if (!jb) {
      jb = document.createElement('button');
      jb.className = 'back jb'; jb.id = 'tb-jb'; jb.setAttribute('aria-label', '返回上一个视图'); jb.title = '返回'; jb.innerHTML = BACK_SVG;
      jb.onclick = function () { history.back(); };
      chatheadEl.insertBefore(jb, chatheadEl.firstChild);
    }
  };
  var pushNav = function () {
    if (S.fromMain && D.mode) S.stack.push({ k: 'view', role: D.role, room: D.roomId, top: thread.scrollTop });
    else if (narrow() && !(appEl && appEl.classList.contains('reading'))) S.stack.push({ k: 'list' });
    else return;
    history.pushState({ nav: S.stack.length }, '', location.href);
    syncJb();
  };
  window.addEventListener('popstate', function () {
    var e = S.stack.pop();
    if (!e) return;
    syncJb();
    // 返回回列表: 浏览器退到的那一格 URL 是压栈时的旧 URL, 而选中态没变 —— 把 URL 改回与当前 role / room 一致, 复制 / 刷新才不丢选中。
    if (e.k === 'list') { setReading(false); syncUrl(); return; }
    S.fromMain = false;
    // 视角与选中态一起恢复: role 先落定 (名片按它取), 再按 room 有无选画哪一页。
    adoptRole(e.role);
    var back = e.room ? loadRoom(e.room, 60) : loadWizard(e.role, true);
    Promise.resolve(back).then(function () { thread.scrollTop = e.top; });
  });
  // 换 role: 宪章 / 日程栏 / 旧名片都属于上一个人, 清掉; 世界视图的未读 / 计划按新 role 重算。
  var adoptRole = function (role) {
    if (!role || role === D.role || (D.wizard && D.cardRole === D.role && role === D.wizard.id)) return false;
    if (D.wizard && role !== D.wizard.id) S.roleMoved = true;
    S.charter = null; resetPane();
    D.role = role; D.plans = []; D.schedules = []; D.stats = null;
    loadWorld();
    return true;
  };
  var isMemberOf = function (roomId, target) {
    var r = roomById(roomId);
    return !!r && (r.members || []).some(function (m) { return nodeIdOf(m.who) === target || ('uid:' + (m.who && m.who.id)) === target; });
  };
  // 选中 room (role 不变); 先 loadRoom (同步改选中态) 再重画图一次, 之前先画再 load, 取回来 renderRoom 又画一遍。
  var goRoom = function (id, limit) { pushNav(); setReading(true); markSeen(id); var p = loadRoom(id, limit, true); if (S.view === 'graph' && S.gdom) renderGraph(); return p; };
  // 清选中: 看当前 role 在所有 room 的记录。列表高亮 / 图的 on·sel 立即同步, detail 等 wizard 回包再换。
  var clearRoom = function () {
    if (!D.roomId) return Promise.resolve(false);
    S.roomGen = (S.roomGen || 0) + 1;   // 在路上的 room 刷新作废
    var p = loadWizard(D.role);
    if (gside) { gside.hidden = true; gside.innerHTML = ''; }
    syncListSel(); if (S.view === 'graph' && S.gdom) renderGraph();
    return p;
  };
  // 列表 / 图里点 room: 没选中 = 选中, 已选中 = 取消 (取消选中的唯一入口)。窄屏也一样: 点已选中的 = 取消并进入 detail 看 role 的全部记录。
  var toggleRoom = function (id) {
    if (D.roomId !== id) return goRoom(id);
    pushNav(); setReading(true);
    return clearRoom();
  };
  // 换视角: 新 role 还是选中 room 的成员 → 选中保留, 用新 role 重画这个 room (「我」换人); 否则清选中, 看它的全部记录。
  var goRole = function (target, keepScroll) {
    if (!target) return loadWizard('', keepScroll);
    pushNav(); setReading(true);
    var room = D.roomId, keep = !!room && isMemberOf(room, target);
    adoptRole(target);
    if (keep) { var p = loadRoom(room, 60, true); if (S.view === 'graph' && S.gdom) renderGraph(); return p; }
    var q = loadWizard(target, keepScroll);
    syncListSel(); if (S.view === 'graph' && S.gdom) renderGraph();
    return q;
  };
  var tbBack = $('#tb-back');
  if (tbBack) tbBack.onclick = function () {
    var top = S.stack[S.stack.length - 1];
    if (top && top.k === 'list') history.back(); else setReading(false);
  };
  var olderPage = function () {
    if (!D.earlier) return;
    var before = D.earlier, prevH = thread.scrollHeight, prevTop = thread.scrollTop;
    var p = D.roomId
      ? api('api/room', { room: D.roomId, before: before, limit: 60 })
      : api('api/wizard', { role: D.role, before: before, session: D.session === 'all' ? '' : D.session, limit: 60 });
    return p.then(function (r) {
      if (!r.ok) return;
      D.msgs = (r.msgs || []).concat(D.msgs);
      D.earlier = r.earlier || '';
      redraw();
      thread.scrollTop = prevTop + (thread.scrollHeight - prevH);
    });
  };

  // ── 过程框 ─────────────────────────────────────────────────────────
  // 「过程」按钮的开合态: 高亮底 + 箭头转向 + aria-expanded, 手机上也一眼分得清。
  var syncOpenBtn = function (a, open) {
    var b = a && a.querySelector('.rv-open');
    if (!b) return;
    b.classList.toggle('on', !!open);
    b.setAttribute('aria-expanded', open ? 'true' : 'false');
  };
  // 过程框在头之上: 在它里面展开 / 收起会把下面的头和气泡推走。以按钮为锚, 把它在视口里的位置补回来, 人眼不用追。
  var holdY = function (a, fn) {
    var b = a.querySelector('.rv-open'), y0 = b ? b.getBoundingClientRect().top : 0;
    fn();
    if (b) thread.scrollTop += b.getBoundingClientRect().top - y0;
  };
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
      syncOpenBtn(a, true);
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
    syncOpenBtn(a, true);
  };
  /** id = 消息 id (定位那一条的盒子), turnId = 产出它的那一轮 (取过程框)。 */
  var toggleTurn = function (id, turnId) {
    var a = inner.querySelector('.rv-msg[data-id="' + cssEsc(id) + '"]');
    if (!a) return;
    var box = a.querySelector('.rv-box');
    if (!box) return;
    if (!box.hidden) { holdY(a, function () { box.hidden = true; delete S.openTurns[id]; syncOpenBtn(a, false); }); return; }
    if (S.openTurns[id]) { holdY(a, function () { setBox(id, S.openTurns[id]); }); return; }
    holdY(a, function () { setBox(id, '<div class="rv-none">加载中…</div>'); });
    api('api/turn', { turn: turnId }).then(function (r) {
      var a2 = inner.querySelector('.rv-msg[data-id="' + cssEsc(id) + '"]');
      var html = r.ok ? r.html : '<div class="rv-none">' + esc(r.error || '取不到这一轮') + '</div>';
      if (a2) holdY(a2, function () { setBox(id, html); }); else setBox(id, html);
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
  // 账属于 role: 选中 room 与否都显示它的账。
  var renderUsage = function () {
    var w = D.wizard;
    putUsage($('#pg-usage'), w && w.kind === 'wizard' ? D.stats : null, { name: w ? w.name || w.id : '', label: w ? w.label : '' });
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
  // 按当前选中态重画 detail: 选中 room → 它的账本, 否则 role 的全部记录。
  var redraw = function () { if (D.roomId) renderRoom(); else renderWizard(); };
  var toggleCharter = function () {
    if (S.charter) { S.charter = null; redraw(); return; }
    api('api/charter', { role: D.role }).then(function (r) {
      if (!r.ok) S.charter = '<div class="rv-none">' + esc(r.error || '取不到宪章') + '</div>';
      else if (r.none) S.charter = '<div class="rv-none">这个 wizard 没有留下宪章记录。</div>';
      else S.charter = '<h4>宪章 · ' + esc(r.tokens) + ' tokens · ' + esc(fmtDay(r.at)) + '</h4>' +
        (r.sections || []).map(function (s) { return '<h5>' + esc(s.title || '') + ' · ' + esc(s.tokens) + ' tokens</h5><pre>' + esc(s.body || '') + '</pre>'; }).join('');
      redraw();
    });
  };

  // ── 世界 ───────────────────────────────────────────────────────────
  var worldReq = null;
  var worldRetry = 0;
  var scheduleWorldRetry = function () {
    if (worldRetry) return;
    worldRetry = setTimeout(function () { worldRetry = 0; loadWorld(); }, 2000);
  };
  var loadWorld = function () {
    if (worldReq) return worldReq;
    worldReq = api('api/world', { role: D.role || ROLE || '' }).then(function (r) {
      worldReq = null;
      if (!r.ok) { convsEl.innerHTML = '<div class="rv-none">' + esc(r.error || '世界视图加载失败') + '</div>'; return; }
      // 名册缺席 (svr 刚重启, 还没收到 daemon 推来的快照): 这份回包里的名字全是 id。已有一份好的就原样留着, 不拿 id 覆盖;
      // 没有好的 (首屏) 就用占位名先画, 2s 后重取, 名册一到立刻补上 —— 不让 id 当名字露出来。
      if (r.degraded && W.good) { W.degraded = true; scheduleWorldRetry(); return r; }
      W.at = r.at; W.rooms = r.rooms || []; W.nodes = (r.nodes || []).map(function (n) { return n.name && ID_LIKE.test(n.name) ? Object.assign({}, n, { name: safeName(n.name) }) : n; });
      W.uidTargets = r.uidTargets || {}; W.chatNames = r.chatNames || {}; W.names = r.names || {}; W.degraded = !!r.degraded;
      if (!r.degraded) W.good = true; else scheduleWorldRetry();
      // 日程栏要的 plans / 定时任务: 名册快照里就是全量 (带 gate 与出错), 每 6s 一次, 开着就看得到最新。
      W.plans = r.plans || []; W.schedules = r.schedules || [];
      renderSide();
      // 选中 room 时名片不随 /api/wizard 轮询: 跟着 world 这一拍刷新, 但名片本身不常变 (card=1 服务端要算名录 / 用量 / 宪章), 30s 一次足够; 换 role 时由 loadRoom 即时补取。
      if (D.roomId && D.role && Date.now() - (S.cardAt || 0) > 30000) loadCard();
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
    if (g) { var id = g.getAttribute('data-node'); if (id) { if (t.closest('summary')) e.preventDefault(); goRole(id); return; } }
    var j = t.closest('[data-jump-room]');
    if (j) { goRoom(j.getAttribute('data-jump-room')); return; }
    var qm = t.closest('.rq-more');
    if (qm) { var qr = qm.parentNode.querySelector('.rq-rest'); if (qr) { qr.hidden = !qr.hidden; qm.setAttribute('aria-expanded', qr.hidden ? 'false' : 'true'); qm.classList.toggle('on', !qr.hidden); } return; }
    var qi = t.closest('.rq-it');
    if (qi) {
      if (qi.getAttribute('data-qgone')) return;
      var qid = qi.getAttribute('data-qid'), qroom = qi.getAttribute('data-qroom') || D.roomId;
      // 同 room 且已在页上: 直接定位; 否则走搜索跳转的同一条路 (jumpRow: 先打开那个 room, 必要时往前翻页再落点)。
      if (D.mode === 'room' && D.roomId === qroom && rowEl(qid)) landRow(qid); else jumpRow({ id: qid, room: qroom });
      return;
    }
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
  // 用户正在滚 (最近 1.2s 内有 scroll) 就让这一轮刷新过去: 下一轮 4s 后再来, 不在手指 / 滚轮底下换 DOM。
  var scrollAt = 0;
  thread.addEventListener('scroll', function () { scrollAt = Date.now(); }, { passive: true });
  var tick = function () {
    if (document.hidden || Date.now() - scrollAt < 1200) return;
    if (D.mode === 'room') loadRoom(D.roomId, Math.max(60, D.msgs.length), false, true);
    else if (D.mode === 'wizard') loadWizard(D.role, true);
  };
  setInterval(tick, TICK_MS);
  var rzTimer = 0;
  window.addEventListener('resize', function () {
    clearTimeout(rzTimer);
    rzTimer = setTimeout(function () { if (W.rooms.length && S.view === 'graph') renderGraph(); }, 120);
  });
  // 窗口之外的尺寸变化 (旋转屏 / 左栏宽度随视图切换 / 移动端地址栏收放) 也要跟: 盯着图所在的面板本身。
  if (window.ResizeObserver) {
    var roTimer = 0;
    new ResizeObserver(function () {
      S.panelBox = { w: convsEl.clientWidth, h: convsEl.clientHeight };
      clearTimeout(roTimer);
      roTimer = setTimeout(function () { if (S.view === 'graph' && S.gdom && S.g) renderGraph(); }, 80);
    }).observe(convsEl);
  }
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
      html: '<span class="av">' + esc(roomIconOf(r.id, r.group)) + '</span><span class="b"><span class="l1">' +
        '<span class="nm chat">' + hl(r.name, q) + '</span>' + groupTag(r.group) + skTs(r.lastAt) + '</span>' +
        (r.preview ? '<span class="pv">' + esc(r.preview) + '</span>' : '') + '</span>',
      go: function () { goRoom(r.id); },
    };
  };
  var memberItem = function (m, q) {
    var human = m.who.kind === 'human';
    return {
      kind: 'role',
      html: '<span class="av">' + (human ? '👤' : esc(nodeOf(nodeIdOf(m.who)).label || '🧙‍♂️')) + '</span><span class="b"><span class="l1">' +
        '<span class="nm ' + (human ? 'human' : 'wizard') + '">' + hl(m.name, q) + '</span><span class="k">切到视角</span></span>' +
        '<span class="pv">在 ' + m.rooms + ' 个 room' + (m.lastAt ? ' · 最近 ' + esc(fmtAgo(m.lastAt)) : '') + '</span></span>',
      go: function () { goRole(nodeIdOf(m.who)); },
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
        '<span class="l3"><span class="where' + (h.group ? '' : ' priv') + '"><i>' + esc(roomIconOf(h.room, h.group)) + '</i>' +
          (h.group ? '群聊' : '会话') + ' · ' + esc(h.roomName) + '</span>' +
          (h.hits > 1 ? '<span class="cnt">' + h.hits + ' 处命中</span>' : '') + '</span></span>',
      go: function () { jumpRow(h); },
    };
  };
  // 定位一行: 打开它的 room; 不在已取的那一截里就往前翻页 (最多 20 页), 滚到中间闪一下。
  var rowEl = function (id) { return inner.querySelector('.rv-msg[data-id="' + cssEsc(id) + '"]'); };
  var landRow = function (id) {
    var row = rowEl(id);
    if (!row) return false;
    // 比半屏还高的一条: 居中会把它的开头推出视口, 改成顶对齐。
    row.scrollIntoView({ block: row.offsetHeight > thread.clientHeight * 0.6 ? 'start' : 'center' });
    row.classList.remove('hit'); void row.offsetWidth; row.classList.add('hit');
    // 定时刷新会整段重画 room —— 记住落点, 重画后补回 (闪完为止)。
    S.hit = { id: id, until: Date.now() + 2000 };
    return true;
  };
  var jumpRow = function (h) {
    var land = function (left) {
      if (landRow(h.id)) return;
      if (left > 0 && D.roomId === h.room && D.earlier) olderPage().then(function () { land(left - 1); });
    };
    goRoom(h.room).then(function () { land(20); });
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
  // 没指定 room 的链接选哪个人当视角: 票据落点那位若是该 room 的成员就用它, 否则 host → 第一个 wizard 成员 → 第一个 human 成员 → 落点本人。
  var pickRoleForRoom = function (roomId, landing) {
    var r = roomById(roomId), ms = (r && r.members) || [];
    var inRoom = ms.some(function (m) { return nodeIdOf(m.who) === landing.id || (landing.uid && m.who.kind === 'wizard' && m.who.id === landing.uid); });
    if (inRoom) return landing.id;
    var first = function (pred) { for (var i = 0; i < ms.length; i++) if (pred(ms[i]) && nodeIdOf(ms[i].who)) return nodeIdOf(ms[i].who); return ''; };
    return (r && r.host && nodeIdOf(r.host)) || first(function (m) { return m.who.kind === 'wizard'; }) || first(function (m) { return m.who.kind === 'human'; }) || landing.id;
  };
  // 启动: URL 的 role (视角) 与 room (选中) 各自解析, 老链接兜底:
  //  · role 形如 room (dm: / adhoc:) → 当 room, role 另选; 有 room 没 role → pickRoleForRoom;
  //  · room 参数缺省 (detail link) → 用票据落点 landingRoom (role 是它的成员才选中); room= 空 → 明确不选。落点只在这里用一次。
  var boot = function () {
    loadWorld().then(function () {
      var role = ROLE, room = ROOM, hasRoom = qs.has('room');
      if (/^(dm|adhoc):/.test(role)) { room = role; hasRoom = true; role = ''; }
      if (!TOKEN) {   // 没有票据取不到名片: 照旧按 URL 直开
        if (room) return goRoom(room);
        if (role) return goRole(role);
        return showFirstRoom();
      }
      return api('api/wizard', { role: role, card: '1' }).then(function (c) {
        if (!c.ok || !c.role || !c.role.id) { if (room) return goRoom(room); return showFirstRoom(); }
        var landing = { id: c.role.id, uid: c.uid || '' };
        var pick = room ? (role ? c.role.id : pickRoleForRoom(room, landing)) : c.role.id;
        if (!room && !hasRoom && c.landingRoom && roomById(c.landingRoom) && isMemberOf(c.landingRoom, pick)) room = c.landingRoom;
        D.role = pick;
        if (pick === c.role.id) applyCard(c);
        if (room) return goRoom(room);
        return goRole(pick);
      }).catch(function () { return showFirstRoom(); });
    });
  };
  var showFirstRoom = function () {
      var first = (W.rooms || [])[0];
      if (first) { D.role = pickRoleForRoom(first.id, { id: '', uid: '' }); return loadRoom(first.id); }
      inner.innerHTML = '<div class="rv-none">还没有 room —— 说一句话, 或者在群里 .name 点名一个 wizard。</div>';
  };
  // ── 样式: 本页新加的 DOM 只在 chat.js 里, 样式也一并带上 (不改 web/chat.css, 无构建) ──
  var CSS = ".side-body { flex: 1; min-height: 0; display: flex }\n.convs { flex: 1; min-width: 0; overflow: auto; padding: 0 }\n.rv-list { padding: 2px 8px 16px }\n.convs-h { padding: 2px 8px 0 }\n.convs-h h2 { margin-top: 6px }\n.convs h2 > span:nth-of-type(2) { flex: none }\n.convs h2 .vt + .vt { margin-left: 0 }\n.convs h2 .vt.on { color: var(--accent) }\n.convs h2 .vt svg { flex: none }\n@media (min-width: 761px) { .app.side-list .side { width: max(332px, 25vw) } }\n* { scrollbar-width: thin; scrollbar-color: var(--line) transparent }\n::-webkit-scrollbar { width: 8px; height: 8px }\n::-webkit-scrollbar-track { background: transparent }\n::-webkit-scrollbar-thumb { background: var(--line); border-radius: 8px; border: 2px solid transparent; background-clip: padding-box }\n::-webkit-scrollbar-thumb:hover { background-color: var(--faint) }\n::-webkit-scrollbar-corner { background: transparent }\n.thread-in, .gside, .rolebar, .rv-mh { overflow-wrap: anywhere }\n.rv-bub { min-width: 0; overflow-wrap: anywhere }\n.rv-files { min-width: 0 }\n.rv-files .rv-chip { white-space: normal; overflow-wrap: anywhere; max-width: 100%; line-height: 1.45; padding: 1px 7px }\n.rv-mh > * { min-width: 0 }\n.gs-mem .nm { white-space: normal; overflow-wrap: anywhere }\n.gs-cls { min-width: 0; overflow-wrap: anywhere }\n.rv-list .ci .l2 .rv-chip { flex: none }\n.rv-msg.hit .rv-bub { animation: hit 1.6s ease-out }\n.rv-graph { display: block; font: 11.5px/1 -apple-system, BlinkMacSystemFont, sans-serif; cursor: grab; touch-action: none; user-select: none }\n.rv-edge { stroke: #c9d2df; stroke-width: 1 }\n.rv-edge.unread { stroke: #f2a7ad; stroke-width: 1.6 }\n.rv-edge.on { stroke: var(--accent); stroke-width: 1.6 }\n.rv-hit { stroke: transparent; stroke-width: 12; cursor: pointer }\n.rv-node { cursor: grab }\n.rv-room rect { fill: var(--them); stroke: var(--line) }\n.rv-room text { fill: var(--ink) }\n.rv-room.on > text { fill: var(--accent); font-weight: 700 }\n.rv-person .sh { fill: var(--card); stroke: var(--mute); stroke-width: 1.6 }\n.rv-person .rv-emo { font-size: 17px; fill: initial }\n.rv-person.human .rv-nm { fill: var(--human); font-weight: 600 }\n.rv-person.wizard.st-working .sh { fill: #2da44e; stroke: #1a7f37 }\n.rv-body { transform-box: fill-box; transform-origin: center }\n.rv-person.wizard.st-working .rv-body { animation: rvbreath 1.8s ease-in-out infinite }\n@keyframes rvbreath { 0%, 100% { transform: scale(.88) } 50% { transform: scale(1.14) } }\n.rv-person.wizard.st-blocked .sh { fill: #e8336d; stroke: #b3124a }\n.rv-person.wizard.st-idle .sh { fill: #e4e7ec; stroke: #7d8795 }\n.rv-person.wizard.st-asleep .sh { fill: #f6f7f9; stroke: #b9c0ca; stroke-dasharray: 3 2.5 }\n.rv-person.wizard.cold .sh { fill: #fff }\n.rv-person.wizard.st-asleep text { fill: var(--faint) }\n.rv-hosthat .hh, .rv-legend .lghost path { fill: #7c4dcc; stroke: #2d1a5e; stroke-width: .9; stroke-linejoin: round }\n.rv-hosthat .hb, .rv-legend .lghost .hb { fill: #d9c8ff; stroke: #2d1a5e; stroke-width: .6 }\n.rv-hosthat { pointer-events: none }\n.rv-legend .lghost { flex: none }\n.rv-room .rv-un circle { fill: #cf222e }\n.rv-room .rv-un text { fill: #fff; font-size: 9px; font-weight: 600 }\n.rv-edge.direct { stroke: #9aa7ba; stroke-width: 1.4 }\n.rv-edge.sel { stroke: var(--accent); stroke-width: 3 }\n.rv-person.wizard.on .rv-nm, .rv-person.human.on .rv-nm { fill: var(--accent); font-weight: 700 }\n.rv-legend { display: flex; flex-wrap: wrap; gap: 3px 10px; padding: 4px 10px 8px; font-size: 11px; color: var(--faint) }\n.rv-legend span { display: inline-flex; align-items: center; gap: 4px }\n.rv-legend .lg { display: inline-block; width: 9px; height: 9px; border: 1.6px solid var(--mute); box-sizing: border-box }\n.rv-legend .wz { border-radius: 50% }\n.rv-legend .wz.working { background: #2da44e; border-color: #1a7f37 }\n.rv-legend .wz.idle { background: #e4e7ec; border-color: #7d8795 }\n.rv-legend .wz.blocked { background: #e8336d; border-color: #b3124a }\n.rv-legend .wz.cold { background: #fff; border-color: #9aa4b2 }\n.rv-legend .wz.asleep { background: #f6f7f9; border-style: dashed; border-color: #b9c0ca }\n.rv-legend .lgemo { font-size: 11px; line-height: 1 }\n.rv-lead { fill: #f5b301; stroke: #6b4a00; stroke-width: .9; stroke-linejoin: round; pointer-events: none }\n.rv-legend .lglead { fill: #f5b301; stroke: #6b4a00; stroke-width: .9 }\n.rv-legend .lgpoly { flex: none }\n.rv-legend .lgpoly polygon, .rv-legend .lgpoly circle { fill: #e4e7ec; stroke: #7d8795; stroke-width: 1.4; stroke-linejoin: round }\n.smi { flex: none; vertical-align: -2px } .smi polygon, .smi circle { fill: #e4e7ec; stroke: #8a93a0; stroke-width: 1.4; stroke-linejoin: round }\n.smi.st-working polygon, .smi.st-working circle { fill: #2da44e; stroke: #1a7f37 }\n.smi.st-blocked polygon, .smi.st-blocked circle { fill: #e8336d; stroke: #b3124a }\n.smi.st-idle polygon, .smi.st-idle circle { fill: #e4e7ec; stroke: #7d8795 }\n.smi.st-asleep polygon, .smi.st-asleep circle { fill: none; stroke: #a3acb9; stroke-width: 1.2 }\n.smi.cold.st-idle polygon, .smi.cold.st-idle circle { fill: #fff }\n.rolebar .facts .fx-smi { display: inline-flex; align-items: center; cursor: help }\n.rolebar .facts .lead { color: #b07d00 }\n.rv-person text { fill: var(--ink); font-size: 12pt }\n.rv-person text.rv-nm { paint-order: stroke; stroke: var(--card); stroke-width: 3.5px; stroke-linejoin: round }\n.rv-room text { font-size: 12pt }\n.rv-person.ghost .sh { fill: #f6f7f9; stroke: #c9d0da; stroke-dasharray: 3 2.5 }\n.rv-person.ghost text { fill: var(--faint) }\n.rv-ttl { font-size: 15.5px; line-height: 22px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap }\n.rv-sub { display: flex; flex-wrap: wrap; gap: 4px 6px; align-items: center; margin-top: 3px; font-size: 11.5px; color: var(--mute) }\n.rv-lb { font-size: 15px }\n.rv-chip { display: inline-flex; align-items: center; padding: 0 6px; border-radius: 999px; background: var(--them); color: var(--mute); font-size: 11px; line-height: 17px; white-space: nowrap }\n.rv-chip.ok { background: #e8f5ee; color: #1a7f3c }\n.rv-chip.warn { background: #fdf1e3; color: #9a5b10 }\n.rv-chip.ask, .rv-chip.bad { background: #fdecec; color: #b42318 }\n.rv-chip.go { background: var(--mine); color: var(--accent) }\n.rv-chip.file { background: var(--them-soft) }\n.rv-chip.re { background: transparent; color: var(--faint); border: 1px solid var(--line) }\n.rv-act { border: 1px solid var(--line); background: var(--card); border-radius: 7px; padding: 2px 9px; font-size: 12px; cursor: pointer; color: var(--mute) }\n.rv-act:hover, .rv-act.on { color: var(--accent); border-color: var(--accent) }\n/* 图右侧的成员列: 点开一个 room 才有, 看 wizard 时收起。 */\n.gside { flex: none; width: 252px; min-height: 0; overflow: auto; border-left: 1px solid var(--line); background: var(--card); padding: 8px }\n.gs-host { flex: none; font-size: 11px; line-height: 1 }\n.gside[hidden] { display: none }\n.gs-head { display: flex; align-items: center; gap: 8px; padding: 0 2px 4px; color: var(--faint); font-size: 12px; line-height: 20px }\n.gs-hl { min-width: 0 }\n.gs-hn { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; margin-left: auto }\n.gs-x { display: none; flex: none; margin-left: auto; width: 32px; height: 32px; border: 0; background: none; color: var(--mute); font-size: 15px; cursor: pointer }\n.gs-hn + .gs-x { margin-left: 0 }\n.gs-meta { display: flex; flex-wrap: wrap; gap: 0 8px; padding: 0 2px 4px; color: var(--faint); font-size: 11px; line-height: 1.6 }\n.gs-notice { display: flex; align-items: flex-start; gap: 5px; width: 100%; margin: 0 0 6px; padding: 5px 8px; border: 0; border-radius: 8px; background: #fff8e1; color: #6b4a00; font: inherit; font-size: 11.5px; line-height: 1.5; text-align: left; cursor: pointer }\n.gs-notice:hover { background: #fff3cd }\n.gs-np { flex: none; font-size: 11px }\n.gs-nt { min-width: 0; overflow-wrap: anywhere; white-space: pre-wrap; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical }\n.gs-notice.on .gs-nt { display: block; -webkit-line-clamp: unset; overflow: visible }\n.gs-head b { color: var(--mute); font-weight: 600 }\n.gs-duty { color: #b42318; font-weight: 600 }\n.gs-list { padding-top: 2px }\n.gs-item { border-radius: 6px }\n.gs-item.grp { margin-top: 4px; padding-top: 4px; border-top: 1px solid var(--paper) }\n.gs-row { display: flex; align-items: center; gap: 4px; min-width: 0; border-radius: 6px; padding-right: 6px }\n.gs-row:hover { background: var(--paper) }\n.gs-ago { flex: none; min-width: 2.6em; text-align: right; color: var(--faint); font-size: 10.5px; white-space: nowrap; cursor: pointer }\n.gs-ago.none { opacity: .6 }\n.gs-role { flex: none; font-size: 11px; line-height: 1; width: 10px; text-align: center; opacity: .8 }\n.gs-host, .gs-lead { flex: none; font-size: 11px; line-height: 1 }\n.gs-blk { margin-left: -2px; font-weight: 600; font-size: 10.5px; color: #b3124a }\n.gs-due.on { background: #b42318; color: #fff }\n.gs-ch { width: 0; height: 0; border-left: 3.5px solid currentColor; border-top: 3px solid transparent; border-bottom: 3px solid transparent; transition: transform .12s }\n.gs-due.on .gs-ch { transform: rotate(90deg) }\n.gs-duties { display: flex; flex-direction: column; gap: 2px; margin: 2px 4px 4px 10px; padding-left: 6px; border-left: 2px solid #f3c6c6 }\n.gs-dt { display: flex; flex-direction: column; gap: 0; text-align: left; border: 0; border-radius: 5px; padding: 2px 6px; background: none; cursor: pointer; font: inherit; color: inherit }\n.gs-dt:hover { background: var(--paper) }\n.gs-dq { font-size: 10.5px; color: var(--mute) }\n.gs-dq b { color: #b42318; font-weight: 600 }\n.gs-ds { font-size: 11px; line-height: 1.45; color: var(--ink); overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical }\n.gs-open { display: none }\n.gs-pip { display: inline-block; width: 6px; height: 6px; margin-left: 4px; border-radius: 50%; background: #cf222e; vertical-align: 2px }\n.gs-list { display: flex; flex-direction: column; gap: 2px }\n.gs-mem { display: flex; align-items: center; gap: 5px; flex: 1; min-width: 0; padding: 5px 6px; border: 0; border-radius: 6px; background: none; color: var(--ink); text-align: left; cursor: pointer }\n.gs-mem .nm { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12.5px }\n.gs-mem.human .nm { color: var(--human) }\n.gs-mem.busy .nm { color: var(--accent) }\n.gs-cls { flex: none; color: var(--faint); font-size: 10.5px }\n.gs-row:has(.gs-mem.me), .gs-row:has(.gs-mem.me):hover { background: var(--mine) }\n.gs-item.out .gs-mem .nm, .gs-item.out .gs-mem.human .nm, .gs-item.out .gs-mem.busy .nm { color: var(--faint) }\n.gs-item.out .gs-ago, .gs-item.out .gs-role, .gs-item.out .gs-host, .gs-item.out .gs-lead, .gs-item.out .smi { opacity: .6 }\n.gs-pov { flex: none; font-size: 11px; line-height: 1 }\n.gs-due { flex: none; display: inline-flex; align-items: center; gap: 3px; border: 0; border-radius: 999px; padding: 0 6px; background: #fdecec; color: #b42318; font-size: 10.5px; line-height: 17px; cursor: pointer }\n@media (max-width: 760px) { .gside { display: none } .gs-open { display: inline-flex; align-items: center } .gside.sheet:not([hidden]) { display: block; position: fixed; left: 0; right: 0; bottom: 0; width: auto; max-height: 72vh; z-index: 30; border-left: 0; border-top: 1px solid var(--line); border-radius: 14px 14px 0 0; box-shadow: 0 -10px 32px #0003; padding: 8px 12px calc(10px + env(safe-area-inset-bottom)) } .gside.sheet .gs-x { display: inline-block } .gside.sheet .gs-mem { padding: 10px 6px } .gside.sheet .gs-dt { padding: 5px 6px } .gside.sheet .gs-due { padding: 3px 10px } .gside.sheet .gs-ago { font-size: 11.5px } .gside.sheet .gs-row { gap: 8px } }\n.rv-older { display: block; margin: 8px auto; border: 1px solid var(--line); background: var(--card); border-radius: 999px; padding: 2px 12px; font-size: 12px; color: var(--mute); cursor: pointer }\n/* 一条消息: 头在气泡外 (谁 → 谁 · room · 时刻), 气泡只装正文。 */\n.rv-msg { display: flex; flex-direction: column; gap: 3px; margin: 10px 0; min-width: 0 }\n.rv-msg > .rv-mh { padding: 0 2px }\n.rv-bub { align-self: flex-start; max-width: min(88%, 720px); padding: 8px 13px; background: var(--them); border: 0; border-radius: 14px }\n.rv-msg.me .rv-bub { align-self: flex-end; background: var(--mine) }\n.rv-msg.k-system .rv-bub { background: var(--them-soft, var(--them)) }\n.rv-msg.me .rv-turn .bubbles > .say { align-self: flex-end }\n.rv-mh { display: flex; flex-wrap: wrap; gap: 3px 8px; align-items: center; font-size: 11.5px; color: var(--mute) }\n.rv-path { display: inline-flex; flex-wrap: wrap; align-items: center; gap: 2px 5px; min-width: 0 }\n.rv-arr { color: var(--faint); white-space: nowrap }\n.rv-arr::before { content: '→' }\n.rv-via::before { content: '—' }\n.rv-via::after { content: '→' }\n.rv-msg.me > .rv-mh, .rv-msg.me .rv-spk > .rv-mh { flex-direction: row-reverse }\n.rv-msg.me .rv-path { flex-direction: row-reverse }\n.rv-msg.me .rv-arr::before { content: '←' }\n.rv-msg.me .rv-via::before { content: '←' }\n.rv-msg.me .rv-via::after { content: '—' }\n.rv-msg.me .rv-rawbtn { margin-left: 0 }\n.rv-au { font-weight: 600; color: var(--ink); cursor: pointer }\n.rv-au:hover { text-decoration: underline dotted var(--faint); text-underline-offset: 3px }\n.rv-au.human { color: var(--human) }\n.rv-au.daemon { color: var(--wezard) }\n.rv-tag { color: var(--accent); cursor: pointer }\n.rv-roomtag { color: var(--chat); cursor: pointer; font-size: 11px; margin: 0 1px }\n.rv-roomtag:hover { text-decoration: underline dotted; text-underline-offset: 3px }\n.rv-mh time { color: var(--faint) }\n.rv-open { border: 1px solid var(--line); background: transparent; border-radius: 6px; padding: 0 6px; font-size: 11px; color: var(--faint); cursor: pointer }\n.rv-open:hover { color: var(--accent); border-color: var(--accent) }\n.rv-quote { margin: 0 0 6px; display: flex; flex-wrap: wrap; align-items: flex-start; gap: 4px; min-width: 0 }\n.rv-quote .rq-it { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; text-align: left; border: 0; border-radius: 8px; padding: 4px 8px; background: #0000000a; font: inherit; cursor: pointer; color: inherit }\n.rv-quote .rq-it:hover { background: #00000012 }\n.rv-quote .rq-who { font-size: 11.5px; font-weight: 600; color: var(--accent) }\n.rv-quote .rq-who.human { color: var(--human) }\n.rv-quote .rq-tx { font-size: 12px; line-height: 1.45; color: var(--mute); overflow: hidden; text-overflow: ellipsis; white-space: nowrap }\n.rv-quote .rq-gone { font-style: italic; color: var(--faint); cursor: default }\n.rv-quote .rq-more { flex: none; align-self: center; border: 0; border-radius: 999px; padding: 0 7px; font-size: 11px; line-height: 18px; background: #0000000a; color: var(--mute); cursor: pointer }\n.rv-quote .rq-more.on { color: var(--accent); background: var(--mine) }\n.rv-quote .rq-rest { flex-basis: 100%; display: flex; flex-direction: column; gap: 4px }\n.rv-quote .rq-rest[hidden] { display: none }\n.rv-open { display: inline-flex; align-items: center; gap: 4px }\n.rv-och { width: 0; height: 0; border-left: 4px solid currentColor; border-top: 3.5px solid transparent; border-bottom: 3.5px solid transparent; transition: transform .12s }\n.rv-open.on { background: var(--mine); color: var(--accent); border-color: var(--accent); font-weight: 600 }\n.rv-open.on .rv-och { transform: rotate(90deg) }\n.rv-tx { font-size: 14px; line-height: 1.65; overflow-wrap: anywhere; color: #1f2328 }\n.rv-tx > :first-child { margin-top: 0 }\n.rv-tx > :last-child { margin-bottom: 0 }\n.rv-tx p { margin: .6em 0 }\n.rv-tx h1, .rv-tx h2, .rv-tx h3, .rv-tx h4 { margin: 1em 0 .4em; font-weight: 600; line-height: 1.35 }\n.rv-tx h1 { font-size: 1.4em }\n.rv-tx h2 { font-size: 1.2em }\n.rv-tx h3 { font-size: 1.05em }\n.rv-tx h4 { font-size: 1em }\n.rv-tx ul, .rv-tx ol { margin: .6em 0; padding-left: 1.6em }\n.rv-tx li { margin: .2em 0 }\n.rv-tx li > p { margin: .2em 0 }\n.rv-tx code { background: #0000000d; border-radius: 4px; padding: 1px 5px; font-size: .9em; font-family: ui-monospace, Menlo, monospace }\n.rv-tx pre { background: #ffffffb3; border-radius: 8px; padding: 8px 10px; margin: .6em 0; overflow: auto; font-size: 12.5px; line-height: 1.5 }\n.rv-tx pre code { background: transparent; padding: 0; font-size: inherit }\n.rv-tx blockquote { margin: .6em 0; padding: .1em 1em; border-left: 3px solid #0000001f; color: #656d76 }\n.rv-tx table { border-collapse: collapse; margin: .7em 0; display: block; overflow: auto; max-width: 100% }\n.rv-tx th, .rv-tx td { border: 1px solid #0000001a; padding: 5px 10px }\n.rv-tx th { background: #0000000a; font-weight: 600 }\n.rv-tx hr { border: 0; border-top: 1px solid #0000001a; margin: .9em 0 }\n.rv-tx a { color: #0969da; text-decoration: none }\n.rv-tx a:hover { text-decoration: underline }\n.rv-empty { color: var(--faint); font-size: 12px; margin: 0 }\n.rv-box { margin-top: 4px; padding: 8px 10px; border: 1px dashed var(--line); border-radius: 10px; background: var(--card) }\n.rv-box[hidden] { display: none }\n.rv-turn { margin: 0; padding: 0; border: 0; background: none }\n.rv-turn .turn-group { margin: 0 }\n.rv-mark { margin: 10px 12px; display: flex; justify-content: center }\n.rv-box .turn-group { margin: 0 }\n.rv-none { padding: 14px; color: var(--faint); font-size: 12.5px }\n.rv-note { margin: 8px 12px; padding: 7px 10px; border-radius: 8px; background: #fdf1e3; color: #9a5b10; font-size: 12px }\n.rv-charter { margin: 12px; padding: 8px 10px; border: 1px solid var(--line); border-radius: 10px; background: var(--card); font-size: 12px }\n.rv-charter h4 { margin: 6px 0 2px; font-size: 11.5px; color: var(--faint); font-weight: 600 }\n.rv-charter h5 { margin: 8px 0 2px; font-size: 11.5px; color: var(--faint) }\n.rv-charter pre { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; font-size: 11.5px; color: var(--mute) }\n/* 一轮写进账本的气泡: 过程框下面, 靠自己那一侧; 多颗时各带一行小头 (去处 / 定论)。 */\n.rv-spk { display: flex; flex-direction: column; gap: 2px; margin-top: 4px; min-width: 0 }\n.rv-msg.me .rv-spk { align-items: flex-end }\n.rv-smh { font-size: 11px }\n.rv-smh time { margin-left: 6px }\n.rv-files { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 4px }\n/* reminder 标签收在气泡底: 默认只露种类, 点开看原文。 */\n.rv-bub .rems { padding: 4px 0 0 }\n.rv-bub .rem-raw { max-height: 360px; overflow: auto }\n.rv-mh .mstat { display: inline-flex; gap: 6px; align-items: center; color: var(--faint) }\n.ho-who[data-node], .ho-line[data-node] { cursor: pointer }\n/* 标题行: room 名 × 👁 role 名 —— ×「取消选择 room」夹在两者之间, 消除的是前者。× 触控区 32px (窄屏不挤标题: 标题先让位 min-width:0), 字形 14px, 与返回键 chevron 同一套线描。 */\n.rv-trow { display: flex; align-items: center; gap: 2px; min-width: 0 }\n.rv-trow .rv-ttl { min-width: 0; flex: 0 1 auto }\n.rv-pov-tag { flex: 0 1 auto; min-width: 4.2em; max-width: 45%; margin-left: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; font-weight: 400; color: var(--faint) }\n.rv-clr { flex: none; display: inline-flex; align-items: center; justify-content: center; width: 32px; height: 32px; margin: -5px 0; padding: 0; border: 0; border-radius: 8px; background: none; color: var(--mute); cursor: pointer }\n.rv-clr:hover, .rv-clr:focus-visible { color: var(--ink); background: var(--paper) }\n.rv-clr svg { display: block }";
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
