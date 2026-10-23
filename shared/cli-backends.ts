// CLI backend descriptors. Claude Code / claude-internal forks / CodeBuddy
// all share the same jsonl transcript + hook protocol shape, but differ in:
//   - binary name + config home (~/.claude vs ~/.claude-internal vs ~/.codebuddy)
//   - on-disk project-dir encoding (Claude: leading `-`; CodeBuddy: none)
//   - jsonl transcript schema (CodeBuddy splits tool_use / tool_result into
//     independent top-level records; Claude Code nests them in message.content)
//   - slash-command injection tag dialect: verified identical (<command-name> /
//     <system-reminder>), so no tag-regex dispatch needed.
//
// normalizeTranscriptLine maps a backend's raw jsonl line into the Claude Code
// TranscriptLine shape that mirror-bridge's renderLine consumes. Claude backends
// are identity; codebuddy does the schema adapter work.

import { normalizeCodex } from "./codex.js";
import { join } from "node:path";
import { expandHome } from "./paths.js";

export type CliBackendName = "claude" | "claude-internal" | "codebuddy" | "codex";

// 人读的后端名 —— 详情页「X 正在思考」这类给人看的地方用它, 而不是配置里的标识符。
// claude-internal 是 Claude Code 的内部构建, 对人来说仍然是 Claude。
const BACKEND_LABEL: Record<CliBackendName, string> = {
  "claude": "Claude",
  "claude-internal": "Claude",
  "codebuddy": "CodeBuddy",
  "codex": "Codex",
};

/** 未知 / 缺省后端退回中性的「Agent」—— 宁可不说, 也别说错一个产品名。 */
export const backendLabel = (name?: string): string =>
  BACKEND_LABEL[name as CliBackendName] ?? "Agent";

// Normalized transcript line — structurally compatible with mirror-bridge's
// TranscriptLine. Defined here (not imported from mirror-bridge) to keep the
// shared layer free of daemon dependencies. mirror-bridge casts the return
// value to its own TranscriptLine; the shapes match field-for-field.
export interface NormalizedContentBlock {
  type?: string;
  text?: string;
  // thinking block (Claude Code shape). CodeBuddy's reasoning_text is normalized into this.
  thinking?: string;
  // tool_use
  id?: string;
  name?: string;
  input?: unknown;
  // tool_result
  tool_use_id?: string;
  content?: string | Array<{ type?: string; text?: string; tool_name?: string }>;
}

export interface NormalizedTranscriptLine {
  timestamp?: string;
  type?: string;
  /** Present on `type:"system"` lines — e.g. "local_command" for slash-command
   *  invocation records (Claude Code); codebuddy only maps `turn-metrics` here (TURN_METRICS). */
  subtype?: string;
  /** Top-level content for `type:"system"` lines. */
  content?: string;
  uuid?: string;
  parentUuid?: string;
  /** Claude Code stamps each assistant line with the effort it ran at. */
  effort?: string;
  message?: {
    role?: string;
    content?: string | NormalizedContentBlock[];
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
  isMeta?: boolean;
  isSidechain?: boolean;
  /** 后端只能说"这条 assistant 消息写完了", 说不出"这一轮结束了" (codebuddy: 每条
   *  记录都是独立的 completed message, 中途叙述与最终答复完全同形)。置位表示**软**
   *  收口 —— mirror-bridge 挂一小段静默期确认, 期间来了新 item 就撤销。原生 Claude
   *  有 end_turn / turn_duration 两个硬信号, 永远不置位。 */
  softTurnEnd?: boolean;
  /** Final text precedes usage; close only on the backend completion event.
   *  不带 stop_reason:"end_turn" 时 (codebuddy) 连「这句是终句」都要等那个事件确认。 */
  awaitTurnEnd?: boolean;
  mid?: boolean;
}

export interface CliBackend {
  /** Stable identifier used in config + logs. */
  name: CliBackendName;
  /** Executable name (resolved via $PATH) or absolute path. */
  bin: string;
  /** Config home, e.g. `~/.claude`. Locates settings.json + projects/. */
  homeDir: string;
  /** Transcript root: `<projectsDir>/<encoded(cwd)>/<sid>.jsonl`. */
  projectsDir: string;
  /** settings.json path inside the home dir. */
  settingsPath: string;
  /** Hook env var exporting the project cwd to child processes. */
  projectDirEnv: "CLAUDE_PROJECT_DIR" | "CODEBUDDY_PROJECT_DIR";
  /** Plugin root env var (for hooks.json `${VAR}` resolution). */
  pluginRootEnv: "CLAUDE_PLUGIN_ROOT" | "CODEBUDDY_PLUGIN_ROOT";
  /** Flag that appends text to the session's system prompt at launch, or
   *  undefined when the CLI has none. wezard uses it to press a wizard's
   *  identity into the process itself — a system prompt survives `/clear` and
   *  can't be squeezed out of the context window, which a first message can't
   *  promise. Undefined → the spawn silently goes without a charter rather
   *  than passing a flag the binary would reject (an unknown flag kills the
   *  pane before the TUI ever starts). */
  systemPromptFlag?: string;
  /** Launch flags pinning the session's model / reasoning effort. Same rule as
   *  `systemPromptFlag`: undefined = this CLI has none, so the spawn leaves the
   *  knob alone (the model still goes through the `/model` picker). */
  modelFlag?: string;
  effortFlag?: string;
  /** Encode an absolute cwd path into the on-disk project dir segment. */
  encodeProjectDir: (absCwd: string) => string;
  /** Map a raw parsed jsonl line into the Claude Code TranscriptLine shape
   *  that mirror-bridge's renderLine consumes. Returns null to drop the line
   *  (e.g. codebuddy's reasoning / file-history-snapshot / ai-title records).
   *  Claude backends are identity — their jsonl is already in the target shape. */
  normalizeTranscriptLine: (raw: unknown) => NormalizedTranscriptLine | null;
}

// Claude + claude-internal: `/` and `.` → `-`, yields a leading `-`
// (e.g. /Users/zyy/foo → -Users-zyy-foo). Verified against ~/.claude/projects.
const encodeClaude = (absCwd: string): string => absCwd.replace(/[/.]/g, "-");

// CodeBuddy: same char mapping but trims the leading separator first, so no
// leading `-` (e.g. /Users/zyy/foo → Users-zyy-foo).
const encodeCodebuddy = (absCwd: string): string =>
  absCwd.replace(/^[/]+/, "").replace(/[/.]/g, "-");

// Module-level encoder, bound at daemon boot via bindCliBackends(). Defaults to
// Claude's dialect so the daemon works out-of-the-box. This is the PRIMARY
// backend's encoder — correct for *write* paths (where a new session's jsonl
// will land). Read paths must go through projectDirsFor/backendForPath instead,
// which consider every active backend.
let _encodeProjectDir: (absCwd: string) => string = encodeClaude;
export const encodeProjectDir = (absCwd: string): string => _encodeProjectDir(absCwd);

const makeClaude = (name: CliBackendName, bin: string): CliBackend => {
  const homeDir = name === "claude-internal" ? "~/.claude-internal" : "~/.claude";
  return {
    name,
    bin,
    homeDir,
    projectsDir: `${homeDir}/projects`,
    settingsPath: `${homeDir}/settings.json`,
    projectDirEnv: "CLAUDE_PROJECT_DIR",
    pluginRootEnv: "CLAUDE_PLUGIN_ROOT",
    systemPromptFlag: "--append-system-prompt",
    modelFlag: "--model",
    effortFlag: "--effort",
    encodeProjectDir: encodeClaude,
    // Claude Code jsonl is already in the TranscriptLine shape — identity pass.
    normalizeTranscriptLine: (raw) => raw as NormalizedTranscriptLine,
  };
};

// CodeBuddy jsonl adapter. Verified schema (2026-07-24, GLM-5.2 session):
//   message              → { type:"message", role:"user"|"assistant",
//                            content:[{type:"input_text"|"output_text", text}],
//                            id, parentId, status?, providerData:{agent,model,usage,...} }
//   function_call        → { type:"function_call", callId, name, arguments(JSON string),
//                            id(==host assistant msg id), parentId }
//   function_call_result → { type:"function_call_result", callId, name, status,
//                            output:{type:"text", text}, id, parentId }
//   reasoning            → { type:"reasoning", rawContent:[{type:"reasoning_text", text}] }
//                          → mapped to assistant message w/ a `thinking` block
//   file-history-snapshot | ai-title | summary → drop
//
// Key structural differences from Claude Code:
//   1. content block types are input_text/output_text, not "text".
//   2. tool_use / tool_result are independent top-level records, not nested in
//      a message.content array. Adapter synthesizes assistant/user messages
//      around them so renderLine sees the Claude shape.
//   3. id/parentId → uuid/parentUuid.
//   4. Subagents live in <sid>/subagents/agent-<id>.jsonl — NOT inlined into
//      the main transcript — so no isSidechain filtering needed here.
//   5. Slash-command tags (<command-name> / <system-reminder>) are identical
//      to Claude Code — no tag-regex dialect dispatch needed.
//   6. /goal marker shape on disk: UNVERIFIED (blocker). The non-isMeta
//      fallback path in renderLine (goalStartOf on string content) should
//      catch it if codebuddy uses the same marker text, but this needs
//      confirmation from a real /goal session.
// CodeBuddy usage → snake_case shape that lastContextTokens / extractTokens expect.
const normalizeCbUsage = (pd: Record<string, unknown>) => {
  const u = pd.usage as Record<string, unknown> | undefined;
  if (!u) return undefined;
  const details = (u.inputTokensDetails ?? []) as Array<{ cached_tokens?: number }>;
  return {
    input_tokens: Number(u.inputTokens ?? 0),
    output_tokens: Number(u.outputTokens ?? 0),
    cache_read_input_tokens: details[0]?.cached_tokens ?? 0,
    cache_creation_input_tokens: 0,
  };
};

/** codebuddy `turn-metrics` 归一化后的 system subtype (见 normalizeCodebuddy 末尾)。 */
export const TURN_METRICS = "turn_metrics";

const normalizeCodebuddy = (raw: unknown): NormalizedTranscriptLine | null => {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const type = r.type as string | undefined;
  const id = r.id as string | undefined;
  const parentId = r.parentId as string | null | undefined;
  const providerData = (r.providerData ?? {}) as Record<string, unknown>;

  const uuids = { uuid: id, parentUuid: parentId ?? undefined };

  if (type === "message") {
    const role = r.role as string;
    const content = r.content as Array<{ type: string; text?: string }> | undefined;
    if (role === "user") {
      // Join input_text blocks into a single string. renderLine's string path
      // handles slash-command stripping, /goal marker detection, task-notification
      // rendering, and the isOwnInject dedup — all driven by string content.
      const text = (content ?? []).map((b) => b.text ?? "").join("");
      return { type: "user", ...uuids, message: { role: "user", content: text } };
    }
    if (role === "assistant") {
      const blocks: NormalizedContentBlock[] = (content ?? []).map((b) => ({
        type: "text",
        text: b.text ?? "",
      }));
      const msg = {
        role: "assistant",
        content: blocks,
        id: providerData.messageId as string | undefined,
        model: providerData.model as string | undefined,
        usage: normalizeCbUsage(providerData),
      };
      // status:"completed" 只说明这条记录写完了 —— codebuddy 把中途叙述和最终答复
      // 写成同形的独立 message, 映射成 stop_reason:"end_turn" 会让"中间说一句"就把
      // 整个 turn 收掉 (后半轮全部退化成散装气泡)。改为软收口, 交给 mirror-bridge
      // 用静默期确认。
      // awaitTurnEnd: 同理, 这句是不是终句只有轮终证据说了算 (紧随的 turn-metrics / 下一句
      // user 行 / CLI 已闲) —— peers 据此不把中途叙述当定论 (见 parseTurns 的 soft)。
      const status = r.status as string | undefined;
      return { type: "assistant", ...uuids, message: msg, softTurnEnd: status === "completed", awaitTurnEnd: true };
    }
    return null;
  }

  if (type === "function_call") {
    const callId = r.callId as string;
    const name = r.name as string;
    const argsRaw = r.arguments as string;
    let input: unknown;
    try {
      input = argsRaw ? JSON.parse(argsRaw) : {};
    } catch {
      input = {};
    }
    return {
      type: "assistant",
      ...uuids,
      message: { role: "assistant", content: [{ type: "tool_use", id: callId, name, input }], usage: normalizeCbUsage(providerData) },
    };
  }

  if (type === "function_call_result") {
    const callId = r.callId as string;
    const output = r.output as { type?: string; text?: string } | undefined;
    const text = output?.text ?? "";
    return {
      type: "user",
      ...uuids,
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: callId, content: text }] },
    };
  }

  // reasoning: thinking lives in rawContent:[{type:"reasoning_text", text}] (not
  // in content, which is empty). Map into a Claude-shape assistant message with
  // a `thinking` block so the transcript keeps Claude's shape.
  // No softTurnEnd — a reasoning record is never a turn boundary.
  if (type === "reasoning") {
    const rawContent = (r.rawContent ?? []) as Array<{ type?: string; text?: string }>;
    const thinking = rawContent
      .filter((b) => b?.type === "reasoning_text" && typeof b.text === "string")
      .map((b) => b.text!)
      .join("\n\n")
      .trim();
    if (!thinking) return null;
    return {
      type: "assistant",
      ...uuids,
      message: { role: "assistant", content: [{ type: "thinking", thinking }] },
    };
  }

  // turn-metrics (时长 / token 增量): 一段模型调用收尾时写一行。紧跟在 assistant 正文后面
  // = 这一轮说完了 —— codebuddy 唯一的轮终证据; 但长工具调用 (TaskOutput 阻塞等后台) 中途
  // 也会写, 那时前一条是 function_call / result。所以不映射成 turn_duration (mirror 会当硬
  // 收口、中途关轮), 单开一个 subtype, 只由 peers 按「紧跟正文」读 (TURN_METRICS)。
  if (type === "turn-metrics") return { type: "system", subtype: TURN_METRICS };

  // file-history-snapshot / ai-title / summary → drop.
  return null;
};

const makeCodebuddy = (bin: string): CliBackend => ({
  name: "codebuddy",
  bin,
  homeDir: "~/.codebuddy",
  projectsDir: "~/.codebuddy/projects",
  settingsPath: "~/.codebuddy/settings.json",
  projectDirEnv: "CODEBUDDY_PROJECT_DIR",
  pluginRootEnv: "CODEBUDDY_PLUGIN_ROOT",
  systemPromptFlag: "--append-system-prompt",
  modelFlag: "--model",
  effortFlag: "--effort",
  encodeProjectDir: encodeCodebuddy,
  normalizeTranscriptLine: normalizeCodebuddy,
});

// Built-in defaults. Each backend name is also its executable resolved via PATH.
export const CLI_BACKEND_DEFAULTS: Record<CliBackendName, CliBackend> = {
  claude: makeClaude("claude", "claude"),
  "claude-internal": makeClaude("claude-internal", "claude-internal"),
  codebuddy: makeCodebuddy("codebuddy"),
  codex: {
    name: "codex", bin: "codex", homeDir: process.env.CODEX_HOME || "~/.codex",
    projectsDir: `${process.env.CODEX_HOME || "~/.codex"}/sessions`,
    settingsPath: `${process.env.CODEX_HOME || "~/.codex"}/config.toml`,
    projectDirEnv: "CLAUDE_PROJECT_DIR", pluginRootEnv: "CLAUDE_PLUGIN_ROOT",
    modelFlag: "--model", encodeProjectDir: () => "", normalizeTranscriptLine: normalizeCodex,
  },
};

/** Minimal slice of Wrc that resolveCliBackend needs. */
export interface CliBackendsConfig {
  /** Active backend. Defaults to "claude". */
  defaultCli?: CliBackendName;
}

/** Resolve the active backend; its built-in executable name is searched on PATH. */
export const resolveCliBackend = (cfg: CliBackendsConfig): CliBackend => {
  const name: CliBackendName = cfg.defaultCli ?? "claude";
  const base = CLI_BACKEND_DEFAULTS[name];
  if (!base) throw new Error(`unknown CLI backend: ${name}`);
  return base;
};

// ── Multi-backend registry ──────────────────────────────────────────────
//
// The daemon mirrors sessions from EVERY installed CLI at once, not just the
// primary one: a user can have `claude` in one tmux pane and `codebuddy` in
// another, each bound to a different WeCom chat. Since a session's identity on
// disk *is* its transcript path, the path is the discriminant — `backendForPath`
// recovers which CLI wrote a jsonl, and every downstream decision (which binary
// to `--resume` with, which jsonl schema to normalize, which project-dir
// encoding to compare panes against) derives from that instead of a global.
//
// `primaryBackend()` remains the tie-breaker for *write* paths — spawning a new
// session has no path to derive from, so it uses `defaultCli`.

let _backends: readonly CliBackend[] = [CLI_BACKEND_DEFAULTS.claude];
let _primary: CliBackend = CLI_BACKEND_DEFAULTS.claude;

/** Active backends, primary first. Read-only snapshot of the last bind. */
export const activeBackends = (): readonly CliBackend[] => _backends;
/** Backend used when there is no path to derive one from (new-session spawns). */
export const primaryBackend = (): CliBackend => _primary;

/**
 * Resolve the primary backend and register every other known backend alongside
 * it. Zero-config: install codebuddy and its sessions become mirrorable without
 * touching config.jsonc.
 *
 * Deliberately does NOT probe for each root's existence. That probe ran once at
 * boot, so a CLI first used *after* the daemon started stayed invisible until a
 * reload — and it bought nothing: a nonexistent root never prefix-matches in
 * backendForPath, and every read path (rankedJsonlsForCwd, findJsonlBySid,
 * session-scan's roots) already tolerates a missing directory.
 */
export const bindCliBackends = (
  cfg: CliBackendsConfig & { projectsDirOverride?: string },
): { primary: CliBackend; backends: readonly CliBackend[] } => {
  const resolved = resolveCliBackend(cfg);
  // An explicit `mirror.projectsDir` retargets the PRIMARY backend only — it is
  // the pre-multi-CLI escape hatch for a nonstandard transcript root, and has no
  // meaning for the other backends.
  const override = (cfg.projectsDirOverride ?? "").trim();
  const primary: CliBackend =
    override && override !== resolved.projectsDir ? { ...resolved, projectsDir: override } : resolved;

  const secondaries = (Object.keys(CLI_BACKEND_DEFAULTS) as CliBackendName[])
    .filter((n) => n !== primary.name)
    .map((n) => CLI_BACKEND_DEFAULTS[n]);

  _primary = primary;
  _backends = [primary, ...secondaries];
  _encodeProjectDir = primary.encodeProjectDir;
  return { primary, backends: _backends };
};

/**
 * Register a backend as active at runtime, returning the already-known
 * descriptor if there is one. `bindCliBackends` only admits secondaries whose
 * transcript root already exists — a CLI that is installed but has never run
 * has none, so the FIRST session spawned with it would be invisible to
 * `backendForPath` (mirrored with the primary's jsonl dialect, resumed with the
 * primary's binary). Spawning with an explicit `cli` calls this so the registry
 * learns the backend before its transcript appears on disk.
 */
export const activateBackend = (backend: CliBackend): CliBackend => {
  const known = _backends.find((b) => b.name === backend.name);
  if (known) return known;
  _backends = [..._backends, backend];
  return backend;
};

/**
 * Recover the backend that owns an absolute transcript path, by longest
 * projectsDir prefix match. Falls back to primary for paths outside every known
 * root (custom `mirror.projectsDir`, or a jsonl handed in by a session switch from a
 * location we don't manage) — treating an unknown transcript as the primary
 * dialect is what the single-backend code already did.
 */
export const backendForPath = (absPath: string): CliBackend =>
  _backends
    .map((b) => ({ b, root: expandHome(b.projectsDir) }))
    .filter(({ root }) => absPath === root || absPath.startsWith(`${root}/`))
    .sort((x, y) => y.root.length - x.root.length)[0]?.b ?? _primary;

/**
 * Every candidate `<projectsDir>/<encoded(cwd)>` across active backends, primary
 * first. Callers filter by existence and rank by mtime — a cwd can legitimately
 * have transcripts under two backends at once (same project, both CLIs used).
 */
export const projectDirsFor = (absCwd: string): Array<{ backend: CliBackend; dir: string }> =>
  _backends.map((b) => ({ backend: b, dir: join(expandHome(b.projectsDir), b.encodeProjectDir(absCwd)) }));

/**
 * The project dir `cwd` would encode to *under the same backend that owns
 * `refPath`*. Used for "is this pane still in the project dir its transcript
 * lives in?" checks — comparing against the primary encoding would report a
 * spurious drift for every non-primary session.
 */
export const projectDirFor = (refPath: string, absCwd: string): string => {
  const b = backendForPath(refPath);
  return join(expandHome(b.projectsDir), b.encodeProjectDir(absCwd));
};
