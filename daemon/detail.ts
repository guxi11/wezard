// 工具调用 / 授权详情。Store + rendering 都在 shared/, 本文件是 daemon 侧胶水:
//   • 单例 store (init on boot, replay)
//   • record*() 写本地 + 可选转发到 remote svr (共享网络上的 detail 服务)
//   • buildDetailUrl 用 config.detailPublicBase / detailRemoteBase / LAN IP 兜底
//   • makeDetailHandler 把 GET /detail?id=xxx 渲染成 HTML
import { randomBytes } from "node:crypto";
import { hostname } from "node:os";
import type { Logger } from "pino";
import type { Decision } from "./pending.js";
import type { Handler } from "./http.js";
import { resolvePublicHost } from "../shared/lan-ip.js";
import {
  createDetailStore,
  type ApprovalDecision,
  type ApprovalDetailRecord,
  type ChatTicketRecord,
  type DetailRecord,
  type DetailStore,
  type MarkDetailRecord,
  type ToolDetailRecord,
  type TurnDetailRecord,
  type TurnItem,
  type TurnUsage,
} from "../shared/detail-store.js";
import { renderDetailPage, renderNotFound } from "../shared/detail-render.js";
import { createChatRoutes, chatRouteTable, CHAT_ROUTE_KEYS, type WorldFactsProvider } from "../shared/chat-http.js";
import { EMPTY_FACTS } from "../shared/world.js";

export type { ToolDetailRecord, ApprovalDetailRecord, TurnDetailRecord, MarkDetailRecord, TurnItem, TurnUsage, CtxCut, TurnOrigin, TurnFrom, TurnAgentMeta } from "../shared/detail-store.js";

let store: DetailStore | null = null;
let remoteBase = "";
let remoteToken = "";
// 关系视图的注册表侧数据源。路由在 boot 早期就注册好了, 而 wizard/job/schedule
// 注册表要到 mirror 块才建得起来 —— 所以这里存的是 provider 而不是数据, 由那边
// 装上 (同 bindWizardStore 的取舍)。没装 = headless 模式, 关系图退化成只画观测边。
let worldFacts: WorldFactsProvider | undefined;
export const setWorldFactsProvider = (fn: WorldFactsProvider): void => { worldFacts = fn; startFactsForward(); };

// 注册表侧的事实同样要过河。turn 记录是 POST /d 一条条推的, 但身份 / 家谱 / 工单 /
// 日程不是"发生的事", 而是"当下的状态" —— 没有增量可推, 只能整份快照定期覆盖。
// 30s: 采一次要按 pane 问一遍 tmux (见 index.ts 的 WORLD_TTL 说明), 而一个开着的
// 浏览器本来就 6s 问一次, 这个频率比它轻五倍, 却足够让远端的日程与名册是准的。
const FACTS_PUSH_MS = 30_000;
let factsTimer: NodeJS.Timeout | undefined;
/** 快照的来源署名 —— 一个 svr 可能接着好几台 daemon, 它按这个键分开存。 */
const factsSource = (): string => hostname() || "daemon";

const pushFacts = async (): Promise<void> => {
  if (!remoteBase || !worldFacts) return;
  const facts = await Promise.resolve(worldFacts()).catch(() => undefined);
  if (!facts) return;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (remoteToken) headers.authorization = `Bearer ${remoteToken}`;
  await fetch(`${remoteBase.replace(/\/+$/, "")}/w`, {
    method: "POST",
    headers,
    body: JSON.stringify({ source: factsSource(), facts }),
  }).catch(() => { /* 同 forwardToRemote: 远端挂了不该影响本机 */ });
};

// 两个前置条件 (配了远端、装上了 provider) 谁先到都可能 —— 两处都调一次, 起过就不再起。
const startFactsForward = (): void => {
  if (factsTimer || !remoteBase || !worldFacts) return;
  void pushFacts();
  factsTimer = setInterval(() => { void pushFacts(); }, FACTS_PUSH_MS);
  factsTimer.unref();
};

// 转发失败静默 — 远端 svr 挂了不该拖垮本地工具调用。
const forwardToRemote = (rec: DetailRecord): void => {
  if (!remoteBase) return;
  const url = `${remoteBase.replace(/\/+$/, "")}/d`;
  const body = JSON.stringify(rec);
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (remoteToken) headers.authorization = `Bearer ${remoteToken}`;
  fetch(url, { method: "POST", headers, body }).catch(() => { /* ignore */ });
};

export const initDetailPersistence = (stateDir: string, log?: Logger): void => {
  store = createDetailStore({ stateDir, log });
};

export const configureRemoteForward = (base: string, token: string): void => {
  remoteBase = base.trim();
  remoteToken = token.trim();
  startFactsForward();
};

// Decision (pending.ts) 是 4 项;detail 层扩了 timeout/swept 两个终态。
const toApprovalDecision = (d: Decision | "timeout" | "swept"): ApprovalDecision => d;

export const recordTool = (rec: Omit<ToolDetailRecord, "kind" | "createdAt"> & { createdAt?: number }): void => {
  if (!store) return;
  store.recordTool(rec);
  const full = store.get(rec.id);
  if (full) forwardToRemote(full);
};

export const recordToolResult = (toolUseId: string, full: string): void => {
  if (!store) return;
  store.recordToolResult(toolUseId, full);
  const rec = store.get(toolUseId);
  if (rec) forwardToRemote(rec);
};

export const recordApproval = (
  rec: Omit<ApprovalDetailRecord, "kind" | "createdAt" | "decision" | "decidedAt" | "decidedBy"> & { createdAt?: number },
): void => {
  if (!store) return;
  store.recordApproval(rec);
  const full = store.get(rec.id);
  if (full) forwardToRemote(full);
};

export const recordApprovalDecision = (
  reqId: string,
  decision: Decision | "timeout" | "swept",
  decidedBy?: string,
): void => {
  if (!store) return;
  store.recordApprovalDecision(reqId, toApprovalDecision(decision), decidedBy);
  const rec = store.get(reqId);
  if (rec) forwardToRemote(rec);
};

// 上下文断点标记: 清空/轮换发生的那一刻就落一条独立记录, chat 线程据此画分隔线,
// 不必等下一轮开口 (那一轮还可能是个被丢弃的空壳)。
export const recordMark = (rec: Omit<MarkDetailRecord, "kind" | "createdAt"> & { createdAt?: number }): void => {
  if (!store) return;
  store.recordMark(rec);
  const full = store.get(rec.id);
  if (full) forwardToRemote(full);
};

// Brief 模式聚合详情: 一个 turn 的时间线。startTurn 建空壳,item 增量 append,close 收尾。
// 每次变更都完整重推整条 record 给 remote svr — svr 侧存的是 last-write-wins 快照。
export const recordTurnStart = (
  rec: Omit<TurnDetailRecord, "kind" | "createdAt" | "updatedAt" | "closed" | "items"> & { createdAt?: number },
): void => {
  if (!store) return;
  store.startTurn(rec);
  const full = store.get(rec.id);
  if (full) forwardToRemote(full);
};

export const recordTurnItem = (id: string, item: TurnItem): void => {
  if (!store) return;
  store.appendTurnItem(id, item);
  const full = store.get(id);
  if (full) forwardToRemote(full);
};

export const recordTurnUsage = (id: string, delta: { model?: string; messageId?: string; usage: TurnUsage }): void => {
  if (!store) return;
  store.addTurnUsage(id, delta);
  const full = store.get(id);
  if (full) forwardToRemote(full);
};

export const recordTurnClose = (id: string): void => {
  if (!store) return;
  store.closeTurn(id);
  const full = store.get(id);
  if (full) forwardToRemote(full);
};

// 收尾此前遗留未关闭的 turn (按 target + sessionId 限定, 排除仍在收尾的当前 turn)。
export const recordCloseOpenTurns = (scope: { target?: string; sessionId?: string; exceptIds?: readonly string[] }): void => {
  if (!store) return;
  for (const id of store.closeOpenTurns(scope)) {
    const full = store.get(id);
    if (full) forwardToRemote(full);
  }
};

export const getDetail = (id: string): DetailRecord | undefined => store?.get(id);

// 一个 wizard 名字背后的 chat 链接需要一张票据 —— `?id=` 既是凭据, 也是页面默认
// 选中哪个 #tag 的默认值。从没跑过一轮的会话没有自己的票据, 返回 undefined。
export const latestTurnIdFor = (target: string): string | undefined => latestTurnId((r) => r.target === target);

// 一个聊天的长期票据 —— 没有就现造一条。`?id=` 的授权范围本来就是整个聊天 (见
// chat-http 的 resolveScope: base 由记录反推), 所以一张聊天级的票据不多给任何权限;
// 开在哪一栏交给 `target=` 明确指定。
// 为什么不能只靠 turn 记录: detail store 只留 24h / 1000 条, 而跨聊天派活的收信方
// 恰恰常常是刚出生 / 闲了一天的 wizard —— 气泡就落在它那个群里, 它却是全场唯一
// 点不开的那个名字。票据一个聊天一条、不参与回收, 于是「有没有链接」不再取决于
// 「最近有没有跑过一轮」。
export const chatTicketFor = (base: string): string | undefined => {
  if (!store || !base) return undefined;
  const found = store.list().find((r) => r.kind === "chat" && r.target === base);
  if (found) return found.id;
  // 长期凭据, 熵给足 —— turn id 那种 `t<时间戳><6 随机>` 的强度是按 24h 寿命定的。
  const rec: ChatTicketRecord = {
    kind: "chat",
    id: `c${randomBytes(12).toString("base64url")}`,
    createdAt: Date.now(),
    target: base,
  };
  store.put(rec);
  forwardToRemote(rec);
  return rec.id;
};

const latestTurnId = (pick: (r: TurnDetailRecord) => boolean): string | undefined =>
  store?.list()
    .filter((r): r is TurnDetailRecord => r.kind === "turn" && pick(r))
    .reduce<TurnDetailRecord | undefined>((best, r) => (best && best.updatedAt >= r.updatedAt ? best : r), undefined)
    ?.id;

// URL 优先级: publicBase (反代/自定义 host) > remoteBase (chat 端直连 svr)
// > fallback host+port (回环 → LAN IP 替换)。
// forceInnerBrowser=1 / ww_vw / ww_vh: WeCom 桌面端识别参数, 让链接在内置浏览器打开。
const detailRoot = (publicBase: string, fallbackHost: string, fallbackPort: number): string =>
  publicBase && publicBase.length > 0
    ? publicBase.replace(/\/+$/, "")
    : remoteBase && remoteBase.length > 0
      ? remoteBase.replace(/\/+$/, "")
      : `http://${resolvePublicHost(fallbackHost)}:${fallbackPort}`;

// ww_uniq 决定 WeCom 内置浏览器窗口复用: 同 chat 的所有 detail 链接共用一个窗口,
// 而不是每条 id 各开一个。无 chatId 时退回 record id (保留旧行为)。
const detailParams = (id: string, uniq?: string, target?: string): string =>
  new URLSearchParams({
    id,
    ...(target ? { target } : {}),
    forceInnerBrowser: "1", ww_vw: "1000", ww_vh: "800", ww_uniq: uniq ?? id,
  }).toString();

export const buildDetailUrl = (
  publicBase: string,
  fallbackHost: string,
  fallbackPort: number,
  id: string,
  uniq?: string,
): string => `${detailRoot(publicBase, fallbackHost, fallbackPort)}/detail?${detailParams(id, uniq)}`;

// Chat 视图入口。id 是那条 turn 记录 —— 它既是凭据, 也是默认选中哪一栏的兜底;
// `target` 显式指定开在哪个 wizard 那一栏 (同聊天内才认, 见 chat-http), 于是票据
// 是谁的都不影响页面落点。
export const buildChatUrl = (
  publicBase: string,
  fallbackHost: string,
  fallbackPort: number,
  id: string,
  uniq?: string,
  target?: string,
): string => `${detailRoot(publicBase, fallbackHost, fallbackPort)}/chat?${detailParams(id, uniq, target)}`;

// Chat 视图路由 (页面 + JSON API + SSE)。store 未初始化时全部 503 —— 只可能发生在
// initDetailPersistence 之前, 正常启动路径不会命中。
export const chatHandlers = (): Record<string, Handler> => {
  // provider 以闭包间接引用 —— chatHandlers 在 boot 早期就被调用, 那时 mirror 块
  // 还没装上 provider; 直接把 worldFacts 传进去会把 undefined 钉死。
  const routes = store ? chatRouteTable(createChatRoutes(store, () => (worldFacts ? worldFacts() : EMPTY_FACTS))) : {};
  const unavailable: Handler = (_req, res) => {
    res.statusCode = 503;
    res.end("detail store not ready");
  };
  return Object.fromEntries(
    CHAT_ROUTE_KEYS.map((key) => {
      const h = routes[key];
      return [key, h ? ((req, res, url) => h(req, res, url)) as Handler : unavailable];
    }),
  );
};

export const makeDetailHandler = (log: Logger): Handler => {
  return (_req, res, url) => {
    const id = url.searchParams.get("id") ?? "";
    if (!id) {
      res.statusCode = 400;
      res.setHeader("content-type", "text/plain; charset=utf-8");
      res.end("missing ?id=");
      return;
    }
    const rec = getDetail(id);
    if (!rec) {
      res.statusCode = 404;
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.end(renderNotFound(id));
      log.info({ id }, "detail not found");
      return;
    }
    res.statusCode = 200;
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.setHeader("cache-control", "no-store");
    res.end(renderDetailPage(rec));
  };
};
