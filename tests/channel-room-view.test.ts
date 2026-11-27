// §2.5 读模型: 频道 / 帖子的 kind 与归属由 channel-posts 映射在读时算 (不落账本), monitor 成员带 role。
// 2026-11-27 (docs/evolve/channel-topic-rooms.md §8): topic room (topic:<T>/<P>) / 旧帖子 room / 存档频道 room
// 都带 channel = {id, name, host?}; /api/world 的 channels 把它们按频道归并 (buildChannelFacts), 给图上画框。
// 删除说明: 旧断言「频道 room 自己没有 channel 指针」随新口径改成「存档频道 room 也属于该频道」。
import assert from "node:assert/strict";
import { applyOp, DAEMON } from "../shared/room.js";
import { buildChannelFacts, buildRoomFact, buildRoomFacts } from "../shared/room-view.js";
import { room as mkRoom, uid, W } from "./room-fixture.js";

const N = { nameOf: (w: { id: string }) => w.id, roomLabel: (r: string) => (r === "chat:T1" ? "研发频道" : r) };
const M = W(uid(9));
const HOST = { identity: "chat:T1", name: "cc-wecom" };
const chOf = (room: string) =>
  room === "chat:T1" ? { channel: "T1", post: "", host: HOST }
  : room === "chat:opkP" ? { channel: "T1", post: "p1", host: HOST }
  : room === "topic:T1/p2" ? { channel: "T1", post: "p2", host: HOST }
  : undefined;

// ① 存档频道 room → kind "channel", 带所属频道 (没有 rootPost)。
const ch = mkRoom("chat:T1", []);
applyOp(ch, { op: "join", at: 2, room: ch.id, who: M, ord: 1, via: "invite", by: DAEMON, role: "monitor" });
const chF = buildRoomFact(ch, N, chOf);
assert.equal(chF.kind, "channel");
assert.deepEqual(chF.channel, { id: "T1", name: "研发频道", host: HOST }, "存档频道 room 也属于该频道, 带 host");
assert.equal(chF.rootPost, undefined);
assert.equal(chF.host, undefined, "只有 monitor 成员时没有 host");
assert.equal(chF.members.find((m) => m.who.id === M.id)?.role, "monitor", "成员态带 role");
assert.equal(chF.members.find((m) => m.who.id === M.id)?.host, false);

// ② 帖子 room → kind "topic-post", 带 channel 指针与 rootPost (名字取频道 room 的显示名)。
const post = mkRoom("chat:opkP", [W(uid(1))]);
const postF = buildRoomFact(post, N, chOf);
assert.equal(postF.kind, "topic-post");
assert.deepEqual(postF.channel, { id: "T1", name: "研发频道", host: HOST });
assert.equal(postF.rootPost, "p1");

// ②b 新口径 topic room: kind topic-post, 频道从映射 (id 解析) 来, 带 rootPost 与 host。
const topic = mkRoom("topic:T1/p2", [W(uid(2))]);
const topicF = buildRoomFact(topic, N, chOf);
assert.equal(topicF.kind, "topic-post");
assert.deepEqual(topicF.channel, { id: "T1", name: "研发频道", host: HOST });
assert.equal(topicF.rootPost, "p2");
assert.equal(topicF.bound, true, "topic room 绑定传输 (评论根帖)");

// ③ 没有映射的普通群照旧 (前缀回落), 不受影响。
const g = mkRoom("chat:wrG", [W(uid(1))]);
assert.equal(buildRoomFact(g, N, chOf).kind, "wecom-group");
assert.equal(buildRoomFact(g, N, chOf).channel, undefined);
// 不给 resolver (独立 svr 无 channel-posts) 时也不炸, 一律普通群。
assert.equal(buildRoomFact(post, N).kind, "wecom-group");

// ④ 频道表: 三个 room 归并成一个频道 (带 host), 没有 room 的已知频道只剩种子也有一个框。
const facts = buildRoomFacts([ch, post, topic, g], N, chOf);
const chans = buildChannelFacts(facts, [{ id: "T9", name: "空频道" }, { id: "T1", name: "研发频道", host: HOST }]);
assert.deepEqual(chans.map((c) => c.id), ["T1", "T9"]);
const t1 = chans.find((c) => c.id === "T1")!;
assert.deepEqual([...t1.rooms].sort(), ["chat:T1", "chat:opkP", "topic:T1/p2"].sort(), "普通群不进任何频道");
assert.deepEqual(t1.host, HOST);
assert.deepEqual(chans.find((c) => c.id === "T9")!.rooms, [], "没有 room 的已知频道仍有一个框");
assert.deepEqual(buildChannelFacts(facts).map((c) => c.id), ["T1"], "没有种子时只从 room 归并");

console.log("channel-room-view ok");
