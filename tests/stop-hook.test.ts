// hooks/stop.sh 端到端: 只把 daemon 回的完整 block 原样交给 CLI; 非 wezard 会话 / daemon 连不上 / 回包坏 → 零输出。
// 运行: npx tsx tests/stop-hook.test.ts  (需要 bash / jq / curl)
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { resolve } from "node:path";

const script = resolve(import.meta.dirname, "..", "hooks", "stop.sh");
let reply = "{}";
let seen: unknown;
const server = createServer((req, res) => {
  let b = "";
  req.on("data", (c) => (b += c));
  req.on("end", () => { seen = { url: req.url, body: JSON.parse(b) }; res.setHeader("content-type", "application/json"); res.end(reply); });
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const port = (server.address() as { port: number }).port;
const run = (env: Record<string, string>, input = JSON.stringify({ session_id: "s1", stop_hook_active: false })) =>
  new Promise<{ out: string; code: number | null }>((done) => {
    // 异步跑: 同进程的 server 要能应答
    const p = spawn("bash", [script], { env: { PATH: process.env.PATH!, TMUX_PANE: "%9", ...env } });
    let out = "";
    p.stdout.on("data", (c: Buffer) => (out += c));
    p.on("close", (code) => done({ out, code }));
    p.stdin.end(input);
  });
const env = { WEZARD_MANAGED: "1", WEZARD_DAEMON_URL: `http://127.0.0.1:${port}/approve` };

assert.equal(spawnSync("bash", ["-n", script]).status, 0, "语法");
reply = JSON.stringify({ decision: "block", reason: "[wezard] 先 chat_reply x.1" });
let r = await run(env);
assert.equal(r.code, 0);
assert.deepEqual(JSON.parse(r.out), { decision: "block", reason: "[wezard] 先 chat_reply x.1" });
assert.deepEqual(seen, { url: "/room/stop-check", body: { sessionId: "s1", tmuxPane: "%9", stopHookActive: false } });
reply = "{}";
r = await run(env);
assert.equal(r.out, "", "无欠账 → 零输出");
reply = "<html>proxy</html>";
r = await run(env);
assert.equal(r.out, "", "回包坏 → 零输出");
reply = JSON.stringify({ decision: "block", reason: "x" });
r = await run({ WEZARD_DAEMON_URL: env.WEZARD_DAEMON_URL });
assert.equal(r.out, "", "非 wezard 会话 → 零输出, 不碰 daemon");
server.close();
r = await run(env);
assert.equal(r.out, "", "daemon 连不上 → 零输出 (照常结束)");
assert.equal(r.code, 0);
console.log("stop-hook ok");
