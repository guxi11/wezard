// `wezard sync` — write wezard's hooks / MCP / env into target settings.json files
// (e.g. ~/.claude/settings.json so claude-internal wrappers pick them up).
// Idempotent + reversible via per-target lock manifest in ~/.wezard/sync.lock.json.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, resolve as pathResolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseJsonc } from "jsonc-parser";
import { loadConfig, type Config } from "../shared/config.js";
import { expandHome } from "../shared/paths.js";
import { codexHookCommand } from "../shared/codex-hooks.js";
import { syncCodexHooks } from "./codex-sync.js";

// ── Plugin root resolution ────────────────────────────────────────────
// dist/cli/sync.js → repo root is two `..` up.
const here = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = pathResolve(here, "..", "..");

const LOCK_FILE = expandHome("~/.wezard/sync.lock.json");
const MARKER = "wezard";
const isOurs = (v: unknown): boolean => v === MARKER;

interface Lock {
  targets: Record<string, { wroteHooks: boolean; wroteMcp: boolean; wroteEnv: string[] }>;
}

const readLock = (): Lock => {
  if (!existsSync(LOCK_FILE)) return { targets: {} };
  try {
    return JSON.parse(readFileSync(LOCK_FILE, "utf8")) as Lock;
  } catch {
    return { targets: {} };
  }
};
const writeLock = (l: Lock): void => {
  mkdirSync(dirname(LOCK_FILE), { recursive: true });
  writeFileSync(LOCK_FILE, JSON.stringify(l, null, 2));
};

const readJson = (p: string): Record<string, unknown> => {
  if (!existsSync(p)) return {};
  const txt = readFileSync(p, "utf8");
  return (parseJsonc(txt) ?? {}) as Record<string, unknown>;
};
const writeJson = (p: string, obj: unknown): void => {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(obj, null, 2) + "\n", "utf8");
};

// ── Hook strip ───────────────────────────────────────────────────────
// 审批 hook 已经改成**按会话注入** (spawn 时 `--settings` / `--plugin-dir`,
// 见 shared/session-hooks.ts): 全机注册会让人自己开的 CLI 会话也每次工具调用
// 多起一个脚本进程, 即使它只是 passthrough。sync 从今只负责 MCP, 顺手把老版本
// 写下的 hook / env 清掉 —— `sync --remove` 之后机器上不留 wezard 的 hook 痕迹。
interface HookEntry {
  matcher?: string;
  hooks: Array<{ type: string; command: string; timeout?: number; _managedBy?: string }>;
  _managedBy?: string;
}

const stripHooks = (settings: Record<string, unknown>): void => {
  const hooks = settings.hooks as Record<string, unknown> | undefined;
  if (!hooks) return;
  const list = (hooks.PreToolUse as HookEntry[] | undefined) ?? [];
  hooks.PreToolUse = list.filter((e) => !isOurs(e._managedBy));
  if ((hooks.PreToolUse as HookEntry[]).length === 0) delete hooks.PreToolUse;
};

// ── MCP strip ─────────────────────────────────────────────────────────
// MCP 也已经改成**按会话注入** (spawn 的启动行带 `--mcp-config <file>`, 见
// shared/session-mcp.ts): 全机 mcpServers 里留一份, 人自己开的每个 CLI 会话都会多起
// 一个 `node dist/mcp/server.js` (实测 initialize 约 119ms) 而根本用不到它。
// sync 只负责把老版本写下的那份清掉。
const stripMcp = (settings: Record<string, unknown>): void => {
  const m = settings.mcpServers as Record<string, unknown> | undefined;
  if (!m) return;
  for (const k of ["wezard"]) {
    const cur = m[k] as Record<string, unknown> | undefined;
    if (isOurs(cur?._managedBy)) delete m[k];
  }
  // 只剩空壳也删掉 —— 手里那份 settings.json 不该有一个空的 mcpServers 提醒人这里曾经有东西。
  if (Object.keys(m).length === 0) delete settings.mcpServers;
};

// ── Env upsert ────────────────────────────────────────────────────────
// 只删不写: 这些变量现在由 spawn 的启动行带给 wezard 自己的 pane (daemon 地址、
// state 目录、hook 预算); 留在全机 settings 里等于给每个人的会话都塞 wezard 的 env。
// WEZARD_HOOK_FALLBACK 是更早版本的遗留键, 一并清掉。
const ENV_STRIP_KEYS = [
  "WEZARD_DAEMON_BASE",
  "WEZARD_DAEMON_URL",
  "WEZARD_STATE_DIR",
  "WEZARD_HOOK_TIMEOUT",
  "WEZARD_HOOK_FALLBACK",
];
const stripEnv = (settings: Record<string, unknown>): void => {
  const env = settings.env as Record<string, unknown> | undefined;
  if (!env) return;
  for (const k of ENV_STRIP_KEYS) delete env[k];
  // 只剩空壳也删掉: 目标是「不留任何 wezard 的痕迹」, "env": {} 也算。
  if (Object.keys(env).length === 0) delete settings.env;
};

// ── Pre-flight: jq is required by hooks/pre-tool-use.sh ──────────────
// The hook hard-falls back to a local `ask` when jq is missing, which means
// approval cards never reach WeCom — silent, confusing failure on fresh
// installs. Catch it here at registration time with install instructions.
const requireJq = (): void => {
  const r = spawnSync("jq", ["--version"], { stdio: "ignore" });
  if (r.status === 0) return;
  const install = (() => {
    switch (process.platform) {
      case "darwin": return "brew install jq";
      case "linux": return "sudo apt-get install -y jq   # or: sudo yum install -y jq / sudo apk add jq";
      default: return "install jq for your platform";
    }
  })();
  // eslint-disable-next-line no-console
  console.error(
    `\n[wezard-sync] ERROR: 'jq' is required by the PreToolUse hook but not found on PATH.\n` +
    `  Approval cards will NOT be delivered until it is installed.\n` +
    `  Install it, then re-run sync:\n    ${install}\n`,
  );
  process.exit(1);
};

// ── Drivers ───────────────────────────────────────────────────────────
const targetKey = (path: string): string => expandHome(path);

interface SyncOpts { remove?: boolean }

// CodeBuddy reads MCP server config from `~/.codebuddy/mcp.json`, NOT from
// settings.json. Derive the mcp.json path from the settings.json path.
const mcpJsonPath = (settingsPath: string): string =>
  pathResolve(dirname(expandHome(settingsPath)), "mcp.json");

const syncOne = (
  settingsPath: string,
  kind: "claude" | "codebuddy",
  opts: SyncOpts,
  lock: Lock,
): void => {
  const abs = expandHome(settingsPath);
  const settings = readJson(abs);
  stripHooks(settings);
  stripEnv(settings);
  stripMcp(settings);
  if (kind === "codebuddy") {
    // CodeBuddy 的 MCP 落在 ~/.codebuddy/mcp.json (settings.json 是更早的位置), 两处都清。
    const mcpAbs = mcpJsonPath(settingsPath);
    if (existsSync(mcpAbs)) {
      const mcpJson = readJson(mcpAbs);
      stripMcp(mcpJson);
      writeJson(mcpAbs, mcpJson);
    }
  }
  writeJson(abs, settings);
  if (opts.remove) delete lock.targets[targetKey(settingsPath)];
  else lock.targets[targetKey(settingsPath)] = { wroteHooks: false, wroteMcp: false, wroteEnv: [] };
};

const main = async (): Promise<void> => {
  const argv = process.argv.slice(2);
  const remove = argv.includes("--remove") || argv.includes("--uninstall");
  const dryRun = argv.includes("--dry-run");

  const { config: cfg, sourcePath } = loadConfig();
  if (cfg.sync.targets.some((t) => t.kind !== "codex")) requireJq();
  const targets = cfg.sync.targets;
  if (targets.length === 0) {
    // eslint-disable-next-line no-console
    console.error("no sync.targets in config — nothing to do.");
    process.exit(0);
  }
  const base = `http://${cfg.daemon.host}:${cfg.daemon.port}`;

  const lock = readLock();
  for (const t of targets) {
    const action = remove ? "remove" : "upsert";
    // eslint-disable-next-line no-console
    console.log(`[wezard-sync] ${action} ${t.kind} → ${t.settingsPath}`);
    if (dryRun) continue;
    if (t.kind === "codex") {
      await syncCodexHooks(expandHome(t.settingsPath), "codex", process.cwd(),
        codexHookCommand(sourcePath, base, `${PLUGIN_ROOT}/dist/cli/codex-hook.js`), cfg.approval.hookTimeoutSec + 10, remove || !cfg.approval.enabled);
      if (remove) delete lock.targets[targetKey(t.settingsPath)];
      else lock.targets[targetKey(t.settingsPath)] = { wroteHooks: cfg.approval.enabled, wroteMcp: false, wroteEnv: [] };
    } else syncOne(t.settingsPath, t.kind, { remove }, lock);
  }
  if (!dryRun) writeLock(lock);
  // eslint-disable-next-line no-console
  console.log(remove ? "[wezard-sync] removed." : "[wezard-sync] synced.");
};

await main();
