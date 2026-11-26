// 批3 行 id 短形: 同一 room 块里 hash 段每行重复 (块头已有 #hash8), 行 id / re / 你要交代 只写 seq;
// 模型照抄回短 id 时 daemon 按「本轮唤醒它的 room」补成全 id, 全形永远照认。
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openRoomStore } from "../daemon/rooms.js";
import { createRoomHub } from "../daemon/room-hub.js";
import { expandIds, parseInjection } from "../shared/inject-view.js";
import { DAEMON, expandMsgRef, expandMsgRefs, openDuties, renderMsgLine, roomHash, type MsgRow, type Who } from "../shared/room.js";
import { uid } from "./room-fixture.js";

const H = "a1b2c3d4";
const NAMES = { nameOf: (w: Who) => (w.kind === "wizard" ? "." + w.id : w.id), roomLabel: (r: string) => r };

// ── 解析: 短形 / 全形 / 混在一起 ──────────────────────────────────────
{
  const short = parseInjection("【群G】#" + H + " 群\n[120] .a → .b re=118 [done]: 好了")![0]!;
  assert.equal(short.lines[0]!.id, "120");
  assert.deepEqual(short.lines[0]!.re, ["118"]);
  assert.equal(short.lines[0]!.status, "done");
  assert.equal(short.lines[0]!.text, "好了");

  const multi = parseInjection("【群G】#" + H + " 群\n[7] .a re=1,2,3: x")![0]!;
  assert.deepEqual(multi.lines[0]!.re, ["1", "2", "3"], "多个 re 逗号连");

  const full = parseInjection("【群G】(" + "chat:wrG)\n[" + H + ".120] .a (re " + H + ".118) [done]: 好了")![0]!;
  assert.equal(full.lines[0]!.id, H + ".120", "旧格式全形照认");
  assert.deepEqual(full.lines[0]!.re, [H + ".118"]);

  // 一段里新旧两块混排
  const both = parseInjection("【新】#" + H + " 群\n[5] 张三: 一\n\n【旧】(chat:wrG)\n[" + H + ".6] 张三: 二")!;
  assert.equal(both.length, 2);
  assert.equal(both[0]!.lines[0]!.id, "5");
  assert.equal(both[1]!.lines[0]!.id, H + ".6");
}

// ── expandIds: 短 → 全; 旧块 / 全形原样 ────────────────────────────────
{
  const b = parseInjection("【群G】#" + H + " 群\n[120] .a re=118: x\n你要交代: 120 (ask, 来自 .b)")![0]!;
  const e = expandIds(b);
  assert.equal(e.lines[0]!.id, H + ".120");
  assert.deepEqual(e.lines[0]!.re, [H + ".118"]);
  assert.deepEqual(e.owe, [H + ".120"]);
  assert.equal(b.lines[0]!.id, "120", "原块不被改 (纯函数)");

  const old = parseInjection("【群G】(chat:wrG)\n[wrG.9] .a: x")![0]!;
  assert.equal(expandIds(old), old, "没有 roomHash 的块原样返回");

  const mixed = parseInjection("【群G】#" + H + " 群\n[5] .a re=" + H + ".7: x")![0]!;
  assert.equal(expandIds(mixed).lines[0]!.id, H + ".5");
  assert.deepEqual(expandIds(mixed).lines[0]!.re, [H + ".7"], "已经全形的 id 不动");
}

// ── 渲染: 给 hash → 短; 不给 → 全; re 有跨块的就留全形 ────────────────
{
  const row = {
    op: "msg", id: H + ".120", seq: 120, room: "chat:wrG", at: 1, ord: 1, speak: "member", kind: "reply",
    author: { kind: "wizard", id: "a" }, text: "好了", wake: [], re: [H + ".118"], status: "done",
  } as unknown as MsgRow;
  assert.equal(renderMsgLine(row, NAMES, 500, H), "[120] .a re=118 [done]: 好了", "同块短形 (re= 紧凑)");
  assert.equal(renderMsgLine(row, NAMES), "[" + H + ".120] .a (re " + H + ".118) [done]: 好了", "不给 hash = 全形 (老路径 / 跨 room)");
  assert.equal(renderMsgLine({ ...row, re: [H + ".118", "ffee0011.3"] } as MsgRow, NAMES, 500, H),
    "[120] .a (re " + H + ".118,ffee0011.3) [done]: 好了", "re 有不在本块的就整体退回全形 (可解析)");
  assert.equal(renderMsgLine({ ...row, re: [] } as unknown as MsgRow, NAMES, 500, H), "[120] .a [done]: 好了", "没有 re 就不带");
}

// ── 工具侧补全: 一个 room 才补 ────────────────────────────────────────
{
  const R = "chat:wrG", h = roomHash(R);
  assert.deepEqual(expandMsgRef("120", [R]), { id: h + ".120" }, "单 room: 补成全 id");
  const none = expandMsgRef("120", []);
  assert.ok(none.error && none.error.includes("#hash8"), "0 room (刚 reload): 给可行动报错, 教模型拿块头 hash 拼全形: " + none.error);
  assert.deepEqual(expandMsgRef(H + ".120", []), { id: H + ".120" }, "0 room 但已是全形: 照旧直通");
  assert.deepEqual(expandMsgRef("乱七八糟", []), { id: "乱七八糟" }, "0 room 的垃圾 id: 原样穿透 (交原解析报不认识)");
  const amb = expandMsgRef("120", [R, "chat:wrH"]);
  assert.ok(amb.error && amb.error.includes("请用完整 id (hash8.seq)"), "多 room: 明确报歧义: " + amb.error);
  assert.deepEqual(expandMsgRef(h + ".120", [R, "chat:wrH"]), { id: h + ".120" }, "全形永远直通 (跨 room 也行)");
  assert.deepEqual(expandMsgRefs(["1", "2"], [R]), { ids: [h + ".1", h + ".2"] });
  assert.ok(expandMsgRefs(["1", "2"], [R, "chat:wrH"]).error);
}

// ── 端到端 (hub 真路径): 贴出去的短 id 被抄回来 → 补全 → 关账 ──────────
{
  const dir = mkdtempSync(join(tmpdir(), "inject-short-"));
  const store = openRoomStore(dir);
  const A = uid(1), B = uid(2);
  const WA: Who = { kind: "wizard", id: A }, WB: Who = { kind: "wizard", id: B };
  const pasted: string[] = [];
  const hub = createRoomHub({
    store, now: () => 10_000,
    wizardOf: (u) => (u === A ? { target: "chat:wrA", name: "a" } : u === B ? { target: "chat:wrB", name: "b" } : undefined),
    nameOf: (w: Who) => (w.kind === "wizard" ? (w.id === A ? ".a" : ".b") : w.id),
    roomLabel: (r) => r,
    mirror: async () => true,
    live: async () => true,
    idle: async () => true,
    interrupt: async () => undefined,
    paste: async (_t: string, text: string) => { pasted.push(text); return "ok" as const; },
  });
  const R = "chat:wrG";
  store.ensure(R, { at: 1, kind: "wecom-group", by: DAEMON });
  hub.write(R, [
    { op: "join", at: 1, room: R, who: WA, ord: 1, via: "founder", by: DAEMON },
    { op: "join", at: 2, room: R, who: WB, ord: 2, via: "spawn", by: WA },
  ]);
  const ask = hub.append(R, { author: WA, kind: "ask", origin: "tool", to: [WB], text: "看下日志" });
  assert.ok(ask.ok);
  await hub.pump();
  const text = pasted.at(-1)!;
  const seq = ask.ok ? ask.row.id.split(".")[1]! : "";
  assert.ok(text.includes("[" + seq + "] .a → .b: 看下日志"), "行 id 短形: " + text);
  assert.ok(text.includes("你要交代: " + seq + " (ask, 来自 .a)"), "交代行短形: " + text);
  // 模型照抄短 id 回来: 与 daemon 的 /room/reply 同一条补全口 (expandMsgRefs + turnRooms)
  const rooms = hub.turnRooms(B);
  assert.deepEqual(rooms, [R], "B 本轮只被这一个 room 唤醒");
  const refs = expandMsgRefs([seq], rooms);
  assert.ok(refs.ids);
  const v = hub.append(R, { author: WB, kind: "reply", origin: "tool", re: refs.ids!, text: "好了", status: "done", statusGiven: true });
  assert.ok(v.ok && v.row.status === "done");
  assert.deepEqual(v.ok ? v.row.closes : [], [ask.ok ? ask.row.id + "@wizard:" + B : ""], "短 re 补全后真的关掉了那条 duty");
  assert.equal(openDuties(store.get(R)!).length, 0);
}

console.log("inject-short-id: ok");
