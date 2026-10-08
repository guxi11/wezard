// 微信 ClawBot (iLink) 协议层: 请求构造是纯的, fetch 是唯一的副作用。
//
// 协议没有正式公开文档, 以 Tencent/openclaw-weixin (2.4.9) 的 docs/protocol 与源码为准 ——
// 变了只改这一个文件。每个调用都**不抛**: 网络错、HTTP 非 2xx、超时一律折成
// `{ ok:false, net:true }`, 业务失败是 `{ ok:false, ret, errcode, errmsg }`, 由调用方按
// 接口定重试 (长轮询退避、sendmessage 进 outbox), 而不是让一个异常掀翻轮询循环。
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

export const ILINK_BASE = "https://ilinkai.weixin.qq.com";
export const ILINK_CDN = "https://novac2c.cdn.weixin.qq.com/c2c";
// 冒充官方插件的版本号: 服务端可能按 channel_version / ClientVersion 放行, 自报一个
// 它没见过的版本是平白多一个被拒的理由。bot_agent 才是我们自己的名字 (只用于观测)。
const CHANNEL_VERSION = "2.4.9";
const APP_ID = "bot";
const clientVersion = (v: string): string =>
  String(v.split(".").map((p) => parseInt(p, 10) || 0).reduce((acc, n) => (acc << 8) | (n & 0xff), 0));
const BOT_AGENT = "wezard/1.0";
const BOT_TYPE = "3";

export const LONG_POLL_MS = 35_000;
const API_TIMEOUT_MS = 15_000;

export interface Res<T> {
  ok: boolean;
  /** 连不上 / 超时 / HTTP 非 2xx —— 与业务码分开, 前者退避重试, 后者看码。 */
  net?: boolean;
  status?: number;
  ret?: number;
  errcode?: number;
  errmsg?: string;
  data?: T;
}

const randomUin = (): string => Buffer.from(String(randomBytes(4).readUInt32BE(0)), "utf8").toString("base64");
const appHeaders = (): Record<string, string> => ({
  "iLink-App-Id": APP_ID,
  "iLink-App-ClientVersion": clientVersion(CHANNEL_VERSION),
});
const botHeaders = (token?: string): Record<string, string> => ({
  "Content-Type": "application/json",
  AuthorizationType: "ilink_bot_token",
  "X-WECHAT-UIN": randomUin(),
  ...appHeaders(),
  ...(token ? { Authorization: `Bearer ${token}` } : {}),
});
const baseInfo = { channel_version: CHANNEL_VERSION, bot_agent: BOT_AGENT };
const join = (base: string, path: string): string => `${base.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;

/** 业务码: 有 ret 看 ret, 有 errcode 看 errcode; 两个都没有 = 成功 (sendTyping 之类不回码)。 */
const verdict = <T>(status: number, body: unknown): Res<T> => {
  const b = (body ?? {}) as { ret?: number; errcode?: number; errmsg?: string };
  const bad = (b.ret !== undefined && b.ret !== 0) || (b.errcode !== undefined && b.errcode !== 0);
  return { ok: !bad, status, ret: b.ret, errcode: b.errcode, errmsg: b.errmsg, data: body as T };
};

const call = async <T>(url: string, init: RequestInit, timeoutMs: number, signal?: AbortSignal): Promise<Res<T>> => {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  const relay = (): void => ctl.abort();
  signal?.addEventListener("abort", relay, { once: true });
  try {
    const res = await fetch(url, { ...init, signal: ctl.signal });
    const text = await res.text();
    if (!res.ok) return { ok: false, net: true, status: res.status, errmsg: text.slice(0, 300) };
    let body: unknown = {};
    try { body = text ? JSON.parse(text) : {}; } catch { return { ok: false, status: res.status, errmsg: `non-json: ${text.slice(0, 200)}` }; }
    return verdict<T>(res.status, body);
  } catch (e) {
    const err = e as Error & { cause?: { code?: string } };
    return { ok: false, net: true, errmsg: ctl.signal.aborted ? (signal?.aborted ? "aborted" : "timeout") : `${err.message}${err.cause?.code ? ` (${err.cause.code})` : ""}` };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", relay);
  }
};

const post = <T>(base: string, path: string, token: string | undefined, body: Record<string, unknown>, timeoutMs = API_TIMEOUT_MS, signal?: AbortSignal): Promise<Res<T>> =>
  call<T>(join(base, path), { method: "POST", headers: botHeaders(token), body: JSON.stringify({ ...body, base_info: baseInfo }) }, timeoutMs, signal);

// ── 登录 ─────────────────────────────────────────────────────────────
export interface QrCode { qrcode: string; qrcode_img_content: string }
export type QrStatus =
  | "wait" | "scaned" | "confirmed" | "expired"
  | "scaned_but_redirect" | "need_verifycode" | "verify_code_blocked" | "binded_redirect";
export interface QrStatusBody {
  status?: QrStatus;
  bot_token?: string;
  ilink_bot_id?: string;
  baseurl?: string;
  ilink_user_id?: string;
  redirect_host?: string;
  [k: string]: unknown;
}

/** `localTokens`: 本机已有的 bot_token (≤10) —— 服务端据此认出「已绑在本端」回 binded_redirect。 */
export const getBotQrcode = (base: string, localTokens: readonly string[]): Promise<Res<QrCode>> =>
  call<QrCode>(join(base, `ilink/bot/get_bot_qrcode?bot_type=${BOT_TYPE}`), {
    method: "POST",
    headers: botHeaders(),
    body: JSON.stringify({ local_token_list: localTokens.slice(0, 10) }),
  }, API_TIMEOUT_MS);

/** 长轮询; 客户端超时当作 `wait` (官方插件同款)。 */
export const getQrcodeStatus = async (base: string, qrcode: string, verifyCode?: string, signal?: AbortSignal): Promise<Res<QrStatusBody>> => {
  const q = `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}${verifyCode ? `&verify_code=${encodeURIComponent(verifyCode)}` : ""}`;
  const r = await call<QrStatusBody>(join(base, q), { method: "GET", headers: appHeaders() }, LONG_POLL_MS + 5_000, signal);
  return r.net && r.errmsg === "timeout" ? { ok: true, data: { status: "wait" } } : r;
};

// ── 收发 ─────────────────────────────────────────────────────────────
export interface CdnMedia { encrypt_query_param?: string; aes_key?: string; encrypt_type?: number; full_url?: string }
export interface MessageItem {
  type?: number;
  text_item?: { text?: string };
  image_item?: { media?: CdnMedia; aeskey?: string; url?: string; mid_size?: number };
  voice_item?: { media?: CdnMedia; text?: string; playtime?: number };
  file_item?: { media?: CdnMedia; file_name?: string; len?: string };
  video_item?: { media?: CdnMedia; video_size?: number };
  ref_msg?: { message_item?: MessageItem; title?: string };
}
export interface WeixinMessage {
  seq?: number;
  message_id?: string | number;
  from_user_id?: string;
  to_user_id?: string;
  client_id?: string;
  create_time_ms?: number;
  message_type?: number;
  message_state?: number;
  item_list?: MessageItem[];
  context_token?: string;
}
export interface Updates { msgs?: WeixinMessage[]; get_updates_buf?: string; longpolling_timeout_ms?: number }

export const ITEM = { text: 1, image: 2, voice: 3, file: 4, video: 5 } as const;
/** `-14`: token 失效 (被重新绑定顶替后必现)。 */
export const STALE_TOKEN = -14;

export const getUpdates = (base: string, token: string, buf: string, timeoutMs: number, signal?: AbortSignal): Promise<Res<Updates>> =>
  post<Updates>(base, "ilink/bot/getupdates", token, { get_updates_buf: buf }, timeoutMs + 5_000, signal);

export const sendItems = (base: string, token: string, to: string, contextToken: string, items: MessageItem[]): Promise<Res<{ message_id?: string }>> =>
  post(base, "ilink/bot/sendmessage", token, {
    msg: {
      from_user_id: "",
      to_user_id: to,
      client_id: `wezard-${randomBytes(8).toString("hex")}`,
      message_type: 2,
      message_state: 2,
      context_token: contextToken,
      item_list: items,
    },
  });

export const sendText = (base: string, token: string, to: string, contextToken: string, text: string): ReturnType<typeof sendItems> =>
  sendItems(base, token, to, contextToken, [{ type: ITEM.text, text_item: { text } }]);

export const getTypingTicket = (base: string, token: string, user: string, contextToken?: string): Promise<Res<{ typing_ticket?: string }>> =>
  post(base, "ilink/bot/getconfig", token, { ilink_user_id: user, ...(contextToken ? { context_token: contextToken } : {}) }, 10_000);

export const sendTyping = (base: string, token: string, user: string, ticket: string, on: boolean): Promise<Res<unknown>> =>
  post(base, "ilink/bot/sendtyping", token, { ilink_user_id: user, typing_ticket: ticket, status: on ? 1 : 2 });

export const notifyLifecycle = (base: string, token: string, start: boolean): Promise<Res<unknown>> =>
  post(base, start ? "ilink/bot/msg/notifystart" : "ilink/bot/msg/notifystop", token, {});

// ── CDN 媒体 (AES-128-ECB + PKCS7) ─────────────────────────────────────
/** media.aes_key 两种都收: base64(16 字节原始 key) 或 base64(32 位 hex 串)。 */
export const parseAesKey = (b64: string): Buffer | undefined => {
  const raw = Buffer.from(b64, "base64");
  if (raw.length === 16) return raw;
  const s = raw.toString("ascii");
  return raw.length === 32 && /^[0-9a-f]{32}$/i.test(s) ? Buffer.from(s, "hex") : undefined;
};
export const decryptEcb = (data: Buffer, key: Buffer): Buffer => {
  const d = createDecipheriv("aes-128-ecb", key, null);
  return Buffer.concat([d.update(data), d.final()]);
};
export const encryptEcb = (data: Buffer, key: Buffer): Buffer => {
  const c = createCipheriv("aes-128-ecb", key, null);
  return Buffer.concat([c.update(data), c.final()]);
};
export const md5 = (b: Buffer): string => createHash("md5").update(b).digest("hex");

export const cdnDownloadUrl = (m: CdnMedia, cdnBase = ILINK_CDN): string | undefined =>
  m.full_url || (m.encrypt_query_param ? `${cdnBase}/download?encrypted_query_param=${encodeURIComponent(m.encrypt_query_param)}` : undefined);

/** 下载并 (有 key 就) 解密。key 缺省 = 明文 (官方插件: 图片无 key 即明文)。 */
export const downloadCdn = async (url: string, key: Buffer | undefined, timeoutMs = 60_000): Promise<{ ok: true; data: Buffer } | { ok: false; reason: string }> => {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctl.signal });
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` };
    const buf = Buffer.from(await res.arrayBuffer());
    return { ok: true, data: key ? decryptEcb(buf, key) : buf };
  } catch (e) {
    return { ok: false, reason: (e as Error).message };
  } finally {
    clearTimeout(timer);
  }
};

// ── CDN 上传 ─────────────────────────────────────────────────────────
export const MEDIA_TYPE = { image: 1, video: 2, file: 3 } as const;
export interface UploadUrl { upload_param?: string; upload_full_url?: string }

export const getUploadUrl = (base: string, token: string, req: { filekey: string; media_type: number; to_user_id: string; rawsize: number; rawfilemd5: string; filesize: number; aeskey: string }): Promise<Res<UploadUrl>> =>
  post<UploadUrl>(base, "ilink/bot/getuploadurl", token, { ...req, no_need_thumb: true });

/** 密文 POST 到 CDN, 成功的唯一凭据是响应头 `x-encrypted-param` (下载参数)。4xx 不重试, 其余 ≤3 次。 */
export const uploadCdn = async (url: string, cipher: Buffer, attempt = 1): Promise<{ ok: true; param: string } | { ok: false; reason: string }> => {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 120_000);
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: new Uint8Array(cipher), signal: ctl.signal })
    .then((res) => ({ status: res.status, param: res.headers.get("x-encrypted-param") ?? "" }))
    .catch((e: Error) => ({ status: 0, param: "", err: e.message }))
    .finally(() => clearTimeout(timer));
  if (r.status === 200 && r.param) return { ok: true, param: r.param };
  if (r.status >= 400 && r.status < 500) return { ok: false, reason: `CDN HTTP ${r.status}` };
  return attempt < 3 ? uploadCdn(url, cipher, attempt + 1) : { ok: false, reason: `CDN 上传失败 (${r.status || ("err" in r ? r.err : "no x-encrypted-param")})` };
};

export const cdnUploadUrl = (u: UploadUrl, filekey: string, cdnBase = ILINK_CDN): string | undefined =>
  u.upload_full_url || (u.upload_param ? `${cdnBase}/upload?encrypted_query_param=${encodeURIComponent(u.upload_param)}&filekey=${encodeURIComponent(filekey)}` : undefined);
