// 世界视图 —— 把「谁存在、谁是谁生的、谁在驱动谁、谁被排了什么」折成一张图。
//
// chat-view 回答的是**一个聊天内部**的问题 (这个 chat 有哪些 `#tag`、某一路的
// 线程长什么样)。但 wizard 早就不止活在一个聊天里了: 分身可以生在别的群、
// send_peer 跨群寻址、一个工单的成员散在几个聊天、定时任务指向任意一个 target。
// 那些关系在 chat-view 里一条都画不出来 —— 它的第一步就是 `baseOfKey === base`。
//
// 本模块因此换一个折叠轴: 不按聊天切, 按**关系**切。
//
//   节点 = wizard (会话 + 身份), 按所属聊天聚簇
//   边   = clone (家谱) / peer (派活) / graph (流水线一步); 定时是节点上的计数
//
// 两类数据源, 边界明确:
//   • 观测到的 (turn 记录): peer / graph 边与定时计数 —— 真发生过的往来。24h TTL,
//     标准 detail 存储, 所以独立 svr 收到 POST 之后画出来的图与本机一模一样。
//   • 登记的 (wizard / job / schedule 注册表): 身份、家谱、工单、日程 —— 它们是
//     「安排」, 不随 TTL 消失, 但只有 daemon 有。svr 拿不到就退化成只画观测边。
//
// 纯函数, 无 IO: 注册表侧的东西由调用方以 WorldFacts 喂进来。
import { baseOfKey, labelFor, stripSigil, tagOfKey } from "./session-label.js";
import { withoutKeepaliveTurns } from "./keepalive.js";
import { isTurn, staleAt, isGhostTurn } from "./chat-view.js";
import type { CharterLineage, CharterRecord, DetailRecord, TurnDetailRecord, TurnItem } from "./detail-store.js";
import { senderOf } from "./role-view.js";
import type { TurnState } from "./turn-state.js";

// ── 注册表侧 (daemon 独有) ────────────────────────────────────────────
/** 一个 wizard 的登记信息 + 此刻的活体状态。daemon 从 wizard.json + tmux 取。 */
export interface WorldFactWizard {
  target: string;
  /** withData 补的占位: 已停且无记录, 只为挂住还在的后代。 */
  ghost?: boolean;
  name: string;
  description: string;
  chat: string;
  cwd: string;
  model: string;
  /** 绑定里记下的 effort 档位 (spawn / set_model 给的); 没给过就没有。 */
  effort?: string;
  cli: string;
  /** 正在生成 (pane 里有中断提示)。 */
  busy: boolean;
  /** tmux pane 还在 —— false = 冷的, 要说话得先把它拉起来。 */
  alive: boolean;
  /** 停在哪些工具调用上等人点 (daemon 发出的审批卡 / 提问卡, 即还挂着的 pending) 的工具名; 缺省 = 没在等。 */
  waiting?: string[];
  /** 谁生的它 —— 分身与子 wizard 都有; 两者靠 clonedFrom 区分。 */
  parent?: string;
  /** fork 自父亲的哪个 sessionId; 有值 = 分身 (从那个 session 节点 clone, 开局带着
   *  父亲的上下文), 空 = 子 wizard (父亲 spawn 的白板)。 */
  clonedFrom?: string;
  /** 被克隆的那个 wizard —— 只在它不是 parent 时才有 (parent 克隆了别人)。 */
  forkOf?: string;
  bornAt?: number;
  /** transcript mtime, 0 = 从没写过。 */
  lastActivity: number;
  /** 最近在聊什么的一行。 */
  summary: string;
}

export interface WorldFactJob {
  id: string;
  base: string;
  owner: string;
  title: string;
  status: "open" | "closed";
  openedAt: number;
  closedAt?: number;
  summary?: string;
  /** 开工时说好要几份 (见 jobs.JobRecord.expect)。 */
  expect?: number;
  /** 开工时的计划 (open_job 的 plan) —— 工单页开工那一行照原样分行显示。 */
  plan?: string;
  /** 上级工单 (金字塔: 工单树); 缺省 = 树根。 */
  parent?: string;
  /** `req` = 需求根单 (管家派 lead 时开)。 */
  kind?: "req";
  /** 验收标准。 */
  criteria?: string;
  /** 根单怎么收的 (只收了工的根单): 人认可 = accept, 取消 = cancel。 */
  end?: "accept" | "cancel";
  /** 需求原话与它来自哪个群 (只根单有)。 */
  origin?: { text: string; chat: string };
  /** 现算的阶段 (见 jobs.jobStage): daemon 算好推过来, 页面只管显示。 */
  stage?: JobStage;
  /** outcome: 这一份落定成什么 (见 jobs.MemberOutcome); 缺省 = 还在干。
   *  role: 它在这张单里是什么 (缺省 exec); forkOf: clone 时材料来自谁 (target key)。 */
  members: Array<{ target: string; task: string; spawned: boolean; outcome?: string; artifacts?: Array<{ path: string; note: string }>; role?: MemberRole; forkOf?: string }>;
}

/** 成员在一张工单里的角色: lead = 根单里被派来的需求 lead; exec 执行; reviewer 评审; expert 借来答问的专家。 */
export type MemberRole = "lead" | "exec" | "reviewer" | "expert";
/** 工单阶段 (现算, 不落盘): plan 规划 · build 实施 · review 评审 · clarify 澄清 (lead 在等人拍板) ·
 *  deliver 交付 (根单: lead 已交差, 等人验收; 子单: 成员都落定, 等 owner 收工) · stalled 卡住 (根单: lead 以 timeout/silent/dead/canceled 收场, 没交差) · shelved 搁置 (根单: 人说先放着, 账本保留、不冒泡) · closed 收工 / 归档。 */
export type JobStage = "plan" | "build" | "review" | "clarify" | "deliver" | "stalled" | "shelved" | "closed";

/** 一张工单的进度: 已落定几份 / 一共几份 (成员数与开工时说好的份数取大) —— 侧栏、关系图、工单页都读这一份。 */
export interface JobProgress { done: number; total: number }
export const jobProgress = (j: WorldFactJob): JobProgress => ({
  done: j.members.filter((mm) => mm.outcome).length,
  total: Math.max(j.members.length, j.expect ?? 0),
});

export interface WorldFactSchedule {
  id: string;
  target: string;
  /** describeWhen 的人话形式 ("每个工作日 21:30")。 */
  when: string;
  /** 下次触发 (epoch ms)。 */
  nextAt: number;
  lastFired?: number;
  prompt: string;
  note: string;
  createdBy: string;
  /** 这条日程归谁 —— 排班那个 wizard 的 target。rolepage 的「日程」按它过滤:
   *  日程跟着 wizard 走, 不跟着它执行时落在哪个聊天走。老 svr 推来的快照可能没有。 */
  owner: string;
  /** 每次新起白板 wizard 去跑 (跑完回收); false = 注入 target 那个已有会话。 */
  fresh?: boolean;
  hasGate?: boolean;
  /** 上一轮 gate 的去向 (见 TaskState.lastGate)。 */
  lastGate?: "go" | "skip" | "error";
  lastGateAt?: number;
  lastError?: string;
  /** 任务文件最近一次加载失败的理由 —— 此刻跑的还是上一版。 */
  loadError?: string;
  file?: string;
}

/** 一件在飞的活 (见 turn-state.ts): `from` 派给 `to`、还没落定。`at` = 派出的时刻, 多久了由读的一方现算。 */
export interface WorldFactInFlight { from: string; to: string; turn: string; job: string; state: TurnState; at: number }

/** 一个微信通道的此刻: 掉没掉线、人最近何时开口、压着几条没发、这份 context_token 还能发几条、频控暂停到何时 (0 = 没停)。 */
export interface WorldFactWeixin { base: string; state: "live" | "expired"; lastInAt: number; held: number; budget: number; pausedUntil: number }

export interface WorldFacts {
  wizards: readonly WorldFactWizard[];
  jobs: readonly WorldFactJob[];
  /** 老 daemon 推来的快照没有。 */
  inflight?: readonly WorldFactInFlight[];
  schedules: readonly WorldFactSchedule[];
  /** base → 聊天名; 没起名的不在表里。 */
  chatNames: Readonly<Record<string, string>>;
  /** human id (`human:x`) → 显示名; 不在表里的显示裸 id。老 daemon 推来的快照没有。 */
  humanNames?: Readonly<Record<string, string>>;
  /** 微信 ClawBot 通道的账号状态, 每个绑定的微信用户一个群 (`chat:wx_…`)。老 daemon 推来的快照没有。 */
  weixin?: readonly WorldFactWeixin[];
  /** 这份不是注册表给的, 是「没拿到」的占位 —— 显式信号: 空名册 ≠ 注册表不可达。 */
  absent?: true;
}

export const EMPTY_FACTS: WorldFacts = { wizards: [], jobs: [], schedules: [], chatNames: {}, absent: true };

// ── 视图模型 ──────────────────────────────────────────────────────────
export interface WorldNode {
  target: string;
  base: string;
  tag: string;
  chat: string;
  /** 全局名字 (`.name` 去掉点): 登记的名字 > slot id > 聊天名 > target。 */
  name: string;
  label: string;
  description: string;
  cwd: string;
  model: string;
  cli: string;
  busy: boolean;
  alive: boolean;
  /** 同 WorldFactWizard.waiting。 */
  waiting?: string[];
  /** 注册表里有登记 —— false = 只在 turn 记录里出现过的会话 (svr 视角下的全部)。 */
  known: boolean;
  /** 占位: 已停且无记录的 wizard, 只为把还在的后代挂回它名下 (灰色)。 */
  ghost?: boolean;
  /** 这是打开本页那条链接所属的会话。 */
  self: boolean;
  /** 与 self 同一个聊天 (卡片布局里本群那张卡片的锚点)。 */
  local: boolean;
  parent?: string;
  inherited: boolean;
  bornAt?: number;
  /** 最近活动时刻 (turn 记录与 transcript mtime 取大)。 */
  lastTs: number;
  turns: number;
  /** 一行近况: 最近一轮的正文 > 注册表 summary。 */
  preview: string;
  /** 无新写入时到这个时刻自动算结束; 0 = 已停。客户端自己熄灯 (同 TagSummary)。 */
  runningUntil: number;
  /** 被定时任务叫醒过几轮 —— 定时没有"派活的一方", 所以它是节点上的计数而不是边。 */
  taskTurns: number;
  /** 被同伴派活开出的轮数 (含跨聊天)。 */
  peerTurns: number;
  /** 与它有关系 (任一种边) 的全部 role —— 在节点按卡片上限裁剪之前算, 所以连到没下发节点的关系也在。
   *  关系图卡片名字旁的「+N」由前端拿它减去图上已连的。 */
  rels?: string[];
}

/** 家谱三种, 都画在「生它、归它管」或「上下文从它来」的那一位下:
 *  clone = 分身 (parent 生的, 开局 fork 了上下文); spawn = 新生 (parent 生的白板);
 *  fork = 分身的上下文来源 —— 只在克隆的是别人 (forkOf ≠ parent) 时另画这一条。 */
export type WorldEdgeKind = "clone" | "spawn" | "fork" | "peer" | "graph";

export interface WorldEdge {
  kind: WorldEdgeKind;
  from: string;
  to: string;
  /** 观测到多少次 (家谱恒为 1 —— 不是流量)。 */
  count: number;
  lastTs: number;
  /** 跨聊天的边 —— 画图时单独着重, 它才是"关联起来了"的证据。 */
  cross: boolean;
  /** 经手的工单号 (peer 边)。 */
  jobs?: string[];
  /** graph run id (graph 边)。 */
  runs?: string[];
  /** 每一次发生的时刻 (最近 EDGE_TS_MAX 次) —— 前端按选中 session 的时间范围重新计数。 */
  ts: number[];
  /** clone 边: 分身在 origin 会话里分叉的那一处 (clone 徽标点了落到这里)。 */
  point?: ClonePoint;
}

/** origin = 被克隆的那一方 (parent, 克隆的是别人时是 forkOf)。`id` = rolepage 的消息 id;
 *  `use` = origin 调 clone_wizard 的那次 tool_use —— 认不出调用、落到出生前那一句时没有。
 *  origin 在记录里一轮都没有 = 只有 origin 与 ts, 前端开它的往来不定位。 */
export interface ClonePoint { origin: string; id?: string; use?: string; ts: number }

const EDGE_TS_MAX = 200;

export interface WorldChat {
  base: string;
  name: string;
  self: boolean;
  /** 那个聊天既有的票据 (`/role?id=`)。由路由层从 store 里取; 取不到 = 这个群还
   *  没有任何记录。rolepage 下任一票据都能看任一 role, 它只是一个落点更近的链接。 */
  token?: string;
  /** 本聊天的 wizard target, 已按家谱序 (父在前, 分身紧随其后并带缩进深度)。 */
  members: Array<{ target: string; depth: number }>;
  /** 被相关性筛掉的成员数 —— 页面上写成「另有 N 个已停的会话」, 免得看图的人
   *  以为这个群就这么几个人。 */
  hidden: number;
}

export interface WorldView {
  at: number;
  /** 打开本页的那个聊天。 */
  base: string;
  self: string;
  chats: WorldChat[];
  nodes: WorldNode[];
  edges: WorldEdge[];
  jobs: Array<WorldFactJob & JobProgress>;
  schedules: WorldFactSchedule[];
  /** 注册表缺席 (svr 独立部署) —— 前端据此说明"只画观测到的往来"。 */
  degraded: boolean;
}

// ── 相关性 ────────────────────────────────────────────────────────────
// 一台跑了几个月的机器上, "所有绑过的会话"是几百个 —— 它们绝大多数是几周前
// 干完一件事就再没动过的 `#tag`。把它们全画出来不是"完整", 是把图变成一堵墙:
// 真正在协作的那十几个 wizard 淹没在里面, 而那恰恰是这张图存在的理由。
//
// 所以画的是**当下的协作网络**, 判据四条, 满足其一即入选:
//   1. 在当前聊天里 —— 这一页的主题就是它, 不筛
//   2. 是某条边的端点 —— 关系是图的主语, 有关系就必须在场 (哪怕它已经凉了)
//   3. 还活着 / 正在跑 —— 此刻能叫得动的人
//   4. 最近动过 —— 刚停下的那些, 人还记得
// 其余的按聊天计数收进 `hidden`, 不是删掉, 是折起来。
const RECENT_MS = 6 * 3600_000;
/** 每个聊天最多画这么多 —— 相关性之上再加一道闸: 当前聊天本身就可能有几十个
 *  `#tag`, 全列出来同样读不动。按最近活动截断, 余下的进 `hidden`。 */
const PER_CHAT_MAX = 14;
const SELF_CHAT_MAX = 24;

// ── 折叠 ──────────────────────────────────────────────────────────────
const liveTurns = (records: readonly DetailRecord[], now: number): TurnDetailRecord[] =>
  records.filter(isTurn).filter((r) => !isGhostTurn(r, now) && !r.agent && !!r.target);

const stripMd = (s: string): string => s.replace(/[`*_~|#>]/g, "").replace(/\s+/g, " ").trim();

const previewOf = (r: TurnDetailRecord): string => {
  const texts = r.items.filter((it): it is Extract<typeof it, { t: "text" }> => it.t === "text");
  return stripMd(texts[texts.length - 1]?.body ?? r.userQuery ?? "").slice(0, 100);
};

const isHuman = (id: string): boolean => id.startsWith("human:") && id !== "human:";

/** 一条边的身份 —— 同一对端点同一种类只留一条, count 累加。 */
const edgeKey = (kind: string, from: string, to: string): string => `${kind}\u0000${from}\u0000${to}`;

const bumpEdge = (
  m: Map<string, WorldEdge>,
  kind: WorldEdgeKind,
  from: string,
  to: string,
  ts: number,
  tag?: { jobs?: string; runs?: string },
): Map<string, WorldEdge> => {
  if (!from || !to || from === to) return m;
  const k = edgeKey(kind, from, to);
  const cur = m.get(k);
  const merge = (list: string[] | undefined, v: string | undefined): string[] | undefined =>
    v ? [...new Set([...(list ?? []), v])] : list;
  return m.set(k, {
    kind,
    from,
    to,
    count: (cur?.count ?? 0) + 1,
    lastTs: Math.max(cur?.lastTs ?? 0, ts),
    // 人不住在哪个群里 —— 它说话的地方没有「跨」可言。
    cross: !isHuman(from) && baseOfKey(from) !== baseOfKey(to),
    jobs: merge(cur?.jobs, tag?.jobs),
    runs: merge(cur?.runs, tag?.runs),
    ts: [...(cur?.ts ?? []), ts].slice(-EDGE_TS_MAX),
  });
};

/** 家谱序: 先根后分身, depth = 到根的距离。环路 (记录可手改) 在 seen 处截断。 */
const lineageOrder = (targets: readonly string[], parentOf: (t: string) => string | undefined): Array<{ target: string; depth: number }> => {
  const inSet = new Set(targets);
  const kids = targets.reduce((m, t) => {
    const p = parentOf(t);
    return p && inSet.has(p) ? m.set(p, [...(m.get(p) ?? []), t]) : m;
  }, new Map<string, string[]>());
  const roots = targets.filter((t) => { const p = parentOf(t); return !p || !inSet.has(p); });
  const walk = (t: string, depth: number, seen: ReadonlySet<string>): Array<{ target: string; depth: number }> =>
    seen.has(t)
      ? []
      : [{ target: t, depth }, ...(kids.get(t) ?? []).flatMap((k) => walk(k, depth + 1, new Set([...seen, t])))];
  const ordered = roots.flatMap((r) => walk(r, 0, new Set()));
  // 环里的节点一个根都走不到 —— 补在后面, 宁可扁平也不能让它整段消失。
  const seen = new Set(ordered.map((o) => o.target));
  return [...ordered, ...targets.filter((t) => !seen.has(t)).map((target) => ({ target, depth: 0 }))];
};

/** 注册表侧按消息数据裁剪: 没有 transcript (lastActivity = 0, daemon 取自 jsonl 的 mtime; 冷记录也是 0)、
 *  轮次记录里也没有它 (没跑过、也没派出过一句) 的 wizard 不进世界 —— 画出来只是一张空卡和几条说不出内容的边。
 *  只看轮次不够: 轮次库有 24h / 1000 条的保留上限, 挤掉了的活跃 wizard 会被误判成没数据; transcript 不受它限。
 *  活着的照留: 刚 spawn 还没开口的分身就是这样。
 *  挂在被裁者名下的后代改认最近一个留下的祖先 (clone 的上下文来源同理), 家谱不断。 */
export const withData = (facts: WorldFacts, records: readonly DetailRecord[], now: number): WorldFacts => {
  const spoke = new Set(liveTurns(records, now).flatMap((r) => [r.target!, ...(r.from?.kind === "peer" && r.from.from ? [r.from.from] : [])]));
  const keep = (w: WorldFactWizard): boolean => w.alive || w.busy || w.lastActivity > 0 || spoke.has(w.target);
  const byTarget = new Map(facts.wizards.map((w) => [w.target, w] as const));
  // 被裁者若还有留下的后代, 不把后代改挂祖父, 而是留一个占位 (ghost) 代表它 —— 家谱里那一层真实存在过。
  const needed = (t: string | undefined, seen: ReadonlySet<string> = new Set()): string[] => {
    const w = t ? byTarget.get(t) : undefined;
    return !t || !w || seen.has(t) ? [] : keep(w) ? [] : [t, ...needed(w.parent, new Set([...seen, t])), ...needed(w.forkOf, new Set([...seen, t]))];
  };
  const ghosts = new Set(facts.wizards.filter(keep).flatMap((w) => [...needed(w.parent), ...needed(w.forkOf)]));
  return {
    ...facts,
    wizards: facts.wizards.filter((w) => keep(w) || ghosts.has(w.target)).map((w) => (keep(w) ? w : { ...w, ghost: true })),
  };
};

// 老宪章 (加 lineage 字段之前) 的出身只在正文那一行里 —— wizard.ts renderCharter 的三种写法。
const BORN_LINE = /^- 出身: \*\*`\.([^`]+)`\*\* (克隆出的 \*\*`\.([^`]+)`\*\* 的分身|的分身|生的子 wizard)/m;

/** 宪章记下的出身; 老记录从正文读回, 名字按此刻的名录换回 target (改过名的就认不出了)。 */
const lineageOf = (c: CharterRecord, targetOf: (name: string) => string | undefined): CharterLineage | undefined => {
  if (c.lineage) return c.lineage;
  const m = BORN_LINE.exec(c.text);
  const parent = m && targetOf(m[1]!);
  if (!m || !parent) return undefined;
  const forkOf = m[3] ? targetOf(m[3]) : undefined;
  return { parent, kind: m[2] === "生的子 wizard" ? "spawn" : "clone", ...(forkOf ? { forkOf } : {}) };
};

const CLONE_TOOL = /(?:^|__)clone_wizard$/;
type ToolUseItem = Extract<TurnItem, { t: "tool_use" }>;
const parseObj = (s: string): Record<string, unknown> | undefined => {
  try { const v: unknown = JSON.parse(s); return v && typeof v === "object" ? (v as Record<string, unknown>) : undefined; } catch { return undefined; }
};
/** 这次 clone_wizard 生出来的名字: 回包落地的名字优先, 没回包退回 input。 */
const clonedName = (r: TurnDetailRecord, u: ToolUseItem): string => {
  const res = r.items.find((it): it is Extract<TurnItem, { t: "tool_result" }> => it.t === "tool_result" && it.toolUseId === u.toolUseId);
  const j = res ? parseObj(res.body) : undefined;
  const a = (u.toolInput && typeof u.toolInput === "object" ? u.toolInput : {}) as Record<string, unknown>;
  return stripSigil(String(j?.name ?? a.name ?? ""));
};
const msgIdOf = (r: TurnDetailRecord): string => `${r.id}:${r.items.length || !r.closed ? "out" : "in"}`;

/** 分身在 origin 会话 (`rs`, 按时刻升序) 里分叉的那一处: origin 自己调 clone_wizard 生的 (`byCall`),
 *  就是那次调用 —— 按名字认, 认不出名字取离出生最近的那次; 否则 (克隆的是别人 / 没找到调用)
 *  落到出生前最近的那一句, 分叉正发生在它之后。 */
export const clonePointOf = (rs: readonly TurnDetailRecord[], origin: string, name: string, bornAt: number, byCall: boolean): ClonePoint => {
  const calls = byCall
    ? rs.flatMap((r) => r.items.filter((it): it is ToolUseItem => it.t === "tool_use" && CLONE_TOOL.test(it.toolName)).map((u) => ({ r, u })))
    : [];
  const near = (ts: number): number => Math.abs(ts - bornAt);
  const call = calls.find((c) => clonedName(c.r, c.u) === name) ??
    calls.filter((c) => near(c.u.ts) < 5 * 60_000).sort((a, b) => near(a.u.ts) - near(b.u.ts))[0];
  if (call) return { origin, id: `${call.r.id}:out`, use: call.u.toolUseId, ts: call.u.ts };
  const before = rs.filter((r) => r.createdAt <= bornAt).at(-1) ?? rs[0];
  return before ? { origin, id: msgIdOf(before), ts: before.createdAt } : { origin, ts: bornAt };
};

export const buildWorld = (
  records: readonly DetailRecord[],
  facts: WorldFacts,
  scope: { base: string; self: string },
  now: number,
): WorldView => {
  const turns = liveTurns(records, now);
  const byTarget = turns.reduce((m, r) => m.set(r.target!, [...(m.get(r.target!) ?? []), r]), new Map<string, TurnDetailRecord[]>());
  const factOf = new Map(facts.wizards.map((w) => [w.target, w] as const));

  // 节点集 = 登记过的 ∪ 跑过轮次的。两边都要: 一个刚 spawn 还没开口的分身只在
  // 注册表里, 一条 24h 内跑过但注册表已被清掉的会话只在 turn 记录里。
  const targets = [...new Set([...factOf.keys(), ...byTarget.keys()])];

  const nodes: WorldNode[] = targets.map((target) => {
    const f = factOf.get(target);
    const rs = (byTarget.get(target) ?? []).sort((a, b) => a.createdAt - b.createdAt);
    const last = rs[rs.length - 1];
    // 卡片上的「最近一句」是它说过的话, 保温的 pong 不算。
    const said = withoutKeepaliveTurns(rs).at(-1);
    const tag = tagOfKey(target);
    const base = baseOfKey(target);
    const chat = f?.chat ?? facts.chatNames[base] ?? "";
    const until = rs.reduce((mx, r) => Math.max(mx, staleAt(r)), 0);
    // 名字全局唯一, 与聊天无关 —— 名册里的就是它; 名册缺席 (svr) 才按 slot / 聊天名推。
    const name = (f?.name ?? "").trim() || tag || chat || target;
    return {
      target,
      base,
      tag,
      chat,
      name,
      label: labelFor(name),
      description: f?.description ?? "",
      cwd: f?.cwd || [...rs].reverse().find((r) => r.cwd)?.cwd || "",
      model: f?.model || [...rs].reverse().find((r) => r.model)?.model || "",
      cli: f?.cli || last?.cli || "",
      busy: f?.busy ?? false,
      alive: f?.alive ?? false,
      ...(f?.waiting?.length ? { waiting: f.waiting } : {}),
      known: !!f,
      ...(f?.ghost ? { ghost: true } : {}),
      self: target === scope.self,
      local: base === scope.base,
      parent: f?.parent,
      inherited: !!(f?.clonedFrom ?? ""),
      bornAt: f?.bornAt,
      lastTs: Math.max(f?.lastActivity ?? 0, rs.reduce((mx, r) => Math.max(mx, r.updatedAt), 0)),
      turns: rs.length,
      preview: (said ? previewOf(said) : "") || f?.summary || "",
      runningUntil: until > now ? until : 0,
      taskTurns: rs.filter((r) => r.from?.kind === "task").length,
      peerTurns: rs.filter((r) => r.from?.kind === "peer").length,
    };
  });

  // 人也是对话方: 开过一轮的那个人 (认得出是谁的) 是一个节点, 它 → 那个 wizard 是一条对话边。
  // 不进 chats —— 人不住在哪个聊天里; 只跟着它连着的 wizard 一起下发。
  const byHuman = turns.reduce((m, r) => {
    const who = senderOf(r);
    return isHuman(who) ? m.set(who, [...(m.get(who) ?? []), r]) : m;
  }, new Map<string, TurnDetailRecord[]>());
  const humans: WorldNode[] = [...byHuman].map(([target, rs]) => {
    const last = rs.reduce((a, b) => (b.createdAt > a.createdAt ? b : a));
    return {
      target, base: "", tag: "", chat: "", name: target.slice("human:".length), label: "👤", description: "",
      cwd: "", model: "", cli: "", busy: false, alive: false, known: false, self: target === scope.self, local: false,
      inherited: false, lastTs: last.createdAt, turns: rs.length, preview: stripMd(last.userQuery ?? "").slice(0, 100),
      runningUntil: 0, taskTurns: 0, peerTurns: 0,
    };
  });
  const known = new Set([...nodes, ...humans].map((n) => n.target));
  // 一条边的两端都必须是节点 —— 派活方可能已经被回收, 那条边就无处落脚, 画一个
  // 悬空端点只会让人以为漏了谁。
  const link = (m: Map<string, WorldEdge>, kind: WorldEdgeKind, from: string, to: string, ts: number, tag?: Parameters<typeof bumpEdge>[5]): Map<string, WorldEdge> =>
    known.has(from) && known.has(to) ? bumpEdge(m, kind, from, to, ts, tag) : m;

  // 观测边 —— 真的发生过的往来, 从 turn 记录里读。
  const observed = turns.reduce((m, r) => {
    const to = r.target!;
    const f = r.from;
    // 定时任务没有"派活的一方" —— 它是节点上的计数 (taskTurns), 不是一条边。
    const who = senderOf(r);
    const m1 = f?.kind === "peer" && f.from ? link(m, "peer", f.from, to, r.createdAt, { jobs: f.job })
      : isHuman(who) ? link(m, "peer", who, to, r.createdAt)
      : m;
    // graph: 上一步的 tag 喂给这一步 —— 同聊天内解析成 target。
    const prev = r.origin?.fromTag;
    return prev !== undefined
      ? link(m1, "graph", prev ? `${baseOfKey(to)}#${prev}` : baseOfKey(to), to, r.createdAt, { runs: r.origin!.runId })
      : m1;
  }, new Map<string, WorldEdge>());

  // 登记边 —— 家谱。观测不到 (分身可能一句话没说), 但它是最稳定的一种关系。
  // parent → 它: 分身 (clone) 或新生 (spawn), 看它开局有没有 fork 上下文; 克隆的是别人时,
  // 上下文的来源另记一条 fork 边 —— 生它、归它管的仍是 parent, 不能因此把它画成 parent 的白板。
  const registered = facts.wizards.reduce(
    (m, w) => {
      if (!w.parent) return m;
      const m1 = link(m, w.clonedFrom ? "clone" : "spawn", w.parent, w.target, w.bornAt ?? 0);
      return w.clonedFrom && w.forkOf ? link(m1, "fork", w.forkOf, w.target, w.bornAt ?? 0) : m1;
    },
    observed,
  );
  // 注册表里已经没有的 (stop_wizard forget、工单回收、回归脚本收尾都会删记录), 家谱只剩
  // 它的宪章 —— 宪章不进 TTL, 记着出生那一刻谁生的它; 不读回来它就只剩一条「对话」边、像个外人。
  const byName = new Map(nodes.map((n) => [n.name, n.target] as const));
  const lineageEdge = (m: Map<string, WorldEdge>, kind: WorldEdgeKind, from: string | undefined, to: string, ts: number): Map<string, WorldEdge> =>
    from ? link(m, kind, from, to, ts) : m;
  const chartered = records.filter((r): r is CharterRecord => r.kind === "charter" && !factOf.has(r.target))
    .flatMap((c) => ((l) => (l ? [{ c, l }] : []))(lineageOf(c, (n) => byName.get(n))));
  const withLineage = chartered.reduce((m, { c, l }) => {
    const m1 = lineageEdge(m, l.kind, l.parent, c.target, c.createdAt);
    return l.kind === "clone" ? lineageEdge(m1, "fork", l.forkOf, c.target, c.createdAt) : m1;
  }, registered);

  // clone 边带上分叉处: 注册表与宪章各记着谁被克隆、何时出生。
  const clones = new Map<string, { origin: string; parent: string; bornAt: number }>([
    ...facts.wizards.filter((w) => w.parent && w.clonedFrom).map((w) => [w.target, { origin: w.forkOf ?? w.parent!, parent: w.parent!, bornAt: w.bornAt ?? 0 }] as const),
    ...chartered.filter(({ l }) => l.kind === "clone").map(({ c, l }) => [c.target, { origin: l.forkOf ?? l.parent, parent: l.parent, bornAt: c.createdAt }] as const),
  ]);
  const nameOf = new Map(nodes.map((n) => [n.target, n.name] as const));
  const withPoint = (e: WorldEdge): WorldEdge => {
    const k = e.kind === "clone" ? clones.get(e.to) : undefined;
    if (!k) return e;
    const rs = [...(byTarget.get(k.origin) ?? [])].sort((a, b) => a.createdAt - b.createdAt);
    return { ...e, point: clonePointOf(rs, k.origin, nameOf.get(e.to) ?? "", k.bornAt, k.origin === k.parent) };
  };

  const edges = [...withLineage.values()].map(withPoint).sort((a, b) => b.lastTs - a.lastTs);
  const relsOf = edges.reduce((m, e) => {
    const add = (a: string, b: string) => m.set(a, (m.get(a) ?? new Set<string>()).add(b));
    add(e.from, e.to); add(e.to, e.from);
    return m;
  }, new Map<string, Set<string>>());

  // 有关系的一律留下 —— 边的端点被筛掉, 那条边就没地方落脚了。
  const linked = new Set(edges.flatMap((e) => [e.from, e.to]));
  const pinned = new Set([
    ...linked,
    ...facts.jobs.filter((j) => j.status === "open").flatMap((j) => [j.owner, ...j.members.map((mm) => mm.target)]),
    ...facts.schedules.flatMap((x) => [x.target, x.owner].filter(Boolean)),
  ]);
  const mustShow = new Set([scope.self, ...(relsOf.get(scope.self) ?? [])]);
  const relevant = (n: WorldNode): boolean =>
    n.local || n.self || pinned.has(n.target) || n.busy || n.alive || now - n.lastTs < RECENT_MS;

  const parentOf = (t: string): string | undefined => factOf.get(t)?.parent;
  const byTs = (a: WorldNode, b: WorldNode): number => b.lastTs - a.lastTs;
  const bases = [...new Set(nodes.map((n) => n.base))];
  const chats: WorldChat[] = bases
    .map((base) => {
      const mine = nodes.filter((n) => n.base === base);
      const self = base === scope.base;
      // 视角的直接关系不受截断 —— 「相关」档要把它们全画出来, 截掉了它们就只剩卡片上的 +N。
      const must = mine.filter((n) => mustShow.has(n.target));
      const rest = mine.filter((n) => !mustShow.has(n.target) && relevant(n)).sort(byTs).slice(0, self ? SELF_CHAT_MAX : PER_CHAT_MAX);
      const kept = [...must, ...rest].sort(byTs);
      return {
        base,
        name: facts.chatNames[base] ?? mine[0]?.chat ?? "",
        self,
        members: lineageOrder(kept.map((n) => n.target), parentOf),
        hidden: mine.length - kept.length,
      };
    })
    // 一个成员都留不下的聊天整张卡片都不画 —— 一张只写着「另有 12 个已停」的空卡
    // 除了占位什么也没说。
    .filter((c) => c.members.length > 0)
    // 自己的聊天永远第一; 其余按最近活动。
    .sort((a, b) => {
      if (a.self !== b.self) return a.self ? -1 : 1;
      const ts = (c: WorldChat): number => Math.max(0, ...c.members.map((mm) => nodes.find((n) => n.target === mm.target)?.lastTs ?? 0));
      return ts(b) - ts(a);
    });

  // 节点表跟着卡片走 —— 画不出来的节点下发了也只是流量 (这条路由是被轮询的)。
  const onCards = new Set(chats.flatMap((c) => c.members.map((mm) => mm.target)));
  const shown = new Set([
    ...onCards,
    ...humans.filter((h) => edges.some((e) => e.from === h.target && onCards.has(e.to))).map((h) => h.target),
  ]);
  return {
    at: now,
    base: scope.base,
    self: scope.self,
    chats,
    nodes: [...nodes, ...humans].filter((n) => shown.has(n.target)).sort(byTs)
      .map((n) => ({ ...n, rels: [...(relsOf.get(n.target) ?? [])] })),
    // 两端都还在图上的边才画得出来。
    edges: edges.filter((e) => shown.has(e.from) && shown.has(e.to)),
    jobs: [...facts.jobs].sort((a, b) => (b.closedAt ?? b.openedAt) - (a.closedAt ?? a.openedAt)).map((j) => ({ ...j, ...jobProgress(j) })),
    schedules: [...facts.schedules].sort((a, b) => a.nextAt - b.nextAt),
    degraded: !!facts.absent,
  };
};
