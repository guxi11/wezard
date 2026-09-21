// Session cache for "Allow for session" decisions.
// Key = (sessionId, toolName, hash(cmd_prefix)). In-memory, TTL via approval.sessionCacheMinutes.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { expandHome } from "../shared/paths.js";
import { baseOfKey } from "../shared/session-label.js";
import type { Decision } from "./pending.js";

interface Entry {
  decision: Decision;
  expiresAt: number;
}

const cache = new Map<string, Entry>();

const norm = (s: string): string => s.trim().replace(/\s+/g, " ");

const cmdPrefix = (toolName: string, toolInput: unknown): string => {
  // Bash: first token of command. Others: stable JSON.
  if (toolName === "Bash" && toolInput && typeof toolInput === "object") {
    const cmd = (toolInput as Record<string, unknown>).command;
    if (typeof cmd === "string") {
      const first = norm(cmd).split(" ")[0] ?? "";
      return first;
    }
  }
  try {
    return JSON.stringify(toolInput);
  } catch {
    return String(toolInput);
  }
};

export const cacheKey = (sessionId: string, toolName: string, toolInput: unknown): string => {
  const h = createHash("sha1").update(cmdPrefix(toolName, toolInput)).digest("hex").slice(0, 12);
  return `${sessionId}::${toolName}::${h}`;
};

export const cacheGet = (key: string): Decision | undefined => {
  const e = cache.get(key);
  if (!e) return undefined;
  if (Date.now() > e.expiresAt) {
    cache.delete(key);
    return undefined;
  }
  return e.decision;
};

export const cachePut = (key: string, decision: Decision, ttlMs: number): void => {
  cache.set(key, { decision, expiresAt: Date.now() + ttlMs });
};

// ── Per-chat auto-approve window ───────────────────────────────────────
// Set by `allow_window` clicks; while active, approval requests routed to
// the SAME chat (WeCom principal like "user:abc" / "chat:wc...") bypass the
// card flow and return allow immediately. Chat-scoped instead of session-scoped
// so that multiple concurrent sessions bound to the same WeCom chat share the
// user's "放行 N 分钟" choice — a new session started under the same chat
// inherits the window until it expires.
// Persisted to disk so daemon restart doesn't drop the user's choice.
const autoApproveUntilByChat = new Map<string, number>();

// 归一化: 审批目标是 mirror target (`user:abc#fix`), 带 `#tag`。窗口是 CHAT 级
// 的授权 — 用户点一次「放行 N 分钟」是对这个聊天说的, 不是对某个 tag 会话说的,
// 所以所有窗口读写都先塌到 base principal, 同 chat 下新开的 `#tag` 会话直接继承。
// 调用方仍传带 tag 的 key (卡片渲染要 tag emoji), 归一化只发生在存储边界。
const scopeOf = baseOfKey;

// 保存最近一次窗口卡片的元信息，用于"取消"时重建卡片不丢上下文。
export interface WindowMeta {
  toolName: string;
  toolInput: unknown;
  cwd: string;
  transcriptTail: string;
}
const windowMetaByChat = new Map<string, WindowMeta>();

// ── Persistence ─────────────────────────────────────────────────────────
let persistPath: string | undefined;

interface PersistShape {
  windows: Record<string, { until: number; meta?: WindowMeta }>;
}

const writeAtomic = (path: string, text: string): void => {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, text, "utf8");
  renameSync(tmp, path);
};

const persist = (): void => {
  if (!persistPath) return;
  const windows: PersistShape["windows"] = {};
  for (const [chatKey, until] of autoApproveUntilByChat.entries()) {
    windows[chatKey] = { until, meta: windowMetaByChat.get(chatKey) };
  }
  try {
    writeAtomic(persistPath, JSON.stringify({ windows } satisfies PersistShape));
  } catch {
    /* best-effort; in-memory state still authoritative */
  }
};

/** Call once at daemon startup. Loads any unexpired windows from disk. */
export const initAutoWindowPersistence = (stateDir: string): void => {
  const dir = expandHome(stateDir);
  // 文件名改成 -by-chat 版本; 旧的 auto-windows.json (sessionId 键) 直接搁置,
  // 不迁移 — 那些键在新语义下永远不会匹配, 靠自然 TTL 淘汰即可。
  persistPath = join(dir, "auto-windows-by-chat.json");
  try {
    mkdirSync(dirname(persistPath), { recursive: true });
  } catch {
    /* ignore */
  }
  if (!existsSync(persistPath)) return;
  try {
    const data = JSON.parse(readFileSync(persistPath, "utf8")) as Partial<PersistShape>;
    const now = Date.now();
    for (const [chatKey, entry] of Object.entries(data.windows ?? {})) {
      if (!entry || typeof entry.until !== "number") continue;
      if (entry.until <= now) continue;
      // 旧盘上可能是带 tag 的 key — 落地时一并塌到 base。
      const k = scopeOf(chatKey);
      autoApproveUntilByChat.set(k, Math.max(autoApproveUntilByChat.get(k) ?? 0, entry.until));
      if (entry.meta) windowMetaByChat.set(k, entry.meta);
    }
    // 清掉过期项后落盘一次。
    persist();
  } catch {
    /* corrupt file — start fresh */
  }
};

export const setAutoWindow = (chatKey: string, ttlMs: number, meta?: WindowMeta): number => {
  const until = Date.now() + ttlMs;
  autoApproveUntilByChat.set(scopeOf(chatKey), until);
  if (meta) windowMetaByChat.set(scopeOf(chatKey), meta);
  persist();
  return until;
};

export const getWindowMeta = (chatKey: string): WindowMeta | undefined =>
  windowMetaByChat.get(scopeOf(chatKey));

export const autoWindowRemainingMs = (chatKey: string): number =>
  Math.max(0, (autoApproveUntilByChat.get(scopeOf(chatKey)) ?? 0) - Date.now());

export const isAutoWindowActive = (chatKey: string): boolean => {
  const base = scopeOf(chatKey);
  const until = autoApproveUntilByChat.get(base);
  if (until === undefined) return false;
  if (Date.now() >= until) {
    autoApproveUntilByChat.delete(base);
    windowMetaByChat.delete(base);
    persist();
    return false;
  }
  return true;
};

export const clearAutoWindow = (chatKey?: string): void => {
  if (chatKey === undefined) {
    autoApproveUntilByChat.clear();
    windowMetaByChat.clear();
  } else {
    autoApproveUntilByChat.delete(scopeOf(chatKey));
    windowMetaByChat.delete(scopeOf(chatKey));
  }
  persist();
};
