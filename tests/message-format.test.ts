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
const other = "user:admin#other";
const targetFor = (raw: string) => footerTarget(raw, "https://example.test/base/", (id) => ["stream", "t1"].includes(id) ? worker : undefined, (target) => target === worker);
bindTagLinker({ urlOf, nameOf: (t) => t === worker ? "renamed-worker" : t === other ? "other" : "", resolve: (name) => name === "worker" || name === "renamed-worker" ? worker : name === "other" ? other : undefined, targetOfUrl: targetFor });
const body = "answer with [source](https://source.test)";
const fallback = urlOf("user:admin");
assert.equal(withMessageFooter(".worker: created", { topOnly: true, url: fallback, principal: "user:admin" }),
  `created\n\n[✨](${urlOf(worker)})`, "unlinked legacy speaker header is removed and keeps its own role footer");
const formatted = withMessageFooter(`[.worker](${urlOf(worker)}): ${body}`, { topOnly: true });
assert.deepEqual(parseTagHeader(formatted), { fromBot: true, tag: "renamed-worker", body }, "footer quote preserves routing across wizard rename");
assert.deepEqual(parseTagHeader(`.someone: example\n\n[✨](${urlOf(worker)})`), { fromBot: true, tag: "renamed-worker", body: ".someone: example" }, "answer text cannot override the footer's speaker");
assert.deepEqual(parseTagHeader(`${body}\n\n[✨](https://example.test/base/role?id=stream&ww_uniq=worker)`), { fromBot: true, tag: "renamed-worker", body }, "old stream URL resolves via recorded turn");
assert.deepEqual(parseTagHeader(`[.old](${urlOf(worker)}): old body`), { fromBot: true, tag: "old", body: "old body" });
const otherFirst = `[.worker](${urlOf(worker)}): [.other](${urlOf(other)}): answer`;
const firstFormat = withMessageFooter(otherFirst, { topOnly: true, url: fallback });
const secondFormat = withMessageFooter(firstFormat, { topOnly: true, url: fallback });
assert.equal(firstFormat, `[.other](${urlOf(other)}): answer\n\n[✨](${urlOf(worker)})`);
assert.equal(secondFormat, firstFormat, "reformatting preserves a body link and its original speaker footer");
const footerWithoutRole = `[.other](${urlOf(other)}): answer\n\n[✨](${urlOf(worker).replace(/&role=[^&]*/, "")})`;
assert.equal(withMessageFooter(footerWithoutRole, { topOnly: true, url: fallback }), footerWithoutRole, "a legacy footer without role metadata protects every body link");
const sameRoleBody = `[.other](${urlOf(worker)}): answer\n\n[✨](${urlOf(worker)})`;
assert.equal(withMessageFooter(sameRoleBody, { topOnly: true, url: fallback }), sameRoleBody, "an existing footer prevents reclassifying even a same-role body link");
for (const url of ["https://evil.test/base/role?id=stream", "https://example.test/role?id=stream", "https://example.test/base/info?id=stream", "https://example.test/base/role?id=missing", "https://example.test/base/role?id=stream&role=user%3Aother"]) {
  const raw = `${body}\n\n[✨](${url})`;
  assert.deepEqual(parseTagHeader(raw), { fromBot: false, tag: "", body: raw }, url);
}
assert.deepEqual(parseTagHeader(`[✨](${urlOf(worker)})`), { fromBot: true, tag: "renamed-worker", body: "" });
console.log("message-format integration tests passed");
