// 频道（topic）桥: SDK 1.0.7 的 dispatch 表里没有 aibot_topic_event_callback，
// 这一层在 SDK 丢掉帧之前接住它，把「频道里 @ 了机器人」翻译成一条普通的文本消息
// 交给 inbound / mirror；出站再把 topic_id 的 markdown 换成频道的 send_post /
// send_reply。群聊 / 单聊的路径完全不变。
//
// 频道里没有被 @ 的新帖子 / 新回复也会进来（topic_event / topic_reply_event）。
// 这些不直接答，先交给每个 bot 的「判官」：判官是一个只读最近几条消息的轻量 wizard，
// 只回 JSON {respond, reason}；respond 才把原帖交给主 wizard。
import { generateReqId, type TextMessage, type WSClient, type WsFrame } from "@wecom/aibot-node-sdk";
import type { Logger } from "pino";
import type { Config } from "../shared/config.js";
import { pickTier } from "../shared/model-tiers.js";
import { baseOfKey, keyOf } from "../shared/session-label.js";
import { sleep } from "../shared/std.js";
import { wizardStore } from "./wizard.js";
import { lastAssistantText, talkTurns } from "./peers.js";
import type { MirrorBridge } from "./mirror-bridge.js";

const TOPIC_EVENT = "aibot_topic_event_callback";
const CMD_POST = "aibot_topic_send_post";
const CMD_REPLY = "aibot_topic_send_reply";
const CMD_GET_POSTS = "aibot_topic_get_post_list";
const CMD_GET_REPLIES = "aibot_topic_get_reply_list";

const JUDGE_JOB = "频道判官：只判断这条频道消息是否该由本机器人回应；只输出 JSON {\"respond\":true|false,\"reason\":\"…\"}；不回答用户，不调用工具。";
const JUDGE_POLL_MS = 300;

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
/** 判官串行：同一判官一次只处理一条，避免 transcript 串轮。 */
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

const emptyFrame = (): WsFrame => ({ headers: { req_id: "" } } as WsFrame);

const serial = <T>(key: string, job: () => Promise<T>): Promise<T> => {
  const prev = judgeQueues.get(key) ?? Promise.resolve();
  const next = prev.then(job, job);
  judgeQueues.set(key, next.catch(() => undefined).finally(() => {
    if (judgeQueues.get(key) === next) judgeQueues.delete(key);
  }));
  return next;
};

type Verdict = { respond: boolean; reason: string };

const parseVerdict = (text: string): Verdict | undefined => {
  const blocks = [...text.matchAll(/\{[\s\S]*?\}/g)].map((m) => m[0]);
  for (const b of blocks.reverse()) {
    try {
      const o = JSON.parse(b) as { respond?: unknown; reason?: unknown };
      if (typeof o.respond === "boolean") return { respond: o.respond, reason: String(o.reason ?? "") };
    } catch { /* not the JSON block */ }
  }
  const plain = text.trim();
  if (/^yes\b/i.test(plain)) return { respond: true, reason: plain.slice(0, 120) };
  if (/^no\b/i.test(plain)) return { respond: false, reason: plain.slice(0, 120) };
  return undefined;
};

interface JudgeDeps { cfg: Config; log: Logger; bridge: MirrorBridge }

const judgeTarget = (topicId: string): string => keyOf(`chat:${topicId}`, "judge");

const ensureJudge = async (deps: JudgeDeps, topicId: string): Promise<string | undefined> => {
  const target = judgeTarget(topicId);
  wizardStore()?.upsert(target, { description: JUDGE_JOB });
  if (deps.bridge.hasMirrorTarget(target)) return target;
  const pick = pickTier(deps.cfg, deps.cfg.wrc.channel.judge.tier, {});
  const r = await deps.bridge.newSession(target, "judge", {
    silent: true,
    ...(pick.ok && pick.model ? { model: pick.model } : {}),
    ...(pick.ok && pick.effort ? { effort: pick.effort } : {}),
  });
  if (!r.ok) {
    deps.log.warn({ reason: r.reason, topicId }, "channel judge spawn failed");
    return undefined;
  }
  return target;
};

const askJudge = async (deps: JudgeDeps, target: string, prompt: string): Promise<Verdict | undefined> => {
  const mirror = deps.bridge.status().mirrors.find((m) => m.target === target);
  if (!mirror) return undefined;
  const before = talkTurns(mirror.jsonlPath, 40).filter((t) => t.role === "assistant").length;
  const injected = await deps.bridge.injectText(target, prompt, { channel: "" });
  if (!injected.ok) {
    deps.log.warn({ reason: injected.reason, target }, "channel judge inject failed");
    return undefined;
  }
  const deadline = Date.now() + deps.cfg.wrc.channel.judge.timeoutMs;
  let last = "";
  let stable = 0;
  while (Date.now() < deadline) {
    await sleep(JUDGE_POLL_MS);
    const turns = talkTurns(mirror.jsonlPath, 40);
    if (turns.filter((t) => t.role === "assistant").length <= before) continue;
    const text = lastAssistantText(mirror.jsonlPath, 4000);
    if (!text) continue;
    if (text === last) stable += 1;
    else { last = text; stable = 0; }
    if (stable >= 2) return parseVerdict(text);
  }
  deps.log.warn({ target, timeoutMs: deps.cfg.wrc.channel.judge.timeoutMs }, "channel judge timeout");
  return undefined;
};

const botName = (cfg: Config): string => cfg.wrc.botNames.find(Boolean) ?? "wezard";

const buildJudgePrompt = (cfg: Config, topicId: string, recent: any[], latest: string, latestAuthor: string): string => {
  const base = `chat:${topicId}`;
  const me = botName(cfg);
  const job = wizardStore()?.get(base)?.description ?? "这个频道的助手";
  const others = (wizardStore()?.all() ?? [])
    .filter((w) => baseOfKey(w.target) === base && w.target !== base && w.target !== judgeTarget(topicId))
    .map((w) => `${w.name || w.target}${w.description ? `（${w.description}）` : ""}`)
    .slice(0, 12);
  const lines = recent.map((p, i) => {
    const c = p?.creator ?? {};
    const who = c.type === 1 ? `bot:${String(c.aibotid ?? "?").slice(0, 10)}` : String(c.userid ?? "user");
    return `[${i + 1}] ${who}: ${clip(cleanContent(p?.content))}`;
  });
  return [
    `你是 ${me} 的频道判官。只判断最新一条消息是否应该由 ${me} 回应。`,
    `你的职责：${job}`,
    others.length ? `频道里其他机器人：${others.join("、")}` : "",
    "最近的频道消息（旧→新）：",
    ...lines,
    `最新消息（${latestAuthor}）：${clip(latest, 600)}`,
    "",
    "规则：",
    "- 最新消息 @ 了别的机器人、明显属于别人的职责、或只是闲聊 → respond=false",
    "- 最新消息在向本频道求助、需要你回答 → respond=true",
    "- 拿不准也 respond=false；不要重复别人已经回答的内容",
    '只输出一行 JSON：{"respond":true|false,"reason":"一句话"}',
    "不要调用工具，不要回答用户。",
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
    return postId
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
    return sendReply(ctx, content);
  };
};

export const installChannelEvents = (client: WSClient, cfg: Config, log: Logger, bridge: MirrorBridge): void => {
  const wsm = (client as any).wsManager;
  if (!wsm || typeof wsm.handleFrame !== "function") {
    log.warn("channel: wsManager.handleFrame unavailable; topic events will be ignored");
    return;
  }

  const dispatch = (topicId: string, postId: string, msgid: string, fromUser: string, text: string, at: number): void => {
    if (dispatched.has(postId)) return;
    dispatched.add(postId);
    if (dispatched.size > 3000) dispatched.delete(dispatched.values().next().value!);
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

  const judgeAndMaybe = async (topicId: string, postId: string, msgid: string, fromUser: string, text: string, at: number, selfBot: string): Promise<void> => {
    if (!cfg.wrc.channel.judge.enabled) return;
    if (dispatched.has(postId)) return;
    const post = await fetchPost(client, topicId, postId, log);
    const ms = mentions(post);
    if (ms.some((m) => m.type === 1 && m.bot === selfBot)) return; // direct @ path handles it
    if (ms.some((m) => m.type === 1 && m.bot && m.bot !== selfBot)) return; // addressed to another bot
    const recent = await fetchRecent(client, topicId, cfg.wrc.channel.judge.maxPosts, log);
    const prompt = buildJudgePrompt(cfg, topicId, recent, text, fromUser);
    const target = judgeTarget(topicId);
    // 判官的出生也串行：两条消息同时到不能各 spawn 一个 judge（后者会杀掉前者）。
    const verdict = await serial(target, async () => {
      const ready = await ensureJudge({ cfg, log, bridge }, topicId);
      return ready ? askJudge({ cfg, log, bridge }, ready, prompt) : undefined;
    });
    if (!verdict?.respond) {
      log.info({ topicId, postId, reason: verdict?.reason ?? "timeout/invalid" }, "channel judge: no");
      return;
    }
    log.info({ topicId, postId, reason: verdict.reason }, "channel judge: yes");
    dispatch(topicId, postId, msgid, fromUser, text, at);
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
      const text = cleanContent(reply?.content ?? post?.content) || "（在频道里 @ 了你，没有正文）";
      dispatch(topicId, postId, msgid, asker, text, at);
      return;
    }

    if (ev.eventtype === "topic_event" && Number(ev.topic_event?.type ?? 0) === 1) {
      const postId = String(ev.topic_event?.post_id ?? "");
      const msgid = String(body.msgid ?? postId);
      if (!postId || !msgid) return;
      if (seen.has(msgid) || dispatched.has(postId)) return;
      if (!asker) return; // bot-authored post (from.aibotid) — don't loop
      seen.add(msgid);
      if (seen.size > 3000) seen.delete(seen.values().next().value!);
      const post = await fetchPost(client, topicId, postId, log);
      const text = cleanContent(post?.content);
      if (!text) return;
      void judgeAndMaybe(topicId, postId, msgid, asker, text, at, selfBot)
        .catch((e: Error) => log.warn({ err: e.message, topicId, postId }, "channel judge failed"));
      return;
    }

    if (ev.eventtype === "topic_reply_event" && Number(ev.topic_reply_event?.type ?? 0) === 1) {
      const postId = String(ev.topic_reply_event?.post_id ?? "");
      const replyId = String(ev.topic_reply_event?.reply_id ?? "");
      const msgid = String(body.msgid ?? replyId);
      if (!postId || !replyId || !msgid) return;
      if (seen.has(replyId) || dispatched.has(replyId) || !asker) return;
      seen.add(replyId);
      if (seen.size > 3000) seen.delete(seen.values().next().value!);
      const reply = await fetchReply(client, topicId, postId, replyId, log);
      const text = cleanContent(reply?.content);
      if (!text) return;
      void judgeAndMaybe(topicId, postId, msgid, asker, text, at, selfBot)
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
export const installChannelBridge = (client: WSClient, cfg: Config, log: Logger, bridge: MirrorBridge): void => {
  installChannelTransport(client, log);
  installChannelEvents(client, cfg, log, bridge);
};
