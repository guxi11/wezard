// Chat detail routes, shared verbatim by the daemon and the standalone svr —
// both own a DetailStore, so both can serve the same view off it.
//
//   GET /chat          → static SPA shell (shared/chat-render)
//   GET /chat/app.css  → 视图样式 (detail 共用样式 + web/chat.css)
//   GET /chat/app.js   → 视图脚本 (web/chat.js)
//   GET /api/chat      → the chat list: every `#tag` session of this chat + status
//   GET /api/thread    → one tag's turns, as server-rendered HTML fragments
//   GET /api/events    → SSE: chat-summary deltas + turn fragments for one tag
//   GET /api/world     → 关系视图: 全部 wizard、家谱、跨聊天往来、工单、日程
//
// 资源路由不校验 `?id=` —— 它们是纯静态前端代码, 不含任何会话数据。
//
// Capability model unchanged from /detail: `?id=` is an unguessable record id
// and IS the credential. The base principal is derived from it server-side and
// never has to be typed by a client, so nothing becomes enumerable.
//
// /api/world 是这条线上唯一的放宽, 而且是有意的、有界的: 它回答"这个世界上有谁、
// 谁是谁生的、谁在驱动谁", 跨聊天可见 —— 因为那正是要展示的东西, 而每个 wizard
// 本来就能 `wizard_roster` 把同一份名册读个遍。
//
// 放宽到哪一步: 一张看得见的拓扑图, 点不进去就只是一张画 —— 所以每张聊天卡片
// 附一张**那个聊天既有的票据** (`chats[].token`), 双击别处的节点就走进那个群。
// 给的是既有凭据 (chat 记录 / 那个群最近一条 turn 的 id), 不新造、不降低强度,
// 进去之后照常按那张票据的聊天关: 拿到一条链接 ⇒ 看得见整张网, 并且**可以顺着
// 网走到相邻的群**。要把正文严格关在一个群里的部署, 不该开放 /api/world。
// 仍然不变的是 /api/thread 的 authorizedTarget: 一次只开一个聊天, 外聊天的节点
// 在本页上只有身份与关系, 没有对话预览。
import type { IncomingMessage, ServerResponse } from "node:http";
import type { URL } from "node:url";
import { baseOfKey } from "./session-label.js";
import { chatSummary, isMark, isTurn, threadEntries, turnDone, type ThreadEntry } from "./chat-view.js";
import { buildWorld, EMPTY_FACTS, type WorldFacts, type WorldNode } from "./world.js";
import { renderCutMark, renderTurnGroup } from "./detail-render.js";
import { chatScript, chatStyles, renderChatPage } from "./chat-render.js";
import type { Asset } from "./web-assets.js";
import type { DetailRecord, DetailStore } from "./detail-store.js";

export type SimpleHandler = (req: IncomingMessage, res: ServerResponse, url: URL) => void;

export interface ChatRoutes {
  page: SimpleHandler;
  styles: SimpleHandler;
  script: SimpleHandler;
  chat: SimpleHandler;
  thread: SimpleHandler;
  events: SimpleHandler;
  world: SimpleHandler;
}

/** 注册表侧的事实 (wizard 身份 / 家谱 / 工单 / 日程) —— 只有 daemon 给得出。
 *  async 是因为活体状态要问 tmux; 独立 svr 不传, 世界图退化成只画观测到的往来。
 *  实现方自己做节流: 这条路由会被前端定时轮询。 */
export type WorldFactsProvider = () => Promise<WorldFacts> | WorldFacts;

const DEFAULT_LIMIT = 20;
const FLUSH_MS = 300;
const PING_MS = 25_000;

const json = (res: ServerResponse, status: number, body: unknown): void => {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.end(JSON.stringify(body));
};

/** Chat a record belongs to. Turns/tools carry `target` directly; an approval
 *  only knows its sessionId, so borrow the base from a turn of that session. */
const baseFromRecord = (store: DetailStore, rec: DetailRecord): string => {
  const direct = (rec as { target?: string }).target;
  if (direct) return baseOfKey(direct);
  const sid = (rec as { sessionId?: string }).sessionId;
  if (!sid) return "";
  const owner = store.list()
    .filter(isTurn)
    .filter((r) => r.sessionId === sid && r.target)
    .sort((a, b) => b.updatedAt - a.updatedAt)[0];
  return owner?.target ? baseOfKey(owner.target) : "";
};

interface Scope { base: string; selfTarget: string }

const resolveScope = (store: DetailStore, url: URL): Scope | undefined => {
  const id = url.searchParams.get("id") ?? "";
  if (!id) return undefined;
  const rec = store.get(id);
  if (!rec) return undefined;
  const base = baseFromRecord(store, rec);
  if (!base) return undefined;
  return { base, selfTarget: (rec as { target?: string }).target ?? "" };
};

/** A `?target=` is only honoured when it lives in the same chat as the token. */
const authorizedTarget = (scope: Scope, raw: string | null): string => {
  const t = (raw ?? "").trim();
  if (!t) return scope.selfTarget;
  return baseOfKey(t) === scope.base ? t : scope.selfTarget;
};

/** 线程一格 → 客户端片段。子 agent 的卡片作为 children 内联进父轮, 不单独成格。 */
const renderEntry = (e: ThreadEntry, now: number): ReturnType<typeof renderTurnGroup> =>
  e.kind === "mark"
    ? renderCutMark(e.mark)
    : renderTurnGroup(e.turn, now, e.children.map((c) => renderTurnGroup(c, now)));

export const createChatRoutes = (store: DetailStore, facts?: WorldFactsProvider): ChatRoutes => {
  const summary = (base: string): ReturnType<typeof chatSummary> =>
    chatSummary(store.list(), base, Date.now());

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

  const chat: SimpleHandler = (_req, res, url) => {
    const scope = resolveScope(store, url);
    if (!scope) { json(res, 404, { ok: false, error: "未找到该会话 (链接可能已过期)" }); return; }
    const s = summary(scope.base);
    // `?target=` 优先于票据自带的那一栏 —— 一个链接可以拿兄弟会话的 id 当凭据
    // (detail store 只留 24h, 闲置的 wizard 没有自己的记录), 由它说清该开在谁那栏。
    json(res, 200, { ok: true, ...s, self: { target: authorizedTarget(scope, url.searchParams.get("target")) } });
  };

  const thread: SimpleHandler = (_req, res, url) => {
    const scope = resolveScope(store, url);
    if (!scope) { json(res, 404, { ok: false, error: "未找到该会话 (链接可能已过期)" }); return; }
    const target = authorizedTarget(scope, url.searchParams.get("target"));
    const now = Date.now();
    const all = threadEntries(store.list(), target, now);
    // 注意 Number(null) === 0 —— 缺省必须先判 null, 否则默认就成了"全量"。
    const raw = url.searchParams.get("limit");
    const n = raw === null ? Number.NaN : Number(raw);
    const limit = Number.isFinite(n) && n >= 0 ? n : DEFAULT_LIMIT;
    // 0 = 全量; 否则只回最近 N 格 (页面默认贴底, 更早的按需再拉)。
    const shown = limit === 0 ? all : all.slice(-limit);
    json(res, 200, {
      ok: true,
      target,
      at: now,
      total: all.length,
      truncated: shown.length < all.length,
      running: all.some((e) => e.kind === "turn" && [e.turn, ...e.children].some((r) => !turnDone(r, now))),
      turns: shown.map((e) => renderEntry(e, now)),
    });
  };

  // SSE — 一条连接同时喂两种事件: chat (侧栏 + 页脚总账) 与 turn (当前 tag 的增量)。
  // store.subscribe 的回调在写入路径上, 所以这里只打标记, 由 FLUSH_MS 定时器合并推送:
  // 一次工具结果会连带更新 turn 记录多次, 逐条推会把同一段 HTML 重复渲染。
  const events: SimpleHandler = (req, res, url) => {
    const scope = resolveScope(store, url);
    if (!scope) { json(res, 404, { ok: false, error: "not found" }); return; }
    const target = authorizedTarget(scope, url.searchParams.get("target"));

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
    const pushChat = (): void => send("chat", { ...summary(scope.base), self: { target } });
    // 一个 turn 的 HTML 可以是几十 KB, 而 usage 累加这类改动并不改变正文 —— 按 sig
    // 去重, 内容没变就不重发。
    const sentSig = new Map<string, string>();
    const pushFrag = (frag: ReturnType<typeof renderTurnGroup>): void => {
      if (sentSig.get(frag.id) === frag.sig) return;
      sentSig.set(frag.id, frag.sig);
      send("turn", frag);
    };
    // 推一条记录所在的那一格。子 agent 的一轮没有自己的顶层节点 —— 它渲染在父轮
    // 里面, 所以推的是父轮 (entries 由本次 flush 统一算一遍, 不逐条重建)。
    const pushTurn = (id: string, entries: readonly ThreadEntry[], now: number): void => {
      const r = store.get(id);
      if (!r) return;
      if (isMark(r)) { pushFrag(renderCutMark(r)); return; }
      if (!isTurn(r)) return;
      const hit = entries.find((e) => e.kind === "turn" && (e.turn.id === id || e.children.some((c) => c.id === id)));
      pushFrag(hit ? renderEntry(hit, now) : renderTurnGroup(r, now));
    };

    pushChat();

    let chatDirty = false;
    const turnDirty = new Set<string>();
    const flush = setInterval(() => {
      if (chatDirty) { chatDirty = false; pushChat(); }
      if (turnDirty.size) {
        const now = Date.now();
        const entries = threadEntries(store.list(), target, now);
        for (const id of turnDirty) pushTurn(id, entries, now);
        turnDirty.clear();
      }
    }, FLUSH_MS);
    const ping = setInterval(() => { try { res.write(": ping\n\n"); } catch { /* closed */ } }, PING_MS);

    const unsub = store.subscribe((rec) => {
      if ((!isTurn(rec) && !isMark(rec)) || !rec.target) return;
      if (baseOfKey(rec.target) !== scope.base) return;
      chatDirty = true;
      if (rec.target === target) turnDirty.add(rec.id);
    });

    const close = (): void => {
      unsub();
      clearInterval(flush);
      clearInterval(ping);
      try { res.end(); } catch { /* ignore */ }
    };
    req.on("close", close);
    req.on("error", close);
  };

  // 外聊天的节点只留身份与关系 —— preview 是对话正文, 不跨聊天下发 (见文件头的
  // capability 说明)。在服务端剥, 而不是指望前端不显示。
  const fenced = (n: WorldNode): WorldNode => (n.local ? n : { ...n, preview: "" });

  /** base → 进那个聊天的票据。长期票据 (chat 记录) 优先, 否则借那个群最近一条
   *  turn 的 id —— 两者的授权范围本来就一样 (resolveScope 从记录反推 base)。
   *  一趟扫完: 这条路由是被轮询的, 每张卡片各扫一遍 store 会随记录数平方增长。 */
  const ticketsByBase = (): Map<string, string> => {
    // ts = 这张票据能活到什么时候的代理量: 长期票据给 Infinity (不参与回收),
    // turn 借来的那张按 updatedAt 取最新的一条 —— 最老的那条明天就 TTL 掉了。
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
    const scope = resolveScope(store, url);
    if (!scope) { json(res, 404, { ok: false, error: "未找到该会话 (链接可能已过期)" }); return; }
    void Promise.resolve(facts ? facts() : EMPTY_FACTS)
      .catch(() => EMPTY_FACTS)
      .then((f) => {
        const w = buildWorld(store.list(), f, { base: scope.base, self: scope.selfTarget }, Date.now());
        const tickets = ticketsByBase();
        json(res, 200, {
          ok: true,
          ...w,
          chats: w.chats.map((c) => ({ ...c, token: tickets.get(c.base) })),
          nodes: w.nodes.map(fenced),
        });
      });
  };

  return { page, styles: asset(chatStyles), script: asset(chatScript), chat, thread, events, world };
};

/** Path → handler map; the daemon registers each, svr dispatches through it. */
export const chatRouteTable = (routes: ChatRoutes): Record<string, SimpleHandler> => ({
  "GET /chat": routes.page,
  "GET /chat/app.css": routes.styles,
  "GET /chat/app.js": routes.script,
  "GET /api/chat": routes.chat,
  "GET /api/thread": routes.thread,
  "GET /api/events": routes.events,
  "GET /api/world": routes.world,
});

/** Route keys, single-sourced so the daemon's registration can't drift. */
export const CHAT_ROUTE_KEYS = [
  "GET /chat", "GET /chat/app.css", "GET /chat/app.js",
  "GET /api/chat", "GET /api/thread", "GET /api/events", "GET /api/world",
] as const;
