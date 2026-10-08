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
    try {
      // Callers pass the daemon-internal target key verbatim (`user:xxx#foo`) —
      // keep the `#tag` visual on the content before stripping it off the id,
      // so CLI/MCP pushes match mirror bubbles from the same session.
      await client.sendMessage(stripPrefix(chat), {
        msgtype: "markdown",
        markdown: { content: withTagHeader(chat, content) },
      });
      log.info({ chat, len: content.length }, "tx markdown");
      json(res, 200, { ok: true });
    } catch (e) {
      log.error({ err: (e as Error).message }, "send failed");
      json(res, 502, { ok: false, error: (e as Error).message });
    }
  };
};
