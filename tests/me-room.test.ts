// .me 用户全局分身 (daemon/me-room.ts + inbound 分流 + approval 卡路由):
// ① 惰性身份 ② me-room 开房/judge 语义 (duty/host/humanCloses/唤醒/占位覆盖)
// ③ meRowMirror 出站 (标注/兜底私聊) ④ 审批卡 targetChatId 剥 #me → 用户 DM
// ⑤ inbound .me 分流 (resolve → 说话人自己的 me)。
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { bindWizardStore, loadWizardStore } from "../daemon/wizard.js";
import { openRoomStore } from "../daemon/rooms.js";
import { createRoomHub } from "../daemon/room-hub.js";
import { isBoundRoom, mirrors, openDuties, roomHost, type Draft, type MsgRow, type RoomOp, type Who } from "../shared/room.js";
import { ensureMeWizard, ensureMeRoom, meChannelSay, meRowMirror, meRoomId, meTargetOf, namesMe, ME_MARK } from "../daemon/me-room.js";
import { targetChatId } from "../daemon/approval.js";
import { uid, W } from "./room-fixture.js";
import { ConfigSchema } from "../shared/config.js";
import { installInboundRouter } from "../daemon/inbound.js";

// ── ① 惰性身份: 首次 .me 落 kind "me" 记录, 名字不占保留字 "me", 幂等 ──────
const ROOT = mkdtempSync(join(tmpdir(), "me-room-"));
const store = bindWizardStore(loadWizardStore(join(ROOT, "wizards.json")));
assert.equal(store.get(meTargetOf("tester")), undefined, "用前无记录");
const t1 = ensureMeWizard(store, "tester");
assert.equal(t1, "user:tester#me");
const rec = store.get(t1)!;
assert.equal(rec.kind, "me");
assert.equal(rec.parent, undefined, "me 不归任何 wizard 管");
assert.ok(rec.name.startsWith("me-tester"), "名字 me-<userid> 起手: " + rec.name);
assert.notEqual(rec.name, "me", "绝不占保留字 me");
assert.ok(rec.description.length > 0);
assert.equal(ensureMeWizard(store, "tester"), t1, "幂等");
assert.equal(store.get(meTargetOf("tester")), rec, "幂等不重复 upsert");
const t2 = ensureMeWizard(store, "other");
assert.equal(t2, "user:other#me", "每用户一个");
assert.notEqual(store.get(t2)!.name, rec.name);

// ── ② me-room: 开房 (me=host, 人入座) + judge 全套沿用 ──────────────────
const ME = W(uid(9));
const H1: Who = { kind: "human", id: "tester" };
const rdir = mkdtempSync(join(tmpdir(), "me-hub-"));
const rstore = openRoomStore(rdir);
const log = { info: () => {}, warn: () => {}, child: () => log } as never;
const mirrored: Array<{ row: MsgRow; cover?: MsgRow }> = [];
const hub = createRoomHub({
  store: rstore, log, now: () => 1_000,
  wizardOf: (u) => (u === ME.id ? { target: "user:tester#me", name: "me-tester" } : undefined),
  nameOf: (w: Who) => (w.kind === "wizard" ? "." + (w.id === ME.id ? "me-tester" : w.id) : w.id),
  roomLabel: (r) => r, mirror: async (row, cover) => { mirrored.push({ row, cover }); return true; },
  live: async () => false, idle: async () => true, interrupt: async () => {}, paste: async () => "ok",
});
const meDeps = { state: (r: string) => rstore.get(r), write: (r: string, ops: never) => hub.write(r, ops), meUid: () => ME.id };
const room = ensureMeRoom(meDeps, "tester");
assert.equal(room, meRoomId("tester"), "room id me:<userid>");
const s0 = rstore.get(room)!;
assert.equal(s0.kind, "dm");
assert.equal(s0.members.size, 2, "me + 人");
assert.ok(s0.members.has("wizard:" + ME.id) && s0.members.has("human:tester"));
assert.deepEqual(roomHost(s0), ME, "me 是 host (唯一 wizard)");
ensureMeRoom(meDeps, "tester");
assert.equal(rstore.get(room)!.members.size, 2, "幂等: 不再写 join");
assert.equal(rstore.get(room)!.memberLog.length, 2);

// me: 前缀不是 dm:/adhoc: → isBoundRoom = true: 人话照常开 duty / 唤醒。
assert.equal(isBoundRoom(room), true, "me-room 按绑定 room 开 duty (dutiesOpenedBy 口径)");

// 人话 (用户 .me 行): 落 me-room, 开 host (me) 槽位 duty, 唤醒 me。
const v1 = hub.append(room, { author: H1, kind: "say", text: "帮我看看仓库", origin: "inbound",
  ext: "st1", bubble: { stream: "st1", expires: 2_000 } });
assert.ok(v1.ok);
assert.ok(v1.row.wake.includes(ME.id), "唤醒 me");
assert.deepEqual(openDuties(rstore.get(room)!).map((d) => d.slot), ["host"], "duty 开在 host=me 槽位");
assert.equal(mirrors(v1.row), false, "人话行不镜像 (origin inbound)");

// me 交代 (chat_reply done): 关账 + 镜像覆盖人话占位 (cover = 用户行)。
const v2 = hub.append(room, { author: ME, kind: "reply", text: "安排上了", re: [v1.row.id], origin: "tool", status: "done", statusGiven: true });
assert.ok(v2.ok);
assert.equal(openDuties(rstore.get(room)!).length, 0, "done 关账");
assert.equal(mirrors(v2.row), true, "me 的回复行走镜像闸 (roomMirror 的 me 分支接管)");
assert.equal(mirrored.length, 1);
assert.equal(mirrored[0]!.row.id, v2.row.id);
assert.equal(mirrored[0]!.cover?.id, v1.row.id, "占位气泡覆盖链: 第一条 re 它的 reply 收口它");

// me 反问 (need): 开在人名下; 用户的下一句 .me 关账并叫醒 me。
const v3 = hub.append(room, { author: H1, kind: "say", text: "还有件事", origin: "inbound" });
assert.ok(v3.ok && v3.row.wake.includes(ME.id));
const v4 = hub.append(room, { author: ME, kind: "reply", text: "哪个仓库?", re: [v3.row.id], origin: "tool", status: "need", statusGiven: true });
assert.ok(v4.ok);
const open = openDuties(rstore.get(room)!);
const humanDuty = open.find((d) => d.kind === "need");
assert.ok(humanDuty, "need 开在人名下");
assert.equal(humanDuty!.slot, "human:tester");
assert.equal(open.length, 2, "host 那笔 (me 还欠着) + need 各一笔");
const v5 = hub.append(room, { author: H1, kind: "say", text: "cc-wecom", origin: "inbound" });
assert.ok(v5.ok);
assert.ok((v5.row.closes ?? []).includes(humanDuty!.key), "人的下一句关掉 need");
const after = openDuties(rstore.get(room)!);
assert.equal(after.length, 2, "need 关了; 但这句人话又开一笔 host 账 (每句 .me 都开)");
assert.ok(after.every((d) => d.slot !== "human:tester"), "人名下无欠账, me 的账只有 me 自己 chat_reply 能关");
assert.ok(after.some((d) => d.slot === "wizard:" + ME.id), "关了谁的账, 这句就点名谁 (duty 直落 me 名下)");
assert.ok(v5.row.wake.includes(ME.id), "关账把提问者 me 补进收话人 → 唤醒 me");

// ── ③ meRowMirror: 标注 + 占位覆盖 > 兜底私聊 ────────────────────────────
const sent: Array<{ principal: string; md: string }> = [];
const covered: Array<{ msgid: string; md: string }> = [];
const media: Array<{ principal: string; spec: unknown }> = [];
const mdeps = {
  authorTargetOf: (u: string) => (u === ME.id ? "user:tester#me" : undefined),
  coverBubble: async (msgid: string, md: string) => { covered.push({ msgid, md }); return true; },
  sendMedia: async (principal: string, spec: unknown) => { media.push({ principal, spec }); return { ok: true }; },
  notify: (principal: string, md: string) => { sent.push({ principal, md }); },
};
const row = (over: Partial<MsgRow>): MsgRow => ({ op: "msg", at: 1, room: "me:tester", id: "x.9", seq: 9, author: ME, ord: 1, speak: "member", kind: "reply", text: "正文", wake: [], origin: "tool", ...over });
assert.equal(await meRowMirror(row({}), undefined, mdeps), true);
assert.equal(sent.length, 1, "无占位 → 兜底私发用户 DM");
assert.equal(sent[0]!.principal, "user:tester");
assert.ok(sent[0]!.md.includes(ME_MARK) && sent[0]!.md.includes("正文"), "带 .me 独立对话标注");
assert.equal(await meRowMirror(row({}), v1.row, mdeps), true);
assert.equal(covered.length, 1, "有占位 → 覆盖 (回发生地), 不私发");
assert.equal(covered[0]!.msgid, v1.row.ext);
assert.equal(sent.length, 1, "覆盖成功后不再兜底");
assert.equal(await meRowMirror(row({ text: "  " }), undefined, mdeps), false, "空正文无文件不出站");
assert.equal(await meRowMirror(row({ text: "", files: [{ path: "/tmp/a.png", kind: "image", name: "a.png" }] }), undefined, mdeps), true);
assert.equal(media.length, 1, "文件走用户私聊");
assert.equal(media[0]!.principal, "user:tester");
assert.equal(await meRowMirror(row({ text: "看图", files: [{ path: "/tmp/a.png", kind: "image", name: "a.png" }] }), undefined, mdeps), true);
assert.equal(media.length, 2);
assert.ok(sent.at(-1)!.md.includes("看图"), "文件随正文兜底私发");

// ── ④ 审批卡路由: me 会话 target 剥 #tag → 用户 DM chatid ────────────────
assert.equal(targetChatId("user:tester#me"), "tester", "me 的审批卡一律到用户私聊");
assert.equal(targetChatId("user:abc"), "abc");
assert.equal(targetChatId("chat:wc1#x"), "wc1");

// ── ⑤ inbound 分流: .me → 说话人自己的 me; 裸消息仍走管家接待 ────────────
const cfg = ConfigSchema.parse({
  bot: { botId: "test", secret: "test" },
  wrc: { allowFrom: ["user:tester"] },
  defaultChat: "user:home",
});
const istore = bindWizardStore(loadWizardStore(join(ROOT, "wizards2.json")));
istore.upsert("user:home", { identity: "user:home", name: "gsw", description: "全局管家", kind: "global-steward", bornAt: 1 });
const handlers = new Map<string, (f: unknown) => Promise<void>>();
const dispatched: Array<{ principal: string; text: string }> = [];
const ibridge = {
  hasMirrorTarget: (t: string) => t === "user:home",
  status: () => ({ mirrors: [] }),
  getCwd: () => ({ runningCwd: "", pendingCwd: "", defaultCwd: "" }),
  newSession: async () => ({ ok: true, sessionId: "s1", cwd: "" }),
  dispatch: async (a: { principal: string; text: string }) => { dispatched.push({ principal: a.principal, text: a.text }); },
  chatRoster: () => [{ base: "user:tester", name: "", self: true, targets: [] }],
  peers: async () => [],
  interruptPane: async () => ({ ok: true }),
  killPane: async () => ({ ok: true }),
  submitPane: async () => ({ ok: true }),
};
const iclient = { on: (e: string, h: (f: unknown) => Promise<void>) => handlers.set(e, h), replyStream: async () => {} };
installInboundRouter(iclient as never, cfg, pino({ level: "silent" }), ibridge as never, join(ROOT, "u.jsonc"), (() => {}) as never);
const msgOf = (text: string) => ({
  headers: { req_id: text },
  body: { msgid: text, chattype: "single", from: { userid: "tester" }, msgtype: "text", text: { content: text }, create_time: 1700000000000 },
});
await handlers.get("message.text")!(msgOf(".me 帮我看看这个仓库"));
assert.equal(dispatched.at(-1)!.principal, "user:tester#me", ".me 分流到说话人自己的 me");
assert.ok(dispatched.at(-1)!.text.includes("帮我看看"), "剥掉 .me 头的正文");
const irec = istore.get("user:tester#me")!;
assert.equal(irec.kind, "me");
assert.ok(irec.name.startsWith("me-tester"));
await handlers.get("message.text")!(msgOf(".me 还有吗"));
assert.equal(dispatched.at(-1)!.principal, "user:tester#me", "后续 .me 仍进同一会话 (连续对话)");
assert.equal(istore.all().filter((w) => w.kind === "me").length, 1, "不重复建记录");

// ── ⑥ 频道 / 帖子: 点名 .me 没 @ 机器人也直达 me, 发生地零行 ──────────────
assert.equal(namesMe(".me 看一眼"), true);
assert.equal(namesMe("这周有空看下吗 .me"), true, "句中点名也算 (频道没有开头 tag 的概念)");
assert.equal(namesMe("\u{1F9D9}\u200D\u2642\uFE0F me 看下"), true, "🧙‍♂️ me 同一套记号");
assert.equal(namesMe("me 看下"), false, "裸 me 不是点名");
assert.equal(namesMe("看下 .mailer 那个"), false, "别的 .名字 不归 me");

const cdir = mkdtempSync(join(tmpdir(), "me-channel-"));
const cstore = openRoomStore(cdir);
const cme = ensureMeWizard(store, "chatter");
const cmeRec = store.get(cme)!;
const coldStarts: string[] = [];
const mhub = createRoomHub({
  store: cstore, log, now: () => 5_000,
  wizardOf: (u) => (u === cmeRec.uid ? { target: cme, name: cmeRec.name } : undefined),
  nameOf: (w: Who) => (w.kind === "wizard" ? "." + (store.byUid(w.id)?.name ?? w.id) : w.id),
  roomLabel: (r) => r, mirror: async () => true,
  live: async () => false, idle: async () => true, interrupt: async () => {}, paste: async () => "ok",
});
const cdeps = {
  store, state: (r: string) => cstore.get(r),
  write: (r: string, ops: readonly RoomOp[]) => { mhub.write(r, ops); },
  append: (r: string, d: Draft) => mhub.append(r, d),
  ensureSession: (t: string) => { coldStarts.push(t); },
};
const chSay = (text: string, over: Record<string, unknown> = {}) =>
  meChannelSay(cdeps, { author: "chatter", text, src: "chat:topic1", post: "p1", ...over });

assert.equal(chSay("这周有空看下吗"), undefined, "没点名 .me → 不接管 (照旧落发生地 room)");
const c1 = chSay(".me 检查下现在有多少个活跃的 room")!;
assert.ok(c1?.ok, "点名 .me → 落行");
assert.equal(c1!.row.room, meRoomId("chatter"), "落他的私有 me-room");
assert.ok(c1!.row.wake.includes(cmeRec.uid!), "开 duty 唤醒 me");
assert.equal(cstore.get("chat:topic1"), undefined, "发生地零行 (host / perceptron 看不见这句)");
assert.deepEqual(coldStarts, [cme], "me 冷着就顺手起会话");
assert.equal(cstore.get(meRoomId("chatter"))!.byId.get(c1!.row.id)!.src, "chat:topic1", "行上记发生地");
// 评论 (没 @ 机器人) 一样; 走帖子源时 src 是帖子 room, post 可省。
const c2 = chSay("这个帖子你跟进一下 \u{1F9D9}\u200D\u2642\uFE0F me", { src: "chat:opk1", post: undefined })!;
assert.ok(c2.ok);
assert.equal(c2.row.room, meRoomId("chatter"));
assert.equal(openDuties(cstore.get(meRoomId("chatter"))!).length, 2, "两条人话各开一笔 host 账 (都欠 me)");
assert.deepEqual(coldStarts, [cme, cme], "已经热了也交给调用方判 (它自己看 hasMirrorTarget)");

console.log("me-room: identity + room ledger + mirror + approval routing + inbound shunt + channel shunt all passed");
