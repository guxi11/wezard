// Inbound text router. Hands the message off to the mirror bridge.
import { statSync } from "node:fs";
import type { WSClient, WsFrame, TextMessage, ImageMessage, MixedMessage, FileMessage, VideoMessage, VoiceMessage, BaseMessage, QuoteContent } from "@wecom/aibot-node-sdk";
import { attachmentLine, inboxName, saveToInbox } from "./media.js";
import type { Logger } from "pino";
import type { Config } from "../shared/config.js";
import type { MirrorBridge } from "./mirror-bridge.js";
import { tailTurnsWithTools, peerMentionPart, renderHumanEnvelope, renderStewardHint, type PeerInfo, type PeerMention } from "./peers.js";
import { keepalivePingSigs } from "../shared/keepalive.js";
import { noticeSuffixFor } from "./notices.js";
import { expandHome, sanitizeId } from "../shared/paths.js";
import type { CliBackendName } from "../shared/cli-backends.js";
import { parseWxCommand, wxCommandHandler } from "./weixin-cmd.js";
import { tryConsumeClaim, persistClaim, ackClaim, shouldAutoClaim, ackAutoClaim } from "./claim.js";
import { getLastResponse } from "./last-response.js";
import { scanClaudeSessions, type SessionInfo } from "./session-scan.js";
import { computeUsage, renderUsageReport } from "./usage.js";
import { computeAuditReport } from "./audit.js";
import { syncProjectConfig, renderSyncReport } from "./cfg-sync.js";
import { captureQuota, renderQuotaReport } from "./quota.js";
import { tagOfKey, baseOfKey, keyOf, withTagHeader, parseTagHeader, nameTokenRe, allNames, unlinkTags, normalizeTag, uniqueTag, displayName, tagLink } from "../shared/session-label.js";
import { chatNameOf, clearChatName, listChatNames, setChatName, stewardTierOf, type CharterGuard } from "./chat-name.js";
import { evictStaleName, reclaimChatName, wizardStore, type EvictDeps } from "./wizard.js";
import { truncate } from "../shared/std.js";

/** 判定"引用内容是否已在目标会话上下文里"时回看的轮数 —— 引用的通常是最近几轮
 *  里的某条气泡,再往前用户多半是真想把老内容重新拎出来说事。 */
const QUOTE_TAIL_TURNS = 12;

// Chat-binding key: stable id for "this conversation thread". Used as
// session-map key, mirror target, defaultChat. NOT used for auth.
const chatPrincipal = (msg: BaseMessage): string =>
  msg.chattype === "group" && msg.chatid ? `chat:${msg.chatid}` : `user:${msg.from.userid}`;

// 寻址靠 wizard 的**全局名字** `.name` —— 它可能住在任何一个聊天里。
// Must be space-delimited or edge-of-string so paths / extensions like `a.ts`
// survive. 一条消息只认**一个**路由名字, 且**只做前缀匹配**: 清洗之后 (链接标记
// 还原成裸 `.name`、@ 已由 stripAt 剥掉、去掉开头的空白与不可见字符) 落在**消息
// 开头**的那个 `.x` 才是目标 —— 认不认识都算 (不认识 = 叫一个新 wizard 出来)。
// 正文里的 `.fix` / `.gitignore` 一律只是提及, 哪怕名册里真有这个名字。
// 选中的那个 token 从正文里摘掉, 其余 `.foo` 原样留着 (见 peerMentions)。
// Token 规则收在 session-label(nameTokenRe / allNames),路由与标注共用同一把尺子。
const NAME_RE = nameTokenRe();
const LEAD_NOISE_RE = /^[\s​-‍⁠﻿]+/u;
const parseTag = (text: string): { tag: string; cleaned: string } => {
  const lead = unlinkTags(text).replace(LEAD_NOISE_RE, "");
  const m = NAME_RE.exec(lead);
  if (!m || m.index !== 0) return { tag: "", cleaned: text };
  return { tag: m[2] ?? "", cleaned: lead.slice(m[0].length).replace(/[ \t]+/g, " ").trim() };
};

const tagOf = tagOfKey;

/** 名字 → 投递目标。名册 (全局) > 本聊天同名 slot (改名前的老 `#tag` 会话) > 在本聊天
 *  新开一个 slot。纯函数: 新 wizard 的名字由 spawn 时 settleName 按 slot 落定。 */
const resolveName = (base: string, name: string, live: (target: string) => boolean): string => {
  if (!name) return base;
  const rec = wizardStore()?.byName(name);
  if (rec) return rec.target;
  const slot = normalizeTag(name) || "wizard";
  const legacy = keyOf(base, slot);
  if (live(legacy)) return legacy;
  // 这个 slot 已被一个改了名的 (冷) wizard 占着 → 挪到 `slot-N`, 别唤醒别人。
  const taken = new Set((wizardStore()?.all() ?? []).filter((w) => baseOfKey(w.target) === base).map((w) => tagOfKey(w.target)));
  return keyOf(base, uniqueTag(slot, taken));
};

// Auth principals: any-of test against allowFrom. Tiered — allowing a user
// grants them access in any chat; allowing a group grants every member of
// that group access. DMs collapse to just the sender.
const authPrincipals = (msg: BaseMessage): string[] => {
  const user = `user:${msg.from.userid}`;
  if (msg.chattype === "group" && msg.chatid) return [`chat:${msg.chatid}`, user];
  return [user];
};

// "会话id" = chat-binding (session/mirror key); "权限id" = either the group
// OR the sender — allowFrom passes if any one of them is whitelisted.
// Also surfaces per-id 授权状态。
const renderIds = (msg: BaseMessage, cfg: Config): string => {
  const allowed = new Set(cfg.wrc.allowFrom.map((e) => sanitizeId(e)));
  const mark = (id: string): string =>
    allowed.has("all") || allowed.has(id) ? "✅ 已授权" : "❌ 未授权";
  const sender = `user:${msg.from.userid}`;
  if (msg.chattype === "group" && msg.chatid) {
    const chat = `chat:${msg.chatid}`;
    return [
      `群: \`${chat}\` ${mark(chat)}`,
      `发送者: \`${sender}\` ${mark(sender)}`,
      `(allowFrom 任一通过即可)`,
    ].join("\n");
  }
  return `会话id: \`${sender}\` ${mark(sender)}`;
};

const isIdCommand = (text: string): boolean => text.trim() === "/id";
const isPwdCommand = (text: string): boolean => text.trim() === "/pwd";
const isCostCommand = (text: string): boolean => text.trim() === "/cost";
// `/audit` or `/audit <name>`. With a name, `/audit` re-routes to that wizard's
// mirror (global name → target; an old slot id still matches, newest-by-mtime);
// without one, falls back to the caller's own mirror binding.
const parseAuditCommand = (text: string): { tag: string } | undefined => {
  const m = /^\/audit(?:\s+(.+))?$/u.exec(text.trim());
  return m ? { tag: (m[1] ?? "").trim().replace(/^[.#]/, "") } : undefined;
};

interface MirrorRef { sessionId: string; jsonlPath: string; target: string; }
const resolveAuditMirror = (
  mirrors: MirrorRef[],
  tag: string,
  who: string,
  chatWho: string,
): MirrorRef | undefined => {
  if (tag) {
    const named = wizardStore()?.byName(tag)?.target;
    const exact = named ? mirrors.find((m) => m.target === named) : undefined;
    if (exact) return exact;
    const matches = mirrors.filter((m) => tagOfKey(m.target) === tag);
    if (matches.length <= 1) return matches[0];
    return matches
      .map((m) => {
        let mt = 0;
        try { mt = statSync(expandHome(m.jsonlPath)).mtimeMs; } catch { /* ignore */ }
        return { m, mt };
      })
      .sort((a, b) => b.mt - a.mt)[0]?.m;
  }
  return mirrors.find((m) => m.target === who || m.target === chatWho);
};
// `/new [cli] [model] [prompt…]` — 三个位置参数都可选, 从前往后逐个认领: 认得出
// 的 CLI 名吃进后端, 认得出的模型别名吃进 `--model`, 剩下的整段就是新会话的第一
// 句话 (spawn 完再照常走 dispatch 注入)。Bare `/new` 沿用当前会话的 CLI 与该 CLI
// 自己的默认模型 —— 见 newSession 的继承规则, 只有要*换*后端时才需要写出来。
const NEW_RE = /^\/new(?:\s+([\s\S]+))?$/i;
const CLI_TOKEN_RE = /^(claude-internal|claude|codebuddy)$/i;
// `--model` 认的短别名与完整 slug。刻意收得窄: 认不出的一律当正文 —— 把
// `/new 看看 sonnet 贵不贵` 的第一个词吃成模型, 比多打一个词烦得多。
const MODEL_TOKEN_RE = /^(?:default|opus|opusplan|sonnet|haiku|(?:claude|gpt|gemini|deepseek)-[\w.-]+)(?:\[1m\])?$/i;

interface NewCommand { cli?: CliBackendName; model?: string; prompt: string }
const parseNewCommand = (text: string): NewCommand | undefined => {
  const m = NEW_RE.exec(text.trim());
  if (!m) return undefined;
  // 递归吃前缀: 每个槽位只认领一次, 第一个认不出的 token 起整段都是 prompt。
  const claim = (rest: string, acc: NewCommand): NewCommand => {
    const head = /^(\S+)(?:\s+([\s\S]*))?$/.exec(rest);
    if (!head) return acc;
    const [, tok = "", tail = ""] = head;
    if (!acc.cli && CLI_TOKEN_RE.test(tok)) {
      return claim(tail, { ...acc, cli: tok.toLowerCase() as CliBackendName });
    }
    if (!acc.model && MODEL_TOKEN_RE.test(tok)) {
      return claim(tail, { ...acc, model: tok.toLowerCase() });
    }
    return { ...acc, prompt: rest };
  };
  return claim((m[1] ?? "").trim(), { prompt: "" });
};
// `/cfgsync` (alias `/sync`) — reconcile the project's per-CLI config trees.
// Bare form is a dry run; `apply` is the only form that writes.
const CFGSYNC_RE = /^\/(?:cfgsync|sync)(?:\s+(apply))?$/i;
const parseCfgSyncCommand = (text: string): { apply: boolean } | undefined => {
  const m = CFGSYNC_RE.exec(text.trim());
  return m ? { apply: Boolean(m[1]) } : undefined;
};
// `/name` 读, `/name x` 写, `/name -` 摘掉。名字是 chat 级的 —— 带不带 `.name`
// 路由过来都命名同一个聊天, 所以这里不看路由目标。
const NAME_RE_CMD = /^\/name(?:\s+(\S+))?$/i;
const parseNameCommand = (text: string): { arg: string } | undefined => {
  const m = NAME_RE_CMD.exec(text.trim());
  return m ? { arg: m[1] ?? "" } : undefined;
};
// `/chats` — 跨聊天目录: 谁有名字、谁没有、各自跑着哪些会话。
const isChatsCommand = (text: string): boolean => /^\/chats?$/i.test(text.trim());
const isUsageCommand = (text: string): boolean => text.trim() === "/usage";
const isStopCommand = (text: string): boolean => text.trim() === "/stop";
const isKillCommand = (text: string): boolean => text.trim() === "/kill";
const isEnterCommand = (text: string): boolean => text.trim() === "/n";
const isRevealCommand = (text: string): boolean => text.trim() === "/reveal";
const isHelpCommand = (text: string): boolean => /^\/(?:help|\?|h)$/i.test(text.trim());

// Static command reference. Grouped: session control, usage/info. Anything
// not matching a command is a
// prompt forwarded to the bound Claude session.
const renderHelp = (): string =>
  [
    "*wezard 命令*",
    "",
    "▎会话",
    "`/new` 让一个全新的 wizard 就位并绑定本聊天 (沿用当前的 CLI;不继承上下文)",
    "`/new <模型>` 指定模型新开 (opus / sonnet / haiku / 完整 slug)",
    "`/new <问题>` 新开并把这句话作为第一句发过去",
    "`/clear` 清空当前会话上下文 (有待切项目时自动升级为 /new)",
    "`/sessions` 列出本机所有 live 会话 · `/sessions <emoji|id>` 把本聊天改接到某一个",
    "`/stop` 打断当前生成 (Esc)",
    "`/kill` 结束本会话并移除 tmux pane (下条消息自动让新的 wizard 就位)",
    "`/n` 向 CLI 输入回车 (Enter)",
    "`/reveal` 把终端的 tmux 窗口切到本会话",
    "`/wx` 微信 ClawBot: 列出 / `bind` 扫码绑定 (每个微信号 = 一个群聊) / `unbind` (仅审批人)",
    "",
    "▎切换 CLI 后端",
    "`/new codebuddy` 用指定 CLI 新开 (claude / claude-internal / codebuddy)",
    "位置参数可叠:`.docs /new codebuddy opus 先读一遍 README` = 名字 + 后端 + 模型 + 首句。",
    "不写则沿用本会话当前的 CLI;新叫出来的 wizard 继承本聊天的 CLI。",
    "切换后 `/clear`、`/stop`、`--resume` 自愈都仍绑在该 CLI 上。",
    "",
    "▎wizard",
    "每个 wizard 有一个**全局唯一**的名字,写作 `.name`;聊天的默认 wizard 名字就是聊天名。",
    "消息里带 `.name`(如 `.docs 帮我改 README`)就是找那一个 —— 它可以住在任何一个聊天里,",
    "回复会回到你说话的这个群;不带 = 本聊天默认那个。开头写一个还不存在的 `.x` = 在这里叫出一个新的 x。",
    "它们的回复以 `emoji .name` 打头。`/clear .x`、`/pwd .x`、`/stop .x` 同理按名字走。",
    "wizard 知道自己是谁、在哪个目录、还有谁在,也能给自己改名、写职责、记长期记忆、上下文满了自己交接重开。",
    "wizard 之间默认**私聊**,只有需要你知道的才发进群。",
    "",
    "▎分身(clone)",
    "对 AI 说「分个身去干 X」「开三个分身分头处理」即可。分身默认**继承它此刻的上下文** ——",
    "先把公共材料读进来、再分身,材料只读一遍却进了 N 份上下文;要白纸一张就说明白。",
    "分身有自己的 `.name`、自己的终端,也能再生分身。活干完对 AI 说「收掉它们」。",
    "",
    "▎跨聊天",
    "`/name <名字>` 给本聊天起名 · `/name` 查看 · `/name -` 取消",
    "`/chats` 列出所有已知聊天及其 wizard",
    "名字 1-32 位字母/数字/`_`/`-`,全机唯一;它同时就是这里默认 wizard 的名字 (撞名会自动加后缀)。",
    "对 AI 说「让 .fix 看一眼」「在 daily 里开个 .ingest 跑这个目录」即可。",
    "",
    "▎协作",
    "`/peers`(或 `/wizards`) 列出本聊天的 wizard:名字、职责、忙闲、谁是谁的分身",
    "同一聊天里的 wizard 互相看得见也驱动得动,直接说人话:",
    "「看下 `.fix` 的进展,推动它直到结束」— AI 会读它最近的对话、派活、收它的回执直到跑完。",
    "「让 `.fix` 和 `.review` 互相迭代到 review 说 LGTM」— AI 会把它们串成一条循环流水线。",
    "它们之间的往来默认只进各自的 rolepage;需要你知道的 (公开讨论、结论) 才发进群;工单的派活与回执不进群。",
    "",
    "▎信息 (免授权)",
    "`/id` 查看会话/权限 id",
    "`/pwd` 当前项目路径",
    "`/usage` 真实订阅额度 %",
    "`/cost` token/成本估算",
    "`/audit` 本会话 token/成本明细 (含 subagent) · `/audit <名字>` 指定 wizard",
    "`/cfgsync` 预演跨 CLI 项目配置同步 · `/cfgsync apply` 执行 (需授权)",
    "`/help` 本帮助",
    "",
    "▎引用 (quote)",
    "引用消息 + 新文字：被引用内容作为上下文前缀附在你的话前。",
    "纯引用不加字：把被引用内容当正文重发 —— 微信会去重相同文本，",
    "这是重新触发同一条命令 (如 `/usage`) 的唯一方式。",
    "",
    "其余文本直接转发给这个聊天绑定的 wizard。",
  ].join("\n");

// /session(s) [arg] — list live Claude sessions, or switch the mirror to one.
// Bare "/sessions" (or "/session") lists; an arg (animal emoji, sessionId, or
// sessionId prefix) switches. Tolerates an optional trailing "s" and any spacing.
const parseSessionsCommand = (text: string): { arg: string } | undefined => {
  const m = /^\/sessions?(?:\s+(.+))?$/u.exec(text.trim());
  if (!m) return undefined;
  return { arg: (m[1] ?? "").trim() };
};

// Render the scanned session list into a WeCom-friendly markdown block. The
// session currently mirrored to this chat's target (if any) is flagged.
const renderSessionsList = (sessions: SessionInfo[], currentSid: string): string => {
  if (sessions.length === 0) return "[wezard] 未发现正在运行的 Agent 会话";
  // Only annotate the CLI when the list actually spans more than one — with a
  // single backend the tag is pure noise on every row.
  const mixed = new Set(sessions.map((s) => s.cli)).size > 1;
  const lines = sessions.map((s) => {
    const here = s.sessionId === currentSid ? " ⬅️ 当前" : "";
    const dir = s.cwd.replace(/^.*\//, "") || s.cwd || "?";
    const cli = mixed ? ` _(${s.cli})_` : "";
    return `${s.label || "🧙"} \`${s.sessionId.slice(0, 8)}\` ${dir}${cli}${here}`;
  });
  return [
    "[wezard] 正在运行的会话：",
    ...lines,
    "> 切换：`/sessions <emoji 或 id>`，如 `/sessions 🐼`",
  ].join("\n");
};

// /peers — 住在**这个聊天**里的 wizard 名册 (默认那个 + 每个分身)。与 /sessions
// 的区别是范围: /sessions 扫的是整台机器上所有 agent 会话 (包括人在终端里自己开
// 的、与企微无关的), 这里列的是同一个聊天里互相叫得动的那些 —— 同聊天 = 同一个
// 地址空间。名字与职责来自 wizard 注册表, 没登记过的就只显示 tag。
const isPeersCommand = (text: string): boolean => /^\/(?:peers?|agents?|wizards?)$/iu.test(text.trim());

const uniq = (xs: string[]): string[] => [...new Set(xs)];
const dirOf = (p: PeerInfo): string => p.cwd.replace(/^.*\//, "") || p.cwd;

// A field with the same value on every row (project dir, CLI backend) is noise
// repeated N times — hoist those into the header and annotate rows only where
// they actually differ. Rows are blank-line separated so a wrapped summary can't
// visually merge into the next peer.
const renderPeers = (peers: PeerInfo[], chatName: string): string => {
  if (peers.length === 0) return "[wezard] 本聊天还没有 wizard。发消息或 `/new` 让一个就位。";
  const reg = wizardStore();
  const dirs = uniq(peers.map(dirOf));
  const clis = uniq(peers.map((p) => p.cli));
  const shared = [dirs.length === 1 ? dirs[0] : "", clis.length === 1 ? clis[0] : ""].filter(Boolean);
  // 家谱只画直系: 谁是谁的分身。整棵树留给 AI 侧的 wizard_roster —— 群里一行放不下。
  // 每个 tag 都点得开它的 chat 详情页。
  const addrOf = (target: string): string => tagLink(target, `.${displayName(target) || "?"}`);
  const parentAddr = (target: string): string => {
    const p = reg?.get(target)?.parent;
    return p ? addrOf(p) : "";
  };
  const rows = peers.flatMap((p) => {
    const rec = reg?.get(p.target);
    const title = addrOf(p.target);
    const state = !p.paneAlive ? "⚫️ 已关闭" : p.busy ? "🔴 忙" : "🟢 空闲";
    const from = parentAddr(p.target);
    const varies = [
      dirs.length > 1 ? dirOf(p) : "",
      clis.length > 1 ? p.cli : "",
      from ? `分身自 ${from}` : "",
    ].filter(Boolean);
    const me = p.self ? " ⬅️ 本会话" : "";
    return [
      `**${p.label} ${title}** ${state}${varies.length ? ` · ${varies.join(" · ")}` : ""}${me}`,
      ...(rec?.description ? [`　_${truncate(rec.description, 48)}_`] : []),
      `　${truncate(p.summary, 64)}`,
      "", // 行间空行: 没有它, 折行的摘要会和下一个 wizard 糊在一起
    ];
  });
  const named = chatName || peers.find((p) => p.chat)?.chat || "";
  return [
    `[wezard] 本聊天${named ? ` \`${named}\`` : ""}的 wizard · ${peers.length} 个${shared.length ? ` · ${shared.join(" · ")}` : ""}`,
    "",
    ...rows,
    "> 协作：直接说「看下 .fix 的进展并推动它」，AI 会读它最近的对话、派活、收它的回执直到跑完",
    "> 分身：说「分个身去干 X」— AI 会 clone 一个带着当前上下文的 wizard，干完再收掉",
    // 空行只在这一处按需省略 —— 上面那些是有意的分隔, 不能被一把 filter 掉。
    ...(named ? [] : ["> 起名：`/name <名字>` — 聊天名就是这里默认 wizard 的名字"]),
  ].join("\n");
};

// /chats — 跨聊天目录: 每个聊天里住着哪些 wizard (`.name`, 全局可达)。
const renderChats = (
  roster: Array<{ base: string; name: string; self: boolean; targets: string[] }>,
): string => {
  if (roster.length === 0) return "[wezard] 还没有任何聊天在跑会话。";
  const rows = roster.flatMap((c) => {
    const sessions = c.targets.map((t) => tagLink(t, `.${displayName(t) || "?"}`)).join(" · ") || "(无)";
    const head = c.name ? `\`${c.name}\`` : `_(未命名)_ \`${c.base}\``;
    return [`**${head}**${c.self ? " ⬅️ 本聊天" : ""} · ${c.targets.length} 个会话`, `　${sessions}`, ""];
  });
  return [
    `[wezard] 已知的聊天 · ${roster.length} 个`,
    "",
    ...rows,
    "> 寻址：`.名字`（如 `.fix`），全局唯一，在任何群里都叫得到",
  ].join("\n");
};

// Match a switch arg against a scanned session: animal emoji label, full
// sessionId, or a ≥6 char sessionId prefix. Returns the session or undefined.
const matchSession = (sessions: SessionInfo[], arg: string): SessionInfo | undefined =>
  sessions.find((s) => s.label === arg) ??
  sessions.find((s) => s.sessionId === arg) ??
  (arg.length >= 6 ? sessions.find((s) => s.sessionId.startsWith(arg)) : undefined);

// ── @mention 剥离 ──────────────────────────────────────────────────────
// 机器人的显示名由建它的人自己取, 消息体里没有任何字段告诉我们叫什么。所以:
// 一条消息里只认定 **一个** 机器人名, 认定后把全文里同名的 @ 全部剥掉 ——
// 用户一条消息里可能 @ 它好几次, 但不可能有两个不同的机器人。
//
// 候选 token = `@` 之后到下一个空格/行尾为止, 且不含 `/` `\`。机器人名不可能
// 带 slash, 所以 `@src/foo.ts` 这类"喂文件"的路径连候选都进不来 —— 路径优先
// 被识别为路径, 这是整条规则的第一顺位。裸文件名 (`@README.md`) 没有 slash,
// 靠扩展名形状再排一道。
const MENTION_RE = "(^|\\s)@NAME(?=\\s|$)";
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const mentionRe = (name: string): RegExp =>
  new RegExp(MENTION_RE.replace("NAME", escapeRe(name)), "giu");

// 扩展名形状的裸 token: `@README.md` 是文件, 不是人。
const looksLikeFile = (name: string): boolean => /\.[A-Za-z0-9]{1,8}$/u.test(name);

/** 这条消息里的机器人名 —— 第一个不像文件的 @token。 */
const detectBotName = (text: string): string | undefined =>
  [...text.matchAll(new RegExp(MENTION_RE.replace("NAME", "([^\\s/\\\\]+)"), "gu"))]
    .map((m) => m[2] ?? "")
    .find((n) => n && !looksLikeFile(n));

/** 剥掉 `@name` 的每一次出现; 分隔符 (`$1`) 留着, 免得吃掉换行 —— 代价是行尾的
 *  @ 会留下一个孤立空格, 所以收尾再清一遍每行的尾随空白。 */
const stripName = (text: string, name: string): string =>
  text
    .replace(mentionRe(name), "$1")
    .replace(/[^\S\n]{2,}/g, " ")
    .replace(/[^\S\n]+$/gmu, "")
    .trim();

// DMs can't @ a bot — any "@" the user types is content (e.g. "@src/foo.ts"),
// so name detection is group-only. 配置里写死的名字 (`wrc.botNames`) 则任何
// 场景都剥: 单聊里手打 "@wezard /usage" 同样不该漏进 prompt。
const isGroup = (msg: BaseMessage): boolean => msg.chattype === "group" && !!msg.chatid;
const BUILTIN_BOT_NAMES = ["wezard", "weclaude"] as const;

const maybeStripMentions = (names: readonly string[], msg: BaseMessage, text: string): string => {
  const configured = names.find((n) => mentionRe(n).test(text));
  const name = configured ?? (isGroup(msg) ? detectBotName(text) : undefined);
  return name ? stripName(text, name) : text.trim();
};

// Render the user's "引用" (quoted message) into a markdown blockquote so the
// claude prompt carries the upstream context. WeCom delivers `quote` as a
// sibling field on the message body — currently we surface text/voice (already
// transcribed) inline; image/mixed-image/file are rendered as a placeholder
// (download would mean an extra round-trip + clipboard paste, which is too
// heavy for a quote — user can always send the file directly if needed).
const quoteToText = (q: QuoteContent): string => {
  if (q.msgtype === "text") return q.text?.content ?? "";
  if (q.msgtype === "voice") return q.voice?.content ?? "";
  if (q.msgtype === "mixed") {
    return (q.mixed?.msg_item ?? [])
      .map((it) => (it.msgtype === "text" ? it.text?.content ?? "" : "[图片]"))
      .filter(Boolean)
      .join(" ");
  }
  if (q.msgtype === "image") return "[图片]";
  if (q.msgtype === "file") return "[文件]";
  return "";
};
const renderQuotePrefix = (body: string): string => {
  if (!body) return "";
  // Quote each line so multi-line引用渲染整洁; trailing blank line separates
  // from the user's actual message.
  const quoted = body.split("\n").map((l) => `> ${l}`).join("\n");
  return `> [引用]\n${quoted}\n\n`;
};
// Normalize for self-reply quote dedup: WeCom mangles formatting on its quote
// bubble in unpredictable ways — strips backticks, swaps `-` bullets for `·`,
// re-wraps whitespace, sometimes loses inline markdown. Reduce both sides to
// just letters + digits (Unicode + CJK) and compare on that — robust against
// any punctuation/whitespace/markup churn while keeping content fidelity.
const canonForCompare = (s: string): string => s.replace(/[^\p{L}\p{N}]/gu, "");

/** `haystack` 里是否已包含 `needle` 的实质内容。
 *  两边归一化后,从 needle 里等间距抽 N 段 chunk,超过阈值命中即判"已在上下文"。
 *  比整串 substring 更健壮: WeCom 引用气泡可能截断、折叠、加 [查看更多]、重排段落,
 *  全文子串匹配在任何一处断裂就 miss。分段采样只要大部分 chunk 命中就够。 */
const CHUNK_LEN = 32;  // 每段采样长度(canon'd 字符)
const CHUNK_COUNT = 5; // 采样段数
const CHUNK_THRESHOLD = 0.6; // 命中比例阈值

const canonContains = (haystack: string, needle: string): boolean => {
  const a = canonForCompare(haystack);
  const b = canonForCompare(needle);
  if (a.length < 4 || b.length < 6) return false;
  // Fast path: short needle — full substring is cheap and precise
  if (b.length <= CHUNK_LEN * 2) return a.includes(b);
  // Sampled-chunk match: pick evenly-spaced chunks from needle, check presence
  const step = Math.max(1, Math.floor((b.length - CHUNK_LEN) / (CHUNK_COUNT - 1)));
  let hits = 0;
  let total = 0;
  for (let i = 0; i <= b.length - CHUNK_LEN && total < CHUNK_COUNT; i += step, total++) {
    if (a.includes(b.slice(i, i + CHUNK_LEN))) hits++;
  }
  return total > 0 && hits / total >= CHUNK_THRESHOLD;
};

const isLastResponseQuote = (target: string, quoted: string): boolean =>
  canonContains(getLastResponse(target) ?? "", quoted);

// ── 引用即路由 ─────────────────────────────────────────────────────────
// 群里要跟 `.fix` 说话,手打名字太慢 —— 直接引用它的气泡即可。每条出站气泡都
// 带 `emoji .name` 头 (withTagHeader),所以引用文本自带路由信息;用户自己发的
// 行首 `.fix 干活` 同样算数(限行首,否则正文里随手写的 .gitignore 会误判)。
// `body` 是剥掉头/tag 后的净引用内容,用于跟目标 context 比对。
// `tag`   = 路由目标(引用继承的投递 tag)。
// `srcTag` = 引用气泡真正出自哪个会话 —— 仅 bot 气泡可知(反解 `emoji .name` 头)。
//            去重要比对的是「内容在不在源会话」,而非路由目标: 带着引用新建 /
//            改投到别的 tag 时,目标会话是空的,只有源会话里才有那段原文。
//            `srcTag===undefined` 表示源未知(用户自己打的引用),回退到按目标查。
const parseQuote = (q: QuoteContent | undefined): { tag: string; srcTag?: string; body: string } | null => {
  const raw = q ? quoteToText(q).trim() : "";
  if (!raw) return null;
  const head = parseTagHeader(raw);
  if (head.fromBot) return { tag: head.tag, srcTag: head.tag, body: head.body };
  const { tag, cleaned } = parseTag(raw);
  return { tag, body: cleaned };
};

// 一条入站消息的最终「投递目标 tag + 给 claude 的正文」。text / image / mixed
// 三条路径共用,两条规则:
//   1. 引用自带的 tag 决定投递目标;引用之外自己打的 `.name` 优先级更高。
//   2. 引用内容若已经在目标会话的 context 尾部,就只保留上面那层路由绑定、正文
//      丢弃(重复贴回去纯属污染);不在则说明它是真载荷(跨会话转发 / 引同事的
//      消息 / 目标已 `/clear`),照旧渲染成 markdown 引用块。
// 纯引用不打字时,沿用旧的"把引用内容提成正文"重触发路径 —— 但同样只在内容不
// 在目标上下文里时才有意义,否则那只是一次对该会话的空 nudge。
/** 名字 → target ("" = 本聊天默认 wizard)。 */
type Resolve = (base: string, name: string) => string;

const composeInbound = (
  msg: BaseMessage,
  rawBody: string,
  inContext: (target: string, quoted: string) => boolean,
  stripAt: (msg: BaseMessage, text: string) => string,
  resolve: Resolve,
): { text: string; tag: string; promoted: boolean } => {
  const { tag: typed, cleaned } = parseTag(rawBody);
  const q = parseQuote(msg.quote);
  const tag = typed || q?.tag || "";
  // 去重比对的会话: 若引用来自某个 bot 会话(srcTag 已知),查那个源会话 ——
  // 内容天然存在于源的 transcript, 与你把它投到哪个 tag 无关。源未知时(用户自打
  // 的引用 / 改投)回退到路由目标。这修掉了「带引用新建/改投会话时原文被重复注入」。
  const dedupTag = q?.srcTag ?? tag;
  // 剥完头什么都不剩(折叠气泡这类纯 chrome 的引用)⇒ 没有可搬运的内容,只留路由。
  const consumed = !q || !q.body.trim() || inContext(resolve(chatPrincipal(msg), dedupTag), q.body);
  if (cleaned.trim()) {
    return { text: consumed ? cleaned : `${renderQuotePrefix(q.body)}${cleaned}`, tag, promoted: false };
  }
  if (q && !consumed) {
    // 提成正文时也剥一次 @mention,让 "@wezard /usage" → "/usage" 命中命令路径。
    const p = parseTag(stripAt(msg, q.body).trim());
    return { text: p.cleaned, tag: p.tag || tag, promoted: true };
  }
  return { text: cleaned, tag, promoted: false };
};

const isAllowed = (cfg: Config, principals: string[]): boolean => {
  if (cfg.wrc.allowFrom.length === 0) return false;
  // Tolerate invisible chars sneaking into hand-edited config (paste artifacts).
  const allowed = new Set(cfg.wrc.allowFrom.map((e) => sanitizeId(e)));
  // "all" is an explicit opt-in wildcard — anyone can talk to the bot.
  if (allowed.has("all")) return true;
  return principals.some((p) => allowed.has(p));
};

// Mirror mode grants implicit talkback: any chat that's currently a mirror
// target can post back without being in `allowFrom`. A session bound to that
// chat is the authorization signal.
const isMirrorTarget = (bridge: MirrorBridge, who: string): boolean => bridge.hasMirrorTarget(who);

// Sniff extension from magic bytes; falls back to .bin. WeCom doesn't always
// give us a filename for images, and we want claude's Read tool to recognize
// the file (it dispatches on extension).
const sniffExt = (buf: Buffer): string => {
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return ".png";
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return ".jpg";
  if (buf.length >= 6 && buf.subarray(0, 6).toString("ascii").startsWith("GIF8")) return ".gif";
  if (buf.length >= 12 && buf.subarray(0, 4).toString("ascii") === "RIFF" && buf.subarray(8, 12).toString("ascii") === "WEBP") return ".webp";
  if (buf.length >= 12 && buf.subarray(4, 12).toString("ascii") === "ftypheic") return ".heic";
  return ".bin";
};

interface DownloadDeps {
  client: WSClient;
  log: Logger;
  inboxDir: string;
}

/** 下载并解密到 inbox; 落盘名留着原文件名 (没有就按魔数补扩展名) —— agent 靠它认类型。 */
const downloadToInbox = async (
  deps: DownloadDeps,
  url: string,
  aesKey: string | undefined,
  msgid: string,
  index: number,
  attempt = 0,
): Promise<{ path: string; bytes: number } | undefined> => {
  try {
    const { buffer, filename } = await deps.client.downloadFile(url, aesKey);
    const saved = saveToInbox(deps.inboxDir, inboxName(msgid, index, filename || `media${sniffExt(buffer)}`), buffer);
    if ("reason" in saved) {
      deps.log.warn({ bytes: buffer.length, reason: saved.reason }, "media not saved");
      return undefined;
    }
    deps.log.info({ url: url.slice(0, 80), bytes: buffer.length, abs: saved.path }, "media saved");
    return { path: saved.path, bytes: buffer.length };
  } catch (e) {
    deps.log.error({ err: (e as Error).message, attempt }, "media download failed");
    // 一次瞬时超时不该让图凭空消失 —— 再试一次。
    return attempt < 1 ? downloadToInbox(deps, url, aesKey, msgid, index, attempt + 1) : undefined;
  }
};

export const installInboundRouter = (
  client: WSClient,
  cfg: Config,
  log: Logger,
  bridge: MirrorBridge,
  sourcePath: string,
  guardCharter: CharterGuard,
): void => {
  const inboxDir = expandHome(cfg.wrc.mirror.inboxDir);
  // 已知的机器人名只随配置变; 下面所有入站路径共用这一个剥离器。
  const botNames = [...BUILTIN_BOT_NAMES, ...cfg.wrc.botNames.filter(Boolean)];
  const stripAt = (msg: BaseMessage, text: string): string => maybeStripMentions(botNames, msg, text);

  // Render /pwd output from the live attachment + persisted store (bridge.getCwd).
  const renderPwd = (who: string): string => {
    const { runningCwd, pendingCwd, defaultCwd } = bridge.getCwd(who);
    const lines = [`[wezard] 📂 当前项目: \`${runningCwd}\``];
    if (pendingCwd && pendingCwd !== runningCwd) {
      lines.push(`下次切换: \`${pendingCwd}\` (使用 /new 或 /clear 生效)`);
    }
    if (runningCwd !== defaultCwd) lines.push(`(默认: \`${defaultCwd}\`)`);
    if (bridge.cwdUnconfirmed(who)) lines.push("⚠️ 这是默认兜底目录, 还没人确认过 —— 要换就说「切到 /path/to/proj」");
    lines.push("> 切换其他项目: 对 AI 说「切到 /path/to/proj」(`set_workspace` 工具直接换目录重开)");
    return lines.join("\n");
  };

  // Auto-spawn / /new helper. Routes through bridge.newSession
  // which kills the old pane, spawns fresh in pendingCwd ?? runningCwd ??
  // default, attaches, and pushes "📂 当前项目" info to the chat. Returns
  // the user-facing one-line ack. The wizard's global name doubles as the
  // tmux window name so the pane shows readably in the status bar (e.g.
  // `.docs` → window `docs`, not the principal slug).
  // On success there is NO reply: newSession already pushed the single
  // "created + cwd" bubble. Only failures produce user-facing text.
  const spawnSession = async (who: string, cli?: CliBackendName, silent?: boolean, model?: string): Promise<{ err?: string }> => {
    const r = await bridge.newSession(who, displayName(who) || tagOf(who) || who, cli, { silent, model });
    return r.ok ? {} : { err: `[wezard] /new failed: ${r.reason ?? "unknown"}` };
  };

  // 同一 wizard 的两条消息会并发落进 gate,双双判定「未附着」→ 双 spawn,后者
  // newSession 会 kill 掉前者的 pane,前者的 dispatch 再 `--resume` 重生出孤儿
  // pane,消息乱序。spawn 窗口有 3s+(TUI_SETTLE_MS),所以必须按会话串行。
  const spawnQ = new Map<string, Promise<unknown>>();
  const serializeSpawn = <T>(key: string, job: () => Promise<T>): Promise<T> => {
    const next = (spawnQ.get(key) ?? Promise.resolve()).then(job, job);
    spawnQ.set(key, next.catch(() => undefined).finally(() => {
      if (spawnQ.get(key) === next) spawnQ.delete(key);
    }));
    return next;
  };

  // 显式 /new:排队但仍强制重开(用户就是要换一个)。
  // 默认会话先把名字换回聊天名, 再 spawn —— charter 在 spawn 时按名字渲染。
  // 聊天名若被一个静默超过一天的 wizard 占着, 先顶掉它 —— 否则默认会话只能退避成 `-N`。
  const staleDeps: EvictDeps = {
    lastActivity: (t) => bridge.lastActivity(t),
    retire: async (t) => { await bridge.killPane(t); },
  };
  // 新开的 slot 先按人写的名字落名: slot 只是内部 id, 被一个改过名的冷 wizard 占着
  // 时会挪成 `foo-N` —— 名字不该跟着它退避。已有名字的 wizard 不受影响 (claim 不改)。
  const claimAsked = (who: string, asked: string): void => {
    if (asked) wizardStore()?.claim(who, asked);
  };
  const autoSpawnAndAttach = (who: string, asked: string, cli?: CliBackendName, model?: string): Promise<{ err?: string }> =>
    serializeSpawn(who, async () => {
      claimAsked(who, asked);
      const chat = chatNameOf(cfg, who);
      if (chat && !tagOf(who)) {
        const gone = await evictStaleName(wizardStore(), chat, [who], staleDeps);
        if (gone) log.info({ target: gone.target, name: gone.name }, "stale name evicted by /new");
      }
      reclaimChatName(wizardStore(), chat, who);
      return spawnSession(who, cli, false, model);
    });

  // 隐式建会话(新 `.name` 的第一条消息):轮到自己时若前一条已经把会话建好,直接
  // 复用,不再 respawn —— 否则先到的消息会被注入进一个刚被杀掉的 pane。
  const ensureSession = (who: string, asked: string): Promise<{ err?: string }> =>
    serializeSpawn(who, async () => {
      if (bridge.hasMirrorTarget(who)) return {};
      claimAsked(who, asked);
      return spawnSession(who, undefined, true);
    });

  // Prefix user-visible daemon replies with `<emoji> .name`, so a chat hosting
  // several wizards stays visually disambiguated. Emoji is derived from the
  // name (not sessionId) so it stays stable across /clear cycles.
  const withTagPrefix = withTagHeader;
  const replyText = async (frame: WsFrame<BaseMessage>, msg: BaseMessage, who: string, text: string): Promise<void> => {
    try { await client.replyStream(frame, msg.msgid, withTagPrefix(who, text), true); } catch { /* ignore */ }
  };

  // Common gating: claim bootstrap + allowFrom check. Returns true if the
  // caller should stop (claim consumed or message rejected).
  const gate = async (frame: WsFrame<BaseMessage>, msg: BaseMessage, text: string, who: string, asked = ""): Promise<{ stop: boolean }> => {
    const auths = authPrincipals(msg);
    // Bootstrap / allowFrom operations are chat-scoped, not session-scoped;
    // use the chat principal, not the routed wizard — a first-time user typing
    // `.foo hello` still promotes them as `user:xxx` (not `user:xxx#foo`).
    const basePrincipal = chatPrincipal(msg);
    // /id — bypass allowFrom so users can discover their ids before configuring.
    if (isIdCommand(text)) {
      await replyText(frame, msg, who, renderIds(msg, cfg));
      return { stop: true };
    }
    // /help — static command reference. Bypasses allowFrom like /id so a new
    // user can discover the command surface before being authorized.
    if (isHelpCommand(text)) {
      await replyText(frame, msg, who, renderHelp());
      return { stop: true };
    }
    // /pwd — bypass allowFrom too. Read-only project-path lookup.
    if (isPwdCommand(text)) {
      await replyText(frame, msg, who, renderPwd(who));
      return { stop: true };
    }
    // /cost — token / cost ESTIMATE pulled from ~/.claude(-internal)?/projects
    // jsonl transcripts (ccusage-style). Read-only, no session state, so it
    // bypasses allowFrom like /id and /pwd. Real subscription %: use /usage.
    if (isCostCommand(text)) {
      let body: string;
      try {
        body = renderUsageReport(computeUsage());
      } catch (e) {
        body = `[wezard] /cost failed: ${(e as Error).message}`;
      }
      await replyText(frame, msg, who, body);
      return { stop: true };
    }
    // /audit [tag] — per-session cost/token breakdown (main + subagents). We
    // handle it here instead of paste-forwarding to the Claude REPL because
    // (a) tmux paste + Enter is racy for slash commands and often fails to
    // submit, and (b) even when it does, the LLM turn adds 30-40s over what
    // is really just a jsonl read. Read-only, no state — bypasses allowFrom.
    //
    // Tag routing: `/audit <tag>` resolves to the SINGLE most-recently-active
    // mirror whose target carries `#<tag>` (by jsonl mtime), NOT the caller's
    // current session and NOT a sum over all sessions sharing the tag.
    // Untagged form falls back to the caller's own mirror binding.
    const audit = parseAuditCommand(text);
    if (audit) {
      const mirror = resolveAuditMirror(bridge.status().mirrors, audit.tag, who, chatPrincipal(msg));
      let body: string;
      if (!mirror) {
        body = audit.tag
          ? `[wezard] /audit: 未找到 \`.${audit.tag}\` 对应的 Agent 会话。`
          : `[wezard] /audit: 未找到 ${who} 绑定的 Agent 会话。先 \`/new\` 或用 \`wezard mirror\` 绑定后再试。`;
      } else {
        try {
          body = computeAuditReport({
            sessionId: mirror.sessionId,
            jsonlPath: mirror.jsonlPath,
            tag: audit.tag || undefined,
          });
        } catch (e) {
          body = `[wezard] /audit failed: ${(e as Error).message}`;
        }
      }
      await replyText(frame, msg, who, body);
      return { stop: true };
    }
    if (tryConsumeClaim(text, basePrincipal)) {
      log.info({ who: basePrincipal }, "claim consumed — bootstrapping defaultChat + allowFrom");
      try { persistClaim(cfg, sourcePath, basePrincipal); } catch (e) {
        log.error({ err: (e as Error).message }, "persistClaim failed");
      }
      await ackClaim(client, basePrincipal, log);
      await replyText(frame, msg, who, "✅ done");
      return { stop: true };
    }
    // Auto-claim: empty allowFrom + DM ⇒ first sender becomes super admin.
    // Falls through so the same message is also dispatched as a real prompt —
    // user types "hi" and gets both the promotion ack and the assistant reply.
    const isDm = !(msg.chattype === "group" && msg.chatid);
    if (shouldAutoClaim(cfg, isDm)) {
      log.info({ who: basePrincipal }, "auto-claim — empty allowFrom, first DM sender promoted");
      try { persistClaim(cfg, sourcePath, basePrincipal); } catch (e) {
        log.error({ err: (e as Error).message }, "auto-claim persistClaim failed");
      }
      await ackAutoClaim(client, basePrincipal, log);
      // fall through to dispatch
    }
    if (!isAllowed(cfg, auths) && !isMirrorTarget(bridge, who)) {
      log.warn({ from: who, auths }, "drop: not in allowFrom");
      try {
        await client.replyStream(
          frame,
          msg.msgid,
          `未授权\n${renderIds(msg, cfg)}\n请将上述任一权限id加入 config 的 wrc.allowFrom 数组`,
          true,
        );
      } catch { /* ignore */ }
      return { stop: true };
    }
    // Authorized `/wx …` — 微信 ClawBot 绑定管理 (weixin-cmd.ts; 只有审批人、绑定只在单聊)。
    const wxc = parseWxCommand(text);
    const wxh = wxc && wxCommandHandler();
    if (wxc && wxh) {
      await wxh({ sender: `user:${msg.from.userid}`, chat: basePrincipal, reply: (t) => replyText(frame, msg, who, t) }, wxc);
      return { stop: true };
    }
    // Authorized `/usage` — real subscription rate-limit %, scraped from Claude
    // Code's own `/usage` TUI (/cost can only estimate cost/tokens; the true
    // limit % is server-side). Drives a throwaway isolated pane (~10s) → interim
    // ack, then replace with the result.
    if (isUsageCommand(text)) {
      log.info({ who }, "/usage panel: start");
      try { await client.replyStream(frame, msg.msgid, withTagPrefix(who, "⏳ 正在拉起 /usage 面板查询真实额度…"), false); } catch (e) { log.warn({ err: (e as Error).message }, "/usage: interim ack failed"); }
      let body: string;
      try {
        const report = await captureQuota(cfg, log);
        // Wrap in a fenced code block so WeCom renders the aligned panel in a
        // monospace bubble (columns stay lined up).
        body = "```\n" + renderQuotaReport(report) + "\n```";
        log.info({ who, limits: report.limits.length }, "/usage panel: done");
      } catch (e) {
        body = `[wezard] /usage failed: ${(e as Error).message}`;
        log.error({ who, err: (e as Error).message }, "/usage panel: failed");
      }
      await replyText(frame, msg, who, body);
      return { stop: true };
    }
    // Authorized `/new` — spawn a tmux+claude pair and attach it to this chat.
    // Runs BEFORE the mirror-not-attached short-circuit so it works as the
    // very first message from a fresh user. When routed with a `.name`, it
    // picks which wizard (re)spawns; the name is also the tmux window name.
    const nu = parseNewCommand(text);
    if (nu) {
      const { err } = await autoSpawnAndAttach(who, asked, nu.cli, nu.model);
      if (err) {
        await replyText(frame, msg, who, err);
        return { stop: true };
      }
      // 带正文的 `/new`: 这段就是新会话的第一句。走和「隐式建会话后 fall through」
      // 完全相同的 dispatch 路径 —— freshSpawn 的冷时序、peer 提示都在那里。
      if (nu.prompt) await send(frame, msg, who, nu.prompt);
      return { stop: true };
    }
    // Authorized `/stop` — Esc the live pane to interrupt whatever Claude is
    // currently doing. Bails cleanly when no attachment.
    if (isStopCommand(text)) {
      // teardown: /stop is the user's "shut this up" button, so it must also
      // close hanging bubbles and free the inject queue — not just press Esc.
      // Stay silent on a clean stop (the pane going quiet IS the receipt);
      // only speak up when a half actually failed — a live pane that refuses
      // Esc is a very different situation from a chat merely stuck on a bubble.
      const r = await bridge.interruptPane(who, { teardown: true });
      if (!r.ok) {
        await replyText(frame, msg, who, `[wezard] /stop failed: ${r.reason ?? "unknown"}`);
      } else if (!r.escOk) {
        const torndown = r.torndown ? ` · 已收口 ${r.torndown} 个挂起气泡` : "";
        await replyText(frame, msg, who, `⚠️ Esc 未送达（${r.escReason ?? "unknown"}）${torndown} · 保活已暂停`);
      }
      return { stop: true };
    }
    // Authorized `/kill` — end this session for good: Esc the pane, kill it,
    // and drop the binding (no `--resume` resurrection). Routed by `.name` like
    // /stop, so `/kill #docs` only takes down that sibling.
    if (isKillCommand(text)) {
      const r = await bridge.killPane(who);
      await replyText(frame, msg, who, r.ok ? "🗑️ 会话已结束，pane 已移除" : `[wezard] /kill failed: ${r.reason ?? "unknown"}`);
      return { stop: true };
    }
    // Authorized `/n` — send a bare Enter to the live pane. Confirms a prompt /
    // dismisses a "press enter to continue", or submits whatever's already in
    // the input box. Bails cleanly when no attachment.
    if (isEnterCommand(text)) {
      const r = await bridge.submitPane(who);
      await replyText(frame, msg, who, r.ok ? "Enter sent" : `[wezard] /n failed: ${r.reason ?? "unknown"}`);
      return { stop: true };
    }
    // Authorized `/reveal` — switch the attached tmux client to this session's
    // pane so the user lands in the terminal showing the live TUI. Routed by
    // `.name` like any other session command.
    if (isRevealCommand(text)) {
      const r = await bridge.revealPane(who);
      await replyText(frame, msg, who, r.ok ? "✅ 已切到本会话的 tmux 窗口" : `[wezard] /reveal failed: ${r.reason ?? "unknown"}`);
      return { stop: true };
    }
    // /cfgsync [apply] — 3-way merge of the bound project's per-CLI config
    // trees (CLAUDE.md ⇄ CODEBUDDY.md, .claude/{skills,commands,agents} ⇄
    // .codebuddy/...). Writes files, so it sits AFTER the allowFrom gate.
    const cs = parseCfgSyncCommand(text);
    if (cs) {
      const cwd = bridge.getCwd(who).runningCwd;
      let body: string;
      try {
        body = renderSyncReport(await syncProjectConfig(cwd, cs.apply));
      } catch (e) {
        body = `[wezard] /cfgsync failed: ${(e as Error).message}`;
      }
      log.info({ who, cwd, apply: cs.apply }, "/cfgsync");
      await replyText(frame, msg, who, body);
      return { stop: true };
    }
    // /name [x|-] — 给本聊天起名。名字是跨聊天寻址的唯一稳定 key(`daily#fix`),
    // 所以它写进 config.jsonc 而不是运行时 state。改名即覆盖:一个聊天只留一个
    // 名字,一个名字只归一个聊天 —— 两边都唯一,`daily#fix` 才是个确定的地址。
    const nc = parseNameCommand(text);
    if (nc) {
      const cur = chatNameOf(cfg, who);
      if (!nc.arg) {
        await replyText(frame, msg, who, cur
          ? `[wezard] 本聊天名为 \`${cur}\``
          : "[wezard] 本聊天还没起名。`/name <名字>` 起一个。");
        return { stop: true };
      }
      // 聊天名进宪章 (home 群、管家那节的 config_set 路径): 过宪章守卫, 受影响的 wizard 被提醒 handoff。
      if (nc.arg === "-") {
        const { r: gone } = guardCharter(() => clearChatName(cfg, sourcePath, who), (g) => g ? { what: `人 \`/name -\` 取消了聊天名 \`${g}\``, byHuman: true } : undefined);
        await replyText(frame, msg, who, gone ? `[wezard] 已取消命名 \`${gone}\`` : "[wezard] 本聊天本来就没起名。");
        return { stop: true };
      }
      // 聊天名就是默认 wizard 的名字: 人起名即改名 (撞名照 pickName 挂 `-N`), tmux 窗口跟着换。
      const home = baseOfKey(who);
      const { r: [r, wiz] } = guardCharter(() => {
        const r = setChatName(cfg, sourcePath, who, nc.arg);
        return [r, r.ok ? wizardStore()?.rename(home, r.name) : undefined] as const;
      }, ([r]) => r.ok && r.name !== cur ? { what: `人 \`/name ${r.name}\` 把聊天${cur ? ` \`${cur}\`` : ""}改名为 \`${r.name}\``, byHuman: true } : undefined);
      if (wiz) void bridge.retitlePane(home);
      await replyText(frame, msg, who, r.ok
        ? `[wezard] ✅ 本聊天更名为 \`${r.name}\`${cur && cur !== r.name ? `（原 \`${cur}\`）` : ""}${wiz && wiz !== r.name ? `; 默认 wizard 名 \`.${wiz}\` (\`.${r.name}\` 已被占)` : ""}`
        : `[wezard] /name failed: ${r.reason}`);
      return { stop: true };
    }
    // /chats — 跨聊天目录:谁有名字、各自跑着哪些会话。Read-only。
    if (isChatsCommand(text)) {
      await replyText(frame, msg, who, renderChats(bridge.chatRoster(who)));
      return { stop: true };
    }
    // /peers — this chat's own wizard roster (default + siblings), with
    // live busy state. Read-only.
    if (isPeersCommand(text)) {
      let body: string;
      try {
        body = renderPeers(await bridge.peers(who), chatNameOf(cfg, who));
      } catch (e) {
        body = `[wezard] /peers failed: ${(e as Error).message}`;
      }
      await replyText(frame, msg, who, body);
      return { stop: true };
    }
    // /sessions [arg] — list live Claude sessions, or switch the mirror to one.
    // Bare lists; with an arg (emoji / sessionId / ≥6-char prefix) it re-points
    // THIS chat's mirror at the matched session. Reuses the same scan+attach
    // path as the /sessions/switch route so IM and MCP behave identically.
    const sc = parseSessionsCommand(text);
    if (sc) {
      let sessions: SessionInfo[] = [];
      try {
        sessions = await scanClaudeSessions();
      } catch (e) {
        log.error({ err: (e as Error).message }, "/sessions scan failed");
      }
      // Resolve which session is currently mirrored to THIS chat.
      const currentSid = bridge.status().mirrors.find((mm) => mm.target === who)?.sessionId ?? "";
      if (!sc.arg) {
        await replyText(frame, msg, who, renderSessionsList(sessions, currentSid));
        return { stop: true };
      }
      const hit = matchSession(sessions, sc.arg);
      if (!hit) {
        const avail = sessions.map((s) => `${s.label || "🧙"} ${s.sessionId.slice(0, 8)}`).join("、") || "无";
        await replyText(frame, msg, who, `[wezard] 未找到会话 \`${sc.arg}\`。可用：${avail}`);
        return { stop: true };
      }
      if (hit.sessionId === currentSid) {
        await replyText(frame, msg, who, `[wezard] 已经在该会话 ${hit.label} \`${hit.sessionId.slice(0, 8)}\``);
        return { stop: true };
      }
      const att = bridge.attach({ sessionId: hit.sessionId, jsonlPath: hit.jsonlPath, target: who, tmuxPane: hit.tmuxPane, tmuxSession: hit.tmuxSession, cwd: hit.cwd });
      await replyText(
        frame, msg, who,
        att.ok
          ? `✅ 已切到 ${hit.label} \`${hit.sessionId.slice(0, 8)}\` (${hit.cwd})`
          : `[wezard] 切换失败: ${att.reason ?? "unknown"}`,
      );
      return { stop: true };
    }
    // No Claude session attached for this chat yet. Since the
    // sender is already in allowFrom, we treat that authorization as license
    // to auto-spawn: this inbound becomes both the binding signal and the
    // first prompt — attach, then fall through to dispatch.
    if (!bridge.hasMirrorTarget(who)) {
      const { err } = await ensureSession(who, asked);
      if (err) {
        await replyText(frame, msg, who, err);
        return { stop: true };
      }
      // attached — fall through to dispatch
    }
    return { stop: false };
  };

  // 「引用内容是否已经在目标会话的 context 里」。两级:先查刚发出去的最后一条
  // 气泡(内存);miss 再读目标会话 transcript 的尾部若干轮
  // —— 引用的往往是几轮之前的气泡,只比对最后一条会漏。目标未挂载(尚未 attach)
  // 时读不到 transcript,退化成"保留引用",宁可多给上下文。
  const quoteInContext = (target: string, quoted: string): boolean => {
    if (isLastResponseQuote(baseOfKey(target), quoted)) {
      log.info({ target, reason: "lastResponse" }, "quoteInContext: hit");
      return true;
    }
    // 源会话的 last stream 还没收口 ⇒ 引用的是实时中间态 (URL + 最新 CoT/工具行),
    // 只保留路由 tag, 不把瞬态内容贴回 prompt。
    if (bridge.isOpenBubbleQuote(target, quoted)) {
      log.info({ target, reason: "openBubble" }, "quoteInContext: hit");
      return true;
    }
    const mirrors = bridge.status().mirrors;
    const jsonl = mirrors.find((m) => m.target === target)?.jsonlPath;
    if (!jsonl) {
      log.info({ target, mirrorCount: mirrors.length, mirrorTargets: mirrors.map((m) => m.target) }, "quoteInContext: no jsonl for target");
      return false;
    }
    // 有效 tail: keepalive ping/pong 不算轮次,否则挂机后引用的真实气泡被挤出窗口。
    const kc = cfg.wrc.mirror.keepalive;
    const tail = tailTurnsWithTools(jsonl, QUOTE_TAIL_TURNS, keepalivePingSigs(kc.ping));
    const hit = canonContains(tail, quoted);
    log.info({ target, jsonl, tailLen: tail.length, quotedLen: quoted.length, hit }, "quoteInContext: tail check");
    return hit;
  };

  // 路由用掉的那个 `.name` 已被 parseTag 摘走,正文里剩下的每个 `.x` 都可能是
  // 用户在指另一个 wizard。解析走 bridge 自己的 resolvePeerTag —— peer 工具用的
  // 同一套(全局名册),所以标注出来的地址一定是 peek_peer/send_peer 打得中的;
  // 解析不到的 `.foo` 与自指静默略过。
  const peerMentions = (who: string, text: string): PeerMention[] => {
    const mb = bridge;
    const seen = new Set<string>();

    return allNames(text).flatMap((name): PeerMention[] => {
      const r = mb.resolvePeerTag(who, name);
      if (!r.ok || r.target === who || seen.has(r.target)) return [];
      seen.add(r.target);
      const { runningCwd, defaultCwd } = mb.getCwd(r.target);
      return [{
        tag: name,
        target: r.target,
        chat: chatNameOf(cfg, r.target),
        foreign: r.foreign,
        job: wizardStore()?.get(r.target)?.description ?? "",
        cwd: runningCwd || defaultCwd,
      }];
    });
  };

  // 名字 → 它指向谁。哪个 `.x` 是路由不在这里定: parseTag 只认消息开头那一个。
  const live = (t: string): boolean => bridge.hasMirrorTarget(t);
  const resolve: Resolve = (base, name) => resolveName(base, name, live);
  const route = (msg: BaseMessage, raw: string): { text: string; tag: string; promoted: boolean; who: string } => {
    const c = composeInbound(msg, raw, quoteInContext, stripAt, resolve);
    return { ...c, who: resolve(chatPrincipal(msg), c.tag) };
  };

  const send = async (frame: WsFrame<BaseMessage>, msg: BaseMessage, who: string, text: string, images: string[] = []): Promise<void> => {
    // 斜杠命令按行解析,尾巴上多挂一段会让它不再被识别成命令 —— 只标注普通消息。
    const slash = text.trimStart().startsWith("/");
    const hint = slash ? [] : [peerMentionPart(peerMentions(who, text), ((c) => c.runningCwd || c.defaultCwd)(bridge.getCwd(who)))];
    // 谁、在哪个群说的 —— transcript 里只有这一段记着它 (read_chat 从那里读回来)。
    // 住在单聊里、又是在那个单聊里被叫到的, 默认值就是对的, 不挂。
    const channel = chatPrincipal(msg);
    const chat = chatNameOf(cfg, channel);
    const homely = channel === baseOfKey(who) && channel.startsWith("user:");
    const envelope = slash || homely || !chat ? "" : renderHumanEnvelope(msg.from.userid, chat);
    const steward = slash || !stewardTierOf(cfg, who) ? "" : renderStewardHint();
    // 同一条边界上再挂: 点名提示, 以及这个 wizard 不在场时群里发生的成员变动 (见 notices.ts,
    // 近几次注入里给过的不再重复)。
    const notice = noticeSuffixFor(who, text, { human: { channel } }, hint);
    try {
      // 回复回到发话的这个群 —— `who` 可能住在别的聊天 (名字全局可达)。
      await bridge.dispatch({ principal: who, text: text + envelope + steward + notice, images, frame, streamId: msg.msgid, channel, speaker: `user:${msg.from.userid}` });
    } catch (e) {
      log.error({ err: (e as Error).message }, "bridge dispatch failed");
      try { await client.replyStream(frame, msg.msgid, withTagHeader(who, `[wezard] error: ${(e as Error).message}`), true); } catch { /* ignore */ }
    }
  };

  client.on("message.text", async (frame: WsFrame<TextMessage>) => {
    const msg = frame.body;
    if (!msg) return;
    const { text, tag, promoted, who } = route(msg, stripAt(msg, msg.text?.content ?? ""));
    log.info({ msgid: msg.msgid, len: text.length, tag, hasQuote: !!msg.quote, promoted }, "rx text");
    const { stop } = await gate(frame, msg, text, who, tag);
    if (stop) return;
    await send(frame, msg, who, text);
  });

  client.on("message.image", async (frame: WsFrame<ImageMessage>) => {
    const msg = frame.body;
    if (!msg) return;
    log.info({ msgid: msg.msgid, hasQuote: !!msg.quote }, "rx image");
    // Images carry no text of their own — the quote (if any) is the only
    // routing signal; without it they land on the chat's default session.
    const { text, tag, who } = route(msg, "");
    const { stop } = await gate(frame, msg, "", who, tag);
    if (stop) return;
    const path = (await downloadToInbox({ client, log, inboxDir }, msg.image.url, msg.image.aeskey, msg.msgid, 0))?.path;
    if (!path) {
      try { await client.replyStream(frame, msg.msgid, "[wezard] 图片下载失败", true); } catch { /* ignore */ }
      return;
    }
    // Pass the path through the bridge's `images` channel — mirror mode pumps
    // each via macOS clipboard + Ctrl+V into the live TTY (matches Claude
    // Code's documented image paste flow → image content block, no Read tool
    // turn). Spawn-mode falls back to `@<path>` automatically.
    await send(frame, msg, who, text, [path]);
  });

  client.on("message.mixed", async (frame: WsFrame<MixedMessage>) => {
    const msg = frame.body;
    if (!msg) return;
    log.info({ msgid: msg.msgid, items: msg.mixed?.msg_item?.length, hasQuote: !!msg.quote }, "rx mixed");
    // Concatenate all text items to sniff a routing `.name`, then strip it from
    // the effective body before forwarding to Claude.
    const rawText = (msg.mixed?.msg_item ?? [])
      .filter((it) => it.msgtype === "text")
      .map((it) => (it as { text?: { content?: string } }).text?.content ?? "")
      .join("\n");
    const { tag, who } = route(msg, stripAt(msg, rawText));
    const { stop } = await gate(frame, msg, "", who, tag);
    if (stop) return;
    const texts: string[] = [];
    const images: string[] = [];
    let imgIdx = 0;
    let lost = 0;
    for (const item of msg.mixed?.msg_item ?? []) {
      if (item.msgtype === "text" && item.text?.content) {
        const t = stripAt(msg, item.text.content);
        if (t) texts.push(t);
      } else if (item.msgtype === "image" && item.image?.url) {
        const path = (await downloadToInbox(
          { client, log, inboxDir },
          item.image.url,
          item.image.aeskey,
          msg.msgid,
          imgIdx++,
        ))?.path;
        if (path) images.push(path); else lost++;
      }
    }
    // 丢图不能静默: agent 得知道它少看了东西 (回复里会带给人)。不另开 replyStream ——
    // 那条流 (msgid) 留给 bridge 回这一轮, 提前 finish 会把它掐掉。
    if (lost) texts.push(`[${lost} 张图片下载失败, 未能附上 —— 请让发送者重发]`);
    if (texts.length === 0 && images.length === 0 && !msg.quote) return;
    // Re-compose on the per-item stripped text: drops the routing `.name` (it was
    // consumed above; leaving it in would leak into Claude) and attaches the
    // quote only when it isn't already in the target's context.
    await send(frame, msg, who, composeInbound(msg, texts.join("\n"), quoteInContext, stripAt, resolve).text, images);
  });

  // 文件 / 视频 (企微只在单聊里推): 落进 inbox, 以一行 `[文件: 路径 (大小)]` 注入 —— 不走剪贴板,
  // agent 按需用 Read / Bash 去读。路由与 image 同理: 没有正文, 只有引用能带 `.name`。
  const onAttachment = (kind: "file" | "video", pick: (m: FileMessage | VideoMessage) => { url: string; aeskey?: string }) =>
    async (frame: WsFrame<FileMessage | VideoMessage>): Promise<void> => {
      const msg = frame.body;
      if (!msg) return;
      log.info({ msgid: msg.msgid, kind, hasQuote: !!msg.quote }, `rx ${kind}`);
      const { text, tag, who } = route(msg, "");
      const { stop } = await gate(frame, msg, "", who, tag);
      if (stop) return;
      const { url, aeskey } = pick(msg);
      const got = await downloadToInbox({ client, log, inboxDir }, url, aeskey, msg.msgid, 0);
      // 丢了也照样告诉 agent (同 mixed): 那条流留给 bridge 回这一轮。
      const line = got ? attachmentLine(kind, got.path, got.bytes) : `[对方发来一个${kind === "file" ? "文件" : "视频"}, 下载失败 —— 请让发送者重发]`;
      await send(frame, msg, who, [text, line].filter(Boolean).join("\n"));
    };
  client.on("message.file", onAttachment("file", (m) => (m as FileMessage).file));
  client.on("message.video", onAttachment("video", (m) => (m as VideoMessage).video));

  // 语音: 企微只给转写文本, 拿不到音频 —— 当文字走, 标明是转写 (可能有错字)。
  client.on("message.voice", async (frame: WsFrame<VoiceMessage>) => {
    const msg = frame.body;
    if (!msg) return;
    const heard = (msg.voice?.content ?? "").trim();
    log.info({ msgid: msg.msgid, len: heard.length }, "rx voice");
    const { text, tag, who } = route(msg, heard);
    const { stop } = await gate(frame, msg, text, who, tag);
    if (stop) return;
    await send(frame, msg, who, text ? `[语音转写] ${text}` : "[对方发来一段语音, 没有转写文本]");
  });

  // template_card_event is handled in approval module; no listener here.
};
