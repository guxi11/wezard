// 升级后回收「起于旧控制面」的 pane (docs/evolve/control-unix-socket.md §6)。
//
// 旧 pane 的启动行是 TCP 时代写的: claude 系带 `--mcp-config <stateDir>/session-mcp.json`
// (stdio, 内存里是旧 server.js) 或 `session-mcp-http.json` (直连 TCP /mcp), codex 带
// `-c mcp_servers.wezard.env.WEZARD_DAEMON_BASE=…`。控制面迁走之后这些 pane 的 MCP 工具
// 只会得到 410 / 拒连。hook 与 codex-hook 每次从盘上现读, 升级后自动走 socket, 不在此列;
// 要换的只有 MCP 那一路 —— 而启动行改不了, 只能重起: `sleepPane` 杀 pane、留绑定与身份,
// 下一条注入 `--resume` 用新启动行拉起来 (带 session-mcp-sock.json / relay)。
//
// 判据是 pane 里 CLI 进程的 argv (`ps` / `/proc`), 不是 pane 的 env: argv 里**没有** wezard
// MCP 痕迹的 pane 不是这次升级造成的, 不碰。只回收空闲的 (没在跑一轮、没停在审批卡上),
// 忙的等下一拍。纯函数 `isLegacyCtlArgs` / `legacyPaneIds` 可单测, IO 全由 deps 注入。
import type { Logger } from "pino";

/** 一个 pane: tmux pane id + 它里面第一个进程 (shell) 的 pid。 */
export interface PaneRef { id: string; pid: number }
export interface ProcRow { ppid: number; cmd: string }

// claude 系: 旧版两份产物都在 `--mcp-config` 后面; 新版是 session-mcp-sock.json, 不匹配。
// 锚在 `--mcp-config` 上, 免得 pane 里随手 `grep session-mcp.json` 的子进程被误当成 CLI。
// codex: 旧版必带这条 `-c` 覆盖 (daemon/spawn-tmux.ts 老写法)。
const LEGACY_CTL_RE =
  /--mcp-config[ =]\S*session-mcp(?:-http)?\.json(?=\s|$)|mcp_servers\.wezard\.env\.WEZARD_DAEMON_BASE=/;

/** 这条 argv 是不是旧控制面时代启动的 agent CLI。 */
export const isLegacyCtlArgs = (args: string): boolean => LEGACY_CTL_RE.test(args);

const MAX_DEPTH = 6;

/** pane pid 起往下 (含自己) 有没有哪个进程的 argv 是旧启动行。 */
const hasLegacyDescendant = (root: number, children: ReadonlyMap<number, number[]>, procs: ReadonlyMap<number, ProcRow>): boolean => {
  const walk = (pid: number, depth: number): boolean =>
    isLegacyCtlArgs(procs.get(pid)?.cmd ?? "") ||
    (depth < MAX_DEPTH && (children.get(pid) ?? []).some((c) => walk(c, depth + 1)));
  return walk(root, 0);
};

/** 哪些 pane 里跑着旧启动行的 CLI (纯函数: 一份 pane 清单 + 一份进程快照)。 */
export const legacyPaneIds = (panes: readonly PaneRef[], procs: ReadonlyMap<number, ProcRow>): string[] => {
  const children = new Map<number, number[]>();
  for (const [pid, p] of procs) children.set(p.ppid, [...(children.get(p.ppid) ?? []), pid]);
  return panes.filter((p) => hasLegacyDescendant(p.pid, children, procs)).map((p) => p.id);
};

/** `tmux list-panes -a -F '#{pane_id} #{pane_pid}'` 的 stdout → PaneRef[] (坏行丢弃)。 */
export const parsePanePids = (stdout: string): PaneRef[] =>
  stdout.split("\n").flatMap((l) => {
    const m = /^\s*(%\d+)\s+(\d+)\s*$/.exec(l);
    return m ? [{ id: m[1]!, pid: parseInt(m[2]!, 10) }] : [];
  });

export interface ReaperDeps {
  log?: Logger;
  listPanes: () => Promise<{ ok: boolean; panes?: readonly PaneRef[]; error?: string }>;
  procs: () => Promise<ReadonlyMap<number, ProcRow>>;
  /** wezard 自己绑定的 wizard: target + 它当前的 pane id。不在这张表里的 pane 一律不碰。 */
  bindings: () => ReadonlyArray<{ target: string; pane: string }>;
  isBusy: (target: string) => Promise<boolean>;
  sleepPane: (target: string) => Promise<{ ok: boolean; reason?: string }>;
}

export interface ReaperStats { legacy: number; slept: number; busy: number; failed: number }

/** 一拍: 找出旧启动行的 pane, 空闲的 sleepPane, 忙的留给下一拍。 */
export const createLegacyPaneReaper = (deps: ReaperDeps) => {
  /** 已经为它打过 warn 的 pane id: sleep 失败只在状态变化时说一次, 不逐拍刷屏。 */
  const warned = new Set<string>();

  const scan = async (): Promise<ReaperStats> => {
    const stats: ReaperStats = { legacy: 0, slept: 0, busy: 0, failed: 0 };
    const listed = await deps.listPanes();
    // tmux 问不出来 = 这一拍什么也别判 (同 room-watchdog 的 D)。
    if (!listed.ok || !listed.panes?.length) return stats;
    const legacy = new Set(legacyPaneIds(listed.panes, await deps.procs()));
    if (!legacy.size) { warned.clear(); return stats; }
    for (const { target, pane } of deps.bindings()) {
      if (!legacy.has(pane)) continue;
      stats.legacy++;
      if (await deps.isBusy(target)) { stats.busy++; continue; }
      const r = await deps.sleepPane(target);
      if (r.ok) {
        stats.slept++;
        warned.delete(pane);
        deps.log?.info({ mod: "legacy-panes", target, pane }, "legacy control plane: idle pane recycled (binding kept; the next message --resumes it on the socket-based launch line)");
      } else {
        stats.failed++;
        if (!warned.has(pane)) {
          warned.add(pane);
          deps.log?.warn({ mod: "legacy-panes", target, pane, reason: r.reason }, "legacy control plane: recycle failed, will retry next beat");
        }
      }
    }
    return stats;
  };

  return { scan };
};
