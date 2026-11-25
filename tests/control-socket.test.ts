// 控制面 unix socket: 权限位 / 陈旧 vs 活 / sun_path / 视图端口 410 / EADDRINUSE 不致命
// 运行: npx tsx tests/control-socket.test.ts
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer as createNetServer, connect } from "node:net";
import { createServer as createHttpServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigSchema } from "../shared/config.js";
import { daemonSocketPath, clientSocketPath, socketFromEnv, sockPathProblem } from "../shared/daemon-addr.js";
import { daemonRequest } from "../shared/daemon-client.js";
import { bindControlSocket, probeSocket, unlinkIfOwned, ControlSocketError } from "../daemon/control-socket.js";
import { startHttp } from "../daemon/http.js";

const root = mkdtempSync(join(tmpdir(), "wz-ctl-"));
const modeOf = (p: string): number => lstatSync(p).mode & 0o777;
const rejects = async (p: Promise<unknown>, re: RegExp, msg: string): Promise<void> => {
  await assert.rejects(p, (e: Error) => e instanceof ControlSocketError && re.test(e.message), msg);
};

// ── 地址派生 ────────────────────────────────────────────────
{
  const cfg = ConfigSchema.parse({ bot: { botId: "t", secret: "t" }, daemon: { stateDir: join(root, "st") } });
  assert.equal(daemonSocketPath(cfg), join(root, "st", "run", "daemon.sock"), "缺省 = <stateDir>/run/daemon.sock");
  const custom = ConfigSchema.parse({ bot: { botId: "t", secret: "t" }, daemon: { socket: join(root, "x.sock") } });
  assert.equal(daemonSocketPath(custom), join(root, "x.sock"));
  assert.equal(socketFromEnv({ WEZARD_DAEMON_SOCK: "/a/b.sock" }), "/a/b.sock", "env 优先");
  assert.equal(socketFromEnv({ WEZARD_STATE_DIR: "/s" }), "/s/run/daemon.sock", "其次 WEZARD_STATE_DIR");
  assert.equal(clientSocketPath(cfg, {}), join(root, "st", "run", "daemon.sock"), "能读配置就按配置");
  assert.equal(clientSocketPath(cfg, { WEZARD_DAEMON_SOCK: "/e.sock" }), "/e.sock", "env 压过配置");
  // 旧配置里的 http 读成 relay, 不报错
  const legacy = ConfigSchema.parse({ bot: { botId: "t", secret: "t" }, daemon: { mcpTransport: "http" } });
  assert.equal(legacy.daemon.mcpTransport, "relay");
  assert.equal(ConfigSchema.parse({ bot: { botId: "t", secret: "t" } }).daemon.mcpTransport, "relay");
  assert.equal(ConfigSchema.parse({ bot: { botId: "t", secret: "t" }, daemon: { mcpTransport: "stdio" } }).daemon.mcpTransport, "stdio");
  assert.equal(ConfigSchema.parse({ bot: { botId: "t", secret: "t" }, daemon: { port: 0 } }).daemon.port, 0, "port 0 = 关视图监听");
}

// ── sun_path ────────────────────────────────────────────────
{
  const long = join(root, "d".repeat(120), "daemon.sock");
  assert.match(sockPathProblem(long) ?? "", /过长.*daemon\.socket/);
  assert.equal(sockPathProblem(join(root, "ok.sock")), undefined);
  assert.equal(sockPathProblem("/" + "a".repeat(102)), undefined, "103 字节正好放得下");
  assert.ok(sockPathProblem("/" + "a".repeat(103)), "104 字节放不下");
  await rejects(bindControlSocket(createNetServer(), long), /过长/, "超长路径启动即报错");
  assert.ok(!existsSync(join(root, "d".repeat(120))), "报错前不建目录");
}

// ── 权限位: 目录 0700、socket 0600, 已存在的宽松目录被收紧 ─────────
{
  const dir = join(root, "perm");
  mkdirSync(dir, { mode: 0o755 });
  chmodSync(dir, 0o755);
  const sock = join(dir, "daemon.sock");
  const server = createNetServer();
  const b = await bindControlSocket(server, sock);
  assert.equal(modeOf(dir), 0o700, "已存在的目录被收紧到 0700");
  assert.equal(modeOf(sock), 0o600, "socket 0600");
  assert.ok(lstatSync(sock).isSocket());
  assert.equal(unlinkIfOwned(b), true);
  assert.ok(!existsSync(sock), "自己的 inode 被删");
  server.close();
}

// ── symlink 目录 / 非 socket 文件 ────────────────────────────
{
  const real = join(root, "real");
  mkdirSync(real, { mode: 0o700 });
  const link = join(root, "link");
  symlinkSync(real, link);
  await rejects(bindControlSocket(createNetServer(), join(link, "daemon.sock")), /不是普通目录/, "symlink 目录拒绝");
  assert.ok(!existsSync(join(real, "daemon.sock")));

  const dir = join(root, "plain");
  mkdirSync(dir, { mode: 0o700 });
  const f = join(dir, "daemon.sock");
  writeFileSync(f, "precious");
  await rejects(bindControlSocket(createNetServer(), f), /不是 socket/, "非 socket 文件拒绝");
  assert.ok(existsSync(f) && lstatSync(f).isFile(), "且不删");
}

// ── 活 vs 陈旧 ──────────────────────────────────────────────
{
  const dir = join(root, "live");
  mkdirSync(dir, { mode: 0o700 });
  const sock = join(dir, "daemon.sock");
  // 活: 另一个 server 在听 → 拒绝, 文件原样
  const holder = createNetServer((c) => { c.on("error", () => undefined); c.end("hi"); });
  await new Promise<void>((r) => holder.listen(sock, r));
  const ino = lstatSync(sock).ino;
  assert.equal(await probeSocket(sock), "live");
  await rejects(bindControlSocket(createNetServer(), sock), /another wezard daemon is listening/, "活 socket 拒绝启动");
  assert.equal(lstatSync(sock).ino, ino, "文件原样保留");
  await new Promise<void>((resolve, reject) => {
    const c = connect(sock); c.once("connect", () => { c.destroy(); resolve(); }); c.once("error", reject);
  });
  holder.close();
  assert.ok(!existsSync(sock));

  // 陈旧: 子进程 bind 后被 SIGKILL, 文件还在却没人听
  const child = spawn(process.execPath, ["-e", `require("net").createServer().listen(${JSON.stringify(sock)}, () => console.log("up"))`], { stdio: ["ignore", "pipe", "inherit"] });
  await new Promise<void>((r) => child.stdout!.once("data", () => r()));
  child.kill("SIGKILL");
  await new Promise((r) => child.once("exit", r));
  assert.ok(lstatSync(sock).isSocket(), "陈旧文件还在");
  assert.equal(await probeSocket(sock), "stale");
  const server = createNetServer();
  const b = await bindControlSocket(server, sock);
  assert.ok(lstatSync(sock).isSocket(), "陈旧被清理后 listen 成功");
  assert.equal(modeOf(sock), 0o600);

  // 退出只删自己的 inode: 被接手者替换后不动它
  unlinkIfOwned(b);
  const heir = createNetServer();
  await new Promise<void>((r) => heir.listen(sock, r));
  assert.equal(unlinkIfOwned(b), false, "路径上已是别人的 inode");
  assert.ok(existsSync(sock), "接手者的 socket 还在");
  heir.close(); server.close();
}

// ── startHttp: 控制面 socket + 只读视图 TCP ──────────────────
const freePort = async (): Promise<number> => {
  const s = createNetServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const p = (s.address() as { port: number }).port;
  await new Promise<void>((r) => s.close(() => r()));
  return p;
};
const logs: { level: string; msg: string; obj: unknown }[] = [];
const mkLog = (): any => {
  const l: any = { child: () => l };
  for (const level of ["trace", "debug", "info", "warn", "error", "fatal"])
    l[level] = (obj: unknown, msg?: string) => logs.push({ level, msg: msg ?? String(obj), obj });
  return l;
};
const ws: any = { client: { isConnected: true }, bots: () => [], status: () => ({}), reconnect: () => undefined, shutdown: async () => undefined };
const mkCfg = (name: string, port: number) =>
  ConfigSchema.parse({ bot: { botId: "t", secret: "t" }, daemon: { socket: join(root, name, "daemon.sock"), stateDir: join(root, name, "st"), host: "127.0.0.1", port } });

{
  const port = await freePort();
  const cfg = mkCfg("view", port);
  const http = startHttp({ cfg, ws, log: mkLog(), sourcePath: "/x" });
  http.register("GET /detail", (_req, res) => { res.end("detail-ok"); });
  http.register("POST /approve", (_req, res) => { res.end("approved"); });
  await http.ready;
  assert.equal(process.env.WEZARD_DAEMON_SOCK, cfg.daemon.socket, "daemon 启动即设 WEZARD_DAEMON_SOCK");
  await new Promise((r) => setTimeout(r, 100));

  // socket 上: 全部路由
  const h = await daemonRequest("GET", "/healthz", { socketPath: http.socketPath });
  assert.equal(h.status, 200);
  const st = await daemonRequest("GET", "/status", { socketPath: http.socketPath });
  assert.equal((st.json as any).socket, cfg.daemon.socket, "/status 报 socket 路径");
  assert.equal((await daemonRequest("POST", "/approve", { socketPath: http.socketPath, body: {} })).text, "approved");

  // TCP 视图: 只读路由 200
  const tcp = `http://127.0.0.1:${port}`;
  assert.equal((await fetch(`${tcp}/healthz`)).status, 200);
  assert.equal(await (await fetch(`${tcp}/detail?id=x`)).text(), "detail-ok");
  // 控制路由 410, 原因可读
  for (const [m, p] of [["GET", "/status"], ["POST", "/approve"], ["POST", "/shutdown"], ["POST", "/config/set"], ["GET", "/pending"]] as const) {
    const r = await fetch(`${tcp}${p}`, { method: m });
    assert.equal(r.status, 410, `${m} ${p} 在视图端口上 410`);
    const body = await r.json() as any;
    assert.equal(body.ok, false);
    assert.ok(body.reason.includes(cfg.daemon.socket) && body.reason.includes("需要重开"), "原因里有 socket 路径与处置");
  }
  // POST /mcp: JSON-RPC error 按请求 id
  const rpc = await fetch(`${tcp}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/list" }) });
  const rb = await rpc.json() as any;
  assert.equal(rb.id, 7);
  assert.equal(rb.error.code, -32000);
  assert.match(rb.error.message, /unix socket/);
  const note = await fetch(`${tcp}/mcp`, { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) });
  assert.equal(note.status, 202, "通知没有 id, 不回 error");
  const batch = await (await fetch(`${tcp}/mcp`, { method: "POST", body: JSON.stringify([{ jsonrpc: "2.0", id: 1, method: "a" }, { jsonrpc: "2.0", method: "b" }]) })).json() as any[];
  assert.deepEqual(batch.map((x) => x.id), [1], "批量只给带 id 的回 error");

  await http.close();
  assert.ok(!existsSync(cfg.daemon.socket), "退出删自己的 socket");
  await assert.rejects(fetch(`${tcp}/healthz`), "视图监听随之关闭");
}

// ── EADDRINUSE 不致命 / port 0 关闭 ─────────────────────────
{
  const squatter = createHttpServer((_q, r) => r.end("squatter"));
  await new Promise<void>((r) => squatter.listen(0, "127.0.0.1", r));
  const port = (squatter.address() as { port: number }).port;
  const cfg = mkCfg("busy", port);
  logs.length = 0;
  const http = startHttp({ cfg, ws, log: mkLog(), sourcePath: "/x" });
  await http.ready; // 不 reject
  await new Promise((r) => setTimeout(r, 200));
  assert.ok(logs.some((l) => l.level === "warn" && /view listener disabled/.test(l.msg)), "warn 一行 view listener disabled");
  assert.equal((await daemonRequest("GET", "/healthz", { socketPath: http.socketPath })).status, 200, "控制面照常");
  assert.equal(await (await fetch(`http://127.0.0.1:${port}/healthz`)).text(), "squatter", "端口仍是占用者的");
  await http.close();
  squatter.close();

  logs.length = 0;
  const off = startHttp({ cfg: mkCfg("off", 0), ws, log: mkLog(), sourcePath: "/x" });
  await off.ready;
  assert.ok(logs.some((l) => /view listener disabled \(daemon\.port=0\)/.test(l.msg)), "port 0 不开视图监听");
  assert.equal((await daemonRequest("GET", "/healthz", { socketPath: off.socketPath })).status, 200);
  await off.close();
}

// ── 活 daemon 在听: 第二个 startHttp 的 ready reject, 且不动对方的 socket ───
{
  const a = startHttp({ cfg: mkCfg("dup", 0), ws, log: mkLog(), sourcePath: "/x" });
  await a.ready;
  const ino = lstatSync(a.socketPath).ino;
  const b = startHttp({ cfg: mkCfg("dup", 0), ws, log: mkLog(), sourcePath: "/x" });
  await assert.rejects(b.ready, /another wezard daemon is listening/);
  assert.equal(lstatSync(a.socketPath).ino, ino, "第一个的 socket 没被动");
  assert.equal((await daemonRequest("GET", "/healthz", { socketPath: a.socketPath })).status, 200);
  await b.close(); // 绑定失败的实例 close 不能删别人的 socket
  assert.ok(existsSync(a.socketPath), "失败者 close 不删对方的 socket");
  await a.close();
}

rmSync(root, { recursive: true, force: true });
console.log("control-socket.test: ok");
