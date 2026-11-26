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
// **递归式催促, 只催叶子**: `for` 名下还挂着一个未关、处理人仍在册的 wizard duty 时, 这条 duty 不催 ——
// 先催下游的处理人 (`buildOpenChildDuties`, 跨 room 建一次); 下游都关掉了, 上游才按自己的空闲时长收提醒。
// 这正是「执行者已 done、上游没转告人」的收口: 子件关账那一刻是活动, 计时从那里重来, remindMin 后催上游。
// progress duty 与普通未答 duty 同一套阈值: progress 只把 lastActivity 推到那一行 (重新计时), 不豁免、不单独计时。
// **球在别处不催 (ballElsewhere)**: holder 最后一句是 need (对人或对 wizard) 且球还在对方手里 —— 对人: 那句 need 在人名下开的账还开着;
// 对 wizard: 提问者没有在那句 need 之后再说过话; 或这条 duty 自己还有未满足的 after (holder 根本没被唤醒) —— 只抑制 remind,
// group 级照旧按 groupMs 走 (两个 wizard 互相 need 的静默死锁要让人看见)。对人 (人名下那条 need 账还开着) 两级都不计, 如旧:
// 人那条自己会在 groupMs 到群里报一行, holder 再报一行只是重复刷群。
// **退避 + 上限**: 同一条 duty 自「最后一次非 progress 的实质行」(anchor) 以来, 每催一次只换来 progress, 下一次提醒的间隔就乘
// `backoff` (60→120→240); 连续催了 `maxReminds` 次后不再唤醒 holder, 改落**一次** group 行 (hit.exhausted: 「球可能不在 .X 手里」)。
// 第 1 次 remind 照旧 remindMs。backoff ≤ 1 = 不退避, maxReminds 0 = 不设上限。
import { DAEMON, HOST_SLOT, afterSatisfied, holderOf, openDuties, sameWho, whoKey, type Duty, type MsgRow, type RoomState, type Who } from "./room.js";

export type OverdueLevel = "remind" | "group";
export interface OverdueThresholds { remindMs: number; groupMs: number; backoff?: number; maxReminds?: number }
/** exhausted = 这是「连催 maxReminds 次只换来 progress」后落的那一行 group。 */
export interface OverdueHit { duty: Duty; holder: Who; level: OverdueLevel; idleMs: number; exhausted?: boolean; reminds?: number }

/** 提醒 / Stop hook 共用的「该写哪个 status」口径: progress 只给新事实, 等别人就 need 点名, 做完 done —— 不再有「还在做就报一句」。 */
export const STATUS_GUIDE =
  "有新事实 (commit / 产物 / 结论) 才 status:\"progress\"; 在等人或同伴就 status:\"need\" 点名对方; 在等你派出去的子件就检查子件的 `for` 是否挂在这条上; 做完 done; 不做 canceled";

export const DEFAULT_BACKOFF = 2;
export const DEFAULT_MAX_REMINDS = 2;

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

/** 下游未关的 duty 查询: msg id → 它 `for` 名下是否还挂着一个**可催的**未关 duty。 */
export type OpenChildDuties = (msgId: string) => boolean;

/** 跨 room 建「下游还开着」索引 (递归式催促的抑制条件)。一条子 bound duty 算数 (会拦住上游) 的条件:
 *  未关, 处理人是 wizard, 仍是那个 room 的成员, 且名册上认得 —— 与 `overdueDue` 会去催的条件一致。
 *  查无此人 / 已离开的孤儿 duty 不算数: 催不动它, 再拦住上游就整条链静默了 (它会走 watchdog 的
 *  canceled 路径收尾, 上游照常收提醒)。只看直接子件: 每一层自己都会被 `overdueDue` 逐条判定, 逐层
 *  抑制自然就是递归的, 不必在这里做深度遍历。 */
export const buildOpenChildDuties = (states: Iterable<RoomState>, known: (uid: string) => boolean = () => true): OpenChildDuties => {
  const blocking = new Set<string>(); // 可催的未关 duty 的 msg id
  const parents = new Map<string, string[]>(); // for → 子行 id
  for (const s of states) {
    for (const d of openDuties(s)) {
      const h = holderOf(s, d);
      if (h?.kind === "wizard" && s.members.has(whoKey(h)) && known(h.id)) blocking.add(d.msg);
    }
    for (const r of s.msgs) if (r.for) parents.set(r.for, [...(parents.get(r.for) ?? []), r.id]);
  }
  return (id) => (parents.get(id) ?? []).some((c) => blocking.has(c));
};

const lastActivity = (s: RoomState, d: Duty, holder: Who, descendant: DescendantActivity): number => Math.max(
    d.at,
    descendant(d.msg),
    d.movedAt ?? 0,
    d.slot === HOST_SLOT ? (s.members.get(whoKey(holder))?.since ?? 0) : 0,
    ...s.msgs.filter((r) => touches(r, d) && (sameWho(r.author, holder) || sameWho(r.author, d.asker))).map((r) => r.at),
  );

/** 跨 room 建「这条消息是否已以 done 关账」索引 (带 after 的 duty 判前置用; 与 room-hub 的 closedDoneAnywhere 同义)。 */
export const buildClosedDone = (states: Iterable<RoomState>): ((msg: string) => boolean) => {
  const ds = new Map<string, Duty[]>();
  for (const s of states) for (const d of s.duties.values()) ds.set(d.msg, [...(ds.get(d.msg) ?? []), d]);
  return (msg) => { const x = ds.get(msg) ?? []; return x.length > 0 && x.every((d) => d.closed?.status === "done"); };
};

/** 球在别处: 催 holder 没有意义 (它在等别人)。"human" = 那句 need 在人名下开的账还开着 (人那条自己会到 groupMs 在群里报一行,
 *  holder 不再重复报); "wizard" = 在等同伴 (need 对 wizard 提问者 / 前置 after 未满足) —— 这一类只抑制 remind, group 照旧。 */
const ballElsewhere = (s: RoomState, d: Duty, holder: Who, closedDone: (msg: string) => boolean): "human" | "wizard" | false => {
  if (d.after?.length && !afterSatisfied(d.after, closedDone)) return "wizard"; // 前置没满足: holder 还没轮到
  if (d.last?.status !== "need") return false;
  const row = s.msgs.find((r) => r.seq === d.last!.seq);
  if (!row) return false;
  if (openDuties(s).some((x) => x.msg === row.id && x.kind === "need")) return "human";
  // 对 wizard: need 行不开账 (球传给提问者); 提问者 (或任何非 holder 的人) 在那句之后没再说过话就算球在对方。
  return d.asker.kind === "wizard" && s.members.has(whoKey(d.asker))
    && !s.msgs.some((r) => touches(r, d) && r.seq > row.seq && r.author.kind !== DAEMON.kind && !sameWho(r.author, holder))
    ? "wizard" : false;
};

/** 退避的锚点: 最后一条非 progress 的实质行 (holder 的 need / error / 提问者的补充 ...); progress 与 daemon 行不算。 */
const anchorOf = (s: RoomState, d: Duty, holder: Who): number => Math.max(
  d.at, d.movedAt ?? 0,
  ...s.msgs.filter((r) => touches(r, d) && r.id !== d.msg && r.author.kind !== DAEMON.kind && r.status !== "progress"
    && (sameWho(r.author, holder) || sameWho(r.author, d.asker))).map((r) => r.at),
);

const remindsTo = (s: RoomState, d: Duty, holder: Who, since: number): MsgRow[] =>
  s.msgs.filter((r) => r.sys === SYS_OVERDUE_REMIND && (r.re ?? []).includes(d.msg) && r.at > since && (r.to ?? []).some((t) => sameWho(t, holder)));

const groupGiven = (s: RoomState, d: Duty, holder: Who, since: number): boolean =>
  s.msgs.some((r) => r.sys === groupSysOf(holder.id) && (r.re ?? []).includes(d.msg) && r.at > since);

export const overdueDue = (
  s: RoomState, now: number, o: OverdueThresholds, known: (uid: string) => boolean = () => true,
  descendantActivity: DescendantActivity = () => 0, openChild: OpenChildDuties = () => false,
  closedDone: (msg: string) => boolean = () => true,
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
    if (holder.kind !== "wizard" || !known(holder.id)) return [];
    // 下游还开着: 先催下游 (它自己也在这一轮被逐条判定), 上游两级都不催。
    if (openChild(duty.msg)) return [];
    const last = lastActivity(s, duty, holder, descendantActivity);
    const idleMs = now - last;
    const ball = ballElsewhere(s, duty, holder, closedDone);
    if (ball === "human") return [];
    const elsewhere = ball === "wizard";
    const anchor = anchorOf(s, duty, holder);
    const n = remindsTo(s, duty, holder, anchor).length; // 自锚点起催过几次 (期间 holder 只回了 progress)
    const exhausted = !elsewhere && (o.maxReminds ?? DEFAULT_MAX_REMINDS) > 0 && n >= (o.maxReminds ?? DEFAULT_MAX_REMINDS);
    const factor = Math.max(1, o.backoff ?? DEFAULT_BACKOFF);
    const nextRemindMs = o.remindMs * Math.pow(factor, Math.min(n, 10));
    const reminds = remindsTo(s, duty, holder, last);
    const hits: OverdueHit[] = [];
    if (o.remindMs > 0 && !elsewhere && !exhausted && idleMs >= nextRemindMs && !reminds.length) hits.push({ duty, holder, level: "remind", idleMs, reminds: n });
    const seen = s.members.get(whoKey(holder))?.seen ?? 0;
    // 已落的 remind 必须先被读到; remind 关了 / 球在别处 / 已到上限时不会再有 remind, 就只看自己的阈值。
    const delivered = !reminds.some((r) => seen < r.seq)
      && (o.remindMs <= 0 || elsewhere || exhausted || reminds.length > 0);
    // 到上限后「落一次」: group 去重改按锚点算 (progress 把 last 往后推, 按 last 去重会每次 progress 都再落一行)。
    const given = exhausted ? groupGiven(s, duty, holder, anchor) : groupGiven(s, duty, holder, last);
    const groupAt = exhausted && o.groupMs > 0 ? Math.min(o.groupMs, nextRemindMs) : o.groupMs;
    if (o.groupMs > 0 && idleMs >= groupAt && delivered && !given) hits.push({ duty, holder, level: "group", idleMs, ...(exhausted ? { exhausted: true, reminds: n } : {}) });
    return hits;
  });
