import assert from "node:assert/strict";
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import pino from "pino";
import { ConfigSchema } from "../shared/config.js";
import { chatPolicyOf } from "../daemon/chat-name.js";
import { splitMarkdown } from "../shared/md-chunk.js";
import { parseTagHeader } from "../shared/session-label.js";
import { finalId } from "../daemon/message-events.js";

// P7-S2 判据①⑨ (出站门夹具, 宅内既定的闭包抽取模式 —— 同 pane-delivery / slash-replies):
// 从 mirror-bridge 抽出真实的生产闭包 (strict 判定 / CoT / standalone / 终句收口 /
// 流式帧 / hardTimer / pushProjectInfo), 用假 client 数出站。
//   ① 50 轮混合夹具: strict 群发自终句/流式/CoT/standalone 的出站 = 0;
//      同一夹具在 implicit 群各路径出站 > 0 (证明夹具真的在打这些路径, 0 不是空转)。
//   ⑨ 占位 ack 的代码路径 (门 + ack 调用, 不含网络/CLI) p95 ≤ 1.5s。

const source = readFileSync("daemon/mirror-bridge.ts", "utf8");
const transpile = (s: string): string => ts.transpileModule(s, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;
const closure = (begin: string, end: string): string => {
  const start = source.indexOf(begin);
  const stop = source.indexOf(end, start);
  assert(start >= 0 && stop > start, "missing closure " + begin.slice(0, 40));
  return source.slice(start, stop);
};

// ── 切片 ──
const strictBlock = closure("  // ── P7-S2 严格群出站门", "  const formatFinal =");
const cotBlock = closure("  const receiptProgress =", "  // 链接落到 chat 视图");
const armBlock = closure("  const armBriefBubble =", "  const newTurnId");
const standaloneBlock = closure("  const sendStandalone =", "  // Like sendStandalone but skips");
const concludeBlock = closure("  const concludeBriefTurn =", "  /** 收口一个 turn");
const streamBlock = closure("  const flushStream =", "  const openStream");
const projectBlock = closure("  const pushProjectInfo =", "  // Cwd is CHAT-SCOPED");

const STRICT_CHAT = "chat:wrStrict";
// P7-S3: strictBase 不再内联直读 cfg.chatPolicy, 走 chatPolicyOf (含 chat-seen 缺省判定)
// —— stateDir 必须隔离, 否则会扫真机的 known-chats.json。
const cfgOf = (speech: string) => ConfigSchema.parse({
  bot: { botId: "t", secret: "t" },
  daemon: { stateDir: mkdtempSync(join(tmpdir(), "strict-outbound-")) },
  chatPolicy: { [STRICT_CHAT]: { speech } },
  wrc: { mirror: { brief: true } },
});
const baseOfKey = (t: string): string => t.split("#")[0]!;

// 出站计数器: 只数「模型的发言」, 占位/系统行单列。
type Sent = { kind: string; text: string; at: number };
const mkClient = () => {
  const sent: Sent[] = [];
  return {
    sent,
    replyStream: async (_f: unknown, _id: string, text: string, finish?: boolean) => {
      sent.push({ kind: "stream" + (finish ? ":final" : ""), text, at: performance.now() });
    },
    replyStreamWithCard: async (_f: unknown, _id: string, text: string, _fin: boolean, _c: unknown) => {
      sent.push({ kind: "stream:card", text, at: performance.now() });
    },
    sendMessage: async (chatId: string, body: { markdown: { content: string } }) => {
      sent.push({ kind: "message:" + chatId, text: body.markdown.content, at: performance.now() });
    },
  };
};

const build = (speech: "strict" | "implicit") => {
  const cfg = cfgOf(speech);
  const client = mkClient();
  const log = pino({ level: "silent" });
  const events = {
    get: (_id: string) => undefined,
    result: (..._a: unknown[]) => undefined,
    delivery: (..._a: unknown[]) => "x",
  };
  const deps = { events: events as never, cfg, log, client } as never;
  const eventOwned = () => true;
  const eventFinalGate = () => true;
  const eventProgressGate = () => false;
  const eventOwnerGate = () => true;
  const isPrivate = (a: { channel?: string }) => a.channel === "";
  const mkStrict = new Function("cfg", "baseOfKey", "isPrivate", "eventOwned", "chatPolicyOf",
    transpile(strictBlock + "\nreturn { strictBase, strictOf, strictChat, turnSilent };"))(
    cfg, baseOfKey, isPrivate, eventOwned, chatPolicyOf) as {
    strictBase: (b: string) => boolean; strictOf: (c: string | undefined, t: string) => boolean;
    strictChat: (a: { channel?: string; target: string; activeEventId?: string }) => boolean;
    turnSilent: (a: { channel?: string; target: string; activeEventId?: string; turnFromChat?: boolean }) => boolean;
  };
  const hasVisibleBody = (content: string): boolean => parseTagHeader(content).body.length > 0;
  const TAG_HEADER_BUDGET = 1024;
  const withLinkedTag = (_a: unknown, content: string) => content;
  const replyChatId = (a: { channel?: string; target: string }) => (a.channel || a.target).replace(/^(user|chat|group):/, "");
  const sendStandalone = new Function("hasVisibleBody", "eventOwned", "isPrivate", "strictChat", "splitMarkdown",
    "TAG_HEADER_BUDGET", "cfg", "withLinkedTag", "replyChatId", "client", "log",
    transpile(standaloneBlock + "\nreturn sendStandalone;"))(
    hasVisibleBody, eventOwned, isPrivate, mkStrict.strictChat, splitMarkdown, TAG_HEADER_BUDGET, cfg,
    withLinkedTag, replyChatId, client, log) as (a: { channel?: string; target: string; activeEventId?: string; sessionId: string }, content: string, stillWanted?: () => boolean) => void;
  const briefLine = (_a: unknown, _turnId: string, rest: string) => rest || "…";
  const clearCot = (a: { cotTimer?: unknown }): void => { a.cotTimer = undefined; };
  const cotFns = new Function("deps", "eventOwnerGate", "eventProgressGate", "strictChat", "client", "briefLine", "log", "clearCot",
    "bubbleOwned", "receiptQuiet", "cotLine", "COT_FLUSH_MS",
    transpile(cotBlock + "\nreturn { flushCot, updateBriefProgress, updateBriefToolProgress };"))(
    deps, eventOwnerGate, eventProgressGate, mkStrict.strictChat, client, briefLine, log, clearCot,
    () => true, () => false, (s: string) => s.replace(/\s+/g, " ").trim().slice(0, 100) + "…", 1500) as {
    flushCot: (a: never) => Promise<void>;
    updateBriefProgress: (a: never, raw: string) => void;
    updateBriefToolProgress: (a: never, raw: string) => void;
  };
  const isWxFrame = () => false;
  const finishBubbleCalls: string[] = [];
  const bubbleOwned = () => true;
  const armBriefBubble = new Function("isWxFrame", "finishBubble", "briefLine", "strictChat", "bubbleOwned", "STILL_WORKING", "clearTimeout", "setTimeout",
    transpile(armBlock + "\nreturn armBriefBubble;"))(
    isWxFrame, async (_a: unknown, _b: unknown, content: string) => { finishBubbleCalls.push(content); return undefined; },
    briefLine, mkStrict.strictChat, bubbleOwned, "⏳ 仍在处理中…", clearTimeout, setTimeout) as never;
  let queueFinalCalls = 0;
  let recoverEventFinalCalls = 0;
  let recordCloseOpenTurnsCalls = 0;
  const finalProgress = new Map<string, Promise<unknown>>();
  const concludeBriefTurn = new Function("strictChat", "isDuplicateConclusion", "deps", "finalId", "log", "clearCot",
    "recordCloseOpenTurns", "eventFinalGate", "eventProgressGate", "turnSilent", "recoverEventFinal", "queueFinal",
    "baseOfKey", "stripForChat", "finalProgress", "formatFinal",
    transpile(concludeBlock + "\nreturn concludeBriefTurn;"))(
    mkStrict.strictChat, () => false, deps, finalId, log, clearCot,
    () => { recordCloseOpenTurnsCalls++; }, eventFinalGate, eventProgressGate, mkStrict.turnSilent,
    () => { recoverEventFinalCalls++; }, () => { queueFinalCalls++; return "f1"; },
    baseOfKey, (t: string) => t, finalProgress, (_t: string, _tu: string, _c: string, b: string) => [b]) as never;
  const streamFns = new Function("strictOf", "eventOwned", "client", "withLinkedTag", "log", "clearTimeout", "setTimeout", "STILL_WORKING",
    "closeSubagentTurns", "detailCardFor", "turnRegistry", "evictTurns", "byTarget", "FLUSH_MS",
    transpile(streamBlock + "\nreturn { flushStream, finalizeStream };"))(
    mkStrict.strictOf, eventOwned, client, withLinkedTag, log, clearTimeout, setTimeout, "⏳ 仍在处理中…",
    () => {}, () => undefined, { set: () => undefined }, () => undefined, new Map(), 50) as {
    flushStream: (s: never) => Promise<void>;
    finalizeStream: (a: never, s: never, timedOut?: boolean) => Promise<void>;
  };
  const pushProjectInfo = new Function("strictBase", "baseOfKey", "sendStandalone", "stripPrincipalPrefix", "client", "withTagHeader", "log", "byTarget",
    transpile(projectBlock + "\nreturn pushProjectInfo;"))(
    mkStrict.strictBase, baseOfKey, sendStandalone, (k: string) => k.replace(/^user:/, ""),
    client, (_k: string, t: string) => t, log, new Map()) as (target: string, header?: string) => void;
  return {
    cfg, client, mkStrict, sendStandalone, cotFns, armBriefBubble, concludeBriefTurn, streamFns, pushProjectInfo,
    counts: () => ({ queueFinal: queueFinalCalls, recoverEventFinal: recoverEventFinalCalls, recordCloseOpenTurns: recordCloseOpenTurnsCalls }),
    finishBubbleCalls,
  };
};

// ── ① 五十轮混合夹具 ──
const runRounds = async (speech: "strict" | "implicit") => {
  const b = build(speech);
  const a = { target: "chat:wrStrict#w1", sessionId: "s1", channel: STRICT_CHAT, activeEventId: undefined as string | undefined,
    standalonePending: Promise.resolve(), liveStream: undefined as unknown, briefBubble: { done: true, owner: "e", pending: Promise.resolve(), hardTimer: undefined, frame: {}, streamId: "s", expires: Date.now() + 350_000 } as never,
    cotText: undefined as string | undefined, cotTool: undefined as string | undefined, cotTimer: undefined as unknown,
    briefLastText: undefined as string | undefined, queryEpoch: 0, briefHadTool: false, briefIsSlash: false };
  const roundStart = performance.now();
  const acks: number[] = [];
  const bubbles: Array<{ hardTimer?: unknown }> = [];
  for (let i = 0; i < 50; i++) {
    const t0 = performance.now();
    a.briefTurnId = "t" + i;
    a.briefConcluded = false;
    (a as { briefBubble?: { done: boolean } }).briefBubble!.done = false;
    // 占位 (armBriefBubble — 真实路径里 ack 后的 hardTimer 武装)
    const bubbleI = { owner: "e" + i, done: false, expires: Date.now() + 350_000, hardTimer: undefined as unknown } as never;
    bubbles.push(bubbleI as { hardTimer?: unknown });
    b.armBriefBubble(a as never, bubbleI, "t" + i, STRICT_CHAT);
    // CoT 进度 (thinking + tool)
    b.cotFns.updateBriefProgress(a as never, "思考中 " + i);
    b.cotFns.updateBriefToolProgress(a as never, "Bash ls " + i);
    // 直接打发送端 (真实路径里节流 1.5s 后同一函数): strict 在这里被门拦下。
    (a as { cotText?: string }).cotText = "思考中 " + i;
    (a as { cotTimer?: unknown }).cotTimer = undefined;
    await b.cotFns.flushCot(a as never);
    // standalone: 模型正文 / skill 输出 / [mirror] 系统行
    b.sendStandalone(a as never, "模型的正文结论 " + i);
    b.sendStandalone(a as never, "中间叙述 " + i);
    b.sendStandalone(a as never, "[mirror] 系统提示 " + i);
    b.sendStandalone(a as never, "[wezard] 系统提示 " + i);
    // 流式帧
    void b.streamFns.flushStream({ acc: "流式增量 " + i, lastSent: "", closed: false, dead: false, dest: STRICT_CHAT, target: a.target, eventId: undefined, turnId: "t" + i } as never);
    void b.streamFns.finalizeStream(a as never, { acc: "流式终稿 " + i, lastSent: "", closed: false, dead: false, dest: STRICT_CHAT, target: a.target, eventId: undefined, turnId: "t" + i, tools: [], flushTimer: undefined, idleTimer: undefined, hardTimer: undefined, cardSent: false, sawTool: false, pending: Promise.resolve() } as never, false);
    // 终句 (brief 收口)
    a.briefTurnId = "t" + i;
    a.briefConcluded = false;
    b.concludeBriefTurn(a as never, "RESULT: 终句 " + i);
    // pushProjectInfo (会话边界)
    b.pushProjectInfo(a.target, "created");
    // 占位 ack (真实路径在 startBriefTurn; 夹具量门+ack 的代码开销)
    void client_ack(b, i);
    acks.push(performance.now() - t0);
    if (b.client.sent.length > 64) b.client.sent.splice(0, b.client.sent.length - 64);
  }
  // hardTimer 对照: 一个未收口的 turn 到点收口 (expires 2ms → 等它打完)。
  a.briefConcluded = false;
  (a as { briefBubble?: { done: boolean; expires: number } }).briefBubble!.done = false;
  (a as { briefBubble?: { done: boolean; expires: number } }).briefBubble!.expires = Date.now() + 2;
  b.armBriefBubble(a as never, (a as { briefBubble: unknown }).briefBubble as never, "thard", STRICT_CHAT);
  await new Promise((r) => setTimeout(r, 12));
  // 夹具的 350s hardTimer 会拖住进程 —— 清掉 (生产行为由上面 2ms 那颗已验)。
  bubbles.forEach((bb) => clearTimeout(bb.hardTimer as ReturnType<typeof setTimeout>));
  const totalMs = performance.now() - roundStart;
  const p95 = [...acks].sort((x, y) => x - y)[Math.floor(acks.length * 0.95)]!;
  return { b, totalMs, p95, rounds: 50 };
};
const client_ack = (b: ReturnType<typeof build>, i: number): void => {
  // ack = briefLine 的占位 (…+详情链接形态由 briefLine 代理) 经 replyStream; 真实路径同 seam。
  void b.client.replyStream({}, "st" + i, "…", false);
};

{
  const { b, p95, rounds } = await runRounds("strict");
  // ① 分类数出站: 严格群里除占位/系统行外必须为 0
  const model = b.client.sent.filter((s) => s.kind !== "stream" || !(s.text === "…" || s.text.includes("仍在处理中")));
  const speak = model.filter((s) => !s.text.startsWith("[mirror]") && !s.text.startsWith("[wezard]") && s.text !== "…");
  assert.equal(speak.length, 0, "strict: 50 轮混合夹具, 模型发言出站 = 0 (实际漏了: " + JSON.stringify(speak.slice(0, 3)) + ")");
  // 各路径逐一为 0
  const finals = b.client.sent.filter((s) => s.kind === "stream:final");
  assert.equal(finals.length, 0, "终句不写流");
  assert.equal(b.counts().queueFinal, 0, "终句不进 queueFinal");
  assert.equal(b.counts().recoverEventFinal, 0, "终句不走 recoverEventFinal");
  const messages = b.client.sent.filter((s) => s.kind.startsWith("message:"));
  assert.equal(messages.filter((m) => !m.text.startsWith("[mirror]") && !m.text.startsWith("[wezard]")).length, 0, "standalone 正文不发 (系统行照放)");
  const cotFrames = b.client.sent.filter((s) => s.kind === "stream" && s.text.includes("思考中"));
  assert.equal(cotFrames.length, 0, "CoT 进度行不出站");
  // hardTimer 收口不添字: 严格群 finishBubble 只会收到占位形 (…), 不含「仍在处理中」
  assert.ok(b.finishBubbleCalls.every((c) => !c.includes("仍在处理中")), "hardTimer 收口不写「仍在处理中」");
  // ⑨ p95
  assert.ok(p95 <= 1500, "人发消息到占位的代码路径 p95 " + Math.round(p95) + "ms ≤ 1500ms (" + rounds + " 轮)");
  console.log("strict-outbound: 50 轮 strict 出站=0 (终句/流式/CoT/standalone), p95=" + Math.round(p95) + "ms");
}
{
  // 对照组: 同一夹具在 implicit 群各路径都要出站 —— 证明夹具真的在打这些路径。
  const { b } = await runRounds("implicit");
  assert.ok(b.client.sent.some((s) => s.kind === "stream" && s.text.includes("思考中")), "implicit: CoT 照发");
  assert.ok(b.client.sent.some((s) => s.kind === "message:wrStrict"), "implicit: standalone 正文照发");
  assert.equal(b.counts().queueFinal, 50, "implicit: 终句照常 queueFinal (50/50)");
  assert.ok(b.finishBubbleCalls.some((c) => c.includes("仍在处理中")), "implicit: hardTimer 照写「仍在处理中」");
  console.log("strict-outbound: implicit 对照组各路径出站 > 0 (夹具有效性)");
}
