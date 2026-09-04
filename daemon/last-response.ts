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
import { parseTagHeader } from "../shared/session-label.js";

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
  if (body.chattype === "group" && body.chatid) return body.chatid;
  if (body.from?.userid) return body.from.userid;
  return "";
};

const lastByBareId = new Map<string, string>();

export const getLastResponse = (target: string): string | undefined =>
  lastByBareId.get(principalToBare(target));

const record = (bareId: string, content: string): void => {
  if (!bareId || !content) return;
  lastByBareId.set(bareId, content);
};

// ── 空消息门控 (最后一道防线) ─────────────────────────────────────────────
// 任何通道都不下发"正文为空"的消息。空 = 剥掉可路由头 (`🦊 #tag …` /
// `[🧙 #tag](url) 2/5 …`) 后没有任何可见内容 —— WeCom 把这种气泡渲染成一行
// 光秃秃的 tag, 正是 "#dev 标题在、正文是空的" 那类事故形态。挂在 tracker 的
// 同一个 SDK 包装层: 单一缝, sendMessage / replyStream / replyStreamWithCard
// 全覆盖, 上游新增调用点自动受保护, 不依赖每个 caller 自觉。
// 两条豁免:
//   • finish≠true 的流式中间帧 —— 打字机更新 ("…" ack / CoT 进度) 本来就可能
//     暂时只有头, 下一帧会覆盖;
//   • 附带 templateCard 的 finish —— 卡片才是载荷, 文本只是搭车, 丢卡片会
//     卡死审批流。
const hasVisibleBody = (content: string): boolean => parseTagHeader(content).body.length > 0;

// Wrap replyStream + replyStreamWithCard (live stream finalize) AND
// sendMessage (markdown standalone push) so EVERY user-visible bubble lands
// in the tracker. Mutates the client in place; call once at daemon startup.
export const installResponseTracker = (client: WSClient, log?: Logger): void => {
  const origReplyStream = client.replyStream.bind(client);
  const origReplyStreamWithCard = client.replyStreamWithCard.bind(client);
  const origSendMessage = client.sendMessage.bind(client);

  const gate = (channel: string, content: string): boolean => {
    if (hasVisibleBody(content)) return true;
    log?.warn({ channel, len: content.length }, "chat-gate: dropped empty push (no visible body)");
    return false;
  };

  client.replyStream = async (frame, streamId, content, finish, msgItem, feedback) => {
    if (finish === true && !gate("replyStream", content)) {
      return undefined as unknown as WsFrame;
    }
    const r = await origReplyStream(frame, streamId, content, finish, msgItem, feedback);
    if (finish) record(bareFromFrame(frame as WsFrame<BaseMessage>), content);
    return r;
  };

  client.replyStreamWithCard = async (frame, streamId, content, finish, options) => {
    if (finish === true && !options?.templateCard && !gate("replyStreamWithCard", content)) {
      return undefined as unknown as WsFrame;
    }
    const r = await origReplyStreamWithCard(frame, streamId, content, finish, options);
    if (finish) record(bareFromFrame(frame as WsFrame<BaseMessage>), content);
    return r;
  };

  client.sendMessage = async (chatid, body) => {
    // Only markdown pushes carry quotable text (and are the empty-message
    // risk class); template_card / media bubbles pass through untouched.
    if ((body as { msgtype?: string }).msgtype === "markdown") {
      const md = (body as { markdown?: { content?: string } }).markdown?.content ?? "";
      if (!gate("sendMessage", md)) return undefined as unknown as WsFrame;
      const r = await origSendMessage(chatid, body);
      record(chatid, md);
      return r;
    }
    return origSendMessage(chatid, body);
  };
};
