// 多机器人分流层: 一个 daemon 同时持有几条企微长连接, 对其余模块只露一个 WSClient —— 主机器人那条。
// 与 weixin-port 同一条缝: 原地包装主 client 的方法, 不另起「通道」抽象, mirror / approval / ask /
// inbound 一行都不用知道有几个机器人:
//   入站 — 副机器人收到的消息 / 事件帧原样转 emit 到主 client 上, 转之前记下「这一帧 (及其 body)
//          是谁收的」(botTagOf); inbound 据此给聊天 principal 挂 `~<id>` (session-label), 于是副机器人
//          的聊天、会话、wizard 天然与主机器人的分开。被踢下线事件不转 —— 那是那条连接自己的事。
//   出站 — 带帧的 (被动回复、改卡) 按帧找回收到它的那条连接: 改卡只能用推卡那个机器人发, 且要在
//          点击 5s 内 (approval 在事件回调里同步改, 这里只是查表, 不拖时间);
//          带 chatid 的 (主动推送) 看 chatid 上的 `~<id>`: 有就剥掉、走那个机器人, 没有走主机器人。
//          chatid 从会话 key 剥出来, 所以 wizard 永远以它出生那个聊天的机器人身份说话。
//   不带 chatid 也不带帧的 (uploadMedia) 由调用方经 reach.connFor 先挑连接。
// 只配了一个机器人时什么都不包、不落盘, 原样就是 startWs —— 单机器人部署升级后行为不变。
// 降级: 多机器人时任一条认证失败只把它标成 failed, 不 exit; 全部失败才等同单机器人的 fatal。
import { WSAuthFailureError, type WSClient } from "@wecom/aibot-node-sdk";
import type { Logger } from "pino";
import { PRIMARY_BOT, type Config } from "../shared/config.js";
import { splitBot } from "../shared/session-label.js";
import { bindChatConn } from "./reach.js";
import { startWs, type DaemonWs } from "./ws.js";

export interface BotSpec {
  id: string;
  botId: string;
  secret: string;
  websocketUrl: string;
  allowFrom: string[];
  defaultChat: string;
  approvers: string[];
}

export type BotState = "connecting" | "up" | "down" | "kicked" | "failed";
export interface BotStatus { id: string; botId: string; connected: boolean; state: BotState; err?: string }

export interface BotMux extends DaemonWs {
  /** 每个机器人此刻的连接状态 (/status 用)。 */
  bots: () => BotStatus[];
}

/** 主机器人 = `bot` 节 (自己的名单为空: 全局那份就是它的); 其后是 `bots`。 */
export const botSpecs = (cfg: Config): BotSpec[] => [
  { id: PRIMARY_BOT, ...cfg.bot, allowFrom: [], defaultChat: "", approvers: [] },
  ...cfg.bots,
];

// ── 纯函数: 帧 / 聊天 → 键 ──
interface FrameLike { headers?: { req_id?: unknown }; body?: { chattype?: string; chatid?: string; from?: { userid?: string }; event?: { eventtype?: string } } }
const reqOf = (frame: unknown): string => {
  const r = (frame as FrameLike | undefined)?.headers?.req_id;
  return typeof r === "string" ? r : "";
};
// 被踢下线 (具名事件, 或通用 `event` 里那一帧) 一律不转: 主 client 上挂着 ws.ts 的「被踢就断开」,
// 转过去会把主机器人一起断掉。
const KICKED = "disconnected_event";
const forwards = (ev: string, frame: unknown): boolean =>
  (ev.startsWith("message") || ev.startsWith("event"))
  && ev !== `event.${KICKED}`
  && (frame as FrameLike | undefined)?.body?.event?.eventtype !== KICKED;

const FRAME_ROUTED = [
  "reply", "replyStream", "replyStreamNonBlocking", "replyStreamWithCard", "replyTemplateCard",
  "updateTemplateCard", "replyWelcome", "replyMedia", "hasPendingReplyAck",
] as const;
const CHAT_ROUTED = ["sendMessage", "sendMediaMessage"] as const;
type Loose = Record<string, (...a: unknown[]) => unknown>;
type LooseEmit = (event: string, ...a: unknown[]) => boolean;

// 被动回复的帧多半就是入站那个对象 (WeakMap 命中); 按 req_id 重建的 `{headers}` 走这张有界表。
const REQ_CAP = 20_000;

// 帧与它的 body 各记一笔: inbound 手里多半只有 body (msg)。进程里只有一个 mux, 模块级即可。
const tags = new WeakMap<object, string>();
/** 这一帧 / 这条消息是哪个副机器人收到的: "" = 主机器人 (或单机器人、或认不出)。 */
export const botTagOf = (o: unknown): string => (o && typeof o === "object" ? tags.get(o) ?? "" : "");
/** Restore the frozen transport identity of a durable frame after JSON/restart. */
export const pinFrameBot = (frame: object, bot: string): void => {
  tags.set(frame, bot || PRIMARY_BOT);
};

/** `connect` 只为能拿假连接验证分流而可换; daemon 里永远是 startWs。 */
export const startMux = (cfg: Config, log: Logger, connect: typeof startWs = startWs): BotMux => {
  const specs = botSpecs(cfg);
  const multi = specs.length > 1;
  const conns = specs.map((spec) => ({ spec, ws: connect(spec, multi ? log.child({ bot: spec.id }) : log) }));
  const [main, ...rest] = conns as [typeof conns[0], ...typeof conns];

  const health = new Map<string, { state: BotState; err?: string }>(specs.map((s) => [s.id, { state: "connecting" }]));
  conns.forEach(({ spec, ws }) => {
    const mark = (state: BotState, err?: string): void => void health.set(spec.id, { state, ...(err ? { err } : {}) });
    ws.client.on("authenticated", () => mark("up"));
    ws.client.on("disconnected", () => health.get(spec.id)?.state !== "kicked" && mark("down"));
    ws.client.on("reconnecting", () => mark("connecting"));
    ws.client.on("event.disconnected_event", () => mark("kicked"));
    // 认证在就绪之后才失败 (secret 被重置) 时 ready 早已 resolve, 只能从 error 上看见。
    ws.client.on("error", (e) => e instanceof WSAuthFailureError && mark("failed", e.message));
    ws.ready.catch((e: Error) => {
      mark("failed", e.message);
      if (multi) log.error({ bot: spec.id, botId: spec.botId, err: e.message }, "bot degraded — other bots keep running");
    });
  });
  const bots = (): BotStatus[] => conns.map(({ spec, ws }) => ({ id: spec.id, botId: spec.botId, connected: ws.client.isConnected, ...health.get(spec.id)! }));

  if (!multi) return { ...main.ws, bots };

  const face = main.ws.client;
  const byId = new Map(conns.map((c) => [c.spec.id, c]));

  // ── 帧归属 ──
  const byReq = new Map<string, string>();
  const note = (frame: unknown, id: string): void => {
    const f = frame as FrameLike | undefined;
    if (f && typeof f === "object") tags.set(f, id);
    if (f?.body && typeof f.body === "object") tags.set(f.body, id);
    const r = reqOf(frame);
    if (!r) return;
    byReq.delete(r);
    byReq.set(r, id);
    if (byReq.size > REQ_CAP) byReq.delete(byReq.keys().next().value!);
  };
  const botIdOfFrame = (frame: unknown): string => botTagOf(frame) || (byReq.get(reqOf(frame)) ?? PRIMARY_BOT);

  const clientOf = (id: string): WSClient => byId.get(id)!.ws.client;

  /** `X~b2` → b2 那条连接 + 裸 `X`; 无后缀 → 主机器人; 后缀指向没配的机器人 → 抛错 (不冒名从主机器人发)。 */
  const route = (chat: string): { client: WSClient; chat: string } => {
    const { id, bot } = splitBot(chat);
    if (!bot) return { client: face, chat };
    const c = byId.get(bot);
    if (!c) throw new Error(`机器人 ${bot} 没配 (bots[]), 发不到 ${chat}`);
    return { client: c.ws.client, chat: id };
  };

  // ── 出站改道: 归主机器人的走原方法, 其余交给那条连接自己的 (未包装的) 同名方法 ──
  const own = face as unknown as Loose;
  const reroute = (pick: (first: unknown) => { client: WSClient; first: unknown }) => (k: string): void => {
    const mine = own[k]!.bind(face);
    own[k] = (first0, ...a) => {
      // 调用方都是 `.catch` / try-await 接错: 选不出连接也得是一个 rejected promise, 不能同步抛。
      let picked: { client: WSClient; first: unknown };
      try { picked = pick(first0); } catch (e) { return Promise.reject(e); }
      const { client, first } = picked;
      return client === face ? mine(first, ...a) : (client as unknown as Loose)[k]!(first, ...a);
    };
  };
  FRAME_ROUTED.forEach(reroute((frame) => ({ client: clientOf(botIdOfFrame(frame)), first: frame })));
  CHAT_ROUTED.forEach(reroute((chat0) => {
    const { client, chat } = route(String(chat0 ?? ""));
    return { client, first: chat };
  }));
  bindChatConn((c) => {
    try { return route(c).client; } catch { return undefined; }
  });

  // ── 入站汇流 ──
  const faceEmit = (face as unknown as { emit: LooseEmit }).emit.bind(face);
  rest.forEach(({ spec, ws }) => {
    const c = ws.client as unknown as { emit: LooseEmit };
    const emit = c.emit.bind(c);
    c.emit = (ev, ...a) => {
      const hit = emit(ev, ...a);
      if (!forwards(ev, a[0])) return hit;
      note(a[0], spec.id);
      return faceEmit(ev, ...a) || hit;
    };
  });

  log.info({ bots: specs.map((s) => ({ id: s.id, botId: s.botId })) }, "multi-bot mux up");

  return {
    client: face,
    // 任一条连上就算就绪; 全部失败才 reject (等同单机器人的 fatal)。
    ready: Promise.any(conns.map((c) => c.ws.ready)).catch(() => {
      throw new Error(`all ${conns.length} bots failed: ${bots().map((b) => `${b.id}=${b.err ?? b.state}`).join(", ")}`);
    }),
    // 被踢下线的那条不重连: 另一处 (别的 daemon) 正用着这个机器人, 抢回来只会互踢。
    reconnect: (reason) => conns.filter((c) => health.get(c.spec.id)?.state !== "kicked").forEach((c) => c.ws.reconnect(reason)),
    shutdown: async () => void (await Promise.allSettled(conns.map((c) => c.ws.shutdown()))),
    // 对外只露主机器人那条 (与 face 同一口径); 各机器人的细分在 bots()。
    status: () => main.ws.status(),
    bots,
  };
};
