// Rolepage routes, shared verbatim by the daemon and the standalone svr — both own a
// DetailStore, so both serve the same view off it. Room 历史另需一个 room 账本读者 (RoomReader):
// daemon 有, svr 没有该参数时 room 视图退化成「只有图与成员」。
//
//   GET /role             → static SPA shell (shared/chat-render)
//   GET /chat/app.css     → 视图样式 (高亮主题 + detail 共用样式 + web/chat.css)
//   GET /chat/app.js      → 视图脚本 (web/chat.js)
//   GET /chat/vendor.js   → markdown-it + highlight.js (随包分发, 不走 CDN)
//   GET /api/world        → 二部图: rooms + wizard/人 节点 + 家谱图层 + plans / 日程
//   GET /api/room         → 一个 room 的快照 + 历史分页 (before / limit)
//   GET /api/wizard       → 一个 wizard 的名片 + 与它相关的消息 (它说的 + 指向它的)
//   GET /api/turn         → 一条消息对应的那一轮的过程框 (工具调用只有摘要)
//   GET /api/tool         → 一次工具调用的展开正文 —— 过程框的第二级, 展开时才取
//   GET /api/charter      → 一个 wizard 出生时被压进系统提示的宪章
//   GET /api/search       → ⌘K: 搜 room 名 / 成员 / 消息正文 (账本全量)
//
// 资源路由不校验 ?id= —— 它们是纯静态前端代码, 不含任何会话数据。
//
// Capability: ?id= 是一条不可猜的记录 id, 它就是凭据。rolepage 的核心动作是
// 「点一条消息就切到它的作者 / 对端」—— 对端可能住在任何一个 room 里, 所以任一有效
// 票据可以看全部 role (单用户部署, 名册本来就对每个 wizard 敞开)。
import type { IncomingMessage, ServerResponse } from "node:http";
import { gzipSync } from "node:zlib";
import type { URL } from "node:url";
import { baseOfKey, sameBot } from "./session-label.js";
import { isTurn } from "./chat-view.js";
import { buildWorld, EMPTY_FACTS, withChatNameFallback, withData, type WorldFacts } from "./world.js";
import { buildRoomFact, buildRoomFacts, dutyFacts, lastSaidAt, roomCreatedAt, roomHistory, whoRef, wizardMessages, wokeRows, type RoomFact, type RoomMsg } from "./room-view.js";
import { unreadCount, type MsgRow, type RenderNames, type RoomState } from "./room.js";
import { channelOf, makeDirectory, roleInfo, roleStats, sessionsOf, spanKey, type SessionSpan } from "./role-view.js";
import { roomMembers } from "./group-members.js";
import { charterBrief, charterView } from "./charter-view.js";
import { renderToolBody } from "./detail-render.js";
import { isInjection, renderTurnBox, roomDeco, spokenTurn, wireMsg, wizardStream } from "./role-render.js";
import { searchRooms } from "./room-search.js";
import { chatScript, chatStyles, chatVendor, renderChatPage } from "./chat-render.js";
import type { Asset } from "./web-assets.js";
import type { DetailRecord, DetailStore, TurnDetailRecord } from "./detail-store.js";
import type { SeenLog } from "./seen-log.js";

export type SimpleHandler = (req: IncomingMessage, res: ServerResponse, url: URL) => void;

/** room 账本的读口 (daemon/rooms.ts 的 RoomStore 满足它)。svr 没有: room 视图只剩快照。 */
export interface RoomReader {
  ids: () => string[];
  get: (id: string) => RoomState | undefined;
  /** 账本此刻能不能读。daemon 的 reader 在 boot 早期先挂上、room store 之后才开
   *  (与 worldFacts 同一取舍), 所以「挂上了」不等于「读得到」。 */
  ready?: () => boolean;
}

export interface ChatRoutes {
  page: SimpleHandler;
  styles: SimpleHandler;
  script: SimpleHandler;
  vendor: SimpleHandler;
  world: SimpleHandler;
  room: SimpleHandler;
  wizard: SimpleHandler;
  turn: SimpleHandler;
  tool: SimpleHandler;
  charter: SimpleHandler;
  search: SimpleHandler;
}

/** 注册表侧的事实 (wizard 身份 / 家谱 / plans / 日程 / room 快照) —— 只有 daemon 给得出。
 *  async 是因为活体状态要问 tmux; 独立 svr 用 daemon 推来的快照。
 *  实现方自己做节流: 这条路由会被前端定时轮询。 */
export type WorldFactsProvider = () => Promise<WorldFacts> | WorldFacts;

const DEFAULT_LIMIT = 60;
/** rolepage 只看最近这么久: 更早的轮次、wizard 登记与家谱一律不进视图。
 *  room 历史不受它限 —— 那是账本, 该翻多久翻多久。 */
export const HORIZON_MS = 3 * 24 * 3600_000;

const lastTsOf = (r: DetailRecord): number => (r as { updatedAt?: number }).updatedAt ?? r.createdAt;
const publicPlan = <T extends WorldFacts["plans"][number]>({ reminder: _reminder, ...plan }: T) => plan;

/** 记录侧的源头裁剪 —— 下游 (节点 / 过程框) 都只见得到这一份。 */
const recentRecords = (records: readonly DetailRecord[], cutoff: number): DetailRecord[] =>
  records.filter((r) => lastTsOf(r) >= cutoff);

/** 注册表侧的源头裁剪: 久未活动、也没有 room 的 wizard 连同它挂着的家谱一起退场。 */
const recentFacts = (f: WorldFacts, records: readonly DetailRecord[], now: number): WorldFacts => {
  const participants = new Set(records.filter(isTurn).map((r) => (r as { target?: string }).target).filter((t): t is string => !!t));
  const cutoff = now - HORIZON_MS;
  const byTarget = new Map(f.wizards.map((w) => [w.target, w] as const));
  const retained = new Set(f.plans.filter((p) => p.state === "active" || p.state === "paused").map((p) => p.owner));
  const pending = [...retained];
  while (pending.length) {
    const parent = byTarget.get(pending.pop()!)?.parent;
    if (parent && !retained.has(parent)) { retained.add(parent); pending.push(parent); }
  }
  // room 成员的身份不能因为最近没说话就被裁掉 —— 图上的成员线会悬空。
  const inRoom = new Set((f.rooms ?? []).flatMap((r) => r.members.filter((m) => m.who.kind === "wizard").map((m) => m.who.id)));
  return {
    ...f,
    wizards: f.wizards.filter((w) => retained.has(w.target) || participants.has(w.target) || w.busy || (!!w.uid && inRoom.has(w.uid)) || Math.max(w.lastActivity, w.bornAt ?? 0) >= cutoff),
    plans: f.plans,
  };
};

// 多机器人隔离: 一张票据只看得见与它 (票据 selfTarget) sameBot 的记录与名册。
const ofBot = (self: string) => (key: string | undefined): boolean => !key || sameBot(self, key);
const botRecords = (records: readonly DetailRecord[], self: string): DetailRecord[] =>
  records.filter((r) => ofBot(self)((r as { target?: string }).target));
const botFacts = (f: WorldFacts, self: string): WorldFacts => {
  const mine = ofBot(self);
  const keep = <V>(o: Readonly<Record<string, V>>): Record<string, V> => Object.fromEntries(Object.entries(o).filter(([k]) => mine(k)));
  const uidTarget = new Map(f.wizards.filter((w) => w.uid).map((w) => [w.uid!, w.target] as const));
  return {
    ...f,
    wizards: f.wizards.filter((w) => mine(w.target)),
    plans: f.plans.filter((p) => mine(p.owner)),
    ...(f.inflight ? { inflight: f.inflight.filter((x) => mine(x.from) && mine(x.to)) } : {}),
    schedules: f.schedules.filter((x) => mine(x.owner || x.createdBy || x.target)),
    chatNames: keep(f.chatNames),
    ...(f.humanNames ? { humanNames: keep(f.humanNames) } : {}),
    ...(f.weixin ? { weixin: f.weixin.filter((x) => mine(x.base)) } : {}),
    ...(f.classes ? { classes: f.classes.filter((c) => mine(c.id)) } : {}),
    // 绑定 room 的 id 就是聊天 base; dm / adhoc 的 id 是 uid —— 按成员是不是本 bot 的实例判。
    ...(f.rooms ? { rooms: f.rooms.filter((r) => mine(r.id) || r.members.some((m) => m.who.kind === "wizard" && mine(uidTarget.get(m.who.id)))) } : {}),
  };
};
const viewerOf = (t: Ticket): string => t.selfTarget;

/** 浏览器收 gzip 吗 (ServerResponse.req 就是这条请求)。远端 svr 的 room / world 回包 5~70KB, 资源 200KB+, 全文本, 压后 1/5 ~ 1/8。 */
const wantsGzip = (res: ServerResponse): boolean => /\bgzip\b/i.test(String(res.req?.headers["accept-encoding"] ?? ""));
const GZIP_MIN = 1024;
const sendText = (res: ServerResponse, body: string | Buffer, gz?: () => Buffer): void => {
  const raw = typeof body === "string" ? Buffer.from(body) : body;
  if (raw.length >= GZIP_MIN && wantsGzip(res)) {
    const z = gz ? gz() : gzipSync(raw);
    res.setHeader("content-encoding", "gzip");
    res.setHeader("vary", "accept-encoding");
    res.end(z);
    return;
  }
  res.end(raw);
};

const json = (res: ServerResponse, status: number, body: unknown): void => {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  sendText(res, JSON.stringify(body));
};

/** 票据自带的默认落点: turn/mark 的 target, 聊天票据的 base (= 那个聊天的默认 wizard)。 */
const ticketTarget = (store: DetailStore, rec: DetailRecord): string => {
  const direct = (rec as { target?: string }).target;
  if (direct) return direct;
  const sid = (rec as { sessionId?: string }).sessionId;
  if (!sid) return "";
  return store.list().filter(isTurn).filter((r) => r.sessionId === sid && r.target)
    .sort((a, b) => b.updatedAt - a.updatedAt)[0]?.target ?? "";
};

interface Ticket { selfTarget: string; turn?: TurnDetailRecord }

const resolveTicket = (store: DetailStore, url: URL): Ticket | undefined => {
  const rec = store.get(url.searchParams.get("id") ?? "");
  return rec ? { selfTarget: ticketTarget(store, rec), turn: isTurn(rec) && rec.target ? rec : undefined } : undefined;
};

const NOT_FOUND = "未找到该会话 (链接可能已过期)";

/** `role=` (名字 / target key / human:x) > 票据自带的那个 wizard。 */
const pickRole = (dir: ReturnType<typeof makeDirectory>, ticket: Ticket, url: URL): string => {
  const ref = url.searchParams.get("role") ?? "";
  // 只在 room 里出现过、注册表已经没有的 wizard 用 uid:<uid> 当节点 id —— 不经过名录。
  return ref.startsWith("uid:") ? ref : dir.resolve(ref) ?? ticket.selfTarget;
};

// Infinity 过不了 JSON。runs 是服务端的时间窗, 前端只认 start/end/turns。
const wireSpan = (s: SessionSpan) => { const { runs: _runs, ...rest } = s; return { ...rest, key: spanKey(s), end: Number.isFinite(s.end) ? s.end : 0 }; };

// ── room 的名字 / 消息补轮次 ──────────────────────────────────────────
const namesOf = (f: WorldFacts): RenderNames => {
  const byUid = new Map(f.wizards.filter((w) => w.uid).map((w) => [w.uid!, w.name] as const));
  const titleOf = new Map((f.rooms ?? []).map((r) => [r.id, r.title] as const));
  const labelOf = new Map((f.rooms ?? []).map((r) => [r.id, r.members.map((m) => m.name).join(" ↔ ")] as const));
  return {
    nameOf: (w) => w.kind === "wizard" ? byUid.get(w.id) ?? f.names?.[w.id] ?? w.id
      : w.kind === "human" ? f.humanNames?.["human:" + w.id] ?? f.names?.[w.id] ?? w.id
      : "wezard",
    // host 起的名字 (title) 是显式别名, 优先于聊天名 —— 只影响显示, 寻址仍只认 id。
    roomLabel: (room) => titleOf.get(room) || f.chatNames[room] || labelOf.get(room) || room,
  };
};

/** 提示行里的去处: 起过名 / 有聊天名就用名字, 否则一个短代号 (与前端 shortRoom 同口径) —— 不拿成员名拼。 */
const roomShortOf = (f: WorldFacts) => {
  const titleOf = new Map((f.rooms ?? []).map((r) => [r.id, r.title] as const));
  return (room: string): string => {
    const named = titleOf.get(room) || f.chatNames[room];
    if (named) return named;
    if (room.startsWith("dm:")) return "私聊";
    if (room.startsWith("adhoc:")) return "临时 room";
    const tail = room.replace(/^[a-z-]+:/, "").slice(-6);
    return (room.startsWith("user:") ? "单聊" : room.startsWith("chat:wx") ? "微信" : "群") + (tail ? " …" + tail : "");
  };
};

const TURN_SLACK_MS = 30 * 60_000;
/** 回包 JSON 里的账本行 id (`"id":"ef965dca.157"`, 可能被转义过几层)。 */
const ROW_ID_RE = /\bid\\*"\s*:\s*\\*"([0-9a-f]{8}\.\d+)\\*"/g;
const TURN_AHEAD_MS = 2 * 60_000;
/** 一条 room 消息对应哪一轮 turn —— 只为了「点开看过程框」, 不参与任何语义判定:
 *  作者是 wizard, 取它在这一刻之前 (容许一点时钟偏差) 最近开的那一轮。 */
const turnLinker = (records: readonly DetailRecord[], f: WorldFacts) => {
  const byTarget = new Map<string, TurnDetailRecord[]>();
  for (const r of records.filter(isTurn)) {
    if (!r.target || r.agent) continue;
    byTarget.set(r.target, [...(byTarget.get(r.target) ?? []), r]);
  }
  for (const rs of byTarget.values()) rs.sort((a, b) => a.createdAt - b.createdAt);
  const uidTarget = new Map(f.wizards.filter((w) => w.uid).map((w) => [w.uid!, w.target] as const));
  // 注册表里已经没有的实例 (切换前 migrate 进来的那批) 只剩显示名 —— 按 target 的 tag 兜底,
  // 不然这些成员的「过程」框永远点不开。
  const byTag = new Map<string, string>();
  for (const r of records.filter(isTurn)) {
    const tag = r.target && !r.agent ? r.target.split("#")[1] : "";
    if (tag) byTag.set(tag, r.target!);
  }
  const targetOf = (uid: string): string => {
    const hit = uidTarget.get(uid);
    if (hit) return hit;
    const name = f.names?.[uid] ?? "";
    return name ? byTag.get(name) ?? "" : "";
  };
  // 先认回包: 写账本的工具 (chat_reply / chat_say / chat_ask …) 回包里带着新行的 id —— 哪一轮的
  // tool_result 第一次出现这个 id, 这一行就是那一轮写的。按时刻猜会被紧接着开的下一轮抢走。
  const byRow = new Map<string, TurnDetailRecord>();
  for (const rs of byTarget.values()) for (const r of rs) for (const it of r.items) {
    if (it.t !== "tool_result") continue;
    for (const hit of it.body.matchAll(ROW_ID_RE)) if (!byRow.has(hit[1]!)) byRow.set(hit[1]!, r);
  }
  const lastAtOrBefore = (rs: readonly TurnDetailRecord[], at: number): TurnDetailRecord | undefined => {
    let lo = 0, hi = rs.length - 1, hit: TurnDetailRecord | undefined;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (rs[mid]!.createdAt <= at) { hit = rs[mid]; lo = mid + 1; } else hi = mid - 1;
    }
    return hit;
  };
  return (m: RoomMsg): string | undefined => {
    if (m.author.kind !== "wizard") return undefined;
    const target = targetOf(m.author.id);
    const exact = byRow.get(m.id);
    if (exact && exact.target === target) return exact.id;
    const rs = byTarget.get(target);
    if (!rs?.length) return undefined;
    // 回包里认不出 (老记录 / 迁移行): 退回时刻 —— 先找这一刻之前开的那一轮, 没有才容许一点时钟偏差。
    const hit = lastAtOrBefore(rs, m.at) ?? lastAtOrBefore(rs, m.at + TURN_AHEAD_MS);
    return hit && m.at - hit.createdAt <= TURN_SLACK_MS ? hit.id : undefined;
  };
};


/** 账本的读侧索引: 按 id 找行、找 re 它的行, 以及切换时刻 (第一条非迁移行; 此后终句零语义)。 */
interface Ledger { lookup: (id: string) => MsgRow | undefined; repliesOf: (id: string) => MsgRow[]; roomFrom: number }
const ledgerIndex = (states: readonly RoomState[]): Ledger => {
  const replies = new Map<string, MsgRow[]>();
  let roomFrom = Infinity;
  for (const s of states) for (const m of s.msgs) {
    if (m.origin !== "migrate") roomFrom = Math.min(roomFrom, m.at);
    for (const id of m.re ?? []) replies.set(id, [...(replies.get(id) ?? []), m]);
  }
  return {
    lookup: (id) => states.reduce<MsgRow | undefined>((hit, s) => hit ?? s.byId.get(id), undefined),
    repliesOf: (id) => replies.get(id) ?? [],
    roomFrom,
  };
};

export const createChatRoutes = (store: DetailStore, facts?: WorldFactsProvider, _seen?: SeenLog, rooms?: RoomReader): ChatRoutes => {
  // room 账本在手边 (daemon / 同机 svr) 就以账本为准重建 rooms —— 推送快照只补认表,
  // 不然 daemon 没重启时这里会一直是旧的一份 (比如人节点缺失)。
  const liveRooms = (): RoomReader | undefined => (rooms && (!rooms.ready || rooms.ready()) ? rooms : undefined);
  const roomsNow = (f: WorldFacts): WorldFacts => {
    const rs = liveRooms();
    if (!rs) return f;
    const states = rs.ids().flatMap((id) => { try { const s = rs.get(id); return s ? [s] : []; } catch { return []; } });
    return states.length ? { ...f, rooms: buildRoomFacts(states, namesOf(f)) } : f;
  };
  const getFacts = (t: Ticket): Promise<WorldFacts> =>
    Promise.resolve(facts ? facts() : EMPTY_FACTS)
      .then((f) => {
        const now = Date.now();
        const records = listRecent(t);
        return withData(recentFacts(botFacts(roomsNow(withChatNameFallback(f)), viewerOf(t)), records, now), records, now);
      })
      .catch(() => EMPTY_FACTS);
  const listRecent = (t: Ticket): DetailRecord[] => botRecords(recentRecords(store.list(), Date.now() - HORIZON_MS), viewerOf(t));
  const statesNow = (): RoomState[] => {
    const rs = liveRooms();
    return rs ? rs.ids().flatMap((id) => { try { const s = rs.get(id); return s ? [s] : []; } catch { return []; } }) : [];
  };

  const page: SimpleHandler = (_req, res) => {
    res.statusCode = 200;
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.setHeader("cache-control", "no-store");
    res.end(renderChatPage());
  };

  const gzCache = new Map<string, Buffer>();
  // 前端资源: ETag 跟着文件 mtime 走 —— 改一次 web/chat.js 浏览器就重新取一次。
  const asset = (make: () => Asset): SimpleHandler => (req, res) => {
    const a = make();
    res.setHeader("cache-control", "no-cache");
    res.setHeader("etag", a.etag);
    if (req.headers["if-none-match"] === a.etag) { res.statusCode = 304; res.end(); return; }
    res.statusCode = 200;
    res.setHeader("content-type", a.type);
    // 资源按 etag 缓存压缩结果: 压一次, 之后每个浏览器直接发。
    sendText(res, a.body, () => { const k = a.etag; let z = gzCache.get(k); if (!z) { z = gzipSync(typeof a.body === "string" ? Buffer.from(a.body) : a.body); if (gzCache.size > 16) gzCache.clear(); gzCache.set(k, z); } return z; });
  };

  const withTicket = (handler: (t: Ticket, url: URL, res: ServerResponse) => void): SimpleHandler => (_req, res, url) => {
    const ticket = resolveTicket(store, url);
    if (!ticket) { json(res, 404, { ok: false, error: NOT_FOUND }); return; }
    handler(ticket, url, res);
  };

  const roomOf = (url: URL): string => url.searchParams.get("room") ?? url.searchParams.get("id") ?? "";

  /** 一个 room 的快照 + 历史分页。没有账本读者 (独立 svr) 时明确说没有, 不装作空。 */
  const room: SimpleHandler = withTicket((ticket, url, res) => {
    const id = roomOf(url);
    if (!id) { json(res, 400, { ok: false, error: "room required" }); return; }
    const ledger = liveRooms();
    if (!ledger) { json(res, 503, { ok: false, error: "这个部署没有 room 账本 (只在 daemon 侧可读)" }); return; }
    let s: RoomState | undefined;
    try { s = ledger.get(id); } catch (e) { json(res, 409, { ok: false, error: String(e) }); return; }
    if (!s) { json(res, 404, { ok: false, error: "没有这个 room: " + id }); return; }
    void getFacts(ticket).then((f) => {
      const now = Date.now();
      const n = namesOf(f);
      const raw = url.searchParams.get("limit");
      const limit = raw && Number.isFinite(Number(raw)) ? Number(raw) : DEFAULT_LIMIT;
      const fromRef = url.searchParams.get("from");
      const from = fromRef ? whoRef([s], fromRef, n) : undefined;
      const hist = roomHistory(s, { ...(url.searchParams.get("before") ? { before: url.searchParams.get("before")! } : {}), limit, ...(from ? { from } : {}) }, n);
      const link = turnLinker(listRecent(ticket), f);
      const fact = buildRoomFact(s, n);
      const said = lastSaidAt(s);
      json(res, 200, {
        ok: true, at: now,
        room: fact,
        label: n.roomLabel(s.id),
        createdAt: roomCreatedAt(s),
        members: roomMembers(fact, f.wizards, f.classes ?? []).map((m) => {
          const at = said.get((m.kind === "wizard" ? "wizard:" : "human:") + m.id);
          return at ? { ...m, lastAt: at } : m;
        }),
        duties: dutyFacts(s, n),
        msgs: hist.msgs.map(wireMsg(ledgerIndex([s]).lookup, n.nameOf)).map((m) => ({ ...m, ...(link(m) ? { turn: link(m)! } : {}) })),
        total: hist.total,
        ...(hist.earlier ? { earlier: hist.earlier } : {}),
      });
    });
  });

  /** 一个 wizard 的名片 + W-1 / W-2 消息 (跨 room 按时间合并)。 */
  const wizard: SimpleHandler = withTicket((ticket, url, res) => {
    void getFacts(ticket).then((f) => {
      const now = Date.now();
      const records = listRecent(ticket);
      const dir = makeDirectory(records, f);
      const role = pickRole(dir, ticket, url);
      if (!role) { json(res, 404, { ok: false, error: "不认识这个 role" }); return; }
      const n = namesOf(f);
      const fact = f.wizards.find((w) => w.target === role);
      const uid = fact?.uid ?? (role.startsWith("uid:") ? role.slice(4) : "");
      const spans = sessionsOf(records, role, now);
      const sid = url.searchParams.get("session");
      const span = !sid || sid === "all" ? undefined : spans.find((s) => spanKey(s) === sid);
      const raw = url.searchParams.get("limit");
      const limit = raw && Number.isFinite(Number(raw)) ? Number(raw) : DEFAULT_LIMIT;
      const states = statesNow();
      // 票据的落点 room (detail link 进来「选中该 role + 该群聊」): turn 票据 = 这一轮说话的那个聊天, 其余 = 票据 wizard 的 home 群。
      // 只在它是现存 room 时给; 该 role 是不是它的成员留给前端判 (换 role 时不一定是)。
      const landing = ticket.turn ? channelOf(ticket.turn) : baseOfKey(ticket.selfTarget);
      const landingRoom = landing && (states.some((s) => s.id === landing) || (f.rooms ?? []).some((r) => r.id === landing)) ? landing : "";
      const schedules = f.schedules.filter((x) => (x.owner || x.createdBy || x.target) === role);
      const card = {
        ok: true, at: now,
        role: roleInfo(role, dir, f, roleStats(records, role, now, span), now),
        uid: uid || "",
        ledger: !!liveRooms(),
        sessions: spans.map(wireSpan),
        session: span ? spanKey(span) : "all",
        plans: f.plans.filter((p) => p.owner === role && (p.state === "active" || p.state === "paused" || p.state === "completed")).map(publicPlan),
        // 日程栏与 main 同形: gate 去向 / 出错理由 / 执行目标 / 任务文件都要, 前端按老卡片渲染。
        schedules,
        stats: roleStats(records, role, now, span),
        charter: charterBrief(store.list(), role),
        ...(landingRoom ? { landingRoom } : {}),
      };
      // card=1: 只要名片 (room 视角下左上角仍是 role, 不必为它再算一遍消息与时间轴)。
      if (url.searchParams.get("card") === "1") { json(res, 200, card); return; }
      const lx = ledgerIndex(states);
      const wire = wireMsg(lx.lookup, n.nameOf);
      const hist = uid && states.length
        ? wizardMessages(states, uid, { limit, ...(url.searchParams.get("before") ? { before: url.searchParams.get("before")! } : {}) }, n)
        : { msgs: [] as (RoomMsg & { roomLabel: string })[], total: 0 };
      const link = turnLinker(records, f);
      const linked = <M extends RoomMsg>(m: M): M => ({ ...m, ...(link(m) ? { turn: link(m)! } : {}) });
      // 时间轴要的是视野 (HORIZON) 内的全部账本行, 不是分页那 60 条 —— 一轮的气泡就是它写进账本的行。
      const since = now - HORIZON_MS;
      const streamMsgs = uid && states.length
        ? wizardMessages(states, uid, { limit: 0 }, n).msgs.filter((m) => m.at >= since).map(wire).map(linked)
        : [];
      json(res, 200, {
        ...card,
        msgs: hist.msgs.map(wire).map(linked),
        // 时间轴: 轮次为主线 (入 / 出 + 过程框), 账本行挂上去; 前端 wizard 视图按它画。
        stream: wizardStream(records, role, dir, now, {
          span,
          msgs: streamMsgs,
          woke: uid ? wokeRows(states, uid, since, n).map(wire) : [],
          roomLabel: n.roomLabel,
          chatLabel: roomShortOf(f),
          repliesOf: lx.repliesOf,
          lookup: lx.lookup,
          roomFrom: lx.roomFrom,
        }),
        total: hist.total,
        ...(hist.earlier ? { earlier: hist.earlier } : {}),
        rooms: f.rooms ?? [],
        names: f.names ?? {},
      });
    });
  });

  /** 关系图: room 二部图 + 家谱图层。 */
  const world: SimpleHandler = withTicket((ticket, url, res) => {
    void getFacts(ticket).then((f) => {
      const records = listRecent(ticket);
      const self = pickRole(makeDirectory(records, f), ticket, url);
      const { at, ...w } = buildWorld(records, f, { base: baseOfKey(self), self }, Date.now());
      // 未读 = 当前查看的 role 在每个 room 里游标之后别人说的行数 (room 账本的 member.seen); 只有 wizard 有游标。
      const uid = f.wizards.find((x) => x.target === self)?.uid ?? (self.startsWith("uid:") ? self.slice(4) : "");
      const byRoom = new Map(statesNow().map((s) => [s.id, s] as const));
      const withUnread = (r: RoomFact): RoomFact & { unread: number } => {
        const s = uid ? byRoom.get(r.id) : undefined;
        return { ...r, unread: s ? unreadCount(s, { kind: "wizard", id: uid }) : 0 };
      };
      json(res, 200, {
        ok: true, at, ...w, rooms: w.rooms.map(withUnread), plans: w.plans.map(publicPlan),
        // 名字表: room 成员只有 id (uid / userid), 图上与消息里的显示名都从这里取。
        chatNames: f.chatNames, names: f.names ?? {}, humanNames: f.humanNames ?? {},
      });
    });
  });

  const tool: SimpleHandler = withTicket((ticket, url, res) => {
    const r = store.get(url.searchParams.get("turn") ?? "");
    const html = r && isTurn(r) && ofBot(viewerOf(ticket))(r.target) ? renderToolBody(r, url.searchParams.get("use") ?? "") : undefined;
    if (html === undefined) { json(res, 404, { ok: false, error: "未找到该工具调用" }); return; }
    json(res, 200, { ok: true, html });
  });

  /** 一条消息对应的那一轮的过程框。 */
  const turn: SimpleHandler = withTicket((ticket, url, res) => {
    const r = store.get(url.searchParams.get("turn") ?? "");
    if (!r || !isTurn(r) || !ofBot(viewerOf(ticket))((r as { target?: string }).target)) {
      json(res, 404, { ok: false, error: "未找到这一轮" });
      return;
    }
    void getFacts(ticket).then((f) => {
      const lx = ledgerIndex(statesNow());
      const deco = roomDeco(makeDirectory(listRecent(ticket), f), { chatLabel: roomShortOf(f), repliesOf: lx.repliesOf, lookup: lx.lookup });
      // room 视图点开的过程框: 气泡就是那一行账本本身, 框里的 CLI 原话 (账本时代) 一律是过程。
      const era = r.createdAt >= lx.roomFrom || isInjection(r);
      json(res, 200, { ok: true, html: renderTurnBox(spokenTurn(r, [], era), store.list(), Date.now(), deco) });
    });
  });

  const charter: SimpleHandler = withTicket((ticket, url, res) => {
    void getFacts(ticket).then((f) => {
      const records = botRecords(store.list(), viewerOf(ticket));
      const r = pickRole(makeDirectory(listRecent(ticket), f), ticket, url);
      const v = r ? charterView(records, r) : undefined;
      json(res, 200, v ? { ok: true, role: r, ...v } : { ok: true, role: r, none: true });
    });
  });

  /** ⌘K: room 名 / 成员 / 消息正文。范围 = 这张票据看得到的 room (与 /api/world 同一份)。 */
  const search: SimpleHandler = withTicket((ticket, url, res) => {
    const q = url.searchParams.get("q") ?? "";
    void getFacts(ticket).then((f) => {
      const facts = f.rooms ?? [];
      const ids = new Set(facts.map((r) => r.id));
      json(res, 200, { ok: true, q, ...searchRooms(statesNow().filter((s) => ids.has(s.id)), facts, namesOf(f), roomShortOf(f), q) });
    });
  });

  return { page, styles: asset(chatStyles), script: asset(chatScript), vendor: asset(chatVendor), world, room, wizard, turn, tool, charter, search };
};

/** Path → handler map; the daemon registers each, svr dispatches through it. */
export const chatRouteTable = (routes: ChatRoutes): Record<string, SimpleHandler> => ({
  "GET /role": routes.page,
  "GET /chat/app.css": routes.styles,
  "GET /chat/app.js": routes.script,
  "GET /chat/vendor.js": routes.vendor,
  "GET /api/world": routes.world,
  "GET /api/room": routes.room,
  "GET /api/wizard": routes.wizard,
  "GET /api/turn": routes.turn,
  "GET /api/tool": routes.tool,
  "GET /api/charter": routes.charter,
  "GET /api/search": routes.search,
});

/** Route keys, single-sourced so the daemon's registration can't drift. */
export const CHAT_ROUTE_KEYS = [
  "GET /role", "GET /chat/app.css", "GET /chat/app.js", "GET /chat/vendor.js",
  "GET /api/world", "GET /api/room", "GET /api/wizard", "GET /api/turn", "GET /api/tool", "GET /api/charter", "GET /api/search",
] as const;
