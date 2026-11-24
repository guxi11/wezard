// Rolepage 的名录 / 会话分段 / 消息折叠 —— 纯函数, 无 IO。
//
// 两套数据各有各的位置, 谁也不是谁的替代品:
//   • room 账本是「说了什么」: 一行一条, 出处 / 完成 / 发言权都写在行上 (shared/room-view);
//   • turn 记录是「怎么做的」: 一轮的工具调用、CLI 原话、用量只在轮次里 (detail-store)。
// wizard 详情以轮次为主干 —— 一轮拆成入 (问的那句) 与出 (这一轮的回复), 出那一侧由
// role-render 画成气泡 + 过程框; 账本行挂在产出它的那一轮上, 没有对应轮次的仍独立成行。
//
// 本文件的折叠口径: 会话分段 (sessionsOf / marksOf)、消息折叠 (allMessages / messagesOfTurn)、
// 名录 (makeDirectory / roleInfo / roleStats)。
//
// role id: wizard 就是它的 target key; 人是 human:<userid>; 定时任务是 task:<id>。
import { baseOfKey, labelFor, rawTagHeader, stripSigil, tagOfKey } from "./session-label.js";
import { isGhostTurn, isMark, isPost, isTurn, staleAt, summarizeTag, type TagSummary } from "./chat-view.js";
import type { Asker, DetailRecord, MarkDetailRecord, PostDetailRecord, TurnDetailRecord } from "./detail-store.js";
import type { WorldFacts, WorldFactWeixin, WorldFactWizard } from "./world.js";

export type RoleKind = "wizard" | "human" | "task";

export const SYSTEM = "system:";

/** `user:<id>` (speaker / 单聊 base) → 人的 role id。 */
export const humanOf = (principal: string): string => "human:" + principal.replace(/^user:/, "").replace(/#.*$/, "");

// ── 消息折叠 (一轮 → 入 + 出) ────────────────────────────────────────
// 一轮 turn 拆成两条消息:
//   入  发话方 → 该 wizard     userQuery
//   出  该 wizard → 发话方     本轮的回复 (文本 + 工具细节)
// 发话方: 同伴 (from.kind=peer) / 定时任务 (task) / 人 (speaker; 认不出是谁就归
// 系统 wezard —— 不另立一个「未知」role)。消息落在哪个会话由 channel 决定。
export interface Msg {
  /** `<turnId>:in` / `<turnId>:out`。 */
  id: string;
  turn: TurnDetailRecord;
  dir: "in" | "out";
  from: string;
  to: string;
  /** 公开频道的 base; "" = wizard 之间的私聊。 */
  channel: string;
  ts: number;
}

/** 见 TurnDetailRecord.channel: 老记录按 from 推 —— peer 私聊, 其余在 home。 */
export const channelOf = (r: TurnDetailRecord): string =>
  r.channel !== undefined
    ? r.channel
    : r.from?.kind === "peer" && !r.from.public
      ? ""
      : baseOfKey(r.target ?? "");

const MATE_RE = /^\s*<teammate-message\b([^>]*)>/;
/** 这句是不是 agent team 队友递进来的; 是就给出它的 teammate_id ("" = 没标)。 */
export const teammateOf = (q: string | undefined): string | undefined => {
  const attrs = q?.match(MATE_RE)?.[1];
  return attrs === undefined ? undefined : attrs.match(/\bteammate_id="([^"]*)"/)?.[1] ?? "";
};
/** 去掉 `<teammate-message …>` 包装, 只留它说的话。 */
export const unwrapMates = (q: string): string =>
  q.replace(/<teammate-message\b[^>]*>\s*/g, "").replace(/\s*<\/teammate-message>/g, "");

export const senderOf = (r: TurnDetailRecord): string => {
  if (r.from?.kind === "peer") return r.from.from || SYSTEM;
  if (r.from?.kind === "task") return `task:${r.from.taskId || "?"}`;
  // 先于 speaker: 队友的话落进来时, 频道上挂着的可能还是上一句人话的 speaker。
  if (teammateOf(r.userQuery) !== undefined) return SYSTEM;
  if (r.speaker) return humanOf(r.speaker);
  const ch = channelOf(r);
  // 与人的单聊里发话的只可能是那个人。
  return ch.startsWith("user:") ? humanOf(ch) : SYSTEM;
};

/** 一个公开频道里听话的那一方: 与人的单聊是那个人; 群里是这条链的链头 (守护进程写 turn
 *  时顺着派活链记下的, 见 Asker) —— 只在他正是在这个群里开的口时才算; 认不出就是
 *  系统 wezard, 不拿群里别的开口的人去猜: 一个 wizard 可能同时在答好几个人。 */
export const audienceOf = (channel: string, asker: Asker | undefined): string =>
  channel.startsWith("user:") ? humanOf(channel) : asker?.chat === channel ? humanOf(asker.who) : SYSTEM;

/** 回执轮: 守护进程把同伴那一轮的终句原样转进发话方的会话。 */
const isReceipt = (r: TurnDetailRecord): boolean => r.from?.kind === "peer" && r.from.receipt === true;

/** 重影判定, 按 records 快照记一次:
 *  injects  忙时插队的一句有时被记了两次: 先在跑着的那轮里记成插话, 随后同一句话又真开了
 *           一轮 —— 插话那条是重影, 不画。按 (主人, 规范正文) 认。
 *  splitIns 同一次投递 (同一 eventId) 在 reload / 重挂后被切成几段轮次记录, 开头那句在每段
 *           上重印了一遍 —— 入消息只留最早那段的。 */
export interface EchoIndex { injects: Map<string, string[]>; splitIns: Set<string> }
const ECHOES = new WeakMap<readonly DetailRecord[], EchoIndex>();
export const injectEchoesOf = (records: readonly DetailRecord[]): EchoIndex => {
  const hit = ECHOES.get(records);
  if (hit) return hit;
  const norm = (s: string | undefined): string => (s ?? "").replace(/\s+/g, " ").trim();
  const injects = new Map<string, string[]>();
  const byEvent = new Map<string, TurnDetailRecord[]>();
  for (const t of records.filter(isTurn)) {
    if (t.id.includes("~")) continue;
    if (t.userQuery?.trim())
      injects.set(t.target ?? "", [...(injects.get(t.target ?? "") ?? []), norm(t.userQuery)]);
    if (t.eventId)
      byEvent.set(`${t.sessionId}\0${t.eventId}`, [...(byEvent.get(`${t.sessionId}\0${t.eventId}`) ?? []), t]);
  }
  const splitIns = new Set<string>();
  for (const group of byEvent.values())
    if (group.length > 1)
      for (const t of group.slice().sort((a, b) => a.createdAt - b.createdAt).slice(1)) splitIns.add(t.id);
  const v = { injects, splitIns };
  ECHOES.set(records, v);
  return v;
};
const isEcho = (echoes: EchoIndex, t: TurnDetailRecord): boolean => {
  const body = (t.userQuery ?? "").replace(/\s+/g, " ").trim();
  return body.length >= 8 && (echoes.injects.get(t.target ?? "") ?? []).some((q) => q.includes(body) || (q.length >= 8 && body.includes(q)));
};

/** 一轮里的插话 → 各自一个只有问话的轮次外形 (id `<轮>~<序号>`): 出处、频道、发话人都是它
 *  自己的, 不随被插的那一轮。它没有自己的回复 —— 回复在被插的那一轮的出消息里。 */
export const injectTurnsOf = (r: TurnDetailRecord): TurnDetailRecord[] =>
  (r.injects ?? []).map((x, i) => ({
    kind: "turn", id: `${r.id}~${i}`, createdAt: x.ts, updatedAt: x.ts, closed: true, items: [],
    target: r.target, sessionId: r.sessionId, userQuery: x.body, channel: x.channel,
    ...(x.from ? { from: x.from } : {}), ...(x.speaker ? { speaker: x.speaker } : {}),
  }));

/** 实发的正文: 群里那条消息头上的「🧙 name：」署名剥掉 —— rolepage 的消息行已经写着是谁说的。 */
export const postBody = (p: PostDetailRecord): string => rawTagHeader(p.body)?.body ?? p.body;

/** 顶层会话里的轮次: 去空壳、去子 agent (它内联在父轮里)。 */
const convTurns = (records: readonly DetailRecord[], now: number): TurnDetailRecord[] =>
  records.filter(isTurn).filter((r) => !!r.target && !r.agent && !isGhostTurn(r, now));

/** 一轮 → 入/出两条消息。没问话的 (/clear 之后的续跑) 只有出; 还没产出也没在跑
 *  的只有入。回执轮例外: 入那一句就是同伴自己那一轮的出 (同一段话), 没有入。 */
export const messagesOfTurn = (r0: TurnDetailRecord, echoes?: EchoIndex): Msg[] => {
  const r = r0;
  const w = r.target!;
  const who = senderOf(r);
  const channel = channelOf(r);
  const receipt = isReceipt(r);
  const to = receipt && channel ? audienceOf(channel, r.from?.asker) : who;
  const firstOut = r.items.reduce((m, it) => Math.min(m, it.ts), Infinity);
  const inMsg: Msg[] = r.userQuery?.trim() && !receipt && !echoes?.splitIns.has(r.id)
    ? [{ id: `${r.id}:in`, turn: r, dir: "in", from: who, to: w, channel, ts: r.createdAt }]
    : [];
  const outMsg: Msg[] = r.items.length > 0 || !r.closed
    ? [{ id: `${r.id}:out`, turn: r, dir: "out", from: w, to, channel, ts: Math.max(r.createdAt + 1, Number.isFinite(firstOut) ? firstOut : r.createdAt + 1) }]
    : [];
  const injected: Msg[] = injectTurnsOf(r)
    .filter((t) => !echoes || !isEcho(echoes, t))
    .map((t) => ({ id: `${t.id}:in`, turn: t, dir: "in", from: senderOf(t), to: w, channel: t.channel ?? "", ts: t.createdAt }));
  return [...inMsg, ...outMsg, ...injected];
};

/** notify 贴进群的一段话 → 发话 wizard 在那个频道里的一条出消息, 对着那里的人说。
 *  装进一个已收口、只有一段终句的轮次外形, 渲染与未读水位都照出消息的老规矩走。 */
export const messageOfPost = (p: PostDetailRecord): Msg => ({
  id: `${p.id}:out`,
  turn: {
    kind: "turn", id: p.id, createdAt: p.createdAt, updatedAt: p.createdAt, closed: true,
    target: p.target, channel: p.channel, items: [{ t: "text", body: postBody(p), ts: p.createdAt, final: true }],
  },
  dir: "out",
  from: p.target,
  to: audienceOf(p.channel, p.asker),
  channel: p.channel,
  ts: p.createdAt,
});

/** 全部消息 (轮次折叠出来的 + notify 贴进来的), 按时间合并。
 *  实例之间不做任何改写: 同身份的两个实例 (wezard-1 / wezard-15) 的 from/to 各是各的 ——
 *  人 2026-11-22 拍板, 同类实例是独立节点、独立会话页, 不混杂。 */
export const allMessages = (records: readonly DetailRecord[], now: number): Msg[] => {
  const echoes = injectEchoesOf(records);
  return [...convTurns(records, now).flatMap((r) => messagesOfTurn(r, echoes)), ...records.filter(isPost).map(messageOfPost)]
    .sort((a, b) => a.ts - b.ts);
};

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
    id.startsWith("task:") ? "⏰" : id === SYSTEM ? "🧙" : wizards.has(id) ? labelFor(nameOf(id)) : "👤";
  // 地址 = 一个实例的 target, 按 target 或名字解析到它自己。同身份的多个实例各是各的页
  // (人 2026-11-22 拍板): 不选代表、不改写 —— 之前「同身份收敛到一个规范 target」会让
  // 点 wezard-15 落到 wezard-1 的页面上。
  const byName = new Map([...wizards].map((t) => [fold(nameOf(t)), t] as const));
  const resolve = (ref: string): string | undefined => {
    const r = (ref ?? "").trim();
    if (!r) return undefined;
    if (wizards.has(r)) return r;
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
      (m, r) => (r.target ? m.set(r.target, Math.max(m.get(r.target) ?? 0, staleAt(r))) : m),
      new Map<string, number>(),
    )).get(id) ?? 0;
  // 状态只看这一个实例自己的事实: 另一个实例活着不代表它活着 (同身份不合并)。
  const status = (id: string, now: number): RoleStatus | undefined => {
    if (!wizards.has(id)) return undefined;
    const f = facts_.get(id);
    const t = untilOf(id);
    const waiting = f?.waiting ?? [];
    return { alive: !!f?.alive, busy: !!f?.busy, runningUntil: t > now ? t : 0,
      ...(waiting.length ? { waiting: [...waiting] } : {}) };
  };
  const wx = new Map((facts.weixin ?? []).map((w) => [w.base, w] as const));
  return { nameOf, labelOf, resolve, fact: (id) => facts_.get(id), chatName, weixin: (base) => wx.get(base), isWizard: (id) => wizards.has(id), status, wizards: () => [...wizards] };
};

// ── 微信通道 ─────────────────────────────────────────────────────────

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

/** 下拉的取值: sessionId 缺失的那一段没有 sid 可当 value (空串会被当成「全部」), 改用起始时刻。 */
export const spanKey = (s: Pick<SessionSpan, "sessionId" | "start">): string => s.sessionId || "start:" + s.start;

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
  /** home 聊天的名字 (wizard target key 的 base principal 那个聊天 = 它的主群; 不是 creator —— creator 在 parent)。 */
  chat: string;
  /** home 聊天的 id (base principal); 前端拿它在 room 列表里取显示名。非 wizard = ""。 */
  chatId: string;
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
    chatId: wiz ? baseOfKey(id) : "",
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
