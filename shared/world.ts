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
import { baseOfKey, labelFor, tagOfKey } from "./session-label.js";
import { isTurn, staleAt, isGhostTurn } from "./chat-view.js";
import type { DetailRecord, TurnDetailRecord } from "./detail-store.js";

// ── 注册表侧 (daemon 独有) ────────────────────────────────────────────
/** 一个 wizard 的登记信息 + 此刻的活体状态。daemon 从 wizard.json + tmux 取。 */
export interface WorldFactWizard {
  target: string;
  name: string;
  description: string;
  chat: string;
  cwd: string;
  model: string;
  cli: string;
  /** 正在生成 (pane 里有中断提示)。 */
  busy: boolean;
  /** tmux pane 还在 —— false = 冷的, 要说话得先把它拉起来。 */
  alive: boolean;
  parent?: string;
  /** fork 自哪个 sessionId; 有值 = 它开局就带着父亲的上下文。 */
  clonedFrom?: string;
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
  members: Array<{ target: string; task: string; spawned: boolean }>;
}

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
}

export interface WorldFacts {
  wizards: readonly WorldFactWizard[];
  jobs: readonly WorldFactJob[];
  schedules: readonly WorldFactSchedule[];
  /** base → 聊天名; 没起名的不在表里。 */
  chatNames: Readonly<Record<string, string>>;
}

export const EMPTY_FACTS: WorldFacts = { wizards: [], jobs: [], schedules: [], chatNames: {} };

// ── 视图模型 ──────────────────────────────────────────────────────────
export interface WorldNode {
  target: string;
  base: string;
  tag: string;
  chat: string;
  /** 显示名: 登记的名字 > `chat#tag` > 裸 tag > target。 */
  name: string;
  label: string;
  description: string;
  cwd: string;
  model: string;
  cli: string;
  busy: boolean;
  alive: boolean;
  /** 注册表里有登记 —— false = 只在 turn 记录里出现过的会话 (svr 视角下的全部)。 */
  known: boolean;
  /** 这是打开本页那条链接所属的会话。 */
  self: boolean;
  /** 与 self 同一个聊天 —— 决定能不能点进线程 (见 chat-http 的 capability 说明)。 */
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
}

export type WorldEdgeKind = "clone" | "peer" | "graph";

export interface WorldEdge {
  kind: WorldEdgeKind;
  from: string;
  to: string;
  /** 观测到多少次 (clone 恒为 1 —— 家谱不是流量)。 */
  count: number;
  lastTs: number;
  /** 跨聊天的边 —— 画图时单独着重, 它才是"关联起来了"的证据。 */
  cross: boolean;
  /** 经手的工单号 (peer 边)。 */
  jobs?: string[];
  /** graph run id (graph 边)。 */
  runs?: string[];
}

export interface WorldChat {
  base: string;
  name: string;
  self: boolean;
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
  jobs: WorldFactJob[];
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
    cross: baseOfKey(from) !== baseOfKey(to),
    jobs: merge(cur?.jobs, tag?.jobs),
    runs: merge(cur?.runs, tag?.runs),
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
    const tag = tagOfKey(target);
    const base = baseOfKey(target);
    const chat = f?.chat ?? facts.chatNames[base] ?? "";
    const until = rs.reduce((mx, r) => Math.max(mx, staleAt(r)), 0);
    return {
      target,
      base,
      tag,
      chat,
      name: (f?.name ?? "").trim() || (chat ? (tag ? `${chat}#${tag}` : chat) : tag || target),
      label: tag ? labelFor(tag) : "🧙",
      description: f?.description ?? "",
      cwd: f?.cwd || [...rs].reverse().find((r) => r.cwd)?.cwd || "",
      model: f?.model || [...rs].reverse().find((r) => r.model)?.model || "",
      cli: f?.cli || last?.cli || "",
      busy: f?.busy ?? false,
      alive: f?.alive ?? false,
      known: !!f,
      self: target === scope.self,
      local: base === scope.base,
      parent: f?.parent,
      inherited: !!(f?.clonedFrom ?? ""),
      bornAt: f?.bornAt,
      lastTs: Math.max(f?.lastActivity ?? 0, rs.reduce((mx, r) => Math.max(mx, r.updatedAt), 0)),
      turns: rs.length,
      preview: (last ? previewOf(last) : "") || f?.summary || "",
      runningUntil: until > now ? until : 0,
      taskTurns: rs.filter((r) => r.from?.kind === "task").length,
      peerTurns: rs.filter((r) => r.from?.kind === "peer").length,
    };
  });

  const known = new Set(nodes.map((n) => n.target));
  // 一条边的两端都必须是节点 —— 派活方可能已经被回收, 那条边就无处落脚, 画一个
  // 悬空端点只会让人以为漏了谁。
  const link = (m: Map<string, WorldEdge>, kind: WorldEdgeKind, from: string, to: string, ts: number, tag?: Parameters<typeof bumpEdge>[5]): Map<string, WorldEdge> =>
    known.has(from) && known.has(to) ? bumpEdge(m, kind, from, to, ts, tag) : m;

  // 观测边 —— 真的发生过的往来, 从 turn 记录里读。
  const observed = turns.reduce((m, r) => {
    const to = r.target!;
    const f = r.from;
    // 定时任务没有"派活的一方" —— 它是节点上的计数 (taskTurns), 不是一条边。
    const m1 = f?.kind === "peer" && f.from ? link(m, "peer", f.from, to, r.createdAt, { jobs: f.job }) : m;
    // graph: 上一步的 tag 喂给这一步 —— 同聊天内解析成 target。
    const prev = r.origin?.fromTag;
    return prev !== undefined
      ? link(m1, "graph", prev ? `${baseOfKey(to)}#${prev}` : baseOfKey(to), to, r.createdAt, { runs: r.origin!.runId })
      : m1;
  }, new Map<string, WorldEdge>());

  // 登记边 —— 家谱。观测不到 (分身可能一句话没说), 但它是最稳定的一种关系。
  const withClones = facts.wizards.reduce(
    (m, w) => (w.parent ? link(m, "clone", w.parent, w.target, w.bornAt ?? 0) : m),
    observed,
  );

  const edges = [...withClones.values()].sort((a, b) => b.lastTs - a.lastTs);

  // 有关系的一律留下 —— 边的端点被筛掉, 那条边就没地方落脚了。
  const linked = new Set(edges.flatMap((e) => [e.from, e.to]));
  const pinned = new Set([
    ...linked,
    ...facts.jobs.filter((j) => j.status === "open").flatMap((j) => [j.owner, ...j.members.map((mm) => mm.target)]),
    ...facts.schedules.map((x) => x.target),
  ]);
  const relevant = (n: WorldNode): boolean =>
    n.local || n.self || pinned.has(n.target) || n.busy || n.alive || now - n.lastTs < RECENT_MS;

  const parentOf = (t: string): string | undefined => factOf.get(t)?.parent;
  const byTs = (a: WorldNode, b: WorldNode): number => b.lastTs - a.lastTs;
  const bases = [...new Set(nodes.map((n) => n.base))];
  const chats: WorldChat[] = bases
    .map((base) => {
      const mine = nodes.filter((n) => n.base === base);
      const self = base === scope.base;
      const kept = mine.filter(relevant).sort(byTs).slice(0, self ? SELF_CHAT_MAX : PER_CHAT_MAX);
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
  const shown = new Set(chats.flatMap((c) => c.members.map((mm) => mm.target)));
  return {
    at: now,
    base: scope.base,
    self: scope.self,
    chats,
    nodes: nodes.filter((n) => shown.has(n.target)).sort(byTs),
    // 两端都还在图上的边才画得出来。
    edges: edges.filter((e) => shown.has(e.from) && shown.has(e.to)),
    jobs: [...facts.jobs].sort((a, b) => (b.closedAt ?? b.openedAt) - (a.closedAt ?? a.openedAt)),
    schedules: [...facts.schedules].sort((a, b) => a.nextAt - b.nextAt),
    degraded: facts.wizards.length === 0,
  };
};
