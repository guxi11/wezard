// v3 P4 (§4 roster 金字塔): 判据全部数值化 —— L0 行数/成员数/活跃窗/字符预算, L1/L2 行数与
// 字符预算, 溢出截断提示, census 去重; charter 出生名册 ROSTER_MAX 15→8。
import assert from "node:assert/strict";
import {
  renderCharter,
  rosterCensus,
  rosterL0,
  rosterL1,
  rosterL2,
  ROSTER_L0_ACTIVE_MS,
  ROSTER_L0_MAX_LINES,
  ROSTER_L1_MAX_LINES,
  ROSTER_L2_MAX_LINES,
  ROSTER_L2_CHARS,
  type CharterArgs,
  type RosterRow,
} from "../daemon/wizard.js";

const NOW = 1_800_000_000_000;
const row = (o: Partial<RosterRow> & { target: string }): RosterRow => ({
  name: o.name ?? o.target.split("#")[1] ?? "x",
  address: o.name ?? o.target.split("#")[1] ?? "x",
  description: "",
  cwd: "",
  chat: "群A",
  solo: false,
  busy: false,
  alive: true,
  self: false,
  lastActivity: NOW,
  summary: "",
  clones: [],
  ...o,
});
const lines = (s: string): string[] => s.split(String.fromCharCode(10));

// ── 1. L0: 行数硬顶、成员构成、48h 窗口、census 行 ──────────────────────
{
  const flood = Array.from({ length: 50 }, (_, i) =>
    row({ target: "chat:A#w" + i, name: "w" + i, lastActivity: NOW - i * 60_000 }));
  const stale = row({ target: "chat:A#old", name: "old", lastActivity: NOW - ROSTER_L0_ACTIVE_MS - 1 });
  const foreign = row({ target: "chat:B#far", name: "far", lastActivity: NOW });
  const apprentice = row({ target: "chat:Z#app", name: "app", kind: "apprentice", lastActivity: 0 });
  const me = row({ target: "chat:A#me", name: "me", self: true, lastActivity: 0 });
  const steward = row({ target: "chat:A", name: "steward", lastActivity: 0 });
  const text = rosterL0([...flood, stale, foreign, apprentice, me, steward], {
    base: "chat:A", stewardTarget: "chat:A", now: NOW, census: rosterCensus([me, steward]),
  });
  const ls = lines(text);
  assert.ok(ls.length <= ROSTER_L0_MAX_LINES, "L0 总行数 ≤ " + ROSTER_L0_MAX_LINES + ", 实际 " + ls.length);
  assert.ok(ls.some((l) => l.includes("me")), "自己在场");
  assert.ok(ls.some((l) => l.includes("steward")), "本群管家在场");
  assert.ok(ls.some((l) => l.includes("app")), "学徒永远在场 (即使不活跃)");
  assert.ok(!text.includes("old"), "48h 外的本群成员不进 L0");
  assert.ok(!text.includes("far"), "别的聊天不进 L0");
  assert.ok(ls.at(-1) === undefined || ls.some((l) => l.startsWith("全机 ")), "尾行是全机普查");
  assert.ok(ls.some((l) => l.includes("没列")), "溢出有截断提示 (50 个活跃 > 10 行上限)");
  // 排序: 自己最前。
  assert.ok(ls[0]!.includes("me"), "自己排第一行");
}

// ── 2. L1: 本群全量 (含冷), 行数上限含子行, 截断提示带总数 ───────────────
{
  const kin = Array.from({ length: 60 }, (_, i) =>
    row({ target: "chat:A#k" + i, name: "k" + i, description: "职责" + i, lastActivity: NOW - i * 60_000 }));
  const other = row({ target: "chat:B#far", name: "far" });
  const text = rosterL1([...kin, other], { base: "chat:A", now: NOW });
  const ls = lines(text);
  assert.ok(ls.length <= ROSTER_L1_MAX_LINES + 1, "L1 ≤ " + ROSTER_L1_MAX_LINES + " 行 (+1 截断提示)");
  assert.ok(!text.includes("far"), "别的聊天不进 L1");
  assert.ok(ls.at(-1)!.includes("共 60 个"), "截断提示带本群总数");
  assert.ok(text.includes("职责"), "L1 保留完整条目 (职责子行)");
}

// ── 3. L2: 每群一行、自己群最前、名字截断 +n、行数/字符双顶 ──────────────
{
  const chats = Array.from({ length: 80 }, (_, c) =>
    Array.from({ length: 7 }, (_, i) =>
      row({ target: "chat:C" + c + "#n" + i, name: "n" + c + "_" + i, chat: "群" + c, lastActivity: NOW - c * 60_000 - i * 1000 })));
  const mine = [row({ target: "chat:A#me", name: "me", chat: "群A", self: true })];
  const all = [...mine, ...chats.flat()];
  const text = rosterL2(all, { base: "chat:A", now: NOW });
  const ls = lines(text);
  assert.ok(ls.length <= ROSTER_L2_MAX_LINES + 1, "L2 ≤ " + ROSTER_L2_MAX_LINES + " 行 (+1 截断提示)");
  assert.ok(ls[0]!.startsWith("群A"), "自己的聊天最前");
  assert.ok(text.includes("+2"), "每群最多列 5 个名字, 其余 +n");
  assert.ok(!text.includes("▸") && !text.includes("职责"), "L2 无 summary/职责子行");
  assert.ok(text.length <= ROSTER_L2_CHARS + 200, "L2 字符预算 " + ROSTER_L2_CHARS + "+截断行");
  assert.ok(ls.at(-1)!.includes("共 81 群"), "截断提示带群总数");
}

// ── 4. census: 按 identity 去重 (多化身一个身份), 忙闲冷三态 ──────────────
{
  const rows = [
    row({ target: "chat:A#fix", name: "fix", identity: "chat:A#fix", busy: true }),
    row({ target: "chat:B#fix", name: "fix", identity: "chat:A#fix", alive: false }),
    row({ target: "chat:A", name: "g", identity: "chat:A" }),
  ];
  const c = rosterCensus(rows);
  assert.equal(c.identities, 2, "两化身同一身份算一个");
  assert.equal(c.chats, 2);
  assert.equal(c.busy, 1);
  assert.equal(c.idle, 1);
  assert.equal(c.cold, 1);
}

// ── 5. miss / degraded 提示行 ────────────────────────────────────────────
{
  const base = { base: "chat:A", stewardTarget: "chat:A", now: NOW, census: rosterCensus([]) } as const;
  const t1 = rosterL0([row({ target: "chat:A#me", name: "me", self: true })], { ...base, missHint: "「fix」不在本群在场名单" });
  assert.ok(t1.includes("「fix」不在本群"), "miss 提示进 L0");
  const t2 = rosterL0([row({ target: "chat:A#me", name: "me", self: true })], { ...base, degraded: "ctx 200k 已到交接线" });
  assert.ok(t2.includes("交接线"), "降级行进 L0");
  const t3 = rosterL0([row({ target: "chat:A#me", name: "me", self: true })], { ...base, missHint: "m", degraded: "d" });
  const hintLines = lines(t3).filter((l) => l.includes("m") && l.includes("不在") || l.includes("交接线"));
  assert.ok(hintLines.length <= 1, "提示至多一行 (不重复占预算)");
}

// ── 6. charter 出生名册: ROSTER_MAX 15 → 8 ───────────────────────────────
{
  const siblings = Array.from({ length: 20 }, (_, i) => ({
    name: "sib" + i, address: "sib" + i, description: "职责" + i, cwd: "/w",
  }));
  const charter = renderCharter({
    self: { name: "me", address: "me", description: "", cwd: "/w" },
    chat: "群A", principal: "chat:A", inherited: false, siblings, memory: [],
    chatMemory: "", workspaceMemory: "", steward: false, stewardBudget: 4,
    lead: false, tiers: [], topOnly: false,
  } satisfies CharterArgs);
  const shown = siblings.filter((s) => charter.includes(s.name));
  assert.ok(shown.length <= 8, "出生名册 ≤8 个 (v3 L0 快照), 实际 " + shown.length);
  assert.ok(charter.includes("另有 12 个"), "其余报个数指向 wizard_roster");
}

console.log("roster pyramid: L0 caps/membership/48h, L1 lines+total, L2 grouping+names, census dedup, hints, charter 8 all passed");
