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
const root = mkdtempSync(join(tmpdir(), "wezard-hook-mode-"));
const stateDir = join(root, "state");
const script = join(process.cwd(), "hooks", "pre-tool-use.sh");
const payload = JSON.stringify({ session_id: "s1", tool_name: "Bash", tool_input: { command: "echo hi" }, cwd: process.cwd(), permission_mode: "default" });

const run = (env: Record<string, string>, body: string = payload) => spawnSync("bash", [script], {
  input: body,
  encoding: "utf8",
  env: { ...process.env, WEZARD_STATE_DIR: stateDir, WEZARD_RESUME_WAIT: "2", ...env },
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
    'const s = http.createServer((req, res) => { req.resume(); req.on("end", () => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ decision: "allow", reason: "test" })); }); });',
    's.listen(0, "127.0.0.1", () => console.log(s.address().port));',
  ].join("\n")], { stdio: ["ignore", "pipe", "inherit"] });
  try {
    const port = await new Promise<string>((ok) => fake.stdout!.once("data", (d) => ok(String(d).trim())));
    const up = run({ WEZARD_DAEMON_URL: `http://127.0.0.1:${port}/approve` });
    assert.equal(up.status, 0, up.stderr);
    assert.match(up.stdout, /"permissionDecision":"allow"/);
    assert.match(up.stdout, /wezard: test/);
  } finally { fake.kill(); }

  console.log("hook-mode.test: ok");
} finally {
  rmSync(root, { recursive: true, force: true });
}
