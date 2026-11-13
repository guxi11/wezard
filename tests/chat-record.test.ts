// v3 P7-S1 记录与账本地基 —— implicit 模式零行为变化的词汇面与机制面。
// 覆盖: chat-record 纯函数 (sliceBatch/renderBatch)、ChatRecords 落盘与写失败语义、
// members 表 (chat|identity, 零 pane 维度)、reminder chatlog 种类、ReceiptStatus passed、
// ChatPolicy.speech 缺省、chat_* 工具的隐藏注册。
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CARD_LINE_MARK, renderBatch, sliceBatch, type ChatLine } from "../shared/chat-record.js";
import { ChatRecords, chatPrincipalOf } from "../daemon/chat-records.js";
import { openMembers } from "../daemon/members.js";
import { REMINDER_KINDS, TAIL_ORDER, parseEnvelope, parseReminders, renderReminder, renderTail, reminderLabel, stripReminders } from "../shared/reminder.js";
import { renderReceiptEnvelope } from "../daemon/peers.js";
import { isTerminal } from "../shared/turn-state.js";
import { chatPolicyOf } from "../daemon/chat-name.js";
import { resetKnownChatsCache } from "../daemon/chat-seen.js";
import { ConfigSchema, type Config } from "../shared/config.js";

const line = (seq: number, over: Partial<ChatLine> = {}): ChatLine => ({
  chat: "chat:wrA", seq, at: 1000 + seq, id: `m${seq}`, author: "alice", kind: "human", text: `line-${seq}`, ...over,
});

// ── 1. sliceBatch: 触发消息全文 / 其余截断 / 剔 self 与卡片系统行 / 游标 ──
{
  const long = "x".repeat(500);
  const lines = [
    line(1),
    line(2, { author: "me", kind: "wizard", text: "我自己说的" }),
    line(3, { kind: "system", author: "wezard", text: `${CARD_LINE_MARK} vote_interaction` }),
    line(4, { kind: "system", author: "wezard", text: "" }),
    line(5, { kind: "wizard", author: "bob", text: long }),
    line(6, { author: "carol", text: "最新的触发消息, 全文照录, 即使很长也全文 — " + long }),
  ];
  const b = sliceBatch(lines, -1, 10_000, "me")!;
  assert.equal(b.from, 1, "从游标后第一条有效行开始");
  assert.equal(b.to, 6, "到最新一条 (新游标)");
  assert.equal(b.trigger, "m6", "触发行 = 最新一条");
  assert.ok(!b.more, "预算内全收");
  assert.ok(!b.render.includes("我自己说的"), "剔除 self 发言");
  assert.ok(!b.render.includes(CARD_LINE_MARK), "剔除卡片类系统行");
  assert.ok(!b.render.includes("line-3") && !b.render.includes("line-4"), "卡片与空文本系统行不进批");
  assert.ok(b.render.includes("全文照录"), "触发消息全文");
  assert.ok(b.render.includes(`‹长文 m5 · 500 字›`), "溢出行写成一行指针 (id + 字数)");
  assert.ok(!b.render.includes("line-2"), "self 行不在批里");
  assert.equal(sliceBatch(lines, 6, 10_000, "me"), undefined, "游标之后没有有效行");
  assert.equal(sliceBatch(lines, 3, 10_000, "me")!.from, 5, "游标 3 → 从 5 开始 (4 是空系统行, 5 起有效)");
}
{
  // 预算裁剪: 旧行被裁, more=true; 触发行永远在批里。
  const lines = [line(1, { text: "a".repeat(200) }), line(2, { text: "b".repeat(200) }), line(3, { text: "c".repeat(200) })];
  const b = sliceBatch(lines, -1, 300)!;
  assert.deepEqual(b.lines.map((l) => l.seq), [3], "装不下旧的两条, 只剩触发行");
  assert.equal(b.more, true);
  assert.equal(sliceBatch(lines, 2, 300)!.more, false, "游标推到 2 后剩下的装得下");
}
assert.equal(renderBatch([line(1, { text: "hi" })], "m1"), "[1] alice: hi", "renderBatch 触发行全文");

// ── 2. ChatRecords: seq 单调 / 落盘 / 重启恢复 / 写失败只记日志 / 空 id 不去重 ──
{
  const dir = mkdtempSync(join(tmpdir(), "chat-records-"));
  const a = new ChatRecords({ dir, keepDays: 30, maxLines: 100 });
  const l1 = a.record("chat:wrA", { at: 1, id: "msg1", author: "alice", kind: "human", text: "第一句" });
  const l2 = a.record("chat:wrA", { at: 2, id: "msg2", author: "bob", kind: "wizard", text: "第二句" });
  const l3 = a.record("chat:wrB", { at: 3, id: "msg3", author: "alice", kind: "human", text: "另一个聊天" });
  assert.deepEqual([l1.seq, l2.seq, l3.seq], [1, 2, 1], "seq 每聊天独立单调");
  const dup = a.record("chat:wrA", { at: 2, id: "msg2", author: "bob", kind: "wizard", text: "重投覆盖" });
  assert.equal(dup.seq, 2, "同 id 重写覆盖, seq 不再分配");
  const noId1 = a.record("chat:wrA", { at: 4, id: "", author: "wezard", kind: "system", text: "推送1" });
  const noId2 = a.record("chat:wrA", { at: 5, id: "", author: "wezard", kind: "system", text: "推送2" });
  assert.ok(noId1.seq !== noId2.seq, "空 id 不去重, 每次都是新行");
  await new Promise((r) => setTimeout(r, 150));
  const onDisk = readFileSync(join(dir, "chat%3AwrA.jsonl"), "utf8").trim().split("\n").map((x) => JSON.parse(x) as ChatLine);
  assert.ok(onDisk.length >= 5 && onDisk.every((l) => l.chat === "chat:wrA"), "append-only 落到每聊天一份 jsonl");
  // 重启恢复: 新实例从盘上续 seq。
  const b = new ChatRecords({ dir, keepDays: 30, maxLines: 100 });
  const after = b.record("chat:wrA", { at: 9, id: "msg9", author: "alice", kind: "human", text: "重启后" });
  assert.equal(after.seq, Math.max(...onDisk.map((l) => l.seq)) + 1, "seq 从盘上最大值续起");
  // 写失败 (目录路径是个文件): record 同步返回不抛, 只记日志。
  const blocked = join(dir, "blocked");
  writeFileSync(blocked, "");
  const fails = new ChatRecords({ dir: join(blocked, "sub"), keepDays: 30, maxLines: 10 });
  const noted: string[] = [];
  const r1 = fails.record("chat:wrX", { at: 1, id: "x1", author: "a", kind: "human", text: "写不进去" });
  assert.equal(r1.seq, 1, "写失败不挡内存记账 (入站不 await, 记录失败不挡消息)");
  void noted;
}

// ── 3. members: join/leave/isMember/modeOf/advance; 键 = chat|identity, 零 pane ──
{
  const dir = mkdtempSync(join(tmpdir(), "members-"));
  const file = join(dir, "members.json");
  const m = openMembers(file);
  const chat = "chat:wrA", idA = "chat:wrA#fix", idB = "chat:wrB#fix";
  m.join(chat, idA, "mention", "human:T1");
  assert.equal(m.isMember(chat, idA), true);
  assert.equal(m.modeOf(chat, idA), "mention");
  assert.equal(m.isMember(chat, idB), false, "同一身份另一群不算成员 (chat × 身份)");
  assert.equal(m.isMember("chat:wrC", idA), false, "另一群不算本群成员");
  m.join(chat, idA, "speaker", idB);
  assert.equal(m.modeOf(chat, idA), "speaker", "重复 join 升级方式");
  assert.equal(m.rowOf(chat, idA)!.cursor, -1, "初始游标 -1");
  m.advance(chat, idA, 7);
  m.advance(chat, idA, 3);
  assert.equal(m.rowOf(chat, idA)!.cursor, 7, "游标只进不退");
  assert.equal(m.ofChat(chat).length, 1);
  m.leave(chat, idA);
  assert.equal(m.isMember(chat, idA), false);
  // 盘上的键: chat|identity, 无 pane 维度。
  m.join(chat, idA, "owner", "human:T1");
  const saved = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  assert.deepEqual(Object.keys(saved), [`${chat}|${idA}`], "键 = chat|identity");
}

// ── 4. reminder chatlog: 属性登记 / TAIL_ORDER / 剥离 / 折叠 label ──
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

// ── 5. ReceiptStatus passed: 措辞 + 终态; S1 无写入方 (判据⑤) ──
assert.equal(isTerminal("passed"), true, "passed 是终态");
{
  const rcpt = renderReceiptEnvelope(".lead", undefined, "passed", "e1");
  assert.ok(rcpt.includes("已了结回执"), "passed 回执有自己的措辞, 不落进失败回执");
}

// ── 6. ChatPolicy.speech: 缺省走 chat-seen 判定 (S3 后首见 strict), chatPolicyOf 透出 ──
// P7-S3: speech 缺省不再是常量 implicit —— 隔离 stateDir 测 (默认 stateDir 会碰真机 state)。
{
  const tmpCfg = (extra: Record<string, unknown> = {}): Config =>
    ConfigSchema.parse({ bot: { botId: "t", secret: "t" }, daemon: { stateDir: mkdtempSync(join(tmpdir(), "chat-record-")) }, ...extra });
  const cfg = tmpCfg();
  assert.equal(chatPolicyOf(cfg, "chat:wrA").speech, "implicit", "未在册 (没发生过往来) → implicit");
  const strict = tmpCfg({ chatPolicy: { "chat:wrA": { speech: "strict" } } });
  assert.equal(chatPolicyOf(strict, "chat:wrA").speech, "strict");
  assert.equal(chatPolicyOf(strict, "chat:wrB").speech, "implicit", "别的群不受影响");
  resetKnownChatsCache();
}

// ── 7. chat_* 工具: S2 起常规注册 (S1 曾判据④「隐藏注册」随四工具升级而反转, 逐条说明见回执) ──
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
  // S2: 四工具从 registerRare 升常规 —— 不带任何 env 也必须在工具面 (implicit 群由 handler 409 挡)。
  const base = await toolNames();
  for (const n of ["chat_members", "chat_say", "chat_reply", "chat_ask"]) {
    assert.ok(base.includes(n), `常规注册后 ${n} 在工具面 (S2 升级)`);
  }
}

// ── 附: 出站包装层的聊天键规范 (wr 前缀 → chat:, 其余 user:, 已带前缀原样) ──
assert.equal(chatPrincipalOf("wrABC"), "chat:wrABC");
assert.equal(chatPrincipalOf("user:u1"), "user:u1");
assert.equal(chatPrincipalOf("u1"), "user:u1");
assert.equal(chatPrincipalOf("wrABC~bot2"), "chat:wrABC");

console.log("chat-record: slice/store/members/chatlog/passed/speech/tools all passed");
