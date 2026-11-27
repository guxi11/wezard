// 单测: 泵投递拿到 gone 之后的一次冷启动 (帖子 / 频道 room 的实例、perceptron 只落记录、不预起 pane)。
//   ① 从没起过会话的记录 → coldStart "started" → 重投成功, 推游标, 不写 undelivered;
//   ② 有会话被人结束了的 → coldStart "declined" → 照旧 gone + undelivered;
//   ③ 出生窗口 → coldStart "birthing" → 不写 undelivered, 游标不动 (索引侧还有 spawning 去重);
// 判据本身 (daemon/steward.coldStartVerdict) 单独断言 —— 记录形态一律, 只能靠「有没有过会话的证据」。
// 运行: npx tsx tests/room-cold-start.test.ts
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openRoomStore, type RoomStore } from "../daemon/rooms.js";
import { createRoomHub, type PasteResult } from "../daemon/room-hub.js";
import { coldStartVerdict } from "../daemon/steward.js";
import { DAEMON, type Who } from "../shared/room.js";
import { uid } from "./room-fixture.js";

// ── 判据 ──────────────────────────────────────────────────────────────
const rec = (patch: Record<string, unknown> = {}) => ({
  target: "topic:x/y#host", identity: "chat:w", name: "host", description: "", bornAt: 1, memory: [], ...patch,
});
assert.equal(coldStartVerdict({ rec: rec(), spoke: false, hasBinding: false, spawning: false }), "yes", "从没起过 → 可以冷启动");
assert.equal(coldStartVerdict({ rec: rec(), spoke: false, hasBinding: false, spawning: true }), "birthing", "已经在起 → 不重复 spawn");
assert.equal(coldStartVerdict({ rec: rec({ endedAt: 5 }), spoke: false, hasBinding: false, spawning: false }), "declined", "被 stop_wizard 结束过 → 不重生");
assert.equal(coldStartVerdict({ rec: rec({ parent: "chat:p" }), spoke: false, hasBinding: false, spawning: false }), "declined", "spawn 出来的 → 有过会话");
assert.equal(coldStartVerdict({ rec: rec({ clonedFrom: "s1" }), spoke: false, hasBinding: false, spawning: false }), "declined", "clone 出来的 → 有过会话");
assert.equal(coldStartVerdict({ rec: rec({ tier: "light" }), spoke: false, hasBinding: false, spawning: false }), "declined", "档位在 → 有过会话");
assert.equal(coldStartVerdict({ rec: rec(), spoke: true, hasBinding: false, spawning: false }), "declined", "发过言 → 有过会话");
assert.equal(coldStartVerdict({ rec: rec(), spoke: false, hasBinding: true, spawning: false }), "declined", "还有绑定 → 不是 gone");
assert.equal(coldStartVerdict({ rec: undefined, spoke: false, hasBinding: false, spawning: false }), "declined", "没记录 → 不造幽灵");

// ── 泵: started → 重投成功 ────────────────────────────────────────────
const A = uid(1), B = uid(2);
const wiz: Record<string, { target: string; name: string }> = { [A]: { target: "chat:cold#a", name: "a" }, [B]: { target: "chat:cold#b", name: "b" } };
const newStore = (): RoomStore => openRoomStore(mkdtempSync(join(tmpdir(), "room-cold-")));
const log = { info: () => {}, debug: () => {}, warn: () => {}, child: () => log } as never;
const mkHub = (store: RoomStore, paste: (target: string) => Promise<PasteResult>, coldStart?: (u: string, t: string) => Promise<"started" | "birthing" | "declined">) =>
  createRoomHub({
    store, log, now: () => 10_000,
    wizardOf: (u) => wiz[u],
    nameOf: (w: Who) => (w.kind === "wizard" ? "." + (wiz[w.id]?.name ?? w.id) : w.id),
    roomLabel: (r) => r, mirror: async () => true,
    live: async () => false, idle: async () => true, interrupt: async () => {},
    paste: async (target) => paste(target),
    ...(coldStart ? { coldStart } : {}),
  });
const seed = (store: RoomStore, room: string): void => {
  store.ensure(room, { at: 1, kind: "adhoc", by: DAEMON });
  const h = mkHub(store, async () => "ok");
  h.write(room, [
    { op: "join", at: 1, room, who: { kind: "wizard", id: A }, ord: 1, via: "founder", by: DAEMON },
    { op: "join", at: 2, room, who: { kind: "wizard", id: B }, ord: 2, via: "spawn", by: { kind: "wizard", id: A } },
  ]);
};
const ask = (h: ReturnType<typeof mkHub>, room: string): string => {
  const v = h.append(room, { author: { kind: "wizard", id: A }, kind: "ask", origin: "tool", to: [{ kind: "wizard", id: B }], text: "看下" });
  assert.ok(v.ok);
  return v.row.id;
};
const sysRows = (store: RoomStore, room: string) => store.get(room)!.msgs.filter((m) => m.sys === "undelivered");
const seenB = (store: RoomStore, room: string) => store.get(room)!.members.get("wizard:" + B)!.seen;

{
  const store = newStore(); const room = "adhoc:cold1"; seed(store, room);
  let started = false; let cold = 0;
  const h = mkHub(store, async (t) => (t === "chat:cold#b" && !started ? "gone" : "ok"), async () => { cold++; started = true; return "started"; });
  ask(h, room);
  const seen0 = seenB(store, room);
  await h.pump();
  assert.equal(cold, 1, "冷启动一次");
  assert.equal(sysRows(store, room).length, 0, "起来了就不是「没有会话」, 不写系统行");
  assert.ok(seenB(store, room) > seen0, "重投成功 → 游标推进");
  await h.pump();
  assert.equal(cold, 1, "投成功了就不再冷启动");
}

// ── 泵: declined → 照旧 gone + 系统行 ─────────────────────────────────
{
  const store = newStore(); const room = "adhoc:cold2"; seed(store, room);
  let cold = 0;
  const h = mkHub(store, async (t) => (t === "chat:cold#b" ? "gone" : "ok"), async () => { cold++; return "declined"; });
  const id = ask(h, room);
  const seen0 = seenB(store, room);
  await h.pump();
  assert.ok(cold >= 1, "问过判据");
  const rows = sysRows(store, room);
  assert.equal(rows.length, 1, "被显式结束的照旧写 undelivered");
  assert.deepEqual(rows[0]!.re, [id]);
  assert.equal(seenB(store, room), seen0, "游标不动 (重生后照样读得到)");
}

// ── 泵: birthing → 不写系统行, 游标不动 ───────────────────────────────
{
  const store = newStore(); const room = "adhoc:cold3"; seed(store, room);
  let cold = 0;
  const h = mkHub(store, async (t) => (t === "chat:cold#b" ? "gone" : "ok"), async () => { cold++; return "birthing"; });
  ask(h, room);
  const seen0 = seenB(store, room);
  await h.pump();
  assert.ok(cold >= 1);
  assert.equal(sysRows(store, room).length, 0, "出生窗口不写「已被结束」");
  assert.equal(seenB(store, room), seen0, "还没投进去, 游标不推");
  const cold0 = cold;
  await h.pump(); // 30s 重踢: 再问一次判据, 仍不写系统行
  assert.ok(cold > cold0, "每轮重踢都会再问 (spawn 去重在索引侧)");
  assert.equal(sysRows(store, room).length, 0);
}

// ── 没有 coldStart 端口 → 老行为 ───────────────────────────────────────
{
  const store = newStore(); const room = "adhoc:cold4"; seed(store, room);
  const h = mkHub(store, async (t) => (t === "chat:cold#b" ? "gone" : "ok"));
  ask(h, room);
  await h.pump();
  assert.equal(sysRows(store, room).length, 1, "不给钩子 = gone 就是 gone");
}

console.log("room-cold-start: ok");
