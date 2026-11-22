// duty 逾期扫描: 把 shared/room-overdue 的判定落成账本行 (全经 hub.append, 过 judge)。
//   remind → trigger 行唤醒处理人 (hub 的 scanOwed 认 trigger 的 re, 它必须交代);
//   group  → 逾期 room 里记一行 system (去重用), 非绑定 room 再往处理人 (退到提问者) 的 home 群
//            写一行 system 让人看见。两条都不带 to: wakeTargets 对 system 行不唤醒任何人。
//   人名下的 duty (wizard 的 need / 点名人的 ask): 叫不醒人, 只有 group 一级 —— 话直接对人说「⏰ 人 有一条 .wizard 的提问 N 分钟没回」。
// 不自动 canceled —— 完成只认显式关账。
import type { Logger } from "pino";
import { baseOfKey } from "../shared/session-label.js";
import { DAEMON, holderOf, isBoundRoom, type Draft, type JudgeCtx, type RoomState, type Verdict, type Who } from "../shared/room.js";
import { groupSysOf, overdueDue, type OverdueHit, SYS_OVERDUE_GROUP, SYS_OVERDUE_REMIND } from "../shared/room-overdue.js";

export interface OverdueDeps {
  log?: Logger;
  now: () => number;
  /** 分钟; 0 = 关该级。每次扫描现读 (hot)。 */
  thresholds: () => { remindMin: number; groupMin: number };
  rooms: () => readonly string[];
  stateOf: (room: string) => RoomState | undefined;
  append: (room: string, d: Draft, extra?: Partial<JudgeCtx>) => Verdict;
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

  type Out = { remind: number; group: number; mirrored: number };
  const act = (room: string, s: RoomState, { duty, holder, level, idleMs }: OverdueHit, out: Out): void => {
    const holderName = p.nameOf(holder), askerName = p.nameOf(duty.asker), n = mins(idleMs);
    if (level === "remind") {
      // 不走唤醒预算 (照 room-hub reconcileAfter): 预算用尽时 trigger 照写但 wake=[], 去重又认它给过 —— 提醒就静默丢了。
      const v = p.append(room, {
        author: DAEMON, kind: "trigger", origin: "daemon", sys: SYS_OVERDUE_REMIND, to: [holder], re: [duty.msg],
        text: `[wezard] ${duty.msg} 已 ${n} 分钟没有动静: 做完了就 chat_reply done; 还在做就 progress 报一句; 做不了就 need / canceled`,
      }, { budget: Number.MAX_SAFE_INTEGER });
      if (v.ok) out.remind++; else p.log?.warn({ room, msg: duty.msg, reason: v.reason }, "overdue: remind 写入被拒");
      return;
    }
    // 人名下的账: 叫不醒人, 话直接对人说 (镜像进企微); 非绑定 room 的转 home 群见下。
    const human = holder.kind === "human";
    const v = p.append(room, {
      author: DAEMON, kind: "system", origin: "daemon", sys: groupSysOf(holder.id), re: [duty.msg],
      text: human ? `[wezard] ⏰ ${holderName} 有一条 ${askerName} 的提问 (${duty.msg}) ${n} 分钟没回`
        : `[wezard] ⏰ ${holderName} 名下 ${duty.msg} (来自 ${askerName}) 已 ${n} 分钟没有动静`,
    });
    if (!v.ok) { p.log?.warn({ room, msg: duty.msg, reason: v.reason }, "overdue: group 记录被拒"); return; }
    out.group++;
    if (isBoundRoom(room)) return; // 本身就镜像进企微
    const home = homeOf(holder) ?? homeOf(duty.asker);
    if (!home) { p.log?.info({ room, msg: duty.msg }, "overdue: 处理人与提问者都没有绑定的 home 群, 只记账本"); return; }
    // 取舍: 上面的 room 内记录已落盘 (去重靠它), home 通知失败 / 抛错就不补发 —— 宁可漏一次通知, 也不重复刷群。
    try {
      const m = p.append(home, {
        author: DAEMON, kind: "system", origin: "daemon", sys: SYS_OVERDUE_GROUP,
        text: human ? `[wezard] ⏰ ${holderName} 有一条 ${askerName} 的提问 (${duty.msg}, 在 ${p.roomLabel(room)}) ${n} 分钟没回`
          : `[wezard] ⏰ ${holderName} 名下 ${duty.msg} (来自 ${askerName}, 在 ${p.roomLabel(room)}) 已 ${n} 分钟没有动静`,
      });
      if (m.ok) out.mirrored++; else p.log?.warn({ home, msg: duty.msg, reason: m.reason }, "overdue: home 群通知被拒");
    } catch (e) { p.log?.warn({ home, msg: duty.msg, err: (e as Error).message }, "overdue: home 群通知失败 (不补发)"); }
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
      for (const hit of overdueDue(s, now, o, (uid) => !!p.wizardOf(uid))) {
        // 一条 duty 一个 try: hub.append 遇损坏 room 的 state() 会直接抛, 一条坏的不饿死后面的。
        try { act(room, s, hit, out); } catch (e) { p.log?.warn({ room, msg: hit.duty.msg, err: (e as Error).message }, "overdue: 单条处理失败, 跳过"); }
      }
    }
    if (out.remind || out.group) p.log?.info(out, "overdue: 本轮逾期动作");
    return out;
  };
  return { scan };
};
