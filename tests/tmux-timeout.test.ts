// 单元测试: daemon/spawn-tmux.ts 的 runTmux 硬超时 — 运行: npx tsx tests/tmux-timeout.test.ts
//
// 为什么值得单独钉住: 2026-07-31 的故障就是「tmux 调用永不返回」——一条企微消息
// 建好 pane 后, dispatch 的 tmuxPaneAlive 再没回来, 该会话的注入队列被这个僵尸
// job 永久占住, 整个 chat 哑掉, 而且日志里一个字都没有。修法是让 runTmux 成为
// daemon 里唯一的 tmux 执行路径并给它一个硬超时。这三件事必须常真:
//   1. 挂住的 tmux 命令到点被 SIGKILL, 以 ok:false 返回 (而不是永远 pending);
//   2. 超时会通知 reporter —— 否则又变成"静默"故障;
//   3. stdin 变体 (load-buffer -, 注入路径在用) 仍然把文本正确喂进去。
// 用真 tmux 而不是 mock: 被测的正是"子进程不返回"这一真实行为, mock 掉就没了。
import assert from "node:assert";
import { runTmux, setTmuxTimeoutReporter } from "../daemon/spawn-tmux.js";

let passed = 0;
let failed = 0;
const t = async (name: string, fn: () => Promise<void>): Promise<void> => {
  try {
    await fn();
    passed++;
    console.log(`ok    ${name}`);
  } catch (e) {
    failed++;
    console.log(`FAIL  ${name}\n      ${(e as Error).message}`);
  }
};

// `tmux wait-for <channel>` 阻塞直到有人 signal 同名 channel —— 一个真实存在、
// 不依赖挂起的 server、也不会有副作用的"永久阻塞的 tmux 命令"。
const BLOCKING = ["wait-for", `wezard-test-${process.pid}`];

const hasTmux = (await runTmux(["-V"], { timeoutMs: 5_000 })).ok;
if (!hasTmux) {
  console.log("skip  本机没有可用的 tmux server —— 跳过 (CI 环境可接受)");
  process.exit(0);
}

await t("正常命令: tmux -V 返回版本, ok=true", async () => {
  const r = await runTmux(["-V"]);
  assert.equal(r.ok, true, `stderr=${r.stderr}`);
  assert.match(r.stdout, /tmux/);
});

await t("挂住的命令: 到点返回 ok=false 而不是永远 pending", async () => {
  const t0 = Date.now();
  const r = await runTmux(BLOCKING, { timeoutMs: 400 });
  const spent = Date.now() - t0;
  assert.equal(r.ok, false, "挂住的命令绝不能报 ok");
  assert.equal(r.code, null, "被 kill 的进程没有正常退出码");
  assert.match(r.stderr, /tmux timeout after 400ms/, `stderr=${r.stderr}`);
  assert.ok(spent < 3_000, `应在超时后立即返回, 实际 ${spent}ms`);
});

await t("超时必须留痕: reporter 收到 args + timeoutMs", async () => {
  const seen: Array<{ args: string[]; timeoutMs: number }> = [];
  setTmuxTimeoutReporter((info) => seen.push(info));
  try {
    await runTmux(BLOCKING, { timeoutMs: 300 });
  } finally {
    setTmuxTimeoutReporter(() => undefined);
  }
  assert.equal(seen.length, 1, "超时恰好上报一次");
  assert.equal(seen[0]!.timeoutMs, 300);
  assert.deepEqual(seen[0]!.args, BLOCKING);
});

await t("正常完成的命令不上报超时", async () => {
  const seen: number[] = [];
  setTmuxTimeoutReporter(() => seen.push(1));
  try {
    await runTmux(["-V"], { timeoutMs: 5_000 });
  } finally {
    setTmuxTimeoutReporter(() => undefined);
  }
  assert.equal(seen.length, 0);
});

await t("stdin 变体: load-buffer - 把文本喂进 tmux buffer (注入路径靠它)", async () => {
  // 注入路径用的是默认 buffer (不带 -b): tmux < 2.0 拒绝自定义 buffer 名, 这里与
  // mirror-bridge 保持同一形式。
  const text = "wezard timeout test 中文 & $pecial";
  const load = await runTmux(["load-buffer", "-"], { stdin: text });
  assert.equal(load.ok, true, `load stderr=${load.stderr}`);
  const show = await runTmux(["show-buffer"]);
  assert.equal(show.ok, true, `show stderr=${show.stderr}`);
  assert.equal(show.stdout.replace(/\n$/, ""), text);
  await runTmux(["delete-buffer"]);
});

await t("timeoutMs=0 关闭超时后, 正常命令照常工作", async () => {
  const r = await runTmux(["-V"], { timeoutMs: 0 });
  assert.equal(r.ok, true, `stderr=${r.stderr}`);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
