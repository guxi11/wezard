// Job: 一次 fan-out 的工单。
//
// send_peer 是点对点, run_agent_graph 是预先声明好的静态流水线, 中间空着的正是
// 「运行时才知道要分几路」的那一种活: 读完材料才知道有 5 个模块要改, 于是现生 5
// 个分身、各派一段、一起等回来。那种活没法写成 graph 的 steps —— 分几路是想出来
// 的, 不是声明出来的。
//
// 所以这里不做第二个编排器。**控制流始终留在发起那个 wizard 的上下文里** (它自己
// spawn、自己 wait、自己汇总), 守护进程只持有一本账:
//
//   谁属于这个工单 · 谁是为它临时生出来的 · 收工时该收掉谁 · 各自落成了什么
//
// 这个取舍是有来由的: graph.ts 把控制流搬进了守护进程, 代价是 run 只能活在内存里,
// reload 即丢。账本没有这个问题 —— 它是死的数据, 落盘即可; 而控制流留在 wizard
// 那边, 重启之后它重试一次就接上了, 比恢复一个状态机简单一个数量级。
//
// 工单整个是私下的: 开工、派活、回执、收工都不进群 —— 人看不懂这些过程, 结构留给
// rolepage 的工单页读。群里只有发起者自己那一轮的最终回复, 用它自己的话收口。
import { randomUUID } from "node:crypto";
import { loadJsonMap } from "../shared/json-map-store.js";
import type { Terminal, TurnState } from "../shared/turn-state.js";
import type { JobStage, MemberRole } from "../shared/world.js";
import type { Closing } from "./peers.js";
import type { JobEpisode } from "./wizard-memory.js";

export interface Artifact { path: string; note: string }

/** 成员交差的验收: `result` (默认) = 要有非空的 `RESULT:`; `artifact` = 还要列出 `ARTIFACT:`;
 *  `none` = 不验。不合格的那一份由守护进程打回一次 (见 receipts.ts)。 */
export type Accept = "result" | "artifact" | "none";
export const ACCEPTS: readonly Accept[] = ["result", "artifact", "none"];

/** 这份答复不合格的理由; 合格 = undefined。 */
export const rejectReason = (accept: Accept, c: Closing): string | undefined =>
  accept === "none" ? undefined
    : c.kind !== "result" || !c.text.trim() ? "没有 `RESULT:` 收口 (或 RESULT 后面是空的)"
      : accept === "artifact" && !c.artifacts.length ? "没有列出 `ARTIFACT:` 交付物"
        : undefined;

export interface JobMember {
  target: string;
  /** 派给它的那一段活 —— 工单页与收工留档里按成员列出来。 */
  task: string;
  /** 为这个工单**临时生出来**的; 只有这些会在收工时被回收。已经存在的 wizard
   *  被拉进来帮忙不该因为工单结束就被杀掉。 */
  spawned: boolean;
  at: number;
  /** 这一份落定了没有、落成什么。「齐了吗」只数它: 回执登记按发话方 → 答话方一对一份,
   *  会被同一对的后一句顶掉, 账本不会。need / error 是中途的, 不进账。 */
  outcome?: Terminal;
  /** 定论落下的时刻 (根单的「交付于」从 lead 的它读)。 */
  settledAt?: number;
  artifacts?: Artifact[];
  /** 它在这张单里是什么 (缺省 exec)。 */
  role?: MemberRole;
  /** clone 时材料来自谁 (target key): lead 要再派一段同材料的活, 账本直接告诉它该从谁 clone。 */
  forkOf?: string;
}

export interface JobRecord {
  id: string;
  /** 工单属于哪个聊天 (list_jobs 按它筛)。 */
  base: string;
  /** 发起的 wizard。 */
  owner: string;
  title: string;
  /** 开工时说的计划 (分几路、各干什么) —— 只进账本, 给工单页读。 */
  plan?: string;
  /** 成员交差的验收 (缺省 = result)。 */
  accept?: Accept;
  /** 开工时说好要几份 —— 分身还没派齐时「一共几份」的下限。 */
  expect?: number;
  /** 派活次数的预算 (每次带这张工单的 tell_peer / 带 task 的 spawn 记一次, 续问也算) ——
   *  NEED 乒乓、续问兜圈的全局刹车; graph 的 rounds 在这里的等价物。没有 = 不限。 */
  maxTurns?: number;
  /** 已经派了几次。 */
  turns?: number;
  /** 上级工单 (金字塔: 工单树); 缺省 = 树根。 */
  parent?: string;
  /** `req` = 需求根单 (管家派 lead 时开): 交付后不自动归档, 等人验收。 */
  kind?: "req";
  /** 验收标准。 */
  criteria?: string;
  /** 需求原话与它来自哪个群 (只根单有)。 */
  origin?: { text: string; chat: string };
  members: JobMember[];
  status: "open" | "closed";
  openedAt: number;
  closedAt?: number;
  summary?: string;
}

export interface JobOpenOpts {
  plan?: string; expect?: number; maxTurns?: number; accept?: Accept;
  parent?: string; kind?: "req"; criteria?: string; origin?: { text: string; chat: string };
}

export interface JobStore {
  open: (base: string, owner: string, title: string, opts?: JobOpenOpts) => JobRecord;
  /** 记一次派活; 返回记完之后的用量。 */
  spend: (id: string) => { turns: number; maxTurns?: number } | undefined;
  get: (id: string) => JobRecord | undefined;
  /** 同一个 target 再次 attach 更新它那一段活, 并清掉它已落定的那一份 (又在干了)。 */
  attach: (id: string, member: Omit<JobMember, "at">) => JobRecord | undefined;
  /** 记下某个成员那一份的定论。不在册 / 已收工 = 不记; 已有定论不改写 (终态写一次)。 */
  settle: (id: string, target: string, outcome: Terminal, artifacts?: Artifact[]) => JobRecord | undefined;
  /** 已落定几份 / 一共几份 (成员数与 expect 取大)。 */
  tally: (id: string) => { done: number; total: number } | undefined;
  close: (id: string, summary: string) => JobRecord | undefined;
  /** 一个 wizard 被 forget 了: 它在开着的工单里还没落定的那一份永远不会落定了, 记成
   *  canceled (留着行, 不删 —— 删了 expect 撑着的总数就永远凑不齐, 也丢了它派的是哪段活);
   *  已落定的 (连同交付物) 原样不动。返回动过的工单 id。 */
  detach: (target: string) => string[];
  /** 某个聊天里还开着的工单, 新的在前。 */
  openOf: (base: string) => JobRecord[];
  all: () => JobRecord[];
}

/** 一个工单最多带这么多直接成员 —— 管辖幅度: 超了就该长一层子 lead, 不是再塞人。
 *  (同时也是 "忘了收" 的刹车: 每个成员是一个 tmux pane 加一份上下文。) */
export const JOB_MEMBER_MAX = 5;
/** 工单树深度上限: 1 = 根单, 2 = lead 的子单, 3 = 子 lead 的子单。 */
export const JOB_DEPTH_MAX = 3;
const KEEP_CLOSED_MS = 24 * 60 * 60 * 1000;

const newId = (): string => `J${randomUUID().slice(0, 6)}`;

/** 写穿式单文件存储, 同 wizard 注册表。收工满 24h 的工单在下一次写盘时被丢掉 ——
 *  账本是为了收尾, 不是为了存档。 */
const dropStale = (map: Record<string, JobRecord>): Record<string, JobRecord> => {
  const cutoff = Date.now() - KEEP_CLOSED_MS;
  // 祖先里还有开着的 (交付等人验收可以等好几天) → 已收工的子单留着, 免得面包屑断。
  const rootOpen = (j: JobRecord): boolean => ancestorsOf((id) => map[id], j).some((a) => a.status === "open");
  return Object.fromEntries(
    Object.entries(map).filter(([, j]) => j.status === "open" || (j.closedAt ?? 0) > cutoff || rootOpen(j)),
  );
};


// ── 工单树 (纯函数) ─────────────────────────────────────────────────

type JobGet = (id: string) => JobRecord | undefined;

/** 祖先链, 由近及远 (不含自己)。带环保护: 账本是落盘数据, 不信它没写坏。 */
export const ancestorsOf = (get: JobGet, j: JobRecord): JobRecord[] => {
  const go = (cur: JobRecord, seen: ReadonlySet<string>): JobRecord[] => {
    const p = cur.parent && !seen.has(cur.parent) ? get(cur.parent) : undefined;
    return p ? [p, ...go(p, new Set([...seen, p.id]))] : [];
  };
  return go(j, new Set([j.id]));
};
/** 深度: 根 = 1。 */
export const depthOf = (get: JobGet, j: JobRecord): number => 1 + ancestorsOf(get, j).length;
export const childrenOf = (all: readonly JobRecord[], id: string): JobRecord[] =>
  all.filter((j) => j.parent === id).sort((a, b) => a.openedAt - b.openedAt);

/** 前序展开成树序: 根在前、子单跟在父后。返回 [工单, 深度]。父不在账里的当根。 */
export const treeOrder = (all: readonly JobRecord[]): Array<[JobRecord, number]> => {
  const ids = new Set(all.map((j) => j.id));
  const walk = (j: JobRecord, d: number): Array<[JobRecord, number]> =>
    [[j, d], ...childrenOf(all, j.id).flatMap((c) => walk(c, d + 1))];
  return all
    .filter((j) => !j.parent || !ids.has(j.parent))
    .sort((a, b) => b.openedAt - a.openedAt)
    .flatMap((r) => walk(r, 1));
};

const roleOf = (mm: JobMember): MemberRole => mm.role ?? "exec";
/** 成员此刻的态: 定论 > 在飞的实时态 > 无 (= 还没派上 / 不知道)。 */
export type MemberLive = (j: JobRecord, mm: JobMember) => TurnState | undefined;

/** 一张单现算的阶段 —— 不落盘 (见设计文档 §3.2)。 */
export const jobStage = (j: JobRecord, all: readonly JobRecord[], live: MemberLive): JobStage => {
  if (j.status === "closed") return "closed";
  const open = j.members.filter((mm) => !mm.outcome);
  const asking = open.some((mm) => live(j, mm) === "needs-input");
  if (j.kind === "req") {
    const lead = j.members.find((mm) => roleOf(mm) === "lead");
    if (lead?.outcome === "done") return "deliver";
    if (asking) return "clarify";
    const sub = childrenOf(all, j.id).find((c) => c.status === "open" && c.members.length);
    return sub ? jobStage(sub, all, live) : "plan";
  }
  if (!j.members.length) return "plan";
  if (asking) return "clarify";
  const doers = j.members.filter((mm) => roleOf(mm) !== "reviewer" && roleOf(mm) !== "expert");
  const reviewers = j.members.filter((mm) => roleOf(mm) === "reviewer");
  return doers.some((mm) => !mm.outcome) ? "build"
    : reviewers.some((mm) => !mm.outcome) ? "review"
      : open.length ? "build" : "deliver";
};

const ROLE_ZH: Readonly<Record<MemberRole, string>> = { lead: "lead", exec: "执行", reviewer: "评审", expert: "专家" };
/** 名册里一个 wizard 的任职: 开着的单里它是什么 (`J1 lead · J2 评审 · J3 开单`); 没有 = 空串。 */
export const dutyLine = (all: readonly JobRecord[], target: string): string =>
  all.filter((j) => j.status === "open")
    .flatMap((j) => [
      ...(j.owner === target ? [`${j.id} 开单`] : []),
      ...j.members.filter((mm) => mm.target === target).map((mm) => `${j.id} ${ROLE_ZH[mm.role ?? "exec"]}`),
    ])
    .join(" · ");

/** 等人验收的根单: owner 的需求根单里 lead 已交差、单还开着。交付时刻 = lead 落定的那一刻。 */
export const awaitingAccept = (all: readonly JobRecord[], owner: string, live: MemberLive): Array<{ job: JobRecord; at: number }> =>
  all.filter((j) => j.kind === "req" && j.owner === owner && jobStage(j, all, live) === "deliver")
    .map((j) => ({ job: j, at: j.members.find((mm) => (mm.role ?? "exec") === "lead")?.settledAt ?? j.openedAt }));

export const loadJobStore = (filePath: string): JobStore => {
  const db = loadJsonMap<JobRecord>(filePath, dropStale);
  return {
    open: (base, owner, title, { plan, expect, maxTurns, accept, parent, kind, criteria, origin } = {}) => {
      const id = newId();
      return db.set(id, { id, base, owner, title, ...(parent ? { parent } : {}), ...(kind ? { kind } : {}), ...(criteria ? { criteria } : {}), ...(origin ? { origin } : {}), ...(plan ? { plan } : {}), ...(accept && accept !== "result" ? { accept } : {}), ...(expect ? { expect } : {}), ...(maxTurns ? { maxTurns, turns: 0 } : {}), members: [], status: "open", openedAt: Date.now() });
    },
    spend: (id) => {
      const j = db.get(id);
      if (!j) return undefined;
      const turns = (j.turns ?? 0) + 1;
      db.set(id, { ...j, turns });
      return { turns, ...(j.maxTurns ? { maxTurns: j.maxTurns } : {}) };
    },
    get: db.get,
    attach: (id, member) => {
      const j = db.get(id);
      if (!j || j.status !== "open" || j.members.length >= JOB_MEMBER_MAX) return undefined;
      const rest = j.members.filter((x) => x.target !== member.target);
      const prev = j.members.find((x) => x.target === member.target);
      // 再派一段 (含 re 续问) = 它又在干了: 旧的定论作废, 不然「全部到齐」会提前报、
      // close_job 会把还在干活的它收掉。
      const role = member.role ?? prev?.role;
      const forkOf = member.forkOf ?? prev?.forkOf;
      return db.set(id, { ...j, members: [...rest, { ...member, task: member.task || prev?.task || "", spawned: member.spawned || !!prev?.spawned, ...(role ? { role } : {}), ...(forkOf ? { forkOf } : {}), at: Date.now() }] });
    },
    settle: (id, target, outcome, artifacts) => {
      const j = db.get(id);
      if (!j || j.status !== "open" || !j.members.some((x) => x.target === target && !x.outcome)) return undefined;
      return db.set(id, {
        ...j,
        members: j.members.map((x) => (x.target === target ? { ...x, outcome, settledAt: Date.now(), ...(artifacts?.length ? { artifacts } : {}) } : x)),
      });
    },
    tally: (id) => {
      const j = db.get(id);
      return j && { done: j.members.filter((x) => x.outcome).length, total: Math.max(j.members.length, j.expect ?? 0) };
    },
    close: (id, summary) => {
      const j = db.get(id);
      return j ? db.set(id, { ...j, status: "closed", closedAt: Date.now(), summary }) : undefined;
    },
    detach: (target) =>
      Object.values(db.all())
        .filter((j) => j.status === "open" && j.members.some((x) => x.target === target && !x.outcome))
        .map((j) => db.set(j.id, {
          ...j,
          members: j.members.map((x) => (x.target === target && !x.outcome ? { ...x, outcome: "canceled" as const } : x)),
        }).id),
    openOf: (base) =>
      Object.values(db.all()).filter((j) => j.base === base && j.status === "open").sort((a, b) => b.openedAt - a.openedAt),
    all: () => Object.values(db.all()),
  };
};

/** 收工的工单 → 一条情景记忆 (见 wizard-memory.ts)。名字、sessionId、聊天名由调用方给:
 *  这里不碰注册表。sid 要在回收分身**之前**取 —— 收掉之后绑定就没了, transcript 是唯一的现场。 */
export const jobEpisode = (
  job: JobRecord,
  o: { nameOf: (target: string) => string; sidOf: (target: string) => string; chat: string },
): JobEpisode => ({
  at: job.closedAt ?? Date.now(),
  kind: "job",
  name: o.nameOf(job.owner),
  sid: o.sidOf(job.owner),
  chat: o.chat,
  job: job.id,
  title: job.title,
  openedAt: job.openedAt,
  text: job.summary ?? "",
  members: job.members.map((mm) => ({
    name: o.nameOf(mm.target),
    sid: o.sidOf(mm.target),
    spawned: mm.spawned,
    task: mm.task,
    ...(mm.outcome ? { outcome: mm.outcome } : {}),
    ...(mm.artifacts?.length ? { artifacts: mm.artifacts } : {}),
  })),
});
