// 频道名 (wrc.channel.name) / room_name 清除 / 帖子 room 首条人话缩略 firstAsk。
//   ① channelNameOf: 新表 > 旧冻结标签 chats[…]=chat:<T> > "";channelNameOfBase 只认 chat:<T> 形式
//   ② setChannelName: 写内存 + 写 jsonc (热读), 空串清除 (文件里没有这一项也不抛)
//   ③ 账本 fold: name op 空 title = 清名字
//   ④ firstAskOf / buildRoomFact: 第一条人话 ~20 字缩略, 帖子 room 才带; 去 markdown / 折空白; 没人话 = 缺省
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigSchema } from "../shared/config.js";
import { applyOp, DAEMON } from "../shared/room.js";
import { buildRoomFact, firstAskOf } from "../shared/room-view.js";
import { channelNameOf, channelNameOfBase } from "../daemon/channel-posts.js";
import { setChannelName } from "../daemon/onboarding.js";
import { H, room as mkRoom, say, uid, W } from "./room-fixture.js";

const ROOT = mkdtempSync(join(tmpdir(), "channel-name-"));
const cfgOf = (name: Record<string, string> = {}, chats: Record<string, string> = {}) =>
  ConfigSchema.parse({
    bot: { botId: "test", secret: "test" },
    daemon: { stateDir: join(ROOT, "state") },
    wrc: { allowFrom: ["user:tester"], channel: { history: { enabled: false }, name } },
    defaultChat: "user:home",
    chats,
  });

// ① 优先级
assert.equal(channelNameOf(cfgOf(), "T1"), "", "都没有 = 空 (前端回落 topic_id 前 8 位)");
assert.equal(channelNameOf(cfgOf({}, { "老名字": "chat:T1" }), "T1"), "老名字", "旧冻结标签兜底");
assert.equal(channelNameOf(cfgOf({ T1: "  新名字 " }, { "老名字": "chat:T1" }), "T1"), "新名字", "新表优先, 且去空白");
assert.equal(channelNameOf(cfgOf({ T1: "  " }, { "老名字": "chat:T1" }), "T1"), "老名字", "新表只有空白 = 没写");
assert.equal(channelNameOfBase(cfgOf({ T1: "新名字" }), "chat:T1"), "新名字");
assert.equal(channelNameOfBase(cfgOf({ T1: "新名字" }), "chat:T2"), "");
assert.equal(channelNameOfBase(cfgOf({ T1: "新名字" }), "topic:T1/p"), "", "帖子 room 不是频道键");

// ② 写 / 清
const file = join(ROOT, "config.jsonc");
writeFileSync(file, '{\n  // 注释要保住\n  "wrc": { "channel": { "name": { "TX": "别的频道" } } }\n}\n');
const cfg = cfgOf({ TX: "别的频道" });
setChannelName(cfg, file, "T1", "  研发  频道 ");
assert.equal(cfg.wrc.channel.name.T1, "研发 频道", "内存即时生效, 空白折叠");
assert.match(readFileSync(file, "utf8"), /"T1": "研发 频道"/);
assert.match(readFileSync(file, "utf8"), /注释要保住/, "jsonc 注释保留");
setChannelName(cfg, file, "T1", "");
assert.equal(cfg.wrc.channel.name.T1, undefined, "空串清除");
assert.equal(cfg.wrc.channel.name.TX, "别的频道", "别的频道不受影响");
assert.doesNotMatch(readFileSync(file, "utf8"), /T1/);
setChannelName(cfg, file, "T9", ""); // 文件里本就没有 T9: 不抛

// ③ name op 空 title = 清除
const r = mkRoom("topic:T1/p1", [W(uid(1))]);
applyOp(r, { op: "name", at: 5, room: r.id, title: "起个名", by: W(uid(1)) });
assert.equal(r.title, "起个名");
applyOp(r, { op: "name", at: 6, room: r.id, title: "", by: W(uid(1)) });
assert.equal(r.title, undefined, "空 title 清掉名字");
applyOp(r, { op: "name", at: 7, room: r.id, title: "", by: W(uid(1)) });
assert.equal(r.title, undefined, "重复清除幂等");

// ④ firstAsk
const N = { nameOf: (w: { id: string }) => w.id, roomLabel: (x: string) => x };
const chOf = (room: string) => (room.startsWith("topic:T1/") ? { channel: "T1", post: room.slice(9) } : undefined);
const t = mkRoom("topic:T1/p1", [W(uid(1))]);
assert.equal(firstAskOf(t), "", "没人说话 = 空");
assert.equal(buildRoomFact(t, N, chOf).firstAsk, undefined, "空 = 不带字段");
say(t, { author: W(uid(1)), text: "我先说" }); // wizard 的话不算
assert.equal(firstAskOf(t), "");
say(t, { author: H("alice"), text: "  **帮我\n看看**   这个   报错 为什么 CI 一直红 红 红 红\n" }, { origin: "inbound" } as never);
const f = buildRoomFact(t, N, chOf);
assert.equal(f.firstAsk, Array.from("帮我 看看 这个 报错 为什么 CI 一直红 红 红 红").slice(0, 20).join("") + "…");
say(t, { author: H("bob"), text: "第二个人" });
assert.equal(buildRoomFact(t, N, chOf).firstAsk, f.firstAsk, "只取第一条");
const short = mkRoom("topic:T1/p2", [W(uid(1))]);
say(short, { author: H("alice"), text: "短问题" });
assert.equal(buildRoomFact(short, N, chOf).firstAsk, "短问题", "不超长不加省略号");
const grp = mkRoom("chat:wrG", [W(uid(1))]);
say(grp, { author: H("alice"), text: "群里的话" });
assert.equal(buildRoomFact(grp, N, chOf).firstAsk, undefined, "只有帖子 room 带");

console.log("channel-name ok");
