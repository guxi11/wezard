// 频道 / 帖子 room 的 monitor 纯核心 (§2.1): 成员角色、host 跳过、人话只激活、activate 行。
import assert from "node:assert/strict";
import { applyOp, hostOf, mirrors, openDuties, roomHost, say as _noop } from "../shared/room.js";
import { H, rejects, room as mkRoom, say, uid, W } from "./room-fixture.js";

const A = W(uid(1)), B = W(uid(2)), M = W(uid(9)), H1 = H("u1");

/** 带 monitor 的绑定 room: A 是先入座的 host, M 以 role:"monitor" 加入。 */
const withMonitor = () => {
  const s = mkRoom("chat:wrG", [A, B]);
  applyOp(s, { op: "join", at: 2_000, room: s.id, who: M, ord: s.nextOrd, via: "invite", by: A, role: "monitor" });
  return s;
};

// ① hostOf 跳过 monitor; monitor 不当 host, 也不因加入早而抢 host
{
  assert.equal(hostOf([{ who: H1, ord: 0 }, { who: M, ord: 1, role: "monitor" }, { who: B, ord: 2 }]), B);
  const s = mkRoom("chat:wrG", [A]);
  applyOp(s, { op: "join", at: 2_000, room: s.id, who: M, ord: 1, via: "invite", by: A, role: "monitor" });
  assert.equal(roomHost(s), A, "monitor 不抢 host");
  const solo = mkRoom("chat:wrH", [M]);
  applyOp(solo, { op: "join", at: 1, room: solo.id, who: M, ord: 1, via: "founder", by: M, role: "monitor" });
  assert.equal(roomHost(solo), undefined, "只有 monitor 的 room 没有 host");
}

// ② 有 monitor 时, 没点名的人话只唤醒 monitor、不开 duty
{
  const s = withMonitor();
  const row = say(s, { author: H1, kind: "say", text: "这个怎么弄" });
  assert.deepEqual(row.wake, [M.id], "只唤醒 monitor");
  assert.equal(row.monitor, true);
  assert.deepEqual(openDuties(s), [], "不在 host 槽位开 duty");
  assert.equal(roomHost(s), A);
}

// ③ @ 了机器人的人话直达 host (即使有 monitor), 照旧开 host 槽位 duty
{
  const s = withMonitor();
  const row = say(s, { author: H1, kind: "say", text: "@wezard 看下", mention: "bot" });
  assert.deepEqual(row.wake, [A.id], "直达 host");
  assert.equal(row.monitor, undefined);
  const ds = openDuties(s);
  assert.equal(ds.length, 1);
  assert.equal(ds[0]!.slot, "host");
  assert.equal(ds[0]!.kind, "human");
}

// ④ 点名的人话不受 monitor 影响
{
  const s = withMonitor();
  const row = say(s, { author: H1, kind: "say", text: "帮我", to: [B] });
  assert.deepEqual(row.wake, [B.id]);
  assert.deepEqual(openDuties(s).map((d) => d.slot), ["wizard:" + B.id]);
}

// ⑤ activate: 只给 re 那条人话在 to 名下开 duty, 并唤醒 to
{
  const s = withMonitor();
  const human = say(s, { author: H1, kind: "say", text: "谁来接" });
  const v = say(s, { author: M, kind: "trigger", sys: "activate", re: [human.id], to: [B], text: "" });
  assert.deepEqual(v.wake, [B.id]);
  assert.equal(v.kind, "trigger");
  assert.equal(mirrors(v), false, "trigger 不镜像企微");
  const ds = openDuties(s);
  assert.equal(ds.length, 1);
  assert.equal(ds[0]!.msg, human.id, "duty 挂在那条人话上, 不是 activate 行");
  assert.equal(ds[0]!.slot, "wizard:" + B.id);
  assert.equal(ds[0]!.kind, "human");
  assert.deepEqual(ds[0]!.asker, M);
  applyOp(s, { op: "seen", at: 3_000, room: s.id, who: B, seq: v.seq });
  const done = say(s, { author: B, kind: "reply", re: [human.id], status: "done", statusGiven: true, text: "我来" });
  assert.deepEqual(done.closes, [ds[0]!.key]);
}

// ⑥ to 为空 = 判定不回应: 记一行, 不开 duty
{
  const s = withMonitor();
  const human = say(s, { author: H1, kind: "say", text: "随便说说" });
  const v = say(s, { author: M, kind: "trigger", sys: "activate", re: [human.id], text: "" });
  assert.deepEqual(v.wake, []);
  assert.deepEqual(openDuties(s), []);
}

// ⑦ 同一条人话只能激活一次
{
  const s = withMonitor();
  const human = say(s, { author: H1, kind: "say", text: "谁来接" });
  say(s, { author: M, kind: "trigger", sys: "activate", re: [human.id], to: [B], text: "" });
  const why = rejects(s, { author: M, kind: "trigger", sys: "activate", re: [human.id], to: [A], text: "" }, 409);
  assert.match(why, /已经被激活/);
}

// ⑧ 只能激活最后一条人话; re 必须是人话
{
  const s = withMonitor();
  const first = say(s, { author: H1, kind: "say", text: "第一句" });
  say(s, { author: H1, kind: "say", text: "第二句" });
  assert.match(rejects(s, { author: M, kind: "trigger", sys: "activate", re: [first.id], to: [B], text: "" }, 409), /最后一条人话/);
  const wiz = say(s, { author: A, kind: "say", text: "我说一句" });
  assert.match(rejects(s, { author: M, kind: "trigger", sys: "activate", re: [wiz.id], to: [B], text: "" }, 400), /人话/);
  assert.match(rejects(s, { author: M, kind: "trigger", sys: "activate", text: "" }, 400), /一条 re/);
}

// ⑨ 只有 monitor 能写 activate; 非 monitor 连 trigger 都写不了
{
  const s = withMonitor();
  const human = say(s, { author: H1, kind: "say", text: "谁来接" });
  assert.match(rejects(s, { author: A, kind: "trigger", sys: "activate", re: [human.id], to: [B], text: "" }, 403), /monitor/);
  assert.match(rejects(s, { author: A, kind: "trigger", sys: "other", text: "x" }, 403), /daemon/);
}

// ⑩ 没有 monitor 的 room 仍是旧口径 (人话落 host 槽位)
{
  const s = mkRoom("chat:wrG", [A, B]);
  const row = say(s, { author: H1, kind: "say", text: "在吗" });
  assert.deepEqual(row.wake, [A.id]);
  assert.equal(row.monitor, undefined);
  assert.deepEqual(openDuties(s).map((d) => d.slot), ["host"]);
}
