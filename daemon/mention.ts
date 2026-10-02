// 需要人回一句时, 在正文之外**另补一条**短提醒。
//
// 为什么另补一条: 一长段方案进了聊天, 末尾的「需要你定」很容易被划过去; 一条单独、短、
// 只写那一句问题的消息, 在单聊里就是一次新消息提醒。为什么不 @: aibot 长连接的
// aibot_send_msg 只收 markdown / template_card / 媒体, 没有任何 @ 机制 —— `text` +
// `mentioned_list` 实测回 errcode 40008 (invalid message type), markdown 里的 `<@userid>`
// 在单聊和群里都原样显示成一串字 (实测), 那是 webhook 群机器人的写法。
import type { WSClient } from "@wecom/aibot-node-sdk";
import type { Logger } from "pino";

/** 终句里约定的收口行: `ASK: 一句话问人`。只认最后一个, 与 RESULT / NEED 同一写法。 */
const ASK_RE = /^\s*ASK\s*[:：]\s*(.+?)\s*$/gm;
export const askLineOf = (body: string): string | undefined =>
  [...body.matchAll(ASK_RE)].map((m) => m[1]!).filter(Boolean).at(-1);

// SDK 的回执失败 reject 的是回执帧 ({errcode, errmsg}) 而不是 Error —— 只读 .message 会把拒收原因记成 undefined。
export const errText = (e: unknown): string => {
  const f = e as { message?: string; errcode?: number; errmsg?: string };
  return f?.message ?? (f?.errcode !== undefined ? `errcode=${f.errcode} ${f.errmsg ?? ""}`.trim() : String(e));
};

/** 往 `channel` (principal, 可带 #slot) 补一条「等你回复」的提醒。who = 发话 wizard 的称呼 (`.name`)。 */
export const sendAsk = async (client: WSClient, log: Logger, channel: string, who: string, ask: string): Promise<void> => {
  const chatId = channel.replace(/^(user|chat|group):/, "").replace(/#.*$/, "");
  try {
    await client.sendMessage(chatId, { msgtype: "markdown", markdown: { content: `🔔 ${who} 等你回复: ${ask}` } });
    log.info({ chatId, who }, "ask pushed");
  } catch (e) {
    log.warn({ chatId, who, err: errText(e) }, "ask push failed");
  }
};
