// room 出站额度 (修复单 §8a, 清单 ⑪): wizard 每轮 ≤3 / 每 room 每分钟 ≤10, 超出 409;
// 换轮恢复; daemon 系统行与人话不计; 不带 text 的 reply 不计。
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openRoomStore } from "../daemon/rooms.js";
import { createRoomHub } from "../daemon/room-hub.js";
import { DAEMON, type Who } from "../shared/room.js";
import { uid } from "./room-fixture.js";

const dir = mkdtempSync(join(tmpdir(), "room-quota-"));
const store = openRoomStore(dir);
const A = uid(1), B = uid(2), C = uid(3);
const wiz: Record<string, { target: string; name: string }> = {
  [A]: { target: "chat:wrG", name: "a" },
  [B]: { target: "chat:wrG", name: "b" },
  [C]: { target: "chat:wrG", name: "c" },
};
const human: Who = { kind: "human", id: "T1" };
let clock = 100_000;
const hub = createRoomHub({
  store, now: () => clock,
  wizardOf: (u) => wiz[u],
  nameOf: (w: Who) => (w.kind === "wizard" ? "." + (wiz[w.id]?.name ?? w.id) : w.id),
  roomLabel: (r) => r,
  mirror: async () => true,
  idle: async () => true,
  interrupt: async () => {},
  paste: async () => "ok",
});
const room = "chat:wrG";
store.ensure(room, { at: 1, kind: "wecom-group", by: DAEMON });
hub.write(room, [
  { op: "join", at: 1, room, who: { kind: "wizard", id: A }, ord: 1, via: "founder", by: DAEMON },
  { op: "join", at: 1, room, who: { kind: "wizard", id: B }, ord: 2, via: "spawn", by: DAEMON },
  { op: "join", at: 1, room, who: { kind: "wizard", id: C }, ord: 3, via: "spawn", by: DAEMON },
]);
const say = (who: string, text = "话") => hub.append(room, { author: { kind: "wizard", id: who }, kind: "say", origin: "tool", text });

// ⑪ 同轮第 4 条 409。
assert.ok(say(A, "1").ok, "第 1 条放行");
assert.ok(say(A, "2").ok, "第 2 条放行");
assert.ok(say(A, "3").ok, "第 3 条放行");
const fourth = say(A, "4");
assert.equal(fourth.ok, false, "同轮第 4 条被拒");
assert.equal((fourth as { status?: number }).status, 409, "409");
assert.match((fourth as { reason?: string }).reason ?? "", /合并成一条/, "文案给出口");

// 被拒的行不落盘、不占 room 额度。
assert.equal(store.get(room)!.msgs.filter((m) => m.text === "4").length, 0, "被拒不落账");

// daemon 系统行与人话不计入 (B 还一条没发, 但 room 里已有 A 的 3 条)。
{
  const sys = hub.append(room, { author: DAEMON, kind: "system", origin: "daemon", sys: "undelivered", text: "[wezard] x 未交代" });
  assert.ok(sys.ok, "daemon 系统行不计额度");
  const h = hub.append(room, { author: human, kind: "say", origin: "inbound", text: "人话" });
  assert.ok(h.ok, "人话不计额度");
  assert.ok(say(B, "b1").ok, "B 第 1 条放行 (daemon/人话没吃掉 room 额度)");
}

// 不带 text 的 reply 不计 (交代 passed 之类)。
{
  const ask = hub.append(room, { author: human, kind: "ask", origin: "inbound", text: "谁看一下", to: [{ kind: "wizard", id: B }], wake: [B] });
  assert.ok(ask.ok);
  // B 已用 1 条 (b1); 再发 2 条到顶。
  assert.ok(say(B, "b2").ok);
  assert.ok(say(B, "b3").ok);
  assert.equal(say(B, "b4").ok, false, "B 同轮到顶");
  const pass = hub.append(room, { author: { kind: "wizard", id: B }, kind: "reply", origin: "tool", text: "", re: [(ask.ok && ask.row.id)!], status: "passed" });
  assert.ok(pass.ok, "不带 text 的 reply 不计额度");
}

// ⑪ 换轮后恢复: turn_end (onIdle) 重置该 wizard 计数。
{
  clock += 1_000;
  assert.equal(say(A, "5").ok, false, "换轮前仍拒");
  void hub.onIdle(A); // 轮终
  assert.ok(say(A, "after-turn").ok, "换轮后恢复");
}

// ⑪ 同 room 每分钟第 11 条 409 (多个 wizard 一起也顶住)。
{
  // 此刻 room 窗口内 (clock ±60s): A 3 + b1 3 + after-turn 1 = 7 条。
  assert.ok(say(C, "c1").ok); // 8
  assert.ok(say(C, "c2").ok); // 9
  assert.ok(say(C, "c3").ok); // 10
  void hub.onIdle(B); void hub.onIdle(C);
  const over = say(B, "room-limit"); // B 换过轮, 个人额度是空的; 但 room 已满 10
  assert.equal(over.ok, false, "同 room 每分钟第 11 条被拒");
  assert.match((over as { reason?: string }).reason ?? "", /1 分钟/, "文案点明 room 窗口");
  // 时间走过 60s 窗口 → 恢复。
  clock += 61_000;
  assert.ok(say(B, "next-minute").ok, "过了 1 分钟窗口恢复");
}

console.log("room-quota: 同轮第 4 条 409 / 同 room 第 11 条 409 / 换轮与过窗恢复 / 系统行人话与裸 reply 不计");
process.exit(0);
