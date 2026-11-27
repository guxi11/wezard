// 频道引导 (人 2026-11-23 拍板「频道没有管家就该由 guide 接待并走引导绑定」):
//   ① 未绑定频道的第一条人话 → 引导化身在**人说话的 topic room** 接住, 且不建 monitor (monitor 会抢唤醒);
//   ② 绑定落定 → 管家当 host, 引导退场, monitor 补建;
//   ③ 已绑定的频道 → 只有 monitor, 没有引导;
//   ④ topic room 在未绑定频道下诞生不炸 (没有 host, 只有 daemon 建的行)。
// 2026-11-27 (docs/evolve/channel-topic-rooms.md §5): 频道自己没有 room —— 引导状态键是频道键 chat:<topic_id>,
// 引导住 topic:<T>/<P>; 同频道别的帖子再来人话 = 同一条引导 join 那个 room。
// 删除说明: 旧「引导的 room 是频道 room」「人话行带 post」「帖子 room 诞生 (postRoomBirthOps)」随新口径改写。
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigSchema } from "../shared/config.js";
import { applyOp, DAEMON, emptyRoom, leaveOps, openDuties, roomHost, whoKey, type RoomState } from "../shared/room.js";
import { loadWizardStore } from "../daemon/wizard.js";
import { learnChannel, learnChannelPost, postsOfChannel } from "../daemon/channel-posts.js";
import { loadOnboardingStore } from "../daemon/onboarding.js";
import {
  channelGuideJoinOps, channelKeyOf, channelMonitorLeaveOps, channelMonitorWanted, channelOnboardingNeeded,
  hostJoinOps, planChannelGuideTurn, topicRoomBirthOps,
} from "../daemon/channel-onboarding.js";
import { H, room as mkRoom, say, uid, W } from "./room-fixture.js";

const cfgOf = (dir: string, channelSteward: Record<string, string> = {}) =>
  ConfigSchema.parse({
    bot: { botId: "test", secret: "test" },
    daemon: { stateDir: join(dir, "state") },
    wrc: { allowFrom: ["user:tester"], channel: { history: { enabled: false }, steward: channelSteward } },
    defaultChat: "user:home",
  });
const dirOf = (tag: string): string => mkdtempSync(join(tmpdir(), "channel-onboarding-" + tag + "-"));
const G = W(uid(7));   // 引导化身
const M = W(uid(9));   // monitor
const S = W(uid(5));   // 管家

// ── ① 未绑定频道: 引导接住, 没有 monitor ────────────────────────────────
{
  const dir = dirOf("unbound");
  const cfg = cfgOf(dir);
  learnChannel(cfg, "topicU");
  assert.equal(channelKeyOf(cfg, "chat:topicU"), "chat:topicU", "频道键 (存档频道 room) 自己认得出来");
  assert.equal(channelKeyOf(cfg, "topic:topicU/p1"), "chat:topicU", "topic room 从 id 直接回到频道键, 不查映射");
  learnChannelPost(cfg, "chat:opkU", "topicU", "p1");
  assert.equal(channelKeyOf(cfg, "chat:opkU"), "chat:topicU", "旧帖子 room 映射回频道");
  assert.deepEqual(postsOfChannel(cfg, "topicU"), ["chat:opkU"], "帖子表不含频道键自己");

  const store = loadWizardStore(join(dir, "wizards.json"));
  const onb = loadOnboardingStore(cfg);

  // 第一句: 人说话的那个 topic room 就是引导的 room (它此刻没有 host); 状态键是频道键。
  const first = planChannelGuideTurn({ cfg, store, onboarding: onb, room: "topic:topicU/p1" },
    { author: "u1", text: "帮我把这个频道接上", msgid: "m1" });
  assert.ok(first, "未绑定频道要引导");
  assert.equal(first!.key, "chat:topicU", "引导状态键 = 频道键");
  assert.equal(first!.room, "topic:topicU/p1", "引导的 room 是人说话的 topic room");
  assert.equal(first!.guide, "chat:topicU#guide");
  assert.equal(first!.first, true, "第一句 = 开篇");
  assert.equal(first!.human.kind, "say");
  assert.equal(first!.human.ext, "m1", "msgid 作去重键");
  assert.equal((first!.human as { post?: string }).post, undefined, "topic room 的行不带 post");
  assert.equal((first!.human as { src?: string }).src, undefined, "也不带 src");
  assert.equal(channelOnboardingNeeded(cfg, store, "chat:topicU"), true);
  assert.equal(channelMonitorWanted(cfg, store, "chat:topicU"), false, "未绑定不建 monitor");

  // 同频道别的帖子再来人话: 同一条引导 (续接), 落那个帖子的 room —— 一条引导可同时住几个 topic room。
  const second = planChannelGuideTurn({ cfg, store, onboarding: onb, room: "topic:topicU/p2" },
    { author: "u1", text: "继续", msgid: "m2" });
  assert.equal(second!.first, false, "在途引导的第二句 = 续接");
  assert.equal(second!.guide, first!.guide, "一个频道一条引导");
  assert.equal(second!.room, "topic:topicU/p2");

  // 引导入座: 空 room 先 open (kind topic-post) 再以 founder 加入 —— 它就成了 host。
  const opened = channelGuideJoinOps(undefined, "topic:topicU/p1", G, 1_000);
  assert.deepEqual(opened.map((o) => o.op === "open" ? "open:" + o.kind : o.op), ["open:topic-post", "join"]);
  const s: RoomState = emptyRoom("topic:topicU/p1");
  for (const op of opened) applyOp(s, op);
  assert.equal(roomHost(s), G, "引导是最早加入者 → host");
  assert.ok(![...s.members.values()].some((m) => m.role === "monitor"), "没有 monitor");
  const row = say(s, { author: H("u1"), text: "看这个", origin: "inbound" });
  assert.deepEqual(row.wake, [G.id], "人话唤醒引导");
  assert.deepEqual(openDuties(s).map((d) => d.slot), ["host"], "duty 落在 host 槽位 (= 引导名下)");
  // 已经在里面就不再补 join。
  assert.deepEqual(channelGuideJoinOps(s, "topic:topicU/p1", G, 2_000), []);

  // 旧版本给未绑定频道建过 monitor: 引导接手前先请它退场, 否则人话只听它的。
  // (2026-11-24 门控: 有 wizard 成员即接管 —— 引导化身在场也一样会被抢走。)
  const stale = mkRoom("topic:topicU2/p1", [G]);
  applyOp(stale, { op: "join", at: 1_500, room: stale.id, who: M, ord: stale.nextOrd, via: "invite", by: DAEMON, role: "monitor" });
  assert.deepEqual(say(stale, { author: H("u1"), text: "抢一句", origin: "inbound" }).wake, [M.id], "monitor 在场时人话先被它抢走");
  for (const op of channelMonitorLeaveOps(stale, 3_000)) applyOp(stale, op);
  assert.equal(stale.members.size, 1, "monitor 已退场");
  assert.equal(roomHost(stale), G);
  assert.deepEqual(say(stale, { author: H("u2"), text: "再来", origin: "inbound" }).wake, [G.id], "引导接回人话");
}

// ── ② 绑定落定: 管家当 host, 引导退场, monitor 补建 ──────────────────────
{
  const dir = dirOf("bound");
  const cfg = cfgOf(dir, { topicB: "butler" });
  learnChannel(cfg, "topicB");
  const store = loadWizardStore(join(dir, "wizards.json"));
  store.upsert("chat:topicB", { identity: "chat:topicB", kind: "steward", name: "butler-1" });
  assert.equal(channelOnboardingNeeded(cfg, store, "chat:topicB"), false, "绑定后不再引导");
  assert.equal(channelMonitorWanted(cfg, store, "chat:topicB"), true, "绑定后要 monitor");
  const plan = planChannelGuideTurn({ cfg, store, onboarding: loadOnboardingStore(cfg), room: "topic:topicB/p1" },
    { author: "u1", text: "你好", msgid: "m9" });
  assert.equal(plan, undefined, "已绑定频道不交引导");

  // 账本重放: 引导在 → 绑定 → 引导 leave → 管家 join → monitor join。
  const s = mkRoom("topic:topicB/p1", [G]);
  for (const op of leaveOps(s, G, DAEMON, 2_000, "引导完成, 管家接手")) applyOp(s, op);
  assert.equal(s.members.has(whoKey(G)), false, "引导被收走");
  for (const op of hostJoinOps(s, S, 2_100)) applyOp(s, op);
  applyOp(s, { op: "join", at: 2_200, room: s.id, who: M, ord: s.nextOrd, via: "invite", by: DAEMON, role: "monitor" });
  assert.equal(roomHost(s), S, "管家当 host (monitor 不抢)");
  // 2026-11-24 门控 (人二次拍板): 单管家频道也进感知 —— 未点名人话交给 perceptron, 不回落 host。
  const row = say(s, { author: H("u1"), text: "看这个", origin: "inbound" });
  assert.deepEqual(row.wake, [M.id], "单管家: 未点名人话只唤醒 perceptron");
  assert.equal(row.monitor, true);
  assert.deepEqual(openDuties(s), [], "判定前不在 host 槽位开 duty");
}

// ── ③ 已绑定的频道: topic room 建出来就是管家 founder (+ 懒建 monitor), 没有引导 ──
{
  const dir = dirOf("settled");
  const cfg = cfgOf(dir, { topicC: "butler" });
  learnChannel(cfg, "topicC");
  const store = loadWizardStore(join(dir, "wizards.json"));
  store.upsert("chat:topicC", { identity: "chat:topicC", kind: "steward", name: "butler-1" });
  learnChannelPost(cfg, "chat:opkC", "topicC", "p9");
  assert.equal(channelOnboardingNeeded(cfg, store, "chat:topicC"), false);
  assert.equal(channelMonitorWanted(cfg, store, "chat:topicC"), true);
  assert.equal(channelMonitorWanted(cfg, store, channelKeyOf(cfg, "chat:opkC")), true, "帖子 room 跟频道一起要 monitor");
  for (const room of ["chat:opkC", "topic:topicC/p9"]) assert.equal(planChannelGuideTurn({ cfg, store, onboarding: loadOnboardingStore(cfg), room },
    { author: "u1", text: "在吗", msgid: "m10" }), undefined, "已绑定频道的帖子 (旧 / 新口径) 都不交引导: " + room);
  // topic room 诞生时频道已绑定 → 管家 (本 room 的实例) 作 founder 直接进来。
  const born = topicRoomBirthOps("topic:topicC/p9", S, 3_000);
  assert.deepEqual(born.map((o) => o.op === "open" ? "open:" + o.kind : o.op), ["open:topic-post", "join"], "已绑定: 开房 + 管家 founder");
}

// ── ④ topic room 在未绑定频道下诞生: 只有 daemon 开房那一行, 不炸 ────────────
{
  const ops = topicRoomBirthOps("topic:topicU/p3", undefined, 5_000);
  assert.equal(ops.length, 1, "没有 host 就只有 open");
  const s: RoomState = emptyRoom("topic:topicU/p3");
  for (const op of ops) applyOp(s, op);
  assert.equal(roomHost(s), undefined, "topic room 没有 host");
  assert.equal(s.members.size, 0, "一个成员都没有");
  // 绑定后补 host: 同一条 helper 把管家拉进来。
  for (const op of hostJoinOps(s, S, 5_100)) applyOp(s, op);
  assert.equal(roomHost(s), S, "绑定后管家补成 host");
}

console.log("channel-onboarding ok");
