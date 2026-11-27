// 世界视图 —— 把「谁存在、谁是谁生的、谁在哪些 room 里、谁有哪些计划」折成一张图。
//
// room 模型之后, 图的骨架换了: **room 节点 ↔ 参与者节点** (二部图)。谁和谁说过话不再从
// transcript 里推断 (那是 role-view 老消息重建的活), 而是 room 账本里一行 join 就写明了的
// 事实。家谱 (谁生的谁) 仍是注册表给的另一层, 前端当可切换的图层画。
//
// 两类数据源, 边界明确:
//   • room 账本 (daemon 现扫, 独立 svr 用快照): 每个 room 的成员 / host / 最后一句 / 未决数。
//   • 登记与轮次 (wizard / plan / schedule 注册表 + turn 记录): 身份、家谱、计划、日程、用量。
//
// 纯函数, 无 IO: 注册表侧的东西由调用方以 WorldFacts 喂进来。
import { baseOfKey, labelFor, stripSigil, tagOfKey } from "./session-label.js";
import { ctxNow, isTurn, staleAt, isGhostTurn } from "./chat-view.js";
import { stripReminders } from "./reminder.js";
import type { CharterLineage, CharterRecord, DetailRecord, TurnDetailRecord, TurnItem } from "./detail-store.js";
import type { PlanRecord } from "./plan.js";
import type { RoomFact } from "./room-view.js";
import { smartsOf, type Smarts } from "./smarts.js";

// ── 注册表侧 (daemon 独有) ────────────────────────────────────────────
/** 一个 wizard 的登记信息 + 此刻的活体状态。daemon 从 wizard.json + tmux 取。 */
export interface WorldFactWizard {
  target: string;
  /** 实例的稳定身份 id (shared/room.ts uidOf): room 账本里一切引用都用它, 改名不变。
   *  老 daemon 的快照没有 —— 那时 room 也还不存在。 */
  uid?: string;
  /** 身份 id (P7 ⑦): 同身份多化身在 rolepage 聚成一页; 老 daemon 的快照没有 → 各化身各一页。 */
  identity?: string;
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
  /** 提示缓存已冷 (transcript 超过缓存 TTL 没动) —— 与 wizard_roster / chat_ask 冷门控同一口径
   *  (daemon/route.ts wakeCostOf)。只对 pane 还在的有意义; 老 daemon 快照没有。 */
  cacheCold?: boolean;
  /** 轮没结束却停在本地审批框 / 弹窗上等人点 (registry idle 且悬着 tool_use) —— 不是在干活, isBusy 把它算忙。 */
  parked?: boolean;
  /** 停在哪些工具调用上等人点 (审批卡 / 提问卡) 的工具名; 缺省 = 没在等。 */
  waiting?: string[];
  /** 谁生的它 —— 分身与子 wizard 都有; 两者靠 clonedFrom 区分。 */
  parent?: string;
  /** fork 自父亲的哪个 sessionId; 有值 = 分身 (开局带着父亲的上下文), 空 = 父亲 spawn 的白板。 */
  clonedFrom?: string;
  /** 被克隆的那个 wizard —— 只在它不是 parent 时才有 (parent 克隆了别人)。 */
  forkOf?: string;
  bornAt?: number;
  /** 类实例的序号 (daemon/wizard.ts WizardRecord.ordinal); 有它 = 名字是 <类名>-<序号>。 */
  ordinal?: number;
  /** 它是所在聊天此刻的管家实例 (daemon/steward.ts isStewardTarget)。老 daemon 快照没有。 */
  steward?: boolean;
  /** 当前档位 (WizardRecord.tier, mini..ultra): 出生时记, set_model 换模型 / effort 后由 daemon 反查档位表更新。老 daemon 快照没有。 */
  tier?: string;
  /** 被派来领一件复杂活的 lead (WizardRecord.lead: 只由 daemon 在 lead:true 派成 / spawn 时写, 不能自封)。老 daemon 快照没有。 */
  lead?: boolean;
  /** transcript mtime, 0 = 从没写过。 */
  lastActivity: number;
  /** 最近在聊什么的一行。 */
  summary: string;
}

/** 类表 (daemon/classes.ts) 的一行: <role, workspace> 唯一的人物设定。
 *  实例名是 <name>-<ordinal>; rolepage 只用 name 标「所属类」。老 daemon 快照没有。 */
export interface WorldFactClass { id: string; name: string; role: string; workspace: string }

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
  /** 这条日程归谁 —— 排班那个 wizard 的 target。rolepage 的「日程」按它过滤。 */
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

/** 一个微信通道的此刻: 掉没掉线、人最近何时开口、压着几条没发、这份 context_token 还能发几条、频控暂停到何时 (0 = 没停)。 */
export interface WorldFactWeixin { base: string; state: "live" | "expired"; lastInAt: number; held: number; budget: number; pausedUntil: number }

export interface WorldFacts {
  wizards: readonly WorldFactWizard[];
  plans: readonly PlanRecord[];
  schedules: readonly WorldFactSchedule[];
  /** base → 聊天名; 没起名的不在表里。 */
  chatNames: Readonly<Record<string, string>>;
  /** human id (human:x) → 显示名; 不在表里的显示裸 id。老 daemon 推来的快照没有。 */
  humanNames?: Readonly<Record<string, string>>;
  /** 微信 ClawBot 通道的账号状态, 每个绑定的微信用户一个群 (chat:wx_…)。 */
  weixin?: readonly WorldFactWeixin[];
  /** 类表 —— 群成员列表用它标出实例所属的类。老 daemon 快照没有 = 只画名字。 */
  classes?: readonly WorldFactClass[];
  /** room 账本的快照 (daemon 现扫, svr 随快照带): 关系图与 room 视图的唯一来源。
   *  老 daemon 没有 = 只有轮次视图, 图退化成家谱。 */
  rooms?: readonly RoomFact[];
  /** 已知频道 (频道没有 room, 但绑了 host 身份的频道也要有一个框): daemon 现算, svr 随快照带。
   *  /api/world 的 channels = 这份种子 ∪ 从 rooms 归并出来的 (带各自名下的 room)。 */
  channels?: ReadonlyArray<{ id: string; name: string; host?: { identity: string; name: string } }>;
  /** 名字表: who.id → 显示名 (wizard 是 uid, 人是 userid)。room 成员只有 id, 名字走这里。 */
  names?: Readonly<Record<string, string>>;
  /** 这份不是注册表给的, 是「没拿到」的占位 —— 显式信号: 空名册 ≠ 注册表不可达。 */
  absent?: true;
}

/** 群名兜底: daemon 的 chatNames 只有 config.chats 里的存量冻结标签, 新群没有 (daemon 侧已不再
 *  自动写入工作区名) —— 这类群的 room 在 rolepage 上就只剩「群 …xxxx」短代号。
 *  没名字的聊天按 默认 wizard 的名字 (untagged 会话) → 同聊天任一 wizard 的工作区 basename 补上;
 *  已有的名字一律不动, 真的什么都没有才留给前端落短代号。 */
export const withChatNameFallback = (f: WorldFacts): WorldFacts => {
  const base = (w: WorldFactWizard): string => baseOfKey(w.target);
  const basename = (p: string): string => p.replace(/\/+$/, "").split("/").pop() ?? "";
  const missing = (w: WorldFactWizard): boolean => !!base(w) && !f.chatNames[base(w)];
  const pick = (ws: readonly WorldFactWizard[]): Record<string, string> =>
    ws.reduce<Record<string, string>>((m, w) => (m[base(w)] ? m : { ...m, [base(w)]: w.name || basename(w.cwd) }), {});
  const byDefault = pick(f.wizards.filter((w) => missing(w) && !tagOfKey(w.target) && w.name));
  const byCwd = pick(f.wizards.filter((w) => missing(w) && !byDefault[base(w)] && basename(w.cwd)).map((w) => ({ ...w, name: basename(w.cwd) })));
  return { ...f, chatNames: { ...byCwd, ...byDefault, ...f.chatNames } };
};

export const EMPTY_FACTS: WorldFacts = { wizards: [], plans: [], schedules: [], chatNames: {}, absent: true };

// ── 视图模型 ──────────────────────────────────────────────────────────
export interface WorldNode {
  /** wizard = target key; 人 = human:<userid>; 只在 room 里出现过、注册表没有的 wizard = uid:<uid>。 */
  target: string;
  /** 节点种类 —— 二部图的另一侧只连 room, 人 / wizard 的装饰不同。 */
  kind: "wizard" | "human";
  /** wizard 的实例 uid (room 成员引用它); 人没有。 */
  uid?: string;
  base: string;
  tag: string;
  chat: string;
  /** 全局名字 (不带点): 登记的名字 > slot id > 聊天名 > target。 */
  name: string;
  label: string;
  description: string;
  cwd: string;
  model: string;
  /** 同 WorldFactWizard.effort。 */
  effort?: string;
  /** 同 WorldFactWizard.lead。 */
  lead?: boolean;
  /** 聪明程度 1~5 (shared/smarts.ts): 只由档位 tier 决定 (没有档位 = 不带); note 是实际模型的附注。 */
  smarts?: Smarts;
  /** 此刻的上下文占用量, 口径同用量条的 ctx。0 = 没有带 usage 的轮次记录。 */
  ctx: number;
  cli: string;
  busy: boolean;
  alive: boolean;
  /** 同 WorldFactWizard.cacheCold。节点状态: busy → working; 无 pane → cold; pane 在而缓存冷 → warm; 其余 idle。 */
  cacheCold?: boolean;
  /** 同 WorldFactWizard.parked。 */
  parked?: boolean;
  /** 同 WorldFactWizard.waiting。 */
  waiting?: string[];
  /** 注册表里有登记 —— false = 只在 room / 轮次里出现过的会话。 */
  known: boolean;
  /** 占位: 已停且无记录, 只为把还在的后代挂回它名下 (灰色)。 */
  ghost?: boolean;
  /** 这是打开本页那条链接所属的会话。 */
  self: boolean;
  /** 与 self 同一个聊天 (本群在图上高亮)。 */
  local: boolean;
  parent?: string;
  inherited: boolean;
  bornAt?: number;
  /** 最近活动时刻 (turn 记录与 transcript mtime 取大)。 */
  lastTs: number;
  turns: number;
  /** 一行近况: 最近一轮的正文 > 注册表 summary。 */
  preview: string;
  /** 无新写入时到这个时刻自动算结束; 0 = 已停。 */
  runningUntil: number;
  /** 被定时任务叫醒过几轮。 */
  taskTurns: number;
  /** 被同伴派活开出的轮数 (room 模型里这是账本上的事实, 图改用 room 成员线)。 */
  peerTurns: number;
  /** 与它有关系 (同 room 或家谱) 的全部节点 id。 */
  rels?: string[];
}

/** 家谱三种, 都画在「生它、归它管」或「上下文从它来」的那一位下:
 *  clone = 分身 (parent 生的, 开局 fork 了上下文); spawn = 新生 (parent 生的白板);
 *  fork = 分身的上下文来源 —— 只在克隆的是别人 (forkOf ≠ parent) 时另画这一条。
 *  room 归属不在这里 —— 二部图的边由 room 成员直接画, 不需要再序列化一份。 */
export type WorldEdgeKind = "clone" | "spawn" | "fork";

export interface WorldEdge {
  kind: WorldEdgeKind;
  from: string;
  to: string;
  /** 家谱恒为 1 —— 不是流量。 */
  count: number;
  lastTs: number;
  /** clone 边: 分身在 origin 会话里分叉的那一处。 */
  point?: ClonePoint;
}

/** origin = 被克隆的那一方 (parent, 克隆的是别人时是 forkOf)。id = rolepage 的消息 id;
 *  use = origin 调 clone_wizard 的那次 tool_use —— 认不出调用、落到出生前那一句时没有。 */
export interface ClonePoint { origin: string; id?: string; use?: string; ts: number }

export interface WorldView {
  at: number;
  /** 打开本页的那个聊天。 */
  base: string;
  self: string;
  /** room 账本快照 (最近的在前)。 */
  rooms: RoomFact[];
  /** uid → target: 前端拿它把 room 成员 id 对到节点上。 */
  uidTargets: Record<string, string>;
  nodes: WorldNode[];
  plans: PlanRecord[];
  schedules: WorldFactSchedule[];
  /** 注册表缺席 (svr 独立部署) —— 前端据此说明「只画观测到的往来」。 */
  degraded: boolean;
}

// ── 折叠 ──────────────────────────────────────────────────────────────
const liveTurns = (records: readonly DetailRecord[], now: number): TurnDetailRecord[] =>
  records.filter(isTurn).filter((r) => !isGhostTurn(r, now) && !r.agent && !!r.target);

const stripMd = (s: string): string => s.replace(/[`*_~|#>]/g, "").replace(/\s+/g, " ").trim();

const previewOf = (r: TurnDetailRecord): string => {
  const texts = r.items.filter((it): it is Extract<typeof it, { t: "text" }> => it.t === "text");
  // 问话行开头可能顶着宪章 preamble / 信封 (reminder 块) —— 先剥再截, 预览才轮得到正文。
  return stripMd(texts[texts.length - 1]?.body ?? stripReminders(r.userQuery ?? "")).slice(0, 100);
};

/** 一条边的身份 —— 同一对端点同一种类只留一条, count 累加。 */
const edgeKey = (kind: string, from: string, to: string): string => kind + "\u0000" + from + "\u0000" + to;

const bumpEdge = (m: Map<string, WorldEdge>, kind: WorldEdgeKind, from: string, to: string, ts: number): Map<string, WorldEdge> => {
  if (!from || !to || from === to) return m;
  const k = edgeKey(kind, from, to);
  const cur = m.get(k);
  return m.set(k, { kind, from, to, count: (cur?.count ?? 0) + 1, lastTs: Math.max(cur?.lastTs ?? 0, ts) });
};

/** 注册表侧按消息数据裁剪: 没有 transcript (lastActivity = 0)、轮次记录里也没有它、
 *  又不在任何 room 里的 wizard 不进世界 —— 画出来只是一张空卡。
 *  活着的照留: 刚 spawn 还没开口的分身就是这样。
 *  挂在被裁者名下的后代改认最近一个留下的祖先 (clone 的上下文来源同理), 家谱不断。 */
export const withData = (facts: WorldFacts, records: readonly DetailRecord[], _now: number): WorldFacts => {
  const uidOfTarget = new Map(facts.wizards.filter((w) => w.uid).map((w) => [w.target, w.uid!] as const));
  const inRoom = new Set((facts.rooms ?? []).flatMap((r) => r.members.flatMap((m) => {
    if (m.who.kind !== "wizard") return [];
    const t = [...uidOfTarget].find(([, u]) => u === m.who.id)?.[0];
    return t ? [t] : [];
  })));
  const spoke = new Set(records.filter(isTurn).map((r) => (r as { target?: string }).target).filter((t): t is string => !!t));
  const keep = (w: WorldFactWizard): boolean => w.alive || w.busy || w.lastActivity > 0 || spoke.has(w.target) || inRoom.has(w.target);
  const byTarget = new Map(facts.wizards.map((w) => [w.target, w] as const));
  // 被裁者若还有留下的后代, 不把后代改挂祖父, 而是留一个占位 (ghost) 代表它。
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
const msgIdOf = (r: TurnDetailRecord): string => r.id + ":" + (r.items.length || !r.closed ? "out" : "in");

/** 分身在 origin 会话 (rs, 按时刻升序) 里分叉的那一处: origin 自己调 clone_wizard 生的 (byCall),
 *  就是那次调用 —— 按名字认, 认不出名字取离出生最近的那次; 否则落到出生前最近的那一句。 */
export const clonePointOf = (rs: readonly TurnDetailRecord[], origin: string, name: string, bornAt: number, byCall: boolean): ClonePoint => {
  const calls = byCall
    ? rs.flatMap((r) => r.items.filter((it): it is ToolUseItem => it.t === "tool_use" && CLONE_TOOL.test(it.toolName)).map((u) => ({ r, u })))
    : [];
  const near = (ts: number): number => Math.abs(ts - bornAt);
  const call = calls.find((c) => clonedName(c.r, c.u) === name) ??
    calls.filter((c) => near(c.u.ts) < 5 * 60_000).sort((a, b) => near(a.u.ts) - near(b.u.ts))[0];
  if (call) return { origin, id: call.r.id + ":out", use: call.u.toolUseId, ts: call.u.ts };
  const before = rs.filter((r) => r.createdAt <= bornAt).at(-1) ?? rs[0];
  return before ? { origin, id: msgIdOf(before), ts: before.createdAt } : { origin, ts: bornAt };
};

const humanNode = (target: string, facts: WorldFacts, scope: { base: string; self: string }, lastTs: number): WorldNode => ({
  target, kind: "human", base: "", tag: "", chat: "", label: "👤",
  name: facts.names?.[target.slice("human:".length)] ?? facts.humanNames?.[target] ?? target.slice("human:".length),
  description: "", cwd: "", model: "", ctx: 0, cli: "", busy: false, alive: false, known: false,
  self: target === scope.self, local: false, inherited: false, lastTs, turns: 0, preview: "",
  runningUntil: 0, taskTurns: 0, peerTurns: 0,
});

export const buildWorld = (
  records: readonly DetailRecord[],
  facts: WorldFacts,
  scope: { base: string; self: string },
  now: number,
): WorldView => {
  const turns = liveTurns(records, now);
  const byTarget = turns.reduce((m, r) => m.set(r.target!, [...(m.get(r.target!) ?? []), r]), new Map<string, TurnDetailRecord[]>());
  const factOf = new Map(facts.wizards.map((w) => [w.target, w] as const));
  const rooms = facts.rooms ?? [];
  const uidTarget = new Map(facts.wizards.filter((w) => w.uid).map((w) => [w.uid!, w.target] as const));
  const roomWizardUids = new Set(rooms.flatMap((r) => r.members.filter((m) => m.who.kind === "wizard").map((m) => m.who.id)));
  const roomHumanIds = new Set(rooms.flatMap((r) => r.members.filter((m) => m.who.kind === "human").map((m) => m.who.id)));

  // wizard 节点 = 登记过的 ∪ 跑过轮次的 ∪ 在 room 里出现过的 (只有 uid 的就造一个 uid:<uid> 节点)。
  const targets = [...new Set([...factOf.keys(), ...byTarget.keys(), ...[...roomWizardUids].map((u) => uidTarget.get(u)).filter((t): t is string => !!t)])];
  const nodes: WorldNode[] = targets.map((target) => {
    const f = factOf.get(target);
    const rs = (byTarget.get(target) ?? []).sort((a, b) => a.createdAt - b.createdAt);
    const last = rs[rs.length - 1];
    const said = rs.at(-1);
    const tag = tagOfKey(target);
    const base = baseOfKey(target);
    const chat = f?.chat ?? facts.chatNames[base] ?? "";
    const until = rs.reduce((mx, r) => Math.max(mx, staleAt(r)), 0);
    const name = (f?.name ?? "").trim() || tag || chat || target;
    const model = f?.model || [...rs].reverse().find((r) => r.model)?.model || "";
    const smarts = smartsOf({ tier: f?.tier, model, effort: f?.effort });
    return {
      target, kind: "wizard",
      ...(f?.uid ? { uid: f.uid } : {}),
      base, tag, chat, name, label: labelFor(name),
      description: f?.description ?? "",
      cwd: f?.cwd || [...rs].reverse().find((r) => r.cwd)?.cwd || "",
      model,
      ...(f?.effort ? { effort: f.effort } : {}),
      ...(f?.lead ? { lead: true } : {}),
      ...(smarts ? { smarts } : {}),
      ctx: ctxNow(rs),
      cli: f?.cli || last?.cli || "",
      busy: f?.busy ?? false,
      alive: f?.alive ?? false,
      ...(f?.cacheCold !== undefined ? { cacheCold: f.cacheCold } : {}),
      ...(f?.parked ? { parked: true } : {}),
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
  // 只在 room 里出现过、注册表已经没有的 wizard: 仍要有一个节点, 否则 room 的成员线悬空。
  const knownUids = new Set(nodes.map((n) => n.uid).filter(Boolean));
  const orphanWizards: WorldNode[] = [...roomWizardUids].filter((u) => !knownUids.has(u)).map((u) => ({
    target: "uid:" + u, kind: "wizard", uid: u, base: "", tag: "", chat: "",
    name: facts.names?.[u] ?? u, label: labelFor(facts.names?.[u] ?? u), description: "",
    cwd: "", model: "", ctx: 0, cli: "", busy: false, alive: false, known: false, self: false, local: false,
    inherited: false, lastTs: rooms.reduce((mx, r) => (r.members.some((m) => m.who.kind === "wizard" && m.who.id === u) ? Math.max(mx, r.last?.at ?? 0) : mx), 0),
    turns: 0, preview: "", runningUntil: 0, taskTurns: 0, peerTurns: 0,
  }));
  const humans: WorldNode[] = [...roomHumanIds].map((id) => humanNode("human:" + id, facts, scope, rooms.reduce((mx, r) => (r.members.some((m) => m.who.kind === "human" && m.who.id === id) ? Math.max(mx, r.last?.at ?? 0) : mx), 0)));
  const all = [...nodes, ...orphanWizards, ...humans];
  const known = new Set(all.map((n) => n.target));
  // 一条边的两端都必须是节点 —— 派活方可能已经被回收, 那条边就无处落脚。
  const link = (m: Map<string, WorldEdge>, kind: WorldEdgeKind, from: string, to: string, ts: number): Map<string, WorldEdge> =>
    known.has(from) && known.has(to) ? bumpEdge(m, kind, from, to, ts) : m;

  // 登记边 —— 家谱。观测不到 (分身可能一句话没说), 但它是最稳定的一种关系。
  const registered = facts.wizards.reduce(
    (m, w) => {
      if (!w.parent) return m;
      const m1 = link(m, w.clonedFrom ? "clone" : "spawn", w.parent, w.target, w.bornAt ?? 0);
      return w.clonedFrom && w.forkOf ? link(m1, "fork", w.forkOf, w.target, w.bornAt ?? 0) : m1;
    },
    new Map<string, WorldEdge>(),
  );
  // 注册表里已经没有的, 家谱只剩它的宪章 —— 宪章不进 TTL, 记着出生那一刻谁生的它。
  const byName = new Map(all.map((n) => [n.name, n.target] as const));
  const lineageEdge = (m: Map<string, WorldEdge>, kind: WorldEdgeKind, from: string | undefined, to: string, ts: number): Map<string, WorldEdge> =>
    from ? link(m, kind, from, to, ts) : m;
  const chartered = records.filter((r): r is CharterRecord => r.kind === "charter" && !factOf.has(r.target))
    .flatMap((c) => ((l) => (l ? [{ c, l }] : []))(lineageOf(c, (n) => byName.get(n))));
  const withLineage = chartered.reduce((m, { c, l }) => {
    const m1 = lineageEdge(m, l.kind, l.parent, c.target, c.createdAt);
    return l.kind === "clone" ? lineageEdge(m1, "fork", l.forkOf, c.target, c.createdAt) : m1;
  }, registered);

  const clones = new Map<string, { origin: string; parent: string; bornAt: number }>([
    ...facts.wizards.filter((w) => w.parent && w.clonedFrom).map((w) => [w.target, { origin: w.forkOf ?? w.parent!, parent: w.parent!, bornAt: w.bornAt ?? 0 }] as const),
    ...chartered.filter(({ l }) => l.kind === "clone").map(({ c, l }) => [c.target, { origin: l.forkOf ?? l.parent, parent: l.parent, bornAt: c.createdAt }] as const),
  ]);
  const nameOf = new Map(all.map((n) => [n.target, n.name] as const));
  const withPoint = (e: WorldEdge): WorldEdge => {
    const k = e.kind === "clone" ? clones.get(e.to) : undefined;
    if (!k) return e;
    const rs = [...(byTarget.get(k.origin) ?? [])].sort((a, b) => a.createdAt - b.createdAt);
    return { ...e, point: clonePointOf(rs, k.origin, nameOf.get(e.to) ?? "", k.bornAt, k.origin === k.parent) };
  };
  const edges = [...withLineage.values()].map(withPoint).sort((a, b) => b.lastTs - a.lastTs);

  // 关系 = 同处一个 room 的成员 + 家谱两端 (图上要能顺着它走)。
  const nodeOfMember = (w: { kind: string; id: string }): string | undefined =>
    w.kind === "wizard" ? uidTarget.get(w.id) ?? "uid:" + w.id : w.kind === "human" ? "human:" + w.id : undefined;
  const rels = edges.reduce((m, e) => {
    const add = (a: string, b: string): void => { m.set(a, (m.get(a) ?? new Set<string>()).add(b)); };
    add(e.from, e.to); add(e.to, e.from);
    return m;
  }, new Map<string, Set<string>>());
  for (const r of rooms) {
    const ids = r.members.map((m) => nodeOfMember(m.who)).filter((x): x is string => !!x && known.has(x));
    for (const a of ids) for (const b of ids) if (a !== b) (rels.get(a) ?? rels.set(a, new Set()).get(a)!).add(b);
  }

  // 相关: 在 room 里 / 有关系的一端 / 还活着 / 最近动过 / 自己。其余不出图 (room 本身仍在)。
  const RECENT_MS = 6 * 3600_000;
  const inAnyRoom = new Set(rooms.flatMap((r) => r.members.map((m) => nodeOfMember(m.who)).filter((x): x is string => !!x)));
  const linked = new Set(edges.flatMap((e) => [e.from, e.to]));
  const pinned = new Set([
    ...linked,
    ...facts.plans.filter((p) => p.state === "active" || p.state === "paused").map((p) => p.owner),
    ...facts.schedules.flatMap((x) => [x.target, x.owner].filter(Boolean)),
  ]);
  const relevant = (n: WorldNode): boolean =>
    n.self || n.kind === "human" || inAnyRoom.has(n.target) || pinned.has(n.target) || n.busy || n.alive || now - n.lastTs < RECENT_MS;
  const shown = all.filter(relevant);
  const shownIds = new Set(shown.map((n) => n.target));

  return {
    at: now,
    base: scope.base,
    self: scope.self,
    rooms: [...rooms].sort((a, b) => (b.last?.at ?? 0) - (a.last?.at ?? 0)),
    uidTargets: Object.fromEntries(uidTarget),
    nodes: shown.sort((a, b) => b.lastTs - a.lastTs)
      .map((n) => ({ ...n, rels: [...(rels.get(n.target) ?? [])].filter((x) => shownIds.has(x)) })),
    plans: [...facts.plans].sort((a, b) => b.updatedAt - a.updatedAt),
    schedules: [...facts.schedules].sort((a, b) => a.nextAt - b.nextAt),
    degraded: !!facts.absent,
  };
};
