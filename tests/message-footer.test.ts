import assert from "node:assert/strict";
import type { WSClient, WsFrame } from "@wecom/aibot-node-sdk";
import { withMessageFooter, withoutMessageFooter } from "../shared/message-footer.js";
import { getLastResponse, installResponseTracker, type ResponseFormatContext } from "../daemon/last-response.js";

const url = "https://example.test/role?id=t123&role=chat%3Awr1%23fix";
const fallback = "https://example.test/role?id=other&role=user%3Aadmin";
const footer = ` [✦](${url})`;
const legacyFooter = `\n\n[✨](${url})`;
const head = `[.fix](${url}): `;
assert.equal(withMessageFooter(`${head}hello`, { topOnly: true }), `hello${footer}`);
assert.equal(withMessageFooter(`${head}hello`, { topOnly: false, url: fallback }), `${head}hello`);
assert.equal(withMessageFooter(`${head}hello`), `${head}hello`);
assert.equal(withMessageFooter(`${head}hello`, { topOnly: true, url: fallback }), `hello${footer}`);
assert.equal(withMessageFooter("hello", { topOnly: true, url: fallback }), `hello [✦](${fallback})`);
assert.equal(withMessageFooter(`${head}\n| a |\n| --- |`, { topOnly: true }), `| a |\n| --- |${footer}`);
assert.equal(withMessageFooter(`${head}\n\x60\x60\x60ts\nx\n\x60\x60\x60`, { topOnly: true }), `\x60\x60\x60ts\nx\n\x60\x60\x60 [✦](${url})`);
const body = `hello [.other](${fallback}) and [source](https://example.test/info)`;
assert.equal(withMessageFooter(`${head}${body}`, { topOnly: true }), `${body}${footer}`);
assert.equal(withMessageFooter(`[source](${url}): hello`, { topOnly: true }), `[source](${url}): hello`);
assert.equal(withMessageFooter("hello", { topOnly: true }), "hello");
assert.equal(withMessageFooter(`hello${footer}${footer}`, { topOnly: true }), `hello${footer}`);
assert.equal(withMessageFooter(`hello${legacyFooter}`, { topOnly: true, url: fallback }), `hello${footer}`);
assert.equal(withMessageFooter(`hello${footer}`, { topOnly: true, url: fallback }), `hello${footer}`);
assert.equal(withoutMessageFooter(`hello${footer}`), "hello");
assert.equal(withoutMessageFooter(`hello${legacyFooter}`), "hello");
assert.equal(withoutMessageFooter("hello [✨](https://example.test/info)"), "hello [✨](https://example.test/info)");
assert.equal(withMessageFooter(`${head}body [✦](https://external.test/info)`, { topOnly: true, url: fallback }), `body [✦](https://external.test/info) [✦](${url})`);
assert.equal(withMessageFooter(`${head}body [✨](https://external.test/info)`, { topOnly: true, url: fallback }), `body [✨](https://external.test/info) [✦](${url})`);

const calls: { kind: string; content: string; options?: unknown }[] = [];
const contexts: ResponseFormatContext[] = [];
const client = {
  isConnected: true,
  replyStream: async (_frame: unknown, _id: string, content: string) => { calls.push({ kind: "stream", content }); return {} as WsFrame; },
  replyStreamWithCard: async (_frame: unknown, _id: string, content: string, _finish: boolean, options: unknown) => { calls.push({ kind: "card", content, options }); return {} as WsFrame; },
  sendMessage: async (_id: string, body: any) => { calls.push({ kind: "standalone", content: body.markdown?.content ?? "", options: body }); return {} as WsFrame; },
} as unknown as WSClient;
installResponseTracker(client, undefined, () => true, (context) => {
  contexts.push(context);
  return { topOnly: context.chatid === "wr1~secondary" || context.chatid === "admin", url: fallback };
});
const frame = { headers: { req_id: "test" }, body: { chattype: "single", from: { userid: "admin" } } } as any;
await client.replyStream(frame, "s", `${head}hello`, false);
assert.equal(calls.at(-1)?.content, `hello${footer}`);
await client.replyStream(frame, "s", `${head}hello`, true);
assert.equal(getLastResponse("user:admin"), `hello${footer}`);
assert.equal(contexts.at(-1)?.chatid, "admin", "policy can enable a named chat homed in a user principal");
assert.equal(contexts.at(-1)?.frame, frame);
assert.equal(contexts.at(-1)?.body, frame.body);
await client.sendMessage("wr1~secondary", { msgtype: "markdown", markdown: { content: `${head}hello` } });
assert.equal(calls.at(-1)?.content, `hello${footer}`);
assert.equal(getLastResponse("chat:wr1~secondary"), `hello${footer}`);
assert.equal(contexts.at(-1)?.chatid, "wr1~secondary");
await client.sendMessage("wrOff", { msgtype: "markdown", markdown: { content: `${head}hello` } });
assert.equal(calls.at(-1)?.content, `${head}hello`);
const card = { templateCard: { card_type: "text_notice" } } as any;
await client.replyStreamWithCard(frame, "s", `${head}hello`, true, card);
assert.equal(calls.at(-1)?.content, `hello${footer}`);
assert.equal(calls.at(-1)?.options, card);
const count = calls.length;
await client.replyStream(frame, "s", head, true);
await client.replyStream(frame, "s", `${head}${footer}`, true);
await client.sendMessage("admin", { msgtype: "markdown", markdown: { content: footer } });
assert.equal(calls.length, count, "generated footer cannot turn an empty body into a visible answer");
await client.replyStreamWithCard(frame, "s", head, true, card);
assert.equal(calls.length, count + 1, "card payload must still be delivered");
await client.replyStream({ headers: { req_id: "header-only" } }, "s", `${head}hello`, true);
assert.equal(contexts.at(-1)?.chatid, "");
assert.equal(calls.at(-1)?.content, `${head}hello`, "unknown destination requires explicit policy evidence");
console.log("message-footer tests passed");
