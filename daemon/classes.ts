// 类 / 实例 (P1): 一个 bot 内的「人物设定」, 与它的稳定地址。
//
//   类   = <role, workspace> 唯一的人物设定 (名字 / 职责 / 专长 / 记忆 / workspace), 一张独立表
//   实例 = 类落在某个聊天里的那条 wizard 记录; 名字 = `<类名>-<N>`, N 每类从 1 单调递增、永不复用
//
// 地址始终是实例的 target (routes / 账本 / receipt 只认这个字符串, 全仓 identityOf 不改);
// 类只回答「这个人是谁」。本模块 = 一张写穿表 + 名字空间的**纯函数** + 迁移计划。
// 会话 / pane / 出站一个都不碰 —— 接 boot 是下一阶段的事。
//
// 与 wizard.ts 互相 import (wizard 的 rename/claim/byName 要看类): 两边顶层都只有函数定义,
// 运行期调用都发生在模块求值之后, ESM 的循环依赖在这里是安全的。
import { copyFileSync, existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { loadJsonMap } from "../shared/json-map-store.js";
import { expandHome } from "../shared/paths.js";
import { botOfKey, tagOfKey } from "../shared/session-label.js";
import { foldName, identityOf, MEMORY_MAX, type WizardRecord, type WizardStore } from "./wizard.js";

/** 迁移前备份的后缀: `<wizardsFile>.pre-classes.bak`, 只在第一次写盘前复制一次。 */
export const CLASS_BACKUP_SUFFIX = ".pre-classes.bak";

/** 类名上限: 实例名 = 类名 + `-<序号>`, 要落进名字字符集 (WIZARD_NAME_RE ≤32)。 */
export const CLASS_NAME_MAX = 28;

/** 规范路径: 展开 ~、resolve、去掉末尾 "/" (根 "/" 保留)。空串 → ""。
 *  原先私有在 daemon/steward.ts (管家的 <role, workspace> 判重), 类表也用同一把尺子 ——
 *  两处各写一份就会在 `~/x/` 与 `/Users/…/x` 上判成两个目录。 */
export const normPath = (p: string | undefined): string => {
  const s = (p ?? "").trim();
  if (!s) return "";
  const r = resolve(expandHome(s));
  return r.length > 1 && r.endsWith("/") ? r.replace(/\/+$/, "") || "/" : r;
};

export interface ClassRecord {
  /** 类 id: 迁移来的 = 原 identity (锚点 target 字符串); 新建的 = 首个实例的 target。
   *  保持「identity id 就是 target 字符串」这条不变量, 全仓的账本字符串因此一个都不用改。 */
  id: string;
  /** 归哪个机器人 (target 的 ~bot 后缀, "" = 主机器人)。 */
  bot: string;
  /** 类名 (bot 内唯一, 不以 -数字 结尾, ≤ CLASS_NAME_MAX)。 */
  name: string;
  /** 人物设定的角色; 本阶段只有 "steward" 会被迁入。 */
  role: string;
  /** 规范化后的工作区; "" = 还推不出来 (待人补)。 */
  workspace: string;
  description: string;
  expertise?: string;
  memory: string[];
  /** 下一个要分配的序号 (只增不减: 实例 drop 掉的号不还)。 */
  nextOrdinal: number;
  createdAt: number;
}

export interface ClassStore {
  get: (id: string) => ClassRecord | undefined;
  /** 类名 (大小写不敏感, 与 wizard.ts 的 foldName 同一折叠)。 */
  byName: (name: string) => ClassRecord | undefined;
  /** <bot, role, workspace> 唯一的类; workspace "" 不参与 (还不是一个可判定的地址)。 */
  byKey: (bot: string, role: string, workspace: string) => ClassRecord | undefined;
  /** 撞 id / 撞名 / 撞 <bot, role, workspace> 都抛错 —— 静默覆盖会让两个人物共用一个地址。 */
  create: (init: ClassInit) => ClassRecord;
  upsert: (id: string, patch: Partial<Omit<ClassRecord, "id">>) => ClassRecord;
  /** 领一个序号并落盘 (+1); 返回领到的那个。 */
  allocOrdinal: (id: string) => number;
  rename: (id: string, want: string) => ClassRecord;
  all: () => ClassRecord[];
}

export interface ClassInit extends Omit<ClassRecord, "workspace" | "memory" | "nextOrdinal" | "createdAt" | "description"> {
  workspace?: string;
  description?: string;
  memory?: string[];
  nextOrdinal?: number;
  createdAt?: number;
}

// ── 名字空间 (纯函数) ──────────────────────────────────────────────────

/** 实例的地址名。 */
export const instanceName = (className: string, ordinal: number): string => `${className}-${ordinal}`;

/** 实例名 → {类名, 序号}; 不是 `<类名>-<数字>` 形状 → undefined。 */
export const parseInstanceName = (name: string | undefined): { className: string; ordinal: number } | undefined => {
  const m = /^(.+)-(\d+)$/.exec((name ?? "").trim());
  if (!m) return undefined;
  const ordinal = Number(m[2]);
  if (!Number.isSafeInteger(ordinal) || ordinal < 1) return undefined;
  return { className: m[1]!, ordinal };
};

/** 类名合不合法: 1..CLASS_NAME_MAX 个名字字符, 且不以 `-数字` 结尾
 *  (那样它自己就长得像一个实例, 名字→类的解析会翻车)。 */
export const validClassName = (name: string | undefined): boolean => {
  const n = (name ?? "").trim();
  return n.length > 0 && n.length <= CLASS_NAME_MAX && /^[\p{L}\p{N}_-]+$/u.test(n) && !/-\d+$/.test(n);
};

/** `name` 是否落在类名字空间里: 某个类名本身, 或某个类的 `<类名>-<数字>`。
 *  自由名 (自动名 / 手工改名) 一律避开这一片, 否则实例地址会被别人占走。 */
export const inClassSpace = (name: string | undefined, classNames: readonly string[]): boolean => {
  const k = foldName((name ?? "").trim());
  if (!k) return false;
  const folded = new Set(classNames.map((n) => foldName(n)).filter(Boolean));
  if (folded.has(k)) return true;
  const inst = parseInstanceName(name);
  return !!inst && folded.has(foldName(inst.className));
};

// ── 写穿表 ────────────────────────────────────────────────────────────

const tidy = (rec: ClassRecord): ClassRecord => ({
  ...rec,
  workspace: normPath(rec.workspace),
  memory: (rec.memory ?? []).slice(-MEMORY_MAX),
});

export const loadClassStore = (filePath: string): ClassStore => {
  const db = loadJsonMap<ClassRecord>(filePath, undefined, { strict: true });
  const all = (): ClassRecord[] => Object.values(db.all());
  const byName = (name: string): ClassRecord | undefined => {
    const k = foldName((name ?? "").trim());
    return k ? all().find((c) => foldName(c.name) === k) : undefined;
  };
  const byKey = (bot: string, role: string, workspace: string): ClassRecord | undefined => {
    const want = normPath(workspace);
    if (!want) return undefined;
    return all().find((c) => c.bot === bot && c.role === role && c.workspace === want);
  };
  const create = (init: ClassInit): ClassRecord => {
    const id = (init.id ?? "").trim();
    if (!id) throw new Error("class id must not be empty");
    if (db.get(id)) throw new Error(`class already exists: ${id}`);
    if (!validClassName(init.name)) throw new Error(`invalid class name: ${init.name || "(empty)"}`);
    if (byName(init.name)) throw new Error(`class name taken: ${init.name}`);
    const rec = tidy({
      id,
      bot: init.bot,
      name: init.name.trim(),
      role: init.role,
      workspace: init.workspace ?? "",
      description: init.description ?? "",
      ...(init.expertise !== undefined ? { expertise: init.expertise } : {}),
      memory: init.memory ?? [],
      nextOrdinal: init.nextOrdinal ?? 1,
      createdAt: init.createdAt ?? Date.now(),
    });
    if (rec.workspace) {
      const twin = byKey(rec.bot, rec.role, rec.workspace);
      if (twin) throw new Error(`class key taken: ${rec.bot}/${rec.role}/${rec.workspace} = ${twin.id}`);
    }
    return db.set(id, rec);
  };
  const upsert = (id: string, patch: Partial<Omit<ClassRecord, "id">>): ClassRecord => {
    const base = db.get(id);
    if (!base) throw new Error(`unknown class: ${id}`);
    const next = tidy({ ...base, ...patch, id });
    if (patch.name !== undefined && foldName(next.name) !== foldName(base.name)) {
      if (!validClassName(next.name)) throw new Error(`invalid class name: ${next.name || "(empty)"}`);
      const clash = byName(next.name);
      if (clash && clash.id !== id) throw new Error(`class name taken: ${next.name}`);
    }
    if (patch.workspace !== undefined && next.workspace && next.workspace !== base.workspace) {
      const twin = byKey(next.bot, next.role, next.workspace);
      if (twin && twin.id !== id) throw new Error(`class key taken: ${next.bot}/${next.role}/${next.workspace} = ${twin.id}`);
    }
    return db.set(id, next);
  };
  return {
    get: db.get,
    byName,
    byKey,
    create,
    upsert,
    allocOrdinal: (id) => {
      const rec = db.get(id);
      if (!rec) throw new Error(`unknown class: ${id}`);
      const n = rec.nextOrdinal;
      upsert(id, { nextOrdinal: n + 1 });
      return n;
    },
    rename: (id, want) => upsert(id, { name: (want ?? "").trim() }),
    all,
  };
};

// ── 迁移 (v3 管家身份 → 类 + 实例) ──────────────────────────────────────
//
// 只有 steward / global-steward 迁入 (apprentice / worker 本阶段保持旧形态):
// 一个身份的**全部化身** = 同一个类的一串实例, 按出生先后编号 1..n; target 一个都不改
// (账本/路由里的字符串因此不用重写), 只有名字变成 `<类名>-<序号>` 并落上 ordinal。

export interface ClassRename {
  target: string;
  from: string;
  to: string;
  ordinal: number;
  /** 合并时要把记录的 identity 改成类的 id; 单组迁移不带 (identity 本来就是它)。 */
  identity?: string;
}

export interface ClassPlan {
  /** 要新建的类 (按 id 排序, 结果与记录顺序无关)。 */
  classes: ClassRecord[];
  /** 要落名的实例; 第二次跑恒为空 (类已存在 → 整组跳过)。 */
  renames: ClassRename[];
  /** 跳过的组 (整组不写) 与需要人确认的提示; 每行自带 `skip:` / `note:` 前缀。 */
  conflicts: string[];
  /** 旧名 → 类名 (每组锚点的旧名): 迁移后管家绑定一律存类名, 调用方据此改写 config。 */
  aliases: Array<{ from: string; to: string }>;
}

// ── 人拍的合并 / 排除清单 (<stateDir>/class-merges.json) ─────────────────
// <role, workspace> 唯一会说「同目录上两个人 = 一个人」, 但存量名册里那一串旧身份
// (cc-wecom-4…18、serviceaiteam、auto) 是按旧规则 -N 退出来的, 名字不像实例、也合并
// 不了 —— 人直接给一张表: 哪些身份并进哪个类 (新名字), 哪些组保持旧形态不动。
// 文件不存在 = 没有合并, 纯旧行为。

export interface ClassMerge {
  /** 合并后类的 id (= 锚点 target 字符串, 账本地址不动)。 */
  into: string;
  /** 合并后的类名。 */
  name: string;
  /** 编号第 1 的那个 target (缺省 = into)。 */
  first?: string;
  /** 并进来的 identity 列表 (含 into 自己, 也容忍列表里出现过期 id)。 */
  members: string[];
}

export interface ClassMergeSpec {
  merges: ClassMerge[];
  /** 保持旧形态、也不报冲突的 identity。 */
  exclude: string[];
}

export const NO_MERGES: ClassMergeSpec = { merges: [], exclude: [] };

/** 读合并清单。文件坏了 / 不存在 → 空表 (迁移退化成纯单组模式, 不炸 boot)。 */
export const loadClassMerges = (filePath: string): ClassMergeSpec => {
  try {
    const raw = JSON.parse(readFileSync(expandHome(filePath), "utf8")) as Partial<ClassMergeSpec> | null;
    if (!raw || typeof raw !== "object") return NO_MERGES;
    const merges = Array.isArray(raw.merges)
      ? raw.merges.filter((m): m is ClassMerge =>
        !!m && typeof m.into === "string" && !!m.into.trim()
        && typeof m.name === "string" && !!m.name.trim()
        && Array.isArray(m.members) && m.members.every((x) => typeof x === "string"))
        .map((m) => ({ ...m, members: [...new Set([...m.members, m.into])] }))
      : [];
    const exclude = Array.isArray(raw.exclude) ? raw.exclude.filter((x): x is string => typeof x === "string") : [];
    return { merges, exclude };
  } catch { return NO_MERGES; }
};

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const kindOf = (w: WizardRecord): string => w.kind ?? (tagOfKey(w.target) ? "worker" : "steward");

const isStewardish = (w: WizardRecord): boolean => kindOf(w) === "steward" || kindOf(w) === "global-steward";

/** 按出生先后 (同刻按 target) —— 序号就是这一列的下标 + 1。 */
const byBirth = (a: WizardRecord, b: WizardRecord): number => a.bornAt - b.bornAt || cmp(a.target, b.target);

/** 组内的锚点 (与 anchorOf 同义): target === identity 的那条优先, 否则最老的一条。 */
const anchorIn = (kin: readonly WizardRecord[], id: string): WizardRecord | undefined =>
  kin.find((w) => w.target === id) ?? kin.slice().sort(byBirth)[0];

const classProblem = (
  name: string,
  id: string,
  others: readonly ClassRecord[],
): string | undefined => {
  const n = name.trim();
  if (!n) return "锚点没有名字";
  if (n.length > CLASS_NAME_MAX) return `类名超过 ${CLASS_NAME_MAX} 字符`;
  if (/-\d+$/.test(n)) return "类名以 -数字 结尾 (会被解析成实例名)";
  if (!validClassName(n)) return "类名含名字字符集之外的字符";
  const twin = others.find((c) => c.id !== id && foldName(c.name) === foldName(n));
  return twin ? `与已存在的类 ${twin.id} 撞名` : undefined;
};

export const planClasses = (
  records: readonly WizardRecord[],
  existingClasses: readonly ClassRecord[],
  cwdOf: (target: string) => string = () => "",
  merges: ClassMergeSpec = NO_MERGES,
): ClassPlan => {
  const conflicts: string[] = [];
  const groups = new Map<string, WizardRecord[]>();
  for (const w of records) {
    const id = identityOf(w);
    const kin = groups.get(id);
    if (kin) kin.push(w); else groups.set(id, [w]);
  }
  const known = new Set(existingClasses.map((c) => c.id));
  const excluded = new Set(merges.exclude);
  const consumed = new Set<string>();
  const pending: ClassRecord[] = [];
  const renames: ClassRename[] = [];
  const aliasMap = new Map<string, string>();
  /** 把一组 (合并时是多组) 记录规划成一个类 + 一串有序号实例。 */
  const planGroup = (ids: readonly string[], classId: string, name: string, first?: string, bot = botOfKey(classId)): void => {
    const kin = ids.flatMap((id) => groups.get(id) ?? []);
    if (!kin.length) return;
    const label = `${classId} (${name || "<无名>"})`;
    const why = classProblem(name, classId, [...existingClasses, ...pending]);
    if (why) { conflicts.push(`skip: ${label} — ${why}`); return; }
    const firstKey = first ?? classId;
    const anchor = kin.find((w) => w.target === firstKey) ?? anchorIn(groups.get(classId) ?? kin, classId)!;
    const workspace = normPath(anchor.workspace) || normPath(cwdOf(anchor.target));
    const twin = workspace
      ? [...existingClasses, ...pending].find((c) => c.bot === bot && c.role === "steward" && c.workspace === workspace)
      : undefined;
    if (twin) {
      conflicts.push(`skip: ${label} — 与 ${twin.id} 同占 ${bot || "主"}/${workspace}, 两边的旧形态都保留, 待人确认是否合并`);
      return;
    }
    if (!workspace) conflicts.push(`note: ${label} — 推不出 workspace, 类先以 "" 落库, 待人补`);
    // 编号: first 的 target 是 -1, 其余按出生先后 (同刻按 target)。合并进来的各组一视同仁。
    const instances = kin.slice().sort((a, b) => Number(a.target !== firstKey) - Number(b.target !== firstKey) || byBirth(a, b));
    pending.push({
      id: classId,
      bot,
      name,
      role: "steward",
      workspace,
      description: anchor.description ?? "",
      ...(anchor.expertise !== undefined ? { expertise: anchor.expertise } : {}),
      memory: [...(anchor.memory ?? [])],
      nextOrdinal: instances.length + 1,
      createdAt: Math.min(...instances.map((w) => w.bornAt)),
    });
    instances.forEach((w, i) => {
      const ordinal = i + 1;
      const to = instanceName(name, ordinal);
      const identity = identityOf(w) === classId ? undefined : classId;
      if (w.name !== to || w.ordinal !== ordinal || identity) {
        renames.push({ target: w.target, from: w.name, to, ordinal, ...(identity ? { identity } : {}) });
      }
    });
    // 绑定里存的是**名字**: 每个被收进来的组的锚点旧名都指向这个类名。
    for (const id of ids) {
      const old = anchorIn(groups.get(id) ?? [], id)?.name?.trim();
      if (old && foldName(old) !== foldName(name)) aliasMap.set(foldName(old), name);
    }
    ids.forEach((id) => consumed.add(id));
  };

  // ① 人拍的合并: 多组并成一个类 (exclude 的组保持旧形态, 不报冲突)。
  for (const m of merges.merges) {
    if (known.has(m.into)) continue; // 已迁过 → 整条跳过 (幂等)
    const ids = [...new Set([...m.members, m.into])].filter((id) => groups.has(id) && !known.has(id) && !excluded.has(id));
    if (ids.length) planGroup(ids, m.into, m.name.trim(), m.first);
  }
  // ② 其余管家组: 一组一个类 (名字取锚点名)。
  for (const [id, kin] of [...groups].sort(([a], [b]) => cmp(a, b))) {
    if (known.has(id) || excluded.has(id) || consumed.has(id)) continue;
    const anchor = anchorIn(kin, id)!;
    if (!isStewardish(anchor)) continue;
    planGroup([id], id, (anchor.name ?? "").trim());
  }
  return {
    classes: pending.sort((a, b) => cmp(a.id, b.id)),
    renames,
    conflicts,
    aliases: [...aliasMap].map(([from, to]) => ({ from, to })),
  };
};

export interface ClassMigration {
  /** 本次落名的实例数 (0 = 没有可迁的 / 已迁完)。 */
  migrated: number;
  conflicts: string[];
  /** 旧名 → 类名: 调用方据此把管家绑定改写成类名 (迁移后绑定存的都是类名)。 */
  aliases: Array<{ from: string; to: string }>;
  /** 本次创建的备份路径; 没写盘就没有。 */
  backup?: string;
  /** 没迁成的原因 (备份失败); 原文件一个字节没动。 */
  skipped?: string;
}

/** 执行迁移计划, 失败安全手法照抄 migrateIdentities: 先备份后写盘, 备份失败一条都不写,
 *  下次再跑照旧 (计划是纯函数, 重算一次就好)。 */
export const migrateClasses = (
  store: WizardStore,
  classes: ClassStore,
  filePath: string,
  cwdOf: (target: string) => string = () => "",
  merges: ClassMergeSpec = NO_MERGES,
): ClassMigration => {
  const plan = planClasses(store.all(), classes.all(), cwdOf, merges);
  if (!plan.classes.length && !plan.renames.length) {
    return { migrated: 0, conflicts: plan.conflicts, aliases: plan.aliases };
  }
  const abs = expandHome(filePath);
  const backup = abs + CLASS_BACKUP_SUFFIX;
  try {
    if (!(existsSync(backup) && statSync(backup).isFile())) copyFileSync(abs, backup);
  } catch (e) {
    return { migrated: 0, conflicts: plan.conflicts, aliases: [], skipped: `backup failed: ${(e as Error).message}` };
  }
  plan.classes.forEach((c) => classes.create(c));
  plan.renames.forEach((r) => store.upsert(r.target, {
    name: r.to,
    ordinal: r.ordinal,
    ...(r.identity ? { identity: r.identity } : {}),
  }));
  return { migrated: plan.renames.length, conflicts: plan.conflicts, aliases: plan.aliases, backup };
};
