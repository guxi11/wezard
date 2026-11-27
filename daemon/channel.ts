// 频道（topic）桥: SDK 1.0.7 的 dispatch 表里没有 aibot_topic_event_callback，
// 这一层在 SDK 丢掉帧之前接住它。
//
// 2026-11-27 起每个帖子一个 room、频道自己没有 room (docs/evolve/channel-topic-rooms.md):
// - 新帖 / 评论 / 频道 @ 都落 topicRoomOf(topic, post, opk?) —— 新口径 topic:<T>/<P>, 存量帖子 room
//   (chat:<opk…>) 与曾被 room_bind 的帖子源照旧 (channel-posts.ts §3.1 的解析顺序)。第一条事件就有 room,
//   不再「先落频道 room 等 host 判」。
// - @ 机器人的原生帧照旧由 inbound 送进帖子会话 (sourceRouteHook 落同一个 topic room);
//   同一句的 topic_at_bot 事件只用来学配对 (post_id ↔ opk ↔ topic_id) 与兜底。
// - 判官 (一次性 JSON 判定) 已删: 每个 room 一个常驻 perceptron, 由它决定激活谁
//   (shared/room.ts 的 activate 行); 这里只负责把话落进对的 room。
import { join } from "node:path";
import { generateReqId, type WSClient, type WsFrame } from "@wecom/aibot-node-sdk";
import type { Logger } from "pino";
import type { Config } from "../shared/config.js";
import { sleep } from "../shared/std.js";
import { addressedElsewhere } from "../shared/mention-filter.js";
import { learnChannel, learnChannelPost, topicRoomOf } from "./channel-posts.js";
import { parseTopicRoomId } from "../shared/topic-room.js";
import { expandHome } from "../shared/paths.js";
import { inboxName, saveToInbox, sniffExt } from "./media.js";
import { ChannelStore, type ChannelMsg } from "./channel-store.js";

const TOPIC_EVENT = "aibot_topic_event_callback";
const CMD_POST = "aibot_topic_send_post";
const CMD_REPLY = "aibot_topic_send_reply";
const CMD_GET_POSTS = "aibot_topic_get_post_list";
const CMD_GET_REPLIES = "aibot_topic_get_reply_list";
const CMD_SEARCH = "aibot_topic_search";
const CMD_SEARCH_RESULT = "get_search_result";

/** 已知 topic_id。sendMessage 用它区分「频道」和普通群 chatid。 */
const topics = new Set<string>();
/** 把 topic_id 登记为已知频道 (onTopic 里自动做; 导出给测试 / 显式注册面用)。 */
export const registerTopic = (topicId: string): void => { topics.add(topicId); };
/** 频道里最近一个说话的人；审批卡改投他的私聊，频道不支持按钮卡片。 */
const lastAsker = new Map<string, string>();
/** 事件可能重投；msgid 去重表有界。 */
const seen = new Set<string>();
/** 企微原生入站已带上的频道 @ (aibot_msg_callback, compat_info.source=channel): asker → 到达记录。
 *  企微把频道里 @ 机器人的话**两路**同时推: 原生帧 (chatid = 该帖子自己的 opk… 群 id) 与
 *  topic_at_bot 事件 (topic_id = 频道)。原生帧由 inbound 记一笔, topic_at_bot 等一拍认领
 *  (一帧只抵一个事件); 等不到 (企微没推原生帧) 才由桥自己落一行, 兜底不丢话。 */
const nativeFrames = new Map<string, Array<{ at: number; chat: string }>>();
const NATIVE_WAIT_MS = 3000;
/** 原生帧可能比事件先到: 认领窗口往前放这么多。 */
const NATIVE_SKEW_MS = 2000;
/** inbound 收到原生频道帧时调: 记下发话人与帖子 chatid。 */
export const noteNativeChannelFrame = (asker: string, chat: string, at = Date.now()): void => {
  if (!asker) return;
  const fresh = (nativeFrames.get(asker) ?? []).filter((n) => at - n.at < NATIVE_WAIT_MS + NATIVE_SKEW_MS);
  nativeFrames.set(asker, [...fresh, { at, chat }]);
};
/** 认领一条 since 之后到达的原生帧 (认领即消耗); 没有 = ""。 */
const takeNative = (asker: string, since: number): string => {
  const list = nativeFrames.get(asker) ?? [];
  const i = list.findIndex((n) => n.at >= since);
  if (i < 0) return "";
  nativeFrames.set(asker, list.filter((_, j) => j !== i));
  return list[i]!.chat;
};
/** 最多等 waitMs 看原生帧到没到。 */
const awaitNative = async (asker: string, since: number, waitMs: number): Promise<string> => {
  for (let left = waitMs; ; left -= 100) {
    const hit = takeNative(asker, since);
    if (hit || left <= 0) return hit;
    await sleep(100);
  }
};

const MENTION_RE = /\$\{inline_mention(?::[^}]*)?\}/g;
const FILE_RE = /\$\{inline_file(?::[^}]*)?\}/g;

const cleanContent = (s: unknown): string =>
  String(s ?? "").replace(MENTION_RE, "").replace(FILE_RE, "").trim();
const clip = (s: string, n = 300): string => (s.length > n ? s.slice(0, n) + "…" : s);

// ── 帖 / 评论里的媒体 ───────────────────────────────────────────────────
// 官方 PostInfo / ReplyInfo 的正文 (content) 只有 markdown, 图片与内嵌文件在**另一个字段**里:
// image_list[] / inline_file_list[] ({download_url, cookie_name, cookie_value}, 1 小时有效)。
// 2026-11-24 之前只读 content, 于是纯图片的帖 / 评论 text 为空 → 整条被丢 (人 12:30 那次的
// 「还看不到图吗」即此); 带字带图的只留字。现在事件时刻就带着 cookie 把图拉进 inbox,
// 行上带本地路径 —— 与群聊图片一个口径 (agent 按路径 Read)。
type MediaRef = { url: string; cookieName?: string; cookieValue?: string };
export interface ChannelMedia {
  /** 已落 inbox 的本地绝对路径。 */
  images: string[];
  /** 内嵌文件: 本地路径 + 企微给的原文件名。 */
  files: Array<{ path: string; name: string }>;
}
const NO_MEDIA: ChannelMedia = { images: [], files: [] };
/** ChannelHuman 的媒体字段: 没有就不写 (账本行不为空字段多一截)。 */
const mediaOf = (m: ChannelMedia): Pick<ChannelHuman, "images" | "files"> => ({
  ...(m.images.length ? { images: m.images } : {}), ...(m.files.length ? { files: m.files } : {}),
});

/** 回包里有几份媒体 (纯读字段, 不下载) —— 日志与「空正文但有图」的判定用。 */
export const mediaCountOf = (item: unknown): { images: number; files: number } => {
  const it = item as { image_list?: unknown; inline_file_list?: unknown } | undefined;
  return {
    images: Array.isArray(it?.image_list) ? it.image_list.length : 0,
    files: Array.isArray(it?.inline_file_list) ? it.inline_file_list.length : 0,
  };
};

const cookieOf = (x: { cookie_name?: unknown; cookie_value?: unknown }): Pick<MediaRef, "cookieName" | "cookieValue"> =>
  x.cookie_name && x.cookie_value ? { cookieName: String(x.cookie_name), cookieValue: String(x.cookie_value) } : {};

const mediaRefsOf = (item: unknown): { images: MediaRef[]; files: Array<MediaRef & { name: string }> } => {
  const it = item as { image_list?: any[]; inline_file_list?: any[] } | undefined;
  const images = (Array.isArray(it?.image_list) ? it.image_list : [])
    .filter((m) => m?.download_url)
    .map((m) => ({ url: String(m.download_url), ...cookieOf(m) }));
  const files = (Array.isArray(it?.inline_file_list) ? it.inline_file_list : [])
    .filter((f) => f?.download_url)
    .map((f) => ({ url: String(f.download_url), ...cookieOf(f), name: String(f.file_name || "file") }));
  return { images, files };
};

/** 拉一份频道媒体: 普通 HTTPS GET + cookie (频道素材没有 aeskey, 不是长连接加密媒体,
 *  不能走 client.downloadFile)。失败只 warn —— 一条拉不到不该把整句话吞掉。 */
const fetchMedia = async (ref: MediaRef, log: Logger, msgid: string): Promise<Buffer | undefined> => {
  try {
    const res = await fetch(ref.url, {
      headers: ref.cookieName && ref.cookieValue ? { cookie: ref.cookieName + "=" + ref.cookieValue } : {},
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) { log.warn({ msgid, status: res.status }, "channel media: http not ok"); return undefined; }
    return Buffer.from(await res.arrayBuffer());
  } catch (e) {
    log.warn({ msgid, err: (e as Error).message }, "channel media: download failed");
    return undefined;
  }
};

const downloadMedia = async (cfg: Config, log: Logger, item: unknown, msgid: string): Promise<ChannelMedia> => {
  const refs = mediaRefsOf(item);
  const n = mediaCountOf(item);
  if (!refs.images.length && !refs.files.length) {
    // debug 口径: 回包到底带没带媒体 (字段长度), 用来在真机上确认企微真的把图放在 image_list 里。
    if (n.images || n.files) log.warn({ msgid, ...n }, "channel media: refs unreadable (no download_url)");
    return NO_MEDIA;
  }
  const dir = expandHome(cfg.wrc.mirror.inboxDir);
  const images: string[] = [];
  const files: Array<{ path: string; name: string }> = [];
  let i = 0;
  for (const ref of refs.images) {
    const buf = await fetchMedia(ref, log, msgid);
    if (!buf) continue;
    const saved = saveToInbox(dir, inboxName(msgid, i++, "image" + sniffExt(buf)), buf);
    if ("reason" in saved) { log.warn({ msgid, reason: saved.reason }, "channel media: not saved"); continue; }
    images.push(saved.path);
  }
  for (const ref of refs.files) {
    const buf = await fetchMedia(ref, log, msgid);
    if (!buf) continue;
    const saved = saveToInbox(dir, inboxName(msgid, i++, ref.name), buf);
    if ("reason" in saved) { log.warn({ msgid, reason: saved.reason }, "channel media: not saved"); continue; }
    files.push({ path: saved.path, name: ref.name });
  }
  log.info({ msgid, ...n, savedImages: images.length, savedFiles: files.length }, "channel media saved");
  return { images, files };
};

const replyBody = (frame: unknown): any =>
  (frame as { body?: unknown } | undefined)?.body ?? frame;

const call = async (client: WSClient, cmd: string, body: unknown): Promise<any> => {
  // reply() 只是「带 cmd 的 WS 请求」；req_id 自造，服务端回执按它匹配。
  const frame = await (client as any).reply({ headers: { req_id: generateReqId("topic") } }, body, cmd);
  return replyBody(frame);
};

const fetchPost = async (client: WSClient, topicId: string, postId: string, log: Logger): Promise<any> => {
  const body = await call(client, CMD_GET_POSTS, { topic_id: topicId, type: 0, post_id_list: [postId] });
  if (body?.errcode) log.warn({ errcode: body.errcode, errmsg: body.errmsg, topicId, postId }, "channel get_post failed");
  const list = body?.post_list ?? body?.posts ?? [];
  return list[0] ?? body?.post ?? null;
};

const fetchReply = async (client: WSClient, topicId: string, postId: string, replyId: string, log: Logger): Promise<any> => {
  const body = await call(client, CMD_GET_REPLIES, { topic_id: topicId, post_id: postId, type: 0, reply_id_list: [replyId] });
  if (body?.errcode) log.warn({ errcode: body.errcode, errmsg: body.errmsg, topicId, postId, replyId }, "channel get_reply failed");
  const list = body?.reply_list ?? body?.replies ?? [];
  return list[0] ?? null;
};

const fetchRecent = async (client: WSClient, topicId: string, limit: number, log: Logger): Promise<any[]> => {
  const body = await call(client, CMD_GET_POSTS, { topic_id: topicId, type: 1, sort_type: 1, limit });
  if (body?.errcode) log.warn({ errcode: body.errcode, errmsg: body.errmsg, topicId }, "channel get_recent failed");
  const list = body?.post_list ?? [];
  return Array.isArray(list) ? list.slice().reverse() : [];
};

/** 本地缓存 (每个 topic 一个 jsonl), 懒初始化: 配置里的 stateDir / 保留策略变了就换一份。 */
let store: ChannelStore | undefined;
let storeKey = "";
/** 已经回填过的 topic —— 进程重启后重新算一次 (断线空窗期的事件本地没有)。 */
const backfilled = new Set<string>();

const ensureStore = (cfg: Config): ChannelStore | undefined => {
  const h = cfg.wrc.channel.history;
  if (!h.enabled) return undefined;
  const key = cfg.daemon.stateDir + "|" + h.keepDays + "|" + h.maxMessages;
  if (!store || storeKey !== key) {
    store = new ChannelStore({
      dir: join(expandHome(cfg.daemon.stateDir), "channels"),
      keepDays: h.keepDays,
      maxMessages: h.maxMessages,
    });
    storeKey = key;
    backfilled.clear();
  }
  return store;
};

/** 频道回包的时间戳单位不统一 (秒 / 毫秒都见过)。 */
const atOf = (t: unknown): number => {
  const n = Number(t ?? 0);
  if (!Number.isFinite(n) || n <= 0) return Date.now();
  return n > 1e12 ? n : n * 1000;
};

const authorOf = (creator: any): string => {
  const c = creator ?? {};
  return Number(c.type) === 1 ? "bot:" + String(c.aibotid ?? "?").slice(0, 10) : String(c.userid ?? "user");
};

const postMsg = (p: any, media: ChannelMedia = NO_MEDIA): ChannelMsg | undefined => {
  const id = String(p?.post_id ?? "");
  const text = cleanContent(p?.content);
  if (!id || (!text && !media.images.length && !media.files.length)) return undefined;
  return { id, kind: "post", postId: id, at: atOf(p?.create_time), author: authorOf(p?.creator), text,
    ...(media.images.length ? { images: media.images } : {}), ...(media.files.length ? { files: media.files } : {}) };
};

const replyMsg = (r: any, postId: string, media: ChannelMedia = NO_MEDIA): ChannelMsg | undefined => {
  const id = String(r?.reply_id ?? "");
  const text = cleanContent(r?.content);
  if (!id || (!text && !media.images.length && !media.files.length)) return undefined;
  return { id, kind: "reply", postId: String(r?.post_id ?? postId), at: atOf(r?.create_time), author: authorOf(r?.creator), text,
    ...(media.images.length ? { images: media.images } : {}), ...(media.files.length ? { files: media.files } : {}) };
};

/** 最近消息里活跃的其他机器人 (§6 邻居感知): bot:<id> → 条数, 自己 (selfBot) 已剔除。 */
export const botAuthors = (msgs: Array<ChannelMsg | undefined>, selfBot = ""): Array<{ id: string; n: number }> => {
  const self = selfBot ? "bot:" + selfBot.slice(0, 10) : "";
  const n = new Map<string, number>();
  for (const m of msgs) {
    const a = m?.author ?? "";
    if (!a.startsWith("bot:") || a === self || a === "bot:?") continue;
    n.set(a, (n.get(a) ?? 0) + 1);
  }
  return [...n.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, 8)
    .map(([id, count]) => ({ id, n: count }));
};

/** 记一条进本地缓存: read_channel / 回填共用这一份。 */
const record = async (cfg: Config, topicId: string, msg: ChannelMsg | undefined): Promise<void> => {
  if (!msg) return;
  await ensureStore(cfg)?.append(topicId, msg);
};

/** 第一次见到的 topic 从官方补最近 N 条 —— reload / 断线空窗期的消息本地没有。 */
const backfill = async (client: WSClient, cfg: Config, log: Logger, topicId: string): Promise<void> => {
  const h = cfg.wrc.channel.history;
  const s = ensureStore(cfg);
  if (!s || !h.backfillOnBoot || backfilled.has(topicId)) return;
  backfilled.add(topicId);
  if ((await s.count(topicId)) >= h.mainPosts) return;
  const posts = await fetchRecent(client, topicId, h.mainPosts, log);
  for (const m of posts.map((p) => postMsg(p)).filter((x): x is ChannelMsg => !!x)) await s.append(topicId, m);
  log.info({ topicId, n: posts.length }, "channel history backfilled");
};

interface ChannelDeps { client: WSClient; cfg: Config; log: Logger }

/** 官方搜索: 两步 (search 出 jobid → get_search_result 取摘要), 摘要只是 ID, 正文按 post 再取一次。 */
const searchRemote = async (d: ChannelDeps, topicId: string, query: string, limit: number): Promise<ChannelMsg[]> => {
  const body = await call(d.client, CMD_SEARCH, { keyword_list: [query], topic_id_list: [topicId], limit });
  if (body?.errcode) {
    d.log.debug({ errcode: body.errcode, errmsg: body.errmsg, topicId }, "channel search rejected");
    return [];
  }
  const jobid = String(body?.jobid ?? "");
  if (!jobid) return [];
  const ids: string[] = [];
  for (let i = 0; i < 5 && ids.length < limit; i += 1) {
    const r = await call(d.client, CMD_SEARCH_RESULT, { jobid, topic_id: topicId, limit });
    if (r?.errcode) break;
    for (const x of r?.result_list ?? []) {
      const id = String(x?.post_id ?? "");
      if (id && !ids.includes(id)) ids.push(id);
    }
    if (!r?.has_more) break;
    await sleep(300);
  }
  if (!ids.length) return [];
  const b = await call(d.client, CMD_GET_POSTS, { topic_id: topicId, type: 0, post_id_list: ids.slice(0, Math.max(1, limit)) });
  const posts: any[] = b?.post_list ?? [];
  return posts.map((p) => postMsg(p)).filter((m): m is ChannelMsg => !!m);
};

/** 先本地 grep (便宜、立刻), 不够再走官方搜索 (语义索引只在服务端)。 */
const searchChannel = async (d: ChannelDeps, topicId: string, query: string, limit: number): Promise<ChannelMsg[]> => {
  if (!limit || !query) return [];
  const local = (await ensureStore(d.cfg)?.search(topicId, query, limit)) ?? [];
  if (local.length >= limit) return local;
  const seen = new Set(local.map((m) => m.id));
  const remote = (await searchRemote(d, topicId, query, limit)).filter((m) => !seen.has(m.id));
  return [...local, ...remote].slice(0, limit);
};

const stamp = (ms: number): string => {
  const d = new Date(ms);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return hh + ":" + mm;
};

/** read_channel 的一行: 正文 + 媒体 (图片 / 文件给本地路径, agent 直接 Read)。 */
const mediaTag = (m: ChannelMsg): string =>
  [...(m.images ?? []).map((p) => "[图: " + p + "]"), ...(m.files ?? []).map((f) => "[文件: " + f.name + " " + f.path + "]")].join(" ");
const renderLines = (list: ChannelMsg[]): string => list.map((m) => {
  const tag = mediaTag(m);
  return "[" + stamp(m.at) + "] " + m.author + ": " + clip(m.text, 400) + (tag ? " " + tag : "");
}).join("\n");

export interface ChannelReadReq { topic: string; query?: string; limit?: number; since?: number; until?: number }

/** read_channel 的守护进程侧: 本地缓存优先, 搜不到 / 没缓存才问官方。 */
export const readChannel = async (d: ChannelDeps, req: ChannelReadReq): Promise<{ ok: boolean; text: string }> => {
  const topicId = (parseTopicRoomId(req.topic.trim())?.channel ?? req.topic.replace(/^chat:/, "")).trim();
  if (!topicId) return { ok: false, text: "给一个频道: chat:<topic_id> / 裸 topic_id / 帖子 room id (topic:<频道>/<帖子>)" };
  const limit = Math.min(Math.max(Number(req.limit ?? 20) || 20, 1), 100);
  const query = (req.query ?? "").trim();
  if (query) {
    const hits = await searchChannel(d, topicId, query, limit);
    return { ok: true, text: hits.length ? "频道 " + topicId + " · 搜「" + query + "」· " + hits.length + " 条\n" + renderLines(hits) : "频道 " + topicId + " 没搜到「" + query + "」" };
  }
  const local = (await ensureStore(d.cfg)?.slice(topicId, { ...(req.since !== undefined ? { since: req.since } : {}), ...(req.until !== undefined ? { until: req.until } : {}), limit })) ?? [];
  const list = local.length
    ? local
    : (await fetchRecent(d.client, topicId, Math.min(limit, 20), d.log)).map((p) => postMsg(p)).filter((m): m is ChannelMsg => !!m);
  return { ok: true, text: list.length ? "频道 " + topicId + " · " + list.length + " 条\n" + renderLines(list) : "频道 " + topicId + " 没有读到消息 (没见过这个频道, 或还没缓存)" };
};

// 出站传输补丁必须早于 installResponseTracker 安装：tracker 会把当时的
// client.sendMessage / replyStream 抓成 orig*，晚装就绕过了频道分支。
/** base principal 是否是一个已登记的频道 (chat:<topic_id>)。 */
export const isTopicChat = (base: string): boolean =>
  base.startsWith("chat:") && topics.has(base.slice("chat:".length));

/** 频道 room 的出站: 一律发新帖 (send_post)。 */
/** 频道 room 的出站选择 (§2.3): 交代 / 回话挂在那条评论行上 (原话行带 post) → 评论回那个帖子;
 *  其余 (chat_say 主动说 / re 的不是评论) → 发新帖。选择编码在动作里, 不给工具加参数。
 *  postOf = 按消息 id 查那条原话行的频道 post_id (频道 room 的人话行带, 帖子 room 的行不带)。 */
export const channelOutboundOf = (
  row: { kind: string; re?: string[] },
  postOf: (id: string) => string | undefined,
): { action: "post" } | { action: "reply"; post: string } => {
  if (row.kind === "reply")
    for (const id of row.re ?? []) {
      const post = postOf(id);
      if (post) return { action: "reply", post };
    }
  return { action: "post" };
};

/** 频道出站带的素材 (已上传换来 media_id 的那种): 图片走 image_list, 其余走 inline_file_list
 *  (content 里必须出现对应的 `${inline_file:<placeholder>}`, 由 topicBody 补)。 */
export interface TopicMedia {
  imageIds?: string[];
  files?: Array<{ mediaId: string; name: string }>;
}

const topicBody = (content: string, media?: TopicMedia): Record<string, unknown> => {
  const files = media?.files ?? [];
  const inline = files.map((f, i) => ({ placeholder: "p" + (i + 1), media_id: f.mediaId }));
  const withInline = files.length
    ? content + "\n" + files.map((_, i) => "${inline_file:p" + (i + 1) + "}").join(" ")
    : content;
  const images = (media?.imageIds ?? []).map((id) => ({ media_id: id }));
  return { content: withInline, ...(images.length ? { image_list: images } : {}), ...(inline.length ? { inline_file_list: inline } : {}) };
};

/** send_post 的原始结果: 企微回的 body 原样带回 (调用方要从里面读 post_id; 字段名无真机证据, 见 postIdOfBody)。 */
export interface TopicPostResult {
  ok: boolean;
  errcode?: number;
  errmsg?: string;
  body: unknown;
}

/** 发新帖并把回包交回去。传输层抛错 (超时 / 断线) 照旧往上抛 —— 调用方据此报「发帖失败」。 */
export const sendTopicPostRaw = async (client: WSClient, log: Logger, topicId: string, content: string, media?: TopicMedia): Promise<TopicPostResult> => {
  const body = await call(client, CMD_POST, { topic_id: topicId, ...topicBody(content, media) });
  if (body?.errcode) {
    log.warn({ errcode: body.errcode, errmsg: body.errmsg, topicId }, "channel tool post rejected");
    return { ok: false, errcode: Number(body.errcode), errmsg: String(body.errmsg ?? ""), body };
  }
  log.info({ topicId, via: "post", len: content.length }, "channel tool sent");
  return { ok: true, body };
};

export const sendTopicPost = async (client: WSClient, log: Logger, topicId: string, content: string, media?: TopicMedia): Promise<"post"> => {
  await sendTopicPostRaw(client, log, topicId, content, media);
  return "post";
};

/** 帖子 room 的出站: 一律评论到根帖 (send_reply)。企微拒 (errcode) 时回 "rejected" —— 调用方决定回退。 */
export const sendTopicReply = async (client: WSClient, log: Logger, topicId: string, postId: string, content: string, media?: TopicMedia): Promise<"reply" | "rejected"> => {
  const body = await call(client, CMD_REPLY, { topic_id: topicId, post_id: postId, ...topicBody(content, media) });
  if (body?.errcode) {
    log.warn({ errcode: body.errcode, errmsg: body.errmsg, topicId, postId }, "channel tool reply rejected");
    return "rejected";
  }
  log.info({ topicId, postId, via: "reply", len: content.length }, "channel tool sent");
  return "reply";
};

/** 评论回帖, 被企微拒时回退发新帖 (2026-11-23 人报纠正: 没 @ 过机器人的帖子实测也能评论, 早先
 *  「只能评论 @ 过它的帖子」的说法不成立; 回退仅作真被拒的兜底, 不按 @ 与否预判。原先只 warn → 交代
 *  静默丢失)。fallback 是新帖正文 (通常带引用标注); 没给就用原正文。 */
export const sendTopicReplyOrPost = async (
  client: WSClient, log: Logger, topicId: string, postId: string, content: string, fallback?: string, media?: TopicMedia,
): Promise<"reply" | "post"> => {
  const r = await sendTopicReply(client, log, topicId, postId, content, media);
  if (r === "reply") return "reply";
  log.warn({ topicId, postId }, "channel reply rejected → fallback to post");
  await sendTopicPost(client, log, topicId, fallback ?? content, media);
  return "post";
};

export const installChannelTransport = (client: WSClient, log: Logger): void => {
  log.info("channel transport installed");
  // ── 出站：topic 不走群 chatid，改成频道新帖 ──
  const origSend = client.sendMessage.bind(client);
  (client as any).sendMessage = (chatid: string, body: any): Promise<any> => {
    // topic room (topic:<T>/<P>): 它不是群 chatid —— 审批卡改投问话人私聊, 正文评论回根帖。
    // (目标 key 的 base = room id, 审批 / mirror 的通知都会把它原样递进来。)
    const tr = parseTopicRoomId(String(chatid));
    if (tr) {
      if (body?.msgtype === "template_card") {
        const asker = lastAsker.get(tr.channel);
        if (asker) {
          log.info({ topicId: tr.channel, post: tr.post, asker }, "channel: card routed to asker DM");
          return origSend(asker, body);
        }
        log.warn({ topicId: tr.channel }, "channel: template_card dropped (no asker)");
        return Promise.resolve({ headers: { req_id: "" } } as WsFrame);
      }
      const text = body?.msgtype === "markdown" ? String(body.markdown?.content ?? "") : "";
      if (!text) {
        log.warn({ topicId: tr.channel, msgtype: body?.msgtype }, "channel: unsupported outbound");
        return Promise.resolve({ headers: { req_id: "" } } as WsFrame);
      }
      return sendTopicReply(client, log, tr.channel, tr.post, text).then(() => ({ headers: { req_id: "" } } as WsFrame));
    }
    // mirror 有时把 "chat:<topic>" 原样递进来；topic 集合里存的是裸 topic_id。
    const bare = String(chatid).replace(/^(user|chat|group):/, "");
    const topicId = topics.has(chatid) ? chatid : topics.has(bare) ? bare : "";
    if (!topicId) return origSend(chatid, body);
    // 频道没有模板卡片按钮；审批卡改投问话人的私聊，点完结论仍回到频道。
    if (body?.msgtype === "template_card") {
      const asker = lastAsker.get(topicId);
      if (asker) {
        log.info({ topicId, asker }, "channel: card routed to asker DM");
        return origSend(asker, body);
      }
      log.warn({ topicId }, "channel: template_card dropped (no asker)");
      return Promise.resolve({ headers: { req_id: "" } } as WsFrame);
    }
    const content = body?.msgtype === "markdown" ? String(body.markdown?.content ?? "") : "";
    if (!content) {
      log.warn({ topicId, msgtype: body?.msgtype }, "channel: unsupported outbound");
      return Promise.resolve({ headers: { req_id: "" } } as WsFrame);
    }
    // 存档频道 room (chat:<topic_id>) 只发新帖; 帖子 room 不走这里 (chat:<opk…> 不在 topics, 由 index 的
    // roomMirror 走 send_reply; topic:<T>/<P> 在上面)。
    return sendTopicPost(client, log, topicId, content).then(() => ({ headers: { req_id: "" } } as WsFrame));
  };
};

export interface ChannelHuman {
  /** 落进哪个 room: topic:<T>/<P> (新口径) 或存量帖子 room (chat:<opk…> / 曾被 room_bind 的承载 room)。
   *  行不带 post / src —— room 自己就是那个帖子。 */
  room: string;
  author: string;
  text: string;
  at: number;
  msgid: string;
  /** 已落 inbox 的图片路径 (纯图片的人话 text 为空, 靠它落行)。 */
  images?: string[];
  /** 内嵌文件: 本地路径 + 原名。 */
  files?: Array<{ path: string; name: string }>;
  /** 人 @ 了机器人 (等同点名 host)。 */
  mention?: "bot";
}

export interface ChannelFacts {
  /** topic_at_bot 等原生帧认领的时长 (ms); 缺省 3000, 测试注入短值。 */
  nativeWaitMs?: number;
  /** 人话落 room (入站写账本的唯一出口)。room 不在由 ingest 开 (founder = 频道 host 身份在本 room 的实例)。 */
  ingest?: (e: ChannelHuman) => void;
  /** (频道, 帖子, opk?) → 落哪个 room (topicRoomOf 的接线: 索引 / 账本由 daemon 注入)。
   *  缺省 = 不看索引与账本, 只按配对表 + 新口径 (测试桩 / 旧接线)。 */
  roomFor?: (topicId: string, postId: string, opk?: string) => string;
  /** 这个 post_id 是机器人自己刚发的新帖 (channelNewPost 记的最近自发集合): 它的 topic_event 不当人话落行。 */
  selfPost?: (postId: string) => boolean;
}

export const installChannelEvents = (client: WSClient, cfg: Config, log: Logger, facts?: ChannelFacts): void => {
  const wsm = (client as any).wsManager;
  if (!wsm || typeof wsm.handleFrame !== "function") {
    log.warn("channel: wsManager.handleFrame unavailable; topic events will be ignored");
    return;
  }

  /** 落一行人话; 没有 ingest (旧接线 / 测试桩) 就只记日志 —— 静默丢话是不允许的。 */
  const ingest = (e: ChannelHuman, rawContent = ""): void => {
    // 非 @ 机器人的帖子 / 评论里 @ 了别人 → 不是说给我们的, 在落行 (= 进 perceptron / 催生 topic room) 之前丢掉,
    // 只记一条 info; 频道历史 (record) 照记。topic_at_bot 的兜底行带 mention:"bot", 不判。`${inline_mention}` 结构化
    // 标记 (cleanContent 里已剥) 说不清点的是机器人还是别人, 有标记就放行 (fail-open, 无真实载荷样本)。判据与放行条件见
    // shared/mention-filter.ts (`wrc.botNames` 没配也放行)。
    if (e.mention !== "bot" && !new RegExp(MENTION_RE.source).test(rawContent)) {
      const others = addressedElsewhere(cfg.wrc.botNames, e.text);
      if (others.length) {
        log.info({ room: e.room, msgid: e.msgid, others }, "channel: @ 了别人而非本机器人, 不进 monitor (丢弃)");
        return;
      }
    }
    if (!facts?.ingest) {
      log.warn({ room: e.room, msgid: e.msgid }, "channel: no room ingest wired, message not delivered");
      return;
    }
    log.info({ room: e.room, msgid: e.msgid, len: e.text.length, mention: e.mention }, "channel rx");
    facts.ingest(e);
  };
  const roomFor = (topicId: string, postId: string, opk?: string): string =>
    facts?.roomFor?.(topicId, postId, opk)
    ?? topicRoomOf({ cfg, topic: topicId, post: postId, ...(opk ? { opk } : {}), roomOfSource: () => undefined, roomExists: () => false });

  const onTopic = async (frame: any): Promise<void> => {
    const body = frame?.body ?? {};
    const ev = body.event ?? {};
    const topicId = String(body.topic_id ?? "");
    const from = body.from ?? {};
    const asker = String(from.userid ?? "");
    const at = Number(body.create_time ?? 0) * 1000 || Date.now();
    const recvAt = Date.now();
    if (!topicId) return;
    registerTopic(topicId);
    if (asker) lastAsker.set(topicId, asker);
    // 频道没有 room, 只记「已知频道」名单 (引导 / 绑定 / 图上框标题认频道靠它)。
    learnChannel(cfg, topicId);
    // 第一次见到的频道从官方补最近 N 条 (reload / 断线空窗期的事件本地没有)。
    void backfill(client, cfg, log, topicId).catch((e: Error) => log.warn({ err: e.message, topicId }, "channel backfill failed"));
    log.info({ topicId, type: ev.eventtype, postId: ev.topic_event?.post_id ?? ev.topic_reply_event?.post_id ?? ev.topic_at_bot?.post_id, asker }, "channel event");

    if (ev.eventtype === "topic_at_bot") {
      const postId = String(ev.topic_at_bot?.post_id ?? "");
      const replyId = String(ev.topic_at_bot?.reply_id ?? "");
      const msgid = String(body.msgid ?? postId);
      if (!postId || !msgid) return;
      if (seen.has(msgid)) return;
      seen.add(msgid);
      if (seen.size > 3000) seen.delete(seen.values().next().value!);
      const native = await awaitNative(asker, recvAt - NATIVE_SKEW_MS, facts?.nativeWaitMs ?? NATIVE_WAIT_MS);
      if (native) {
        // 原生帧已把这句话投给帖子会话 (= 帖子 room 的那条人话); 桥只记账。
        // 配上的这一对就是「帖子 → 频道」的唯一判据 (原生帧里没有频道标识)。
        if (learnChannelPost(cfg, native, topicId, postId)) log.info({ topicId, post: native }, "channel post learned");
        log.info({ topicId, postId, msgid, nativeChat: native }, "channel at_bot: carried by native frame, bridge skip");
        await record(cfg, topicId, postMsg(await fetchPost(client, topicId, postId, log)));
        if (replyId) await record(cfg, topicId, replyMsg(await fetchReply(client, topicId, postId, replyId, log), postId));
        return;
      }
      const post = await fetchPost(client, topicId, postId, log);
      const reply = replyId ? await fetchReply(client, topicId, postId, replyId, log) : null;
      if (!post) log.warn({ topicId, postId }, "channel: post content not found");
      const hit = reply ?? post;
      const media = await downloadMedia(cfg, log, hit, msgid);
      await record(cfg, topicId, postMsg(post, reply ? NO_MEDIA : media));
      if (reply) await record(cfg, topicId, replyMsg(reply, postId, media));
      const text = cleanContent(hit?.content) || "（在频道里 @ 了你，没有正文）";
      // 兜底: 企微没推原生帧 → 桥自己落一行, 与原生路径同一个 topic room; 这一路是 topic_at_bot
      // (人 @ 了机器人), 一样记 mention:"bot" —— 直达 host, 不交给 room 的 perceptron。
      ingest({ room: roomFor(topicId, postId), author: asker, text, at, msgid, mention: "bot", ...mediaOf(media) });
      return;
    }

    if (ev.eventtype === "topic_event" && Number(ev.topic_event?.type ?? 0) === 1) {
      const postId = String(ev.topic_event?.post_id ?? "");
      const msgid = String(body.msgid ?? postId);
      if (!postId || !msgid) return;
      if (seen.has(msgid)) {
        log.info({ topicId, postId, msgid }, "channel topic_event skipped: seen");
        return;
      }
      if (!asker) {
        log.info({ topicId, postId, msgid }, "channel topic_event skipped: bot-authored");
        return;
      }
      seen.add(msgid);
      if (seen.size > 3000) seen.delete(seen.values().next().value!);
      // 双保险 (主判据是上面的 !asker): 自己刚发的新帖 —— 话已经由 chat_say 记进它的 room 了。
      if (facts?.selfPost?.(postId)) {
        log.info({ topicId, postId, msgid }, "channel topic_event skipped: self-posted");
        return;
      }
      const post = await fetchPost(client, topicId, postId, log);
      const media = await downloadMedia(cfg, log, post, msgid);
      await record(cfg, topicId, postMsg(post, media));
      const text = cleanContent(post?.content);
      if (!text && !media.images.length && !media.files.length) return;
      // 没被 @ 的新帖: 它自己 room 的第一行人话 (room 不在就开); 不 @ 机器人就不过 host, 由 perceptron 判激活。
      ingest({ room: roomFor(topicId, postId), author: asker, text, at, msgid, ...mediaOf(media) }, String(post?.content ?? ""));
      return;
    }

    if (ev.eventtype === "topic_reply_event" && Number(ev.topic_reply_event?.type ?? 0) === 1) {
      const postId = String(ev.topic_reply_event?.post_id ?? "");
      const replyId = String(ev.topic_reply_event?.reply_id ?? "");
      const msgid = String(body.msgid ?? replyId);
      if (!postId || !replyId || !msgid) return;
      if (seen.has(replyId) || !asker) {
        log.info({ topicId, postId, replyId, msgid, asker }, "channel topic_reply_event skipped");
        return;
      }
      seen.add(replyId);
      if (seen.size > 3000) seen.delete(seen.values().next().value!);
      const reply = await fetchReply(client, topicId, postId, replyId, log);
      const media = await downloadMedia(cfg, log, reply, msgid);
      await record(cfg, topicId, replyMsg(reply, postId, media));
      const text = cleanContent(reply?.content);
      if (!text && !media.images.length && !media.files.length) return;
      // 评论: 落它所属帖子的 room (不再需要先配对出 opk)。
      ingest({ room: roomFor(topicId, postId), author: asker, text, at, msgid, ...mediaOf(media) }, String(reply?.content ?? ""));
      return;
    }

    log.debug({ type: ev.eventtype, topicId }, "channel event ignored");
  };

  // 先接住原始帧，再交给 SDK 原来的 handleFrame（普通群 / 单聊不受影响）。
  // 注意不能包 onMessage: WSManager.handleFrame 的未知帧分支根本不会调它。
  const prev = wsm.handleFrame.bind(wsm);
  wsm.handleFrame = (frame: any) => {
    if (frame?.cmd === TOPIC_EVENT) {
      void onTopic(frame).catch((e: Error) => log.warn({ err: e.message }, "channel event failed"));
      return;
    }
    prev(frame);
  };
};
