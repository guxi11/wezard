// 端口递增 + 实际口落盘 + 链接跟随 + 实例署名。运行: npx tsx tests/ports-fallback.test.ts
// 会起两次 svr 子进程 (node --import tsx, 不经 npx: npx 不转发 SIGTERM, 孙进程会留下来), 占用本机几个临时 TCP 口, 跑完全部关掉。
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync, mkdirSync, statSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listenWithFallback, portsFileOf, readPorts, writePorts, EXIT_CONFIG } from "../shared/ports.js";
import { daemonSourceOf } from "../shared/instance-id.js";
import { buildChatUrl, buildDetailUrl, configureRemoteForward, detailRoot, linksDead, setViewPort } from "../daemon/detail.js";

const HOST = "127.0.0.1";
const tmp = mkdtempSync(join(tmpdir(), "wz-ports-"));
const servers: Server[] = [];
const hold = (port: number): Promise<Server> => new Promise((resolve, reject) => {
  const s = createServer();
  s.once("error", reject);
  s.listen(port, HOST, () => { servers.push(s); resolve(s); });
});
/** 一段连着的空闲口: 先让内核给一个, 再确认其后 n-1 个也空。 */
const freeRun = async (n: number): Promise<number> => {
  for (let i = 0; i < 50; i++) {
    const probe = await hold(0);
    const base = (probe.address() as { port: number }).port;
    await new Promise<void>((r) => probe.close(() => r()));
    servers.splice(servers.indexOf(probe), 1);
    if (base + n > 65535) continue;
    const got: Server[] = [];
    let ok = true;
    for (let p = base; p < base + n; p++) {
      try { got.push(await hold(p)); } catch { ok = false; break; }
    }
    await Promise.all(got.map((s) => new Promise<void>((r) => s.close(() => r()))));
    got.forEach((s) => servers.splice(servers.indexOf(s), 1));
    if (ok) return base;
  }
  throw new Error("no free port run");
};

const run = async (): Promise<void> => {
  // ── listenWithFallback: 首选口被占 → 落到 +1 ─────────────────────────
  const P = await freeRun(4);
  await hold(P);
  const s1 = createServer();
  const r1 = await listenWithFallback(s1, HOST, P, 3);
  assert.ok(r1.ok, "首选口被占时递增成功");
  assert.equal(r1.ok && r1.port, P + 1, "落在 +1");
  assert.equal(r1.ok && r1.tried, 2);
  servers.push(s1);

  // ── ports.json: 原子写、0600、合并 ──────────────────────────────────
  const stateDir = join(tmp, "state");
  const file = portsFileOf(stateDir);
  assert.equal(file, join(stateDir, "run", "ports.json"));
  writePorts(file, { view: { host: HOST, port: P + 1, pid: process.pid, at: 1 } });
  writePorts(file, { svr: null });
  assert.equal(readPorts(file).view?.port, P + 1, "写进实际口");
  assert.equal(readPorts(file).svr, null, "合并写不覆盖别的项; null = 没起来");
  assert.equal(statSync(file).mode & 0o777, 0o600, "ports.json 0600");
  assert.equal(statSync(join(stateDir, "run")).mode & 0o777, 0o700, "run 目录 0700");
  assert.deepEqual(readPorts(join(tmp, "nope.json")), {}, "没有文件 = 空");

  // ── 全被占: 返回失败, 不抛 ──────────────────────────────────────────
  const Q = await freeRun(3);
  await Promise.all([hold(Q), hold(Q + 1), hold(Q + 2)]);
  const r2 = await listenWithFallback(createServer(), HOST, Q, 2);
  assert.ok(!r2.ok, "全被占 = 失败");
  assert.equal(!r2.ok && r2.code, "EADDRINUSE");
  assert.equal(r2.tried, 3, "首选口 + span 个");

  // ── svr: 全被占 → 退出码 78; 首选口被占 → +1 且 ports.json 写对 ────────
  const svrState = join(tmp, "svr");
  const svrArgs = (port: number, span: number): string[] =>
    ["--import", "tsx", "svr/index.ts", "--host", HOST, "--port", String(port), "--port-span", String(span), "--state", svrState,
      "--rooms", join(tmp, "rooms"), "--token", "t", "--token-file", join(tmp, "svr-token"), "--log-level", "error"];
  const env = { ...process.env, WEZARD_CONFIG: join(tmp, "no-config.jsonc") };
  delete env.XPC_SERVICE_NAME;
  const code = await new Promise<number | null>((resolve) => {
    const c = spawn(process.execPath, svrArgs(Q, 2), { env, stdio: ["ignore", "ignore", "pipe"] });
    c.on("exit", (c2) => resolve(c2));
  });
  assert.equal(code, EXIT_CONFIG, "svr 全被占以 78 退出");
  assert.equal(readPorts(portsFileOf(svrState)).svr, null, "失败也记下 svr 没起来");

  const R = await freeRun(3);
  await hold(R);
  const child = spawn(process.execPath, svrArgs(R, 2), { env, stdio: ["ignore", "pipe", "pipe"] });
  const out = await new Promise<string>((resolve, reject) => {
    let buf = "";
    const t = setTimeout(() => reject(new Error("svr did not start: " + buf)), 30_000);
    child.stdout!.on("data", (d) => { buf += String(d); if (buf.includes("base URL")) { clearTimeout(t); resolve(buf); } });
    child.on("exit", (c2) => { clearTimeout(t); reject(new Error(`svr exited ${c2}: ${buf}`)); });
  });
  child.removeAllListeners("exit");
  assert.ok(out.includes(`listening on ${HOST}:${R + 1}`), "svr 落在 +1: " + out.split("\n")[0]);
  assert.equal(readPorts(portsFileOf(svrState)).svr?.port, R + 1, "svr 的 ports.json 写的是实际口");
  const health = await fetch(`http://${HOST}:${R + 1}/healthz`).then((r) => r.json() as Promise<{ ok: boolean }>);
  assert.equal(health.ok, true, "实际口上真的在服务");
  child.kill("SIGTERM");
  await new Promise((r) => child.once("exit", r));

  // ── 链接跟随实际口; 显式 base 优先; 没起来又没 base = 不发链接 ──────────
  assert.equal(detailRoot("", HOST, 17890), `http://${HOST}:17890`, "还没定时先用配置口");
  setViewPort(P + 1);
  assert.ok(buildChatUrl("", HOST, 17890, "t1", "u", "chat:x").startsWith(`http://${HOST}:${P + 1}/role?`), "链接跟着实际口");
  assert.ok(buildDetailUrl("", HOST, 17890, "t1").startsWith(`http://${HOST}:${P + 1}/detail?`));
  assert.ok(buildChatUrl("https://pub.example/wz/", HOST, 17890, "t1").startsWith("https://pub.example/wz/role?"), "显式 detailPublicBase 优先");
  setViewPort(null);
  assert.equal(buildChatUrl("", HOST, 0, "t1"), "", "视图没起来 + 无 base = 空串 (裸头), 不是 :0 死链");
  assert.equal(buildDetailUrl("", HOST, 17890, "t1"), "");
  assert.ok(linksDead(""), "这种情况要告警");
  assert.ok(!linksDead("https://pub.example"), "有 publicBase 就不算死链");
  configureRemoteForward("http://svr.example:17891/", "");
  assert.ok(buildChatUrl("", HOST, 0, "t1").startsWith("http://svr.example:17891/role?"), "显式 detailRemoteBase 优先于视图口");
  assert.ok(!linksDead(""));
  configureRemoteForward("", "");

  // ── 实例署名: 同机不同 stateDir 不撞; 同一目录 (含符号链接写法) 稳定 ──────
  const a = join(tmp, "a"), b = join(tmp, "b"), link = join(tmp, "a-link");
  mkdirSync(a); mkdirSync(b); symlinkSync(a, link);
  assert.notEqual(daemonSourceOf(a, "h"), daemonSourceOf(b, "h"), "同 hostname 不同 stateDir 不撞");
  assert.equal(daemonSourceOf(a, "h"), daemonSourceOf(a, "h"), "重启后不变");
  assert.equal(daemonSourceOf(link, "h"), daemonSourceOf(a, "h"), "符号链接与真实路径是同一个实例");
  assert.match(daemonSourceOf(a, "h"), /^h:[0-9a-f]{8}$/);
};

run()
  .then(() => { console.log("ok ports-fallback"); })
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => {
    servers.forEach((s) => s.close());
    rmSync(tmp, { recursive: true, force: true });
  });
