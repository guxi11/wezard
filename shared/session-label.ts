// Stable per-session visual tag. Hash a sessionId to a fixed animal emoji so
// the same Claude session always shows the same icon — on approval cards and
// in the /sessions list — letting the user tell sibling sessions apart when
// several un-mirrored sessions all fall back to the same WeCom chat.
//
// Stateless + deterministic: same sessionId → same emoji across daemon
// restarts, no persistence needed.

const ANIMALS = [
  "🦊", "🐬", "🦄", "🐙", "🦉", "🐢", "🦋", "🐝",
  "🐳", "🦁", "🐯", "🐰", "🦝", "🐼", "🐨", "🦓",
  "🦔", "🦇", "🐧", "🦜", "🦩", "🐸", "🐺", "🦅",
  "🐡", "🦗", "🐌", "🦚", "🐲",
];

// FNV-1a — small, fast, good spread for short ascii ids.
const hash = (s: string): number => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
};

export const labelFor = (sessionId: string): string => {
  if (!sessionId) return "❔";
  return ANIMALS[hash(sessionId) % ANIMALS.length] ?? "❔";
};

// ── `.name` lexicon ─────────────────────────────────────────────────────
// A wizard is addressed by its GLOBAL name, written `.name` — in a chat, in a
// peer message, in a bubble header. One rule for what counts as a name token,
// shared by everything that reads them out of prose: the inbound router (FIRST
// match = who gets the message) and mention annotation (the REST). Two readers
// of the same text must not disagree on where the tokens are.
// Must be space-delimited or edge-of-string so paths / extensions like
// `a.ts` / `./foo` survive. 右边界除空白/行尾外,零宽与 word-joiner 等不可见格式
// 字符也算分隔 —— 输入法/复制常在名字后夹一个 U+2060 之类。
const NAME_CHARS = "[\\p{L}\\p{N}_-]";
const NAME_TOKEN = `(^|\\s)\\.(${NAME_CHARS}{1,32})(?=[\\s\\u200B-\\u200D\\u2060\\uFEFF]|$)`;

/** Fresh non-global matcher — capture 2 is the name. Own instance per caller so
 *  nobody inherits another's `lastIndex`. */
export const nameTokenRe = (): RegExp => new RegExp(NAME_TOKEN, "u");

/** Every distinct `.name` in `text`, in first-appearance order. */
export const allNames = (text: string): string[] => [
  ...new Set([...text.matchAll(new RegExp(NAME_TOKEN, "gu"))].map((m) => m[2] ?? "").filter(Boolean)),
];

/** `.fix` / `fix` / `#fix` (旧写法) → `fix`; 其余原样 trim。 */
export const stripSigil = (raw: string | undefined): string => (raw ?? "").trim().replace(/^[.#@]+/, "");

// ── Target keys ─────────────────────────────────────────────────────────
// Daemon-internal target keys are `user:xxx[#k]` / `chat:xxx[#k]`: the chat a
// wizard was BORN in (its home) plus an internal slot id. The slot id is NOT
// the wizard's name — the name is global, lives in the wizard registry, and
// is what every human/wizard-facing surface shows (`.name`). A rename never
// rekeys a session. Every bubble carries `.name` (the chat's default wizard
// at home excepted, see isHost); the emoji avatar is rolepage-only.

/** `#tag` suffix of a target key, "" when untagged. */
export const tagOfKey = (target: string | undefined): string => {
  if (!target) return "";
  const h = target.indexOf("#");
  return h >= 0 ? target.slice(h + 1) : "";
};

/** Drop the `#tag` suffix — collapses a tagged session key to the chat-scoped
 *  base principal (`user:xxx#foo` → `user:xxx`). Everything shared across a
 *  chat's sessions (cwd, peer discovery, graph runs) keys off this. */
export const baseOfKey = (target: string): string => {
  const h = target.indexOf("#");
  return h >= 0 ? target.slice(0, h) : target;
};

/** Base of daemon-internal sessions (the memory steward): a home that is no chat,
 *  so it never shows in a chat roster, never gets auto-named, never takes a bubble. */
export const INTERNAL_BASE = "wezard:internal";
export const isInternalKey = (target: string): boolean => baseOfKey(target) === INTERNAL_BASE;

/** Compose a session key from a base principal and a tag ("" → default session). */
export const keyOf = (base: string, tag: string): string => (tag ? `${base}#${tag}` : base);

/** Coerce an arbitrary string into the name charset `NAME_TOKEN` accepts — a
 *  name the header parser can't round-trip would make its own bubbles
 *  unaddressable. "" when nothing usable survives. Also the slot-id charset. */
export const normalizeTag = (raw: string | undefined): string =>
  stripSigil(raw)
    .replace(/[^\p{L}\p{N}_-]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);

/** Default tag for a session spawned in `cwd` — the project's own name is what
 *  a human would have typed. */
export const tagFromCwd = (cwd: string): string => normalizeTag(cwd.split("/").filter(Boolean).pop());

/** `want`, or the first `want-N` not already in `taken`. */
export const uniqueTag = (want: string, taken: ReadonlySet<string>, n = 1): string => {
  const candidate = n < 2 ? want : `${want.slice(0, 29)}-${n}`;
  return taken.has(candidate) ? uniqueTag(want, taken, n + 1) : candidate;
};

// 出站气泡的头 (`.fix: …`) 是可被「引用」的路由信息: 群里要跟某个 wizard 说话,
// 引用它的气泡比手打名字快得多。这里做反向解析。
// 头有两种形态,都要认:裸 `.fix: …`,以及 rolepage 链接形态 `[.fix](https://…): …`。
// 裸头不带 emoji 时必须跟冒号 —— 人自己行首打的 `.fix 干活` 不是 bot 的头。
// 链接里的 URL 若留在 body 里,既污染比对又会被当成用户内容贴进 prompt。
// 群默认 wizard 在自己群里说话不带头 (人本来就在跟它说): 引用它的气泡剥不出头,
// 照普通引用走, 路由落回本群默认 wizard —— 正是它。
// 旧气泡的写法仍被认: `#tag` 头 (改名前发出去的, 迁移时名字取自 tag, 照旧指得对人),
// 带 emoji 头像的 `🦊.fix:` / `🦊 .fix …`, 以及 wizard 之间的 `🦊 .a → .b`、`🦊.a: @🐨.b`。
// 公开频道里 wizard 之间说话的头是 `.a: .b`, 路由信息取发话方 (引用它 = 跟 a 说)。
// 分片序号 (`2/5`) 与折叠气泡的 `← View chat details` 提示同理,一并算作头。
const HEAD_EMOJI = [...ANIMALS, "🧙", "❔"];
const EMO = `(?:${HEAD_EMOJI.join("|")})`;
const NAME_PART = `(?:\\s*[.#](${NAME_CHARS}{1,32}))?(?:\\s*→\\s*[.#]${NAME_CHARS}{1,32})?`;
const BARE_NAME = `[.#](${NAME_CHARS}{1,32})`;
// 对方那一半: 新 `: [.b](url)`, 旧 `: @[🐨.b](url)` / `→ [🐨 .b](url)`。没有 → / @ 引着时
// 只认链接或带 emoji 的形态 —— 冒号后正文开头随手写的 `.gitignore` 不是对象。
const PEER_NAME = `(?:${EMO}\\s*)?[.#]${NAME_CHARS}{1,32}`;
const PEER_LINK = `\\[@?${PEER_NAME}\\]\\([^)]*\\)`;
const TO_PART = `(?:\\s*(?:(?:→|@)\\s*(?:${PEER_LINK}|${PEER_NAME})|${PEER_LINK}|${EMO}\\s*[.#]${NAME_CHARS}{1,32}))?`;
const HEADER_RE = new RegExp(
  `^(?:\\[(?:${EMO}${NAME_PART}|${BARE_NAME})\\]\\([^)]*\\)(?::)?|${EMO}${NAME_PART}(?::)?|${BARE_NAME}:)${TO_PART}` +
    `(?:\\s+\\d+/\\d+)?(?:\\s*←\\s*View chat details)?(?![\\p{L}\\p{N}_-])\\s*`,
  "u",
);

/** 反解一条出站气泡的 `.name:` 头,返回名字与剥头后的正文。
 *  `fromBot=false` 表示这不是 wezard 发的 (或是不带头的群默认 wizard),body 原样返回。
 *  只切掉头那一段; 正文里 linkNames 挂上的 `[.fix](url)` 还原成裸 `.fix` —— 引用
 *  内容要跟 transcript 尾部比对, 也可能被贴进 prompt, URL 两头都是噪声。 */
export const parseTagHeader = (text: string): { fromBot: boolean; tag: string; body: string } => {
  const t = text.trim();
  const m = HEADER_RE.exec(t);
  if (!m) return { fromBot: false, tag: "", body: t };
  const tag = m.slice(1).find(Boolean) ?? "";
  return { fromBot: true, tag, body: unlinkTags(t.slice(m[0].length).trim()) };
};

/** 卡片标题前的 `.name ` 徽标; 群默认 wizard 在自己群里不报名 (同 withTagHeader)。 */
export const tagBadge = (target: string | undefined): string => {
  const head = isHost(target) ? "" : tagHead(target);
  return head ? `${head} ` : "";
};

/** 头与正文之间该留多少空白。默认同行一个空格 —— 头只是一句话的前缀,省一行。
 *  块级语法认行首,两种例外:
 *   • ``` 栅栏必须顶行首才被 WeCom 认作代码块,同行拼头会把它挤成字面文本;
 *   • 表格更严 —— 它**不能打断一个段落**,只隔一个换行,首行表头会被当成头那一
 *     段的续行,整张表塌成一行带竖线的文字。所以表格必须空行隔开。
 *  HEADER_RE 尾部的 \s* 吃得掉这些换行,parseTagHeader 剥头不受影响。 */
export const headSep = (content: string): string =>
  content.startsWith("```") ? "\n" : content.startsWith("|") ? "\n\n" : " ";

// ── name → rolepage 链接 ─────────────────────────────────────────────
// 群里出现的每个 `.name` 都该点得开那个 wizard 的 rolepage —— 气泡头, 以及正文里
// 提到的 `.fix`。票据、名册 (target ↔ name) 都在 daemon 手里, 这里只认一个进程级
// 的注入口 (同 bindWizardStore): 没绑定 (boot 早期 / 浏览器端) 一律退回 slot id /
// 裸文本, 头照样写 —— 少了链接只是少一层可点。
export interface TagLinker {
  /** 该 wizard 的 rolepage; undefined = 拿不到票据。 */
  urlOf: (target: string) => string | undefined;
  /** 全局名字 → 已知 wizard 的 target。 */
  resolve: (name: string) => string | undefined;
  /** target → 它的全局名字 ("" = 名册里没有)。 */
  nameOf: (target: string) => string;
}
let linker: TagLinker | undefined;
export const bindTagLinker = (l: TagLinker): void => { linker = l; };

/** target 的对外名字: 名册里的全局名, 名册没绑定时退回 slot id。 */
export const displayName = (target: string | undefined): string =>
  target ? linker?.nameOf(target) || tagOfKey(target) : "";

// 正文里最多挂几个链接: 一条 URL 两百来字节, 分片预算 (mirror 的 TAG_HEADER_BUDGET)
// 按「头 + 这么多个」留的余量。同一个名字只挂第一次出现。
export const MAX_BODY_LINKS = 2;
// 右边界比路由用的 NAME_TOKEN 宽: 正文里 `.fix。` `.fix,` 也是提及; 后接 `]` 说明它已在
// 某个链接文本里, 不再套一层。左边界必须是空白/行首 —— `a.ts` 不是提及。
const MENTION_RE = /(^|\s)(\.([\p{L}\p{N}_-]{1,32}))(?![\p{L}\p{N}_\].-])/gu;
// 代码里的 `.x` 是字面量, 不是提及: 栅栏块与行内代码原样放过 (split 的捕获组落在奇数位)。
const CODE_RE = /(```[\s\S]*?(?:```|$)|`[^`\n]*`)/;
const LINKED_RE = /\[([.#][\p{L}\p{N}_-]{1,32})\]\([^)\s]*\)/gu;

/** `text` 挂上 `target` 的 rolepage; 拿不到票据原样返回。 */
export const tagLink = (target: string, text: string): string => {
  const url = linker?.urlOf(target);
  return url ? `[${text}](${url})` : text;
};

/** 正文里指向已知 wizard 的 `.name` 挂上它的 rolepage。 */
export const linkTags = (target: string | undefined, text: string): string => {
  const l = linker;
  if (!l || !target) return text;
  const seen = new Set<string>();
  const link = (whole: string, lead: string, token: string, name: string): string => {
    if (seen.size >= MAX_BODY_LINKS || seen.has(token)) return whole;
    const t = l.resolve(name);
    const linked = t ? tagLink(t, token) : token;
    if (linked === token) return whole;
    seen.add(token);
    return `${lead}${linked}`;
  };
  return text
    .split(CODE_RE)
    .map((seg, i) => (i % 2 ? seg : seg.replace(MENTION_RE, link)))
    .join("");
};

/** linkTags 的逆: `[.fix](url)` → `.fix`。 */
export const unlinkTags = (text: string): string => text.replace(LINKED_RE, "$1");

// ── 发言头 ─────────────────────────────────────────────────────────────
// 谁说的、说给谁, 群气泡 (markdown 链接)、read_chat (纯文本)、rolepage (HTML) 写成同一个结构:
// `.a:` / `.a: .b` —— 发话方后跟冒号, 对象紧跟其后 (名字前的 `.` 已是 wizard 的记号, 不再加 @)。
// emoji 只是 rolepage 的头像: 群里与 read_chat 只写名字, rolepage 用 nameHead 把头像贴上去。
// 下面三个原子就是这份结构的全部; 各处只决定两边的名字各自怎么画 (裸名 / 链接 / 按钮)。它们原样送进
// 浏览器 (SPEAKER_KIT, 由 chat-render 拼进 /chat/app.js), 所以只许是不引用模块里任何别的东西的纯函数。
/** 头像 + 名字, 中间不留空格。 */
export const nameHead = (label: string, name: string): string => `${label}${name}`;
/** 发话方 + 冒号。 */
export const said = (me: string): string => `${me}:`;
/** 一条发言的头: 发话方后跟冒号; 对着谁说 (`to`) 时再接对方。 */
export const speakerHead = (me: string, to?: string): string => (to ? `${said(me)} ${to}` : said(me));
/** 送进浏览器的那几个原子: 名字 → 源码。 */
export const SPEAKER_KIT: Readonly<Record<string, (...a: never[]) => string>> = { nameHead, said, speakerHead };

/** 头的裸形态 `.name`; 名字都拿不到时为空 (不写头)。 */
export const tagHead = (target: string | undefined): string => {
  const name = displayName(target);
  return name ? `.${name}` : "";
};

/** 头的链接形态 `[.name](url)` —— 点它就进那个 wizard 的 rolepage。
 *  HEADER_RE 认得这一形态, parseTagHeader 照样剥得掉。 */
export const linkedTagHead = (target: string | undefined, url: string): string =>
  ((h) => (h ? `[${h}](${url})` : ""))(tagHead(target));

/** 群的默认 wizard 在自己群里 (`dest` 缺省 = 它的 home): 人本来就在跟它说话, 不报名。
 *  slot 分身、被人从别的群点名过来的都不是 host, 照旧带头以示区分。 */
export const isHost = (target: string | undefined, dest?: string): boolean =>
  !!target && !tagOfKey(target) && !isInternalKey(target) && (!dest || baseOfKey(dest) === baseOfKey(target));

/** 一条群气泡: 头 + 正文, 头为空就只有正文。 */
export const headed = (head: string, body: string, sep = headSep(body)): string => (head ? `${head}${sep}${body}` : body);

/** 发话方在 `dest` 群里的头: host 不报名; `to` = 说给谁 (公开 wizard 间), 有对象时 host 也得报名。 */
export const chatHead = (target: string | undefined, url: string | undefined, to?: string, dest?: string): string =>
  !to && isHost(target, dest)
    ? ""
    : ((me) => (me ? speakerHead(me, to) : ""))(url ? linkedTagHead(target, url) : tagHead(target));

/** 头挂上指定的 rolepage 链接 (mirror 用本轮 turn 的票据), 正文里的名字一并挂链。
 *  url 为空时退回裸头 —— 头那一段是路由信息, 少了链接只是少一层可点, 不能因此不写。
 *  群默认 wizard 在自己群 (`dest`, 缺省 = home) 里不写头 (isHost)。
 *  `to` = 这段话是答给哪个 wizard 的 (公开 peer 轮): 头写成 `.me: .它`, 与它问话
 *  那条气泡的 `.它: .me` 对称。
 *  `seq` ("2/5") marks one piece of a split push — it rides in the same header
 *  line so every chunk of a long reply is attributable on its own. */
export const withLinkedTagHeader = (
  target: string | undefined,
  content: string,
  url: string | undefined,
  seq?: string,
  to?: string,
  dest?: string,
): string => {
  const head = [chatHead(target, url, ((h) => (h ? tagLink(to!, h) : undefined))(tagHead(to)), dest), seq ?? ""].filter(Boolean).join(" ");
  return headed(head, linkTags(target, content));
};

/** 给气泡加 `.name:` 头, 链接取该 wizard 自己的 rolepage (bindTagLinker)。 */
export const withTagHeader = (target: string | undefined, content: string, seq?: string, dest?: string): string =>
  withLinkedTagHeader(target, content, target ? linker?.urlOf(target) : undefined, seq, undefined, dest);
