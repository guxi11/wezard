import assert from "node:assert/strict";
import type { WSClient, WsFrame } from "@wecom/aibot-node-sdk";
import { ConfigSchema } from "../shared/config.js";
import { bindTagLinker, parseTagHeader } from "../shared/session-label.js";
import { withMessageFooter, withoutMessageFooter } from "../shared/message-footer.js";
import { getLastResponse, installResponseTracker } from "../daemon/last-response.js";
import { footerTarget, responseFormatPolicy } from "../daemon/message-format.js";

const home = "user:admin", worker = `${home}#worker`, foreignDefault = "chat:wrOther~bot", voice = `${home}#voice`;
const known = [home, worker, foreignDefault, voice];
const nameOf = (t: string) => t === home ? "default" : t === worker ? "worker" : t === voice ? "voice" : "other";
const urlOf = (t: string) => `https://own.test/base/role?id=ticket&role=${encodeURIComponent(t)}`;
const resolve = (n: string) => known.find((t) => nameOf(t) === n);
const trusted = (u: string) => footerTarget(u, "https://own.test/base/", () => worker, (t) => known.includes(t));
bindTagLinker({ urlOf, nameOf, resolve, targetOfUrl: trusted, voiceOf: (t) => t === voice ? home : t });
const cfg = ConfigSchema.parse({ bot: { botId: "test", secret: "test" }, chats: { wezard: home, other: foreignDefault } });
const policy = responseFormatPolicy(cfg, { chatid: "admin" }, urlOf)!;
const head = (t: string) => `[.${nameOf(t)}](${urlOf(t)}): `;
const footer = ` [✦](${urlOf(home)})`;
const bodyLink = `[.worker](${urlOf(worker)})`;
assert.equal(withMessageFooter(`${head(home)}hello \n\t`, policy), `hello${footer}`);
assert.equal(withMessageFooter(`${head(worker)}hello`, policy), `${head(worker)}hello`);
assert.equal(withMessageFooter(`${head(foreignDefault)}hello`, policy), `${head(foreignDefault)}hello`);
assert.equal(withMessageFooter(`${head(voice)}hello`, policy), `${head(voice)}hello`, "voiceOf never impersonates the true default");
assert.equal(withMessageFooter(`answer [✨](${urlOf(worker)})`, policy), `${head(worker)}answer`, "old worker footer migrates back to header");
assert.equal(withMessageFooter(`answer [✨](${urlOf(home)}) [✦](${urlOf(home)})`, policy), `answer${footer}`);
for (const input of [`${head(home)}${bodyLink}: answer`, `.default: ${bodyLink}: answer`, `${bodyLink}: answer [✨](${urlOf(home)})`]) {
  const formatted = withMessageFooter(input, policy);
  assert.equal(formatted, `${bodyLink}: answer${footer}`, "body-leading link survives formatting");
  assert.equal(withMessageFooter(formatted, policy), formatted);
}
assert.equal(withMessageFooter("unknown raw text", policy), "unknown raw text", "unknown sender does not become default");
assert.equal(withMessageFooter(`only [✦](https://foreign.test/role?id=article)`, policy), "only [✦](https://foreign.test/role?id=article)");
assert.equal(withoutMessageFooter(`answer${footer}`), "answer");
for (const glyph of ["✦", "✨"]) for (const u of ["https://foreign.test/role?id=article", "https://foreign.test/chat?id=article", "https://own.test/wrong/role?id=article"]) {
  const external = `[${glyph}](${u})`;
  assert.equal(withoutMessageFooter(external), external);
  assert.equal(withMessageFooter(`${head(home)}answer ${external}`, policy), `answer ${external}${footer}`);
}
assert.deepEqual(parseTagHeader(`[.old](${urlOf(worker)}): ${bodyLink}`), { fromBot: true, tag: "worker", body: ".worker" });

const calls: string[] = [];
const client = {
  isConnected: true,
  replyStream: async (_f: unknown, _id: string, c: string) => { calls.push(c); return {} as WsFrame; },
  replyStreamWithCard: async (_f: unknown, _id: string, c: string) => { calls.push(c); return {} as WsFrame; },
  sendMessage: async (_id: string, b: any) => { calls.push(b.markdown?.content ?? ""); return {} as WsFrame; },
} as unknown as WSClient;
installResponseTracker(client, undefined, () => true, (c) => responseFormatPolicy(cfg, c, urlOf));
const frame = { headers: { req_id: "test" }, body: { chattype: "single", from: { userid: "admin" } } } as any;
const senders = [
  (c: string) => client.replyStream(frame, "s", c, true),
  (c: string) => client.replyStreamWithCard(frame, "s", c, true),
  (c: string) => client.sendMessage("admin", { msgtype: "markdown", markdown: { content: c } }),
];
for (const topOnly of [true, false]) {
  cfg.chatPolicy[home] = { topOnly, stewardBudget: 4 };
  for (const send of senders) {
    await send(`${head(home)}hello`); assert.equal(calls.at(-1), `hello${footer}`);
    await send(`${head(worker)}hello`); assert.equal(calls.at(-1), `${head(worker)}hello`);
    await send(`${head(home)}${bodyLink}`); assert.equal(calls.at(-1), `${bodyLink}${footer}`, "gate preserves a body containing only a name link");
    const count = calls.length;
    await send(head(home)); await send(`[✦](${urlOf(home)})`);
    for (const sender of [home, worker]) for (const glyph of ["✦", "✨"]) await send(`${head(sender)} [${glyph}](${urlOf(sender)})`);
    assert.equal(calls.length, count, "empty payload gate survives headers and old/new footer chrome");
    const external = "[✦](https://foreign.test/role?id=article)";
    await send(external); assert.equal(calls.at(-1), external, "foreign link-only message is delivered");
  }
}
assert.equal(getLastResponse(home), "[✦](https://foreign.test/role?id=article)");
console.log("message-footer tests passed");
