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
import { isSessionKey, windowLabel } from "../shared/session-label.js";
import { activateBackend, resolveCliBackend, type CliBackend, type CliBackendName } from "../shared/cli-backends.js";
import { selectModel } from "./model-select.js";
import type { Effort } from "../shared/effort.js";
import { hasRegistry, sessionOnPane } from "./wezard-session.js";
import { codebuddyTrustPrompt, startupConfirmation, workspaceTrustPrompt, workspaceTrustConfig } from "../shared/workspace-trust.js";
import { isModalPane } from "../shared/modal-pane.js";
import { unknownStartupNotice } from "../shared/startup-notice.js";


// New sessions follow configuration; resumed transcripts retain their backend.
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

/** spawn 撞上认不出的启动确认框时的广播出口: daemon 接线时装上 (向该 spawn 的企微
 * 频道发一条 markdown, 与审批卡同源的频道换算)。没装 / 抛错 = 只记日志, 不回灌 spawn。 */
export type StartupNoticeFn = (chatKey: string, text: string) => void;
let _startupNotice: StartupNoticeFn | undefined;
export const bindStartupNotice = (fn: StartupNoticeFn): void => { _startupNotice = fn; };

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

// `tmux -V` 只是能力门槛, 每次 spawn 探一遍、补位再探一遍纯属白花 fork。成功就缓存
// (daemon 活着的时候 tmux 不会降级); 失败不缓存 —— 装上 tmux 之后不必等 reload。
let tmuxProbe: ExecResult | undefined;
const tmuxProbeResult = async (): Promise<ExecResult> => {
  if (tmuxProbe?.ok) return tmuxProbe;
  const r = await runTmux(["-V"]);
  if (r.ok) tmuxProbe = r;
  return r;
};


// ── 暖 shell 池 ──────────────────────────────────────────────────────────
//
// 新 pane 的登录 zsh 要先源完 rc (实测 1.1–1.4s), 我们 send-keys 的启动行才排得上;
// 之后才是 CLI 自己的 init (2.4–4s)。前一段和 CLI 无关, 可以提前做掉: 池里养一条空
// shell, spawn 时把它的窗口搬进主 session 再往里面打启动行, 整段 rc 就省了。
//
// 暖 pane 必须住在**另一个 session** (`<prefix>-warm`): pane 上限与孤儿清扫只认主
// session (`session === cfg.wrc.tmuxPrefix`), 主 session 里没绑定的 pane 会被当孤儿
// 杀掉 —— 池里的 pane 在搬过去之前恰好就是「没绑定」。
//
// 池按 cwd 分槽 (pane 的起始目录在创建那刻就定了), 每槽最多一个、总量 3: 暖 pane 是
// 白占的内存, 养多了反而把 spawn 的 fork 预算吃掉 (macOS 无 swap, 见 TRANSIENT_FORK_RE)。
const WARM_LIMIT = 3;
// 壳是养着的, rc 里的环境可能早变了: 20 分钟换一条新的, 别让一次 export 永远留在池里。
const WARM_TTL_MS = 20 * 60_000;
// 前台还停在这些壳上 = 这条 pane 没被谁拿去跑东西。前导 "-" 是登录 shell 的写法。
const SHELL_CMD_RE = /^-?(zsh|bash|sh|fish|dash|ksh)$/;
// 与 spawn 里的 paneEnv 同源 (rc 的 oh-my-zsh 更新询问会吃掉启动行); 暖 pane 建在
// tmux ≥3.0 上, 所以直接走 `-e`。
const ANTI_UPDATE_ENV = ["-e", "DISABLE_AUTO_UPDATE=true", "-e", "DISABLE_UPDATE_PROMPT=true"];

interface WarmShell {
  pane: string;
  usedAt: number;
  timer?: NodeJS.Timeout;
}

const warmPool = new Map<string, WarmShell>();
// 同一 cwd 的补位去重: 补位是 fire-and-forget, 连着开两个会话会同时补。
const warmInflight = new Set<string>();
// reload 后池是空的, warm session 里却可能留着上一个进程的 pane —— 第一次补位前清一次。
let warmSwept = false;

const warmEnabled = (): boolean => process.env.WEZARD_WARM_SHELL !== "0";
const warmSessionOf = (cfg: Config): string => `${cfg.wrc.tmuxPrefix}-warm`;

/** 槽键 = realpath 后的 cwd: `-c` 收的是原样字符串, 但同一个目录的两种写法该占一槽。 */
const warmKey = (cwd: string): string => { try { return realpathSync(cwd); } catch { return cwd; } };
const disarmWarm = (entry: WarmShell): void => { if (entry.timer) clearTimeout(entry.timer); };

/** 到点还在池里 = 没人要它, 且它带的环境可能已经过时: 换一条新的。 */
const armWarmTtl = (cfg: Config, cwd: string, log: Logger, entry: WarmShell): void => {
  entry.timer = setTimeout(() => {
    if (warmPool.get(warmKey(cwd)) !== entry) return;
    warmPool.delete(warmKey(cwd));
    void runTmux(["kill-pane", "-t", entry.pane]).then(() => prewarmShell(cfg, cwd, log));
  }, WARM_TTL_MS);
  // 一条暖 pane 不该拖住 daemon 退出。
  entry.timer.unref();
};

/** 超量的槽里最久没用的先 kill。 */
const trimWarmPool = (log: Logger): void => {
  while (warmPool.size > WARM_LIMIT) {
    const [key, entry] = [...warmPool.entries()].sort((a, b) => a[1].usedAt - b[1].usedAt)[0]!;
    warmPool.delete(key);
    disarmWarm(entry);
    void runTmux(["kill-pane", "-t", entry.pane]);
    log.debug({ pane: entry.pane, cwd: key }, "warm shell: evicted");
  }
};

// 暖 shell 与备用 CLI 共用一条 warm session。建那条 session 的那一下必须串起来: 一方
// new-session、另一方 new-window, 会撞出 "duplicate session" / "no server running"
// (warm session 空掉时 tmux 会把它整个销毁, 池里的 pane 一搬走就可能空)。
let warmSessionLock: Promise<unknown> = Promise.resolve();
const warmSessionExclusive = <T>(fn: () => Promise<T>): Promise<T> => {
  const run = warmSessionLock.then(fn, fn);
  warmSessionLock = run.catch(() => undefined);
  return run;
};

/** 在 warm session 里开一条新窗口, 返回 pane id。undefined = 建不出来 (只记日志)。 */
const openWarmPane = (
  warm: string,
  dir: string,
  name: string,
  flags: { cwd: boolean; env: boolean },
  log: Logger,
): Promise<string | undefined> => warmSessionExclusive(async () => {
  const argv = (sessionless: boolean): string[] => [
    ...(sessionless ? [] : ["-d", "-t", `=${warm}:`]),
    "-n", name,
    ...(sessionless ? ["-x", String(DETACHED_COLS), "-y", String(DETACHED_ROWS)] : []),
    ...(flags.cwd ? ["-c", dir] : []),
    ...(flags.env ? ANTI_UPDATE_ENV : []),
    "-P", "-F", "#{pane_id}",
  ];
  const create = async (): Promise<ExecResult> => {
    const has = await runTmux(["has-session", "-t", `=${warm}`]);
    // 首次建 session 时它自带的那个 pane 就是第一片 —— 不再 new-window, 否则 session
    // 里永远多躺一条没人认领的空 shell。
    return has.code === 0
      ? runTmux(["new-window", ...argv(false)])
      : runTmux(["new-session", "-d", "-s", warm, ...argv(true)]);
  };
  let made = await create();
  // "没 server / 刚被别人建出来 / 刚被销毁" 都是竞态而不是结论: 再问一次。
  for (let retry = 0; !made.ok && retry < 2 && /duplicate session|no server running|can't find session|no current session/i.test(made.stderr); retry++) {
    await sleep(150);
    made = await create();
  }
  if (!made.ok) {
    log.warn({ warm, cwd: dir, stderr: made.stderr.trim(), code: made.code }, `${name}: pane creation failed`);
    return undefined;
  }
  // 没人 attach 的窗口取 session 的 default-size, tmux 自己的默认是 80x24。
  await runTmux(["set-option", "-t", `=${warm}`, "default-size", `${DETACHED_COLS}x${DETACHED_ROWS}`]);
  return made.stdout.split("\n").map((s) => s.trim()).filter(Boolean)[0] || undefined;
});

/** 一次性清掉上一个 daemon 进程留下的暖 pane (池里没有的都不是本进程的)。 */
const sweepWarmSession = async (warm: string, log: Logger): Promise<void> => {
  if (warmSwept) return;
  warmSwept = true;
  const r = await runTmux(["list-panes", "-s", "-t", `=${warm}`, "-F", "#{pane_id}"]);
  // 超时 = 没问出结果, 残件还在: 复位让下一次补位重试 (session 不存在之类的其他失败
  // 算扫过 —— 没有 pane 就没什么可清的)。
  if (r.timedOut) { warmSwept = false; return; }
  if (!r.ok) return;
  // 备用 CLI 与暖 shell 同住一个 session, 两条池都要认 —— 不然第一次补位就把本进程
  // 刚建好的备用当上一个进程的残件杀了。
  const known = new Set([...[...warmPool.values()].map((e) => e.pane), ...spares.map((s) => s.pane)]);
  const doomed = r.stdout.split("\n").map((s) => s.trim()).filter((p) => p && !known.has(p));
  for (const pane of doomed) await runTmux(["kill-pane", "-t", pane]);
  if (doomed.length) log.info({ panes: doomed }, "warm shell: killed panes left by a previous process");
};

/** 给 cwd 补一条暖 shell。唯一入口, 只记日志不抛错 —— 暖 pane 是提速, 不是前提。 */
export const prewarmShell = async (cfg: Config, cwd: string, log: Logger): Promise<void> => {
  // 调用方可能给的是 `~/…` (cfg.wrc.cwd 的原样写法): tmux 的 -c 不认 `~`, 先展开。
  const dir = expandHome(cwd);
  if (!warmEnabled() || !existsSync(dir)) return;
  const key = warmKey(dir);
  if (warmPool.has(key) || warmInflight.has(key)) return;
  warmInflight.add(key);
  try {
    // 老 tmux (没有 `-e`) 建不出带防更新变量的 pane, 这种机器照旧走冷路径。
    const probe = await tmuxProbeResult();
    if (!probe.ok || parseTmuxVersion(probe.stdout) < 3.0) return;
    const warm = warmSessionOf(cfg);
    // 清理得排在问 session 之前: tmux 会销毁没有窗口的 session, 清掉最后一个暖 pane 之后
    // 这条 session 就没了 ("can't find session"), 必须重新问一次才能建窗口。
    if (!warmSwept) await sweepWarmSession(warm, log);
    const pane = await openWarmPane(warm, dir, "warm", { cwd: true, env: true }, log);
    if (!pane) return;
    const entry: WarmShell = { pane, usedAt: Date.now() };
    warmPool.set(key, entry);
    armWarmTtl(cfg, dir, log, entry);
    trimWarmPool(log);
    log.info({ warm, pane, cwd: key }, "warm shell: prewarmed");
  } catch (e) {
    log.warn({ cwd: dir, err: (e as Error).message }, "warm shell: prewarm failed");
  } finally {
    warmInflight.delete(key);
  }
};

/** 领一条同 cwd 的暖 pane 搬进主 session。undefined = 没有可用的, 调用方走冷路径。 */
const claimWarmShell = async (cfg: Config, log: Logger, cwd: string, tmuxName: string, winName: string): Promise<string | undefined> => {
  if (!warmEnabled()) return undefined;
  const key = warmKey(cwd);
  const entry = warmPool.get(key);
  if (!entry) return undefined;
  // 先摘再 await: 两个并发 spawn 不能领到同一条 shell。
  warmPool.delete(key);
  disarmWarm(entry);
  const probe = await runTmux(["display-message", "-p", "-t", entry.pane, "#{pane_dead}\t#{pane_current_command}\t#{pane_current_path}\t#{window_id}"]);
  const [dead = "", foreground = "", path = "", window = ""] = probe.ok ? probe.stdout.trim().split("\t") : [];
  const sameDir = ((): boolean => { try { return realpathSync(path) === key; } catch { return false; } })();
  // 壳已经没了 / 被谁拿去跑东西了 / 起始目录不对: 它不再是空白 shell, 冷路径更安全。
  if (!probe.ok || dead !== "0" || !SHELL_CMD_RE.test(basename(foreground)) || !sameDir || !window) {
    await runTmux(["kill-pane", "-t", entry.pane]);
    log.debug({ pane: entry.pane, cwd: key, foreground, path, stderr: probe.stderr.trim() }, "warm shell: claim rejected");
    return undefined;
  }
  // 尾冒号 = 只按 session 解析 (同 openPane 里 new-window 的理由)。搬家不改 pane id。
  const moved = await runTmux(["move-window", "-d", "-s", window, "-t", `=${tmuxName}:`]);
  if (!moved.ok) {
    await runTmux(["kill-pane", "-t", entry.pane]);
    log.warn({ pane: entry.pane, cwd: key, stderr: moved.stderr.trim(), code: moved.code }, "warm shell: move-window failed, falling back to cold spawn");
    return undefined;
  }
  await renameWindow(entry.pane, winName);
  log.info({ pane: entry.pane, cwd: key, tmuxName }, "warm shell: claimed");
  return entry.pane;
};

// ── 空白备用池 ──────────────────────────────────────────────────────────
//
// 冷启动一条空白 CLI 要 2.4–2.9s, 而这段时间的输入 —— cwd / 后端 / model / effort ——
// 在会话建起来之前就定了。于是可以按这四元组提前建好、白养着, 新会话来了把窗口搬进主
// session 直接用。备用是**冷启动**而不是 fork: 实测 fork 既不省就绪时间, 又会和父会话
// 抢首条消息 (POOL-DESIGN 的测量)。
//
// 住在 `<prefix>-warm` (与暖 shell 同住): pane 上限与孤儿清扫只认主 session, 池里的
// pane 在搬过去之前恰好都是「没绑定」的。
//
// 备用**不带宪章**: 宪章按会话不同, 池按四元组共享 —— 领用方的身份由它的首条消息补
// (mirror-bridge 的 charterPending)。所以池与「宪章改走首条消息」必须同批上线。
const SPARE_CLAIM_WAIT_MS = 2000;
// 领走之后 sid 还要在别人的目录扫描面前挡一会儿: attach 落定之前它仍是一条「住在
// 这个 cwd 里、没有任何绑定指着」的 jsonl。
const SPARE_FENCE_MS = 5 * 60_000;

interface Spare {
  key: string;
  pane: string;
  sessionId: string;
  jsonlPath: string;
  cwd: string;
  cli: CliBackendName;
  model: string;
  builtAt: number;
  timer?: NodeJS.Timeout;
}

const spares: Spare[] = [];
// 同键只建一条: 补位是 fire-and-forget, 连着两次冷启动不该各补一条。
const spareInflight = new Map<string, Promise<void>>();
// 池里 / 刚被领走的 sid。mirror 的目录扫描 (newest-in-cwd 自愈、分叉跟随) 与 /sessions
// 扫描都要绕开它们 —— 一条没绑定的会话在别人眼里就是可以认领的孤儿。
const pooledSids = new Set<string>();
const claimedSids = new Map<string, number>();

const sparePoolEnabled = (cfg: Config): boolean =>
  process.env.WEZARD_SPARE_POOL !== "0" && cfg.wrc.sparePool.enabled;

export const sparePoolFencedSids = (now = Date.now()): string[] => {
  for (const [sid, at] of claimedSids) if (now - at > SPARE_FENCE_MS) claimedSids.delete(sid);
  return [...pooledSids, ...claimedSids.keys()];
};

const spareKeyOf = (cwd: string, cli: CliBackendName, model: string, effort: string): string =>
  `${warmKey(cwd)}\u0000${cli}\u0000${model.trim()}\u0000${effort}`;

/** `--effort` 只在这把后端认它时才算进键: 后端不收的档位, 起出来的都是同一个东西。 */
const spareEffort = (backend: CliBackend, effort: Effort | undefined): Effort | undefined =>
  effort && backend.effortFlag ? effort : undefined;

const dropSpare = (spare: Spare, why: "expired" | "evicted" | "unusable", log: Logger): void => {
  const at = spares.indexOf(spare);
  if (at >= 0) spares.splice(at, 1);
  if (spare.timer) clearTimeout(spare.timer);
  pooledSids.delete(spare.sessionId);
  claimedSids.delete(spare.sessionId);
  void runTmux(["kill-pane", "-t", spare.pane]);
  log.info({ pane: spare.pane, sessionId: spare.sessionId, key: spare.key, ageMs: Date.now() - spare.builtAt, why }, `spawn-tmux: spare ${why}`);
};

const armSpareTtl = (cfg: Config, log: Logger, spare: Spare): void => {
  spare.timer = setTimeout(() => {
    // 到点不补: 没人要它才轮到过期, 再养一条还是没人要。
    if (spares.includes(spare)) dropSpare(spare, "expired", log);
  }, cfg.wrc.sparePool.ttlMin * 60_000);
  spare.timer.unref();
};

/** 同键超量先收新建的 (池里的备用都一样热, 留老的不吃亏); 全局超量按最久未用跨键收。 */
const trimSpares = (cfg: Config, log: Logger): void => {
  const { perKey, maxTotal } = cfg.wrc.sparePool;
  for (const key of new Set(spares.map((s) => s.key))) {
    const same = spares.filter((s) => s.key === key).sort((a, b) => a.builtAt - b.builtAt);
    for (const extra of same.slice(perKey)) dropSpare(extra, "evicted", log);
  }
  while (spares.length > maxTotal) {
    const oldest = [...spares].sort((a, b) => a.builtAt - b.builtAt)[0]!;
    dropSpare(oldest, "evicted", log);
  }
};

/** 建一条备用。唯一入口, 只记日志不抛错 —— 备用是提速, 不是前提。 */
const buildSpare = async (
  cfg: Config,
  log: Logger,
  spec: { cwd: string; backend: CliBackend; model: string; effort?: Effort; key: string },
): Promise<void> => {
  const t0 = Date.now();
  const dir = spec.cwd;
  const sessionId = randomUUID();
  const projectDir = join(expandHome(spec.backend.projectsDir), spec.backend.encodeProjectDir(dir));
  const jsonlPath = join(projectDir, `${sessionId}.jsonl`);
  const warm = warmSessionOf(cfg);
  // 从建窗那刻就挡住目录扫描 —— CLI 一起来就可能写 jsonl。
  pooledSids.add(sessionId);
  try {
    mkdirSync(dir, { recursive: true });
    mkdirSync(projectDir, { recursive: true });
    trustWorkspace(spec.backend.bin, dir, log);
    const probe = await tmuxProbeResult();
    if (!probe.ok) { poolRemove(sessionId); return; }
    const ver = parseTmuxVersion(probe.stdout);
    const supportsC = ver >= 1.9;
    const supportsE = ver >= 3.0;
    if (!warmSwept) await sweepWarmSession(warm, log);
    const pane = await openWarmPane(warm, dir, "spare", { cwd: supportsC, env: supportsE }, log);
    if (!pane) { poolRemove(sessionId); return; }
    // 与 commandFor 同形的启动行: 不带宪章、不带 resume, 只把这一档的环境定下来。
    const envPrefix = [
      ...(supportsE ? [] : ["DISABLE_AUTO_UPDATE=true", "DISABLE_UPDATE_PROMPT=true"]),
      "DISABLE_AUTOUPDATER=1",
    ];
    const argv = [
      "--session-id", sessionId,
      ...(spec.model && spec.backend.modelFlag ? [spec.backend.modelFlag, spec.model] : []),
      ...(spec.effort && spec.backend.effortFlag ? [spec.backend.effortFlag, spec.effort] : []),
      ...cfg.wrc.extraArgs,
    ].map(shQuote);
    const cmd = [...envPrefix, shQuote(spec.backend.bin), ...argv].join(" ");
    const line = `${supportsC ? cmd : `cd ${shQuote(dir)} && ${cmd}`}${EXIT_TAIL}`;
    const sent = await runTmux(["send-keys", "-t", pane, line, "Enter"]);
    if (!sent.ok) {
      await runTmux(["kill-pane", "-t", pane]);
      poolRemove(sessionId);
      return;
    }
    log.info({ tmuxName: warm, winName: "spare", tmuxPane: pane, cwd: dir, sessionId, cli: spec.backend.name, spare: true }, "spawn-tmux: pane created");
    // 与正常启动同一套就绪判据 (注册表 idle / 输入框 / 退出标记)。
    const tui = await waitForTuiReady(pane, line, spec.backend, dir, undefined, log);
    // 建不成就是建不成: 失败只 kill, 绝不重试 —— 认不出的 model id 会被重试一次次砸在
    // 同一个判据上, 而备用本来只是提速。
    if (!tui.ready || tui.exited) {
      await runTmux(["kill-pane", "-t", pane]);
      poolRemove(sessionId);
      log.warn({ pane, cwd: dir, reason: tui.exited ?? "TUI 未就绪", ms: Date.now() - t0 }, "spawn-tmux: spare unusable");
      return;
    }
    if (spec.model && spec.backend.modelFlag && modelNotRecognized(await capturePaneBottom(pane, "-"), spec.model)) {
      await runTmux(["kill-pane", "-t", pane]);
      poolRemove(sessionId);
      log.warn({ pane, model: spec.model }, "spawn-tmux: spare unusable (CLI 不认识这个 --model)");
      return;
    }
    const spare: Spare = { key: spec.key, pane, sessionId, jsonlPath, cwd: dir, cli: spec.backend.name, model: spec.model, builtAt: Date.now() };
    spares.push(spare);
    armSpareTtl(cfg, log, spare);
    trimSpares(cfg, log);
    log.info({ pane, sessionId, key: spec.key, cwd: dir, cli: spec.backend.name, model: spec.model, effort: spec.effort, ms: Date.now() - t0 }, "spawn-tmux: spare built");
  } catch (e) {
    if (!spares.some((s) => s.sessionId === sessionId)) poolRemove(sessionId);
    log.warn({ cwd: dir, err: (e as Error).message }, "spawn-tmux: spare build failed");
  }
};

/** 从扫描围栏里摘掉 sid。池里那条由 dropSpare 自己管。 */
const poolRemove = (sessionId: string): void => {
  pooledSids.delete(sessionId);
  claimedSids.delete(sessionId);
};

/** 领一条同键的备用搬进主 session。undefined = 没有可用的, 调用方走冷路径。 */
const claimSpare = async (
  cfg: Config,
  log: Logger,
  want: { cwd: string; backend: CliBackend; model: string; effort?: Effort; tmuxName: string; winName: string },
): Promise<Spare | undefined> => {
  if (!sparePoolEnabled(cfg)) return undefined;
  const key = spareKeyOf(want.cwd, want.backend.name, want.model, want.effort ?? "");
  // 同键正在补的那条马上就好时, 等它一拍比另起一条冷启动划算 (冷路径 4–5s)。
  if (!spares.some((s) => s.key === key)) {
    const inflight = spareInflight.get(key);
    if (inflight) await Promise.race([inflight, sleep(SPARE_CLAIM_WAIT_MS)]);
  }
  const at = spares.findIndex((s) => s.key === key);
  if (at < 0) return undefined;
  // 先摘再 await: 两个并发 spawn 不能领到同一条。
  const [spare] = spares.splice(at, 1);
  if (!spare) return undefined;
  if (spare.timer) clearTimeout(spare.timer);
  pooledSids.delete(spare.sessionId);
  claimedSids.set(spare.sessionId, Date.now());
  const reject = async (why: string, detail: Record<string, unknown> = {}): Promise<undefined> => {
    await runTmux(["kill-pane", "-t", spare.pane]);
    poolRemove(spare.sessionId);
    log.debug({ pane: spare.pane, key, why, ...detail }, "spawn-tmux: spare rejected, falling back to cold spawn");
    return undefined;
  };
  const probe = await runTmux(["display-message", "-p", "-t", spare.pane, "#{pane_dead}\t#{pane_current_command}\t#{window_id}"]);
  const [dead = "", foreground = "", window = ""] = probe.ok ? probe.stdout.trim().split("\t") : [];
  // pane 活着、前台还是那个 CLI (退回 shell = 它已经退出)、窗口还在。
  if (!probe.ok || dead !== "0" || SHELL_CMD_RE.test(basename(foreground)) || !window) {
    return reject("pane not live", { foreground, dead, stderr: probe.stderr.trim() });
  }
  // 只看当前屏 (bare `-p`): 卷进 scrollback 会把已经关掉的框当成活模态。
  const captured = await runTmux(["capture-pane", "-t", spare.pane, "-p"]);
  const screen = captured.ok ? captured.stdout : "";
  const tuiUp = TUI_READY_RE.test(screen) || sessionOnPane(want.backend.homeDir, spare.pane)?.status === "idle";
  if (cliExit(screen)) return reject("cli exited");
  if (startupConfirmation(screen)) return reject("startup confirmation on screen");
  if (workspaceTrustPrompt(screen, want.backend.name, want.cwd, realpathSync)) return reject("workspace trust prompt on screen");
  if (codebuddyTrustPrompt(screen, want.cwd, realpathSync)) return reject("codebuddy trust prompt on screen");
  if (isModalPane(screen).modal) return reject("modal on screen");
  if (!tuiUp) return reject("no input box");
  // 主 session 可能刚被 reap 掉 (最后一个 pane 收掉时 tmux 连 session 一起销毁): 先把它
  // 建起来再把备用搬进来, 用完收掉占位窗口 —— 与冷路径 new-session 那一支同形。
  const has = await runTmux(["has-session", "-t", `=${want.tmuxName}`]);
  let seedPane = "";
  if (has.code !== 0) {
    const seed = await runTmux(["new-session", "-d", "-s", want.tmuxName, "-n", want.winName, "-x", String(DETACHED_COLS), "-y", String(DETACHED_ROWS), "-P", "-F", "#{pane_id}"]);
    if (!seed.ok) return reject("main session creation failed", { stderr: seed.stderr.trim(), code: seed.code });
    seedPane = seed.stdout.trim();
    await runTmux(["set-option", "-t", `=${want.tmuxName}`, "default-size", `${DETACHED_COLS}x${DETACHED_ROWS}`]);
  }
  // 尾冒号 = 只按 session 解析 (同 openPane 里 new-window 的理由)。搬家不改 pane id。
  const moved = await runTmux(["move-window", "-d", "-s", window, "-t", `=${want.tmuxName}:`]);
  if (seedPane) await runTmux(["kill-pane", "-t", seedPane]);
  if (!moved.ok) return reject("move-window failed", { stderr: moved.stderr.trim(), code: moved.code });
  await renameWindow(spare.pane, want.winName);
  log.info({ pane: spare.pane, sessionId: spare.sessionId, key, cwd: spare.cwd, cli: spare.cli, model: spare.model, ageMs: Date.now() - spare.builtAt, ms: Date.now() - spare.builtAt }, "spawn-tmux: spare claimed");
  return spare;
};

/** 补一条该键的备用 (fire-and-forget)。冷启动成功与领用之后都走这里。 */
export const ensureSpare = async (cfg: Config, log: Logger, cwd: string, model: string | undefined, effort: Effort | undefined): Promise<void> => {
  if (!sparePoolEnabled(cfg) || !existsSync(cwd)) return;
  const backend = backendFor(cfg);
  // codex 的会话由 app-server 预热出来, 不是一条命令 —— 备用的形状不一样, 不掺和。
  if (backend.name === "codex") return;
  const eff = spareEffort(backend, effort);
  const key = spareKeyOf(cwd, backend.name, model ?? "", eff ?? "");
  if (spareInflight.has(key)) return;
  if (spares.filter((s) => s.key === key).length >= cfg.wrc.sparePool.perKey) return;
  if (cfg.wrc.sparePool.maxTotal <= 0) return;
  // 全局满了先按 LRU 腾位置: 这条冷启动刚证明可用, 比一条躺着没人要的更值钱。
  while (spares.length >= cfg.wrc.sparePool.maxTotal) {
    const oldest = [...spares].sort((a, b) => a.builtAt - b.builtAt)[0];
    if (!oldest) break;
    dropSpare(oldest, "evicted", log);
  }
  const job = buildSpare(cfg, log, { cwd, backend, model: model?.trim() ?? "", effort: eff, key })
    .catch((e: unknown) => log.warn({ cwd, err: (e as Error).message }, "spawn-tmux: spare build failed"))
    .finally(() => spareInflight.delete(key));
  spareInflight.set(key, job);
};

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
// 名字的写法 `.fix` 与 `fix` 是同一个人: 前导点在这里剥掉, 两种拼法印同一个窗口名。
const safeWindowName = (s: string): string => {
  const isPrincipal = s.startsWith("user:") || s.startsWith("chat:");
  const compact = s.startsWith("user:") ? `u-${s.slice(5)}`
    : s.startsWith("chat:") ? `c-${s.slice(5)}`
    : s;
  const slug = compact.replace(/^\.+/, "").replace(/[^A-Za-z0-9_.\-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
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
// Poll interval for capture-pane checks. codebuddy 不写带 tmux 字段的会话注册表, 读屏
// 是它唯一的证人 —— 就绪与否全看这一眼, 400ms 一拍等于平均白等 0.2–0.4s。读屏是一次
// tmux capture-pane (几十 ms), 150ms 的节奏仍在预算内。
const SCREEN_POLL_MS = 150;
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
export const answerWorkspaceTrust = async (pane: string, backend: CliBackendName, cwd: string, log: Logger, screen?: string): Promise<boolean> => {
  const capture = async (): Promise<string> => {
    const r = await runTmux(["capture-pane", "-t", pane, "-p"]);
    return r.ok ? r.stdout : "";
  };
  // screen = 调用方本拍刚读过的那一屏, 省掉一次白读; 按键之后的复读必须重新读。
  const before = workspaceTrustPrompt(screen ?? await capture(), backend, cwd, realpathSync);
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

// CodeBuddy 的四选项目录信任选择器 (形状见 shared/workspace-trust.ts 的 codebuddyTrustPrompt):
// 自动选第 1 项 Trust folder only —— 与预写信任 (trustWorkspace) 同一授权范围, 只限本目录。
// 实测按键语义 (v2.167): 高亮默认在第 1 项, 单发 Enter 即确认; 数字键则「选中即确认」,
// 单发 1 就落。因此按高亮位置二选一, 永远只发一个键; 发送后等一拍必须看到框已消失且
// CLI 没退 —— 框还在说明键没生效, 立即返回 false 退回「只通知」路径, 绝不补发第二个键。
export const answerCodebuddyTrust = async (pane: string, cwd: string, log: Logger, screen?: string): Promise<boolean> => {
  const capture = async (): Promise<string> => {
    const r = await runTmux(["capture-pane", "-t", pane, "-p"]);
    return r.ok ? r.stdout : "";
  };
  // screen = 调用方本拍刚读过的那一屏; 按键之后的复读照旧现读 (要看的是框有没有消失)。
  const before = codebuddyTrustPrompt(screen ?? await capture(), cwd, realpathSync);
  if (!before) return false;
  const key = before.selected === 0 ? "Enter" : "1";
  const sent = await runTmux(["send-keys", "-t", pane, key]);
  if (!sent.ok) return false;
  await sleep(600);
  const after = await capture();
  if (codebuddyTrustPrompt(after, cwd, realpathSync) !== undefined) return false;
  if (cliExit(after)) return false;
  log.info({ pane, cwd, key }, "codebuddy trust: confirmed folder-only trust");
  return true;
};

/** 该 spawn 的企微频道上下文; 有则认不出的启动确认框会广播一条通知过去。 */
interface SpawnNoticeCtx {
  /** 该 spawn 服务的会话 principal; 空 = 无通道, 只记日志。 */
  chatKey?: string;
  who: string;
  tmuxSession: string;
}

const waitForTuiReady = async (
  pane: string,
  cmd: string,
  backend: CliBackend,
  cwd: string,
  notice: SpawnNoticeCtx | undefined,
  log: Logger,
): Promise<TuiState> => {
  const registry = hasRegistry(backend.homeDir);
  const t0 = Date.now();
  const deadline = t0 + MIN_SETTLE_MS + TUI_READY_TIMEOUT_MS;
  let resent = false;
  let sawSession = false;
  let lastCap = 0;
  // 认不出的启动确认框: ready 判定照旧不放行 (留给本地人工, 不按任何键), 但把这只
  // 远端看不见的框广播到该 spawn 的频道 —— 同一形状只发一次 (指纹), 一次 spawn 最多
  // 3 条 (框里带动态内容时兜底)。fire-and-forget: 失败只记日志, 不阻塞轮询。
  let noticedFp: string | undefined;
  let noticeCount = 0;
  const notifyUnknownFrame = (screen: string): void => {
    if (!notice?.chatKey || noticeCount >= 3) return;
    const n = unknownStartupNotice({ who: notice.who, pane, tmuxSession: notice.tmuxSession, cwd, screen });
    if (!n.fp || n.fp === noticedFp) return;
    noticedFp = n.fp;
    noticeCount += 1;
    log.info({ pane, cwd, who: notice.who }, "spawn-tmux: unknown startup confirmation, notifying chat");
    try { _startupNotice?.(notice.chatKey, n.text); }
    catch (e) { log.warn({ pane, err: (e as Error).message }, "spawn-tmux: startup notice dispatch failed"); }
  };
  while (Date.now() < deadline) {
    await sleep(registry ? REGISTRY_POLL_MS : SCREEN_POLL_MS);
    let registryIdle = false;
    if (registry) {
      const s = sessionOnPane(backend.homeDir, pane);
      registryIdle = s?.status === "idle";
      if (s) sawSession = true;
    }
    // Shell rc needs time to source before capture-pane shows anything meaningful.
    if (Date.now() - t0 < MIN_SETTLE_MS) continue;
    // pane 那一路仍按 SCREEN_POLL_MS 的节奏读屏 —— 注册表查得再密也不多起 tmux。
    if (Date.now() - lastCap < SCREEN_POLL_MS) continue;
    lastCap = Date.now();
    const captured = await runTmux(["capture-pane", "-t", pane, "-p"]);
    if (!captured.ok) continue;
    const cap = captured.ok ? captured.stdout : "";
    const exited = cliExit(cap);
    if (exited) return { ready: false, exited };
    if (await answerWorkspaceTrust(pane, backend.name, cwd, log, cap)) continue;
    if (await answerCodebuddyTrust(pane, cwd, log, cap)) continue;
    if (startupConfirmation(cap)) {
      notifyUnknownFrame(cap);
      continue;
    }
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
  /** Durable workspace-handoff key stored on the pane before the CLI starts. */
  handoffId?: string;
  /** Cosmetic tmux window name (status-bar label). Falls back to sessionId.
   *  Pass the principal (e.g. "user:xxx") to make windows easy to skim. */
  windowName?: string;
  /** Per-chat cwd override. Empty/undefined → fall back to cfg.wrc.cwd.
   *  Mirror mode persists this in mirror-attachments.json so /new respawns
   *  in the user-bound project, not the global default. */
  cwdOverride?: string;
  /** 该 spawn 服务的会话 principal (mirror 的 target key)。认不出的启动确认框
   * 把通知发到这个频道 (daemon 侧按审批卡同源换算 chatid); 不传 = 只记日志。 */
  chatKey?: string;
  /** Owner of a resumed transcript, used to select its original backend.
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
  /** Wizard charter. Recorded to `state/charters/<sid>.md` for rolepage's
   *  backfill; the identity itself now rides the session's FIRST INJECTED
   *  message (mirror-bridge `charterPending` → `<system-reminder
   *  wezard="charter">` preamble) — launch no longer pays the CLI's
   *  prompt-assembly cost for it, and a pane is idle until that first message
   *  anyway. codex is the exception: its charter still travels as
   *  `developer_instructions` in the launch command. */
  systemPrompt?: string;
}

export interface SpawnResult {
  ok: boolean;
  reason?: string;
  retryable?: boolean;
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

/** Park a charter next to the daemon's other state — rolepage's backfill reads
 *  it (`state/charters/<sid>.md`, see index.ts boot). Always returns "" now:
 *  the charter rides the session's FIRST INJECTED message instead (mirror-bridge
 *  `charterPending` → `<system-reminder wezard="charter">` preamble) —
 *  `--append-system-prompt` made every cold start drag the whole charter through
 *  the CLI's launch-time prompt assembly (measured +1.4s median), and a fresh
 *  pane sits idle until that first message anyway. codex keeps its
 *  developer_instructions (assembled in commandFor), so it never lands here.
 *  A missing charter degrades the wizard's self-awareness, it must never cost
 *  us the pane. */
const charterArg = (cfg: Config, backend: CliBackend, sessionId: string, charter: string | undefined, log: Logger): string => {
  const text = (charter ?? "").trim();
  if (!text || !backend.systemPromptFlag) return "";
  try {
    const dir = join(expandHome(cfg.daemon.stateDir), "charters");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${sessionId}.md`);
    writeFileSync(file, text, "utf8");
    pruneCharters(dir);
    return "";
  } catch (e) {
    log.warn({ err: (e as Error).message }, "spawn-tmux: charter write failed; spawning without identity");
    return "";
  }
};

const spawnTmuxInner = async ({ cfg, log, resumeSessionId, sessionId: freshSessionId, handoffId, windowName, cwdOverride, chatKey, cli, model, effort, systemPrompt, forkSession }: SpawnArgs): Promise<SpawnResult> => {
  const backend = resumeSessionId && cli
    ? resolveCliBackend({ ...cfg.wrc, defaultCli: cli })
    : backendFor(cfg);
  activateBackend(backend);
  const cwd = expandHome((cwdOverride ?? "").trim() || cfg.wrc.cwd);
  const projectDir = join(expandHome(backend.projectsDir), backend.encodeProjectDir(cwd));
  let sessionId = resumeSessionId ?? freshSessionId ?? randomUUID();
  let jsonlPath = join(projectDir, `${sessionId}.jsonl`);
  const tmuxName = cfg.wrc.tmuxPrefix; // shared session for all chats
  // 调用方手里只有会话 key 时 (init 的自动建会话), 窗口名照旧取那个 wizard 的名字 ——
  // key 印上去只会被截成 `u-T03880`, 和它所在聊天的窗口一模一样。
  const winName = safeWindowName(windowName && isSessionKey(windowName) ? windowLabel(windowName) : windowName ?? sessionId);

  // Probe tmux availability up front — clearer error than a generic spawn fail.
  // Also gate two flags on version: `-c <start-dir>` on new-session/new-window
  // landed in tmux 1.9; `-e KEY=VAL` in 3.0. Old tmux (e.g. CentOS 7 ships 1.8)
  // errors `unknown option -- c` and aborts the whole spawn — so when either is
  // unsupported we fold the equivalent into the launch command instead (`cd` +
  // inline env exports), which every tmux understands.
  const probe = await tmuxProbeResult();
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
    if (conflict) return { ok: false, retryable: false, reason: `Codex extraArgs ${conflict} conflicts with wrc.cliBackends.codex.disableSandbox; remove the shortcut and use the sandbox config` };
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
  const paneEnv = supportsE ? ANTI_UPDATE_ENV : [];
  const cwdArg = supportsC ? ["-c", cwd] : [];
  // With no client attached a window takes the session's default-size — tmux's
  // own default is 80x24, and the codebuddy `/model` picker (30-odd unwindowed
  // rows, ids truncated at 80 cols) then scrolls its title and scope tab off
  // the screen: the picker reads as never opened. An attached human's terminal
  // still wins; this only sizes the panes nobody is looking at. Best-effort —
  // tmux < 2.9 has no default-size and keeps 80x24.
  const sizeArg = ["-x", String(DETACHED_COLS), "-y", String(DETACHED_ROWS)];
  const openPane = async (): Promise<{ pane: string; warm: boolean } | { reason: string }> => {
    const has = await runTmux(["has-session", "-t", `=${tmuxName}`]);
    if (has.code === 0) await runTmux(["set-option", "-t", `=${tmuxName}`, "default-size", `${DETACHED_COLS}x${DETACHED_ROWS}`]);
    // 主 session 已在 = 这是往现成的盘子里加窗口, 才可能领到暖 shell; 走 new-session 那支
    // 要先建 session, 搬迁窗口过去没有意义, 也领不了。
    const warmPane = has.code === 0 ? await claimWarmShell(cfg, log, cwd, tmuxName, winName) : undefined;
    // `=` prevents wezard from matching wezard-warm when the main session is gone.
    // The trailing colon selects the next free window index.
    // Bare `-t wezard` is ambiguous: if a *window* is also named
    // `wezard`, tmux matches it and tries to reuse its index → "index N in use".
    const create = () => has.code === 0
      ? runTmux(["new-window", "-d", "-t", `=${tmuxName}:`, "-n", winName, ...cwdArg, ...paneEnv, "-P", "-F", "#{pane_id}"])
      : runTmux(["new-session", "-d", "-s", tmuxName, "-n", winName, ...sizeArg, ...cwdArg, ...paneEnv, "-P", "-F", "#{pane_id}"]);
    let pane = warmPane ?? "";
    if (!pane) {
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
      pane = created.stdout.split("\n").map((s) => s.trim()).filter(Boolean)[0] ?? "";
      if (!pane) return { reason: "tmux returned no pane id" };
    }
    if (handoffId) {
      const tagged = await runTmux(["set-option", "-p", "-t", pane, "@wezard_handoff_id", handoffId]);
      if (!tagged.ok) {
        await runTmux(["kill-pane", "-t", pane]);
        return { reason: `could not persist workspace handoff pane identity: ${tagged.stderr.trim() || tagged.code}` };
      }
    }
    log.info({ tmuxName, winName, tmuxPane: pane, cwd, sessionId, cli: backend.name, reused: has.code === 0, warm: !!warmPane, spare: false }, "spawn-tmux: pane created");
    return { pane, warm: !!warmPane };
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
        // Keep the startup update picker out of this managed invocation only.
        "-c", "check_for_update_on_startup=false",
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
    const cmd = [...envPrefix, shQuote(backend.bin), ...argv].filter(Boolean).join(" ");
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
    try { tui = await waitForTuiReady(pane, line, backend, cwd, { chatKey: chatKey?.trim() || undefined, who: winName, tmuxSession: tmuxName ?? "" }, log); }
    finally { if (script) try { unlinkSync(script); } catch { /* already removed */ } }
    if (tui.exited) return { ok: true, pane, ready: false, failure: tui.exited };
    const unknown = !!flagModel && tui.ready && modelNotRecognized(await capturePaneBottom(pane, "-"), flagModel);
    return { ok: true, pane, ready: tui.ready, ...(unknown ? { failure: `CLI 不认识 --model ${flagModel} (欢迎框原样回显, 首轮会 400)` } : {}) };
  };

  // Whatever was asked goes straight in with `--model`. Only when the CLI
  // proves it can't take it is the pane thrown away and relaunched bare —
  // the ask then goes through the picker like any colloquial name.
  const flagModel = wanted && backend.modelFlag ? wanted : undefined;
  // 池里能领就先领: 领用只是搬窗口 + 核屏, 比冷启动省一个数量级。只有全新会话可以领 ——
  // resume/fork 的 sid 是给定的, 交接那条路的 sid 要按 id 复活 (池里那条不是它)。
  const claimable = !resumeSessionId && !forkSession && !handoffId && (!wanted || !!flagModel);
  const spare = claimable
    ? await claimSpare(cfg, log, { cwd, backend, model: wanted, effort: effortArg, tmuxName, winName })
    : undefined;
  if (spare) {
    sessionId = spare.sessionId;
    jsonlPath = spare.jsonlPath;
  }
  // 只落盘 (rolepage 回填按 sid 读), 不进启动行 —— 宪章改由首条注入的 preamble
  // 交给 pane (mirror-bridge charterPending)。必须在领用**之后**: 领用会换 sid,
  // 文件要落在真实接手的那个会话名下。
  charterArg(cfg, backend, sessionId, systemPrompt, log);
  const first: Launched = spare ? { ok: true, pane: spare.pane, ready: true } : await launch(flagModel);
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
  log.info({ tmuxName, tmuxPane, sessionId, jsonlPath, cwd, cli: backend.name, model: resolvedModel, viaFlag, relaunched: !!launchFailure, effort: effortArg, spare: !!spare }, "spawn-tmux: ready");
  return {
    ok: true, sessionId, jsonlPath, tmuxPane, tmuxSession: tmuxName, cwd, cli: backend.name,
    ...(wanted ? { model: resolvedModel, ...(modelWarning ? { modelWarning } : {}) } : {}),
    ...(effortArg ? { effort: effortArg } : {}),
  };
};

/** spawn 的对外入口: 「跑一次 spawn + 把暖 shell / 空白备用补回去」。补位必须挂在最外层
 *  —— 里面十几处提前 return, 挂进任何一处都得漏; 而无论成败, 该 cwd 的暖 pane 都已经被
 *  领走或根本没建, 补一条下次才省得下来。补位是 fire-and-forget, 绝不影响这次的结果。 */
export const spawnTmuxClaude = async (args: SpawnArgs): Promise<SpawnResult> => {
  const result = await spawnTmuxInner(args);
  const cwd = expandHome((args.cwdOverride ?? "").trim() || args.cfg.wrc.cwd);
  if (warmEnabled() && existsSync(cwd)) void prewarmShell(args.cfg, cwd, args.log);
  // 一次全新会话成功 = 这个 (cwd, 后端, model, effort) 刚被证明能用, 顺手补一条备用:
  // 下一个同键会话直接领。resume / fork / 交接 / codex 都不补 —— 它们的启动形状不一样,
  // 备用帮不上; 领用之后也走这里补回 (它是 fresh 路径的一次成功)。
  // 备用按 (cwd, 后端, model, effort) 建也按它领 —— 只有「这个 model 字符串顶上
  // `--model` 就被认下」的那种 spawn 才值得补: 被拒过、或靠 `/model` 才落到别的 id 的,
  // 拿原串去建必然在开机自检里判「CLI 不认识」然后白丢 (还占一个 pane)。modelWarning
  // 正好是这两种情况的印记。
  if (result.ok && !result.modelWarning && !args.resumeSessionId && !args.forkSession && !args.handoffId) {
    void ensureSpare(args.cfg, args.log, cwd, args.model, args.effort);
  }
  return result;
};
