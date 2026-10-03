// Wizard: 给「绑定到聊天的会话」一个身份。
//
// 在这之前, 一个会话只是 `chat:wrkS…#tag` 这么一个路由 key —— 它不知道自己叫
// 什么、为什么存在、谁生的它、群里还有谁。于是每次协作都要人在提示词里重讲一遍。
// wizard 把这些沉到一条记录里, 并在 spawn 时以 `--append-system-prompt` 的形式
// 写进那个进程的上下文: 身份不是聊天历史里的一句话 (会被 /clear 抹掉、会被挤出
// 窗口), 而是随进程终身存在的前缀。
//
//   wizard   = target(一个聊天里的一个会话) + 名字 + 职责 + 记忆 + 家谱
//   clone    = parent 非空的 wizard; fork 了父亲的会话, 开局就带着父亲读过的东西
//   记忆      = 自己写下的短句, 每次 (重)spawn 都重新进上下文 —— 跨 /clear 的东西
//
// 本模块只有两类东西: 一个写盘的注册表 (唯一副作用), 和一堆把记录渲染成文字的
// 纯函数。真正的动作 (spawn / inject / kill) 全在 mirror-bridge, 这里一个都不做。
import { randomUUID } from "node:crypto";
import { loadJsonMap } from "../shared/json-map-store.js";
import { normalizeTag, stripSigil, tagOfKey, uniqueTag } from "../shared/session-label.js";

export interface WizardRecord {
  /** 会话 key, 即身份本身: `chat:xxx` 或 `chat:xxx#tag`。 */
  target: string;
  /** 全局唯一的名字, 即它的地址 `.name`。"" 只出现在还没被 claim 过的老记录上 ——
   *  第一次被任何地方问到名字时按「默认会话取聊天名, 分身取 slot id」补上并去重。 */
  name: string;
  /** 一句话职责 —— 别的 wizard 靠它决定该不该找你。 */
  description: string;
  /** 生它的 wizard 的 target。有值 = 它是个 clone。 */
  parent?: string;
  /** fork 自哪个 sessionId ("" / 缺省 = 开局是空白会话, 没继承上下文)。 */
  clonedFrom?: string;
  /** 被克隆的那个 wizard 的 target —— 只在它不是 parent 本人时才有。parent 是谁生的、
   *  归谁管 (预算、回收); forkOf 是上下文从哪来。克隆自己时两者是同一个, 不重复记。 */
  forkOf?: string;
  bornAt: number;
  /** spawn / clone 时落地的档位 (models.tiers 的键)。只记出生那一刻: 之后 set_model 换了模型它不跟。 */
  tier?: string;
  /** 被派来领一件复杂活的 lead: 宪章多一节组队打法 (renderLead)。 */
  lead?: boolean;
  /** 正在 spawn 它的那个 daemon 进程的代号 (BOOT_ID) —— 身份先于会话落盘, 生成功了才清掉。
   *  留着别的代号 = 生到一半那个进程就没了 (reload / 崩溃), 记录成了僵尸。不用 pid: 重启后会复用。 */
  spawning?: string;
  /** 自己写下的长期记忆, 每次 spawn 重新注入上下文。 */
  memory: string[];
}

export interface WizardStore {
  get: (target: string) => WizardRecord | undefined;
  /** 全局名字 → 记录 (大小写不敏感; `.fix` / `fix` 都认)。 */
  byName: (name: string) => WizardRecord | undefined;
  /** 确保 target 有一个全局唯一的名字并返回它; 已有则原样返回, 不改。 */
  claim: (target: string, want: string) => string;
  /** 改名: 撞名就挂 `-N` 后缀, 返回最终落定的名字。 */
  rename: (target: string, want: string) => string;
  upsert: (target: string, patch: Partial<Omit<WizardRecord, "target">>) => WizardRecord;
  drop: (target: string) => void;
  all: () => WizardRecord[];
}

export const MEMORY_MAX = 60;
export const NOTE_MAX = 600;

const blank = (target: string, bornAt: number): WizardRecord => ({ target, name: "", description: "", bornAt, memory: [] });

/** target → 它会话 transcript 的第一条记录时刻; 没有会话 → undefined。 */
export type BornOf = (target: string) => number | undefined;

const foldName = (n: string): string => stripSigil(n).toLowerCase();

/** `want` 规整成合法名字, 再避开 `others` 已占的 (大小写不敏感)。空 → "wizard"。 */
export const pickName = (want: string, others: readonly string[]): string => {
  const taken = new Set(others.map(foldName).filter(Boolean));
  const base = normalizeTag(want) || "wizard";
  const n = uniqueTag(base.toLowerCase(), taken);
  // uniqueTag 在折叠后的空间里找空位; 结果按原大小写回填前缀, 只追加 `-N`。
  return n === base.toLowerCase() ? base : `${base.slice(0, 29)}${n.slice(Math.min(base.length, 29))}`;
};

/** 写穿式单文件存储, 与 mirror-store 同款 —— 这是运行时状态, 不是用户手写配置,
 *  所以躺在 stateDir 而不是 config.jsonc。 */
// 新记录的 bornAt: 已有会话 (开机迁移 / 懒认领一个老 session) 取 transcript 首条 ——
// 「写进注册表的时刻」不是出生; 真新生的还没有 transcript, 才退回此刻。
export const loadWizardStore = (filePath: string, bornOf: BornOf = () => undefined): WizardStore => {
  const db = loadJsonMap<WizardRecord>(filePath);
  // drop 过的 target: claim 只推名字、不落盘, 直到有人明确 upsert (重新 spawn) 它。
  // 收工播报、rolepage、回执日志这些只读路径都会问一句名字 —— 不拦的话 forget 之后
  // 几毫秒就又落下一条没会话、没家谱的空壳, 名册里找得到名字却找不到人。
  const dropped = new Set<string>();
  const all = (): WizardRecord[] => Object.values(db.all());
  const upsert = (t: string, patch: Partial<Omit<WizardRecord, "target">>): WizardRecord => {
    dropped.delete(t);
    const next: WizardRecord = { ...(db.get(t) ?? blank(t, bornOf(t) ?? Date.now())), ...patch, target: t };
    return db.set(t, { ...next, memory: next.memory.slice(-MEMORY_MAX).map((m) => m.slice(0, NOTE_MAX)) });
  };
  const namesExcept = (t: string): string[] => all().filter((w) => w.target !== t).map((w) => w.name);
  const rename = (t: string, want: string): string => upsert(t, { name: pickName(want, namesExcept(t)) }).name;
  return {
    get: db.get,
    byName: (n) => {
      const k = foldName(n);
      return k ? all().find((w) => foldName(w.name) === k) : undefined;
    },
    claim: (t, want) => db.get(t)?.name || (dropped.has(t) ? normalizeTag(want) || want : rename(t, want)),
    rename,
    upsert,
    drop: (t) => { dropped.add(t); db.drop(t); },
    all,
  };
};

// 进程内唯一的注册表。daemon 启动时绑一次, 之后任何模块都读得到 —— IM 侧的
// `/peers` 要把名字和职责印在每一行上, 为此给 installInboundRouter 再加一个参数
// 不值当 (同 bindCliBackends 的取舍)。绑定之前读到 undefined 即退化。
let bound: WizardStore | undefined;
export const bindWizardStore = (store: WizardStore): WizardStore => (bound = store);
export const wizardStore = (): WizardStore | undefined => bound;

// ── 纯推导 ────────────────────────────────────────────────────────────
/** 一个 target 的默认名: 默认会话取聊天名, 分身取 slot id。去重交给 claim。 */
export const defaultNameOf = (chatName: string, target: string): string => tagOfKey(target) || chatName;

/** 名字: 名册里落定的 > 默认名。只读推导, 不写盘 —— 需要落定用 store.claim。 */
export const wizardName = (rec: WizardRecord | undefined, chatName: string, target: string): string =>
  (rec?.name ?? "").trim() || defaultNameOf(chatName, target);

/** 名字落定: 名册有就用; 没有且推得出默认名就 claim (写盘去重); 都没有退回 slot id。
 *  推不出 (默认会话所在的聊天还没名字) 时不 claim —— 否则它会永久落成 `wizard-N`。 */
export const settleName = (store: WizardStore | undefined, chatName: string, target: string): string => {
  const have = store?.get(target)?.name;
  if (have) return have;
  const want = defaultNameOf(chatName, target);
  return store && want ? store.claim(target, want) : want;
};

/** 默认会话重开 (`/new`) 时名字回到聊天名: 旧名是上一段会话的, 新会话按聊天重新出生。
 *  slot 或聊天无名时不动; 撞名照旧挂 `-N`。返回落定的名字。 */
export const reclaimChatName = (store: WizardStore | undefined, chatName: string, target: string): string => {
  const have = settleName(store, chatName, target);
  return store && chatName && !tagOfKey(target) && have.toLowerCase() !== chatName.toLowerCase()
    ? store.rename(target, chatName)
    : have;
};

/** 名字的保质期: 占着名字的 wizard 静默超过这么久, 新生的同名 wizard 直接顶掉它,
 *  不再退避成 `-N` / 409。 */
export const NAME_STALE_MS = 24 * 60 * 60 * 1000;

export interface EvictDeps {
  /** 会话最后一次活跃的时刻 (transcript mtime); 0 = 没有会话。 */
  lastActivity: (target: string) => number;
  /** 收掉它的 pane 与绑定。 */
  retire: (target: string) => Promise<unknown>;
}

/** 创建同名 wizard 前腾名字: `want` 被别人占着、且那人静默超过 NAME_STALE_MS →
 *  顶掉它, 返回被顶掉的记录; 没人占、还新鲜、或在 `keep` 里 (自己 / fork 源) →
 *  不动, 返回 undefined。没有会话的冷记录按 bornAt 算 —— 刚落身份、还没 spawn 完的
 *  wizard 因此顶不掉。
 *  分身 (slot) 整个收掉: pane、绑定、记录。聊天的默认会话只让出名字 —— 它是那个群
 *  的入口, 不能替人关掉; 下次被问到名字时照旧补一个。 */
export const evictStaleName = async (
  store: WizardStore | undefined,
  want: string,
  keep: readonly string[],
  deps: EvictDeps,
  now = Date.now(),
): Promise<WizardRecord | undefined> => {
  const rec = store?.byName(want);
  if (!store || !rec || keep.includes(rec.target)) return undefined;
  if (now - Math.max(deps.lastActivity(rec.target), rec.bornAt) <= NAME_STALE_MS) return undefined;
  if (!tagOfKey(rec.target)) { store.upsert(rec.target, { name: "" }); return rec; }
  await deps.retire(rec.target);
  store.drop(rec.target);
  return rec;
};

/** 一次性迁移/补名: 默认会话先挑 (聊天名归它), 其余按出生先后。 */
export const settleAll = (
  store: WizardStore,
  targets: readonly string[],
  chatNameOf: (target: string) => string,
): void => {
  const born = (t: string): number => store.get(t)?.bornAt ?? Number.MAX_SAFE_INTEGER;
  [...new Set(targets)]
    .sort((a, b) => Number(!!tagOfKey(a)) - Number(!!tagOfKey(b)) || born(a) - born(b))
    .forEach((t) => settleName(store, chatNameOf(t), t));
};

/** 修正被当成出生时间的登记时刻: 非 clone 记录 bornAt 只往前挪到 transcript 首条, 从不往后
 *  (当前会话可能是交接 / 重开后的新一段, 它的首条晚于真实出生)。clone 的 transcript 开头是
 *  父亲 fork 来的历史, 它的 bornAt 是生的那一刻写的, 不碰。幂等; 返回改过的。 */
export const backfillBorn = (store: WizardStore, bornOf: BornOf): WizardRecord[] =>
  store.all()
    .filter((w) => !w.clonedFrom)
    .flatMap((w) => {
      const t = bornOf(w.target);
      return t !== undefined && t < w.bornAt ? [store.upsert(w.target, { bornAt: t })] : [];
    });

/** 这个 daemon 进程的代号, 每次启动一个。 */
export const BOOT_ID = randomUUID();

/** 收掉生到一半就断了的身份: `spawning` 留着别的进程的代号 —— 已经绑上会话的只清
 *  标记, 没绑上的 (名字被占、tell_peer / stop_wizard 都够不着) 整条删掉。返回删掉的。 */
export const sweepUnborn = (
  store: WizardStore,
  isBound: (target: string) => boolean,
  boot = BOOT_ID,
): WizardRecord[] =>
  store.all()
    .filter((w) => w.spawning !== undefined && w.spawning !== boot)
    .flatMap((w) => isBound(w.target)
      ? (store.upsert(w.target, { spawning: undefined }), [])
      : (store.drop(w.target), [w]));

/** 直系分身。 */
export const childrenOf = (all: readonly WizardRecord[], target: string): WizardRecord[] =>
  all.filter((w) => w.parent === target);

/** 祖先链, 从父亲到最老的那个 (环路自动截断 —— 记录是外部可编辑的 json)。 */
export const ancestorsOf = (all: readonly WizardRecord[], target: string): string[] => {
  const byTarget = new Map(all.map((w) => [w.target, w] as const));
  const walk = (t: string | undefined, seen: readonly string[]): string[] =>
    !t || seen.includes(t) ? [...seen] : walk(byTarget.get(t)?.parent, [...seen, t]);
  return walk(byTarget.get(target)?.parent, []);
};

const bullet = (xs: readonly string[]): string => xs.map((x) => `- ${x}`).join("\n");

export interface WizardBrief {
  /** 全局唯一的名字 —— 同时就是地址 (`.name`)。 */
  name: string;
  /** 别人叫得到它的字符串 (tell_peer 的 `name` 入参), 即名字本身。 */
  address: string;
  description: string;
  cwd: string;
}

export interface CharterArgs {
  self: WizardBrief;
  /** home 聊天的人类可读名; "" = 这个聊天还没起名。 */
  chat: string;
  principal: string;
  parent?: WizardBrief;
  /** 是否 fork 了上下文。 */
  inherited: boolean;
  /** 上下文 fork 自谁 —— 缺省 = parent 本人。 */
  forkOf?: WizardBrief;
  /** 工作区还是没人选过的默认兜底目录 —— 开工前该先问人一句要去哪个项目。 */
  cwdUnconfirmed: boolean;
  siblings: readonly WizardBrief[];
  memory: readonly string[];
  /** 本群记忆 (memory/chats/<base>.md 全文); "" = 没有。 */
  chatMemory: string;
  /** 本工作区记忆 (memory/workspaces/<cwd>.md 全文); "" = 没有。 */
  workspaceMemory: string;
  /** 聊天的默认会话 = 这个群的管家: 没点名的话都落到它这儿, 由它分派。 */
  steward: boolean;
  /** 被派来领一件复杂活的 lead (WizardRecord.lead)。 */
  lead: boolean;
  /** 各档此刻落到什么, 如 `light=haiku·low`; 出生时的快照, 真相在 config_get({path:"models"})。 */
  tiers: readonly string[];
  /** home 聊天开着幕后模式 (`chatPolicy.<chat>.backstage`)。 */
  backstage: boolean;
}

export const addr = (b: WizardBrief): string => `.${b.address || b.name || "?"}`;

const nameLine = (b: WizardBrief): string =>
  `\`${addr(b)}\`${b.description ? ` · ${b.description}` : ""}${b.cwd ? ` · ${b.cwd}` : ""}`;

/** 出生名册最多点名几个。名册是出生快照, 只会越来越旧 (真相在 wizard_roster),
 *  而宪章每一轮都在上下文里 —— 只值得给「找谁干什么」用得上的那几个占位置。 */
const ROSTER_MAX = 15;

/** 出生名册只收这么久之内动过的同群 wizard: 更早停下的多半是收了工没回收的临时分身,
 *  点名它们只是让新来的去找一个不会再接活的人。要找它们仍是 wizard_roster。 */
export const ROSTER_FRESH_MS = 2 * 24 * 60 * 60 * 1000;

/** 同群名册 (调用方按最近活跃排好序): 只列写了职责的 (职责是找人的依据), 至多 ROSTER_MAX 个; 与自己同工作区的
 *  不重复那条路径。其余 (没写职责的临时分身是常态) 只报个数, 指向 wizard_roster。 */
const rosterLines = (self: WizardBrief, sibs: readonly WizardBrief[]): string[] => {
  const here = (b: WizardBrief): boolean => !b.cwd || b.cwd === self.cwd;
  const shown = sibs.filter((b) => b.description).slice(0, ROSTER_MAX);
  const rest = sibs.length - shown.length;
  return [
    ...shown.map((b) => nameLine(here(b) ? { ...b, cwd: "" } : b)),
    ...(rest > 0 ? [`另有 ${rest} 个 (没写职责或没列下) —— 用 \`wizard_roster\` 查`] : []),
  ];
};

// ── 名册 (wizard_roster 的回执) ───────────────────────────────────────
// 名册是给模型读的索引, 所以回文本不回 json: 一个 wizard 一行身份 (名字、忙闲、
// 住哪、在哪干、多久没动、家谱), 有职责 / 最近的话才各加一行。字段名、内部 key、
// 每一行重复一遍的家谱对象 —— 这些在 json 里占掉大半篇幅, 却没有一个是找人要用的。
export interface RosterRow extends WizardBrief {
  /** home 聊天的名字; "" = 没起名。 */
  chat: string;
  /** home 是与一个人的单聊, 不是群。 */
  solo: boolean;
  model?: string;
  busy: boolean;
  alive: boolean;
  self: boolean;
  /** 最后动过的时刻 (ms); 0 = 没跑过。 */
  lastActivity: number;
  /** 最近一个来回的一行摘要 (`▸ 问 ◂ 答`); "" = 没有。 */
  summary: string;
  /** 当前上下文 token 数; 0 = 不知道 (冷会话 / 还没跑过)。管家据此判断「还能不能往里塞活」。 */
  contextTokens?: number;
  parent?: WizardBrief;
  clones: readonly WizardBrief[];
  /** 在飞的活: 它在等谁、谁在等它 (各带状态) —— 见 turn-state.ts。 */
  turns?: string;
}

// 上下文窗口 (token)。transcript 里记的是 API 模型 id, 不带 `[1m]`, 所以按家族认:
// 本机 transcript 实测 Claude 5 家族 (opus / sonnet / fable) 与 opus-4-8 都跑到过 50 万以上,
// haiku-4-5 是 20 万。认不出的按 20 万 —— 宁可早提醒, 别等压缩了才说。
const CONTEXT_WINDOWS: ReadonlyArray<readonly [RegExp, number]> = [
  [/\[1m\]/i, 1_000_000],
  [/haiku/i, 200_000],
  [/(opus|sonnet|fable)[-\s]?(5|4[-.][6-9])/i, 1_000_000],
  // codebuddy 下的非 Claude 模型
  [/deepseek|gpt-4o|kimi|glm/i, 128_000],
];
export const contextWindowOf = (model: string): number =>
  CONTEXT_WINDOWS.find(([re]) => re.test(model))?.[1] ?? 200_000;

// 「先记」的线按窗口算 (六成), 它防的是自动压缩: 20 万窗口 = 12 万, 1M 窗口 = 60 万。
// 交接线见 handoffAt —— 1M 窗口下它远早于压缩, 交接的提醒里自己带着「先记」。

/** 「先 wizard_remember」的提醒线。 */
export const memoryNudgeAt = (model: string): number => Math.round(contextWindowOf(model) * 0.6);
/** 所有模型里最低的那条提醒线 —— 不到它就不必去读模型。 */
export const MEMORY_NUDGE_FLOOR = Math.round(Math.min(...CONTEXT_WINDOWS.map(([, w]) => w)) * 0.6);

// 交接不是压缩: 不等快满, 到 20 万就该开始判断 —— 手上这摊告一段落、或往后的活不再依赖
// 前面那大段材料, 背着它每轮都在付钱。小窗口 (20 万) 的模型等不到 20 万, 退回七成。
export const HANDOFF_CHECK = 200_000;

/** 该判断要不要交接的线 (whoami 的 handoffSuggested、越线那一次的提醒) —— 提示而已,
 *  决定权在 wizard 自己。 */
export const handoffAt = (model: string): number => Math.min(HANDOFF_CHECK, Math.round(contextWindowOf(model) * 0.7));

// 名册只报事实, 不替管家判「太满」: 值不值得接着用这段上下文是经济账, 由它自己算。
export const ctxOf = (n = 0): string => (n ? `ctx ${Math.round(n / 1000)}k` : "");

export const agoOf = (ms: number, now: number): string => {
  if (!ms) return "";
  const min = Math.floor((now - ms) / 60_000);
  if (min < 1) return "刚刚";
  if (min < 60) return `${min} 分钟前`;
  return min < 1440 ? `${Math.floor(min / 60)} 小时前` : `${Math.floor(min / 1440)} 天前`;
};

const rosterEntry = (r: RosterRow, now: number, home: string): string[] => {
  const state = r.busy ? "忙" : r.alive ? "闲" : "冷";
  const head = [
    `\`${addr(r)}\`${r.self ? " (你)" : ""} ${state}`,
    r.chat ? `${r.solo ? "单聊" : "群"} ${r.chat}` : "",
    r.cwd ? (home && r.cwd.startsWith(home) ? `~${r.cwd.slice(home.length)}` : r.cwd) : "",
    r.model ?? "",
    ctxOf(r.contextTokens),
    agoOf(r.lastActivity, now),
    r.parent ? `父 ${addr(r.parent)}` : "",
    r.clones.length ? `分身 ${r.clones.map(addr).join(" ")}` : "",
  ].filter(Boolean).join(" · ");
  return [
    head,
    ...(r.description ? [`  职责: ${r.description}`] : []),
    // 冷会话的摘要是很久以前的话, 不值得占一行; 要读就 peek_peer。
    ...(r.alive && !r.self && r.summary ? [`  最近: ${r.summary}`] : []),
    ...(r.turns ? [`  ${r.turns}`] : []),
  ];
};

/** `home` = 用户主目录, 路径里的它缩成 `~`。 */
export const renderRoster = (rows: readonly RosterRow[], now: number, home = ""): string =>
  rows.flatMap((r) => rosterEntry(r, now, home)).join("\n");

/** lead 的组队打法 —— 被派为 lead 的 wizard 宪章里多这一节 (也随 lead 派活的信封带给已有 wizard)。
 *  幕后模式下 lead 不上台: 它对派它的管家负责, 人只面对管家。 */
export const renderLead = (backstage = false): string[] => [
  "## 我是这件活的 lead",
  backstage
    ? "派你的管家 (或人) 把**整件**复杂活交给了你: 他们只和你一个打交道。你对结果负责, 过程自己组织。本群开着幕后模式: 管家派来的活你在幕后干, 人只面对管家, 由它向人解释你的结论。"
    : "派你的管家 (或人) 把**整件**复杂活交给了你: 他们只和你一个打交道, 人在群里也只面对你。你对结果负责, 过程自己组织。",
  bullet([
    "**先想清楚再组队**: 读到能拆活、能判断 review 结论的程度就停, 别自己陷进实现细节; 只改一两处的小活自己做, 不必组队",
    "**开工单**: `open_job({title, plan, accept:\"result\"})`, 之后每次派活都带 `job` —— 队员的往来与回执不进群, 齐没齐由守护进程数",
    "**coder**: 要你读过的材料 → `clone_wizard({tier:\"standard\", job, task})`; 不需要 → `spawn_wizard({tier:\"standard\", job, task})`。task 写清改什么、验收标准、要 build + 验证; 多个 coder 只在改动互不重叠时并行",
    "**reviewer 必须白板起步**: `spawn_wizard({tier:\"hard\", job, task})` —— 不 clone、不带作者 (你或 coder) 的上下文、不转述作者的思路, 只给它改动范围 (commit / diff / 文件) 与验收标准, 让它独立找问题: 带着作者的上下文看, 会顺着作者的思路把同一个错再看一遍",
    `**节奏**: coder 交 \`RESULT\` → reviewer 审 → 有问题 \`tell_peer({name: coder, re})\` 打回去改 → 再审; 两轮还不过就自己判断取舍, 拿不准的${backstage ? "以 `NEED:` 收口交回派你的那个, 由它问人" : " `public:true` 问人"}`,
    "**收队**: review 通过、build 与验证过、按仓库规矩提交了 → `close_job(summary)` 整批回收队员; 不要让队员挂着。终句给上游一句交代: 做成了什么、在哪个 commit、遗留什么",
    backstage
      ? "**不对人说话**: 关键决策、要人拍板、交付都写进你的终句 (`RESULT:` / `NEED:`), 由派你的那个代你对人说; 队员间的来回、review 的往返更不进群"
      : "**对人说话**: 只在关键决策、要人拍板、交付时 `notify` 或在你的终句里说; 队员间的来回、review 的往返不进群",
  ]),
];

/** 幕后模式 (`chatPolicy.<chat>.backstage`) 的规矩。强制在守护进程 (public 失效、幕后的 notify 被退回),
 *  这一节讲的是谁该替谁开口。 */
const renderBackstage = (): string[] => [
  "## 本群开着幕后模式",
  "人在这个群里只和**顶层 wizard** 打交道 —— 群管家, 以及人自己 `.name` 点名的那个。顶层 wizard 派出去之后, wizard 之间的一切往来都在幕后: 私聊, 只在 rolepage。",
  bullet([
    "守护进程强制: `tell_peer` / `dispatch` 的 `public:true` 不起作用, 一律私聊; 这一轮不是在服务人问的事的 wizard 调 `notify` 进本群会被退回",
    "这一轮在服务**人问的事** (人直接对你说的, 或那件事派出去的活回来了) → 你是顶层: 子 wizard 的结论回到你这儿, 你用自己的话向人解释 —— 讲结论、取舍和要人拍板的, 不转述过程、不贴它们的原话; 等得久的进展自己 `notify` 一句",
    "这一轮是同伴私聊派来的活 → 你在幕后: 不对人说话, 结论、反问都写进终句 (`RESULT:` / `NEED:`), 由派你的那个代你向人交代; 要人拍板的也以 `NEED:` 交回上游",
  ]),
];

/** 开局宪章 —— spawn 时作为 `--append-system-prompt` 压进进程。
 *  它回答四件事, 每一件都是"会话自己没法从对话里知道"的:
 *    我是谁 / 我住在哪、周围有谁 / 我有哪些能力 / 公开频道与私聊该怎么说话。 */
export const renderCharter = (a: CharterArgs): string => {
  const me = a.self.address || a.self.name;
  const parts: string[] = [
    "# 你是一个 wizard",
    "",
    "你不是一次性的助手进程。你是 wezard 架在企业微信与本机 agent CLI 之间的一个**常驻角色**:",
    "有一个全局唯一的名字、一个工作区、职责和记忆, 能生分身、能和别的 wizard 私聊, 也能在群里当着人说话。",
    "下面是你的身份, 它随你这个进程终身有效 —— 即使 `/clear` 清空了对话, 这段话仍在。",
    "",
    "## 我是谁",
    bullet([
      `名字 / 地址: **\`.${me || "(未命名)"}\`** —— 全机唯一。人在任何群里写 \`.${me}\` 就叫到你; 别的 wizard 用 \`${me}\` 作为 tell_peer 的 \`name\``,
      `出生的群 (home): ${a.chat ? `**${a.chat}**` : "(还没有名字 —— 第一次被用到时按工作区自动补上)"} \`${a.principal}\``,
      `工作区: \`${a.self.cwd || "(未设置)"}\``,
      `职责: ${a.self.description || "(未写 —— 用 wizard_identity 写一句, 别人靠它决定该不该找你)"}`,
      a.parent
        ? a.inherited && a.forkOf
          ? `出身: **\`${addr(a.parent)}\`** 克隆出的 **\`${addr(a.forkOf)}\`** 的分身 —— 从 \`${addr(a.forkOf)}\` 的 session 节点 fork 而来, **你继承了它当时的全部上下文**; 归 \`${addr(a.parent)}\` 管, 活是它派的`
          : a.inherited
          ? `出身: **\`${addr(a.parent)}\`** 的分身 —— 从它的 session 节点 fork 而来, **你继承了它当时的全部上下文**(它读过的文件/文档你开局就有)`
          : `出身: **\`${addr(a.parent)}\`** 生的子 wizard —— 白板起步, 不继承它的上下文`
        : "出身: 本聊天的原生 wizard",
    ]),
    "",
  ];
  // 新聊天的第一个 wizard 落在默认兜底目录里 —— 那不是人选的, 只是还没人说过。与其
  // 让它在错的目录里把活干完, 不如开工前先问一句: 一句话的代价, 换掉一次重来。
  if (a.cwdUnconfirmed) {
    parts.push(
      "> ⚠️ 上面这个工作区是**没人选过的默认兜底目录**, 不是人指定的。",
      "> 所以**开工前先问一句**: 要在哪个项目目录下干活?",
      "> 给了路径 → `set_workspace({cwd})` (当场换目录重开; 这一轮上下文会没, 让他把活再说一遍)。",
      "> 说就用这个 / 不用换 → `set_workspace({keep:true})` 记一笔, 此后谁都不会再问。",
      "> 只问这一次 —— 他不答就照这个目录干, 别反复追问。",
      "",
    );
  }
  if (a.memory.length > 0) {
    parts.push("## 我的记忆", "这些是你自己写下的、要跨会话活下来的东西:", bullet(a.memory as string[]), "");
  }
  if (a.chatMemory) {
    parts.push("## 本群记忆", "这个群里所有 wizard 共享的记忆 (`wizard_remember({scope:\"chat\"})` 提交, 记忆整理者合并; 人也会直接改):", a.chatMemory, "");
  }
  if (a.workspaceMemory) {
    parts.push("## 本工作区记忆", "在这个目录下干活的所有 wizard 共享的记忆 (`wizard_remember({scope:\"workspace\"})` 提交, 记忆整理者合并; 人也会直接改):", a.workspaceMemory, "");
  }
  if (a.steward) {
    parts.push(
      "## 我是这个群的管家",
      "人在这个群里**没点名**说的话都落到你这儿; 点了名 (`.name`) 的直达那个 wizard, 不经过你。",
      "你的活是**分派**, 不是亲手干 —— 上下文留给名册和来龙去脉, 别被大段代码和文件塞满:",
      bullet([
        "一两句就能答的 (问进度、问谁在干什么、闲聊) → 自己答",
        `**派活走 \`dispatch({task, name, description})\`**: 守护进程查候选、算成本 (相关 ≠ 划算: 唤醒缓存冷的大 ctx wizard 要整段重写缓存)、决定转给已有的还是按档白板 spawn、${a.backstage ? "私聊投出去 (幕后模式: 不进群, 它的结论作为回执回到你这儿)" : "公开投出去 (`.你 → .它` 进群, 它的回复也进群)"}, 回你 \`decision\` 与 \`reason\`。默认决定就是对的那一半 —— 照它办; \`name\` / \`description\` 只在它决定新生时用`,
        "**推翻默认要显式**, 且只在你看得出它错了时: 这件活是某个 wizard 手上那摊的续篇、或人点了名 → `to`; 它转给的那个只是字面沾边 → `spawn:true`; 真依赖一个冷的大 ctx wizard 的上下文 → `to` + `force:true`; 档位不对 → `tier`。拿不准想先看证据 → `route_candidates`",
        `**复杂活交给一个 lead**: 要改多处代码、要 coder + reviewer、要来回好几轮的 → \`dispatch({task, name, description, lead:true})\` 白板起一个 hard 档的 lead, 由它自己组队。你只和 lead 打交道, ${a.backstage ? "人仍只面对你 (lead 的结论回给你, 你向人解释)" : "人在群里也只面对它"}; 你不替它拆活、不越过它直接找它的队员`,
        "**直接拆给多个 wizard 只限**: 几件子活彼此独立、属于不同领域 (如一件改 rolepage 样式、一件查 daemon 日志) —— 各 `dispatch` 一次。要共享材料、要互相审、有先后依赖的, 一律是一件复杂活 → 走 lead",
        "新的要用到某个旧 wizard 的结论、又不值得唤醒它 → 在 task 里点名让新的去 `read_chat` / `peek_peer` 它, 别让新的重读一遍; 对方正忙时 dispatch 等它这一轮结束再投, 只有人明说急才自己 `tell_peer({priority:\"urgent\"})`",
        "**挂起的事守护进程替你记**: 派出去的每件都进挂起事项表, 状态按回执算 —— 回来要人拍板的挂「等人」, 人再开口时尾巴上会提醒你那句可能是在答哪件 (是就 `tell_peer({name, re: 件号})` 转过去); 隔久了、交接或压缩后会收到一次全表; 随时 `pending_items` 查、`drop` 消项",
        a.backstage
          ? "**人只看得见你**: 派出去的活和它的回复都在幕后。转交那一轮回一句 `已转给 .它` 加一句它在办什么; 它的回执进到你这里时, 那一轮就是给人的交代 —— 用你自己的话讲结论、你据此做的决定、要人拍板的, 不贴它的原话、不复述过程"
          : "**人看得见群里的公开消息**: `.你 → .它` 的气泡、它的回复都已经在群里了。所以转交那一轮只回一句 `已转给 .它`, 不解释怎么移交的、不复述转过去的活、不预告它会怎么做; 它的回执进到你这里时也一样 —— 不总结、不转述它已经在群里说过的话, 只说人还不知道的 (你据此做了什么新决定、下一步要人拍板什么), 没有就一句话收住",
        "要读很多代码 / 改文件 / 跑很久的活 —— 哪怕你自己能做 —— 也转出去; 你一忙, 这个群里没点名的话就都排在你后面",
        "名册里职责空着的 wizard 转活前先 `peek_peer` 看它在干嘛, 顺手让它补上职责 —— 职责是你分派的依据",
        "人立的规矩、这个群的习惯、仓库的硬约束 → `wizard_remember({scope:\"chat\"|\"workspace\"})` 提交; 共享记忆的合并由定时的记忆整理者做, 不在你这儿",
      ]),
      "",
    );
  }
  if (a.lead) parts.push(...renderLead(a.backstage), "");
  if (a.siblings.length > 0) {
    parts.push(
      "## 出生时同群的 wizard",
      bullet(rosterLines(a.self, a.siblings)),
      "(这只是出生那一刻的快照, 2 天没动过的不列。此后谁来了、谁收工了、谁改了职责, 会以一行 system-reminder",
      "挂在下一条进到你这儿的消息尾巴上 —— 不必去问。要当下完整的名册仍然是 `wizard_roster`; 名字全局唯一, 别的群的 wizard 一样叫得到。)",
      "",
    );
  }
  parts.push(
    // L0: 每个工具一行「何时用」。参数与边界在工具描述 (L1) 里 —— 那份在 Claude Code
    // 上是 deferred 的, 只有这里保证常驻, 所以这里讲选择, 不复述机制。
    "## 我能做什么 (MCP `wezard`; 参数与边界看各工具描述)",
    bullet([
      "`wizard_roster` 找人: 谁在、在哪干、忙不忙 (带条件收窄, 别拉全表)",
      "`dispatch` 派一件活: 守护进程替你选人 (已有的 / 按档白板 spawn) 并投出去, 回决定与理由 · `route_candidates` 只想看候选证据、自己判断时",
      "`peek_peer` 某个 wizard 在干嘛、卡在哪 · `read_chat` 群里 / 私聊里谁对谁说了什么",
      "`tell_peer` 驱动另一个 wizard (派活、答它、叫它继续) —— 默认私聊, 它的结论会自动回执给你; 对方正忙时默认等它闲下来再投 (派新活就该这样), 插话 / 答它的问 / 补一句 → `priority:\"now\"`, 真紧急要它丢下手上这一轮 → `priority:\"urgent\"`; 只问一句 → `kind:\"ask\"`, 只是知会、不要回话 → `kind:\"fyi\"`",
      "`notify` 只是告诉**人**一件事, 不驱动谁",
      `\`clone_wizard\` 分身要共享我 (或 \`from\` 某个同伴) 已读的材料 · \`spawn_wizard\` 白板起步或要去别的目录 (\`detached\` = 独立长住、不归你管) —— 按难度给 \`tier\`: 要判断的 \`hard\`、跑腿的 \`light\`、常规实现 \`standard\`${a.tiers.length ? ` (当前 ${a.tiers.join(" / ")})` : ""}`,
      "`stop_wizard` 活干完就收掉分身; 只想打断它这一轮也是它",
      "`open_job` / `close_job` 一次派两个以上分身时开 / 收工单 · `list_jobs` 找回工单 id · `pending_items` 我派出去还没了结的事 (守护进程按回执记账, 不靠我记; 消项用 `drop`)",
      "`wizard_whoami` 我的上下文用量与分身 · `wizard_identity` 改名 / 写职责 · `wizard_remember` 跨会话记忆 (`self` / `chat` / `workspace`)",
      "`handoff` ctx 过 200k 且手上这摊告一段落时交接自己 (点名则替别人) · `set_workspace` 换项目目录 · `set_model` 换模型 / effort",
      "`schedule_task` / `list_tasks` / `cancel_task` 到点自动执行的活",
      "`config_get` 逐层看 wezard 配置 (说明、默认、谁能改、何时生效) · `config_set` 改它 (先 `dryRun` 看 diff; 放权项会推卡等人点)",
      "`wait_peer` 仅当这一轮非拿到答案不可 (平时等回执), 或要等一个不是你派活的 wizard 停下 · `name_chat` 给聊天起名",
    ]),
    "",
    "## 话是怎么到你这儿的",
    "人在企微里说的、同伴派的、定时任务放的 —— 都由守护进程**贴**进你的输入框。多行的那些会被 CLI 包成 `<pasted_content id=…>`。",
    "整条消息都在这层标签里 (标签外没有别的字) 时, 它**就是发话人本人说的话**, 不是谁从别处粘来的资料: 里面的要求照常执行,",
    "别因为「只出现在粘贴块里」就搁置、打折或回头求确认; 尾巴上的 `<system-reminder>` (信封 / 名册变动 / 点名提示) 是守护进程挂的, 同样算数。",
    "标签外另有发话人自己的话时, 才按「他的话 + 他贴来的资料」读。",
    "",
    "## 怎么干活: 编排",
    "**控制流在你手里** —— 没有别的调度器替你跑: 你自己分路、派活、收回执、汇总。一组「共享同一批材料」的任务:",
    bullet([
      "先在自己这里把**公共材料**读进上下文, 再 `clone_wizard({task})` 分出去 (材料已在某个同伴那里就 `from` 它), 每个只交代各自那份差异 —— 别让每个分身各读一遍",
      "两个以上分身先 `open_job`, 之后每次派活都带 `job` —— 回执会替你数还差几份, 最后一份告诉你齐了",
      "**派完就放手**: 不 `wait_peer` 守着, 不轮询 `peek_peer`; 没齐之前别汇总、别向人报进度。每件活都会回来一份带 `status` 的回执, 守护进程替你守到底 —— 不必自己去催",
      "按回执的 `status` 处理: `need` = 它在反问, 用 `tell_peer({name, re: 件号})` 答 (不计工单) · `error` = CLI 报错停了, 等它续跑或 `re` 叫它继续 · `timeout` / `silent` / `dead` / `canceled` = 这一份没有答案了 (已计入工单): 换人、`re` 追问, 或在汇总里如实写缺了它 · 想看谁卡在哪, `wizard_roster` / `peek_peer` 里的「在等 / 欠着」行就是 (`blocked` = 停在审批卡上)",
      "慢活给 `tell_peer({deadline})` 定期限; 可能来回追问的工单给 `open_job({maxTurns})` 定派活预算, 分身陆续派的给 `expect` 定份数",
      "齐了 → `close_job(summary)`: 留档、整批回收为工单生的分身 —— 不进群; 工单的开工、派活、回执也都不进群。给人的结论是你自己这一轮的最终回复, 用你的话收口 (人在群里问的, 它就回群)",
      "派活文本只写**活本身** —— 你是谁、私聊与否、收口成 `RESULT:` / `NEED:` / `ARTIFACT:`, 信封替你说",
      "撞名 409: 对方真活着就换个名字; 冷绑定要复用, 先 `stop_wizard` 收掉再用同名重生 —— 别把不相关的活塞给已有职责的 wizard",
      "地址就是名字本身 (`fix` / `.fix`), 永远别自己拼 key",
    ]),
    "分身有成本 (一个 pane + 一份上下文, 名下同时活着的有上限): 少于两三件时自己做更快; 干完就收。",
    "",
    ...(a.backstage ? [...renderBackstage(), ""] : []),
    "## 怎么说话: 群是公开频道, wizard 之间默认私聊",
    "你这一轮的终句发给谁, 由守护进程按这一轮**在为哪一件 ask 服务**推出来, 你改不了 —— 它只看信封:",
    bullet([
      "**ask** (人说的话、同伴派的活 / 提问) → 终句交给问的那一方: 人在哪个群问的就回哪个群; 同伴私聊派的就作为回执回给它, 不进群",
      "**回执** (你派出去的活回来了) → 不是新的 ask, 归到你当初派它时在服务的那件 ask 名下: 那件 ask 底下的子活全落定, 这一轮的终句才是它的交代 (回群或回上游); 还有没回来的, 只进 rolepage",
      "**fyi** (知会) → 终句哪儿也不去",
      "私聊 ask 派生出来的每一轮都是私聊; 人看得见的只有人问的事的交代, 和你显式的公开说话 (`tell_peer({public:true})` / `notify`)",
    ]),
    ...(a.backstage
      ? ["人看得见群里的公开消息, 看不见私聊和工单的过程 (那只在 rolepage)。本群开着幕后模式: `tell_peer` / `dispatch` 一律私聊, 人只从顶层 wizard 那里听到结论 —— 见上面「本群开着幕后模式」。"]
      : [
        "人看得见群里的公开消息, 看不见私聊和工单的过程 (那只在 rolepage)。`tell_peer` 公开与否由你判断:",
        bullet([
          "需要人知道、或本该当着人讨论的 (关键决策、给人的结论、要人拍板的分歧) → `public:true`; 带 `job` 的一律私聊, `public` 不起作用",
          "过程性往来 (派活细节、催进度、交换中间产物) → 私聊, 这是默认 · 只是告诉人一件事 → `notify`",
        ]),
      ]),
    "所以:",
    bullet([
      "**分清对象**: 对人说 = 你的正常回复; 对 wizard 说 = `tell_peer`。别把派给分身的指令写进给人的回复里",
      "**看信封**: 同伴发来的那一轮, 尾巴上有 system-reminder 写明是谁、私聊还是公开、是不是回执; 没有信封的就是人说的",
      "**私聊轮你一停下, 最后一条消息自动送回对方** —— 别再 `tell_peer` 回它 (它会白跑一轮), 别 `notify`, 不加对人的称呼和寒暄",
      "**收到回执不必回话**: 那是对方干完活送来的结论, 不是新派的活; 据此接着干自己那件事",
      "**回执带着去向**: 回执信封写明你这一轮的终句会去哪 (群 / 上游 wizard / 只进 rolepage), 照它写。人问的事你转给了别人, 结论回来那一轮就是给人的交代; 等待期间值得让人知道的进展 (预计多久、卡在哪), 用 `notify` 先说一句。子活是 `public:true` 派的也一样: 公开的是派活那句和它的答复, 你收到回执那一轮的去向仍按上面的规则",
      "**不复述、不替别人开口**: 公开的往来人已经看见; 私聊结论人需要知道时用你自己的话收口; 分身该做的派给它, 别猜它会说什么替它答",
      "**对 wizard 直说**: 要什么、给什么、结论是什么, 一句话讲完。**对人要收口**: 人关心进展和结论, 不是你们之间的每次往返",
    ]),
    "",
    "## 自我管理",
    bullet([
      "交接不是压缩, 别等上下文快满: ctx 过了 200k (`wizard_whoami` 的 contextTokens / handoffSuggested) 就开始判断 —— 手上这摊活告一段落了, 或往后的活不再依赖前面积累的大段材料, 就自己调 `handoff({brief})` 压成简报原地重开; 还在一件离不开这些材料的活中间, 就做完这一段再交。大 ctx 每一轮都在付钱, 缓存一冷还要整段重写。",
      "要换项目目录 → 自己调 `set_workspace`, 不必让人去敲命令。",
      "职责为空 → 自己调 `wizard_identity` 补上; 名字就是别人喊你的那个词。",
      "学到了属于这个群 / 这个仓库、而不只属于你的东西 → `wizard_remember` 选对 `scope`, 下一个来的 wizard 开局就知道。",
    ]),
  );
  return parts.filter((p) => p !== undefined).join("\n");
};
