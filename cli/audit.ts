// Slash-command entry: `wezard audit [.name|slot]`.
//   - With an argument: a wizard name (`.name` / `name`, same lookup as IM `/audit <.name>`:
//     wizards.json → that identity's anchor target) audits that wizard's session; when no
//     wizard has the name, it is read as a slot id and matches the newest-by-mtime mirror
//     whose target carries `#<slot>` (the old form, kept working). Either way the audit is of
//     THAT session regardless of which CLI/pane the command was fired from. Fails hard when
//     the daemon is down or nothing matches — falling back to "current session" would
//     silently mis-answer.
//   - Without a tag: resolve the caller's own session (via
//     $CLAUDE_CODE_SESSION_ID or newest-mtime jsonl under the project dir),
//     print locally, and — when the daemon is up and this session is
//     mirrored — also push the report into WeCom.
// WeCom-side `/audit` doesn't go through here; daemon/inbound.ts intercepts
// it and calls computeAuditReport directly (bypasses the flaky tmux paste path).
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { basename, join } from "node:path";
import { homedir } from "node:os";
import { computeAuditReport, pickMirror } from "../daemon/audit.js";
import { cliSocketPath } from "../shared/cli-socket.js";
import { daemonRequest } from "../shared/daemon-client.js";
import { loadConfig } from "../shared/config.js";
import { foldName, identityOf } from "../daemon/wizard.js";

// daemon 控制面 = unix socket; 连不上 (daemon 没起) 一律当「没有镜像」。

const PROJECT_BASES = [
  join(homedir(), ".claude-internal", "projects"),
  join(homedir(), ".claude", "projects"),
  join(homedir(), ".codebuddy", "projects"),
];

// Encoding differs by backend: Claude Code uses `/`/`.`→`-` (leading `-` kept);
// CodeBuddy strips the leading separator first (no leading `-`).
const encodeFor = (base: string, probe: string): string => {
  if (base.includes(".codebuddy")) return probe.replace(/^[/]+/, "").replace(/[/.]/g, "-");
  return probe.replace(/[/.]/g, "-");
};

const findProjectDir = (cwd: string): string | null => {
  let probe = cwd;
  while (probe) {
    for (const base of PROJECT_BASES) {
      const p = join(base, encodeFor(base, probe));
      if (existsSync(p)) return p;
    }
    if (probe === "/") break;
    const parent = probe.slice(0, probe.lastIndexOf("/")) || "/";
    if (parent === probe) break;
    probe = parent;
  }
  return null;
};

const resolveSessionId = (proj: string): string | null => {
  const envSid = process.env.CLAUDE_CODE_SESSION_ID || process.env.CLAUDE_SESSION_ID;
  if (envSid && existsSync(join(proj, `${envSid}.jsonl`))) return envSid;
  let latest: { sid: string; mtime: number } | null = null;
  for (const f of readdirSync(proj)) {
    if (!f.endsWith(".jsonl")) continue;
    const fp = join(proj, f);
    try {
      const st = statSync(fp);
      if (!latest || st.mtimeMs > latest.mtime) {
        latest = { sid: basename(f, ".jsonl"), mtime: st.mtimeMs };
      }
    } catch { /* ignore */ }
  }
  return latest?.sid ?? null;
};

const expandHome = (p: string): string => (p.startsWith("~/") ? join(homedir(), p.slice(2)) : p);

interface MirrorRef { sessionId: string; jsonlPath: string; target: string; }

// Name → anchor target, read straight off the registry file (the CLI has no daemon-side store):
// same rule as WizardStore.byName — fold case/sigil, then take the identity's anchor record.
const wizardTargetOfName = (name: string): string | undefined => {
  const key = foldName(name);
  if (!key) return undefined;
  try {
    const file = expandHome(loadConfig().config.wrc.mirror.wizardsFile);
    const rows = Object.values(JSON.parse(readFileSync(file, "utf8")) as Record<string, { target: string; name?: string; identity?: string }>);
    const hits = rows.filter((w) => w.target && foldName(w.name ?? "") === key);
    const id = [...new Set(hits.map(identityOf))].sort()[0];
    if (!id) return undefined;
    const kin = hits.filter((w) => identityOf(w) === id).sort((a, b) => (a.target < b.target ? -1 : a.target > b.target ? 1 : 0));
    return (kin.find((w) => w.target === id) ?? kin[0])?.target;
  } catch { return undefined; }
};

// Ask daemon for all live mirrors and resolve `arg` among them. Returns null when the daemon is
// unreachable or nothing matches.
const findMirror = async (arg: string): Promise<MirrorRef | null> => {
  try {
    const res = await daemonRequest("GET", "/mirror/status", { socketPath: cliSocketPath(), timeoutMs: 2000 });
    if (res.status !== 200) return null;
    const status = (res.json ?? {}) as { mirrors?: MirrorRef[] };
    return pickMirror(status.mirrors ?? [], arg, wizardTargetOfName, (m) => {
      try { return statSync(expandHome(m.jsonlPath)).mtimeMs; } catch { return 0; }
    });
  } catch { return null; }
};

// Slash-command output goes into the jsonl as a `tool_result` under a user turn;
// mirror-bridge only tails `assistant` lines, so WeCom never sees it. Ask the
// daemon to push directly to whichever chat mirrors this session. Silent-fail
// when the daemon is down or no mirror is bound — local stdout is enough.
const pushToWeCom = async (sid: string, markdown: string): Promise<void> => {
  try {
    const socketPath = cliSocketPath();
    const statusRes = await daemonRequest("GET", "/mirror/status", { socketPath, timeoutMs: 2000 });
    if (statusRes.status !== 200) return;
    const status = (statusRes.json ?? {}) as { mirrors?: MirrorRef[] };
    const target = (status.mirrors ?? []).find((m) => m.sessionId === sid)?.target;
    if (!target) return;
    await daemonRequest("POST", "/message", { socketPath, body: { chat: target, markdown }, timeoutMs: 5000 });
  } catch { /* daemon unreachable — local stdout is enough */ }
};

const main = async (): Promise<void> => {
  const tag = (process.argv.slice(2).join(" ") || "").trim().replace(/^#/, "");

  if (tag) {
    const mirror = await findMirror(tag);
    if (!mirror) {
      console.error(`no mirror found for tag \`${tag}\` (daemon down or session not attached)`);
      process.exit(1);
    }
    const jsonlPath = expandHome(mirror.jsonlPath);
    if (!existsSync(jsonlPath)) {
      console.error(`mirror jsonl missing: ${jsonlPath}`);
      process.exit(1);
    }
    const report = computeAuditReport({ sessionId: mirror.sessionId, jsonlPath, tag });
    console.log(report);
    await pushToWeCom(mirror.sessionId, report);
    return;
  }

  const cwd = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const proj = findProjectDir(cwd);
  if (!proj) {
    console.error(`no claude project dir for cwd: ${cwd}`);
    process.exit(1);
  }
  const sid = resolveSessionId(proj);
  if (!sid) {
    console.error(`no .jsonl under ${proj}`);
    process.exit(1);
  }
  const jsonlPath = join(proj, `${sid}.jsonl`);
  if (!existsSync(jsonlPath)) {
    console.error(`main jsonl missing: ${jsonlPath}`);
    process.exit(1);
  }
  const report = computeAuditReport({ sessionId: sid, jsonlPath });
  console.log(report);
  await pushToWeCom(sid, report);
};

main();
