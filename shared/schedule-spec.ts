// 定时规格 —— 把一句人话里的「什么时候」解析成三种形状之一, 外加到点判定与
// 下次触发时刻。整模块是纯函数: 时钟由调用方传进来 (now), 这里只做匹配与算术。
//
// 三种形状覆盖了「比 /loop 更长」的全部实际需求:
//   daily  某几天的 HH:MM (days 为空 = 每天) —— 「每个工作日晚上 9:30」
//   every  每隔 N 分钟                       —— 「每两小时」
//   once   一个绝对时刻                      —— 「明早 9 点」「20 分钟后」, 触发后自删
//
// 刻意不做 cron 表达式: 人在群里说的是「每个工作日晚上九点半」, 让 wizard 把这句
// 原样递进来比让它翻译成 `30 21 * * 1-5` 更不容易错 —— 翻译错了没人看得出来。

export type When =
  | { kind: "daily"; days: number[]; hour: number; minute: number } // days: 0=周日
  | { kind: "every"; minutes: number }
  | { kind: "once"; at: number };

// 守护进程重启/维护会吃掉整分钟的 tick。错过的那一下在 5 分钟内补跑, 超出就放弃 ——
// 早上 9 点的任务在中午补跑比不跑更糟。
const CATCHUP_MS = 5 * 60_000;

// ── 汉字数字 ────────────────────────────────────────────────────────
const CN_DIGIT: Readonly<Record<string, number>> = {
  零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5,
  六: 6, 七: 7, 八: 8, 九: 9, 十: 10,
};

/** 「二十一」→ 21, 「十」→ 10, 「9」→ 9。认不出返回 undefined。 */
export const cnToNum = (raw: string): number | undefined => {
  const s = raw.trim();
  if (!s) return undefined;
  if (/^\d+$/.test(s)) return Number(s);
  if ([...s].some((c) => !(c in CN_DIGIT))) return undefined;
  const i = s.indexOf("十");
  if (i < 0) return [...s].reduce((n, c) => n * 10 + CN_DIGIT[c]!, 0);
  const tens = i === 0 ? 1 : CN_DIGIT[s[i - 1]!]!;
  const ones = i === s.length - 1 ? 0 : CN_DIGIT[s[s.length - 1]!]!;
  return tens * 10 + ones;
};

const NUM = "[0-9零〇一二三四五六七八九十两]";

// ── 星期 ────────────────────────────────────────────────────────────
const CN_WEEKDAY: Readonly<Record<string, number>> = {
  日: 0, 天: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6,
};
const EN_WEEKDAY: Readonly<Record<string, number>> = {
  sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
};

const uniqSorted = (xs: number[]): number[] => [...new Set(xs)].sort((a, b) => a - b);

/** 文本里说的是哪几天。`[]` = 每天; undefined = 没提。 */
export const parseDays = (t: string): number[] | undefined => {
  if (/工作日|上班日|周一到周五|周一至周五|週一到週五|weekdays?|workdays?/i.test(t)) return [1, 2, 3, 4, 5];
  if (/周末|週末|双休|週休|weekends?/i.test(t)) return [0, 6];
  const cn = [...t.matchAll(/(?:每)?(?:周|週|星期|礼拜|禮拜)\s*([日一二三四五六天]+)/g)]
    .flatMap((m) => [...m[1]!].map((c) => CN_WEEKDAY[c]!));
  if (cn.length) return uniqSorted(cn);
  const en = [...t.matchAll(/\b(sun|mon|tue|wed|thu|fri|sat)[a-z]*\b/gi)].map((m) => EN_WEEKDAY[m[1]!.toLowerCase()]!);
  if (en.length) return uniqSorted(en);
  if (/每天|每日|天天|每晚|每早|每个早上|daily|every\s*day/i.test(t)) return [];
  return undefined;
};

// ── 时刻 ────────────────────────────────────────────────────────────
// 时段词只在 12 小时制下有意义: 「晚上 21:30」里的 21 已经说清楚了, 再 +12 就废了。
const shiftMeridiem = (h: number, t: string): number => {
  if (h > 12) return h;
  if (/下午|傍晚|晚上|夜里|夜間|今晚|每晚|晚|(?<![a-z])pm\b/i.test(t)) return h === 12 ? 12 : h + 12;
  if (/中午|正午|noon/.test(t)) return h === 12 ? 12 : h + 12;
  if (/凌晨|半夜|midnight/.test(t)) return h === 12 ? 0 : h;
  if (/早上|早晨|清晨|上午|每早|明早|(?<![a-z])am\b/i.test(t)) return h === 12 ? 0 : h;
  return h;
};

const QUARTER: Readonly<Record<string, number>> = { 半: 30, 一刻: 15, 三刻: 45 };

/** 「晚上九点半」「21:30」「9:30pm」→ {hour, minute}。没提时刻返回 undefined。 */
export const parseTimeOfDay = (t: string): { hour: number; minute: number } | undefined => {
  const digital = t.match(/(\d{1,2})\s*[:：]\s*(\d{1,2})/);
  if (digital) {
    const h = shiftMeridiem(Number(digital[1]), t);
    return { hour: h % 24, minute: Number(digital[2]) % 60 };
  }
  const spoken = t.match(new RegExp(`(${NUM}{1,3})\\s*(?:点|時|时|时钟|o'?clock)\\s*(半|一刻|三刻)?\\s*(?:(${NUM}{1,3})\\s*分)?`));
  if (spoken) {
    const h0 = cnToNum(spoken[1]!);
    if (h0 === undefined || h0 > 24) return undefined;
    const m = spoken[2] ? QUARTER[spoken[2]]! : spoken[3] ? (cnToNum(spoken[3]) ?? 0) : 0;
    return { hour: shiftMeridiem(h0, t) % 24, minute: m % 60 };
  }
  const bare = t.match(/(\d{1,2})\s*(am|pm)\b/i);
  if (bare) return { hour: shiftMeridiem(Number(bare[1]), bare[2]!) % 24, minute: 0 };
  return undefined;
};

// ── 间隔 ────────────────────────────────────────────────────────────
const UNIT_MIN: Readonly<Record<string, number>> = {
  分: 1, 分钟: 1, 分鐘: 1, min: 1, mins: 1, minute: 1, minutes: 1, m: 1,
  小时: 60, 小時: 60, 钟头: 60, 鐘頭: 60, 时: 60, hour: 60, hours: 60, hr: 60, h: 60,
  天: 1440, 日: 1440, day: 1440, days: 1440, d: 1440,
};

/** 「每隔两小时」「每 30 分钟」「每半小时」「every 15m」→ 分钟数。 */
export const parseInterval = (t: string): number | undefined => {
  const half = t.match(/每\s*隔?\s*半\s*(小时|小時|钟头|鐘頭|天|日|hour)/);
  if (half) return (UNIT_MIN[half[1]!] ?? 60) / 2;
  const cn = t.match(new RegExp(`每\\s*隔?\\s*(${NUM}{1,3})\\s*(分钟|分鐘|分|小时|小時|钟头|鐘頭|天|日)`));
  if (cn) {
    const n = cnToNum(cn[1]!);
    return n && n > 0 ? n * (UNIT_MIN[cn[2]!] ?? 1) : undefined;
  }
  const en = t.match(/every\s*(\d{1,4})?\s*(minutes?|mins?|hours?|hrs?|days?|[mhd])\b/i);
  if (en) {
    const n = en[1] ? Number(en[1]) : 1;
    return n > 0 ? n * (UNIT_MIN[en[2]!.toLowerCase()] ?? 1) : undefined;
  }
  return undefined;
};

// ── 一次性 ──────────────────────────────────────────────────────────
const atOn = (now: Date, addDays: number, hour: number, minute: number): number =>
  new Date(now.getFullYear(), now.getMonth(), now.getDate() + addDays, hour, minute, 0, 0).getTime();

const parseOnce = (t: string, now: Date): When | undefined => {
  const rel = t.match(new RegExp(`(半|${NUM}{1,4})\\s*(分钟|分鐘|分|小时|小時|钟头|鐘頭|天)\\s*(?:之)?后`))
    ?? t.match(/\bin\s*(\d{1,4})\s*(minutes?|mins?|hours?|hrs?|days?|[mhd])\b/i);
  if (rel) {
    const unit = UNIT_MIN[rel[2]!.toLowerCase()] ?? 1;
    const n = rel[1] === "半" ? 0.5 : (cnToNum(rel[1]!) ?? Number(rel[1]));
    if (n > 0) return { kind: "once", at: now.getTime() + Math.round(n * unit) * 60_000 };
  }
  const dayWord = t.match(/(今天|今晚|今夜|明天|明早|明晚|后天|後天|tomorrow|tonight)/i);
  if (!dayWord) return undefined;
  const addDays = /后天|後天/.test(dayWord[1]!) ? 2 : /今天|今晚|今夜|tonight/i.test(dayWord[1]!) ? 0 : 1;
  const tod = parseTimeOfDay(t) ?? (/晚|tonight/i.test(dayWord[1]!) ? { hour: 21, minute: 0 } : undefined);
  if (!tod) return undefined;
  return { kind: "once", at: atOn(now, addDays, tod.hour, tod.minute) };
};

// ── 入口 ────────────────────────────────────────────────────────────
/**
 * 整句话进, 规格出。认不出返回 undefined —— 调用方要把原句回给用户让他重说,
 * 绝不能猜一个时间安静地存下去。
 *
 * 顺序有意为之: 一次性(带「今天/明天/N 分钟后」的措辞) 最具体, 其次是间隔,
 * 最后才是周期日程 —— 「每天」这种词在前两者里都不会出现。
 */
export const parseWhen = (text: string, now: Date = new Date()): When | undefined => {
  const t = text.trim();
  if (!t) return undefined;
  const once = parseOnce(t, now);
  if (once) return once;
  const tod = parseTimeOfDay(t);
  // 「每 2 天早上 9 点」这种既给间隔又给时刻的说法, 按日程理解更接近本意;
  // 纯间隔 (不带时刻) 才走 every。
  const iv = parseInterval(t);
  if (iv !== undefined && !tod) return { kind: "every", minutes: Math.max(1, Math.round(iv)) };
  const days = parseDays(t);
  if (tod) return { kind: "daily", days: days ?? [], hour: tod.hour, minute: tod.minute };
  if (days) return { kind: "daily", days, hour: 9, minute: 0 }; // 只说了「每个工作日」: 默认早上 9 点
  if (iv !== undefined) return { kind: "every", minutes: Math.max(1, Math.round(iv)) };
  return undefined;
};

// ── 判定 ────────────────────────────────────────────────────────────
const instantToday = (w: Extract<When, { kind: "daily" }>, now: Date): number | undefined => {
  if (w.days.length && !w.days.includes(now.getDay())) return undefined;
  const d = new Date(now);
  d.setHours(w.hour, w.minute, 0, 0);
  return d.getTime();
};

/**
 * 到点了吗。`since` = 上次触发时刻, 从没触发过就传创建时刻 —— 它同时承担三件事:
 * 同一分钟内多次 tick 的去重、重启后不重复触发、以及「刚创建就到点」不立即打一枪。
 */
export const isDue = (when: When, now: Date, since: number): boolean => {
  const t = now.getTime();
  switch (when.kind) {
    case "once":
      return t >= when.at && since < when.at;
    case "every":
      return t - since >= when.minutes * 60_000;
    case "daily": {
      const inst = instantToday(when, now);
      return inst !== undefined && t >= inst && t - inst < CATCHUP_MS && since < inst;
    }
  }
};

/** 下一次该在什么时候响。`since` 同 isDue。 */
export const nextFire = (when: When, since: number, now: Date = new Date()): number => {
  if (when.kind === "once") return when.at;
  if (when.kind === "every") return Math.max(since + when.minutes * 60_000, now.getTime());
  for (let i = 0; i < 8; i++) {
    const c = new Date(now.getFullYear(), now.getMonth(), now.getDate() + i, when.hour, when.minute, 0, 0);
    if (c.getTime() > now.getTime() && (!when.days.length || when.days.includes(c.getDay()))) return c.getTime();
  }
  return now.getTime();
};

// ── 回显 ────────────────────────────────────────────────────────────
const hhmm = (h: number, m: number): string => `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
const CN_DAY_NAME = ["日", "一", "二", "三", "四", "五", "六"];

const daysLabel = (days: number[]): string => {
  if (!days.length) return "每天";
  const k = days.join(",");
  if (k === "1,2,3,4,5") return "每个工作日";
  if (k === "0,6") return "每逢周末";
  return `每周${days.map((d) => CN_DAY_NAME[d]!).join("、")}`;
};

/** 人能一眼确认的回显 —— 存下去之前必须把它回给用户。 */
export const describeWhen = (when: When): string => {
  switch (when.kind) {
    case "daily":
      return `${daysLabel(when.days)} ${hhmm(when.hour, when.minute)}`;
    case "every": {
      const { minutes: n } = when;
      if (n % 1440 === 0) return `每 ${n / 1440} 天`;
      if (n % 60 === 0) return `每 ${n / 60} 小时`;
      return n > 60 ? `每 ${Math.floor(n / 60)} 小时 ${n % 60} 分` : `每 ${n} 分钟`;
    }
    case "once": {
      const d = new Date(when.at);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${hhmm(d.getHours(), d.getMinutes())}(仅一次)`;
    }
  }
};
