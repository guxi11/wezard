// `<system-reminder>`: 注入时挂在一句话尾巴上的机器信息 —— 信封 (谁、在哪说的) /
// 点名提示 / 名册增量。两个读者各取一半:
//   模型读正文 —— 规矩是写给它的, 措辞随时会改;
//   读回来的一方 (read_chat 的 parseEnvelope) 读开标签上的属性 ——
//   事实只写一次、按名取, 改措辞不再牵连解析。
// 属性出现之前落盘的 transcript / 轮次记录里只有正文, 那些靠 LEGACY 表按措辞认。
//
// 属性一览 (`wezard` 区分种类):
//   envelope  kind=human|peer|task  from  chat?  scope=private|public (仅 peer)
//             receipt=1 (仅 peer): 这一轮是守护进程自动送回来的回执, 不是新活
//             reply-to (仅回执): 这一轮的终句会送到哪 (`.x` / 群名); 缺省 = 只进 rolepage
//             k (仅回执): 机器读的父 k (`chat:<base>` / `peer:<turn>:<key>`), 下一跳继承
//   mention   names  (空格分隔的 `.name`)
//   roster    正文里 `- ` 开头的每一行是一条变动

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
  kind: "peer" | "human" | "task";
  /** 发话方的称呼: wizard 是 `.name`, 人是 userid, 定时任务是 `定时 <id>`。 */
  from: string;
  /** wizard 之间的私聊。 */
  private: boolean;
  /** 公开轮所在群的名字; "" = 这个会话的 home 聊天。 */
  chat: string;
  /** 这一轮是回执 (对方干完了, 守护进程把结论送回发话方), 不是新派的活。 */
  receipt?: boolean;
  /** 回执的定论 (见 ReceiptStatus); 老信封没有 = done。 */
  status?: ReceiptStatus;
  /** 这件活的 id (`t` + 6 hex): 派活、续问、回执都带同一个, 回执按它定位答句。 */
  turn?: string;
  /** 续问 (`tell_peer({re})`): 这一句接着那件活说, 不是新活。值同 `turn`。 */
  re?: string;
  /** 回执: 这一轮的终句会送到哪 (`.x` = 作为回执回给它; 群名 = 进那个群)。 */
  replyTo?: string;
  /** 回执: 父 k 的机器表示 (见 receipts.kAttr)。 */
  k?: string;
}

/** 回执那一轮的去向 (见 receipts.routeOf), 已渲染成给人 / 模型看的称呼。 */
export interface ReceiptRoute { replyTo?: string; k?: string }

/** 一件活的编号: 写进派活与回执的信封。 */
/** `act`: 这句话要对方怎么接 —— 缺省是一件活; ask = 只答一问; fyi = 知会, 不用回。
 *  `quiet`: 发话方不收回执 (fyi 一定是; task 带 receipt:false 也是)。 */
export interface TurnTag { turn: string; re?: boolean; deadline?: number; act?: "ask" | "fyi"; quiet?: boolean }

/** 回执落成什么。done = 答了; need = 它收口成 `NEED:` 反问发话方, 不是定论; error = 那一轮以 CLI 报错 (API Error) 收尾, 不是定论;
 *  timeout / silent / dead = 没等到答案 (超时 / 停下几次都没答 / pane 没了); canceled = 被人 stop 掉了。 */
export type ReceiptStatus = "done" | "need" | "error" | "timeout" | "silent" | "dead" | "canceled";

export const envelopeAttrs = {
  human: (user: string, chat: string): Attrs => ({ wezard: "envelope", kind: "human", from: user, chat }),
  /** `chat` 不给 = 私聊。 */
  peer: (from: string, chat?: string, t?: TurnTag): Attrs => ({
    wezard: "envelope", kind: "peer", from, scope: chat === undefined ? "private" : "public", ...(chat ? { chat } : {}),
    ...(t ? { turn: t.turn, ...(t.re ? { re: t.turn } : {}), ...(t.deadline ? { deadline: new Date(t.deadline).toISOString() } : {}), ...(t.act ? { act: t.act } : {}) } : {}),
  }),
  /** `turn` = 这一枪的件号 (安静任务按它定位终句, 见 index.ts relayUnlessQuiet)。 */
  task: (taskId: string, turn?: string): Attrs => ({ wezard: "envelope", kind: "task", from: taskId, ...(turn ? { turn } : {}) }),
  /** 回执也是「`from` 在对你说话」, 所以仍是 peer 信封 —— read_chat / rolepage 照旧
   *  把它归到那场对话里; 多一个 `receipt` 属性说明它是自动送回来的结论而不是新活。 */
  receipt: (from: string, chat?: string, job?: { job: string; done: number; total: number }, status: ReceiptStatus = "done", turn?: string, route?: ReceiptRoute): Attrs => ({
    ...envelopeAttrs.peer(from, chat, turn ? { turn } : undefined),
    receipt: "1",
    status,
    ...(route?.replyTo ? { "reply-to": route.replyTo } : {}),
    ...(route?.k ? { k: route.k } : {}),
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
        ...(a.receipt === "1" ? { receipt: true } : {}),
        ...(a.status ? { status: a.status as ReceiptStatus } : {}),
        ...(a.turn ? { turn: a.turn } : {}),
        ...(a.re ? { re: a.re } : {}),
        ...(a["reply-to"] ? { replyTo: a["reply-to"] } : {}),
        ...(a.k ? { k: a.k } : {}),
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

/** 一句落盘的输入上挂着的信封。只在 `<system-reminder>` 里找 —— 正文里引用这句
 *  措辞的人话不算。 */
export const parseEnvelope = (raw: string): Envelope | undefined =>
  parseReminders(raw).reduce<Envelope | undefined>((hit, r) => hit ?? envelopeOf(r), undefined);
