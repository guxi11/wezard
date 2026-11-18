import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sayVerdict, openSayMeter, topOnlyVerdict } from "../daemon/strict-gate.js";
import { ChatRecords } from "../daemon/chat-records.js";
import { openMembers } from "../daemon/members.js";
import { sliceBatch, renderBatch, CHAT_BATCH_BUDGET } from "../shared/chat-record.js";
import { parseReminders } from "../shared/reminder.js";
import { openRouter, ops, makeOutcome } from "../daemon/router.js";

// P7-S2 义务与批量 (判据②③④⑤的纯函数面; ② 于 2026-11-18 随「入群即发言权」放宽改写):
//   ② 非成员 403 = 100%; 成员 (owner/speaker/mention 同权) 不挂义务即可发言; 额度 409 照判
//   ③ 每条人话恰好 1 条义务; 销账只走 chat_reply 的显式答复 (answer+hand), 出站 (chat_say/notify/send_file) 不销账
//   ④ 20 条消息 3 次激活, 每个 seq 恰好出现在 1 个 chatlog; uncertain 游标不动, committed 后无重复
//   ⑤ 每批 ≤6KB 且触发消息 100% 全文

// ── ② 判定矩阵 (人拍板「入群即发言权」: 义务不再是出站前置, 只拦非成员与额度) ──
const nonMember = Array.from({ length: 10 }, (_, i) => sayVerdict({ mode: undefined, turnUsed: i, windowCount: i }));
assert.ok(nonMember.every((v) => v?.status === 403), "非成员 403 = 100% (10/10)");
for (const mode of ["owner", "speaker", "mention"] as const) {
  assert.equal(sayVerdict({ mode, turnUsed: 0, windowCount: 0 }), undefined, mode + " 成员不挂义务即可发言 (与 speaker/owner 同权)");
  assert.equal(sayVerdict({ mode, turnUsed: 3, windowCount: 0 })?.status, 409, mode + " 每轮第 4 条 409");
  assert.equal(sayVerdict({ mode, turnUsed: 0, windowCount: 10 })?.status, 409, mode + " 每群每分钟第 11 条 409");
}
// send_file 的 delivery 豁免随 re 要求一起退役: 文件与 chat_say 同一道门 (成员 + 额度), 无特殊分支。
assert.equal(sayVerdict({ mode: "mention", turnUsed: 0, windowCount: 0 }), undefined, "mention 成员发文件照走成员门 (无需豁免)");

// ── topOnly 门 (chat_say 与 notify / send_file 同一道核): 下层轮 (服务同伴的活) 不得在顶层模式群说话 ──
assert.equal(topOnlyVerdict({ belowTop: true, topOnly: true, exempt: false }), true, "下层轮在 topOnly 群 chat_say 被拦");
assert.equal(topOnlyVerdict({ belowTop: true, topOnly: true, exempt: true }), false, "管家豁免: 该群默认会话照发");
assert.equal(topOnlyVerdict({ belowTop: false, topOnly: true, exempt: false }), false, "人直说 / 人点名的轮 (非下层) 通过");
assert.equal(topOnlyVerdict({ belowTop: true, topOnly: false, exempt: false }), false, "非 topOnly 群不受影响");
// handler 接线 (源码切片, 宅内闭包抽取模式): chat_say 的 topOnly 门在 implicit 指路之后、
// strictSayGate 之前 —— implicit 群照旧收 implicit 409; notify 与 chat_say 调同一个 topOnlyMuted。
{
  const src = readFileSync("daemon/index.ts", "utf8");
  const handler = (open: string, close: string): string => {
    const a = src.indexOf(open);
    const b = src.indexOf(close, a);
    assert.ok(a >= 0 && b > a, "handler 切片定位: " + open);
    return src.slice(a, b);
  };
  const say = handler('http.register("POST /chat/say"', 'http.register("POST /chat/reply"');
  const pImplicit = say.indexOf("未开严格模式");
  const pTop = say.indexOf("topOnlyMuted");
  const pGate = say.indexOf("strictSayGate");
  assert.ok(pImplicit > 0 && pTop > pImplicit && pGate > pTop, "chat_say: implicit 指路在前, topOnly 门在 strictSayGate 前 (implicit 群行为不变)");
  // notify 的切片止于它自己的 handler 结尾 (后面紧跟 chat_* 一族, 不能扫进去)。
  const notify = handler('http.register("POST /notify"', '// ── 给人看的文件');
  assert.ok(notify.includes("topOnlyMuted"), "notify 与 chat_say 同一道 topOnly 门");
  const sendfile = handler('http.register("POST /send_file"', 'http.register("POST /peers/peek"');
  // 放宽后 chat_reply 也能自由发言 (已结/别人的义务照发) —— 必须补上 topOnly 门,
  // 否则替同伴干活的那一轮能借 chat_reply 绕过顶层模式对人说话。
  const reply = handler('http.register("POST /chat/reply"', 'http.register("POST /chat/ask"');
  const rTop = reply.indexOf("topOnlyMuted");
  const rGate = reply.indexOf("strictSayGate");
  assert.ok(rTop > 0 && rGate > rTop, "chat_reply 也走 topOnly 门, 且在 strictSayGate 前");
  // 出站不销账 (验收): chat_say / notify / send_file 的 handler 不碰义务账;
  // 销账 (answer+hand) 只在 chat_reply 的显式答复分支; 已结/非己义务只发言。
  for (const [name, slice] of [["chat_say", say], ["notify", notify], ["send_file", sendfile]] as const) {
    assert.ok(!slice.includes("ops.answer") && !slice.includes("ops.hand"), name + " 出站不销义务的账");
  }
  assert.ok(reply.includes("ops.answer") && reply.includes("ops.hand"), "只有 chat_reply 的显式答复销账");
  assert.ok(reply.includes("不销账"), "chat_reply 对已结 / 欠在别人手上的义务只发言不销账");
}

// 记账: 轮次额度随事件归零, 窗口按群滚动; 同一条义务下连发 ack + 结论 + 进展 (验收)。
{
  const meter = openSayMeter();
  // mention 成员在同一轮 (同一注入事件) 里连发三条: 派活 ack (chat_say) → 结论 (chat_reply) → 进展 (chat_say)。
  for (const [i, what] of ["ack", "结论", "进展"].entries()) {
    const f = meter.check("w1", "ev1", "chat:wrA", 1_000_000 + i);
    assert.equal(sayVerdict({ mode: "mention", ...f }), undefined, "同一条义务下第 " + (i + 1) + " 条 (" + what + ") 放行");
    meter.charge("w1", "ev1", "chat:wrA", 1_000_000 + i);
  }
  assert.equal(sayVerdict({ mode: "speaker", ...meter.check("w1", "ev1", "chat:wrA", 1_000_010) })?.status, 409, "同轮第 4 条撞轮次额度");
  for (let i = 0; i < 7; i++) meter.charge("w1", "ev2", "chat:wrA", 1_000_020 + i);
  assert.equal(sayVerdict({ mode: "speaker", ...meter.check("w1", "ev2", "chat:wrA", 1_000_030) })?.status, 409, "同群第 11 条撞窗口额度");
  assert.equal(sayVerdict({ mode: "speaker", ...meter.check("w2", "ev1", "chat:wrB", 1_000_030) }), undefined, "别的群 / 别人不受影响");
  assert.equal(sayVerdict({ mode: "speaker", ...meter.check("w1", "ev3", "chat:wrA", 1_000_030 + 61_000) }), undefined, "时间走到窗口外恢复");
}

// ── ③④⑤ 义务与批量: 真 ChatRecords + members + 游标 ──
const tmp = mkdtempSync(join(tmpdir(), "strict-chat-"));
const chat = "chat:wrStrict";
const records = new ChatRecords({ dir: join(tmp, "chats"), keepDays: 30, maxLines: 2000 });
const members = openMembers(join(tmp, "members.json"));
const me = "chat:wrStrict#worker";
const identity = me;
members.join(chat, identity, "speaker", "test");

// 20 条人话 (含一条超长 — 触发消息全文的对面)
const texts = Array.from({ length: 20 }, (_, i) => i === 5 ? "超长消息。".repeat(600) : "人话 " + (i + 1));
const T0 = Date.now();
texts.forEach((text, i) => records.record(chat, { at: T0 + i, id: "m" + i, author: "user:human", kind: "human", text }));

// 3 次激活 (dispatch → sliceBatch → committed → advance), 收集所有批
const seen = new Map<number, number>();
const batches: string[] = [];
const cursorOf = (): number => members.rowOf(chat, identity)?.cursor ?? -1;
for (let round = 0; round < 3; round++) {
  // 每次激活前人再补几句 — 模拟连续消息
  if (round > 0) {
    for (let i = 0; i < 3; i++) {
      const n = 20 + (round - 1) * 3 + i;
      records.record(chat, { at: T0 + n, id: "m" + n, author: "user:human", kind: "human", text: "人话 " + (n + 1) });
    }
  }
  const batch = sliceBatch(records.lines(chat), cursorOf(), CHAT_BATCH_BUDGET, "worker");
  if (!batch) break;
  batches.push(batch.render);
  for (const l of batch.lines) seen.set(l.seq, (seen.get(l.seq) ?? 0) + 1);
  // uncertain 夹具: 提交未确认 → 游标不动, 同一批重新切 — 模型侧看到的批不重复计数
  const uncertainAgain = sliceBatch(records.lines(chat), cursorOf(), CHAT_BATCH_BUDGET, "worker");
  assert.equal(uncertainAgain?.from, batch.from, "游标未推进时同一批原样重切 (uncertain 不推进)");
  // committed → advance
  members.advance(chat, identity, batch.to);
}
// ④ 每个 seq 恰好出现在 1 个 chatlog
const dup = [...seen.entries()].filter(([, n]) => n !== 1);
assert.equal(dup.length, 0, "每个 seq 恰好出现在 1 个 chatlog (重复: " + JSON.stringify(dup) + ")");
assert.ok(seen.size >= 20, "20 条消息全部覆盖 (实际 " + seen.size + ")");
// ⑤ 每批 ≤6KB
for (const b of batches) assert.ok(Buffer.byteLength(b, "utf8") <= 6144, "每批 ≤6KB (" + Buffer.byteLength(b, "utf8") + "B)");
// ⑤ 触发消息 100% 全文: 每一批的最后一条 (触发行) 必须是全文, 不是 ‹长文› 指针
for (const b of batches) {
  const lines = b.split("\n");
  const trigger = lines[lines.length - 1]!;
  assert.ok(!trigger.includes("‹长文"), "触发消息全文, 不落指针: " + trigger.slice(0, 40));
}
// 超长行 (非触发) 落指针
assert.ok(batches.some((b) => b.includes("‹长文")), "非触发的超长行写成一行指针");
// 剩余未消费的行: 下一批接着来, 无缝
const rest = sliceBatch(records.lines(chat), cursorOf(), CHAT_BATCH_BUDGET, "worker");
if (rest) for (const l of rest.lines) assert.equal(seen.has(l.seq), false, "残余批只含没见过的 seq");

// chatlog reminder 解析面: attrs 原样读回
{
  const reminder = ["<system-reminder " + 'wezard="chatlog" chat="' + chat + '" from="3" to="9" owes="2">', "[3] user: hi", "</system-reminder>"].join("\n");
  const parsed = parseReminders(reminder).find((r) => r.attrs.wezard === "chatlog")!;
  assert.equal(parsed.attrs.chat, chat);
  assert.equal(Number(parsed.attrs.to), 9);
  assert.equal(Number(parsed.attrs.owes), 2);
}

// ── ③ 义务账 (router 层): 每条人话一条行; chat_reply 关账 (answer+hand); 同 re 二次无效 ──
const router = openRouter({ file: join(tmp, "routes.jsonl"), note: () => {} });
const UNFINISHED = ["held", "open", "need", "error"];
for (let i = 0; i < 5; i++) {
  router.commit(ops.open({ event: "eRoot" + i, owner: me, at: 1_000_000 + i, deadlineAt: Number.MAX_SAFE_INTEGER,
    receiver: { kind: "chat", channel: chat, message: "m" + i } }));
}
const owed = (): number => router.owedBy(me).filter((r) => r.receiver.kind === "chat" && UNFINISHED.includes(r.status)).length;
assert.equal(owed(), 5, "5 条人话 = 5 条义务 (每条恰好 1)");
// chat_reply: answer(done) + hand
router.commit(ops.answer({ event: "eRoot0", outcome: makeOutcome("done", "答复") }));
router.commit(ops.hand({ event: "eRoot0", inbox: "chat_reply:m0:rev1" }));
assert.equal(owed(), 4, "交付一条, 欠账少一条");
const row0 = router.get("eRoot0")!;
assert.equal(row0.status, "handed");
// 2026-11-18 起 同 re 二次不再 409: handler 对已结义务只发言不销账 (账面保持 handed, 不回 open)。
assert.ok(!UNFINISHED.includes(row0.status), "同 re 二次: 行已 handed, 账面不再回 open");
// passed 关账
router.commit(ops.answer({ event: "eRoot1", outcome: makeOutcome("passed", "（无需答复）") }));
router.commit(ops.hand({ event: "eRoot1", inbox: "chat_reply:m1:passed" }));
assert.equal(owed(), 3, "passed 也关账");
assert.equal(router.get("eRoot1")!.outcome!.status, "passed");
// 重放不报错
const reopened = openRouter({ file: join(tmp, "routes.jsonl"), note: () => {} });
assert.equal(reopened.get("eRoot0")!.status, "handed", "重放: handed 墓碑保持");

// 每条人话恰好一条义务 (判据③): 同 message id 重放开行 → 同 event 幂等; 不同 message 各一行
router.commit(ops.open({ event: "eRoot0", owner: me, at: 1_999_999, deadlineAt: Number.MAX_SAFE_INTEGER,
  receiver: { kind: "chat", channel: chat, message: "m0" } }));
assert.equal(router.get("eRoot0")!.at, 1_000_000, "同 event 重放不重开");

// 渲染面: renderBatch 触发行全文, 其余行照常渲染
{
  const lines = records.lines(chat).slice(0, 3);
  const render = renderBatch(lines, lines[lines.length - 1]!.id);
  assert.ok(render.includes("[" + lines[lines.length - 1]!.seq + "] user:human: 人话 3"), "触发行全文进批");
  assert.ok(render.startsWith("[" + lines[0]!.seq + "] user:human: 人话 1"), "非触发行照常渲染");
}

rmSync(tmp, { recursive: true, force: true });
console.log("strict-chat: say 判定矩阵 100% / 义务每话一条 + passed·二次拒绝 / seq 无重复 / 批 ≤6KB + 触发全文 / uncertain 不推进");
