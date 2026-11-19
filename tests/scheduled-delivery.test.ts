import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { deliverScheduled, type ScheduledDispatchOptions } from "../daemon/scheduled-delivery.js";

// 生产适配器 (daemon/index.ts 的 scheduledTaskInject) 按文本切出来跑。room 模型下它只剩
// 两条路 (cutmap G-1): fresh 起白板 runner, 其余落一条 trigger 行 —— 等待 / 重试 / 预算
// 都归 hub 泵, 适配器不再持有队列事实。
const source = readFileSync(new URL("../daemon/index.ts", import.meta.url), "utf8");
const start = source.indexOf("    scheduledTaskInject = async (target, text, opts) => {");
const end = source.indexOf("    /** 到点起一个白板 wizard 执行这一枪, 跑完自动收掉。 */", start);
assert(start >= 0 && end > start, "adapter source markers moved");
const code = ts.transpileModule("let scheduledTaskInject;\n" + source.slice(start, end) + "\nglobalThis.inject=scheduledTaskInject;", {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;

const fired: Array<{ target: string; text: string; ext: string }> = [];
const ran: Array<{ target: string; text: string; taskId: string; quiet: boolean }> = [];
let sameBotValue = true;
const ctx = vm.createContext({
  tasks: { get: () => ({ owner: "user:owner" }) },
  ownerOf: () => "user:owner",
  sameBot: () => sameBotValue,
  fireTaskTrigger: (target: string, text: string, ext: string) => { fired.push({ target, text, ext }); },
  runTaskInRunner: async (target: string, text: string, taskId: string, quiet: boolean) => { ran.push({ target, text, taskId, quiet }); return { ok: true }; },
});
vm.runInContext(code, ctx);
type Inject = (target: string, text: string, opts: Record<string, unknown>) => Promise<{ ok: boolean; reason?: string }>;
const inject = ctx.inject as Inject;

// 已有会话的一枪: 一条 trigger 行, 立即 ok。
assert.equal((await inject("user:owner", "hello", { taskId: "t1", fresh: false, quiet: false })).ok, true);
assert.deepEqual(fired, [{ target: "user:owner", text: "hello", ext: "t1" }]);
assert.deepEqual(ran, [], "non-fresh must not spawn a runner");
// fresh: 交给 runner, quiet 原样带过去。
assert.equal((await inject("user:owner", "hello2", { taskId: "t2", fresh: true, quiet: true })).ok, true);
assert.deepEqual(ran, [{ target: "user:owner", text: "hello2", taskId: "t2", quiet: true }]);
// 跨 bot 拒绝, 不落 trigger 也不起 runner。
sameBotValue = false;
const before = fired.length + ran.length;
const cross = await inject("user:other", "x", { taskId: "t3", fresh: false });
assert.equal(cross.ok, false);
assert.equal(fired.length + ran.length, before);

// deliverScheduled 本体 (模块级): uncertain 不回退也不重试。
const options: ScheduledDispatchOptions = { taskId: "unknown", fresh: false, quiet: true, signal: new AbortController().signal,
  guard: () => true, submit: (f) => f() };
let unknownAttempts = 0;
const unknown = await deliverScheduled(options, {
  postponeMs: 1000, handedOff: async () => {}, idleNow: async () => true, untilIdle: async () => ({ idle: true }),
  named: async () => { unknownAttempts++; return { ok: false, uncertain: true, retryable: true }; },
  runner: async () => { assert.fail("uncertain must not fall back or retry"); },
});
assert.equal(unknown.uncertain, true);
assert.equal(unknownAttempts, 1);
console.log("scheduled delivery: trigger/runner adapter + uncertain fence passed");
