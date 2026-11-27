// 频道的非 @ 帖子 / 评论 (topic_event / topic_reply_event) 里 @ 了别人而非本机器人 → ingest 前丢弃。
// 放行: 开头点 .name、艾特了本机器人 (内置名 + botNames)、只有路径 / 扩展名形状、代码里的 @、topic_at_bot 兜底行。
// 不 fail-open: botNames 没配也拦; 只有 `${inline_mention}` 结构化标记 (正文被剥空) 也拦。
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { ConfigSchema } from "../shared/config.js";
import { installChannelEvents, type ChannelHuman } from "../daemon/channel.js";

// channel.ts 的 seen 去重表是模块级的: id 跨 run 要全局唯一。
let n = 0;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const run = async (botNames: string[], contents: string[], kind: "post" | "reply" = "post"): Promise<ChannelHuman[]> => {
  const ROOT = mkdtempSync(join(tmpdir(), "channel-mention-"));
  const cfg = ConfigSchema.parse({
    bot: { botId: "test", secret: "test" },
    daemon: { stateDir: join(ROOT, "state") },
    wrc: { allowFrom: ["user:tester"], botNames, channel: { history: { enabled: false } } },
    defaultChat: "user:home",
  });
  const ingested: ChannelHuman[] = [];
  const bodyOf = new Map<string, string>();
  const client = {
    wsManager: { handleFrame: (_f: unknown) => {} },
    reply: async (_h: unknown, body: { post_id_list?: string[]; reply_id_list?: string[] }) => {
      const id = String(body.reply_id_list?.[0] ?? body.post_id_list?.[0]);
      const content = bodyOf.get(id) ?? "";
      return { body: { post_list: [{ post_id: id, content }], reply_list: [{ reply_id: id, post_id: "P", content }] } };
    },
  };
  installChannelEvents(client as never, cfg, pino({ level: "silent" }), { nativeWaitMs: 50, ingest: (e) => ingested.push(e) });
  for (const content of contents) {
    const id = "x" + ++n;
    bodyOf.set(id, content);
    client.wsManager.handleFrame({
      cmd: "aibot_topic_event_callback",
      body: { topic_id: "topicT", msgid: "m-" + id, from: { userid: "tester" }, create_time: 1700000000,
        event: kind === "post"
          ? { eventtype: "topic_event", topic_event: { type: 1, post_id: id } }
          : { eventtype: "topic_reply_event", topic_reply_event: { type: 1, post_id: "P", reply_id: id } } },
    });
  }
  await sleep(400);
  return ingested;
};

const B = ["weSingapore"];
for (const kind of ["post", "reply"] as const) {
  assert.equal((await run(B, ["@张三 看下", "@张三 @src/foo.ts"], kind)).length, 0, kind + ": 艾特别人 → 不落行");
  assert.equal((await run(B, ["@weSingapore 看下", "@张三 @weSingapore 一起", "@src/foo.ts 看下", "看下", "```java\n@Override\n```", "`@Component` 注解"], kind)).length, 6,
    kind + ": 机器人 / 机器人+别人 / 只有路径 / 无艾特 / 代码块里的 @ → 放行");
  assert.equal((await run([], ["@张三 看下"], kind)).length, 0, kind + ": botNames 未配也拦 (不 fail-open)");
  assert.equal((await run(B, ["请 ${inline_mention:u1} 看下"], kind)).length, 0, kind + ": 只有结构化 @ 标记 → 丢弃");
  assert.equal((await run([], ["请 ${inline_mention:u1} 看下"], kind)).length, 0, kind + ": botNames 未配 + 只有结构化标记 → 丢弃");
  assert.equal((await run([], ["看下"], kind)).length, 1, kind + ": botNames 未配且无 @ → 放行");
  assert.equal((await run([], ["@src/foo.ts 看下", "@wezard 看下"], kind)).length, 2, kind + ": botNames 未配, 只有路径 / 内置机器人名 → 放行");
}
console.log("channel mention filter ok");
