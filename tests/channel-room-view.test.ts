// §2.5 读模型: 频道 / 帖子的 kind 与归属由 channel-posts 映射在读时算 (不落账本), monitor 成员带 role。
import assert from "node:assert/strict";
import { applyOp, DAEMON } from "../shared/room.js";
import { buildRoomFact } from "../shared/room-view.js";
import { room as mkRoom, uid, W } from "./room-fixture.js";

const N = { nameOf: (w: { id: string }) => w.id, roomLabel: (r: string) => (r === "chat:T1" ? "研发频道" : r) };
const M = W(uid(9));
const chOf = (room: string) =>
  room === "chat:T1" ? { channel: "T1", post: "" }
  : room === "chat:opkP" ? { channel: "T1", post: "p1" }
  : undefined;

// ① 频道 room → kind "channel", 没有 post/channel 指针。
const ch = mkRoom("chat:T1", []);
applyOp(ch, { op: "join", at: 2, room: ch.id, who: M, ord: 1, via: "invite", by: DAEMON, role: "monitor" });
const chF = buildRoomFact(ch, N, chOf);
assert.equal(chF.kind, "channel");
assert.equal(chF.channel, undefined, "频道 room 自己没有 channel 指针");
assert.equal(chF.host, undefined, "只有 monitor 成员时没有 host");
assert.equal(chF.members.find((m) => m.who.id === M.id)?.role, "monitor", "成员态带 role");
assert.equal(chF.members.find((m) => m.who.id === M.id)?.host, false);

// ② 帖子 room → kind "topic-post", 带 channel 指针与 rootPost (名字取频道 room 的显示名)。
const post = mkRoom("chat:opkP", [W(uid(1))]);
const postF = buildRoomFact(post, N, chOf);
assert.equal(postF.kind, "topic-post");
assert.deepEqual(postF.channel, { id: "T1", name: "研发频道" });
assert.equal(postF.rootPost, "p1");

// ③ 没有映射的普通群照旧 (前缀回落), 不受影响。
const g = mkRoom("chat:wrG", [W(uid(1))]);
assert.equal(buildRoomFact(g, N, chOf).kind, "wecom-group");
assert.equal(buildRoomFact(g, N, chOf).channel, undefined);
// 不给 resolver (独立 svr 无 channel-posts) 时也不炸, 一律普通群。
assert.equal(buildRoomFact(post, N).kind, "wecom-group");

console.log("channel-room-view ok");
