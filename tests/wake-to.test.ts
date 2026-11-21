// wireMsg 的 wakeTo: 人在群里直接说的话 (无 to / 无 re) 的收件人 = 账本行上 wake 记的那一行当时唤醒了谁。
// 只给人话; 有 to / 有 reTo 的不带; wizard 自己的行不带; wake 为空不带 (前端退回只画 `A —room→`)。
import assert from "node:assert/strict";
import { wireMsg } from "../shared/role-render.js";
import type { MsgRow, Who } from "../shared/room.js";
import type { RoomMsg } from "../shared/room-view.js";
import { H, W, room, say, uid } from "./room-fixture.js";

const A = W(uid(1)), B = W(uid(2)), U = H("U1");
const G = room("chat:wrG", [A, B, U]);   // A 最早加入 = host
const human = say(G, { author: U, kind: "say", text: "谁来搭把手", origin: "inbound" });                 // 直接发言, 无 to / re
const named = say(G, { author: U, kind: "say", text: "bob 看下", to: [B], origin: "inbound" });           // 点名 bob
const reply = say(G, { author: A, kind: "reply", text: "我来", re: [human.id], origin: "tool" });         // wizard 行
const reHuman = say(G, { author: U, kind: "say", text: "补一句", re: [reply.id], origin: "inbound" });    // 人 re 了 alice 的行
const lookup = (id: string): MsgRow | undefined => G.msgs.find((m) => m.id === id);
const wire = wireMsg(lookup);
const asMsg = (m: MsgRow) => ({ id: m.id, author: m.author, text: m.text, ...(m.to?.length ? { to: m.to } : {}), ...(m.re?.length ? { re: m.re } : {}) }) as unknown as RoomMsg;
const wakeToOf = (m: MsgRow, w = wire): Who[] | undefined => (w(asMsg(m)) as { wakeTo?: Who[] }).wakeTo;
const wireWith = (row: MsgRow) => wireMsg((id) => (id === row.id ? row : lookup(id)));

assert.deepEqual(human.wake, [A.id], "前提: 无 to 的人话在 bound room 唤醒 host (账本行上的显式事实)");
assert.deepEqual(wakeToOf(human), [{ kind: "wizard", id: A.id }], "人的直接发言: wakeTo = wake 里的 wizard");
assert.equal(wakeToOf(named), undefined, "有显式 to 的不带 wakeTo");
assert.equal(wakeToOf(reply), undefined, "wizard 自己的行不套 wake (to / reTo 另有语义)");
assert.equal(wakeToOf(reHuman), undefined, "人 re 了别人的行: 已有 reTo, 不再补 wakeTo");
assert.ok(((wire(asMsg(reHuman)) as { reTo?: Who[] }).reTo ?? []).length === 1, "前提: 上一条确有 reTo");
// 历史上 host 会变: 收件人只认行上记的 wake, 不按现在的 host 推
const old = { ...human, wake: [B.id] } as MsgRow;
assert.deepEqual(wakeToOf(old, wireWith(old)), [{ kind: "wizard", id: B.id }], "按行上的 wake, 不是现在的 host (A)");
// wake 为空 (没有 wizard 在): 不给, 前端只画 `A —room→`
const none = { ...human, wake: [] } as MsgRow;
assert.equal(wakeToOf(none, wireWith(none)), undefined, "wake 为空不带 wakeTo");
// 查不到这一行 (lookup 缺): 不给, 不报错
assert.equal((wireMsg(() => undefined)(asMsg(human)) as { wakeTo?: unknown }).wakeTo, undefined);
console.log("wake-to: ok");
