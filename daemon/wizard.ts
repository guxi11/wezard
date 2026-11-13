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
import { copyFileSync, existsSync, statSync } from "node:fs";
import { loadJsonMap } from "../shared/json-map-store.js";
import { expandHome } from "../shared/paths.js";
import { loadAutoNames } from "./wizard-names.js";
import { baseOfKey, keyOf, normalizeTag, stripSigil, tagOfKey, uniqueTag, WIZARD_MARK } from "../shared/session-label.js";

/** 宪章学徒章 (§7; renderCharter 在 self.kind === "apprentice" 时追加)。 */
const renderApprenticeRules = (): string[] => [
  "## 你是学徒 (连续身份)",
  "- 每 bot 实例唯一, 代表人: 不可被退役 / 顶名; `/new` 对你无效, pane 死了会带着记忆同身份重生 —— 你的价值在连续, 不在新鲜。",
  "- 一个连续会话服务多个群: 每条注入的信封都带 `chat=` 属性标明来自哪个群, 回复自动回那个群; 分不清出处时先看信封, 别猜。",
  "- `handoff` 只作上下文工具 (压简报), 会话与身份不变; **交接前先把值得跨会话留下的用 `wizard_remember` 记下**。",
  "- 你的审批卡永远到人: 会话级豁免 (⏱ 窗口 / skipAll) 对你禁用 —— 你代表人动手, 人必须看得见。",
  "- 巡检 / 自主整理的产物默认只进你自己的会话与 rolepage; 要发群必须显式动作 (`notify` / `send_file`), 巡检指令里给了每轮上限, 超过就分轮。",
];

/** 身份的种类 (v3): 全局管家 / 群管家 / 学徒 / 工人。归组与金字塔 (§3/§4/§7) 用, 切片一先落字段与缺省值。 */
export type WizardKind = "global-steward" | "steward" | "apprentice" | "worker";
export const WIZARD_KINDS: readonly WizardKind[] = ["global-steward", "steward", "apprentice", "worker"];
/** 缺省种类: 聊天的默认会话 (untagged target) 是那个群的管家, 其余都是工人。 */
const defaultKindOf = (target: string): WizardKind => (tagOfKey(target) ? "worker" : "steward");

/** 记录所属的身份 id。老盘上还没迁移的记录没有这个字段 —— 一律按自己的 target 回落,
 *  所以「未迁移」和「已迁移 (1:1)」在这条读取路径上不可区分, 迁移幂等因此有据可依。 */
export const identityOf = (w: { target: string; identity?: string }): string => w.identity || w.target;

/** 名字 → 身份 → **base 聊天里的那个化身** (§2 切片二的化身解析):
 *  身份在 base 有化身 → 那个化身的 target (A 群点名只落 A 化身, 不串 B);
 *  没有化身 → 回落锚点化身 (target === identity 那条) —— 即旧世界的跨群点名行为,
 *  上下文共享而非新开 pane, 不自动新建。查无此名 → undefined。
 *  1:1 世界 (迁移后每身份恰一条记录) 它恒等于 `byName(name).target`, 行为零变化。 */
export const manifestationOf = (store: WizardStore | undefined, name: string, base: string): string | undefined => {
  const rec = store?.byName(name);
  if (!store || !rec) return undefined;
  const id = identityOf(rec);
  return store.all().find((w) => identityOf(w) === id && baseOfKey(w.target) === base)?.target ?? rec.target;
};

export interface WizardRecord {
  /** 会话 key: `chat:xxx` 或 `chat:xxx#tag`。v3 起它是「身份在该聊天的化身」的坐标,
   *  不再是身份本身 —— 身份看 `identity`; 路由/回执/账本仍只认这个字符串。 */
  target: string;
  /** 身份 id: 同一身份的多条 wizard 记录 (每群一条化身) 共享它。存量记录 1:1 迁移
   *  (identity = 自己的 target, 稳定不变); 新记录缺省开自己的身份。 */
  identity?: string;
  /** 人给的职责名 —— 身份的归组键之一 (身份的归组键 = role + workspace)。缺省 = 没写。 */
  role?: string;
  /** 身份种类; 缺省按 target 推 (`defaultKindOf`)。 */
  kind?: WizardKind;
  /** 全局唯一的名字, 即它的地址 (人点名写 `.name`, 人面气泡头显示 `🧙‍♂️ name`; 系统面与参数层是裸名)。"" 只出现在还没被 claim 过的老记录上 ——
   *  第一次被任何地方问到名字时按「默认会话取聊天名, 分身取 slot id」补上并去重。 */
  name: string;
  /** 一句话职责 —— 别的 wizard 靠它决定该不该找你。 */
  description: string;
  /** 一句话专长: 熟哪块代码 / 领域 (`wizard_identity({expertise})` 自己写)。lead 借人 (`role:"expert"`) 与 delegate 选人都按它挑。 */
  expertise?: string;
  /** 生它的 wizard 的 target。有值 = 它是个 clone。 */
  parent?: string;
  /** 它在群里替谁说话 —— 定时任务执行体写日程主人: 主人是群默认 wizard 时, 执行体的话按主人的规矩不报名 (isHost)。 */
  voiceOf?: string;
  /** fork 自哪个 sessionId ("" / 缺省 = 开局是空白会话, 没继承上下文)。 */
  clonedFrom?: string;
  /** 被克隆的那个 wizard 的 target —— 只在它不是 parent 本人时才有。parent 是谁生的、
   *  归谁管 (预算、回收); forkOf 是上下文从哪来。克隆自己时两者是同一个, 不重复记。 */
  forkOf?: string;
  bornAt: number;
  /** spawn / clone 时落地的档位 (models.backends.<backend>.tiers 的键)。只记出生那一刻: 之后 set_model 换了模型它不跟。 */
  tier?: string;
  /** 被派来领一件复杂活的 lead: 宪章多一节层级规矩 (renderLeadRules), 组队打法随派活信封带 (renderLeadPlaybook)。 */
  lead?: boolean;
  /** 正在 spawn 它的那个 daemon 进程的代号 (BOOT_ID) —— 身份先于会话落盘, 生成功了才清掉。
   *  留着别的代号 = 生到一半那个进程就没了 (reload / 崩溃), 记录成了僵尸。不用 pid: 重启后会复用。 */
  spawning?: string;
  /** 每次出生的所有权; 旧异步请求不能修改同槽重生的新身份。 */
  birthToken?: string;
  /** 复用旧身份的出生中断时只清标记, 保留它的记忆和家谱。 */
  spawnReused?: boolean;
  /** 自己写下的长期记忆, 每次 spawn 重新注入上下文。 */
  memory: string[];
}

export interface WizardStore {
  /** Consume the next automatic name (never reused), skipping globally occupied strings and `inUse`. */
  nextName: (inUse?: (name: string) => boolean) => string;
  get: (target: string) => WizardRecord | undefined;
  /** 名字 → 身份的锚点记录 (大小写不敏感; `fix` / `🧙‍♂️ fix` 都认)。名字是身份的地址:
   *  同身份的多个化身折叠到锚点 (target === identity 那条), 不与碰到的顺序相关。 */
  byName: (name: string) => WizardRecord | undefined;
  /** 确保 target 有一个身份级唯一的名字并返回它; 已有则原样返回, 不改;
   *  同身份别的化身已有名字时直接领那个名字 (化身共用身份的名字)。 */
  claim: (target: string, want: string) => string;
  /** 改名 (身份级): 撞**别的身份**的名才挂 `-N`; 同身份的全部化身一起改。返回落定的名字。 */
  rename: (target: string, want: string) => string;
  upsert: (target: string, patch: Partial<Omit<WizardRecord, "target">>) => WizardRecord;
  drop: (target: string) => void;
  all: () => WizardRecord[];
}

export const MEMORY_MAX = 60;
export const NOTE_MAX = 600;

const blank = (target: string, bornAt: number): WizardRecord => ({ target, identity: target, kind: defaultKindOf(target), name: "", description: "", bornAt, memory: [] });

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
  const db = loadJsonMap<WizardRecord>(filePath, undefined, { strict: true });
  const nextAutoName = loadAutoNames(`${filePath}.names.json`);
  // drop 过的 target: claim 只推名字、不落盘, 直到有人明确 upsert (重新 spawn) 它。
  // 收工播报、rolepage、回执日志这些只读路径都会问一句名字 —— 不拦的话 forget 之后
  // 几毫秒就又落下一条没会话、没家谱的空壳, 名册里找得到名字却找不到人。
  const dropped = new Set<string>();
  const all = (): WizardRecord[] => Object.values(db.all());
  // 这个 target 当前所属的身份: 有记录看记录, 没记录它自己就是一个新身份。
  const identityKey = (t: string): string => db.get(t)?.identity || t;
  const upsert = (t: string, patch: Partial<Omit<WizardRecord, "target">>): WizardRecord => {
    dropped.delete(t);
    const base = db.get(t) ?? blank(t, bornOf(t) ?? Date.now());
    const next: WizardRecord = { ...base, ...patch, target: t };
    // 身份字段的兜底归一: 老盘上没迁移过的记录无论从哪条路写盘, 落下去的都是已迁移形态
    // (与 migrateIdentities 同一组值 —— 两条路径殊途同归, 这是幂等的另一半)。
    next.identity = next.identity || t;
    next.kind = next.kind || defaultKindOf(t);
    return db.set(t, { ...next, memory: next.memory.slice(-MEMORY_MAX).map((m) => m.slice(0, NOTE_MAX)) });
  };
  // 撞名检查排除的是**整个身份**: 同身份的化身共用名字, 不与自己撞。
  const namesExcept = (t: string): string[] => all().filter((w) => identityOf(w) !== identityKey(t)).map((w) => w.name);
  const rename = (t: string, want: string): string => {
    const id = identityKey(t);
    const name = pickName(want, namesExcept(t));
    upsert(t, { name });
    // 名字是身份的地址: 改名同步同身份的全部化身, 否则「名字→身份」的寻址会裂开。
    all().filter((w) => w.target !== t && identityOf(w) === id).forEach((w) => upsert(w.target, { name }));
    return name;
  };
  return {
    nextName: (inUse = () => false) => {
      const taken = new Set(all().map((w) => foldName(w.name)));
      return nextAutoName((name) => taken.has(foldName(name)) || inUse(name));
    },
    get: db.get,
    // 名字 → 身份 → 那个身份的锚点记录 (target === identity 的那条; 1:1 迁移后每身份恰有一条)。
    // 命中多个化身时挑锚点而非碰到的第一条 —— 调用方拿到的 target 恒定可复现; 挑「当前聊天的化身」
    // 是 resolveName (§2 切片二) 的事, 这里只保证名字回到一个稳定的身份入口。
    byName: (n) => {
      const k = foldName(n);
      const hits = k ? all().filter((w) => foldName(w.name) === k) : [];
      if (!hits.length) return undefined;
      const id = [...new Set(hits.map(identityOf))].sort()[0]!;
      const kin = hits.filter((w) => identityOf(w) === id).slice().sort((a, b) => (a.target < b.target ? -1 : a.target > b.target ? 1 : 0));
      return kin.find((w) => w.target === id) ?? kin[0];
    },
    claim: (t, want) => {
      const have = db.get(t)?.name;
      if (have) return have;
      if (dropped.has(t)) return normalizeTag(want) || want;
      // 同身份已有名字: 化身直接领身份的名字, 不查重也不挂 -N (名字属于身份, 不属于化身)。
      const sib = all().find((w) => w.target !== t && identityOf(w) === identityKey(t) && w.name);
      return sib?.name ?? rename(t, want);
    },
    rename,
    upsert,
    drop: (t) => { dropped.add(t); db.drop(t); },
    all,
  };
};

// ── v3 身份迁移 (boot 幂等) ────────────────────────────────────────────

/** 迁移前备份的后缀: `<wizardsFile>.pre-v3-identities.bak`, 只在第一次写盘前复制一次
 *  (已存在不覆盖) —— 它永远是最原始的 v2 名册, 回滚就把它拷回去。 */
export const MIGRATION_BACKUP_SUFFIX = ".pre-v3-identities.bak";

export interface IdentityMigration {
  /** 本次补上 identity/kind 的记录数; 0 = 没有可迁的 (已迁完 / 空表)。 */
  migrated: number;
  /** 本次创建的备份路径; 没写盘就没有。 */
  backup?: string;
  /** 没迁成的原因 (备份失败 / 表里有畸形记录); 原文件一个字节没动。 */
  skipped?: string;
}

/** 存量名册 1:1 生成身份 (§2.4): 每条记录 `identity = 自己的 target` (稳定不变, 旧账的
 *  owner 字符串因此一个都不用改写), `kind` 按 target 推 (untagged 默认会话 = steward,
 *  其余 = worker), `role` 留空。名字占用从 wizard 级升到身份级, 但 1:1 迁移不产生新名字
 *  (一名一记录 → 一名一身份), byName/claim 行为不变。
 *
 *  幂等: 判据是 `identity`/`kind` 字段缺省 —— 已迁移的记录不再动, 同一份数据跑两遍结果
 *  一致; 中途崩了的半迁状态重跑收敛到同一结果 (逐字段补缺, 与 upsert 的归一是同一组值)。
 *
 *  失败安全: 先备份后写盘, 备份失败就不迁 (记录靠 `identityOf` 的 target 回落照常工作,
 *  下次开机再试); 表里有畸形记录 (target 非法) 时一条都不写, 原 wizards.json 原样。 */
export const migrateIdentities = (store: WizardStore, filePath: string): IdentityMigration => {
  const rows = store.all();
  const bad = rows.find((w) => typeof w.target !== "string" || w.target === "");
  if (bad) return { migrated: 0, skipped: `invalid wizard record (target=${String((bad as { target?: unknown }).target)})` };
  const patch = rows
    .filter((w) => !w.identity || !w.kind)
    .map((w) => ({ target: w.target, identity: w.identity || w.target, kind: w.kind || defaultKindOf(w.target) }));
  if (!patch.length) return { migrated: 0 };
  const abs = expandHome(filePath);
  const backup = abs + MIGRATION_BACKUP_SUFFIX;
  try {
    // 只有「备份已是一个文件」才算迁过、跳过复制 —— 备份路径被目录之类的东西占着时,
    // copyFileSync 会失败, 走下面的 skipped (不迁, 原文件不动)。
    if (!(existsSync(backup) && statSync(backup).isFile())) copyFileSync(abs, backup);
  } catch (e) {
    return { migrated: 0, skipped: `backup failed: ${(e as Error).message}` };
  }
  patch.forEach((p) => store.upsert(p.target, { identity: p.identity, kind: p.kind }));
  return { migrated: patch.length, backup };
};

/** 还有人指着的 target。forget 删的是名册记录和绑定, 但路由行、消息事件 (含墓碑)、定时任务、
 *  plan 都只认 target 字符串, 不知道人已经没了 —— 名册里查不到 ≠ 这个 target 没人用。 */
export interface TargetRefSources {
  routes: readonly { owner: string; receiver: { kind: string; to?: string } }[];
  events: readonly string[];
  tasks: readonly { target: string; createdBy: string; owner: string }[];
  plans: readonly { owner: string }[];
  /** 名册记录与镜像绑定的 target。 */
  live: readonly string[];
}
export const referencedTargets = (s: TargetRefSources): Set<string> => new Set([
  ...s.routes.flatMap((r) => [r.owner, r.receiver.kind === "wizard" ? r.receiver.to ?? "" : ""]),
  ...s.events,
  ...s.tasks.flatMap((t) => [t.target, t.createdBy, t.owner]),
  ...s.plans.map((p) => p.owner),
  ...s.live,
].filter(Boolean));
/** 自动名在 `base` 下落成 `base#name`: 那个 target 仍被引用就跳过这个名字 (跳过即消耗, 名字照样不复用)。 */
export const slotInUse = (base: string, refs: ReadonlySet<string>) => (name: string): boolean => refs.has(keyOf(base, name));

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
  retire: (target: string) => Promise<{ ok: boolean }>;
}

/** 创建同名 wizard 前腾名字: `want` 被**一个身份**占着、且它全部化身都静默超过
 *  NAME_STALE_MS → 顶掉, 返回被顶掉的记录 (byName 的锚点); 没人占、任一化身还新鲜、
 *  或任一化身在 `keep` 里 (自己 / fork 源) → 不动, 返回 undefined。没有会话的冷记录按
 *  bornAt 算 —— 刚落身份、还没 spawn 完的 wizard 因此顶不掉。
 *  名字占在身份上, 所以新鲜度按身份的全部化身取最热的一个 —— 锚点冷了但另一个群里
 *  的化身还在干活, 名字就不算 stale。
 *  分身 (slot 化身) 整个收掉: pane、绑定、记录。身份里的默认会话 (untagged) 只让出
 *  名字 —— 它是那个群的入口, 不能替人关掉; 下次被问到名字时照旧补一个。 */
export const evictStaleName = async (
  store: WizardStore | undefined,
  want: string,
  keep: readonly string[],
  deps: EvictDeps,
  now = Date.now(),
): Promise<WizardRecord | undefined> => {
  const rec = store?.byName(want);
  if (!store || !rec) return undefined;
  // 学徒 (§7): 名字跟着连续身份走, 永远不算 stale —— 冷多久都不顶、不收。
  if (rec.kind === "apprentice") return undefined;
  const kin = store.all().filter((w) => identityOf(w) === identityOf(rec));
  if (kin.some((w) => keep.includes(w.target))) return undefined;
  if (kin.some((w) => now - Math.max(deps.lastActivity(w.target), w.bornAt) <= NAME_STALE_MS)) return undefined;
  for (const w of kin) {
    if (!tagOfKey(w.target)) continue;
    if (!(await deps.retire(w.target)).ok) return undefined;
    const current = store.get(w.target);
    if (!current || current.birthToken !== w.birthToken) return undefined;
    store.drop(w.target);
  }
  kin.filter((w) => !tagOfKey(w.target)).forEach((w) => store.upsert(w.target, { name: "" }));
  return rec;
};

/** 当前启动/按需补名: 默认会话先挑 (聊天名归它), 其余按出生先后；重复执行按当前身份状态落定。 */
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
    .flatMap((w) => isBound(w.target) || w.spawnReused
      ? (store.upsert(w.target, { spawning: undefined, spawnReused: undefined }), [])
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
  /** 全局唯一的名字 —— 同时就是地址 (tell_peer 的 name 入参; wizard 之间与 rolepage 显示就是它, 人面气泡头带 🧙‍♂️)。 */
  name: string;
  /** 别人叫得到它的字符串 (tell_peer 的 `name` 入参), 即名字本身。 */
  address: string;
  description: string;
  /** 专长 (WizardRecord.expertise); 缺省 = 没写。 */
  expertise?: string;
  cwd: string;
  /** 身份种类 (§7): 学徒的宪章带学徒章; 缺省 = 普通。 */
  kind?: WizardKind;
}

// 档位行: 各档由轻到重排开, 常用的三档挂一个词说用途; 两头的 mini / ultra 靠位置自明。
const TIER_HINT: Record<string, string> = { light: "跑腿", standard: "常规", hard: "要判断" };
const tierLine = (tiers: readonly string[]): string =>
  tiers.length
    ? `按难度给 \`tier\`, 轻→重: ${tiers.map((t) => [t, TIER_HINT[t.split("=")[0]!]].filter(Boolean).join(" ")).join(" / ")}`
    : "按难度给 `tier`";

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
  siblings: readonly WizardBrief[];
  memory: readonly string[];
  /** 本群记忆 (memory/chats/<base>.md 全文); "" = 没有。 */
  chatMemory: string;
  /** 本工作区记忆 (memory/workspaces/<cwd>.md 全文); "" = 没有。 */
  workspaceMemory: string;
  /** 这个 target 是所在聊天的管家化身 (v3 §3: config chatPolicy.steward 绑定优先, 没绑 = 现存默认会话):
   *  没点名的话都落到它这儿, 由它分派。 */
  steward: boolean;
  /** 管家手闸的每轮查看预算 (`chatPolicy.<chat>.stewardBudget`); -1 = 不设闸。 */
  stewardBudget: number;
  /** 被派来领一件复杂活的 lead (WizardRecord.lead)。 */
  lead: boolean;
  /** 各档此刻落到什么, 如 `light=haiku·low`; 出生时的快照, 真相在 config_get({path:"models"})。 */
  tiers: readonly string[];
  /** home 聊天开着顶层模式 (`chatPolicy.<chat>.topOnly`)。 */
  topOnly: boolean;
}

// 系统面 (设计稿 §1.5) 的称呼: 裸名 —— roster/charter 里不画记号; 记号只在人面 (企微气泡头/审批卡)。
export const addr = (b: WizardBrief): string => b.address || b.name || "?";

const nameLine = (b: WizardBrief): string =>
  `\`${addr(b)}\`${b.description ? ` · ${b.description}` : ""}${b.cwd ? ` · ${b.cwd}` : ""}`;

/** 出生名册最多点名几个 (v3 §4: L0 快照化, 15 → 8 —— 宪章是常驻系统提示, 名册只给
 *  「找谁干什么」用得上的那几个占位置; 更大的世界交给 wizard_roster 金字塔)。 */
const ROSTER_MAX = 8;

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
  /** 会话 key (`chat:xxx#tag`)。名册行按它定位, L0/L1 的「本聊天」按 baseOfKey(target) 判。 */
  target: string;
  /** 记录的身份 id (v3): 金字塔 L0 的汇总按它去重 (同身份多化身算一个身份)。 */
  identity?: string;
  /** 身份种类; L0 的「在场」永远包含学徒。 */
  kind?: WizardKind;
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
    ...(r.expertise ? [`  专长: ${r.expertise}`] : []),
    // 冷会话的摘要是很久以前的话, 不值得占一行; 要读就 peek_peer。
    ...(r.alive && !r.self && r.summary ? [`  最近: ${r.summary}`] : []),
    ...(r.turns ? [`  ${r.turns}`] : []),
  ];
};

/** `home` = 用户主目录, 路径里的它缩成 `~`。 */
export const renderRoster = (rows: readonly RosterRow[], now: number, home = ""): string =>
  rows.flatMap((r) => rosterEntry(r, now, home)).join("\n");

// ── v3 §4: roster 金字塔 ──────────────────────────────────────────────
// 预算的度量依据 (2026-11-13 现场实测, 1154 记录): roster 行均宽 55-59 字符, 按中文为主
// 的行 ~1 token ≈ 1.8 字符折算 (0.55 token/字符)。全机平铺 = 97,211 字符 ≈ 53k token,
// 这就是平铺不可用的实证。各层预算都留了 ~15% 余量。

/** L0 在场: 成员行上限 (不含汇总/提示行)。 */
export const ROSTER_L0_ROWS = 10;
/** L0 总行数硬顶 (成员 + 截断提示 + 汇总 + 至多一条提示/降级行)。 */
export const ROSTER_L0_MAX_LINES = 12;
/** L0 「活跃」判据: 本聊天最后动过在这么多之内。 */
export const ROSTER_L0_ACTIVE_MS = 48 * 60 * 60 * 1000;
/** L0 字符预算 (≈440 token): 超线就减行, 不折行。 */
export const ROSTER_L0_CHARS = 800;
/** L1 本群: 总行数上限 (含职责/最近等子行)。 */
export const ROSTER_L1_MAX_LINES = 40;
/** L1 字符预算 (≈1,430 token)。 */
export const ROSTER_L1_CHARS = 2600;
/** L2 组团: 聊天行上限。 */
export const ROSTER_L2_MAX_LINES = 60;
/** L2 字符预算 (≈2,300 token)。 */
export const ROSTER_L2_CHARS = 4200;
/** L2 每个聊天行列出的名字数上限 (其余计 +n)。 */
export const ROSTER_L2_NAMES = 5;

export interface RosterCensus {
  /** 全机身份数 (按 identity 去重)。 */
  identities: number;
  /** 全机聊天数。 */
  chats: number;
  busy: number;
  idle: number;
  cold: number;
}
export const rosterCensus = (rows: readonly RosterRow[]): RosterCensus => ({
  identities: new Set(rows.map((r) => r.identity ?? r.target)).size,
  chats: new Set(rows.map((r) => baseOfKey(r.target))).size,
  busy: rows.filter((r) => r.busy).length,
  idle: rows.filter((r) => !r.busy && r.alive).length,
  cold: rows.filter((r) => !r.alive).length,
});

const censusLine = (c: RosterCensus): string =>
  "全机 " + c.identities + " 身份 · " + c.chats + " 群 · 忙 " + c.busy + " 闲 " + c.idle + " 冷 " + c.cold;

/** 行数守卫: 从尾行往前删到 ≤ maxLines 且总字符 ≤ maxChars, 返回 [保留行, 删掉行数]。 */
const fit = (lines: readonly string[], maxLines: number, maxChars: number): [string[], number] => {
  const kept = [...lines];
  while (kept.length && (kept.length > maxLines || kept.join("\n").length > maxChars)) kept.pop();
  return [kept, lines.length - kept.length];
};

export interface L0Args {
  /** 调用方所在聊天的 base。 */
  base: string;
  /** 该聊天此刻的管家化身 target (§3); undefined = 没有管家。 */
  stewardTarget?: string;
  now: number;
  home?: string;
  /** 全机普查 (调用方拿全量 rows 算好的, 见 rosterCensus)。 */
  census: RosterCensus;
  /** L0 没找见的名字提示 (调用方判了 miss 才给)。 */
  missHint?: string;
  /** 降级说明 (ctx 超线时调用方给; 给了就附这一行, 层不在这里换)。 */
  degraded?: string;
}

/** L0 在场 (默认层): 自己 + 本群管家 + 学徒 (钉住, 截断也不丢) + 本聊天 ROSTER_L0_ACTIVE_MS
 *  内动过的化身 (按最近排, 填满剩余行), 每个一行 (不带职责/最近子行), 尾行全机普查 +
 *  至多一条提示 (降级 > miss > 截断), 总行数 ≤ ROSTER_L0_MAX_LINES。 */
export const rosterL0 = (rows: readonly RosterRow[], a: L0Args): string => {
  const pinned = rows
    .filter((r) => r.self || r.target === a.stewardTarget || r.kind === "apprentice")
    .slice()
    .sort((x, y) => Number(y.self) - Number(x.self)
      || Number(y.target === a.stewardTarget) - Number(x.target === a.stewardTarget));
  const active = rows
    .filter((r) => !pinned.includes(r) && baseOfKey(r.target) === a.base
      && a.now - r.lastActivity <= ROSTER_L0_ACTIVE_MS)
    .slice()
    .sort((x, y) => (y.lastActivity ?? 0) - (x.lastActivity ?? 0));
  // 钉住的先占行, 活跃的填剩余; 字符预算不够再从活跃尾部减。
  let members = [...pinned, ...active.slice(0, Math.max(ROSTER_L0_ROWS - pinned.length, 0))]
    .map((r) => rosterEntry(r, a.now, a.home ?? "")[0] ?? "");
  const budget = ROSTER_L0_CHARS - censusLine(a.census).length - 60;
  while (members.length > pinned.length && members.join("\n").length > budget) members.pop();
  const dropped = active.length - Math.max(members.length - pinned.length, 0);
  const hint = a.degraded ?? a.missHint
    ?? (dropped > 0 ? dropped + " 个更早的没列 — wizard_roster({chat}) 看本群全量" : undefined);
  return [...members, censusLine(a.census), ...(hint ? [hint] : [])].join("\n");
};

/** L1 本群: 该聊天全部化身 (含冷), 完整条目 (职责/最近/家谱), 总行数 ≤ ROSTER_L1_MAX_LINES。 */
export const rosterL1 = (rows: readonly RosterRow[], a: { base: string; now: number; home?: string }): string => {
  const kin = rows
    .filter((r) => baseOfKey(r.target) === a.base)
    .slice()
    .sort((x, y) => Number(y.self) - Number(x.self) || (y.lastActivity ?? 0) - (x.lastActivity ?? 0));
  const lines = kin.flatMap((r) => rosterEntry(r, a.now, a.home ?? ""));
  const [kept, dropped] = fit(lines, ROSTER_L1_MAX_LINES, ROSTER_L1_CHARS);
  return [
    ...kept,
    ...(dropped ? ["… 本群共 " + kin.length + " 个, 超出行数/预算未列全 — query 收窄"] : []),
  ].join("\n");
};

/** L2 组团: 每个聊天一行 (名字串, 无 summary/turns/职责), 自己的聊天最前, 其余按最近活动排。
 *  行数 ≤ ROSTER_L2_MAX_LINES。 */
export const rosterL2 = (rows: readonly RosterRow[], a: { base: string; now: number }): string => {
  const byChat = new Map<string, RosterRow[]>();
  for (const r of rows) {
    const b = baseOfKey(r.target);
    byChat.set(b, [...(byChat.get(b) ?? []), r]);
  }
  const chatLine = (b: string, kin: readonly RosterRow[]): string => {
    const named = kin.slice().sort((x, y) => (y.lastActivity ?? 0) - (x.lastActivity ?? 0));
    const shown = named.slice(0, ROSTER_L2_NAMES).map((r) => r.address || r.name);
    const rest = named.length - shown.length;
    const label = kin[0]?.chat || b;
    return label + " (" + named.length + (kin.some((r) => r.busy) ? "·忙" : "") + "): " + shown.join(" ") + (rest > 0 ? " +" + rest : "");
  };
  const chats = [...byChat.entries()]
    .map(([b, kin]) => [b, kin, Math.max(...kin.map((r) => r.lastActivity ?? 0))] as const)
    .sort((x, y) => Number(y[0] === a.base) - Number(x[0] === a.base) || y[2] - x[2]);
  const lines = chats.map(([b, kin]) => chatLine(b, kin));
  const [kept, dropped] = fit(lines, ROSTER_L2_MAX_LINES, ROSTER_L2_CHARS);
  return [...kept, ...(dropped ? ["… 共 " + chats.length + " 群, 列出 " + kept.length + " — chat 收窄后看该群"] : [])].join("\n");
};

/** lead 在协作树里的位置。 */
export const renderLeadRules = (pointer = false): string[] => [
  "## 我是这件活的 lead",
  "派你的 (管家或上级 lead) 把**整件**活交给了你, 你对结果负责并维护自己的计划。直属 parent 是管理归属；横向沟通不改变家谱:",
  bullet([
    "**对上**: 回复必须明确标出接收者 (`@name RESULT: …`), 一条消息可分段回复多个接收者; 做成了什么 · commit · `ARTIFACT` 指针, **单列「取舍 / 遗留」一段**。需要对方补信息或递归拆活时用 `tell_peer({kind:\"ask\"|\"task\"})`。你不对人说话, 由派你的那个代你对人交代",
    "**对下**: 只管理自己直属创建的 wizard；其他节点由其 parent 管理。需要横向协作时直接沟通，之后回到主流程向自己的上级交付",
    ...(pointer ? ["组队打法 (coder / 白板 reviewer / 何时收工) 随派活信封带"] : []),
  ]),
];

/** lead 的组队打法 —— 随 lead 派活的信封带给它 (不进出生宪章: 一件活里才用得上, 宪章每轮都在上下文里)。 */
export const renderLeadPlaybook = (): string[] => [
  "组队打法:",
  bullet([
    "**复杂任务才建 plan**: 先建立可变 DAG，简单问题直接处理。plan 是自己的状态记忆；你按实际进展显式更新 revision、任务状态与结果，不把它当执行器",
    "**owner 与提醒**: 每个 plan 只有 owner 能写，其他 wizard 只读。首次派出属于 plan 的任务要显式带 `planId`；补充同一 event 会沿用关联。暂停 plan 只暂停 daemon 提醒，不阻挡 receiver 消息或协作",
    "**逐阶段协作**: 先只创建当前阶段需要的 wizard。典型顺序是 explorer 调研 → 你读回结果并决定 → coder 实现 → 你验收后创建 reviewer；不要预先创建后续队伍",
    "**coder**: 范围清楚、低风险 coding 默认 light。task 写清改什么和验收标准；交付后保留 coder，直到 reviewer 完成",
    "**reviewer**: 需要独立评审时白板 `spawn_wizard` reviewer，只给改动范围与验收标准，不 clone 作者上下文。按审查难度选 light / standard / hard。reviewer 发现可由 coder 修复的问题时，直接横向联系 coder 返修，再回主线；最后由 reviewer 向你提交结论",
    "**推进与结束**: 收到阶段回复、思考并验收后，再显式更新 plan 并启动下一阶段。所有节点完成或取消后显式完成 plan；结束 plan 不会回收 wizard",
    "**保留与退役**: wizard 交付后默认保留；pane 只在数量超限时回收，身份、会话、plans 与 receiver 状态保留。逻辑退役只由直属 lead 或本人操作，且必须先结束所有未完成的 plan",
  ]),
];

/** lead 的全套 (规矩 + 打法): 随派活信封带给**已经存在**的 wizard —— 它的宪章是出生时定的, 没有 lead 这一节。 */
export const renderLead = (): string[] => [...renderLeadRules(), ...renderLeadPlaybook()];

/** 顶层模式 (`chatPolicy.<chat>.topOnly`) 的规矩。强制在守护进程 (public 失效、下层的 notify 被退回),
 *  这一节讲的是谁该替谁开口。 */
const renderTopOnly = (): string[] => [
  "## 本群开着顶层模式",
  "人在这个群里只和**顶层 wizard** 打交道 —— 群管家, 以及人自己 `.name` 点名的那个。顶层 wizard 派出去之后, wizard 之间的一切往来都是私聊, 只在 rolepage。",
  bullet([
    "守护进程强制: `tell_peer` / `delegate` 的 `public:true` 不起作用, 一律私聊; 普通私聊 fyi 不授权对人通知; 这一轮不是在服务人问的事的 wizard 调 `notify` 进本群会被退回",
    "这一轮在服务**人问的事** (人直接对你说的, 或那件事派出去的活回来了) → 你是顶层: 子 wizard 的结论回到你这儿, 你用自己的话向人解释 —— 讲结论、取舍和要人拍板的, 不转述过程、不贴它们的原话; 不轮询或提前汇总, 但长等待、阻塞可按已知实据用 `notify` 报进展。收到子 wizard 的完成 fyi 时, 立即向原群 `notify` 结论与仍 pending / 尚无正式回执的状态; fyi 本身不代表 ledger done",
    "这一轮是同伴私聊派来的活 → 你不是顶层: 不对人说话, 结论用 `@name RESULT:` 交给对应接收者; 需要对方补信息或协作时用 `tell_peer({kind:\"ask\"})`; 由派你的那个代你向人交代",
  ]),
];

/** config_set 路径里写哪个键: 聊天名好认, 但路径按 `.` 切段 —— 名字里带点就退回 principal。 */
const policyKeyOf = (name: string, base: string): string => (name && !name.includes(".") ? name : base);

/** 管家的顶层模式开关 (开没开都给一行): 默认开着, 所以这一行的用处是**关法** —— 人问起、或想让某个群照旧
 *  (人能看见 wizard 之间说话、默认会话也自己动手干活) 时它得知道按哪个键。 */
const topOnlyLine = (chat: string, on: boolean): string => {
  const set = (v: boolean): string => `\`config_set({path:"chatPolicy.${chat}.topOnly", value:${v}})\``;
  return on
    ? `**顶层模式 (本群: 开)**, 规矩见下文那一节; 人要关 → ${set(false)}`
    : `**顶层模式 (本群: 关)**: 开了之后人只和顶层 wizard (你 / 人 \`.name\` 点名的) 打交道, wizard 之间一律私聊、过程只在 rolepage, 群里不再有 wizard 互相派活的气泡。人问起或想开 → ${set(true)} (热生效)`;
};

/** 管家 (群的默认会话) 那一节。写给最轻能当管家的那档模型: 每条规则是一个可照做的动作, 判断写成
 *  从上往下的检查单 —— 原则性的「别被代码塞满」它读了也会忘, 检查单才会被逐条对。 */
const renderStewardRules = (a: CharterArgs): string[] => {
  const look = a.stewardBudget < 0 ? "自己跑" : `自己跑, 每轮至多 ${a.stewardBudget} 次`;
  return [
    "## 我是这个群的管家 (L1)",
    "你只做三件事: **分派、收回执、向人交代**。不亲手干活 —— 你一忙, 全群没点名的话都排在你后面。",
    "",
    "**人的每条话先过这张检查单, 从上往下, 命中即停:**",
    "1. 问进度 / 谁在干什么 / 闲聊 / 凭你已知道的就能答 → 自己答 (plans 看 `plan_list`; wizard 近况看 `peek_peer` / `read_chat`)",
    `2. 跑一条状态命令就能答 (git log / status、服务在不在) → ${look}`,
    "3. 凡是要看代码才答得了的 —— 机制 / 原理 / 「现在还会不会…」/ 方案 / 排查 / 改动, 哪怕看一眼就像能答、哪怕你会做 → 派出去, 见下",
    "",
    "**怎么派:**",
    bullet([
      "先判续篇还是新活: 只有服务于原任务同一验收目标的补充证据、纠正或返工才用 `tell_peer({name: 原来接活的那个, re})`。能独立验收、无需原任务结论或在途状态的新问题必须另派, 另派不等于强制新生: 有近期实际材料关联的空闲、无职责占用非 lead 可以复用; 同项目、同目录、刚联系过、读过公共规则文件都不算续篇, 不得把它改写成「同时核实 / 顺便检查 / 最终交付中补充」塞回原 lead",
      "保护复杂 lead 的注意力: 正在排查编辑器问题时, 新问「有没有 AGENTS.md、如何加载 CLAUDE.md」是独立核查 → 另派 light; 不用同一笔 re, 不用 priority:now / ask 把新工作插进去。真正依赖原排障证据的纠正仍交回原 lead",
      `范围清楚、低风险的 coding → \`delegate({tier:"light", task, description})\`; 机械一步用 mini。你负责写计划与验收标准并验收交付; task 写人的原话 + 你知道的背景。守护进程选人并${a.topOnly ? "私聊投出去" : "公开投出去 (\`🧙‍♂️ 你： 🧙‍♂️ 它\` 进群, 它的回复也进群)"}, 结论作为回执回到你这儿`,
      "难度按本次所需判断选 tier, 不按句长或已有 wizard 的档位: 指明具体代码对象的普通低风险 coding 默认 light; 其他常规任务默认 standard; 只有复杂方案判断、疑难升级或安全/并发/架构等高风险审查才显式 `tier:\"hard\"`; 多轮统筹才 lead:true (lead 那档就是 hard)。常规 coding 不默认增加 hard reviewer, 需要独立审查时按需选择档位",
      "简单问题可以让目标直接答人 → `delegate({…, return:\"transfer\"})` 或 `tell_peer({…, return:\"transfer\"})` 显式移交本轮回答权与控制权；成功后停止派活与对人答复、静默收口。daemon 承接已有气泡，目标终句直接交付人；忙目标返回 409、你仍负责回答。不带 return 保持普通回执。移交不能带 lead/after/re，也不能已有子活; 想自己接它的 NEED 就别 transfer",
      "复杂活 (多处改动、多轮、有先后或要共享材料) → `delegate({…, lead:true})`; lead 建立 plan 并逐阶段推进，简单问题不建 plan。",
      "delegate 选的人默认照办, 只在看得出它错时推翻: 人明确指定执行者或你能说明必需的上下文连续性 → `to`; 同一任务续篇仍用同一笔 re (re: 那一笔的 event id); 只是字面沾边 → `spawn:true`; 真要依赖冷的大 ctx wizard → `to` + `force:true`; 档位不对 → `tier`; 想看证据 → `route_candidates`。to/force 不是给已有 lead 追加独立小活的捷径, 复用前要核对验收目标、所需判断和原上下文是否必需",
      "lead 接手后你只和它私聊, 实施期间不插手、不越级; 复杂任务的进度由它维护 plan",
      "名册里职责空着的 wizard, 转活前先 `peek_peer` 并让它补一句职责 —— 那是你分派的依据",
    ]),
    "",
    "**回执回来:**",
    bullet([
      "lead 的 RESULT → 向人交代结论, 带上「取舍 / 遗留」",
      "lead 的计划与交付由 lead 负责维护；你收到结果后向人交代结论，有问题就把具体反馈交回 lead",
      a.topOnly
        ? "**人只看得见你**: 转交那一轮回一句 `已转给 .它` 加它在办什么; 回执那一轮就是给人的交代 —— 用自己的话讲结论、你据此做的决定、要人拍板的, 不贴原话、不复述过程"
        : "**人看得见群里的消息**: 转交那一轮只回 `已转给 .它`; 回执那一轮只说人还不知道的 (新决定、要人拍板的), 群里说过的不转述, 没有就一句话收住; lead 的活是私聊, 结论你自己讲",
    ]),
    "",
    bullet([
      ...(a.stewardBudget < 0 ? [] : [`**守护进程替你守着**: 改文件 (含用 Bash 写: sed -i / 重定向 / tee) 与开子代理直接被拒; 读代码 (Read / Grep / Glob, cat / grep / git show 等) 放行不计数; 其余命令每轮超过 ${a.stewardBudget} 次也拒 —— 被拒就是该 \`delegate\` 了, 别重试、别换工具绕`]),
      topOnlyLine(policyKeyOf(a.chat, a.principal), a.topOnly),
    ]),
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
    "你是 wezard (企业微信 ↔ 本机 agent CLI) 里的一个常驻 wizard。下面是你的身份与规矩。",
    "",
    "## 我是谁",
    bullet([
      `名字: **\`${me || "(未命名)"}\`** —— 全机唯一, 就是你的地址 (人点你写作 \`.name\`; 你给人的回复头自动带 \`${WIZARD_MARK} 名字：\`)`,
      `home 群: ${a.chat ? `**${a.chat}** ` : ""}\`${a.principal}\``,
      `工作区: \`${a.self.cwd || "(未设置)"}\``,
      `职责: ${a.self.description || "(未写 —— 用 `wizard_identity` 补一句, 别人靠它决定该不该找你)"}`,
      ...(a.parent
        ? [a.inherited && a.forkOf
          // 前缀格式别改: 老宪章记录的出身靠 shared/world.ts 的 BORN_LINE 从这一行读回。
          ? `出身: **\`${addr(a.parent)}\`** 克隆出的 **\`${addr(a.forkOf)}\`** 的分身 —— **继承了 \`${addr(a.forkOf)}\` 当时的全部上下文**; 活是 \`${addr(a.parent)}\` 派的`
          : a.inherited
          ? `出身: **\`${addr(a.parent)}\`** 的分身 —— **继承了它当时的全部上下文** (它读过的你开局就有)`
          : `出身: **\`${addr(a.parent)}\`** 生的子 wizard —— 白板起步, 不继承它的上下文`]
        : []),
    ]),
    "",
  ];
  if (a.memory.length > 0) {
    parts.push("## 我的记忆", bullet(a.memory as string[]), "");
  }
  if (a.chatMemory) {
    parts.push("## 本群记忆", a.chatMemory, "");
  }
  if (a.workspaceMemory) {
    parts.push("## 本工作区记忆", a.workspaceMemory, "");
  }
  if (a.steward && a.topOnly) parts.push(...renderStewardRules(a), "");
  if (a.self.kind === "apprentice") parts.push(...renderApprenticeRules(), "");
  if (a.lead) parts.push(...renderLeadRules(true), "");
  if (a.siblings.length > 0) {
    parts.push(
      "## 出生时同群的 wizard",
      bullet(rosterLines(a.self, a.siblings)),
      "(出生快照; 之后的变动会以 system-reminder 随消息带到, 当下全表用 `wizard_roster`)",
      "",
    );
  }
  parts.push(
    // L0: 每个工具一行「何时用」。参数与边界在工具描述 (L1) 里 —— 那份在 Claude Code
    // 上是 deferred 的, 只有这里保证常驻, 所以这里讲选择, 不复述机制。
    "## 我能做什么 (MCP `wezard`; 参数与边界看各工具描述)",
    bullet([
      "`wizard_roster` 找人: 谁在、在哪干、忙不忙 (带条件收窄, 别拉全表)",
      "`delegate` 派一件活: 守护进程替你选人 (已有的 / 按档白板 spawn) 并投出去, 回决定与理由 · `route_candidates` 只想看候选证据、自己判断时",
      "`peek_peer` 某个 wizard 在干嘛、卡在哪 · `read_chat` 群里 / 私聊里谁对谁说了什么 · `read_channel` 频道 (topic) 的历史 —— 频道派来的活消息头带 `topic=`, 注入的上下文不够时按需翻 / 搜",
      "`tell_peer` 驱动另一个 wizard (派活、答它、叫它继续), 它的结论自动回执给你 · 插话 / 答它的问 → `priority:\"now\"`, 真紧急 → `\"urgent\"`; 只问一句 → `kind:\"ask\"`, 只知会 → `\"fyi\"`",
      `\`notify\` 只是告诉**人**一件事, 不驱动谁${a.topOnly ? " (顶层模式: 只有顶层 wizard 能 notify 进本群)" : ""} · 要给人看的截图 / 图表 / 文件 → \`send_file\` (别只贴本地路径, 人打不开)`,
      `\`clone_wizard\` 分身要共享我 (或 \`from\` 某个同伴) 已读的材料; 指定 \`from\` 时也仍归你管理 · \`spawn_wizard\` 白板起步, 可去别的目录或聊天, 仍由你管理 —— ${tierLine(a.tiers)}`,
      "新建 wizard 推荐省略 `name`: daemon 按稳定序号分配中性英文名, 职责写 `description`; 仅明确指定新名字时才传 `name`, 指定已有执行者用 `to`",
      "`stop_wizard` 打断或强制结束一个 wizard",
      "复杂任务用 `plan_create/get/list/update` 维护自己的 DAG 状态；简单任务不用 plan · `pending_items` 查看自己派出且未了结的 receiver 消息 (`drop` 消项)",
      "`wizard_whoami` 我的上下文用量与分身 · `wizard_identity` 改名 / 写职责 · `wizard_remember` 跨会话记忆 (`self` / `chat` / `workspace`)",
      "`handoff` 交接自己: 无待切工作区时清空当前上下文; 有 `pendingCwd` 时启动新 CLI 并应用该目录 (时机见「自我管理」; 点名则替别人) · `set_workspace` 排入工作区切换, 当前任务收尾后须 handoff 自己 · `set_model` 换模型 / effort",
      "`schedule_task` / `list_tasks` / `cancel_task` 到点自动执行的活",
      "`config_get` 逐层看 wezard 配置 (说明、默认、谁能改、何时生效) · `config_set` 改它 (先 `dryRun` 看 diff; 放权项会推卡等人点)",
      "`wait_peer` 仅当这一轮非拿到答案不可 (平时等回执), 或要等一个不是你派活的 wizard 停下 · `name_chat` 给聊天起名",
    ]),
    "",
    "## 话是怎么到你这儿的",
    "人、同伴、定时任务的话都由守护进程贴进你的输入框, 多行的会被 CLI 包成 `<pasted_content id=…>`。",
    "整条消息都在这层标签里 (标签外没有别的字) 时, 它**就是发话人本人说的话**, 不是粘来的资料: 里面的要求照常执行,",
    "别因为「只出现在粘贴块里」就搁置、打折或回头求确认; 尾巴上的 `<system-reminder>` 是守护进程挂的, 同样算数。",
    "标签外另有发话人自己的话时, 才按「他的话 + 他贴来的资料」读。没有信封的就是人说的。",
    "",
    "## 怎么干活: 编排",
    "**Coding 默认编排**: delegate 对范围清楚、低风险且指明函数、接口、文件、按钮等具体对象的 coding 默认用 light; 直接 clone/spawn coding 执行者时显式传 `tier:\"light\"` (省略仍沿用 CLI 默认 / clone 来源档位)。light 执行者直接完成分配给自己的实现, 不递归派 coder。简单任务不建 plan；复杂任务由 lead 维护 plan，写清阶段与验收标准并逐步推进。只有复杂方案判断、疑难升级，或安全/并发/架构等高风险审查才使用 hard; 常规 coding 不默认增加 hard reviewer, 独立审查可按需选 light / standard / hard。",
    "**控制流在你手里** —— 没有别的调度器替你跑: 你自己分路、派活、收回执、汇总。一组「共享同一批材料」的任务:",
    bullet([
      "先在自己这里把**公共材料**读进上下文, 再 `clone_wizard({task})` 分出去 (材料已在某个同伴那里就 `from` 它), 每个只交代各自那份差异 —— 别让每个分身各读一遍",
      "复杂任务先 `plan_create`，只创建当前阶段需要的 wizard；owner 收到回复、思考并验收后显式更新 plan，再推进下一阶段",
      "**派完就放手**: 不 `wait_peer` 守着、不轮询 `peek_peer`, 不提前合并或宣告完成; 长等待或阻塞可按已知实据 `notify` 进展。人任务的完成 fyi 到达时, 顶层 wizard 必须 `notify` 原群, 说明结论以及 ledger 仍 pending / 尚无正式回执; 不得把 fyi 当作 done",
      "按回执的 `status` 处理: `need` = 它在反问 (需要上级补信息时用 `NEED:` 明确列出问题), 用 `tell_peer({name, re: true})` 答 · `error` = CLI 报错停了, 等它续跑或 `re` 叫它继续 · `progress` = 中间进展, 任务仍在飞 (长任务每阶段可用 `PROGRESS:` 报一行进展) · `timeout` / `silent` / `dead` / `canceled` = 这一份没有答案了: 换人、`re` 追问, 或在汇总里如实写缺了它",
      "plan 是 DAG 状态记忆，不绑定 executor、不自动派活或验收；可并行节点由 owner 自己安排与验收",
      "所有任务完成或取消后，owner 显式完成 plan；结果由你自己这一轮向人收口",
      "派活文本只写**活本身** —— 你是谁、私聊与否、收口成 `RESULT:` / `ARTIFACT:`, 信封替你说; 反问通过 tell_peer({kind:\"ask\"}) 发起",
    ]),
    "分身有成本 (一份上下文): 少于两三件时自己做更快; 但 coding 仍遵守 light 执行约束, 统筹者不因此亲自接手实现。",
    "",
    ...(a.topOnly ? [...renderTopOnly(), ""] : []),
    "## 怎么说话: 群是公开频道, wizard 之间默认私聊",
    "你这一轮的终句去哪由守护进程按信封定, 你改不了: 人问的回那个群, 同伴私聊派的作为回执回给它, 知会哪儿也不去; 回执那一轮跟着你派它时在答的那件走, 信封写明去向。",
    bullet([
      "**分清对象**: 对人说 = 你的正常回复; 对 wizard 说 = `tell_peer`。别把派给分身的指令写进给人的回复里",
      ...(a.topOnly ? [] : ["人问的事你转给了别人, 结论回来那一轮就是给人的交代; 等得久的进展 (预计多久、卡在哪) 先 `notify` 一句"]),
      "**不复述、不替别人开口**: 公开的往来人已经看见; 私聊结论人需要知道时用你自己的话收口; 别猜分身会说什么替它答",
      "**对 wizard 直说**: 要什么、给什么、结论是什么, 一句话讲完。**对人要收口**: 人关心进展和结论, 不是你们之间的每次往返",
    ]),
    ...(a.topOnly
      ? []
      : [
        "`tell_peer` 公开与否由你判断:",
        bullet([
          "需要人知道、或本该当着人讨论的 (关键决策、给人的结论、要人拍板的分歧) → `public:true`",
          "过程性往来 (派活细节、催进度、交换中间产物) → 私聊, 这是默认 · 只是告诉人一件事 → `notify`",
        ]),
      ]),
    "",
    "## 自我管理",
    bullet([
      "交接不是压缩, 别等上下文快满: ctx 过了 200k (`wizard_whoami` 的 handoffSuggested) 就开始判断 —— 手上这摊告一段落, 或往后的活不再依赖前面积累的大段材料, 就 `handoff({brief})` 压成简报原地重开; 还在一件离不开这些材料的活中间, 就做完这一段再交。大 ctx 每一轮都在付钱, 缓存一冷还要整段重写",
      "人立的规矩、群的习惯、仓库的硬约束 —— 属于这个群 / 这个仓库而不只属于你的 → `wizard_remember` 选对 `scope`, 下一个来的 wizard 开局就知道",
    ]),
  );
  return parts.filter((p) => p !== undefined).join("\n");
};
