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
  /** Project cwd the live pane was last spawned in. Empty/undefined → fall
   *  back to cfg.wrc.cwd. Updated on every spawn/respawn so /pwd reflects
   *  reality, not an outdated user request. */
  cwd?: string;
  /** `--model` slug the live pane was spawned with. Empty/undefined = the CLI's
   *  own default. Persisted so a pane-death respawn brings the wizard back on
   *  the model it was given instead of silently dropping to the default. */
  model?: string;
  /** User-requested next cwd (set by AI via the `set_workspace` MCP). Applied
   *  on the next /new (or /clear → upgraded to /new when present). Cleared
   *  once the spawn lands. Decoupling from `cwd` means a /pwd before /new
   *  can show "current X, will switch to Y on /new". */
  pendingCwd?: string;
  /** 人确认过「就用这个目录」。只有一个写入点: 人明说了不用换 (`set_workspace({keep:true})`)。
   *  换去别的目录不必记 —— 那时 runningCwd 已经不是默认兜底目录, 「该不该问」自然为假。
   *  聊天级, 与 cwd/pendingCwd 一样挂在 base principal 上。 */
  cwdConfirmed?: boolean;
  /** `/stop` keepalive pause, persisted so a daemon reload doesn't resurrect a
   *  session the user explicitly quieted. Lifted (→ false) by a real inbound or a
   *  busy-resume, both of which re-persist. `keepaliveOffAt` = when paused (ms),
   *  gating the busy-resume grace across restarts. */
  keepaliveOff?: boolean;
  keepaliveOffAt?: number;
  /** Sticky per-session opt-out, set at spawn time (`spawn_clone` /
   *  `new_claude_session`'s `keepalive:false`). Unlike `keepaliveOff` this
   *  never auto-resumes on real activity — the session was deliberately
   *  created as a disposable worker that shouldn't be kept warm. */
  keepaliveDisabled?: boolean;
}

export type MirrorStore = JsonMap<MirrorAttachment>;

export const loadMirrorStore = (filePath: string): MirrorStore => loadJsonMap<MirrorAttachment>(filePath);
