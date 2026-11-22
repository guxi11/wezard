// duty 逾期 (纯函数): 未关的 duty 距「最后一次活动」多久了, 该给哪一级提醒。
// 计时与去重都按 **holder** 算 (`ask to:[B,C]` 是 msg@B / msg@C 两条 duty): 活动 = 该 holder 自己写的行
// + 提问者对这条 msg 的补充 + 一次转交 (move) + (host 槽位) 当前 host 入座; daemon 自己的提醒不算,
// 否则一次提醒就把后面的升级压没了。处理人 chat_reply progress 一句就重新计时。
// remind 去重: 最后活动之后已有 `sys:overdue-remind` 且 `to` 含这个 holder 的行。
// group 去重: 最后活动之后已有 `sys:overdue-group@<holderUid>` 的行; 且必须等 remind 真的送到
// (holder 的 seen 游标越过那条 trigger) —— 否则处理人在跑长 turn、提醒还没投递, 群里就先说「没有动静」了。
// 无主的 duty (holder 已不是成员 / 名册上查无此人) 直接跳过: 它归 watchdog 的 canceled 路径收尾。
// 人名下的 duty (wizard 的 need / 点名人的 ask) 叫不醒人: 不发 remind, 只到 groupMs 在群里让人看见一行;
// 提问的 wizard 已不在 room 里就不催了。反过来, wizard 名下那条若它最后一句是 need、而它那句 need
// 在人名下开的账还开着 —— 球在人那边, 不对这个 wizard 计逾期。
// 派出去的子件也算 holder 的活动: duty 的 msg id 被别的 task / ask 行当作 `for` (血缘) 时, 那些子行自身的时刻、
// 它们 room 里非 daemon 行对它们的回应 (含子件 done 关账那一刻) 以及孙辈的同类活动, 都并入 lastActivity
// (`descendantActivityOf`, 跨 room 由调用方建一次索引传进来); 子件也静止超时才照常提醒。
import { DAEMON, HOST_SLOT, holderOf, openDuties, sameWho, whoKey, type Duty, type MsgRow, type RoomState, type Who } from "./room.js";

export type OverdueLevel = "remind" | "group";
export interface OverdueThresholds { remindMs: number; groupMs: number }
export interface OverdueHit { duty: Duty; holder: Who; level: OverdueLevel; idleMs: number }

export const SYS_OVERDUE_REMIND = "overdue-remind";
export const SYS_OVERDUE_GROUP = "overdue-group";
/** group 行的 sys 带 holder uid: 同一条 msg 的多个 holder 各自去重 (group 行不能带 to, 否则会唤醒)。 */
export const groupSysOf = (holderUid: string): string => SYS_OVERDUE_GROUP + "@" + holderUid;

const touches = (r: MsgRow, d: Duty): boolean => r.id === d.msg || (r.re ?? []).includes(d.msg);

/** 子件活动查询: msg id → 它名下派出去的子件 (含孙辈) 最近一次活动的时刻, 没有 = 0。 */
export type DescendantActivity = (msgId: string) => number;

const MAX_LINEAGE_DEPTH = 5;

/** 跨 room 建 `for` 血缘索引: 每条带 `for` 的 msg 行挂到 children[for]; 子件活动 = 子行自身 at 与其 room 里
 *  `re` 含子行 id 的非 daemon 行的最大 at, 递归并入孙辈 (visited 防环, 深度 ≤ 5)。
 *  `for` 写的是名字而非消息 id 时, 没有任何 msg id 会命中它 —— 自然被忽略。 */
export const buildDescendantActivity = (states: Iterable<RoomState>): DescendantActivity => {
  const children = new Map<string, MsgRow[]>();
  const touched = new Map<string, number>(); // msg id → 非 daemon 行对它的最近一次回应
  for (const s of states) for (const r of s.msgs) {
    if (r.for) children.set(r.for, [...(children.get(r.for) ?? []), r]);
    if (r.author.kind !== DAEMON.kind) for (const id of r.re ?? []) touched.set(id, Math.max(touched.get(id) ?? 0, r.at));
  }
  const walk = (id: string, depth: number, seen: Set<string>): number =>
    (children.get(id) ?? []).reduce((acc, c) => {
      if (seen.has(c.id)) return acc;
      seen.add(c.id);
      const own = Math.max(c.at, touched.get(c.id) ?? 0);
      return Math.max(acc, own, depth < MAX_LINEAGE_DEPTH ? walk(c.id, depth + 1, seen) : 0);
    }, 0);
  return (id) => walk(id, 1, new Set([id]));
};

const lastActivity = (s: RoomState, d: Duty, holder: Who, descendant: DescendantActivity): number =>
  Math.max(
    d.at,
    descendant(d.msg),
    d.movedAt ?? 0,
    d.slot === HOST_SLOT ? (s.members.get(whoKey(holder))?.since ?? 0) : 0,
    ...s.msgs.filter((r) => touches(r, d) && (sameWho(r.author, holder) || sameWho(r.author, d.asker))).map((r) => r.at),
  );

/** 球在人那边: holder 最近一句非终态是 need, 且那句 need 在人名下开的 duty 还没关。 */
const ballWithHuman = (s: RoomState, d: Duty): boolean => {
  if (d.last?.status !== "need") return false;
  const row = s.msgs.find((r) => r.seq === d.last!.seq);
  return !!row && openDuties(s).some((x) => x.msg === row.id && x.kind === "need");
};

const remindsTo = (s: RoomState, d: Duty, holder: Who, since: number): MsgRow[] =>
  s.msgs.filter((r) => r.sys === SYS_OVERDUE_REMIND && (r.re ?? []).includes(d.msg) && r.at > since && (r.to ?? []).some((t) => sameWho(t, holder)));

const groupGiven = (s: RoomState, d: Duty, holder: Who, since: number): boolean =>
  s.msgs.some((r) => r.sys === groupSysOf(holder.id) && (r.re ?? []).includes(d.msg) && r.at > since);

export const overdueDue = (
  s: RoomState, now: number, o: OverdueThresholds, known: (uid: string) => boolean = () => true,
  descendantActivity: DescendantActivity = () => 0,
): OverdueHit[] =>
  openDuties(s).flatMap((duty): OverdueHit[] => {
    const holder = holderOf(s, duty);
    if (duty.kind === "join-req" || !holder || !s.members.has(whoKey(holder))) return [];
    if (holder.kind === "human") {
      if (duty.asker.kind === "wizard" && !s.members.has(whoKey(duty.asker))) return [];
      const last = lastActivity(s, duty, holder, descendantActivity);
      return o.groupMs > 0 && now - last >= o.groupMs && !groupGiven(s, duty, holder, last)
        ? [{ duty, holder, level: "group", idleMs: now - last }] : [];
    }
    if (holder.kind !== "wizard" || !known(holder.id) || ballWithHuman(s, duty)) return [];
    const last = lastActivity(s, duty, holder, descendantActivity);
    const idleMs = now - last;
    const reminds = remindsTo(s, duty, holder, last);
    const hits: OverdueHit[] = [];
    if (o.remindMs > 0 && idleMs >= o.remindMs && !reminds.length) hits.push({ duty, holder, level: "remind", idleMs });
    const seen = s.members.get(whoKey(holder))?.seen ?? 0;
    // remind 开着时, group 要等 remind 被读到; remind 关了 (0) 就只看自己的阈值。
    const delivered = o.remindMs <= 0 || reminds.some((r) => seen >= r.seq);
    if (o.groupMs > 0 && idleMs >= o.groupMs && delivered && !groupGiven(s, duty, holder, last)) hits.push({ duty, holder, level: "group", idleMs });
    return hits;
  });
