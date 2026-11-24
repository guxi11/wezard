// room-hub: append → 落盘 → 镜像 / 唤醒泵 (游标重算, 不确定不推游标) / interrupt 先 Esc / F-1 提醒与升级。
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openRoomStore } from "../daemon/rooms.js";
import { createRoomHub, type PasteResult } from "../daemon/room-hub.js";
import { DAEMON, openDuties, type MsgRow, type Who } from "../shared/room.js";
import { uid } from "./room-fixture.js";

const dir = mkdtempSync(join(tmpdir(), "room-hub-"));
const store = openRoomStore(dir);
const A = uid(1), B = uid(2);
const wiz: Record<string, { target: string; name: string; parentUid?: string }> = {
  [A]: { target: "chat:wrG", name: "steward" },
  [B]: { target: "chat:wrG#b", name: "b", parentUid: A },
};
const pasted: Array<{ target: string; text: string }> = [];
const mirrored: Array<{ row: MsgRow; cover?: string }> = [];
const escs: string[] = [];
let busy = new Set<string>();
// 有活 pane 的 target; 不在 = 冷 (reload 后没重挂 / pane 已死)
let livePanes = new Set<string>(["chat:wrG", "chat:wrG#b"]);
let next: PasteResult = "ok";
const hub = createRoomHub({
  store, now: () => 10_000,
  wizardOf: (u) => wiz[u],
  nameOf: (w: Who) => (w.kind === "wizard" ? "." + (wiz[w.id]?.name ?? w.id) : w.id),
  roomLabel: (r) => r,
  mirror: async (row, cover) => { mirrored.push({ row, cover: cover?.id }); },
  live: async (t) => livePanes.has(t),
  idle: async (t) => !busy.has(t),
  interrupt: async (t) => { escs.push(t); busy.delete(t); },
  paste: async (target, text) => { pasted.push({ target, text }); return next; },
});
const room = "chat:wrG";
store.ensure(room, { at: 1, kind: "wecom-group", by: DAEMON });
hub.write(room, [
  { op: "join", at: 1, room, who: { kind: "wizard", id: A }, ord: 1, via: "founder", by: DAEMON },
  { op: "join", at: 2, room, who: { kind: "wizard", id: B }, ord: 2, via: "spawn", by: { kind: "wizard", id: A } },
]);
const human: Who = { kind: "human", id: "T1" };
const settle = () => hub.pump();

// 人话没点名 → 唤醒 host; inbound 不回镜; 投递成功推游标
{
  const v = hub.append(room, { author: human, kind: "say", origin: "inbound", text: "在吗", bubble: { stream: "s1", expires: 9e12 } });
  assert.ok(v.ok);
  await settle();
  assert.equal(pasted.length, 1);
  assert.equal(pasted[0]!.target, "chat:wrG");
  assert.match(pasted[0]!.text, /在吗/);
  assert.match(pasted[0]!.text, /你要交代/);
  assert.equal(mirrored.length, 0);
  assert.equal(store.get(room)!.members.get("wizard:" + A)!.seen, store.get(room)!.seq);
  await settle();
  assert.equal(pasted.length, 1, "游标推进后不重投");
  assert.equal(hub.defaultRoom(A).room, room);
  assert.equal(hub.defaultFor(A), (v.ok && v.row.id)!, "defaultFor: 本轮唤醒它、仍持有未关的唯一一条 → 它的 msg id");
  // 交代: 第一条 reply 覆盖占位气泡并镜像
  const hm = (v.ok && v.row.id)!;
  const r = hub.append(room, { author: { kind: "wizard", id: A }, kind: "reply", origin: "tool", re: [hm], text: "在的" });
  assert.ok(r.ok && r.row.status === "done");
  assert.equal(mirrored.at(-1)!.cover, hm);
  assert.equal(hub.defaultFor(A), undefined, "defaultFor: 唯一那条已交代关账 → 零条 → undefined");
  assert.equal(hub.defaultFor(B), undefined, "defaultFor: 没被唤醒过的人 → undefined");
}
// 不确定投递 → 不推游标, 重投标「可能已读过」
{
  next = "uncertain";
  hub.append(room, { author: { kind: "wizard", id: A }, kind: "ask", origin: "tool", to: [{ kind: "wizard", id: B }], text: "看下日志" });
  await settle();
  const before = pasted.length;
  next = "ok";
  await settle();
  assert.equal(pasted.length, before + 1);
  assert.match(pasted.at(-1)!.text, /可能有你已读过的/);
  assert.match(pasted.at(-1)!.text, /看下日志/);
}
// interrupt: 对方忙 → 先 Esc 再投; 不带 interrupt 时忙就等
{
  await hub.onIdle(A); // §8a 出站额度按轮清零: A 上一轮已发满 3 条工具行, 这里轮终再开新一轮
  busy = new Set(["chat:wrG#b"]);
  hub.append(room, { author: { kind: "wizard", id: A }, kind: "say", origin: "tool", to: [{ kind: "wizard", id: B }], text: "普通" });
  const n0 = pasted.length;
  await settle();
  assert.equal(pasted.length, n0, "忙且没 interrupt → 不投");
  hub.append(room, { author: { kind: "wizard", id: A }, kind: "ask", origin: "tool", to: [{ kind: "wizard", id: B }], text: "停一下", interrupt: true });
  await settle();
  assert.deepEqual(escs, ["chat:wrG#b"]);
  assert.match(pasted.at(-1)!.text, /停一下/);
  assert.match(pasted.at(-1)!.text, /普通/, "被压着的那条随游标一起补上");
}
// 冷目标 (没有活 pane) 不算忙: 照常投 —— injectText 会为它重生, 不能等到一个不会出现的 idle
{
  livePanes.delete("chat:wrG#b");
  busy = new Set(["chat:wrG#b"]);
  const n0 = pasted.length;
  hub.append(room, { author: { kind: "wizard", id: A }, kind: "ask", origin: "tool", to: [{ kind: "wizard", id: B }], text: "冷会话也要收到" });
  await settle();
  assert.equal(pasted.length, n0 + 1);
  assert.match(pasted.at(-1)!.text, /冷会话也要收到/);
  assert.equal(escs.length, 1, "冷目标没有可打断的 pane, 不按 Esc");
  livePanes = new Set(["chat:wrG", "chat:wrG#b"]);
  busy = new Set();
}
// F-1: 一轮结束未交代 → 当轮提醒一次; 再闲 → 给提问者写系统行 (镜像进群), 只写一次
{
  const owedBefore = openDuties(store.get(room)!).filter((d) => d.slot === "wizard:" + B).length;
  assert.ok(owedBefore >= 1);
  const n0 = pasted.length;
  await hub.onIdle(B);
  assert.equal(pasted.length, n0 + 1);
  assert.match(pasted.at(-1)!.text, /还没交代/);
  await hub.onIdle(B);
  const sys = store.get(room)!.msgs.filter((m) => m.sys === "undelivered");
  assert.ok(sys.length >= 1);
  assert.equal(mirrored.some((m) => m.row.sys === "undelivered"), true);
  await hub.onIdle(B);
  assert.equal(store.get(room)!.msgs.filter((m) => m.sys === "undelivered").length, sys.length, "升级只写一次");
}
// F-1 话术与收账 / 一次唤醒的合并投递
// (原 idle-nudge / strict-delivery-nudge / strict-obligation 的有界追问 + merged-envelope 的合并注入)
{
  const room2 = "chat:wrH";
  store.ensure(room2, { at: 1, kind: "wecom-group", by: DAEMON });
  hub.write(room2, [{ op: "join", at: 1, room: room2, who: { kind: "wizard", id: A }, ord: 1, via: "founder", by: DAEMON }]);
  // 人连发两句 (都没点名) → 合并成一次注入, 两句都在, 一条 paste
  const h1 = hub.append(room2, { author: human, kind: "say", origin: "inbound", text: "第一句" });
  const h2 = hub.append(room2, { author: human, kind: "say", origin: "inbound", text: "第二句" });
  const n0 = pasted.length;
  await settle();
  assert.equal(pasted.length, n0 + 1, "两句未读合并成一条注入");
  assert.match(pasted.at(-1)!.text, /第一句/);
  assert.match(pasted.at(-1)!.text, /第二句/);
  assert.ok(h1.ok && h2.ok);
  // 当轮提醒: 点名要交代的 msg + chat_reply 出路 + 不用答记 passed
  const reminded = pasted.length;
  await hub.onIdle(A);
  assert.equal(pasted.length, reminded + 1, "闲下来提醒恰好一次");
  const note = pasted.at(-1)!.text;
  assert.ok(note.includes(h1.row.id) && note.includes(h2.row.id), "提醒点名欠着的 msg id: " + note);
  assert.match(note, /chat_reply/);
  assert.match(note, /passed/);
  // 交代了就收账: 再闲不提醒、也不给提问者写系统行
  hub.append(room2, { author: { kind: "wizard", id: A }, kind: "reply", origin: "tool", re: [h1.row.id], text: "一" });
  hub.append(room2, { author: { kind: "wizard", id: A }, kind: "reply", origin: "tool", re: [h2.row.id], text: "二" });
  await settle();
  const n1 = pasted.length;
  await hub.onIdle(A);
  assert.equal(pasted.length, n1, "交代后不再提醒");
  assert.equal(store.get(room2)!.msgs.filter((m) => m.sys === "undelivered").length, 0, "也不写 undelivered 系统行");
}
// progress / need 也算交代: duty 仍开着, 但之后的轮终不提醒、不写系统行 (管家误报「被提醒后仍没有交代」)
{
  const room3 = "chat:wrP";
  store.ensure(room3, { at: 1, kind: "wecom-group", by: DAEMON });
  hub.write(room3, [{ op: "join", at: 1, room: room3, who: { kind: "wizard", id: A }, ord: 1, via: "founder", by: DAEMON }]);
  const ask = hub.append(room3, { author: human, kind: "say", origin: "inbound", text: "做 8 件事" });
  assert.ok(ask.ok);
  await settle();
  const pr = hub.append(room3, { author: { kind: "wizard", id: A }, kind: "reply", origin: "tool", re: [ask.row.id], text: "转给同伴在做", status: "progress", statusGiven: true });
  assert.ok(pr.ok && pr.row.status === "progress");
  const n0 = pasted.length;
  await hub.onIdle(A); // 当轮
  await hub.onIdle(A); // 下一轮 (别的事唤醒它, 没再碰这件)
  await hub.onIdle(A);
  assert.equal(pasted.filter((x, i) => i >= n0 && x.text.includes(ask.row.id)).length, 0, "progress 之后不提醒");
  assert.equal(store.get(room3)!.msgs.filter((m) => m.sys === "undelivered").length, 0, "progress 之后不写系统行");
  assert.equal(openDuties(store.get(room3)!).filter((d) => d.msg === ask.row.id).length, 1, "duty 仍开着");
  // need → 人补答再唤醒 → 这一轮没交代 → 照常提醒一次, 再闲写系统行
  hub.append(room3, { author: { kind: "wizard", id: A }, kind: "reply", origin: "tool", re: [ask.row.id], text: "第 3 项要哪个分支?", status: "need", statusGiven: true });
  await hub.onIdle(A);
  assert.equal(pasted.length, n0, "need 当轮也算交代");
  hub.append(room3, { author: human, kind: "say", origin: "inbound", re: [ask.row.id], to: [{ kind: "wizard", id: A }], text: "v3" });
  await settle();
  const n1 = pasted.length;
  assert.ok(n1 > n0, "补答唤醒了它");
  await hub.onIdle(A);
  assert.equal(pasted.length, n1 + 1);
  assert.ok(pasted.at(-1)!.text.includes(ask.row.id) && /还没交代/.test(pasted.at(-1)!.text), "补答后没交代 → 重新提醒");
  await hub.onIdle(A);
  assert.equal(store.get(room3)!.msgs.filter((m) => m.sys === "undelivered" && (m.re ?? []).includes(ask.row.id)).length, 1, "再闲写系统行");
  // 真正 done 照常关账
  const done = hub.append(room3, { author: { kind: "wizard", id: A }, kind: "reply", origin: "tool", re: [ask.row.id], text: "8 件都完了" });
  assert.ok(done.ok && done.row.status === "done");
  assert.equal(openDuties(store.get(room3)!).filter((d) => d.msg === ask.row.id).length, 0);
}
// defaultFor: 一轮里同时被两条 duty 唤醒 → 有歧义 → undefined; overdue-remind 的 trigger (re 指向 duty) 算唤醒
{
  await hub.onIdle(A); // 清掉上一轮
  const roomF = "chat:wrF";
  store.ensure(roomF, { at: 1, kind: "wecom-group", by: DAEMON });
  hub.write(roomF, [
    { op: "join", at: 1, room: roomF, who: { kind: "wizard", id: A }, ord: 1, via: "founder", by: DAEMON },
    { op: "join", at: 2, room: roomF, who: { kind: "wizard", id: B }, ord: 2, via: "spawn", by: { kind: "wizard", id: A } },
  ]);
  const ask1 = hub.append(roomF, { author: { kind: "wizard", id: B }, kind: "ask", origin: "tool", to: [{ kind: "wizard", id: A }], text: "一" });
  await settle();
  const ask2 = hub.append(roomF, { author: { kind: "wizard", id: B }, kind: "ask", origin: "tool", to: [{ kind: "wizard", id: A }], text: "二" });
  assert.ok(ask1.ok && ask2.ok);
  await settle();
  assert.equal(hub.defaultFor(A), undefined, "同一轮两条 duty → 多条有歧义, 不猜");
  hub.append(roomF, { author: { kind: "wizard", id: A }, kind: "reply", origin: "tool", re: [ask2.ok ? ask2.row.id : ""], text: "二好了" });
  assert.equal(hub.defaultFor(A), ask1.ok ? ask1.row.id : "", "关掉一条后剩唯一一条");
  // 轮终清空; 之后 overdue-remind 的 trigger (re 指向 ask1) 再唤醒它 → 仍归到 ask1
  await hub.onIdle(A);
  assert.equal(hub.defaultFor(A), undefined, "轮终后没有「本轮」");
  hub.append(roomF, { author: DAEMON, kind: "trigger", origin: "daemon", sys: "overdue-remind", to: [{ kind: "wizard", id: A }], re: [ask1.ok ? ask1.row.id : ""], text: "[wezard] 逾期" }, { budget: Number.MAX_SAFE_INTEGER });
  await settle();
  assert.equal(hub.defaultFor(A), ask1.ok ? ask1.row.id : "", "trigger 行的 re 指向 duty 也算唤醒它的那一条");
  await hub.onIdle(A);
}
// 绑定 room 里同伴的 done 回复人已经看见: 向人关账的「你要交代」点明这一点, 不让 host 复述
{
  const roomR = "chat:wrR";
  store.ensure(roomR, { at: 1, kind: "wecom-group", by: DAEMON });
  hub.write(roomR, [
    { op: "join", at: 1, room: roomR, who: { kind: "wizard", id: A }, ord: 1, via: "founder", by: DAEMON },
    { op: "join", at: 2, room: roomR, who: { kind: "wizard", id: B }, ord: 2, via: "spawn", by: { kind: "wizard", id: A } },
  ]);
  const h = hub.append(roomR, { author: human, kind: "say", origin: "inbound", text: "为什么 X 不对" });
  assert.ok(h.ok);
  await settle();
  assert.ok(!pasted.at(-1)!.text.includes("别再复述"), "只有人话那一轮: 没有同伴发言, 不挂不复述提示");
  const ask = hub.append(roomR, { author: { kind: "wizard", id: A }, kind: "ask", origin: "tool", to: [{ kind: "wizard", id: B }], text: "查一下 X" });
  assert.ok(ask.ok);
  const rep = hub.append(roomR, { author: { kind: "wizard", id: B }, kind: "reply", origin: "tool", re: [ask.row.id], text: "原因是 Y" });
  assert.ok(rep.ok && rep.row.status === "done");
  await settle();
  const note = pasted.at(-1)!.text;
  assert.match(note, /原因是 Y/, "同伴的回复照常列给 host 读");
  assert.match(note, /人已经在群里看过上面 \.b 的发言/, "提示: 同伴这一行真的进了群, 人已经看见");
  assert.match(note, /它说过的别再复述/, "提示: 关账不许复述同伴的话");
  assert.ok(
    openDuties(store.get(roomR)!).some((d) => d.msg === h.row.id && d.asker.kind === "human"),
    "human 那条 duty 还开着 —— 提示正是给这一轮向人交代用的",
  );
}
// 重开 store (模拟 reload): 账本状态一致
{
  const again = openRoomStore(dir);
  assert.equal(again.get(room)!.seq, store.get(room)!.seq);
  assert.equal(again.roomOfMsg(store.get(room)!.msgs[0]!.id), room);
}
console.log("room-hub ok");
