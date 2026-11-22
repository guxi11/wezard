// lead 摘章 (方案 B): leadSettled 的判据, 与 room-hub 在关账后叫 onClosed。
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openRoomStore } from "../daemon/rooms.js";
import { createRoomHub } from "../daemon/room-hub.js";
import { leadSettled } from "../daemon/wizard.js";
import { DAEMON, type Who } from "../shared/room.js";
import { uid } from "./room-fixture.js";

// ── 1. 判据 ──
const facts = (o: Partial<Parameters<typeof leadSettled>[1]> = {}) =>
  ({ open: () => false, occupied: false, unfinishedPlan: false, boot: false, ...o });
assert.equal(leadSettled({ lead: false }, facts()), false, "不是 lead 无从摘");
assert.equal(leadSettled({ lead: true, leadOf: ["m1"] }, facts()), true, "领的那件关了 → 摘");
assert.equal(leadSettled({ lead: true, leadOf: ["m1", "m2"] }, facts({ open: (m) => m === "m2" })), false, "领两件, 还有一件开着 → 不摘");
assert.equal(leadSettled({ lead: true, leadOf: ["m1"] }, facts({ unfinishedPlan: true })), false, "plan 没收尾 → 不摘");
assert.equal(leadSettled({ lead: true, leadOf: ["m1"] }, facts({ occupied: true })), true, "记着 leadOf 时只看 leadOf, 别的活不挡");
assert.equal(leadSettled({ lead: true }, facts()), false, "老记录平时不按推断摘");
assert.equal(leadSettled({ lead: true }, facts({ boot: true })), true, "老记录 boot 清扫: 名下没有同伴的活 → 摘");
assert.equal(leadSettled({ lead: true }, facts({ boot: true, occupied: true })), false, "老记录 boot 清扫: 还欠同伴的活 → 不摘");
assert.equal(leadSettled({ lead: true }, facts({ boot: true, unfinishedPlan: true })), false, "老记录 boot 清扫: plan 没收尾 → 不摘");

// ── 2. hub: 关账 (任何 status) 后叫 onClosed; 不关账的行不叫; 钩子抛错不挡 append ──
const dir = mkdtempSync(join(tmpdir(), "lead-settle-"));
const store = openRoomStore(dir);
const A = uid(1), B = uid(2);
const wiz: Record<string, { target: string; name: string }> = {
  [A]: { target: "chat:wrL", name: "boss" },
  [B]: { target: "chat:wrL#b", name: "b" },
};
let closed = 0;
let explode = false;
const log = { info: () => {}, warn: () => {}, child: () => log } as never;
const hub = createRoomHub({
  store, log, now: () => 10_000,
  wizardOf: (u) => wiz[u],
  nameOf: (w: Who) => (w.kind === "wizard" ? "." + (wiz[w.id]?.name ?? w.id) : w.id),
  roomLabel: (r) => r,
  mirror: async () => true,
  idle: async () => true,
  interrupt: async () => {},
  paste: async () => "ok",
  onClosed: () => { closed++; if (explode) throw new Error("boom"); },
});
const room = "adhoc:l1";
store.ensure(room, { at: 1, kind: "adhoc", by: DAEMON });
hub.write(room, [
  { op: "join", at: 1, room, who: { kind: "wizard", id: A }, ord: 1, via: "founder", by: DAEMON },
  { op: "join", at: 2, room, who: { kind: "wizard", id: B }, ord: 2, via: "spawn", by: { kind: "wizard", id: A } },
]);
const a = { kind: "wizard" as const, id: A }, b = { kind: "wizard" as const, id: B };
const task = hub.append(room, { author: a, kind: "task", origin: "tool", to: [b], text: "领这件" });
assert.ok(task.ok);
const taskId = task.ok ? task.row.id : "";
assert.equal(closed, 0, "开 duty 不叫");
assert.ok(hub.append(room, { author: b, kind: "reply", origin: "tool", re: [taskId], status: "progress", statusGiven: true, text: "在做" }).ok);
assert.equal(closed, 0, "progress 不关账, 不叫");
explode = true;
assert.ok(hub.append(room, { author: b, kind: "reply", origin: "tool", re: [taskId], status: "done", statusGiven: true, text: "做完" }).ok, "钩子抛错不挡 append");
assert.equal(closed, 1, "done 关账 → 叫一次");

console.log("lead-settle: leadSettled 判据 + hub onClosed passed");
