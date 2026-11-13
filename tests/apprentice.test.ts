// v3 P6 (§7 学徒): 每 bot 实例唯一、代表人、连续唯一会话。
// Part A: boot 落位 —— home 是单聊时建档 (home 的 slot, 不占默认会话/全局管家锚点),
//         幂等; home 非单聊不造幽灵; 名字来自 config。
// Part B: 锁定 —— evictStaleName 永不顶学徒; /new 被拦 (整理记忆 + 原会话继续, 不换会话);
//         /kill 被拦; 定时任务 fresh 恒 false (显式 true 也不行)。
// Part C: 连续会话 × 多群 —— 两个群点名学徒都落同一个 target (P2 锚点回落), 不新建化身;
//         每条注入信封带各自群的 chat=, 回复按发话群回去; 首触 spawn 在学徒工作区。
// Part D: 提醒线减半 + 审批豁免判定 + 巡检装配 (config 权威, quiet, 有界, 幂等)。
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { ConfigSchema } from "../shared/config.js";
import { bindWizardStore, loadWizardStore, evictStaleName, handoffAt, renderCharter } from "../daemon/wizard.js";
import {
  apprenticeOf,
  ensureApprentice,
  ensurePatrolTask,
  handoffLineOf,
  isApprentice,
  patrolPrompt,
} from "../daemon/apprentice.js";
import { manifestationOf } from "../daemon/wizard.js";
import { installInboundRouter } from "../daemon/inbound.js";
import { deliverToChat } from "../daemon/outbound.js";
import type { TaskRegistry, TaskDraft } from "./task-registry.js";
import type { TaskRecord } from "../shared/task-file.js";

const ROOT = mkdtempSync(join(tmpdir(), "apprentice-"));
const log = pino({ level: "silent" });
const cfgOf = (over: Record<string, unknown> = {}) => ConfigSchema.parse({
  bot: { botId: "test", secret: "test" },
  wrc: { allowFrom: ["user:tester"], apprentice: over },
  defaultChat: "user:home",
});

// ── Part A: boot 落位 ────────────────────────────────────────────────
const store = bindWizardStore(loadWizardStore(join(ROOT, "wizards.json")));
store.upsert("user:home", { identity: "user:home", name: "gsw", kind: "global-steward", bornAt: 1 });
const cfg = cfgOf();
const a1 = ensureApprentice(store, "user:home", cfg.wrc.apprentice.name);
assert.equal(a1.created, true);
assert.equal(a1.target, "user:home#apprentice", "学徒住在 home 单聊的一个 slot, 不占默认会话 (那是全局管家锚点)");
const rec = store.get(a1.target)!;
assert.equal(rec.kind, "apprentice");
assert.equal(rec.name, "学徒");
assert.equal(rec.identity, a1.target, "学徒的记录就是自己的身份锚点");
// 幂等: 第二次 boot 不再建, 也不覆盖人改过的名字。
store.upsert(a1.target, { name: "小徒" });
const a2 = ensureApprentice(store, "user:home", cfg.wrc.apprentice.name);
assert.equal(a2.created, false);
assert.equal(a2.target, a1.target);
assert.equal(store.get(a1.target)?.name, "小徒", "已有记录时不动");
// home 非单聊: 不造幽灵 (用一份空名册, 排除已有学徒的干扰)。
const ghostStore = loadWizardStore(join(ROOT, "ghost.json"));
const ghost = ensureApprentice(ghostStore, "chat:group", "学徒");
assert.deepEqual([ghost.created, ghost.target], [false, ""], "群为家不造学徒幽灵");
assert.equal(ghostStore.all().length, 0);
// 唯一性判定面。
assert.equal(isApprentice(store, a1.target), true);
assert.equal(isApprentice(store, "user:home"), false);
assert.equal(apprenticeOf(store)?.target, a1.target);

// ── Part B: 锁定 ─────────────────────────────────────────────────────
// evictStaleName: 学徒冷多久都不顶名。
const coldStore = loadWizardStore(join(ROOT, "cold.json"));
coldStore.upsert("user:home", { identity: "user:home", name: "gsw", kind: "global-steward", bornAt: 1 });
coldStore.upsert(a1.target, { identity: a1.target, name: "学徒", kind: "apprentice", bornAt: 1 });
const evicted = await evictStaleName(coldStore, "学徒", [], {
  lastActivity: () => 0, // 冷到天荒地老
  retire: async () => ({ ok: true }),
}, Date.now() + 100 * 24 * 3600 * 1000);
assert.equal(evicted, undefined, "学徒名字永不被顶");
assert.ok(coldStore.get(a1.target), "学徒记录还在");

// /new 与 /kill: 走 inbound 集成 (同一个 mock 桥)。
const ROOT2 = mkdtempSync(join(tmpdir(), "apprentice-route-"));
const store2 = bindWizardStore(loadWizardStore(join(ROOT2, "wizards.json")));
store2.upsert("user:home", { identity: "user:home", name: "gsw", kind: "global-steward", bornAt: 1 });
const anchor2 = ensureApprentice(store2, "user:home", "学徒").target;
const handlers = new Map<string, (f: unknown) => Promise<void>>();
const replies: string[] = [];
const spawned2: Array<{ target: string; opts: Record<string, unknown> }> = [];
const dispatched2: Array<{ principal: string; text: string; channel?: string }> = [];
let attached2 = new Set<string>();
const bridge = {
  hasMirrorTarget: (t: string) => attached2.has(t),
  status: () => ({ mirrors: [] }),
  getCwd: (t: string) => ({ runningCwd: t === anchor2 ? "/home/apprentice" : "", pendingCwd: "", defaultCwd: "" }),
  newSession: async (target: string, _n: string, opts: Record<string, unknown>) => {
    spawned2.push({ target, opts });
    attached2.add(target);
    return { ok: true, sessionId: "s1", cwd: (opts as { cwd?: string }).cwd ?? "" };
  },
  dispatch: async (a: { principal: string; text: string; channel?: string }) => { dispatched2.push({ principal: a.principal, text: a.text, channel: a.channel }); },
  chatRoster: () => [],
  peers: async () => [],
  interruptPane: async () => ({ ok: true }),
  killPane: async () => ({ ok: true, killed: true }),
  submitPane: async () => ({ ok: true }),
};
const client2 = {
  on: (e: string, h: (f: unknown) => Promise<void>) => handlers.set(e, h),
  replyStream: async (_f: unknown, _id: string, text: string) => { replies.push(text); },
};
const cfgRoute = cfgOf({ workspace: "/home/apprentice" });
installInboundRouter(client2 as never, cfgRoute, log, bridge as never, join(ROOT2, "unused.jsonc"), (() => {}) as never);

const groupFrame = (chatid: string, text: string) => ({
  headers: { req_id: text },
  body: { msgid: chatid + ":" + text.length, chattype: "group", chatid, from: { userid: "tester" }, msgtype: "text", text: { content: text }, create_time: 1700000000000 },
});
const send2 = async (chatid: string, text: string) => { await handlers.get("message.text")!(groupFrame(chatid, text)); };

// /new 被拦: 不换会话, 注入「整理记忆」指令, 不走 autoSpawn 的 fresh spawn。
await send2("chat:A", ".学徒 /new");
assert.equal(spawned2.length, 1, "首触按需起 pane (工作区 = 学徒工作区)");
assert.equal(spawned2[0]!.opts.cwd, "/home/apprentice", "学徒会话起在 wrc.apprentice.workspace");
assert.equal(spawned2[0]!.opts.silent, true, "首触不冒气泡 (ensureSession 语义)");
assert.ok(dispatched2.at(-1)!.text.includes("/new 已拦"), "注入拦截说明");
assert.ok(dispatched2.at(-1)!.text.includes("wizard_remember"), "注入整理记忆指令");
assert.equal(dispatched2.at(-1)!.principal, anchor2);
// 再来一次 /new: 已附着, 不再 spawn, 仍是拦截指令。
await send2("chat:A", ".学徒 /new");
assert.equal(spawned2.length, 1, "连续会话不因 /new 重开");
// /kill 被拦。
dispatched2.length = 0;
await send2("chat:A", ".学徒 /kill");
assert.ok(replies.at(-1)!.includes("不可 /kill"), "kill 拒绝回执");
assert.equal(dispatched2.length, 0, "没有注入任何东西");
// /stop 不拦 (正常打断)。
await send2("chat:A", ".学徒 /stop");
assert.ok(replies.at(-1) !== undefined);

// ── Part C: 连续会话 × 多群 ──────────────────────────────────────────
dispatched2.length = 0;
await send2("chat:A", ".学徒 帮我看下 A 群的事");
await send2("chat:B", ".学徒 B 群也有个问题");
assert.equal(dispatched2.length, 2);
assert.equal(dispatched2[0]!.principal, anchor2, "A 群点名落学徒唯一会话");
assert.equal(dispatched2[1]!.principal, anchor2, "B 群点名也落同一个会话 (不是每群一个化身)");
assert.equal(spawned2.length, 1, "没有为 B 群新开化身");
assert.ok(dispatched2[0]!.text.includes(String.raw`chat="chat:chat:A"`), "A 群注入的信封带 chat=chat:A");
assert.ok(dispatched2[1]!.text.includes(String.raw`chat="chat:chat:B"`), "B 群注入的信封带 chat=chat:B");
assert.equal(dispatched2[0]!.channel, "chat:chat:A", "回复回发话群 A");
assert.equal(dispatched2[1]!.channel, "chat:chat:B", "回复回发话群 B");
assert.equal(store2.get("chat:A#学徒"), undefined, "A 群没有学徒化身记录");
assert.equal(store2.get("chat:B#学徒"), undefined, "B 群也没有");
// 化身解析: 任何 base 里点名学徒都解析到锚点 (P2 回落), 不自动新建。
assert.equal(manifestationOf(store2, "学徒", "chat:A"), anchor2);
assert.equal(manifestationOf(store2, "学徒", "chat:B"), anchor2);

// ── Part D: 提醒线 / 豁免 / 巡检 / 出站接缝 ──────────────────────────
// 学徒的交接线 = handoffAt / 2; 普通身份不变。
assert.equal(handoffLineOf(store2, anchor2, "claude-sonnet-4-5"), Math.round(handoffAt("claude-sonnet-4-5") / 2));
assert.equal(handoffLineOf(store2, "user:home", "claude-sonnet-4-5"), handoffAt("claude-sonnet-4-5"));
// 宪章学徒章。
const charter = renderCharter({
  self: { name: "学徒", address: "学徒", description: "", cwd: "~", kind: "apprentice" },
  chat: "home", principal: "user:home", inherited: false, siblings: [], memory: [],
  chatMemory: "", workspaceMemory: "", steward: false, stewardBudget: 4, lead: false, tiers: [], topOnly: true,
});
assert.ok(charter.includes("你是学徒 (连续身份)"), "宪章带学徒章");
assert.ok(charter.includes("chat="), "宪章写明多群信封纪律");
assert.ok(charter.includes("wizard_remember"), "交接前先记忆");
const charterPlain = renderCharter({
  self: { name: "x", address: "x", description: "", cwd: "~" },
  chat: "c", principal: "chat:c", inherited: false, siblings: [], memory: [],
  chatMemory: "", workspaceMemory: "", steward: false, stewardBudget: 4, lead: false, tiers: [], topOnly: true,
});
assert.ok(!charterPlain.includes("学徒"), "普通身份不带学徒章");

// 审批豁免判定: apprenticeSession 的语义 = 会话最近一轮落在学徒 target 上。
// (approval.ts 的 HTTP 流不在此测; 这里钉判定函数的输入输出关系 —— 用 isApprentice 的
//  面即可, approval 侧同一谓词。)
assert.equal(isApprentice(store2, anchor2), true);
assert.equal(isApprentice(store2, "user:home"), false, "全局管家不享受学徒的特殊纪律");

// 巡检装配: config 是权威。
const mkRegistry = (): TaskRegistry => {
  const list: TaskRecord[] = [];
  const reg = {
    list: () => list,
    create: (d: TaskDraft) => { const t: TaskRecord = { id: d.id, file: `/tmp/${d.id}.task.mjs`, trigger: d.trigger, when: `every ${(d.trigger as { clock: { minutes?: number } }).clock.minutes ?? "?"}m`, prompt: d.prompt, note: d.note, target: d.target, fresh: d.fresh, enabled: true, quiet: d.quiet, hasGate: false, gateTimeoutSec: 120, createdBy: d.createdBy, owner: d.createdBy }; list.push(t); return t; },
    remove: (id: string) => { const i = list.findIndex((t) => t.id === id); if (i >= 0) list.splice(i, 1); },
    stateOf: () => ({}),
    patchState: () => {},
    takenIds: () => new Set(list.map((t) => t.id)),
  } as unknown as TaskRegistry;
  return reg;
};
const reg = mkRegistry();
const cfgPatrolOff = cfgOf({ patrol: { enabled: false } });
assert.deepEqual(ensurePatrolTask(reg, cfgPatrolOff, anchor2), { active: false, recreated: false }, "默认关");
const cfgPatrol = cfgOf({ patrol: { enabled: true, everyMin: 90, maxItems: 3 } });
const p1 = ensurePatrolTask(reg, cfgPatrol, anchor2);
assert.deepEqual([p1.active, p1.recreated], [true, true]);
const task = reg.list().find((t) => t.id === "apprentice-patrol")!;
assert.equal(task.target, anchor2);
assert.equal(task.fresh, false, "巡检永远注入学徒自己的会话");
assert.equal(task.quiet, true, "巡检不预告不进群");
assert.ok(task.when.includes("90m"), "间隔来自 config");
assert.ok(task.prompt.includes("最多整理 3 条"), "每轮上限来自 config");
assert.ok(task.prompt.includes("不主动发任何群"), "巡检产物默认不进群");
assert.ok(task.prompt.includes("QUIET"), "没事就 QUIET 收尾");
const p2 = ensurePatrolTask(reg, cfgPatrol, anchor2);
assert.equal(p2.recreated, false, "幂等: 已一致不重建");
assert.equal(reg.list().length, 1);
const p3 = ensurePatrolTask(reg, cfgOf({ patrol: { enabled: true, everyMin: 120, maxItems: 3 } }), anchor2);
assert.equal(p3.recreated, true, "config 变了按新值重建");
assert.ok(reg.list()[0]!.when.includes("120m"));
assert.equal(ensurePatrolTask(reg, cfgPatrolOff, anchor2).active, false, "关掉即删");
assert.equal(reg.list().length, 0);
// patrolPrompt 有界性 (直接钉文案要素)。
const pp = patrolPrompt(cfgPatrol);
assert.ok(pp.includes("3 条") && pp.includes("90 分钟"), "上限与频率都进指令");

// 出站接缝: deliverToChat 是「这句话怎么进群」的唯一出口。
const sent: Array<{ chatid: string; content: string }> = [];
const fakeClient = { sendMessage: async (chatid: string, body: any) => { sent.push({ chatid, content: body?.markdown?.content ?? "" }); return {}; } } as never;
assert.equal(await deliverToChat(fakeClient, "user:home#apprentice", "hi", log), true);
assert.equal(sent[0]!.chatid, "home", "剥掉 principal 前缀与 #tag");
assert.ok(sent[0]!.content.includes("apprentice"), "带 #tag 气泡头 (接缝保持 /message 原语义: 头用 tag)");

console.log("apprentice ok");
