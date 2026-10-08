// 媒体收发里与通道无关的那一半: 出站「把本地文件发到某个聊天」的接口与校验, 入站「把
// 收到的文件落进 inbox、写成 agent 读得懂的一行」。每个 IM 通道 (aibot 见 aibot-media.ts,
// 微信 ClawBot 见 weixin.ts) 各自实现 SendMedia; 调用方只认 principal, 不认通道。
import { mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";

export type MediaKind = "image" | "file" | "voice" | "video";

export interface MediaSpec {
  /** 本机绝对路径 */
  path: string;
  /** 省略 = 按扩展名推 (kindOf) */
  kind?: MediaKind;
  /** 对方看到的文件名, 省略 = basename(path) */
  name?: string;
  /** 只对 video 有意义 */
  title?: string;
  description?: string;
}

export type MediaResult =
  | { ok: true; kind: MediaKind; name: string; bytes: number }
  | { ok: false; reason: string };

/** 出站媒体的唯一入口: `target` 是 principal (`chat:…` / `user:…` / `wx:…`, 可带 `#slot`,
 *  实现自己剥), 失败不抛, 以 reason 回给调用方 —— 它多半要原样转给模型。 */
export type SendMedia = (target: string, spec: MediaSpec) => Promise<MediaResult>;

const MB = 1024 * 1024;

// 企微 aibot 上传临时素材的硬限制 (官方 101463)。微信通道若更宽, 在自己的实现里另判。
export const LIMITS: Record<MediaKind, { max: number; exts?: readonly string[]; hint: string }> = {
  image: { max: 10 * MB, exts: [".png", ".jpg", ".jpeg", ".gif"], hint: "png / jpg / gif, ≤10MB" },
  video: { max: 10 * MB, exts: [".mp4"], hint: "mp4, ≤10MB" },
  voice: { max: 2 * MB, exts: [".amr"], hint: "amr, ≤2MB" },
  file: { max: 20 * MB, hint: "任意类型, ≤20MB" },
};
const MIN_BYTES = 5;

const KIND_BY_EXT: Record<string, MediaKind> = Object.fromEntries(
  (["image", "video", "voice"] as const).flatMap((k) => (LIMITS[k].exts ?? []).map((e) => [e, k])),
);

export const kindOf = (path: string): MediaKind => KIND_BY_EXT[extname(path).toLowerCase()] ?? "file";

const fmtSize = (n: number): string => (n >= MB ? `${(n / MB).toFixed(1)}MB` : `${Math.ceil(n / 1024)}KB`);

/** 这份文件能不能以 kind 发出; 不能就给一句模型照着改得动的理由。 */
export const checkMedia = (kind: MediaKind, name: string, bytes: number): string | undefined => {
  const lim = LIMITS[kind];
  const ext = extname(name).toLowerCase();
  if (bytes < MIN_BYTES) return `文件太小 (${bytes}B), 企微要求至少 ${MIN_BYTES} 字节`;
  if (lim.exts && !lim.exts.includes(ext)) return `${kind} 只收 ${lim.hint}, 「${name}」不是 —— 改 kind:"file" 当附件发`;
  if (bytes > lim.max) {
    const asFile = kind !== "file" && bytes <= LIMITS.file.max ? ` —— 改 kind:"file" 当附件发 (文件上限 ${fmtSize(LIMITS.file.max)})` : "";
    return `${kind} 上限 ${fmtSize(lim.max)}, 「${name}」有 ${fmtSize(bytes)}${asFile}`;
  }
  return undefined;
};

export type Planned = { ok: true; kind: MediaKind; name: string; bytes: number } | { ok: false; reason: string };

/** 定下 kind / name 并校验; 只 stat, 不读内容。 */
export const planMedia = (spec: MediaSpec): Planned => {
  if (!spec.path.startsWith("/")) return { ok: false, reason: `path 要写绝对路径: ${spec.path}` };
  const st = ((): ReturnType<typeof statSync> | undefined => {
    try { return statSync(spec.path); } catch { return undefined; }
  })();
  if (!st) return { ok: false, reason: `文件不存在: ${spec.path}` };
  if (!st.isFile()) return { ok: false, reason: `不是普通文件: ${spec.path}` };
  const name = spec.name?.trim() || basename(spec.path);
  const kind = spec.kind ?? kindOf(name);
  const bad = checkMedia(kind, name, Number(st.size));
  return bad ? { ok: false, reason: bad } : { ok: true, kind, name, bytes: Number(st.size) };
};

// ── 入站: inbox ─────────────────────────────────────────────────────────
// 入站文件过 TTL 就删: 人发来的文件只为这一两轮服务, 留着只会越积越多。
export const INBOX_TTL_MS = 7 * 24 * 3600_000;
// 企微本身只回调 ≤100MB 的文件 / 视频; 这道闸防的是别的通道。
export const INBOX_MAX_BYTES = 100 * MB;

/** 落盘名: `<msgid>_<序号>_<原名>`, 只留安全字符 —— 原名留着, agent 一看就知道是什么。 */
export const inboxName = (msgid: string, index: number, filename: string): string => {
  const safe = (s: string): string => s.replace(/[^\p{L}\p{N}._-]+/gu, "_").replace(/^\.+/, "").slice(-120);
  return `${safe(msgid) || "msg"}_${index}_${safe(filename) || "file"}`;
};

const sweptAt = new Map<string, number>();
/** 删 dir 下超过 ttl 的文件; 同一目录一小时最多扫一次 (挂在每次落盘之后, 懒执行)。 */
export const sweepInbox = (dir: string, ttl = INBOX_TTL_MS, now = Date.now()): number => {
  if (now - (sweptAt.get(dir) ?? 0) < 3600_000) return 0;
  sweptAt.set(dir, now);
  const stale = (() => {
    try { return readdirSync(dir).map((f) => join(dir, f)); } catch { return []; }
  })().filter((p) => {
    try { const s = statSync(p); return s.isFile() && now - s.mtimeMs > ttl; } catch { return false; }
  });
  return stale.reduce((n, p) => {
    try { unlinkSync(p); return n + 1; } catch { return n; }
  }, 0);
};

/** 写进 inbox (0600), 顺手清过期的; 超限返回 reason 不落盘。 */
export const saveToInbox = (dir: string, name: string, buf: Buffer): { path: string } | { reason: string } => {
  if (buf.length > INBOX_MAX_BYTES) return { reason: `文件 ${fmtSize(buf.length)} 超过 inbox 上限 ${fmtSize(INBOX_MAX_BYTES)}, 未保存` };
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, buf, { mode: 0o600 });
  sweepInbox(dir);
  return { path };
};

const LABEL: Record<MediaKind, string> = { image: "图片", file: "文件", voice: "语音", video: "视频" };

/** 注入会话的那一行: agent 用 Read / Bash 按路径去读。 */
export const attachmentLine = (kind: MediaKind, path: string, bytes: number): string =>
  `[${LABEL[kind]}: ${path} (${fmtSize(bytes)})]`;
