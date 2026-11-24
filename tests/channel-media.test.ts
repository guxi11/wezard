// 频道帖 / 评论里的图片与内嵌文件 (2026-11-24): 官方 PostInfo / ReplyInfo 的 image_list 与
// inline_file_list 是**独立字段** —— content 只有 markdown, 纯图片时 content 为空。这一条守住三件事:
// ① 事件时刻就带 cookie 把图拉进 inbox (不再因为正文为空丢掉整条); ② 落盘名按魔数补扩展名;
// ③ 人话行带 images / files 交给 channelIngest (账本行 + @path 由它写)。
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { ConfigSchema } from "../shared/config.js";
import { installChannelEvents, mediaCountOf, sendTopicPost, sendTopicReply, type ChannelHuman } from "../daemon/channel.js";
import { uploadMediaId } from "../daemon/aibot-media.js";

const ROOT = mkdtempSync(join(tmpdir(), "channel-media-"));
const log = pino({ level: "silent" });
const cfg = ConfigSchema.parse({
  bot: { botId: "test", secret: "test" },
  daemon: { stateDir: join(ROOT, "state") },
  wrc: { allowFrom: ["user:tester"], mirror: { inboxDir: join(ROOT, "inbox") }, channel: { history: { enabled: false } } },
  defaultChat: "user:home",
});

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("payload")]);
const FILE = Buffer.from("hello from channel");
const cookies: string[] = [];
const server = createServer((req, res) => {
  cookies.push(String(req.headers.cookie ?? ""));
  res.writeHead(200, { "content-type": "application/octet-stream" });
  res.end(String(req.url).includes("doc") ? FILE : PNG);
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const base = "http://127.0.0.1:" + (server.address() as { port: number }).port;

const postOf = () => ({
  post_id: "pImg",
  creator: { type: 0, userid: "tester" },
  create_time: 1700000000,
  content: "",                                   // 纯图片: 正文就是空的 (旧代码在这一步整条丢)
  image_list: [{ download_url: base + "/img", cookie_name: "wwk", cookie_value: "v1" }],
  inline_file_list: [{ placeholder: "f1", file_name: "需求.pdf", download_url: base + "/doc", cookie_name: "wwk", cookie_value: "v2" }],
});
const replyOf = () => ({
  reply_id: "rImg",
  post_id: "pImg",
  creator: { type: 0, userid: "tester" },
  create_time: 1700000001,
  content: "看这张图",
  image_list: [{ download_url: base + "/img2", cookie_name: "wwk", cookie_value: "v3" }],
});
const client = {
  wsManager: { handleFrame: (_f: unknown) => { /* 直接喂帧 */ } },
  reply: async (_h: unknown, body: unknown, cmd: string) => ({
    body: cmd === "aibot_topic_get_post_list"
      ? { post_list: [(body as { post_id_list?: string[] }).post_id_list?.[0] === "pImg" ? postOf() : { post_id: "px", content: "文字帖" }] }
      : cmd === "aibot_topic_get_reply_list" ? { reply_list: [replyOf()] } : {},
  }),
};
const ingested: ChannelHuman[] = [];
installChannelEvents(client as never, cfg, log, { nativeWaitMs: 0, ingest: (e) => ingested.push(e) });
const frame = (event: unknown, msgid: string) => (client as unknown as { wsManager: { handleFrame: (f: unknown) => void } }).wsManager.handleFrame({
  cmd: "aibot_topic_event_callback",
  body: { topic_id: "topicImg", msgid, from: { userid: "tester" }, aibotid: "bot", create_time: 1700000000, event },
});
const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ① 纯图片的新帖: 以前 text 为空 → 整条丢; 现在落成一条带 images 的人话。
frame({ eventtype: "topic_event", topic_event: { type: 1, post_id: "pImg" } }, "m-post");
await settle(120);
assert.equal(ingested.length, 1, "纯图片帖不再丢");
const post = ingested[0]!;
assert.equal(post.text, "", "正文本来就是空 (图片不在 content 里)");
assert.equal(post.images?.length, 1, "图片落进 images");
assert.equal(post.files?.length, 1, "内嵌文件落进 files");
assert.equal(post.files![0]!.name, "需求.pdf", "文件名保留企微给的原名");
assert.ok(post.images![0]!.endsWith(".png"), "按魔数补扩展名: " + post.images![0]!);
assert.ok(existsSync(post.images![0]!), "图片真的落盘");
assert.deepEqual(readFileSync(post.images![0]!), PNG, "落盘内容就是下载到的字节");
assert.equal(readFileSync(post.files![0]!.path).toString(), "hello from channel", "文件内容一致");
assert.deepEqual(cookies, ["wwk=v1", "wwk=v2"], "下载带 cookie (image_list / inline_file_list 各自的)");

// ② 带字带图的评论: 文字与图片都要到。
frame({ eventtype: "topic_reply_event", topic_reply_event: { type: 1, post_id: "pImg", reply_id: "rImg" } }, "m-reply");
await settle(120);
assert.equal(ingested.length, 2, "评论照旧落行");
const reply = ingested[1]!;
assert.equal(reply.text, "看这张图");
assert.equal(reply.images?.length, 1, "评论里的图也落下来");
assert.ok(reply.images![0]!.endsWith(".png"));
assert.equal(cookies.at(-1), "wwk=v3");

// ③ 回包字段长度 (日志口径) 与「空正文不再等于丢」的判据。
assert.deepEqual(mediaCountOf(postOf()), { images: 1, files: 1 });
assert.deepEqual(mediaCountOf({ content: "只有字" }), { images: 0, files: 0 });

// ④ 出站: 素材先换 media_id, 再随 send_post / send_reply 的 image_list / inline_file_list 带走
//    (官方 101967 / 101963 的字段名; content 里必须出现 inline_file 的占位符)。
const sent: Array<{ cmd: string; body: any }> = [];
const upCalls: Array<{ type: string; filename: string }> = [];
const txClient: any = {
  isConnected: true,
  uploadMedia: async (_buf: Buffer, o: { type: string; filename: string }) => { upCalls.push(o); return { media_id: "MID-" + o.filename }; },
  reply: async (_h: unknown, body: any, cmd: string) => { sent.push({ cmd, body }); return { body: { errcode: 0 } }; },
  wsManager: { handleFrame: (_f: unknown) => { /* 不用 */ } },
};
const imgPath = join(ROOT, "shot.png");
writeFileSync(imgPath, PNG);
const docPath = join(ROOT, "spec.pdf");
writeFileSync(docPath, FILE);
const up1 = await uploadMediaId(txClient, "chat:topicX", { path: imgPath, kind: "image" }, log);
const up2 = await uploadMediaId(txClient, "chat:topicX", { path: docPath, kind: "file" }, log);
assert.ok(up1.ok && up2.ok, "上传成功才拿得到 media_id");
assert.deepEqual(upCalls.map((c) => c.type), ["image", "file"], "按 kind 上传 (image_list 只收图片)");
const imgId = up1.ok ? up1.mediaId : "";
const docId = up2.ok ? up2.mediaId : "";
await sendTopicPost(txClient, log, "topicX", "看这两份", { imageIds: [imgId], files: [{ mediaId: docId, name: "spec.pdf" }] });
const postCmd = sent.at(-1)!;
assert.equal(postCmd.cmd, "aibot_topic_send_post");
assert.deepEqual(postCmd.body.image_list, [{ media_id: imgId }], "图片走 image_list (media_id)");
assert.ok(postCmd.body.content.includes("${inline_file:p1}"), "content 里补了占位符: " + postCmd.body.content);
assert.deepEqual(postCmd.body.inline_file_list, [{ placeholder: "p1", media_id: docId }], "文件走 inline_file_list");
await sendTopicReply(txClient, log, "topicX", "pX", "回你", { imageIds: ["MID9"] });
const replyCmd = sent.at(-1)!;
assert.equal(replyCmd.cmd, "aibot_topic_send_reply");
assert.deepEqual(replyCmd.body.image_list, [{ media_id: "MID9" }], "评论也带 image_list");

server.close();
console.log("channel-media ok (纯图片帖/评论落盘 + cookie + 魔数扩展名 + 空正文不再整条丢 + 出站 media_id)");
