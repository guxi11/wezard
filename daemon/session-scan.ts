// Scan the host for live `claude` sessions running inside tmux, and summarize
// what each is doing from its transcript tail. Used by the /sessions/* routes
// so a WeCom-side Claude can list / switch / describe sibling sessions.
//
// Why daemon-side: an MCP tool runs *inside one* claude process and can only
// see its own $TMUX_PANE / cwd / sessionId. Correlating *other* sessions to
// their tmux pane (required for IM→CLI inject) needs a host-wide /proc + tmux
// sweep, which only the resident daemon is positioned to do.
//
// Scope: tmux-hosted sessions only (a session with no pane can't receive
// pasted input, so it's not a useful mirror target). Linux reads /proc;
// macOS falls back to `ps` + `lsof` (no /proc there); other platforms
// degrade to [] gracefully.
import { spawn } from "node:child_process";
import { readdirSync, readFileSync, existsSync, statSync, readlinkSync } from "node:fs";
import { join, basename } from "node:path";
import { activeBackends, backendForPath, projectDirsFor, type CliBackendName } from "../shared/cli-backends.js";
import { expandHome } from "../shared/paths.js";
import { augmentedPath } from "../shared/exec-path.js";
import { labelFor } from "../shared/session-label.js";
import { summarizeTail } from "./peers.js";

export interface SessionInfo {
  sessionId: string;
  /** Stable animal-emoji tag (same as approval cards). */
  label: string;
  /** Working directory of the live claude process. */
  cwd: string;
  /** Transcript path (may not exist yet for a freshly-spawned session). */
  jsonlPath: string;
  tmuxSession: string;
  tmuxPane: string;
  /** jsonl mtime in ms (0 if absent); used for ordering. */
  lastActivity: number;
  /** One-line "what is this session doing" preview from the transcript tail. */
  summary: string;
  /** Which CLI owns this session, derived from the transcript's projects root.
   *  Lets a caller (and the UI) tell a claude pane from a codebuddy one. */
  cli: CliBackendName;
}

interface PaneOwner {
  paneId: string;
  session: string;
}

// lsof lives in /usr/sbin on macOS, which a stripped launchd PATH lacks.
const scanPath = (orig: string | undefined): string => augmentedPath(orig, ["/usr/sbin", "/sbin"]);

// A wedged tmux server (or an lsof blocked on a stuck mount) must not hang the
// scan forever — /sessions would never answer and, worse, the caller's await
// would never return. Degrade to "no output" like any other failure.
const SCAN_CMD_TIMEOUT_MS = 15_000;

const runCmd = (cmd: string, args: string[]): Promise<{ ok: boolean; stdout: string }> =>
  new Promise((resolve) => {
    const p = spawn(cmd, args, {
      env: { ...process.env, PATH: scanPath(process.env.PATH) },
      stdio: ["ignore", "pipe", "ignore"],
    });
    let out = "";
    let settled = false;
    const finish = (r: { ok: boolean; stdout: string }): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    const timer = setTimeout(() => {
      p.kill("SIGKILL");
      finish({ ok: false, stdout: "" });
    }, SCAN_CMD_TIMEOUT_MS);
    p.stdout?.on("data", (c) => (out += c.toString("utf8")));
    p.on("error", () => finish({ ok: false, stdout: "" }));
    p.on("close", (code) => finish({ ok: code === 0, stdout: out }));
  });

const runTmux = (args: string[]): Promise<{ ok: boolean; stdout: string }> => runCmd("tmux", args);

// ── Process table snapshot ──────────────────────────────────────────────
// One scan produces pid → {ppid, cmd} for the whole host; the tmux-pane walk
// and the agent-cli filter both read from it, so the source (Linux /proc vs
// macOS ps) is a contained difference.

interface ProcEntry {
  ppid: number;
  cmd: string;
}

// Read /proc/<pid>/stat → ppid. comm (2nd field) is wrapped in parens and may
// itself contain spaces/parens, so split on the LAST ')' and index from there:
// fields after comm are state ppid ... → ppid is index 1 of the tail.
const ppidOfProc = (pid: number): number | null => {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const rp = stat.lastIndexOf(")");
    if (rp < 0) return null;
    const rest = stat.slice(rp + 2).split(" ");
    const ppid = parseInt(rest[1] ?? "", 10);
    return Number.isInteger(ppid) ? ppid : null;
  } catch {
    return null;
  }
};

const cmdlineOfProc = (pid: number): string => {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " ").trim();
  } catch {
    return "";
  }
};

const procSnapshotLinux = (): Map<number, ProcEntry> => {
  const m = new Map<number, ProcEntry>();
  let pids: number[];
  try {
    pids = readdirSync("/proc").filter((n) => /^\d+$/.test(n)).map((n) => parseInt(n, 10));
  } catch {
    return m;
  }
  for (const pid of pids) {
    const ppid = ppidOfProc(pid);
    if (ppid != null) m.set(pid, { ppid, cmd: cmdlineOfProc(pid) });
  }
  return m;
};

// macOS: `ps` snapshot. -ww keeps long cmdlines (a `--session-id` near the end
// of a wrapped command would otherwise be truncated away); BSD ps rejects a
// bare `ax` mixed with dashed flags, hence `-ax`.
const procSnapshotPs = async (): Promise<Map<number, ProcEntry>> => {
  const r = await runCmd("ps", ["-ww", "-ax", "-o", "pid=,ppid=,command="]);
  const m = new Map<number, ProcEntry>();
  if (!r.ok) return m;
  for (const line of r.stdout.split("\n")) {
    const mm = /^\s*(\d+)\s+(\d+)\s+(.*\S)\s*$/.exec(line);
    if (mm) m.set(parseInt(mm[1]!, 10), { ppid: parseInt(mm[2]!, 10), cmd: mm[3]! });
  }
  return m;
};

const procSnapshot = (): Promise<Map<number, ProcEntry>> | Map<number, ProcEntry> =>
  process.platform === "linux" ? procSnapshotLinux() : procSnapshotPs();

// cwd is only needed for the handful of agent-cli candidates, so it's resolved
// lazily per platform: Linux reads /proc directly; macOS batches one lsof call
// (`-Fn` → machine-readable `p<pid>` / `n<path>` records).
const cwdMapFor = async (pids: number[]): Promise<Map<number, string>> => {
  const m = new Map<number, string>();
  if (pids.length === 0) return m;
  if (process.platform === "linux") {
    for (const pid of pids) {
      try {
        m.set(pid, readlinkSync(`/proc/${pid}/cwd`));
      } catch {
        /* process gone or unreadable */
      }
    }
    return m;
  }
  const r = await runCmd("lsof", ["-a", "-p", pids.join(","), "-d", "cwd", "-Fn"]);
  if (!r.ok) return m;
  let cur = 0;
  for (const line of r.stdout.split("\n")) {
    if (line.startsWith("p")) cur = parseInt(line.slice(1), 10);
    else if (line.startsWith("n") && cur > 0) m.set(cur, line.slice(1));
  }
  return m;
};

// Pull a `--session-id <uuid>` out of a cmdline. Returns "" when absent
// (e.g. claude launched with bare `-r`/`--resume` — no explicit id to bind).
const sessionIdFromCmd = (cmd: string): string => {
  const m = cmd.match(/--session-id[= ]+([0-9a-fA-F-]{36})/);
  return m?.[1] ?? "";
};

// A process belongs to an agent CLI if its cmdline mentions any active
// backend's binary name. Derived from the registry rather than hardcoded, so a
// custom `cliBackends.<name>.bin` is recognized too — without this, codebuddy
// panes were invisible to the scan and could never be listed or switched to.
const looksLikeAgentCli = (cmd: string): boolean =>
  activeBackends().some((b) => cmd.toLowerCase().includes(basename(b.bin).toLowerCase()));

// Transcript roots of every active backend, in registry order (primary first).
const projectRoots = (): string[] => activeBackends().map((b) => expandHome(b.projectsDir));

// Locate `<sessionId>.jsonl` (UUID is globally unique, so we don't have to
// reverse the cwd→dir encoding). Skips subagent transcripts (they live under a
// `<sid>/subagents/` subdir, never directly under a project dir).
const findJsonl = (sessionId: string): string => {
  const name = `${sessionId}.jsonl`;
  for (const root of projectRoots()) {
    if (!existsSync(root)) continue;
    let subs: import("node:fs").Dirent[];
    try {
      subs = readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const d of subs) {
      if (!d.isDirectory()) continue;
      const p = join(root, d.name, name);
      if (existsSync(p)) return p;
    }
  }
  return "";
};

// cwd→projectDir encoding is backend-specific; projectDirsFor yields one
// candidate per active backend (primary first) using each one's own dialect.
// (The old local copies diverged — the Claude encoder here also mapped `_`,
// which does NOT match what Claude Code writes.)

// Expected jsonl path for a freshly-spawned session whose transcript doesn't
// exist on disk yet (a CLI only writes it after the first user input). Used so
// a brand-new `new_claude_session` still shows up in the list immediately.
const expectedJsonl = (cwd: string, sessionId: string): string => {
  if (!cwd || !sessionId) return "";
  const cands = projectDirsFor(cwd);
  const hit = cands.find(({ dir }) => existsSync(dir)) ?? cands[0];
  return hit ? join(hit.dir, `${sessionId}.jsonl`) : "";
};

// Resume-mode fallback: a claude launched with bare `-r`/`--resume` carries no
// `--session-id` on its cmdline. Infer the session from its cwd: the most
// recently written `<uuid>.jsonl` directly under that project dir. `taken`
// holds session ids already claimed by explicit-id processes so two sessions
// sharing a cwd don't both resolve to the same newest file.
const inferByCwd = (cwd: string, taken: Set<string>): { sessionId: string; jsonlPath: string } | null => {
  if (!cwd) return null;
  for (const { dir } of projectDirsFor(cwd)) {
    if (!existsSync(dir)) continue;
    let files: string[];
    try {
      files = readdirSync(dir).filter((n) => n.endsWith(".jsonl"));
    } catch {
      continue;
    }
    const cands = files
      .map((n) => ({ sid: n.slice(0, -6), p: join(dir, n) }))
      .filter((c) => !taken.has(c.sid))
      .map((c) => ({
        ...c,
        m: (() => {
          try {
            return statSync(c.p).mtimeMs;
          } catch {
            return 0;
          }
        })(),
      }))
      .sort((a, b) => b.m - a.m);
    const top = cands[0];
    if (top) return { sessionId: top.sid, jsonlPath: top.p };
  }
  return null;
};

// Build pane_pid → {paneId, session}. We map the *pane's* root pid; the claude
// worker is a descendant, so we walk its ppid chain up to find a matching pane.
const tmuxPaneIndex = async (): Promise<Map<number, PaneOwner>> => {
  const r = await runTmux(["list-panes", "-a", "-F", "#{pane_pid}|#{pane_id}|#{session_name}"]);
  const idx = new Map<number, PaneOwner>();
  if (!r.ok) return idx;
  for (const line of r.stdout.split("\n")) {
    const [panePid, paneId, session] = line.split("|");
    const pid = parseInt(panePid ?? "", 10);
    if (Number.isInteger(pid) && paneId) idx.set(pid, { paneId, session: session ?? "" });
  }
  return idx;
};

// Climb the ppid chain from `pid` until we hit a pid that owns a tmux pane.
// Bounded to avoid pathological loops.
const tmuxOwnerOf = (
  pid: number,
  procs: Map<number, ProcEntry>,
  paneIdx: Map<number, PaneOwner>,
): PaneOwner | null => {
  let cur: number | null = pid;
  for (let i = 0; i < 40 && cur != null && cur > 1; i++) {
    const hit = paneIdx.get(cur);
    if (hit) return hit;
    const pp: number | undefined = procs.get(cur)?.ppid;
    if (pp == null || pp === cur) break;
    cur = pp;
  }
  return null;
};

export const scanClaudeSessions = async (): Promise<SessionInfo[]> => {
  const paneIdx = await tmuxPaneIndex();
  const procs = await procSnapshot();
  if (procs.size === 0) return []; // unsupported platform / ps+proc both missing

  // Collect tmux-hosted claude workers, then collapse to ONE session per pane
  // (a tmux pane runs exactly one claude session; a pane may host several
  // claude processes — shim + worker + nested — which must not each count as
  // a separate session). Per pane: prefer a process carrying an explicit
  // `--session-id`; else fall back to one resume-mode inference by cwd.
  const byPane = new Map<string, { pid: number; owner: PaneOwner; explicitSid: string }>();
  for (const [pid, e] of procs) {
    if (!e.cmd || !looksLikeAgentCli(e.cmd)) continue;
    const owner = tmuxOwnerOf(pid, procs, paneIdx);
    if (!owner) continue; // tmux scope
    const explicitSid = sessionIdFromCmd(e.cmd);
    const prev = byPane.get(owner.paneId);
    if (!prev || (!prev.explicitSid && explicitSid)) {
      byPane.set(owner.paneId, { pid, owner, explicitSid });
    }
  }

  // Resolve cwd only for the chosen worker per pane (a handful of pids).
  const cwds = await cwdMapFor(Array.from(byPane.values()).map((w) => w.pid));
  const panes = Array.from(byPane.values()).map((w) => ({ ...w, cwd: cwds.get(w.pid) ?? "" }));

  const seen = new Set<string>();
  const out: SessionInfo[] = [];
  const emit = (sessionId: string, jsonlPath: string, cwd: string, owner: PaneOwner): void => {
    if (!sessionId || !jsonlPath || seen.has(sessionId)) return;
    seen.add(sessionId);
    let lastActivity = 0;
    try {
      lastActivity = statSync(jsonlPath).mtimeMs;
    } catch {
      /* fresh session: no transcript yet */
    }
    out.push({
      sessionId,
      label: labelFor(sessionId),
      cwd,
      jsonlPath,
      tmuxSession: owner.session,
      tmuxPane: owner.paneId,
      lastActivity,
      summary: summarizeTail(jsonlPath),
      cli: backendForPath(jsonlPath).name,
    });
  };

  // Pass 1: explicit `--session-id` — exact, no ambiguity. Seeds `seen` so
  // resume inference in pass 2 can't re-claim these ids. A freshly-spawned
  // session may not have written its jsonl yet — fall back to the expected
  // path so it still appears (summary reads as a new/empty session).
  for (const w of panes) {
    if (!w.explicitSid) continue;
    const jsonlPath = findJsonl(w.explicitSid) || expectedJsonl(w.cwd, w.explicitSid);
    if (jsonlPath) emit(w.explicitSid, jsonlPath, w.cwd, w.owner);
  }
  // Pass 2: resume-mode (`-r`/`--resume`, no id) — infer via cwd→newest jsonl,
  // skipping any session already claimed in pass 1.
  for (const w of panes) {
    if (w.explicitSid) continue;
    const inf = inferByCwd(w.cwd, seen);
    if (inf) emit(inf.sessionId, inf.jsonlPath, w.cwd, w.owner);
  }

  out.sort((a, b) => b.lastActivity - a.lastActivity);
  return out;
};
