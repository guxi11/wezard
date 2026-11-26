// Session-scoped token/cost audit. Reads the session's main jsonl plus any
// subagent transcripts under `<projectDir>/<sid>/subagents/agent-*.jsonl` and
// produces a markdown table grouped by (bucket, model). Used by:
//   - `wezard audit` CLI (cli/audit.ts) — invoked by the /audit slash command
//   - inbound intercept (daemon/inbound.ts) — when a WeCom user sends `/audit`
//     directly, we bypass the Claude REPL entirely (tmux paste of /audit was
//     unreliable) and reply with the report immediately.
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import {
  ModelTotals,
  emptyTotals,
  addInto,
  sumTotal,
  extractTokens,
  costOf,
  fmtTokens,
  fmtCost,
} from "./usage.js";

interface BucketKey { kind: "main" | "subagent"; agentType: string; }
interface Row { ts: number; model: string; tokens: ModelTotals; dedupKey: string; bucket: BucketKey; }

const readRows = (path: string, kind: "main" | "subagent", fallbackAgent: string): Row[] => {
  let raw: string;
  try { raw = readFileSync(path, "utf8"); } catch { return []; }
  const rows: Row[] = [];
  for (const line of raw.split("\n")) {
    if (!line || line.indexOf('"usage"') < 0) continue;
    let rec: Record<string, unknown>;
    try { rec = JSON.parse(line); } catch { continue; }
    if (rec.type !== "assistant") continue;
    const msg = (rec.message ?? {}) as Record<string, unknown>;
    const model = String(msg.model ?? "");
    if (!model || model === "<synthetic>") continue;
    const tokens = extractTokens((msg.usage ?? {}) as Record<string, unknown>, model);
    if (!tokens) continue;
    const ts = Date.parse(String(rec.timestamp ?? "")) || 0;
    const msgId = String(msg.id ?? "");
    const reqId = String(rec.requestId ?? "");
    const dedupKey = msgId ? `${msgId}|${reqId}` : String(rec.uuid ?? "");
    if (!dedupKey) continue;
    const agentType = String(rec.attributionAgent ?? "") || fallbackAgent;
    rows.push({ ts, model, tokens, dedupKey, bucket: { kind, agentType } });
  }
  return rows;
};

const listSubagentJsonls = (projectDir: string, sid: string): string[] => {
  const dir = join(projectDir, sid, "subagents");
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir)
      .filter((f) => f.startsWith("agent-") && f.endsWith(".jsonl"))
      .map((f) => join(dir, f));
  } catch { return []; }
};

interface Bucket {
  key: BucketKey;
  byModel: Map<string, ModelTotals>;
}

const bucketKey = (b: BucketKey): string => (b.kind === "main" ? "main" : `sub:${b.agentType}`);
const bucketLabel = (b: Bucket): string => bucketKey(b.key);

const aggregate = (rows: Row[]): { buckets: Map<string, Bucket>; firstTs: number; lastTs: number } => {
  const buckets = new Map<string, Bucket>();
  const seen = new Set<string>();
  let firstTs = Infinity;
  let lastTs = 0;
  for (const r of rows) {
    if (seen.has(r.dedupKey)) continue;
    seen.add(r.dedupKey);
    if (r.ts) { if (r.ts < firstTs) firstTs = r.ts; if (r.ts > lastTs) lastTs = r.ts; }
    const k = bucketKey(r.bucket);
    let b = buckets.get(k);
    if (!b) { b = { key: r.bucket, byModel: new Map() }; buckets.set(k, b); }
    const cell = b.byModel.get(r.model) ?? emptyTotals();
    addInto(cell, r.tokens);
    b.byModel.set(r.model, cell);
  }
  return { buckets, firstTs: firstTs === Infinity ? 0 : firstTs, lastTs };
};

const pad2 = (n: number): string => String(n).padStart(2, "0");
const fmtHHMM = (ts: number): string => {
  const d = new Date(ts);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
};
const fmtDuration = (ms: number): string => {
  if (ms <= 0) return "0s";
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  return h > 0 ? `${h}h${m}m` : m > 0 ? `${m}m${s}s` : `${s}s`;
};

interface BucketRow {
  bucket: string;
  model: string;
  tokens: ModelTotals;
  total: number;
  cost: number;
}

const flattenBucket = (b: Bucket): BucketRow[] =>
  Array.from(b.byModel.entries())
    .map(([model, tokens]) => ({
      bucket: bucketLabel(b),
      model,
      tokens,
      total: sumTotal(tokens),
      cost: costOf(model, tokens),
    }))
    .sort((x, y) => y.total - x.total);

const renderTable = (rows: BucketRow[]): string[] => {
  const header = "| bucket | model | in | out | cache_w | cache_r | total | cost |";
  const sep = "|---|---|---:|---:|---:|---:|---:|---:|";
  const body = rows.map((r) => {
    const short = r.model.replace(/^claude-/, "");
    return `| \`${r.bucket}\` | \`${short}\` | ${fmtTokens(r.tokens.input)} | ${fmtTokens(r.tokens.output)} | ${fmtTokens(r.tokens.cacheCreate)} | ${fmtTokens(r.tokens.cacheRead)} | ${fmtTokens(r.total)} | ${fmtCost(r.cost)} |`;
  });
  return [header, sep, ...body];
};

export interface AuditOpts {
  sessionId: string;
  jsonlPath: string;
  tag?: string;
}

export const computeAuditReport = (opts: AuditOpts): string => {
  const { sessionId: sid, jsonlPath, tag } = opts;
  const projectDir = dirname(jsonlPath);

  const rows: Row[] = [];
  rows.push(...readRows(jsonlPath, "main", "main"));
  const subFiles = listSubagentJsonls(projectDir, sid);
  let subInvocations = 0;
  for (const fp of subFiles) {
    const before = rows.length;
    rows.push(...readRows(fp, "subagent", "unknown"));
    if (rows.length > before) subInvocations += 1;
  }

  const { buckets, firstTs, lastTs } = aggregate(rows);
  const out: string[] = [];
  const header = tag ? `📊 /audit — session tag \`${tag}\`` : "📊 /audit";
  out.push(header);
  out.push(`session: \`${sid}\``);
  out.push(`project: \`${projectDir.replace(homedir(), "~")}\``);
  if (firstTs && lastTs) {
    out.push(`活跃时段: ${fmtHHMM(firstTs)} → ${fmtHHMM(lastTs)} (${fmtDuration(lastTs - firstTs)})`);
  }

  if (buckets.size === 0) {
    out.push("", "本会话尚无 usage 记录。");
    return out.join("\n");
  }

  const mainB = buckets.get("main");
  const subBuckets = Array.from(buckets.entries())
    .filter(([k]) => k !== "main")
    .map(([, b]) => b);

  const tableRows: BucketRow[] = [];
  if (mainB) tableRows.push(...flattenBucket(mainB));
  for (const b of subBuckets) tableRows.push(...flattenBucket(b));

  const grandTokens = tableRows.reduce((s, r) => s + r.total, 0);
  const grandCost = tableRows.reduce((s, r) => s + r.cost, 0);

  out.push("", ...renderTable(tableRows));
  if (subBuckets.length > 0) {
    out.push("", `子会话: ${subInvocations} 次调用 · ${subBuckets.length} 种 agent`);
  }
  out.push("", `**总计: ${fmtTokens(grandTokens)} tokens · ${fmtCost(grandCost)}**`);
  return out.join("\n");
};

// Pure: which live mirror does `arg` mean — a wizard's exact target when `arg` names one, else the
// newest-by-mtime mirror carrying `#<arg>` (legacy slot form). `mtimeOf` is injected so it stays testable.
export const pickMirror = <M extends { target: string }>(
  mirrors: M[],
  arg: string,
  targetOfName: (name: string) => string | undefined,
  mtimeOf: (m: M) => number,
): M | null => {
  const wanted = arg.replace(/^#/, "");
  const named = targetOfName(arg);
  const matches = named
    ? mirrors.filter((m) => m.target === named)
    : mirrors.filter((m) => (m.target.split("#")[1] ?? "") === wanted);
  return matches
    .map((m) => ({ m, mt: mtimeOf(m) }))
    .sort((a, b) => b.mt - a.mt)[0]?.m ?? null;
};

