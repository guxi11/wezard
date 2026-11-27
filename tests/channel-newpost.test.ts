// 频道开新帖 (docs/evolve/channel-topic-rooms.md §3.2 / §9-③): chat_say({room:"chat:<topic_id>"}) ——
//   ① 虚地址判定: 只有「频道本身」(chat:<T>) 算, 旧 chat:<opk> 帖子 room / 非频道 / topic room 都不算;
//   ② 有 post_id → 建 topic:<T>/<post_id>、调用方入座、这句话记在新 room、只外发一次 (send_post 一次, mirror 零次);
//   ③ 没有 post_id → 不建 room、带 warning、不编造; 回包形状打一行日志;
//   ④ 发帖失败 (抛错 / errcode) → 报错, 任何 room 里都没有行。
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { ConfigSchema } from "../shared/config.js";
import { openRoomStore } from "../daemon/rooms.js";
import { createRoomHub } from "../daemon/room-hub.js";
import { roomHost, whoKey, type MsgRow, type Who } from "../shared/room.js";
import { learnChannel, learnChannelPost, channelOf } from "../daemon/channel-posts.js";
import { sendTopicPostRaw } from "../daemon/channel.js";
import { channelNewPost, createSelfPostLog, newPostChannelOf, newPostGate, newPostSeatOps, newPostTopicOfRef, NO_POST_ID_WARNING, postIdOfBody, type NewPostCaller } from "../daemon/channel-newpost.js";
import { uid, W } from "./room-fixture.js";

const dir = mkdtempSync(join(tmpdir(), "channel-newpost-"));
const cfg = ConfigSchema.parse({
  bot: { botId: "test", secret: "test" },
  daemon: { stateDir: join(dir, "state") },
  wrc: { allowFrom: ["user:tester"], channel: { history: { enabled: false } } },
  defaultChat: "user:home",
});
learnChannel(cfg, "T1");
learnChannelPost(cfg, "chat:opkOld", "T1", "pOld");
const chOf = (b: string) => channelOf(cfg, b);

// ── ① 虚地址判定 ────────────────────────────────────────────────────
assert.equal(newPostChannelOf("chat:T1", chOf), "T1", "频道本身 = 开新帖虚地址");
assert.equal(newPostChannelOf(" chat:T1 ", chOf), "T1", "容忍首尾空白");
assert.equal(newPostChannelOf("chat:opkOld", chOf), undefined, "旧帖子 room 属于频道但不是频道本身: 照旧评论根帖");
assert.equal(newPostChannelOf("topic:T1/p1", chOf), undefined, "topic room 不是虚地址");
assert.equal(newPostChannelOf("chat:unknown", chOf), undefined, "不认识的频道不算");
assert.equal(newPostChannelOf(undefined, chOf), undefined);
assert.equal(newPostChannelOf("user:x", chOf), undefined);

// 另一项: #hash8 / 聊天名指到存档频道 room, 经 resolve 还原成 id 后与全 id 同口径 = 开新帖。
const resolver = (m: Record<string, string>) => (r: string) => m[r];
assert.equal(newPostTopicOfRef("#ab12cd34", resolver({ "#ab12cd34": "chat:T1" }), chOf), "T1", "#hash8 → 存档频道 room → 开新帖");
assert.equal(newPostTopicOfRef("研发频道", resolver({ "研发频道": "chat:T1" }), chOf), "T1", "聊天名 → 存档频道 room → 开新帖");
assert.equal(newPostTopicOfRef("chat:T1", resolver({}), chOf), "T1", "全 id 不需要 resolve");
assert.equal(newPostTopicOfRef("#ab12cd34", resolver({ "#ab12cd34": "chat:opkOld" }), chOf), undefined, "指到旧帖子 room = 照旧评论根帖, 不开新帖");
assert.equal(newPostTopicOfRef("#ab12cd34", resolver({ "#ab12cd34": "topic:T1/p1" }), chOf), undefined, "指到 topic room 不开新帖");
assert.equal(newPostTopicOfRef("#nope", resolver({}), chOf), undefined);
assert.equal(newPostTopicOfRef(undefined, resolver({}), chOf), undefined);

// ── post_id 的常见回包形状 ──────────────────────────────────────────
assert.equal(postIdOfBody({ post_id: "p1" }), "p1");
assert.equal(postIdOfBody({ data: { post_id: "p2" } }), "p2");
assert.equal(postIdOfBody({ post: { post_id: "p3" } }), "p3");
assert.equal(postIdOfBody({ errcode: 0, errmsg: "ok" }), undefined, "没有 post_id 就是没有, 不编");
assert.equal(postIdOfBody({ post_id: "  " }), undefined);
assert.equal(postIdOfBody(undefined), undefined);

// ── 夹具: 真 store + 真 hub, mirror 计数 ──────────────────────────────
const store = openRoomStore(dir);
const A = uid(1);
const me: Who = W(A);
const mirrored: string[] = [];
const log0 = pino({ level: "silent" });
const hub = createRoomHub({
  store, log: log0 as never, now: () => 10_000,
  wizardOf: (u) => (u === A ? { target: "chat:T1#a", name: "a" } : undefined),
  nameOf: (w: Who) => (w.kind === "wizard" ? ".a" : w.id),
  roomLabel: (r) => r,
  mirror: async (row: MsgRow) => { mirrored.push(row.room + ":" + row.id); return true; },
  live: async () => false, idle: async () => true, interrupt: async () => {}, paste: async () => "ok",
});
const roomIdsBefore = () => store.ids().length;

/** 与 daemon/index.ts 的接线同形 (ensureRoom / record / send 三个口子)。 */
const HOST: Who = W(uid(9)); // 频道 host 身份在本 room 的实例 (founder)
const OK_CALLER: NewPostCaller = { monitor: false, guide: false, hostClass: true, archiveMember: false };
const remembered: string[] = [];
const run = (send: () => Promise<{ ok: boolean; errcode?: number; errmsg?: string; body: unknown }>, shapes: Array<Record<string, unknown>>,
  caller: NewPostCaller = OK_CALLER, founder?: Who) =>
  channelNewPost("T1", {
    caller,
    send,
    remember: (p) => remembered.push(p),
    ensureRoom: (room) => {
      const ops = newPostSeatOps(store.get(room), room, founder, me, Date.now());
      if (ops.length) hub.write(room, ops);
    },
    record: (room) => hub.append(room, { author: me, kind: "say", text: "新帖正文", origin: "tool" }, {}, { noMirror: true }),
    logShape: (o) => shapes.push(o),
  });

// ── ② 有 post_id ────────────────────────────────────────────────────
{
  let sends = 0;
  const shapes: Array<Record<string, unknown>> = [];
  const before = roomIdsBefore();
  const out = await run(async () => { sends++; return { ok: true, body: { errcode: 0, post_id: "pNew" } }; }, shapes);
  assert.equal(out.ok, true);
  assert.ok("room" in out, "回包带新 room");
  if (!("room" in out)) throw new Error("unreachable");
  assert.equal(out.room, "topic:T1/pNew", "topic room id = topic:<T>/<post_id>");
  assert.equal(out.post, "pNew");
  assert.equal(out.warning, undefined);
  assert.equal(roomIdsBefore(), before + 1, "只多一个 room");
  const s = store.get("topic:T1/pNew")!;
  assert.equal(s.kind, "topic-post");
  assert.ok(s.members.has(whoKey(me)), "调用者入座");
  assert.deepEqual(remembered, ["pNew"], "L2: 发出且拿到 post_id → 记进最近自发集合");
  assert.equal(roomHost(s) && whoKey(roomHost(s)!), whoKey(me), "频道没绑 (无 founder): 调用方自己是 founder / host");
  assert.equal(s.msgs.length, 1, "这句话记在新 room 里");
  assert.equal(s.msgs[0]!.text, "新帖正文");
  assert.equal(s.msgs[0]!.id, out.verdict.ok ? out.verdict.row.id : "", "回包的行就是账本里那行");
  assert.equal(sends, 1, "send_post 恰好一次");
  await hub.pump();
  assert.deepEqual(mirrored, [], "mirror 零次: 帖子已经由 send_post 发出, 不二次外发");
  assert.equal(shapes.length, 1, "回包形状一行日志");
  assert.deepEqual(shapes[0], { topic: "T1", keys: ["errcode", "post_id"], postId: "pNew" });
  // 对照: 同一个新 room 里的后续话照常 mirror 一次 (noMirror 只管这一行)。
  const v = hub.append("topic:T1/pNew", { author: me, kind: "say", text: "接着说", origin: "tool" });
  assert.equal(v.ok, true);
  await hub.pump();
  assert.equal(mirrored.length, 1, "后续发言 mirror 一次 (走评论根帖)");
  mirrored.length = 0;
}

// ── M3: 新帖 room 的 founder = 频道 host 身份在本 room 的实例, 调用方作为普通成员 ───
{
  const out = await run(async () => ({ ok: true, body: { post_id: "pHost" } }), [], OK_CALLER, HOST);
  assert.ok("room" in out && out.room === "topic:T1/pHost");
  const s = store.get("topic:T1/pHost")!;
  assert.equal(whoKey(roomHost(s)!), whoKey(HOST), "M3: host = 频道 host 实例 (founder, ord 1)");
  assert.equal(s.members.get(whoKey(HOST))!.ord, 1);
  assert.ok(s.members.has(whoKey(me)), "M3: 调用方入座 (普通成员)");
  assert.notEqual(s.members.get(whoKey(me))!.ord, 1);
  assert.equal(s.msgs[0]!.author.id, me.id, "M3: 账本行仍记调用方为作者");
  assert.deepEqual(remembered, ["pNew", "pHost"]);
  // 调用方就是 founder 本人 (频道没绑 / 实例取不到): 不重复入座。
  assert.deepEqual(newPostSeatOps(undefined, "topic:T1/x", me, me, 1).map((o) => o.op), ["open", "join"]);
  assert.deepEqual(newPostSeatOps(s, s.id, HOST, me, 1), [], "已存在且调用方在里面 = 无动作");
}

// ── M2: 预检在 send_post 之前, 不过 = 403 且零外发、零 room、零行 ────────────────
{
  const mk = (caller: NewPostCaller) => ({ caller, sends: 0 });
  const cases: Array<[string, NewPostCaller, RegExp]> = [
    ["monitor", { monitor: true, guide: false, hostClass: true, archiveMember: true }, /perceptron/],
    ["引导化身", { monitor: false, guide: true, hostClass: true, archiveMember: true }, /引导/],
    ["非 host 非成员", { monitor: false, guide: false, hostClass: false, archiveMember: false }, /请频道 host 发帖/],
  ];
  for (const [label, caller, re] of cases) {
    const c = mk(caller);
    const before = roomIdsBefore();
    const rows = store.ids().reduce((n, r) => n + store.get(r)!.msgs.length, 0);
    const rem = remembered.length;
    const out = await run(async () => { c.sends++; return { ok: true, body: { post_id: "pBad" } }; }, [], caller, HOST);
    assert.equal(out.ok, false, label + " 被拒");
    assert.equal((out as { status: number }).status, 403, label + " = 403");
    assert.match((out as { reason: string }).reason, re, label);
    assert.equal(c.sends, 0, label + ": 零外发 (send 一次都没调)");
    assert.equal(roomIdsBefore(), before, label + ": 没建 room");
    assert.equal(store.ids().reduce((n, r) => n + store.get(r)!.msgs.length, 0), rows, label + ": 没写行");
    assert.equal(remembered.length, rem, label + ": 没记自发集合");
  }
  await hub.pump();
  assert.deepEqual(mirrored.filter((m) => m.includes("pBad")), [], "mirror 也零次");
  // 放行的两条路: host 类实例 / 存档频道 room 成员 (monitor / guide 永远不放)。
  assert.deepEqual(newPostGate({ monitor: false, guide: false, hostClass: true, archiveMember: false }), { ok: true });
  assert.deepEqual(newPostGate({ monitor: false, guide: false, hostClass: false, archiveMember: true }), { ok: true });
  assert.equal(newPostGate({ monitor: true, guide: false, hostClass: false, archiveMember: true }).ok, false);
}

// ── L2: 最近自发 post_id 集合 (有上限, 先进先出) ───────────────────────────────────
{
  const l = createSelfPostLog(3);
  ["a", "b", "c"].forEach(l.add);
  assert.ok(l.has("a") && l.has("b") && l.has("c"));
  l.add("d");
  assert.equal(l.has("a"), false, "超上限挤掉最老的");
  assert.ok(l.has("d"));
  assert.equal(l.has("zzz"), false);
}

// ── ③ 没有 post_id ──────────────────────────────────────────────────
{
  let sends = 0;
  const shapes: Array<Record<string, unknown>> = [];
  const before = roomIdsBefore();
  const out = await run(async () => { sends++; return { ok: true, body: { errcode: 0, errmsg: "ok" } }; }, shapes);
  assert.equal(out.ok, true);
  assert.ok(!("room" in out), "不编造 room");
  assert.equal((out as { warning?: string }).warning, NO_POST_ID_WARNING);
  assert.ok(NO_POST_ID_WARNING.includes("拿不到 post_id") && NO_POST_ID_WARNING.includes("已有帖子 room"));
  assert.equal(sends, 1, "帖子已发出 (一次)");
  assert.equal(roomIdsBefore(), before, "没建 room");
  await hub.pump();
  assert.deepEqual(mirrored, [], "也没有任何外发");
  assert.deepEqual(shapes[0], { topic: "T1", keys: ["errcode", "errmsg"], postId: "" }, "真实回包形状仍打日志");
}

// ── ④ 发帖失败 ──────────────────────────────────────────────────────
{
  const before = roomIdsBefore();
  const rowsBefore = store.ids().reduce((n, r) => n + store.get(r)!.msgs.length, 0);
  const shapes: Array<Record<string, unknown>> = [];
  const thrown = await run(async () => { throw new Error("ws timeout"); }, shapes);
  assert.equal(thrown.ok, false);
  assert.match((thrown as { reason: string }).reason, /发新帖失败.*ws timeout/);
  const rejected = await run(async () => ({ ok: false, errcode: 40001, errmsg: "no permission", body: { errcode: 40001, errmsg: "no permission" } }), shapes);
  assert.equal(rejected.ok, false);
  assert.match((rejected as { reason: string }).reason, /被企微拒绝.*no permission/);
  assert.equal(roomIdsBefore(), before, "失败不建 room");
  assert.equal(store.ids().reduce((n, r) => n + store.get(r)!.msgs.length, 0), rowsBefore, "失败不写任何行");
  await hub.pump();
  assert.deepEqual(mirrored, []);
}

// ── 传输原语: errcode → ok:false 带原样 body; 正常 → body 原样 ─────────
{
  const mk = (body: unknown): any => ({ reply: async () => ({ body }) });
  const okR = await sendTopicPostRaw(mk({ post_id: "px" }), log0, "T1", "hi");
  assert.deepEqual(okR, { ok: true, body: { post_id: "px" } });
  const bad = await sendTopicPostRaw(mk({ errcode: 9, errmsg: "nope" }), log0, "T1", "hi");
  assert.equal(bad.ok, false);
  assert.equal(bad.errcode, 9);
  assert.equal(bad.errmsg, "nope");
  const rej: any = { reply: async () => { throw new Error("boom"); } };
  await assert.rejects(() => sendTopicPostRaw(rej, log0, "T1", "hi"), /boom/, "传输层抛错照旧往上抛");
}

console.log("channel-newpost ok");
