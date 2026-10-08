// 把微信 ClawBot 接到 aibot WSClient 上的分流层 —— 原地包装, 与 last-response 的
// installResponseTracker 同一个做法。
//
// 为什么不另起「通道」抽象: 出站有几十处直接 `client.sendMessage(chatid, …)` /
// `client.replyStream(frame, …)`, 入站是 `client.on("message.text", …)`。在这一个缝上分流,
// mirror-bridge / approval / ask / tasks / inbound 一行都不用知道微信存在:
//   出站 — chatid 是已绑定的 `wx_…`, 或帧 req_id 以 `wx:` 开头 → 走微信 (markdown 降纯文本,
//          流式中间帧只亮「正在输入」, 卡片降成编号菜单); 其余原样交给 aibot。
//   入站 — 微信消息翻成 aibot 形状的帧 `client.emit(...)`; 人回菜单数字 → 合成同一个
//          `event.template_card_event`, 审批 / 提问 / 计划选择的处理器原样认。
// 装在 installResponseTracker **之后** (外层): 微信出站不该等企微长连接连上。
import type { WSClient, WsFrame, TemplateCard } from "@wecom/aibot-node-sdk";
import type { Logger } from "pino";
import { renderCard, renderAck, choicesOf, parseMenuReply, clickOf, mintCode, mdToPlain, type Choices } from "../shared/wx-text.js";
import type { Weixin, WxInbound } from "./weixin.js";

const CARD_TTL_MS = 24 * 3600_000;
const REQ = "wx:";

interface OpenCard { code: string; taskId: string; choices: Choices; cardType: string; at: number }

/** `wx:<chatId>:<n>` → chatId; 不是微信帧返回 undefined。 */
const chatOfFrame = (frame: unknown): string | undefined => {
  const id = (frame as WsFrame | undefined)?.headers?.req_id;
  return typeof id === "string" && id.startsWith(REQ) ? id.slice(REQ.length).split(":")[0] : undefined;
};
// SDK 的事件表是强类型的; 合成帧要按名字随意发, 走一个宽口。
type LooseEmit = (event: string, frame: WsFrame) => boolean;
const ack = (reqId: string): WsFrame => ({ headers: { req_id: reqId }, errcode: 0, errmsg: "ok" });

export interface WeixinPort {
  /** 当前挂着、等人回数字的卡片 (rolepage / `/wx` 列表用)。 */
  openCards: (chatId: string) => OpenCard[];
}

export const installWeixinPort = (client: WSClient, wx: Weixin, log: Logger): WeixinPort => {
  const cards = new Map<string, OpenCard[]>();
  const live = (chatId: string): OpenCard[] => {
    const now = Date.now();
    const xs = (cards.get(chatId) ?? []).filter((c) => now - c.at < CARD_TTL_MS);
    cards.set(chatId, xs);
    return xs;
  };
  let seq = 0;
  const reqId = (chatId: string): string => `${REQ}${chatId}:${Date.now().toString(36)}${(seq++).toString(36)}`;

  const isWx = (chatId: string | undefined): chatId is string => !!chatId && wx.owns(chatId);

  // ── 出站 ──
  const text = (chatId: string, md: string): void => {
    const plain = mdToPlain(md);
    if (plain) wx.send(chatId, plain);
  };
  const card = (chatId: string, c: TemplateCard): void => {
    const choices = choicesOf(c);
    const code = mintCode(new Set(live(chatId).map((x) => x.code)));
    if (choices.kind !== "none") {
      cards.set(chatId, [...live(chatId), { code, taskId: c.task_id ?? "", choices, cardType: c.card_type, at: Date.now() }]);
    }
    wx.send(chatId, renderCard(c, code), { card: true });
  };
  const body = (chatId: string, b: Record<string, unknown>): void => {
    const t = b.msgtype;
    if (t === "markdown") return text(chatId, String((b.markdown as { content?: string })?.content ?? ""));
    if (t === "template_card") return card(chatId, b.template_card as TemplateCard);
    if (t === "stream") {
      const st = b.stream as { content?: string; finish?: boolean };
      return st.finish ? (wx.typing(chatId, false), text(chatId, st.content ?? "")) : wx.typing(chatId, true);
    }
    log.warn({ chatId, msgtype: t }, "weixin port: unsupported outbound msgtype — dropped");
  };

  const orig = {
    sendMessage: client.sendMessage.bind(client),
    reply: client.reply.bind(client),
    replyStream: client.replyStream.bind(client),
    replyStreamNonBlocking: client.replyStreamNonBlocking.bind(client),
    replyStreamWithCard: client.replyStreamWithCard.bind(client),
    replyTemplateCard: client.replyTemplateCard.bind(client),
    updateTemplateCard: client.updateTemplateCard.bind(client),
    replyWelcome: client.replyWelcome.bind(client),
    replyMedia: client.replyMedia.bind(client),
    sendMediaMessage: client.sendMediaMessage.bind(client),
    hasPendingReplyAck: client.hasPendingReplyAck.bind(client),
    downloadFile: client.downloadFile.bind(client),
  };

  client.sendMessage = async (chatid, b) => (isWx(chatid) ? (body(chatid, b as unknown as Record<string, unknown>), ack(reqId(chatid))) : orig.sendMessage(chatid, b));
  client.reply = async (frame, b, cmd) => {
    const c = chatOfFrame(frame);
    return isWx(c) ? (body(c, b as Record<string, unknown>), ack(frame.headers.req_id)) : orig.reply(frame, b, cmd);
  };
  const stream = (c: string, content: string, finish?: boolean): void => {
    if (finish) { wx.typing(c, false); text(c, content); } else wx.typing(c, true);
  };
  client.replyStream = async (frame, id, content, finish, msgItem, feedback) => {
    const c = chatOfFrame(frame);
    return isWx(c) ? (stream(c, content, finish), ack(frame.headers.req_id)) : orig.replyStream(frame, id, content, finish, msgItem, feedback);
  };
  client.replyStreamNonBlocking = async (frame, id, content, finish, msgItem, feedback) => {
    const c = chatOfFrame(frame);
    return isWx(c) ? (stream(c, content, finish), ack(frame.headers.req_id)) : orig.replyStreamNonBlocking(frame, id, content, finish, msgItem, feedback);
  };
  client.replyStreamWithCard = async (frame, id, content, finish, options) => {
    const c = chatOfFrame(frame);
    if (!isWx(c)) return orig.replyStreamWithCard(frame, id, content, finish, options);
    stream(c, content, finish);
    if (options?.templateCard) card(c, options.templateCard);
    return ack(frame.headers.req_id);
  };
  client.replyTemplateCard = async (frame, c0, feedback) => {
    const c = chatOfFrame(frame);
    return isWx(c) ? (card(c, c0), ack(frame.headers.req_id)) : orig.replyTemplateCard(frame, c0, feedback);
  };
  // 点击 (数字回复) 之后的改卡 → 一行回执, 并把这张卡从待答表里摘掉。
  client.updateTemplateCard = async (frame, c0, userids) => {
    const c = chatOfFrame(frame);
    if (!isWx(c)) return orig.updateTemplateCard(frame, c0, userids);
    const open = live(c);
    const hit = open.find((x) => x.taskId && x.taskId === c0.task_id);
    if (hit) cards.set(c, open.filter((x) => x !== hit));
    wx.send(c, renderAck(c0, hit?.code ?? "卡片"), { card: true });
    return ack(frame.headers.req_id);
  };
  client.replyWelcome = async (frame, b) => (isWx(chatOfFrame(frame)) ? ack(frame.headers.req_id) : orig.replyWelcome(frame, b));
  // 媒体走 SendMedia (index.ts 按聊天分流), 不经这两个口; 走到这里说明有人绕过了它。
  client.replyMedia = async (frame, kind, mediaId, video) => {
    const c = chatOfFrame(frame);
    if (!isWx(c)) return orig.replyMedia(frame, kind, mediaId, video);
    log.warn({ chatId: c, kind }, "weixin port: replyMedia bypassed SendMedia — dropped");
    return ack(frame.headers.req_id);
  };
  client.sendMediaMessage = async (chatid, kind, mediaId, video) => {
    if (!isWx(chatid)) return orig.sendMediaMessage(chatid, kind, mediaId, video);
    log.warn({ chatId: chatid, kind }, "weixin port: sendMediaMessage bypassed SendMedia — dropped");
    return ack(reqId(chatid));
  };
  client.hasPendingReplyAck = (frame) => (isWx(chatOfFrame(frame)) ? false : orig.hasPendingReplyAck(frame));
  client.downloadFile = async (url, aesKey) => (url.startsWith("wxcdn:") ? wx.download(url) : orig.downloadFile(url, aesKey));

  // ── 入站 ──
  const frameOf = (m: WxInbound, extra: Record<string, unknown>): WsFrame => ({
    cmd: "aibot_msg_callback",
    headers: { req_id: reqId(m.chatId) },
    body: {
      msgid: m.msgId,
      aibotid: "weixin",
      chatid: m.chatId,
      chattype: "group",
      from: { userid: m.chatId },
      create_time: Math.floor(m.at / 1000),
      ...(m.quote ? { quote: { msgtype: "text", text: { content: m.quote } } } : {}),
      ...extra,
    },
  });
  const emit = (name: string, f: WsFrame): void => {
    try {
      const e = client.emit.bind(client) as unknown as LooseEmit;
      e("message", f);
      e(name, f);
    } catch (e) {
      log.error({ name, err: (e as Error).message }, "weixin port: inbound listener threw");
    }
  };

  // 人回的是菜单数字 → 合成点击; 返回 true = 已消费, 不再当普通消息派给 wizard。
  const answerCard = (m: WxInbound): boolean => {
    if (m.images.length || m.files.length) return false;
    const r = parseMenuReply(m.text);
    const open = live(m.chatId);
    if (!r || open.length === 0) return false;
    const target = r.code ? open.find((x) => x.code === r.code) : open.length === 1 ? open[0] : undefined;
    if (!target) {
      wx.send(m.chatId, r.code
        ? `短码 ${r.code} 的卡片已处理或已过期。待答: ${open.map((x) => x.code).join(" / ")}`
        : `有 ${open.length} 张待答卡 (${open.map((x) => x.code).join(" / ")}), 请带短码回, 如 "${open[0]!.code} 1"`);
      return true;
    }
    const click = clickOf(target.choices, r.picks);
    if (!click) {
      wx.send(m.chatId, `${target.code}: 选项不对, 请回菜单里的编号${target.choices.kind === "vote" && target.choices.multi ? " (可多个, 空格隔开)" : ""}`);
      return true;
    }
    // 投票卡提交后企微不改卡 —— 这里先摘; 按钮卡等 updateTemplateCard 回执时摘。
    if (target.choices.kind === "vote") cards.set(m.chatId, open.filter((x) => x !== target));
    const tce = { card_type: target.cardType, event_key: click.eventKey, task_id: target.taskId, ...(click.selected ? { selected_items: click.selected } : {}) };
    const f: WsFrame = {
      cmd: "aibot_event_callback",
      headers: { req_id: reqId(m.chatId) },
      body: {
        msgid: m.msgId, aibotid: "weixin", chatid: m.chatId, chattype: "group", from: { userid: m.chatId },
        create_time: Math.floor(m.at / 1000), msgtype: "event",
        event: { eventtype: "template_card_event", ...tce, template_card_event: tce },
      },
    };
    log.info({ chatId: m.chatId, code: target.code, eventKey: click.eventKey }, "weixin menu reply → card event");
    try {
      const e = client.emit.bind(client) as unknown as LooseEmit;
      e("event", f);
      e("event.template_card_event", f);
    } catch (e) {
      log.error({ err: (e as Error).message }, "weixin port: card listener threw");
    }
    return true;
  };

  wx.onInbound((m) => {
    if (answerCard(m)) return;
    const [file] = m.files;
    if (file) {
      emit(`message.${file.kind}`, frameOf(m, { msgtype: file.kind, [file.kind]: { url: file.ref } }));
      // 文件之外同一条里还有字 / 图: 照常再走一遍 (微信一条消息通常只有一项, 这是兜底)。
      if (!m.text && !m.images.length) return;
    }
    if (m.images.length && !m.text && m.images.length === 1) {
      emit("message.image", frameOf(m, { msgtype: "image", image: { url: m.images[0] } }));
      return;
    }
    if (m.images.length) {
      const items = [
        ...(m.text ? [{ msgtype: "text", text: { content: m.text } }] : []),
        ...m.images.map((u) => ({ msgtype: "image", image: { url: u } })),
      ];
      emit("message.mixed", frameOf(m, { msgtype: "mixed", mixed: { msg_item: items } }));
      return;
    }
    if (m.text) emit("message.text", frameOf(m, { msgtype: "text", text: { content: m.text } }));
  });

  return { openCards: (chatId) => live(chatId) };
};
