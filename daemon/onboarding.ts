// 新群引导 (人 2026-11-16 拍板 + 2026-11-17 两次改口径): bot 被拉进新群后由一个**真实
// 的引导会话** (base#guide 化身) 在群里对话式引导, 只落一件事 —— 管家的 workspace。
// 人 2026-11-17 第二次改口径: 「工作区设置以后, 其实就等同于绑定了一个 wizard 管家,
// 就应该退出引导了」: 一给合法目录, daemon 就在本群 untagged 锚点新建管家 (kind
// steward + workspace, 自动中性名) 并写 chatPolicy.<base>.steward, 状态机一步终结、
// 系统行确认、引导化身当场收掉; 名字后置给 /name。人 2026-11-17 拍板 <role, workspace>
// 唯一确定身份 —— 给的目录上已有本 bot 的管家身份就绑它 (每群一条隔离化身, 职责/记忆随
// 身份复用), 没有才新建; 名字入口照旧。两条入口按形状区分: 目录以 / 或 ~ 起头, 名字不含 /。
// 引导是强制的: 不设跳过、不设超时。daemon 是状态机主人: 判定/校验/落盘/强制全在
// 这里与 guideGate, 引导化身只负责表达 —— 它没有工具面 (宪章不发、审批层全拒、改
// 运行形态的路由按引导异常收尸, 见 guideRefusal), 绝不会 handoff / set_workspace 自己。
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { ChatPolicy, type Config } from "../shared/config.js";
import { patchJsonc } from "../shared/config-writer.js";
import { expandHome } from "../shared/paths.js";
import { baseOfKey, keyOf, tagOfKey, uniqueTag } from "../shared/session-label.js";
import { parse } from "acorn";
import { EXEC_SHELLS, execToolRefusal, shortToolOf } from "./exec-surface.js";
import { instanceName, validClassName } from "./classes.js";
import { appointedChannelSteward, appointedSteward, localManifestation, stewardsAt } from "./steward.js";
import { foldName, identityOf, type WizardRecord, type WizardStore } from "./wizard.js";
import { channelOf, postsOfChannel } from "./channel-posts.js";
import { DAEMON, applyOp, holderOf, leaveOps, msgIdOf, openDuties, sameWho, whoKey, type MsgRow, type RoomOp, type RoomState, type Who } from "../shared/room.js";

export type OnboardingStep = "workspace";

export interface OnboardingState {
  step: OnboardingStep;
}

/** 引导是否该接管这个群: 机器已认领 + 群 principal + 没绑管家 + 没有 untagged 默认会话
 *  (存量群 / 已引导群走老路 —— 绑定一落盘本判定即转 false, 不需要完成标记)。
 *  单聊 (user:*) 不引导: 人私聊的默认接待 = 全局管家 (v3 §3)。频道会走到这里: 桥接帧的 base 是
 *  chat:<topic_id>, 企微原生帧 (compat_info.source=channel) 的 base 是**每个帖子自己的** chat:opk…
 *  —— 后者经 channel-posts 配上频道后按频道键查绑定: 同频道任一帖子绑过, 其余帖子不再引导
 *  (人 2026-11-17 拍板: 整个频道一个管家); 配不上频道的帖子按普通群判。 */
export const needsOnboarding = (cfg: Config, store: WizardStore | undefined, base: string): boolean =>
  !!cfg.defaultChat
  && base.startsWith("chat:")
  && !appointedChannelSteward(cfg, base)
  && !appointedSteward(cfg, base)
  && !store?.get(base);

/** 与 wizard 名字同一套字符集 (wizard 地址语法: 不能含 # / : 与空白)。 */
export const WIZARD_NAME_RE = /^[\p{L}\p{N}_-]{1,32}$/u;

// ── 引导会话 ──────────────────────────────────────────────────────────
// 引导化身是 base#guide 这个 tagged slot —— 绝不占 untagged 记录: 那是「该群管家
// 锚点」的保留位 (新建管家时引导会写它)。slot 被人手开的同名 wizard 占着时退到
// guide-2 …, 不借用人家的会话; 认它只认「职责标记 + guide 系 slot」双证。

/** 引导化身记录的职责标记 —— 收尸与工具面收窄都认它。 */
export const GUIDE_DESC = "新群引导";
const GUIDE_SLOT = "guide";
const GUIDE_SLOT_RE = /^guide(?:-\d+)?$/;
/** 这条记录是不是引导化身 (职责标记 + guide 系 slot 双证)。人手开的 .guide 没有标记, 不认。 */
export const isGuideManifestation = (rec: WizardRecord | undefined): boolean =>
  !!rec && rec.description === GUIDE_DESC && GUIDE_SLOT_RE.test(tagOfKey(rec.target));
/** 这个群现有的引导化身 target ("" = 没有)。 */
export const guideOf = (store: WizardStore | undefined, base: string): string =>
  store?.all().find((r) => baseOfKey(r.target) === base && isGuideManifestation(r))?.target ?? "";
/** 这个群的引导化身该落在哪: 已有就是它; 否则 base#guide, 被别的记录占着就挂 -N。 */
export const guideTargetOf = (store: WizardStore | undefined, base: string): string => {
  const have = guideOf(store, base);
  if (have) return have;
  const taken = new Set((store?.all() ?? []).filter((r) => baseOfKey(r.target) === base).map((r) => tagOfKey(r.target)).filter(Boolean));
  return keyOf(base, uniqueTag(GUIDE_SLOT, taken));
};

/** 引导化身的工具面 = 白名单三项 (2026-11-20): 在 room 里说话 (chat_reply / chat_say, 只限本群
 *  room) + 一次受控绑定 (onboard_bind)。其余一律拒 —— 尤其 handoff / set_workspace / spawn /
 *  delegate 这类改自己运行形态或另起会话的 (2026-11-17 teststrict 实录: 引导化身把「设置工作区
 *  为 …」当成自己的事, set_workspace + handoff self 后留在群里「等指令」)。 */
export const GUIDE_TOOLS: ReadonlySet<string> = new Set(["chat_reply", "chat_say", "onboard_bind"]);

export { EXEC_SHELLS, shortToolOf };

/** 引导会话的代码执行外壳 (REPL) 里只许调白名单三件 —— 下钻在 daemon/exec-surface.ts
 *  (与 monitor 共用同一份 AST 解析; 这里只给拒绝文案)。 */
const execRefusal = (what: string): string =>
  "引导会话的代码执行外壳 (REPL) 里只许调 chat_reply / chat_say (本群 room) / onboard_bind 三件工具 (入参直接写对象字面量), 脚本里的其它调用 ("
  + what + ") 一律拒 —— 要说话用 chat_reply / chat_say, 定目录 / 起名用 onboard_bind。";

/** 一个 REPL 脚本是否只调了引导的白名单工具 ("" = 可以放; 否则 = 拒的理由)。 */
export const guideExecRefusal = (code: unknown): string => execToolRefusal(code, GUIDE_TOOLS, execRefusal);

/** 引导化身调了某个工具 / 路由时的拒绝理由 ("" = 不是引导化身, 或用的是白名单里的那三件)。
 *  toolInput 只在代码执行外壳 (EXEC_SHELLS) 下用得上 —— 那时放行与否看脚本里实际调了什么。 */
export const guideRefusal = (rec: WizardRecord | undefined, action: string, toolInput?: unknown): string => {
  if (!isGuideManifestation(rec)) return "";
  const short = shortToolOf(action);
  if (GUIDE_TOOLS.has(short)) return "";
  if (EXEC_SHELLS.has(short)) {
    const code = toolInput !== null && typeof toolInput === "object" ? (toolInput as { code?: unknown }).code : undefined;
    return guideExecRefusal(code);
  }
  return "引导会话只有 chat_reply / chat_say (本群 room) / onboard_bind 三件工具 (" + action + " 被拒): 话用 chat_reply / chat_say 说进 room, 目录与绑定用 onboard_bind 交给 daemon, 不要调别的工具或命令。";
};

// ── 在途状态 ──────────────────────────────────────────────────────────
// <stateDir>/onboarding.json 只记**还没走完**的群; 走完的凭据是 config 里的绑定,
// 不在状态里 —— crash / reload 后凭 config 就能接着判, 状态只是断点续传。
const statePath = (cfg: Config): string => join(expandHome(cfg.daemon.stateDir), "onboarding.json");

const readStates = (cfg: Config): Record<string, OnboardingState> => {
  try {
    const raw: unknown = JSON.parse(readFileSync(statePath(cfg), "utf8"));
    const out: Record<string, OnboardingState> = {};
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
        if (v && typeof v === "object" && (v as OnboardingState).step === "workspace") out[k] = { step: "workspace" };
      }
    }
    return out;
  } catch { return {}; }
};

export interface OnboardingStore {
  /** 在途引导; 不在途 = undefined。 */
  get(base: string): OnboardingState | undefined;
  /** 进入 (或继续) 引导, 返回当前步。 */
  begin(base: string): OnboardingStep;
  /** 绑定落盘后清掉在途状态。 */
  finish(base: string): void;
}

export const loadOnboardingStore = (cfg: Config): OnboardingStore => {
  const db = readStates(cfg);
  const save = (): void => {
    try {
      mkdirSync(dirname(statePath(cfg)), { recursive: true });
      writeFileSync(statePath(cfg), JSON.stringify(db, null, 2) + "\n");
    } catch { /* 断点续传是锦上添花, 写失败不挡引导本身 */ }
  };
  return {
    get: (b) => db[b],
    begin: (b) => { db[b] = db[b] ?? { step: "workspace" }; save(); return db[b]!.step; },
    finish: (b) => { if (db[b]) { delete db[b]; save(); } },
  };
};

// ── 纯输入解析 ────────────────────────────────────────────────────────

/** 人给的 workspace: 展开 ~、剥引号; 必须存在且是目录。 */
export const validateWorkspace = (raw: string): { ok: true; abs: string } | { ok: false; reason: string } => {
  const p = expandHome((raw ?? "").trim().replace(/^["']+|["']+$/g, ""));
  if (!p.startsWith("/")) return { ok: false, reason: "要绝对路径 (可 ~ 开头)" };
  let st: ReturnType<typeof statSync>;
  try { st = statSync(p); } catch { return { ok: false, reason: p + " 不存在" }; }
  if (!st.isDirectory()) return { ok: false, reason: p + " 不是目录" };
  return { ok: true, abs: p };
};

export type OnboardingInput =
  | { kind: "workspace"; path: string }
  | { kind: "command" }
  | { kind: "names"; names: string[] }
  /** 不是「一步答案」: 交引导化身按 room 流程问清楚 / 用 onboard_bind 办。 */
  | { kind: "sentence" };

// 快路径只收**整句答案** (2026-11-20 重做): 旧版从长句里抽第一个路径片段 ——
// 「在 ~/develop/Tencent 下创建一个 dhtpm 的目录, 并在里面初始化 codebuddy.md, 然后绑定它为
// workspace」被读成父目录 ~/develop/Tencent, 0.5s 内就绑了管家, 人真正要的三件事全丢, 触发
// 绑定的那句话还被吞掉。现在整句 (strip @ / 首尾引号 / 尾标点) 就是一个路径、或就是一个名字
// token 才算答案; 含路径但还有别的话、相对路径、什么都认不出 —— 一律 {kind:"sentence"}。
const TAIL_PUNCT_RE = /[.,;:!?'"”’。，；：！？、…]+$/u;
const QUOTE_EDGE_RE = /^["'“”‘’]+|["'“”‘’]+$/gu;

/** 整句是不是一个路径: / 或 ~ 起头; 带引号的允许空格, 否则不许有空白。 */
const wholePathOf = (text: string, wasQuoted: boolean): string =>
  /^[/~]/.test(text) && (wasQuoted || !/\s/.test(text)) ? text : "";

/** 整句 → 一步答案 (纯路径 / 纯名字), 否则 sentence。 */
export const answerOf = (raw: string): Exclude<OnboardingInput, { kind: "command" }> => {
  const original = (raw ?? "").trim();
  const quoted = /^["'“”‘’].*["'“”‘’]$/u.test(original);
  const text = original.replace(QUOTE_EDGE_RE, "").replace(TAIL_PUNCT_RE, "").trim();
  if (!text) return { kind: "sentence" };
  const path = wholePathOf(text, quoted);
  if (path) return { kind: "workspace", path };
  if (!/\s/.test(text) && WIZARD_NAME_RE.test(text)) return { kind: "names", names: [text] };
  return { kind: "sentence" };
};

/** 引导期的一句人话归哪类: 斜杠命令 / 一步答案 / 别的 (交引导化身)。行首 / 的既可能是命令也可
 *  能是绝对路径 —— 首 token 是存在的目录或带第二段 (/Users/x) 就按路径, 否则 (/new) 是命令。 */
export const classifyOnboardingInput = (raw: string): OnboardingInput => {
  const text = (raw ?? "").trim();
  if (text.startsWith("/")) {
    const head = text.split(/\s+/)[0] ?? "";
    const pathish = /^\/[^/\s]+\//.test(head) || validateWorkspace(head).ok;
    if (!pathish) return { kind: "command" };
  }
  return answerOf(text);
};

/** 引导里的 workspace 校验: 缺省必须已存在; create 时允许 mkdir **最后一级** (父目录必须已存在,
 *  目标必须在 $HOME 下, 已存在就当普通目录)。~ 开头先展开。 */
export const validateOnboardingWorkspace = (
  raw: string,
  opts: { create?: boolean } = {},
): { ok: true; abs: string; created: boolean } | { ok: false; reason: string } => {
  // 相对路径一律拒 (resolve 会把它接到 daemon 的 cwd 上, 撞巧了就成了一个真目录)。
  const rawPath = (raw ?? "").trim().replace(/^["']+|["']+$/g, "");
  if (!(rawPath.startsWith("/") || rawPath === "~" || rawPath.startsWith("~/"))) return { ok: false, reason: "要绝对路径 (可 ~ 开头)" };
  const abs = resolve(expandHome(rawPath));
  if (!opts.create) {
    const v = validateWorkspace(abs);
    return v.ok ? { ok: true, abs: v.abs, created: false } : v;
  }
  const home = resolve(homedir());
  if (abs !== home && !abs.startsWith(home + "/")) return { ok: false, reason: "create 只允许在 $HOME 下建 (" + abs + " 在 " + home + " 之外)" };
  const parent = dirname(abs);
  let pst: ReturnType<typeof statSync>;
  try { pst = statSync(parent); } catch { return { ok: false, reason: "父目录 " + parent + " 不存在 (create 只建最后一级)" }; }
  if (!pst.isDirectory()) return { ok: false, reason: parent + " 不是目录" };
  const cur = statSync(abs, { throwIfNoEntry: false });
  if (cur) return cur.isDirectory() ? { ok: true, abs, created: false } : { ok: false, reason: abs + " 已存在且不是目录" };
  try { mkdirSync(abs); } catch (e) { return { ok: false, reason: "建不出来: " + (e as Error).message }; }
  return { ok: true, abs, created: true };
};

// ── 判定 + 写入 ───────────────────────────────────────────────────────

/** 绑定的是**身份**不是某一条化身 (人 2026-11-23): name 落绑定 (类命中 = 类名),
 *  identity 是身份 id (类 id / 普通身份 id), 本 room 的化身由 applyOnboarding 落定解析。
 *  target 只作「身份锚点在哪」的线索 (推工作区用), **绝不再拿去 join 别的 room**。 */
export type OnboardingVerdict =
  | { kind: "retry"; reason: string }
  | { kind: "bind-new"; workspace: string }
  | { kind: "bind-existing"; name: string; target: string; identity?: string; classId?: string };

/** 一句非命令人话 → 该做什么 (纯判定, 不写盘)。名字只认本 bot 名册里的已有身份,
 *  且排除引导化身本身。目录上已有管家身份 (<role, workspace> 唯一) 就绑它, 没有才新建 ——
 *  cwdOf 给「没写 workspace 的管家」判它现在的活目录。
 *  命中是**类**时绑类名 (不是锚点实例名) —— 同一个类在不同 room 要各用各的实例。 */
export const judgeOnboarding = (store: WizardStore | undefined, base: string, input: Exclude<OnboardingInput, { kind: "command" | "sentence" }>, cwdOf: (target: string) => string = () => ""): OnboardingVerdict => {
  /** 一条身份记录 → verdict: 类是类名 + classId, 其余是身份名。 */
  const bindOf = (rec: WizardRecord): OnboardingVerdict => {
    const identity = identityOf(rec);
    const cls = store?.classes?.get(identity);
    return { kind: "bind-existing", name: cls ? cls.name : rec.name, target: rec.target, identity, ...(cls ? { classId: cls.id } : {}) };
  };
  if (input.kind === "workspace") {
    const v = validateWorkspace(input.path);
    if (!v.ok) return { kind: "retry", reason: "目录不行: " + v.reason };
    const hits = stewardsAt(store, base, v.abs, cwdOf);
    if (hits.length === 1) return bindOf(hits[0]!);
    if (hits.length > 1) return { kind: "retry", reason: "目录 " + v.abs + " 上已有多个管家: " + hits.slice(0, 5).map((h) => h.name).join(" / ") + " — 回复其中一个的名字" };
    return { kind: "bind-new", workspace: v.abs };
  }
  // 人给的是实例名 / 身份名: 落它的身份 (类实例 → 类名, 本 room 的实例落定时再解析)。
  const hit = input.names.map((n) => store?.byName(n)).find((r) => r && !isGuideManifestation(r));
  if (hit) return bindOf(hit);
  // 人直接给类名 (类名不在 wizard 名册里, 在类表)。
  const cls = input.names.map((n) => store?.classes?.byName(n)).find((c) => !!c);
  if (cls) return { kind: "bind-existing", name: cls.name, target: cls.id, identity: cls.id, classId: cls.id };
  return { kind: "retry", reason: input.names.length ? "没认出目录, 名册里也没有叫 " + input.names.slice(0, 3).join(" / ") + " 的管家" : "没认出目录或管家名字" };
};

/** 把频道管家写进 config (热): wrc.channel.steward.<topic_id>, 顺手删掉 clear 里各帖子的
 *  chatPolicy.<帖子>.steward —— 同频道只留一个管家 (人 2026-11-17)。宪章守卫由调用方包。 */
export const bindChannelSteward = (cfg: Config, sourcePath: string, topicId: string, name: string, clear: string[] = []): void => {
  cfg.wrc.channel.steward = { ...(cfg.wrc.channel.steward ?? {}), [topicId]: name };
  const dropSteward = (p: ChatPolicy): ChatPolicy => Object.fromEntries(Object.entries(p).filter(([k]) => k !== "steward")) as ChatPolicy;
  cfg.chatPolicy = Object.fromEntries(Object.entries(cfg.chatPolicy ?? {}).map(([b, p]) => [b, clear.includes(b) ? dropSteward(p) : p]));
  patchJsonc(sourcePath, [{ path: ["wrc", "channel", "steward", topicId], value: name }]);
  // 删项逐条: 文件里没有这一项 (只在内存 / secrets 里) 时 jsonc 删除会抛, 不能连累上面那条绑定。
  for (const b of clear) {
    try { patchJsonc(sourcePath, [{ path: ["chatPolicy", b, "steward"], value: undefined }]); } catch { /* 文件里本就没有 */ }
  }
};

/** 写频道名 (热): wrc.channel.name.<topic_id>。空名 = 清掉 (回落旧标签 / topic_id 前 8 位)。
 *  不进宪章, 不用守卫。 */
export const setChannelName = (cfg: Config, sourcePath: string, topicId: string, name: string): void => {
  const clean = name.trim().replace(/\s+/g, " ");
  const rest = Object.fromEntries(Object.entries(cfg.wrc.channel.name ?? {}).filter(([k]) => k !== topicId));
  cfg.wrc.channel.name = clean ? { ...rest, [topicId]: clean } : rest;
  try { patchJsonc(sourcePath, [{ path: ["wrc", "channel", "name", topicId], value: clean || undefined }]); }
  catch (err) { if (clean) throw err; /* 清除时文件里本就没有这一项 */ }
};

/** 频道级收口: base 认得出频道时, 散落在各帖子的 chatPolicy.<帖子>.steward 并成频道表一条 ——
 *  频道已绑就只清帖子级残留; 没绑就把帖子级里最早出生的那个身份升格。什么都不用做 = undefined。 */
export const settleChannelSteward = (cfg: Config, store: WizardStore | undefined, sourcePath: string, base: string): { topicId: string; name: string; cleared: string[] } | undefined => {
  const topicId = channelOf(cfg, base);
  if (!topicId) return undefined;
  const local = [...new Set([base, ...postsOfChannel(cfg, topicId)])].filter((b) => appointedSteward(cfg, b));
  if (!local.length) return undefined;
  const bornOf = (b: string): number => store?.byName(appointedSteward(cfg, b))?.bornAt ?? Number.MAX_SAFE_INTEGER;
  const name = appointedChannelSteward(cfg, base) || appointedSteward(cfg, local.slice().sort((a, b) => bornOf(a) - bornOf(b))[0]!);
  bindChannelSteward(cfg, sourcePath, topicId, name, local);
  return { topicId, name, cleared: local };
};

/** 把管家绑定写进 config (热): chatPolicy.<base>.steward; 频道帖子 / 频道本身改落频道表。宪章守卫由调用方包。 */
export const bindSteward = (cfg: Config, sourcePath: string, base: string, name: string): void => {
  const topicId = channelOf(cfg, base);
  if (topicId) return bindChannelSteward(cfg, sourcePath, topicId, name, appointedSteward(cfg, base) ? [base] : []);
  const policy = cfg.chatPolicy ?? {};
  const cur = policy[base] ?? ChatPolicy.parse({});
  cfg.chatPolicy = { ...policy, [base]: { ...cur, steward: name } };
  patchJsonc(sourcePath, [{ path: ["chatPolicy", base, "steward"], value: name }]);
};

/** 迁移后管家绑定一律存**类名** (人 2026-11-18): 把 chatPolicy.<b>.steward 与
 *  wrc.channel.steward.<t> 里等于某个旧名 (aliases 的 from) 的值改写成类名。
 *  幂等: 类名不在 from 表里, 第二次跑不再命中。返回改了几处。 */
export const rewriteStewardBindings = (
  cfg: Config,
  sourcePath: string,
  aliases: ReadonlyArray<{ from: string; to: string }>,
): number => {
  if (!aliases.length) return 0;
  const map = new Map(aliases.map((a) => [a.from.trim().toLowerCase(), a.to]));
  let n = 0;
  for (const [b, p] of Object.entries(cfg.chatPolicy ?? {})) {
    const cur = (p?.steward ?? "").trim();
    const to = cur ? map.get(cur.toLowerCase()) : undefined;
    if (to) { bindSteward(cfg, sourcePath, b, to); n += 1; }
  }
  for (const [t, s] of Object.entries(cfg.wrc.channel.steward ?? {})) {
    const cur = (s ?? "").trim();
    const to = cur ? map.get(cur.toLowerCase()) : undefined;
    if (to) { bindChannelSteward(cfg, sourcePath, t, to); n += 1; }
  }
  return n;
};

export interface OnboardingBound {
  /** 绑进 config 的名字: 类命中 = 类名, 否则身份名。 */
  name: string;
  /** **本 room** 的化身 target —— room 交接用它找 uid; 已按 room 解析, 不会指别的 room。 */
  target: string;
  workspace: string;
  fresh: boolean;
  /** 绑的是类 (人 2026-11-23): 同一个类在不同 room 各用各的实例。 */
  classId?: string;
  /** 有类时本 room 实例的名字 (类名-序号)。 */
  instance?: string;
  /** 本 room 的实例是这次绑定**新领号开的** (false / 缺省 = 本 room 本来就有这个身份的化身)。
   *  完成确认据此说「新建」而不是「已有的」—— 人 2026-11-23 看到「已有的 .wezard-16」以为复用了别的 room。 */
  instanceOpened?: boolean;
}

/** 落定一个绑定 verdict: 新建 = 本群 untagged 锚点落 kind:steward + workspace (身份级) 并领一个
 *  名字 (want 给了就用它, 否则自动中性名); 已有 = 只绑名字 (工作区跟身份走)。bind 写 chatPolicy
 *  (调用方包宪章守卫), 最后 finish 关掉状态机与出站豁免 —— 返回之后 needsOnboarding 恒为 false。 */
export const applyOnboarding = (
  store: WizardStore,
  onboarding: OnboardingStore,
  base: string,
  verdict: Exclude<OnboardingVerdict, { kind: "retry" }>,
  bind: (name: string) => void,
  workspaceOf: (target: string) => string,
  want = "",
  /** 化身 / 类锚点落在哪个座位 (缺省 = base)。频道没有 room, base 是频道键 chat:<topic_id>: 引导所在的
   *  topic room 才是真座位 —— 传它, 免得在一个没有 room 的频道键上造一条无家可归的实例记录。 */
  seatBase = base,
): OnboardingBound => {
  const done = (b: OnboardingBound): OnboardingBound => { bind(b.name); onboarding.finish(base); return b; };
  // 绑已有 (人 2026-11-23): 绑定只绑身份, **化身按本 room 解析** —— 本 room 已有这个身份的
  // 化身就用它, 没有就开一条 (类是领序号的新实例)。绝不把别的 room 的 target 拉过来当管家。
  if (verdict.kind === "bind-existing") {
    const identity = verdict.identity ?? "";
    const cls = identity ? store.classes?.get(identity) : undefined;
    // 本 room 是否本来就有这个身份的化身 (要在 localManifestation 之前判 —— 它会顺手开一条)。
    const had = !!identity && store.all().some((w) => identityOf(w) === identity && baseOfKey(w.target) === seatBase);
    const local = localManifestation(store, seatBase, identity);
    const target = local || verdict.target;
    const rec = store.get(target);
    return done({
      name: cls ? cls.name : verdict.name,
      target,
      workspace: cls?.workspace || workspaceOf(target) || workspaceOf(verdict.target),
      fresh: false,
      ...(cls ? { classId: cls.id } : {}),
      ...(cls && rec?.name ? { instance: rec.name } : {}),
      ...(cls && !had ? { instanceOpened: true } : {}),
    });
  }
  // 类世界 (人 2026-11-18): 新建管家 = 建一个类 (id = 本群锚点 target, 名 = want / 自动中性名)
  // + 它的第 1 个实例 (记录名 `类名-1`); 绑定写**类名** —— 人点类名就落本群这个实例。
  // want 是人类指定给管家的名字 (人 2026-11-23: 引导一句话里连名字一起定, 不要甩给后来的管家)。
  const classes = store.classes;
  const name = want || store.nextName();
  if (classes) {
    classes.create({ id: seatBase, name, role: "steward", workspace: verdict.workspace });
    store.upsert(seatBase, { kind: "steward", workspace: verdict.workspace, identity: seatBase, ordinal: 1, name: instanceName(name, 1) });
    return done({ name, target: seatBase, workspace: verdict.workspace, fresh: true });
  }
  store.upsert(seatBase, { kind: "steward", workspace: verdict.workspace });
  return done({ name: store.claim(seatBase, name), target: seatBase, workspace: verdict.workspace, fresh: true });
};

export interface OnboardPlan {
  ok: true;
  verdict: Exclude<OnboardingVerdict, { kind: "retry" }>;
  /** 给**新建的**管家指定的类名 (不给 = daemon 自动中性名; 实例名 = <类名>-1)。 */
  name?: string;
  /** 顺手给本群 room 起的名字 (rolepage 的显示名)。 */
  roomName?: string;
}

/** onboard_bind 的全部判定 (不落盘): 谁能调 / 参数形状 / 目录还是名字 / 新管家与群名 / verdict。
 *  纯函数 (create 那一步会 mkdir, nameTaken 只读), 路由只负责把结果写进配置并交接 room。
 *  `name` 的身份按 workspace 分: 同给 = 给新管家起名 (目录上已有管家时不许另起); 只给 = 绑已有管家。 */
export const planOnboardBind = (a: {
  caller: WizardRecord | undefined;
  onboarding: boolean;
  workspace?: unknown;
  create?: unknown;
  name?: unknown;
  roomName?: unknown;
  /** 新管家名字是否已被占用 (类名 / 实例名 / 自由名共一个全机名字空间)。 */
  nameTaken?: (name: string) => boolean;
  judge: (input: Exclude<OnboardingInput, { kind: "command" | "sentence" }>) => OnboardingVerdict;
}): OnboardPlan | { ok: false; status: 400 | 403 | 409; reason: string } => {
  if (!isGuideManifestation(a.caller)) return { ok: false, status: 403, reason: "onboard_bind 只有新群引导会话能调" };
  if (!a.onboarding) return { ok: false, status: 409, reason: "本群已经绑过管家, 引导应当结束" };
  const ws = String(a.workspace ?? "").trim();
  const nm = String(a.name ?? "").trim();
  const roomName = String(a.roomName ?? "").trim().replace(/\s+/g, " ");
  if (roomName.length > 60) return { ok: false, status: 400, reason: "群名太长 (最多 60 字): " + roomName.slice(0, 20) + "…" };
  if (!ws && !nm) return { ok: false, status: 400, reason: "workspace 与 name 至少给一个: 目录给 workspace (要建就带 create:true), 已有管家给 name; 给新管家起名要跟 workspace 一起给" };
  if (!ws) {
    const verdict = a.judge({ kind: "names", names: [nm] });
    return verdict.kind === "retry" ? { ok: false, status: 400, reason: verdict.reason }
      : { ok: true, verdict, ...(roomName ? { roomName } : {}) };
  }
  const v = validateOnboardingWorkspace(ws, { create: a.create === true });
  if (!v.ok) return { ok: false, status: 400, reason: v.reason };
  const verdict = a.judge({ kind: "workspace", path: v.abs });
  if (verdict.kind === "retry") return { ok: false, status: 400, reason: verdict.reason };
  const rest = roomName ? { roomName } : {};
  if (verdict.kind === "bind-existing") {
    // 目录上已有管家: 名字跟身份走, 不能另起。给的是它自己就算了, 别的名字要如实回绝。
    if (nm && foldName(nm) !== foldName(verdict.name))
      return { ok: false, status: 400, reason: "目录 " + v.abs + " 上已有管家 ." + verdict.name + " —— 绑它就不要给 name; 要给新名字请换一个还没有管家的目录" };
    return { ok: true, verdict, ...rest };
  }
  if (nm) {
    if (!validClassName(nm)) return { ok: false, status: 400, reason: "名字 " + nm + " 不能用作管家名 (1-28 个字母 / 数字 / _ / -, 不以 -数字 结尾)" };
    if (a.nameTaken?.(nm)) return { ok: false, status: 409, reason: "名字 ." + nm + " 已被占用 (名字全机唯一), 换一个" };
  }
  return { ok: true, verdict, ...(nm ? { name: nm } : {}), ...rest };
};

// ── 引导落定: 把 room 交给管家 (契约 §4) ──────────────────────────────

/** 引导在 room 期间自己关掉的人话行 (人的原话): 关账后 move 够不着它们, 要另开 duty 交给管家。 */
export const guideClosedHumanLines = (s: RoomState, guide: Who): MsgRow[] => {
  const seen = new Set<string>();
  return [...s.duties.values()].flatMap((d) => {
    const closer = d.closed && s.byId.get(d.closed.by);
    const row = s.byId.get(d.msg);
    if (!closer || !row || !sameWho(closer.author, guide) || row.author.kind !== "human" || seen.has(row.id)) return [];
    seen.add(row.id);
    return [row];
  });
};

/** 一次交接的全部账本行: 管家 join (via invite, by guide) → guide 名下未结 duty 全部 move 给
 *  管家 (人的原话因此跟到管家手上) → guide leave (此时它手上已无 duty, 不产生 canceled 行) →
 *  daemon 系统行 (引导完成, 镜像进企微, 唤醒管家)。纯函数: 调用方把这一串写进 hub。
 *  guide 不在这个 room 里 (老流程 / 没走过 room) = 没有可交的, 返回 []; 调用方自己回一句。 */
export const guideHandoffOps = (
  s: RoomState,
  a: { guide: Who; steward: Who; text: string; now: number; roomName?: string },
): RoomOp[] => {
  if (!s.members.has(whoKey(a.guide))) return [];
  const ops: RoomOp[] = [];
  let cur = s;
  const push = (list: RoomOp[]): void => { ops.push(...list); cur = list.reduce(applyOp, cur); };
  // 引导还是 host: 顺手把群名定下来 (人 2026-11-23: 一句话里给的群名由引导办, 不甩给管家)。
  if (a.roomName) push([{ op: "name", at: a.now, room: cur.id, title: a.roomName, by: a.guide }]);
  if (!cur.members.has(whoKey(a.steward)))
    push([{ op: "join", at: a.now, room: cur.id, who: a.steward, ord: cur.nextOrd, via: "invite", by: a.guide }]);
  const mine = openDuties(cur).filter((d) => sameWho(holderOf(cur, d), a.guide));
  if (mine.length)
    push(mine.map((d) => ({ op: "move" as const, at: a.now, room: cur.id, duty: d.msg, from: a.guide, to: a.steward, by: a.guide })));
  push(leaveOps(cur, a.guide, a.guide, a.now, "引导完成, 管家接手"));
  const orphans = guideClosedHumanLines(cur, a.guide);
  const seq = cur.seq + 1;
  // 有被引导先关账的人话时, 唤醒交给下面那条 task (带原话 + 新 duty), 完成行只做确认, 免得唤醒两次。
  push([{ op: "msg", at: a.now, room: cur.id, id: msgIdOf(cur.id, seq), seq, author: DAEMON, ord: 0, speak: "daemon",
    kind: "system", text: a.text, to: [a.steward], wake: orphans.length ? [] : [a.steward.id], origin: "daemon", sys: "onboard-done" }]);
  if (orphans.length) {
    const seq2 = cur.seq + 1;
    push([{ op: "msg", at: a.now, room: cur.id, id: msgIdOf(cur.id, seq2), seq: seq2, author: DAEMON, ord: 0, speak: "daemon",
      kind: "task", to: [a.steward], re: orphans.map((r) => r.id), wake: [a.steward.id], origin: "daemon", sys: "onboard-forward",
      text: "引导在绑定前已把人的下面这些话关账, 其中绑定之外的要求还没人做, 现在归你, 请照原话办并 chat_reply 交代:\n"
        + orphans.map((r) => "> " + r.text.replace(/\n/g, "\n> ")).join("\n") }]);
  }
  return ops;
};

// ── 话术 ──────────────────────────────────────────────────────────────
// 注入指令 (自包含: 它就是引导化身的宪章, reload / 重生换了一份也能接上) 与完成确认 (daemon
// 系统行, 以 [wezard] 起头 —— 镜像时不再补前缀)。指令里不写点号名字示例, 免得被
// peerMentions 当成点名标注。

export const renderGuideOpening = (): string =>
  "你是这个新群的引导者 (wezard 被拉进新群后的初始化流程)。你只有三件工具: chat_reply / chat_say (只在本群 room) 和 onboard_bind"
  + " —— 代码执行外壳 (CodeBuddy 的 REPL) 里也只调这三件 (写 mcp.wezard.chat_reply / mcp.wezard.onboard_bind, 入参直接写对象字面量); Bash / Read / 别的工具一律被拒。\n"
  + "这一轮要做的事只有一件 —— 定下本群管家的工作目录; 人顺带给的管家名 / 群名在同一次调用里一起办完, 不要留给后来的管家。\n"
  + "- 人话里点名了目录 (例如「在 X 下建 Y」「工作区设为 X」): 直接 onboard_bind({workspace:\"X/Y\", create:true}); 目录已存在就别带 create; 只是让你用某个已有管家: onboard_bind({name:\"…\"}).\n"
  + "- 人同时给了新管家的名字 (例如「给管家起名 tpm」「新 host 叫 tpm」): 在同一个调用里加 name:\"tpm\" —— 跟 workspace 一起给才是给**新**管家起名 (只给 name 是绑已有管家); 名字全机唯一, 撞名 / 不合法会 400/409, 如实回报人让他换一个。\n"
  + "- 人同时给了群名 (例如「把这个群命名为 tpmtest」): 同一个调用里加 roomName:\"tpmtest\".\n"
  + "- 这三件 (workspace + name + roomName) 一次 onboard_bind 就够, 不要拆成多次调用。\n"
  + "- 拿不准该建还是该绑: 用 chat_reply({re, status:\"need\", text:\"…\"}) 一句话问人, 不要猜、不要替人决定。\n"
  + "- 句子里绑定之外的要求 (例如「在里面初始化 codebuddy.md」) 不要自己做、也不要答应 —— 绑定后这条 duty 连原话一起交给管家。\n"
  + "- 绑定成功之前不要 done 关人的那条; 成功之后这一轮就结束, 不要再说话、不要自己做别的。\n"
  + "不闲聊、不回答与引导无关的问题, 每次一两句话。";

export const renderGuideRetry = (reason: string): string =>
  "人刚才那句还不足以定下管家" + (reason ? " (" + reason + ")" : "") + "。你只有 chat_reply / chat_say (本群 room) / onboard_bind 三件工具"
  + " (REPL 里也只调这三件; 别的调用被拒); "
  + "用一句话向人说明, 并请他给一个目录 (绝对路径, 可 ~ 开头) 或一个已有管家的名字 —— 他答对了就 onboard_bind 绑定; 有歧义就用 chat_reply(status:\"need\") 问清楚。"
  + "他给了新管家的名字 / 群名, 就与 workspace 放在同一次 onboard_bind 里。"
  + "绑定之外的任何要求都不要自己做, 绑定后随原话交给管家。";

export const renderOnboardingDone = (b: OnboardingBound): string =>
  b.fresh
    ? "[wezard] ✅ 引导完成: 本群管家 ." + b.name + " 已就位 (工作区 " + b.workspace + ")。之后直接在群里说话就是找它; 想改名 / 改职责对它说一声即可。"
    // 绑的是类: 说清本 room 用的是哪个实例, 以及它是不是这次新开的 —— 同一个类在别的 room 是别的实例,
    // 别让人以为「绑定的是别处那个」。「已有的」只用于本 room 本来就有这个身份的化身。
    : "[wezard] ✅ 引导完成: 本群管家 ." + (b.instance || b.name)
      + (b.classId ? " (." + b.name + " 类在本群" + (b.instanceOpened ? "新建的实例" : "已有的实例") + ")" : "")
      + " (工作区跟身份走: " + (b.workspace || "身份未记录工作区") + ")。之后直接在群里说话就是找它。";
