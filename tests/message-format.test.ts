import assert from "node:assert/strict";
import { ConfigSchema } from "../shared/config.js";
import { bindTagLinker, parseTagHeader } from "../shared/session-label.js";
import { withMessageFooter } from "../shared/message-footer.js";
import { footerTarget, responseFormatPolicy, responsePrincipal } from "../daemon/message-format.js";
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
for (const topOnly of [true, false]) for (const destination of [a, b]) {
  cfg.chatPolicy[destination] = { topOnly, stewardBudget: 4 };
  const policy = responseFormatPolicy(cfg, { chatid: destination.split(":")[1]! }, urlOf)!;
  assert.equal(policy.defaultTarget, destination);
  for (const sender of known) {
    const input = `[.${names[sender]}](${urlOf(sender)}): answer`;
    // v3: 管家 (目的地默认) 也署名 —— 裸 `🧙‍♂️ name：`; 其余仍包反引号。
    const expected = sender === destination
      ? `🧙‍♂️ ${names[sender]}： answer [✦](${urlOf(sender)})`
      : `\`🧙‍♂️ ${names[sender]}\`： answer [✦](${urlOf(sender)})`;
    assert.equal(withMessageFooter(input, policy), expected, `${topOnly}/${destination}/${sender}`);
    assert.equal(withMessageFooter(expected, policy), expected);
    assert.equal(parseTagHeader(expected).tag, names[sender]);
  }
  const migrated = withMessageFooter(".worker: answer", policy);
  assert.equal(migrated, `\`🧙‍♂️ renamed-worker\`： answer [✦](${urlOf(worker)})`, "answer-transfer receiver worker keeps its own signed head");
  assert.equal(withMessageFooter(`\`🧙‍♂️ renamed-worker\`： answer [✦](${urlOf(worker)})`, policy), migrated);
}
assert.deepEqual(parseTagHeader(`[.old](${urlOf(worker)}): answer`), { fromBot: true, tag: "renamed-worker", body: "answer" });
// ✨ (老版 footer 记号) 与无 role 参数的链接都不再承载身份。
assert.deepEqual(parseTagHeader(`answer [✨](https://own.test/base/role?id=stream)`), { fromBot: false, tag: "", body: `answer [✨](https://own.test/base/role?id=stream)` });
for (const u of ["https://foreign.test/base/role?id=stream", "https://own.test/role?id=stream", "https://own.test/base/info?id=stream"]) {
  const text = `answer [✦](${u})`;
  assert.deepEqual(parseTagHeader(text), { fromBot: false, tag: "", body: text });
}
console.log("message-format integration tests passed");
