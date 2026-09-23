// 「什么时候」的**词法层**: 把一句人话拆成零件 —— 星期、时刻、间隔、时间窗口。
// 纯函数, 且刻意不持有任何判定逻辑: 零件拼成规约 (Trigger)、到点判定与下次触发
// 全在 shared/trigger.ts。分这一刀是因为两边的变化方向不同 —— 这里跟着"人怎么
// 说"长, 那里跟着"怎么算"长。
//
// 刻意不做 cron 表达式: 人在群里说的是「白天每隔一个小时」, 让 wizard 把这句原样
// 递进来, 比让它翻译成 `0 8-20/1 * * *` 更不容易错 —— 翻译错了没人看得出来。

export interface HM {
  hour: number;
  minute: number;
}

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
/** 量词。「每隔一**个**小时」「每**个**小时」—— 漏掉它整句就解析不出来。 */
const CLASSIFIER = "(?:个|個)?";

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

/** 星期的人话写法, 供 Trigger 的 onDays 直接收人话。`[]` = 每天。 */
export const daysOf = (spec: string | readonly number[]): number[] =>
  Array.isArray(spec) ? uniqSorted([...spec] as number[]) : (parseDays(String(spec)) ?? []);

// ── 时刻 ────────────────────────────────────────────────────────────
// 时段词只在 12 小时制下有意义: 「晚上 21:30」里的 21 已经说清楚了, 再 +12 就废了。
const MERIDIEM = /下午|傍晚|晚上|夜里|夜間|今晚|每晚|晚|中午|正午|凌晨|半夜|早上|早晨|清晨|上午|每早|明早|noon|midnight|(?<![a-z])[ap]m\b/i;

const shiftMeridiem = (h: number, t: string): number => {
  if (h > 12) return h;
  if (/下午|傍晚|晚上|夜里|夜間|今晚|每晚|晚|(?<![a-z])pm\b/i.test(t)) return h === 12 ? 12 : h + 12;
  if (/中午|正午|noon/.test(t)) return h === 12 ? 12 : h + 12;
  if (/凌晨|半夜|midnight/.test(t)) return h === 12 ? 0 : h;
  if (/早上|早晨|清晨|上午|每早|明早|(?<![a-z])am\b/i.test(t)) return h === 12 ? 0 : h;
  return h;
};

const QUARTER: Readonly<Record<string, number>> = { 半: 30, 一刻: 15, 三刻: 45 };

/**
 * 「晚上九点半」「21:30」「9:30pm」→ {hour, minute}。没提时刻返回 undefined。
 * `ctx` 是这句话的其余部分: 「晚上8点到10点」里的「10点」自己不带时段词, 得回
 * 整句去借 —— 否则后半段会掉到上午。段内自带时段词时以段内为准。
 */
export const parseTimeOfDay = (t: string, ctx: string = t): HM | undefined => {
  const mer = MERIDIEM.test(t) ? t : ctx;
  const digital = t.match(/(\d{1,2})\s*[:：]\s*(\d{1,2})/);
  if (digital) {
    const h = shiftMeridiem(Number(digital[1]), mer);
    return { hour: h % 24, minute: Number(digital[2]) % 60 };
  }
  const spoken = t.match(new RegExp(`(${NUM}{1,3})\\s*(?:点|時|时|时钟|o'?clock)\\s*(半|一刻|三刻)?\\s*(?:(${NUM}{1,3})\\s*分)?`));
  if (spoken) {
    const h0 = cnToNum(spoken[1]!);
    if (h0 === undefined || h0 > 24) return undefined;
    const m = spoken[2] ? QUARTER[spoken[2]]! : spoken[3] ? (cnToNum(spoken[3]) ?? 0) : 0;
    return { hour: shiftMeridiem(h0, mer) % 24, minute: m % 60 };
  }
  const bare = t.match(/(\d{1,2})\s*(am|pm)\b/i);
  if (bare) return { hour: shiftMeridiem(Number(bare[1]), bare[2]!) % 24, minute: 0 };
  return undefined;
};

// ── 间隔 ────────────────────────────────────────────────────────────
const UNIT_MIN: Readonly<Record<string, number>> = {
  分: 1, 分钟: 1, 分鐘: 1, min: 1, mins: 1, minute: 1, minutes: 1, m: 1,
  小时: 60, 小時: 60, 钟头: 60, 鐘頭: 60, 时: 60, hour: 60, hours: 60, hr: 60, hrs: 60, h: 60,
  天: 1440, 日: 1440, day: 1440, days: 1440, d: 1440,
};

const CN_UNIT = "分钟|分鐘|分|小时|小時|钟头|鐘頭|天|日";
/** 省掉数字时只认「小时」类: 「每天」是日程不是间隔, 咬住它会把每天 9 点变成每 24 小时。 */
const CN_HOUR_UNIT = "小时|小時|钟头|鐘頭";

/** 「两小时」「30 分钟」「1h」「90m」→ 分钟数。纯时长, 不含「每」。 */
export const parseDuration = (raw: string | number): number | undefined => {
  if (typeof raw === "number") return raw > 0 ? raw : undefined;
  const t = raw.trim();
  const half = t.match(new RegExp(`^半\\s*${CLASSIFIER}\\s*(${CN_UNIT})$`));
  if (half) return (UNIT_MIN[half[1]!] ?? 60) / 2;
  const cn = t.match(new RegExp(`^(${NUM}{1,4})\\s*${CLASSIFIER}\\s*(${CN_UNIT})$`));
  if (cn) {
    const n = cnToNum(cn[1]!);
    return n && n > 0 ? n * (UNIT_MIN[cn[2]!] ?? 1) : undefined;
  }
  const en = t.match(/^(\d{1,5})?\s*(minutes?|mins?|hours?|hrs?|days?|[mhd])$/i);
  if (en) {
    const n = en[1] ? Number(en[1]) : 1;
    return n > 0 ? n * (UNIT_MIN[en[2]!.toLowerCase()] ?? 1) : undefined;
  }
  return undefined;
};

/** 「每隔两个小时」「每 30 分钟」「每半小时」「每小时」「every 15m」→ 分钟数。 */
export const parseInterval = (t: string): number | undefined => {
  const half = t.match(new RegExp(`每\\s*隔?\\s*半\\s*${CLASSIFIER}\\s*(${CN_UNIT}|hour)`));
  if (half) return (UNIT_MIN[half[1]!] ?? 60) / 2;
  const cn = t.match(new RegExp(`每\\s*隔?\\s*(${NUM}{1,3})\\s*${CLASSIFIER}\\s*(${CN_UNIT})`));
  if (cn) {
    const n = cnToNum(cn[1]!);
    return n && n > 0 ? n * (UNIT_MIN[cn[2]!] ?? 1) : undefined;
  }
  const bare = t.match(new RegExp(`每\\s*隔?\\s*${CLASSIFIER}\\s*(${CN_HOUR_UNIT})`));
  if (bare) return UNIT_MIN[bare[1]!] ?? 60;
  const en = t.match(/every\s*(\d{1,4})?\s*(minutes?|mins?|hours?|hrs?|days?|[mhd])\b/i);
  if (en) {
    const n = en[1] ? Number(en[1]) : 1;
    return n > 0 ? n * (UNIT_MIN[en[2]!.toLowerCase()] ?? 1) : undefined;
  }
  return undefined;
};

// ── 时间窗口 ────────────────────────────────────────────────────────
// 「白天每小时」里的「白天」不是触发时刻, 是**筛子** —— 它自己产生不了任何一枪,
// 只否决落在窗外的那些。所以它在这里是独立零件, 在 Trigger 里是 guard。
// `soft` = 这个词同时也是时段词:「晚上9:30」里的「晚上」说的是 21 点这一刻, 不是
// 一段窗口。软窗口只在整句没给出具体时刻时才作数 (见 parseTrigger)。
const NAMED_WINDOW: ReadonlyArray<{ re: RegExp; from: string; to: string; soft: boolean }> = [
  { re: /白天|日间|日間|daytime/i, from: "08:00", to: "20:00", soft: false },
  { re: /工作时间|上班时间|工作時間|上班時間|office\s*hours|business\s*hours/i, from: "09:00", to: "18:00", soft: false },
  { re: /夜里|夜间|夜間|晚上|深夜|overnight|at\s*night/i, from: "20:00", to: "08:00", soft: true },
];

const SEG = "[^,，。;；\\s]{1,12}";
/** 显式区间的连接部分 —— parseTrigger 要把它从句子里剔掉再找日程时刻。 */
export const RANGE_RE = new RegExp(`(${SEG})\\s*(?:到|至|~|～|-|–|—|until|to)\\s*(${SEG})`, "i");

export interface Window { from: HM; to: HM; soft: boolean; explicit: boolean }

/** 「白天」「8点到20点」「09:00-18:00」→ 一天里的一段。没提返回 undefined。 */
export const parseWindow = (t: string): Window | undefined => {
  const range = t.match(RANGE_RE);
  if (range) {
    const from = parseTimeOfDay(range[1]!, t);
    const to = parseTimeOfDay(range[2]!, t);
    if (from && to) return { from, to, soft: false, explicit: true };
  }
  const named = NAMED_WINDOW.find((w) => w.re.test(t));
  return named
    ? { from: parseTimeOfDay(named.from)!, to: parseTimeOfDay(named.to)!, soft: named.soft, explicit: false }
    : undefined;
};

// ── 一次性 ──────────────────────────────────────────────────────────
const atOn = (now: Date, addDays: number, hour: number, minute: number): number =>
  new Date(now.getFullYear(), now.getMonth(), now.getDate() + addDays, hour, minute, 0, 0).getTime();

/** 「20 分钟后」「明早 9 点」「今晚」→ 绝对时刻 (epoch ms)。不是一次性的返回 undefined。 */
export const parseOnceAt = (t: string, now: Date): number | undefined => {
  const rel = t.match(new RegExp(`(半|${NUM}{1,4})\\s*${CLASSIFIER}\\s*(${CN_UNIT})\\s*(?:之)?后`))
    ?? t.match(/\bin\s*(\d{1,4})\s*(minutes?|mins?|hours?|hrs?|days?|[mhd])\b/i);
  if (rel) {
    const unit = UNIT_MIN[rel[2]!.toLowerCase()] ?? 1;
    const n = rel[1] === "半" ? 0.5 : (cnToNum(rel[1]!) ?? Number(rel[1]));
    if (n > 0) return now.getTime() + Math.round(n * unit) * 60_000;
  }
  const dayWord = t.match(/(今天|今晚|今夜|明天|明早|明晚|后天|後天|tomorrow|tonight)/i);
  if (!dayWord) return undefined;
  const addDays = /后天|後天/.test(dayWord[1]!) ? 2 : /今天|今晚|今夜|tonight/i.test(dayWord[1]!) ? 0 : 1;
  const tod = parseTimeOfDay(t) ?? (/晚|tonight/i.test(dayWord[1]!) ? { hour: 21, minute: 0 } : undefined);
  return tod ? atOn(now, addDays, tod.hour, tod.minute) : undefined;
};

// ── 回显零件 ────────────────────────────────────────────────────────
export const hhmm = (t: HM): string => `${String(t.hour).padStart(2, "0")}:${String(t.minute).padStart(2, "0")}`;

const CN_DAY_NAME = ["日", "一", "二", "三", "四", "五", "六"];

export const daysLabel = (days: readonly number[]): string => {
  if (!days.length) return "每天";
  const k = [...days].join(",");
  if (k === "1,2,3,4,5") return "每个工作日";
  if (k === "0,6") return "每逢周末";
  return `每周${days.map((d) => CN_DAY_NAME[d]!).join("、")}`;
};

export const durationLabel = (n: number): string => {
  if (n % 1440 === 0) return `${n / 1440} 天`;
  if (n % 60 === 0) return `${n / 60} 小时`;
  return n > 60 ? `${Math.floor(n / 60)} 小时 ${n % 60} 分` : `${n} 分钟`;
};
