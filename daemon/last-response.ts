// Track the last response wezard emitted to each chat target, so the inbound
// router can suppress redundant `quote` blocks when the user replies to our
// most recent message. We treat the FINAL bubble (`finish=true` of a stream)
// AND any markdown sendMessage push as "the response" — because the standalone
// rendering path (post tool→text split, /pwd/ack, /id replies, etc.) skips the
// stream and goes straight through `client.sendMessage`. If we only watched
// replyStream we'd miss exactly the case where the user is most likely to
// quote (the final text bubble of a tool-heavy turn).
//
// Implemented as a one-shot SDK-level wrap rather than threading a tracker
// through every call site (~30+) — single seam, every reply path covered.
//
// In-memory only by design: a `wezard reload` clears the map; the next
// inbound after reload will miss dedup once. Acceptable in production (rare
// reloads); in dev just avoid reloading mid-conversation when testing.
import type { WSClient, WsFrame, BaseMessage, WsFrameHeaders } from "@wecom/aibot-node-sdk";
import type { Logger } from "pino";
import { rawTagHeader, parseTagHeader, resolveTagTarget, targetOfTagUrl, withBot, botOfKey } from "../shared/session-label.js";
import { chatPrincipalOf } from "./chat-records.js";
import { PRIMARY_BOT } from "../shared/config.js";
import { botTagOf, pinFrameBot } from "./bot-mux.js";
import { connFor } from "./reach.js";
import { withMessageFooter, withoutMessageFooter, type MessageFooterPolicy } from "../shared/message-footer.js";

export interface ResponseFormatContext {
  /** SDK bare id including the ~bot suffix. Empty for header-only frames. */
  chatid: string;
  frame?: WsFrameHeaders;
  body?: unknown;
}
export type ResponseFormatPolicy = (context: ResponseFormatContext) => MessageFooterPolicy | undefined;

// Strip `chat:` / `user:` prefix to get the bare chatid/userid that
// `sendMessage` takes. Chat ids and user ids don't collide in practice (group
// chatids start with `wr…`, userids are short alphanumeric) so we can safely
// key the tracker by the bare id and use the same lookup from inbound.
const stripPrefix = (s: string): string => {
  const i = s.indexOf(":");
  return i >= 0 ? s.slice(i + 1) : s;
};

const principalToBare = (principal: string): string => stripPrefix(principal);

const bareFromFrame = (frame: WsFrame<BaseMessage> | WsFrameHeaders | undefined): string => {
  // Wrapped SDK calls receive the full inbound frame (with body); plain header
  // frames have no chat context and we just skip recording.
  const body = (frame as WsFrame<BaseMessage> | undefined)?.body;
  if (!body) return "";
  // 副机器人收到的帧, 聊天键带 `~<bot>` —— 与会话 key 剥出来的 chatid (sendMessage 那一路) 对齐。
  const bot = [botTagOf(frame), botTagOf(body)].find((tag) => tag && tag !== PRIMARY_BOT) ?? "";
  if (body.chattype === "group" && body.chatid) return withBot(body.chatid, bot);
  if (body.from?.userid) return withBot(body.from.userid, bot);
  return "";
};

const lastByBareId = new Map<string, string>();

// SDK 的回执失败 reject 的是回执帧 ({errcode, errmsg}) 而不是 Error —— 只读 .message 会把拒收原因记成 undefined。
export const errText = (e: unknown): string => {
  const f = e as { message?: string; errcode?: number; errmsg?: string };
  return f?.message ?? (f?.errcode !== undefined ? `errcode=${f.errcode} ${f.errmsg ?? ""}`.trim() : String(e));
};

export const getLastResponse = (target: string): string | undefined =>
  lastByBareId.get(principalToBare(target));

const record = (bareId: string, content: string): void => {
  if (!bareId || !content) return;
  lastByBareId.set(bareId, content);
};

// ── 空消息门控 (最后一道防线) ─────────────────────────────────────────────
// 任何通道都不下发"正文为空"的消息。空 = 剥掉当前可路由头 (`.name: …` / signed or linked `.name`, optionally `2/5`)
// 后没有任何可见内容 —— WeCom 把这种气泡渲染成一行
// 光秃秃的 tag, 正是 "#dev 标题在、正文是空的" 那类事故形态。挂在 tracker 的
// 同一个 SDK 包装层: 单一缝, sendMessage / replyStream / replyStreamWithCard
// 全覆盖, 上游新增调用点自动受保护, 不依赖每个 caller 自觉。
// 两条豁免:
//   • finish≠true 的流式中间帧 —— 打字机更新 ("…" ack / CoT 进度) 本来就可能
//     暂时只有头, 下一帧会覆盖;
//   • 附带 templateCard 的 finish —— 卡片才是载荷, 文本只是搭车, 丢卡片会
//     卡死审批流。
const hasVisibleBody = (content: string): boolean => {
  const clean = withoutMessageFooter(content);
  const header = rawTagHeader(clean);
  const footer = /\[✦\]\(([^\n)]*)\)\s*$/.exec(content)?.[1];
  const sender = footer && targetOfTagUrl(footer);
  const ownHeader = header && (!sender || (!header.url && resolveTagTarget(header.tag, sender) === sender));
  return (ownHeader ? header.body : clean).trim().length > 0;
};

// Wrap replyStream + replyStreamWithCard (live stream finalize) AND
// sendMessage (markdown standalone push) so EVERY user-visible bubble lands
// in the tracker. Mutates the client in place; call once at daemon startup.
// `ownTransport(chatid)`: 这个 chat 的出站不走企微长连接 (微信) —— 不必等 WS 连上。
// 通道分流层装在这里面 (内层), 所以 gate / record 照样覆盖它。
export interface OutboundNote {
  /** 稳定聊天键 (base principal)。 */
  chat: string;
  /** 流 id / 终句合成 id; 空串 = 由记录侧分配。 */
  id: string;
  kind: "wizard" | "system";
  /** wizard = 裸名; system = "wezard" / ""。 */
  author: string;
  text: string;
}

/** 出站记录器 (P7-S1): 只观察 —— 挂在同一个 SDK 包装层, 不改任何出站 payload (判据①)。 */
export type OutboundRecorder = (note: OutboundNote) => void;

export const installResponseTracker = (client: WSClient, log?: Logger, ownTransport: (chatid: string) => boolean = () => false, policy?: ResponseFormatPolicy, note?: OutboundRecorder) => {
  const origReplyStream = client.replyStream.bind(client);
  const origReplyStreamWithCard = client.replyStreamWithCard.bind(client);
  const origSendMessage = client.sendMessage.bind(client);

  // P7-S1 出站记录: 终句/推送落一行到聊天账本。只读 content, 不动它。
  // 作者反解: 头认得出 = wizard 裸名; 剥头后 [wezard]/[mirror] 前缀与认不出头的 = 系统。
  const SYS_PREFIX = /^\[(wezard|mirror)\]/;
  const classify = (content: string): { kind: "wizard" | "system"; author: string; text: string } => {
    const t = content.trim();
    const h = parseTagHeader(t);
    const body = (h.fromBot ? h.body : t).trim();
    if (SYS_PREFIX.test(body)) return { kind: "system", author: "wezard", text: body };
    return h.fromBot && h.tag ? { kind: "wizard", author: h.tag, text: body } : { kind: "system", author: "", text: body };
  };
  const emit = (chatid: string, id: string, line: { kind: "wizard" | "system"; author: string; text: string }): void => {
    if (!note || !chatid) return;
    note({ chat: chatPrincipalOf(chatid), id, ...line });
  };

  const gate = (channel: string, content: string): boolean => {
    if (hasVisibleBody(content)) return true;
    log?.warn({ channel, len: content.length }, "chat-gate: dropped empty push (no visible body)");
    return false;
  };

  client.replyStream = async (frame, streamId, content, finish, msgItem, feedback) => {
    const format = policy?.({ chatid: bareFromFrame(frame), frame, body: (frame as WsFrame<BaseMessage>).body });
    content = withMessageFooter(content, format);
    if (finish === true && !gate("replyStream", content)) {
      return undefined as unknown as WsFrame;
    }
    const r = await origReplyStream(frame, streamId, content, finish, msgItem, feedback);
    const chatKey = bareFromFrame(frame as WsFrame<BaseMessage>);
    if (finish) record(chatKey, content);
    if (finish) emit(chatKey, streamId, classify(content));
    return r;
  };

  client.replyStreamWithCard = async (frame, streamId, content, finish, options) => {
    const format = policy?.({ chatid: bareFromFrame(frame), frame, body: (frame as WsFrame<BaseMessage>).body });
    content = withMessageFooter(content, format);
    if (finish === true && !options?.templateCard && !gate("replyStreamWithCard", content)) {
      return undefined as unknown as WsFrame;
    }
    const r = await origReplyStreamWithCard(frame, streamId, content, finish, options);
    const chatKey = bareFromFrame(frame as WsFrame<BaseMessage>);
    if (finish) record(chatKey, content);
    // 附卡终句: 卡片才是载荷 —— 记成卡片类系统行 (sliceBatch 剔除的那类); 无卡照常反解作者。
    if (finish) emit(chatKey, streamId, options?.templateCard
      ? { kind: "system", author: "wezard", text: `[卡片] ${options.templateCard.card_type ?? ""}` }
      : classify(content));
    return r;
  };

  // reload 窗口: 新进程恢复 mirror 后立刻有终句要推, 而 WS 还没鉴权完 —— SDK 直接抛
  // "WebSocket not connected", 那条消息就永久丢了 (近两天十几条都是这么没的)。主动推送
  // 不赶这几秒: 先等连上再发, 等不到再照常失败。
  const CONNECT_WAIT_MS = 30_000;
  // 等的是这个聊天归属的那条连接 (多机器人时不一定是主机器人)。
  const untilConnected = async (chatid: string): Promise<void> => {
    const conn = connFor(client, chatid);
    for (const t0 = Date.now(); !conn.isConnected && Date.now() - t0 < CONNECT_WAIT_MS; ) {
      await new Promise((r) => setTimeout(r, 500));
    }
  };

  client.sendMessage = async (chatid, body) => {
    if (!ownTransport(chatid)) await untilConnected(chatid);
    // Only markdown pushes carry quotable text (and are the empty-message
    // risk class); template_card / media bubbles pass through untouched.
    if (body.msgtype === "markdown") {
      const md = (body as { markdown?: { content?: string } }).markdown?.content ?? "";
      const format = policy?.({ chatid, body });
      const content = withMessageFooter(md, format);
      if (!gate("sendMessage", content)) return undefined as unknown as WsFrame;
      const r = await origSendMessage(chatid, { ...body, markdown: { ...body.markdown, content } });
      record(chatid, content);
      emit(chatid, "", classify(content));
      return r;
    }
    // P7-S1: 卡片与媒体出站也各记一行系统行 —— 账本完整 (卡片行带 [卡片] 标记, 供 sliceBatch 剔除)。
    emit(chatid, "", body.msgtype === "template_card"
      ? { kind: "system", author: "wezard", text: `[卡片] ${(body as { template_card?: { card_type?: string } }).template_card?.card_type ?? ""}` }
      : { kind: "system", author: "", text: `[媒体] ${body.msgtype}` });
    return origSendMessage(chatid, body);
  };
  return {
    freeze: (chatid: string, content: string): string => withMessageFooter(content, policy?.({ chatid })),
    sendFrozen: async (chatid: string, content: string, stream?: { frame: WsFrameHeaders; id: string }, guard?: () => boolean): Promise<WsFrame> => {
      if (!gate("durable-final", content)) throw { headers: {}, errcode: -1, errmsg: "empty final rejected before send" };
      if (!ownTransport(chatid)) {
        await untilConnected(chatid);
        if (!connFor(client, chatid).isConnected) throw { headers: {}, errcode: -1, errmsg: "disconnected before final send" };
      }
      if (guard && !guard()) throw { headers: {}, errcode: -1, errmsg: "final send stopped before transport" };
      if (stream) pinFrameBot(stream.frame, botOfKey(chatid));
      const ack = stream ? await origReplyStream(stream.frame, stream.id, content, true)
        : await origSendMessage(chatid, { msgtype: "markdown", markdown: { content } });
      record(chatid, content);
      emit(chatid, stream?.id ?? "", classify(content));
      return ack;
    },
  };
};
