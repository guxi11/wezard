// Stop hook 轮内催交代 (hub.onStop): 有没提醒过的欠账 → block 一次; 再停仍欠 → 放行并写系统行;
// progress 交代过不拦; 没投进输入框的行不拿来催; hook 来问过的那一轮轮终 (onIdle) 不再插手。
// 运行: npx tsx tests/room-stop-hook.test.ts
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openRoomStore } from "../daemon/rooms.js";
import { createRoomHub, type PasteResult } from "../daemon/room-hub.js";
import { DAEMON, type Who } from "../shared/room.js";
import { uid } from "./room-fixture.js";

const store = openRoomStore(mkdtempSync(join(tmpdir(), "room-stop-")));
const A = uid(1);
let clock = 10_000;
let busy = false;
const pasted: string[] = [];
const hub = createRoomHub({
  store, now: () => clock, stopGraceMs: 0,
  wizardOf: (u) => (u === A ? { target: "chat:wrS", name: "a" } : undefined),
  nameOf: (w: Who) => (w.kind === "wizard" ? ".a" : w.id),
  roomLabel: (r) => r,
  mirror: async () => true,
  idle: async () => !busy,
  interrupt: async () => undefined,
  paste: async (_t, text): Promise<PasteResult> => { pasted.push(text); return "ok"; },
});
const room = "chat:wrS";
store.ensure(room, { at: 1, kind: "wecom-group", by: DAEMON });
hub.write(room, [{ op: "join", at: 1, room, who: { kind: "wizard", id: A }, ord: 1, via: "founder", by: DAEMON }]);
const human: Who = { kind: "human", id: "T1" };
const sys = (msg: string) => store.get(room)!.msgs.filter((m) => m.sys === "undelivered" && (m.re ?? []).includes(msg));

// 没投进输入框 (pane 忙, 游标没推) 的行不拿来催
busy = true;
const q = hub.append(room, { author: human, kind: "say", origin: "inbound", text: "查一下" });
assert.ok(q.ok);
await hub.pump();
assert.deepEqual(hub.onStop(A), {}, "它还没见过这一行, 不拦");
busy = false;
await hub.pump();
assert.equal(pasted.length, 1, "闲了投进去");

// 投进去后没交代就要结束 → 拦一次; 再停仍没交代 → 放行 + 系统行 (只一条)
const r1 = hub.onStop(A);
assert.ok(r1.block?.includes(q.row.id) && /chat_reply/.test(r1.block), "拦住并点名: " + r1.block);
assert.ok(/有新事实 .*才 status:"progress"/.test(r1.block ?? "") && /status:"need" 点名对方/.test(r1.block ?? "") && !/还在做就/.test(r1.block ?? ""), "STOP_TEXT: progress 只给新事实, 等人 / 同伴用 need, 没有「还在做就 progress」");
assert.equal(sys(q.row.id).length, 0, "拦的那一下不告状");
assert.deepEqual(hub.onStop(A), {}, "同一条 duty 只拦一次 —— 不会无限 block");
assert.equal(sys(q.row.id).length, 1, "拦过仍没交代 → 系统行");
hub.onStop(A);
assert.equal(sys(q.row.id).length, 1, "系统行不重复");
// hook 来问过的这一轮, 轮终不再贴提醒
const n0 = pasted.length;
await hub.onIdle(A);
assert.equal(pasted.length, n0, "hook 判过的一轮, onIdle 不插手");

// progress 交代 → 不拦; hook 没来的一轮 (老 pane) 照常由 onIdle 兜底
clock += 60_000;
const q2 = hub.append(room, { author: human, kind: "say", origin: "inbound", text: "再做一件" });
await hub.pump();
hub.append(room, { author: { kind: "wizard", id: A }, kind: "reply", origin: "tool", re: [q2.row.id], text: "在做", status: "progress", statusGiven: true });
assert.deepEqual(hub.onStop(A), {}, "progress 算交代");
assert.equal(sys(q2.row.id).length, 0);
clock += 60_000;
const q3 = hub.append(room, { author: human, kind: "say", origin: "inbound", text: "第三件" });
await hub.pump();
clock += 60_000; // hook 没来问 (超出 grace)
const n1 = pasted.length;
await hub.onIdle(A);
assert.equal(pasted.length, n1 + 1, "hook 没来 → onIdle 老路提醒");
assert.ok(pasted.at(-1)!.includes(q3.row.id));
console.log("room-stop-hook ok");
