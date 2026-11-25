// 派活只用 `for` 指一条人话 id、task 里不复述原话时, 接活者要真能读到那条:
// 它不在本批未读里 (游标已过 / 后加入) → 唤醒文本补一行「派活指向的原话」; 已在未读里 → 不重复。
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openRoomStore } from "../daemon/rooms.js";
import { createRoomHub } from "../daemon/room-hub.js";
import { DAEMON, type Who } from "../shared/room.js";
import { uid } from "./room-fixture.js";

const A = uid(1), B = uid(2);
const WA: Who = { kind: "wizard", id: A }, WB: Who = { kind: "wizard", id: B };
const T1: Who = { kind: "human", id: "T1" };
let t = 10_000;
const pasted: Array<{ target: string; text: string }> = [];
const store = openRoomStore(mkdtempSync(join(tmpdir(), "room-ref-quote-")));
const hub = createRoomHub({
  store, now: () => t,
  wizardOf: (u) => (u === A ? { target: "chat:wrA", name: "a" } : u === B ? { target: "chat:wrB", name: "b" } : undefined),
  nameOf: (w: Who) => (w.kind === "wizard" ? (w.id === A ? ".a" : ".b") : w.id),
  roomLabel: (r) => r,
  mirror: async () => true,
  idle: async () => true,
  interrupt: async () => {},
  paste: async (target, text) => { pasted.push({ target, text }); return "ok"; },
});
const lastFor = (target: string): string => [...pasted].reverse().find((p) => p.target === target)?.text ?? "";
let n = 0;
const mk = (): string => {
  const room = "chat:wrQ" + ++n;
  store.ensure(room, { at: 1, kind: "wecom-group", by: DAEMON });
  hub.write(room, [
    { op: "join", at: 1, room, who: WA, ord: 1, via: "founder", by: DAEMON },
    { op: "join", at: 1, room, who: WB, ord: 2, via: "invite", by: DAEMON },
  ]);
  return room;
};
const human = async (room: string, text: string): Promise<string> => {
  t += 1000;
  const v = hub.append(room, { author: T1, kind: "say", origin: "inbound", text });
  assert.ok(v.ok);
  await hub.pump();
  return v.ok ? v.row.id : "";
};
const ask = async (room: string, text: string, forId: string): Promise<void> => {
  t += 1000;
  assert.ok(hub.append(room, { author: WA, kind: "ask", origin: "tool", text, to: [WB], for: forId }).ok);
  await hub.pump();
};

// (1) 人话还在 B 的未读里: 不补引用 (它会连同这条 ask 一起看到)
{
  const room = mk();
  const h = await human(room, "分析一下 WXWorkLog 这个日志");
  await ask(room, "按这个日志排查, 交付结论", h);
  const text = lastFor("chat:wrB");
  assert.ok(text.includes("分析一下 WXWorkLog"), "人话在未读里: " + text);
  assert.ok(!text.includes("派活指向的原话"), "不重复引用: " + text);
}

// (2) B 已读过那条 (游标推过): 补一行引用, 内容就是那条原话
{
  const room = mk();
  const h = await human(room, "分析一下 WXWorkLog 这个日志");
  const s = store.get(room)!;
  const seq = s.msgs.find((m) => m.id === h)!.seq;
  hub.write(room, [{ op: "seen", at: t + 1, room, who: WB, seq, batch: true }]);
  await ask(room, "按这个日志排查, 交付结论", h);
  const text = lastFor("chat:wrB");
  assert.ok(text.includes("派活指向的原话"), "补引用: " + text);
  assert.ok(text.includes("分析一下 WXWorkLog"), "引用带原话: " + text);
  assert.ok(text.indexOf("派活指向的原话") < text.indexOf("你要交代:"), "引用在交代之前");
}

// (3) for 指向别的 room 的行: 本 room 查不到就不造引用
{
  const r1 = mk();
  const other = await human(r1, "别处的话");
  const r2 = mk();
  await human(r2, "这间的话");
  const s2 = store.get(r2)!;
  hub.write(r2, [{ op: "seen", at: t + 1, room: r2, who: WB, seq: s2.seq, batch: true }]);
  await ask(r2, "按这件做", other);
  assert.ok(!lastFor("chat:wrB").includes("派活指向的原话"), lastFor("chat:wrB"));
}

console.log("room-ref-quote ok");
