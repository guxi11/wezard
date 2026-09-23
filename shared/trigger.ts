// 触发规约 (Specification) —— 「什么时候放枪」从一个三选一的枚举, 改成一棵可组合、
// 可序列化、可回显的小 AST。
//
// 改这一刀的理由: 枚举是封闭的, 而人的说法是开放的。「白天每隔一个小时」在旧形状
// 里无处安放 —— 它是两件事的**交集**: 一个产生时刻的时钟 (每小时), 和一个只会
// 否决的筛子 (08:00–20:00)。把这两类分开, 组合就够用了, 不必为每种新说法再加一个
// kind:
//
//   Clock  能自己产生候选时刻, 有「下次是什么时候」    every / daily / once
//   Guard  产生不了任何一枪, 只否决落在外面的         between / onDays / not
//   Trigger = 一个 Clock ∧ 若干 Guard
//
// AST 而不是闭包: 闭包没法回显给人看 (「每 1 小时 · 08:00-20:00」)、没法存进 json、
// 没法在详情页画出来。构造器 (every/daily/and/…) 只是这棵树的字面量工厂 —— LLM
// 写 `and(every("1h"), between("08:00","20:00"))` 与手写对象字面量等价。
import {
  daysLabel, daysOf, durationLabel, hhmm, parseDays, parseDuration,
  parseInterval, parseOnceAt, parseTimeOfDay, parseWindow, RANGE_RE, type HM,
} from "./schedule-spec.js";

export type { HM };

export type Clock =
  | { kind: "every"; minutes: number }
  | { kind: "daily"; times: HM[] }
  | { kind: "once"; at: number };

export type Guard =
  | { kind: "between"; from: HM; to: HM }
  | { kind: "onDays"; days: number[] }
  | { kind: "not"; of: Guard };

export interface Trigger {
  clock: Clock;
  guards: Guard[];
}

// 守护进程重启/维护会吃掉整分钟的 tick。错过的那一下在 5 分钟内补跑, 超出就放弃 ——
// 早上 9 点的任务在中午补跑比不跑更糟。
const CATCHUP_MS = 5 * 60_000;

const minutesOfDay = (t: HM): number => t.hour * 60 + t.minute;

const asHM = (v: string | HM): HM => {
  if (typeof v !== "string") return v;
  const t = parseTimeOfDay(v);
  if (!t) throw new Error(`认不出时刻「${v}」, 写成 "09:30" / "晚上9点半" 这样`);
  return t;
};

// ── 构造器 (任务文件里的 helpers) ──────────────────────────────────
/** `every("1h")` / `every(90)` / `every("每隔两个小时")` —— 每隔多久一枪。 */
export const every = (spec: string | number): Trigger => {
  const n = typeof spec === "string" ? (parseDuration(spec) ?? parseInterval(spec)) : parseDuration(spec);
  if (!n) throw new Error(`认不出间隔「${spec}」, 写成 "1h" / "30m" / "两小时"`);
  return { clock: { kind: "every", minutes: Math.max(1, Math.round(n)) }, guards: [] };
};

/** `daily("09:30")` / `daily("09:00", "18:00")` —— 每天的这几个时刻。 */
export const daily = (...times: (string | HM)[]): Trigger => ({
  clock: { kind: "daily", times: times.length ? times.map(asHM) : [{ hour: 9, minute: 0 }] },
  guards: [],
});

/** `at("2026-10-01 09:00")` / `at(Date)` —— 只响一次。 */
export const at = (when: string | number | Date): Trigger => {
  const ms = when instanceof Date ? when.getTime()
    : typeof when === "number" ? when
      : (parseOnceAt(when, new Date()) ?? Date.parse(when));
  if (!Number.isFinite(ms)) throw new Error(`认不出时刻「${String(when)}」`);
  return { clock: { kind: "once", at: ms }, guards: [] };
};

/** `between("08:00","20:00")` —— 只在这段时间内放行。from > to 视为跨午夜。 */
export const between = (from: string | HM, to: string | HM): Guard =>
  ({ kind: "between", from: asHM(from), to: asHM(to) });

/** `onDays("工作日")` / `onDays([1,3,5])` —— 只在这几天放行。 */
export const onDays = (spec: string | readonly number[]): Guard => ({ kind: "onDays", days: daysOf(spec) });

export const not = (of: Guard): Guard => ({ kind: "not", of });

/** `and(every("1h"), between("08:00","20:00"))` —— 一个时钟配若干筛子。 */
export const and = (base: Trigger, ...guards: Guard[]): Trigger =>
  ({ clock: base.clock, guards: [...base.guards, ...guards] });

/** 任务文件的 `when` 拿到的就是这一组; 传进去而不是让它 import, 是因为任务文件
 *  住在 ~/.wezard/tasks/ 下, 那里没有也不该有到 dist 的相对路径。 */
export const TRIGGER_HELPERS = { every, daily, at, between, onDays, not, and } as const;
export type TriggerHelpers = typeof TRIGGER_HELPERS;

// ── 人话 → 规约 ────────────────────────────────────────────────────
/**
 * 整句话进, 规约出。认不出返回 undefined —— 调用方要把原句回给用户让他重说,
 * 绝不能猜一个时间安静地存下去。
 *
 * 顺序有意为之: 一次性 (带「今天/明天/N 分钟后」的措辞) 最具体, 其次是间隔,
 * 最后才是周期日程 —— 「每天」这种词在前两者里都不会出现。窗口与星期是筛子,
 * 无论走哪条时钟分支都往上挂。
 */
export const parseTrigger = (text: string, now: Date = new Date()): Trigger | undefined => {
  const t = text.trim();
  if (!t) return undefined;
  const once = parseOnceAt(t, now);
  if (once !== undefined) return { clock: { kind: "once", at: once }, guards: [] };

  const w = parseWindow(t);
  // 「8点到20点每小时」: 区间已被窗口吃掉, 再去 parseTimeOfDay 会把 8 点当成日程
  // 时刻。显式区间从句子里剔掉后再找时刻。
  const tod = parseTimeOfDay(w?.explicit ? t.replace(RANGE_RE, " ") : t, t);
  // 软窗口 (「晚上」) 碰上具体时刻就让位 —— 那个词说的是这一刻, 不是一段。
  const win = w && (!w.soft || !tod) ? w : undefined;
  const days = parseDays(t);
  const iv = parseInterval(t);
  const guards: Guard[] = [
    ...(win ? [between(win.from, win.to)] : []),
    ...(days && days.length ? [onDays(days)] : []),
  ];

  // 「每 2 天早上 9 点」这种既给间隔又给时刻的说法, 按日程理解更接近本意;
  // 纯间隔 (不带时刻) 才走 every。
  if (iv !== undefined && !tod) return { clock: { kind: "every", minutes: Math.max(1, Math.round(iv)) }, guards };
  if (tod) return { clock: { kind: "daily", times: [tod] }, guards };
  if (days) return { clock: { kind: "daily", times: [{ hour: 9, minute: 0 }] }, guards }; // 只说了「每个工作日」
  if (iv !== undefined) return { clock: { kind: "every", minutes: Math.max(1, Math.round(iv)) }, guards };
  return undefined;
};

/** 1.5.x 之前的三选一 `when`。老 config 里的定时靠它升格, 否则静默消失。 */
export const triggerOfLegacyWhen = (w: {
  kind: string; days?: number[]; hour?: number; minute?: number; minutes?: number; at?: number;
}): Trigger => {
  if (w.kind === "every") return { clock: { kind: "every", minutes: w.minutes ?? 60 }, guards: [] };
  if (w.kind === "once") return { clock: { kind: "once", at: w.at ?? 0 }, guards: [] };
  return {
    clock: { kind: "daily", times: [{ hour: w.hour ?? 9, minute: w.minute ?? 0 }] },
    guards: w.days?.length ? [onDays(w.days)] : [],
  };
};

/** 任务文件的 `when` 可以写成人话、helpers 表达式或直接一棵树 —— 都收敛到这里。 */
export const toTrigger = (
  when: unknown,
  now: Date = new Date(),
): { ok: true; trigger: Trigger } | { ok: false; reason: string } => {
  try {
    if (typeof when === "function") {
      const r = (when as (h: TriggerHelpers) => unknown)(TRIGGER_HELPERS);
      return toTrigger(r, now);
    }
    if (typeof when === "string") {
      const t = parseTrigger(when, now);
      return t ? { ok: true, trigger: t } : { ok: false, reason: WHEN_HELP(when) };
    }
    if (when && typeof when === "object" && "clock" in when) {
      const tr = when as Trigger;
      return { ok: true, trigger: { clock: tr.clock, guards: tr.guards ?? [] } };
    }
    return { ok: false, reason: `when 认不出: ${JSON.stringify(when)?.slice(0, 120) ?? typeof when}` };
  } catch (e) {
    return { ok: false, reason: (e as Error).message };
  }
};

export const WHEN_HELP = (raw: string): string =>
  `无法理解「${raw}」。能认的说法: 每天/每个工作日/每周三 + 时刻 (晚上9:30 / 21:30 / 九点半), ` +
  `每隔 N 分钟|小时 (每小时 / 每隔两个小时), N 分钟后, 明早 9 点; ` +
  `再叠时间窗口 (白天 / 工作时间 / 8点到20点)。也可以在任务文件里直接写 ` +
  `\`when: ({every, between, and}) => and(every("1h"), between("08:00","20:00"))\`。`;

// ── 判定 ────────────────────────────────────────────────────────────
/** 此刻落在这个筛子里吗。`between` 的 from > to 表示跨午夜 (「夜里」)。 */
export const holds = (g: Guard, now: Date): boolean => {
  switch (g.kind) {
    case "onDays":
      return !g.days.length || g.days.includes(now.getDay());
    case "not":
      return !holds(g.of, now);
    case "between": {
      const m = now.getHours() * 60 + now.getMinutes();
      const a = minutesOfDay(g.from);
      const b = minutesOfDay(g.to);
      return a <= b ? m >= a && m < b : m >= a || m < b;
    }
  }
};

const dailyInstantsToday = (times: readonly HM[], now: Date): number[] =>
  times.map((t) => {
    const d = new Date(now);
    d.setHours(t.hour, t.minute, 0, 0);
    return d.getTime();
  });

const clockDue = (c: Clock, now: Date, since: number): boolean => {
  const t = now.getTime();
  switch (c.kind) {
    case "once":
      return t >= c.at && since < c.at;
    case "every":
      return t - since >= c.minutes * 60_000;
    case "daily":
      return dailyInstantsToday(c.times, now).some((inst) => t >= inst && t - inst < CATCHUP_MS && since < inst);
  }
};

/**
 * 到点了吗。`since` = 上次触发时刻, 从没触发过就传创建时刻 —— 它同时承担三件事:
 * 同一分钟内多次 tick 的去重、重启后不重复触发、以及「刚创建就到点」不立即打一枪。
 *
 * 筛子放在时钟之后判: 窗外的那一枪是**被吞掉**而不是被推迟 —— 「白天每小时」在
 * 夜里不补跑, 早上 8 点重新开始。
 */
export const isDue = (tr: Trigger, now: Date, since: number): boolean =>
  clockDue(tr.clock, now, since) && tr.guards.every((g) => holds(g, now));

// 筛子恒假时 (「每周三」配「周末」) 枚举会走到天荒地老 —— 给个上限, 到顶返回
// 最后一个候选。回显里那个"下次"不准好过让详情页卡死。
const MAX_PROBE = 512;

function* candidates(c: Clock, since: number, now: Date): Generator<number> {
  const t = now.getTime();
  if (c.kind === "once") { yield c.at; return; }
  if (c.kind === "every") {
    const step = c.minutes * 60_000;
    let next = Math.max(since + step, t);
    for (let i = 0; i < MAX_PROBE; i++) { yield next; next += step; }
    return;
  }
  for (let d = 0; d < MAX_PROBE / 8; d++) {
    const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() + d);
    for (const inst of dailyInstantsToday(c.times, day).sort((a, b) => a - b)) if (inst > t) yield inst;
  }
}

/** 下一次该在什么时候响 —— 时钟给候选, 筛子挑第一个过的。`since` 同 isDue。 */
export const nextFire = (tr: Trigger, since: number, now: Date = new Date()): number => {
  let last = now.getTime();
  for (const c of candidates(tr.clock, since, now)) {
    last = c;
    if (tr.guards.every((g) => holds(g, new Date(c)))) return c;
  }
  return last;
};

// ── 回显 ────────────────────────────────────────────────────────────
const guardLabel = (g: Guard): string => {
  switch (g.kind) {
    case "between": return `${hhmm(g.from)}-${hhmm(g.to)}`;
    case "onDays": return daysLabel(g.days);
    case "not": return `非(${guardLabel(g.of)})`;
  }
};

const clockLabel = (c: Clock): string => {
  switch (c.kind) {
    case "every": return `每 ${durationLabel(c.minutes)}`;
    case "daily": return c.times.map(hhmm).join("、");
    case "once": {
      const d = new Date(c.at);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${hhmm({ hour: d.getHours(), minute: d.getMinutes() })}(仅一次)`;
    }
  }
};

/** 人能一眼确认的回显 —— 存下去之前必须把它回给用户。 */
export const describeTrigger = (tr: Trigger): string =>
  [clockLabel(tr.clock), ...tr.guards.map(guardLabel)].join(" · ");
