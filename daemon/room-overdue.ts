// duty 逾期扫描: 把 shared/room-overdue 的判定落成账本行 (全经 hub.append, 过 judge)。
//   remind → trigger 行唤醒处理人 (hub 的 scanOwed 认 trigger 的 re, 它必须交代);
//   group  → 逾期 room 里记一行 system (去重用), 非绑定 room 再往处理人 (退到提问者) 的 home 群
//            写一行 system 让人看见。两条都不带 to: wakeTargets 对 system 行不唤醒任何人。
// 不自动 canceled —— 完成只认显式关账。
import type { Logger } from "pino";
import { baseOfKey } from "../shared/session-label.js";
import { DAEMON, holderOf, isBoundRoom, type Draft, type RoomState, type Verdict, type Who } from "../shared/room.js";
import { overdueDue, SYS_OVERDUE_GROUP, SYS_OVERDUE_REMIND } from "../shared/room-overdue.js";

export interface OverdueDeps {
  log?: Logger;
  now: () => number;
  /** 分钟; 0 = 关该级。每次扫描现读 (hot)。 */
  thresholds: () => { remindMin: number; groupMin: number };
  rooms: () => readonly string[];
  stateOf: (room: string) => RoomState | undefined;
  append: (room: string, d: Draft) => Verdict;
  wizardOf: (uid: string) => { target: string; name: string } | undefined;
  nameOf: (w: Who) => string;
  roomLabel: (room: string) => string;
}

const mins = (ms: number): number => Math.floor(ms / 60_000);

export const createOverdueScan = (p: OverdueDeps): { scan: () => { remind: number; group: number; mirrored: number } } => {
  const homeOf = (w: Who): string | undefined => {
    if (w.kind !== "wizard") return undefined;
    const t = p.wizardOf(w.id)?.target;
    const base = t ? baseOfKey(t) : undefined;
    const s = base ? p.stateOf(base) : undefined;
    return base && s && isBoundRoom(base) ? base : undefined;
  };

  const scan = (): { remind: number; group: number; mirrored: number } => {
    const c = p.thresholds();
    const o = { remindMs: c.remindMin * 60_000, groupMs: c.groupMin * 60_000 };
    const out = { remind: 0, group: 0, mirrored: 0 };
    if (o.remindMs <= 0 && o.groupMs <= 0) return out;
    const now = p.now();
    for (const room of p.rooms()) {
      let s: RoomState | undefined;
      try { s = p.stateOf(room); } catch { continue; } // 坏 room 跳过
      if (!s) continue;
      for (const { duty, level, idleMs } of overdueDue(s, now, o)) {
        const holder = holderOf(s, duty);
        if (!holder) continue;
        const holderName = p.nameOf(holder), askerName = p.nameOf(duty.asker), n = mins(idleMs);
        if (level === "remind") {
          const v = p.append(room, {
            author: DAEMON, kind: "trigger", origin: "daemon", sys: SYS_OVERDUE_REMIND, to: [holder], re: [duty.msg],
            text: `[wezard] ${duty.msg} 已 ${n} 分钟没有动静: 做完了就 chat_reply done; 还在做就 progress 报一句; 做不了就 need / canceled`,
          });
          if (v.ok) out.remind++; else p.log?.warn({ room, msg: duty.msg, reason: v.reason }, "overdue: remind 写入被拒");
          continue;
        }
        const label = p.roomLabel(room);
        const v = p.append(room, {
          author: DAEMON, kind: "system", origin: "daemon", sys: SYS_OVERDUE_GROUP, re: [duty.msg],
          text: `[wezard] ⏰ ${holderName} 名下 ${duty.msg} (来自 ${askerName}) 已 ${n} 分钟没有动静`,
        });
        if (!v.ok) { p.log?.warn({ room, msg: duty.msg, reason: v.reason }, "overdue: group 记录被拒"); continue; }
        out.group++;
        if (isBoundRoom(room)) continue; // 本身就镜像进企微
        const home = homeOf(holder) ?? homeOf(duty.asker);
        if (!home) { p.log?.info({ room, msg: duty.msg }, "overdue: 处理人与提问者都没有绑定的 home 群, 只记账本"); continue; }
        const m = p.append(home, {
          author: DAEMON, kind: "system", origin: "daemon", sys: SYS_OVERDUE_GROUP,
          text: `[wezard] ⏰ ${holderName} 名下 ${duty.msg} (来自 ${askerName}, 在 ${label}) 已 ${n} 分钟没有动静`,
        });
        if (m.ok) out.mirrored++; else p.log?.warn({ home, msg: duty.msg, reason: m.reason }, "overdue: home 群通知被拒");
      }
    }
    if (out.remind || out.group) p.log?.info(out, "overdue: 本轮逾期动作");
    return out;
  };
  return { scan };
};
