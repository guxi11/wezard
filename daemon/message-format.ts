import type { Config } from "../shared/config.js";
import { withMessageFooter } from "../shared/message-footer.js";
import { baseOfKey, headed, isWxChat, ownHead } from "../shared/session-label.js";
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
  if (!target || isWxChat(target)) return undefined;
  return { url: urlOf(target), principal: target };
};

/** 一条绑定 room 的消息交给传输时的正文: 作者身份头在这里写, 尾部 rolepage 链接
 *  由 tracker 的 withMessageFooter 补 —— 它认作者只认这个头 (无头的正文不算任何人的,
 *  原样放过)。所以覆盖占位气泡跟发新气泡一样必须先带头, 否则那条气泡既没身份也没链接。
 *  daemon 行 (无作者) 补 "[wezard] " 头; 正文自己已带 (系统行 / 撤回 / 离开…) 就不再叠一层。 */
export const roomBubble = (author: string | undefined, body: string): string =>
  (author ? headed(ownHead(author), body, "\n\n") : /^\[wezard\]/.test(body) ? body : "[wezard] " + body);

/** 频道 / 帖子的出站正文收尾: send_post / send_reply 是直连通道, 不经 SDK tracker 的
 *  withMessageFooter —— 在这里补同一道署名改写 (裸署名头 + 尾部 ✦ 链接), 频道与群气泡才是
 *  同一套 link 渲染 (否则频道是「头带链接、尾不带」, 群里是「头裸、尾带」)。 */
export const withBubbleFooter = (content: string, principal: string): string =>
  withMessageFooter(content, { principal });

/** 点名了谁就在正文头写 `→ .a, .b`: 群里的人光看气泡分不出这句是对哪个 wizard 说的。
 *  写在正文而不是作者头里 —— 尾部改写 (withMessageFooter) 会把作者头剥掉重写, 头里的收话人活不过那一层。 */
export const addressed = (names: readonly string[], body: string): string =>
  (names.length && body ? `→ ${names.join(", ")} ${body}` : body);

/** A footer is routing metadata only when it belongs to this daemon's rolepage. */
export const footerTarget = (raw: string, root: string, known: (target: string) => boolean): string | undefined => {
  try {
    const url = new URL(raw);
    const expected = new URL(root);
    if (url.origin !== expected.origin || url.pathname !== `${expected.pathname.replace(/\/$/, "")}/role`) return;
    const id = url.searchParams.get("id");
    if (!id) return;
    const target = url.searchParams.get("role");
    return target && known(target) ? target : undefined;
  } catch { return; }
};
