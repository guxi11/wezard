// Read Claude Code transcripts (~/.claude(-internal)?/projects/**/*.jsonl) and
// aggregate token usage into (a) today's totals and (b) the currently-active
// 5-hour billing block. Matches ccusage's algorithm without pulling ccusage's
// heavy dep graph or paying npx's 28s cold start.
//
// Block model: Anthropic's rate-limit windows are 5h. First assistant message
// anchors block startTs to floor-of-hour; block ends 5h later. A gap of >5h
// since last activity starts a new block on the next message.
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { priceOf, costOf as costWith } from "../shared/pricing.js";

export interface ModelTotals {
  input: number;
  output: number;
  cacheCreate: number;
  cacheRead: number;
}

export const emptyTotals = (): ModelTotals => ({ input: 0, output: 0, cacheCreate: 0, cacheRead: 0 });

export const addInto = (a: ModelTotals, b: ModelTotals): void => {
  a.input += b.input;
  a.output += b.output;
  a.cacheCreate += b.cacheCreate;
  a.cacheRead += b.cacheRead;
};

export const sumTotal = (t: ModelTotals): number => t.input + t.output + t.cacheCreate + t.cacheRead;

// Pull the four token counts off a raw `message.usage` blob, applying the
// totalized-input adjustment when `input_tokens` already covers both cache
// tiers (gateway dialect: claude-4.7-opus, deepseek-v4-flash). Returns null
// if the row carries no meaningful token counts.
export const extractTokens = (usage: Record<string, unknown>, model: string): ModelTotals | null => {
  const rawIn = Number(usage.input_tokens ?? 0);
  const output = Number(usage.output_tokens ?? 0);
  const cacheCreate = Number(usage.cache_creation_input_tokens ?? 0);
  const cacheRead = Number(usage.cache_read_input_tokens ?? 0);
  // Same data-based reconciliation as peers.lastContextTokens: input_tokens
  // >= cache_read+cache_creation ⇔ the gateway totalized it, so back-derive
  // fresh input; otherwise input_tokens is already the fresh portion.
  const isTotalized = rawIn >= cacheRead + cacheCreate;
  const input = isTotalized ? rawIn - cacheRead - cacheCreate : rawIn;
  if (input + output + cacheCreate + cacheRead === 0) return null;
  return { input, output, cacheCreate, cacheRead };
};

interface UsageEntry {
  ts: number;
  model: string;
  tokens: ModelTotals;
  dedupKey: string;
}

export interface BlockUsage {
  startTs: number;
  endTs: number;
  lastTs: number;
  isActive: boolean;
  byModel: Map<string, ModelTotals>;
}

const PROJECT_ROOTS = [
  join(homedir(), ".claude-internal", "projects"),
  join(homedir(), ".claude", "projects"),
  join(homedir(), ".codebuddy", "projects"),
];

const HOUR_MS = 60 * 60 * 1000;
const BLOCK_MS = 5 * HOUR_MS;
const DAY_MS = 24 * HOUR_MS;

// 单价来自 shared/pricing (LiteLLM 价格表快照); 认不出的模型记 0 (token 照计, 不出费用)。
export const costOf = (model: string, t: ModelTotals): number => {
  const p = priceOf(model);
  return p ? costWith(p, { input: t.input, output: t.output, cacheWrite: t.cacheCreate, cacheRead: t.cacheRead }) : 0;
};

const walkJsonl = (root: string, sinceMs: number, out: string[]): void => {
  let subs: import("node:fs").Dirent[];
  try {
    subs = readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const d of subs) {
    if (!d.isDirectory()) continue;
    const dir = join(root, d.name);
    let files: string[];
    try {
      files = readdirSync(dir);
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.endsWith(".jsonl")) continue;
      const p = join(dir, f);
      try {
        const st = statSync(p);
        if (st.mtimeMs < sinceMs) continue;
        out.push(p);
      } catch {
        /* ignore */
      }
    }
  }
};

// CodeBuddy usage lives on `type:"function_call"` rows (each row = one real
// API request), under `providerData.usage` with OpenAI-Responses-API camelCase
// (inputTokens / outputTokens / inputTokensDetails[0].cached_tokens). No
// separate cache_creation concept — the gateway reports total-cached only.
// Returns null when the row lacks a usable usage blob.
const extractCodebuddyTokens = (
  u: Record<string, unknown>,
  model: string,
): ModelTotals | null => {
  const rawIn = Number(u.inputTokens ?? 0);
  const output = Number(u.outputTokens ?? 0);
  const details = Array.isArray(u.inputTokensDetails) ? u.inputTokensDetails : [];
  const cached = details.reduce((sum: number, d: unknown) => {
    const c = (d as { cached_tokens?: unknown })?.cached_tokens;
    return sum + Number(c ?? 0);
  }, 0);
  // rawIn is the full inbound (fresh + cached). Treat cached as cache_read
  // and back-derive fresh input to keep the same accounting as extractTokens.
  const cacheRead = cached;
  const input = rawIn >= cacheRead ? rawIn - cacheRead : rawIn;
  if (input + output + cacheRead === 0) return null;
  void model;
  return { input, output, cacheCreate: 0, cacheRead };
};

// Parse a jsonl file and yield assistant usage entries with ts >= sinceMs.
// Skips synthetic error messages (model=<synthetic>) and rows without usage.
// Sniffs the schema by top-level type: Claude Code writes `type:"assistant"`
// with `message.usage`; CodeBuddy writes `type:"function_call"` with
// `providerData.usage`. Both formats can appear in the same PROJECT_ROOTS
// sweep, so per-line dispatch is safer than per-file.
const readUsageEntries = (path: string, sinceMs: number): UsageEntry[] => {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const out: UsageEntry[] = [];
  for (const line of raw.split("\n")) {
    if (!line) continue;
    // Fast reject: rows without usage never match.
    if (line.indexOf("\"usage\"") < 0) continue;
    let row: Record<string, unknown>;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    const ts = Date.parse(String(row.timestamp ?? ""));
    if (!Number.isFinite(ts) || ts < sinceMs) continue;

    if (row.type === "assistant") {
      const msg = (row.message ?? {}) as Record<string, unknown>;
      const model = String(msg.model ?? "");
      if (!model || model === "<synthetic>") continue;
      const u = (msg.usage ?? {}) as Record<string, unknown>;
      // 网关把 input_tokens 报成 cr+cw+fresh 的合计 (claude-4.7-opus, deepseek-v4-flash),
      // 与 Anthropic 官方口径 (input_tokens 仅含 fresh, 与 cache_* 互不相交) 冲突。
      // extractTokens 按数据判据 (input_tokens 是否覆盖两个 cache 档) 反推, 不依赖模型名。
      const tokens = extractTokens(u, model);
      if (!tokens) continue;
      // Dedup: `--resume` copies the parent transcript into the new session's
      // jsonl, so every historical message would otherwise count many times.
      // ccusage keys on `message.id + requestId`; we do the same. Fall back to
      // `uuid` for older rows that lack message.id.
      const msgId = String(msg.id ?? "");
      const reqId = String(row.requestId ?? "");
      const dedupKey = msgId ? `${msgId}|${reqId}` : String(row.uuid ?? "");
      if (!dedupKey) continue;
      out.push({ ts, model, tokens, dedupKey });
      continue;
    }

    if (row.type === "function_call") {
      const pd = (row.providerData ?? {}) as Record<string, unknown>;
      const model = String(pd.model ?? "");
      if (!model || model === "<synthetic>") continue;
      const u = (pd.usage ?? {}) as Record<string, unknown>;
      const tokens = extractCodebuddyTokens(u, model);
      if (!tokens) continue;
      // Dedup: CodeBuddy `callId` is unique per API request (a single
      // conversation turn can spawn many with the same host `id`, so `id`
      // alone would collapse them into one).
      const dedupKey = String(row.callId ?? row.id ?? "");
      if (!dedupKey) continue;
      out.push({ ts, model, tokens, dedupKey });
      continue;
    }
  }
  return out;
};

// Group sorted entries into 5h billing blocks (matches ccusage semantics):
// startTs = floor-of-hour of first entry; endTs = startTs + 5h; a >5h idle gap
// since lastTs forces a new block.
const groupBlocks = (entries: UsageEntry[]): BlockUsage[] => {
  const blocks: BlockUsage[] = [];
  const now = Date.now();
  for (const e of entries) {
    const cur = blocks[blocks.length - 1];
    const shouldStart =
      !cur || e.ts >= cur.endTs || e.ts - cur.lastTs >= BLOCK_MS;
    if (shouldStart) {
      const startTs = Math.floor(e.ts / HOUR_MS) * HOUR_MS;
      blocks.push({
        startTs,
        endTs: startTs + BLOCK_MS,
        lastTs: e.ts,
        isActive: false,
        byModel: new Map(),
      });
    }
    const b = blocks[blocks.length - 1]!;
    b.lastTs = e.ts;
    const bucket = b.byModel.get(e.model) ?? emptyTotals();
    addInto(bucket, e.tokens);
    b.byModel.set(e.model, bucket);
  }
  for (const b of blocks) {
    b.isActive = now < b.endTs && now - b.lastTs < BLOCK_MS;
  }
  return blocks;
};

const startOfLocalDay = (ts: number): number => {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

// Monday 00:00 local as week anchor (Chinese convention: week starts Monday).
const startOfLocalWeek = (ts: number): number => {
  const d = new Date(startOfLocalDay(ts));
  const back = (d.getDay() + 6) % 7; // days since Monday (getDay: 0=Sun)
  d.setDate(d.getDate() - back);
  return d.getTime();
};

export interface UsageReport {
  now: number;
  todayStart: number;
  today: Map<string, ModelTotals>;
  weekStart: number;
  week: Map<string, ModelTotals>;
  active?: BlockUsage;
}

const aggregateSince = (entries: UsageEntry[], sinceMs: number): Map<string, ModelTotals> => {
  const acc = new Map<string, ModelTotals>();
  for (const e of entries) {
    if (e.ts < sinceMs) continue;
    const t = acc.get(e.model) ?? emptyTotals();
    addInto(t, e.tokens);
    acc.set(e.model, t);
  }
  return acc;
};

// Public entry point. Scans jsonl mtime'd within the last ~30h (covers today +
// any in-flight 5h block that started late yesterday), parses usage rows, and
// returns (a) today's aggregates and (b) the active block if any.
export const computeUsage = (): UsageReport => {
  const now = Date.now();
  const todayStart = startOfLocalDay(now);
  const weekStart = startOfLocalWeek(now);
  // Scan back to whichever is earlier: week start, or one day (covers active block).
  const scanSince = Math.min(weekStart, todayStart - DAY_MS);
  const files: string[] = [];
  for (const root of PROJECT_ROOTS) {
    if (existsSync(root)) walkJsonl(root, scanSince, files);
  }
  const entries: UsageEntry[] = [];
  for (const f of files) entries.push(...readUsageEntries(f, scanSince));
  entries.sort((a, b) => a.ts - b.ts);
  // Dedup after sort so we keep the earliest occurrence (matches ccusage — the
  // first jsonl that carried a message is where the actual work happened).
  const seen = new Set<string>();
  const dedup: UsageEntry[] = [];
  for (const e of entries) {
    if (seen.has(e.dedupKey)) continue;
    seen.add(e.dedupKey);
    dedup.push(e);
  }
  const blocks = groupBlocks(dedup);
  const active = blocks.find((b) => b.isActive);
  const today = aggregateSince(dedup, todayStart);
  const week = aggregateSince(dedup, weekStart);
  return { now, todayStart, today, weekStart, week, active };
};

export const fmtTokens = (n: number): string => {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
};

export const fmtCost = (usd: number): string => (usd >= 0.005 ? `$${usd.toFixed(2)}` : "—");

const fmtDuration = (ms: number): string => {
  if (ms <= 0) return "0m";
  const h = Math.floor(ms / HOUR_MS);
  const m = Math.floor((ms % HOUR_MS) / (60 * 1000));
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
};

const pad2 = (n: number): string => String(n).padStart(2, "0");
const fmtHHMM = (ts: number): string => {
  const d = new Date(ts);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
};

export const renderModelLines = (byModel: Map<string, ModelTotals>): { lines: string[]; totalTokens: number; totalCost: number } => {
  let totalTokens = 0;
  let totalCost = 0;
  const lines: string[] = [];
  const sorted = Array.from(byModel.entries()).sort(
    (a, b) => sumTotal(b[1]) - sumTotal(a[1]),
  );
  for (const [model, t] of sorted) {
    const sum = sumTotal(t);
    const cost = costOf(model, t);
    totalTokens += sum;
    totalCost += cost;
    const short = model.replace(/^claude-/, "");
    lines.push(
      `  \`${short}\` in ${fmtTokens(t.input)} / out ${fmtTokens(t.output)} / cache ${fmtTokens(t.cacheRead + t.cacheCreate)}`,
    );
  }
  return { lines, totalTokens, totalCost };
};

const fmtLocalDate = (ts: number): string => {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
};

export const renderUsageReport = (r: UsageReport): string => {
  const out: string[] = ["[wezard] 📊 Usage 概览"];

  if (r.active) {
    const b = r.active;
    const remaining = Math.max(0, b.endTs - r.now);
    const elapsed = Math.max(0, r.now - b.startTs);
    const { lines, totalTokens, totalCost } = renderModelLines(b.byModel);
    out.push(
      "",
      `⏰ 当前 5h 计费块 (${fmtHHMM(b.startTs)} → ${fmtHHMM(b.endTs)}, 剩余 ${fmtDuration(remaining)})`,
    );
    out.push(...lines);
    out.push(`  合计: **${fmtTokens(totalTokens)}** tokens · ${fmtCost(totalCost)}`);
    if (elapsed > 60_000 && totalCost > 0) {
      const perHour = (totalCost / elapsed) * HOUR_MS;
      const projected = perHour * (BLOCK_MS / HOUR_MS);
      out.push(`  燃烧速率: ${fmtCost(perHour)}/h · 预计块末 ${fmtCost(projected)}`);
    }
  } else {
    out.push("", "⏰ 当前无活跃 5h 计费块");
  }

  const dayLabel = fmtLocalDate(r.todayStart);
  if (r.today.size > 0) {
    const { lines, totalTokens, totalCost } = renderModelLines(r.today);
    out.push("", `📅 今日累计 (${dayLabel})`);
    out.push(...lines);
    out.push(`  合计: **${fmtTokens(totalTokens)}** tokens · ${fmtCost(totalCost)}`);
  } else {
    out.push("", `📅 今日累计 (${dayLabel}): 无`);
  }

  const weekLabel = `${fmtLocalDate(r.weekStart)} → ${fmtLocalDate(r.now)}`;
  if (r.week.size > 0) {
    const { lines, totalTokens, totalCost } = renderModelLines(r.week);
    out.push("", `🗓️ 本周累计 (${weekLabel})`);
    out.push(...lines);
    out.push(`  合计: **${fmtTokens(totalTokens)}** tokens · ${fmtCost(totalCost)}`);
  } else {
    out.push("", `🗓️ 本周累计 (${weekLabel}): 无`);
  }

  return out.join("\n");
};
