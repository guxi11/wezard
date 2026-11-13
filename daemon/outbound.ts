// Outbound message handler for /message endpoint (used by `wezard send` & MCP).
import type { WSClient } from "@wecom/aibot-node-sdk";
import type { Logger } from "pino";
import type { Handler } from "./http.js";
import { json, readBody } from "./http.js";
import { reachable } from "./reach.js";
import { withTagHeader } from "../shared/session-label.js";

// Strip principal prefix (`user:` / `chat:`) AND `#tag` suffix so callers
// can pass daemon-internal target keys (`user:xxx#foo`) verbatim; the WeCom
// SDK only accepts bare chatid/userid.
const stripPrefix = (s: string): string => {
  const i = s.indexOf(":");
  const rest = i >= 0 ? s.slice(i + 1) : s;
  const h = rest.indexOf("#");
  return h >= 0 ? rest.slice(0, h) : rest;
};

interface MsgReq {
  chat: string;
  text?: string;
  markdown?: string;
}

/** 「这一句话怎么进群」的唯一出口 (v3 §7 出站接缝): 给定会话 target (可带 #tag) 与
 *  正文, 加上气泡头交给人。现在走企微 markdown 直发; 将来「群聊严格治理」切显式工具
 *  出站 (chat_say / chat_reply) 时, 只改这一处 —— 所有进群路径 (wezard send / MCP 推送 /
 *  定时任务预告 / 学徒入群) 都必须经过这里, 不许各自直呼 client.sendMessage。 */
export const deliverToChat = async (
  client: WSClient,
  chatKey: string,
  content: string,
  log?: Logger,
): Promise<boolean> => {
  try {
    await client.sendMessage(stripPrefix(chatKey), {
      msgtype: "markdown",
      markdown: { content: withTagHeader(chatKey, content) },
    });
    return true;
  } catch (e) {
    log?.error({ err: (e as Error).message, chatKey }, "deliverToChat failed");
    return false;
  }
};

export const makeMessageHandler = (client: WSClient, log: Logger): Handler => {
  return async (req, res) => {
    const body = (await readBody(req)) as Partial<MsgReq>;
    const chat = body.chat ?? "";
    const content = body.markdown ?? body.text ?? "";
    if (!chat || !content) {
      json(res, 400, { ok: false, error: "missing chat or text" });
      return;
    }
    if (!reachable(client, chat)) {
      json(res, 503, { ok: false, error: "ws_disconnected" });
      return;
    }
    // 进群出站走唯一接缝 deliverToChat (§7); 接缝内部负责 #tag 头与 chatid 剥前缀。
    if (await deliverToChat(client, chat, content, log)) {
      log.info({ chat, len: content.length }, "tx markdown");
      json(res, 200, { ok: true });
    } else {
      json(res, 502, { ok: false, error: "send failed" });
    }
  };
};
