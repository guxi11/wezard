// Rolepage 的名录与会话分段 —— 纯函数, 无 IO。
//
// room 模型之后, 消息不再从 turn 记录重建: 一条消息是 room 账本上的一行, 出处 / 完成 /
// 发言权都写在行上 (见 shared/room-view.ts)。本文件只剩两件与 turn 记录有关的事:
//   • 会话分段 (sessionsOf / marksOf): 同一个 wizard 的 /clear /new 轮换, 切换视角时按时间
//     窗过滤;
//   • 名录 (makeDirectory / roleInfo / roleStats): 名字解析、活体状态、身份聚合与用量账。
//
// role id: wizard 就是它的 target key; 人是 human:<userid>; 定时任务是 task:<id>。
import { baseOfKey, labelFor, stripSigil, tagOfKey } from "./session-label.js";
import { isGhostTurn, isMark, isTurn, staleAt, summarizeTag, type TagSummary } from "./chat-view.js";
import type { DetailRecord, MarkDetailRecord, TurnDetailRecord } from "./detail-store.js";
import type { WorldFacts, WorldFactWeixin, WorldFactWizard } from "./world.js";

export type RoleKind = "wizard" | "human" | "task";

export const SYSTEM = "system:";

/** `user:<id>` (speaker / 单聊 base) → 人的 role id。 */
export const humanOf = (principal: string): string => "human:" + principal.replace(/^user:/, "").replace(/#.*$/, "");

// ── 名录 ─────────────────────────────────────────────────────────────
/** 一个 wizard 此刻的活体状态。「执行中」由客户端判: busy || 现在 < runningUntil ——
 *  pane 的转圈 (busy) 在长工具调用里也亮着, 但它是名册快照、会过期; turn 记录
 *  (runningUntil) 随写入即时, 但静默久了会误熄。两个信号互补, 任一成立就算在跑。 */
export interface RoleStatus {
  alive: boolean;
  busy: boolean;
  /** 同 TagSummary.runningUntil: 无新写入时到这个时刻自动算结束, 0 = 已停。 */
  runningUntil: number;
  /** 停在哪些工具调用上等人点; 缺省 = 没在等。优先于「执行中」。 */
  waiting?: string[];
}

export interface Directory {
  nameOf: (id: string) => string;
  labelOf: (id: string) => string;
  /** .fix / fix / target / user:x → role id; undefined = 不认识。 */
  resolve: (ref: string) => string | undefined;
  fact: (id: string) => WorldFactWizard | undefined;
  chatName: (base: string) => string;
  /** 微信通道群 (chat:wx_…) 的账号状态; 不是微信群 / 老 daemon 没给 = undefined。 */
  weixin: (base: string) => WorldFactWeixin | undefined;
  isWizard: (id: string) => boolean;
  /** undefined = 不是 wizard (人 / 定时 / 系统没有「执行中」)。 */
  status: (id: string, now: number) => RoleStatus | undefined;
  /** 认得的全部 wizard。 */
  wizards: () => string[];
  /** 身份规范 target (P7 ⑦): 同身份多化身收敛到同一页; 无 identity 的事实恒等。 */
  canon: (id: string) => string;
}

const fold = (s: string): string => stripSigil(s).toLowerCase();

export const makeDirectory = (records: readonly DetailRecord[], facts: WorldFacts): Directory => {
  const facts_ = new Map(facts.wizards.map((w) => [w.target, w] as const));
  const turnTargets = new Set(records.filter(isTurn).map((r) => r.target).filter((t): t is string => !!t));
  const wizards = new Set([...facts_.keys(), ...turnTargets]);
  const chatName = (base: string): string => facts.chatNames[base] ?? "";
  const nameOf = (id: string): string => {
    if (id.startsWith("task:")) return "定时 " + id.slice(5);
    if (id === SYSTEM) return "wezard";
    if (wizards.has(id)) return (facts_.get(id)?.name ?? "").trim() || tagOfKey(id) || chatName(baseOfKey(id)) || id;
    return id.startsWith("human:") ? facts.humanNames?.[id] || id.slice(6) : id;
  };
  const labelOf = (id: string): string =>
    id.startsWith("task:") ? "⏰" : id === SYSTEM ? "🧙‍♂️" : wizards.has(id) ? labelFor(nameOf(id)) : "👤";
  // P7 ⑦: 每个身份选一个规范 target (锚点 target === identity 优先, 否则字典序最小),
  // 同身份的化身全部收敛到它; 没有 identity 的事实恒等 (老快照兼容)。
  const identityFact = new Map(facts.wizards.filter((w) => w.identity).map((w) => [w.target, w.identity!] as const));
  const byIdentity = new Map<string, string[]>();
  for (const t of wizards) {
    const id = identityFact.get(t);
    if (!id) continue;
    byIdentity.set(id, [...(byIdentity.get(id) ?? []), t]);
  }
  const canonical = new Map<string, string>();
  for (const [id, ts] of byIdentity) {
    const rep = ts.includes(id) ? id : [...ts].sort()[0]!;
    ts.forEach((t) => canonical.set(t, rep));
  }
  const canon = (t: string): string => canonical.get(t) ?? t;
  const manifestationsOf = (id: string): string[] => [...wizards].filter((t) => canon(t) === id);
  const byName = new Map([...wizards].map((t) => [fold(nameOf(t)), canon(t)] as const));
  const resolve = (ref: string): string | undefined => {
    const r = (ref ?? "").trim();
    if (!r) return undefined;
    if (wizards.has(r)) return canon(r);
    const named = byName.get(fold(r));
    if (named) return named;
    if (r === "human:") return SYSTEM;
    if (/^human:[^#]+$/.test(r)) return r;
    return /^user:[^#]+$/.test(r) ? humanOf(r) : undefined;
  };
  // 只有摘要要状态, 而 makeDirectory 每次都会建 —— 用到才扫一遍。
  let until: Map<string, number> | undefined;
  const untilOf = (id: string): number =>
    (until ??= records.filter(isTurn).reduce(
      (m, r) => (r.target ? m.set(canon(r.target), Math.max(m.get(canon(r.target)) ?? 0, staleAt(r))) : m),
      new Map<string, number>(),
    )).get(id) ?? 0;
  const status = (id: string, now: number): RoleStatus | undefined => {
    if (!wizards.has(id)) return undefined;
    const fs = manifestationsOf(id).map((t) => facts_.get(t)).filter((f): f is WorldFactWizard => !!f);
    const f = facts_.get(id) ?? fs[0];
    const t = Math.max(0, ...manifestationsOf(id).map((x) => untilOf(x)));
    const waiting = [...new Set(fs.flatMap((x) => x.waiting ?? []))];
    return { alive: fs.some((x) => x.alive) || !!f?.alive, busy: fs.some((x) => x.busy) || !!f?.busy,
      runningUntil: t > now ? t : 0, ...(waiting.length ? { waiting } : {}) };
  };
  const wx = new Map((facts.weixin ?? []).map((w) => [w.base, w] as const));
  return { nameOf, labelOf, resolve, fact: (id) => facts_.get(id) ?? manifestationsOf(id).map((t) => facts_.get(t)).find(Boolean), chatName, weixin: (base) => wx.get(base), isWizard: (id) => wizards.has(id), status, wizards: () => [...wizards], canon };
};

// ── 微信通道 ─────────────────────────────────────────────────────────
/** 群行 / 群详情头部名字旁的小标记: 怎么判、写什么只在这里, 页面照抄 text / tip。 */
export interface WxMark { state: "live" | "paused" | "down"; text: string; tip: string }
const agoText = (ms: number): string =>
  ms < 60_000 ? "刚刚" : ms < 3600_000 ? Math.floor(ms / 60_000) + " 分钟前" : ms < 86400_000 ? Math.floor(ms / 3600_000) + " 小时前" : Math.floor(ms / 86400_000) + " 天前";
export const wxMark = (w: WorldFactWeixin, now: number): WxMark => {
  const state = w.state === "expired" ? "down" : w.pausedUntil > now ? "paused" : "live";
  const head = { live: "🟢 微信", paused: "⏸️ 微信频控", down: "🔴 微信掉线" }[state];
  const tip = [
    state === "down" ? "微信通道掉线 —— 在企微单聊发 /wx bind 重新扫码" : "微信通道在线",
    "对方最近开口: " + (w.lastInAt ? agoText(now - w.lastInAt) : "从没有"),
    ...(state === "down" ? [] : ["这一轮还能发 " + w.budget + " 条 (对方每说一句补一份额度)"]),
    ...(w.held ? ["压着 " + w.held + " 条没发出, " + (state === "down" ? "重新绑定后" : "对方再说一句就") + "取回"] : []),
    ...(state === "paused" ? ["频控暂停出站, 还剩 " + Math.ceil((w.pausedUntil - now) / 60_000) + " 分钟"] : []),
  ].join("\n");
  return { state, text: head + (w.held ? " · 📬 压着 " + w.held : ""), tip };
};

// ── session ───────────────────────────────────────────────────────────
// 同一个名字下的多个 session (/clear /new 轮换, handoff 重开): 按 sessionId 分段,
// 每段的时间窗 = [首轮, 下一段首轮)。切换 session 就是按时间窗过滤。
export interface SessionSpan {
  sessionId: string;
  /** 这一段的外沿 (只用于显示/排序); 真正的时间窗是 runs —— 同一 sid 可能被别的轮隔开。 */
  start: number;
  end: number;
  turns: number;
  lastTs: number;
  /** 同一 sid 的若干时间窗 (至少一段)。只有被隔开时才给。 */
  runs?: ReadonlyArray<{ start: number; end: number }>;
}

export const sessionsOf = (records: readonly DetailRecord[], role: string, now: number): SessionSpan[] => {
  const turns = records.filter(isTurn).filter((r) => r.target === role && !r.agent && !isGhostTurn(r, now))
    .sort((a, b) => a.createdAt - b.createdAt);
  // 先按连续切段 (每段的时间窗 = [本段首轮, 下一段首轮)), 再按 sid 归并 —— 一条 sessionId
  // 缺失的轮夹在中间, 不能把同一场 session 劈成两段两行。
  const runs = turns.reduce<Array<{ sessionId: string; rs: TurnDetailRecord[] }>>((acc, r) => {
    const sid = r.sessionId ?? "";
    const cur = acc[acc.length - 1];
    return cur && cur.sessionId === sid ? [...acc.slice(0, -1), { sessionId: sid, rs: [...cur.rs, r] }] : [...acc, { sessionId: sid, rs: [r] }];
  }, []);
  const windows = runs.map((g, i) => ({
    sessionId: g.sessionId,
    rs: g.rs,
    run: { start: g.rs[0]!.createdAt, end: runs[i + 1]?.rs[0]?.createdAt ?? Infinity },
  }));
  const bySid = windows.reduce<Map<string, { rs: TurnDetailRecord[]; runs: Array<{ start: number; end: number }> }>>(
    (m, w) => {
      const cur = m.get(w.sessionId);
      m.set(w.sessionId, cur ? { rs: [...cur.rs, ...w.rs], runs: [...cur.runs, w.run] } : { rs: w.rs, runs: [w.run] });
      return m;
    },
    new Map(),
  );
  return [...bySid].map(([sessionId, g]) => ({
    sessionId,
    start: g.runs[0]!.start,
    end: g.runs[g.runs.length - 1]!.end,
    turns: g.rs.length,
    lastTs: g.rs.reduce((m, r) => Math.max(m, r.updatedAt), 0),
    ...(g.runs.length > 1 ? { runs: g.runs } : {}),
  }));
};

export const inSpan = (span: SessionSpan | undefined) => (ts: number): boolean =>
  !span || (span.runs ?? [span]).some((r) => ts >= r.start && ts < r.end);

/** 视角 role 自己的上下文断点 (/clear /new)。 */
export const marksOf = (records: readonly DetailRecord[], role: string): MarkDetailRecord[] =>
  records.filter(isMark).filter((m) => m.target === role);

// ── 身份 ─────────────────────────────────────────────────────────────
export interface RoleInfo extends RoleStatus {
  id: string;
  kind: RoleKind;
  name: string;
  label: string;
  description: string;
  cwd: string;
  model: string;
  bornAt?: number;
  /** home 聊天的名字。 */
  chat: string;
  parent?: { id: string; name: string; label: string };
  /** 分身: 从某个 session 节点 fork 出来的, 开局带着那一刻的上下文。 */
  clones: Array<{ id: string; name: string; label: string }>;
  /** 子 wizard: spawn 出来的白板, 只有出身、没有继承。 */
  spawns: Array<{ id: string; name: string; label: string }>;
  /** fork 自父亲的哪个 sessionId; "" = 不是分身。 */
  forkedFrom: string;
}

const COLD: RoleStatus = { alive: false, busy: false, runningUntil: 0 };

export const roleInfo = (id: string, dir: Directory, facts: WorldFacts, stats: TagSummary | undefined, now: number): RoleInfo => {
  const f = dir.fact(id);
  const ref = (t: string) => ({ id: t, name: dir.nameOf(t), label: dir.labelOf(t) });
  const wiz = dir.isWizard(id);
  const kids = facts.wizards.filter((w) => w.parent === id);
  return {
    id,
    kind: wiz ? "wizard" : id.startsWith("task:") ? "task" : "human",
    name: dir.nameOf(id),
    label: dir.labelOf(id),
    description: f?.description ?? "",
    cwd: f?.cwd || stats?.cwd || "",
    model: f?.model || stats?.model || "",
    bornAt: f?.bornAt,
    chat: wiz ? dir.chatName(baseOfKey(id)) : "",
    parent: f?.parent ? ref(f.parent) : undefined,
    clones: kids.filter((w) => w.clonedFrom).map((w) => ref(w.target)),
    spawns: kids.filter((w) => !w.clonedFrom).map((w) => ref(w.target)),
    ...(dir.status(id, now) ?? COLD),
    forkedFrom: f?.clonedFrom ?? "",
  };
};

/** 页脚总账: 视角 role 自己跑过的全部轮次 (含子 agent —— 那都是真花销)。 */
export const roleStats = (records: readonly DetailRecord[], role: string, now: number, span?: SessionSpan): TagSummary | undefined => {
  const turns = records.filter(isTurn)
    .filter((r) => r.target === role && !isGhostTurn(r, now) && inSpan(span)(r.createdAt))
    .sort((a, b) => a.createdAt - b.createdAt);
  return turns.length ? summarizeTag(role, turns, now) : undefined;
};
