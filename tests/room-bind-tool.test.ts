// 源 ↔ room 绑定 (multi-source-binding P3): 工具面的硬门与权限 (planBind / planUnbind)、
// 首触兜底扫描 (pendingFirstTouches)、boot 频道成员补拉 (planChannelBackfill), 以及
// bind/unbind 走账本后的索引与 lazy 回落。
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigSchema } from "../shared/config.js";
import { applyOp, DAEMON, emptyRoom, judge, type MsgRow, type RoomState, type Who } from "../shared/room.js";
import { openRoomStore } from "../daemon/rooms.js";
import { learnChannelPost } from "../daemon/channel-posts.js";
import { planBind, planUnbind, planChannelBackfill, pendingFirstTouches } from "../daemon/room-bind.js";
import { H, W, uid } from "./room-fixture.js";

const ROOT = mkdtempSync(join(tmpdir(), "room-bind-"));
const cfg = ConfigSchema.parse({
  bot: { botId: "test", secret: "test" },
  daemon: { stateDir: join(ROOT, "state") },
  wrc: { allowFrom: ["user:tester"], channel: { history: { enabled: false } } },
  defaultChat: "user:home",
});
const SRC_POST = "chat:opkA";     // 帖子源 (chat:<opk…>)
const CHAN = "chat:T1";           // 频道 room
const GROUP = "chat:wrG";         // 群源
const ROOM_R = "chat:wrR";        // 目标 room
learnChannelPost(cfg, SRC_POST, "T1", "p1");

const chanRoom = (id: string, members: Who[], kind: "channel" | "wecom-group" = "channel"): RoomState => {
  const s = emptyRoom(id);
  applyOp(s, { op: "open", at: 1_000, room: id, kind, by: DAEMON });
  members.forEach((who, i) => applyOp(s, { op: "join", at: 1_001 + i, room: id, who, ord: s.nextOrd, via: "founder", by: DAEMON }));
  return s;
};

// ── ① planBind 硬门与权限 ─────────────────────────────────────────────
const host = W(uid(1));
const roomS = chanRoom(ROOM_R, [host], "wecom-group");
const ctx = (over: Partial<{ roomOf: (s: string) => string | undefined; gateOk: boolean; stateOf: (r: string) => RoomState | undefined }> = {}) => ({
  cfg,
  roomOfSource: over.roomOf ?? (() => undefined),
  stateOf: over.stateOf ?? ((r: string) => (r === ROOM_R ? roomS : undefined)),
  gate: over.gateOk === false ? { ok: false, reason: "对账失败" } : { ok: true },
});
const bind = (over: Partial<Parameters<typeof planBind>[0]> = {}) => planBind({ ...ctx(), room: ROOM_R, source: SRC_POST, actor: host, ...over }, 5_000);

// 闸关 → 503
const closed = bind({ gate: { ok: false, reason: "x" } } as never);
assert.equal(closed.ok, false);
assert.equal((closed as { status: number }).status, 503);
// ⑤ 源 = 目标主源
assert.equal(bind({ source: ROOM_R }).ok, false);
assert.match((bind({ source: ROOM_R }) as { reason: string }).reason, /主源/);
// ④ 源类型: 单聊 / 频道自己都不行
assert.match((bind({ source: "user:U1" }) as { reason: string }).reason, /不能绑/);
assert.match((bind({ source: CHAN }) as { reason: string }).reason, /不能绑/);
// ① 跨 bot
assert.match((bind({ source: SRC_POST + "~b2" }) as { reason: string }).reason, /跨机器人/);
// ③ room 不存在 / 没有 host
assert.equal((bind({ room: "chat:nope" }) as { status: number }).status, 404);
const emptyS = chanRoom("chat:wrE", [], "wecom-group");
assert.equal((bind({ room: "chat:wrE", stateOf: (r) => (r === "chat:wrE" ? emptyS : undefined) }) as { status: number }).status, 409);
// §6 权限: 非 host 的 wizard 拒, 人可写
assert.equal((bind({ actor: W(uid(9)) }) as { status: number }).status, 403);
assert.match((bind({ actor: W(uid(9)) }) as { reason: string }).reason, /chat_ask/);
assert.equal(bind({ actor: H("u1") }).ok, true);
// ② 一源一 room: 绑在别处 → 409; 已绑本 room → 幂等
assert.equal((bind({ roomOfSource: () => "chat:wrX" }) as { status: number }).status, 409);
const again = bind({ roomOfSource: () => ROOM_R });
assert.equal(again.ok && again.already, true);
// 正常路径产出 bind op
const ok = bind();
assert.equal(ok.ok, true);
if (ok.ok) {
  assert.equal(ok.op.op, "bind");
  assert.equal((ok.op as { room: string }).room, ROOM_R);
  assert.equal((ok.op as { source: string }).source, SRC_POST);
  assert.equal((ok.op as { by: Who }).by.id, host.id);
}

// ── ② planUnbind ─────────────────────────────────────────────────────
const withBinding = ((): RoomState => {
  const s = chanRoom(ROOM_R, [host], "wecom-group");
  applyOp(s, { op: "bind", at: 4_000, room: ROOM_R, source: SRC_POST, by: host });
  return s;
})();
const unbind = (over: Partial<Parameters<typeof planUnbind>[0]> = {}) => planUnbind({
  ...ctx({ stateOf: (r) => (r === ROOM_R ? withBinding : undefined) }), room: ROOM_R, source: SRC_POST, actor: host, ...over,
}, 5_000);
assert.equal(unbind().ok, true);
assert.equal((unbind({ actor: W(uid(9)) }) as { status: number }).status, 403);
assert.equal((unbind({ source: GROUP }) as { status: number }).status, 409);
assert.equal(unbind({ room: "chat:nope" }).ok, false);
assert.equal(unbind({ gate: { ok: false, reason: "x" } } as never).ok, false);

// ── ③ 账本: bind / unbind 后索引与 lazy 回落 ─────────────────────────
const store = openRoomStore(join(ROOT, "state", "rooms"));
store.append(ROOM_R, [{ op: "open", at: 1, room: ROOM_R, kind: "wecom-group", by: DAEMON }]);
store.append(ROOM_R, [{ op: "join", at: 2, room: ROOM_R, who: host, ord: 1, via: "founder", by: DAEMON }]);
store.append(ROOM_R, [ok.ok ? ok.op : { op: "bind", at: 3, room: ROOM_R, source: SRC_POST, by: host }]);
assert.equal(store.roomOfSource(SRC_POST), ROOM_R, "bind 后索引指向目标 room");
store.append(ROOM_R, [{ op: "unbind", at: 4, room: ROOM_R, source: SRC_POST, by: host }]);
assert.equal(store.roomOfSource(SRC_POST), undefined, "unbind 后回落恒等");
// 重开 store 从账本重放还是同一个结论 (内存态 = 盘上重放)
const store2 = openRoomStore(join(ROOT, "state", "rooms"));
assert.equal(store2.roomOfSource(SRC_POST), undefined);
assert.equal(store2.bindingGate().ok, true);

// ── ④ 首触兜底扫描 (pendingFirstTouches) ─────────────────────────────
const firstTouchRow = (s: RoomState, text: string, at: number): MsgRow => {
  const v = judge(s, { author: H("u1"), kind: "say", text, origin: "inbound", post: "p1", mention: "bot", src: SRC_POST },
    { now: at });
  assert.equal(v.ok, true);
  if (v.ok) applyOp(s, v.row);
  return v.ok ? v.row : (undefined as never);
};
const s4 = chanRoom(CHAN, [host]);
const row1 = firstTouchRow(s4, "@wezard 这句是我的", 10_000);
const scan = (over: Partial<Parameters<typeof pendingFirstTouches>[0]> = {}) => pendingFirstTouches({
  cfg, states: [s4], roomOfSource: () => undefined, stateOf: (r) => (r === CHAN ? s4 : undefined),
  now: 10_000 + 11 * 60_000, timeoutMs: 10 * 60_000, ...over,
});
assert.equal(scan().length, 1, "超时未判定 = 待另起");
assert.equal(scan()[0]!.source, SRC_POST);
assert.equal(scan()[0]!.topicId, "T1");
assert.equal(scan({ now: 10_000 + 9 * 60_000 }).length, 0, "窗口内不兜底");
assert.equal(scan({ roomOfSource: () => ROOM_R }).length, 0, "已绑 (哪怕别处) 不兜底");
assert.equal(scan({ stateOf: (r) => (r === CHAN ? s4 : r === SRC_POST ? chanRoom(SRC_POST, []) : undefined) }).length, 0, "帖子 room 已诞生不再兜底");
assert.equal(scan({ timeoutMs: 0 }).length, 0, "0 = 关");
// 引导期 (没有 wizard host) 不兜底
assert.equal(scan({ states: [chanRoom(CHAN, [H("u1")])] }).length, 0);
// 没有 src 的频道行 / 别的频道帖子不算
const s4b = chanRoom(CHAN, [host]);
const plain = judge(s4b, { author: H("u1"), kind: "say", text: "没带源", origin: "inbound", post: "p1" }, { now: 10_000 });
assert.equal(plain.ok, true);
if (plain.ok) applyOp(s4b, plain.row);
assert.equal(scan({ states: [s4b] }).length, 0);
// 同源多条取最近一条 (窗口从最近那条算)
const s4c = chanRoom(CHAN, [host]);
firstTouchRow(s4c, "老话", 1_000);
firstTouchRow(s4c, "新话", 10_000);
assert.equal(scan({ states: [s4c], now: 10_000 + 5 * 60_000 }).length, 0, "最近一条还在窗口内");
assert.equal(scan({ states: [s4c], now: 10_000 + 11 * 60_000 }).length, 1);
assert.equal(row1.src, SRC_POST, "人话行写死 src");
assert.equal(row1.post, "p1");
assert.equal(row1.mention, "bot");

// ── ⑤ boot 频道成员补拉 (planChannelBackfill) ────────────────────────
const postHost = W(uid(2));
const ch = chanRoom(CHAN, [host]);
const post = chanRoom(SRC_POST, [postHost], "wecom-group");
const backfill = (over: Partial<Parameters<typeof planChannelBackfill>[0]> = {}) => planChannelBackfill({
  cfg, rooms: [SRC_POST, CHAN], stateOf: (r) => (r === CHAN ? ch : r === SRC_POST ? post : undefined),
  targetOf: (u) => (u === postHost.id ? ".inst" : undefined), ...over,
});
assert.equal(backfill().length, 1, "帖子 host 不在频道成员表 → 补拉");
assert.equal(backfill()[0]!.channelRoom, CHAN);
assert.equal(backfill()[0]!.who.id, postHost.id);
// 已在成员表 = 幂等不出
const ch2 = chanRoom(CHAN, [host, postHost]);
assert.equal(backfill({ stateOf: (r) => (r === CHAN ? ch2 : r === SRC_POST ? post : undefined) }).length, 0);
// 实例不在册 (stop / forget) 跳过
assert.equal(backfill({ targetOf: () => undefined }).length, 0);
// 频道没有 wizard host (引导期) 不拉
const chGuide = chanRoom(CHAN, [H("u1")]);
assert.equal(backfill({ stateOf: (r) => (r === CHAN ? chGuide : r === SRC_POST ? post : undefined) }).length, 0);
// 帖子 room 没有 host 不拉
assert.equal(backfill({ stateOf: (r) => (r === CHAN ? ch : r === SRC_POST ? chanRoom(SRC_POST, [], "wecom-group") : undefined) }).length, 0);

console.log("room-bind-tool ok");
