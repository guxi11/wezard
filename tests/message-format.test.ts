import assert from "node:assert/strict";
import { ConfigSchema } from "../shared/config.js";
import { bindTagLinker, parseTagHeader } from "../shared/session-label.js";
import { withMessageFooter } from "../shared/message-footer.js";
import { footerTarget, responseFormatPolicy, responsePrincipal } from "../daemon/message-format.js";

const cfg = ConfigSchema.parse({ bot: { botId: "test", secret: "test" }, chats: { wezard: "user:admin", other: "chat:wrOther~bot" }, chatPolicy: { "chat:wrOther~bot": { topOnly: true } } });
const urlOf = (target: string) => `https://example.test/base/role?id=t1&role=${encodeURIComponent(target)}`;
assert.equal(responsePrincipal(cfg, { chatid: "admin" }), "user:admin");
assert.equal(responsePrincipal(cfg, { chatid: "wrOther~bot" }), "chat:wrOther~bot");
assert.equal(responsePrincipal(cfg, { chatid: "unknown~bot", frame: {} as any, body: { chattype: "group", chatid: "unknown" } }), "chat:unknown~bot");
assert.equal(responsePrincipal(cfg, { chatid: "wrUser~bot", frame: {} as any, body: { chattype: "single", from: { userid: "wrUser" } } }), "user:wrUser~bot");
assert.equal(responseFormatPolicy(cfg, { chatid: "admin" }, urlOf)?.topOnly, true);
assert.equal(responseFormatPolicy(cfg, { chatid: "wrOther~bot" }, urlOf)?.url, urlOf("chat:wrOther~bot"));
assert.equal(responseFormatPolicy(cfg, { chatid: "wrOther" }, urlOf), undefined, "bot suffix is part of the policy identity");
assert.equal(responseFormatPolicy(cfg, { chatid: "wx_123" }, urlOf), undefined, "Weixin retains its text-only transport convention");
assert.equal(responseFormatPolicy(cfg, { chatid: "" }, urlOf), undefined);
cfg.chatPolicy["user:admin"] = { topOnly: false, stewardBudget: 4 };
assert.equal(responseFormatPolicy(cfg, { chatid: "admin" }, urlOf), undefined, "hot explicit false wins over named default");

const worker = "user:admin#worker";
const targetFor = (raw: string) => footerTarget(raw, "https://example.test/base/", (id) => id === "stream" ? worker : undefined, (target) => target === worker);
bindTagLinker({ urlOf, nameOf: (t) => t === worker ? "renamed-worker" : "", resolve: () => undefined, targetOfUrl: targetFor });
const body = "answer with [source](https://source.test)";
const formatted = withMessageFooter(`[.worker](${urlOf(worker)}): ${body}`, { topOnly: true });
assert.deepEqual(parseTagHeader(formatted), { fromBot: true, tag: "renamed-worker", body }, "footer quote preserves routing across wizard rename");
assert.deepEqual(parseTagHeader(`.someone: example\n\n[✨](${urlOf(worker)})`), { fromBot: true, tag: "renamed-worker", body: ".someone: example" }, "answer text cannot override the footer's speaker");
assert.deepEqual(parseTagHeader(`${body}\n\n[✨](https://example.test/base/role?id=stream&ww_uniq=worker)`), { fromBot: true, tag: "renamed-worker", body }, "old stream URL resolves via recorded turn");
assert.deepEqual(parseTagHeader(`[.old](${urlOf(worker)}): old body`), { fromBot: true, tag: "old", body: "old body" });
for (const url of ["https://evil.test/base/role?id=stream", "https://example.test/role?id=stream", "https://example.test/base/info?id=stream", "https://example.test/base/role?id=missing", "https://example.test/base/role?id=stream&role=user%3Aother"]) {
  const raw = `${body}\n\n[✨](${url})`;
  assert.deepEqual(parseTagHeader(raw), { fromBot: false, tag: "", body: raw }, url);
}
assert.deepEqual(parseTagHeader(`[✨](${urlOf(worker)})`), { fromBot: true, tag: "renamed-worker", body: "" });
console.log("message-format integration tests passed");
