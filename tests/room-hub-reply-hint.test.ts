// 「你要交代」用法提示按最近 N 次唤醒批次节流 (rooms.replyHint.window): shared replyHintDue + room-hub render。
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openRoomStore } from "../daemon/rooms.js";
import { createRoomHub } from "../daemon/room-hub.js";
import { DAEMON, foldRoom, replyHintDue, type RoomOp, type Who } from "../shared/room.js";
import { uid } from "./room-fixture.js";

const A = uid(1), B = uid(2);
const WA: Who = { kind: "wizard", id: A }, WB: Who = { kind: "wizard", id: B };
const wiz: Record<string, { target: string; name: string }> = { [A]: { target: "chat:wrA", name: "a" }, [B]: { target: "chat:wrB", name: "b" } };
let t = 10_000;
let window = 3;
let busy = false;
const pasted: string[] = [];
const store = openRoomStore(mkdtempSync(join(tmpdir(), "reply-hint-")));
const hub = createRoomHub({
  store, now: () => t,
  wizardOf: (u) => wiz[u],
  nameOf: (w: Who) => (w.kind === "wizard" ? "." + (wiz[w.id]?.name ?? w.id) : w.id),
  roomLabel: (r) => r,
  mirror: async () => true,
  idle: async () => !busy,
  interrupt: async () => {},
  paste: async (_target, text) => { pasted.push(text); return "ok"; },
  replyHintWindow: () => window,
});
const mk = (room: string) => {
  hub.write(room, [
    { op: "open", at: t, room, kind: "adhoc", by: WA },
    { op: "join", at: t, room, who: WA, ord: 1, via: "founder", by: WA },
    { op: "join", at: t, room, who: WB, ord: 2, via: "invite", by: WA },
  ]);
};
const R1 = "adhoc:00000001", R2 = "adhoc:00000002";
mk(R1); mk(R2);
const ask = async (room = R1): Promise<{ id: string; text: string }> => {
  t += 1000;
  const v = hub.append(room, { author: WA, kind: "ask", origin: "tool", to: [WB], text: "干活 " + t });
  assert.ok(v.ok);
  await hub.pump();
  return { id: v.ok ? v.row.id : "", text: pasted.at(-1)! };
};
const USAGE = /用 chat_reply\(\{re, text, status\}\) 交代/;
const SHORT = (id: string) => new RegExp("你要交代: " + id.replace(".", "\\.") + " \\(ask, 来自 \\.a\\)$", "m");

// 新 wizard (< N 批) 每次都附
const first = await ask();
assert.match(first.text, USAGE);
const second = await ask();
assert.match(second.text, USAGE);
const third = await ask();
assert.match(third.text, USAGE, "已有 2 批 < 3, 照附");
// ≥N 批且窗口内没写过 reply → 附
const fourth = await ask();
assert.match(fourth.text, USAGE, "已有 3 批, 窗口内无 reply → 附");

// 写一条 reply 之后: 窗口内有 → 省 (保留 id 短形)
t += 1000;
assert.ok(hub.append(R1, { author: WB, kind: "reply", origin: "tool", re: [first.id], text: "好了" }).ok);
const fifth = await ask();
assert.doesNotMatch(fifth.text, USAGE);
assert.match(fifth.text, SHORT(fifth.id));
const sixth = await ask();
assert.doesNotMatch(sixth.text, USAGE, "reply 还在最近 3 批里");
const seventh = await ask();
assert.doesNotMatch(seventh.text, USAGE, "reply 恰在窗口起点上");
// 窗口外的老 reply 不算: 再三批没回, 它滑出去 → 附
const eighth = await ask();
assert.match(eighth.text, USAGE, "老 reply 已在窗口外");

// N = 0: 每次附 (旧行为), 哪怕刚回过
window = 0;
t += 1000;
assert.ok(hub.append(R1, { author: WB, kind: "reply", origin: "tool", re: [eighth.id], text: "再回" }).ok);
assert.match((await ask()).text, USAGE);

// 跨 room 同批只算一次: 一次 pump 同时投 R1 + R2 → 每个 room 的 seen 带同一个 at, 去重后是 1 批
window = 3;
t += 1000;
busy = true; // 两条都落账之后才一起投: 一批跨两个 room
hub.append(R1, { author: WA, kind: "ask", origin: "tool", to: [WB], text: "x" });
hub.append(R2, { author: WA, kind: "ask", origin: "tool", to: [WB], text: "y" });
busy = false;
await hub.pump();
const states = [R1, R2].map((r) => store.get(r)!);
const lastAt = (s: (typeof states)[number]) => s.members.get("wizard:" + B)!.batches.at(-1);
assert.equal(lastAt(states[0]!), lastAt(states[1]!), "同批同 at");
assert.equal(pasted.at(-1)!.match(/【/g)!.length, 2, "一次粘贴带两个 room 段");

// 纯函数: 批次不足 / 窗口内外 / reply 的作者必须是它自己
{
  const ops = (batches: number[], replies: Array<{ at: number; by: Who }>): RoomOp[] => [
    { op: "open", at: 1, room: "adhoc:0000000f", kind: "adhoc", by: WA },
    { op: "join", at: 1, room: "adhoc:0000000f", who: WA, ord: 1, via: "founder", by: WA },
    { op: "join", at: 1, room: "adhoc:0000000f", who: WB, ord: 2, via: "invite", by: WA },
    ...batches.map((at): RoomOp => ({ op: "seen", at, room: "adhoc:0000000f", who: WB, seq: 0, batch: true })),
    ...replies.map((r, i): RoomOp => ({ op: "msg", at: r.at, room: "adhoc:0000000f", id: "x." + i, seq: i + 1, author: r.by, ord: 0, speak: "member", kind: "reply", text: "ok", wake: [], origin: "tool" })),
  ];
  const fold = (b: number[], r: Array<{ at: number; by: Who }>) => foldRoom("adhoc:0000000f", ops(b, r));
  assert.equal(replyHintDue([fold([10, 20], [{ at: 15, by: WB }])], B, 3), true, "不足 3 批");
  assert.equal(replyHintDue([fold([10, 20, 30], [{ at: 25, by: WB }])], B, 3), false, "窗口 [10,∞) 内有");
  assert.equal(replyHintDue([fold([10, 20, 30], [{ at: 5, by: WB }])], B, 3), true, "窗口外的老 reply");
  assert.equal(replyHintDue([fold([10, 20, 30], [{ at: 25, by: WA }])], B, 3), true, "别人的 reply 不算");
  assert.equal(replyHintDue([fold([10, 20, 30], [{ at: 25, by: WB }])], B, 0), true, "0 = 每次附");
  const x = fold([10, 20], []), y = fold([10, 30], [{ at: 31, by: WB }]);
  assert.equal(replyHintDue([x, y], B, 3), false, "两个 room 并起来是 10/20/30 三批, 其中有 reply");
  assert.equal(replyHintDue([x, fold([10, 20], [])], B, 3), true, "同时刻的两份只算 2 批");
}
console.log("room-hub-reply-hint ok");
