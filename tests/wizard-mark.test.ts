// v3 P1: wizard 表示 🧙‍♂️ name 的双态 (新头 / 旧 .name 头) 断言。
// 覆盖: 渲染原子、气泡头反解 (旧/新/混排)、行首寻址、正文提及、剥记号 (工具参数收口)、
// addressedResults 的 @name RESULT、md-chunk 不切 ZWJ 序列、envelope 解析不受表示影响。
import assert from "node:assert/strict";
import {
  WIZARD_MARK, MAGE_SRC, nameTokenRe, allNames, stripSigil, said, speakerHead,
  tagHead, chatHead, tagBadge, parseTagHeader, rawTagHeader, withLinkedTagHeader,
  linkTags, unlinkTags, bindTagLinker, isHost, keyOf,
} from "../shared/session-label.js";
import { addressedResults } from "../daemon/peers.js";
import { parseEnvelope, renderReminder, envelopeAttrs } from "../shared/reminder.js";
import { splitMarkdown } from "../shared/md-chunk.js";

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

// ── @name RESULT 双态 (addressedResults) ────────────────────────────
assert.deepEqual(addressedResults("@" + WIZARD_MARK + " fix RESULT: done it"), [{ name: "fix", body: "done it" }]);
assert.deepEqual(addressedResults("@.fix RESULT: done it"), [{ name: "fix", body: "done it" }]);

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
console.log("wizard-mark dual-form tests passed");
