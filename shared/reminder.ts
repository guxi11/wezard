// `<system-reminder>`: 注入时挂在一句话尾巴上的机器信息 —— 信封 (谁、在哪说的) /
// 点名提示 / 名册增量。两个读者各取一半:
//   模型读正文 —— 规矩是写给它的, 措辞随时会改;
//   读回来的一方 (read_chat 的 parseEnvelope) 读开标签上的属性 ——
//   事实只写一次、按名取, 改措辞不再牵连解析。
// 属性出现之前落盘的 transcript / 轮次记录里只有正文, 那些靠 LEGACY 表按措辞认。
//
// 属性一览 (`wezard` 区分种类)。只留两种属性: 有机器读回的 (下面标了读者), 和模型要原样抄进
// 工具参数的 id。只给模型看的语义 (知会 / 期限 / 沿链升级 / 迟到) 写正文, 不再在开标签上抄一遍。
//   envelope  kind=human|peer|task  from  chat?  (read_chat / rolepage / mirror 认出处)
//             scope=private|public (仅 peer)   chat-key (仅 human: 改名不变的群 key)
//             asker-user / asker-chat: 链头那句人话 (askerOf: 卡片落哪个群、audience)
//             event (仅 task / 回执): task = 这一枪开的群根行 (servesOfTurn); 回执 = 刚落定的那一笔
//                  —— 发话方 `tell_peer({re})` 抄的就是它。派活 / 续问不写: 收方不需要自己那一笔的 id,
//                  守护进程从 message-event 的 id 反查 (`events.get(id).serves`)
//             receipt=1 status audience job/done/total/complete (仅回执; regress 与 chat-log 读)
//   message-event  event: 这句话的注入事件 id —— 提交见证 (submittedEventSince) 与轮次↔事件绑定的
//             唯一凭据; 回执也走它 (id = `rcpt:<event>:<rev>`)
//   mention   names  (空格分隔的 `.name`)
//   roster / pending / hint / lead / after: 只给模型, 属性只区分种类与 mode
// 退役不再写、只为老 transcript 照认的: receipt-delivery (与 message-event 同值重复), 派活信封的
// event / quiet / act / deadline, 回执的 serves / via / late。

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
export interface ReceiptRoute { up?: boolean; audience?: string; asker?: Asker; via?: string; late?: boolean; pending?: number }

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

export const envelopeAttrs = {
  human: (user: string, chat: string, chatKey?: string): Attrs => ({ wezard: "envelope", kind: "human", from: user, chat, ...(chatKey ? { "chat-key": chatKey } : {}) }),
  /** `chat` 不给 = 私聊。 */
  peer: (from: string, chat?: string, asker?: Asker): Attrs => ({
    wezard: "envelope", kind: "peer", from, scope: chat === undefined ? "private" : "public", ...(chat ? { chat } : {}),
    ...askerAttrs(asker),
  }),
  /** `event` = 这一枪为它开的那条群根行 (安静任务按它定位终句, 见 index.ts relayUnlessQuiet)。 */
  task: (taskId: string, event?: string): Attrs => ({ wezard: "envelope", kind: "task", from: taskId, ...(event ? { event } : {}) }),
  /** 回执也是「`from` 在对你说话」, 所以仍是 peer 信封 —— read_chat / rolepage 照旧
   *  把它归到那场对话里; 多一个 `receipt` 属性说明它是自动送回来的结论而不是新活。 */
  receipt: (from: string, chat?: string, job?: { job: string; done: number; total: number }, status: ReceiptStatus = "done", event?: string, route?: ReceiptRoute): Attrs => ({
    ...envelopeAttrs.peer(from, chat, route?.asker),
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
        ...(a.status ? { status: a.status as ReceiptStatus } : {}),
        ...(a.event ? { event: a.event } : {}),
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
  // receipt-delivery: 退役前回执多挂的一块, 值与 message-event 相同 —— 老 transcript 照认。
  const eventId = reminders.filter((r) => ["message-event", "receipt-delivery"].includes(r.attrs.wezard ?? "")).at(-1)?.attrs.event;
  return env && { ...env, ...(eventId ? { eventId } : {}) };
};
