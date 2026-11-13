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
const { getDetail } = await import("../daemon/detail.js");
assert.equal(getDetail("stream-9")?.kind, "post");
assert.ok((getDetail("stream-9") as { body?: string }).body?.includes("最终交付"), "同 id upsert: 留最终那句");

rmSync(tmp, { recursive: true, force: true });
console.log("strict-detail: 出气泡=实发内容(逐字) / 沉默轮零气泡 / implicit 回归 / 老数据兼容 / post 按 id 去重");
