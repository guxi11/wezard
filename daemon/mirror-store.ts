// Persisted mirror attachments: principal (e.g. "chat:xxx" / "user:xxx") →
// { sessionId, jsonlPath, tmuxSession?, tmuxPane? }. Survives daemon reload so
// the next inbound for a known chat resumes the prior Claude session instead
// of spawning a fresh one. Single-file write-through, same shape/style as
// sessions.ts.
import { loadJsonMap, type JsonMap } from "../shared/json-map-store.js";

export interface MirrorAttachment {
  sessionId: string;
  jsonlPath: string;
  tmuxSession?: string;
  /** Snapshot at attach time. Pane ids are not stable across daemon restarts;
   * restore re-derives the live pane from `tmuxSession` via `list-panes`. */
  tmuxPane?: string;
  /** 绑定时那块 pane 的窗口名与 shell pid (2026-11-19): tmux server 重启后 pane id 从 %0
   *  重新编号, 存下来的 %N 很可能落到**别人的** pane 上。restore 用这两个字段核对「%N 还是
   *  原来那块 pane 吗」; 对不上就按死 pane 处理, 绝不按名字去猜别人的 pane。 */
  tmuxWindow?: string;
  tmuxPid?: string;
  /** 绑定时那块 pane 里注册表登记的 CLI 子进程 pid (2026-11-19): codebuddy 的注册表
   *  没有 tmux 字段, 认回只能靠进程树 —— shell pid 等值之外的补充判据。respawn 后
   *  由 refreshPaneIdentity 重捕。 */
  cliPid?: number;
  /** Project cwd the live pane was last spawned in. Empty/undefined → fall
   *  back to cfg.wrc.cwd. Updated on every spawn/respawn so /pwd reflects
   *  reality, not an outdated user request. */
  cwd?: string;
  /** `--model` slug the live pane was spawned with. Empty/undefined = the CLI's
   *  own default. Persisted so a pane-death respawn brings the wizard back on
   *  the model it was given instead of silently dropping to the default. */
  model?: string;
  /** `--effort` level the wizard runs at. Empty/undefined = the CLI's default.
   *  Persisted for the same reason as `model`, and carried through `/new`. */
  effort?: string;
  /** User-requested next cwd (set by AI via the `set_workspace` MCP). Applied
   *  on the next /new (or /clear → upgraded to /new when present). Cleared
   *  once the spawn lands. Decoupling from `cwd` means a /pwd before /new
   *  can show "current X, will switch to Y on /new". */
  pendingCwd?: string;
  /** 这个会话有一份还没送达的宪章 (`AttachState.charterPending`): 挂上时落 true,
   *  注入确认 ok 后清掉。daemon 重启后内存里的 pending 没了, attach 凭它 +
   *  transcript 判据重新武装 —— 见 shared/charter-rearm.ts。 */
  charterOwed?: boolean;
  /** 人确认过「就用这个目录」。只有一个写入点: 人明说了不用换 (`set_workspace({keep:true})`)。
   *  换去别的目录不必记 —— 那时 runningCwd 已经不是默认兜底目录, 「该不该问」自然为假。
   *  聊天级, 与 cwd/pendingCwd 一样挂在 base principal 上。 */
  cwdConfirmed?: boolean;
}

export type MirrorStore = JsonMap<MirrorAttachment>;

/** restore 的 pane 认领判据 (纯): 存过身份 (窗口名/pid) 就要求对得上; 老记录两样都没存 =
 *  只认 pane id (向后兼容)。pane id 被 tmux 重编号后可能指向别人, 这里对不上就当它没了。 */
export const paneIdentityMatches = (
  rec: Pick<MirrorAttachment, "tmuxWindow" | "tmuxPid">,
  meta: { window: string; pid: string } | undefined,
): boolean => {
  if (!rec.tmuxWindow && !rec.tmuxPid) return true;
  if (!meta) return false;
  return (!rec.tmuxWindow || meta.window === rec.tmuxWindow) && (!rec.tmuxPid || meta.pid === rec.tmuxPid);
};

/** 认回判据 (纯, 2026-11-19): %N 失效后一个候选 pane 能否按「窗口名 + pid」认回。
 *  ① 注册表 sid 是最强判据, 但要读盘, 在调用方的 I/O 层做; 这里管 ②③:
 *  ② 存过 shell pid 且与候选 pane_pid 等值; ③ 存过 CLI pid 且它还在候选 pane 的
 *  进程树里 (treeHas 由调用方带 ps 快照进来)。存过窗口名就必须对上 —— 窗口名/ pid
 *  单独一样对上都不够猜 (绝不按名字串门), 两样都没有的老记录不认回。 */
export const paneReclaimMatches = (
  rec: Pick<MirrorAttachment, "tmuxWindow" | "tmuxPid" | "cliPid">,
  cand: { window: string; pid: string },
  treeHas: (rootPid: number, pid: number) => boolean,
): boolean => {
  const win = (rec.tmuxWindow ?? "").trim();
  if (win && cand.window !== win) return false;
  if (!win && !rec.tmuxPid && !rec.cliPid) return false;
  if (rec.tmuxPid && cand.pid === rec.tmuxPid) return true;
  return Boolean(rec.cliPid && treeHas(Number(cand.pid), rec.cliPid));
};

export const loadMirrorStore = (filePath: string): MirrorStore => loadJsonMap<MirrorAttachment>(filePath);
