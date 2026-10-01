// Rolepage routes, shared verbatim by the daemon and the standalone svr —
// both own a DetailStore, so both can serve the same view off it.
//
//   GET /role, /chat      → static SPA shell (shared/chat-render); /chat 是改名前的老链接
//   GET /chat/app.css     → 视图样式 (高亮主题 + detail 共用样式 + web/chat.css)
//   GET /chat/app.js      → 视图脚本 (web/chat.js)
//   GET /chat/vendor.js   → markdown-it + highlight.js (随包分发, 不走 CDN)
//   GET /api/role         → 一个 role 的身份 + 它参与的会话 (群聊/单聊) + session 分段
//   GET /api/msgs         → 一个会话窗口的消息片段 (服务端渲染的 HTML; 工具调用只有摘要)
//   GET /api/tool         → 一次工具调用的展开正文 —— 片段的第二级, 展开时才取
//   GET /api/role-events  → SSE: role 摘要变动 + 当前窗口的消息增量
//   GET /api/world        → 关系视图: 全部 wizard、家谱、跨聊天往来、工单、日程
//
// 资源路由不校验 `?id=` —— 它们是纯静态前端代码, 不含任何会话数据。
//
// Capability: `?id=` 是一条不可猜的记录 id, 它就是凭据。rolepage 的核心动作是
// 「点一条消息就切到对端的视角」—— 对端可能住在任何一个聊天里, 所以**任一有效票据
// 可以看全部 role** (用户确认过的取舍: 单用户部署, 名册本来就对每个 wizard 敞开)。
// 票据只剩两个作用: 证明你拿到过一条真链接; 以及没有 `role=` 时默认开在谁那里。
// 要把正文严格关在一个群里的部署, 不该对外暴露这些路由。
import type { IncomingMessage, ServerResponse } from "node:http";
import type { URL } from "node:url";
import { baseOfKey } from "./session-label.js";
import { isMark, isPost, isTurn } from "./chat-view.js";
import { buildWorld, EMPTY_FACTS, type WorldFacts } from "./world.js";
import {
  allMessages, convKeyOf, convMessages, convsOf, hasRelations, inSpan, makeDirectory, marksOf, messageOfPost, messagesOfTurn,
  roleInfo, roleStats, sessionsOf, windowStats, type Directory, type Msg, type SessionSpan,
} from "./role-view.js";
import { renderMark, renderMsg, type MsgFragment } from "./role-render.js";
import { renderToolBody } from "./detail-render.js";
import { chatScript, chatStyles, chatVendor, renderChatPage } from "./chat-render.js";
import type { Asset } from "./web-assets.js";
import type { DetailRecord, DetailStore, TurnDetailRecord } from "./detail-store.js";

export type SimpleHandler = (req: IncomingMessage, res: ServerResponse, url: URL) => void;

export interface ChatRoutes {
  page: SimpleHandler;
  styles: SimpleHandler;
  script: SimpleHandler;
  vendor: SimpleHandler;
  role: SimpleHandler;
  msgs: SimpleHandler;
  tool: SimpleHandler;
  events: SimpleHandler;
  world: SimpleHandler;
}

/** 注册表侧的事实 (wizard 身份 / 家谱 / 工单 / 日程) —— 只有 daemon 给得出。
 *  async 是因为活体状态要问 tmux; 独立 svr 用 daemon 推来的快照。
 *  实现方自己做节流: 这条路由会被前端定时轮询。 */
export type WorldFactsProvider = () => Promise<WorldFacts> | WorldFacts;

const DEFAULT_LIMIT = 60;
const FLUSH_MS = 300;
const PING_MS = 25_000;
const FACTS_MS = 10_000;
/** rolepage 只看最近这么久: 更早的轮次、wizard 登记、家谱、工单一律不进视图。 */
const HORIZON_MS = 3 * 24 * 3600_000;

const lastTsOf = (r: DetailRecord): number => (r as { updatedAt?: number }).updatedAt ?? r.createdAt;

/** 记录侧的源头裁剪 —— 下游 (会话列表、窗口、关系图) 都只见得到这一份。 */
const recentRecords = (records: readonly DetailRecord[], cutoff: number): DetailRecord[] =>
  records.filter((r) => lastTsOf(r) >= cutoff);

/** 注册表侧的源头裁剪: 久未活动的 wizard 连同它挂着的家谱一起退场; 开着的工单与日程是往后看的, 留下。 */
const recentFacts = (f: WorldFacts, cutoff: number): WorldFacts => ({
  ...f,
  wizards: f.wizards.filter((w) => w.busy || Math.max(w.lastActivity, w.bornAt ?? 0) >= cutoff),
  jobs: f.jobs.filter((j) => j.status === "open" || (j.closedAt ?? j.openedAt) >= cutoff),
});

const json = (res: ServerResponse, status: number, body: unknown): void => {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.end(JSON.stringify(body));
};

/** 票据自带的默认落点: turn/mark 的 target, 聊天票据的 base (= 那个聊天的默认 wizard)。
 *  审批记录只知道 sessionId, 借同 session 的 turn 反推。 */
const ticketTarget = (store: DetailStore, rec: DetailRecord): string => {
  const direct = (rec as { target?: string }).target;
  if (direct) return direct;
  const sid = (rec as { sessionId?: string }).sessionId;
  if (!sid) return "";
  return store.list().filter(isTurn).filter((r) => r.sessionId === sid && r.target)
    .sort((a, b) => b.updatedAt - a.updatedAt)[0]?.target ?? "";
};

interface Ticket {
  selfTarget: string;
  /** 票据就是一轮对话时的那一轮 —— 气泡头上的链接带的正是它自己那一轮的 id。 */
  turn?: TurnDetailRecord;
}

const resolveTicket = (store: DetailStore, url: URL): Ticket | undefined => {
  const rec = store.get(url.searchParams.get("id") ?? "");
  return rec ? { selfTarget: ticketTarget(store, rec), turn: isTurn(rec) && rec.target ? rec : undefined } : undefined;
};

/** 没指定窗口时落在哪: 哪个会话, 以及只看与谁的往来 ("" = 由摘要在那个会话里挑)。 */
interface Landing { conv: string; with: string }

/** 票据是一轮对话、而 role 正是其中一方 → 落在那一句所在的会话, 对面就是那一句的另一方:
 *  从哪个群点进来就开哪个群, 谁问的就只看与谁的往来 —— 都从那条消息反查, 不靠猜。
 *  聊天票据 / 别人的轮次只知道一个群: 落在票据的 home 群。 */
const landingOf = (ticket: Ticket, role: string): Landing => {
  const m = ticket.turn ? messagesOfTurn(ticket.turn)[0] : undefined;
  return m && (m.from === role || m.to === role)
    ? { conv: convKeyOf(m, role), with: m.channel ? (m.from === role ? m.to : m.from) : "" }
    : { conv: `c:${baseOfKey(ticket.selfTarget)}`, with: "" };
};

const NOT_FOUND = "未找到该会话 (链接可能已过期)";

/** `role=` (名字 / target / human:x) > 老链接的 `target=` > 票据自带的那个 wizard。 */
const pickRole = (dir: Directory, ticket: Ticket, url: URL): string =>
  dir.resolve(url.searchParams.get("role") ?? "") ??
  dir.resolve(url.searchParams.get("target") ?? "") ??
  ticket.selfTarget;

// 没指定 = 最新那段 (spans 按时间升序); "all" = 不切, 全部时间。
const ALL_SESSIONS = "all";
const spanOf = (spans: readonly SessionSpan[], sid: string | null): SessionSpan | undefined =>
  !sid ? spans[spans.length - 1]
  : sid === ALL_SESSIONS ? undefined
  : spans.find((s) => s.sessionId === sid);

// Infinity 过不了 JSON。
const wireSpan = (s: SessionSpan) => ({ ...s, end: Number.isFinite(s.end) ? s.end : 0 });

interface View {
  role: string;
  conv: string;
  with: string;
  span?: SessionSpan;
}

export const createChatRoutes = (store: DetailStore, facts?: WorldFactsProvider): ChatRoutes => {
  const getFacts = (): Promise<WorldFacts> =>
    Promise.resolve(facts ? facts() : EMPTY_FACTS)
      .then((f) => recentFacts(f, Date.now() - HORIZON_MS))
      .catch(() => EMPTY_FACTS);
  // 票据校验 (store.get) 不受此限: 一条老链接照样打得开, 只是看到的是最近 3 天。
  const listRecent = (): DetailRecord[] => recentRecords(store.list(), Date.now() - HORIZON_MS);

  const page: SimpleHandler = (_req, res) => {
    res.statusCode = 200;
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.setHeader("cache-control", "no-store");
    res.end(renderChatPage());
  };

  // 前端资源: ETag 跟着文件 mtime 走 —— 改一次 web/chat.js 浏览器就重新取一次,
  // 没改则 304, 而 shell 本身永远 no-store, 不会把旧版本钉死在缓存里。
  const asset = (make: () => Asset): SimpleHandler => (req, res) => {
    const a = make();
    res.setHeader("cache-control", "no-cache");
    res.setHeader("etag", a.etag);
    if (req.headers["if-none-match"] === a.etag) { res.statusCode = 304; res.end(); return; }
    res.statusCode = 200;
    res.setHeader("content-type", a.type);
    res.end(a.body);
  };

  /** role 摘要: 身份、会话列表、session 分段、页脚总账 (role 自己的 + 当前窗口的)。 */
  const summary = (records: readonly DetailRecord[], f: WorldFacts, role: string, sid: string | null, land: Landing, win?: Pick<View, "conv" | "with">) => {
    const now = Date.now();
    const dir = makeDirectory(records, f);
    const msgs = allMessages(records, now);
    const spans = sessionsOf(records, role, now);
    const span = spanOf(spans, sid);
    const convs = convsOf(msgs.filter((m) => inSpan(span)(m.ts)), role, dir, now);
    const stats = roleStats(records, role, now, span);
    const info = roleInfo(role, dir, f, stats, now);
    // 日程页画的两样东西 (与 chat.js 的 renderPlan 同一口径) —— 都没有就不给入口。
    const schedules = f.schedules.filter((x) => (x.owner || x.createdBy || x.target) === role);
    const jobs = f.jobs.filter((j) => j.owner === role || j.members.some((m) => m.target === role));
    const home = convs.find((c) => c.key === land.conv);
    return {
      at: now,
      role: info,
      sessions: spans.map(wireSpan),
      session: span?.sessionId ?? (spans.length ? ALL_SESSIONS : ""),
      convs,
      // 链接来自哪个会话就默认开哪个 (见 landingOf); 否则最近活动的那个。
      conv: home?.key ?? convs[0]?.key ?? "",
      // 从群里点名字进来, 要看的是「我在这个群里和它说过什么」—— 默认只看与问话那一方的
      // 往来。票据不是一轮对话时不知道是谁问的, 退到最近说过话的那个人 (subs 已按往来、
      // 最近排好)。落在别的会话上就不猜。
      with: home?.subs.find((s) => s.count && (land.with ? s.role === land.with : s.role.startsWith("human:")))?.role ?? "",
      relations: hasRelations(msgs, role, info),
      schedules: schedules.length + jobs.length,
      // 侧栏日程入口的副标题: 下一枪几点、还开着几个工单、有没有坏掉的定时。
      plan: {
        tasks: schedules.length,
        jobs: jobs.filter((j) => j.status === "open").length,
        nextAt: schedules.reduce((m, x) => (m && m < x.nextAt ? m : x.nextAt), 0),
        broken: schedules.filter((x) => x.lastGate === "error" || !!x.loadError).length,
      },
      stats,
      // 「只看我与某个 wizard」的窗口自带一本账 —— 人的视角没有 stats, 用量看这里。
      winStats: win?.conv && dir.isWizard(win.with)
        ? windowStats(records, convMessages(msgs, role, win.conv, win.with).filter((m) => inSpan(span)(m.ts)), win.with, now)
        : undefined,
    };
  };

  const role: SimpleHandler = (_req, res, url) => {
    const ticket = resolveTicket(store, url);
    if (!ticket) { json(res, 404, { ok: false, error: NOT_FOUND }); return; }
    void getFacts().then((f) => {
      const records = listRecent();
      const v = viewOf(records, makeDirectory(records, f), ticket, url);
      if (!v) { json(res, 404, { ok: false, error: "不认识这个 role" }); return; }
      json(res, 200, { ok: true, ...summary(records, f, v.role, url.searchParams.get("session"), landingOf(ticket, v.role), v) });
    });
  };

  /** 一个窗口的全部片段, 时间序: 消息 + 视角 role 自己的断点。
   *  给的是**待渲染**的片段 —— 窗口通常只上屏最后几十条, 先按时间切片再渲染,
   *  没上屏的那几百轮就一个字都不用排。 */
  const windowFrags = (records: readonly DetailRecord[], dir: Directory, v: View, now: number): Array<{ ts: number; render: () => MsgFragment }> => {
    const msgs = convMessages(allMessages(records, now), v.role, v.conv, v.with || undefined)
      .filter((m) => inSpan(v.span)(m.ts));
    const lo = msgs[0]?.ts ?? Infinity;
    const marks = marksOf(records, v.role).filter((mk) => mk.createdAt >= lo && inSpan(v.span)(mk.createdAt));
    return [
      ...msgs.map((m) => ({ ts: m.ts, render: () => renderMsg(m, records, dir, now) })),
      ...marks.map((mk) => ({ ts: mk.createdAt, render: () => renderMark(mk, v.role, dir) })),
    ].sort((a, b) => a.ts - b.ts);
  };

  const viewOf = (records: readonly DetailRecord[], dir: Directory, ticket: Ticket, url: URL): View | undefined => {
    const r = pickRole(dir, ticket, url);
    if (!r) return undefined;
    const spans = sessionsOf(records, r, Date.now());
    return {
      role: r,
      conv: url.searchParams.get("conv") ?? "",
      with: dir.resolve(url.searchParams.get("with") ?? "") ?? "",
      span: spanOf(spans, url.searchParams.get("session")),
    };
  };

  const msgs: SimpleHandler = (_req, res, url) => {
    const ticket = resolveTicket(store, url);
    if (!ticket) { json(res, 404, { ok: false, error: NOT_FOUND }); return; }
    void getFacts().then((f) => {
      const records = listRecent();
      const dir = makeDirectory(records, f);
      const v = viewOf(records, dir, ticket, url);
      if (!v || !v.conv) { json(res, 200, { ok: true, at: Date.now(), total: 0, truncated: false, msgs: [] }); return; }
      const all = windowFrags(records, dir, v, Date.now());
      // 注意 Number(null) === 0 —— 缺省必须先判 null, 否则默认就成了"全量"。
      const raw = url.searchParams.get("limit");
      const n = raw === null ? Number.NaN : Number(raw);
      const limit = Number.isFinite(n) && n >= 0 ? n : DEFAULT_LIMIT;
      const shown = (limit === 0 ? all : all.slice(-limit)).map((x) => x.render());
      json(res, 200, { ok: true, at: Date.now(), role: v.role, conv: v.conv, total: all.length, truncated: shown.length < all.length, msgs: shown });
    });
  };

  // 票据照旧只证明「拿到过一条真链接」—— 任一有效票据可以看任一轮, 与 msgs 同一口径。
  const tool: SimpleHandler = (_req, res, url) => {
    if (!resolveTicket(store, url)) { json(res, 404, { ok: false, error: NOT_FOUND }); return; }
    const r = store.get(url.searchParams.get("turn") ?? "");
    const html = r && isTurn(r) ? renderToolBody(r, url.searchParams.get("use") ?? "") : undefined;
    if (html === undefined) { json(res, 404, { ok: false, error: "未找到该工具调用" }); return; }
    json(res, 200, { ok: true, html });
  };

  // SSE — 一条连接喂两种事件: role (侧栏 + 顶栏 + 页脚) 与 msg (当前窗口的增量)。
  // store.subscribe 的回调在写入路径上, 所以这里只打标记, 由 FLUSH_MS 定时器合并推送:
  // 一次工具结果会连带更新 turn 记录多次, 逐条推会把同一段 HTML 重复渲染。
  const events: SimpleHandler = (req, res, url) => {
    const ticket = resolveTicket(store, url);
    if (!ticket) { json(res, 404, { ok: false, error: "not found" }); return; }

    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no", // nginx 反代下不缓冲, 否则事件会被攒住
    });
    res.write(": open\n\n");

    const send = (event: string, data: unknown): void => {
      try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch { /* closed */ }
    };

    // 名册快照按连接缓存 —— 每次 flush 都问一遍 provider 会把 tmux 打爆 (daemon 侧
    // 本身也有 5s TTL, 这里再挡一层)。
    let f: WorldFacts = EMPTY_FACTS;
    let factsAt = 0;
    const freshFacts = async (): Promise<WorldFacts> => {
      if (Date.now() - factsAt > FACTS_MS) { f = await getFacts(); factsAt = Date.now(); }
      return f;
    };

    const sentSig = new Map<string, string>();
    const pushFrag = (frag: MsgFragment): void => {
      if (sentSig.get(frag.id) === frag.sig) return;
      sentSig.set(frag.id, frag.sig);
      send("msg", frag);
    };

    let v: View | undefined;
    const pushRole = async (): Promise<void> => {
      const ff = await freshFacts();
      const records = listRecent();
      v ??= viewOf(records, makeDirectory(records, ff), ticket, url);
      if (!v) return;
      send("role", summary(records, ff, v.role, url.searchParams.get("session"), landingOf(ticket, v.role), v));
    };

    /** 这一轮拆出的消息里, 落在当前窗口的那几条。 */
    const pushTurn = (id: string, records: readonly DetailRecord[], dir: Directory, now: number): void => {
      if (!v || !v.conv) return;
      const r = store.get(id);
      if (!r) return;
      if (isMark(r)) {
        if (r.target === v.role && inSpan(v.span)(r.createdAt)) pushFrag(renderMark(r, v.role, dir));
        return;
      }
      if (isPost(r)) {
        const m = messageOfPost(r);
        if (convMessages([m], v.role, v.conv, v.with || undefined).length && inSpan(v.span)(m.ts)) pushFrag(renderMsg(m, records, dir, now));
        return;
      }
      if (!isTurn(r) || !r.target) return;
      // 子 agent 的一轮渲染在父轮的出消息里 —— 推父轮。
      const top = r.agent?.parentTurnId ? store.get(r.agent.parentTurnId) : r;
      if (!top || !isTurn(top) || !top.target) return;
      const own = messagesOfTurn(top);
      const inWin = new Set(convMessages(own, v.role, v.conv, v.with || undefined).filter((m) => inSpan(v!.span)(m.ts)).map((m) => m.id));
      own.filter((m: Msg) => inWin.has(m.id)).forEach((m) => pushFrag(renderMsg(m, records, dir, now)));
    };

    void pushRole();

    let roleDirty = false;
    const turnDirty = new Set<string>();
    const flush = setInterval(() => {
      if (roleDirty) { roleDirty = false; void pushRole(); }
      if (turnDirty.size) {
        const now = Date.now();
        const records = listRecent();
        const dir = makeDirectory(records, f);
        for (const id of turnDirty) pushTurn(id, records, dir, now);
        turnDirty.clear();
      }
    }, FLUSH_MS);
    const ping = setInterval(() => { try { res.write(": ping\n\n"); } catch { /* closed */ } }, PING_MS);
    // 「执行中」的一半来自名册 (pane 的 busy), 而名册变了不会写 store —— 没有这一拍,
    // 最后一次写入带出去的那份旧快照会让灯一直亮着, 别人开工了侧栏也不知道。
    const beat = setInterval(() => { factsAt = 0; roleDirty = true; }, FACTS_MS);

    const unsub = store.subscribe((rec) => {
      if (!isTurn(rec) && !isMark(rec) && !isPost(rec)) return;
      if (!rec.target) return;
      // 侧栏的预览/时间只在与视角 role 有关的轮次变动时才需要重算。
      const involved = !v || rec.target === v.role || (isTurn(rec) && rec.from?.from === v.role) ||
        (isPost(rec) && !!v.conv && rec.channel === v.conv.slice(2)) ||
        (isTurn(rec) && !!v.conv && v.conv.startsWith("c:") && (rec.channel ?? baseOfKey(rec.target)) === v.conv.slice(2));
      if (involved) roleDirty = true;
      turnDirty.add(rec.id);
    });

    const close = (): void => {
      unsub();
      clearInterval(flush);
      clearInterval(ping);
      clearInterval(beat);
      try { res.end(); } catch { /* ignore */ }
    };
    req.on("close", close);
    req.on("error", close);
  };

  /** base → 那个聊天既有的票据。rolepage 下任何票据都能看任何 role, 这里给出去只是
   *  让「从关系图走进别的聊天」拿到一张落点就在那个聊天的链接。 */
  const ticketsByBase = (): Map<string, string> => {
    const best = store.list().reduce((m, r) => {
      const key = r.kind === "chat" ? r.target : isTurn(r) && r.target ? baseOfKey(r.target) : "";
      if (!key) return m;
      const ts = r.kind === "chat" ? Infinity : (r as { updatedAt: number }).updatedAt;
      const cur = m.get(key);
      return cur && cur.ts >= ts ? m : m.set(key, { id: r.id, ts });
    }, new Map<string, { id: string; ts: number }>());
    return new Map([...best].map(([base, v]) => [base, v.id] as const));
  };

  const world: SimpleHandler = (_req, res, url) => {
    const ticket = resolveTicket(store, url);
    if (!ticket) { json(res, 404, { ok: false, error: NOT_FOUND }); return; }
    void getFacts().then((f) => {
      const records = listRecent();
      const self = pickRole(makeDirectory(records, f), ticket, url);
      const w = buildWorld(records, f, { base: baseOfKey(self), self }, Date.now());
      const tickets = ticketsByBase();
      json(res, 200, { ok: true, ...w, chats: w.chats.map((c) => ({ ...c, token: tickets.get(c.base) })) });
    });
  };

  return { page, styles: asset(chatStyles), script: asset(chatScript), vendor: asset(chatVendor), role, msgs, tool, events, world };
};

/** Path → handler map; the daemon registers each, svr dispatches through it. */
export const chatRouteTable = (routes: ChatRoutes): Record<string, SimpleHandler> => ({
  "GET /role": routes.page,
  "GET /chat": routes.page,
  "GET /chat/app.css": routes.styles,
  "GET /chat/app.js": routes.script,
  "GET /chat/vendor.js": routes.vendor,
  "GET /api/role": routes.role,
  "GET /api/msgs": routes.msgs,
  "GET /api/tool": routes.tool,
  "GET /api/role-events": routes.events,
  "GET /api/world": routes.world,
});

/** Route keys, single-sourced so the daemon's registration can't drift. */
export const CHAT_ROUTE_KEYS = [
  "GET /role", "GET /chat", "GET /chat/app.css", "GET /chat/app.js", "GET /chat/vendor.js",
  "GET /api/role", "GET /api/msgs", "GET /api/tool", "GET /api/role-events", "GET /api/world",
] as const;
