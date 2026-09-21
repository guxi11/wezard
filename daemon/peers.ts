// 同伴感知: 「这个聊天里还有谁在干活」的读侧。
//
// 一个企微聊天里住着一个默认 wizard 加任意多个 `#tag` wizard (inbound.ts 按 tag
// 路由)。它们互为同伴 —— 同一个聊天, 各有各的 pane、CLI、模型、工作区。看得见
// 同伴的 wizard 就驱动得动它们: 读 `#fix` 的终端、推它一把、等它闲下来、再拿它
// 的答案接着干。身份那一层 (名字/职责/记忆/家谱) 在 wizard.ts, 这里只管"此刻它
// 在干嘛、是不是还活着"。
//
// Everything here is pure parsing over a transcript tail or a captured pane —
// no tmux, no WeCom, no daemon state. The mirror bridge (which owns the live
// attachments) and the graph runner (which drives them) both compose on top.
import { existsSync, openSync, readSync, closeSync, statSync } from "node:fs";
import { backendForPath, type CliBackendName } from "../shared/cli-backends.js";

/** Strip ANSI SGR/CSI + OSC so captured pane text is safe to embed / match on. */
export const stripAnsi = (s: string): string =>
  s.replace(/\x1B\[[0-9;?]*[a-zA-Z]/g, "").replace(/\x1B\][^\x07]*\x07/g, "");

// ── Transcript tail ───────────────────────────────────────────────────
// Bounded read: a session that has run for hours has a multi-MB jsonl, and we
// only ever want the last few turns. 64K covers ~10 turns of prose plus tool
// noise even in the worst case.
const TAIL_BYTES = 64 * 1024;
// …除非单行本身就比窗口大。Claude Code 每轮往 transcript 里写若干 `attachment`
// 行, 其中 `prompt_snapshot` 带完整系统提示 + skill 清单 —— 实测一行 157KB。一条
// 这样的行就能把 64K 的窗口整个吃掉, 于是尾部根本够不到真正的对话行: lastText 空、
// summarizeTail 空、keepalive 的两个时钟一起退化成 mtime。窗口因此按需长大: 常见
// 情况仍然只读 64K, 读不到要的东西才翻四倍, 到这个上限为止 (再大就不是"尾巴"了)。
const TAIL_BYTES_MAX = 2 * 1024 * 1024;

const fileSize = (jsonlPath: string): number => {
  try { return statSync(jsonlPath).size; } catch { return 0; }
};

const readTailBytes = (jsonlPath: string, want: number): string => {
  if (!existsSync(jsonlPath)) return "";
  let fd: number | undefined;
  try {
    const size = statSync(jsonlPath).size;
    const len = Math.min(size, want);
    const buf = Buffer.allocUnsafe(len);
    fd = openSync(jsonlPath, "r");
    const read = readSync(fd, buf, 0, len, Math.max(0, size - want));
    return buf.subarray(0, read).toString("utf8");
  } catch {
    return "";
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* ignore */ } }
  }
};

/** 从文件尾读一段并解析; `enough` 说不够就翻四倍重读, 直到够了、读完整个文件、
 *  或者撞上上限。窗口是手段不是目的 —— 调用方只说"我要几轮", 不该关心一条
 *  attachment 有多大。 */
const readTailUntil = <T>(
  jsonlPath: string,
  parse: (raw: string) => T,
  enough: (parsed: T) => boolean,
): T => {
  const size = fileSize(jsonlPath);
  const ceiling = Math.min(size || TAIL_BYTES, TAIL_BYTES_MAX);
  const walk = (win: number): T => {
    const parsed = parse(readTailBytes(jsonlPath, win));
    return enough(parsed) || win >= ceiling ? parsed : walk(Math.min(win * 4, ceiling));
  };
  return walk(Math.min(TAIL_BYTES, ceiling));
};


export interface Turn {
  role: "user" | "assistant";
  text: string;
  /** Wall-clock epoch ms from the line's own `timestamp`; 0 if absent/unparsable.
   *  Lets keepalive anchor realIdle to a message's actual time, not file mtime. */
  ms?: number;
}

// Meta wrappers Claude Code injects around slash commands / hook output. They
// are machinery, not conversation — drop them before any summary or handoff.
const META_RE = /<(system-reminder|command-[^>]*|local-command-[^>]*|task-notification)>[\s\S]*?<\/\1>/g;

const blockText = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b): b is { type?: string; text?: string } => !!b && (b as { type?: string }).type === "text")
    .map((b) => b.text ?? "")
    .join(" ");
};

/** Last `n` user/assistant turns of a transcript, oldest first. Backend-agnostic:
 *  the line shape is normalized through the owning CLI's dialect adapter. */
export const tailTurns = (jsonlPath: string, n = 3): Turn[] =>
  readTailUntil(jsonlPath, (raw) => parseTurns(jsonlPath, raw), (ts) => ts.length >= n).slice(-n);

/** 纯解析: 一段 transcript 原文 → 里面的对话轮次。 */
const parseTurns = (jsonlPath: string, raw: string): Turn[] => {
  if (!raw) return [];
  const normalize = backendForPath(jsonlPath).normalizeTranscriptLine;
  return raw
    .split("\n")
    .filter((l) => l.trim())
    .flatMap((line) => {
      let parsed: unknown;
      try { parsed = JSON.parse(line); } catch { return []; }
      // The first line of a truncated tail is usually a fragment — normalize
      // returning null (or a throw) is the expected outcome, not an error.
      let row;
      try { row = normalize(parsed); } catch { return []; }
      if (!row || row.isMeta || row.isSidechain) return [];
      const role = row.message?.role;
      if (role !== "user" && role !== "assistant") return [];
      const text = blockText(row.message?.content).replace(META_RE, "").replace(/\s+/g, " ").trim();
      // Claude writes ISO timestamp strings; CodeBuddy writes epoch-ms NUMBERS.
      // Date.parse(number) coerces to a bare digit-string and returns NaN —
      // which silently stamped every CodeBuddy turn ms=0, degraded
      // keepaliveStamps to mtime fallback, and let the keepalive's own ping
      // writes (plus snapshot/summary churn) read as REAL activity that reset
      // the round budget without bound.
      const rawTs = (parsed as { timestamp?: unknown }).timestamp;
      const ms = typeof rawTs === "number" ? rawTs : Date.parse(String(rawTs ?? ""));
      return text ? [{ role, text, ms: Number.isNaN(ms) ? 0 : ms } as Turn] : [];
    });
};

// Flatten a message's content for QUOTE DEDUP only — unlike `blockText` this
// also lifts `tool_use` (name + stringified input) and `tool_result` text.
// Outbound tool bubbles render as `🔧 <Name> <input>` / `↳ <result>`, so a
// user quoting one carries tool tokens that plain text-only extraction can't
// match — the dedup then wrongly re-injects the quote (observed dup bug).
const blockTextWithTools = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((b): string => {
      const t = (b as { type?: string })?.type;
      if (t === "text") return (b as { text?: string }).text ?? "";
      if (t === "tool_use") {
        const c = b as { name?: string; input?: unknown };
        return `${c.name ?? ""} ${typeof c.input === "string" ? c.input : JSON.stringify(c.input ?? "")}`;
      }
      if (t === "tool_result") {
        const c = (b as { content?: unknown }).content;
        return typeof c === "string" ? c : blockText(c);
      }
      return "";
    })
    .filter(Boolean)
    .join(" ");
};

// ── Keepalive ping detection ──────────────────────────────────────────
// Shared by the idle clocks (keepaliveStamps) and the quote-dedup tail:
// a ping is machinery, not conversation, and both readers must agree on
// what counts as one.
const normPing = (s: string): string => s.replace(/\s+/gu, "");

/** Normalized signature set of the configured ping forms — whitespace-stripped
 *  40-char prefixes, the same shape keepaliveTick feeds keepaliveStamps. */
export const keepalivePingSigs = (...pings: string[]): string[] =>
  pings.map((p) => normPing(p).slice(0, 40)).filter((s) => s.length > 0);

/** Is this user-turn text a keepalive ping? Matches every configured form plus
 *  the bare "ping" legacy streak form still present in older transcripts. */
export const isKeepalivePingText = (text: string, sigs: readonly string[]): boolean =>
  normPing(text).toLowerCase() === "ping" ||
  sigs.some((sig) => sig.length > 0 && normPing(text).includes(sig));

/** Like `tailTurns` but the flattened text includes tool_use/tool_result
 *  content — the dedup-only reader so quoted tool bubbles match context.
 *  `n` counts logical conversation turns (user→assistant transitions), not
 *  individual transcript records — essential for backends like CodeBuddy
 *  where a single turn is split across many jsonl lines (text, function_call,
 *  function_call_result, reasoning, …).
 *  `pingSigs` 剔除 keepalive ping 及其应答后再数轮次(有效 tail) —— 挂机久了
 *  ping/pong 会把真实轮次挤出窗口,引用去重 miss → 原文被重复注入。 */
interface ToolEntry { role: string; text: string }

/** 纯解析: transcript 原文 → 条目 (文本含 tool_use/tool_result)。 */
const parseToolEntries = (jsonlPath: string, raw: string): ToolEntry[] => {
  if (!raw) return [];
  const normalize = backendForPath(jsonlPath).normalizeTranscriptLine;
  return raw.split("\n").flatMap((line): ToolEntry[] => {
    if (!line.trim()) return [];
    let parsed: unknown;
    try { parsed = JSON.parse(line); } catch { return []; }
    let row;
    try { row = normalize(parsed); } catch { return []; }
    if (!row || row.isMeta || row.isSidechain) return [];
    const role = row.message?.role;
    if (role !== "user" && role !== "assistant") return [];
    const text = blockTextWithTools(row.message?.content).replace(META_RE, "").replace(/\s+/g, " ").trim();
    return text ? [{ role, text }] : [];
  });
};

/** Keepalive = ping query + whatever the model replies to it (query-based,
 *  same rule as keepaliveStamps). */
const withoutPings = (all: readonly ToolEntry[], pingSigs: readonly string[]): ToolEntry[] => {
  const isPing = (e: ToolEntry | undefined): boolean =>
    !!e && e.role === "user" && isKeepalivePingText(e.text, pingSigs);
  return all.filter((e, i) => !isPing(e) && !(e.role === "assistant" && isPing(all[i - 1])));
};

/** 逻辑轮次 = 角色交替的次数 (一条模型回复可能被后端拆成好几行记录)。 */
const countTurns = (entries: readonly ToolEntry[]): number =>
  entries.reduce((acc, e, i) => acc + (i > 0 && entries[i - 1]!.role !== e.role ? 1 : 0), 0);

/** 从尾部数 `n` 个逻辑轮次的切点; 不足 n 轮就从头给 (要多少给多少)。 */
const cutForTurns = (entries: readonly ToolEntry[], n: number): number => {
  let turns = 0;
  for (let i = entries.length - 1; i > 0; i--) {
    if (entries[i]!.role !== entries[i - 1]!.role && ++turns >= n) return i;
  }
  return 0;
};

export const tailTurnsWithTools = (jsonlPath: string, n = 3, pingSigs: readonly string[] = []): string => {
  const entries = withoutPings(
    readTailUntil(
      jsonlPath,
      (raw) => parseToolEntries(jsonlPath, raw),
      (es) => countTurns(withoutPings(es, pingSigs)) >= n,
    ),
    pingSigs,
  );
  return entries.slice(cutForTurns(entries, n)).map((e) => e.text).join("\n");
};

// Transcript prose is arbitrary text: backticks / asterisks / pipes lifted out of
// it render as chips and table cells inside a WeCom bubble, shredding the line
// layout. A preview is plain text — flatten every markdown-active char.
const stripMd = (s: string): string => s.replace(/[`*_~|]/g, "").replace(/\s+/g, " ").trim();

/** One-line "what is this session doing" preview, for list rendering. */
export const summarizeTail = (jsonlPath: string, n = 3, per = 80): string => {
  if (!existsSync(jsonlPath)) return "(新会话 · 暂无对话)";
  const turns = tailTurns(jsonlPath, n);
  if (turns.length === 0) return "(暂无对话)";
  return turns.map((t) => `${t.role === "user" ? "你" : "AI"}: ${stripMd(t.text).slice(0, per)}`).join(" · ");
};

/** Readable multi-turn rendering of a transcript tail — "what has been said in
 *  that session", for one agent reading another's conversation. Strictly better
 *  than a pane capture for *reading*: whole messages (the viewport truncates),
 *  no ANSI / TUI chrome, already role-tagged. The pane remains the only honest
 *  source for `busy`. */
export const renderDialog = (turns: readonly Turn[], per = 800): string =>
  turns
    .map((t) => `${t.role === "user" ? "▸" : "◂"} ${t.text.length > per ? `${t.text.slice(0, per)}…` : t.text}`)
    .join("\n");

/** 交付收口行。
 *
 *  fan-out 之后 join 的载荷是「最后一条 assistant 文本」, 而一个分身的最后一句可能
 *  是"好的我开始了", 也可能是八百字散文 —— 两种都没法直接汇总。对法与 graph 的
 *  `until` 哨兵同源: 不改 CLI 的输出格式 (改不了), 只在派活的提示里要求收口成一行
 *  `RESULT: …`, 这里把它捞出来。取**最后一个**匹配 —— 中间复述过这个格式的那些
 *  不算数。捞不到返回 "", 调用方退回整段 lastText, 所以不遵守约定也只是退化。 */
export const extractResult = (text: string, max = 800): string => {
  // 标记之后的**全部**内容, 而不是"那一行" —— 这个函数的入口 (lastAssistantText)
  // 已经把换行压成空格了, 行的概念到这里不存在。约定是收口在最后, 所以标记之后
  // 剩下的就是结论。取最后一个匹配: 模型常先复述一遍格式要求再给答案。
  const hits = [...text.matchAll(/(?:^|[\s>*|-])(?:RESULT|结论)\s*[:：]\s*/gim)];
  const last = hits[hits.length - 1];
  return last ? text.slice((last.index ?? 0) + last[0].length).trim().slice(0, max) : "";
};

/** The peer's most recent assistant message — the handoff payload when one
 *  agent drives another ("take #fix's conclusion and review it"). */
export const lastAssistantText = (jsonlPath: string, max = 4000): string => {
  const turns = tailTurns(jsonlPath, 40).filter((t) => t.role === "assistant");
  const last = turns[turns.length - 1]?.text ?? "";
  return last.length > max ? `${last.slice(0, max)}…` : last;
};

/** Prompt-token size of the session's most recent turn: input + both cache
 *  tiers = how full the context window is, i.e. exactly what a cold cache would
 *  have to re-write at 1.25x. Read from the last assistant usage snapshot in
 *  the tail; 0 when no usage is on record yet. Drives the keepalive decision
 *  and the "session size" note. */
export const lastContextTokens = (jsonlPath: string): number =>
  readTailUntil(jsonlPath, (raw) => pickContextTokens(jsonlPath, raw), (v) => v > 0);

const pickContextTokens = (jsonlPath: string, raw: string): number => {
  if (!raw) return 0;
  const normalize = backendForPath(jsonlPath).normalizeTranscriptLine;
  const lines = raw.split("\n").filter((l) => l.trim());
  for (let i = lines.length - 1; i >= 0; i--) {
    let row;
    try { row = normalize(JSON.parse(lines[i]!)); } catch { continue; }
    const u = row?.message?.usage;
    if (!u) continue;
    const rawIn = u.input_tokens ?? 0;
    const cr = u.cache_read_input_tokens ?? 0;
    const cw = u.cache_creation_input_tokens ?? 0;
    // A totalized gateway reports input_tokens = cr+cw+fresh; Anthropic-native
    // keeps the three disjoint (input_tokens = fresh only). The data signal —
    // input_tokens alone covering both cache tiers — identifies the totalized
    // shape without betting on a model-name dialect (deepseek-v4-flash is a
    // totalized gateway but has no digit-dot in its name). Same reconciliation
    // the mirror + usage accounting use.
    return rawIn >= cr + cw ? rawIn : rawIn + cr + cw;
  }
  return 0;
};

/** The two clocks keepalive actually needs, read from MESSAGE-turn timestamps —
 *  never from file mtime. Claude Code appends `file-history-snapshot` / `ai-title`
 *  / `mode` / `permission-mode` lines that carry no `timestamp` yet bump the file
 *  mtime; keying the schedule off mtime lets that non-conversational churn fake
 *  "activity", resetting the idle clocks and pinning a long-dead session in an
 *  endless keepalive loop. Deriving from turns kills that at the source.
 *   `lastMs`     newest user/assistant turn (real OR our own ping) — the prompt-cache
 *                warmth clock; only a real model request actually re-warms the cache.
 *   `lastRealMs` newest GENUINE turn (non-keepalive) — the real-idle cutoff; 0
 *                when none sits in the read window ⇒ real work predates the tail.
 *   `stamped`    false when no turn carried a timestamp (backend without them), so
 *                the caller can fall back to mtime instead of judging all idle. */
export const keepaliveStamps = (
  jsonlPath: string,
  pingSigs: string[],
): { lastMs: number; lastRealMs: number; stamped: boolean } => {
  const turns = tailTurns(jsonlPath, 24);
  // Every warmer ping now carries the full instruction; a stall-recovery ping
  // carries a different one. Match every injected form (`pingSigs` = normalized
  // prefixes of each) plus the bare "ping" that streak pings used to shrink to
  // (transcripts written before that changed still hold them) — otherwise a
  // keepalive user line reads as REAL activity and re-anchors lastRealMs /
  // resets the round counter before the model has even replied.
  const isPing = (t: Turn): boolean => t.role === "user" && isKeepalivePingText(t.text, pingSigs);
  let lastMs = 0;
  let lastRealMs = 0;
  let stamped = false;
  // "After a ping" persists across EVERY assistant turn until the next user
  // turn: CodeBuddy splits one model reply into multiple independent message
  // records (mid-turn narration + final), so strict ping→assistant adjacency
  // would let the 2nd record of a pong read as REAL activity and reset the
  // round budget.
  let afterPing = false;
  for (let i = 0; i < turns.length; i++) {
    const t = turns[i]!;
    const ms = t.ms ?? 0;
    if (ms > 0) stamped = true;
    if (ms > lastMs) lastMs = ms;
    // Keepalive = ping query + whatever the model replies to it. Detection is
    // purely query-based: if the user turn is a ping, the assistant reply is
    // keepalive too — even when the model adds extra content beyond "pong".
    const isKeepalive = isPing(t) || (afterPing && t.role === "assistant");
    if (t.role === "user") afterPing = isPing(t);
    if (ms > lastRealMs && !isKeepalive) lastRealMs = ms;
  }
  return { lastMs, lastRealMs, stamped };
};

// ── Pane liveness ─────────────────────────────────────────────────────
// "Is this agent still working?" answered from outside the process. The pane is
// the only honest source: transcript mtime goes quiet during long tool calls,
// and a pane that merely *exists* says nothing about what it's doing.
//
// Every agent TUI renders a spinner footer just above the input box while a turn
// is in flight, and the shape has churned across versions:
//   ✢ Moonwalking… (12m 31s · ↓ 41.7k tokens · thought for 3s)   ← current
//   ✳ Thinking… (8s · esc to interrupt)                          ← older
// So match on either signal: the elapsed-timer parenthetical after an ellipsis,
// or a literal interrupt hint. Both only ever appear while generating.
//
// Only the footer region is searched (last few non-blank rows). Assistant prose
// scrolled just above the box can quote an elapsed time; the footer cannot lie.
const SPINNER_RE = /\S*…\s*\((?:\d+h\s*)?(?:\d+m\s*)?\d+(?:\.\d+)?s\b/;
const BUSY_MARKERS = [SPINNER_RE, /esc to interrupt/i, /按\s*esc[^\n]*中断/, /esc\s*中断/i];
const FOOTER_ROWS = 8;

export const paneIsBusy = (paneText: string): boolean =>
  stripAnsi(paneText)
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(-FOOTER_ROWS)
    .some((l) => BUSY_MARKERS.some((re) => re.test(l)));

// A turn that died mid-work leaves an error/limit banner and drops back to an
// idle prompt (no spinner). This is the ONLY footer state where keepalive should
// nudge the model to resume instead of just warming the cache. Not-busy is part
// of the definition: a live auto-retry spinner is the CLI already recovering, so
// we stay out of its way. Searched over a wider window than the spinner — the
// error text can sit a few rows above the reclaimed input box.
const STALL_MARKERS = [
  /API Error/i, /request (failed|timed ?out)/i, /overloaded/i, /server error/i,
  /rate.?limit/i, /usage limit/i, /too many requests/i, /quota/i,
  /请求过多/, /限流|超过.{0,4}限制|额度不足|额度已/, /接口.{0,4}(失败|错误|超时)/, /连接(超时|中断|失败)/, /稍后.{0,4}重试/,
];
const STALL_ROWS = 16;
export const paneIsStalled = (paneText: string): boolean => {
  if (paneIsBusy(paneText)) return false;
  return stripAnsi(paneText)
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(-STALL_ROWS)
    .some((l) => STALL_MARKERS.some((re) => re.test(l)));
};

// Session-log side of the same signal, and the more reliable one: Claude Code
// writes a synthetic `<model>` assistant line when a turn dies — "You've hit your
// session limit …", "API Error: Connection closed mid-response …". If the LAST
// assistant turn is one of those, the turn died mid-work and nothing recovered
// it. Gated on brevity (these are always short one-liners) so a long assistant
// message merely *discussing* an error can't false-trigger.
const STALL_TEXT_MARKERS = [
  /^API Error/i, /hit your (session|usage) limit/i, /session limit/i, /usage limit/i,
  /rate.?limit/i, /overloaded/i, /too many requests/i, /mid-(response|stream)/i,
  /连接(超时|中断|失败)/, /请求过多/, /额度(不足|已)/, /稍后.{0,4}重试/,
];
export const transcriptStalled = (jsonlPath: string): boolean => {
  const turns = tailTurns(jsonlPath, 4);
  for (let i = turns.length - 1; i >= 0; i--) {
    const t = turns[i]!;
    if (t.role !== "assistant") continue; // judge only the newest assistant turn
    const txt = t.text.trim();
    return txt.length > 0 && txt.length < 240 && STALL_TEXT_MARKERS.some((re) => re.test(txt));
  }
  return false;
};

/** Trim a captured pane to its last `rows` non-blank lines — the TUI pads the
 *  viewport with empties that would otherwise dominate a WeCom bubble. */
export const compactPane = (paneText: string, rows = 24): string =>
  stripAnsi(paneText)
    .split("\n")
    .map((l) => l.replace(/\s+$/, ""))
    .filter((l) => l.trim())
    .slice(-rows)
    .join("\n");

// ── 提到别的 wizard ───────────────────────────────────────────────────
// 入站路由只吃掉消息里**第一个** `#tag` —— 那个决定这条消息进谁的输入框。其余的
// `#tag` 原样流过去, 而那正是用户指着另一个 wizard 说话的地方: 「让 #b 也看一眼」
// 「把 #fix 的结论拿过来」。收到消息的 wizard 眼里只有一个光秃秃的 token, 上下文
// 里没有任何东西说明它是一个**活着的同类**, 于是它替 #b answered 了 (或者把它读
// 成 issue 号), 而不是去叫它。
//
// 在边界上给这个 mention 加注, 就是把 `#b` 变成「wizard b」的那一步。加注只对
// 已经能通过 send_peer/peek_peer 同一套查找解析出来的 tag 发生, 所以它永远不会
// 广告一个调不通的地址 —— 解析不出来的 `#123` / `#L45` 静静穿过去。
export interface PeerMention {
  /** Tag as written, without `#`. */
  tag: string;
  /** Resolved session key, e.g. `chat:wrxxx#b`. */
  target: string;
  /** Canonical string to hand the peer tools — the bare tag for a sibling,
   *  `chatName#tag` for a session in another (named) chat. */
  address: string;
  /** Lives in a DIFFERENT chat. */
  foreign: boolean;
  /** That chat's name; "" when it has none. */
  chat: string;
  label: string;
  cwd: string;
  /** Session doesn't exist yet — chat name resolved but no running session. */
  unborn?: boolean;
}

/** Machinery, not conversation: the `<system-reminder>` wrapper is the same
 *  marker the mirror's meta-stripper and `tailTurns` already drop, so the hint
 *  reaches the agent's context without leaking into WeCom bubbles or peer
 *  summaries. Empty string for no mentions — appending it stays a no-op. */
export const renderPeerMentionHint = (mentions: readonly PeerMention[]): string => {
  if (mentions.length === 0) return "";
  const live = mentions.filter((m) => !m.unborn);
  const unborn = mentions.filter((m) => m.unborn);
  const lines = live.map(
    (m) =>
      `- \`#${m.tag}\` ${m.label} —— 一个活着的 wizard, 住在${m.foreign ? `**另一个**聊天${m.chat ? ` (\`${m.chat}\`)` : ""}` : "你这个聊天"}` +
      ` (target \`${m.target}\`${m.cwd ? `, 工作区 ${m.cwd}` : ""}), 地址 "${m.address}"。`,
  );
  const unbornLines = unborn.map(
    (m) =>
      `- \`${m.address}\` —— 指的是聊天 "${m.chat}" 里的 "#${m.tag}", 但那个 wizard **还不存在**。` +
      ` 先把它造出来: new_claude_session({ chat: "${m.chat}", tag: "${m.tag}", cwd: "<项目路径>" }) (白纸一张),` +
      ` 或者 spawn_clone 让它继承你此刻的上下文; 然后 send_peer("${m.address}", "<活>") 派活。`,
  );
  const parts: string[] = [
    "",
    "<system-reminder>",
  ];
  if (lines.length > 0) {
    parts.push(
      "上面这条消息里的 `#tag` 点的是**别的 wizard**, 不是字面文本:",
      ...lines,
    );
  }
  if (unbornLines.length > 0) {
    parts.push(
      "下面这些 `聊天名#tag` 形式的地址指向还不存在的 wizard:",
      ...unbornLines,
    );
  }
  parts.push(
    "用户要你把它们拉进来、看看它们在干嘛、或者把话带到时, 去叫它们, 别猜、更别替它们回答:",
    "peek_peer(address) 读它最近的对话, send_peer(address, text) 派活或推它一把, wait_peer(address) 等它闲下来,",
    "wizard_roster() 看全体 wizard 的名字/职责/家谱。地址原样用上面给的那个 —— 同一个聊天里是裸 tag,",
    "别的聊天里是 `聊天名#tag`。你跟它们说的话会以 `你 → 它` 的气泡出现在群里, 所以直说、别复述。",
    "只是提了一嘴、并没有要你去找它 (\"#b 说的那个方案\") 就不必调工具 —— 看用户到底要什么。",
    "</system-reminder>",
  );
  return parts.join("\n");
};

// ── 同伴模型 ──────────────────────────────────────────────────────────
// 一行 = 一个 wizard 此刻的可观测状态。名字/职责/家谱不在这里 (那些在注册表里,
// 由 index.ts 的 roster 贴上来) —— 这一层只回答"它在不在、忙不忙、刚在干嘛"。
export interface PeerInfo {
  /** Full session key, e.g. `chat:wrxxx#fix`. */
  target: string;
  /** `#tag` suffix; "" for the chat's default session. */
  tag: string;
  /** Name of the chat this session lives in; "" when that chat is unnamed. */
  chat: string;
  /** Exactly what to pass to peek_peer / send_peer / wait_peer to hit this
   *  session from the caller's own: bare tag for a sibling, `chatName#tag`
   *  across chats. */
  address: string;
  /** Stable animal emoji (same glyph the approval cards use). */
  label: string;
  sessionId: string;
  jsonlPath: string;
  cwd: string;
  cli: CliBackendName;
  /** `--model` slug this session runs on; "" = the CLI's own default. */
  model: string;
  tmuxPane: string;
  /** Bridge holds a live attachment (vs. a persisted-but-cold binding). */
  attached: boolean;
  /** tmux pane still exists — false means the session needs a respawn to talk to. */
  paneAlive: boolean;
  /** Mid-turn right now (spinner visible in the pane). */
  busy: boolean;
  /** Transcript mtime (ms); 0 when the session hasn't written yet. */
  lastActivity: number;
  summary: string;
  /** 调用方自己 —— wizard 不该驱动自己。 */
  self: boolean;
}
