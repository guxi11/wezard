// 迁移 (契约 §6): 源快照 → room 账本的行形状、join 顺序、游标映射与幂等。
// 覆盖: 绑定 room 的 open / join 顺序 (管家 → members 按 since → 近 7 天有轮次)、历史行的
// 作者解析 (重名取 bornAt 最新 / 缺 bornAt 的确定回退)、成员游标 → seen、未结 chat / wizard
// 路由、uncertain 归档、queued 事件、二次跑 0 行、源文件一字不动、--dry-run 不写。
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runMigrate } from "../cli/migrate-rooms.js";
import { dmRoomId, uidOf } from "../shared/room.js";

const NOW = 1_700_000_000_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
const WR_A = "chat:wrA";

const write = (file: string, text: string): void => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
};
const fileOfChat = (home: string, chat: string): string =>
  join(home, "state", "chats", encodeURIComponent(chat) + ".jsonl");

const SOURCES = [
  "wizards.json",
  "routes.jsonl",
  "state/members.json",
  "state/chats/" + encodeURIComponent(WR_A) + ".jsonl",
  "state/details.jsonl",
  "state/message-events.json",
];

/** 源文件的原样快照 (内容 + mtime): 迁移后必须一字不差。 */
const snapshot = (home: string): string[] =>
  SOURCES.map((f) => {
    const p = join(home, f);
    return f + "|" + statSync(p).mtimeMs + "|" + readFileSync(p, "utf8");
  });

// 账本在 <stateDir>/rooms (与 daemon 同一推导); 夹具把 stateDir 设成 <home>/state。
const readOps = (home: string, room: string): Array<Record<string, any>> => {
  const p = join(home, "state", "rooms", encodeURIComponent(room) + ".jsonl");
  return readFileSync(p, "utf8").split("\n").filter((l) => l.trim() !== "").map((l) => JSON.parse(l) as Record<string, any>);
};

const build = (home: string): void => {
  // 名册: Bob 两条记录重名 (wrB 更新); Carol 缺 bornAt; Dan 只在过期轮次里出现。
  write(join(home, "wizards.json"), JSON.stringify({
    [WR_A]: { target: WR_A, name: "Alice", description: "", bornAt: 1000 },
    "chat:wrA#bob": { target: "chat:wrA#bob", name: "Bob", description: "", bornAt: 2000 },
    "chat:wrB": { target: "chat:wrB", name: "bob", description: "", bornAt: 3000 },
    "user:u1": { target: "user:u1", name: "Carol", description: "" },
    "chat:wrZ": { target: "chat:wrZ", name: "Dan", description: "", bornAt: 4000 },
  }, null, 2));

  // 路由: e1 = 未结 chat 路由, e2 = 未结 wizard 路由, e3 已答 (不迁)。
  write(join(home, "routes.jsonl"), [
    { op: "open", at: 5000, event: "e1", owner: WR_A, receiver: { kind: "chat", channel: WR_A, message: "h1" }, deadlineAt: 0 },
    { op: "open", at: 5100, event: "e2", owner: "chat:wrA#bob", receiver: { kind: "wizard", to: WR_A, event: "h2" }, deadlineAt: 0 },
    { op: "open", at: 5200, event: "e3", owner: WR_A, receiver: { kind: "chat", channel: WR_A, message: "h3" }, deadlineAt: 0 },
    { op: "answer", at: 5300, event: "e3", outcome: { status: "done", body: "ok", rev: "r1" } },
  ].map((o) => JSON.stringify(o)).join("\n") + "\n");

  // 成员: Bob 在群里, 老游标 2。
  write(join(home, "state", "members.json"), JSON.stringify({
    [WR_A + "|chat:wrA#bob"]: { mode: "speaker", since: 1500, by: "human:u1", cursor: 2 },
  }, null, 2));

  // 群聊记录 (id 重复一次 = record 覆盖写也 append, 读侧只认最后一条)。
  const lines = [
    { chat: WR_A, seq: 1, at: 1000, id: "m1", author: "u1", kind: "human", text: "早" },
    { chat: WR_A, seq: 2, at: 2000, id: "m2", author: "bob", kind: "wizard", text: "在" },
    { chat: WR_A, seq: 3, at: 3000, id: "m3", author: "wezard", kind: "system", text: "[wezard] 入群" },
    { chat: WR_A, seq: 3, at: 3000, id: "m3", author: "wezard", kind: "system", text: "[wezard] 入群" },
    { chat: WR_A, seq: 4, at: 4000, id: "m4", author: "", kind: "system", text: "卡片" },
  ];
  write(fileOfChat(home, WR_A), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");

  // 轮次: Carol 一小时前在这个群说过话 → 成员; Dan 十天前 → 不是成员。
  write(join(home, "state", "details.jsonl"), [
    { kind: "turn", id: "t1", target: "user:u1", channel: WR_A, createdAt: NOW - HOUR, items: [] },
    { kind: "turn", id: "t2", target: "chat:wrZ", channel: WR_A, createdAt: NOW - 10 * DAY, items: [] },
  ].map((l) => JSON.stringify(l)).join("\n") + "\n");

  write(join(home, "state", "message-events.json"), JSON.stringify({
    h1: { id: "h1", target: WR_A, channel: WR_A, speaker: "user:u9", execution: "complete", exposure: "consumed", payload: { text: "问题一", human: { text: "问题一" } } },
    h2: { id: "h2", target: "chat:wrA#bob", channel: WR_A, speaker: "user:u9", execution: "open", exposure: "consumed", payload: { text: "帮我看看" } },
    h3: { id: "h3", target: WR_A, channel: WR_A, execution: "complete", exposure: "consumed", payload: { text: "早答了" } },
    q1: { id: "q1", target: WR_A, channel: WR_A, speaker: "user:u9", execution: "queued", exposure: "none", payload: { text: "排队的一句", human: { text: "排队的一句" } } },
    q2: { id: "q2", target: "chat:wrA#bob", execution: "queued", exposure: "none", payload: { text: "去干这个", peer: { from: { from: WR_A } } } },
    x1: { id: "x1", target: WR_A, execution: "uncertain", exposure: "none", payload: { text: "不确定" } },
  }, null, 2));
};

// ── 主运行 ─────────────────────────────────────────────────────────────
const home = mkdtempSync(join(tmpdir(), "room-mig-"));
build(home);
const before = snapshot(home);
const stewardOf = (chat: string): string | undefined => (chat === WR_A ? "Alice" : undefined);

const out = runMigrate({ home, stateDir: join(home, "state"), now: NOW, stewardOf });
const rpt = out.plan.report;

const uidA = uidOf({ target: WR_A, bornAt: 1000 });
const uidBobA = uidOf({ target: "chat:wrA#bob", bornAt: 2000 });
const uidBobB = uidOf({ target: "chat:wrB", bornAt: 3000 });
const uidCarol = uidOf({ target: "user:u1" });
const uidDan = uidOf({ target: "chat:wrZ", bornAt: 4000 });
const dm = dmRoomId(uidA, uidBobA);

const wrA = readOps(home, WR_A);

// ① 行形状: open 打头, 群按 wecom-group。
assert.equal(wrA[0]!.op, "open");
assert.equal(wrA[0]!.room, WR_A);
assert.equal(wrA[0]!.kind, "wecom-group");

// ② join 顺序: 管家 founder → members 按 since → 近 7 天有轮次; home ≠ 成员不全拉。
const joins = wrA.filter((o) => o.op === "join");
assert.deepEqual(joins.map((j) => [j.who.id, j.ord]), [[uidA, 1], [uidBobA, 2], [uidCarol, 3]]);
assert.ok(joins.every((j) => j.via === "migrate" && j.who.kind === "wizard"));
assert.ok(!joins.some((j) => j.who.id === uidDan), "过期轮次 (10 天前) 不算成员");

// ③ 历史行: seq 重排、作者/kind/speak/origin/ext。
const msgs = wrA.filter((o) => o.op === "msg");
assert.deepEqual(msgs.slice(0, 4).map((m) => m.seq), [1, 2, 3, 4]);
assert.deepEqual(msgs[0]!.author, { kind: "human", id: "u1" });
assert.equal(msgs[0]!.kind, "say");
assert.equal(msgs[0]!.speak, "human");
assert.equal(msgs[0]!.origin, "migrate");
assert.match(msgs[0]!.id, /^[0-9a-f]{8}\.1$/);
assert.ok(msgs[0]!.ext.startsWith("mig:") && msgs[0]!.ext.endsWith("|legacy:1"), "ext = 确定键 + 老 seq");
assert.deepEqual(msgs[1]!.author, { kind: "wizard", id: uidBobB }, "重名取 bornAt 最新的记录");
assert.equal(msgs[1]!.ord, 0, "不是本群成员的 wizard 行 ord=0");
assert.deepEqual([msgs[2]!.author.kind, msgs[2]!.kind, msgs[2]!.speak], ["daemon", "system", "daemon"]);
assert.equal(msgs[3]!.author.kind, "daemon", "空 author 的系统行 → daemon");
assert.ok(msgs.every((m) => Array.isArray(m.wake) && m.wake.length === 0));
assert.equal(rpt.history, 4, "重复 id 只算一行 (record 覆盖写)");

// ④ 成员游标: 老 seq 2 → 新 seq 2 的 seen 行; 没有老游标的人 (管家 / 近 7 天才进来的)
// 直接落到历史末尾 —— 迁移进来的历史不该被重新喂一遍。
const seen = wrA.filter((o) => o.op === "seen");
assert.deepEqual(seen.map((s) => [s.who.id, s.seq]), [[uidBobA, 2], [uidA, 4], [uidCarol, 4]]);

// ⑤ 未结 chat 路由 → 该群一条人话, 点名 owner。
const routeMsg = msgs.find((m) => String(m.ext).endsWith("|legacy:e1"))!;
assert.ok(routeMsg, "未结 chat 路由迁成 msg");
assert.deepEqual(routeMsg.author, { kind: "human", id: "u9" });
assert.deepEqual(routeMsg.to, [{ kind: "wizard", id: uidA }]);
assert.equal(routeMsg.text, "问题一");
assert.equal(routeMsg.origin, "inbound", "不开 duty / 不回镜的那一类 origin");
assert.ok(!msgs.some((m) => String(m.ext).endsWith("|legacy:e3")), "已答路由不迁");

// ⑥ 未结 wizard 路由 → dm room 一条 task (author=派活方, to=owner)。
assert.match(dm, /^dm:w[0-9a-f]{12}\|w[0-9a-f]{12}$/, "dm id 只含 uid");
const dmOps = readOps(home, dm);
assert.equal(dmOps[0]!.op, "open");
assert.equal(dmOps[0]!.kind, "dm");
assert.deepEqual(dmOps.filter((o) => o.op === "join").map((j) => j.who.id), [uidA, uidBobA], "派活方 ord=1");
const dmMsgs = dmOps.filter((o) => o.op === "msg");
assert.equal(dmMsgs.length, 2);
assert.deepEqual([dmMsgs[0]!.kind, dmMsgs[0]!.author.id, dmMsgs[0]!.to[0].id], ["task", uidA, uidBobA]);
assert.equal(dmMsgs[0]!.text, "帮我看看");
assert.equal(dmMsgs[0]!.origin, "tool");

// ⑦ queued 事件: 人话进群, 派活进 dm; uncertain 原样归档。
const queued = msgs.find((m) => String(m.ext).endsWith("|legacy:q1"))!;
assert.ok(queued, "queued 人话迁成 msg");
assert.equal(queued.text, "排队的一句");
assert.equal(queued.author.id, "u9");
assert.equal(dmMsgs[1]!.text, "去干这个");
assert.deepEqual([dmMsgs[1]!.author.id, dmMsgs[1]!.to[0].id], [uidA, uidBobA]);
const archived = JSON.parse(readFileSync(join(home, "state", "rooms", "_archive", "message-events-uncertain.json"), "utf8")) as Array<{ id: string }>;
assert.deepEqual(archived.map((e) => e.id), ["x1"]);

// ⑧ 报表。
assert.deepEqual(rpt.routes, { chat: 1, wizard: 1 });
assert.deepEqual(rpt.events, { uncertain: 1, queuedHuman: 1, queuedPeer: 1, skipped: 3 });
assert.deepEqual(rpt.duplicateNames, ["bob"]);
assert.deepEqual(rpt.unknownWizards, []);
assert.equal(rpt.joins, 5, "wrA 三条 + dm 两条");
assert.equal(rpt.seen, 3);
assert.equal(rpt.writes, out.written);
assert.ok(out.written > 0);

// ⑨ 二次跑: 0 行, 账本一字不动, 源也一字不动。
const roomsBefore = new Map([WR_A, dm].map((r) => [r, readFileSync(join(home, "state", "rooms", encodeURIComponent(r) + ".jsonl"), "utf8")]));
const again = runMigrate({ home, stateDir: join(home, "state"), now: NOW + 1000, stewardOf });
assert.equal(again.written, 0, "二次跑写 0 行");
assert.deepEqual(again.plan.rooms, [], "没有任何 room 需要追加");
assert.ok(again.plan.report.duplicate > 0, "跳过的是已有确定键");
for (const [r, text] of roomsBefore) {
  assert.equal(readFileSync(join(home, "state", "rooms", encodeURIComponent(r) + ".jsonl"), "utf8"), text, "账本不变: " + r);
}
assert.deepEqual(snapshot(home), before, "源文件内容与 mtime 一字不动");

// ⑩ --dry-run: 只出报表, 连 rooms/ 都不建。
const dryHome = mkdtempSync(join(tmpdir(), "room-mig-dry-"));
build(dryHome);
const dryBefore = snapshot(dryHome);
const dry = runMigrate({ home: dryHome, stateDir: join(dryHome, "state"), now: NOW, dryRun: true, stewardOf });
assert.ok(dry.plan.report.writes > 0, "dry-run 照样算出要写多少");
assert.equal(dry.written, 0);
assert.equal(existsSync(join(dryHome, "state", "rooms")), false, "dry-run 不建目录、不写文件");
assert.deepEqual(snapshot(dryHome), dryBefore, "dry-run 也不碰源");

console.log("room-migrate: all assertions passed");
