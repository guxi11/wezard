// 工具调用 / 授权详情。Store + rendering 都在 shared/, 本文件是 daemon 侧胶水:
//   • 单例 store (init on boot, replay)
//   • record*() 写本地 + 可选转发到 remote svr (共享网络上的 detail 服务)
//   • buildDetailUrl 用 config.detailPublicBase / detailRemoteBase / LAN IP 兜底
//   • makeDetailHandler 把 GET /detail?id=xxx 渲染成 HTML
import type { Logger } from "pino";
import type { Decision } from "./pending.js";
import type { Handler } from "./http.js";
import { resolvePublicHost } from "../shared/lan-ip.js";
import {
  createDetailStore,
  type ApprovalDecision,
  type ApprovalDetailRecord,
  type DetailRecord,
  type DetailStore,
  type ToolDetailRecord,
  type TurnDetailRecord,
  type TurnItem,
  type TurnUsage,
} from "../shared/detail-store.js";
import { renderDetailPage, renderNotFound } from "../shared/detail-render.js";
import { createChatRoutes, chatRouteTable, CHAT_ROUTE_KEYS } from "../shared/chat-http.js";

export type { ToolDetailRecord, ApprovalDetailRecord, TurnDetailRecord, TurnItem, TurnUsage, CtxCut, TurnOrigin, TurnAgentMeta } from "../shared/detail-store.js";

let store: DetailStore | null = null;
let remoteBase = "";
let remoteToken = "";

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
const detailParams = (id: string, uniq?: string): string =>
  new URLSearchParams({ id, forceInnerBrowser: "1", ww_vw: "1000", ww_vh: "800", ww_uniq: uniq ?? id }).toString();

export const buildDetailUrl = (
  publicBase: string,
  fallbackHost: string,
  fallbackPort: number,
  id: string,
  uniq?: string,
): string => `${detailRoot(publicBase, fallbackHost, fallbackPort)}/detail?${detailParams(id, uniq)}`;

// Chat 视图入口。id 仍是那条 turn 记录 —— 它既是凭据, 也决定默认选中哪个 #tag。
export const buildChatUrl = (
  publicBase: string,
  fallbackHost: string,
  fallbackPort: number,
  id: string,
  uniq?: string,
): string => `${detailRoot(publicBase, fallbackHost, fallbackPort)}/chat?${detailParams(id, uniq)}`;

// Chat 视图路由 (页面 + JSON API + SSE)。store 未初始化时全部 503 —— 只可能发生在
// initDetailPersistence 之前, 正常启动路径不会命中。
export const chatHandlers = (): Record<string, Handler> => {
  const routes = store ? chatRouteTable(createChatRoutes(store)) : {};
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
