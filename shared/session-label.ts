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

/** `@.fix` / `.fix` → `fix`; 其余原样 trim。 */
export const stripSigil = (raw: string | undefined): string => (raw ?? "").trim().replace(/^[.@]+/, "");

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
 *  chat's sessions (cwd, peer discovery, relationship graph) keys off this. */
export const baseOfKey = (target: string): string => {
  const h = target.indexOf("#");
  return h >= 0 ? target.slice(0, h) : target;
};

// 多机器人: 副机器人收到的聊天, base 带 `~<botId>` (`user:X~b2` / `chat:wr…~b2#slot`) —— 同一个人
// 私聊两个机器人、同一个群里两个机器人, 落成两个聊天、两套 wizard。主机器人不带后缀, 所以单机器人与
// 既有数据一个字不变。后缀只在 key 里, 不进名字; 出站时 bot-mux 认出它、剥掉、走那条连接。
// `~` 不会出现在企微 userid / chatid 里, 也不在 `#slot` 的字符集里。
export const BOT_SEP = "~";
/** key 归哪个机器人: "" = 主机器人。 */
export const botOfKey = (target: string): string => {
  const b = baseOfKey(target);
  const i = b.lastIndexOf(BOT_SEP);
  return i >= 0 ? b.slice(i + 1) : "";
};
/** 裸 chatid / principal 挂上机器人后缀 ("" = 主机器人, 原样)。 */
export const withBot = (id: string, bot: string): string => (bot ? `${id}${BOT_SEP}${bot}` : id);
/** `X~b2` → { id: "X", bot: "b2" }; 无后缀 bot = ""。 */
export const splitBot = (bare: string): { id: string; bot: string } => {
  const i = bare.lastIndexOf(BOT_SEP);
  return i >= 0 ? { id: bare.slice(0, i), bot: bare.slice(i + 1) } : { id: bare, bot: "" };
};
// 内部会话 (记忆整理者) 读全机的收件箱与 md, 多机器人时它不归任何一个机器人: 与任何非内部 key 都不 sameBot,
// 否则主机器人的 wizard 能 peek / read_chat / rolepage 到别的机器人的记忆提议。单机器人时保持原状 (它算主机器人)。
// 机器人数是进程启动时的配置 (bots 改了要重启), daemon 与 svr 各自在启动时 bindMultiBot。
let multiBot = false;
export const bindMultiBot = (on: boolean): void => { multiBot = on; };
/** 两个 key 是否同属一个机器人 —— wizard 之间互相看得见、说得上话的唯一前提。 */
export const sameBot = (a: string, b: string): boolean =>
  botOfKey(a) === botOfKey(b) && (!multiBot || isInternalKey(a) === isInternalKey(b));

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

// Only a linked peer suffix is part of the current header; bare `.name` after
// the colon can be ordinary prose.
const HEADER_RE = /^(?:\[\x60?\.([\p{L}\p{N}_-]{1,32})\x60?\]\(([^)]*)\)|(\x60?\.[\p{L}\p{N}_-]{1,32}\x60?)):/u;
/** 反解一条出站气泡的 `.name:` 头,返回名字与剥头后的正文。
 *  `fromBot=false` 表示这不是 wezard 发的 (或是不带头的群默认 wizard),body 原样返回。
 *  只切掉头那一段; 正文里 linkNames 挂上的 `[.fix](url)` 还原成裸 `.fix` —— 引用
 *  内容要跟 transcript 尾部比对, 也可能被贴进 prompt, URL 两头都是噪声。 */
export const parseTagHeader = (text: string): { fromBot: boolean; tag: string; body: string } => {
  const t = text.trim();
  const footer = /(?:^|\s)\[✦\]\(([^\n)]*)\)\s*$/.exec(t);
  const target = footer && linker?.targetOfUrl?.(footer[1]!);
  if (target) {
    const clean = t.slice(0, footer!.index).trim();
    const header = rawTagHeader(clean);
    const ownHeader = header && (header.url ? linker?.targetOfUrl?.(header.url) === target : resolveTagTarget(header.tag, target) === target);
    return { fromBot: true, tag: displayName(target), body: unlinkTags((ownHeader ? header!.body : clean).trim()) };
  }
  const m = HEADER_RE.exec(t);
  if (!m) return { fromBot: false, tag: "", body: t };
  const raw = rawTagHeader(t)!;
  const sender = raw.url && linker?.targetOfUrl?.(raw.url);
  return { fromBot: true, tag: sender ? displayName(sender) : raw.tag, body: unlinkTags(raw.body.trim()) };
};

/** Formatting needs the original body; quote parsing deliberately unlinks its names. */
export const rawTagHeader = (text: string): { tag: string; header: string; body: string; url?: string } | undefined => {
  const t = text.trimStart();
  const m = HEADER_RE.exec(t);
  if (!m) return undefined;
  const tag = m[1] ?? (m[3] ?? "").replace(/^\x60?\.|\x60?$/g, "");
  let end = m[0].length;
  const peer = /^[ \t]+\[\x60?\.[\p{L}\p{N}_-]{1,32}\x60?\]\(([^)]*)\)/u.exec(t.slice(end));
  if (peer) end += peer[0].length;
  const seq = /^[ \t]+\d+\/\d+/u.exec(t.slice(end));
  if (seq) end += seq[0].length;
  end += /^\s*/u.exec(t.slice(end))?.[0].length ?? 0;
  return { tag, header: t.slice(0, end), body: t.slice(end), ...(m[2] ? { url: m[2] } : {}) };
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
  /** Resolve daemon-owned footer URLs for quote routing after the name header is removed. */
  targetOfUrl?: (url: string) => string | undefined;
  /** 该 wizard 的 rolepage; undefined = 拿不到票据。 */
  urlOf: (target: string) => string | undefined;
  /** 全局名字 → 已知 wizard 的 target。`from` = 这段话是谁说的 (其 key): 名字落在别的机器人名下
   *  就当不认识 —— 链接带的是对方的票据, 点开就是别的机器人的整个 rolepage。 */
  resolve: (name: string, from: string) => string | undefined;
  /** target → 它的全局名字 ("" = 名册里没有)。 */
  nameOf: (target: string) => string;
  /** 它在群里替谁说话 (定时任务执行体 = 日程主人); undefined = 替自己。 */
  voiceOf?: (target: string) => string | undefined;
}
let linker: TagLinker | undefined;
export const bindTagLinker = (l: TagLinker): void => { linker = l; };
export const resolveTagTarget = (name: string, from: string): string | undefined => linker?.resolve(name, from);
export const tagUrlOf = (target: string): string | undefined => linker?.urlOf(target);
export const targetOfTagUrl = (url: string): string | undefined => linker?.targetOfUrl?.(url);

/** target 的对外名字: 名册里的全局名, 名册没绑定时退回 slot id。 */
export const displayName = (target: string | undefined): string =>
  target ? linker?.nameOf(target) || tagOfKey(target) : "";

/** 会话 key 的形态 (`user:xxx#slot` / `chat:wr…` / 内部 `wezard:internal`) —— 它永远不是名字。 */
export const isSessionKey = (s: string): boolean => /^(?:user|chat|group|wezard):/.test(s.trim());

/** tmux 窗口 (pane) 的标签 —— 一律是 wizard 的**名字**。`want` 是调用方给的那一个:
 *  名字照用, 是会话 key (手里只有 key) 或没给, 就用名册 / 聊天名推、落定名字。
 *  窗口名会被 safeWindowName 截断, key 印出去看不出是谁 —— `user:T03880027A#naming`
 *  和它所在的聊天都印成 `u-T03880`。 */
export const windowLabel = (target: string, want?: string): string => {
  const w = (want ?? "").trim();
  return (w && !isSessionKey(w) ? w : "") || displayName(target) || target;
};

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
    const t = l.resolve(name, target);
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

/** 微信 ClawBot 的群聊 (`chat:wx_…`): 文本里不挂链接, 默认开顶层模式。 */
export const isWxChat = (key: string): boolean => key.startsWith("chat:wx_");

/** 群的默认 wizard 在自己群里 (`dest` 缺省 = 它的 home): 人本来就在跟它说话, 不必报名。
 *  替它说话的 (定时任务执行体, voiceOf) 算它本人; slot 分身、被人从别的群点名过来的都不是 host, 照旧带头以示区分。 */
export const isHost = (target: string | undefined, dest = target): boolean =>
  ((t) => !!t && !!dest && !tagOfKey(t) && !isInternalKey(t) && baseOfKey(dest) === baseOfKey(t))(
    target && (linker?.voiceOf?.(target) || target));

/** 一条群气泡: 头 + 正文, 头为空就只有正文。 */
export const headed = (head: string, body: string, sep = headSep(body)): string => (head ? `${head}${sep}${body}` : body);

/** 发话方在 `dest` 群里的头; `to` = 说给谁 (公开 wizard 间), 有对象时谁都得报名。
 *  host 不报名, 但企微里它的名字链接是进 rolepage 的入口: 有链接就留 `[.name](url):`, 只是不写裸名字;
 *  微信那头链接本就降成文字 (wxMarkdown), 留下的只会是一句重复的自报身份, 整个头都不写。
 *  署名: 非 default wizard (isHost 为假 —— slot 会话 / 从别群点名过来的) 名字包一层反引号,
 *  `\`.name\`` / `[\`.name\`](url)`, 与 default wizard 的裸头区分; HEADER_RE / rawTagHeader 两种形态都认。 */
export const chatHead = (target: string | undefined, url: string | undefined, to?: string, dest?: string): string => {
  const host = !to && isHost(target, dest);
  if (host && (!url || isWxChat(baseOfKey(dest || target!)))) return "";
  const head = ((h) => (h && !isHost(target, dest) ? `\`${h}\`` : h))(tagHead(target));
  const me = url ? ((h) => (h ? `[${h}](${url})` : ""))(head) : head;
  return me ? speakerHead(me, to) : "";
};

/** `target` 自己往 `dest` 群说话的当前头; 链接取它自己的 rolepage。 */
export const ownHead = (target: string, dest?: string): string => chatHead(target, linker?.urlOf(target), undefined, dest);

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
