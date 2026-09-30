// 审批卡标题上的「会话名」— 回答"是哪个会话在请求授权"。
//
// 数据源按可靠度降级:
//   1. chatKey 里的 `#tag` — 企微侧显式命名的并行会话, 人起的名, 最准;
//   2. CC 的会话名 — `~/.claude{,-internal}/sessions/<pid>.json` 活跃会话注册表
//      的 `name` 字段 (CC 会话列表显示的就是它, 如 "product-engineer-83")。
//      只覆盖活着的进程, 但发卡时会话必然活着 —— hook 正是它触发的;
//   3. transcript 首条用户消息首句 — 注册表意外缺失时的语义兜底;
//   4. sessionId 尾八位 — 保底可辨识串。
// (jsonl 的 summary 行实测 0/20 覆盖 — CC 2.1.x 不写, 不可用。)
import { closeSync, openSync, readSync } from "node:fs";
import { tagOfKey } from "../shared/session-label.js";
import { readRegistry } from "./cc-session.js";

const NAME_MAX = 16;
const TRUNC = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

// ── CC 活跃会话注册表 ────────────────────────────────────────────────
// 目录很小 (每个活跃 claude 进程一个 json), 每次全量扫 + 短 TTL 缓存足够。
// pid 文件在进程退出后清理, 长缓存反而会拿到死名字。
const REGISTRY_HOMES = ["~/.claude", "~/.claude-internal"];
const REGISTRY_TTL_MS = 30_000;
let registry: { at: number; bySession: Map<string, string> } | null = null;

const scanRegistry = (): Map<string, string> => {
  const now = Date.now();
  if (registry && now - registry.at < REGISTRY_TTL_MS) return registry.bySession;
  const bySession = new Map(
    REGISTRY_HOMES.flatMap(readRegistry).filter((r) => r.name).map((r) => [r.sessionId, r.name] as const),
  );
  registry = { at: now, bySession };
  return bySession;
};

// ── transcript 首条用户消息 (语义兜底) ──────────────────────────────
const HEAD_BYTES = 32 * 1024;

const readHead = (path: string): string => {
  try {
    const fd = openSync(path, "r");
    try {
      const buf = Buffer.alloc(HEAD_BYTES);
      const n = readSync(fd, buf, 0, HEAD_BYTES, 0);
      return buf.toString("utf8", 0, n);
    } finally {
      closeSync(fd);
    }
  } catch {
    return "";
  }
};

// 与 hook 的 transcript_tail 提取同一套噪声过滤: 剥掉 Claude Code 注入的包裹标签。
const WRAPPER_RE = /<system-reminder(?:\s[^>]*)?>[\s\S]*?<\/system-reminder>|<command-[a-z]+>[\s\S]*?<\/command-[a-z]+>|<local-command-[a-z]+>[\s\S]*?<\/local-command-[a-z]+>/g;

const firstUserText = (path: string): string => {
  for (const line of readHead(path).split("\n")) {
    if (!line.includes('"user"')) continue; // 便宜的预过滤, 大部分行不用 parse
    let row: Record<string, unknown>;
    try { row = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
    if (row.type !== "user" || row.isMeta === true) continue;
    const msg = row.message as { content?: unknown } | undefined;
    const c = msg?.content;
    const text = typeof c === "string"
      ? c
      : Array.isArray(c)
        ? c.filter((b): b is { type: string; text: string } =>
            Boolean(b) && (b as { type?: string }).type === "text",
          ).map((b) => b.text).join(" ")
        : "";
    const clean = text.replace(WRAPPER_RE, "").replace(/\s+/g, " ").trim();
    if (clean) return clean;
  }
  return "";
};

const firstMsgCache = new Map<string, string>(); // transcriptPath → 首条用户消息原文
const CACHE_MAX = 300;

const firstUserTextCached = (path: string): string => {
  const hit = firstMsgCache.get(path);
  if (hit !== undefined) return hit;
  const v = firstUserText(path);
  if (v) {
    if (firstMsgCache.size >= CACHE_MAX) {
      const oldest = firstMsgCache.keys().next().value;
      if (oldest !== undefined) firstMsgCache.delete(oldest);
    }
    firstMsgCache.set(path, v);
  }
  return v;
};

/** 会话名: #tag > CC 会话名 > transcript 首条用户消息 > sessionId 尾八位。 */
export const sessionNameFor = (
  chatKey: string | undefined,
  transcriptPath: string | undefined,
  sessionId: string | undefined,
): string => {
  const tag = chatKey ? tagOfKey(chatKey) : "";
  if (tag) return `#${TRUNC(tag, NAME_MAX)}`;
  if (sessionId) {
    const cc = scanRegistry().get(sessionId);
    if (cc) return TRUNC(cc, NAME_MAX);
  }
  if (transcriptPath) {
    const t = firstUserTextCached(transcriptPath);
    if (t) return TRUNC(t, NAME_MAX);
  }
  return sessionId ? sessionId.slice(-8) : "";
};
