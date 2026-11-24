// 频道引导 (人 2026-11-23 拍板「频道没有管家就该由 guide 接待并走引导绑定」):
//   ① 未绑定频道的第一条人话 → 引导化身在频道 room 接住, 且不建 monitor (monitor 会抢唤醒);
//   ② 绑定落定 → 管家当 host, 引导退场, monitor 补建;
//   ③ 已绑定的频道 → 只有 monitor, 没有引导;
//   ④ 帖子 room 在未绑定频道下诞生不炸 (没有 host, 只有 daemon 建的行)。
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigSchema } from "../shared/config.js";
import { applyOp, DAEMON, emptyRoom, leaveOps, openDuties, roomHost, whoKey, type RoomState } from "../shared/room.js";
import { loadWizardStore } from "../daemon/wizard.js";
import { learnChannelPost, learnChannelRoom, postsOfChannel } from "../daemon/channel-posts.js";
import { loadOnboardingStore } from "../daemon/onboarding.js";
import {
  channelGuideJoinOps, channelMonitorLeaveOps, channelMonitorWanted, channelOnboardingNeeded, channelRoomOf,
  hostJoinOps, planChannelGuideTurn, postRoomBirthOps,
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
  learnChannelRoom(cfg, "topicU");
  assert.equal(channelRoomOf(cfg, "chat:topicU"), "chat:topicU", "频道 room 自己认得出来");
  learnChannelPost(cfg, "chat:opkU", "topicU", "p1");
  assert.equal(channelRoomOf(cfg, "chat:opkU"), "chat:topicU", "帖子 room 映射回频道");
  assert.deepEqual(postsOfChannel(cfg, "topicU"), ["chat:opkU"], "帖子表不含频道 room 自己");

  const store = loadWizardStore(join(dir, "wizards.json"));
  const onb = loadOnboardingStore(cfg);

  // 第一句: 帖子 room 来的话也要转进频道 room (帖子 room 此刻没有 host)。
  const first = planChannelGuideTurn({ cfg, store, onboarding: onb, room: "chat:opkU" },
    { author: "u1", text: "帮我把这个频道接上", msgid: "m1" });
  assert.ok(first, "未绑定频道要引导");
  assert.equal(first!.channelRoom, "chat:topicU", "引导的 room 是频道 room, 不是帖子 room");
  assert.equal(first!.guide, "chat:topicU#guide");
  assert.equal(first!.first, true, "第一句 = 开篇");
  assert.equal(first!.human.kind, "say");
  assert.equal(first!.human.ext, "m1", "msgid 作去重键");
  assert.equal(first!.human.post, "p1", "归属于哪个帖子跟着搬过去");
  assert.equal(channelOnboardingNeeded(cfg, store, "chat:topicU"), true);
  assert.equal(channelMonitorWanted(cfg, store, "chat:topicU"), false, "未绑定不建 monitor");

  const second = planChannelGuideTurn({ cfg, store, onboarding: onb, room: "chat:topicU" },
    { author: "u1", text: "继续", msgid: "m2", post: "p1" });
  assert.equal(second!.first, false, "在途引导的第二句 = 续接");

  // 引导入座: 空 room 先 open 再以 founder 加入 —— 它就成了 host。
  const s: RoomState = emptyRoom("chat:topicU");
  for (const op of channelGuideJoinOps(undefined, "chat:topicU", G, 1_000)) applyOp(s, op);
  assert.equal(roomHost(s), G, "引导是最早加入者 → host");
  assert.ok(![...s.members.values()].some((m) => m.role === "monitor"), "没有 monitor");
  const row = say(s, { author: H("u1"), text: "看这个", origin: "inbound" });
  assert.deepEqual(row.wake, [G.id], "人话唤醒引导");
  assert.deepEqual(openDuties(s).map((d) => d.slot), ["host"], "duty 落在 host 槽位 (= 引导名下)");
  // 已经在里面就不再补 join。
  assert.deepEqual(channelGuideJoinOps(s, "chat:topicU", G, 2_000), []);

  // 旧版本给未绑定频道建过 monitor: 引导接手前先请它退场, 否则人话只听它的。
  // 2026-11-24 门控: 感知器要候选 ≥2 才接管 —— 房里得有第二个成员, 「抢唤醒」才成立。
  const stale = mkRoom("chat:topicU2", [G, S]);
  applyOp(stale, { op: "join", at: 1_500, room: stale.id, who: M, ord: stale.nextOrd, via: "invite", by: DAEMON, role: "monitor" });
  assert.deepEqual(say(stale, { author: H("u1"), text: "抢一句", origin: "inbound" }).wake, [M.id], "monitor 在场时人话先被它抢走");
  for (const op of channelMonitorLeaveOps(stale, 3_000)) applyOp(stale, op);
  assert.equal(stale.members.size, 2, "monitor 已退场");
  assert.equal(roomHost(stale), G);
  assert.deepEqual(say(stale, { author: H("u2"), text: "再来", origin: "inbound" }).wake, [G.id], "引导接回人话");
}

// ── ② 绑定落定: 管家当 host, 引导退场, monitor 补建 ──────────────────────
{
  const dir = dirOf("bound");
  const cfg = cfgOf(dir, { topicB: "butler" });
  learnChannelRoom(cfg, "topicB");
  const store = loadWizardStore(join(dir, "wizards.json"));
  store.upsert("chat:topicB", { identity: "chat:topicB", kind: "steward", name: "butler-1" });
  assert.equal(channelOnboardingNeeded(cfg, store, "chat:topicB"), false, "绑定后不再引导");
  assert.equal(channelMonitorWanted(cfg, store, "chat:topicB"), true, "绑定后要 monitor");
  const plan = planChannelGuideTurn({ cfg, store, onboarding: loadOnboardingStore(cfg), room: "chat:topicB" },
    { author: "u1", text: "你好", msgid: "m9" });
  assert.equal(plan, undefined, "已绑定频道不交引导");

  // 账本重放: 引导在 → 绑定 → 引导 leave → 管家 join → monitor join。
  const s = mkRoom("chat:topicB", [G]);
  for (const op of leaveOps(s, G, DAEMON, 2_000, "引导完成, 管家接手")) applyOp(s, op);
  assert.equal(s.members.has(whoKey(G)), false, "引导被收走");
  for (const op of hostJoinOps(s, S, 2_100)) applyOp(s, op);
  applyOp(s, { op: "join", at: 2_200, room: s.id, who: M, ord: s.nextOrd, via: "invite", by: DAEMON, role: "monitor" });
  assert.equal(roomHost(s), S, "管家当 host (monitor 不抢)");
  // 2026-11-24 门控: 只有管家一个 wizard 时未点名人话不进感知, 照旧落 host。
  const row = say(s, { author: H("u1"), text: "看这个", origin: "inbound" });
  assert.deepEqual(row.wake, [S.id], "单管家: 照旧唤醒 host");
  assert.equal(row.monitor, undefined);
  assert.deepEqual(openDuties(s).map((d) => d.slot), ["host"]);
  // 候选 ≥2 (第二个成员入座) 才交给 perceptron。
  applyOp(s, { op: "join", at: 2_300, room: s.id, who: W(uid(3)), ord: s.nextOrd, via: "invite", by: DAEMON });
  const row2 = say(s, { author: H("u1"), text: "再看这个", origin: "inbound" });
  assert.deepEqual(row2.wake, [M.id], "候选 ≥2: 只唤醒 perceptron");
  assert.equal(row2.monitor, true);
  assert.deepEqual(openDuties(s).filter((d) => d.msg === row2.id), [], "判定前不在 host 槽位开 duty");
}

// ── ③ 已绑定的频道: 频道 room 建出来就是管家 founder + monitor, 没有引导 ──
{
  const dir = dirOf("settled");
  const cfg = cfgOf(dir, { topicC: "butler" });
  learnChannelRoom(cfg, "topicC");
  const store = loadWizardStore(join(dir, "wizards.json"));
  store.upsert("chat:topicC", { identity: "chat:topicC", kind: "steward", name: "butler-1" });
  learnChannelPost(cfg, "chat:opkC", "topicC", "p9");
  assert.equal(channelOnboardingNeeded(cfg, store, "chat:topicC"), false);
  assert.equal(channelMonitorWanted(cfg, store, "chat:topicC"), true);
  assert.equal(channelMonitorWanted(cfg, store, "chat:opkC"), true, "帖子 room 跟频道一起要 monitor");
  assert.equal(planChannelGuideTurn({ cfg, store, onboarding: loadOnboardingStore(cfg), room: "chat:opkC" },
    { author: "u1", text: "在吗", msgid: "m10" }), undefined, "已绑定频道的帖子也不交引导");
  // 帖子 room 诞生时频道有 host (绑定后) → 管家作 founder 直接进来。
  const born = postRoomBirthOps("chat:opkC", S, 3_000);
  assert.deepEqual(born.map((o) => o.op), ["open", "join"], "已绑定: 开房 + 管家 founder");
}

// ── ④ 帖子 room 在未绑定频道下诞生: 只有 daemon 开房那一行, 不炸 ────────────
{
  const ops = postRoomBirthOps("chat:opkU", undefined, 5_000);
  assert.equal(ops.length, 1, "没有 host 就只有 open");
  const s: RoomState = emptyRoom("chat:opkU");
  for (const op of ops) applyOp(s, op);
  assert.equal(roomHost(s), undefined, "帖子 room 没有 host");
  assert.equal(s.members.size, 0, "一个成员都没有");
  // 绑定后补 host: 同一条 helper 把管家拉进来。
  for (const op of hostJoinOps(s, S, 5_100)) applyOp(s, op);
  assert.equal(roomHost(s), S, "绑定后管家补成 host");
}

console.log("channel-onboarding ok");
