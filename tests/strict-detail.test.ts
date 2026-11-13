// v3 P7-S3b: rolepage 群窗的账本口径 —— strict 群的 turn 出气泡被压掉, 实发内容走 post 记录。
// 断言: ① 同一轮 strict 群的出气泡文本 === chat-records 对应行的文本 (逐字, 同一字符串)
//      ② passed / 沉默轮不出现模型终句 ③ implicit 群不受影响 ④ 老数据 (无 post 的历史轮) 仍显示。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { allMessages, makeDirectory, messageOfPost, messagesOfTurn } from "../shared/role-view.js";
import { EMPTY_FACTS, type WorldFacts } from "../shared/world.js";
import type { DetailRecord, TurnDetailRecord } from "../shared/detail-store.js";
import { recordPost, initDetailPersistence } from "../daemon/detail.js";
import { ChatRecords } from "../daemon/chat-records.js";

const tmp = mkdtempSync(join(tmpdir(), "strict-detail-"));

const turn = (o: Partial<TurnDetailRecord> & { id: string; target: string; channel?: string }): TurnDetailRecord => ({
  kind: "turn", createdAt: 1000, updatedAt: 2000, closed: true,
  userQuery: "帮我看个报错", items: [{ t: "text", body: "模型终句 (从未进群)", ts: 2000, final: true }],
  ...o,
} as TurnDetailRecord);

const STRICT = "chat:wrS", PLAIN = "chat:wrP";
const facts: WorldFacts = { ...EMPTY_FACTS, absent: undefined, strictChats: [STRICT],
  wizards: [{ target: "chat:wrS#fix", identity: "chat:wrS#fix", name: "fix", description: "", chat: "", cwd: "", model: "", cli: "", busy: false, alive: true, lastActivity: 1 }] };
const records: DetailRecord[] = [
  turn({ id: "t1", target: "chat:wrS#fix", channel: STRICT }),   // strict 群的轮
  turn({ id: "t2", target: "chat:wrS#fix", channel: PLAIN }),    // implicit 群的轮
  turn({ id: "t3", target: "chat:wrS#fix", channel: "" }),       // 私聊轮
  turn({ id: "t4", target: "chat:wrS#fix", channel: STRICT, items: [] }), // 老数据: 无 post 的沉默轮
];
const dir = makeDirectory(records, facts);
assert.ok(dir.strictChats.has(STRICT), "Directory 带上 strictChats");
assert.ok(!dir.strictChats.has(PLAIN));

// ── 1. messagesOfTurn: strict 群的出气泡压掉, 入消息保留; implicit / 私聊照旧 ──
const strictChats = dir.strictChats;
assert.equal(messagesOfTurn(records[0] as TurnDetailRecord, undefined, strictChats).some((m) => m.dir === "out"), false, "strict 群: 模型终句的出气泡不出现");
assert.equal(messagesOfTurn(records[0] as TurnDetailRecord, undefined, strictChats).some((m) => m.dir === "in"), true, "strict 群: 问话入消息保留 (轮发生了, 区分「没这轮」)");
assert.equal(messagesOfTurn(records[1] as TurnDetailRecord, undefined, strictChats).some((m) => m.dir === "out"), true, "implicit 群: 出气泡照旧");
assert.equal(messagesOfTurn(records[2] as TurnDetailRecord, undefined, strictChats).some((m) => m.dir === "out"), true, "私聊: 出气泡照旧 (strict 只压群)");
assert.equal(messagesOfTurn(records[0] as TurnDetailRecord).some((m) => m.dir === "out"), true, "不传 strict 集 = 老 daemon 行为 (回归兼容)");

// ── 2. 实发内容 = post 记录, 文本与账本行逐字一致 ──
const LEDGER_TEXT = "看过了, 是配置问题"; // 同一字符串既进账本 (ChatLine.text) 又进 post (body)
const post: DetailRecord = { kind: "post", id: "msg-stream-1", createdAt: 2500, target: "chat:wrS#fix", channel: STRICT, body: LEDGER_TEXT };
const msgs = allMessages([...records, post], 3000, dir.canon, strictChats);
const outInStrict = msgs.filter((m) => m.channel === STRICT && m.dir === "out");
assert.equal(outInStrict.length, 1, "strict 群的出气泡只有 post 那一条 (t1 被压掉)");
assert.equal(outInStrict[0]!.turn.items[0]!.body ?? "", LEDGER_TEXT, "出气泡文本 === 账本行文本 (逐字: 同一字符串)");
// 同一轮 chat_pass (t4): 无 post → 群里零出气泡, 模型终句 (其实 t4 没有) 也不出现
assert.equal(msgs.filter((m) => m.channel === STRICT && m.dir === "out" && m.turn.id === "t4").length, 0, "沉默轮零出气泡");

// ── 3. messageOfPost: post 的合成 turn 只含实发正文 ──
const pm = messageOfPost(post as Extract<typeof post, { kind: "post" }>);
assert.equal(pm.turn.items.filter((i) => i.t === "text").map((i: any) => i.body).join(""), LEDGER_TEXT);
assert.equal(pm.channel, STRICT);

// ── 4. implicit 群不受影响 (回归): 无 strict 集 / 空集时行为一致 ──
const plainAll = allMessages(records, 3000, dir.canon);
assert.equal(plainAll.filter((m) => m.channel === PLAIN && m.dir === "out").length, 1, "implicit 群出气泡在");
assert.equal(allMessages(records, 3000, dir.canon, new Set()).length, plainAll.length, "空 strict 集 = 全量行为");

// ── 5. recordPost 指定 id 去重: 占位→交付同一流两次落账只留一条 (最终那句) ──
initDetailPersistence(tmp, undefined as never);
recordPost({ target: "chat:wrS#fix", channel: STRICT, body: "…", id: "stream-9" });
recordPost({ target: "chat:wrS#fix", channel: STRICT, body: "最终交付的那句", id: "stream-9" });
recordPost({ target: "chat:wrS#fix", channel: STRICT, body: "另一条" });
recordPost({ target: "chat:wrS#fix", channel: STRICT, body: "带历史时刻", id: "stream-7", createdAt: 12345 }); // backfill 用账本行时刻
const { getDetail } = await import("../daemon/detail.js");
assert.equal(getDetail("stream-9")?.kind, "post");
assert.ok((getDetail("stream-9") as { body?: string }).body?.includes("最终交付"), "同 id upsert: 留最终那句");
assert.equal((getDetail("stream-7") as { createdAt?: number }).createdAt, 12345, "backfill 的 post 用账本行时刻 (排序不失真)");


// ── P7-S3c ①: wizard 出站行 id 用 `#w` 命名空间, 人话重投不洗交付行 ──
{
  const rec2 = new ChatRecords({ dir: join(tmp, "chats2"), keepDays: 30, maxLines: 200 });
  const c = "chat:wrNS";
  const T0B = Date.now() - 60_000;
  rec2.record(c, { at: T0B, id: "dd60#w", author: "fix", kind: "wizard", text: "交付的那句" });
  // 同一裸 id 的人话重投 3 次 (WeCom 重投场景: msgid == 交付流 id)
  for (let i = 0; i < 3; i++) rec2.record(c, { at: T0B + 1000 + i, id: "dd60", author: "alice", kind: "human", text: "重投 " + i });
  const lines = rec2.lines(c);
  const wiz = lines.find((l) => l.id === "dd60#w");
  assert.ok(wiz, "wizard 交付行仍在");
  assert.equal(wiz.text, "交付的那句", "内容不变");
  assert.equal(wiz.kind, "wizard");
  const hum = lines.find((l) => l.id === "dd60");
  assert.equal(hum?.kind, "human", "人话行独立存在 (各占各的 seq)");
  assert.equal(new Set(lines.map((l) => l.seq)).size, lines.length, "seq 无重复");
  // upsert 语义保留: 同 id 的 wizard 重写 (占位→交付) 仍覆盖
  rec2.record(c, { at: T0B + 2000, id: "dd60#w", author: "fix", kind: "wizard", text: "最终交付" });
  assert.equal(rec2.lines(c).find((l) => l.id === "dd60#w")?.text, "最终交付", "同 id wizard 行仍 upsert");
}

// ── P7-S3c ②: strict 群入消息正文 = 账本原文 (rawQuery), 逐字一致 ──
import { renderMsg } from "../shared/role-render.js";
{
  const RAW = "帮我看个报错";
  const ENVELOPE = '\n<system-reminder wezard="hint">\n提示\n</system-reminder>'; // 真 reminder 形态 (splitReminders 剥的就是它)
  const humanTurn = turn({ id: "th1", target: "chat:wrS#fix", channel: STRICT, userQuery: RAW + ENVELOPE, rawQuery: RAW,
    items: [] });
  const oldTurn = turn({ id: "th2", target: "chat:wrS#fix", channel: STRICT, userQuery: RAW + ENVELOPE, items: [] }); // 老数据: 无 rawQuery
  const implicitTurn = turn({ id: "th3", target: "chat:wrS#fix", channel: PLAIN, userQuery: RAW + ENVELOPE, rawQuery: RAW, items: [] });
  const recs: DetailRecord[] = [humanTurn, oldTurn, implicitTurn];
  const dir2 = makeDirectory(recs, facts);
  const msgs2 = allMessages(recs, 5000, dir2.canon, dir2.strictChats);
  const mdOf = (m: { html: string }): string => (m.html.match(/md-src">([\s\S]*?)<\/script>/) ?? [])[1] ?? "";
  const in1 = msgs2.find((m) => m.id === "th1:in")!;
  assert.equal(mdOf(renderMsg(in1, recs, dir2, 5000)), RAW, "strict 群 in-msg 逐字 === 账本原文 (rawQuery)");
  const in2 = msgs2.find((m) => m.id === "th2:in")!;
  assert.ok(mdOf(renderMsg(in2, recs, dir2, 5000)).length > 0, "老数据回落 userQuery 不为空");
  assert.equal(mdOf(renderMsg(in2, recs, dir2, 5000)), RAW, "回落体 = 剥尾后的 userQuery (旧行为)");
  const in3 = msgs2.find((m) => m.id === "th3:in")!;
  assert.equal(mdOf(renderMsg(in3, recs, dir2, 5000)), RAW, "implicit 群照旧走 userQuery+splitReminders (不受 rawQuery 影响)");
}
rmSync(tmp, { recursive: true, force: true });
console.log("strict-detail: 出气泡=实发内容(逐字) / 沉默轮零气泡 / implicit 回归 / 老数据兼容 / post 按 id 去重 / #w 命名空间 / in-msg=账本原文");
