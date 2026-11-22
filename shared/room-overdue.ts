// duty 逾期 (纯函数): 未关的 duty 距「最后一次活动」多久了, 该给哪一级提醒。
// 活动 = 原行 + re 含它的行, 且只算非 daemon 作者 —— daemon 自己写的提醒不重置计时,
// 否则一次提醒就把后面的升级压没了; 处理人 chat_reply progress 一句就重新计时。
// 去重靠账本: 同级的 sys 行 (overdue-remind / overdue-group) 在最后活动之后已有 → 不再给。
import { holderOf, openDuties, type Duty, type RoomState } from "./room.js";

export type OverdueLevel = "remind" | "group";
export interface OverdueThresholds { remindMs: number; groupMs: number }
export interface OverdueHit { duty: Duty; level: OverdueLevel; idleMs: number }

export const SYS_OVERDUE_REMIND = "overdue-remind";
export const SYS_OVERDUE_GROUP = "overdue-group";

const lastActivity = (s: RoomState, d: Duty): number =>
  s.msgs.reduce(
    (at, r) => (r.author.kind !== "daemon" && (r.id === d.msg || (r.re ?? []).includes(d.msg)) ? Math.max(at, r.at) : at),
    d.at,
  );

const alreadyGiven = (s: RoomState, d: Duty, sys: string, since: number): boolean =>
  s.msgs.some((r) => r.sys === sys && (r.re ?? []).includes(d.msg) && r.at > since);

export const overdueDue = (s: RoomState, now: number, o: OverdueThresholds): OverdueHit[] =>
  openDuties(s)
    .filter((d) => d.kind !== "join-req" && holderOf(s, d)?.kind === "wizard")
    .flatMap((duty): OverdueHit[] => {
      const last = lastActivity(s, duty);
      const idleMs = now - last;
      const levels: Array<[OverdueLevel, number, string]> = [
        ["remind", o.remindMs, SYS_OVERDUE_REMIND],
        ["group", o.groupMs, SYS_OVERDUE_GROUP],
      ];
      return levels
        .filter(([, ms, sys]) => ms > 0 && idleMs >= ms && !alreadyGiven(s, duty, sys, last))
        .map(([level]) => ({ duty, level, idleMs }));
    });
