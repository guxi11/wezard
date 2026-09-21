// Project-level config sync across CLI backends.
//
// A project that is worked on by both Claude Code and CodeBuddy carries two
// parallel config trees (`CLAUDE.md` + `.claude/{skills,commands,agents}` vs
// `CODEBUDDY.md` + `.codebuddy/...`). They drift because an edit made through
// one CLI is invisible to the other. This module folds them back together.
//
// Merge is a real 3-way merge, not a copy: `git merge-file` against a base
// snapshot of the last synced content (`~/.wezard/cfgsync/<project>/base/`).
// Both sides' independent edits survive; only genuinely overlapping edits
// conflict, and those files are reported and left untouched.
//
// GLOBAL config (~/.claude, ~/.codebuddy) is deliberately out of scope — those
// homes carry CLI-specific hooks / plugin roots / MCP wiring that must NOT be
// cross-written.
import { execFile } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { expandHome } from "../shared/paths.js";
import { augmentedPath } from "../shared/exec-path.js";
import { activeBackends, type CliBackend, type CliBackendName } from "../shared/cli-backends.js";

// Subdirectories synced under each backend's project config dir. settings.json
// is excluded on purpose: hook paths, plugin roots and MCP entries are per-CLI,
// and wezard's own `cli/sync.ts` owns the hook block inside them.
const SUBDIRS = ["skills", "commands", "agents"] as const;

// Logical key for the per-CLI memory file. `CLAUDE.md` and `CODEBUDDY.md` are
// the same asset under two names, so they collapse to one key and each side
// materializes it under its own filename.
const MEMORY_KEY = "MEMORY.md";

const MAX_BYTES = 512 * 1024;

const CFGSYNC_ROOT = "~/.wezard/cfgsync";

interface ProjectRoot {
  name: CliBackendName;
  /** `<cwd>/.claude` | `<cwd>/.codebuddy` */
  dir: string;
  /** `<cwd>/CLAUDE.md` | `<cwd>/CODEBUDDY.md` */
  memory: string;
}

export type ItemStatus = "same" | "copy" | "merge" | "conflict" | "delete" | "skip";

export interface SyncItem {
  key: string;
  status: ItemStatus;
  /** Backend names whose on-disk copy would change. */
  targets: CliBackendName[];
  note?: string;
}

export interface SyncReport {
  cwd: string;
  roots: CliBackendName[];
  applied: boolean;
  items: SyncItem[];
  backupDir?: string;
}

// ── pure path algebra ───────────────────────────────────────────────────

const isCodebuddy = (name: CliBackendName): boolean => name === "codebuddy";

const projectRootOf = (b: CliBackend, cwd: string): ProjectRoot => ({
  name: b.name,
  dir: join(cwd, isCodebuddy(b.name) ? ".codebuddy" : ".claude"),
  memory: join(cwd, isCodebuddy(b.name) ? "CODEBUDDY.md" : "CLAUDE.md"),
});

const pathOf = (root: ProjectRoot, key: string): string =>
  key === MEMORY_KEY ? root.memory : join(root.dir, key);

/** Path-safe slug for a project cwd, mirroring the CLI transcript encoding. */
const slugOfCwd = (cwd: string): string => cwd.replace(/^[/]+/, "").replace(/[/.]/g, "-");

const baseDirOf = (cwd: string): string => join(expandHome(CFGSYNC_ROOT), slugOfCwd(cwd), "base");

// A backend participates only if it is actually in use here: its global home
// exists (installed) or the project already carries its config tree. Without
// this every sync would conjure a `.codebuddy/` into projects of users who have
// never run CodeBuddy.
const participates = (b: CliBackend, root: ProjectRoot): boolean =>
  existsSync(expandHome(b.homeDir)) || existsSync(root.dir) || existsSync(root.memory);

// claude and claude-internal share `.claude` — same tree, keep one.
const rootsFor = (cwd: string): ProjectRoot[] =>
  activeBackends()
    .map((b) => ({ b, root: projectRootOf(b, cwd) }))
    .filter(({ b, root }) => participates(b, root))
    .reduce<ProjectRoot[]>(
      (acc, { root }) => (acc.some((r) => r.dir === root.dir) ? acc : [...acc, root]),
      [],
    );

// ── file IO helpers (side effects live here) ────────────────────────────

const walk = (dir: string, prefix: string): string[] => {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (e.name.startsWith(".")) return [];
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) return walk(join(dir, e.name), rel);
    return e.isFile() ? [rel] : [];
  });
};

const keysOf = (root: ProjectRoot): string[] => [
  ...(existsSync(root.memory) ? [MEMORY_KEY] : []),
  ...SUBDIRS.flatMap((sub) => walk(join(root.dir, sub), sub)),
];

const readMaybe = (p: string): Buffer | undefined => {
  try {
    return statSync(p).size > MAX_BYTES ? undefined : readFileSync(p);
  } catch {
    return undefined;
  }
};

const isText = (b: Buffer): boolean => !b.includes(0);

const writeFile = (p: string, data: Buffer): void => {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, data);
};

// PATH is stripped under launchd/systemd — git may live in a homebrew prefix.
const syncPath = (orig: string | undefined): string => augmentedPath(orig, ["/usr/bin", "/bin"]);

/**
 * 3-way text merge via `git merge-file`. Exit code ≥ 0 is the conflict count;
 * < 0 means git itself failed. Stdout is always the merged text (with conflict
 * markers when count > 0) — callers decide whether to keep it.
 */
const merge3 = (tmpDir: string, base: string, ours: string, theirs: string): Promise<{ text: string; conflicts: number }> =>
  new Promise((resolve, reject) => {
    mkdirSync(tmpDir, { recursive: true });
    const files = { ours: join(tmpDir, "ours"), base: join(tmpDir, "base"), theirs: join(tmpDir, "theirs") };
    writeFileSync(files.ours, ours, "utf8");
    writeFileSync(files.base, base, "utf8");
    writeFileSync(files.theirs, theirs, "utf8");
    execFile(
      "git",
      ["merge-file", "-p", "-L", "current", "-L", "base", "-L", "incoming", files.ours, files.base, files.theirs],
      { encoding: "utf8", maxBuffer: 4 * MAX_BYTES, env: { ...process.env, PATH: syncPath(process.env.PATH) } },
      (err, stdout) => {
        const code = (err as { code?: number } | null)?.code ?? 0;
        if (code < 0 || (err && typeof code !== "number")) return reject(err);
        resolve({ text: stdout, conflicts: code });
      },
    );
  });

// ── per-key resolution ──────────────────────────────────────────────────

interface Resolution {
  status: ItemStatus;
  targets: CliBackendName[];
  note?: string;
  /** Reconciled content — written to every target AND to the base snapshot.
   *  Absent for conflict/skip/delete, i.e. exactly when nothing was settled. */
  content?: Buffer;
}

/**
 * Fold every side's version into one. Order is roots order (primary first);
 * a side equal to the base loses to a side that changed, and two divergent
 * changes go through git's 3-way merge.
 */
const resolveKey = async (
  key: string,
  roots: ProjectRoot[],
  base: Buffer | undefined,
  tmpDir: string,
): Promise<Resolution> => {
  const sides = roots.map((r) => ({ root: r, buf: readMaybe(pathOf(r, key)) }));
  const present = sides.filter((s) => s.buf !== undefined) as Array<{ root: ProjectRoot; buf: Buffer }>;
  if (present.length === 0) return { status: "skip", targets: [], note: "unreadable / too large" };

  const missing = sides.filter((s) => s.buf === undefined);
  // Deletion propagates only when every surviving copy is untouched since the
  // last sync — otherwise the delete loses to a real edit.
  if (base !== undefined && missing.length > 0 && present.every((s) => s.buf.equals(base))) {
    return { status: "delete", targets: present.map((s) => s.root.name) };
  }

  // Binaries (skill assets, images) have no textual merge — propagate only
  // when every present copy is byte-identical.
  if (present.some((s) => !isText(s.buf))) {
    const first = present[0]!.buf;
    if (!present.every((s) => s.buf.equals(first))) return { status: "conflict", targets: [], note: "binary differs" };
    return {
      status: missing.length === 0 ? "same" : "copy",
      targets: missing.map((s) => s.root.name),
      content: first,
      note: "binary",
    };
  }

  const baseText = base !== undefined && isText(base) ? base.toString("utf8") : "";
  let acc = present[0]!.buf.toString("utf8");
  let conflicted = false;
  for (const s of present.slice(1)) {
    const theirs = s.buf.toString("utf8");
    if (theirs === acc) continue;
    if (acc === baseText) { acc = theirs; continue; }
    if (theirs === baseText) continue;
    const m = await merge3(tmpDir, baseText, acc, theirs);
    if (m.conflicts > 0) { conflicted = true; break; }
    acc = m.text;
  }
  if (conflicted) {
    return { status: "conflict", targets: [], note: base === undefined ? "无 base 快照，首次同步需人工对齐" : "重叠修改" };
  }

  const stale = sides.filter((s) => s.buf === undefined || s.buf.toString("utf8") !== acc);
  return {
    status: stale.length === 0 ? "same" : present.length === 1 ? "copy" : "merge",
    targets: stale.map((s) => s.root.name),
    content: Buffer.from(acc, "utf8"),
  };
};

// ── driver ──────────────────────────────────────────────────────────────

const ts = (): string => new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "");

/**
 * Compute (and optionally apply) the sync plan for one project cwd.
 * `apply=false` touches nothing on disk except the scratch merge dir.
 */
export const syncProjectConfig = async (cwd: string, apply: boolean): Promise<SyncReport> => {
  const roots = rootsFor(cwd);
  if (roots.length < 2) {
    return { cwd, roots: roots.map((r) => r.name), applied: false, items: [] };
  }
  const baseDir = baseDirOf(cwd);
  const tmpDir = join(expandHome(CFGSYNC_ROOT), ".tmp");
  const backupDir = join(expandHome(CFGSYNC_ROOT), slugOfCwd(cwd), "backup", ts());

  const byName = new Map(roots.map((r) => [r.name, r] as const));
  const keys = [...new Set(roots.flatMap(keysOf))].sort();
  const items: SyncItem[] = [];
  let backedUp = false;

  for (const key of keys) {
    const basePath = join(baseDir, key);
    const res = await resolveKey(key, roots, readMaybe(basePath), tmpDir);
    items.push({ key, status: res.status, targets: res.targets, note: res.note });
    if (!apply) continue;

    res.targets.forEach((name) => {
      const root = byName.get(name);
      if (!root) return;
      const dest = pathOf(root, key);
      const old = readMaybe(dest);
      if (old !== undefined) {
        writeFile(join(backupDir, name, key), old);
        backedUp = true;
      }
      if (res.status === "delete") rmSync(dest, { force: true });
      else if (res.content) writeFile(dest, res.content);
    });
    // The base snapshot advances only for keys that actually settled — a
    // conflicting file keeps its old base so it can be re-merged after a fix.
    // It also advances for identical-everywhere files, which is what gives the
    // NEXT divergence a real 3-way base instead of an empty one.
    if (res.status === "delete") rmSync(basePath, { force: true });
    else if (res.content) writeFile(basePath, res.content);
  }

  return { cwd, roots: roots.map((r) => r.name), applied: apply, items, backupDir: backedUp ? backupDir : undefined };
};

// ── rendering ───────────────────────────────────────────────────────────

const ICON: Record<ItemStatus, string> = {
  same: "=",
  copy: "＋",
  merge: "⇄",
  conflict: "✗",
  delete: "－",
  skip: "·",
};

export const renderSyncReport = (r: SyncReport): string => {
  if (r.roots.length < 2) {
    return `[wezard] /cfgsync: 本项目只发现 ${r.roots.length} 个 CLI 配置树 (${r.roots.join(", ") || "无"}),无需同步。`;
  }
  const changed = r.items.filter((i) => i.status !== "same" && i.status !== "skip");
  const head = `📐 项目配置同步 \`${r.cwd}\`\nCLI: ${r.roots.join(" ⇄ ")}`;
  if (changed.length === 0) return `${head}\n\n✅ 全部一致 (${r.items.length} 个文件)`;
  const lines = changed.map(
    (i) => `${ICON[i.status]} \`${i.key}\`${i.targets.length ? ` → ${i.targets.join(",")}` : ""}${i.note ? ` (${i.note})` : ""}`,
  );
  const conflicts = changed.filter((i) => i.status === "conflict").length;
  const tail = r.applied
    ? [`\n✅ 已写入 ${changed.length - conflicts} 项${conflicts ? `,${conflicts} 项冲突已跳过` : ""}`,
       ...(r.backupDir ? [`备份: \`${r.backupDir}\``] : [])]
    : ["\n预演模式,未写入。执行同步: `/cfgsync apply`"];
  return [head, "", ...lines, ...tail].join("\n");
};
