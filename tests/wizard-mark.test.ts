// v3 P1: wizard 表示 🧙‍♂️ name 的双态 (新头 / 旧 .name 头) 断言; §1.5 修正后另覆盖:
// 记号只留在人面 (气泡头/审批卡), 系统面 (roster/read_chat/rolepage/charter) 只出现裸名。
// 覆盖: 渲染原子、气泡头反解 (旧/新/混排)、行首寻址、正文提及、剥记号 (工具参数收口)、
// addressedResults 三态 (@name / @.name / @🧙‍♂️ name)、md-chunk 不切 ZWJ 序列、envelope 解析不受表示影响。
import assert from "node:assert/strict";
import {
  WIZARD_MARK, MAGE_SRC, nameTokenRe, allNames, stripSigil, said, speakerHead,
  tagHead, chatHead, tagBadge, parseTagHeader, rawTagHeader, withLinkedTagHeader,
  linkTags, unlinkTags, bindTagLinker, isHost, keyOf,
} from "../shared/session-label.js";
import { addressedResults, receiptKeyword, renderPeerEnvelope } from "../daemon/peers.js";
import { addr, renderRoster, type WizardBrief, type RosterRow } from "../daemon/wizard.js";
import { renderChatLog, type LogSession } from "../daemon/chat-log.js";
import { glanceOfTalk, type Directory, type Msg } from "../shared/role-view.js";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEnvelope, renderReminder, envelopeAttrs } from "../shared/reminder.js";
import { splitMarkdown } from "../shared/md-chunk.js";
import { finalKind, openRouter, ops } from "../daemon/router.js";

// ── 词法常量 ────────────────────────────────────────────────────────
assert.equal(WIZARD_MARK, "\u{1F9D9}\u200D\u2642\uFE0F");
assert.equal([...WIZARD_MARK].length, 4);
// MAGE_SRC 放宽形态: 裸 🧙 也认 (输入法丢 ZWJ 段)
assert.ok(new RegExp("^" + MAGE_SRC + " $", "u").test("\u{1F9D9} "));
assert.ok(new RegExp("^" + MAGE_SRC + " ", "u").test(WIZARD_MARK + " "));

// ── 渲染原子 ────────────────────────────────────────────────────────
const BT = "\u0060";
const a = "user:admin", fix = keyOf(a, "fix");
const names: Record<string, string> = { [a]: "admin", [fix]: "fix" };
const urlOf = (t: string) => "https://x.test/role?id=1&role=" + encodeURIComponent(t);
bindTagLinker({ urlOf, nameOf: (t) => names[t] || "", resolve: (n) => n === "fix" ? fix : n === "admin" ? a : undefined, targetOfUrl: (u) => /role\?/.test(u) ? fix : undefined });
assert.equal(tagHead(fix), WIZARD_MARK + " fix");
assert.equal(said(tagHead(fix)), WIZARD_MARK + " fix：");
assert.equal(speakerHead("X", "Y"), "X： Y");
// 卡片徽标: 管家 (群默认) 也带 —— isHost 不再豁免
assert.equal(tagBadge(a), WIZARD_MARK + " admin ");
assert.equal(tagBadge(fix), WIZARD_MARK + " fix ");
// chatHead: host 在自己群照写头 (裸, 不包反引号); slot 包反引号; 公开 peer 轮带 to
assert.equal(chatHead(a, urlOf(a)), "[" + WIZARD_MARK + " admin](" + urlOf(a) + ")：");
assert.equal(chatHead(fix, urlOf(fix)), "[" + BT + WIZARD_MARK + " fix" + BT + "](" + urlOf(fix) + ")：");
assert.equal(chatHead(fix, urlOf(fix), tagHead(a)), "[" + BT + WIZARD_MARK + " fix" + BT + "](" + urlOf(fix) + ")：" + " " + WIZARD_MARK + " admin");
assert.equal(isHost(a), true);

// ── 气泡头反解: 旧形态 (存量 transcript / 引用) ────────────────────────
assert.deepEqual(parseTagHeader(".fix: body"), { fromBot: true, tag: "fix", body: "body" });
assert.deepEqual(parseTagHeader("[.fix](https://x.test/role?id=1): body"), { fromBot: true, tag: "fix", body: "body" });
assert.deepEqual(parseTagHeader(BT + ".fix" + BT + ": body"), { fromBot: true, tag: "fix", body: "body" });

// ── 气泡头反解: 新形态 (渲染产物, 全角冒号; 输入法丢 VS16 / 无空格也认) ──
for (const head of [WIZARD_MARK + " fix：body", "[" + WIZARD_MARK + " fix](https://x.test/role?id=1)：body",
  BT + WIZARD_MARK + " fix" + BT + "：body", "\u{1F9D9} fix：body", WIZARD_MARK + "fix:body"]) {
  const p = parseTagHeader(head);
  assert.equal(p.fromBot, true, head);
  assert.equal(p.tag, "fix", head);
  assert.equal(p.body, "body", head);
}
// 反解不吃行首冒号 / 无关正文
assert.equal(parseTagHeader("：bad").fromBot, false);
assert.equal(parseTagHeader("no head here: ok").fromBot, false);
// rawTagHeader 的 peer 后缀 + seq: 渲染产物往返剥干净 (公开 peer 轮的 to 是链接形态)
const rn = rawTagHeader(withLinkedTagHeader(fix, "body", urlOf(fix), "2/5", a))!;
assert.equal(rn.tag, "fix");
assert.equal(rn.body, "body");
assert.equal(rawTagHeader("[.fix](https://x.test/role?id=1): [.admin](https://x.test/role?id=1) 2/5 body")!.body, "body");
// 混排: 旧头 + 正文里的新提及互不干扰
const mixed = parseTagHeader(".fix: 问一下 " + WIZARD_MARK + " admin 在吗");
assert.equal(mixed.tag, "fix");
assert.ok(mixed.body.includes(WIZARD_MARK + " admin"));

// ── 行首寻址 (inbound parseTag 同一把尺子) ───────────────────────────
const NAME_RE = nameTokenRe();
const strip = (s: string) => s.replace(/^[\s\u200B-\u200D\u2060\uFEFF]+/u, "");
for (const [text, name] of [[WIZARD_MARK + " fix 帮我", "fix"], [".fix 帮我", "fix"],
  [WIZARD_MARK + " fix：帮我", "fix"], [".fix:帮我", "fix"], ["\u{1F9D9}fix 干活", "fix"]] as const) {
  const m = NAME_RE.exec(strip(text));
  assert.ok(m && m.index === 0 && m[2] === name, text);
}
// 行中 .gitignore 不是路由 (旧行为不回归: 只认行首)
const gi = NAME_RE.exec("see .gitignore pls");
assert.ok(gi === null || gi.index !== 0);

// ── 正文提及 + 链接往返 ──────────────────────────────────────────────
assert.deepEqual(allNames("叫 " + WIZARD_MARK + " fix 和 .admin 看看"), ["fix", "admin"]);
const linked = linkTags(fix, "叫 " + WIZARD_MARK + " admin 看看");
assert.ok(linked.startsWith("叫 [" + WIZARD_MARK + " admin]("), linked);
assert.equal(unlinkTags(linked), "叫 " + WIZARD_MARK + " admin 看看");

// ── 工具参数剥记号 (单一收口) ────────────────────────────────────────
assert.equal(stripSigil(WIZARD_MARK + " fix"), "fix");
assert.equal(stripSigil("@" + WIZARD_MARK + " fix"), "fix");
assert.equal(stripSigil(".fix"), "fix");
assert.equal(stripSigil("@.fix"), "fix");
assert.equal(stripSigil("\u{1F9D9}fix"), "fix");

// ── 回执署名四态 (addressedResults; 口径 B 2026-11-13): 新写法 = 行首 `.name RESULT:`,
//  存量三态 `@name` / `@.name` / `@🧙‍♂️ name` 长期照认 ──────────────────────
assert.deepEqual(addressedResults("@fix RESULT: done it"), [{ name: "fix", body: "done it" }]);
assert.deepEqual(addressedResults("@" + WIZARD_MARK + " fix RESULT: done it"), [{ name: "fix", body: "done it" }]);
assert.deepEqual(addressedResults("@.fix RESULT: done it"), [{ name: "fix", body: "done it" }]);
assert.deepEqual(addressedResults(".fix RESULT: done it"), [{ name: "fix", body: "done it" }], "行首 .name RESULT: 新写法");
assert.deepEqual(addressedResults("- .fix RESULT: done it"), [{ name: "fix", body: "done it" }], "列表标记后的点形态");
assert.deepEqual(addressedResults(".fix RESULT: 一段\n.bob RESULT: 二段"), [{ name: "fix", body: "一段" }, { name: "bob", body: "二段" }], "一段内多个 .name RESULT: 分段投递");
assert.deepEqual(addressedResults("版本 2.9.0 RESULT: 不是收件人"), [], "行中的小数不当作点名 (点形态锚行首)");
assert.deepEqual(addressedResults("@bob 中间有话 RESULT: 说不通"), [], "@ 形态名字后必须紧跟 RESULT");

// ── md-chunk: 永不切开 ZWJ 序列 (按行块切, 行内原子) ──────────────────
{
  const line = WIZARD_MARK + " name：" + "x".repeat(80);
  const chunks = splitMarkdown(Array.from({ length: 120 }, () => line).join("\n"), 600);
  for (const c of chunks) {
    for (const l of c.split("\n")) {
      if (l.trim()) assert.ok(l.includes(WIZARD_MARK) || !l.includes("\u{1F9D9}"), "ZWJ sequence intact");
    }
  }
  assert.ok(chunks.length > 1);
}

// ── envelope 协议不受表示影响 ────────────────────────────────────────
{
  const env = renderReminder(envelopeAttrs.peer(WIZARD_MARK + " fix", "chat-x"), ["这是 wizard 私聊, 不是人说的。"]);
  const text = WIZARD_MARK + " fix：你好" + env;
  const parsed = parseEnvelope(text);
  assert.equal(parsed?.kind, "peer");
  assert.equal(parsed?.from, WIZARD_MARK + " fix");
  assert.equal(parsed?.private, false);
}
// ── 系统面 (§1.5): 同一身份在 roster / read_chat / rolepage / charter 只出现裸名 ──
{
  // roster: addr 裸名, renderRoster 行里无点无记号
  assert.equal(addr({ name: "fix", address: "fix" } as WizardBrief), "fix");
  const row = { name: "fix", address: "fix", description: "d", cwd: "/w", target: "user:admin#fix", chat: "home", solo: false, busy: false, alive: true, self: false, lastActivity: Date.now(), summary: "", clones: [] } as unknown as RosterRow;
  const roster = renderRoster([row], Date.now(), "/w");
  assert.ok(roster.includes("`fix`"), roster);
  assert.ok(!roster.includes(".fix") && !roster.includes(WIZARD_MARK), roster);

  // read_chat: 信封协议值 from=".fix" 带点, 输出剥成裸名; 会话主人一侧也裸
  const tmp = mkdtempSync(join(tmpdir(), "wizface-"));
  const at = Date.now() - 3600_000;
  const script = join(tmp, "a.jsonl");
  const rows: object[] = [
    { type: "user", timestamp: new Date(at).toISOString(), message: { role: "user", content: "问一句" + renderPeerEnvelope(".fix") } },
    { type: "assistant", timestamp: new Date(at + 1000).toISOString(), message: { role: "assistant", content: "答一句" } },
  ];
  writeFileSync(script, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  const s: LogSession = { name: "docs", key: "user:admin#docs", jsonlPath: script, homeChat: "home", homeKey: "chat:wrX", homeHuman: "张三", since: 0 };
  const log = renderChatLog([s], { limit: 10, per: 200 }, Date.now()).text;
  assert.ok(log.includes("fix：") && log.includes("docs"), log);
  assert.ok(!log.includes(".fix") && !log.includes(WIZARD_MARK), log);

  // rolepage: 会话列表预览的说话人前缀一律裸名 (wizard 与人同形)
  const dir: Directory = {
    nameOf: (id) => (id === "u:fix" ? "fix" : id === "u:zhang" ? "张三" : id),
    labelOf: () => "🦊",
    resolve: () => undefined,
    fact: () => undefined,
    chatName: () => "",
    weixin: () => undefined,
    isWizard: (id) => id === "u:fix",
    status: () => undefined,
    wizards: () => ["u:fix"],
  };
  const turn = { kind: "turn", id: "t1", items: [{ t: "text", body: "看看", ts: at }] } as unknown as Msg["turn"];
  const mk = (from: string): Msg => ({ id: "t1:out", turn, dir: "out", from, to: "u:me", channel: "chat:wrX", ts: at });
  const wizardGlance = glanceOfTalk([mk("u:fix")], "u:me", dir, "u:me", []);
  assert.ok(wizardGlance.preview.startsWith("fix： "), wizardGlance.preview);
  const humanGlance = glanceOfTalk([mk("u:zhang")], "u:me", dir, "u:me", []);
  assert.ok(humanGlance.preview.startsWith("张三： "), humanGlance.preview);
  assert.ok(!wizardGlance.preview.includes(WIZARD_MARK), wizardGlance.preview);

  // 人面不变式: wizard 对人的气泡头仍带记号 (唯一保留记号的显示面)
  assert.equal(said(tagHead(fix)), WIZARD_MARK + " fix：");
}


// ── 关键字优先 (receiptKeyword; 口径 B): 带收口关键字即回执, 不以 @ 为前提 ──
assert.equal(receiptKeyword("RESULT: 纯标记无前缀"), true, "纯 RESULT 无前缀算回执");
assert.equal(receiptKeyword("NEED: 反问"), true);
assert.equal(receiptKeyword("PROGRESS: 进展"), true);
assert.equal(receiptKeyword("ARTIFACT: /tmp/f — 一句话"), true);
assert.equal(receiptKeyword("@bob 你看这句, 顺带 RESULT: 也在"), true, "@别的名字又含 RESULT 时按回执处理");
assert.equal(receiptKeyword("一句普通答话"), false);
assert.equal(receiptKeyword("what I need: 小写不算"), false);

// ── 纯 RESULT 无前缀按原归属 (口径 B): 裸 RESULT 落它服务的那一行, 无需收件人 ──
{
  const dir = mkdtempSync(join(tmpdir(), "rcpt-bare-"));
  const router = openRouter({ file: join(dir, "routes.jsonl") });
  router.commit(ops.open({ event: "route:bare", owner: "chat:A#w", receiver: { kind: "wizard", to: "chat:B#lead" }, deadlineAt: Number.MAX_SAFE_INTEGER }));
  assert.equal(finalKind(router.table(), "route:bare", "RESULT: 结论内容"), "result");
  const plans = router.onFinal("chat:A#w", "route:bare", { text: "RESULT: 结论内容", source: { input: "e1" } });
  assert.equal(plans[0]?.op, "answer");
  assert.equal(plans[0] && "outcome" in plans[0] ? plans[0].outcome?.status : undefined, "done");
}
console.log("wizard-mark dual-form tests passed");
