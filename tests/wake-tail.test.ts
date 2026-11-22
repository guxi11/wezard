// 人话信封删除 + 提醒尾巴改在唤醒时挂 (admin 定; 本测试覆盖这套协议的各面):
//  (a) 账本行 / inbound 交出的人话 == 原话, 不含 <system-reminder (即使收件人是管家、话里点了名)
//  (b) 唤醒渲染里该人话行之后才挂 steward hint / 点名提示; 同伴触发的唤醒不挂; 账本与 pane 文本本身不含尾巴
//  (c) openingOf (turn-opening) 对无信封的新形态唤醒读回 channel = 群 / speaker = user:<id>, dm / adhoc 读回私下
//  (d) 老信封 transcript 仍读回原 channel / speaker
//  (e) 老账本行带尾巴: 读侧 (room_read / 唤醒 render / rolepage 气泡 / 预览) 剥掉末尾的 wezard 提醒块, 不改写老行
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { ConfigSchema } from "../shared/config.js";
import { bindWizardStore, loadWizardStore } from "../daemon/wizard.js";
import { installInboundRouter } from "../daemon/inbound.js";
import { openRoomStore } from "../daemon/rooms.js";
import { createRoomHub } from "../daemon/room-hub.js";
import { humanWakeTail, wakeInjectOpts } from "../daemon/wake-tail.js";
import { noticeSuffixFor, type WakeTail } from "../daemon/notices.js";
import { lastUserTurn, type PeerMention } from "../daemon/peers.js";
import { turnOpening } from "../daemon/turn-opening.js";
import { humanOpening } from "../shared/inject-view.js";
import { DAEMON, renderMsgLine, rowText, type MsgRow, type Who } from "../shared/room.js";
import { renderReminder, renderTail, stripLegacyTail } from "../shared/reminder.js";
import { buildRoomFact, toRoomMsg } from "../shared/room-view.js";
import { uid } from "./room-fixture.js";

const TAG = "<system-reminder";

// ── (a) inbound: 管家收到带点名的人话, 交出去的仍是原话 ───────────────────────
{
  const ROOT = mkdtempSync(join(tmpdir(), "wake-tail-in-"));
  const cfg = ConfigSchema.parse({ bot: { botId: "test", secret: "test" }, wrc: { allowFrom: ["user:tester"] }, defaultChat: "user:home" });
  const store = bindWizardStore(loadWizardStore(join(ROOT, "wizards.json")));
  store.upsert("user:home", { identity: "user:home", name: "gsw", description: "全局管家", kind: "global-steward", bornAt: 1 });
  const handlers = new Map<string, (f: unknown) => Promise<void>>();
  const dispatched: Array<{ text: string; rawText?: string; channel?: string; speaker?: string }> = [];
  const attached = new Set<string>(["user:home"]);
  const bridge = {
    hasMirrorTarget: (t: string) => attached.has(t), status: () => ({ mirrors: [] }),
    getCwd: () => ({ runningCwd: "/home/ws", pendingCwd: "", defaultCwd: "" }),
    newSession: async (t: string) => { attached.add(t); return { ok: true, sessionId: "s1", cwd: "" }; },
    resolvePeerTag: (_who: string, name: string) => name === "b" ? { ok: true, target: "chat:Z#b", foreign: false } : { ok: false },
    dispatch: async (a: { text: string; rawText?: string; channel?: string; speaker?: string }) => { dispatched.push(a); },
    chatRoster: () => [{ base: "user:tester", name: "", self: true, targets: [] }], peers: async () => [],
    interruptPane: async () => ({ ok: true }), killPane: async () => ({ ok: true }), submitPane: async () => ({ ok: true }),
  };
  const client = { on: (e: string, h: (f: unknown) => Promise<void>) => handlers.set(e, h), replyStream: async () => undefined };
  installInboundRouter(client as never, cfg, pino({ level: "silent" }), bridge as never, join(ROOT, "unused.jsonc"), (() => {}) as never);
  const said = "你好, 让 .b 也看一眼这个仓库";
  await handlers.get("message.text")!({ headers: { req_id: "r" }, body: { msgid: "m1", chattype: "single", from: { userid: "tester" }, msgtype: "text", text: { content: said }, create_time: 1700000000000 } });
  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0]!.text, said, "(a) 交给账本的就是原话");
  assert.equal(dispatched[0]!.rawText, said);
  assert.ok(!dispatched[0]!.text.includes(TAG), "(a) 无信封 / hint / 点名提示 / 名册增量");
}

// ── (b) 唤醒渲染: 尾巴只在人话触发时、在该人话行之后挂 ──────────────────────────
const dir = mkdtempSync(join(tmpdir(), "wake-tail-hub-"));
const store = openRoomStore(dir);
const A = uid(1), B = uid(2);
const wiz: Record<string, { target: string; name: string; parentUid?: string }> = {
  [A]: { target: "chat:wrG", name: "steward" }, [B]: { target: "chat:wrG#b", name: "b", parentUid: A },
};
const mention: PeerMention = { tag: "b", target: "chat:wrG#b", chat: "", foreign: false, job: "查日志", cwd: "/w" };
const pasted: Array<{ target: string; text: string; tail?: WakeTail }> = [];
const names = { nameOf: (w: Who) => (w.kind === "wizard" ? "." + (wiz[w.id]?.name ?? w.id) : w.id), roomLabel: (r: string) => r };
const hub = createRoomHub({
  store, now: () => 10_000, wizardOf: (u) => wiz[u], ...names,
  mirror: async () => undefined, live: async () => true, idle: async () => true, interrupt: async () => undefined,
  tailOf: (target, triggers) => humanWakeTail({
    isSteward: (t) => t === "chat:wrG",
    mentionsOf: (_who, text) => (text.includes(".b") ? [mention] : []),
    cwdOf: () => "/w",
  }, target, triggers),
  paste: async (target, text, tail) => { pasted.push({ target, text, tail }); return "ok"; },
});
const room = "chat:wrG";
store.ensure(room, { at: 1, kind: "wecom-group", by: DAEMON });
hub.write(room, [
  { op: "join", at: 1, room, who: { kind: "wizard", id: A }, ord: 1, via: "founder", by: DAEMON },
  { op: "join", at: 2, room, who: { kind: "wizard", id: B }, ord: 2, via: "spawn", by: { kind: "wizard", id: A } },
]);
// pane 放行后 injectText.prepareText 做的事 (mirror-bridge): 原文 + renderTail(信封?, noticeSuffixFor(target, text, via, lead))。
const rendered = (p: { target: string; text: string; tail?: WakeTail }): string =>
  p.text + renderTail("", noticeSuffixFor(p.target, p.text, p.tail?.via, p.tail?.lead));

const human: Who = { kind: "human", id: "admin" };
const hv = hub.append(room, { author: human, kind: "say", origin: "inbound", text: "让 .b 看下日志" });
assert.ok(hv.ok);
assert.equal(store.get(room)!.msgs.at(-1)!.text, "让 .b 看下日志", "(a) 账本行 text == 原话");
assert.ok(!store.get(room)!.msgs.at(-1)!.text.includes(TAG));
await hub.pump();
assert.equal(pasted.length, 1);
assert.equal(pasted[0]!.target, "chat:wrG");
assert.ok(!pasted[0]!.text.includes(TAG), "(b) hub 渲染的唤醒文本本身不含任何尾巴");
assert.deepEqual(pasted[0]!.tail?.via, { human: { channel: room } }, "(b) via = 人话所在 room");
{
  const full = rendered(pasted[0]!);
  const at = (needle: string) => full.indexOf(needle);
  assert.ok(at("让 .b 看下日志") >= 0 && at('wezard="hint"') > at("让 .b 看下日志"), "(b) steward hint 挂在人话行之后");
  assert.ok(at('wezard="mention"') > at('wezard="hint"'), "(b) 点名提示在 hint 之后 (TAIL_ORDER: hint → mention)");
  assert.ok(at("job=\"查日志\"") > at('wezard="mention"'));
  assert.ok(!full.includes('wezard="envelope"'), "(b) 没有人话信封");
}
// 非管家被点名的人话: 只挂点名提示, 不挂管家自查
{
  const noSteward = humanWakeTail({ isSteward: () => false, mentionsOf: () => [mention], cwdOf: () => "" }, "chat:wrG#b", [store.get(room)!.msgs.at(-1)!]);
  const full = noSteward!.lead.map((p) => p(() => false).text).join("");
  assert.ok(full.includes('wezard="mention"') && !full.includes('wezard="hint"'));
}
// 同伴触发的唤醒 (B → A 的 ask): 不挂 steward hint / 点名提示
{
  hub.append(room, { author: { kind: "wizard", id: B }, kind: "ask", origin: "tool", to: [{ kind: "wizard", id: A }], text: "也看下 .b 的结论" });
  await hub.pump();
  assert.equal(pasted.length, 2);
  assert.equal(pasted[1]!.tail, undefined, "(b) 触发行没有人话 → 不挂人话那几种尾巴");
  assert.ok(!rendered(pasted[1]!).includes(TAG));
}
// 老行 (尾巴里有 `.b`) 不被当成人在点名: 点名解析只看原话
{
  const seen: string[] = [];
  const old = { ...store.get(room)!.msgs[0]!, text: "你好\n<system-reminder wezard=\"roster\">\n- .b 查日志\n</system-reminder>" } as MsgRow;
  humanWakeTail({ isSteward: () => false, mentionsOf: (_w, t) => { seen.push(t); return []; }, cwdOf: () => "" }, "chat:wrG", [old]);
  assert.deepEqual(seen, ["你好"], "点名解析读 rowText");
}
// 点名了没人答应的 .x (解析不到) 不广告: 只有 hint
{
  const t = humanWakeTail({ isSteward: () => true, mentionsOf: () => [], cwdOf: () => "" }, "chat:wrG", [store.get(room)!.msgs[0]!]);
  assert.equal(t!.lead.map((p) => p(() => false).text).join("").includes('wezard="mention"'), false);
}

// ── live 路径: 人话触发的唤醒带 channel / speaker (与 reload 后 turnOpening 同规则) ──────
{
  const ports = { isSteward: () => false, mentionsOf: () => [], cwdOf: () => "" };
  const row = (r: string, author: Who, id: string) => ({ ...store.get(room)!.msgs[0]!, id, room: r, author, text: "hi" }) as MsgRow;
  // 非 home 群的人话 → channel = 该群, speaker = user:<id>
  const grp = wakeInjectOpts(humanWakeTail(ports, "chat:wrG", [row("chat:wrOther", { kind: "human", id: "carol" }, "o.1")]));
  assert.deepEqual([grp.requireIdle, grp.channel, grp.speaker], [true, "chat:wrOther", "user:carol"], "非 home 群人话: live 也记成那个群 + 发话人");
  // adhoc / dm 里的人话 → 私下 ""
  const adhoc = wakeInjectOpts(humanWakeTail(ports, "chat:wrG", [row("adhoc:abc", { kind: "human", id: "admin" }, "a.1")]));
  assert.deepEqual([adhoc.channel, adhoc.speaker], ["", "user:admin"], "adhoc 人话: channel 空串 (私下), 不是 home");
  // 多条触发: 取最后一条人话 (与 humanOpening 同), 夹着的同伴行不算
  const multi = wakeInjectOpts(humanWakeTail(ports, "chat:wrG", [
    row("chat:wrG", { kind: "human", id: "a" }, "g.1"), row("chat:wrG", { kind: "wizard", id: B }, "g.2"), row("chat:wrH", { kind: "human", id: "c" }, "h.1"),
  ]));
  assert.deepEqual([multi.channel, multi.speaker], ["chat:wrH", "user:c"]);
  // 同伴触发 (无人话) → 不传 channel / speaker / tail
  const peer = wakeInjectOpts(humanWakeTail(ports, "chat:wrG", [row("chat:wrG", { kind: "wizard", id: B }, "g.3")]));
  assert.deepEqual(peer, { requireIdle: true }, "无人话触发: 保持现状, 什么都不传");
  // 与 reload 读回一致: 同一段 (单人话) 唤醒文本, humanOpening 给出同样的 room / speaker
  assert.deepEqual(humanOpening("【g】(chat:wrOther)\n[o.1] carol: hi\n你要交代: o.1 (human, 来自 carol) —— x"), { room: "chat:wrOther", speaker: "carol" });
}
// R2: 有「你要交代」行时只认交代点到的人话行; 点到的都不是人话 → 读不出 (同伴派活, 未读上下文里的人话不是发话人)
{
  const wake = "【g】(chat:wrG)\n[g.1] admin: 帮我看下\n[g.2] .b: 你也看下 .x\n你要交代: g.2 (ask, 来自 .b) —— 用 chat_reply({re, text, status}) 交代。";
  assert.equal(humanOpening(wake), undefined, "R2: 交代的是同伴派的活, 未读上下文里的人话不算发话人");
  // 人话行也被交代点到 (多条里取交代点到的最后一条人话)
  const both = "【g】(chat:wrG)\n[g.1] admin: 一\n[g.2] carol: 二\n[g.3] .b: 三\n你要交代: g.1 (human, 来自 admin); g.3 (ask, 来自 .b) —— x";
  assert.equal(humanOpening(both)?.speaker, "admin", "R2: 交代点到 g.1 (人) 与 g.3 (同伴): 取点到的人话, 不取未点到的 carol");
  // 没有交代行 (room_watch 订阅者): 回落最后一条人话
  assert.equal(humanOpening("【g】(chat:wrG)\n[g.1] admin: 一\n[g.2] carol: 二")?.speaker, "carol");
}

// ── (c) / (d) openingOf: 新形态读回 channel / speaker; 老信封照读 ───────────────
const jsonl = (rows: unknown[]): string => {
  const p = join(mkdtempSync(join(tmpdir(), "wake-tail-tr-")), "s.jsonl");
  writeFileSync(p, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return p;
};
const userRow = (content: string, ts: string) => ({ type: "user", timestamp: ts, message: { role: "user", content } });
const pasteWrap = (s: string) => `<pasted_content id="p1">\n${s}\n</pasted_content id="p1">`;
const HOME = "chat:wrG";
const opening = (content: string, home = HOME) => turnOpening(lastUserTurn(jsonl([userRow(content, "2026-11-22T10:00:00Z")])), home, () => undefined);
{
  // 绑定群里人说话: channel = 群 (非 home), speaker = user:<id>; 唤醒前挂着宪章 preamble + 尾巴也不影响
  const charter = '<system-reminder wezard="charter">\n你是 wizard\n</system-reminder>\n';
  const wake = "【某群】(chat:wrOther)\n[wrOther.3] admin: 你好\n你要交代: wrOther.3 (human, 来自 admin) —— 用 chat_reply({re, text, status}) 交代。";
  const o = opening(charter + pasteWrap(wake + renderReminder({ wezard: "hint" }, ["管家自查"])));
  assert.equal(o?.channel, "chat:wrOther", "(c) 人话唤醒头的 room = 群 → channel");
  assert.equal(o?.speaker, "user:admin", "(c) 触发行作者 = 人 → speaker");
  // home 群说话: channel = 群 base principal (== home, consumeChannel 会把它折回缺省)
  assert.equal(opening(pasteWrap("【g】(chat:wrG)\n[wrG.1] tester: hi"))?.channel, HOME);
  // 单聊 room id = user:xxx 也是绑定 room
  assert.equal(opening("【t】(user:tester)\n[user:tester.1] tester: hi")?.channel, "user:tester");
  // dm / adhoc: 私下 (人偶然在 adhoc 里说话也是私下 channel "")
  const dm = opening(pasteWrap("【a ↔ b】(dm:w1|w2)\n[w1.4] .a (re x) [done]: 回你\n"));
  assert.equal(dm, undefined, "(c) dm 里只有 wizard 行 → 没有人话行, 读不出 (回落最近一轮印章)");
  const adhoc = opening(pasteWrap("【x, y】(adhoc:abc)\n[abc.2] admin: 来看看\n"));
  assert.deepEqual([adhoc?.channel, adhoc?.speaker], ["", "user:admin"], "(c) adhoc 里的人话 → 私下 channel");
  // 同伴 / 系统触发的 room 唤醒: 没有出处可读
  assert.equal(opening("【g】(chat:wrG)\n[wrG.5] .b: 完成了\n[wrG.6] wezard: [wezard] 提醒\n"), undefined);
  // 多条: 取最后一条人话行
  const multi = opening("【g1】(chat:wrG)\n[a.1] admin: 一\n\n【g2】(chat:wrH)\n[b.1] .x: 二\n[b.2] carol: 三");
  assert.deepEqual([multi?.channel, multi?.speaker], ["chat:wrH", "user:carol"]);
}
{
  // (d) 老人话信封: home 群缺省 → home; 带 chat-key → 那个群; 速记 speaker 取 from
  const envHome = opening("你好" + renderReminder({ wezard: "envelope", kind: "human", from: "admin" } as never, []));
  assert.deepEqual([envHome?.channel, envHome?.speaker], [HOME, "user:admin"], "(d) 老 home 群信封 → home");
  const envAway = opening("你好" + '\n<system-reminder wezard="envelope" kind="human" from="admin" chat="某群" chat-key="chat:wrX">\n</system-reminder>');
  assert.deepEqual([envAway?.channel, envAway?.speaker], ["chat:wrX", "user:admin"], "(d) 老带 chat-key 信封 → 原群");
  // 老信封 + 里面的老尾巴 + 老形态 room 唤醒 (人话行带尾巴): 信封优先
  const oldWake = "【某群】(chat:wrX)\n[wrX.1] admin: 你好" + '\n<system-reminder wezard="envelope" kind="human" from="admin" chat-key="chat:wrX">\n</system-reminder>\n<system-reminder wezard="hint">\nx\n</system-reminder>';
  assert.equal(opening(oldWake)?.channel, "chat:wrX");
  // 定时任务信封照旧
  const task = opening("到点了" + renderReminder({ wezard: "envelope", kind: "task", from: "t1", scope: "public", "chat-key": "chat:wrG" }, []));
  assert.deepEqual([task?.channel, task?.from], ["chat:wrG", { kind: "task", taskId: "t1" }]);
  // 老私聊 (同伴) 信封 → channel ""
  assert.equal(opening("x" + '\n<system-reminder wezard="envelope" kind="peer" from=".b" scope="private">\n</system-reminder>')?.channel, "");
}

// ── (e) 老账本行带尾巴: 读侧剥掉, 不改写 ─────────────────────────────────────
{
  const legacyText = '你好\n<system-reminder wezard="envelope" kind="human" from="admin">\n</system-reminder>\n<system-reminder wezard="hint">\n管家自查\n</system-reminder>\n<system-reminder wezard="roster">\n- x\n</system-reminder>';
  const row = { op: "msg", at: 5, room, id: "wrG.99", seq: 99, author: human, ord: 0, speak: "human", kind: "say", text: legacyText, wake: [], origin: "inbound" } as unknown as MsgRow;
  assert.equal(rowText(row), "你好", "(e) 读侧剥末尾 wezard 块");
  assert.equal(row.text, legacyText, "(e) 不改写老行");
  assert.ok(!renderMsgLine(row, names).includes(TAG), "(e) room_read / 唤醒渲染的行");
  assert.ok(renderMsgLine(row, names).endsWith(": 你好"));
  assert.equal(toRoomMsg(row, names).text, "你好", "(e) rolepage 气泡");
  // 图片 @path 行在尾巴之后 (index 先拼尾巴再续图): 路径保留
  assert.equal(stripLegacyTail(legacyText + "\n@/a/b.png"), "你好\n@/a/b.png");
  // 只剥末尾: 原话里引用的 reminder 字面量与非 inbound 行不动
  const quoted = '看这段:\n<system-reminder wezard="hint">\nfoo\n</system-reminder>\n然后呢';
  assert.equal(rowText({ text: quoted, origin: "inbound" }), quoted);
  assert.equal(rowText({ text: legacyText, origin: "tool" }), legacyText, "wizard 写的行不碰");
  // 预览 (room fact)
  const s = store.get(room)!;
  const fact = buildRoomFact({ ...s, msgs: [...s.msgs, row] } as never, names);
  assert.equal(fact.last?.preview, "你好", "(e) room 预览不含尾巴");
}
console.log("wake-tail ok");
