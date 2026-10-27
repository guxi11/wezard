// In-process MCP endpoint: the daemon serves the same tool surface as a pane's
// stdio child, over StreamableHTTP on the loopback port it already owns.
//
// Stateless by construction — one server + transport per request. The SDK binds a
// server to exactly one transport and JSON-RPC ids are per-connection, so sharing
// one registry across clients would cross-wire responses (two clients both calling
// initialize would collide). Building the registry is cheap (schema only), so pay
// it per request instead.
//
// The caller's identity cannot come from env here: the daemon is a single process
// with one env, while each request carries its own pane/session headers. That is
// what `mcpIdentity.run` is for — every handler downstream (selfRef → daemonPost)
// reads the store bound around this one request.
import type { IncomingMessage } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Logger } from "pino";
import { DAEMON_TOKEN_FILE, DAEMON_TOKEN_HEADER } from "../shared/daemon-token.js";
import { createWezardServer, mcpIdentity } from "../mcp/tools.js";
import { json, readBody, type Handler, type HttpServer } from "./http.js";

const PANE_HEADER = "x-wezard-pane";
const SESSION_HEADER = "x-wezard-session";

// Mirrors the stdio side's env reading: an empty value or a template that never
// got expanded (`${WEZARD_PANE}` left verbatim in a config) is no identity at all.
const headerOf = (req: IncomingMessage, name: string): string | undefined => {
  const raw = req.headers[name];
  const v = (Array.isArray(raw) ? raw[0] : raw)?.trim();
  return !v || v.includes("${") ? undefined : v;
};

const identityOf = (req: IncomingMessage): { sessionId?: string; tmuxPane?: string } => {
  const sessionId = headerOf(req, SESSION_HEADER);
  const tmuxPane = headerOf(req, PANE_HEADER);
  return { ...(sessionId ? { sessionId } : {}), ...(tmuxPane ? { tmuxPane } : {}) };
};

// 日志要的是「这一次调了什么」, 而 handleRequest 自己会拿走请求体: 先读一遍, 再把
// 解析结果作为第三参交回去, 让它不必去读一个已经空的流 (批量请求逐条记)。
type Rpc = { method?: string; params?: { name?: unknown } };
const rpcOf = (body: unknown): Rpc[] => (Array.isArray(body) ? body : [body]).filter((m): m is Rpc => !!m && typeof m === "object");

const handlePost = (log: Logger, tokenOk: (req: IncomingMessage) => boolean): Handler => async (req, res) => {
  if (!tokenOk(req)) {
    json(res, 403, {
      ok: false,
      reason: `POST /mcp 要出示 ${DAEMON_TOKEN_FILE} 里的口令 (header ${DAEMON_TOKEN_HEADER})`,
    });
    return;
  }
  const started = Date.now();
  const body = await readBody(req);
  const ident = identityOf(req);
  const rpcs = rpcOf(body);
  const server = createWezardServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  // 请求结束就收掉这一对: 不关的话每个请求都留一个 transport + 一份注册表。
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  try {
    await server.connect(transport);
    await mcpIdentity.run(ident, () => transport.handleRequest(req, res, body));
  } catch (e) {
    log.error({ err: (e as Error).message, pane: ident.tmuxPane, session: ident.sessionId }, "mcp http request failed");
    if (!res.headersSent) json(res, 500, { ok: false, reason: "mcp transport failed" });
  } finally {
    const fields = { pane: ident.tmuxPane, session: ident.sessionId, ms: Date.now() - started, status: res.statusCode };
    for (const rpc of rpcs) {
      const tool = rpc.params && typeof rpc.params.name === "string" ? rpc.params.name : undefined;
      if (rpc.method === "initialize" || rpc.method === "tools/call") log.info({ method: rpc.method, ...(tool ? { tool } : {}), ...fields }, "mcp http");
      else log.debug({ method: rpc.method, ...fields }, "mcp http");
    }
    if (rpcs.length === 0) log.debug(fields, "mcp http (no rpc method)");
  }
};

// Stateless: there is no standalone SSE stream to open and no session to delete, so
// both verbs answer 405 rather than pretending to hold state.
const notAllowed = (tokenOk: (req: IncomingMessage) => boolean): Handler => async (req, res) => {
  if (!tokenOk(req)) {
    json(res, 403, { ok: false, reason: `这条路由要出示 ${DAEMON_TOKEN_FILE} 里的口令 (header ${DAEMON_TOKEN_HEADER})` });
    return;
  }
  res.setHeader("Allow", "POST");
  json(res, 405, { ok: false, reason: "stateless MCP endpoint: only POST /mcp is served (no SSE stream, no sessions)" });
};

export const registerMcpHttp = (http: HttpServer, opts: { tokenOk: (req: IncomingMessage) => boolean; log: Logger }): void => {
  const post = handlePost(opts.log, opts.tokenOk);
  http.register("POST /mcp", post);
  http.register("GET /mcp", notAllowed(opts.tokenOk));
  http.register("DELETE /mcp", notAllowed(opts.tokenOk));
};
