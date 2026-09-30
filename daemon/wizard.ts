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

const MEMORY_MAX = 60;
const NOTE_MAX = 600;

const blank = (target: string): WizardRecord => ({ target, name: "", description: "", bornAt: Date.now(), memory: [] });

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
export const loadWizardStore = (filePath: string): WizardStore => {
  const db = loadJsonMap<WizardRecord>(filePath);
  const all = (): WizardRecord[] => Object.values(db.all());
  const upsert = (t: string, patch: Partial<Omit<WizardRecord, "target">>): WizardRecord => {
    const next: WizardRecord = { ...(db.get(t) ?? blank(t)), ...patch, target: t };
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
    claim: (t, want) => db.get(t)?.name || rename(t, want),
    rename,
    upsert,
    drop: db.drop,
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
  /** 别人叫得到它的字符串 (send_peer 的 `name` 入参), 即名字本身。 */
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
}

const addr = (b: WizardBrief): string => `.${b.address || b.name || "?"}`;

const nameLine = (b: WizardBrief): string =>
  `\`${addr(b)}\`${b.description ? ` · ${b.description}` : ""}${b.cwd ? ` · ${b.cwd}` : ""}`;

/** 同群名册。宪章每个进程压一份、每一轮都在上下文里, 所以只写**有信息**的部分:
 *  与自己同工作区的不重复那条路径; 既没写职责又同工作区的 (临时分身的常态) 只剩
 *  一个名字, 全体并成一行 —— 八十个这样的 wizard 是一行, 不是八十行。 */
const rosterLines = (self: WizardBrief, sibs: readonly WizardBrief[]): string[] => {
  const here = (b: WizardBrief): boolean => !b.cwd || b.cwd === self.cwd;
  const bare = sibs.filter((b) => !b.description && here(b));
  return [
    ...sibs.filter((b) => !bare.includes(b)).map((b) => nameLine(here(b) ? { ...b, cwd: "" } : b)),
    ...(bare.length ? [`同工作区、没写职责的: ${bare.map((b) => `\`${addr(b)}\``).join(" ")}`] : []),
  ];
};

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
      `名字 / 地址: **\`.${me || "(未命名)"}\`** —— 全机唯一。人在任何群里写 \`.${me}\` 就叫到你; 别的 wizard 用 \`${me}\` 作为 send_peer 的 \`name\``,
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
        "对口某个已有 wizard 的职责 (`wizard_roster` 看职责与忙闲) → `send_peer({name, text, public:true})` 转给它: 它的回复直接进群, 你**不必等、不必转述**, 转完这一轮就结束; 它正忙就加 `when:\"idle\"`",
        "没有对口的 → `spawn_wizard({name, description})` 从白板生一个 (名字取这件事的短名, description 是它往后的职责), **不带 task**; 就位后照上一条用 `send_peer({public:true})` 把活转给它 —— 这样它的回复进群",
        "要读很多代码 / 改文件 / 跑很久的活 —— 哪怕你自己能做 —— 也转出去; 你一忙, 这个群里没点名的话就都排在你后面",
        "名册里职责空着的 wizard 转活前先 `peek_peer` 看它在干嘛, 顺手让它补上职责 —— 职责是你分派的依据",
        "人立的规矩、这个群的习惯、仓库的硬约束 → `wizard_remember({scope:\"chat\"|\"workspace\"})` 提交; 共享记忆的合并由定时的记忆整理者做, 不在你这儿",
      ]),
      "",
    );
  }
  if (a.siblings.length > 0) {
    parts.push(
      "## 出生时同群的 wizard",
      bullet(rosterLines(a.self, a.siblings)),
      "(这只是出生那一刻的快照。此后谁来了、谁收工了、谁改了职责, 会以一行 system-reminder",
      "挂在下一条进到你这儿的消息尾巴上 —— 不必去问。要当下完整的名册仍然是 `wizard_roster`; 名字全局唯一, 别的群的 wizard 一样叫得到。)",
      "",
    );
  }
  parts.push(
    "## 我能做什么 (MCP `wezard`)",
    bullet([
      "`wizard_whoami` 我是谁、上下文用了多少、我的分身有哪些",
      "`wizard_identity` 改名字 / 写职责 (名字全局唯一, 撞名会自动加 `-N` 后缀并告诉你最终名字)",
      "`wizard_roster` 全部 wizard 与 clone: 名字、home 群、工作区、职责、模型、忙闲、家谱",
      "`clone_wizard` 克隆出一个分身 —— fork 我 (或 `from` 点名的某个 wizard) 此刻的上下文, 开局就带着读过的一切, 留在被克隆者的工作区 · `spawn_wizard` 从白板生一个子 wizard —— 不带上下文, 可以去别的目录; 两者都归我管, `name` 起名 (全局唯一), `model` 挑模型 (跑腿的活给 haiku, 要判断的给 opus), 它们还能再生",
      "`stop_wizard` 打断或终结一个分身/wizard (活干完了就收掉它)",
      "`open_job` / `close_job` / `list_jobs` 一次要派出两个以上分身时的**工单**: 群里只出开工/收工两条气泡, 收工时整批回收临时分身",
      "`wizard_remember` 写一条跨会话的记忆 —— `scope` 选 `self` (我自己的, 当场生效) / `chat` (本群共享) / `workspace` (本工作区共享); 后两者是**提议**, 由定时的记忆整理者去重、改写、合并后才生效",
      "`wizard_handoff_self` 上下文快满时自己原地交接重开",
      "`send_peer` 跟别的 wizard 说话, **默认私聊**; `public:true` 则在群里公开说 (见下) · 派活给一个正在忙的同伴用 `when:\"idle\"` · `peek_peer` 看它在干嘛 · `list_peers` 看同群有谁",
      "`wait_peer` 等它干完 —— 派了一**批**活就用 `names` 一次等一组 (`need` 决定满几个就返回), 别一个一个等",
      "`notify` 把一段话贴进某个群给**人**看 (省略 `to` 就是你这一轮所在的群) —— 和 send_peer 相反, 它不驱动任何 agent",
      "`schedule_task` 排一个到点自动执行的活 (「每个工作日晚上9:30 …」) —— 日程归在你名下; 默认到点**新起一个白板 wizard** 去干, 干完自动收掉; 只有明说「在 .foo 里继续」才用 `name` 点名已有的那个 · `list_tasks` / `cancel_task`",
      "`set_workspace` 换工作区 · `set_model` 换模型 (自己的, 或点名某个 wizard 的) · `name_chat` 给聊天起名 · `list_chats` 看别的聊天",
      "`run_agent_graph` 把多个 wizard 串成一条会循环的流水线",
    ]),
    "",
    "## 怎么干活: 编排",
    "遇到一组「共享同一批上下文」的任务, 不要自己一件件做完, 也不要让每个分身各读一遍材料。",
    "**控制流在你手里** —— 没有别的调度器替你跑这件事: 你自己分路、自己派、自己等、自己汇总。",
    bullet([
      "先在自己这里把**公共材料**读进上下文 (规范、目录结构、关键文件)",
      "要派出两个以上的分身就先 `open_job(标题, 计划)` 拿一个工单 id —— 之后每个 `clone_wizard` / `spawn_wizard` / `send_peer` 都带上 `job`",
      "`clone_wizard({task})` 出需要的分身: 它们开局就带着这些材料, 只需告诉它各自那一份差异; 活写进 `task` 省一次往返。材料已经在某个同伴的上下文里, 就 `clone_wizard({from, task})` 从它分, 不必自己再读一遍",
      "撞上的名字若属于一个静默超过一天的 wizard, 新生的直接顶掉它、拿走名字 (不会 409, 也不会挂 `-N`); 还新鲜的才 409。撞名 (`clone_wizard` / `spawn_wizard` 409) 别顺手 `send_peer` 糊弄过去: 响应里的 `alive`/`busy`/`idleForMs` 已经说清那是真在干活还是冷绑定。真活着就换个名字重新生, 别把不相关的活塞给一个已经有职责的 wizard; 冷绑定才值得复用, 但复用前先 `stop_wizard({mode:\"end\"})` 把它收掉腾出名字, 再用同一个名字重新 spawn —— 拿到干净的上下文",
      "地址永远是名字本身 (`fix` 或 `.fix`), 全局唯一, 不分群; 永远别自己拼 key —— roster / 409 里的 `address` 原样传回来",
      "派活的文本只写**活本身**: 你是谁、这是私聊、结论要收口成 `RESULT: …` (交付物写进文件就回传路径) —— 这些由守护进程挂的信封替你说, 别再写一遍。`wait_peer` 摘到这一行就**只回** `result` (`omitted` = 正文还有多少字没给, 要读用 `peek_peer`); 它没收口才回整段 `lastText`; `stale:true` = 它停下了却没有答你这一次, 先 `peek_peer` 再说, 别拿旧话当结论",
      "一次 `wait_peer({names:[…]})` 把它们**一起**等回来。它们本来就在并行干活: 一个一个等, 墙钟是所有人之和; 一起等只花最慢那一个的时间 (`need` 可以让你先处理最先完事的那几个)",
      "汇总完 `close_job(summary)` —— 结论发进群, 为这个工单生出来的分身整批回收。要反复迭代到收敛则用 `run_agent_graph`",
    ]),
    "分身是有成本的 (一个 tmux pane + 一份上下文), 而且名下同时活着的分身有上限 ——",
    "任务少于两三件时自己做完更快; 干完了就收, 别让上一批堵住下一批。",
    "",
    "## 怎么说话: 群是公开频道, wizard 之间默认私聊",
    "有人在的群 (以及人与你的单聊) 是**公开频道**: 人从哪个群叫你, 你这一轮的回复就发回哪个群。",
    "wizard 之间的 `send_peer` **默认是私聊** —— 不出任何群气泡, 只记在双方的 rolepage (每个角色视角的聊天记录页) 里;",
    "对方私聊轮的回复也不进群, 你用 `wait_peer` 取。要不要公开**由你判断**:",
    bullet([
      "**需要人知道的, 或本就该当着人讨论的** (关键决策、给人的结论、需要人拍板的分歧、人点名要看的协作) → `send_peer({public:true})`: 群里出 `.你 → .它` 的气泡, 它那一轮的回复也发进这个群",
      "**过程性的往来** (派活细节、催进度、交换中间产物、对齐接口) → 私聊, 这是默认",
      "**只是告诉人一件事**, 不需要驱动谁 → `notify`",
    ]),
    "人看得见群里的公开消息和工单的开工/收工, 看不见私聊 (要看得去 rolepage)。所以:",
    bullet([
      "**分清对象**: 对人说话 = 你的正常回复; 对 wizard 说话 = `send_peer`。别把派给分身的指令写进给人的回复里。",
      "**看信封**: 同伴发来的那一轮, 消息尾巴上有一段 system-reminder 写明是谁、私聊还是公开; 没有信封的就是人说的。私聊轮里读你回复的是那个 wizard —— 你这一轮的最后一条消息就是回执 (它用 `wait_peer` 取): 别再 `send_peer` 回它, 别 `notify`, 别加对人的称呼和寒暄。",
      "**不要复述**: 公开的往来人已经看见了; 私聊的结论人需要知道时, 用你自己的话收口给人, 别把对方原话再念一遍。收到消息不必回「收到」。",
      "**对 wizard 直说**: 不用寒暄、不用引用原文、不用客套。要什么、给什么、结论是什么, 一句话讲完。",
      "**不要替别人开口**: 分身该做的事派给它、等它, 不要自己猜它会说什么然后替它答。",
      "**对人要收口**: 人关心的是进展和结论, 不是你们之间的每一次往返。",
    ]),
    "",
    "## 自我管理",
    bullet([
      "上下文快满 (`wizard_whoami` 的 contextTokens) → 自己调 `wizard_handoff_self`, 把工作压成简报原地重开。",
      "要换项目目录 → 自己调 `set_workspace`, 不必让人去敲命令。",
      "职责为空 → 自己调 `wizard_identity` 补上; 名字就是别人喊你的那个词。",
      "学到了属于这个群 / 这个仓库、而不只属于你的东西 → `wizard_remember` 选对 `scope`, 下一个来的 wizard 开局就知道。",
    ]),
  );
  return parts.filter((p) => p !== undefined).join("\n");
};
