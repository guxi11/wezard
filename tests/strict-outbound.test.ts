// room 口径 (契约 §5 F-1): 终句零语义 —— 一轮的散文终句对谁都不出站。群里的交付只有 room 的
// 镜像 (chat_say / chat_reply / send_file 触发的 hub.append → mirror), 终句只做三件事:
// 防重复终稿 / 记 turn store (rolepage 的正文) / 推进收口标记。
// 严格群的 speech / topOnly 出站门随 strict-gate 一起退役, 不再有「按群开/关终句投递」这回事。
//
// 断言方式: 从生产源码里抽出 concludeBriefTurn 的真实闭包 (宅内既定的闭包抽取模式), 用会记录/
// 报错的发送原语跑 50 轮 —— 有任何出站路径都会被抓到; 同时确认收口记录照常推进。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import pino from "pino";

const source = readFileSync("daemon/mirror-bridge.ts", "utf8");
const transpile = (s: string): string => ts.transpileModule(s, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;
const closure = (begin: string, end: string): string => {
  const start = source.indexOf(begin);
  const stop = source.indexOf(end, start);
  assert.ok(start >= 0 && stop > start, "missing closure " + begin.slice(0, 40));
  return source.slice(start, stop);
};
const block = closure("  /** 终句落地 (契约 §5 F-1: 终句零语义)", "  /** 收口一个 turn");

// 任何发送原语被调用都记账; 闭包里若引用别的名字会直接 ReferenceError (同样算红)。
const sent: string[] = [];
const client = {
  replyStream: async (...a: unknown[]) => { sent.push("stream " + String(a[2])); return undefined; },
  replyStreamWithCard: async (...a: unknown[]) => { sent.push("stream:card " + String(a[2])); return undefined; },
  sendMessage: async (_c: string, body: { markdown: { content: string } }) => { sent.push("message " + body.markdown.content); return {}; },
};
const append = (...a: unknown[]): void => { sent.push("hub.append " + String(a[1])); };
const notify = (...a: unknown[]): void => { sent.push("notify " + String(a[0])); };
const sendStandalone = (...a: unknown[]): void => { sent.push("sendStandalone " + String(a[1])); };

const closedTurns: string[] = [];
const concludeBriefTurn = new Function(
  "isDuplicateConclusion", "recordCloseOpenTurns", "clearCot", "log", "client", "append", "notify", "sendStandalone",
  transpile(block + "\nreturn concludeBriefTurn;"),
)(
  () => false,
  (x: { exceptIds?: string[] }) => { closedTurns.push(String(x.exceptIds?.[0])); },
  () => undefined,
  pino({ level: "silent" }),
  client, append, notify, sendStandalone,
) as (a: Record<string, unknown>, body: string) => void;

// 50 轮对话边界收口: 每轮都有正文, 不能有重复终稿抑制干扰
for (let i = 0; i < 50; i++) {
  const a: Record<string, unknown> = {
    sessionId: "s1", target: "chat:wrStrict#w1", briefTurnId: "t" + i, briefConcluded: false,
    queryEpoch: 0, activeEventId: undefined, briefBubble: { done: true },
  };
  concludeBriefTurn(a, "RESULT: 终句 " + i);
  assert.equal(a.briefConcluded, true, "收口标记推进 (第 " + i + " 轮)");
  assert.equal(a.lastConcludedBody, "RESULT: 终句 " + i, "终稿正文留在本轮状态里 (rolepage 用)");
}
assert.equal(sent.length, 0, "50 轮终句零出站 (实际: " + JSON.stringify(sent.slice(0, 3)) + ")");
assert.equal(closedTurns.length, 50, "每轮都记收口 (turn store), 一条不漏");

// 空正文 / 已收口 / 没有 briefTurnId: 什么都不做 (不出站, 也不覆盖终稿)
{
  const a = { sessionId: "s1", target: "chat:wrStrict#w1", briefTurnId: "t0", briefConcluded: true, queryEpoch: 0 };
  const before = closedTurns.length;
  concludeBriefTurn(a, "RESULT: 第二次");
  assert.equal(closedTurns.length, before, "已收口的 turn 不再记一次");
  const b = { sessionId: "s1", target: "chat:wrStrict#w1", briefTurnId: undefined as string | undefined, briefConcluded: false, queryEpoch: 0 };
  concludeBriefTurn(b, "RESULT: 无 turn");
  assert.equal(sent.length, 0, "无 turn 的终句照样零出站");
}

console.log("strict-outbound: 50 轮终句零出站 / 收口记录照常 (终句零语义)");
