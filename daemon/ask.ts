// /card and /ask endpoints — used by MCP `send_card` / `ask_user`.
import type { WSClient, TemplateCard } from "@wecom/aibot-node-sdk";
import type { Logger } from "pino";
import type { Handler } from "./http.js";
import { json, readBody } from "./http.js";
import { reachable } from "./reach.js";
import { createPending, resolvePending } from "./pending.js";
import { tagBadge } from "../shared/session-label.js";

const stripPrefix = (s: string): string => {
  const i = s.indexOf(":");
  const rest = i >= 0 ? s.slice(i + 1) : s;
  const h = rest.indexOf("#");
  return h >= 0 ? rest.slice(0, h) : rest;
};

interface CardReq {
  chat: string;
  card: TemplateCard;
}

export const makeCardHandler = (client: WSClient, log: Logger): Handler => {
  return async (req, res) => {
    const body = (await readBody(req)) as Partial<CardReq>;
    const chat = body.chat ?? "";
    const card = body.card;
    if (!chat || !card) {
      json(res, 400, { ok: false, error: "missing chat or card" });
      return;
    }
    if (!reachable(client, chat)) {
      json(res, 503, { ok: false, error: "ws_disconnected" });
      return;
    }
    try {
      await client.sendMessage(stripPrefix(chat), { msgtype: "template_card", template_card: card });
      json(res, 200, { ok: true });
    } catch (e) {
      log.error({ err: (e as Error).message }, "send card failed");
      json(res, 502, { ok: false, error: (e as Error).message });
    }
  };
};

interface AskReq {
  chat: string;
  title: string;
  detail?: string;
  options: Array<{ key: string; label: string; style?: number }>;
  timeoutSec: number;
}

const TRUNC = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

const askKey = (reqId: string, choiceKey: string): string => `ASK|${reqId}|${choiceKey}`;
export const decodeAskKey = (s: string): { reqId: string; choice: string } | undefined => {
  if (!s.startsWith("ASK|")) return undefined;
  const [, reqId, choice] = s.split("|");
  if (!reqId || !choice) return undefined;
  return { reqId, choice };
};

export const makeAskHandler = (client: WSClient, log: Logger): Handler => {
  return async (req, res) => {
    const body = (await readBody(req)) as Partial<AskReq>;
    const chat = body.chat ?? "";
    const title = body.title ?? "";
    const opts = body.options ?? [];
    const timeoutSec = body.timeoutSec ?? 600;
    if (!chat || !title || opts.length === 0) {
      json(res, 400, { ok: false, error: "missing chat / title / options" });
      return;
    }
    if (!reachable(client, chat)) {
      json(res, 503, { ok: false, error: "ws_disconnected" });
      return;
    }

    const { reqId, promise } = createPending({
      meta: { kind: "generic", createdAt: Date.now() },
      timeoutMs: timeoutSec * 1000,
    });

    const card: TemplateCard = {
      card_type: "button_interaction",
      // 与审批卡同规: 绑到 tagged 会话的卡片标题带该会话的 emoji 徽标。
      main_title: { title: TRUNC(`${tagBadge(chat)}${title}`, 26) },
      sub_title_text: body.detail ? TRUNC(body.detail, 480) : undefined,
      task_id: reqId,
      button_list: opts.map((o) => ({ text: TRUNC(o.label, 10), style: o.style ?? 1, key: askKey(reqId, o.key) })),
    };

    try {
      await client.sendMessage(stripPrefix(chat), { msgtype: "template_card", template_card: card });
    } catch (e) {
      log.error({ err: (e as Error).message }, "ask card send failed");
      resolvePending(reqId, "deny"); // free pending slot
      json(res, 502, { ok: false, error: `send: ${(e as Error).message}` });
      return;
    }

    try {
      // We piggyback on Decision union for typing; the actual click decoded via decodeAskKey
      // and resolved separately by the event listener below.
      const choice = (await promise) as unknown as string;
      json(res, 200, { ok: true, choice });
    } catch {
      json(res, 200, { ok: false, error: "timeout" });
    }
  };
};

export const installAskEventListener = (client: WSClient, log: Logger): void => {
  client.on("event.template_card_event", (frame) => {
    const key = frame.body?.event?.event_key ?? "";
    const decoded = decodeAskKey(key);
    if (!decoded) return;
    // resolvePending coerces the value through Decision union; we abuse it for ask.
    const ok = resolvePending(decoded.reqId, decoded.choice as never);
    log.info({ ...decoded, ok }, "ask event resolved");
  });
};
