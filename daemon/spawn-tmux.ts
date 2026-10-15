import { recordCodexPaneSession } from "../shared/codex.js";
import { codexHookLaunchArgs, codexHookCommand, prepareCodexSession, codexSandboxLaunchArgs, codexSandboxMode, codexSandboxArgConflict } from "../shared/codex-hooks.js";
// Auto-spawn helper for mirror mode.
//
// Goal: from a WeCom inbound, materialize a fresh `claude` process inside a
// shared tmux session and attach the resulting jsonl to the WeCom chat —
// no human-in-the-loop attach needed.
//
// Layout: ONE shared tmux session named `cfg.wrc.tmuxPrefix` (default
// `wezard`); each chat gets its own window inside it. The pane id (`%N`)
// uniquely identifies a chat's claude process — pane ids are monotonic per
// tmux server lifetime, so they're safe to persist and re-validate via
// `display-message -t %N`. Window names are cosmetic (sanitized principal id;
// WeCom doesn't expose a display name).
//
// Pipeline:
//   uuid = randomUUID                                       (deterministic session)
//   tmux has-session -t wezard  → create or reuse
//   tmux new-window/new-session -P -F '#{pane_id}' …        (→ paneId)
//   tmux send-keys -t %paneId "claudeBin --session-id <uuid> …" Enter
//
// We do NOT wait for claude to write anything to the jsonl. The jsonl is the
// transcript file, populated as claude runs; the empty file is enough for
// MirrorBridge.attach() (existsSync) and startMirrorTail (statSync.size=0 →
// tail from offset 0). The brief post-launch settle exists only to give the
// pane's shell time to finish sourcing rc + claude TUI time to grab the pty
// before the first paste-buffer inject hits.
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { Logger } from "pino";
import { loadConfig, type Config } from "../shared/config.js";
import { expandHome } from "../shared/paths.js";
import { tmuxClientEnv } from "../shared/exec-path.js";
import { sleep } from "../shared/std.js";
import { activateBackend, resolveCliBackend, type CliBackend, type CliBackendName } from "../shared/cli-backends.js";
import { selectModel } from "./model-select.js";
import type { Effort } from "../shared/effort.js";
import { hasRegistry, sessionOnPane } from "./wezard-session.js";
import { startupConfirmation, workspaceTrustPrompt, workspaceTrustConfig } from "../shared/workspace-trust.js";


// Every new pane uses the configured backend, including resume and fork panes.
// `cli` is retained on SpawnArgs only to identify a resumed transcript's owner.
export const backendFor = (cfg: Config): CliBackend => {
  const backend = resolveCliBackend(cfg.wrc);
  activateBackend(backend);
  return backend;
};

interface ExecResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number | null;
  /** 超时被 SIGKILL (server 卡住), 或根本没起得来。绝大多数调用点只关心 `ok`, 但探活
   *  那类「失败 = 对象不存在」的调用必须把它和真正的失败分开: tmux 卡住一次就判 pane
   *  死掉, 代价是整个会话被重生一遍 (2026-10-14 实测: 7 分钟重生 3 次)。 */
  timedOut?: boolean;
}

/** Hard ceiling for ANY tmux subcommand. A wedged tmux server used to hang the
 *  caller forever with zero log output: one inbound spawned a pane, then
 *  dispatch's `tmuxPaneAlive` never returned, so the per-session inject queue
 *  stayed locked behind a zombie job and that chat went permanently silent.
 *  Normal tmux commands finish in <100ms — 10s is a generous ceiling, not a
 *  latency budget. Override via WEZARD_TMUX_TIMEOUT_MS (0 disables, for debugging). */
const DETACHED_COLS = 200;
const DETACHED_ROWS = 60;

// stderr signatures of a transient server-side fork failure (ENOMEM/EAGAIN).
const TRANSIENT_FORK_RE = /Cannot allocate memory|Resource temporarily unavailable/;

export const TMUX_TIMEOUT_MS = ((): number => {
  const raw = Number(process.env.WEZARD_TMUX_TIMEOUT_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : 10_000;
})();

/** Timeouts are the only signal that the tmux server wedged, so they must leave
 *  a trace. runTmux has no logger of its own (it predates the daemon's pino
 *  child loggers and is called from two modules) — the daemon installs a
 *  reporter at boot. */
let timeoutReporter: ((info: { args: string[]; timeoutMs: number }) => void) | undefined;
export const setTmuxTimeoutReporter = (fn: (info: { args: string[]; timeoutMs: number }) => void): void => {
  timeoutReporter = fn;
};

export interface RunTmuxOpts {
  /** Written to the child's stdin, which is then closed. For `tmux load-buffer -`. */
  stdin?: string;
  /** Per-call override of TMUX_TIMEOUT_MS. */
  timeoutMs?: number;
}

export const runTmux = (args: string[], opts: RunTmuxOpts = {}): Promise<ExecResult> =>  new Promise((resolve) => {
    // `-u`: launchd/systemd 起的 daemon 没有 LANG/LC_*, tmux 把这样的 client 当非
    // UTF-8, 输出里的控制字符一律洗成 `_` —— `-F "#{pane_id}\t…"` 的 tab 也在其中,
    // 于是按 tab 切的每一处 (boot 恢复的 pane 快照 / pane 漂移跟随 / pane 上限) 都认不出
    // 任何 pane, 而在带 locale 的 dev shell 里一切正常。
    const proc = spawn("tmux", ["-u", ...args], {
      env: tmuxClientEnv(process.env),
      stdio: [opts.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    let inputError = "";
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const timeoutMs = opts.timeoutMs ?? TMUX_TIMEOUT_MS;
    const finish = (r: ExecResult): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(r);
    };
    // SIGKILL, not SIGTERM: a tmux client blocked on a wedged server ignores
    // TERM. Resolving as a normal failure lets every existing `if (!r.ok)`
    // branch handle it — `timedOut` is there for the probe-style call sites that
    // must tell "server 卡住, 问不出来" apart from "对象真的不存在" (probePane).
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        proc.kill("SIGKILL");
        timeoutReporter?.({ args, timeoutMs });
        finish({ ok: false, stdout: out, stderr: `tmux timeout after ${timeoutMs}ms: ${args.slice(0, 3).join(" ")}`, code: null, timedOut: true });
      }, timeoutMs);
    }
    proc.stdout?.on("data", (c: Buffer) => (out += c.toString("utf8")));
    proc.stderr?.on("data", (c: Buffer) => (err += c.toString("utf8")));
    proc.on("error", (e) => finish({ ok: false, stdout: "", stderr: e.message, code: null, timedOut: true }));
    proc.on("close", (code) => finish({ ok: code === 0 && !inputError, stdout: out, stderr: err || inputError, code }));
    // An old tmux can reject -b before reading a large stdin. Its EPIPE must
    // not crash the daemon or hide stderr (the buffer fallback needs that error).
    if (opts.stdin !== undefined) {
      proc.stdin?.on("error", (e: Error) => { inputError = e.message; });
      proc.stdin?.end(opts.stdin);
    }
  });


// `tmux -V` → "tmux 3.4" / "tmux 3.2a" / "tmux next-3.4" / "tmux 1.8". Extract
// the first major.minor as a float for coarse feature gating. Unparseable →
// Infinity (assume modern; the flags we gate on are ancient anyway).
const parseTmuxVersion = (out: string): number => {
  const m = out.match(/(\d+)\.(\d+)/);
  return m ? Number(`${m[1]}.${m[2]}`) : Number.POSITIVE_INFINITY;
};
export { parseTmuxVersion };


// Single-quote shell-escape: wrap in '…' and escape embedded ' as '\''.
// Allowlist, not a blocklist of metachars: the pane shell is often zsh, where a
// bare glob (`mcp__x__*` in extraArgs) that matches nothing aborts the whole
// launch line with "no matches found" — the pane drops straight to a prompt.
const shQuote = (a: string): string => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, "'\\''")}'`);

// tmux window names are free-form but a status-bar friendly slug avoids
// surprises (no whitespace / colons / quoting hazards). Principals are
// shortened: `user:foo` → `u-foo`, `chat:foo` → `c-foo`, and get truncated to
// 8 chars total (status bar real estate is scarce; collisions don't matter —
// we always address windows by pane id, never by name). Explicit tag names
// (not `user:`/`chat:` prefixed) are treated as user-authored labels and kept
// up to 24 chars so `/new #my-tag` shows readably in the tmux status bar.
const safeWindowName = (s: string): string => {
  const isPrincipal = s.startsWith("user:") || s.startsWith("chat:");
  const compact = s.startsWith("user:") ? `u-${s.slice(5)}`
    : s.startsWith("chat:") ? `c-${s.slice(5)}`
    : s;
  const slug = compact.replace(/[^A-Za-z0-9_.\-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  return (slug || "claude").slice(0, isPrincipal ? 8 : 24);
};

/** Relabel the window holding `pane` — same slug as at spawn. `allow-rename off`
 *  keeps it; the pane title itself is the CLI's (OSC) and would be overwritten. */
export const renameWindow = (pane: string, name: string): Promise<ExecResult> =>
  runTmux(["rename-window", "-t", pane, safeWindowName(name)]);

// Minimum settle before first poll: shell rc needs time to source before
// capture-pane contains anything meaningful. Too short → wasted polls against
// a blank screen; too long → added latency on happy path.
const MIN_SETTLE_MS = 1500;
// Max time to wait for TUI readiness. Covers slow machines / heavy .zshrc.
const TUI_READY_TIMEOUT_MS = 15_000;
// Poll interval for capture-pane checks.
const POLL_MS = 400;
// 注册表判就绪只是读几个小 json, 不起 tmux —— 查得密一些, idle 一报就走
// (实测冷启动 2.6–2.9s 报 idle, 400ms 的粒度平均白等 0.2–0.3s)。
const REGISTRY_POLL_MS = 100;

// Patterns indicating the TUI reached interactive state (input box visible).
// Covers Claude Code, Claude Internal, and CodeBuddy TUIs across versions.
const TUI_READY_RE = /for shortcuts|auto mode|Try "|OpenAI Codex|[›>]\s*$/m;

// Patterns indicating an interactive prompt that consumed our Enter — the
// command is sitting unsent in the shell line.
const BLOCKER_RE = /Would you like to update|oh-my-zsh|Do you want to update/i;

const capturePaneBottom = async (pane: string, rows: number | "-"): Promise<string> => {
  const r = await runTmux(["capture-pane", "-t", pane, "-p", "-S", rows === "-" ? "-" : `-${rows}`]);
  return r.ok ? r.stdout : "";
};

// The launch line ends in `; printf … __wezard_ cli_exit $?`, so a CLI that
// quits hands the shell back a line no TUI ever prints. Split in two on the
// typed line so the echoed command itself never matches.
const EXIT_TAIL = `; printf '\\n%s%s:%s\\n' __wezard_ cli_exit "$?"`;
const EXIT_RE = /__wezard_cli_exit:(\d+)/u;

const nonBlank = (s: string): string[] => s.split("\n").map((l) => l.trimEnd()).filter(Boolean);

/** The CLI quit back to the shell: the exit marker sits at the very bottom.
 *  Only the bottom counts — a live TUI always ends in its input box, and a
 *  resumed transcript replaying text that quotes the marker sits above it. */
export const cliExit = (screen: string): string | undefined => {
  const lines = nonBlank(screen);
  const tail = lines.slice(-3);
  const hit = tail.find((l) => EXIT_RE.test(l));
  if (!hit) return undefined;
  const at = lines.length - tail.length + tail.indexOf(hit);
  const why = lines.slice(Math.max(0, at - 6), at).join(" ").replace(/\s+/gu, " ").slice(-300);
  return `CLI 启动后退出 (exit ${EXIT_RE.exec(hit)![1]})${why ? `: ${why}` : ""}`;
};

/** The CLI took `--model` without recognizing it. A launch that knows the id
 *  prints its display name in the welcome box ("Deepseek-V4.1-Flash · high");
 *  one that doesn't echoes the raw string back ("no-such-model-9.9 · high") and
 *  only fails on the first turn with "400 model [...] service info not found".
 *  Read off the welcome box only — the first one titled with a version
 *  ("╭─── CodeBuddy Code v2.143.1 ───"), else the first box at all: it comes
 *  before any resumed history, which may quote anything. No box → false:
 *  nothing to judge by. A valid id whose display name is byte-identical to it
 *  would read as a miss — that costs one extra launch and lands on the same
 *  model through the picker. */
export const modelNotRecognized = (screen: string, wanted: string): boolean => {
  const lines = screen.split("\n");
  const isTop = (l: string): boolean => l.trimStart().startsWith("╭");
  const titled = lines.findIndex((l) => isTop(l) && /\bv\d+\.\d+/u.test(l));
  const top = titled >= 0 ? titled : lines.findIndex(isTop);
  const end = top < 0 ? -1 : lines.findIndex((l, i) => i > top && l.trimStart().startsWith("╰"));
  if (end < 0) return false;
  return lines.slice(top + 1, end)
    .flatMap((l) => l.split("│").map((s) => s.trim()))
    .some((s) => s === wanted || s.startsWith(`${wanted} · `));
};

interface TuiState {
  ready: boolean;
  /** The CLI quit before it ever took input — why, as far as the screen says. */
  exited?: string;
}

// Active verification that the AI session inside the pane is up and waiting
// for input. On success returns true; on timeout returns false (caller decides
// whether to treat as fatal).
//
// 注册表的 idle 只在读屏排除启动确认框后认下: 信任框可能先于会话注册出现,
// 也可能在已有注册记录时阻塞。未知确认框保持人工处理, 不能以 idle 或欢迎标题放行。
//
// 退出标记 (`cliExit`) 每次读屏都先看: CLI 一退回 shell 就不必等满预算, 而注册表
// 里那行可能还没清掉 —— 所以注册表已认下会话时也照读屏, 只是不拿屏去判就绪。
export const answerWorkspaceTrust = async (pane: string, backend: CliBackendName, cwd: string, log: Logger): Promise<boolean> => {
  const capture = async (): Promise<string> => {
    const r = await runTmux(["capture-pane", "-t", pane, "-p"]);
    return r.ok ? r.stdout : "";
  };
  const screen = await capture();
  const before = workspaceTrustPrompt(screen, backend, cwd, realpathSync);
  if (!before) return false;
  if (before.selected !== before.choice) {
    const moved = await runTmux(["send-keys", "-t", pane, before.selected < before.choice ? "Down" : "Up"]);
    if (!moved.ok) return false;
    await sleep(150);
  }
  // Re-read even if Yes was already selected: a local key may have changed the picker.
  const after = workspaceTrustPrompt(await capture(), backend, cwd, realpathSync);
  if (!after || after.selected !== after.choice || after.directory !== before.directory
    || after.labels.join("\n") !== before.labels.join("\n")) return false;
  const pressed = await runTmux(["send-keys", "-t", pane, "Enter"]);
  if (!pressed.ok) return false;
  log.info({ pane, backend, cwd }, "workspace trust: confirmed authorized directory");
  await sleep(300);
  return true;
};

const waitForTuiReady = async (pane: string, cmd: string, backend: CliBackend, cwd: string, log: Logger): Promise<TuiState> => {
  const registry = hasRegistry(backend.homeDir);
  const t0 = Date.now();
  const deadline = t0 + MIN_SETTLE_MS + TUI_READY_TIMEOUT_MS;
  let resent = false;
  let sawSession = false;
  let lastCap = 0;
  while (Date.now() < deadline) {
    await sleep(registry ? REGISTRY_POLL_MS : POLL_MS);
    let registryIdle = false;
    if (registry) {
      const s = sessionOnPane(backend.homeDir, pane);
      registryIdle = s?.status === "idle";
      if (s) sawSession = true;
    }
    // Shell rc needs time to source before capture-pane shows anything meaningful.
    if (Date.now() - t0 < MIN_SETTLE_MS) continue;
    // pane 那一路仍按 POLL_MS 的节奏读屏 —— 注册表查得再密也不多起 tmux。
    if (Date.now() - lastCap < POLL_MS) continue;
    lastCap = Date.now();
    const captured = await runTmux(["capture-pane", "-t", pane, "-p"]);
    if (!captured.ok) continue;
    const cap = captured.ok ? captured.stdout : "";
    const exited = cliExit(cap);
    if (exited) return { ready: false, exited };
    if (await answerWorkspaceTrust(pane, backend.name, cwd, log)) continue;
    if (startupConfirmation(cap)) continue;
    if (registryIdle) return { ready: true };
    // 注册表认不到这个 pane (schema 不认识 / 后端不写) 时, pane 读屏就是唯一证人;
    // 注册表已认下 (sawSession) 则仍以它报的 idle 为准, 尾部裁决不变。
    if (sawSession) continue;
    if (TUI_READY_RE.test(cap)) return { ready: true };
    // Shell prompt eating our Enter: an interactive blocker (omz update, etc.)
    // swallowed it. Dismiss with "N" + Enter, then re-send the full command.
    if (!resent && BLOCKER_RE.test(cap)) {
      log.warn({ pane }, "spawn-tmux: interactive blocker detected, dismissing");
      await runTmux(["send-keys", "-t", pane, "N", "Enter"]);
      await sleep(800);
      await runTmux(["send-keys", "-t", pane, cmd, "Enter"]);
      resent = true;
    }
  }
  // 注册表认得这个会话却迟迟不 idle (启动期对话框? 状态字段改了名?) —— 最后让 pane 裁决一次。
  const captured = await runTmux(["capture-pane", "-t", pane, "-p"]);
  const last = captured.ok ? captured.stdout : "";
  const exited = cliExit(last);
  if (exited) return { ready: false, exited };
  if (!startupConfirmation(last) && sawSession && TUI_READY_RE.test(last)) return { ready: true };
  log.warn({ pane, registry, sawSession }, "spawn-tmux: TUI ready timeout, proceeding anyway");
  return { ready: false };
};

export interface SpawnArgs {
  cfg: Config;
  log: Logger;
  /** Resume an existing claude session (its jsonl already exists) instead of
   *  minting a new uuid. Used when the user closed the original tmux pane and
   *  we need to reincarnate the same conversation in a fresh pane. */
  resumeSessionId?: string;
  /** A fresh session's id, chosen by the caller (ignored with `resumeSessionId`) —
   *  so the caller can fence it off from sibling sessions' dir scans before the
   *  pre-created jsonl appears. Omitted = minted here. */
  sessionId?: string;
  /** Cosmetic tmux window name (status-bar label). Falls back to sessionId.
   *  Pass the principal (e.g. "user:xxx") to make windows easy to skim. */
  windowName?: string;
  /** Per-chat cwd override. Empty/undefined → fall back to cfg.wrc.cwd.
   *  Mirror mode persists this in mirror-attachments.json so /new respawns
   *  in the user-bound project, not the global default. */
  cwdOverride?: string;
  /** Owner of a resumed transcript, used to reject cross-backend resume.
   *  Fresh panes always use the configured backend. */
  cli?: CliBackendName;
  /** Model to put the pane on. Lets sibling `#tag` sessions in one chat run on
   *  different models (a graph node can pick opus for design, haiku for lint).
   *  Passed as-is with `--model` — no guessing whether it is an id, a label or
   *  "最新的 opus". A value the CLI can't take shows up right at launch: it
   *  quits back to the shell (`cliExit`), or comes up echoing the raw string
   *  where a known model's display name would be (`modelNotRecognized`). Then
   *  the pane is thrown away and relaunched without `--model`, and the value
   *  goes through the pane's own `/model` picker instead (see
   *  `model-select.ts`) — a wrong id costs one extra launch, never the wizard.
   *  Undefined/empty → the CLI's own default. */
  model?: string;
  /** Reasoning effort, passed as `--effort` (session-scoped, unlike the
   *  `/effort <level>` command). Dropped for a backend with no such flag. */
  effort?: Effort;
  /** Fork the resumed session instead of continuing it (`--fork-session`).
   *  MANDATORY whenever a SECOND pane resumes a session the daemon still has
   *  bound: without it both panes append to the same jsonl and the two chats
   *  cross-wire irrecoverably. The CLI writes the forked transcript (a seeded
   *  copy of the parent) the moment the new pane takes its first message. */
  forkSession?: boolean;
  /** Wizard charter — pressed into the pane's SYSTEM prompt at launch
   *  (`--append-system-prompt`), not injected as a first message. Two reasons:
   *  a first message costs a turn and shows up in the chat, and it is the first
   *  thing `/clear` throws away — while identity is exactly what must survive a
   *  clear. Passed via `"$(cat <file>)"` so a multi-KB charter never travels
   *  through `send-keys` (a literal newline there would submit a half-typed
   *  command line). Ignored for backends with no such flag. */
  systemPrompt?: string;
}

export interface SpawnResult {
  ok: boolean;
  reason?: string;
  sessionId?: string;
  jsonlPath?: string;
  tmuxPane?: string;
  tmuxSession?: string;
  /** Effective cwd the pane was launched in. Mirrors `cwdOverride ?? cfg.wrc.cwd`
   *  after expandHome, so callers can persist it without re-resolving. */
  cwd?: string;
  /** Backend actually launched. */
  cli?: CliBackendName;
  /** What the pane is really on — this is what callers persist and a respawn
   *  passes straight back to `--model`, so it must never be a string the CLI
   *  already refused: the requested string when `--model` took it; else the
   *  picker row `/model` landed on (its id, e.g. "最新的 opus" → "claude-opus-5.5");
   *  else the ✔ row the pane was left on; else "" (the CLI's default). Only a
   *  string nothing has disproved (no launch failure, picker skipped) is kept
   *  as asked. Absent when no model was requested; `modelWarning` explains any
   *  fallback. */
  model?: string;
  modelWarning?: string;
  /** Effort the pane was launched with; absent when none was asked or the
   *  backend can't take it. */
  effort?: Effort;
}

// Pre-write the "trust this folder" + onboarding markers for `cwd` into
// claude's user-config json so the TUI doesn't park on the workspace-trust /
// onboarding prompts — those would silently swallow paste-buffer injects.
//
//   claude          → ~/.claude.json
//   claude-internal → ~/.claude-internal/.claude.json
//   <other>         → first existing of {~/.<bin>/.claude.json, ~/.<bin>.json};
//                     when neither exists we pick the dir-style path so the
//                     write also creates the conventional layout.
//
// Patch only this directory's trust/onboarding markers; external includes stay separate.
const claudeConfigCandidates = (claudeBin: string): string[] => {
  const home = homedir();
  const name = basename(claudeBin);
  if (name === "claude") return [join(home, ".claude.json")];
  return [join(home, `.${name}`, ".claude.json"), join(home, `.${name}.json`)];
};
export const trustWorkspace = (claudeBin: string, cwd: string, log: Logger): void => {
  if (basename(claudeBin) === "codex") return; // Native Codex trust belongs to its scoped TUI.
  const candidates = claudeConfigCandidates(claudeBin);
  const target: string = candidates.find(existsSync) ?? candidates[0]!;
  try {
    const directory = realpathSync(cwd);
    const original = existsSync(target) ? readFileSync(target, "utf8") : "{}\n";
    const patched = workspaceTrustConfig(original, directory);
    if (patched === original) return;
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, patched);
    log.info({ target, cwd: directory }, "trustWorkspace: marker written");
  } catch (e) {
    // A damaged user config is not ours to replace; the scoped pane path can recover.
    log.warn({ target, err: (e as Error).message }, "trustWorkspace: config unchanged");
  }
};

/** 一个会话一份宪章, 会话是无限多的 —— 留最近 200 份就够用 (真正在跑的 pane
 *  远少于此, 更老的那些对应的会话早已不存在)。best-effort: 清不掉也不影响 spawn。 */
const CHARTER_KEEP = 200;
const pruneCharters = (dir: string): void => {
  try {
    const files = readdirSync(dir).filter((n) => n.endsWith(".md"));
    if (files.length <= CHARTER_KEEP) return;
    files
      .map((n) => ({ p: join(dir, n), m: statSync(join(dir, n)).mtimeMs }))
      .sort((a, b) => b.m - a.m)
      .slice(CHARTER_KEEP)
      .forEach((f) => { try { unlinkSync(f.p); } catch { /* 下次再说 */ } });
  } catch { /* ignore */ }
};

/** Park a charter next to the daemon's other state and hand back the shell
 *  fragment that feeds it to the CLI. "" when the backend has no flag for it,
 *  or the write failed — a missing charter degrades the wizard's self-awareness,
 *  it must never cost us the pane. */
const charterArg = (cfg: Config, backend: CliBackend, sessionId: string, charter: string | undefined, log: Logger): string => {
  const text = (charter ?? "").trim();
  if (!text || !backend.systemPromptFlag) return "";
  try {
    const dir = join(expandHome(cfg.daemon.stateDir), "charters");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${sessionId}.md`);
    writeFileSync(file, text, "utf8");
    pruneCharters(dir);
    return `${backend.systemPromptFlag} "$(cat ${shQuote(file)})"`;
  } catch (e) {
    log.warn({ err: (e as Error).message }, "spawn-tmux: charter write failed; spawning without identity");
    return "";
  }
};

export const spawnTmuxClaude = async ({ cfg, log, resumeSessionId, sessionId: freshSessionId, windowName, cwdOverride, cli, model, effort, systemPrompt, forkSession }: SpawnArgs): Promise<SpawnResult> => {
  const backend = backendFor(cfg);
  if (resumeSessionId && cli && cli !== backend.name) {
    return { ok: false, reason: `会话属于 ${cli}, 当前配置后端是 ${backend.name}, 无法跨后端恢复或克隆。请用 /new 新建会话。` };
  }
  const cwd = expandHome((cwdOverride ?? "").trim() || cfg.wrc.cwd);
  const projectDir = join(expandHome(backend.projectsDir), backend.encodeProjectDir(cwd));
  let sessionId = resumeSessionId ?? freshSessionId ?? randomUUID();
  let jsonlPath = join(projectDir, `${sessionId}.jsonl`);
  const tmuxName = cfg.wrc.tmuxPrefix; // shared session for all chats
  const winName = safeWindowName(windowName ?? sessionId);

  // Probe tmux availability up front — clearer error than a generic spawn fail.
  // Also gate two flags on version: `-c <start-dir>` on new-session/new-window
  // landed in tmux 1.9; `-e KEY=VAL` in 3.0. Old tmux (e.g. CentOS 7 ships 1.8)
  // errors `unknown option -- c` and aborts the whole spawn — so when either is
  // unsupported we fold the equivalent into the launch command instead (`cd` +
  // inline env exports), which every tmux understands.
  const probe = await runTmux(["-V"]);
  if (!probe.ok) return { ok: false, reason: `tmux not available: ${probe.stderr.trim() || probe.code}` };
  const ver = parseTmuxVersion(probe.stdout);
  const supportsC = ver >= 1.9;
  const supportsE = ver >= 3.0;

  // Ensure cwd / projectDir exist (tmux `new-session -c` fails if cwd missing;
  // default `~/.wezard/workspace` often hasn't been touched yet). Do NOT
  // pre-create the jsonl: `claude --session-id <uuid>` refuses to start when
  // the transcript file already exists ("session id is already in use"). We
  // poll for it after spawn instead.
  try {
    mkdirSync(cwd, { recursive: true });
    mkdirSync(projectDir, { recursive: true });
  } catch (e) {
    return { ok: false, reason: `prepare cwd failed: ${(e as Error).message}` };
  }

  // Pre-trust the workspace so claude TUI doesn't park on the "Do you trust
  // this folder?" / onboarding prompts — those prompts swallow paste-buffer
  // injects and the approval card never fires. Best-effort: log + continue
  // on failure (worst case the user clicks through the prompts manually).
  if (backend.name !== "codex") trustWorkspace(backend.bin, cwd, log);

  let codexApprovalArgs: string[] = [];
  const sandboxDisabled = cfg.wrc.cliBackends.codex.disableSandbox;
  const codexSandboxArgs = backend.name === "codex" ? codexSandboxLaunchArgs(sandboxDisabled) : [];
  if (backend.name === "codex") {
    const conflict = sandboxDisabled ? codexSandboxArgConflict(cfg.wrc.extraArgs) : undefined;
    if (conflict) return { ok: false, reason: `Codex extraArgs ${conflict} conflicts with wrc.cliBackends.codex.disableSandbox; remove the shortcut and use the sandbox config` };
    const hookEntry = fileURLToPath(new URL("../cli/codex-hook.js", import.meta.url));
    const command = codexHookCommand(loadConfig().sourcePath, `http://127.0.0.1:${cfg.daemon.port}`, hookEntry);
    try { codexApprovalArgs = await codexHookLaunchArgs(backend.bin, cwd, command, cfg.approval.hookTimeoutSec + 10, cfg.approval.enabled); }
    catch (e) { return { ok: false, reason: `Codex approval hooks unavailable: ${(e as Error).message}` }; }
    try {
      const native = await prepareCodexSession(backend.bin, cwd, winName, [...codexApprovalArgs, ...codexSandboxArgs], {
        resumeSessionId, forkSession, model, systemPrompt, sandboxMode: codexSandboxMode(sandboxDisabled),
      });
      sessionId = native.sessionId;
      jsonlPath = native.jsonlPath;
    } catch (e) { return { ok: false, reason: `Codex session preparation failed: ${(e as Error).message}` }; }
  }

  // Reuse the shared session if alive; otherwise create it. Either way, end
  // up with a fresh window whose pane id we capture via `-P -F '#{pane_id}'`.
  //
  // Seed the new pane's environment (`-e`, tmux ≥3.0) BEFORE its shell sources
  // rc: oh-my-zsh runs its update check while sourcing .zshrc and, when due,
  // blocks on `[oh-my-zsh] Would you like to update? [Y/n]`. That prompt eats
  // the `claude …` command line + the trailing Enter, so claude never launches
  // and the injected message falls through to a bare shell (`command not
  // found: hi`). These two legacy vars (still honored for back-compat) disable
  // the prompt regardless of the user's zstyle config.
  const paneEnv = supportsE ? ["-e", "DISABLE_AUTO_UPDATE=true", "-e", "DISABLE_UPDATE_PROMPT=true"] : [];
  const cwdArg = supportsC ? ["-c", cwd] : [];
  // With no client attached a window takes the session's default-size — tmux's
  // own default is 80x24, and the codebuddy `/model` picker (30-odd unwindowed
  // rows, ids truncated at 80 cols) then scrolls its title and scope tab off
  // the screen: the picker reads as never opened. An attached human's terminal
  // still wins; this only sizes the panes nobody is looking at. Best-effort —
  // tmux < 2.9 has no default-size and keeps 80x24.
  const sizeArg = ["-x", String(DETACHED_COLS), "-y", String(DETACHED_ROWS)];
  const openPane = async (): Promise<{ pane: string } | { reason: string }> => {
    const has = await runTmux(["has-session", "-t", tmuxName]);
    if (has.code === 0) await runTmux(["set-option", "-t", tmuxName, "default-size", `${DETACHED_COLS}x${DETACHED_ROWS}`]);
    // `${tmuxName}:` (trailing colon) forces session-only resolution → next free
    // window index. Bare `-t wezard` is ambiguous: if a *window* is also named
    // `wezard`, tmux matches it and tries to reuse its index → "index N in use".
    const create = () => has.code === 0
      ? runTmux(["new-window", "-d", "-t", `${tmuxName}:`, "-n", winName, ...cwdArg, ...paneEnv, "-P", "-F", "#{pane_id}"])
      : runTmux(["new-session", "-d", "-s", tmuxName, "-n", winName, ...sizeArg, ...cwdArg, ...paneEnv, "-P", "-F", "#{pane_id}"]);
    let created = await create();
    // Server-side fork failing ENOMEM/EAGAIN is transient on swap-less macOS
    // (a momentary pressure spike, e.g. >20 CLI panes, fails fork outright) —
    // retry briefly before giving up.
    for (let retry = 0; !created.ok && retry < 2 && TRANSIENT_FORK_RE.test(created.stderr); retry++) {
      await sleep(500 * (retry + 1));
      created = await create();
    }
    // Every caller just returns this reason — without the warn a failed spawn
    // leaves zero trace in daemon.log (the 2026-10-14 ENOMEM was unfindable).
    if (!created.ok) {
      log.warn({ tmuxName, winName, stderr: created.stderr.trim(), code: created.code }, "spawn-tmux: pane creation failed");
      return { reason: `tmux ${has.code === 0 ? "new-window" : "new-session"} failed: ${created.stderr.trim() || created.code}` };
    }
    const pane = created.stdout.split("\n").map((s) => s.trim()).filter(Boolean)[0] ?? "";
    if (!pane) return { reason: "tmux returned no pane id" };
    log.info({ tmuxName, winName, tmuxPane: pane, cwd, sessionId, cli: backend.name, reused: has.code === 0 }, "spawn-tmux: pane created");
    return { pane };
  };

  // DISABLE_AUTOUPDATER=1 防止新 pane 启动时弹出 "An update is available" 询问 ——
  // 该交互会吞掉首条 paste-buffer 注入，导致仅落字符不进入 claude 输入框。
  // On old tmux the pane never got the two anti-update-prompt vars via `-e`, so
  // fold them into the command line as inline exports (`KEY=VAL cmd`).
  const envPrefix = [
    ...(supportsE ? [] : ["DISABLE_AUTO_UPDATE=true", "DISABLE_UPDATE_PROMPT=true"]),
    "DISABLE_AUTOUPDATER=1",
  ];
  const wanted = model?.trim() ?? "";
  const effortArg = effort && (backend.effortFlag || backend.name === "codex") ? effort : undefined;
  const charter = charterArg(cfg, backend, sessionId, systemPrompt, log);
  // A fresh session relaunched after a failed first try resumes instead if that
  // try already wrote the transcript — `--session-id` refuses an existing one.
  const commandFor = (flagModel: string | undefined, retry: boolean, pane: string): string => {
    const resume = !!resumeSessionId || (retry && existsSync(jsonlPath));
    const argv = [
      ...(backend.name === "codex"
        ? ["resume", sessionId]
        : (resume ? ["--resume", sessionId, ...(forkSession ? ["--fork-session"] : [])] : ["--session-id", sessionId])),
      ...(backend.name === "codex" ? [
        "--no-daemon",
        "-c", `mcp_servers.wezard.command=${JSON.stringify(process.execPath)}`,
        "-c", `mcp_servers.wezard.args=${JSON.stringify([fileURLToPath(new URL("../mcp/server.js", import.meta.url))])}`,
        "-c", `mcp_servers.wezard.env.WEZARD_DAEMON_BASE=${JSON.stringify(`http://127.0.0.1:${cfg.daemon.port}`)}`,
        "-c", `mcp_servers.wezard.env.TMUX_PANE=${JSON.stringify(pane)}`,
        "-c", `mcp_servers.wezard.env.CODEX_THREAD_ID=${JSON.stringify(sessionId)}`,
      ] : []),
      ...codexApprovalArgs,
      ...(backend.name === "codex" && effort ? ["-c", `model_reasoning_effort=${JSON.stringify(effort)}`] : []),
      ...(backend.name === "codex" && systemPrompt ? ["-c", `developer_instructions=${JSON.stringify(systemPrompt)}`] : []),
      ...(flagModel ? [backend.modelFlag!, flagModel] : []),
      ...(effortArg && backend.effortFlag ? [backend.effortFlag, effortArg] : []),
      ...cfg.wrc.extraArgs.filter((arg) => backend.name !== "codex" || !arg.startsWith("--disallowedTools")),
      ...codexSandboxArgs,
    ].map(shQuote);
    const cmd = [...envPrefix, shQuote(backend.bin), ...argv, charter].filter(Boolean).join(" ");
    // Old tmux couldn't set the pane's start-dir via `-c`; cd into it first.
    return `${supportsC ? cmd : `cd ${shQuote(cwd)} && ${cmd}`}${EXIT_TAIL}`;
  };

  type Launched = { ok: true; pane: string; ready: boolean; failure?: string } | { ok: false; reason: string };
  // One pane, one CLI process, verified up. `failure` = the CLI couldn't take
  // `flagModel`: it quit, or came up not knowing it.
  const launch = async (flagModel: string | undefined, retry = false): Promise<Launched> => {
    const opened = await openPane();
    if ("reason" in opened) return { ok: false, reason: opened.reason };
    const { pane } = opened;
    const fullCommand = commandFor(flagModel, retry, pane);
    // PTY canonical input truncates long hook/TOML arguments at ~4 KiB.
    // Send only a short script invocation through the interactive shell.
    const script = backend.name === "codex" ? join(tmpdir(), `wezard-codex-${randomUUID()}.sh`) : undefined;
    if (script) writeFileSync(script, `${fullCommand}\n`, { mode: 0o600, flag: "wx" });
    const line = script ? `/bin/sh ${shQuote(script)}` : fullCommand;
    const sent = await runTmux(["send-keys", "-t", pane, line, "Enter"]);
    if (!sent.ok) {
      if (script) try { unlinkSync(script); } catch { /* already removed */ }
      // Kill only this window/pane, never the shared session.
      await runTmux(["kill-pane", "-t", pane]);
      return { ok: false, reason: `tmux send-keys failed: ${sent.stderr.trim() || sent.code}` };
    }
    // Actively verify the TUI reached interactive state before returning.
    // claude does NOT create the transcript jsonl until it processes the first
    // user input, so we don't wait for the file — mirror tail tolerates a
    // missing jsonl and starts emitting once claude writes the first line.
    let tui: TuiState;
    try { tui = await waitForTuiReady(pane, line, backend, cwd, log); }
    finally { if (script) try { unlinkSync(script); } catch { /* already removed */ } }
    if (tui.exited) return { ok: true, pane, ready: false, failure: tui.exited };
    const unknown = !!flagModel && tui.ready && modelNotRecognized(await capturePaneBottom(pane, "-"), flagModel);
    return { ok: true, pane, ready: tui.ready, ...(unknown ? { failure: `CLI 不认识 --model ${flagModel} (欢迎框原样回显, 首轮会 400)` } : {}) };
  };

  // Whatever was asked goes straight in with `--model`. Only when the CLI
  // proves it can't take it is the pane thrown away and relaunched bare —
  // the ask then goes through the picker like any colloquial name.
  const flagModel = wanted && backend.modelFlag ? wanted : undefined;
  const first = await launch(flagModel);
  if (!first.ok) return { ok: false, reason: first.reason };
  let landed = first;
  const launchFailure = flagModel ? first.failure : undefined;
  if (launchFailure) {
    log.warn({ tmuxPane: first.pane, model: flagModel, reason: launchFailure }, "spawn-tmux: launch failure with --model, relaunching without it");
    await runTmux(["kill-pane", "-t", first.pane]);
    const bare = await launch(undefined, true);
    if (!bare.ok) return { ok: false, reason: `${launchFailure}; 不带 --model 重起也失败: ${bare.reason}` };
    if (bare.failure) {
      await runTmux(["kill-pane", "-t", bare.pane]);
      return { ok: false, reason: `${launchFailure}; 不带 --model 重起也失败: ${bare.failure}` };
    }
    landed = bare;
  }
  const tmuxPane = landed.pane;
  const viaFlag = !!flagModel && !launchFailure;

  // Model selection needs the TUI actually up (it types `/model` into the
  // input box and drives the picker) — skip it if readiness never confirmed, same as any other
  // post-launch step would have to.
  let resolvedModel = viaFlag ? wanted : "";
  let modelWarning: string | undefined;
  if (wanted && !viaFlag && landed.ready) {
    const sel = await selectModel(tmuxPane, wanted, log);
    if (sel.ok) {
      resolvedModel = sel.applied ?? wanted;
    } else {
      // Record where the pane really is, not the ask that just failed twice.
      resolvedModel = sel.current ?? "";
      modelWarning = sel.reason;
      log.warn({ tmuxPane, wanted, current: sel.current, reason: sel.reason }, "spawn-tmux: model selection failed, pane stays on its prior model");
    }
  } else if (wanted && !viaFlag) {
    // Unverified either way; the raw ask is only kept when the CLI never refused it.
    resolvedModel = launchFailure ? "" : wanted;
    modelWarning = "TUI 未就绪, 跳过了模型选择";
  }
  if (launchFailure) modelWarning = `${launchFailure}; ${modelWarning ?? "已不带 --model 重起并改走 /model 选择器"}`;

  if (backend.name === "codex") {
    if (!landed.ready || !existsSync(jsonlPath)) {
      const startupScreen = await capturePaneBottom(tmuxPane, 20);
      await runTmux(["kill-pane", "-t", tmuxPane]);
      return { ok: false, reason: `Codex pane did not resume its prepared session. ${startupScreen.slice(-500)}` };
    }
    recordCodexPaneSession({ sessionId, jsonlPath, cwd, pane: tmuxPane, startedAt: Date.now() }, cfg.daemon.stateDir);
  }
  log.info({ tmuxName, tmuxPane, sessionId, jsonlPath, cwd, cli: backend.name, model: resolvedModel, viaFlag, relaunched: !!launchFailure, effort: effortArg }, "spawn-tmux: ready");
  return {
    ok: true, sessionId, jsonlPath, tmuxPane, tmuxSession: tmuxName, cwd, cli: backend.name,
    ...(wanted ? { model: resolvedModel, ...(modelWarning ? { modelWarning } : {}) } : {}),
    ...(effortArg ? { effort: effortArg } : {}),
  };
};
