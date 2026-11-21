// room 口径: 唤醒一次给模型看什么, 由账本现算 (unreadFor) —— 不再有 chat-records 落盘、
// members 游标表、chat-record 批。保留「批」的行为断言 (游标之后 / 触发全文 / 预算 / 已读不重投),
// 另留 reminder 词汇面 (chatlog 属性)、passed 终态与 room 工具面。
import assert from "node:assert/strict";
import { applyOp, renderMsgLine, UNREAD_BUDGET, unreadFor, type Who } from "../shared/room.js";
import { REMINDER_KINDS, TAIL_ORDER, parseEnvelope, parseReminders, renderReminder, renderTail, reminderLabel, stripReminders } from "../shared/reminder.js";
import { isTerminal } from "../shared/turn-state.js";
import { H, room, say, uid, W } from "./room-fixture.js";

const me = W(uid(1));
const human = H("T1");
const names = { nameOf: (w: Who): string => w.id, roomLabel: (r: string): string => r };

// ── 1. 一次唤醒的「批」: 游标之后 / 剔除自己 / 触发消息全文 / 非触发裁剪 / 预算上限 ──
const s = room("chat:wrA", [me]);
const long = "x".repeat(500);
const texts = Array.from({ length: 20 }, (_, i) => (i === 5 ? "超长消息。" + long : "人话 " + (i + 1)));
texts.forEach((text) => say(s, { author: human, origin: "inbound", text }));
say(s, { author: me, text: "我自己说的" }); // 自己的发言不进批

{
  const all = unreadFor(s, me);
  assert.equal(all.rows.length, 20, "游标 0 → 20 条人话全在批里");
  assert.equal(all.rows.some((m) => m.author.kind === "wizard"), false, "剔除自己说的");
  assert.equal(all.to, s.seq, "游标推到账本尾");
  const trigger = all.rows[all.rows.length - 1]!;
  const longRow = all.rows.find((m) => m.text.length > 500)!;
  assert.ok(renderMsgLine(trigger, names, 100_000).includes(trigger.text), "触发消息全文");
  const clipped = renderMsgLine(longRow, names, 500);
  assert.ok(clipped.includes("…(+" + (longRow.text.length - 500) + ")"), "非触发超长行写成截断指针");
  assert.ok(clipped.length < 500 + 64);
  const cost = all.rows.filter((m) => m.id !== trigger.id).reduce((n, m) => n + Math.min(m.text.length, 500), 0);
  assert.ok(cost <= UNREAD_BUDGET, "整批成本 " + cost + " ≤ " + UNREAD_BUDGET);
}

// 三次激活: 每次只拿游标之后; 已投过的不再出现; 不确定投递时同一批原样重切
{
  const seenSeq = new Map<number, number>();
  for (let round = 0; round < 3; round++) {
    if (round > 0) for (let i = 0; i < 3; i++) say(s, { author: human, origin: "inbound", text: "补充 " + round + "-" + i });
    const triggerId = s.msgs.filter((m) => m.author.kind === "human").at(-1)!.id;
    const batch = unreadFor(s, me, [triggerId], 600);
    assert.ok(batch.rows.length > 0, "有未读就有批");
    assert.equal(batch.rows.some((m) => m.id === triggerId), true, "触发消息永远在批里");
    batch.rows.forEach((r) => seenSeq.set(r.seq, (seenSeq.get(r.seq) ?? 0) + 1));
    const again = unreadFor(s, me, [triggerId], 600);
    assert.equal(again.rows[0]?.seq, batch.rows[0]?.seq, "游标未推进时同一批原样重切 (uncertain 不丢)");
    applyOp(s, { op: "seen", at: 9_000, room: s.id, who: me, seq: batch.to });
  }
  assert.equal([...seenSeq.values()].filter((n) => n > 1).length, 0, "游标推进后已读行不再回到批里");
  assert.equal(unreadFor(s, me).rows.length, 0, "最后一次投递后账本已无未读");
}

// ── 2. reminder chatlog: 属性登记 / TAIL_ORDER / 剥离 / 折叠 label ──
{
  assert.deepEqual(Object.keys(REMINDER_KINDS.chatlog), ["chat", "from", "to", "owes"], "chatlog 属性表");
  const block = renderReminder({ wezard: "chatlog", chat: "chat:wrA", from: "3", to: "9", owes: "2" }, ["群里的新话:"]);
  const parsed = parseReminders(block)[0]!;
  assert.equal(parsed.attrs.chat, "chat:wrA");
  assert.equal(parsed.attrs.from, "3");
  assert.equal(parsed.attrs.to, "9");
  assert.equal(parsed.attrs.owes, "2");
  assert.ok(TAIL_ORDER.indexOf("chatlog") > TAIL_ORDER.indexOf("mention") && TAIL_ORDER.indexOf("chatlog") < TAIL_ORDER.indexOf("roster"), "排在 mention 之后 roster 之前");
  const tail = renderTail(renderReminder({ wezard: "hint" }, ["旁注"]), block);
  assert.ok(tail.indexOf('wezard="hint"') < tail.indexOf('wezard="chatlog"'), "信封/旁注在前, chatlog 按表排");
  assert.equal(stripReminders("正 文" + block), "正 文", "stripReminders 剥得掉 chatlog");
  assert.equal(parseEnvelope(block), undefined, "chatlog 不是信封, 不干扰轮次归属");
  assert.deepEqual(reminderLabel(parsed), { label: "聊天记录", machine: true });
}

// ── 3. ReceiptStatus passed: 终态 ──
assert.equal(isTerminal("passed"), true, "passed 是终态");

// ── 4. room 工具面: 沟通口子是 chat_* + room_*, 旧的 chat_members / read_chat / tell_peer 退场 ──
const toolNames = async (): Promise<string[]> => {
  const { createWezardServer } = await import("../mcp/tools.js");
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const server = createWezardServer();
  const client = new Client({ name: "probe", version: "0" }, { capabilities: {} });
  const [t1, t2] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(t1), client.connect(t2)]);
  return (await client.listTools()).tools.map((x) => x.name);
};
{
  const base = await toolNames();
  for (const n of ["chat_say", "chat_ask", "chat_reply", "room_open", "room_read", "room_members", "room_watch"]) {
    assert.ok(base.includes(n), "room 口子 " + n + " 在工具面");
  }
  for (const gone of ["chat_members", "read_chat", "tell_peer"]) {
    assert.ok(!base.includes(gone), gone + " 已退役");
  }
}

console.log("chat-record: 唤醒批 / reminder chatlog / passed / room 工具面 all passed");
