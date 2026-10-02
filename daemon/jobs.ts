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
//   谁属于这个工单 · 谁是为它临时生出来的 · 收工时该收掉谁 · 群里该看见哪两条
//
// 这个取舍是有来由的: graph.ts 把控制流搬进了守护进程, 代价是 run 只能活在内存里,
// reload 即丢。账本没有这个问题 —— 它是死的数据, 落盘即可; 而控制流留在 wizard
// 那边, 重启之后它重试一次就接上了, 比恢复一个状态机简单一个数量级。
//
// 群里只出两条气泡 (开工 / 收工), 中间的每一次派活与回话照旧落在各自 wizard 的
// rolepage —— 五个分身同时干活时, 十条交叉气泡里读不出结构, 两条能。
import { randomUUID } from "node:crypto";
import { loadJsonMap } from "../shared/json-map-store.js";
import type { ReceiptStatus } from "../shared/reminder.js";

/** 成员那一份的定论 —— 回执落了终态才写 (need / error 是中途的, 不进账)。 */
export type MemberOutcome = Exclude<ReceiptStatus, "need" | "error">;
export interface Artifact { path: string; note: string }

export interface JobMember {
  target: string;
  /** 派给它的那一段活 (首行即可) —— 收工气泡里按成员列出来。 */
  task: string;
  /** 为这个工单**临时生出来**的; 只有这些会在收工时被回收。已经存在的 wizard
   *  被拉进来帮忙不该因为工单结束就被杀掉。 */
  spawned: boolean;
  at: number;
  /** 这一份落定了没有、落成什么。「齐了吗」只数它: 回执登记按发话方 → 答话方一对一份,
   *  会被同一对的后一句顶掉, 账本不会。 */
  outcome?: MemberOutcome;
  artifacts?: Artifact[];
}

export interface JobRecord {
  id: string;
  /** 工单属于哪个聊天 —— 两条气泡落在这里。 */
  base: string;
  /** 发起的 wizard。 */
  owner: string;
  title: string;
  /** 开工时说好要几份 —— 分身还没派齐时「一共几份」的下限。 */
  expect?: number;
  members: JobMember[];
  status: "open" | "closed";
  openedAt: number;
  closedAt?: number;
  summary?: string;
}

export interface JobStore {
  open: (base: string, owner: string, title: string, expect?: number) => JobRecord;
  get: (id: string) => JobRecord | undefined;
  /** 同一个 target 再次 attach 更新它那一段活, 并清掉它已落定的那一份 (又在干了)。 */
  attach: (id: string, member: Omit<JobMember, "at">) => JobRecord | undefined;
  /** 记下某个成员那一份的定论。不在册 / 已收工 = 不记; 已有定论不改写 (终态写一次)。 */
  settle: (id: string, target: string, outcome: MemberOutcome, artifacts?: Artifact[]) => JobRecord | undefined;
  /** 已落定几份 / 一共几份 (成员数与 expect 取大)。 */
  tally: (id: string) => { done: number; total: number } | undefined;
  close: (id: string, summary: string) => JobRecord | undefined;
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
    open: (base, owner, title, expect) => {
      const id = newId();
      return db.set(id, { id, base, owner, title, ...(expect ? { expect } : {}), members: [], status: "open", openedAt: Date.now() });
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
    openOf: (base) =>
      Object.values(db.all()).filter((j) => j.base === base && j.status === "open").sort((a, b) => b.openedAt - a.openedAt),
    all: () => Object.values(db.all()),
  };
};

// ── 纯渲染 ────────────────────────────────────────────────────────────
const firstLine = (s: string, max = 90): string => {
  const t = (s.split("\n")[0] ?? "").trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
};

/** 开工气泡 —— 工单存在这件事本身。成员此刻还没有, 所以这一条只说要干什么。 */
export const renderJobOpen = (job: JobRecord, plan: string): string =>
  [`📋 \`${job.id}\` 开工 · **${job.title}**`, plan.trim() ? firstLine(plan, 300) : ""].filter(Boolean).join("\n");

/** 收工气泡 —— 谁干了什么、结论是什么。成员名字挂各自的 rolepage, 人想看某一路
 *  的来龙去脉就点进去, 不必在群里翻交叉的气泡。 */
export const renderJobClose = (
  job: JobRecord,
  label: (target: string) => string,
  recycled: number,
): string =>
  [
    `📋 \`${job.id}\` 收工 · **${job.title}**`,
    ...job.members.flatMap((mm) => [
      `- ${label(mm.target)}${mm.outcome === "done" ? "" : ` · ${mm.outcome ?? "未回"}`}${mm.task ? ` · ${firstLine(mm.task)}` : ""}`,
      ...(mm.artifacts ?? []).map((a) => `  ↳ ${a.path}${a.note ? ` — ${firstLine(a.note, 60)}` : ""}`),
    ]),
    job.summary?.trim() ? `\n${job.summary.trim()}` : "",
    recycled > 0 ? `(已回收 ${recycled} 个临时分身)` : "",
  ]
    .filter(Boolean)
    .join("\n");
