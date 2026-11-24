import assert from "node:assert/strict";
import { ConfigSchema } from "../shared/config.js";
import { bindTagLinker, parseTagHeader } from "../shared/session-label.js";
import { withMessageFooter } from "../shared/message-footer.js";
import { addressed, footerTarget, responseFormatPolicy, responsePrincipal, roomBubble, withBubbleFooter } from "../daemon/message-format.js";
const a = "user:admin", b = "chat:wrOther~bot", worker = `${a}#worker`, voice = `${a}#voice`;
const known = [a, b, worker, voice];
const cfg = ConfigSchema.parse({ bot: { botId: "test", secret: "test" }, chats: { wezard: a, other: b } });
const urlOf = (t: string) => `https://own.test/base/role?id=t1&role=${encodeURIComponent(t)}`;
const names: Record<string, string> = { [a]: "default", [b]: "other", [worker]: "renamed-worker", [voice]: "voice" };
const targetFor = (u: string) => footerTarget(u, "https://own.test/base/", (t) => known.includes(t));
bindTagLinker({ urlOf, nameOf: (t) => names[t] || "", resolve: (n) => n === "worker" ? worker : known.find((t) => names[t] === n), targetOfUrl: targetFor, voiceOf: (t) => t === voice ? a : t });
assert.equal(responsePrincipal(cfg, { chatid: "admin" }), a);
assert.equal(responsePrincipal(cfg, { chatid: "wrOther~bot" }), b);
assert.equal(responsePrincipal(cfg, { chatid: "unknown~bot", frame: {} as any, body: { chattype: "group", chatid: "unknown" } }), "chat:unknown~bot");
assert.equal(responseFormatPolicy(cfg, { chatid: "wx_123" }, urlOf), undefined);
assert.equal(responseFormatPolicy(cfg, { chatid: "" }, urlOf), undefined);
for (const destination of [a, b]) {
  cfg.chatPolicy[destination] = { stewardBudget: 4 };
  const policy = responseFormatPolicy(cfg, { chatid: destination.split(":")[1]! }, urlOf)!;
  for (const sender of known) {
    const input = `[.${names[sender]}](${urlOf(sender)}): answer`;
    // 署名一律裸 `🧙‍♂️ name：` (名字外不包反引号), default / 非 default 同形。
    const expected = `🧙‍♂️ ${names[sender]}： answer [✦](${urlOf(sender)})`;
    assert.equal(withMessageFooter(input, policy), expected, `${destination}/${sender}`);
    assert.equal(withMessageFooter(expected, policy), expected);
    assert.equal(parseTagHeader(expected).tag, names[sender]);
  }
  const migrated = withMessageFooter(".worker: answer", policy);
  assert.equal(migrated, `🧙‍♂️ renamed-worker： answer [✦](${urlOf(worker)})`, "answer-transfer receiver worker keeps its own signed head");
  assert.equal(withMessageFooter(`🧙‍♂️ renamed-worker： answer [✦](${urlOf(worker)})`, policy), migrated);
  assert.equal(withMessageFooter(`\`🧙‍♂️ renamed-worker\`： answer [✦](${urlOf(worker)})`, policy), migrated, "old backtick head still parses");
}
assert.deepEqual(parseTagHeader(`[.old](${urlOf(worker)}): answer`), { fromBot: true, tag: "renamed-worker", body: "answer" });
// ✨ (老版 footer 记号) 与无 role 参数的链接都不再承载身份。
assert.deepEqual(parseTagHeader(`answer [✨](https://own.test/base/role?id=stream)`), { fromBot: false, tag: "", body: `answer [✨](https://own.test/base/role?id=stream)` });
for (const u of ["https://foreign.test/base/role?id=stream", "https://own.test/role?id=stream", "https://own.test/base/info?id=stream"]) {
  const text = `answer [✦](${u})`;
  assert.deepEqual(parseTagHeader(text), { fromBot: false, tag: "", body: text });
}
// 群里被点名的 wizard 答话 (room 行 → 覆盖那条人的占位气泡) 也必须带头带 link:
// tracker 只从正文头反解作者, 无头正文原样放过 —— 所以镜像正文 (roomBubble) 必须先写作者头。
const group = "chat:wrkGroup";
const groupPolicy = responseFormatPolicy(cfg, { chatid: "wrkGroup" }, urlOf)!;
assert.equal(groupPolicy.principal, group, "未知群按前缀落 chat: principal");
assert.equal(withMessageFooter(roomBubble(worker, "done"), groupPolicy), "\u{1F9D9}\u200D\u2642\uFE0F " + names[worker] + "： done [✦](" + urlOf(worker) + ")");
assert.equal(withMessageFooter("done", groupPolicy), "done", "无头正文不属于任何人 —— 覆盖气泡不带作者头就会裸奔");
assert.equal(roomBubble(undefined, "x 已离开"), "[wezard] x 已离开", "daemon 行补 [wezard] 头");
assert.equal(roomBubble(undefined, "[wezard] .a 被提醒后仍没有交代 m.1"), "[wezard] .a 被提醒后仍没有交代 m.1", "正文自带 [wezard] 不再叠一层");
assert.equal(addressed([".Grace"], "看下"), "→ .Grace 看下");
assert.equal(addressed([".a", ".b"], "x"), "→ .a, .b x");
assert.equal(addressed([], "x"), "x", "无收话人原样");
// 频道 / 帖子出站: 直连 send_post / send_reply, 署名收尾由 withBubbleFooter 补 ——
// 头与尾必须是同一套 link 渲染 (头裸 + 尾部 ✦ 指向同一个 rolepage), 与群气泡逐字相同。
const topic = "chat:topicX";
const topicBubble = withBubbleFooter(roomBubble(worker, "done"), topic);
assert.equal(topicBubble, "\u{1F9D9}\u200D\u2642\uFE0F " + names[worker] + "： done [✦](" + urlOf(worker) + ")", "频道正文与群气泡同一条署名渲染");
assert.equal(topicBubble, withMessageFooter(roomBubble(worker, "done"), groupPolicy), "频道与群的收尾逐字一致");
assert.equal(withBubbleFooter(topicBubble, topic), topicBubble, "已收尾的不再叠一层");
assert.equal(withBubbleFooter(roomBubble(undefined, "x 已离开"), topic), "[wezard] x 已离开", "daemon 行没有作者, 不加尾署");
assert.equal(withBubbleFooter("裸正文", topic), "裸正文", "无头正文不属于任何人");
assert.equal(withMessageFooter(roomBubble(worker, addressed([".Grace"], "done")), groupPolicy), "\u{1F9D9}\u200D\u2642\uFE0F " + names[worker] + "： → .Grace done [✦](" + urlOf(worker) + ")", "收话人在尾部改写后仍在");
console.log("message-format integration tests passed");
