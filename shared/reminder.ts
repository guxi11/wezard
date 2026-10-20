// `<system-reminder>`: 注入时挂在一句话尾巴上的机器信息 —— 信封 (谁、在哪说的) /
// 点名提示 / 名册增量 / 挂起事项。两个读者各取一半:
//   模型读正文 —— 规矩是写给它的, 措辞随时会改;
//   读回来的一方 (parseEnvelope / 提交见证 / rolepage / regress) 读开标签上的属性 ——
//   事实只写一次、按名取, 改措辞不再牵连解析。
// 属性出现之前落盘的 transcript / 轮次记录里只有正文, 那些靠 LEGACY 表按措辞认。
//
// 形状 (一句话): 一个信封块打头 (属性只放机器读回的与模型要抄的 id; 注入事件 id 作为 `msg`
// 并在信封上), 后面按 TAIL_ORDER 平铺只给模型看的旁注块 —— 全是 `<system-reminder wezard=…>`,
// 由 REMINDER_KINDS 约束、renderTail 拼出。不嵌套、不另起 tag 名、属性不塞 JSON、不打版本号: 有没有 `msg`
// 本身就分得出新旧。
//
// reminder **不是路由的真相来源**: 去向 / 放行闸 / 追述 / GC 只读 router 的 journal; 这里是
// 给模型的快照, 与 mirror / chat-log 认出处的回读。会过期的派生量 (行状态、是否追述) 不写成属性。
//
// 退役不再写、只为老 transcript 照认的: message-event 块 (event = 注入事件 id, 现为信封 `msg`;
// 没有信封的注入仍挂它兜底), receipt-delivery (与 message-event 同值重复), 派活信封的
// event / quiet / act / deadline, 回执的 serves / via / late, 名册 / 挂起事项的 mode,
// mention 的 names, hint 的 role。

import type { Asker } from "./detail-store.js";

export type Attrs = Readonly<Record<string, string>>;
export interface Reminder {
  attrs: Attrs;
  body: string;
  raw: string;
}

/** 一个属性的读者: `M` = 机器读回 (写了就有代码读它); `C` = 模型要原样抄进工具参数的 id
 *  (`re` / `for` / `drop`), 机器也读。两者都不是的 —— 只给模型看的语义 —— 写正文, 不进属性。 */
type Use = "M" | "C";

/** 种类注册表: 每种块允许写哪些属性 (`wezard` 自己不列)。渲染只认这里登记过的; 新增一个属性
 *  = 在这里加一行并说清谁读它。读者在行尾。 */
export const REMINDER_KINDS = {
  envelope: {
    kind: "M", from: "M", scope: "M", chat: "M",      // 出处: parseEnvelope → read_chat / rolepage / mirror
    "chat-key": "M",                                  // 人话: 改名不变的群 key (mirror 恢复频道)
    "asker-user": "M", "asker-chat": "M",              // 链头那句人话 (askerOf: 卡片落哪个群)
    msg: "M",                                         // 注入事件 id: 提交见证 / 轮次↔事件绑定 / serves 反查
    event: "C",                                       // 路由行 id (仅回执 / 定时): `tell_peer({re})` 抄它
    receipt: "M", status: "M", audience: "M",          // 回执: mirror / chat-log / regress
    job: "M", done: "M", total: "M", complete: "M",    // 工单进度: regress (齐没齐由守护进程数)
  },
  /** 退役中: 只在没有信封的注入上兜底 (见 withMsg)。 */
  "message-event": { event: "M" },
  hint: {},
  lead: {},
  after: {},
  mention: {},
  roster: {},
  pending: {},
} as const satisfies Record<string, Record<string, Use>>;
export type Kind = keyof typeof REMINDER_KINDS;
type AttrOf<K extends Kind> = keyof (typeof REMINDER_KINDS)[K] & string;
/** 某一种块的开标签属性。 */
export type KindAttrs<K extends Kind> = { readonly wezard: K } & { readonly [A in AttrOf<K>]?: string };
export type NoteAttrs = { [K in Kind]: KindAttrs<K> }[Kind];

/** 尾巴上的固定顺序: 信封打头 (parseEnvelope 取最后一个信封, 而尾巴只有一个), 旁注按
 *  「这一轮怎么接 → 附件 → 环境」排。表外的 (codebuddy 自己的块、老种类) 排最后, 相对顺序不变。 */
export const TAIL_ORDER: readonly string[] = ["envelope", "message-event", "hint", "lead", "after", "mention", "roster", "pending"];

// 开标签容许属性: 我们自己的, 以及 codebuddy 的 `data-role="command-caveat"`。
// 开标签锚定行首 (渲染方永远 `\n` 起头, 见 renderReminder): 正文里行中提及的
// `<system-reminder>` 字面量 (讨论这个 tag 本身时很常见) 一旦当成开标签, 懒惰匹配会
// 从那里一路吞掉后面真正的信封块 —— 整句的信封 / 注入事件 id 全丢, 轮次再也绑不回
// 路由行 (2026-10-15 .remindtrim e3c34b4.1: 派活正文里写了 `<system-reminder>` 四个字,
// 那轮 RESULT: 终句永远没认领, sweeper 误判闲置追问)。
export const REMINDER_RE = /^<system-reminder(\s[^>]*)?>([\s\S]*?)<\/system-reminder>/gm;

const ENT: ReadonlyArray<[string, string]> = [["&", "&amp;"], ['"', "&quot;"], ["<", "&lt;"], [">", "&gt;"]];
const escAttr = (s: string): string => ENT.reduce((a, [c, e]) => a.split(c).join(e), s);
const unescAttr = (s: string): string => [...ENT].reverse().reduce((a, [c, e]) => a.split(e).join(c), s);

const attrsOf = (s = ""): Attrs =>
  Object.fromEntries([...s.matchAll(/([\w-]+)="([^"]*)"/g)].map((m) => [m[1]!, unescAttr(m[2]!)]));

/** 没在 REMINDER_KINDS 登记的属性 (含未登记的种类)。渲染时直接丢掉 —— 类型挡住了字面量, 这里挡住展开进来的。 */
export const unregisteredAttrs = (attrs: Attrs): string[] => {
  const known = (REMINDER_KINDS as Record<string, Record<string, Use>>)[attrs.wezard ?? ""];
  return Object.keys(attrs).filter((k) => k !== "wezard" && !(known && k in known));
};

const openTag = (attrs: Attrs): string => {
  const bad = new Set(unregisteredAttrs(attrs));
  return `<system-reminder${Object.entries(attrs).filter(([k, v]) => !bad.has(k) && v !== undefined).map(([k, v]) => ` ${k}="${escAttr(v)}"`).join("")}>`;
};

/** 以换行起头 —— 直接接在正文后面。 */
export const renderReminder = (attrs: NoteAttrs, lines: readonly string[]): string =>
  ["", openTag(attrs), ...lines, "</system-reminder>"].join("\n");

export const parseReminders = (text: string): Reminder[] =>
  [...text.matchAll(REMINDER_RE)].map((m) => ({ attrs: attrsOf(m[1]), body: (m[2] ?? "").trim(), raw: m[0] }));

export const stripReminders = (text: string): string => text.replace(REMINDER_RE, "").trim();

const rankOf = (attrs: Attrs): number => {
  const i = TAIL_ORDER.indexOf(attrs.wezard ?? "");
  return i < 0 ? TAIL_ORDER.length : i;
};

/** 一次注入的尾巴: 把各处拼好的块 (信封、旁注、通知) 按 TAIL_ORDER 稳定排序后接起来。
 *  只收 reminder 块 —— 段里块以外的字会被丢掉, 所以只喂渲染出来的尾巴, 别喂正文。 */
export const renderTail = (...parts: readonly string[]): string =>
  parts.flatMap((p) => [...p.matchAll(REMINDER_RE)].map((m) => ({ raw: m[0], rank: rankOf(attrsOf(m[1])) })))
    .map((b, i) => ({ ...b, i }))
    .sort((a, b) => a.rank - b.rank || a.i - b.i)
    .map((b) => `\n${b.raw}`)
    .join("");

/** 投递那一刻把注入事件 id 写进这句话的信封 (`msg`): 取**最后一个**信封 (正文里引用的老信封在它前面)。
 *  没有信封的注入 (slash 之外的少数) 兜底挂一块老形状的 message-event —— 提交见证照样认得。 */
export const withMsg = (text: string, msg: string): string => {
  const hit = [...text.matchAll(REMINDER_RE)].filter((m) => attrsOf(m[1]).wezard === "envelope").at(-1);
  if (!hit || hit.index === undefined) return text + renderReminder({ wezard: "message-event", event: msg }, []);
  const old = `<system-reminder${hit[1] ?? ""}>`;
  return text.slice(0, hit.index) + openTag({ ...attrsOf(hit[1]), msg }) + text.slice(hit.index + old.length);
};

/** 这句话是不是带着注入事件 `id` 进来的 (提交见证用): 任一信封的 `msg`, 或老形状的块。 */
export const carriesMsg = (text: string, id: string): boolean =>
  !!id && parseReminders(text).some((r) =>
    (r.attrs.wezard === "envelope" && r.attrs.msg === id) || (r.attrs.wezard === "message-event" && r.attrs.event === id));

// ── 信封 ──────────────────────────────────────────────────────────────
export interface Envelope {
  /** 这句话的注入事件 id (message-events 的主键): 信封的 `msg`, 老形状读信封外的 message-event 块。 */
  eventId?: string;
  kind: "peer" | "human" | "task";
  /** 发话方的称呼: wizard 是 `.name`, 人是 userid, 定时任务是 `定时 <id>`。 */
  from: string;
  /** wizard 之间的私聊。 */
  private: boolean;
  /** 公开轮所在群的名字; "" = 这个会话的 home 聊天。 */
  chat: string;
  /** Stable inbound principal; chat is a display name and may be renamed. */
  chatKey?: string;
  /** Original human request, preserved across private dispatch and receipts. */
  asker?: Asker;
  /** 这一轮是回执 (对方干完了, 守护进程把结论送回发话方), 不是新派的活。 */
  receipt?: boolean;
  /** 回执的定论 (见 ReceiptStatus); 老信封没有 = done。 */
  status?: ReceiptStatus;
  /** 回执 = 刚落定的那一笔; 定时任务 = 为它开的群根行。派活 / 续问轮不带 (老信封带的照读) ——
   *  那一轮服务哪一笔按 `eventId` 问注入事件。 */
  event?: string;
  /** 回执: 这一轮在群里的终句答给的那个人 (userid, 见 role-view.audienceOf); 认不出 = 没有。 */
  audience?: string;
}

/** Human identity comes from inbound metadata; a private hop keeps that origin. */
export const askerFromEnvelope = (env: Envelope, chatOf: (chat: string) => string): Asker | undefined => {
  if (env.asker) return env.asker;
  if (env.kind !== "human" || !env.from) return undefined;
  const chat = env.chatKey || chatOf(env.chat);
  return chat ? { who: `user:${env.from}`, chat } : undefined;
};

/** 回执那一轮的去向, 已渲染成给人 / 模型看的称呼 (§9.5: 去向由路由行的 receiver 边决定)。
 *  `up` = 这一轮的终句会落到另一笔同伴的欠账上 (结论回给上游 wizard); 缺省 = 只进 rolepage
 *  或落回那个群 (看 chat)。只用于信封正文措辞, 不写成属性。 */
export interface ReceiptRoute {
  up?: boolean; audience?: string; asker?: Asker; via?: string; pending?: number;
  /** 收方这一轮服务的那一笔已收口 (孤儿, §4.3)。 */
  late?: boolean;
  /** 迟到时, 收方带 `RESULT:` 的终句作为那一笔的追述沿原路投给谁 (上游 wizard / 群的称呼); 缺省 = 无处可冒。 */
  retellTo?: string;
  /** 这份回执本身是追述 (对方之前已交过一份)。 */
  retold?: boolean;
}

/** 这句话怎么接 —— 只影响派活信封的正文措辞 (挂在哪一笔上由注入事件的 `serves` 定, 不进信封)。
 *  `act`: 缺省是一件活; ask = 只答一问; fyi = 知会, 不用回。
 *  `re`: 续问 (接着那一笔说)。
 *  `quiet`: 发话方不收回执 (fyi 一定是; task 带 receipt:false 也是)。 */
export interface TurnTag { re?: boolean; legs?: number; deadline?: number; act?: "ask" | "fyi"; quiet?: boolean; asker?: Asker }

const askerAttrs = (asker?: Asker): Attrs => asker
  ? { "asker-user": asker.who, "asker-chat": asker.chat } : {};

/** 回执落成什么。done = 答了; need = 它收口成 `NEED:` 反问发话方, 不是定论; error = 那一轮以 CLI 报错 (API Error) 收尾, 不是定论;
 *  timeout / silent / dead = 没等到答案 (超时 / 停下几次都没答 / pane 没了); canceled = 被人 stop 掉了。 */
export type ReceiptStatus = "done" | "need" | "error" | "timeout" | "silent" | "dead" | "canceled";

type EnvelopeAttrs = KindAttrs<"envelope">;
export const envelopeAttrs = {
  human: (user: string, chat: string, chatKey?: string): EnvelopeAttrs => ({ wezard: "envelope", kind: "human", from: user, chat, ...(chatKey ? { "chat-key": chatKey } : {}) }),
  /** `chat` 不给 = 私聊。`chatKey` = 公开轮所在聊天的稳定 key —— 名字会被 rename 换主,
   *  read_chat / 无参视图按它归档 (chat 只做显示); 与人话信封同一个属性。 */
  peer: (from: string, chat?: string, asker?: Asker, chatKey?: string): EnvelopeAttrs => ({
    wezard: "envelope", kind: "peer", from, scope: chat === undefined ? "private" : "public", ...(chat ? { chat } : {}),
    ...(chatKey ? { "chat-key": chatKey } : {}),
    ...askerAttrs(asker),
  }),
  /** `event` = 这一枪为它开的那条群根行 (安静任务按它定位终句, 见 index.ts relayUnlessQuiet)。 */
  task: (taskId: string, event?: string): EnvelopeAttrs => ({ wezard: "envelope", kind: "task", from: taskId, ...(event ? { event } : {}) }),
  /** 回执也是「`from` 在对你说话」, 所以仍是 peer 信封 —— read_chat / rolepage 照旧
   *  把它归到那场对话里; 多一个 `receipt` 属性说明它是自动送回来的结论而不是新活。 */
  receipt: (from: string, chat?: string, job?: { job: string; done: number; total: number }, status: ReceiptStatus = "done", event?: string, route?: ReceiptRoute, chatKey?: string): EnvelopeAttrs => ({
    ...envelopeAttrs.peer(from, chat, route?.asker, chatKey),
    ...(event ? { event } : {}),
    receipt: "1",
    status,
    ...(route?.audience ? { audience: route.audience } : {}),
    // 工单的「齐了吗」由守护进程数出来写在属性上, 不让模型自己记: 异步回执是 N 个
    // 独立的轮次陆续进来的, 靠模型在上下文里数到五是最容易出错的那种事。
    ...(job && job.job
      ? { job: job.job, done: String(job.done), total: String(job.total), complete: job.done >= job.total ? "1" : "0" }
      : {}),
  }),
};

const ENVELOPE_KINDS = new Set(["peer", "human", "task"]);
const envelopeOfAttrs = (a: Attrs): Envelope | undefined =>
  a.wezard === "envelope" && ENVELOPE_KINDS.has(a.kind ?? "")
    ? {
        kind: a.kind as Envelope["kind"],
        from: a.kind === "task" ? `定时 ${a.from ?? ""}` : a.from ?? "",
        private: a.scope === "private",
        chat: a.chat ?? "",
        ...(a["chat-key"] ? { chatKey: a["chat-key"] } : {}),
        ...(a["asker-user"] && a["asker-chat"] ? { asker: { who: a["asker-user"], chat: a["asker-chat"] } } : {}),
        ...(a.receipt === "1" ? { receipt: true } : {}),
        ...(a.status ? { status: a.status as ReceiptStatus } : {}),
        ...(a.event ? { event: a.event } : {}),
        ...(a.msg ? { eventId: a.msg } : {}),
        ...(a.audience ? { audience: a.audience } : {}),
      }
    : undefined;

// 属性出现之前的措辞。只增不删: 老 transcript 永远在盘上。
const LEGACY: ReadonlyArray<[RegExp, (m: RegExpMatchArray) => Envelope]> = [
  [/这一轮是 wizard `([^`]+)` 发来的\*\*私聊\*\*/, (m) => ({ kind: "peer", from: m[1]!, private: true, chat: "" })],
  [/这一轮是 wizard `([^`]+)` 在群(?: \*\*([^*]*)\*\* )?里\*\*公开\*\*/, (m) => ({ kind: "peer", from: m[1]!, private: false, chat: m[2] ?? "" })],
  [/这一轮是 `([^`]+)` 在群 \*\*([^*]*)\*\* 里说的/, (m) => ({ kind: "human", from: m[1]!, private: false, chat: m[2] ?? "" })],
  [/这一轮是定时任务 `([^`]+)` 到点放进来的/, (m) => ({ kind: "task", from: `定时 ${m[1]!}`, private: false, chat: "" })],
];
const legacyEnvelope = (body: string): Envelope | undefined =>
  LEGACY.reduce<Envelope | undefined>((hit, [re, make]) => hit ?? ((m) => (m ? make(m) : undefined))(body.match(re)), undefined);

const envelopeOf = (r: Reminder): Envelope | undefined => envelopeOfAttrs(r.attrs) ?? legacyEnvelope(r.body);

/** Daemon appends the authoritative envelope after the message. Quoted older
 *  envelopes in the body must not override the actual inbound sender. */
export const parseEnvelope = (raw: string): Envelope | undefined => {
  const reminders = parseReminders(raw);
  const env = reminders.reduce<Envelope | undefined>((hit, r) => envelopeOf(r) ?? hit, undefined);
  if (!env || env.eventId) return env;
  // 老形状: 注入事件 id 挂在信封外的 message-event 块上 (receipt-delivery: 退役前回执多挂的一块,
  // 值与 message-event 相同) —— 老 transcript 照认。
  const eventId = reminders.filter((r) => ["message-event", "receipt-delivery"].includes(r.attrs.wezard ?? "")).at(-1)?.attrs.event;
  return { ...env, ...(eventId ? { eventId } : {}) };
};

/** rolepage 折叠态的标签: 认得出种类就写种类 (信封带上发话方, 回执带上定论), codebuddy 自己的块写
 *  它的 `data-role`, 认不出的仍叫 reminder。`machine` = 只给机器的空块 (老形状的 message-event /
 *  receipt-delivery) —— 画淡一点。老措辞的信封 (LEGACY) 也按信封标。 */
export const reminderLabel = (r: Reminder): { label: string; machine?: boolean } => {
  const w = r.attrs.wezard ?? "";
  if (w === "message-event" || w === "receipt-delivery") return { label: "msg", machine: true };
  const env = envelopeOf(r);
  if (env) return { label: env.receipt ? `回执 · ${env.from} · ${env.status ?? "done"}` : `envelope · ${env.from}` };
  return { label: w || r.attrs["data-role"] || "reminder" };
};
