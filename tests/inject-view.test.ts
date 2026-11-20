// 守护进程中转的注入消息 (room 唤醒) 在 rolepage 上的归位。
//
// 真实故障: dm room 里 DavidPrice 的 chat_reply 被守护进程贴进 wezard-15 的输入框,
// chat detail 上画成「群 … · wezard → wezard-1」的一整段原文 —— 作者 / room 都退回了
// 「系统 → home 群」, 换行被注入压平。
//
// 验收: 注入头里的 room 认回 dm (有名字用名字), 作者认回原作者, 正文按账本行全文
// (保留换行), 注入原文一字不动地折在「注入原文」里; 多个 room 块逐条拆开。
import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import { URL } from "node:url";
import { createChatRoutes, type SimpleHandler } from "../shared/chat-http.js";
import type { DetailStore, TurnDetailRecord } from "../shared/detail-store.js";
import type { WorldFacts } from "../shared/world.js";
import { buildRoomFacts } from "../shared/room-view.js";
import { renderMsgLine } from "../shared/room.js";
import { wizardStream } from "../shared/role-render.js";
import { makeDirectory } from "../shared/role-view.js";
import { parseInjection } from "../shared/inject-view.js";
import { H, W, dmRoomId, room, say, uid } from "./room-fixture.js";

const A = W(uid(1)), B = W(uid(2)), H1 = H("U1");
const now = Date.now();
const G = room("chat:wrG", [A, H1, B], now - 9000);
const DM = room(dmRoomId(A.id, B.id), [A, B], now - 8000);
const NAMES = { nameOf: (w: { kind: string; id: string }) => w.kind === "wizard" ? (w.id === A.id ? "alice" : "bob") : "U1", roomLabel: (r: string) => r === DM.id ? "alice ↔ bob" : "群G" };

const ask = say(DM, { author: A, kind: "ask", text: "改一下 rolepage", to: [B] }, { now: now - 7000 });
const reply = say(DM, { author: B, kind: "reply", text: "已完成, commit 90d4f04。\n\n改了什么:\n- 成员列挪到最右\n- host 标记换位置", re: [ask.id], status: "done" }, { now: now - 6000 });
const inGroup = say(G, { author: H1, kind: "say", text: "顺便看下群里的这句", origin: "inbound" }, { now: now - 5000 });
const inGroup2 = say(G, { author: B, kind: "say", text: "第二行", origin: "tool" }, { now: now - 4900 });

// 守护进程真正贴进输入框的那段 (格式由 room-hub.render + renderMsgLine 决定)。
const injection = "【alice ↔ bob】(" + DM.id + ")\n" + renderMsgLine(reply, NAMES)
  + "\n你要交代: " + reply.id + " (task, 来自 bob) —— 用 chat_reply({re, text, status}) 交代。"
  + "\n\n【群G】(chat:wrG)\n" + renderMsgLine(inGroup, NAMES, 100_000) + "\n" + renderMsgLine(inGroup2, NAMES, 100_000);

const turn: TurnDetailRecord = {
  kind: "turn", id: "t1", createdAt: now - 4000, updatedAt: now - 1000, closed: true,
  target: "chat:wrG#guide", sessionId: "s1",
  // 故障现场: 注入开出的轮记的是「home 群的频道」, 没有 from —— 视图不能拿它当出处。
  channel: "chat:wrG", userQuery: injection,
  items: [{ t: "text", body: "收到", ts: now - 1000, final: true }],
} as TurnDetailRecord;

const store = { get: (id: string) => (id === "t1" ? turn : undefined), list: () => [turn] } as unknown as DetailStore;
const facts: WorldFacts = {
  wizards: [
    { target: "chat:wrG#guide", name: "alice", uid: A.id, description: "", chat: "群G", cwd: "/w", model: "x", cli: "codebuddy", busy: false, alive: true, bornAt: now - 9000, lastActivity: now, summary: "" },
    { target: "chat:wrG#bob", name: "bob", uid: B.id, description: "", chat: "群G", cwd: "/w", model: "x", cli: "codebuddy", busy: false, alive: true, bornAt: now - 9000, lastActivity: now, summary: "" },
  ],
  rooms: buildRoomFacts([G, DM], NAMES), plans: [], schedules: [],
  chatNames: { "chat:wrG": "群G" }, names: { [A.id]: "alice", [B.id]: "bob" }, humanNames: { "human:U1": "U1" },
} as WorldFacts;

const get = (handler: SimpleHandler, query: string): Promise<any> => new Promise((resolve) => {
  const res = { setHeader() {}, end: (body: string) => resolve(JSON.parse(body)) } as unknown as ServerResponse;
  handler({ headers: {} } as IncomingMessage, res, new URL("http://x/?" + query));
});

const ledgerRow = (id: string) => [...DM.msgs, ...G.msgs].find((m) => m.id === id);

// ── 纯解析: 多块 / 原文可逆 ────────────────────────────────────────────
const parsed = parseInjection(injection)!;
assert.equal(parsed.length, 2, "两个 room 块逐条拆开");
assert.equal(parsed[0]!.room, DM.id, "块头里的 room id");
assert.equal(parsed[0]!.lines[0]!.id, reply.id);
assert.equal(parsed[0]!.lines[0]!.author, "bob");
assert.deepEqual(parsed[0]!.lines[0]!.re, [ask.id]);
assert.equal(parsed[0]!.lines[0]!.status, "done");
assert.deepEqual(parsed[0]!.owe, [reply.id], "「你要交代」点到的消息 id");
assert.ok(parsed[0]!.raw.includes("你要交代: " + reply.id), "块原文含你要交代那一行 (可逆)");
assert.equal(parsed[0]!.raw, injection.split("\n\n")[0], "原文逐字未改");
assert.equal(parseInjection("随便一句话"), undefined, "不是注入就不拆");

const run = async (): Promise<void> => {
  // ① 账本读得到时: 唤醒它的账本行按账本画, 注入原文不再重复成一条。
  const ledger = { ids: () => [G.id, DM.id], get: (id: string) => (id === G.id ? G : id === DM.id ? DM : undefined) };
  const routes = createChatRoutes(store, () => facts, undefined, ledger);
  const w = await get(routes.wizard, "id=t1&role=chat:wrG%23guide");
  assert.equal(w.stream.filter((r: { kind: string }) => r.kind === "in").length, 0, "账本行已画: 注入不重复画");
  assert.equal(w.stream.filter((r: { kind: string }) => r.kind === "ledger").length, 2, "两条账本行各自成条");

  // ② 账本给不出 (页 id 不是任何 target 的 uid / svr 没有这条账本) 时: 注入自己就是全部证据,
  //    按块解析出场 —— 作者 / room / 收件人都归位, 正文回账本取全文。
  const dir = makeDirectory([turn], facts);
  const rows = wizardStream([turn], "chat:wrG#guide", dir, now, {
    msgs: [], woke: [], roomLabel: NAMES.roomLabel, chatLabel: () => "", lookup: ledgerRow,
    repliesOf: () => [], roomFrom: now - 20_000,
  });
  const ins = rows.filter((r) => r.kind === "in");
  assert.equal(ins.length, 3, "一次输入里的三条注入各成一条消息");
  const dm = ins[0]!;
  assert.equal(dm.from, "chat:wrG#bob", "作者认回 .DavidPrice 那一侧, 不是系统");
  assert.equal(dm.fromName, "bob");
  assert.equal(dm.to, "chat:wrG#guide", "收件人是这一轮真正的主人, 不是 home 群");
  assert.equal(dm.toName, "alice");
  assert.equal(dm.room, DM.id, "room 认回 dm");
  assert.equal(dm.roomLabel, "alice ↔ bob", "有名字就用名字");
  assert.equal(dm.text, reply.text, "正文取账本行全文 (保留换行)");
  assert.ok(dm.text!.includes("\n"), "换行没有丢");
  assert.equal(dm.inj!.id, reply.id);
  assert.deepEqual(dm.inj!.re, [ask.id]);
  assert.equal(dm.inj!.status, "done");
  assert.ok(dm.inj!.raw && dm.inj!.raw.startsWith("【alice ↔ bob】(" + DM.id + ")"), "注入原文可点开看 (逐字)");
  assert.deepEqual(dm.tags, ["要交代 " + reply.id], "提醒挂在块的最后一条上");
  const grp = ins[1]!;
  assert.equal(grp.from, "human:U1", "群里那句的作者");
  assert.equal(grp.room, "chat:wrG");
  assert.equal(grp.roomLabel, "群G");
  assert.ok(grp.inj!.raw && grp.inj!.raw.startsWith("【群G】(chat:wrG)"), "第二块也有自己的原文");
  assert.equal(ins[2]!.inj!.raw, undefined, "原文只在每块第一条上挂一次");
  assert.equal(rows.filter((r) => r.kind === "out").length, 1, "出消息还是这一轮");
  // 只带一个 room 块的注入: 这一轮的头部也落到那个 room (轮的 channel 是投递兜底, 不是出处)。
  const solo = { ...turn, userQuery: injection.split("\n\n")[0]! };
  const soloRows = wizardStream([solo], "chat:wrG#guide", dir, now, {
    msgs: [], woke: [], roomLabel: NAMES.roomLabel, chatLabel: () => "", lookup: ledgerRow,
    repliesOf: () => [], roomFrom: now - 20_000,
  });
  assert.equal(soloRows.find((r) => r.kind === "out")!.room, DM.id, "单块注入: 出消息的 room 归 dm, 不是 home 群");
  // ③ 账本全文带 <system-reminder> 信封时: 正文不外露原文, 折叠标签进 rems。
  const REM = '<system-reminder wezard="roster">花名册 secret-roster-body</system-reminder>';
  const dirty = (id: string) => { const r = ledgerRow(id); return r && id === reply.id ? { ...r, text: r.text + "\n" + REM } : r; };
  const dirtyRows = wizardStream([turn], "chat:wrG#guide", dir, now, {
    msgs: [], woke: [], roomLabel: NAMES.roomLabel, chatLabel: () => "", lookup: dirty,
    repliesOf: () => [], roomFrom: now - 20_000,
  }).filter((r) => r.kind === "in");
  assert.ok(!dirtyRows[0]!.text!.includes("<system-reminder"), "text 不含 reminder 原文");
  assert.ok(dirtyRows[0]!.text!.includes(reply.text.split("\n")[0]!), "正文仍在");
  assert.ok(dirtyRows[0]!.rems && dirtyRows[0]!.rems.includes("roster"), "rems 有折叠标签");
  console.log("inject-view: 注入按块拆开 / 作者与 room 归位 / 正文换行 / 原文可逆");
};

await run();
