// `<system-reminder>`: 注入时挂在一句话尾巴上的机器信息 —— 信封 (谁、在哪说的) /
// 点名提示 / 名册增量。两个读者各取一半:
//   模型读正文 —— 规矩是写给它的, 措辞随时会改;
//   读回来的一方 (read_chat 的 parseEnvelope、rolepage 的展示) 读开标签上的属性 ——
//   事实只写一次、按名取, 改措辞不再牵连解析。
// 属性出现之前落盘的 transcript / 轮次记录里只有正文, 那些靠 LEGACY 表按措辞认。
//
// 属性一览 (`wezard` 区分种类):
//   envelope  kind=human|peer|task  from  chat?  scope=private|public (仅 peer)
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
}

export const envelopeAttrs = {
  human: (user: string, chat: string): Attrs => ({ wezard: "envelope", kind: "human", from: user, chat }),
  /** `chat` 不给 = 私聊。 */
  peer: (from: string, chat?: string): Attrs => ({
    wezard: "envelope", kind: "peer", from, scope: chat === undefined ? "private" : "public", ...(chat ? { chat } : {}),
  }),
  task: (taskId: string): Attrs => ({ wezard: "envelope", kind: "task", from: taskId }),
};

const KINDS = new Set(["peer", "human", "task"]);
const envelopeOfAttrs = (a: Attrs): Envelope | undefined =>
  a.wezard === "envelope" && KINDS.has(a.kind ?? "")
    ? {
        kind: a.kind as Envelope["kind"],
        from: a.kind === "task" ? `定时 ${a.from ?? ""}` : a.from ?? "",
        private: a.scope === "private",
        chat: a.chat ?? "",
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

export const envelopeOf = (r: Reminder): Envelope | undefined => envelopeOfAttrs(r.attrs) ?? legacyEnvelope(r.body);

/** 一句落盘的输入上挂着的信封。只在 `<system-reminder>` 里找 —— 正文里引用这句
 *  措辞的人话不算。 */
export const parseEnvelope = (raw: string): Envelope | undefined =>
  parseReminders(raw).reduce<Envelope | undefined>((hit, r) => hit ?? envelopeOf(r), undefined);

// ── 展示 ──────────────────────────────────────────────────────────────
// rolepage 上一段 reminder 的摘要: 一行标签 + 可选的条目。认不出的 (Claude Code 自己
// 挂的、未来新加的种类) 也给一行, 原文永远在 raw 那一面。
export interface ReminderView {
  kind: "human" | "peer" | "task" | "mention" | "roster" | "other";
  icon: string;
  label: string;
  items: string[];
}

const itemsOf = (body: string): string[] =>
  body.split("\n").filter((l) => l.startsWith("- ")).map((l) => l.slice(2).trim());

const LEGACY_MENTION = "上面这条消息里的 `.name` 点的是";
const LEGACY_ROSTER = "你出生时拿到的那份名册已经变了";

const envelopeView = (e: Envelope): ReminderView => {
  const where = e.chat ? ` · 群 ${e.chat}` : "";
  if (e.kind === "human") return { kind: "human", icon: "👤", label: `${e.from}${where}`, items: [] };
  if (e.kind === "task") return { kind: "task", icon: "⏰", label: e.from, items: [] };
  return e.private
    ? { kind: "peer", icon: "🔒", label: `${e.from} 私聊`, items: [] }
    : { kind: "peer", icon: "📣", label: `${e.from} 公开${where}`, items: [] };
};

export const viewOf = (r: Reminder): ReminderView => {
  const env = envelopeOf(r);
  if (env) return envelopeView(env);
  const mention = r.attrs.wezard === "mention" || r.body.startsWith(LEGACY_MENTION);
  if (mention) {
    const names = r.attrs.names?.split(/\s+/).filter(Boolean)
      ?? [...r.body.matchAll(/^- `(\.[^`]+)`/gm)].map((m) => m[1]!);
    return { kind: "mention", icon: "🔗", label: `点名 ${names.join(" ")}`, items: [] };
  }
  if (r.attrs.wezard === "roster" || r.body.startsWith(LEGACY_ROSTER)) {
    const items = itemsOf(r.body);
    return { kind: "roster", icon: "🧭", label: `名册变动 ${items.length} 条`, items };
  }
  const first = r.body.split("\n").find((l) => l.trim()) ?? "";
  return { kind: "other", icon: "⚙️", label: first.length > 80 ? `${first.slice(0, 80)}…` : first || "system-reminder", items: [] };
};
