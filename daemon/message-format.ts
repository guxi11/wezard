import type { Config } from "../shared/config.js";
import { baseOfKey, isWxChat } from "../shared/session-label.js";
import { chatPolicyOf } from "./chat-name.js";
import type { ResponseFormatContext } from "./last-response.js";

/** Resolve SDK destinations using frame evidence first, preserving the bot suffix. */
export const responsePrincipal = (cfg: Config, context: ResponseFormatContext): string => {
  const { chatid } = context;
  if (!chatid) return "";
  const body = context.frame ? context.body as { chattype?: string; chatid?: string; from?: { userid?: string } } : undefined;
  if (body?.chattype === "group" && body.chatid) return `chat:${chatid}`;
  if (body?.from?.userid) return `user:${chatid}`;
  const known = [...Object.values(cfg.chats), ...Object.keys(cfg.chatPolicy), cfg.defaultChat]
    .map(baseOfKey).find((key) => key.replace(/^(?:user|chat|group|external_user):/, "") === chatid);
  return known || `${/^(?:wr|wx_)/.test(chatid) ? "chat" : "user"}:${chatid}`;
};

export const responseFormatPolicy = (cfg: Config, context: ResponseFormatContext, urlOf: (target: string) => string | undefined) => {
  const target = responsePrincipal(cfg, context);
  if (!target || isWxChat(target) || !chatPolicyOf(cfg, target).topOnly) return undefined;
  return { topOnly: true, url: urlOf(target), principal: target };
};

/** A footer is routing metadata only when it belongs to this daemon's rolepage. */
export const footerTarget = (raw: string, root: string, recordTarget: (id: string) => string | undefined, known: (target: string) => boolean): string | undefined => {
  try {
    const url = new URL(raw);
    const expected = new URL(root);
    if (url.origin !== expected.origin || !["/role", "/chat"].some((path) => url.pathname === `${expected.pathname.replace(/\/$/, "")}${path}`)) return;
    const id = url.searchParams.get("id");
    if (!id) return;
    // Stream tickets predate explicit role=; their recorded turn is authoritative.
    const target = url.searchParams.get("role") || recordTarget(id);
    return target && known(target) ? target : undefined;
  } catch { return; }
};
