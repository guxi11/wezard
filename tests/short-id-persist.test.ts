// 短 id 补全的持久化口径 (真机缺陷 2026-11-26): wezard-16 收到注入 [229], 事后 chat_reply re:"229"
// 报「本轮没有已登记的 room」—— turns 是内存的, 轮终 / reload 就没了。现在按**投递事实**记账:
// 每次注入成功写下这一批渲染过的 {room, seqs}, 短 id 只在「最近投递记录」里找候选。
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openRoomStore } from "../daemon/rooms.js";
import { createRoomHub } from "../daemon/room-hub.js";
import { openShortIdLog } from "../daemon/short-id-log.js";
import { expandMsgRefs } from "../shared/room.js";
import { DAEMON, openDuties, roomHash, type Who } from "../shared/room.js";
import { uid } from "./room-fixture.js";

const A = uid(1), B = uid(2);
const WA: Who = { kind: "wizard", id: A }, WB: Who = { kind: "wizard", id: B };
const dir = mkdtempSync(join(tmpdir(), "short-id-persist-"));
const file = join(dir, "short-id-deliveries.json");
const store = openRoomStore(join(dir, "rooms"));
let at = 10_000;

const makeHub = () => {
  const pasted: string[] = [];
  const hub = createRoomHub({
    store, now: () => at,
    deliveryLog: openShortIdLog(file, { now: () => at }),
    wizardOf: (u) => (u === A ? { target: "chat:wrA", name: "a" } : u === B ? { target: "chat:wrB", name: "b" } : undefined),
    nameOf: (w: Who) => (w.kind === "wizard" ? (w.id === A ? ".a" : ".b") : w.id),
    roomLabel: (r) => r,
    mirror: async () => true,
    live: async () => true,
    idle: async () => true,
    interrupt: async () => undefined,
    paste: async (_t: string, text: string) => { pasted.push(text); return "ok" as const; },
  });
  return { hub, pasted };
};
const mkRoom = (id: string): void => {
  store.ensure(id, { at: 1, kind: "wecom-group", by: DAEMON });
  store.append(id, [
    { op: "join", at: 1, room: id, who: WA, ord: 1, via: "founder", by: DAEMON },
    { op: "join", at: 2, room: id, who: WB, ord: 2, via: "spawn", by: WA },
  ]);
};
/** 补全短 id 的 daemon 口子 (index.ts expandMsgRefs 同形)。 */
const resolveFor = (hub: ReturnType<typeof createRoomHub>, id: string): { ids?: string[]; error?: string } =>
  expandMsgRefs([id], (x) => hub.msgRoomsOfSeq(B, Number(x)));

const R1 = "chat:wrP1", R2 = "chat:wrP2";
mkRoom(R1); mkRoom(R2);

// ① 投递一批 (含 [1]) → 轮终 (turns 清掉) 后短 id 仍解析并关账
{
  const { hub, pasted } = makeHub();
  const ask = hub.append(R1, { author: WA, kind: "ask", origin: "tool", to: [WB], text: "看下 229 那种" });
  assert.ok(ask.ok);
  await hub.pump();
  assert.ok(pasted.at(-1)!.includes("[1] .a → .b"), "注入里是短 id: " + pasted.at(-1));
  assert.deepEqual(hub.turnRooms(B), [R1], "轮内 turns 有它");
  await hub.onIdle(B); // 轮终: turns.delete(B)
  assert.deepEqual(hub.turnRooms(B), [], "轮终后 turns 已清");
  assert.deepEqual(hub.msgRoomsOfSeq(B, 1), [R1], "投递记录仍在 —— 短 id 依旧可反查");
  const r = resolveFor(hub, "1");
  assert.deepEqual(r.ids, [roomHash(R1) + ".1"], "补成全形");
  const v = hub.append(R1, { author: WB, kind: "reply", origin: "tool", re: r.ids!, text: "好了", status: "done", statusGiven: true });
  assert.ok(v.ok && v.row.status === "done");
  assert.equal(openDuties(store.get(R1)!).length, 0, "轮终后短 id 照样关账");
}

// ② 模拟 daemon 重启 (新 hub + 重载同一个文件) → 仍解析
{
  at += 1000;
  const first = makeHub();
  const ask = first.hub.append(R1, { author: WA, kind: "ask", origin: "tool", to: [WB], text: "第二件" });
  assert.ok(ask.ok);
  await first.hub.pump();
  const seq = ask.ok ? ask.row.id.split(".")[1]! : "";
  const reloaded = makeHub(); // boot: 从同一份 json 重载
  assert.deepEqual(reloaded.hub.msgRoomsOfSeq(B, Number(seq)), [R1], "重启后仍能反查");
  const r = resolveFor(reloaded.hub, seq);
  assert.deepEqual(r.ids, [ask.ok ? ask.row.id : ""]);
  const v = reloaded.hub.append(R1, { author: WB, kind: "reply", origin: "tool", re: r.ids!, text: "好了", status: "done", statusGiven: true });
  assert.ok(v.ok && v.row.status === "done", "重启后短 id 照样关账");
}

// ③ 同一 seq 在两个 room 都投递过 → 歧义报错 (不猜)
{
  const { hub } = makeHub();
  const R3 = "chat:wrP3", R4 = "chat:wrP4";
  mkRoom(R3); mkRoom(R4); // 两个全新 room, 第一条都是 seq 1
  const a1 = hub.append(R3, { author: WA, kind: "ask", origin: "tool", to: [WB], text: "r3 的" });
  assert.ok(a1.ok);
  await hub.pump();
  const a2 = hub.append(R4, { author: WA, kind: "ask", origin: "tool", to: [WB], text: "r4 的" });
  assert.ok(a2.ok);
  await hub.pump();
  assert.equal(a1.ok ? a1.row.seq : 0, 1, "前提: 两条都落在 seq 1");
  assert.equal(a2.ok ? a2.row.seq : 0, 1);
  const rooms = hub.msgRoomsOfSeq(B, 1);
  assert.ok(rooms.includes(R3) && rooms.includes(R4) && rooms.length > 1, "两个 room 都投递过 seq 1: " + rooms.join(","));
  const r = resolveFor(hub, "1");
  assert.ok(r.error && r.error.includes("请用完整 id (hash8.seq)"), "歧义要报错: " + r.error);
}

// ④ 出窗 / 从没投递过 → 0 候选的可行动报错
{
  const tiny = openShortIdLog(join(dir, "tiny.json"), { now: () => at, windowMs: 1000 });
  tiny.record(B, { at, rooms: [{ room: R1, seqs: [7] }] });
  assert.deepEqual(tiny.roomsOfSeq(B, 7), [R1]);
  at += 2000;
  assert.deepEqual(tiny.roomsOfSeq(B, 7), [], "出窗后不再算候选");
  assert.equal(tiny.batches(B).length, 0, "出窗的批次不返回");
  const r = expandMsgRefs(["7"], (id) => tiny.roomsOfSeq(B, Number(id)));
  assert.ok(r.error && r.error.includes("#hash8"), "0 候选给可行动报错: " + r.error);
  at -= 2000;
}

// ⑤ 全形 id 直通 (任何候选状态下都不受影响)
{
  const { hub } = makeHub();
  const full = roomHash(R2) + ".1";
  assert.deepEqual(expandMsgRefs([full], (x) => hub.msgRoomsOfSeq(B, Number(x))), { ids: [full] });
}

console.log("short-id-persist: ok");
