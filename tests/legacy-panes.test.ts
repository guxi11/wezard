// 起于旧控制面的 pane 回收: argv 判据 (纯函数) + 一拍的行为 (空闲才 sleep / 忙的等下一拍 / 不碰无痕迹的)
// 运行: npx tsx tests/legacy-panes.test.ts
import assert from "node:assert/strict";
import { createLegacyPaneReaper, isLegacyCtlArgs, legacyPaneIds, parsePanePids, type ProcRow } from "../daemon/legacy-panes.js";

// ── isLegacyCtlArgs ────────────────────────────────────────
const S = "/home/u/.wezard/state";
assert.equal(isLegacyCtlArgs(`node /x/claude --session-id a --mcp-config ${S}/session-mcp.json --model m`), true, "旧 stdio 产物");
assert.equal(isLegacyCtlArgs(`node /x/claude --resume a --mcp-config ${S}/session-mcp-http.json`), true, "旧 http 产物 (行尾)");
assert.equal(isLegacyCtlArgs(`codebuddy --mcp-config=${S}/session-mcp.json`), true, "--mcp-config=path 写法");
assert.equal(isLegacyCtlArgs(`codex resume sid -c mcp_servers.wezard.command="node" -c mcp_servers.wezard.env.WEZARD_DAEMON_BASE="http://127.0.0.1:17890"`), true, "codex 旧 -c");
assert.equal(isLegacyCtlArgs(`node /x/claude --mcp-config ${S}/session-mcp-sock.json`), false, "新产物不算");
assert.equal(isLegacyCtlArgs(`codex resume sid -c mcp_servers.wezard.env.WEZARD_DAEMON_SOCK="/s/d.sock"`), false, "codex 新 -c 不算");
assert.equal(isLegacyCtlArgs("node /x/claude --resume a"), false, "argv 里没有任何 wezard MCP 痕迹 = 不是这次升级造成的, 不动");
assert.equal(isLegacyCtlArgs(`node /x/claude --mcp-config /home/u/mine/other-mcp.json`), false, "用户自己的 MCP 配置不算");
assert.equal(isLegacyCtlArgs(`grep -r session-mcp.json ${S}`), false, "pane 里随手 grep 的子进程不是 CLI");
assert.equal(isLegacyCtlArgs(`tail -f ${S}/session-mcp.json`), false);
assert.equal(isLegacyCtlArgs(""), false);

// ── parsePanePids ──────────────────────────────────────────
assert.deepEqual(parsePanePids("%1 100\n%12 2048\n\ngarbage\n %3  7 \n"), [{ id: "%1", pid: 100 }, { id: "%12", pid: 2048 }, { id: "%3", pid: 7 }]);
assert.deepEqual(parsePanePids(""), []);

// ── legacyPaneIds: 只看 pane 进程树 ─────────────────────────
//   %1: bash(100) → node claude (旧)         → 回收
//   %2: bash(200) → node claude (新)         → 不动
//   %3: bash(300) → sh → claude (旧, 深一层)  → 回收
//   %4: bash(400) → vim (无痕迹)              → 不动
//   %5: bash(500) 空闲, 别的 pane 里有旧进程   → 不动 (不看全局)
const procs = new Map<number, ProcRow>([
  [100, { ppid: 1, cmd: "bash" }], [101, { ppid: 100, cmd: `node /x/claude --mcp-config ${S}/session-mcp.json` }],
  [200, { ppid: 1, cmd: "bash" }], [201, { ppid: 200, cmd: `node /x/claude --mcp-config ${S}/session-mcp-sock.json` }],
  [300, { ppid: 1, cmd: "bash" }], [301, { ppid: 300, cmd: "sh -c run" }], [302, { ppid: 301, cmd: `node /x/claude --mcp-config ${S}/session-mcp-http.json` }],
  [400, { ppid: 1, cmd: "bash" }], [401, { ppid: 400, cmd: "vim notes.txt" }],
  [500, { ppid: 1, cmd: "bash" }],
]);
const panes = [100, 200, 300, 400, 500].map((pid, i) => ({ id: `%${i + 1}`, pid }));
assert.deepEqual(legacyPaneIds(panes, procs), ["%1", "%3"]);

// ── 一拍的行为 ─────────────────────────────────────────────
const logs: { level: string; obj: any; msg: string }[] = [];
const log: any = { child: () => log };
for (const level of ["debug", "info", "warn", "error"]) log[level] = (obj: any, msg: string) => logs.push({ level, obj, msg });
const bindings = [
  { target: "t1", pane: "%1" }, { target: "t2", pane: "%2" }, { target: "t3", pane: "%3" },
  { target: "t4", pane: "%4" },
];
const busy = new Set<string>(["t1"]);
const slept: string[] = [];
let sleepOk = true;
let tmuxOk = true;
const reaper = createLegacyPaneReaper({
  log,
  listPanes: async () => tmuxOk ? { ok: true, panes } : { ok: false, error: "no server" },
  procs: async () => procs,
  bindings: () => bindings,
  isBusy: async (t) => busy.has(t),
  sleepPane: async (t) => { slept.push(t); return sleepOk ? { ok: true } : { ok: false, reason: "kill-pane failed" }; },
});

// tmux 问不出来: 什么也不做
tmuxOk = false;
assert.deepEqual(await reaper.scan(), { legacy: 0, slept: 0, busy: 0, failed: 0 });
assert.deepEqual(slept, []);
tmuxOk = true;

// 第一拍: t1 忙 (等下一拍), t3 空闲 → sleep; t2 / t4 无旧痕迹不动
let st = await reaper.scan();
assert.deepEqual(st, { legacy: 2, slept: 1, busy: 1, failed: 0 });
assert.deepEqual(slept, ["t3"]);
assert.equal(logs.filter((l) => l.level === "info" && l.obj.target === "t3").length, 1, "每个 pane 一行 info");

// 第二拍: t1 闲下来了 → sleep
busy.clear();
slept.length = 0;
st = await reaper.scan();
assert.deepEqual(slept, ["t1", "t3"], "旧 pane 仍在列表里就仍会被回收 (真实环境 sleep 后 pane 已死)");

// 没绑定的旧 pane 不碰: %1 在 tmux 里, 但 wezard 没有它的绑定
slept.length = 0;
bindings.length = 0;
st = await reaper.scan();
assert.deepEqual(st, { legacy: 0, slept: 0, busy: 0, failed: 0 });
assert.deepEqual(slept, [], "不是 wezard 绑定的 pane 一律不碰");

// sleep 失败: 记 failed, 同一个 pane 只 warn 一次, 下一拍照旧重试
bindings.push({ target: "t1", pane: "%1" });
sleepOk = false;
logs.length = 0;
st = await reaper.scan();
st = await reaper.scan();
assert.equal(st.failed, 1);
assert.equal(logs.filter((l) => l.level === "warn").length, 1, "失败只在状态变化时说一次");
sleepOk = true;
st = await reaper.scan();
assert.equal(st.slept, 1, "恢复后重试成功");

console.log("legacy-panes.test: ok");
