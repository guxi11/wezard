// 微信 ClawBot 通道: 账号表 + 每账号一路长轮询 + 出站账本 + 扫码绑定。
//
// 每个扫码绑定的微信用户 = 一个群聊 `chat:wx_…` (chatIdOfUser), 与企微群聊同构 ——
// 这里只管「微信那头」: 收到的消息交给 onInbound (weixin-port 把它翻成 aibot 帧), 发出去
// 的文本进账本。账本存在是因为送达约束很硬 (社区实测, 互相矛盾): 没有新鲜的 context_token
// 发不出去, 它只随人说话刷新; 一份 token 之后能发的条数有限; ~8 分钟 4 条就被频控半小时。
// 所以出站一律先进 outbox, 由 pump 按「额度 / 节流 / 暂停」决定何时合并发出; 发不出的压着,
// 人下一次开口时先取回 —— 宁可晚到, 不丢。
//
// 账号间互不牵连: 各自一条轮询链、各自的 outbox / 暂停; 一个号 -14 掉线只停它自己。
import { chmodSync, readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import type { Logger } from "pino";
import type { Config } from "../shared/config.js";
import { loadJsonMap } from "../shared/json-map-store.js";
import { expandHome } from "../shared/paths.js";
import { chatIdOfUser, chunkText, nickOf } from "../shared/wx-text.js";
import {
  ILINK_BASE, LONG_POLL_MS, STALE_TOKEN, ITEM,
  getBotQrcode, getQrcodeStatus, getUpdates, sendText, sendItems, getTypingTicket, sendTyping, notifyLifecycle,
  cdnDownloadUrl, downloadCdn, parseAesKey, MEDIA_TYPE, getUploadUrl, uploadCdn, cdnUploadUrl, encryptEcb, md5,
  type CdnMedia, type MessageItem, type WeixinMessage, type Res,
} from "./ilink.js";

// ── 数据 ─────────────────────────────────────────────────────────────
export interface OutItem { text: string; card?: boolean; at: number }
export interface WxAccount {
  botId: string;
  botToken: string;
  baseUrl: string;
  /** ilink_user_id —— 扫码者, 唯一能和这个 bot 说话的人。 */
  userId: string;
  /** 群聊 id `wx_…`; principal 是 `chat:${chatId}`。 */
  chatId: string;
  /** 发起绑定的那个人 (企微 principal / `cli`), 掉线时默认往他那儿报。 */
  boundBy: string;
  boundAt: number;
  cursor: string;
  state: "live" | "expired";
  /** 最近一份 context_token: 何时拿到、之后已发几条。 */
  ctx?: { token: string; at: number; used: number };
  outbox: OutItem[];
  lastInAt?: number;
  lastOutAt?: number;
  pausedUntil?: number;
  /** 这一段静默里是否已往企微报过「压着 N 条」—— 人一开口清零。 */
  staleNoted?: boolean;
  sent?: number;
  failed?: number;
}

/** 入站, 已归一化 —— 只有 weixin-port 关心它怎么变成 aibot 帧。 */
export interface WxInbound {
  chatId: string;
  msgId: string;
  at: number;
  text: string;
  /** `wxcdn:` 引用, 交给 download 取回明文。 */
  images: string[];
  files: Array<{ ref: string; name: string; kind: "file" | "video" }>;
  quote?: string;
}

export interface BindView {
  id: string;
  by: string;
  name: string;
  status: "qr" | "scaned" | "need_code" | "done" | "already" | "failed";
  qrUrl: string;
  refresh: number;
  message: string;
  chatId?: string;
  startedAt: number;
}

export interface WeixinDeps {
  cfg: Config;
  log: Logger;
  /** 扫码确认、账号已落库之后: 起群名、进 allowFrom、生默认 wizard。返回落定的群名。 */
  onBound: (acct: WxAccount, wantName: string, rebind: boolean) => Promise<string>;
  /** 往企微报一句 (掉线、压着消息) —— 走原生 aibot 出口, 不经过微信分流。 */
  notifyWecom: (principal: string, markdown: string) => void;
}

export interface Weixin {
  owns: (chatId: string) => boolean;
  accountOf: (chatId: string) => WxAccount | undefined;
  list: () => WxAccount[];
  send: (chatId: string, text: string, opts?: { card?: boolean }) => void;
  typing: (chatId: string, on: boolean) => void;
  download: (ref: string) => Promise<{ buffer: Buffer; filename?: string }>;
  /** 发一个文件: 先冲掉排着的文本 (顺序不乱), 再占一条额度直发; 发不出就如实回 reason, 不压 outbox (二进制不进账本)。 */
  sendMedia: (chatId: string, f: { path: string; kind: WxMediaKind; name: string }) => Promise<{ ok: true } | { ok: false; reason: string }>;
  onInbound: (fn: (m: WxInbound) => void) => void;
  startBind: (by: string, name: string, onChange: (v: BindView) => void) => { ok: true; view: BindView } | { ok: false; reason: string };
  submitCode: (by: string, code: string) => { ok: boolean; reason?: string };
  bindOf: (idOrBy: string) => BindView | undefined;
  unbind: (chatId: string) => { ok: boolean; reason?: string };
  /** 切网: 掐断在途长轮询立即重连。 */
  kick: (reason: string) => void;
  stop: () => Promise<void>;
}

export type WxMediaKind = keyof typeof MEDIA_TYPE;
/** 微信侧出站上限: 服务端未公开, 取官方插件单媒体缓存上限。 */
export const WX_MEDIA_MAX = 25 * 1024 * 1024;

const SEP = "\n\n— — —\n\n";
const TYPING_TICKET_MS = 24 * 3600_000;
const TYPING_EVERY_MS = 5_000;
const LOGIN_DEADLINE_MS = 8 * 60_000;
const MAX_QR_REFRESH = 3;
const SEEN_MAX = 500;

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((res) => {
    const t = setTimeout(res, ms);
    signal?.addEventListener("abort", () => { clearTimeout(t); res(); }, { once: true });
  });
const redact = (t: string): string => (t.length > 8 ? `${t.slice(0, 4)}…${t.slice(-2)}` : "***");

// ── 账本 (纯) ────────────────────────────────────────────────────────
export type Plan =
  | { kind: "send"; chunks: string[]; rest: OutItem[] }
  | { kind: "wait"; ms: number }
  | { kind: "hold"; why: "stale" | "cap" | "paused" | "empty" };

/** 这一刻能发什么: 无 token / 过期 → 压着; 暂停中 / 未到间隔 → 等; 额度内合并发, 超了留尾巴并在最后一条挂提示。 */
export const planFlush = (a: Pick<WxAccount, "ctx" | "outbox" | "lastOutAt" | "pausedUntil">, now: number, w: Config["weixin"]): Plan => {
  if (a.outbox.length === 0) return { kind: "hold", why: "empty" };
  if (a.pausedUntil && a.pausedUntil > now) return { kind: "wait", ms: a.pausedUntil - now };
  if (!a.ctx || now - a.ctx.at > w.ctxTtlHours * 3600_000) return { kind: "hold", why: "stale" };
  const budget = w.sendCap - a.ctx.used;
  if (budget <= 0) return { kind: "hold", why: "cap" };
  const gap = (a.lastOutAt ?? 0) + w.minGapSec * 1000 - now;
  if (gap > 0) return { kind: "wait", ms: gap };
  // 卡片插队: 等人点的东西不能排在一长段正文后面被额度挡住。
  const ordered = [...a.outbox.filter((o) => o.card), ...a.outbox.filter((o) => !o.card)];
  const chunks = chunkText(ordered.map((o) => o.text).join(SEP));
  if (chunks.length <= budget) return { kind: "send", chunks, rest: [] };
  const sendNow = chunks.slice(0, budget);
  const left = chunks.slice(budget);
  const tail = `\n\n📬 还有 ${left.length} 段没发出 (微信限额), 回任意一句取回`;
  return {
    kind: "send",
    chunks: [...sendNow.slice(0, -1), `${sendNow[sendNow.length - 1]}${tail}`],
    rest: [{ text: left.join("\n\n"), at: now }],
  };
};

/** sendmessage 失败怎么办: 掉线 / token 失效 / 频控 / 网络 (重试)。 */
export const classifySendFail = (r: Res<unknown>): "dead" | "stale" | "rate" | "net" =>
  r.ret === STALE_TOKEN || r.errcode === STALE_TOKEN ? "dead"
    : /rate/i.test(r.errmsg ?? "") ? "rate"
    : r.net ? "net"
    : "stale";

// ── 入站翻译 (纯) ────────────────────────────────────────────────────
const mediaRef = (m: CdnMedia | undefined, hexKey?: string, name?: string): string | undefined =>
  m && (m.full_url || m.encrypt_query_param)
    ? `wxcdn:${Buffer.from(JSON.stringify({ m, k: hexKey ?? "", n: name ?? "" })).toString("base64url")}`
    : undefined;

const itemText = (it: MessageItem | undefined): string =>
  !it ? ""
    : it.type === ITEM.text ? it.text_item?.text ?? ""
    : it.type === ITEM.voice ? it.voice_item?.text ? `[语音] ${it.voice_item.text}` : "[语音]"
    : it.type === ITEM.image ? "[图片]"
    : it.type === ITEM.file ? `[文件] ${it.file_item?.file_name ?? ""}`.trim()
    : it.type === ITEM.video ? "[视频]"
    : "";

export const normalizeInbound = (chatId: string, m: WeixinMessage, now: number): WxInbound => {
  const items = m.item_list ?? [];
  const texts = items.flatMap((it) =>
    it.type === ITEM.text ? [it.text_item?.text ?? ""]
      : it.type === ITEM.voice ? [it.voice_item?.text ? it.voice_item.text : "[语音, 未转写]"]
      : []).filter((t) => t.trim() !== "");
  const images = items.flatMap((it) => (it.type === ITEM.image ? [mediaRef(it.image_item?.media, it.image_item?.aeskey)] : [])).filter((x): x is string => !!x);
  const files = items.flatMap((it): WxInbound["files"] => {
    const ref = it.type === ITEM.file ? mediaRef(it.file_item?.media, undefined, it.file_item?.file_name) : it.type === ITEM.video ? mediaRef(it.video_item?.media, undefined, "video.mp4") : undefined;
    return ref ? [{ ref, name: it.type === ITEM.file ? it.file_item?.file_name ?? "file" : "video.mp4", kind: it.type === ITEM.file ? "file" : "video" }] : [];
  });
  const ref = items.find((it) => it.ref_msg)?.ref_msg;
  const quote = ref ? (ref.title || itemText(ref.message_item)).trim() : "";
  return {
    chatId,
    msgId: `wx${m.message_id ?? m.seq ?? now}`,
    at: m.create_time_ms ?? now,
    text: texts.join("\n"),
    images,
    files,
    ...(quote ? { quote } : {}),
  };
};

// ── 服务 ─────────────────────────────────────────────────────────────
export const startWeixin = ({ cfg, log, onBound, notifyWecom }: WeixinDeps): Weixin => {
  const w = (): Config["weixin"] => cfg.weixin;
  const file = expandHome(w().stateFile);
  // 凭据在里面: 每次写完收紧权限 (json-map-store 自己不管 mode)。
  const db = loadJsonMap<WxAccount>(w().stateFile);
  const tighten = (): void => { try { chmodSync(file, 0o600); } catch { /* 文件还没有 */ } };
  tighten();
  const save = (a: WxAccount): WxAccount => { db.set(a.botId, a); tighten(); return a; };
  const all = (): WxAccount[] => Object.values(db.all());
  const byChat = (chatId: string): WxAccount | undefined => all().find((a) => a.chatId === chatId);
  const patch = (botId: string, f: (a: WxAccount) => Partial<WxAccount>): WxAccount | undefined => {
    const a = db.get(botId);
    return a ? save({ ...a, ...f(a) }) : undefined;
  };

  let inbound: (m: WxInbound) => void = () => undefined;
  const polls = new Map<string, AbortController>();
  const seen = new Map<string, Set<string>>();
  const pumps = new Map<string, Promise<void>>();
  const timers = new Map<string, NodeJS.Timeout>();
  const typingState = new Map<string, { ticket?: string; ticketAt?: number; lastAt?: number; on?: boolean }>();
  let stopped = false;

  const fallbackOf = (a: WxAccount): string => w().fallbackChat || (a.boundBy.includes(":") ? a.boundBy : "");
  const tell = (a: WxAccount, md: string): void => {
    const to = fallbackOf(a);
    if (to) notifyWecom(to, md);
  };

  // ── 出站 ──
  const expire = (a: WxAccount, why: string): void => {
    log.warn({ botId: a.botId, chatId: a.chatId, why }, "weixin account expired");
    polls.get(a.botId)?.abort();
    polls.delete(a.botId);
    const cur = patch(a.botId, () => ({ state: "expired" as const, ctx: undefined }));
    if (cur) tell(cur, `📵 微信通道 \`${a.chatId}\` 掉线 (${why})${cur.outbox.length ? `, 压着 ${cur.outbox.length} 条` : ""} —— 在企微单聊发 \`/wx bind\` 重新扫码即可, 群聊与 wizard 都保留`);
  };

  const schedule = (botId: string, ms: number): void => {
    if (timers.has(botId)) return;
    timers.set(botId, setTimeout(() => { timers.delete(botId); pump(botId); }, Math.max(50, ms)));
  };

  // 同一账号的出站串行: 两次 pump 交叠会把同一份 outbox 发两遍。
  const pump = (botId: string): void => {
    const prev = pumps.get(botId) ?? Promise.resolve();
    const next = prev.then(() => flushOnce(botId)).catch((e) => log.error({ botId, err: (e as Error).message }, "weixin pump failed"));
    pumps.set(botId, next);
  };

  const flushOnce = async (botId: string): Promise<void> => {
    const a = db.get(botId);
    if (!a || stopped || a.state !== "live") return;
    const plan = planFlush(a, Date.now(), w());
    if (plan.kind === "wait") return schedule(botId, plan.ms);
    if (plan.kind === "hold") {
      if (plan.why === "stale" && !a.staleNoted) {
        patch(botId, () => ({ staleNoted: true }));
        tell(a, `📭 微信 \`${a.chatId}\` 那头久没说话, ${a.outbox.length} 条消息发不出去, 压着 —— 在微信里随便说一句就会取回`);
      }
      if (plan.why === "cap") log.info({ botId, held: a.outbox.length }, "weixin outbox held (cap)");
      return;
    }
    patch(botId, () => ({ outbox: [] }));
    for (const [i, text] of plan.chunks.entries()) {
      const cur = db.get(botId);
      if (!cur?.ctx) return;
      const r = await sendText(cur.baseUrl, cur.botToken, cur.userId, cur.ctx.token, text);
      if (r.ok) {
        patch(botId, (x) => ({ ctx: x.ctx && { ...x.ctx, used: x.ctx.used + 1 }, lastOutAt: Date.now(), sent: (x.sent ?? 0) + 1 }));
        log.info({ botId, len: text.length, msgId: (r.data as { message_id?: string } | undefined)?.message_id }, "weixin tx");
        continue;
      }
      // 没发出去的这一段和后面的, 原样塞回队头。
      const back: OutItem[] = [...plan.chunks.slice(i).map((t) => ({ text: t, at: Date.now() })), ...plan.rest];
      const kind = classifySendFail(r);
      log.warn({ botId, ret: r.ret, errcode: r.errcode, errmsg: r.errmsg, kind }, "weixin tx failed");
      patch(botId, (x) => ({
        outbox: [...back, ...x.outbox],
        failed: (x.failed ?? 0) + 1,
        ...(kind === "rate" ? { pausedUntil: Date.now() + w().ratePauseMin * 60_000 } : {}),
        ...(kind === "stale" ? { ctx: undefined } : {}),
      }));
      const after = db.get(botId)!;
      if (kind === "dead") return expire(after, `token 失效 ${r.ret ?? r.errcode}`);
      if (kind === "rate") {
        tell(after, `⏸️ 微信 \`${after.chatId}\` 被频控, 暂停出站 ${w().ratePauseMin} 分钟, ${after.outbox.length} 条排队`);
        return schedule(botId, w().ratePauseMin * 60_000);
      }
      if (kind === "net") return schedule(botId, 30_000);
      return void flushOnce(botId); // stale: 走 hold 分支报一次
    }
    const left = db.get(botId);
    if (left && plan.rest.length) patch(botId, (x) => ({ outbox: [...plan.rest, ...x.outbox] }));
    else if (left?.outbox.length) pump(botId); // 发送期间又进来的
    stopTyping(botId);
  };

  const send = (chatId: string, text: string, opts: { card?: boolean } = {}): void => {
    const a = byChat(chatId);
    if (!a || !text.trim()) return;
    patch(a.botId, (x) => ({ outbox: [...x.outbox, { text, at: Date.now(), ...(opts.card ? { card: true } : {}) }] }));
    pump(a.botId);
  };

  // ── 正在输入 ──
  const typingOf = (botId: string): { ticket?: string; ticketAt?: number; lastAt?: number; on?: boolean } =>
    typingState.get(botId) ?? (typingState.set(botId, {}), typingState.get(botId)!);
  const stopTyping = (botId: string): void => {
    const t = typingOf(botId);
    const a = db.get(botId);
    if (!t.on || !t.ticket || !a) return;
    t.on = false;
    void sendTyping(a.baseUrl, a.botToken, a.userId, t.ticket, false);
  };
  const typing = (chatId: string, on: boolean): void => {
    const a = byChat(chatId);
    if (!a || !w().typing || a.state !== "live") return;
    if (!on) return stopTyping(a.botId);
    const t = typingOf(a.botId);
    const now = Date.now();
    if (t.lastAt && now - t.lastAt < TYPING_EVERY_MS) return;
    t.lastAt = now;
    void (async () => {
      if (!t.ticket || now - (t.ticketAt ?? 0) > TYPING_TICKET_MS) {
        const r = await getTypingTicket(a.baseUrl, a.botToken, a.userId, a.ctx?.token);
        if (!r.ok || !r.data?.typing_ticket) return;
        t.ticket = r.data.typing_ticket;
        t.ticketAt = now;
      }
      const r = await sendTyping(a.baseUrl, a.botToken, a.userId, t.ticket, true);
      t.on = r.ok;
    })().catch(() => undefined);
  };

  // ── 入站 ──
  const accept = (a: WxAccount, m: WeixinMessage): void => {
    if (m.message_type === 2) return; // bot 自己发的回声
    if (m.from_user_id && m.from_user_id !== a.userId) {
      log.warn({ botId: a.botId, from: m.from_user_id }, "weixin rx from a stranger — dropped");
      return;
    }
    const id = String(m.message_id ?? m.seq ?? "");
    const ids = seen.get(a.botId) ?? new Set<string>();
    if (id && ids.has(id)) return;
    if (id) {
      ids.add(id);
      if (ids.size > SEEN_MAX) ids.delete(ids.values().next().value as string);
      seen.set(a.botId, ids);
    }
    const now = Date.now();
    // 人一开口: 新 token、额度归零、静默提示复位 —— 然后先把压着的发出去。
    patch(a.botId, () => ({ lastInAt: now, staleNoted: false, ...(m.context_token ? { ctx: { token: m.context_token, at: now, used: 0 } } : {}) }));
    pump(a.botId);
    const msg = normalizeInbound(a.chatId, m, now);
    log.info({ botId: a.botId, chatId: a.chatId, len: msg.text.length, images: msg.images.length, files: msg.files.length }, "weixin rx");
    try { inbound(msg); } catch (e) { log.error({ err: (e as Error).message }, "weixin inbound handler threw"); }
  };

  const poll = async (botId: string): Promise<void> => {
    let fails = 0;
    let timeoutMs = LONG_POLL_MS;
    while (!stopped) {
      const a = db.get(botId);
      if (!a || a.state !== "live") return;
      const ctl = new AbortController();
      polls.set(botId, ctl);
      const r = await getUpdates(a.baseUrl, a.botToken, a.cursor, timeoutMs, ctl.signal);
      if (stopped || polls.get(botId) !== ctl) return; // 被 unbind / 重绑替下
      if (ctl.signal.aborted) continue; // kick: 立即重连
      if (r.ok) {
        fails = 0;
        timeoutMs = r.data?.longpolling_timeout_ms || LONG_POLL_MS;
        const buf = r.data?.get_updates_buf;
        if (buf) patch(botId, () => ({ cursor: buf }));
        for (const m of r.data?.msgs ?? []) accept(db.get(botId)!, m);
        continue;
      }
      if (r.ret === STALE_TOKEN || r.errcode === STALE_TOKEN) return expire(a, `getupdates ${r.ret ?? r.errcode} ${r.errmsg ?? ""}`.trim());
      fails += 1;
      // 合盖过夜 / 切网: 永不放弃, 封顶 30s (与 ws.ts 的 MAX_RECONNECT=-1 同一个理由)。
      const backoff = Math.min(30_000, 1000 * 2 ** Math.min(fails, 5));
      log.warn({ botId, fails, backoff, net: r.net, ret: r.ret, errmsg: r.errmsg }, "weixin getupdates failed");
      await sleep(backoff, ctl.signal);
    }
  };

  const startPoll = (a: WxAccount): void => {
    polls.get(a.botId)?.abort();
    polls.delete(a.botId);
    void notifyLifecycle(a.baseUrl, a.botToken, true);
    void poll(a.botId).catch((e) => log.error({ botId: a.botId, err: (e as Error).message }, "weixin poll crashed"));
    pump(a.botId);
  };

  // ── 绑定 ──
  interface Login extends BindView { qrcode: string; base: string; code?: string; codeTried?: boolean; ctl: AbortController; onChange: (v: BindView) => void }
  const logins = new Map<string, Login>();
  const view = (l: Login): BindView => ({ id: l.id, by: l.by, name: l.name, status: l.status, qrUrl: l.qrUrl, refresh: l.refresh, message: l.message, startedAt: l.startedAt, ...(l.chatId ? { chatId: l.chatId } : {}) });
  const set = (l: Login, p: Partial<BindView>): void => {
    Object.assign(l, p);
    try { l.onChange(view(l)); } catch { /* 观察者自己的事 */ }
  };
  const finish = (l: Login, p: Partial<BindView>): void => {
    set(l, p);
    l.ctl.abort();
    // 留 10 分钟给 CLI / rolepage 读终态。
    setTimeout(() => { if (logins.get(l.by) === l) logins.delete(l.by); }, 10 * 60_000).unref();
  };

  const confirm = async (l: Login, body: Record<string, unknown> & { bot_token?: string; ilink_bot_id?: string; ilink_user_id?: string; baseurl?: string }): Promise<void> => {
    const userId = body.ilink_user_id ?? "";
    if (!body.bot_token || !body.ilink_bot_id || !userId) return finish(l, { status: "failed", message: "确认响应缺字段 (bot_token / ilink_bot_id / ilink_user_id)" });
    const chatId = chatIdOfUser(userId);
    const olds = all().filter((a) => a.userId === userId || a.chatId === chatId);
    if (olds.length === 0 && all().length >= w().maxAccounts) {
      return finish(l, { status: "failed", message: `已绑满 ${w().maxAccounts} 个微信号 (weixin.maxAccounts), 先 /wx unbind 一个` });
    }
    // 同一人重扫: 旧号停掉、删行, 新 bot 接管同一个群 —— 压着的消息带过去。
    const carried = olds.flatMap((o) => o.outbox);
    for (const o of olds) {
      polls.get(o.botId)?.abort();
      polls.delete(o.botId);
      db.drop(o.botId);
    }
    const acct = save({
      botId: body.ilink_bot_id,
      botToken: body.bot_token,
      baseUrl: body.baseurl || w().baseUrl || ILINK_BASE,
      userId,
      chatId,
      boundBy: l.by,
      boundAt: Date.now(),
      cursor: "",
      state: "live",
      outbox: carried,
    });
    log.info({ botId: acct.botId, chatId, user: userId, token: redact(acct.botToken), rebind: olds.length > 0 }, "weixin bound");
    startPoll(acct);
    let name = l.name || nickOf(body);
    try {
      name = await onBound(acct, name, olds.length > 0);
    } catch (e) {
      log.error({ err: (e as Error).message }, "weixin onBound failed");
    }
    finish(l, { status: "done", chatId, name, message: olds.length ? "已重新绑定 (原群聊与 wizard 保留)" : "已绑定" });
  };

  const runLogin = async (l: Login): Promise<void> => {
    const deadline = l.startedAt + LOGIN_DEADLINE_MS;
    while (!l.ctl.signal.aborted && Date.now() < deadline) {
      const code = l.code;
      const r = await getQrcodeStatus(l.base, l.qrcode, code, l.ctl.signal);
      if (l.ctl.signal.aborted) return;
      if (!r.ok) {
        log.warn({ id: l.id, errmsg: r.errmsg, ret: r.ret }, "weixin qr status failed");
        await sleep(2_000, l.ctl.signal);
        continue;
      }
      const body = r.data ?? {};
      switch (body.status) {
        case "wait":
          break;
        case "scaned":
          if (l.status !== "scaned") set(l, { status: "scaned", message: "已扫码, 请在微信里点确认" });
          break;
        case "need_verifycode":
          // 带着码还回 need_verifycode = 码不对; 清掉等人重输, 期间别空转。
          if (code) { l.code = undefined; set(l, { status: "need_code", message: "配对码不对, 请重新输入" }); }
          else if (l.status !== "need_code") set(l, { status: "need_code", message: "微信上显示了一串配对码, 请把它发回来" });
          await sleep(2_000, l.ctl.signal);
          break;
        case "verify_code_blocked":
          return finish(l, { status: "failed", message: "配对码错误次数过多, 请稍后重新发起绑定" });
        case "scaned_but_redirect":
          if (typeof body.redirect_host === "string" && body.redirect_host) l.base = `https://${body.redirect_host}`;
          break;
        case "binded_redirect":
          return finish(l, { status: "already", message: "这个微信已经绑在本机, 无需重复绑定 —— 直接在微信里说话" });
        case "expired": {
          if (l.refresh >= MAX_QR_REFRESH) return finish(l, { status: "failed", message: "二维码多次过期, 请重新发起绑定" });
          const q = await getBotQrcode(w().baseUrl || ILINK_BASE, all().map((a) => a.botToken));
          if (!q.ok || !q.data?.qrcode) return finish(l, { status: "failed", message: `刷新二维码失败: ${q.errmsg ?? q.ret ?? "unknown"}` });
          l.qrcode = q.data.qrcode;
          set(l, { status: "qr", qrUrl: q.data.qrcode_img_content, refresh: l.refresh + 1, message: `二维码已刷新 (${l.refresh + 1}/${MAX_QR_REFRESH})` });
          break;
        }
        case "confirmed":
          return confirm(l, body);
        default:
          await sleep(1_000, l.ctl.signal);
      }
    }
    if (!l.ctl.signal.aborted) finish(l, { status: "failed", message: "等扫码超时 (8 分钟), 请重新发起绑定" });
  };

  const startBind: Weixin["startBind"] = (by, name, onChange) => {
    if (!w().enabled) return { ok: false, reason: "微信通道未开启 (weixin.enabled=false)" };
    logins.get(by)?.ctl.abort();
    const l: Login = {
      id: `wb${Date.now().toString(36)}`, by, name, status: "qr", qrUrl: "", refresh: 0, message: "正在取二维码…",
      startedAt: Date.now(), qrcode: "", base: w().baseUrl || ILINK_BASE, ctl: new AbortController(), onChange,
    };
    logins.set(by, l);
    void (async () => {
      const q = await getBotQrcode(w().baseUrl || ILINK_BASE, all().map((a) => a.botToken));
      if (!q.ok || !q.data?.qrcode) return finish(l, { status: "failed", message: `取二维码失败: ${q.errmsg ?? q.ret ?? "unknown"}` });
      l.qrcode = q.data.qrcode;
      set(l, { status: "qr", qrUrl: q.data.qrcode_img_content, message: "请用微信扫码 (约 2 分钟有效, 过期自动换新码)" });
      await runLogin(l);
    })().catch((e) => finish(l, { status: "failed", message: (e as Error).message }));
    return { ok: true, view: view(l) };
  };

  const submitCode: Weixin["submitCode"] = (by, code) => {
    const l = logins.get(by);
    if (!l || l.ctl.signal.aborted) return { ok: false, reason: "没有进行中的绑定" };
    if (!/^\w{2,12}$/.test(code.trim())) return { ok: false, reason: "配对码格式不对" };
    l.code = code.trim();
    set(l, { message: "已提交配对码, 校验中…" });
    return { ok: true };
  };

  const bindOf: Weixin["bindOf"] = (k) => {
    const l = logins.get(k) ?? [...logins.values()].find((x) => x.id === k);
    return l && view(l);
  };

  const unbind: Weixin["unbind"] = (chatId) => {
    const a = byChat(chatId);
    if (!a) return { ok: false, reason: `没有绑定 ${chatId}` };
    polls.get(a.botId)?.abort();
    polls.delete(a.botId);
    void notifyLifecycle(a.baseUrl, a.botToken, false);
    db.drop(a.botId);
    log.info({ botId: a.botId, chatId }, "weixin unbound");
    return { ok: true };
  };

  const download: Weixin["download"] = async (ref) => {
    const { m, k, n } = JSON.parse(Buffer.from(ref.replace(/^wxcdn:/, ""), "base64url").toString("utf8")) as { m: CdnMedia; k: string; n?: string };
    const url = cdnDownloadUrl(m, w().cdnBaseUrl);
    if (!url) throw new Error("wxcdn: no download url");
    // 图片优先 image_item.aeskey (hex), 其次 media.aes_key; 都没有 = 明文。
    const key = k ? Buffer.from(k, "hex") : m.aes_key ? parseAesKey(m.aes_key) : undefined;
    const r = await downloadCdn(url, key);
    if (!r.ok) throw new Error(`wxcdn download failed: ${r.reason}`);
    return { buffer: r.data, ...(n ? { filename: n } : {}) };
  };

  const uploadAndSend = async (botId: string, f: { path: string; kind: WxMediaKind; name: string }): Promise<{ ok: true } | { ok: false; reason: string }> => {
    const a = db.get(botId);
    if (!a || a.state !== "live") return { ok: false, reason: "微信通道已掉线, 先 /wx bind 重新绑定" };
    const now = Date.now();
    if (a.pausedUntil && a.pausedUntil > now) return { ok: false, reason: `微信被频控, ${Math.ceil((a.pausedUntil - now) / 60_000)} 分钟后再试` };
    if (!a.ctx || now - a.ctx.at > w().ctxTtlHours * 3600_000) return { ok: false, reason: "微信那头久没说话, context_token 已过期 —— 等对方在微信里说一句再发" };
    if (a.ctx.used >= w().sendCap) return { ok: false, reason: `这一轮已发满 ${w().sendCap} 条 (weixin.sendCap), 等对方再说话再发` };
    const raw = readFileSync(f.path);
    const key = randomBytes(16);
    const cipher = encryptEcb(raw, key);
    const filekey = randomBytes(16).toString("hex");
    const u = await getUploadUrl(a.baseUrl, a.botToken, { filekey, media_type: MEDIA_TYPE[f.kind], to_user_id: a.userId, rawsize: raw.length, rawfilemd5: md5(raw), filesize: cipher.length, aeskey: key.toString("hex") });
    const url = u.ok && u.data ? cdnUploadUrl(u.data, filekey, w().cdnBaseUrl) : undefined;
    if (!url) return { ok: false, reason: `微信拒发上传参数: ${u.errmsg ?? u.ret ?? "no upload url"}` };
    const up = await uploadCdn(url, cipher);
    if (!up.ok) return { ok: false, reason: up.reason };
    // aes_key: hex 串再 base64 (官方插件的发送形态)。
    const media = { encrypt_query_param: up.param, aes_key: Buffer.from(key.toString("hex")).toString("base64"), encrypt_type: 1 };
    const item: MessageItem = f.kind === "image" ? { type: ITEM.image, image_item: { media, mid_size: cipher.length } }
      : f.kind === "video" ? { type: ITEM.video, video_item: { media, video_size: cipher.length } }
      : { type: ITEM.file, file_item: { media, file_name: f.name, len: String(raw.length) } };
    const r = await sendItems(a.baseUrl, a.botToken, a.userId, a.ctx.token, [item]);
    if (!r.ok) {
      const kind = classifySendFail(r);
      patch(botId, (x) => ({ failed: (x.failed ?? 0) + 1, ...(kind === "rate" ? { pausedUntil: Date.now() + w().ratePauseMin * 60_000 } : {}), ...(kind === "stale" ? { ctx: undefined } : {}) }));
      if (kind === "dead") expire(db.get(botId)!, `token 失效 ${r.ret ?? r.errcode}`);
      return { ok: false, reason: `微信拒收 (${kind}): ${r.errmsg ?? r.ret ?? ""}` };
    }
    patch(botId, (x) => ({ ctx: x.ctx && { ...x.ctx, used: x.ctx.used + 1 }, lastOutAt: Date.now(), sent: (x.sent ?? 0) + 1 }));
    log.info({ botId, kind: f.kind, name: f.name, bytes: raw.length }, "weixin tx media");
    return { ok: true };
  };

  const sendMedia: Weixin["sendMedia"] = (chatId, f) => {
    const a = byChat(chatId);
    if (!a) return Promise.resolve({ ok: false, reason: `没有绑定 ${chatId}` });
    // 排进同一条出站链: 前面排着的文字先走 (仍受间隔约束 —— 媒体不等间隔, 但排在它们后面)。
    const prev = pumps.get(a.botId) ?? Promise.resolve();
    const run = prev.then(() => flushOnce(a.botId)).then(() => uploadAndSend(a.botId, f)).catch((e: Error) => ({ ok: false as const, reason: e.message }));
    pumps.set(a.botId, run.then(() => undefined));
    return run;
  };

  const kick: Weixin["kick"] = (reason) => {
    log.info({ reason, n: polls.size }, "weixin kick long-polls");
    for (const c of polls.values()) c.abort();
  };

  const stop: Weixin["stop"] = async () => {
    stopped = true;
    for (const c of polls.values()) c.abort();
    for (const t of timers.values()) clearTimeout(t);
    for (const l of logins.values()) l.ctl.abort();
    await Promise.all(all().filter((a) => a.state === "live").map((a) => notifyLifecycle(a.baseUrl, a.botToken, false)));
  };

  // 开机: 只在开关开着时收发; 关着的时候账号原样留着, 再开即续。
  if (w().enabled) for (const a of all().filter((x) => x.state === "live")) startPoll(a);
  log.info({ enabled: w().enabled, accounts: all().length }, "weixin init");

  return {
    owns: (chatId) => !!byChat(chatId),
    accountOf: byChat,
    list: all,
    send,
    typing,
    download,
    sendMedia,
    onInbound: (fn) => { inbound = fn; },
    startBind,
    submitCode,
    bindOf,
    unbind,
    kick,
    stop,
  };
};
