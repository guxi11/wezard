// monitor 判决的落盘形态 (2026-11-23 人定): 完全不写消息行 —— assign op 开 duty, 泵靠它 + 人话未读唤醒。
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRoomHub } from "../daemon/room-hub.js";
import { openRoomStore } from "../daemon/rooms.js";
import { applyOp, DAEMON, foldRoom, judgeActivate, openDuties, wasActivated, type AssignOp, type PerceiveOp, type RoomOp, type Who } from "../shared/room.js";
import { room as mkRoom, uid, W } from "./room-fixture.js";

const A = W(uid(1)), B = W(uid(2)), M = W(uid(9)), H1: Who = { kind: "human", id: "u1" };
const withMonitor = () => {
  const s = mkRoom("chat:wrG", [A, B]);
  applyOp(s, { op: "join", at: 2_000, room: s.id, who: M, ord: s.nextOrd, via: "invite", by: A, role: "monitor" });
  return s;
};
const humanRow = (s: ReturnType<typeof withMonitor>, text = "谁来接") => {
  const op = { op: "msg", at: 3_000, room: s.id, id: s.id + "#" + (s.seq + 1), seq: s.seq + 1,
    author: H1, ord: 0, speak: "human", kind: "say", text, wake: [M.id], origin: "inbound", monitor: true } as const;
  applyOp(s, op);
  return op;
};

// ① assign op 开 duty: asker = 人话作者, via:"assign", 不占 seq、不写消息行; fold 重放一致。
{
  const s = withMonitor();
  const h = humanRow(s);
  const seqBefore = s.seq, msgsBefore = s.msgs.length;
  const op: AssignOp = { op: "assign", at: 4_000, room: s.id, duty: h.id, to: B, asker: H1, by: M };
  applyOp(s, op);
  assert.equal(s.seq, seqBefore, "assign 不占 seq");
  assert.equal(s.msgs.length, msgsBefore, "assign 不写消息行");
  const ds = openDuties(s);
  assert.equal(ds.length, 1);
  assert.equal(ds[0]!.msg, h.id, "duty 挂在人话上");
  assert.equal(ds[0]!.slot, "wizard:" + B.id);
  assert.equal(ds[0]!.kind, "human");
  assert.deepEqual(ds[0]!.asker, H1, "asker = 人话作者 (不是 monitor)");
  assert.equal(ds[0]!.via, "assign");
  assert.equal(ds[0]!.seq, h.seq, "seq 取人话行");
  // 重放: 同一串 op fold 出的 duty 一样 (幂等: 重复 assign 不覆盖)。
  const ops: RoomOp[] = [
    { op: "open", at: 1_000, room: s.id, kind: "wecom-group", by: DAEMON },
    { op: "join", at: 1_000, room: s.id, who: A, ord: 1, via: "founder", by: DAEMON },
    { op: "join", at: 2_000, room: s.id, who: M, ord: 2, via: "invite", by: A, role: "monitor" },
    h as unknown as RoomOp, op, { ...op, at: 9_000 },
  ];
  const re = foldRoom(s.id, ops);
  assert.deepEqual([...re.duties.values()], [...s.duties.values()]);
  assert.equal(re.msgs.filter((m) => m.kind === "trigger").length, 0, "没有任何判决消息行");
}

// ② judgeActivate: 最后一条人话 / 成员 / 一次; 名单可多目标; 存量 trigger 行与 assign 都算「已激活」。
{
  const s = withMonitor();
  const h = humanRow(s);
  assert.deepEqual(judgeActivate(s, M, [h.id], [B]), { ok: true });
  assert.deepEqual(judgeActivate(s, M, [h.id], [A, B]), { ok: true }, "多目标名单 ok");
  assert.equal(judgeActivate(s, M, [h.id], [H1]).ok, false, "非 wizard 400");
  assert.equal(judgeActivate(s, M, [h.id], [W("wzzz")]).ok, false, "非成员 400");
  assert.equal(judgeActivate(s, A, [h.id], [B]).ok, false, "非 perceptron 403");
  applyOp(s, { op: "assign", at: 4_000, room: s.id, duty: h.id, to: B, asker: H1, by: M });
  const again = judgeActivate(s, M, [h.id], [A]);
  assert.equal(again.ok, false);
  if (!again.ok) assert.equal(again.status, 409);
  assert.ok(wasActivated(s, h.id));
  const s2 = withMonitor();
  const h2 = humanRow(s2);
  applyOp(s2, { op: "msg", at: 5_000, room: s2.id, id: s2.id + "#9", seq: 9, author: M, ord: 2, speak: "member",
    kind: "trigger", sys: "activate", text: "", re: [h2.id], to: [B], wake: [B.id], origin: "tool" } as unknown as RoomOp);
  assert.ok(wasActivated(s2, h2.id), "存量 activate trigger 行也算已激活");
  assert.equal(openDuties(s2).length, 1, "存量行的 duty 照旧开出来 (兼容)");
}

// ③ 注入: 被激活者只看到人的原话 + 你要交代 (human, 来自 人), 没有任何 monitor 行; 泵必须唤醒它。
{
  const dir = mkdtempSync(join(tmpdir(), "room-assign-hub-"));
  const store = openRoomStore(dir);
  const log = { info: () => {}, warn: () => {}, child: () => log } as never;
  const pasted = new Map<string, string>();
  const hub = createRoomHub({
    store, log, now: () => 1_000,
    wizardOf: (u) => ({ target: u === M.id ? "chat:t#monitor" : "chat:t#" + u.slice(-4), name: u.slice(-4) }),
    nameOf: (w: Who) => (w.kind === "wizard" ? "." + w.id.slice(-4) : w.id),
    roomLabel: (r) => r, mirror: async () => true, live: async () => false, idle: async () => true,
    interrupt: async () => {}, paste: async (target, text) => { pasted.set(target, text); return "ok"; },
  });
  store.ensure("chat:t", { at: 1, kind: "wecom-group", by: DAEMON });
  hub.write("chat:t", [
    { op: "join", at: 1, room: "chat:t", who: A, ord: 1, via: "founder", by: DAEMON },
    { op: "join", at: 2, room: "chat:t", who: M, ord: 2, via: "invite", by: DAEMON, role: "monitor" },
    { op: "join", at: 3, room: "chat:t", who: B, ord: 3, via: "invite", by: DAEMON },
  ]);
  const h = hub.append("chat:t", { author: H1, kind: "say", text: "这个怎么弄", origin: "inbound" });
  assert.ok(h.ok);
  const msgId = h.ok ? h.row.id : "";
  hub.write("chat:t", [{ op: "assign", at: 3, room: "chat:t", duty: msgId, to: A, asker: H1, by: M }]);
  await hub.pump();
  const text = pasted.get("chat:t#" + A.id.slice(-4)) ?? "";
  assert.ok(text.includes("这个怎么弄"), "注入含人的原话: " + text);
  // 行 id / owe 行在同一个 room 块里用短形 (hash 段在块头): 全形 msgId 的 seq 部分。
  assert.ok(text.includes("你要交代: " + msgId.split(".")[1] + " (human, 来自 u1)"), "owe 行归属人: " + text);
  assert.ok(!text.includes(".mon") && !text.includes("monitor"), "注入里没有任何 monitor 痕迹: " + text);
  assert.equal(store.get("chat:t")!.msgs.filter((m) => m.kind === "trigger").length, 0, "账本里没有判决行");
}

// ④ 人话行已经被别的唤醒读过 (seen 越过) 但 assign 判决更晚 → 仍补唤醒; 投递过之后 (批次比判决晚) 不再重复。
{
  const dir = mkdtempSync(join(tmpdir(), "room-assign-seen-"));
  const store = openRoomStore(dir);
  const log = { info: () => {}, warn: () => {}, child: () => log } as never;
  const hub = createRoomHub({
    store, log, now: () => 10_000,
    wizardOf: (u) => ({ target: "chat:s#" + u.slice(-4), name: u.slice(-4) }),
    nameOf: (w: Who) => (w.kind === "wizard" ? "." + w.id.slice(-4) : w.id),
    roomLabel: (r) => r, mirror: async () => true, live: async () => false, idle: async () => true,
    interrupt: async () => {}, paste: async () => "ok",
  });
  store.ensure("chat:s", { at: 1, kind: "wecom-group", by: DAEMON });
  hub.write("chat:s", [
    { op: "join", at: 1, room: "chat:s", who: A, ord: 1, via: "founder", by: DAEMON },
    { op: "join", at: 2, room: "chat:s", who: M, ord: 2, via: "invite", by: DAEMON, role: "monitor" },
    { op: "join", at: 3, room: "chat:s", who: B, ord: 3, via: "invite", by: DAEMON },
  ]);
  const h = hub.append("chat:s", { author: H1, kind: "say", text: "谁来接", origin: "inbound" });
  const msgId = h.ok ? h.row.id : "";
  // A 的游标越过人话行 (更早一次唤醒批), 但判决在那之后。
  hub.write("chat:s", [
    { op: "seen", at: 2_000, room: "chat:s", who: A, seq: store.get("chat:s")!.seq, batch: true },
    { op: "assign", at: 5_000, room: "chat:s", duty: msgId, to: A, asker: H1, by: M },
  ]);
  let p = hub.pending();
  assert.ok(p.get(A.id)?.get("chat:s")?.some((r) => r.id === msgId), "判决晚于上次唤醒 → 补唤醒");
  // 投递成功后批次比判决新 → 不再重复。
  await hub.pump();
  hub.write("chat:s", [
    { op: "seen", at: 20_000, room: "chat:s", who: A, seq: store.get("chat:s")!.seq, batch: true },
  ]);
  p = hub.pending();
  assert.ok(!p.get(A.id)?.get("chat:s")?.length, "投递过就不再重复唤醒");
}

// ⑤ perceive op (2026-11-24 感知判决): 一条 op 开一串 duty + 记 verdict; 不写消息行; 重放幂等。
{
  const s = withMonitor();
  const h = humanRow(s);
  const seqBefore = s.seq, msgsBefore = s.msgs.length;
  const op: PerceiveOp = { op: "perceive", at: 4_000, room: s.id, duty: h.id, to: [A, B], asker: H1, by: M, why: "A 懂这块, B 在跟" };
  applyOp(s, op);
  assert.equal(s.seq, seqBefore, "perceive 不占 seq");
  assert.equal(s.msgs.length, msgsBefore, "perceive 不写消息行");
  const ds = openDuties(s);
  assert.deepEqual(ds.map((d) => d.slot).sort(), ["wizard:" + A.id, "wizard:" + B.id], "名单逐个开 duty");
  assert.ok(ds.every((d) => d.via === "assign" && d.kind === "human" && d.msg === h.id));
  const v = s.verdicts.get(h.id)!;
  assert.deepEqual(v.to, [A, B], "verdict 记全名单");
  assert.equal(v.why, "A 懂这块, B 在跟");
  assert.ok(wasActivated(s, h.id), "perceive 开的账算已判");
  // 重放幂等: 同一 op 再来一遍不重复开。
  applyOp(s, { ...op, at: 9_000 });
  assert.equal(openDuties(s).length, 2, "重复 perceive 不加开");
}

console.log("room-assign ok (assign/perceive 开 duty / 注入无 perceptron 痕迹 / 存量兼容 / 已读行补唤醒)");
