// room 口径 (契约 §2): 发言权 = 本 room 成员 (owner / speaker / mention 的差别与 strict 额度已退役);
// 一条绑定 room 的人话恰好开一条 duty; 交代只认 chat_reply 的 status —— done/passed/canceled 关账,
// need/progress 不关; 同 re 再答一次不重开也不 403 (只发言)。
import assert from "node:assert/strict";
import { dutiesHeldBy, openDuties, roomHost } from "../shared/room.js";
import { H, rejects, room, say, uid, W } from "./room-fixture.js";

const A = W(uid(1)), B = W(uid(2)), out = W(uid(3));
const human = H("T1");
const chat = "chat:wrStrict";

// ── ① 发言权: 非成员 403 = 100%; 任何 via 进来的成员同权 ──
{
  const s = room(chat, [A, B]);
  for (let i = 0; i < 10; i++) rejects(s, { author: out, text: "路人 " + i }, 403);
  rejects(s, { author: out, text: "", files: [{ path: "/tmp/x", kind: "file", name: "x" }] }, 403);
  // 成员不挂义务即可发言; 文件与文字同一道门 (不需要特殊豁免)
  for (const via of ["founder", "invite", "approve", "mention"] as const) {
    const m = room(chat + ":" + via, [A]);
    void via;
    assert.ok(m.members.get("wizard:" + A.id));
    say(m, { author: A, text: "说一句" });
    say(m, { author: A, text: "", files: [{ path: "/tmp/x", kind: "file", name: "x" }] });
  }
}

// ── ② 每条人话恰好一条 duty (归 host); 点名只开给被点名者 ──
{
  const s = room(chat, [A, B]);
  for (let i = 0; i < 5; i++) say(s, { author: human, origin: "inbound", text: "人话 " + (i + 1) });
  const mine = dutiesHeldBy(s, roomHost(s)!);
  assert.equal(mine.length, 5, "5 条人话 = 5 条 duty (每条恰好 1)");
  assert.equal(new Set(mine.map((d) => d.msg)).size, 5, "一条人话不开两条 duty");
  const named = say(s, { author: human, origin: "inbound", text: ".b 看下", to: [B] });
  assert.equal(dutiesHeldBy(s, A).some((d) => d.msg === named.id), false, "点名的不开给 host");
  assert.equal(dutiesHeldBy(s, B).some((d) => d.msg === named.id), true, "点名开给被点名者");
}

// ── ③ chat_reply: done / passed 关账; 同 re 二次不重开; need 不关 ──
{
  const s = room(chat, [A, B]);
  const m0 = say(s, { author: human, origin: "inbound", text: "第一件" });
  const m1 = say(s, { author: human, origin: "inbound", text: "第二件" });
  const m2 = say(s, { author: human, origin: "inbound", text: "第三件" });
  const owed = (): number => openDuties(s).length;
  assert.equal(owed(), 3);
  const done = say(s, { author: A, kind: "reply", re: [m0.id], text: "答复" });
  assert.equal(done.status, "done", "缺省 status: holder 带正文 = done");
  assert.deepEqual(done.closes, [m0.id + "@host"], "关掉的是 host 槽位的那条");
  assert.equal(owed(), 2, "交付一条, 欠账少一条");
  const passed = say(s, { author: A, kind: "reply", re: [m1.id], status: "passed", statusGiven: true });
  assert.deepEqual(passed.closes, [m1.id + "@host"], "passed 也关账");
  assert.equal(owed(), 1);
  // 同 re 二次: 已经结了 → 只发言, 不重开、不 403、不带 status
  const again = say(s, { author: A, kind: "reply", re: [m0.id], text: "再补一句" });
  assert.equal(again.status, undefined, "已结的 re 只发言");
  assert.equal(again.closes, undefined);
  assert.equal(owed(), 1, "账面不会回到未结");
  assert.equal(owed(), 1);
  // 非 holder 给 status → 403 (不是静默)
  rejects(s, { author: B, kind: "reply", re: [m2.id], status: "done", statusGiven: true, text: "我替它答" }, 403);
  // need 不关, 回头唤醒提问者 (wizard 提的活: 人要看到的是群里的行, 不占 pane)
  const ask = say(s, { author: B, kind: "ask", to: [A], text: "查一下" });
  const need = say(s, { author: A, kind: "reply", re: [ask.id], status: "need", statusGiven: true, text: "要哪个?" });
  assert.deepEqual(need.wake, [B.id], "need 回头唤醒提问者");
  assert.equal(openDuties(s).some((d) => d.msg === ask.id), true, "need 不关账");
}

// ── ④ 交付只走 reply: say / 文件不销账 ──
{
  const s = room(chat, [A]);
  const m = say(s, { author: human, origin: "inbound", text: "问一句" });
  say(s, { author: A, kind: "say", re: [m.id], text: "我在看" });
  say(s, { author: A, kind: "file", re: [m.id], text: "", files: [{ path: "/tmp/x", kind: "file", name: "x" }] });
  assert.equal(openDuties(s).length, 1, "chat_say / 文件不关账");
  const r = say(s, { author: A, kind: "reply", re: [m.id], text: "结论" });
  assert.equal(openDuties(s).length, 0, "chat_reply 才关账");
  assert.equal(r.status, "done");
}

console.log("strict-chat: 成员发言权 / 人话一条 duty / reply 四态关账 / 二次不重开 / 只说文件不销账");
