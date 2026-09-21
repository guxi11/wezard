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
// chat 详情页 —— 五个分身同时干活时, 十条交叉气泡里读不出结构, 两条能。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { expandHome } from "../shared/paths.js";

export interface JobMember {
  target: string;
  /** 派给它的那一段活 (首行即可) —— 收工气泡里按成员列出来。 */
  task: string;
  /** 为这个工单**临时生出来**的; 只有这些会在收工时被回收。已经存在的 wizard
   *  被拉进来帮忙不该因为工单结束就被杀掉。 */
  spawned: boolean;
  at: number;
}

export interface JobRecord {
  id: string;
  /** 工单属于哪个聊天 —— 两条气泡落在这里。 */
  base: string;
  /** 发起的 wizard。 */
  owner: string;
  title: string;
  members: JobMember[];
  status: "open" | "closed";
  openedAt: number;
  closedAt?: number;
  summary?: string;
}

export interface JobStore {
  open: (base: string, owner: string, title: string) => JobRecord;
  get: (id: string) => JobRecord | undefined;
  /** 幂等: 同一个 target 再次 attach 只更新它那一段活。 */
  attach: (id: string, member: Omit<JobMember, "at">) => JobRecord | undefined;
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
export const loadJobStore = (filePath: string): JobStore => {
  const abs = expandHome(filePath);
  let map: Record<string, JobRecord> = {};
  if (existsSync(abs)) {
    try { map = JSON.parse(readFileSync(abs, "utf8")) as Record<string, JobRecord>; } catch { map = {}; }
  } else {
    mkdirSync(dirname(abs), { recursive: true });
  }
  const persist = (): void => {
    const cutoff = Date.now() - KEEP_CLOSED_MS;
    map = Object.fromEntries(Object.entries(map).filter(([, j]) => j.status === "open" || (j.closedAt ?? 0) > cutoff));
    try { writeFileSync(abs, JSON.stringify(map, null, 2), "utf8"); } catch { /* 账本丢了也不该拖垮会话 */ }
  };
  const put = (j: JobRecord): JobRecord => { map[j.id] = j; persist(); return j; };
  return {
    open: (base, owner, title) =>
      put({ id: newId(), base, owner, title, members: [], status: "open", openedAt: Date.now() }),
    get: (id) => map[id],
    attach: (id, member) => {
      const j = map[id];
      if (!j || j.status !== "open" || j.members.length >= JOB_MEMBER_MAX) return undefined;
      const rest = j.members.filter((x) => x.target !== member.target);
      const prev = j.members.find((x) => x.target === member.target);
      return put({ ...j, members: [...rest, { ...member, spawned: member.spawned || !!prev?.spawned, at: Date.now() }] });
    },
    close: (id, summary) => {
      const j = map[id];
      if (!j) return undefined;
      return put({ ...j, status: "closed", closedAt: Date.now(), summary });
    },
    openOf: (base) => Object.values(map).filter((j) => j.base === base && j.status === "open").sort((a, b) => b.openedAt - a.openedAt),
    all: () => Object.values(map),
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

/** 收工气泡 —— 谁干了什么、结论是什么。成员名字挂各自的 chat 详情页, 人想看某一路
 *  的来龙去脉就点进去, 不必在群里翻交叉的气泡。 */
export const renderJobClose = (
  job: JobRecord,
  label: (target: string) => string,
  recycled: number,
): string =>
  [
    `📋 \`${job.id}\` 收工 · **${job.title}**`,
    ...job.members.map((mm) => `- ${label(mm.target)}${mm.task ? ` · ${firstLine(mm.task)}` : ""}`),
    job.summary?.trim() ? `\n${job.summary.trim()}` : "",
    recycled > 0 ? `(已回收 ${recycled} 个临时分身)` : "",
  ]
    .filter(Boolean)
    .join("\n");
