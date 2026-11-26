// 「你要交代」用法半句的第一道闸: 同一 uid 投递成功后本进程内不再附 (daemon 重启重给一次)。
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openRoomStore } from "../daemon/rooms.js";
import { createRoomHub } from "../daemon/room-hub.js";
import type { Who } from "../shared/room.js";
import { uid } from "./room-fixture.js";

const A = uid(1), B = uid(2);
const WA: Who = { kind: "wizard", id: A }, WB: Who = { kind: "wizard", id: B };
const wiz: Record<string, { target: string; name: string }> = { [A]: { target: "chat:wrA", name: "a" }, [B]: { target: "chat:wrB", name: "b" } };
let t = 10_000;
const pasted: string[] = [];
const store = openRoomStore(mkdtempSync(join(tmpdir(), "reply-hint-once-")));
const makeHub = () => createRoomHub({
  store, now: () => t,
  wizardOf: (u) => wiz[u],
  nameOf: (w: Who) => (w.kind === "wizard" ? "." + (wiz[w.id]?.name ?? w.id) : w.id),
  roomLabel: (r) => r,
  mirror: async () => true,
  idle: async () => true,
  interrupt: async () => {},
  paste: async (_target, text) => { pasted.push(text); return "ok"; },
  replyHintWindow: () => 0, // 第二道闸 (窗口) 关掉, 只验第一道闸
});
let hub = makeHub();
const R = "adhoc:00000001";
hub.write(R, [
  { op: "open", at: t, room: R, kind: "adhoc", by: WA },
  { op: "join", at: t, room: R, who: WA, ord: 1, via: "founder", by: WA },
  { op: "join", at: t, room: R, who: WB, ord: 2, via: "invite", by: WA },
]);
const ask = async (): Promise<{ id: string; text: string }> => {
  t += 1000;
  const v = hub.append(R, { author: WA, kind: "ask", origin: "tool", to: [WB], text: "活 " + t });
  assert.ok(v.ok);
  await hub.pump();
  return { id: v.ok ? v.row.id : "", text: pasted.at(-1)! };
};
const USAGE = /用 chat_reply\(\{re, text, status\}\) 交代/;

// ① 第一次投递: 附
const first = await ask();
assert.match(first.text, USAGE, "首次带用法半句");
// ② 同一 uid 第二次投递: 不再附, 但 id 短形与「你要交代」照旧
const second = await ask();
assert.doesNotMatch(second.text, USAGE, "同一 uid 第二次投递不再带用法半句");
assert.match(second.text, new RegExp("你要交代: " + second.id.replace(".", "\\.") + " \\(ask, 来自 \\.a\\)$", "m"));
// ③ 换一个 uid 不受影响
t += 1000;
const v3 = hub.append(R, { author: WB, kind: "ask", origin: "tool", to: [WA], text: "反过来 " + t });
assert.ok(v3.ok);
await hub.pump();
assert.match(pasted.at(-1)!, USAGE, "别的 uid 首次仍附");
// ④ daemon 重启 (新 hub) 后重给一次
hub = makeHub();
const fourth = await ask();
assert.match(fourth.text, USAGE, "重启后重给一次");
console.log("room-hub-reply-hint-once ok");
