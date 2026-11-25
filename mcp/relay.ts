// MCP relay `wezard` — the default per-pane child (`daemon.mcpTransport:"relay"`).
//
// Why it exists: a `type:"http"` MCP client can only dial a URL, and any TCP port left
// open for MCP can be squatted while the daemon restarts — the squatter would collect the
// token from the request headers and then call every tool as any pane. So the client
// speaks stdio to this relay, and the relay speaks to the daemon over its unix socket
// (uid-isolated, and the peer cannot be impersonated).
//
// Why not mcp/server.js: that one pulls in the SDK + zod + the whole tool registry
// (≈33MB RssAnon per pane); this one uses only node builtins (≈7~9MB).
// **Keep it that way — no SDK / zod / daemon imports here**, only node: modules and the
// builtin-only shared/daemon-addr.ts / daemon-token.ts.
//
// Protocol: each stdin line is one JSON-RPC message → `POST /mcp` over the socket; the
// reply body (JSON) goes back as one stdout line, one write per request, requests are
// independent (a slow tools/call never blocks the next line). 202 / empty body
// (notifications) writes nothing. A daemon that is down is retried for ~15s (a reload
// gap), then every request with an id gets a JSON-RPC error instead of hanging.
import { request } from "node:http";
import { createInterface } from "node:readline";
import { socketFromEnv } from "../shared/daemon-addr.js";
import { DAEMON_TOKEN_HEADER, readDaemonToken } from "../shared/daemon-token.js";

// WEZARD_RELAY_RETRY_MS 只给测试缩短窗口用。
const RETRY_WINDOW_MS = Number(process.env.WEZARD_RELAY_RETRY_MS) || 15_000;
const RETRY_STEP_MS = 500;

const sock = socketFromEnv();

// Same identity sources as mcp/tools.ts `selfRef` (env goes stale after /clear, the pane id doesn't).
const identityHeaders = (): Record<string, string> => {
  const session =
    process.env.CODEX_THREAD_ID ??
    process.env.CODEBUDDY_SESSION_ID ??
    process.env.CLAUDE_CODE_SESSION_ID ??
    process.env.CLAUDE_SESSION_ID;
  const pane = process.env.TMUX_PANE?.trim();
  return { ...(pane ? { "x-wezard-pane": pane } : {}), ...(session ? { "x-wezard-session": session } : {}) };
};

interface Reply { status: number; body: string }

const post = (payload: string): Promise<Reply> =>
  new Promise((resolve, reject) => {
    const req = request(
      {
        socketPath: sock,
        method: "POST",
        path: "/mcp",
        headers: {
          host: "wezard",
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
          "content-length": String(Buffer.byteLength(payload)),
          // 现读: daemon 可能在本进程起来之后才生成口令。
          [DAEMON_TOKEN_HEADER]: readDaemonToken(),
          ...identityHeaders(),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("error", reject);
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
      },
    );
    req.on("error", reject);
    req.end(payload);
  });

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// Only connection-level failures are retried (nothing reached the daemon, so a resend
// cannot double-run a tool); an answered request — whatever its status — is final.
const CONNECT_ERRORS = new Set(["ENOENT", "ECONNREFUSED", "ECONNRESET", "EPIPE"]);
const postWithRetry = async (payload: string): Promise<Reply> => {
  const deadline = Date.now() + RETRY_WINDOW_MS;
  for (;;) {
    try { return await post(payload); } catch (e) {
      const code = (e as NodeJS.ErrnoException).code ?? "";
      if (!CONNECT_ERRORS.has(code) || Date.now() >= deadline) throw e;
      await sleep(RETRY_STEP_MS);
    }
  }
};

const rpcError = (id: unknown, message: string): unknown => ({ jsonrpc: "2.0", id, error: { code: -32000, message } });

const idsOf = (msg: unknown): unknown[] =>
  (Array.isArray(msg) ? msg : [msg]).filter((m) => m && typeof m === "object" && "id" in m).map((m) => (m as { id: unknown }).id);

const parseJson = (text: string): unknown => { try { return JSON.parse(text); } catch { return undefined; } };
const isRpc = (v: unknown): boolean =>
  Array.isArray(v) ? v.length > 0 && v.every(isRpc) : !!v && typeof v === "object" && (v as { jsonrpc?: unknown }).jsonrpc === "2.0";

const out = (value: unknown): void => { process.stdout.write(`${typeof value === "string" ? value : JSON.stringify(value)}\n`); };

const handleLine = async (line: string): Promise<void> => {
  let msg: unknown;
  try { msg = JSON.parse(line); } catch {
    out(rpcError(null, "wezard relay: invalid JSON on stdin"));
    return;
  }
  const ids = idsOf(msg);
  try {
    const r = await postWithRetry(line);
    if (r.status === 202 || !r.body.trim()) return;
    // 单行写回: 多行的响应体压成一行再交。不是 JSON-RPC 的回包 (403 口令不对 / 5xx / 非 JSON)
    // 客户端读不懂: 带 id 的请求要有个说法, 通知就算了。
    const parsed = parseJson(r.body);
    if (isRpc(parsed)) out(JSON.stringify(parsed));
    else {
      const reason = (parsed as { reason?: unknown } | undefined)?.reason;
      const why = `wezard daemon replied http ${r.status} via ${sock}: ${typeof reason === "string" ? reason : r.body.slice(0, 200)}`;
      ids.forEach((id) => out(rpcError(id, why)));
    }
  } catch (e) {
    const why = `wezard daemon unreachable via ${sock}`;
    process.stderr.write(`[wezard-relay] ${why}: ${(e as Error).message}\n`);
    // 批量请求: 每个带 id 的各回一条; 通知不回。
    ids.forEach((id) => out(rpcError(id, why)));
  }
};

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
const inflight = new Set<Promise<void>>();
rl.on("line", (line) => {
  if (!line.trim()) return;
  const p = handleLine(line).finally(() => inflight.delete(p));
  inflight.add(p);
});
// stdin 关了 (CLI 退出): 等在飞的请求写完再走, 不丢最后一条响应。
rl.on("close", () => { void Promise.allSettled([...inflight]).then(() => process.exit(0)); });
