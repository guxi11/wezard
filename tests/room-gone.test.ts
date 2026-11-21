// room-hub: 目标没有会话 (stop_wizard end 丢了绑定) → 给提问者写一条 undelivered 系统行, 游标不动, 不重复写;
// 其他失败只打一次 warn (状态变化才打), 不刷屏。
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openRoomStore } from "../daemon/rooms.js";
import { createRoomHub, type PasteResult } from "../daemon/room-hub.js";
import { DAEMON, type Who } from "../shared/room.js";
import { uid } from "./room-fixture.js";

const dir = mkdtempSync(join(tmpdir(), "room-gone-"));
const store = openRoomStore(dir);
const A = uid(1), B = uid(2);
const wiz: Record<string, { target: string; name: string }> = {
  [A]: { target: "chat:wrG", name: "lead" },
  [B]: { target: "chat:wrG#b", name: "b" },
};
const warns: Array<Record<string, unknown>> = [];
const log = { info: () => {}, warn: (o: Record<string, unknown>) => { warns.push(o); }, child: () => log } as never;
let next: PasteResult = "gone";
const pastedTo: string[] = [];
const hub = createRoomHub({
  store, log, now: () => 10_000,
  wizardOf: (u) => wiz[u],
  nameOf: (w: Who) => (w.kind === "wizard" ? "." + (wiz[w.id]?.name ?? w.id) : w.id),
  roomLabel: (r) => r,
  mirror: async () => true,
  live: async () => false,
  idle: async () => true,
  interrupt: async () => {},
  // 只有 B 的会话没了; A 正常收信 (它要被系统行唤醒)
  paste: async (target) => { pastedTo.push(target); return target === "chat:wrG#b" ? next : "ok"; },
});
const room = "adhoc:g1";
store.ensure(room, { at: 1, kind: "adhoc", by: DAEMON });
hub.write(room, [
  { op: "join", at: 1, room, who: { kind: "wizard", id: A }, ord: 1, via: "founder", by: DAEMON },
  { op: "join", at: 2, room, who: { kind: "wizard", id: B }, ord: 2, via: "spawn", by: { kind: "wizard", id: A } },
]);

const sysRows = () => store.get(room)!.msgs.filter((m) => m.sys === "undelivered");
const seenB = () => store.get(room)!.members.get("wizard:" + B)!.seen;

// gone → 一条系统行给提问者, B 的游标不动
const v = hub.append(room, { author: { kind: "wizard", id: A }, kind: "ask", origin: "tool", to: [{ kind: "wizard", id: B }], text: "改 x" });
assert.ok(v.ok);
const ask = v.ok ? v.row.id : "";
const seen0 = seenB();
await hub.pump();
assert.equal(sysRows().length, 1, "写了一条 undelivered");
const row = sysRows()[0]!;
assert.deepEqual(row.re, [ask]);
assert.ok(row.wake.includes(A), "唤醒提问者");
assert.match(row.text, /没有会话/);
assert.match(row.text, /spawn_wizard/);
assert.equal(seenB(), seen0, "游标不推: 重生后照样读得到");
assert.equal(warns.filter((w) => w.result === "gone").length, 1, "gone 打一次 warn");

// 30s 重踢: 不再写系统行, 也不再打 warn
await hub.pump();
await hub.pump();
assert.equal(sysRows().length, 1, "账本里有就不重复");
assert.equal(warns.filter((w) => w.result === "gone").length, 1, "同一失败不刷屏");

// 失败原因变了 (failed) → 再打一次 warn, 但不写系统行 (可能自己就好了)
next = "failed";
await hub.pump();
assert.equal(warns.filter((w) => w.result === "failed").length, 1);
assert.equal(sysRows().length, 1);

// 重生后投递成功 → 游标推进, 失败记号清掉 (之后再失败会重新打 warn)
next = "ok";
await hub.pump();
assert.ok(seenB() > seen0, "重生后投进去, 游标推进");
next = "failed";
hub.append(room, { author: { kind: "wizard", id: A }, kind: "say", origin: "tool", to: [{ kind: "wizard", id: B }], text: "顺便" });
hub.append(room, { author: { kind: "wizard", id: A }, kind: "ask", origin: "tool", to: [{ kind: "wizard", id: B }], text: "再看下 y" });
await hub.pump();
assert.equal(warns.filter((w) => w.result === "failed").length, 2, "成功后的新失败重新报");

console.log("room-gone: ok");
