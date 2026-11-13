// 频道（topic）桥: SDK 1.0.7 的 dispatch 表里没有 aibot_topic_event_callback，
// 这一层在 SDK 丢掉帧之前接住它，把「频道里 @ 了机器人」翻译成一条普通的文本消息
// 交给 inbound / mirror；出站再把 topic_id 的 markdown 换成频道的 send_post /
// send_reply。群聊 / 单聊的路径完全不变。
//
// 频道里没有被 @ 的新帖子 / 新回复也会进来（topic_event / topic_reply_event）。
// 这些不直接答，先交给每个 bot 的「判官」：判官是一个只读最近几条消息的轻量 wizard，
// 只回 JSON {respond, reason}；respond 才把原帖交给主 wizard。
import { spawn } from "node:child_process";
import { join } from "node:path";
import { generateReqId, type TextMessage, type WSClient, type WsFrame } from "@wecom/aibot-node-sdk";
import type { Logger } from "pino";
import type { Config } from "../shared/config.js";
import { pickTier } from "../shared/model-tiers.js";
import { resolveCliBackend } from "../shared/cli-backends.js";
import { augmentedPath } from "../shared/exec-path.js";
import { baseOfKey, keyOf } from "../shared/session-label.js";
import { sleep } from "../shared/std.js";
import { wizardStore } from "./wizard.js";
import { expandHome } from "../shared/paths.js";
import { ChannelStore, type ChannelMsg } from "./channel-store.js";
import { formatChannelContext, pickQuery, wantsHistory, withoutMsg } from "./channel-context.js";

const TOPIC_EVENT = "aibot_topic_event_callback";
const CMD_POST = "aibot_topic_send_post";
const CMD_REPLY = "aibot_topic_send_reply";
const CMD_GET_POSTS = "aibot_topic_get_post_list";
const CMD_GET_REPLIES = "aibot_topic_get_reply_list";
const CMD_SEARCH = "aibot_topic_search";
const CMD_SEARCH_RESULT = "get_search_result";


interface TopicCtx { topicId: string; postId: string; asker: string }

/** 已知 topic_id。sendMessage 用它区分「频道」和普通群 chatid。 */
const topics = new Set<string>();
/** 入站事件 msgid → 它所属的帖子；replyStream 用 streamId 找回来。 */
const byStream = new Map<string, TopicCtx>();
/** topic 上最近一条帖子，主动消息尽量挂成它的评论。 */
const lastPost = new Map<string, string>();
/** 频道里最近一个说话的人；审批卡改投他的私聊，频道不支持按钮卡片。 */
const lastAsker = new Map<string, string>();
/** 事件可能重投；msgid 去重表有界。 */
const seen = new Set<string>();
/** 已经交给主 wizard 的 post / reply；判官与直接 @ 可能同时到，谁先到谁答。 */
const dispatched = new Set<string>();
/** post_id → 是否收到过 topic_at_bot。只有被 @ 过的帖子才能用 send_reply 评论；
 *  未被 @ 的新帖只能 send_post 主动发（官方“回复被@的内容” vs “主动发内容”）。 */
const replyOk = new Map<string, boolean>();
/** 判官串行：同一 topic 一次只跑一个判断，一次 -p 进程更不该并发抢占。 */
const judgeQueues = new Map<string, Promise<unknown>>();

const MENTION_RE = /\$\{inline_mention(?::[^}]*)?\}/g;
const FILE_RE = /\$\{inline_file(?::[^}]*)?\}/g;

const cleanContent = (s: unknown): string =>
  String(s ?? "").replace(MENTION_RE, "").replace(FILE_RE, "").trim();
const clip = (s: string, n = 300): string => (s.length > n ? s.slice(0, n) + "…" : s);

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
  const key = `${cfg.daemon.stateDir}|${h.keepDays}|${h.maxMessages}`;
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
  return Number(c.type) === 1 ? `bot:${String(c.aibotid ?? "?").slice(0, 10)}` : String(c.userid ?? "user");
};

const postMsg = (p: any): ChannelMsg | undefined => {
  const id = String(p?.post_id ?? "");
  const text = cleanContent(p?.content);
  if (!id || !text) return undefined;
  return { id, kind: "post", postId: id, at: atOf(p?.create_time), author: authorOf(p?.creator), text };
};

const replyMsg = (r: any, postId: string): ChannelMsg | undefined => {
  const id = String(r?.reply_id ?? "");
  const text = cleanContent(r?.content);
  if (!id || !text) return undefined;
  return { id, kind: "reply", postId: String(r?.post_id ?? postId), at: atOf(r?.create_time), author: authorOf(r?.creator), text };
};

/** 记一条进本地缓存: 判官上下文 / 主 wizard 上下文 / read_channel 共用这一份。 */
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
  for (const m of posts.map(postMsg).filter((x): x is ChannelMsg => !!x)) await s.append(topicId, m);
  log.info({ topicId, n: posts.length }, "channel history backfilled");
};

/** 判官 / 上下文要看的最近帖子: 本地够用就不打接口。 */
const recentPosts = async (client: WSClient, cfg: Config, log: Logger, topicId: string, limit: number): Promise<ChannelMsg[]> => {
  const local = (await ensureStore(cfg)?.recentPosts(topicId, limit)) ?? [];
  if (local.length >= Math.min(limit, 3)) return local;
  const posts = await fetchRecent(client, topicId, limit, log);
  return posts.map(postMsg).filter((m): m is ChannelMsg => !!m);
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
  return posts.map(postMsg).filter((m): m is ChannelMsg => !!m);
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

/** 主 wizard 的上下文: 当前线程 + 最近 + (这句话有指代时才) 搜索命中。
 *  入站帧的身份 (topic / post / msgid) 永远写在首行 —— 即使 history 关掉、没有历史可带，
 *  主 agent 也必须能指回原始消息。 */
const contextFor = async (
  d: ChannelDeps,
  topicId: string,
  postId: string,
  triggerId: string | undefined,
  text: string,
  extra: { reason?: string; intent?: string; msgid?: string } = {},
): Promise<string> => {
  const h = d.cfg.wrc.channel.history;
  // 触发这条上下文的回复 id 与线程根不同 (评论) 时一并带上: 目标 agent 要能指回
  // 那一句评论, 而不只是它所属的帖子。
  const replyId = triggerId && triggerId !== postId ? triggerId : "";
  const id = { topicId, postId, ...(replyId ? { replyId } : {}), ...(extra.msgid ? { msgid: extra.msgid } : {}) };
  const s = ensureStore(d.cfg);
  if (!s) return formatChannelContext({ ...id, budget: h.contextChars });
  const thread = withoutMsg(await s.thread(topicId, postId, h.mainReplies), triggerId);
  const recent = withoutMsg(await s.recentPosts(topicId, h.mainPosts), triggerId);
  const query = h.searchLimit > 0 && wantsHistory(text) ? pickQuery(text) : "";
  const hits = query ? (await searchChannel(d, topicId, query, h.searchLimit)).filter((m) => m.id !== triggerId) : [];
  return formatChannelContext({
    ...id,
    thread,
    recent,
    hits,
    ...(query ? { query } : {}),
    ...(extra.reason ? { reason: extra.reason } : {}),
    ...(extra.intent ? { intent: extra.intent } : {}),
    budget: h.contextChars,
  });
};

const stamp = (ms: number): string => {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

const renderLines = (list: ChannelMsg[]): string => list.map((m) => `[${stamp(m.at)}] ${m.author}: ${clip(m.text, 400)}`).join("\n");

export interface ChannelReadReq { topic: string; query?: string; limit?: number; since?: number; until?: number }

/** read_channel 的守护进程侧: 本地缓存优先, 搜不到 / 没缓存才问官方。 */
export const readChannel = async (d: ChannelDeps, req: ChannelReadReq): Promise<{ ok: boolean; text: string }> => {
  const topicId = req.topic.replace(/^chat:/, "").trim();
  if (!topicId) return { ok: false, text: "给一个频道: `chat:<topic_id>` 或裸 topic_id" };
  const limit = Math.min(Math.max(Number(req.limit ?? 20) || 20, 1), 100);
  const query = (req.query ?? "").trim();
  if (query) {
    const hits = await searchChannel(d, topicId, query, limit);
    return { ok: true, text: hits.length ? `频道 ${topicId} · 搜「${query}」· ${hits.length} 条\n${renderLines(hits)}` : `频道 ${topicId} 没搜到「${query}」` };
  }
  const local = (await ensureStore(d.cfg)?.slice(topicId, { ...(req.since !== undefined ? { since: req.since } : {}), ...(req.until !== undefined ? { until: req.until } : {}), limit })) ?? [];
  const list = local.length
    ? local
    : (await fetchRecent(d.client, topicId, Math.min(limit, 20), d.log)).map(postMsg).filter((m): m is ChannelMsg => !!m);
  return { ok: true, text: list.length ? `频道 ${topicId} · ${list.length} 条\n${renderLines(list)}` : `频道 ${topicId} 没有读到消息 (没见过这个频道, 或还没缓存)` };
};

const emptyFrame = (): WsFrame => ({ headers: { req_id: "" } } as WsFrame);

const serial = <T>(key: string, job: () => Promise<T>): Promise<T> => {
  const prev = judgeQueues.get(key) ?? Promise.resolve();
  const next = prev.then(job, job);
  judgeQueues.set(key, next.catch(() => undefined).finally(() => {
    if (judgeQueues.get(key) === next) judgeQueues.delete(key);
  }));
  return next;
};

// 判官的输出契约。respond=false 时 intent / rewrite 一律不采信 (不要编造改写)；
// respond=true 时 rewrite 是给主 agent 的正文，缺失或为空就退回原帖。
// 只有 respond 决定放不放行，intent / rewrite 再差也不影响这次放行。
type Verdict = { respond: boolean; reason: string; intent?: string; rewrite?: string };

/** 逐个 `{` 数括号取 JSON 对象 (跳过字符串里的括号)，比非贪婪正则可容下 rewrite 里的代码块。 */
const jsonObjects = (text: string): string[] => {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] !== "{") continue;
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let j = i; j < text.length; j += 1) {
      const c = text[j];
      if (inStr) {
        if (esc) esc = false;
        else if (c === "\\") esc = true;
        else if (c === '"') inStr = false;
      } else if (c === '"') inStr = true;
      else if (c === "{") depth += 1;
      else if (c === "}") {
        depth -= 1;
        if (depth === 0) {
          out.push(text.slice(i, j + 1));
          i = j;
          break;
        }
      }
    }
  }
  return out;
};

const asText = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

/** 字段容错: 只认字符串 (对象 / 数组当没写)，并按第一个非空别名取值 —— 模型多吐、少吐都不炸。 */
const asField = (o: Record<string, unknown>, keys: string[]): string =>
  keys.map((k) => asText(o[k])).find(Boolean) ?? "";

/** respond 也容忍模型写成字符串 "true" / "false"。 */
const asReply = (v: unknown): boolean | undefined =>
  typeof v === "boolean" ? v : v === "true" ? true : v === "false" ? false : undefined;

export const parseVerdict = (text: string): Verdict | undefined => {
  for (const b of jsonObjects(text).reverse()) {
    try {
      const o = JSON.parse(b) as Record<string, unknown>;
      const respond = asReply(o.respond);
      if (respond === undefined) continue;
      const intent = asField(o, ["intent", "意图"]);
      const rewrite = asField(o, ["rewrite", "rewritten", "instruction", "改写"]);
      return {
        respond,
        reason: asField(o, ["reason", "理由"]),
        ...(respond && intent ? { intent } : {}),
        ...(respond && rewrite ? { rewrite } : {}),
      };
    } catch { /* 不是这一块 */ }
  }
  const plain = text.trim();
  if (/^yes\b/i.test(plain)) return { respond: true, reason: plain.slice(0, 120) };
  if (/^no\b/i.test(plain)) return { respond: false, reason: plain.slice(0, 120) };
  return undefined;
};

/** 判官放行后交给主 agent 的正文: 改写优先, 原文永远可回溯。
 *  改写缺失 / 为空 / 与原文相同 → 原样用原帖, 改写这一层坏了也不丢消息。 */
const bodyFor = (text: string, verdict: Verdict): string => {
  const rewrite = verdict.respond ? (verdict.rewrite ?? "").trim() : "";
  if (!rewrite || rewrite === text.trim()) return text;
  return `${rewrite}\n——\n原帖：${text}`;
};

export interface JudgeDeps { cfg: Config; log: Logger }

/** 判官是一次性判定, 不是一个住下来的会话: 一个 `-p` 进程进, stdout 出一行 JSON。
 *  不落会话 (--no-session-persistence)、不给工具 (--tools "")、不带 --settings /
 *  --session-id —— 判官不该在 projects/ 里留痕被当成可镜像的会话, 也不该出审批卡。 */
export const runJudgeOnce = (deps: JudgeDeps, prompt: string): Promise<string | undefined> => {
  const { cfg, log } = deps;
  const backend = resolveCliBackend(cfg.wrc);
  if (!backend.oneShotArgs) {
    log.warn({ backend: backend.name }, "channel judge: backend has no one-shot mode");
    return Promise.resolve(undefined);
  }
  const pick = pickTier(cfg, cfg.wrc.channel.judge.tier, {});
  const args = backend.oneShotArgs(prompt, {
    ...(pick.ok && pick.model ? { model: pick.model } : {}),
    ...(pick.ok && pick.effort ? { effort: pick.effort } : {}),
  });
  const timeoutMs = cfg.wrc.channel.judge.timeoutMs;
  return new Promise((resolve) => {
    const started = Date.now();
    const proc = spawn(backend.bin, args, {
      cwd: expandHome(cfg.wrc.cwd),
      env: { ...process.env, PATH: augmentedPath(process.env.PATH) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let errTail = "";
    let settled = false;
    const finish = (text: string | undefined, why: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const ms = Date.now() - started;
      if (text) log.info({ ms, tier: pick.ok ? pick.tier : undefined, model: pick.ok ? pick.model : undefined }, "channel judge ran");
      else log.warn({ ms, why, bin: backend.bin, stderrTail: errTail.slice(-200) }, "channel judge: no verdict");
      resolve(text);
    };
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      finish(undefined, `timeout ${timeoutMs}ms`);
    }, timeoutMs);
    proc.stdout?.on("data", (c: Buffer) => { out = (out + c.toString("utf8")).slice(-8000); });
    proc.stderr?.on("data", (c: Buffer) => { errTail = (errTail + c.toString("utf8")).slice(-800); });
    proc.on("error", (e: Error) => finish(undefined, `spawn ${e.message}`));
    proc.on("close", (code) => {
      if (code !== 0) return finish(undefined, `exit ${code}`);
      finish(out.trim() || undefined, "empty output");
    });
  });
};

const askJudge = async (deps: JudgeDeps, prompt: string): Promise<Verdict | undefined> => {
  const text = await runJudgeOnce(deps, prompt);
  if (!text) return undefined;
  const verdict = parseVerdict(text);
  if (!verdict) deps.log.warn({ chars: text.length, head: text.slice(0, 200) }, "channel judge: unparsable output");
  return verdict;
};

const botName = (cfg: Config): string => cfg.wrc.botNames.find(Boolean) ?? "wezard";

export interface JudgePrompt {
  topicId: string;
  /** 线程根 (被回复的那条帖子)。 */
  postId: string;
  /** 触发这次判断的回复 id; 新帖时等于 postId。 */
  triggerId: string;
  /** 入站帧 id, 目标 agent 靠它去重 / 定位。 */
  msgid: string;
  recent: ChannelMsg[];
  thread: ChannelMsg[];
  latest: string;
  latestAuthor: string;
}

/** 每条历史都带 id + 时刻: 判官只做判定不改身份, 但它引用的那一句必须能被
 *  目标 agent 直接指回去, 所以 id 不能被压缩成 "第 N 条"。 */
const judgeLine = (m: ChannelMsg, mark = "  "): string =>
  `${mark}${m.kind === "reply" ? "reply" : "post"}=${m.id} [${stamp(m.at)}] ${m.author}: ${clip(m.text, 300)}`;

export const buildJudgePrompt = (cfg: Config, i: JudgePrompt): string => {
  const base = `chat:${i.topicId}`;
  const me = botName(cfg);
  const job = wizardStore()?.get(base)?.description ?? "这个频道的助手";
  const others = (wizardStore()?.all() ?? [])
    .filter((w) => baseOfKey(w.target) === base && w.target !== base && w.target !== keyOf(base, "judge"))
    .map((w) => `${w.name || w.target}${w.description ? `（${w.description}）` : ""}`)
    .slice(0, 12);
  const isReply = i.triggerId && i.triggerId !== i.postId;
  return [
    `你是 ${me} 的频道判官。判断最新一条消息是否应该由 ${me} 回应；该回应时，把它整理成一条给主 agent 的指令。`,
    `定位：topic=${i.topicId} · thread post=${i.postId}${isReply ? ` · 本次消息 reply=${i.triggerId}` : ""} · msgid=${i.msgid}`,
    `你的职责：${job}`,
    others.length ? `频道里其他机器人：${others.join("、")}` : "",
    i.thread.length ? "这条消息所在的线程（父帖 + 评论，都带 id）：" : "",
    ...i.thread.map((m) => judgeLine(m, "  ")),
    i.recent.length ? "最近的频道消息（旧→新）：" : "",
    ...i.recent.map((m, k) => judgeLine(m, `[${k + 1}] `)),
    `最新消息（${i.latestAuthor}）：${clip(i.latest, 600)}`,
    "",
    "规则：",
    "- 最新消息 @ 了别的机器人、明显属于别人的职责、或只是闲聊 → respond=false",
    "- 最新消息在向本频道求助、需要你回答 → respond=true",
    "- 拿不准也 respond=false；不要重复别人已经回答的内容",
    "- respond=false 时不要写 intent / rewrite，留空字符串",
    "",
    "respond=true 时还要给出两步（只整理，不回答）：",
    "1. intent：一句话说清这条消息想要什么（问什么 / 要你做什么 / 报了什么故障）。",
    "2. rewrite：把这条消息改写成一条主 agent 能直接执行的自洽指令 ——",
    "   补全省略的主语和指代对象（必要时代上线程里被回复的那一句），把零散的一句压成一条完整指令；",
    "   原文里的路径、命令、报错、数字、ID、链接一律原样保留，不添加原文没有的事实，不替用户补需求，不写答复内容；",
    "   用与原文相同的语言，只写改写后的正文，不要加「改写：」之类的前缀。",
    "",
    "这是一次性请求：不要调用工具，不要回答用户，不要解释。只输出下面这一行 JSON（不要代码围栏）：",
    '{"respond":true|false,"reason":"一句话判断依据","intent":"一句话意图（respond=false 时留空）","rewrite":"改写后给主 agent 的指令正文（respond=false 时留空）"}',
  ].filter(Boolean).join("\n");
};

// 出站传输补丁必须早于 installResponseTracker 安装：tracker 会把当时的
// client.sendMessage / replyStream 抓成 orig*，晚装就绕过了频道分支。
export const installChannelTransport = (client: WSClient, log: Logger): void => {
  log.info("channel transport installed");
  const sendPost = (topicId: string, content: string): Promise<any> =>
    call(client, CMD_POST, { topic_id: topicId, content })
      .then((body) => {
        if (body?.errcode) log.warn({ errcode: body.errcode, errmsg: body.errmsg, topicId }, "channel post rejected");
        else log.info({ topicId, len: content.length }, "channel post sent");
        const id = String(body?.post_id ?? ""); if (id) lastPost.set(topicId, id); return body;
      })
      .catch((e: Error) => { log.warn({ err: e.message, topicId }, "channel post failed"); return undefined; });

  const sendReply = (ctx: TopicCtx, content: string): Promise<any> =>
    call(client, CMD_REPLY, { topic_id: ctx.topicId, post_id: ctx.postId, content })
      .then((body) => {
        if (body?.errcode) log.warn({ errcode: body.errcode, errmsg: body.errmsg, topicId: ctx.topicId }, "channel reply rejected");
        else log.info({ topicId: ctx.topicId, postId: ctx.postId, len: content.length }, "channel reply sent");
        return body;
      })
      .catch((e: Error) => { log.warn({ err: e.message, topicId: ctx.topicId }, "channel reply failed"); return undefined; });

  // ── 出站：topic 不走群 chatid，改成频道帖子 / 评论 ──
  const origSend = client.sendMessage.bind(client);
  (client as any).sendMessage = (chatid: string, body: any): Promise<any> => {
    // mirror 有时把 “chat:<topic>” 原样递进来；topic 集合里存的是裸 topic_id。
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
      return Promise.resolve(emptyFrame());
    }
    const content = body?.msgtype === "markdown" ? String(body.markdown?.content ?? "") : "";
    if (!content) {
      log.warn({ topicId, msgtype: body?.msgtype }, "channel: unsupported outbound");
      return Promise.resolve(emptyFrame());
    }
    const postId = lastPost.get(topicId);
    // 只有被 @ 过的帖子才能评论；未被 @ 的新帖只能主动发一条新帖。
    return postId && replyOk.get(postId) === true
      ? sendReply({ topicId, postId, asker: lastAsker.get(topicId) ?? "" }, content)
      : sendPost(topicId, content);
  };

  // replyStream 的气泡只对群聊有意义；频道里把最终帧落成一条评论，中间帧丢掉。
  const origStream = client.replyStream.bind(client);
  (client as any).replyStream = (frame: any, streamId: string, content: string, finish = false, ...rest: any[]): Promise<any> => {
    // 事件流里的 streamId 可能是 route eventId，而 fake frame 的 req_id 才是频道 msgid —— 两边都认。
    const ctx = byStream.get(streamId) ?? byStream.get(String(frame?.headers?.req_id ?? ""));
    if (!ctx) return origStream(frame, streamId, content, finish, ...rest);
    if (!finish) return Promise.resolve(emptyFrame());
    return replyOk.get(ctx.postId) === true ? sendReply(ctx, content) : sendPost(ctx.topicId, content);
  };
};

export const installChannelEvents = (client: WSClient, cfg: Config, log: Logger): void => {
  const wsm = (client as any).wsManager;
  if (!wsm || typeof wsm.handleFrame !== "function") {
    log.warn("channel: wsManager.handleFrame unavailable; topic events will be ignored");
    return;
  }

  const dispatch = (topicId: string, postId: string, msgid: string, fromUser: string, text: string, at: number, allowReply: boolean): void => {
    if (dispatched.has(postId)) return;
    dispatched.add(postId);
    if (dispatched.size > 3000) dispatched.delete(dispatched.values().next().value!);
    replyOk.set(postId, allowReply);
    if (replyOk.size > 3000) replyOk.delete(replyOk.keys().next().value!);
    lastPost.set(topicId, postId);
    byStream.set(msgid, { topicId, postId, asker: fromUser });
    if (byStream.size > 3000) byStream.delete(byStream.keys().next().value!);
    const fake = {
      headers: { req_id: msgid },
      body: {
        msgid,
        chattype: "group",
        chatid: topicId,
        from: { userid: fromUser },
        create_time: at,
        msgtype: "text",
        text: { content: text },
      },
    } as WsFrame<TextMessage>;
    log.info({ topicId, postId, msgid, len: text.length }, "channel rx");
    client.emit("message.text", fake);
  };

  const mentions = (post: any): Array<{ type: number; bot?: string }> => {
    const list = post?.inline_mention_list ?? post?.mention_list ?? [];
    if (!Array.isArray(list)) return [];
    return list.map((x: any) => {
      const m = x?.member ?? x ?? {};
      return { type: Number(m.type ?? 0), bot: typeof m.aibotid === "string" ? m.aibotid : undefined };
    });
  };

  const judgeAndMaybe = async (topicId: string, postId: string, msgid: string, fromUser: string, text: string, at: number, selfBot: string, triggerId: string): Promise<void> => {
    if (!cfg.wrc.channel.judge.enabled) {
      log.info({ topicId, postId }, "channel judge disabled");
      return;
    }
    if (dispatched.has(postId)) {
      log.info({ topicId, postId }, "channel judge skipped: already dispatched");
      return;
    }
    const post = await fetchPost(client, topicId, postId, log);
    const ms = mentions(post);
    // 不能因为“提到自己”就跳过：回复/引用机器人时 inline_mention 也可能带上自己，
    // 但这时不一定有 topic_at_bot。交给判官，dispatched 会保证不会双答。
    if (ms.some((m) => m.type === 1 && m.bot === selfBot)) {
      log.info({ topicId, postId }, "channel judge: self-mention, wait for topic_at_bot");
      // 先等一拍：真有 topic_at_bot 就让直接 @ 路径答（评论）；没有才走判官。
      await sleep(1200);
      if (dispatched.has(postId)) {
        log.info({ topicId, postId }, "channel judge skipped: self-mention handled by topic_at_bot");
        return;
      }
    }
    if (ms.some((m) => m.type === 1 && m.bot && m.bot !== selfBot)) {
      log.info({ topicId, postId }, "channel judge skipped: addressed to another bot");
      return;
    }
    const recent = await recentPosts(client, cfg, log, topicId, cfg.wrc.channel.judge.maxPosts);
    const thread = withoutMsg((await ensureStore(cfg)?.thread(topicId, postId, 4)) ?? [], triggerId);
    const prompt = buildJudgePrompt(cfg, {
      topicId, postId, triggerId, msgid,
      recent: withoutMsg(recent, triggerId),
      thread,
      latest: text,
      latestAuthor: fromUser,
    });
    // 一次 -p 进程也串行：同一 topic 两条消息同时到不该各起一个, 判词会互相盖。
    const verdict = await serial(`judge:${topicId}`, () => askJudge({ cfg, log }, prompt));
    if (!verdict?.respond) {
      // 超时 / 进程失败 / 输出解析不了都落在这里: 判官是个减噪层, 它的结论是「不回应」。
      // 回落 = 不投递 (频道里不会有人收到这条), 但要留得下可查的一行 —— 不静默丢。
      log.warn(
        { topicId, postId, msgid, triggerId, reason: verdict?.reason ?? "timeout/unparsable" },
        "channel judge: no dispatch (verdict absent or respond=false)",
      );
      return;
    }
    log.info({ topicId, postId, reason: verdict.reason, intent: verdict.intent, rewritten: !!verdict.rewrite }, "channel judge: yes");
    // 判官说 YES 才拼展开版上下文: 线程 + 最近 + (这句话有指代时) 搜索命中。
    // 入站帧的 msgid 随首行一起下去 —— 判官只加意图 / 改写，不替换身份。
    const ctx = await contextFor({ client, cfg, log }, topicId, postId, triggerId, text, {
      reason: verdict.reason,
      msgid,
      ...(verdict.intent ? { intent: verdict.intent } : {}),
    });
    dispatch(topicId, postId, msgid, fromUser, `${ctx}\n——\n${bodyFor(text, verdict)}`, at, false);
  };

  const onTopic = async (frame: any): Promise<void> => {
    const body = frame?.body ?? {};
    const ev = body.event ?? {};
    const topicId = String(body.topic_id ?? "");
    const from = body.from ?? {};
    const asker = String(from.userid ?? "");
    const selfBot = String(body.aibotid ?? "");
    const at = Number(body.create_time ?? 0) * 1000 || Date.now();
    if (!topicId) return;
    topics.add(topicId);
    if (asker) lastAsker.set(topicId, asker);
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
      if (dispatched.has(postId)) return;
      const post = await fetchPost(client, topicId, postId, log);
      const reply = replyId ? await fetchReply(client, topicId, postId, replyId, log) : null;
      if (!post) log.warn({ topicId, postId }, "channel: post content not found");
      await record(cfg, topicId, postMsg(post));
      if (reply) await record(cfg, topicId, replyMsg(reply, postId));
      const text = cleanContent(reply?.content ?? post?.content) || "（在频道里 @ 了你，没有正文）";
      const ctx = await contextFor({ client, cfg, log }, topicId, postId, replyId || postId, text, { msgid });
      dispatch(topicId, postId, msgid, asker, `${ctx}\n——\n${text}`, at, true);
      return;
    }

    if (ev.eventtype === "topic_event" && Number(ev.topic_event?.type ?? 0) === 1) {
      const postId = String(ev.topic_event?.post_id ?? "");
      const msgid = String(body.msgid ?? postId);
      if (!postId || !msgid) return;
      if (seen.has(msgid) || dispatched.has(postId)) {
        log.info({ topicId, postId, msgid }, "channel topic_event skipped: seen/dispatched");
        return;
      }
      if (!asker) {
        log.info({ topicId, postId, msgid }, "channel topic_event skipped: bot-authored");
        return;
      }
      seen.add(msgid);
      if (seen.size > 3000) seen.delete(seen.values().next().value!);
      const post = await fetchPost(client, topicId, postId, log);
      await record(cfg, topicId, postMsg(post));
      const text = cleanContent(post?.content);
      if (!text) return;
      void judgeAndMaybe(topicId, postId, msgid, asker, text, at, selfBot, postId)
        .catch((e: Error) => log.warn({ err: e.message, topicId, postId }, "channel judge failed"));
      return;
    }

    if (ev.eventtype === "topic_reply_event" && Number(ev.topic_reply_event?.type ?? 0) === 1) {
      const postId = String(ev.topic_reply_event?.post_id ?? "");
      const replyId = String(ev.topic_reply_event?.reply_id ?? "");
      const msgid = String(body.msgid ?? replyId);
      if (!postId || !replyId || !msgid) return;
      if (seen.has(replyId) || dispatched.has(replyId) || !asker) {
        log.info({ topicId, postId, replyId, msgid, asker }, "channel topic_reply_event skipped");
        return;
      }
      seen.add(replyId);
      if (seen.size > 3000) seen.delete(seen.values().next().value!);
      const reply = await fetchReply(client, topicId, postId, replyId, log);
      await record(cfg, topicId, replyMsg(reply, postId));
      const text = cleanContent(reply?.content);
      if (!text) return;
      void judgeAndMaybe(topicId, postId, msgid, asker, text, at, selfBot, replyId)
        .catch((e: Error) => log.warn({ err: e.message, topicId, postId }, "channel judge failed"));
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

// 兼容入口：新代码应分别早装 transport、晚装 events。
export const installChannelBridge = (client: WSClient, cfg: Config, log: Logger): void => {
  installChannelTransport(client, log);
  installChannelEvents(client, cfg, log);
};
