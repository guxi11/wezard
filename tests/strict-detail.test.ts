// v3 P7-S3b: rolepage 群窗的账本口径 —— strict 群一轮的出消息照旧 (工具调用进过程框),
// 只有气泡换成实发 (post 记录并进它那一轮); 没有实发的轮退回 CLI 终句, 与非 strict 同口径。
// 断言: ① 气泡文本 === 实发文本 (逐字), CLI 原话留在过程框 (aside) ② 工具调用不丢
//      ③ 归不进任何轮的 post 仍独立成条 ④ implicit 群不受影响 ⑤ post 按 id 去重。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { allMessages, makeDirectory, messageOfPost, messagesOfTurn, strictPostsOf } from "../shared/role-view.js";
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

// ── 1. messagesOfTurn: strict 群没有实发的轮 = 非 strict 口径 (出消息在, 终句当气泡) ──
const strictChats = dir.strictChats;
const ix0 = strictPostsOf(records, strictChats);
assert.equal(messagesOfTurn(records[0] as TurnDetailRecord, undefined, ix0).some((m) => m.dir === "out"), true, "strict 群无实发: 出消息照旧 (不再整段压掉)");
assert.equal(messagesOfTurn(records[0] as TurnDetailRecord, undefined, ix0).some((m) => m.dir === "in"), true, "strict 群: 问话入消息保留");
assert.equal(messagesOfTurn(records[1] as TurnDetailRecord, undefined, ix0).some((m) => m.dir === "out"), true, "implicit 群: 出气泡照旧");
assert.equal(messagesOfTurn(records[2] as TurnDetailRecord, undefined, ix0).some((m) => m.dir === "out"), true, "私聊: 出气泡照旧");

// ── 2. 有实发的 strict 轮: 一条出消息, 工具调用进过程框, 气泡 = 实发逐字, CLI 原话 aside ──
const LEDGER_TEXT = "看过了, 是配置问题"; // 同一字符串既进账本 (ChatLine.text) 又进 post (body)
const tooled = turn({ id: "t5", target: "chat:wrS#fix", channel: STRICT, createdAt: 10_000, updatedAt: 14_000, items: [
  { t: "tool_use", toolUseId: "u1", toolName: "Read", toolInput: { file_path: "/x.ts" }, ts: 11_000 },
  { t: "tool_result", toolUseId: "u1", body: "file body", ts: 11_500 },
  { t: "tool_use", toolUseId: "u2", toolName: "mcp__wezard__chat_reply", toolInput: { re: "h1", text: LEDGER_TEXT }, ts: 12_000 },
  { t: "tool_result", toolUseId: "u2", body: "{\"ok\":true}", ts: 13_000 },
  { t: "text", body: "已用 chat_reply 回了 (CLI 终句)", ts: 13_500, final: true },
] });
const post: DetailRecord = { kind: "post", id: "msg-stream-1#w", createdAt: 12_500, target: "chat:wrS#fix", channel: STRICT, body: LEDGER_TEXT };
const stray: DetailRecord = { kind: "post", id: "stray#w", createdAt: 500_000, target: "chat:wrS#fix", channel: STRICT, body: "很久以后落账的一句" };
const all = [...records, tooled, post, stray];
const ix = strictPostsOf(all, strictChats);
assert.equal(ix.hostOf.get("msg-stream-1#w"), "t5", "实发归到当时正跑着、在该群答话的那一轮");
assert.equal(ix.hostOf.has("stray#w"), false, "轮次收口很久之后才落账的 post 不归轮");
const msgs = allMessages(all, 600_000, dir.canon, strictChats);
const out5 = msgs.filter((m) => m.turn.id === "t5" && m.dir === "out");
assert.equal(out5.length, 1, "t5 一条出消息");
assert.equal(msgs.some((m) => m.id === "msg-stream-1#w:out"), false, "并进轮次的 post 不再独立成条");
assert.equal(msgs.filter((m) => m.id === "stray#w:out").length, 1, "归不进轮的 post 仍独立成条");
const html = renderMsg(out5[0]!, all, makeDirectory(all, facts), 600_000).html;
assert.equal((html.match(/class="say"/g) ?? []).length, 1, "只有一颗气泡");
const sayAt = html.indexOf('class="say"');
assert.ok(html.slice(sayAt).includes(LEDGER_TEXT), "气泡正文 = 实发文本");
assert.ok(html.includes("2 次工具调用"), "两次工具调用都进过程框");
assert.equal((html.match(/class="steps[ "]/g) ?? []).length, 1, "只有一个过程框: 工具调用与 CLI 原话聚在一起");
const boxAt = html.indexOf('class="steps');
assert.ok(boxAt < sayAt, "实发气泡在过程框之下, 是这一轮的最后一条");
assert.ok(/bubble note aside[^>]*>[\s\S]*CLI 终句/.test(html.slice(boxAt, sayAt)), "CLI 原话 (aside) 在过程框里, 不丢");
// 还在跑的轮: 实发一落账就是气泡 (posted), 不等收口; 仍排在最后
const running = { ...tooled, id: "t7", closed: false, updatedAt: 13_600, items: tooled.items.map((i) => ({ ...i, ...(i.t === "text" ? { final: false } : {}) })) } as TurnDetailRecord;
const runPost: DetailRecord = { ...post, id: "p7#w" } as DetailRecord;
const runAll = [running, runPost];
const m7 = messagesOfTurn(running, undefined, strictPostsOf(runAll, strictChats)).find((m) => m.dir === "out")!;
assert.equal(m7.turn.items.at(-1)?.t === "text" && (m7.turn.items.at(-1) as { posted?: boolean }).posted, true, "实发排在最后");
const html7 = renderMsg(m7, runAll, makeDirectory(runAll, facts), 13_700).html;
assert.ok(html7.indexOf('class="say"') > html7.indexOf('class="steps'), "进行中: 实发气泡在过程框之下");
assert.equal(out5[0]!.turn.items.filter((i) => i.t === "text" && i.final).length, 1, "收口判定 (final) 不变");

// ── 3. 实发与 CLI 终句同文: 并成一颗气泡, 不重复 ──
const echoTurn = turn({ id: "t6", target: "chat:wrS#fix", channel: STRICT, createdAt: 20_000, updatedAt: 21_000,
  items: [{ t: "text", body: LEDGER_TEXT, ts: 20_900, final: true }] });
const echoPost: DetailRecord = { kind: "post", id: "p6#w", createdAt: 20_950, target: "chat:wrS#fix", channel: STRICT, body: LEDGER_TEXT };
const m6 = messagesOfTurn(echoTurn, undefined, strictPostsOf([echoTurn, echoPost], strictChats)).find((m) => m.dir === "out")!;
assert.deepEqual(m6.turn.items.map((i) => [i.t, (i as { aside?: boolean }).aside ?? false, (i as { final?: boolean }).final ?? false]), [["text", false, true]], "同文并进实发, final 跟过去");

// ── 3a. 实发记在身份锚点上、轮次记在本群化身上 (2026-11-17 study 答 hi): 按 canon 认同一个人 ──
const anchorPost: DetailRecord = { kind: "post", id: "pa#w", createdAt: 30_500, target: "chat:wrAnchor", channel: STRICT, body: "在，我是这个群的管家" };
const manifTurn = turn({ id: "t8", target: STRICT, channel: STRICT, createdAt: 30_000, updatedAt: 31_000,
  items: [{ t: "text", body: "已回复。", ts: 30_900, final: true }] });
const canon = (id: string) => (id === STRICT ? "chat:wrAnchor" : id);
const ix8 = strictPostsOf([manifTurn, anchorPost], strictChats, canon);
assert.equal(ix8.hostOf.get("pa#w"), "t8", "身份锚点的 post 并进本群化身的那一轮");
assert.equal(strictPostsOf([manifTurn, { ...anchorPost }], strictChats).hostOf.size, 0, "不给 canon 就认不出 (对照)");
// 群里那条带「🧙‍♂️ name：」署名, rolepage 气泡里剥掉 (消息行已写着是谁)
const signed = { ...anchorPost, id: "ps#w", body: "\uD83E\uDDD9\u200D\u2642\uFE0F study： 在，我是这个群的管家" } as DetailRecord;
const m8 = messagesOfTurn(manifTurn, undefined, strictPostsOf([manifTurn, signed], strictChats, canon)).find((m) => m.dir === "out")!;
assert.equal((m8.turn.items.at(-1) as { body: string }).body, "在，我是这个群的管家");

// ── 3b. messageOfPost: post 的合成 turn 只含实发正文 ──
const pm = messageOfPost(stray as Extract<typeof stray, { kind: "post" }>);
assert.equal(pm.turn.items.filter((i) => i.t === "text").map((i: any) => i.body).join(""), "很久以后落账的一句");
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
console.log("strict-detail: 气泡=实发内容(逐字) / 工具调用进过程框 / CLI 原话 aside / implicit 回归 / 老数据兼容 / post 按 id 去重 / #w 命名空间 / in-msg=账本原文");