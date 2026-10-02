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
import type { Terminal } from "../shared/turn-state.js";
import type { JobEpisode } from "./wizard-memory.js";

export interface Artifact { path: string; note: string }

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
  artifacts?: Artifact[];
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
  /** 开工时说好要几份 —— 分身还没派齐时「一共几份」的下限。 */
  expect?: number;
  /** 派活次数的预算 (每次带这张工单的 tell_peer / 带 task 的 spawn 记一次, 续问也算) ——
   *  NEED 乒乓、续问兜圈的全局刹车; graph 的 rounds 在这里的等价物。没有 = 不限。 */
  maxTurns?: number;
  /** 已经派了几次。 */
  turns?: number;
  members: JobMember[];
  status: "open" | "closed";
  openedAt: number;
  closedAt?: number;
  summary?: string;
}

export interface JobStore {
  open: (base: string, owner: string, title: string, opts?: { plan?: string; expect?: number; maxTurns?: number }) => JobRecord;
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

/** 一个工单最多带这么多成员 —— 不是能力上限, 是"忘了收"的刹车: 每个成员都是一个
 *  tmux pane 加一份上下文, 而 fd 是有限的 (见 launchd plist 的 NumberOfFiles)。 */
export const JOB_MEMBER_MAX = 12;
const KEEP_CLOSED_MS = 24 * 60 * 60 * 1000;

const newId = (): string => `J${randomUUID().slice(0, 6)}`;

/** 写穿式单文件存储, 同 wizard 注册表。收工满 24h 的工单在下一次写盘时被丢掉 ——
 *  账本是为了收尾, 不是为了存档。 */
const dropStale = (map: Record<string, JobRecord>): Record<string, JobRecord> => {
  const cutoff = Date.now() - KEEP_CLOSED_MS;
  return Object.fromEntries(
    Object.entries(map).filter(([, j]) => j.status === "open" || (j.closedAt ?? 0) > cutoff),
  );
};

export const loadJobStore = (filePath: string): JobStore => {
  const db = loadJsonMap<JobRecord>(filePath, dropStale);
  return {
    open: (base, owner, title, { plan, expect, maxTurns } = {}) => {
      const id = newId();
      return db.set(id, { id, base, owner, title, ...(plan ? { plan } : {}), ...(expect ? { expect } : {}), ...(maxTurns ? { maxTurns, turns: 0 } : {}), members: [], status: "open", openedAt: Date.now() });
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
      return db.set(id, { ...j, members: [...rest, { ...member, task: member.task || prev?.task || "", spawned: member.spawned || !!prev?.spawned, at: Date.now() }] });
    },
    settle: (id, target, outcome, artifacts) => {
      const j = db.get(id);
      if (!j || j.status !== "open" || !j.members.some((x) => x.target === target && !x.outcome)) return undefined;
      return db.set(id, {
        ...j,
        members: j.members.map((x) => (x.target === target ? { ...x, outcome, ...(artifacts?.length ? { artifacts } : {}) } : x)),
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
