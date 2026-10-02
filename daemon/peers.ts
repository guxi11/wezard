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
import { truncate, truncateWithCount } from "../shared/std.js";
import { isKeepalivePingText, withoutKeepalive } from "../shared/keepalive.js";
import { envelopeAttrs, parseEnvelope, renderReminder, type Envelope, type ReceiptStatus } from "../shared/reminder.js";

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
  /** 这一句挂着的信封 (谁说的、在哪说的); 没挂 = 人在这个会话的 home 聊天里说的。 */
  env?: Envelope;
  /** Wall-clock epoch ms from the line's own `timestamp`; 0 if absent/unparsable.
   *  Lets keepalive anchor realIdle to a message's actual time, not file mtime. */
  ms?: number;
  /** assistant 的中途句: 这条 message 以工具调用收尾 (stop_reason=tool_use), 后面还有
   *  话, 不可能是这一轮的终句。后端不写 stop_reason (codebuddy) 就不标。 */
  mid?: true;
  /** CLI 自己插进来的一行 user (后台任务完成的 `<task-notification>`): 没有话, 但它
   *  起了新的一轮 —— 只有要按 user 行切轮的调用方 (`marks`) 才拿得到。 */
  notice?: true;
  /** CLI 自己合成的报错回复 (`isApiErrorMessage`: "API Error: …"), 不是模型说的话。 */
  apiError?: true;
}

// Meta wrappers Claude Code injects around slash commands / hook output. They
// are machinery, not conversation — drop them before any summary or handoff.
const META_RE = /<(system-reminder|command-[^>\s]*|local-command-[^>\s]*|task-notification)(?:\s[^>]*)?>[\s\S]*?<\/\1>/g;

// Claude Code (2.1.27x+) 把折叠成 `[Pasted text #N]` 的粘贴在 transcript 里包成
// `<pasted_content id="…">…</pasted_content id="…">`。wezard 的注入走 tmux paste, 所以
// **每一条多行注入** (人在企微里说的、同伴派的、定时任务放的) 落盘时都带着这层壳。
// 壳是传输的产物不是内容: 只剥标签, 里面的话原样留下。
const PASTED_TAG_RE = /<pasted_content id="[^"]*">\n?|\n?<\/pasted_content(?:\s+id="[^"]*")?>/g;
export const unwrapPasted = (s: string): string => s.replace(PASTED_TAG_RE, "");
/** 一段落盘的输入 → 人真正说的那句话: 去粘贴壳, 去信封 / 名册增量 / slash 包装。 */
export const stripMeta = (s: string): string => unwrapPasted(s).replace(META_RE, "");

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
export const tailTurns = (jsonlPath: string, n = 3, keepLines = false): Turn[] =>
  readTailUntil(jsonlPath, (raw) => parseTurns(jsonlPath, raw, keepLines), (ts) => ts.length >= n).slice(-n);

/** `tailTurns` 去掉保温 ping/pong 之后的最后 `n` 轮 —— 凡是交给另一个 wizard (或人)
 *  **读**的都走这里: 挂机一晚的会话尾巴上全是 ping/pong, 照 tailTurns 数出来的
 *  「最近 6 轮」一句真话都没有, 「最后一条回复」是一个 pong。`pingSigs` 只给保温
 *  那一种 —— resumePing ("continue") 之后模型是真的在干活, 那一轮不能丢。 */
export const talkTurns = (jsonlPath: string, n: number, pingSigs: readonly string[] = [], keepLines = false, marks = false): Turn[] => {
  const clean = (ts: Turn[]): Turn[] => withoutKeepalive(ts, pingSigs);
  return clean(readTailUntil(jsonlPath, (raw) => parseTurns(jsonlPath, raw, keepLines, marks), (ts) => clean(ts).length >= n)).slice(-n);
};

/** 一个会话的来回, 每个来回 = 一句问话 + 它之后的全部回答 (途中的话在前, 终句在
 *  最后), 旧的在前。读多深由时间窗定, 调用方再按时刻与条数裁:
 *    给了 `since` → 一直读到比它更早的那一句 (窗口内的一句不漏);
 *    没给        → 读到 `until` 之前攒够 `rounds` 个来回为止。
 *  多读一个问话才停, 所以留下的最早一组是完整的; 开头那组若没有问话 (问话落在
 *  读到的范围之外) 就丢掉 —— 一句不知道在答谁的话没法归到任何频道。 */
export const talkRounds = (
  jsonlPath: string,
  rounds: number,
  pingSigs: readonly string[] = [],
  win: { since?: number; until?: number } = {},
): Turn[][] => {
  const { since, until = Infinity } = win;
  const clean = (ts: Turn[]): Turn[] => withoutKeepalive(ts, pingSigs);
  const enough = (ts: Turn[]): boolean => {
    const seen = clean(ts).filter((t) => (t.ms ?? 0) < until);
    return since !== undefined
      ? seen.length > 0 && (seen[0]!.ms ?? 0) < since
      : seen.filter((t) => t.role === "user").length > rounds;
  };
  return clean(readTailUntil(jsonlPath, (raw) => parseTurns(jsonlPath, raw, true), enough))
    .reduce<Turn[][]>((acc, t) => {
      if (t.role === "user" || acc.length === 0) acc.push([t]);
      else acc[acc.length - 1]!.push(t);
      return acc;
    }, [])
    .filter((round) => round[0]!.role === "user");
};

/** 纯解析: 一段 transcript 原文 → 里面的对话轮次。`keepLines` 保留换行 —— 摘要与
 *  预览要压成一行, 但交给另一个 wizard 读的回复不能: 表格 / 列表 / 代码块压成一行
 *  之后对模型就是一团字。`marks` 把 CLI 自插的 user 行留成空的 `notice` 轮 (见 Turn)。 */
const parseTurns = (jsonlPath: string, raw: string, keepLines = false, marks = false): Turn[] => {
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
      const raw = blockText(row.message?.content);
      const bare = stripMeta(raw);
      const env = role === "user" ? parseEnvelope(raw) : undefined;
      const text = (keepLines ? bare : bare.replace(/\s+/g, " ")).trim();
      // Claude writes ISO timestamp strings; CodeBuddy writes epoch-ms NUMBERS.
      // Date.parse(number) coerces to a bare digit-string and returns NaN —
      // which silently stamped every CodeBuddy turn ms=0, degraded
      // keepaliveStamps to mtime fallback, and let the keepalive's own ping
      // writes (plus snapshot/summary churn) read as REAL activity that reset
      // the round budget without bound.
      const rawTs = (parsed as { timestamp?: unknown }).timestamp;
      const ms = typeof rawTs === "number" ? rawTs : Date.parse(String(rawTs ?? ""));
      const mid = role === "assistant" && row.message?.stop_reason === "tool_use";
      if (!text && marks && role === "user" && raw.includes("<task-notification")) return [{ role, text: "", ms: Number.isNaN(ms) ? 0 : ms, notice: true } as Turn];
      const apiError = role === "assistant" && (parsed as { isApiErrorMessage?: unknown }).isApiErrorMessage === true;
      return text ? [{ role, text, ms: Number.isNaN(ms) ? 0 : ms, ...(env ? { env } : {}), ...(mid ? { mid: true } : {}), ...(apiError ? { apiError: true } : {}) } as Turn] : [];
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

/** The keepalive ping this session's newest words answer: the text of the LAST
 *  user turn when that turn is a ping, else undefined. Read from the transcript
 *  on purpose — "was a keepalive sent" must survive whatever forgot the
 *  in-memory swallow (a daemon reload lands between the ping and its pong, and
 *  the restored tail starts past the ping line). tool_result-only user lines
 *  carry no text and are not turns, so a ping answered through a tool call
 *  still reads as open. */
export const openKeepalivePing = (jsonlPath: string, pingSigs: readonly string[]): string | undefined => {
  const last = tailTurns(jsonlPath, 8).filter((t) => t.role === "user").at(-1);
  return last && isKeepalivePingText(last.text, pingSigs) ? last.text : undefined;
};

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
    const text = stripMeta(blockTextWithTools(row.message?.content)).replace(/\s+/g, " ").trim();
    return text ? [{ role, text }] : [];
  });
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
  const entries = withoutKeepalive(
    readTailUntil(
      jsonlPath,
      (raw) => parseToolEntries(jsonlPath, raw),
      (es) => countTurns(withoutKeepalive(es, pingSigs)) >= n,
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
export const summarizeTail = (jsonlPath: string, n = 3, per = 80, pingSigs: readonly string[] = []): string => {
  if (!existsSync(jsonlPath)) return "(新会话 · 暂无对话)";
  const turns = talkTurns(jsonlPath, n, pingSigs);
  if (turns.length === 0) return "(暂无对话)";
  // 截了就得看得出截了: 裸 slice 出来的半句话, 读的人会当成它就说了这么多。
  return turns.map((t) => `${t.role === "user" ? "你" : "AI"}: ${truncate(stripMd(t.text), per)}`).join(" · ");
};

/** 最近一个来回, 压成一行: `▸ 问话 ◂ 它最新的一句`。名册用它 —— 读名册的是另一个
 *  wizard, summarizeTail 的「你:」在它眼里指的是它自己; 这里用 peek_peer 同款的
 *  箭头, 不指代任何人。没有对话 = ""。 */
export const lastExchange = (jsonlPath: string, per = 80, pingSigs: readonly string[] = []): string => {
  const round = talkRounds(jsonlPath, 1, pingSigs).at(-1);
  if (!round) return "";
  const line = (t: Turn): string => truncate(stripMd(t.text), per);
  return [`▸ ${line(round[0]!)}`, ...(round.length > 1 ? [`◂ ${line(round.at(-1)!)}`] : [])].join(" ");
};

/** 这个会话最近一次应答用的模型 —— transcript 里记的是真正跑的那个, 而绑定里的
 *  `model` 只在有人显式选过时才有 (用 CLI 默认模型的会话那里是空的)。 */
export const lastModel = (jsonlPath: string): string =>
  readTailUntil(jsonlPath, (raw) => pickModel(jsonlPath, raw), (v) => v !== "");

const pickModel = (jsonlPath: string, raw: string): string => {
  const normalize = backendForPath(jsonlPath).normalizeTranscriptLine;
  const lines = raw.split("\n").filter((l) => l.trim());
  for (let i = lines.length - 1; i >= 0; i--) {
    let row;
    try { row = normalize(JSON.parse(lines[i]!)); } catch { continue; }
    const model = row?.message?.role === "assistant" ? row.message.model ?? "" : "";
    // `<synthetic>` 是 CLI 自己写的报错行 (限流 / 断连), 不是模型。
    if (model && !model.startsWith("<")) return model;
  }
  return "";
};

/** Readable multi-turn rendering of a transcript tail — "what has been said in
 *  that session", for one agent reading another's conversation. Strictly better
 *  than a pane capture for *reading*: whole messages (the viewport truncates),
 *  no ANSI / TUI chrome, already role-tagged. The pane remains the only honest
 *  source for `busy`. The newest turn gets `lastPer` — it is the one a reader
 *  came for (the peer's latest answer), so it is clipped last and in the middle. */
export const renderDialog = (turns: readonly Turn[], per = 800, lastPer = per): string =>
  turns
    .map((t, i) => `${t.role === "user" ? "▸" : "◂"} ${i === turns.length - 1 ? clipMiddle(t.text, Math.max(per, lastPer)) : truncateWithCount(t.text, per)}`)
    .join("\n");

/** 这个会话此刻悬着的工具调用 (发了 tool_use、还没等到 tool_result) 的名字。
 *
 *  peek 从前靠刮终端回答「它卡在哪」; transcript 答得更准: 一个不在转圈、却悬着
 *  工具调用的会话, 就是停在审批卡 / 本地弹窗上等人点。一句新的人话会让没收到结果
 *  的调用作废 (被打断的那些), 所以遇到带正文的 user 行就清空。 */
export const openToolUses = (jsonlPath: string): string[] =>
  readTailUntil(jsonlPath, (raw) => parseOpenTools(jsonlPath, raw), (r) => r.rows > 0).names;

const parseOpenTools = (jsonlPath: string, raw: string): { names: string[]; rows: number } => {
  const normalize = backendForPath(jsonlPath).normalizeTranscriptLine;
  const open = new Map<string, string>();
  let rows = 0;
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let row;
    try { row = normalize(JSON.parse(line)); } catch { continue; }
    const content = row?.message?.content;
    if (!row || row.isMeta || row.isSidechain || !content) continue;
    rows++;
    if (row.message?.role === "user" && stripMeta(blockText(content)).trim()) open.clear();
    if (!Array.isArray(content)) continue;
    for (const b of content) {
      if (b.type === "tool_use" && b.id) open.set(b.id, b.name ?? "?");
      if (b.type === "tool_result" && b.tool_use_id) open.delete(b.tool_use_id);
    }
  }
  return { names: [...open.values()], rows };
};

/** 交付收口行。
 *
 *  fan-out 之后 join 的载荷是「最后一条 assistant 文本」, 而一个分身的最后一句可能
 *  是"好的我开始了", 也可能是八百字散文 —— 两种都没法直接汇总。对法与 graph 的
 *  `until` 哨兵同源: 不改 CLI 的输出格式 (改不了), 只在派活的提示里要求收口成一行
 *  `RESULT: …`, 这里把它捞出来。取**最后一个**匹配 —— 中间复述过这个格式的那些
 *  不算数。捞不到返回 "", 调用方退回整段 lastText, 所以不遵守约定也只是退化。 */
export const extractResult = (text: string, max = 800): string => {
  // 标记之后的**全部**内容, 而不是"那一行" —— 结论常常不止一行 (路径一行、说明
  // 一行)。约定是收口在最后, 所以标记之后剩下的就是结论。取最后一个匹配: 模型常
  // 先复述一遍格式要求再给答案。
  const hits = [...text.matchAll(/(?:^|[\s>*|-])(?:RESULT|结论)\s*[:：]\s*/gim)];
  const last = hits[hits.length - 1];
  return last ? text.slice((last.index ?? 0) + last[0].length).trim().slice(0, max) : "";
};

/** The peer's most recent assistant message — the handoff payload when one
 *  agent drives another ("take #fix's conclusion and review it"). */
export const lastAssistantText = (jsonlPath: string, max = 4000, pingSigs: readonly string[] = []): string =>
  truncate(talkTurns(jsonlPath, 40, pingSigs).filter((t) => t.role === "assistant").at(-1)?.text ?? "", max);

/** 掐中间: 来龙去脉在头、结论在尾, 超长时丢的该是中段。(从尾巴截会把收口那一行
 *  截掉 —— 而那恰恰是对方最想读的。) */
export const clipMiddle = (s: string, max = 4000, head = Math.floor(max / 4)): string =>
  s.length <= max ? s : `${s.slice(0, head)}\n…(略 ${s.length - max} 字)…\n${s.slice(head - max)}`;

/** `sinceMs` 之后这个会话最新的一条回复, 全文、保留换行 —— wait_peer 的载荷。
 *
 *  「最后一条 assistant 文本」本身不带归属: 那句话没被接住、或者它停在一个等人点
 *  的弹窗上时, 最后一条是**上一件事**的答案, 原样交回去就是拿旧结论冒充新结论。
 *  发话时刻是最便宜的关联 id (A2A 的 taskId 在这里的等价物): 早于它的一律不算。
 *  没有时间戳的行 (ms=0) 无从判断, 放行 —— 退化成旧行为, 而不是把回复吞掉。
 *  保温的 pong 不算回复: 它比真正的答案晚, 不剔掉的话等的人拿到的就是一个 "pong"。 */
export const lastReply = (jsonlPath: string, sinceMs = 0, pingSigs: readonly string[] = []): string =>
  talkTurns(jsonlPath, 40, pingSigs, true, true)
    .filter((t) => t.role === "assistant" && (!t.ms || t.ms >= sinceMs))
    .at(-1)?.text ?? "";

/** 报错之后叫它接着干的那一句 (keepalive 的 resumePing 默认就是 `continue`)。 */
const RESUME_RE = /^(?:continue|go on|resume|继续|接着(?:干|做)?)[\s.!。！]*$/i;

/** paste 到那一行落盘之间的抖动 —— 问话的时间戳可能比我们记的发话时刻早一点。 */
const ASK_SLACK_MS = 60_000;

/** 「`from` 那一句的回答」—— 比 lastReply 严一档, 自动回执靠它定位。
 *
 *  发话时刻 (lastReply 的 sinceMs) 分不开两件事: 目标正忙时我们这一句是排队的,
 *  它先吐出来的是**上一件事**的结论, 而那条回复同样晚于我们 paste 的时刻 —— 按时刻
 *  取就会拿旧结论当新回执。信封是更硬的锚: 我们注入的那一句在它的 transcript 里挂着
 *  `kind=peer from=.我`, 从那一句往后数, 答的就一定是我们问的。找不到那一句 (还排在
 *  输入框里没读进) 返回 `undefined`; 找到了问话但它后面还没有回答返回 "" —— 两种都要
 *  接着等, 绝不能退回按时刻取把上一件事的结论当成这一次的回执 (receipts 只用前者分辨
 *  「它在忙前面的轮」与「读进了却没答」)。 */
export const replyToPeer = (
  jsonlPath: string,
  fromName: string,
  sinceMs = 0,
  pingSigs: readonly string[] = [],
): PeerReply | undefined => {
  const r = answerOf(talkTurns(jsonlPath, 80, pingSigs, true, true), fromName, sinceMs);
  return r && { text: r.text, ...(r.error ? { error: true } : {}) };
};

/** 一句的回答。`error` = 那一轮以 CLI 报错收尾 (`text` 就是那句 "API Error: …") ——
 *  它没答完, 不能当结论投回去。 */
export interface PeerReply { text: string; error?: true }

/** 交接那一刻, `from` 那一句在旧会话里**收口**了没有 —— 比 replyToPeer 再严一档。
 *
 *  自我交接是在某一轮**中途**调的: 那一轮最后一条 assistant 是"已交接"之类的收尾,
 *  不是答案。所以只认在 `untilMs` 之前就被下一句 user 行关上的那一轮: 问话那一轮
 *  还开着 (就是交接这一轮) → "", 这份回执的义务跟着简报转进新会话。三态同 replyToPeer。 */
export const replyClosedBefore = (
  jsonlPath: string,
  fromName: string,
  sinceMs: number,
  untilMs: number,
  pingSigs: readonly string[] = [],
): string | undefined => {
  const r = answerOf(talkTurns(jsonlPath, 80, pingSigs, true, true), fromName, sinceMs);
  return r && (r.closedAt !== undefined && r.closedAt < untilMs && !r.error ? r.text : "");
};

/** `from` 那一句 (发话时刻之后最新的那次) 所在那一轮的终句。答案止于**下一句 user 行**:
 *  这一轮还开着、最后一句又是中途句 (`mid`, 后面跟着工具调用) → 还没答完, 回 "" 让调用方
 *  接着等 —— 忙闲判定会在长工具调用 / 生成的间隙误报一次「闲了」, 那时取到的是
 *  「开始读文件」这种开场白, 不是结论。被下一句 user 行关上的就照取最后一句 (中途被打断)。
 *  那是另一轮的开始 (同伴的新话、回执、人) —— 不截的话, 答方刚说完紧接着收到一份回执、
 *  回了句「收到」, 发话方拿到的就是这句。后台任务完成的通知 (`notice`) 同样起新一轮
 *  —— 不截的话回执拿到的是「（后台任务已完成）」。CLI 在一轮中途吃进的排队消息记成
 *  `attachment`, 不是 user 行, 截不断一轮。`closedAt` = 关上这一轮的那一行的时刻
 *  (还开着 = undefined)。
 *  例外: 以 CLI 报错 (`apiError`) 收尾之后紧跟的那句**没有信封**、只是叫它接着干的
 *  user 行 (保温的 `continue` 续跑、或人敲的「继续」) 是在续这一轮, 不切 —— 否则续跑
 *  出来的答案永远定位不到, 回执只拿得到那句报错。人说的别的话照样切: 那是一件新事,
 *  它的答案不能当回执投出去。`error` = 终句是报错。 */
const answerOf = (
  ts: readonly { role: string; text: string; ms?: number; mid?: true; apiError?: true; notice?: true; env?: { kind: string; from: string } }[],
  fromName: string,
  sinceMs: number,
): { text: string; closedAt?: number; error?: true } | undefined => {
  const asked = ts.reduce(
    (hit, t, i) =>
      t.role === "user" && t.env?.kind === "peer" && t.env.from === fromName && (!t.ms || t.ms >= sinceMs - ASK_SLACK_MS)
        ? i
        : hit,
    -1,
  );
  if (asked < 0) return undefined;
  const resumes = (t: (typeof ts)[number], i: number): boolean =>
    !!ts[i - 1]?.apiError && !t.env && !t.notice && RESUME_RE.test(t.text.trim());
  const next = ts.findIndex((t, i) => i > asked && t.role === "user" && !resumes(t, i));
  const last = ts.slice(asked + 1, next < 0 ? undefined : next).filter((t) => t.role === "assistant").at(-1);
  const text = last && !(last.mid && next < 0) ? last.text : "";
  return { text, ...(next < 0 ? {} : { closedAt: ts[next]!.ms ?? 0 }), ...(text && last?.apiError ? { error: true } : {}) };
};

// ── wizard → wizard 的信封 ────────────────────────────────────────────
// 同伴的话是原样落进输入框的, 而落进输入框的东西在模型眼里都是「用户说的」。没有
// 信封, 收件方分不清这一轮是人说的还是 wizard 说的、回复给谁看、该不该回话 ——
// 于是对着 wizard 寒暄、把过程 notify 进群、或者 send_peer 回去 (发话方正挂在
// wait_peer 上, 这一回会给它多排一轮, 两边就此乒乓)。信封把这三件事写在每一轮
// 自己身上: 宪章是出生时的快照, 正在跑的老 wizard 读不到新规矩, 这一段读得到。
// 与 mention hint / 名册增量同一个 `<system-reminder>` 壳 —— mirror 的 meta 剥离器
// 和 tailTurns 都会丢掉它, 不进气泡、不进 rolepage、不进 peek。
//
// 信封同时是 transcript 里**唯一**记着「这句话是谁、在哪个频道说的」的地方: 会话的
// jsonl 只知道输入框里进过什么。read_chat 就靠把它读回来 (parseEnvelope) 在各个
// 会话的 jsonl 之间拼出一个群 / 一段私聊的记录。事实写在开标签的属性上 (见
// shared/reminder.ts), 正文只是给模型的规矩 —— 改措辞不影响解析; 老措辞在那边认。
export { parseEnvelope, type Envelope };

/** 人说的那一轮的信封。只在 transcript 自己推不出来时才挂 (见 inbound.send): 一个
 *  wizard 被人从别的群叫到、或者住在多人的群里, 它和后来读记录的人都得知道这句是
 *  谁、在哪说的; 住在与一个人的单聊里的, 默认值就是对的, 不为它每轮多付一段。 */
export const renderHumanEnvelope = (user: string, chat: string): string =>
  renderReminder(envelopeAttrs.human(user, chat), [`这一轮是 \`${user}\` 在群 **${chat}** 里说的, 你的回复发回那个群。`]);

/** 定时任务放的那一轮: 不标的话, 记录里它就成了「人说的」。 */
export const renderTaskEnvelope = (taskId: string): string =>
  renderReminder(envelopeAttrs.task(taskId), [`这一轮是定时任务 \`${taskId}\` 到点放进来的, 不是人此刻说的 —— 照常执行, 回复照常发进群。`]);

/** `from` = 发话方的称呼 (`.name`); `chat` 给了 = 公开轮 (那个群的名字, 可以是 ""),
 *  不给 = 私聊。 */
export const renderPeerEnvelope = (from: string, chat?: string): string =>
  renderReminder(envelopeAttrs.peer(from, chat), chat === undefined
      ? [
          `这一轮是 wizard \`${from}\` 发来的**私聊**, 不是人说的: 人看不见这一轮, 读你回复的是 \`${from}\`。`,
          `你这一轮的**最后一条消息**就是给它的回执 —— 你一停下, 守护进程自动把它送进 \`${from}\` 的输入框, **你不需要再调任何工具**: 不要 send_peer 回它 (那会让它多跑一轮), 也不要为这一轮 notify。`,
          "对 wizard 直说: 不寒暄、不加对人的称呼、不复述它的话; 结论收口成末尾的 `RESULT: …` (交付物写进文件就回传路径), 要它补信息也写在那里。",
        ]
      : [
          `这一轮是 wizard \`${from}\` 在群${chat ? ` **${chat}** ` : ""}里**公开**对你说的: 你的回复会直接发进那个群, 人和 \`${from}\` 都看得到。`,
          `照对人说话的方式答; 不要再 send_peer 把同一段话回给 \`${from}\` —— 你停下之后守护进程会自动把这段结论送回它那里。`,
        ]);

/** 回执的信封 —— 这一轮是对方干完活、守护进程自动送回来的结论, 不是新派的活。
 *
 *  为什么必须有它: 回执是原样 paste 进输入框的, 而落进输入框的东西在模型眼里都是
 *  「有人在对我说话」。没有这一段, 它会把一份结论当成一件新活去做, 或者客气地回它
 *  一句 —— 而回那一句又会被对方当成新的一轮。所以这里写死三件事: 这是回执、原话在
 *  下面、读完接着干你自己的, 别回话。 */
export const renderReceiptEnvelope = (
  from: string,
  chat?: string,
  job?: { job: string; done: number; total: number },
  status: ReceiptStatus = "done",
): string =>
  renderReminder(envelopeAttrs.receipt(from, chat, job, status), [
    ...(status === "done"
      ? [`这是 wizard \`${from}\` 对你某一次 send_peer 的**回执**: 它那一轮干完了, 守护进程把它的结论自动送到你这里 —— 不是人说的, 也不是新派给你的活。`]
      : status === "error"
        ? [`这是 wizard \`${from}\` 对你某一次 send_peer 的**失败回执**: 它那一轮以 CLI 报错收尾, 下面是报错原文, 不是它的结论, **不计入工单**。它若被续跑、之后答出来, 结论会照常再送来一份; 等不及就 peek_peer 看它, 或者再 tell_peer 它一次。`]
        : [`这是 wizard \`${from}\` 对你某一次 send_peer 的**失败回执**: ${FAILED[status]}, 这一份不会再有答案了 (工单里按已落定计)。自己判断: 换人、再 tell_peer 追问, 或者在汇总里如实写缺了这一份。下面是守护进程的说明和它最后说的一句。`]),
    ...(chat === undefined
      ? [`这段对话是私聊, 人看不见。`]
      : [`这一轮的对话在群${chat ? ` **${chat}** ` : ""}里, 人看得见你们俩。`]),
    ...(status === "done"
      ? [
          "下面就是它的原话。据此接着干你自己手上那件事; **不要为收到回执而回话** —— 不要 send_peer 回它 (除非你确实有新的东西要问它), 也不要把这段原话复述给人, 只说你据此做了什么、结论是什么。",
          "它可能还没干完全部 —— 读 `RESULT:` 那一行 (如果有) 作为它的收口结论; 要更多细节用 peek_peer 读它的对话, 不要猜。",
        ]
      : []),
    // 「齐了吗」是守护进程数的, 不让模型在上下文里自己数 —— 异步回执是 N 个独立
    // 的轮次陆续进来的, 数错一个就会提前收口或者永远等。
    ...(job && job.job
      ? job.done >= job.total
        ? [`这是工单 \`${job.job}\` 的**最后一份** (${job.done}/${job.total}, 全部到齐): 现在可以汇总收口了 —— close_job(summary) 发结论并回收临时分身。`]
        : [`这是工单 \`${job.job}\` 的第 ${job.done}/${job.total} 份, **还差 ${job.total - job.done} 份**: 先把这一份记住 (或落到文件里), 不要现在汇总、也不要向人汇报进度; 等最后一份到了会明确告诉你「全部到齐」。`]
      : []),
  ]);

const FAILED: Record<Exclude<ReceiptStatus, "done" | "error">, string> = {
  timeout: "等到期限它还没答完",
  silent: "它停下了几次, 都没有答这一句",
  dead: "它的 pane 没了 (被收掉或崩了)",
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

/** 这段上下文里读过 / 改过的文件 (旧的在前、去重, 同一文件按最后一次碰它的位置排)。
 *
 *  「它的上下文里装着什么」是可以算出来的事实: 从文件尾往回, 撞上 compact 边界就停
 *  (边界之前的已被压成摘要, 不再原样在窗口里); `/clear` 换了新 jsonl, 天然隔开。
 *  只抽工具参数里的路径, 不看结果 —— 读没读过是事实, 读出了什么另说。窗口给到
 *  1MB: 再往前的东西大概率已不在一个 200k 的上下文里。 */
export const contextFiles = (jsonlPath: string): string[] => {
  const normalize = backendForPath(jsonlPath).normalizeTranscriptLine;
  const lines = readTailBytes(jsonlPath, CONTEXT_FILES_BYTES).split("\n");
  const cut = lines.reduce((at, l, i) => (l.includes('"compact_boundary"') ? i : at), -1);
  const paths = lines.slice(cut + 1).flatMap((line) => {
    if (!line.includes("tool_use")) return []; // cheap prefilter
    let row;
    try { row = normalize(JSON.parse(line)); } catch { return []; }
    const content = row?.message?.content;
    if (!row || row.isSidechain || !Array.isArray(content)) return [];
    return content.flatMap((b) => (b.type === "tool_use" ? toolPaths(b.input) : []));
  });
  // 去重保留最后一次出现的位置。
  return paths.filter((p, i) => paths.lastIndexOf(p) === i);
};

const CONTEXT_FILES_BYTES = 1024 * 1024;

// shell 里读文件 (cat / sed -n / grep) 和 Read 工具一样把内容拉进了上下文, 只是路径
// 藏在命令里: 带扩展名的那些词就是文件。
const SHELL_FILE_RE = /(?:~|\.{0,2}\/)?[\w.\-/]*\w\.[a-z][a-z0-9]{0,4}\b/gi;

const toolPaths = (input: unknown): string[] => {
  if (!input || typeof input !== "object") return [];
  const o = input as Record<string, unknown>;
  const named = ["file_path", "notebook_path", "path"]
    .map((k) => o[k])
    .filter((v): v is string => typeof v === "string" && v.length > 1);
  const shell = typeof o.command === "string" ? o.command.match(SHELL_FILE_RE) ?? [] : [];
  return [...named, ...shell.filter((w) => !/^\d/.test(w)).filter((w) => w.includes("/") || /\.(?:ts|tsx|js|mjs|json|jsonc|md|css|html|py|go|rs|sh)$/.test(w))];
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
 *   `streak`     pings already sent since that last genuine turn — the round
 *                counter's seed. The budget is "N pings after real work", a fact
 *                of the transcript: a counter that lives only in memory restarts
 *                at 0 on every daemon reload and hands the session a fresh N.
 *   `stamped`    false when no turn carried a timestamp (backend without them), so
 *                the caller can fall back to mtime instead of judging all idle. */
export const keepaliveStamps = (
  jsonlPath: string,
  pingSigs: string[],
): { lastMs: number; lastRealMs: number; streak: number; stamped: boolean } => {
  const turns = tailTurns(jsonlPath, 24);
  // Every warmer ping now carries the full instruction; a stall-recovery ping
  // carries a different one. Match every injected form (`pingSigs` = normalized
  // prefixes of each) plus the bare "ping" that streak pings used to shrink to
  // (transcripts written before that changed still hold them) — otherwise a
  // keepalive user line reads as REAL activity and re-anchors lastRealMs /
  // resets the round counter before the model has even replied. What counts as
  // keepalive (the ping AND every record of its reply) is `withoutKeepalive`'s
  // rule — one definition for the clocks, the quote dedup and the peer readers.
  const newest = (ts: readonly Turn[]): number => ts.reduce((m, t) => Math.max(m, t.ms ?? 0), 0);
  const real = withoutKeepalive(turns, pingSigs);
  // Everything past the last genuine turn is keepalive; its user turns are the pings.
  const sinceReal = real.length ? turns.slice(turns.lastIndexOf(real[real.length - 1]!) + 1) : turns;
  // Turns are text-only, so a long tool chain after the last prose line would
  // read as idle — the tool rows are real work and each one touched the cache.
  // A ping's reply is a bare "pong", never a tool call, so they can't be warmer traffic.
  const work = lastToolMs(jsonlPath);
  const pingsAfterWork = work > newest(sinceReal) ? [] : sinceReal;
  return {
    lastMs: Math.max(newest(turns), work),
    lastRealMs: Math.max(newest(real), work),
    streak: pingsAfterWork.filter((t) => t.role === "user").length,
    stamped: turns.some((t) => (t.ms ?? 0) > 0),
  };
};

/** Timestamp of the newest main-thread tool_use / tool_result row in the tail (0 = none). */
const lastToolMs = (jsonlPath: string): number => {
  const normalize = backendForPath(jsonlPath).normalizeTranscriptLine;
  return readTailBytes(jsonlPath, TAIL_BYTES)
    .split("\n")
    .reduce((m, line) => {
      if (!line.includes("tool_")) return m; // cheap prefilter
      try {
        const parsed = JSON.parse(line) as { timestamp?: unknown };
        const row = normalize(parsed);
        if (!row || row.isMeta || row.isSidechain) return m;
        const content = row.message?.content;
        const tooly = Array.isArray(content) && content.some((b) => /^tool_(use|result)$/.test((b as { type?: string })?.type ?? ""));
        const ms = typeof parsed.timestamp === "number" ? parsed.timestamp : Date.parse(String(parsed.timestamp ?? ""));
        return tooly && !Number.isNaN(ms) ? Math.max(m, ms) : m;
      } catch { return m; }
    }, 0);
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
// The CLI's own auto-retry footer (`✻ API error · Retrying in 0s · attempt 2/10`)
// has neither an ellipsis nor a timer parenthetical, yet the turn is still in
// flight — read as idle it both lets keepalive in and trips paneIsStalled's
// /API Error/, so a healthy session gets a stray "continue" queued behind the retry.
const RETRY_RE = /Retrying in \d+(?:\.\d+)?s\b.*attempt \d+\/\d+/i;
const BUSY_MARKERS = [SPINNER_RE, RETRY_RE, /esc to interrupt/i, /按\s*esc[^\n]*中断/, /esc\s*中断/i];
const FOOTER_ROWS = 8;

export const paneIsBusy = (paneText: string): boolean =>
  stripAnsi(paneText)
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(-FOOTER_ROWS)
    .some((l) => BUSY_MARKERS.some((re) => re.test(l)));

// ── Stall: a turn that died mid-work ─────────────────────────────────
// Judged from the transcript's STRUCTURE alone — never from screen text, never
// from what the words say. A pane scan (and a keyword match on reply prose)
// can't tell a banner from a model merely *talking about* "API Error", and every
// false positive hands a healthy session a stray "continue". Exactly two shapes
// count, both "the turn is unfinished" by construction:
//   1. the newest message row is the CLI's own synthetic error reply
//      (`isApiErrorMessage`) — and the turn it killed was real work: one opened
//      by a keepalive ping (or a previous "continue") is not work to resume, and
//      an auth failure is not something "continue" can fix;
//   2. the newest message row is a tool result and nothing followed — the tool
//      finished, the model's next request never produced a line.
// A pending tool_use (tool running / parked on an approval card), a real
// assistant reply, a human interrupt, a local command — all read as not stalled.
// "Quiet for a while" is part of the definition: the newest message row must be
// at least `quietMs` old, so a turn still streaming its next block never counts.
type StallRow = { role: "user" | "assistant"; ms: number; apiError: boolean; toolResult: boolean; text: string };

const stallRows = (jsonlPath: string): StallRow[] => {
  const normalize = backendForPath(jsonlPath).normalizeTranscriptLine;
  return readTailBytes(jsonlPath, TAIL_BYTES)
    .split("\n")
    .flatMap((line): StallRow[] => {
      if (!line.trim()) return [];
      try {
        const parsed = JSON.parse(line) as { timestamp?: unknown; isApiErrorMessage?: unknown };
        const row = normalize(parsed);
        const role = row?.message?.role;
        if (!row || row.isMeta || row.isSidechain || (role !== "user" && role !== "assistant")) return [];
        const content = row.message?.content;
        const blocks = Array.isArray(content) ? (content as { type?: string }[]) : [];
        const ms = typeof parsed.timestamp === "number" ? parsed.timestamp : Date.parse(String(parsed.timestamp ?? ""));
        return [{
          role, ms: Number.isNaN(ms) ? 0 : ms,
          apiError: parsed.isApiErrorMessage === true,
          toolResult: blocks.length > 0 && blocks.every((b) => b?.type === "tool_result"),
          text: stripMeta(blockText(content)).trim(),
        }];
      } catch { return []; } // truncated first line of the tail window
    });
};

export const transcriptStalled = (jsonlPath: string, pingSigs: readonly string[], quietMs: number, now = Date.now()): boolean => {
  const rows = stallRows(jsonlPath);
  const last = rows.at(-1);
  if (!last || !last.ms || now - last.ms < quietMs) return false;
  if (last.toolResult) return true;
  if (!(last.role === "assistant" && last.apiError)) return false;
  if (/\/login\b|log(ged)? ?in|auth/i.test(last.text)) return false;
  const opener = [...rows].reverse().find((r) => r.role === "user" && !r.toolResult);
  return !!opener && !isKeepalivePingText(opener.text, pingSigs);
};

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
  /** Name as written, without `.`. */
  tag: string;
  /** Resolved session key, e.g. `chat:wrxxx#b`. */
  target: string;
  /** Canonical string to hand the peer tools — the wizard's global name. */
  address: string;
  /** Lives in a DIFFERENT chat. */
  foreign: boolean;
  /** That chat's name; "" when it has none. */
  chat: string;
  label: string;
  cwd: string;
}

/** Machinery, not conversation: the `<system-reminder>` wrapper is the same
 *  marker the mirror's meta-stripper and `tailTurns` already drop, so the hint
 *  reaches the agent's context without leaking into WeCom bubbles or peer
 *  summaries. Empty string for no mentions — appending it stays a no-op. */
export const renderPeerMentionHint = (mentions: readonly PeerMention[]): string => {
  if (mentions.length === 0) return "";
  const lines = mentions.map(
    (m) =>
      `- \`.${m.tag}\` ${m.label} —— 一个活着的 wizard, 住在${m.foreign ? `**另一个**聊天${m.chat ? ` (\`${m.chat}\`)` : ""}` : "你这个聊天"}` +
      ` (target \`${m.target}\`${m.cwd ? `, 工作区 ${m.cwd}` : ""}), 地址 "${m.address}"。`,
  );
  return renderReminder({ wezard: "mention", names: mentions.map((m) => `.${m.tag}`).join(" ") }, [
    "上面这条消息里的 `.name` 点的是**别的 wizard**, 不是字面文本:",
    ...lines,
    "用户要你把它们拉进来、看看它们在干嘛、或者把话带到时, 去叫它们, 别猜、更别替它们回答:",
    "peek_peer(address) 读它最近的对话, send_peer(address, text) 派活或推它一把, wait_peer(address) 等它闲下来,",
    "wizard_roster() 看全体 wizard 的名字/职责/家谱。地址就是它的全局名字, 原样用上面给的那个。",
    "只是提了一嘴、并没有要你去找它 (\".b 说的那个方案\") 就不必调工具 —— 看用户到底要什么。",
  ]);
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
