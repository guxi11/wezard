// 注入头 (batch 2): 房头从 【label】(roomId) 改成 【label】#hash8 标记 —— 渲染 / 回读 / 反查都要
// 新旧双格式; 8 位 hash 撞车时退回全 id, 反查一律报歧义。
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { indexRoomHash, openRoomStore, resolveHashRef } from "../daemon/rooms.js";
import { createRoomHub, type PasteResult } from "../daemon/room-hub.js";
import type { Turn } from "../daemon/peers.js";
import { turnOpening } from "../daemon/turn-opening.js";
import { blockRoom, humanOpening, parseInjection } from "../shared/inject-view.js";
import { isInjection } from "../shared/role-render.js";
import { DAEMON, dmRoomId, markIsBound, roomHash, roomMark, type Who } from "../shared/room.js";
import { uid } from "./room-fixture.js";

const HASH = "a1b2c3d4";
const NEW = "【群G】#" + HASH + " 群 · 更早还有 3 条没列, 用 room_read 翻\n[abcd1234.1] 张三: 在吗\n你要交代: abcd1234.1 (say, 来自 张三) —— x";
const OLD = "【群G】(chat:wrG)\n[wrG.1] 张三: 在吗\n你要交代: wrG.1 (say, 来自 张三) —— x";

// ── 双格式解析 ────────────────────────────────────────────────────────
{
  const b = parseInjection(NEW)![0]!;
  assert.equal(b.label, "群G");
  assert.equal(b.room, undefined, "新格式没有全 id");
  assert.equal(b.roomHash, HASH);
  assert.equal(b.mark, "群");
  assert.deepEqual(b.notes, ["更早还有 3 条没列, 用 room_read 翻"], "标记不吃掉头后缀");
  assert.equal(b.lines[0]!.author, "张三");
  assert.ok(b.raw.startsWith("【群G】#" + HASH + " 群"), "注入原文可点开看 (逐字)");

  const o = parseInjection(OLD)![0]!;
  assert.equal(o.room, "chat:wrG", "旧格式仍认全 id");
  assert.equal(o.roomHash, undefined);
  assert.equal(o.mark, undefined);

  assert.equal(blockRoom(o), "chat:wrG", "旧格式直接给全 id");
  assert.equal(blockRoom(b), "", "没有反查 = 认不出 (调用方退显示名)");
  assert.equal(blockRoom(b, (h) => (h === HASH ? "chat:wrOther" : undefined)), "chat:wrOther");

  // 同一段里的两种块各认各的
  const both = parseInjection(NEW + "\n\n" + OLD)!;
  assert.equal(both.length, 2);
  assert.equal(both[0]!.roomHash, HASH);
  assert.equal(both[1]!.room, "chat:wrG");

  // rolepage 的「这一轮是不是注入」也要认新格式, 否则新注入整段退回原文画。
  const inj = (q: string): boolean => isInjection({ userQuery: q } as never);
  assert.equal(inj(NEW), true);
  assert.equal(inj(OLD), true);
  assert.equal(inj("随便一句话"), false);
}

// ── humanOpening: 新格式给 #hash + 标记, 旧格式照旧 ────────────────────
{
  assert.deepEqual(humanOpening(NEW), { room: "#" + HASH, roomHash: HASH, mark: "群", speaker: "张三" });
  assert.deepEqual(humanOpening(OLD), { room: "chat:wrG", speaker: "张三" });
}

// ── turn-opening: 标记定 bound, hash 反查全 id 作频道 ─────────────────
{
  const turn = (text: string): Turn => ({ text }) as unknown as Turn;
  const resolve = (h: string): string | undefined => (h === HASH ? "chat:wrOther" : undefined);

  assert.equal(turnOpening(turn(NEW), "chat:wrG", () => undefined, resolve)!.channel, "chat:wrOther", "群 → 反查出真 room");
  assert.equal(turnOpening(turn(NEW), "chat:wrG", () => undefined)!.channel, "", "反查不到 = 落 home (不拿 #hash 当频道)");
  assert.equal(turnOpening(turn("【a ↔ b】#" + HASH + " 私\n[abcd1234.2] 张三: hi"), "chat:wrG", () => undefined, resolve)!.channel, "", "私 = 不绑定出站");
  assert.equal(turnOpening(turn("【a,b】#" + HASH + " 临\n[abcd1234.3] 张三: hi"), "chat:wrG", () => undefined, resolve)!.channel, "", "临 = 不绑定出站");
  assert.equal(turnOpening(turn("【单聊】#" + HASH + " 单\n[abcd1234.4] 张三: hi"), "chat:wrG", () => undefined, resolve)!.channel, "chat:wrOther", "单 = 绑定出站");
  assert.equal(turnOpening(turn(OLD), "chat:wrG", () => undefined)!.channel, "chat:wrG", "旧格式照旧看 id");
  assert.equal(turnOpening(turn("【a ↔ b】(dm:w1|w2)\n[w1.4] 张三: hi"), "chat:wrG", () => undefined)!.channel, "", "旧格式 dm 仍不绑定");
}

// ── 标记规则 ──────────────────────────────────────────────────────────
{
  assert.equal(roomMark("chat:1234"), "群");
  assert.equal(roomMark("chat:wx@im.bot"), "群");
  assert.equal(roomMark("user:U1"), "单");
  assert.equal(roomMark("me:U1"), "单");
  assert.equal(roomMark(dmRoomId(uid(1), uid(2))), "私");
  assert.equal(roomMark("adhoc:abcd1234"), "临");
  assert.deepEqual(["群", "单", "私", "临"].map((m) => markIsBound(m as never)), [true, true, false, false]);
}

// ── hash 索引: 撞车记歧义, 反查让位 ────────────────────────────────────
{
  const byHash = new Map<string, string>();
  const collided = new Set<string>();
  indexRoomHash(byHash, collided, "deadbeef", "chat:one");
  indexRoomHash(byHash, collided, "deadbeef", "chat:one");
  assert.equal(collided.size, 0, "同一个 room 重复索引不算撞车");
  indexRoomHash(byHash, collided, "deadbeef", "chat:two");
  assert.ok(collided.has("deadbeef"), "两个 room 同 hash = 撞车");
}

const dir = mkdtempSync(join(tmpdir(), "inject-head-"));
const store = openRoomStore(dir);
const A = uid(1), B = uid(2);
{
  const G = "chat:wrG";
  store.ensure(G, { at: 1, kind: "wecom-group", by: DAEMON });
  assert.equal(store.roomByHash(roomHash(G)), G, "无撞车时 hash 反查得到全 id");
  assert.equal(store.hashAmbiguous(roomHash(G)), false);
  assert.equal(store.roomByHash("ffffffff"), undefined);
  assert.equal(resolveHashRef(store, "#" + roomHash(G))?.room ?? (() => { throw new Error("没认出"); })(), G);
  assert.equal(resolveHashRef(store, "chat:wrG"), undefined, "全 id 不归它管 (调用方先按 id 认)");
  assert.deepEqual(resolveHashRef({ roomByHash: () => undefined, hashAmbiguous: () => true }, "#" + roomHash(G)),
    { error: "hash 歧义 (两个 room 同 hash), 请用完整 room id: " + roomHash(G) });
}

// ── 房头渲染: 新格式 / 撞车退全 id / dm 记 私 ─────────────────────────
{
  const pasted: string[] = [];
  const wiz: Record<string, { target: string; name: string }> = {
    [A]: { target: "chat:wrH", name: "steward" },
    [B]: { target: "chat:wrH#b", name: "b" },
  };
  const hub = (s: typeof store) => {
    const h = createRoomHub({
      store: s, now: () => 10_000,
      wizardOf: (u) => wiz[u],
      nameOf: (w: Who) => (w.kind === "wizard" ? "." + (wiz[w.id]?.name ?? w.id) : w.id),
      roomLabel: (r) => r,
      mirror: async () => true,
      live: async () => true,
      idle: async () => true,
      interrupt: async () => undefined,
      paste: async (_target: string, text: string): Promise<PasteResult> => { pasted.push(text); return "ok"; },
    });
    return h;
  };

  const G = "chat:wrH";
  store.ensure(G, { at: 1, kind: "wecom-group", by: DAEMON });
  hub(store).write(G, [
    { op: "join", at: 1, room: G, who: { kind: "wizard", id: A }, ord: 1, via: "founder", by: DAEMON },
    { op: "join", at: 2, room: G, who: { kind: "wizard", id: B }, ord: 2, via: "spawn", by: { kind: "wizard", id: A } },
  ]);
  hub(store).append(G, { author: { kind: "human", id: "T1" }, kind: "say", origin: "inbound", text: "在吗" });
  await new Promise((r) => setTimeout(r, 0));
  await hub(store).pump();
  assert.ok(pasted.at(-1)!.startsWith("【" + G + "】#" + roomHash(G) + " 群\n"), "群房头 = #hash8 + 群: " + pasted.at(-1)!.split("\n")[0]);

  // 撞车: 同一份 store 包一层 hashAmbiguous=true → 退回全 id
  const amb = { ...store, hashAmbiguous: () => true } as typeof store;
  const D = "chat:wrH2";
  store.ensure(D, { at: 1, kind: "wecom-group", by: DAEMON });
  hub(amb).write(D, [{ op: "join", at: 1, room: D, who: { kind: "wizard", id: A }, ord: 1, via: "founder", by: DAEMON }]);
  hub(amb).append(D, { author: { kind: "human", id: "T1" }, kind: "say", origin: "inbound", text: "撞了" });
  await new Promise((r) => setTimeout(r, 0));
  await hub(amb).pump();
  assert.ok(pasted.at(-1)!.startsWith("【" + D + "】(" + D + ")\n"), "撞车退全 id: " + pasted.at(-1)!.split("\n")[0]);

  // dm: 标记是 私 (只在 rolepage), 头里仍给 hash
  const DM = dmRoomId(A, B);
  store.ensure(DM, { at: 1, kind: "dm", by: DAEMON });
  hub(store).write(DM, [
    { op: "join", at: 1, room: DM, who: { kind: "wizard", id: A }, ord: 1, via: "founder", by: DAEMON },
    { op: "join", at: 2, room: DM, who: { kind: "wizard", id: B }, ord: 2, via: "invite", by: { kind: "wizard", id: A } },
  ]);
  hub(store).append(DM, { author: { kind: "wizard", id: A }, kind: "ask", origin: "tool", to: [{ kind: "wizard", id: B }], text: "私下说" });
  await new Promise((r) => setTimeout(r, 0));
  await hub(store).pump();
  const dmHead = pasted.at(-1)!.split("\n")[0]!;
  assert.ok(dmHead.includes("#" + roomHash(DM) + " 私"), "dm 记 私: " + dmHead);
  assert.equal(humanOpening(pasted.at(-1)!), undefined, "dm 里只有同伴行, 没有人话开头");
  assert.ok(parseInjection(pasted.at(-1)!), "新格式唤醒文本仍可解析");
}

console.log("inject-room-head: ok");
