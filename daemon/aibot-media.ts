// SendMedia 的企微 aibot 实现: 上传临时素材 → 主动推送 (aibot_send_msg)。
// 不走被动 replyMedia: 它要绑一条入站帧的 req_id, 而 wizard 发文件的时刻多半不在
// 人开的那一轮里 (私聊轮、回执轮、定时任务); 主动推送对任何已互动过的会话都成立。
import { readFileSync } from "node:fs";
import type { WSClient } from "@wecom/aibot-node-sdk";
import type { Logger } from "pino";
import { baseOfKey } from "../shared/session-label.js";
import { errText } from "./last-response.js";
import { planMedia, type SendMedia } from "./media.js";

// SDK 1.0.7 把每个回执的等待写死 5s (aibot-node-sdk #27), 大文件分片的回执常 6–8s 才到,
// 被误判失败、重传又被服务端拒。上传期间放宽, 最后一个上传结束时还原 —— 期间别的发送
// 也跟着宽限, 只是失败报得晚些, 无害。
const UPLOAD_ACK_MS = 30_000;
type AckKnob = { replyAckTimeout: number };
const widenAck = (client: WSClient): (() => void) => {
  const mgr = (client as unknown as { wsManager?: AckKnob }).wsManager;
  if (!mgr || typeof mgr.replyAckTimeout !== "number") return () => {};
  const st = ackState.get(mgr) ?? { n: 0, orig: mgr.replyAckTimeout };
  ackState.set(mgr, { ...st, n: st.n + 1 });
  mgr.replyAckTimeout = Math.max(st.orig, UPLOAD_ACK_MS);
  return () => {
    const cur = ackState.get(mgr)!;
    if (cur.n > 1) { ackState.set(mgr, { ...cur, n: cur.n - 1 }); return; }
    ackState.delete(mgr);
    mgr.replyAckTimeout = cur.orig;
  };
};
const ackState = new WeakMap<AckKnob, { n: number; orig: number }>();

/** `chat:wr…#slot` → `wr…`: SDK 只认裸 chatid / userid。 */
const chatIdOf = (target: string): string => baseOfKey(target).replace(/^(user|chat|group):/, "");

export const aibotSendMedia = (client: WSClient, log: Logger): SendMedia => async (target, spec) => {
  const plan = planMedia(spec);
  if (!plan.ok) return plan;
  const chatId = chatIdOf(target);
  if (!chatId) return { ok: false, reason: `认不出收件聊天: ${target}` };
  if (!client.isConnected) return { ok: false, reason: "企微长连接没连上, 稍后再试" };
  const { kind, name, bytes } = plan;
  const upload = async (): Promise<string> => {
    const restore = widenAck(client);
    try {
      return (await client.uploadMedia(readFileSync(spec.path), { type: kind, filename: name })).media_id;
    } finally {
      restore();
    }
  };
  try {
    const video = kind === "video" ? { title: spec.title, description: spec.description } : undefined;
    await client.sendMediaMessage(chatId, kind, await upload(), video);
    log.info({ chatId, kind, name, bytes }, "tx media");
    return { ok: true, kind, name, bytes };
  } catch (e) {
    log.warn({ chatId, kind, name, bytes, err: errText(e) }, "tx media failed");
    return { ok: false, reason: `企微拒收 (${kind} ${name}): ${errText(e)}` };
  }
};
