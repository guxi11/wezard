// 源 ↔ room 绑定 (multi-source-binding P3): 工具面的硬门与权限 (planBind / planUnbind)、
// 以及 bind/unbind 走账本后的索引与 lazy 回落。
// 2026-11-27 (docs/evolve/channel-topic-rooms.md): 频道帖子每帖一个 topic room, 帖子源不能再 bind (400);
// 存量的帖子源 bind op 照读 (索引 / unbind 仍有效)。
// 删除说明: 首触兜底扫描 (pendingFirstTouches)、boot 频道成员补拉 (planChannelBackfill)、room_fork 判定
// (planFork) 随首触接待一起删除, 对应的 ④ ⑤ ⑧ 段不再存在; ① 的正常路径改用群源。
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigSchema } from "../shared/config.js";
import { applyOp, DAEMON, emptyRoom, judge, type RoomState, type Who } from "../shared/room.js";
import { openRoomStore } from "../daemon/rooms.js";
import { learnChannelPost } from "../daemon/channel-posts.js";
import { bindableSource, bindCandidates, isChannelSource, planBind, planUnbind, sourceRoomOf } from "../daemon/room-bind.js";
import { stewardRoute } from "../daemon/steward.js";
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
const bind = (over: Partial<Parameters<typeof planBind>[0]> = {}) => planBind({ ...ctx(), room: ROOM_R, source: GROUP, actor: host, ...over }, 5_000);

// 闸关 → 503
const closed = bind({ gate: { ok: false, reason: "x" } } as never);
assert.equal(closed.ok, false);
assert.equal((closed as { status: number }).status, 503);
// ⑤ 源 = 目标主源
assert.equal(bind({ source: ROOM_R }).ok, false);
assert.match((bind({ source: ROOM_R }) as { reason: string }).reason, /主源/);
// ④ 源类型: 只有群。单聊 / 频道键 / 频道帖子 (新旧口径) 都不行 —— 帖子源 400 且说明「每帖一个 room」。
assert.match((bind({ source: "user:U1" }) as { reason: string }).reason, /不能绑/);
for (const src of [CHAN, SRC_POST, "topic:T1/p1"]) {
  const v = bind({ source: src });
  assert.equal(v.ok, false, src + " 不能当源");
  assert.equal((v as { status: number }).status, 400, src + " → 400");
  assert.match((v as { reason: string }).reason, /每个帖子自己就是一个 room/, src + " 的拒绝说明");
}
assert.equal(bindableSource(cfg, GROUP), true, "群源仍可绑");
assert.equal(bindableSource(cfg, SRC_POST), false);
assert.equal(isChannelSource(cfg, "topic:T1/p1"), true, "topic room id 一眼认出, 不查映射");
assert.equal(isChannelSource(cfg, SRC_POST), true, "旧帖子 base 靠配对表认出");
assert.equal(isChannelSource(cfg, GROUP), false);
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
  assert.equal((ok.op as { source: string }).source, GROUP);
  assert.equal((ok.op as { by: Who }).by.id, host.id);
}

// ── ② planUnbind (存量帖子源 bind 仍可解) ──────────────────────────────
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
// 存量: 早先写进账本的帖子源 bind op 照读 (新的帖子源 bind 已拒, 这条是历史事实)。
store.append(ROOM_R, [{ op: "bind", at: 3, room: ROOM_R, source: SRC_POST, by: host }]);
assert.equal(store.roomOfSource(SRC_POST), ROOM_R, "存量 bind 后索引指向目标 room");
store.append(ROOM_R, [{ op: "unbind", at: 4, room: ROOM_R, source: SRC_POST, by: host }]);
assert.equal(store.roomOfSource(SRC_POST), undefined, "unbind 后回落恒等");
// 重开 store 从账本重放还是同一个结论 (内存态 = 盘上重放)
const store2 = openRoomStore(join(ROOT, "state", "rooms"));
assert.equal(store2.roomOfSource(SRC_POST), undefined);
assert.equal(store2.bindingGate().ok, true);

// ── ⑥ 群源: 源 → room 落点 + steward 接待 (P4 §4.1) ───────────────────
const gRoom = chanRoom(GROUP, [W(uid(3))], "wecom-group");
const sctx = { roomOfSource: (s: string) => (s === GROUP ? ROOM_R : undefined), stateOf: (r: string) => (r === GROUP ? gRoom : r === ROOM_R ? roomS : undefined) };
assert.equal(sourceRoomOf({ source: GROUP, ...sctx }), ROOM_R, "群源已绑 → 落目标 room");
assert.equal(sourceRoomOf({ source: GROUP, roomOfSource: () => undefined, stateOf: (r) => (r === GROUP ? gRoom : undefined) }), GROUP, "未绑 → 恒等回落");
// stewardRoute 先查索引: 绑了就不再走源自己的类绑定化身
assert.deepEqual(stewardRoute(cfg, undefined, GROUP, undefined, () => ({ target: ROOM_R })), { target: ROOM_R });
assert.deepEqual(stewardRoute(cfg, undefined, GROUP), { target: GROUP }, "没有绑定回执 → 恒等路径不变");

// ── ⑦ dry-run 证据 (§5.2) ───────────────────────────────────────────
const T0 = 10_000_000;
const mk = (id: string, members: Who[], rows: Array<{ text: string; at: number; src?: string }> = []): RoomState => {
  const s = chanRoom(id, members, "wecom-group");
  for (const r of rows) {
    const v = judge(s, { author: H("u1"), kind: "say", text: r.text, origin: "inbound", ...(r.src ? { src: r.src } : {}) }, { now: r.at });
    assert.equal(v.ok, true, v.ok ? "" : v.reason);
    if (v.ok) applyOp(s, v.row);
  }
  return s;
};
const near = T0 - 60_000;
const sStrong = mk("chat:wrS", [W(uid(5))], [{ text: "账单迁移的 review 结论", at: near }]);
const sText = mk("chat:wrT", [W(uid(6))], [{ text: "完全一样的正文 账单迁移的 review 结论", at: near }]);
const sDead = mk("chat:wrD", [W(uid(7))]);
const sNoHost = mk("chat:wrN", []);
const cand = (over: Partial<Parameters<typeof bindCandidates>[0]> = {}) => bindCandidates({
  cfg, source: GROUP, text: "账单迁移的 review 结论", asker: "u1",
  states: [sStrong, sText, sDead, sNoHost], roomOfSource: () => undefined,
  now: T0, simMin: 0.3, busyWindowMin: 60,
  hostInfoOf: (u) => (u === uid(7) ? { name: "x", responsibility: "账单迁移 / review" } : undefined),
  ...over,
});
const rep = cand();
assert.equal(rep.blocked, "", "没绑别处不 blocked");
assert.equal(rep.candidates[0]!.room, "chat:wrS", "同 asker 证据最强, 排第一");
assert.ok(rep.candidates[0]!.evidence.some((e) => e.includes("同 asker")));
const byRoom = new Map(rep.candidates.map((c) => [c.room, c]));
assert.ok(byRoom.get("chat:wrT")!.evidence.some((e) => e.includes("正文相关")), "正文 trigram >= simMin 出证据");
assert.ok(byRoom.get("chat:wrD")!.veto.some((e) => e.includes("死 room")), "死 room veto");
assert.ok(byRoom.get("chat:wrN")!.veto.some((e) => e.includes("没有 host")), "没 host veto");
// veto 的排在最后
assert.equal(rep.candidates[rep.candidates.length - 1]!.veto.length > 0, true);
// 源已绑别处 → blocked, 但仍给候选供人判断
assert.match(cand({ roomOfSource: () => "chat:wrX" }).blocked, /已经绑在 chat:wrX/);
// 阈值: simMin 拉到 1 时同文也只算 0.9x → 不出正文证据 (整句相同其实 1.0, 用截断文本测)
assert.equal(cand({ text: "账单", simMin: 1 }).candidates.every((c) => !c.evidence.some((e) => e.includes("正文相关"))), true);
// 近期接待: 这个源的话曾落在这本账
const sPrev = mk("chat:wrP", [W(uid(9))], [{ text: "旧帖子的话", at: near, src: GROUP }]);
const rep2 = cand({ states: [sPrev], text: "", asker: "" });
assert.ok(rep2.candidates[0]!.evidence.some((e) => e.includes("近期接待")));
// busyWindowMin=0 = 不看活跃度 → 死 room 不 veto
assert.equal(cand({ states: [sDead], busyWindowMin: 0 }).candidates[0]!.veto.length, 0);

console.log("room-bind-tool ok");
