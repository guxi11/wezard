// after 补唤醒: chat_ask 带 after 时 judge 把 wake 落成 [], 前置以 done 关闭后 daemon 追加 trigger 行叫醒被点名者。
// 覆盖: 前置 done 后补唤醒一次 · 重复关账 / 重启不重复 · seen 已越过仍能唤醒 · after:["undefined"] 视为满足 (旧受害行经管理入口补)。
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openRoomStore } from "../daemon/rooms.js";
import { createRoomHub, type RoomHub } from "../daemon/room-hub.js";
import { DAEMON, afterSatisfied, dutiesOpenedBy, msgIdOf, openDuties, type MsgRow, type RoomOp, type Who } from "../shared/room.js";
import { uid } from "./room-fixture.js";

const dir = mkdtempSync(join(tmpdir(), "room-after-"));
const A = uid(1), B = uid(2), C = uid(3);
const W = (id: string): Who => ({ kind: "wizard", id });
const wiz: Record<string, { target: string; name: string }> = {
  [A]: { target: "chat:wrG", name: "lead" }, [B]: { target: "chat:wrG#b", name: "b" }, [C]: { target: "chat:wrG#c", name: "c" },
};
const pasted: Array<{ target: string; text: string }> = [];
let t = 10_000;
const mkHub = (): { hub: RoomHub; store: ReturnType<typeof openRoomStore> } => {
  const store = openRoomStore(dir);
  const hub = createRoomHub({
    store, now: () => t,
    wizardOf: (u) => wiz[u],
    nameOf: (w: Who) => (w.kind === "wizard" ? "." + (wiz[w.id]?.name ?? w.id) : w.id),
    roomLabel: (r) => r,
    mirror: async () => true,
    idle: async () => true,
    interrupt: async () => undefined,
    paste: async (target, text) => { pasted.push({ target, text }); return "ok"; },
  });
  return { hub, store };
};
let { hub, store } = mkHub();
/** 模拟重启: 先让旧 hub 的投递落完 (否则它的 seen 行写进旧 store 的缓存), 再从盘上重新 fold。 */
const restart = async (): Promise<void> => { await hub.pump(); ({ hub, store } = mkHub()); };
const room = "adhoc:aaaa";
const other = "adhoc:bbbb";
for (const r of [room, other]) {
  store.ensure(r, { at: 1, kind: "adhoc", by: DAEMON });
  hub.write(r, [A, B, C].map((u, i): RoomOp => ({ op: "join", at: 1, room: r, who: W(u), ord: i + 1, via: "founder", by: DAEMON })));
}
const ok = (v: ReturnType<RoomHub["append"]>): MsgRow => { assert.ok(v.ok, v.ok ? "" : v.reason); return v.row; };
const triggersFor = (r: string, msg: string): MsgRow[] => store.get(r)!.msgs.filter((m) => m.kind === "trigger" && (m.re ?? []).includes(msg));
const tick = () => { t += 1_000; };

// ① 前置未满足: ask 不唤醒; 前置以 done 关闭后补一条 trigger, 唤醒被点名者一次, 渲染指回原 ask 并带原文
let pre: MsgRow, dep: MsgRow;
{
  pre = ok(hub.append(room, { author: W(A), kind: "ask", origin: "tool", to: [W(B)], text: "先建表" }));
  await hub.pump();
  tick();
  dep = ok(hub.append(room, { author: W(A), kind: "task", origin: "tool", to: [W(C)], text: "表建好后写迁移脚本", after: [pre.id] }));
  assert.deepEqual(dep.wake, [], "前置未满足时不唤醒");
  await hub.pump();
  // C 的 seen 已越过 dep 那一行 (比如被同 room 别的消息叫醒过, 账本游标推到了末尾)
  tick();
  ok(hub.append(room, { author: W(A), kind: "say", origin: "tool", to: [W(C)], text: "顺便看下 lint" }));
  await hub.pump();
  const cSeen = store.get(room)!.members.get("wizard:" + C)!.seen;
  assert.ok(cSeen > dep.seq, "seen 已越过 after 那一行");
  assert.equal(hub.reconcileAfter({ dryRun: true }).due.length, 0, "前置未关时不欠");
  const before = pasted.length;
  tick();
  ok(hub.append(room, { author: W(B), kind: "reply", origin: "tool", re: [pre.id], text: "建好了", status: "done", statusGiven: true }));
  const trig = triggersFor(room, dep.id);
  assert.equal(trig.length, 1, "补唤醒一次");
  assert.deepEqual(trig[0]!.wake, [C]);
  assert.deepEqual(trig[0]!.to, [W(C)]);
  assert.equal(trig[0]!.author.kind, "daemon");
  assert.ok(!trig[0]!.closes?.length);
  assert.equal(openDuties(store.get(room)!).filter((d) => d.msg === trig[0]!.id).length, 0, "trigger 行不开 duty");
  assert.equal(dutiesOpenedBy(trig[0]!).length, 0);
  await hub.pump();
  const toC = pasted.slice(before).filter((x) => x.target === "chat:wrG#c");
  assert.equal(toC.length, 1, "C 被唤醒一次");
  assert.match(toC[0]!.text, /表建好后写迁移脚本/, "原 ask 正文随 trigger 带到 (它在游标之前)");
  assert.match(toC[0]!.text, new RegExp("你要交代: " + dep.id.replace(".", "\\.") + " \\(task, 来自 \\.lead\\)"), "「你要交代」指回原 ask");
  assert.ok(store.get(room)!.members.get("wizard:" + C)!.seen > cSeen);
  // 被 trigger 叫醒、这一轮没交代 → 轮终提醒指向原 ask (onIdle 认 trigger 行的唤醒)
  const n = pasted.length;
  await hub.onIdle(C);
  assert.equal(pasted.length, n + 1);
  assert.match(pasted.at(-1)!.text, new RegExp(dep.id.replace(".", "\\.") + ".*还没交代"));
}

// ② 重复关账 / 再扫 / 重启: 不重复
{
  tick();
  // 人对同一条前置再 done 一次 (duty 已关, reply 只是线程回复, 不带 closes) + 显式全扫
  hub.append(room, { author: { kind: "human", id: "T1" }, kind: "reply", origin: "tool", re: [pre.id], text: "确认", status: "done", statusGiven: true });
  hub.reconcileAfter();
  assert.equal(triggersFor(room, dep.id).length, 1, "重复关账 / 再扫不重复");
  // 重启: 新 store + 新 hub 从盘上 fold, boot 对账
  await restart();
  const boot = hub.reconcileAfter();
  assert.equal(boot.due.length, 0);
  assert.equal(triggersFor(room, dep.id).length, 1, "重启不重复");
}

// ③ 停机期间前置被关 (落盘的 reply 带 closes, 但没走 hub) → boot 对账补上; 已 re 过的不补
{
  const p2 = ok(hub.append(room, { author: W(A), kind: "ask", origin: "tool", to: [W(B)], text: "前置 2" }));
  tick();
  const d2 = ok(hub.append(room, { author: W(A), kind: "ask", origin: "tool", to: [W(C)], text: "依赖 2", after: [p2.id] }));
  const d3 = ok(hub.append(room, { author: W(A), kind: "ask", origin: "tool", to: [W(B)], text: "依赖 2 (B 已自己读到)", after: [p2.id] }));
  tick();
  ok(hub.append(room, { author: W(B), kind: "reply", origin: "tool", re: [d3.id], text: "在看", status: "progress", statusGiven: true }));
  // 直接写盘模拟「旧版本 daemon 关的账」: 不经 hub.append, 不触发对账
  const seq = store.get(room)!.seq + 1;
  store.append(room, [{ op: "msg", at: t, room, id: msgIdOf(room, seq), seq, author: W(B), ord: 2, speak: "member",
    kind: "reply", text: "好了", re: [p2.id], status: "done", closes: [p2.id + "@wizard:" + B], wake: [A], origin: "tool" }]);
  await restart();
  const dry = hub.reconcileAfter({ dryRun: true });
  assert.deepEqual(dry.due.map((x) => x.msg), [d2.id], "只欠 d2 (d3 的 holder 已 re 过)");
  assert.equal(triggersFor(room, d2.id).length, 0, "dryRun 不写");
  const r = hub.reconcileAfter();
  assert.equal(r.written.length, 1);
  assert.equal(triggersFor(room, d2.id).length, 1);
  assert.equal(triggersFor(room, d3.id).length, 0);
}

// ④ 跨 room 的前置: 在 other 里关账, 唤醒 room 里等它的 ask
{
  const px = ok(hub.append(other, { author: W(A), kind: "ask", origin: "tool", to: [W(B)], text: "跨 room 前置" }));
  tick();
  const dx = ok(hub.append(room, { author: W(A), kind: "ask", origin: "tool", to: [W(C)], text: "跨 room 依赖", after: [px.id] }));
  assert.deepEqual(dx.wake, []);
  tick();
  ok(hub.append(other, { author: W(B), kind: "reply", origin: "tool", re: [px.id], text: "ok", status: "done", statusGiven: true }));
  assert.equal(triggersFor(room, dx.id).length, 1, "跨 room 关账也补");
  // 前置以 canceled 关 → 不算满足, 不补
  const pc = ok(hub.append(room, { author: W(A), kind: "ask", origin: "tool", to: [W(B)], text: "会被取消的前置" }));
  tick();
  const dc = ok(hub.append(room, { author: W(A), kind: "ask", origin: "tool", to: [W(C)], text: "等被取消的前置", after: [pc.id] }));
  tick();
  ok(hub.append(room, { author: W(B), kind: "reply", origin: "tool", re: [pc.id], text: "不做了", status: "canceled", statusGiven: true }));
  hub.reconcileAfter();
  assert.equal(triggersFor(room, dc.id).length, 0, "canceled 不满足 after");
}

// ⑤ after:["undefined"] (旧 bug 的假 id) 视为满足; 旧受害行 boot 不自动补, 管理入口 fake:true 才补, 幂等
{
  assert.equal(afterSatisfied(["undefined"], () => false), true);
  assert.equal(afterSatisfied(["undefined", "x.1"], () => false), false);
  // 新写入的 after:["undefined"] 行 —— judge 现在直接唤醒
  const live = ok(hub.append(room, { author: W(A), kind: "ask", origin: "tool", to: [W(B)], text: "新写的假 after", after: ["undefined"] }));
  assert.deepEqual(live.wake, [B], "假 id 不再挡唤醒");
  // 模拟旧受害行: 直接落盘 wake:[] 的 after:["undefined"] 行 (修复前 judge 落下的样子)
  const seq = store.get(room)!.seq + 1;
  const old: MsgRow = { op: "msg", at: t, room, id: msgIdOf(room, seq), seq, author: W(A), ord: 1, speak: "member",
    kind: "ask", text: "旧受害 ask", to: [W(C)], after: ["undefined"], wake: [], origin: "tool" };
  const answered: MsgRow = { ...old, id: msgIdOf(room, seq + 1), seq: seq + 1, text: "旧受害但 C 已 re 过", to: [W(C)] };
  const reByC: MsgRow = { op: "msg", at: t, room, id: msgIdOf(room, seq + 2), seq: seq + 2, author: W(C), ord: 3, speak: "member",
    kind: "reply", text: "看到了", re: [answered.id], status: "progress", wake: [A], origin: "tool" };
  store.append(room, [old, answered, reByC]);
  await restart();
  assert.equal(hub.reconcileAfter().written.length, 0, "boot 对账不收假 after 旧行");
  const dry = hub.reconcileAfter({ dryRun: true, fake: true });
  assert.deepEqual(dry.due.map((x) => [x.msg, x.fake, x.holder.id]), [[old.id, true, C]], "已 re 过的不补");
  const before = pasted.length;
  const done = hub.reconcileAfter({ fake: true, only: [old.id] });
  assert.equal(done.written.length, 1);
  await hub.pump();
  const toC = pasted.slice(before).filter((x) => x.target === "chat:wrG#c");
  assert.equal(toC.length, 1);
  assert.match(toC[0]!.text, /旧受害 ask/);
  assert.match(toC[0]!.text, /假 id/);
  assert.equal(hub.reconcileAfter({ fake: true }).written.length, 0, "补过不再补");
  await restart();
  assert.equal(hub.reconcileAfter({ fake: true, dryRun: true }).due.length, 0, "重启后仍幂等");
}

console.log("room-after-wake: ok");
