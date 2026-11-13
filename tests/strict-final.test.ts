import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openRouter, ops, makeOutcome, type Table } from "../daemon/router.js";
import { finalKind, finalReleased, onFinal } from "../daemon/router.js";

// P7-S2 关账口径 (router 纯函数层):
//   strict 群 chat 接收行: 终句零 op、finalReleased=false (占位保持, 关账走 chat_reply);
//   私聊/wizard 接收行: 照旧 (@name RESULT 语义不变);
//   implicit (strict=false): chat 接收行照旧由终句落定 —— 拨回 implicit 后未结义务由下一句终句关账 (判据⑧)。

const tmp = mkdtempSync(join(tmpdir(), "strict-final-"));
const file = join(tmp, "routes.jsonl");

const chatReceiver = { kind: "chat" as const, channel: "chat:wrStrict", message: "m1" };
const wizardReceiver = { kind: "wizard" as const, to: "chat:wrA#asker", event: "eRoot" };

let t: Table = {};
const commit = (op: Parameters<openRouter["commit"]>[0]): Table => { t = openR.commit(op); return t; };
const openR = openRouter({ file, note: () => {} });
commit(ops.open({ event: "eRoot", owner: "chat:wrA#asker", receiver: chatReceiver, deadlineAt: Number.MAX_SAFE_INTEGER }));
commit(ops.open({ event: "ePeer", owner: "chat:wrA#asker", receiver: wizardReceiver, deadlineAt: Number.MAX_SAFE_INTEGER }));

const verdict = (text: string) => ({ text, source: { input: "x" }, result: true as const });

// ① strict: chat 行终句零 op —— 不落定、不 mark、不追述
assert.deepEqual(onFinal(t, "chat:wrA#asker", "eRoot", verdict("RESULT: 完成"), true), []);
assert.deepEqual(onFinal(t, "chat:wrA#asker", "eRoot", verdict("NEED: 缺信息"), true), []);
// 落定过的行在 strict 下也不收追述
commit(ops.answer({ event: "eRoot", outcome: makeOutcome("done", "第一份") }));
assert.deepEqual(onFinal(t, "chat:wrA#asker", "eRoot", verdict("RESULT: 补充"), true), []);
// 回到 open 再验 implicit 路径没被破坏
commit(ops.open({ event: "eRoot2", owner: "chat:wrA#asker", receiver: chatReceiver, deadlineAt: Number.MAX_SAFE_INTEGER }));
assert.notEqual(onFinal(t, "chat:wrA#asker", "eRoot2", verdict("RESULT: 完成"), false).length, 0, "implicit: chat 行终句照旧落定 (判据⑧)");

// ② strict: wizard 接收行照旧 (私聊 @name RESULT 语义不变)
const peerOps = onFinal(t, "chat:wrA#asker", "ePeer", verdict("RESULT: 私聊结论"), true);
assert.equal(peerOps.length, 1, "strict 不影响 wizard 接收行");
assert.equal(peerOps[0]!.op, "answer");

// ③ finalReleased: strict chat 行 false, wizard 行 / implicit 照旧
assert.equal(finalReleased(t, "chat:wrA#asker", "ePeer", "RESULT: x", { input: "x" }, true), true);
const source = { input: "eRoot2" };
const released = finalReleased(t, "chat:wrA#asker", "eRoot2", "RESULT: x", source, false);
assert.equal(typeof released, "boolean");
commit(ops.open({ event: "eRoot3", owner: "chat:wrA#asker", receiver: chatReceiver, deadlineAt: Number.MAX_SAFE_INTEGER }));
assert.equal(finalReleased(t, "chat:wrA#asker", "eRoot3", "RESULT: x", { input: "x" }, true), false, "strict: chat 行终句不放行");
assert.equal(finalReleased(t, "chat:wrA#asker", "eRoot3", "RESULT: x", { input: "x" }, false), true, "implicit: 同一行照旧放行");

// ④ 实例 API 透传 strict
assert.deepEqual(openR.onFinal("chat:wrA#asker", "eRoot3", verdict("RESULT: y"), true), []);
assert.equal(openR.finalReleased("chat:wrA#asker", "eRoot3", "RESULT: y", { input: "x" }, true), false);

// ⑤ 判据⑧ 后半: routes.jsonl 重放不报错 (strict 期间落的行没有新形状, fold 一遍即可)
const reopened = openRouter({ file, note: () => {} });
assert.equal(reopened.get("eRoot3")?.status, "open", "重放后未结义务仍是 open");
assert.equal(finalKind(reopened.table(), "ePeer", "RESULT: x"), "result");

rmSync(tmp, { recursive: true, force: true });
console.log("strict-final: chat 行 strict 终句零 op / wizard 行照旧 / implicit 拨回关账 / 重放干净");
