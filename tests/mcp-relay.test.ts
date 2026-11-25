// MCP relay 端到端: relay 进程 (mcp/relay.ts) ↔ unix socket ↔ registerMcpHttp 挂的 daemon /mcp。
// 覆盖 initialize / tools/list / tools/call 往返 (含身份头)、通知不回、并发、口令不对、
// daemon 不在时带 id 的请求得到 JSON-RPC error 而不是挂起、reload 空窗内重试。
// 运行: npx tsx tests/mcp-relay.test.ts  (子进程用 `node --import tsx` 跑源码, 一次只起一个)
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { URL } from "node:url";

const root = mkdtempSync(join(tmpdir(), "wz-relay-"));
const sock = join(root, "d.sock");
const TOKEN = "test-token-123";
// relay 每次现读 ~/.wezard/daemon-token: 把 HOME 指到临时目录。
const homeWith = (name: string, token: string | null): string => {
  const h = join(root, name);
  mkdirSync(join(h, ".wezard"), { recursive: true });
  if (token !== null) writeFileSync(join(h, ".wezard", "daemon-token"), token);
  return h;
};
const goodHome = homeWith("home-ok", TOKEN);
process.env.WEZARD_DAEMON_SOCK = sock; // 进程内 MCP 工具 (daemonPost) 回打自己

// 先设好 env 再 import: 工具层每次调用现读它, 但保险起见放在前面。
const { registerMcpHttp } = await import("../daemon/mcp-http.js");
const { json, readBody } = await import("../daemon/http.js");

const routes = new Map<string, (req: any, res: any, url: URL) => unknown>();
const fakeHttp = { register: (k: string, h: any) => routes.set(k, h) } as any;
const silent: any = { error: () => undefined, info: () => undefined, debug: () => undefined, warn: () => undefined, child: () => silent };
registerMcpHttp(fakeHttp, { tokenOk: (req) => req.headers["x-wezard-token"] === TOKEN, log: silent });
routes.set("POST /tasks/list", async (req, res) => {
  const body = await readBody(req) as { tmuxPane?: string; sessionId?: string };
  // 把 relay 带来的身份原样回显: 工具层 selfRef → daemonPost 把它放进 body
  json(res, 200, { ok: true, tasks: [{ id: "t1", pane: body.tmuxPane ?? null, sid: body.sessionId ?? null }] });
});
const mkServer = (): Server => createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://wezard");
  const h = routes.get(`${req.method} ${url.pathname}`);
  if (!h) return json(res, 404, { error: "not_found" });
  await h(req, res, url);
});
const listen = (s: Server): Promise<void> => new Promise((r) => s.listen(sock, r));

interface Relay { child: ChildProcess; send: (m: unknown) => void; next: (ms?: number) => Promise<any>; none: (ms: number) => Promise<void>; close: () => Promise<void> }
const startRelay = (env: Record<string, string>): Relay => {
  const child = spawn(process.execPath, ["--import", "tsx", "mcp/relay.ts"], {
    env: { PATH: process.env.PATH!, WEZARD_DAEMON_SOCK: sock, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const lines: any[] = [];
  const waiters: Array<(v: any) => void> = [];
  createInterface({ input: child.stdout! }).on("line", (l) => {
    const v = JSON.parse(l); // 每行必须是完整 JSON
    const w = waiters.shift();
    w ? w(v) : lines.push(v);
  });
  return {
    child,
    send: (m) => child.stdin!.write(`${JSON.stringify(m)}\n`),
    next: (ms = 30_000) => lines.length ? Promise.resolve(lines.shift()) : new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("relay produced no output (hung?)")), ms);
      waiters.push((v) => { clearTimeout(t); resolve(v); });
    }),
    none: async (ms) => { await new Promise((r) => setTimeout(r, ms)); assert.equal(lines.length, 0, `unexpected output: ${JSON.stringify(lines)}`); },
    close: () => new Promise((resolve) => { child.once("exit", () => resolve()); child.stdin!.end(); }),
  };
};
const INIT = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "0" } } };

try {
  // ── 往返 ────────────────────────────────────────────────
  const server = mkServer();
  await listen(server);
  const relay = startRelay({ HOME: goodHome, TMUX_PANE: "%7", CLAUDE_CODE_SESSION_ID: "sess-x" });
  relay.send(INIT);
  const init = await relay.next();
  assert.equal(init.id, 1);
  assert.ok(init.result?.serverInfo, "initialize 有 serverInfo");

  relay.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  await relay.none(400); // 通知 (202 / 空体) 不写 stdout

  relay.send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  const list = await relay.next();
  assert.equal(list.id, 2);
  assert.ok(list.result.tools.some((t: any) => t.name === "list_tasks"), "tools/list 含 list_tasks");

  // 并发两条 tools/call: 各自独立返回
  relay.send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "list_tasks", arguments: {} } });
  relay.send({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "list_tasks", arguments: { mine: true } } });
  const got = [await relay.next(), await relay.next()].sort((a, b) => a.id - b.id);
  assert.deepEqual(got.map((g) => g.id), [3, 4]);
  for (const g of got) {
    const out = JSON.parse(g.result.content[0].text);
    assert.equal(out.tasks[0].id, "t1");
    assert.equal(out.tasks[0].pane, "%7", "x-wezard-pane 来自 TMUX_PANE");
    assert.equal(out.tasks[0].sid, "sess-x", "x-wezard-session 来自 CLAUDE_CODE_SESSION_ID");
  }
  await relay.close();

  // ── 口令不对: 403 变成带 id 的 JSON-RPC error, 带上原因 ─────
  const noTok = startRelay({ HOME: homeWith("home-notoken", null) });
  noTok.send(INIT);
  const denied = await noTok.next();
  assert.equal(denied.id, 1);
  assert.equal(denied.error.code, -32000);
  assert.match(denied.error.message, /口令/);
  await noTok.close();

  // ── 非法输入: 不崩 ────────────────────────────────────
  const junk = startRelay({ HOME: goodHome });
  junk.child.stdin!.write("not json\n");
  const bad = await junk.next();
  assert.equal(bad.error.code, -32000);
  assert.equal(bad.id, null);
  await junk.close();

  // ── daemon 在 relay 起来之后才到 (reload 空窗): 重试到连上 ──
  await new Promise<void>((r) => server.close(() => r()));
  const gap = startRelay({ HOME: goodHome, WEZARD_RELAY_RETRY_MS: "10000" });
  gap.send(INIT);
  await new Promise((r) => setTimeout(r, 1500));
  const late = mkServer();
  await listen(late);
  const lateInit = await gap.next();
  assert.equal(lateInit.id, 1);
  assert.ok(lateInit.result, "重试窗口内 daemon 回来, 请求照常完成");
  await gap.close();
  await new Promise<void>((r) => late.close(() => r()));

  // ── 连上之后断开: 请求可能已被执行, 绝不重发; 带 id 的请求得到 JSON-RPC error ──
  let hits = 0;
  const dropper = createServer((req, res) => {
    hits++;
    req.resume();
    req.on("end", () => req.socket.destroy()); // 请求体完整送达之后才断 (daemon 收到并在执行时 reload 退出)
  });
  await listen(dropper);
  const lost = startRelay({ HOME: goodHome, WEZARD_RELAY_RETRY_MS: "10000" });
  lost.send({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "list_tasks", arguments: {} } });
  const lostErr = await lost.next();
  assert.equal(lostErr.id, 5);
  assert.equal(lostErr.error.code, -32000);
  assert.match(lostErr.error.message, /connection lost mid-request.*may or may not have run/);
  await new Promise((r) => setTimeout(r, 1500)); // 若会重试, 窗口内早该再来一次
  assert.equal(hits, 1, "daemon 只收到 1 次, relay 没有重发");
  await lost.close();
  await new Promise<void>((r) => dropper.close(() => r()));

  // ── daemon 不在: 重试窗口过后, 带 id 的请求得到 JSON-RPC error, 通知静默 ──
  const down = startRelay({ HOME: goodHome, WEZARD_RELAY_RETRY_MS: "1200" });
  const t0 = Date.now();
  down.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  down.send({ jsonrpc: "2.0", id: 9, method: "tools/list" });
  const err = await down.next();
  assert.equal(err.id, 9);
  assert.equal(err.error.code, -32000);
  assert.ok(err.error.message.includes(`wezard daemon unreachable via ${sock}`), err.error.message);
  assert.ok(Date.now() - t0 < 15_000, "不挂起");
  await down.none(300); // 通知没有 id, 不回 error
  await down.close();
} finally {
  rmSync(root, { recursive: true, force: true });
}
console.log("mcp-relay.test: ok");
