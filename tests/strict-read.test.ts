// v3 P7-S3 ④ 读侧: read_chat 的 strict 账本面 (golden 逐行一致) / roster L0 成员欠账面 /
// members.chats / governance 透传。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatRecords } from "../daemon/chat-records.js";
import { openMembers } from "../daemon/members.js";
import { renderChatRecords, type ChatLine } from "../shared/chat-record.js";
import { rosterL0, rosterCensus, type RosterRow } from "../daemon/wizard.js";
import { withData, EMPTY_FACTS, type WorldFacts } from "../shared/world.js";

const tmp = mkdtempSync(join(tmpdir(), "strict-read-"));

// ── 1. strict 账本面 golden: 手写的期望行 vs renderChatRecords, 逐行一致 ──
const rec = new ChatRecords({ dir: join(tmp, "chats"), keepDays: 30, maxLines: 2000 });
const base = "chat:wrG";
const T0 = Date.now() - 60_000; // 账本按 keepDays 剪旧行, 时间要落在保留窗内
const mk = (seq: number, author: string, kind: ChatLine["kind"], text: string, at = T0 + seq * 1000): ChatLine =>
  rec.record(base, { at, id: "m" + seq, author, kind, text });
mk(1, "alice", "human", "帮我看个报错");
mk(2, "wezard", "system", "[wezard] fix 入群 (mention, 由人带入)");
mk(3, "fix", "wizard", "看过了, 是配置问题");
mk(4, "alice", "human", "多行长文 " + "x".repeat(600));
mk(5, "fix", "wizard", "修好了");

{
  const view = renderChatRecords(rec.lines(base), { limit: 30, per: 500 });
  assert.equal(view.shown, 5);
  assert.equal(view.total, 5);
  const golden = [
    "[1] alice: 帮我看个报错",
    "[2] wezard: [wezard] fix 入群 (mention, 由人带入)",
    "[3] fix: 看过了, 是配置问题",
    "[4] alice: " + ("多行长文 " + "x".repeat(600)).slice(0, 500) + "…(+N)",
    "[5] fix: 修好了",
  ];
  assert.deepEqual(view.text.split("\n"), golden, "read_chat strict 面与 chat-records golden 逐行一致");
  assert.equal(view.earlier, undefined, "全量显示时无翻页提示");
  assert.equal(view.later, undefined);
}

// 作者过滤 (role/target 裸名, 剥前导 .) 与 limit/翻页。
{
  const byFix = renderChatRecords(rec.lines(base), { names: [".fix"], limit: 30 });
  assert.deepEqual(byFix.text.split("\n"), ["[3] fix: 看过了, 是配置问题", "[5] fix: 修好了"]);
  const paged = renderChatRecords(rec.lines(base), { limit: 2 });
  assert.equal(paged.shown, 2);
  assert.equal(paged.total, 5);
  assert.ok(paged.earlier, "回最新的 N 条 → 给往回翻页的 until");
  assert.equal(paged.later, undefined, "最新窗口没有「往后」");
  const fwd = renderChatRecords(rec.lines(base), { since: T0 + 1000, limit: 2 });
  assert.equal(fwd.shown, 2);
  assert.ok(fwd.later, "since 窗口 → 给往后翻页的 since");
  assert.equal(renderChatRecords(rec.lines(base), { since: T0 + 3000, until: T0 + 5000 }).shown, 2, "时间窗过滤");
}

// ── 2. roster L0 strict 面: 在场 = 本群成员 + 欠账数, 总行数 ≤ 12 ──
const row = (target: string): RosterRow => ({ target, name: target, address: target, description: "", cwd: "", chat: "", cli: "", busy: false, alive: true, lastActivity: Date.now() } as unknown as RosterRow);
const census = rosterCensus([row("chat:wrG#me")]);
const members = [
  { name: "me", mode: "owner", owed: 0 },
  { name: "fix", mode: "speaker", owed: 2 },
  { name: "docs", mode: "mention", owed: 0 },
  { name: "audit", mode: "mention", owed: 1 },
];
{
  const text = rosterL0([row("chat:wrG#me")], { base, now: Date.now(), census, members });
  const lines = text.split("\n");
  assert.ok(lines.length <= 12, "L0 ≤ 12 行 (验收数字④)");
  assert.equal(lines.filter((l) => l.startsWith(".")).length, 4, "成员行数 = members.json 行数");
  assert.ok(lines[0]!.includes("(owner)"), "owner 在第一行");
  assert.ok(lines[1]!.includes("欠 2"), "speaker 带欠账数");
  assert.ok(text.includes("全机 "), "尾行仍是全机普查");
  // 30 个成员也 ≤ 12 行, 截断有提示。
  const many = rosterL0([row("chat:wrG#me")], { base, now: Date.now(), census,
    members: Array.from({ length: 30 }, (_, i) => ({ name: "w" + i, mode: "mention", owed: 0 })) });
  assert.ok(many.split("\n").length <= 12, "30 成员仍 ≤ 12 行");
  assert.ok(many.includes("成员 30 个"), "截断提示给全量入口");
}

// ── 3. members.chats(): 有成员表的全部聊天键 ──
{
  const ms = openMembers(join(tmp, "members.json"));
  ms.join("chat:wrA", "chat:wrA#a", "mention", "human:u");
  ms.join("chat:wrB", "chat:wrB#b", "speaker", "human:u");
  ms.join("chat:wrA", "chat:wrA#c", "mention", "human:u");
  assert.deepEqual(ms.chats().sort(), ["chat:wrA", "chat:wrB"]);
}

// ── 4. governance 随 WorldFacts 透传 (withData 不丢) ──
{
  const facts: WorldFacts = { ...EMPTY_FACTS, absent: undefined,
    governance: [{ chat: "chat:wrG", members: [{ name: "fix", mode: "speaker", cursor: 5, owed: 1, passed: 2, overdue: 0 }] }] };
  const kept = withData(facts, [], Date.now());
  assert.equal(kept.governance?.length, 1, "withData 透传 governance");
  assert.equal(kept.governance![0]!.members[0]!.cursor, 5);
}

rmSync(tmp, { recursive: true, force: true });
console.log("strict-read: 账本 golden 逐行一致 / L0 成员+欠账 ≤12 行 / members.chats / governance 透传");
