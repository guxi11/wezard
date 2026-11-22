// 人也有 duty: wizard 对人 need / chat_ask 点名人 → 人名下开账; 人的下一句话关账 (带 re 只关被引用的) 并唤醒提问者;
// 提问者可撤回; 逾期两条规则; 人不被 pane 投递。
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openRoomStore } from "../daemon/rooms.js";
import { createRoomHub } from "../daemon/room-hub.js";
import { createOverdueScan } from "../daemon/room-overdue.js";
import { dutiesHeldBy, DAEMON, foldRoom, openDuties, quotedRowIds, applyOp, type RoomOp, type Who } from "../shared/room.js";
import { groupSysOf, overdueDue } from "../shared/room-overdue.js";
import { H, rejects, room, say, uid, W } from "./room-fixture.js";

const A = W(uid(1)), B = W(uid(2)), C = W(uid(3)), T1 = H("T1"), T2 = H("T2");
const need = { kind: "reply" as const, status: "need" as const, statusGiven: true };
const heldBy = (s: ReturnType<typeof room>, w: Who) => dutiesHeldBy(s, w);

// ① 开: 非 host 的 B 被人点名后对人 need → 人名下开 need (asker = B, msg = 这条 reply, slot = 人); 人叫不醒, 不唤醒任何人
{
  const s = room("chat:wrG", [A, B, T1]);
  const q = say(s, { author: T1, kind: "say", origin: "inbound", to: [B], text: "帮我看下 x" });
  assert.deepEqual(q.wake, [B.id]);
  const n = say(s, { author: B, ...need, re: [q.id], text: "要看哪个分支?" });
  assert.deepEqual(n.to, [T1], "judge 把被反问的人补进 to");
  assert.deepEqual(n.wake, [], "人不被唤醒 (也没有 wizard 被叫)");
  const d = s.duties.get(n.id + "@human:T1")!;
  assert.ok(d && !d.closed);
  assert.equal(d.kind, "need");
  assert.deepEqual(d.asker, B);
  assert.equal(d.msg, n.id);
  assert.equal(heldBy(s, T1).length, 1, "读侧: 人的待交代计数是通用的 dutiesHeldBy");
  assert.equal(heldBy(s, B).length, 1, "B 自己名下那条照旧开着 (need 不关)");
  assert.deepEqual(s.duties.get(q.id + "@wizard:" + B.id)!.last?.status, "need");
  // 提问者是 wizard 的 need 不开人账
  const s2 = room("adhoc:00000040", [A, B]);
  const a = say(s2, { author: A, kind: "ask", to: [B], text: "?" });
  const n2 = say(s2, { author: B, ...need, re: [a.id], text: "哪个?" });
  assert.equal(n2.to, undefined);
  assert.equal(openDuties(s2).filter((x) => x.kind === "need").length, 0);
}

// ② 关: 人不带 re 的下一句话 → 关它在本 room 名下全部未关的账 (status done), 唤醒非 host 提问者 B, 不吵 host A
{
  const s = room("chat:wrG", [A, B, T1]);
  // 人的下一句话本身就会关账, 所以同时挂着两条要靠同一件活里 B 连问两次
  const q1 = say(s, { author: T1, kind: "say", origin: "inbound", to: [B], text: "任务一" });
  const n1 = say(s, { author: B, ...need, re: [q1.id], text: "问一" });
  const n2 = say(s, { author: B, ...need, re: [q1.id], text: "问二" });
  assert.equal(heldBy(s, T1).length, 2);
  const ans = say(s, { author: T1, kind: "say", origin: "inbound", text: "都按 main 来" });
  assert.deepEqual(ans.closes?.sort(), [n1.id + "@human:T1", n2.id + "@human:T1"].sort());
  assert.deepEqual(ans.wake, [B.id], "叫醒提问者; host (A) 不被连带吵醒");
  assert.deepEqual(ans.to, [B], "提问者作为收话人落进行里");
  assert.equal(heldBy(s, T1).length, 0);
  assert.equal(s.duties.get(n1.id + "@human:T1")!.closed?.status, "done");
  assert.equal(s.duties.get(n1.id + "@human:T1")!.closed?.by, ans.id);
  // 回话开的 human duty 落给收话人 B, 不落 host
  assert.ok(s.duties.get(ans.id + "@wizard:" + B.id));
  assert.equal(s.duties.get(ans.id + "@host"), undefined);
  // 没有未关的人名下账时, 人话照旧: 没点名 → host
  const plain = say(s, { author: T1, kind: "say", origin: "inbound", text: "另外问一句" });
  assert.equal(plain.closes, undefined);
  assert.deepEqual(plain.wake, [A.id]);
  // 提问者 = host 时与 host 唤醒去重
  const s2 = room("chat:wrH", [A, B, T1]);
  const h = say(s2, { author: T1, kind: "say", origin: "inbound", text: "在吗" });
  const hn = say(s2, { author: A, ...need, re: [h.id], text: "要什么?" });
  const back = say(s2, { author: T1, kind: "say", origin: "inbound", text: "要 y" });
  assert.deepEqual(back.closes, [hn.id + "@human:T1"]);
  assert.deepEqual(back.wake, [A.id], "host 只被唤醒一次");
}

// ③ 带 re (企微引用) 只关被引用的; 引用没命中它名下的账 → 全关
{
  const s = room("chat:wrG", [A, B, T1, T2]);
  const q1 = say(s, { author: T1, kind: "say", origin: "inbound", to: [B], text: "任务一" });
  const n1 = say(s, { author: B, ...need, re: [q1.id], text: "问一" });
  const n2 = say(s, { author: B, ...need, re: [q1.id], text: "问二" });
  const other = say(s, { author: A, kind: "say", text: "闲话" });
  const r1 = say(s, { author: T1, kind: "say", origin: "inbound", re: [n2.id], text: "答二" });
  assert.deepEqual(r1.closes, [n2.id + "@human:T1"], "只关被引用的");
  assert.equal(s.duties.get(n1.id + "@human:T1")!.closed, undefined);
  assert.deepEqual(r1.wake, [B.id]);
  const r2 = say(s, { author: T1, kind: "say", origin: "inbound", re: [other.id], text: "答一 (引了别的)" });
  assert.deepEqual(r2.closes, [n1.id + "@human:T1"], "引用没命中它名下的账 → 全关剩下的");
  // 别的人 (T2) 的话关不了 T1 名下的账
  const q3 = say(s, { author: T1, kind: "say", origin: "inbound", to: [B], text: "任务三" });
  const n3 = say(s, { author: B, ...need, re: [q3.id], text: "问三" });
  const t2 = say(s, { author: T2, kind: "say", origin: "inbound", text: "我插一句" });
  assert.equal(t2.closes, undefined);
  assert.equal(s.duties.get(n3.id + "@human:T1")!.closed, undefined);
}

// ④ 提问者撤回自己开出的人名下账: 显式 canceled / passed 可以; done、没给 status、别的 wizard 都不能关
{
  const s = room("chat:wrG", [A, B, C, T1]);
  const q = say(s, { author: T1, kind: "say", origin: "inbound", to: [B], text: "任务" });
  const n = say(s, { author: B, ...need, re: [q.id], text: "问" });
  rejects(s, { author: B, kind: "reply", re: [n.id], status: "done", statusGiven: true, text: "我替人答了" }, 403);
  const plain = say(s, { author: B, kind: "reply", re: [n.id], text: "没给 status 只是线程回复" });
  assert.equal(plain.closes, undefined);
  rejects(s, { author: C, kind: "reply", re: [n.id], status: "canceled", statusGiven: true, text: "我替它撤" }, 403);
  const cx = say(s, { author: B, kind: "reply", re: [n.id], status: "canceled", statusGiven: true, text: "不需要了" });
  assert.deepEqual(cx.closes, [n.id + "@human:T1"]);
  assert.deepEqual(cx.wake, [], "撤回不唤醒任何人");
  assert.equal(heldBy(s, T1).length, 0);
  // passed 同样; 提问者自己撤回不吃「提问者补充先读」(它的 seen 游标在自己的行之前)
  const n2 = say(s, { author: B, ...need, re: [q.id], text: "再问" });
  const ps = say(s, { author: B, kind: "reply", re: [n2.id], status: "passed", statusGiven: true });
  assert.equal(ps.status, "passed");
  assert.deepEqual(ps.closes, [n2.id + "@human:T1"]);
  // 人写 chat_reply 照旧 (超集), 关该账
  const n3 = say(s, { author: B, ...need, re: [q.id], text: "又问" });
  const hr = say(s, { author: T1, kind: "reply", re: [n3.id], text: "好" });
  assert.deepEqual(hr.closes, [n3.id + "@human:T1"]);
}

// ⑤ chat_ask 点名人: 人名下开 ask / task; 非成员的人 409; 只点人也行; 人话关账唤醒提问者
{
  const s = room("chat:wrG", [A, B, T1]);
  const ask = say(s, { author: B, kind: "ask", to: [T1], text: "周报发哪?" });
  assert.deepEqual(ask.wake, []);
  const d = s.duties.get(ask.id + "@human:T1")!;
  assert.ok(d && d.kind === "ask" && d.asker.id === B.id);
  const task = say(s, { author: B, kind: "task", to: [A, T1], text: "一起定" });
  assert.deepEqual(task.wake, [A.id], "同一条里 wizard 照常被唤醒, 人不被");
  assert.equal(openDuties(s).filter((x) => x.msg === task.id).length, 2);
  rejects(s, { author: B, kind: "ask", to: [H("T9")], text: "你好" }, 409);
  say(s, { author: A, kind: "ask", to: [T1], text: "另一件: 周会几点?" });
  const ans = say(s, { author: T1, kind: "say", origin: "inbound", text: "发 wiki" });
  assert.equal(ans.closes?.length, 3, "两个提问者三条人名下的账都关");
  assert.deepEqual(ans.wake.sort(), [A.id, B.id].sort(), "两个提问者都叫醒");
  assert.equal(heldBy(s, T1).length, 0);
  assert.equal(s.duties.get(ask.id + "@human:T1")!.closed?.status, "done");
}

// ⑥ 重放: 落进行里的 to / closes 就是全部事实, fold 出同一份 duty (不靠重新推断)
{
  const s = room("chat:wrG", [A, B, T1]);
  const ops: RoomOp[] = [];
  const q = say(s, { author: T1, kind: "say", origin: "inbound", to: [B], text: "任务" }); ops.push(q);
  const n = say(s, { author: B, ...need, re: [q.id], text: "问" }); ops.push(n);
  const ans = say(s, { author: T1, kind: "say", origin: "inbound", text: "答" }); ops.push(ans);
  const base = room("chat:wrG", [A, B, T1]);
  const replay = ops.reduce(applyOp, base);
  const keys = (x: typeof s): string[] => [...x.duties.values()].map((d) => d.key + ":" + (d.closed?.status ?? "open")).sort();
  assert.deepEqual(keys(replay), keys(s));
  assert.equal(foldRoom("x", []).duties.size, 0);
}

// ⑦ 引用正文 → 账本行 (企微只带文字): 互相包含、取最近一条别人说的; 太短 / 对不上不认
{
  const s = room("chat:wrG", [A, B, T1]);
  const m1 = say(s, { author: B, kind: "say", text: "要看哪个分支? 我这边有 main 和 v3" });
  const m2 = say(s, { author: A, kind: "say", text: "[wezard] 已重启完成" });
  assert.deepEqual(quotedRowIds(s, "要看哪个分支？ 我这边有 main 和 v3", T1), [m1.id], "标点 / 空白 / 全半角差异不影响");
  assert.deepEqual(quotedRowIds(s, "已重启完成", T1), [m2.id]);
  assert.deepEqual(quotedRowIds(s, "没说过的话", T1), []);
  assert.deepEqual(quotedRowIds(s, "要看", T1), [], "< 4 字不认");
  const mine = say(s, { author: T1, kind: "say", origin: "inbound", text: "我自己说过的话在这里" });
  assert.deepEqual(quotedRowIds(s, "我自己说过的话在这里", T1), [], "不认作者自己的行");
  void mine;
}

// ⑧ 逾期纯判定: 人名下不 remind, 到 groupMin 报一次; wizard 的 need 球在人那边不计逾期, 人答了又计
{
  const MIN = 60_000, O = { remindMs: 60 * MIN, groupMs: 120 * MIN };
  const s = room("chat:wrG", [A, B, T1]);
  const q = say(s, { author: T1, kind: "say", origin: "inbound", to: [B], text: "任务" }, { now: 0 });
  const n = say(s, { author: B, ...need, re: [q.id], text: "问" }, { now: 5 * MIN });
  const tag = (now: number, known?: (u: string) => boolean) => overdueDue(s, now, O, known).map((h) => h.holder.kind + ":" + h.holder.id.slice(-2) + ":" + h.level);
  assert.deepEqual(tag(100 * MIN), [], "B 的账最后是 need, 人那条还没到 groupMin → 都不报");
  assert.deepEqual(tag(125 * MIN), ["human:T1:group"], "人名下只有 group, 没有 remind; B 不计逾期");
  assert.deepEqual(tag(125 * MIN, () => false), ["human:T1:group"], "人不看名册");
  // 去重: group 给过就不再给
  applyOp(s, { op: "msg", at: 126 * MIN, room: s.id, id: "g1", seq: s.seq + 1, author: DAEMON, ord: 0, speak: "daemon", kind: "system", text: "t", re: [n.id], wake: [], origin: "daemon", sys: groupSysOf("T1") });
  assert.deepEqual(tag(999 * MIN), [], "给过不再给 (B 仍不计)");
  // 人答了: 人名下关掉, B 那条重新计时 (人话是它的收话人, 又开了一条 human duty 给 B)
  say(s, { author: T1, kind: "say", origin: "inbound", text: "main" }, { now: 200 * MIN });
  const after = tag(200 * MIN + 61 * MIN);
  assert.ok(after.includes("wizard:02:remind"), "球回到 B: 照常逾期提醒 " + JSON.stringify(after));
  // 提问者已不在 room: 人名下的账不催
  const s2 = room("chat:wrG", [A, B, T1]);
  const q2 = say(s2, { author: T1, kind: "say", origin: "inbound", to: [B], text: "任务" }, { now: 0 });
  say(s2, { author: B, ...need, re: [q2.id], text: "问" }, { now: 1 * MIN });
  applyOp(s2, { op: "leave", at: 2 * MIN, room: s2.id, who: B, by: DAEMON });
  assert.deepEqual(overdueDue(s2, 999 * MIN, O).filter((h) => h.holder.kind === "human"), []);
  // 点名人的 ask: 同样只有 group
  const s3 = room("chat:wrG", [A, B, T1]);
  say(s3, { author: B, kind: "ask", to: [T1], text: "问你" }, { now: 0 });
  assert.deepEqual(overdueDue(s3, 61 * MIN, O), [], "人名下不 remind");
  assert.deepEqual(overdueDue(s3, 121 * MIN, O).map((h) => h.level), ["group"]);
}

// ⑨ 中枢 + 扫描: 人不被 pane 投递; group 行镜像进企微 (绑定 room) / 非绑定 room 转提问者 home 群
{
  const MIN = 60_000;
  const dir = mkdtempSync(join(tmpdir(), "room-human-duty-"));
  const store = openRoomStore(dir);
  let clock = 1_000_000;
  const names: Record<string, { target: string; name: string }> = {
    [A.id]: { target: "chat:wrG", name: "lead" },
    [B.id]: { target: "chat:wrG#b", name: "b" },
  };
  const nameOf = (w: Who): string => (w.kind === "wizard" ? "." + (names[w.id]?.name ?? w.id) : w.id);
  const pasted: Array<{ target: string; text: string }> = [];
  const mirrored: string[] = [];
  const log = { info: () => {}, warn: () => {}, child: () => log } as never;
  const hub = createRoomHub({
    store, log, now: () => clock, wizardOf: (u) => names[u], nameOf, roomLabel: (r) => r,
    mirror: async (row) => { mirrored.push(row.text); return true; },
    live: async () => true, idle: async () => true, interrupt: async () => {},
    paste: async (target, text) => { pasted.push({ target, text }); return "ok"; },
    stopGraceMs: 0,
  });
  const g = "chat:wrG";
  store.ensure(g, { at: 1, kind: "wecom-group", by: DAEMON });
  hub.write(g, [
    { op: "join", at: 1, room: g, who: A, ord: 1, via: "founder", by: DAEMON },
    { op: "join", at: 2, room: g, who: B, ord: 2, via: "spawn", by: A },
    { op: "join", at: 3, room: g, who: T1, ord: 3, via: "inbound", by: DAEMON },
  ]);
  const q = hub.append(g, { author: T1, kind: "say", origin: "inbound", to: [B], text: "任务" });
  assert.ok(q.ok);
  await hub.pump();
  assert.deepEqual(pasted.map((p) => p.target), ["chat:wrG#b"]);
  const n = hub.append(g, { author: B, kind: "reply", origin: "tool", re: [q.ok ? q.row.id : ""], status: "need", statusGiven: true, text: "问你" });
  assert.ok(n.ok);
  await hub.pump();
  pasted.length = 0;
  // 欠账提醒 / Stop hook 只认 wizard: B 已交代过 (need), 没有欠账; 人那条 need 账不会被当 wizard 投
  assert.deepEqual(hub.onStop(B.id), {}, "B 没有欠账, 不拦");
  await hub.onIdle(B.id);
  await hub.pump();
  assert.deepEqual(pasted, [], "人名下的账不产生任何 pane 投递");
  assert.equal(store.get(g)!.msgs.some((m) => m.sys === "undelivered"), false);
  // 逾期扫描: 到 groupMin 在群里写一行 (镜像进企微), 不 remind、不唤醒
  const mkScan = () => createOverdueScan({
    log, now: () => clock, thresholds: () => ({ remindMin: 60, groupMin: 120 }), rooms: store.ids,
    stateOf: (r) => store.get(r), append: (r, d, extra) => hub.append(r, d, extra),
    wizardOf: (u) => names[u], nameOf, roomLabel: (r) => r,
  });
  const at = n.ok ? n.row.at : 0;
  clock = at + 130 * MIN;
  assert.deepEqual(mkScan().scan(), { remind: 0, group: 1, mirrored: 0 }, "绑定 room: 本群一行, 不再转 home");
  const row = store.get(g)!.msgs.find((m) => m.sys === "overdue-group@T1")!;
  assert.match(row.text, /⏰ T1 有一条 \.b 的提问 .* 130 分钟没回/);
  assert.deepEqual(row.wake, []);
  assert.ok(mirrored.some((t) => t.includes("130 分钟没回")), "镜像进企微");
  assert.deepEqual(mkScan().scan(), { remind: 0, group: 0, mirrored: 0 }, "不重复");
  // B 名下那条 (最后一句是 need, 人那条还开着) 没有被 remind
  assert.equal(store.get(g)!.msgs.some((m) => m.sys === "overdue-remind"), false);
  // 人答了 → 叫醒 B (只 B 被投递, host A 不被)
  const ans = hub.append(g, { author: T1, kind: "say", origin: "inbound", text: "main" });
  assert.ok(ans.ok && ans.row.wake.join() === B.id);
  await hub.pump();
  assert.deepEqual(pasted.map((p) => p.target), ["chat:wrG#b"]);
  assert.match(pasted[0]!.text, /你要交代/);

  // 非绑定 room (adhoc): 人名下的账 → 本 room 记一行 + 提问者 home 群一行
  const ad = "adhoc:h1";
  store.ensure(ad, { at: 1, kind: "adhoc", by: DAEMON });
  hub.write(ad, [
    { op: "join", at: 1, room: ad, who: B, ord: 1, via: "founder", by: DAEMON },
    { op: "join", at: 2, room: ad, who: T1, ord: 2, via: "invite", by: B },
  ]);
  const ak = hub.append(ad, { author: B, kind: "ask", origin: "tool", to: [T1], text: "私下问你" });
  assert.ok(ak.ok);
  clock = (ak.ok ? ak.row.at : 0) + 125 * MIN;
  const out = mkScan().scan();
  assert.equal(out.group, 1);
  assert.equal(out.mirrored, 1, "转给提问者的 home 群让人看见");
  const home = store.get(g)!.msgs.filter((m) => m.sys === "overdue-group").pop()!;
  assert.match(home.text, /T1 有一条 \.b 的提问 .*adhoc:h1.* 125 分钟没回/);
}

console.log("room-human-duty ok");
