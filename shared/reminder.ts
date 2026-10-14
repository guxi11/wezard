// `<system-reminder>`: 注入时挂在一句话尾巴上的机器信息 —— 信封 (谁、在哪说的) /
// 点名提示 / 名册增量。两个读者各取一半:
//   模型读正文 —— 规矩是写给它的, 措辞随时会改;
//   读回来的一方 (read_chat 的 parseEnvelope) 读开标签上的属性 ——
//   事实只写一次、按名取, 改措辞不再牵连解析。
// 属性出现之前落盘的 transcript / 轮次记录里只有正文, 那些靠 LEGACY 表按措辞认。
//
// 属性一览 (`wezard` 区分种类):
//   envelope  kind=human|peer|task  from  chat?  scope=private|public (仅 peer)
//             event (peer/task): 这一轮对应的**路由行** id (`route:<event>` 注入事件的那一笔)
//             serves (仅回执): 这一轮的终句落在哪一笔上 (= receiver.event)
//             receipt=1 (仅 peer): 这一轮是守护进程自动送回来的回执, 不是新活
//             quiet=1 (仅 peer): 发话方不收回执; 不改变公开/私聊或工具授权
//             via (仅回执): 这份结论是谁替 `from` 送到的 —— 收方已不在 (stop / 注销) 时沿链
//                  升级, 被跳过的那些 wizard (由近及远, `, ` 分隔)
//             late=1 (仅回执): 这一笔的上一环已经收口 (孤儿), 结论迟到了 —— 那一轮服务的
//                  那一笔已关, 它的终句只进 rolepage
//   mention   names  (空格分隔的 `.name`)
//   roster    正文里 `- ` 开头的每一行是一条变动
//   hint      role=steward: 人对管家说的那一轮挂的「自己答还是派出去」(只给模型, 不读回)

import type { Asker } from "./detail-store.js";

export type Attrs = Readonly<Record<string, string>>;
export interface Reminder {
  attrs: Attrs;
  body: string;
  raw: string;
}

// 开标签容许属性: 我们自己的, 以及 codebuddy 的 `data-role="command-caveat"`。
export const REMINDER_RE = /<system-reminder(\s[^>]*)?>([\s\S]*?)<\/system-reminder>/g;

const ENT: ReadonlyArray<[string, string]> = [["&", "&amp;"], ['"', "&quot;"], ["<", "&lt;"], [">", "&gt;"]];
const escAttr = (s: string): string => ENT.reduce((a, [c, e]) => a.split(c).join(e), s);
const unescAttr = (s: string): string => [...ENT].reverse().reduce((a, [c, e]) => a.split(e).join(c), s);

const attrsOf = (s = ""): Attrs =>
  Object.fromEntries([...s.matchAll(/([\w-]+)="([^"]*)"/g)].map((m) => [m[1]!, unescAttr(m[2]!)]));

/** 以换行起头 —— 直接接在正文后面。 */
export const renderReminder = (attrs: Attrs, lines: readonly string[]): string =>
  [
    "",
    `<system-reminder${Object.entries(attrs).map(([k, v]) => ` ${k}="${escAttr(v)}"`).join("")}>`,
    ...lines,
    "</system-reminder>",
  ].join("\n");

export const parseReminders = (text: string): Reminder[] =>
  [...text.matchAll(REMINDER_RE)].map((m) => ({ attrs: attrsOf(m[1]), body: (m[2] ?? "").trim(), raw: m[0] }));

export const stripReminders = (text: string): string => text.replace(REMINDER_RE, "").trim();

// ── 信封 ──────────────────────────────────────────────────────────────
export interface Envelope {
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
  /** 发话方不收自动回执 (fyi / receipt:false); 与 private、工具授权无关。 */
  quiet?: boolean;
  /** 回执的定论 (见 ReceiptStatus); 老信封没有 = done。 */
  status?: ReceiptStatus;
  /** 这一轮对应的路由行 id (§9.1): 派活/续问 = 新开的子行; 回执 = 刚落定的那一笔;
   *  定时任务 = 为它开的群根行。 */
  event?: string;
  /** 回执: 这一轮的终句落在哪一笔上 (= 收方自己欠的 `receiver.event`, §9.4)。 */
  serves?: string;
  /** 回执: 这一轮在群里的终句答给的那个人 (userid, 见 role-view.audienceOf); 认不出 = 没有。 */
  audience?: string;
  /** 回执: 这份结论是谁替 `from` 送到的 (`.x`, 多个用 `, ` 分隔) —— 收方已不在时沿链升级
   *  跳过的那些 (见 router.escalate); transfer 接手作答的旧义。 */
  via?: string;
  /** 回执: 这一笔的上一环已经收口 —— 结论迟到了, 它服务的那一笔已关 (见 router.isOrphaned)。 */
  late?: boolean;
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
export interface ReceiptRoute { up?: boolean; audience?: string; asker?: Asker; via?: string; late?: boolean; pending?: number }

/** 这句话挂在哪一笔上、怎么接 (§9.4) —— 写进派活信封。
 *  `act`: 这句话要对方怎么接 —— 缺省是一件活; ask = 只答一问; fyi = 知会, 不用回。
 *  `re`: 续问 (接着那一笔说); 只影响信封正文的措辞。
 *  `quiet`: 发话方不收回执 (fyi 一定是; task 带 receipt:false 也是)。 */
export interface TurnTag { event?: string; re?: boolean; legs?: number; deadline?: number; act?: "ask" | "fyi"; quiet?: boolean; asker?: Asker }

const askerAttrs = (asker?: Asker): Attrs => asker
  ? { "asker-user": asker.who, "asker-chat": asker.chat } : {};

/** 回执落成什么。done = 答了; need = 它收口成 `NEED:` 反问发话方, 不是定论; error = 那一轮以 CLI 报错 (API Error) 收尾, 不是定论;
 *  timeout / silent / dead = 没等到答案 (超时 / 停下几次都没答 / pane 没了); canceled = 被人 stop 掉了。 */
export type ReceiptStatus = "done" | "need" | "error" | "timeout" | "silent" | "dead" | "canceled";

export const envelopeAttrs = {
  human: (user: string, chat: string, chatKey?: string): Attrs => ({ wezard: "envelope", kind: "human", from: user, chat, ...(chatKey ? { "chat-key": chatKey } : {}) }),
  /** `chat` 不给 = 私聊。 */
  peer: (from: string, chat?: string, t?: TurnTag): Attrs => ({
    wezard: "envelope", kind: "peer", from, scope: chat === undefined ? "private" : "public", ...(chat ? { chat } : {}),
    ...askerAttrs(t?.asker),
    ...(t?.quiet || t?.act === "fyi" ? { quiet: "1" } : {}),
    ...(t?.event ? { event: t.event } : {}),
    ...(t?.deadline ? { deadline: new Date(t.deadline).toISOString() } : {}),
    ...(t?.act ? { act: t.act } : {}),
  }),
  /** `event` = 这一枪为它开的那条群根行 (安静任务按它定位终句, 见 index.ts relayUnlessQuiet)。 */
  task: (taskId: string, event?: string): Attrs => ({ wezard: "envelope", kind: "task", from: taskId, ...(event ? { event } : {}) }),
  /** 回执也是「`from` 在对你说话」, 所以仍是 peer 信封 —— read_chat / rolepage 照旧
   *  把它归到那场对话里; 多一个 `receipt` 属性说明它是自动送回来的结论而不是新活。 */
  receipt: (from: string, chat?: string, job?: { job: string; done: number; total: number }, status: ReceiptStatus = "done", event?: string, route?: ReceiptRoute): Attrs => ({
    ...envelopeAttrs.peer(from, chat, event ? { event } : undefined),
    receipt: "1",
    status,
    ...askerAttrs(route?.asker),
    ...(route?.audience ? { audience: route.audience } : {}),
    ...(route?.via ? { via: route.via } : {}),
    ...(route?.late ? { late: "1" } : {}),
    // 工单的「齐了吗」由守护进程数出来写在属性上, 不让模型自己记: 异步回执是 N 个
    // 独立的轮次陆续进来的, 靠模型在上下文里数到五是最容易出错的那种事。
    ...(job && job.job
      ? { job: job.job, done: String(job.done), total: String(job.total), complete: job.done >= job.total ? "1" : "0" }
      : {}),
  }),
};

const KINDS = new Set(["peer", "human", "task"]);
const envelopeOfAttrs = (a: Attrs): Envelope | undefined =>
  a.wezard === "envelope" && KINDS.has(a.kind ?? "")
    ? {
        kind: a.kind as Envelope["kind"],
        from: a.kind === "task" ? `定时 ${a.from ?? ""}` : a.from ?? "",
        private: a.scope === "private",
        chat: a.chat ?? "",
        ...(a["chat-key"] ? { chatKey: a["chat-key"] } : {}),
        ...(a["asker-user"] && a["asker-chat"] ? { asker: { who: a["asker-user"], chat: a["asker-chat"] } } : {}),
        ...(a.receipt === "1" ? { receipt: true } : {}),
        ...(a.quiet === "1" || a.act === "fyi" ? { quiet: true } : {}),
        ...(a.status ? { status: a.status as ReceiptStatus } : {}),
        ...(a.event ? { event: a.event } : {}),
        ...(a.serves ? { serves: a.serves } : {}),
        ...(a.audience ? { audience: a.audience } : {}),
        ...(a.via ? { via: a.via } : {}),
        ...(a.late === "1" ? { late: true } : {}),
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
  const eventId = reminders.filter((r) => ["message-event", "receipt-delivery"].includes(r.attrs.wezard ?? "")).at(-1)?.attrs.event;
  return env && { ...env, ...(eventId ? { eventId } : {}) };
};
