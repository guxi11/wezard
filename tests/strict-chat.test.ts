import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sayVerdict, openSayMeter } from "../daemon/strict-gate.js";
import { ChatRecords } from "../daemon/chat-records.js";
import { openMembers } from "../daemon/members.js";
import { sliceBatch, renderBatch, CHAT_BATCH_BUDGET } from "../shared/chat-record.js";
import { parseReminders } from "../shared/reminder.js";
import { openRouter, ops, makeOutcome } from "../daemon/router.js";

// P7-S2 义务与批量 (判据②③④⑤的纯函数面):
//   ② 非成员 chat_say 403 = 100%; mention 无有效 re 409 = 100%
//   ③ 每条人话恰好 1 条义务; 同 re 二次 (行已 answer+hand) 不再是有效义务
//   ④ 20 条消息 3 次激活, 每个 seq 恰好出现在 1 个 chatlog; uncertain 游标不动, committed 后无重复
//   ⑤ 每批 ≤6KB 且触发消息 100% 全文

// ── ② 判定矩阵 ──
const nonMember = Array.from({ length: 10 }, (_, i) => sayVerdict({ mode: undefined, hasValidRe: false, turnUsed: i, windowCount: i }));
assert.ok(nonMember.every((v) => v?.status === 403), "非成员 chat_say 403 = 100% (10/10)");
const mentionNoRe = Array.from({ length: 10 }, (_, i) => sayVerdict({ mode: "mention", hasValidRe: false, turnUsed: i, windowCount: i }));
assert.ok(mentionNoRe.every((v) => v?.status === 409 && v.reason.includes("mention")), "mention 无有效 re 409 = 100% (10/10)");
assert.equal(sayVerdict({ mode: "mention", hasValidRe: true, turnUsed: 0, windowCount: 0 }), undefined, "mention + 有效 re 放行");
assert.equal(sayVerdict({ mode: "speaker", hasValidRe: false, turnUsed: 0, windowCount: 0 }), undefined, "speaker 主动发言放行");
assert.equal(sayVerdict({ mode: "owner", hasValidRe: false, turnUsed: 0, windowCount: 0 }), undefined, "owner 放行");
assert.equal(sayVerdict({ mode: "speaker", hasValidRe: false, turnUsed: 3, windowCount: 0 })?.status, 409, "每轮第 4 条 409");
assert.equal(sayVerdict({ mode: "speaker", hasValidRe: false, turnUsed: 0, windowCount: 10 })?.status, 409, "每群每分钟第 11 条 409");

// 记账: 轮次额度随事件归零, 窗口按群滚动
{
  const meter = openSayMeter();
  for (let i = 0; i < 3; i++) {
    const f = meter.check("w1", "ev1", "chat:wrA", 1_000_000 + i);
    assert.equal(sayVerdict({ mode: "speaker", hasValidRe: false, ...f }), undefined, "第 " + (i + 1) + " 条放行");
    meter.charge("w1", "ev1", "chat:wrA", 1_000_000 + i);
  }
  assert.equal(sayVerdict({ mode: "speaker", hasValidRe: false, ...meter.check("w1", "ev1", "chat:wrA", 1_000_010) })?.status, 409, "同轮第 4 条撞轮次额度");
  for (let i = 0; i < 7; i++) meter.charge("w1", "ev2", "chat:wrA", 1_000_020 + i);
  assert.equal(sayVerdict({ mode: "speaker", hasValidRe: false, ...meter.check("w1", "ev2", "chat:wrA", 1_000_030) })?.status, 409, "同群第 11 条撞窗口额度");
  assert.equal(sayVerdict({ mode: "speaker", hasValidRe: false, ...meter.check("w2", "ev1", "chat:wrB", 1_000_030) }), undefined, "别的群 / 别人不受影响");
  assert.equal(sayVerdict({ mode: "speaker", hasValidRe: false, ...meter.check("w1", "ev3", "chat:wrA", 1_000_030 + 61_000) }), undefined, "时间走到窗口外恢复");
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
assert.ok(!UNFINISHED.includes(row0.status), "同 re 二次: 行已 handed, 义务校验不过 (409 语义)");
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
