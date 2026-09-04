// Subagent transcript watcher.
//
// Claude Code and CodeBuddy both park spawned subagent (Task / Agent tool)
// transcripts at `<projectDir>/<parentSid>/subagents/agent-<id>.jsonl` — same
// per-backend schema as the main session transcript (verified on disk for both
// backends). The main tail (`startMirrorTail`) deliberately ignores that
// directory; this watcher is the dedicated reader:
//   • polls the subagents/ dir (fs.watch + 1s poll floor, mirroring the main
//     tail's discipline), starting a per-agent incremental tail per file;
//   • files present when the watch starts are tailed from EOF (don't replay
//     history); files appearing later start at 0 — an agent file is created at
//     spawn, so we see its task prompt as the first line;
//   • the dir follows the parent transcript's live path (worktree relocations
//     rename the whole project dir; per-agent offsets survive the move since a
//     rename preserves the byte prefix);
//   • line classification reuses the backend normalizer (claude identity,
//     codebuddy schema adapter), then emits a lean item stream — no keepalive
//     / goal / inject-echo logic, those are main-transcript concerns.
//
// Claude subagent lines carry `isSidechain:true` — the main renderLine drops
// those; here they are the content, so the gate is intentionally absent.
import { readdirSync, readFileSync, statSync, watch, openSync, readSync, closeSync, type FSWatcher } from "node:fs";
import { dirname, join } from "node:path";
import type { Logger } from "pino";
import type { NormalizedTranscriptLine } from "../shared/cli-backends.js";
import type { TurnUsage } from "../shared/detail-store.js";

export interface SubagentMeta {
  type?: string;
  description?: string;
}

export type SubagentItem =
  // 首条 user 行 = 派发任务原文 (parent Task/Agent input.prompt)。
  | { kind: "task"; body: string; meta: SubagentMeta }
  | { kind: "text"; body: string; final?: boolean }
  | { kind: "thinking"; body: string }
  | { kind: "tool_use"; calls: Array<{ toolUseId: string; name: string; input: unknown }> }
  | { kind: "tool_result"; toolUseId: string; full: string }
  | { kind: "usage"; model?: string; messageId?: string; usage: TurnUsage }
  // 终态 (claude: end_turn 带 text / system turn_duration)。codebuddy 无硬信号,
  // 由 mirror-bridge 在父 turn 收口时统一关闭。
  | { kind: "end" };

export interface SubagentWatchDeps {
  log: Logger;
  sessionId: string;
  /** 主 jsonl 的实时路径 (可能因 worktree 迁移而变) — subagents 目录跟着它走。 */
  liveJsonlPath: () => string | undefined;
  normalizeLine: (raw: unknown) => NormalizedTranscriptLine | null;
  onAgentItem: (agentId: string, item: SubagentItem) => void;
}

export interface SubagentWatchHandle {
  stop: () => void;
}

// detail 页的存储上限, 与 mirror-bridge 的 DETAIL_RESULT_MAX 对齐。
const RESULT_MAX = 64 * 1024;
const POLL_MS = 1000;
const MAX_AGENTS = 128;

interface AgentState {
  offset: number;
  buffer: string;
  done: boolean;
  sawUser: boolean;
}

interface ContentBlock {
  type?: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: string | Array<{ type?: string; text?: string }>;
}

interface LineShape {
  type?: string;
  subtype?: string;
  message?: {
    role?: string;
    content?: string | ContentBlock[];
    stop_reason?: string;
    id?: string;
    model?: string;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
      service_tier?: string;
    };
  };
  softTurnEnd?: boolean;
}

const truncate = (s: string, max: number): string =>
  s.length <= max ? s : `${s.slice(0, max)}…(+${s.length - max})`;

const resultText = (c: { content?: string | Array<{ type?: string; text?: string }> }): string => {
  const v = c.content;
  if (typeof v === "string") return v;
  if (!Array.isArray(v)) return "";
  return v.map((b) => (typeof b?.text === "string" ? b.text : "")).filter(Boolean).join("\n");
};

// 单条归一化行 → items。与 mirror-bridge 的 renderLine 同源逻辑的精简版:
// 去掉 keepalive / goal / inject-echo / skill_output (主会话专属), 保留
// text(three-state final) / tool_use 分组 / tool_result / usage / 终态判定。
const classifyLine = (line: LineShape): SubagentItem[] => {
  const out: SubagentItem[] = [];

  if (line.type === "user") {
    const c = line.message?.content;
    if (typeof c === "string") {
      // subagent 只有一条真实 user 行 (任务派发); 后续 string 行只可能是元数据。
      return [{ kind: "task", body: c, meta: {} }];
    }
    if (Array.isArray(c)) {
      for (const b of c) {
        if (b?.type !== "tool_result") continue;
        const full = truncate(resultText(b), RESULT_MAX);
        if (full) out.push({ kind: "tool_result", toolUseId: b.tool_use_id ?? "", full });
      }
    }
    return out;
  }

  if (line.type === "assistant") {
    const blocks = line.message?.content;
    if (!Array.isArray(blocks)) return [];
    const sr = line.message?.stop_reason;
    const isFinal = sr === "end_turn";
    const textFinal = isFinal ? true : line.softTurnEnd ? undefined : false;
    let pending: Array<{ toolUseId: string; name: string; input: unknown }> = [];
    const flushPending = (): void => {
      if (pending.length === 0) return;
      out.push({ kind: "tool_use", calls: pending });
      pending = [];
    };
    for (const b of blocks) {
      if (b?.type === "text" && typeof b.text === "string") {
        flushPending();
        const t = b.text.trim();
        if (t) out.push({ kind: "text", body: t, final: textFinal });
      } else if (b?.type === "tool_use") {
        const name = b.name ?? "tool";
        if (pending.length > 0 && pending[0]!.name !== name) flushPending();
        pending.push({ toolUseId: b.id ?? "", name, input: b.input });
      } else if (b?.type === "thinking" && typeof b.thinking === "string") {
        const thought = b.thinking.trim();
        if (thought) out.push({ kind: "thinking", body: thought });
      }
    }
    flushPending();
    const u = line.message?.usage;
    if (u) {
      const rawIn = u.input_tokens ?? 0;
      const cr = u.cache_read_input_tokens ?? 0;
      const cw = u.cache_creation_input_tokens ?? 0;
      // 网关口径修正 — 与 renderLine 的 turn_usage 同一判据 (见 mirror-bridge 注释)。
      const isTotalized = rawIn >= cr + cw;
      out.push({
        kind: "usage",
        model: typeof line.message?.model === "string" ? line.message.model : undefined,
        messageId: typeof line.message?.id === "string" ? line.message.id : undefined,
        usage: {
          input: isTotalized ? rawIn - cr - cw : rawIn,
          output: u.output_tokens ?? 0,
          cacheRead: cr,
          cacheWrite: cw,
          serviceTier: u.service_tier,
          calls: 1,
        },
      });
    }
    // 终态判定与 renderLine 相同: 终态消息必含 text 块, 且从不拆出第二个 text 行。
    if (isFinal && blocks.some((b) => b?.type === "text")) out.push({ kind: "end" });
    return out;
  }

  if (line.type === "system" && line.subtype === "turn_duration") return [{ kind: "end" }];
  return out;
};

export const startSubagentWatch = (deps: SubagentWatchDeps): SubagentWatchHandle => {
  const { log } = deps;
  const agents = new Map<string, AgentState>();
  let stopped = false;
  let watcher: FSWatcher | undefined;
  let watchedDir = "";
  // 目录已成功读过一次 = watch 建立时刻已过; 之后再出现的 agent 文件必是新 spawn。
  let dirSeen = false;
  const watchStart = Date.now();

  // subagents 目录 = <dirname(live jsonl)>/<sessionId>/subagents。sessionId 在
  // watch 创建时固定 — 会话轮换由 mirror-bridge 重建整个 watch。
  const dirOf = (): string | undefined => {
    const live = deps.liveJsonlPath();
    return live ? join(dirname(live), deps.sessionId, "subagents") : undefined;
  };

  // Claude 在 agent 文件旁写 agent-<id>.meta.json {agentType, description};
  // codebuddy 没有 — type 由 mirror-bridge 用父 Task input 对 prompt 匹配补上。
  const readMeta = (dir: string, file: string): SubagentMeta => {
    try {
      const j = JSON.parse(readFileSync(join(dir, `${file.replace(/\.jsonl$/, "")}.meta.json`), "utf8")) as {
        agentType?: unknown;
        description?: unknown;
      };
      return {
        type: typeof j.agentType === "string" && j.agentType ? j.agentType : undefined,
        description: typeof j.description === "string" && j.description ? j.description : undefined,
      };
    } catch {
      return {};
    }
  };

  // end item → 标记 done (state 留在 map 里, 防止重扫时当新 agent 重建)。
  // 包装一层而不是让 classify 回写 state —— classify 保持纯函数。
  const onItem = (agentId: string, item: SubagentItem): void => {
    deps.onAgentItem(agentId, item);
    if (item.kind === "end") {
      const st = agents.get(agentId);
      if (st) st.done = true;
    }
  };

  const emit = (agentId: string, raw: string, meta: SubagentMeta): void => {
    let line: unknown;
    try {
      line = JSON.parse(raw);
    } catch {
      return;
    }
    const normalized = deps.normalizeLine(line);
    if (!normalized) return;
    for (const item of classifyLine(normalized as unknown as LineShape)) {
      onItem(agentId, item.kind === "task" ? { ...item, meta } : item);
    }
  };

  const drainAgent = (dir: string, agentId: string, file: string): void => {
    const st = agents.get(agentId);
    if (!st || st.done) return;
    const path = join(dir, file);
    let size: number;
    try {
      size = statSync(path).size;
    } catch {
      return; // 目录刚迁移 / 文件暂不可见 — 下一轮 poll 再找
    }
    if (size < st.offset) {
      // truncated/rotated — 对齐主 tail 的语义, 重置到新 EOF
      st.offset = size;
      st.buffer = "";
      return;
    }
    if (size > st.offset) {
      const fd = openSync(path, "r");
      try {
        const len = size - st.offset;
        const buf = Buffer.alloc(len);
        readSync(fd, buf, 0, len, st.offset);
        st.offset = size;
        st.buffer += buf.toString("utf8");
      } finally {
        closeSync(fd);
      }
    }
    let nl: number;
    while ((nl = st.buffer.indexOf("\n")) !== -1) {
      const line = st.buffer.slice(0, nl);
      st.buffer = st.buffer.slice(nl + 1);
      if (!line.trim()) continue;
      const meta = st.sawUser ? {} : readMeta(dir, file); // 首行前读一次 meta
      if (!st.sawUser) st.sawUser = true;
      emit(agentId, line, meta);
      const after = agents.get(agentId);
      if (after?.done) return;
    }
  };

  const scan = (): void => {
    if (stopped) return;
    const dir = dirOf();
    if (!dir) return;
    let files: string[];
    try {
      files = readdirSync(dir).filter((f) => f.startsWith("agent-") && f.endsWith(".jsonl"));
    } catch {
      if (watchedDir !== dir) { watcher?.close(); watcher = undefined; watchedDir = ""; }
      return; // 目录还不存在 — attach 早期 / 尚无 subagent
    }
    if (watchedDir !== dir) {
      watcher?.close();
      watchedDir = dir;
      try {
        watcher = watch(dir, { persistent: false }, () => scan());
      } catch {
        watcher = undefined;
      }
    }
    for (const f of files) {
      const id = f.replace(/^agent-/, "").replace(/\.jsonl$/, "");
      if (agents.has(id)) continue;
      if (agents.size >= MAX_AGENTS) {
        log.warn({ agentCount: agents.size }, "subagent watch: cap reached, ignoring new agent");
        continue;
      }
      // 与主 tail 同语义: watch 建立时已在盘上的 agent = 历史, 从 EOF 起不重放;
      // watch 建立后才出现 = 本轮新 spawn, 从 0 起完整拿到 task 行。首扫目录时用
      // mtime 区分「attach 前就有的老文件」(历史) 与「恰在 watch 前后 spawn 的」
      // (新文件, mtime ≥ watchStart) —— 否则首扫恰逢首个 agent 建文件时, 会把新
      // spawn 误判成历史、丢它的开头。dirSeen 之后再出现的文件一律是新 spawn。
      let offset = 0;
      if (!dirSeen) {
        try {
          const st = statSync(join(dir, f));
          if (st.mtimeMs < watchStart) offset = st.size;
        } catch { offset = 0; }
      }
      agents.set(id, { offset, buffer: "", done: false, sawUser: false });
      if (offset === 0) log.info({ agentId: id }, "subagent watch: agent file appeared");
    }
    dirSeen = true;
    for (const f of files) {
      drainAgent(dir, f.replace(/^agent-/, "").replace(/\.jsonl$/, ""), f);
    }
  };

  const poll = setInterval(scan, POLL_MS);
  scan();

  log.info("subagent watch started");
  return {
    stop: () => {
      stopped = true;
      watcher?.close();
      clearInterval(poll);
    },
  };
};
