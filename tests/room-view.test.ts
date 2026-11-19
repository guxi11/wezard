// room 读模型 (shared/room-view.ts): 快照 / 历史分页 / W-1 与 W-2 / room_read 的纯文本。
// 断言的是「账本行上的显式字段直译成视图」—— 不再有从 turn 记录推断谁说了什么。
import assert from "node:assert/strict";
import {
  buildRoomFact, buildRoomFacts, dutyFacts, parseWhen, renderRoomRead, roomHistory, roomKindOf, whoRef, wizardMessages,
} from "../shared/room-view.js";
import { emptyRoom, type RenderNames } from "../shared/room.js";
import { H, W, room, say, uid } from "./room-fixture.js";

const A = W(uid(1));
const B = W(uid(2));
const H1 = H("U1");

const NAMES: RenderNames = {
  nameOf: (w) => w.kind === "human" ? (w.id === "U1" ? "张三" : w.id)
    : w.id === A.id ? "alice" : w.id === B.id ? "bob" : w.id,
  roomLabel: (r) => r === "chat:wrG" ? "群G" : r === "dm:" ? "dm" : r,
};

// ── 1. 快照: 成员序 / host / 最后一句 / 未决 duty ─────────────────────
{
  const G = room("chat:wrG", [A, B, H1]);
  const q1 = say(G, { author: H1, kind: "say", text: "谁来搭把手", origin: "inbound" });
  say(G, { author: A, kind: "reply", text: "我来", re: [q1.id], origin: "tool" });

  const f = buildRoomFact(G, NAMES);
  assert.equal(f.id, "chat:wrG");
  assert.equal(f.kind, "wecom-group", "chat: 前缀 = 企微群");
  assert.equal(f.bound, true);
  assert.deepEqual(f.members.map((m) => m.name), ["alice", "bob", "张三"], "成员按加入序");
  assert.deepEqual(f.host, A, "host = 加入序最小的 wizard");
  assert.equal(f.members[0]!.host, true);
  assert.equal(f.members[2]!.host, false, "人不进 host 排序");
  assert.equal(f.members[0]!.via, "founder");
  assert.equal(f.openDuties, 0, "回复关掉了人话开的那条 duty");
  assert.equal(f.last!.preview, "我来");
  assert.equal(f.last!.authorName, "alice");

  // 未决: 再问一句不答
  say(G, { author: A, kind: "ask", to: [B], text: "查一下配置", origin: "tool" });
  const f2 = buildRoomFact(G, NAMES);
  assert.equal(f2.openDuties, 1);
  const ds = dutyFacts(G, NAMES);
  assert.equal(ds.length, 1);
  assert.equal(ds[0]!.kind, "ask");
  assert.equal(ds[0]!.askerName, "alice");
  assert.deepEqual(ds[0]!.holder, B);

  // dm / adhoc 的 kind 与 bound
  const D = room("dm:" + A.id + "|" + B.id, [A, B]);
  const df = buildRoomFact(D, NAMES);
  assert.equal(df.kind, "dm");
  assert.equal(df.bound, false, "无绑定 = 不镜像");
  // kind 缺省 (老账本没写 open 行) 按 id 前缀推
  assert.equal(roomKindOf(emptyRoom("adhoc:1234abcd")), "adhoc");
  assert.equal(roomKindOf(emptyRoom("user:U1")), "wecom-dm");
  assert.equal(roomKindOf(emptyRoom("chat:wrG")), "wecom-group");
  assert.equal(roomKindOf(emptyRoom("chat:wx_abc")), "wx");

  // buildRoomFacts: 最近有动静的在前
  const list = buildRoomFacts([D, G], NAMES);
  assert.equal(list.length, 2);
  assert.equal(list[0]!.id, G.id, "刚说过话的 room 在前");
}

// ── 2. 历史分页 ───────────────────────────────────────────────────────
const G = room("chat:wrG", [A, B, H1]);
const q1 = say(G, { author: H1, kind: "say", text: "谁来搭把手", origin: "inbound" });
const a1 = say(G, { author: A, kind: "reply", text: "我来", re: [q1.id], origin: "tool" });
const q2 = say(G, { author: A, kind: "ask", to: [B], text: "查一下配置", origin: "tool" });
const b1 = say(G, { author: B, kind: "reply", text: "查完了", re: [q2.id], origin: "tool" });

{
  const all = roomHistory(G, { limit: 10 }, NAMES);
  assert.equal(all.total, 4);
  assert.deepEqual(all.msgs.map((m) => m.text), ["谁来搭把手", "我来", "查一下配置", "查完了"]);
  assert.equal(all.earlier, undefined, "一页装得下就不给游标");
  assert.equal(all.msgs[1]!.status, "done");
  assert.deepEqual(all.msgs[1]!.re, [q1.id]);

  const page = roomHistory(G, { limit: 2 }, NAMES);
  assert.deepEqual(page.msgs.map((m) => m.id), [q2.id, b1.id], "取最新的两条");
  assert.equal(page.earlier, q2.id, "游标 = 这一页的第一条");
  const older = roomHistory(G, { limit: 2, before: page.earlier }, NAMES);
  assert.deepEqual(older.msgs.map((m) => m.id), [q1.id, a1.id]);
  assert.equal(older.earlier, undefined);

  const onlyBob = roomHistory(G, { limit: 10, from: B }, NAMES);
  assert.deepEqual(onlyBob.msgs.map((m) => m.text), ["查完了"]);
}

// ── 3. wizard 视图 W-1 / W-2 ─────────────────────────────────────────
const DM = room("dm:" + [A.id, B.id].sort().join("|"), [A, B]);
const d1 = say(DM, { author: B, kind: "say", text: "私聊一句", origin: "tool" });
const d2 = say(DM, { author: A, kind: "reply", text: "收到", re: [d1.id], origin: "tool" });

{
  // W-1: 它说的 (a1, q2) + re 了它的消息 (b1 回 q2)
  const w1 = wizardMessages([G, DM], A.id, {}, NAMES);
  // 跨 room 按时刻合 (两个 room 的 seq 各自从 1 起, 同一毫秒时 chat 在前)
  assert.deepEqual(w1.msgs.map((m) => m.text), ["我来", "收到", "查一下配置", "查完了"]);
  assert.ok(w1.msgs.every((m) => m.roomLabel), "跨 room 的每一条都标出 room");
  assert.equal(w1.msgs[0]!.roomLabel, "群G");
  assert.equal(w1.msgs[1]!.room, DM.id);

  // W-2: 它所在全部 room 的全部消息
  const w2 = wizardMessages([G, DM], A.id, { all: true }, NAMES);
  assert.equal(w2.total, 6);

  // 与 A 无关的 room 不进来
  const OTHER = room("chat:wrX", [B, H1]);
  say(OTHER, { author: B, kind: "say", text: "别处的闲聊", origin: "tool" });
  assert.equal(wizardMessages([G, DM, OTHER], A.id, { all: true }, NAMES).total, 6);

  // 分页游标
  const p = wizardMessages([G, DM], A.id, { all: true, limit: 2 }, NAMES);
  assert.equal(p.msgs.length, 2);
  assert.ok(p.earlier, "更早的消息还有, 给游标");
  const older = wizardMessages([G, DM], A.id, { all: true, limit: 10, before: p.earlier }, NAMES);
  assert.equal(older.msgs.length, 4);
}

// ── 4. room_read 的纯文本 ─────────────────────────────────────────────
{
  const text = (q: Parameters<typeof renderRoomRead>[2], states = [G, DM], viewer = A) =>
    renderRoomRead(states, viewer, q, NAMES).text;
  assert.match(text({ room: "chat:wrG" }), /alice → bob: 查一下配置/);
  assert.match(text({ room: "chat:wrG" }), /\[done\].*查完了/, "reply 的 status 原样写着");
  assert.ok(text({ room: "群G" }).includes("张三: 谁来搭把手"), "room 参数也认聊天名");
  assert.ok(!text({ room: "chat:wrG", limit: 1 }).includes("我来"), "limit 只留最新一条");
  assert.ok(text({ from: "bob", all: true }).includes("查完了"));
  assert.ok(!text({ from: "bob", all: true }).includes("谁来搭把手"), "from 只留这个人说的");
  // 不给 room = W-1, 跨 room 合并, 每行标 room
  const w1 = text({});
  assert.ok(w1.includes("群G") && w1.includes(DM.id), "跨 room 时每行标出 room");
  // room_read 的 status 后缀来自账本行
  assert.ok(w1.includes("[done]"), "reply 的 status 原样写着");
  // 不存在
  assert.match(text({ room: "chat:nope" }), /没有这个 room/);
}

// ── 5. 名字反查 / 时间解析 ───────────────────────────────────────────
{
  assert.deepEqual(whoRef([G, DM], "alice", NAMES), A);
  assert.deepEqual(whoRef([G, DM], "." + "bob", NAMES), B, "带点也认");
  assert.deepEqual(whoRef([G, DM], A.id, NAMES), A, "uid 直接认");
  assert.deepEqual(whoRef([G, DM], "human:U1", NAMES), H1);
  assert.equal(whoRef([G, DM], "nobody", NAMES), undefined);

  const now = Date.now();
  assert.equal(parseWhen("2h", now), now - 2 * 3600_000);
  assert.equal(parseWhen("30m", now), now - 30 * 60_000);
  assert.equal(parseWhen("", now), undefined);
  assert.equal(typeof parseWhen("14:30", now), "number");
}

console.log("room-view: 快照 / 分页 / W-1 与 W-2 / room_read 均按账本行直译");
