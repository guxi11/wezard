// 成员进出 → 系统通知 (shared/room-view.ts memberNotes / noteText): 账本 join / leave 的直译 + 折叠。
// 纯函数, 不碰 daemon: 直接喂 RoomOp 折出的 RoomState。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { listNames, memberNotes, noteText, NOTE_GAP_MS } from "../shared/room-view.js";
import { applyOp, DAEMON, emptyRoom, leaveOps, type JoinVia, type MsgRow, type RenderNames, type RoomOp, type Who } from "../shared/room.js";

const w = (id: string): Who => ({ kind: "wizard", id });
const [A, B, C, D, E, F] = ["a", "b", "c", "d", "e", "f"].map(w) as [Who, Who, Who, Who, Who, Who];
const H1: Who = { kind: "human", id: "U1" };
const NAMES: RenderNames = { nameOf: (x) => x.kind === "daemon" ? "wezard" : x.id === "U1" ? "张三" : "." + x.id, roomLabel: (r) => r };

const join = (room: string, at: number, who: Who, via: JoinVia, by: Who, ord = 1): RoomOp => ({ op: "join", at, room, who, ord, via, by });
const fold = (id: string, ops: RoomOp[]) => ops.reduce(applyOp, emptyRoom(id));
const say = (room: string, at: number, seq: number): RoomOp => ({
  op: "msg", at, room, id: "x." + seq, seq, author: A, ord: 1, speak: "member", kind: "say", text: "hi", wake: [], origin: "tool",
} satisfies MsgRow);
const texts = (s: ReturnType<typeof fold>, involving?: string) => memberNotes(s, NAMES, involving).map((n) => n.text);

// ── 1. 文案表: 每种入座 / 离开 ─────────────────────────────────────
{
  assert.equal(noteText({ op: "join", via: "invite", self: false, by: ".a" }, [".b"]), ".a 邀请了 .b 进群");
  assert.equal(noteText({ op: "join", via: "invite", self: true, by: ".b" }, [".b"]), ".b 加入了群", "自己进 = 不写操作者");
  assert.equal(noteText({ op: "join", via: "invite", self: false, by: "" }, [".b"]), ".b 加入了群", "拿不到操作者就省略");
  assert.equal(noteText({ op: "join", via: "approve", self: false, by: ".a" }, [".b"]), ".a 批准了 .b 入群");
  assert.equal(noteText({ op: "join", via: "spawn", self: false, by: ".a" }, [".b"]), ".a 拉起了 .b 进群");
  assert.equal(noteText({ op: "join", via: "mention", self: false, by: ".a" }, [".b"]), ".a @ 了 .b, 已加入群");
  assert.equal(noteText({ op: "join", via: "transfer", self: false, by: ".a" }, [".b"]), ".a 把任务转交给了 .b, 已加入群");
  assert.equal(noteText({ op: "leave", self: true, by: ".b" }, [".b"]), ".b 退出了群");
  assert.equal(noteText({ op: "leave", self: true, by: ".b", why: "引导完成" }, [".b"]), ".b 退出了群 (引导完成)");
  assert.equal(noteText({ op: "leave", self: false, by: ".a" }, [".b"]), ".b 被 .a 移出群");
  assert.equal(noteText({ op: "leave", self: false, by: "", why: "pane 不存在" }, [".b"]), ".b 被移出群 (pane 不存在)", "daemon 移的不写操作者");
  assert.equal(listNames(["a", "b", "c"]), "a、b、c");
  assert.equal(listNames(["a", "b", "c", "d", "e"]), "a、b、c 等 5 人");
}

// ── 2. 哪些入座不报: founder / migrate / inbound, 以及 dm 开房那一拍 ───
{
  const G = fold("chat:g", [
    join("chat:g", 1, A, "founder", A), join("chat:g", 2, H1, "inbound", DAEMON), join("chat:g", 3, B, "migrate", DAEMON),
    join("chat:g", 10, C, "invite", A, 2), join("chat:g", 20, D, "inbound", DAEMON, 3),
  ]);
  assert.deepEqual(texts(G), [".a 邀请了 .c 进群", ".d 加入了群"], "founder / migrate / 人的隐式入座不报; wizard 首次进群要报 (daemon 写的, 没有操作者)");

  const dm = fold("dm:a|b", [
    { op: "open", at: 5, room: "dm:a|b", kind: "dm", by: A }, join("dm:a|b", 5, A, "founder", A), join("dm:a|b", 5, B, "invite", A, 2),
  ]);
  assert.deepEqual(texts(dm), [], "dm 两个人是定义, 开房那一拍不是事件");
  const dm2 = [...[
    { op: "leave", at: 9, room: "dm:a|b", who: B, by: B } as RoomOp, join("dm:a|b", 20, B, "invite", A, 3),
  ]].reduce(applyOp, dm);
  assert.deepEqual(texts(dm2), [".b 退出了群", ".a 邀请了 .b 进群"], "dm 里后来的退出 / 回补要报");

  const adhoc = fold("adhoc:1", [
    { op: "open", at: 5, room: "adhoc:1", kind: "adhoc", by: A }, join("adhoc:1", 5, A, "founder", A), join("adhoc:1", 5, B, "invite", A, 2), join("adhoc:1", 5, C, "invite", A, 3),
  ]);
  assert.deepEqual(texts(adhoc), [".a 邀请了 .b、.c 进群"], "adhoc 开房时的邀请要报 (并折叠成一条)");
}

// ── 3. 退出 / 被移除: leave 的 by 决定文案, leaveOps 的真实产物 ───────
{
  const base: RoomOp[] = [join("chat:g", 1, A, "founder", A), join("chat:g", 2, B, "invite", A, 2), join("chat:g", 3, C, "invite", A, 3)];
  const s0 = fold("chat:g", base);
  const self = leaveOps(s0, B, B, 100, "").filter((o) => o.op === "leave");
  const kicked = leaveOps(s0, C, A, 101).filter((o) => o.op === "leave");
  const s = [...self, ...kicked].reduce(applyOp, s0);
  const ns = memberNotes(s, NAMES);
  assert.deepEqual(ns.slice(-2).map((n) => [n.kind, n.text]), [["leave", ".b 退出了群"], ["remove", ".c 被 .a 移出群"]]);
  const retired = leaveOps(s, A, DAEMON, 102, "实例退役").filter((o) => o.op === "leave").reduce(applyOp, s);
  assert.equal(memberNotes(retired, NAMES).at(-1)!.text, ".a 被移出群 (实例退役)", "stop_wizard end = daemon 写的 leave");
  // 不在座的人 leave 不产生通知 (fold 里没有它)
  assert.equal(memberNotes(applyOp(retired, { op: "leave", at: 200, room: "chat:g", who: B, by: B }), NAMES).length, memberNotes(retired, NAMES).length);
}

// ── 4. 折叠: 同动作 + 同操作者 + 邻近 + 其间没人说话 ────────────────────
{
  const ops: RoomOp[] = [join("chat:g", 1, A, "founder", A)];
  [B, C, D, E].forEach((x, i) => ops.push(join("chat:g", 100 + i * 10, x, "spawn", A, i + 2)));
  const folded = fold("chat:g", ops);
  const ns = memberNotes(folded, NAMES);
  assert.equal(ns.length, 1);
  assert.equal(ns[0]!.text, ".a 拉起了 .b、.c、.d 等 4 人 进群", "超过三个只列前三");
  assert.equal(ns[0]!.whos.length, 4, "whos 带全部当事人");

  // 其间有人说话 → 断开
  const split = fold("chat:g", [...ops.slice(0, 3), say("chat:g", 115, 1), ...ops.slice(3)]);
  assert.equal(memberNotes(split, NAMES).length, 2, "中间有人说话, 不跨过去折叠");
  // 间隔太久 → 断开
  const gap = fold("chat:g", [ops[0]!, ops[1]!, join("chat:g", 110 + NOTE_GAP_MS + 1, C, "spawn", A, 3)]);
  assert.equal(memberNotes(gap, NAMES).length, 2);
  // 不同操作者 / 不同来路 → 各自一条
  const mixed = fold("chat:g", [ops[0]!, join("chat:g", 100, B, "spawn", A, 2), join("chat:g", 101, C, "spawn", D, 3), join("chat:g", 102, E, "invite", A, 4)]);
  assert.equal(memberNotes(mixed, NAMES).length, 3);
  // 进与退不折在一起
  const inout = fold("chat:g", [ops[0]!, join("chat:g", 100, B, "invite", A, 2), { op: "leave", at: 101, room: "chat:g", who: B, by: B }]);
  assert.deepEqual(texts(inout), [".a 邀请了 .b 进群", ".b 退出了群"]);
  // 已在座者的再次 join (只改 via / by) 不是进出
  const again = applyOp(inout, join("chat:g", 300, C, "invite", A, 5));
  assert.equal(memberNotes(applyOp(again, join("chat:g", 301, C, "approve", A, 5)), NAMES).length, 3);
}

// ── 5. involving: wizard 视图只要与它有关的 (当事人或操作者) ────────────
{
  const s = fold("chat:g", [
    join("chat:g", 1, A, "founder", A), join("chat:g", 100, B, "invite", A, 2), join("chat:g", 200, C, "invite", D, 3),
    { op: "leave", at: 300, room: "chat:g", who: E, by: F },
  ]);
  assert.deepEqual(texts(s, "b"), [".a 邀请了 .b 进群"]);
  assert.deepEqual(texts(s, "a"), [".a 邀请了 .b 进群"], "操作者也算当事");
  assert.deepEqual(texts(s, "zzz"), []);
}

// ── 6. 通知的 id 稳定 (前端轮询靠它判「没变」) ────────────────────────
{
  const mk = () => fold("chat:g", [join("chat:g", 1, A, "founder", A), join("chat:g", 100, B, "invite", A, 2)]);
  assert.equal(memberNotes(mk(), NAMES)[0]!.id, memberNotes(mk(), NAMES)[0]!.id);
  assert.match(memberNotes(mk(), NAMES)[0]!.id, /^mn:[0-9a-f]{8}:100:wizard:b$/);
}

// ── 7. 前端合并 (web/chat.js 的 mergeNotes, 按标记截出来跑) ─────────────
{
  const src = readFileSync(new URL("../web/chat.js", import.meta.url), "utf8");
  const m = /\/\/ <notes-merge>[^\n]*\n([\s\S]*?)\/\/ <\/notes-merge>/.exec(src);
  assert.ok(m, "chat.js 里找得到 notes-merge 标记");
  const mergeNotes = new Function(m![1]!.replace("var mergeNotes =", "return") + "\n")() as (a: unknown[], b: unknown[], c?: string) => Array<{ note?: { id: string }; msg?: { id: string } }>;
  const msgs = [{ id: "m1", at: 100 }, { id: "m2", at: 200 }];
  const notes = [{ id: "n0", at: 50 }, { id: "n1", at: 150 }, { id: "n2", at: 300 }];
  const tag = (xs: ReturnType<typeof mergeNotes>) => xs.map((x) => (x.note ?? x.msg)!.id);
  assert.deepEqual(tag(mergeNotes(msgs, notes, "")), ["n0", "m1", "n1", "m2", "n2"], "到头了: 全部按时间穿插");
  assert.deepEqual(tag(mergeNotes(msgs, notes, "m1")), ["m1", "n1", "m2", "n2"], "还有更早的页: 早于最早已加载消息的通知先不画");
  assert.deepEqual(tag(mergeNotes([], notes, "")), ["n0", "n1", "n2"]);
}

console.log("room-member-notes ok");
