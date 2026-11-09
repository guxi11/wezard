// 频道（topic）桥: SDK 1.0.7 的 dispatch 表里没有 aibot_topic_event_callback，
// 这一层在 SDK 丢掉帧之前接住它，把「频道里 @ 了机器人」翻译成一条普通的文本消息
// 交给 inbound / mirror；出站再把 topic_id 的 markdown 换成频道的 send_post /
// send_reply。群聊 / 单聊的路径完全不变。
import { generateReqId, type TextMessage, type WSClient, type WsFrame } from "@wecom/aibot-node-sdk";
import type { Logger } from "pino";

const TOPIC_EVENT = "aibot_topic_event_callback";
const CMD_POST = "aibot_topic_send_post";
const CMD_REPLY = "aibot_topic_send_reply";
const CMD_GET_POSTS = "aibot_topic_get_post_list";

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

const MENTION_RE = /\$\{inline_mention(?::[^}]*)?\}/g;
const FILE_RE = /\$\{inline_file(?::[^}]*)?\}/g;

const cleanContent = (s: unknown): string =>
  String(s ?? "").replace(MENTION_RE, "").replace(FILE_RE, "").trim();

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

const emptyFrame = (): WsFrame => ({ headers: { req_id: "" } } as WsFrame);

export const installChannelBridge = (client: WSClient, log: Logger): void => {
  const wsm = (client as any).wsManager;
  if (!wsm || typeof wsm.handleFrame !== "function") {
    log.warn("channel: wsManager.handleFrame unavailable; topic events will be ignored");
    return;
  }

  const sendPost = (topicId: string, content: string): Promise<any> =>
    call(client, CMD_POST, { topic_id: topicId, content })
      .then((body) => { const id = String(body?.post_id ?? ""); if (id) lastPost.set(topicId, id); return body; })
      .catch((e: Error) => { log.warn({ err: e.message, topicId }, "channel post failed"); return undefined; });

  const sendReply = (ctx: TopicCtx, content: string): Promise<any> =>
    call(client, CMD_REPLY, { topic_id: ctx.topicId, post_id: ctx.postId, content })
      .catch((e: Error) => { log.warn({ err: e.message, topicId: ctx.topicId }, "channel reply failed"); return undefined; });

  const onTopic = async (frame: any): Promise<void> => {
    const body = frame?.body ?? {};
    const ev = body.event ?? {};
    const topicId = String(body.topic_id ?? "");
    const from = body.from ?? {};
    const asker = String(from.userid ?? "");
    if (!topicId) return;
    topics.add(topicId);
    if (asker) lastAsker.set(topicId, asker);
    if (ev.eventtype !== "topic_at_bot") {
      log.debug({ type: ev.eventtype, topicId }, "channel event ignored");
      return;
    }
    const postId = String(ev.topic_at_bot?.post_id ?? "");
    const msgid = String(body.msgid ?? postId);
    if (!postId || !msgid) return;
    if (seen.has(msgid)) return;
    seen.add(msgid);
    if (seen.size > 2000) seen.delete(seen.values().next().value!);

    const post = await fetchPost(client, topicId, postId, log);
    if (!post) log.warn({ topicId, postId }, "channel: post content not found");
    const text = cleanContent(post?.content) || "（在频道里 @ 了你，没有正文）";
    lastPost.set(topicId, postId);
    byStream.set(msgid, { topicId, postId, asker });
    if (byStream.size > 2000) byStream.delete(byStream.keys().next().value!);

    const fake = {
      headers: frame.headers,
      body: {
        msgid,
        aibotid: body.aibotid,
        chattype: "group",
        chatid: topicId,
        from: { userid: asker },
        create_time: body.create_time,
        msgtype: "text",
        text: { content: text },
      },
    } as WsFrame<TextMessage>;
    log.info({ topicId, postId, msgid, len: text.length }, "channel rx");
    // inbound 的监听器挂在 client 上；这一帧在结构上就是一条群消息。
    client.emit("message.text", fake);
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

  // ── 出站：topic 不走群 chatid，改成频道帖子 / 评论 ──
  const origSend = client.sendMessage.bind(client);
  (client as any).sendMessage = (chatid: string, body: any): Promise<any> => {
    if (!topics.has(chatid)) return origSend(chatid, body);
    // 频道没有模板卡片按钮；审批卡改投问话人的私聊，点完结论仍回到频道。
    if (body?.msgtype === "template_card") {
      const asker = lastAsker.get(chatid);
      if (asker) {
        log.info({ topicId: chatid, asker }, "channel: card routed to asker DM");
        return origSend(asker, body);
      }
      log.warn({ topicId: chatid }, "channel: template_card dropped (no asker)");
      return Promise.resolve(emptyFrame());
    }
    const content = body?.msgtype === "markdown" ? String(body.markdown?.content ?? "") : "";
    if (!content) {
      log.warn({ topicId: chatid, msgtype: body?.msgtype }, "channel: unsupported outbound");
      return Promise.resolve(emptyFrame());
    }
    const postId = lastPost.get(chatid);
    return postId
      ? sendReply({ topicId: chatid, postId, asker: lastAsker.get(chatid) ?? "" }, content)
      : sendPost(chatid, content);
  };

  // replyStream 的气泡只对群聊有意义；频道里把最终帧落成一条评论，中间帧丢掉。
  const origStream = client.replyStream.bind(client);
  (client as any).replyStream = (frame: any, streamId: string, content: string, finish = false, ...rest: any[]): Promise<any> => {
    const ctx = byStream.get(streamId);
    if (!ctx) return origStream(frame, streamId, content, finish, ...rest);
    if (!finish) return Promise.resolve(emptyFrame());
    return sendReply(ctx, content);
  };
};
