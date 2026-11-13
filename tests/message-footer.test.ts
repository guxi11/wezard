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
// v3: default wizard (管家) 也署名 —— 裸 `🧙‍♂️ name：`; 非 default wizard 仍 code 样式 (反引号); 链接统一落尾部 ✦。
const bare = (t: string, body: string) => `🧙‍♂️ ${nameOf(t)}： ${body} [✦](${urlOf(t)})`;
const signed = (t: string, body: string) => `\`🧙‍♂️ ${nameOf(t)}\`： ${body} [✦](${urlOf(t)})`;
assert.equal(withMessageFooter(`${head(home)}hello \n\t`, policy), bare(home, "hello"));
assert.equal(withMessageFooter(`${head(worker)}hello`, policy), signed(worker, "hello"));
assert.equal(withMessageFooter(signed(worker, "hello"), policy), signed(worker, "hello"), "signed header is idempotent");
assert.equal(withMessageFooter(`${head(foreignDefault)}hello`, policy), signed(foreignDefault, "hello"));
assert.equal(withMessageFooter(`${head(voice)}hello`, policy), signed(voice, "hello"), "voiceOf never impersonates the true default");
// ✨ (老版 footer 记号) 不再被识别为身份来源: 没有头也没有 ✦ 的消息原样通过。
assert.equal(withMessageFooter(`answer [✨](${urlOf(worker)})`, policy), `answer [✨](${urlOf(worker)})`);
assert.equal(withMessageFooter(`answer [✨](${urlOf(home)}) [✦](${urlOf(home)})`, policy), bare(home, `answer [✨](${urlOf(home)})`));
// 行首的链接名 = 发话方头 (不是正文): body-leading 的 linked-name 被当 sender 消费。
assert.equal(withMessageFooter(`${head(home)}${bodyLink}: answer`, policy), bare(home, ": answer"));
assert.equal(withMessageFooter(`${bodyLink}: answer [✨](${urlOf(home)})`, policy), signed(worker, `answer [✨](${urlOf(home)})`));
assert.equal(withMessageFooter("unknown raw text", policy), "unknown raw text", "unknown sender does not become default");
assert.equal(withMessageFooter(`only [✦](https://foreign.test/role?id=article)`, policy), "only [✦](https://foreign.test/role?id=article)");
assert.equal(withoutMessageFooter(`answer${footer}`), "answer");
for (const glyph of ["✦", "✨"]) for (const u of ["https://foreign.test/role?id=article", "https://foreign.test/chat?id=article", "https://own.test/wrong/role?id=article"]) {
  const external = `[${glyph}](${u})`;
  assert.equal(withoutMessageFooter(external), external);
  assert.equal(withMessageFooter(`${head(home)}answer ${external}`, policy), bare(home, `answer ${external}`));
}
// 头后紧跟的链接名是对话对象 (peer 后缀), 一并剥掉。
assert.deepEqual(parseTagHeader(`[.old](${urlOf(worker)}): ${bodyLink}`), { fromBot: true, tag: "worker", body: "" });

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
    await send(`${head(home)}hello`); assert.equal(calls.at(-1), bare(home, "hello"));
    await send(`${head(worker)}hello`); assert.equal(calls.at(-1), signed(worker, "hello"));
    // 头后只剩一个 peer 链接 ⇒ 空 payload, 被 gate 拦下不投递。
    { const n = calls.length; await send(`${head(home)}${bodyLink}`); assert.equal(calls.length, n, "a body containing only a name link is a peer suffix, not body"); }
    const count = calls.length;
    await send(head(home)); await send(`[✦](${urlOf(home)})`);
    for (const sender of [home, worker]) await send(`${head(sender)} [✦](${urlOf(sender)})`);
    assert.equal(calls.length, count, "empty payload gate survives headers and footer chrome");
    // ✨ 是老版 footer 记号, 现按正文算: 头 + ✨ 链接 = 有正文, 照常投递 (带新署名)。
    await send(`${head(home)} [✨](${urlOf(home)})`); assert.equal(calls.at(-1), bare(home, `[✨](${urlOf(home)})`));
    await send(`${head(worker)} [✨](${urlOf(worker)})`); assert.equal(calls.at(-1), signed(worker, `[✨](${urlOf(worker)})`));
    const external = "[✦](https://foreign.test/role?id=article)";
    await send(external); assert.equal(calls.at(-1), external, "foreign link-only message is delivered");
  }
}
assert.equal(getLastResponse(home), "[✦](https://foreign.test/role?id=article)");
console.log("message-footer tests passed");
