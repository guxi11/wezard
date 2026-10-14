// 单元测试: daemon/mirror-bridge.ts 的 paneLiveness 三态判活 —
// 运行: npx tsx tests/pane-liveness.test.ts
//
// 为什么值得单独钉住: 探活以前是布尔 — `display-message` 只要不是「成功且回显同一个
// pane id」就算 pane 死了, 而 tmux server 卡住时它最常见的失败是**超时**。于是 server
// 一打嗝, 所有 pane 都"死"一遍, 每条消息都给会话重生一个 pane: 2026-10-14 实测 7 分钟
// 之内同一个 wizard 被重生 3 次 (22:43 → %656, 22:49 → %660, 22:50 → %661), 每次都用
// `--resume` 起新 pane、作废会话的现有输入队列。修法是让"问不出来"和"真的没了"分开:
// 只有 tmux 明确报「没有这个 pane / 没有 server」才叫 gone, 超时一律 unknown, 调用方
// (injectText / dispatch 的 inject job) 对 unknown 既不贴也不重生。
//
// 超时那一条用**真的** tmux 阻塞命令 (`wait-for`) 而不是手搓的假结果: 被测的正是
// 「子进程挂住 → runTmux 报 timedOut」这条真实链路, mock 掉就只剩自说自话。
import assert from "node:assert";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { runTmux } from "../daemon/spawn-tmux.js";

const source = readFileSync(new URL("../daemon/mirror-bridge.ts", import.meta.url), "utf8");
const start = source.indexOf("type PaneLiveness =");
const end = source.indexOf("/** 沿 ps 快照从某个 pid", start);
assert(start >= 0 && end > start, "paneLiveness 源码段没找到 (改了形状就同步改这个测试)");
const code = ts.transpileModule(`${source.slice(start, end)}\nreturn paneLiveness;`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;
/** 把被测函数的 runTmux 换成给定实现 —— 它就是 paneLiveness 唯一的外部依赖。 */
const withRunTmux = (run: unknown): ((paneId: string) => Promise<string>) =>
  new Function("runTmux", code)(run) as (paneId: string) => Promise<string>;

const result = (r: Partial<{ ok: boolean; stdout: string; stderr: string; code: number | null; timedOut?: boolean }>) =>
  ({ ok: false, stdout: "", stderr: "", code: null, ...r });

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

await t("echo 回同一个 pane id = alive", async () => {
  const probe = withRunTmux(async (args: string[]) => {
    assert.deepEqual(args.slice(0, 2), ["display-message", "-p"]);
    return result({ ok: true, code: 0, stdout: "%7\n" });
  });
  assert.equal(await probe("%7"), "alive");
});

await t("tmux 明说 can't find pane = gone", async () => {
  const probe = withRunTmux(async () => result({ code: 1, stderr: "can't find pane: %7" }));
  assert.equal(await probe("%7"), "gone");
});

await t("server 没了 = gone (它的 pane 当然也没了)", async () => {
  const probe = withRunTmux(async () => result({ code: 1, stderr: "no server running on /tmp/tmux-501/default" }));
  assert.equal(await probe("%7"), "gone");
});

await t("空 pane id = gone, 不起子进程", async () => {
  const probe = withRunTmux(async () => {
    throw new Error("不该问 tmux");
  });
  assert.equal(await probe(""), "gone");
});

await t("回答的不是同一个 pane id = unknown (不敢当它死了)", async () => {
  const probe = withRunTmux(async () => result({ ok: true, code: 0, stdout: "%8\n" }));
  assert.equal(await probe("%7"), "unknown");
});

await t("命令根本没起来 (code null, 无 timedOut) = unknown", async () => {
  const probe = withRunTmux(async () => result({ stderr: "spawn tmux ENOENT" }));
  assert.equal(await probe("%7"), "unknown");
});

await t("真·卡住的 tmux (wait-for + 硬超时) = unknown, 不是 gone", async () => {
  // `tmux wait-for <channel>` 阻塞到有人 signal 同名 channel —— 一个真实存在、不会返回、
  // 也没有副作用的阻塞命令。超时由 runTmux 自己的硬超时给, 结果里必须带 timedOut。
  const channel = `wezard-liveness-${process.pid}`;
  const probe = withRunTmux(async () => runTmux(["wait-for", channel], { timeoutMs: 600 }));
  assert.equal(await probe("%7"), "unknown");
  const direct = await runTmux(["wait-for", channel], { timeoutMs: 600 });
  assert.equal(direct.timedOut, true, "runTmux 的超时路径必须标 timedOut — 探活就靠它");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
