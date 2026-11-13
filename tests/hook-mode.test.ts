import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { hookModePath, readHookMode, writeHookMode } from "../shared/hook-mode.js";

// 预期行为:
//  - 开关文件 / 环境变量 = cli  → hook exit 0 且 stdout 为空 (不给 CLI 任何 decision)
//  - daemon 不可达                  → 同上 (交还本地 CLI), 不是以前的 auto-allow
//  - daemon 正常                     → 还原先那张卡的裁决
//  - 没有归属标记 (人自己开的会话)   → 同上, 且一个请求都不发给 daemon
//    (hook 在全机注册, 只有 wezard spawn 的进程带 WEZARD_MANAGED=1)
const root = mkdtempSync(join(tmpdir(), "wezard-hook-mode-"));
const stateDir = join(root, "state");
const script = join(process.cwd(), "hooks", "pre-tool-use.sh");
const payload = JSON.stringify({ session_id: "s1", tool_name: "Bash", tool_input: { command: "echo hi" }, cwd: process.cwd(), permission_mode: "default" });

const run = (env: Record<string, string>, body: string = payload) => spawnSync("bash", [script], {
  input: body,
  encoding: "utf8",
  // WEZARD_MANAGED=1: 这些用例测的是「wezard 自己的会话」这条路径; TMUX_PANE 清空,
  // 让归属闸门不去查当前 shell 所在 pane 的 pane option。
  env: { ...process.env, WEZARD_MANAGED: "1", TMUX_PANE: "", WEZARD_STATE_DIR: stateDir, WEZARD_RESUME_WAIT: "2", ...env },
  timeout: 30_000,
});

try {
  // 纯读写: 默认 wecom = 文件不存在, cli = 存在; 切回来就把文件删掉。
  assert.equal(readHookMode(stateDir), "wecom");
  writeHookMode(stateDir, "cli");
  assert.equal(readFileSync(hookModePath(stateDir), "utf8").trim(), "cli");
  assert.equal(readHookMode(stateDir), "cli");
  writeHookMode(stateDir, "wecom");
  assert.equal(existsSync(hookModePath(stateDir)), false);

  // 开关文件 = cli: 不请示 daemon, 不输出任何东西。
  writeHookMode(stateDir, "cli");
  const off = run({});
  assert.equal(off.status, 0);
  assert.equal(off.stdout.trim(), "");
  writeHookMode(stateDir, "wecom");

  // cli 模式下权限模式档案照样落盘: 切回 wecom 时子代理按它对齐父会话, 停在旧档
  // (比如已经取消的 bypass) 才是「cli 模式影响了模式切换」。
  writeHookMode(stateDir, "cli");
  const bypassPayload = JSON.stringify({ session_id: "s1", tool_name: "Bash", tool_input: { command: "echo hi" }, cwd: process.cwd(), permission_mode: "bypassPermissions" });
  const bypassRun = run({}, bypassPayload);
  assert.equal(bypassRun.status, 0);
  assert.equal(bypassRun.stdout.trim(), "", "cli mode must not emit allow even in bypass");
  assert.equal(readFileSync(join(stateDir, "modes", "s1"), "utf8").trim(), "bypassPermissions");
  writeHookMode(stateDir, "wecom");

  // 环境变量胜过文件 (便于测试和临时绕过)。
  const envOff = run({ WEZARD_HOOK_MODE: "cli" });
  assert.equal(envOff.status, 0);
  assert.equal(envOff.stdout.trim(), "");

  // daemon 不可达 (端口没人听): 不给 decision。这是本次改动的核心 ——
  // 从前这里回 allow, pane 里的东西会静默拿到任何权限。
  const down = run({ WEZARD_DAEMON_URL: "http://127.0.0.1:9/approve" });
  assert.equal(down.status, 0);
  assert.equal(down.stdout.trim(), "", `daemon down must not answer, got: ${down.stdout}`);

  // daemon 正常: 裁决照旧传回。假 daemon 必须另起进程 —— spawnSync 会挡住本进程的
  // 事件循环, 同进程的 http server 永远回不了包 (只会看着 hook 超时)。
  const fake = spawn(process.execPath, ["-e", [
    'const http = require("node:http");',
    'let n = 0;',
    'const s = http.createServer((req, res) => { n++; console.log("REQ " + n); req.resume(); req.on("end", () => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ decision: "allow", reason: "test" })); }); });',
    's.listen(0, "127.0.0.1", () => console.log("PORT " + s.address().port));',
  ].join("\n")], { stdio: ["ignore", "pipe", "inherit"] });
  try {
    let fakeOut = "";
    const port = await new Promise<string>((ok) => fake.stdout!.on("data", (d) => {
      fakeOut += String(d);
      const m = /PORT (\d+)/.exec(fakeOut);
      if (m) ok(m[1]!);
    }));
    const url = `http://127.0.0.1:${port}/approve`;
    const up = run({ WEZARD_DAEMON_URL: url });
    assert.equal(up.status, 0, up.stderr);
    assert.match(up.stdout, /"permissionDecision":"allow"/);
    assert.match(up.stdout, /wezard: test/);

    // 没有归属标记 = 人自己开的会话: 同一台「会回 allow」的假 daemon 在听, 但
    // hook 必须一个请求都不发、零输出 (回了 allow 就等于替别人的会话放权)。
    const foreign = run({ WEZARD_DAEMON_URL: url, WEZARD_MANAGED: "" });
    assert.equal(foreign.status, 0, foreign.stderr);
    assert.equal(foreign.stdout.trim(), "", `unmanaged session must stay silent, got: ${foreign.stdout}`);
    // 子进程的 stdout 是异步到的: 给它一拍再数。
    const hits = async (n: number): Promise<boolean> => {
      for (let i = 0; i < 60; i++) {
        if ((fakeOut.match(/REQ /g) ?? []).length >= n) return true;
        await new Promise((r) => setTimeout(r, 50));
      }
      return false;
    };
    assert.ok(await hits(1), "managed session must reach the daemon");
    assert.equal((fakeOut.match(/REQ /g) ?? []).length, 1, "unmanaged session must not reach the daemon");
  } finally { fake.kill(); }

  console.log("hook-mode.test: ok");
} finally {
  rmSync(root, { recursive: true, force: true });
}
