// 反问过人、人另发新话作答 (不带引用): 唤醒文本的「你要交代」要把原 duty 一并列出并加标注。
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openRoomStore } from "../daemon/rooms.js";
import { createRoomHub } from "../daemon/room-hub.js";
import { DAEMON, type Who } from "../shared/room.js";
import { uid } from "./room-fixture.js";

const A = uid(1);
const WA: Who = { kind: "wizard", id: A };
const T1: Who = { kind: "human", id: "T1" }, T2: Who = { kind: "human", id: "T2" };
let t = 10_000;
const pasted: string[] = [];
const store = openRoomStore(mkdtempSync(join(tmpdir(), "need-answered-")));
const hub = createRoomHub({
  store, now: () => t,
  wizardOf: (u) => (u === A ? { target: "chat:wrA", name: "a" } : undefined),
  nameOf: (w: Who) => (w.kind === "wizard" ? ".a" : w.id),
  roomLabel: (r) => r,
  mirror: async () => true,
  idle: async () => true,
  interrupt: async () => {},
  paste: async (_target, text) => { pasted.push(text); return "ok"; },
});
let n = 0;
const mk = (): string => {
  const room = "chat:wrN" + ++n;
  store.ensure(room, { at: 1, kind: "wecom-group", by: DAEMON });
  hub.write(room, [{ op: "join", at: 1, room, who: WA, ord: 1, via: "founder", by: DAEMON }]);
  return room;
};
const human = async (room: string, who: Who, text: string, re?: string[]): Promise<string> => {
  t += 1000;
  const v = hub.append(room, { author: who, kind: "say", origin: "inbound", text, ...(re ? { re } : {}) });
  assert.ok(v.ok);
  await hub.pump();
  return v.ok ? v.row.id : "";
};
const needReply = (room: string, re: string): void => {
  t += 1000;
  assert.ok(hub.append(room, { author: WA, kind: "reply", origin: "tool", status: "need", statusGiven: true, re: [re], text: "要哪个?" } as never).ok);
};
const oweOf = (text: string): string => text.split("\n").find((l) => l.startsWith("你要交代:")) ?? "";

// (1) 人话 A → need → 人新话 B (不引用) → 交代同时含 B 与 A, A 带标注, B 在前
{
  const room = mk();
  const a = await human(room, T1, "帮我看下 x");
  needReply(room, a);
  const b = await human(room, T1, "看 main 分支");
  const line = oweOf(pasted.at(-1)!);
  assert.ok(line.includes(b + " (human") && line.includes(a + " (human, 来自 T1 · 你反问过"), line);
  assert.ok(line.indexOf(b) < line.indexOf(a), "原有条目在前, 追加在后");
}
// (2) 别的人发话不带出 A
{
  const room = mk();
  const a = await human(room, T1, "帮我看下 x");
  needReply(room, a);
  await human(room, T2, "无关的话");
  assert.ok(!oweOf(pasted.at(-1)!).includes(a), oweOf(pasted.at(-1)!));
}
// (3) A 已 done 后不再列
{
  const room = mk();
  const a = await human(room, T1, "帮我看下 x");
  needReply(room, a);
  t += 1000;
  assert.ok(hub.append(room, { author: WA, kind: "reply", origin: "tool", status: "done", statusGiven: true, re: [a], text: "好了" } as never).ok);
  await human(room, T1, "谢谢");
  assert.ok(!oweOf(pasted.at(-1)!).includes(a), oweOf(pasted.at(-1)!));
}
// (4) 带引用的老行为不变: 引用 A → 只列被引用那条, 无标注
{
  const room = mk();
  const a = await human(room, T1, "帮我看下 x");
  needReply(room, a);
  const b = await human(room, T1, "看 main", [a]);
  const line = oweOf(pasted.at(-1)!);
  assert.ok(line.includes(a) && !line.includes("你反问过"), line);
  void b;
}
console.log("room-hub-need-answered ok");
