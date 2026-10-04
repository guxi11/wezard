// Chat-level derivations over the detail store — pure, no IO.
//
// A WeCom chat hosts one default session plus any number of `#tag` siblings
// (see session-label). The store already stamps every turn with its `target`
// (`chat:xxx#fix`), so "what does this chat look like right now" is a fold over
// the turn records sharing a base principal: group by target → a chat list,
// order one group by time → a thread, sum the usages → a status bar.
//
// Nothing here touches tmux or the mirror bridge, so the standalone svr derives
// exactly the same view from the records that were POSTed to it.
import { baseOfKey, labelFor, tagOfKey } from "./session-label.js";
import type { DetailRecord, MarkDetailRecord, PostDetailRecord, TurnDetailRecord, TurnOrigin, TurnUsage } from "./detail-store.js";
import { costOf, modelLabel, priceOf, type Price, type Tokens } from "./pricing.js";

/** 账单的一行: 一个模型 (同一显示名、同一单价) 的 token 合计 × 单价 = 它的那份费用。
 *  price 缺 = 价格表里认不出, 这几次调用没计进 cost。cost 是逐轮 costOf 的和, 与总账同源。 */
export interface BillRow extends Tokens {
  model: string;
  label: string;
  price?: Price;
  calls: number;
  cost: number;
}

export interface AggUsage extends TurnUsage {
  /** 此刻的上下文: 最近一轮主会话 (子 agent 有自己的窗口, 不算) 最后一次调用送入的
   *  input + 缓存。是现状, 不是峰值 —— compact / clear 之后峰值就过时了。 */
  ctx: number;
  /** 估算费用 (USD): 每轮按它的模型单价算, 再加总。 */
  cost: number;
  /** 模型在价格表里认不出的那几轮的 API 调用数 —— 这部分没计进 cost。 */
  unpriced: number;
  turns: number;
  tools: number;
  /** cost 的计算过程: 按模型分行, 子 agent 的轮次按它自己的模型并进来。 */
  bill: BillRow[];
}

const ZERO: AggUsage = {
  input: 0, output: 0, cacheRead: 0, cacheWrite: 0, calls: 0,
  ctx: 0, cost: 0, unpriced: 0, turns: 0, tools: 0, bill: [],
};

export interface TagSummary {
  target: string;
  /** `#tag` suffix; "" for the chat's default session. */
  tag: string;
  /** Stable animal emoji, keyed on the tag string (survives /clear). */
  label: string;
  sessionId?: string;
  /** 最近一轮记到的工作目录 —— 同一 chat 的兄弟会话可以各跑各的 cwd。 */
  cwd?: string;
  model?: string;
  /** 给人看的模型简名 (modelLabel): 前端不另做归一。 */
  modelLabel?: string;
  /** 主会话最近一轮 CLI 记下的 effort 档位; 没记过就没有 —— 不猜默认。 */
  effort?: string;
  turns: number;
  lastTs: number;
  running: boolean;
  /** Wall-clock at which `running` decays to false with no further writes —
   *  lets the client expire the badge on its own timer (see staleAt). */
  runningUntil: number;
  /** One-line "what happened last", for the chat-list row. */
  preview: string;
  /** Most recent graph attribution seen on this session — present iff some
   *  turn of it was injected by a run (i.e. this tag is graph-driven). */
  origin?: TurnOrigin;
  usage: AggUsage;
}

/** One graph run, reconstructed from the turns it stamped. Nothing here comes
 *  from graph.ts's in-memory run table — this view has to survive a reload and
 *  work identically on the standalone svr, which never sees a runner at all. */
export interface GraphStepView {
  step: number;
  tag: string;
  /** 该步最近一次被走到的时间, 用来定位"当前停在哪一步"。 */
  ts: number;
}

export interface GraphSummary {
  runId: string;
  rounds: number;
  steps: number;
  /** Latest round/step observed = 走到哪了。 */
  round: number;
  step: number;
  /** Step order recovered from the observed turns; 缺步 = 还没走到过。 */
  pipeline: GraphStepView[];
  startedAt: number;
  lastTs: number;
  running: boolean;
  /** 同 TagSummary.runningUntil: 无新写入时到这个时刻自动算结束, 由客户端自行
   *  熄灯。SSE 只在有写入时推送 —— run 一旦真的停下就再没有事件, 没有它页面上的
   *  「⟳ 运行中」永远熄不掉。0 = 已结束。 */
  runningUntil: number;
}

export interface ChatSummary {
  base: string;
  /** Server clock when this snapshot was derived — the client ticks off it. */
  at: number;
  tags: TagSummary[];
  /** Graph runs touching this chat, most recently active first. */
  graphs: GraphSummary[];
  usage: AggUsage;
}

// ── turn 结束判定 ─────────────────────────────────────────────────────
// 三种证据, 由强到弱: closed (收口信号) → final text (closeTurn 可能滞后, 但
// final 就是最后一条) → 静默超时。第三条是唯一的兜底: daemon 重启 / 漏收
// turn_end 会把 turn 永久留在 open 态, 侧栏于是永远「运行中」, 而页脚耗时
// (open turn 的 span 按 now 算) 会一路累加到几十小时。
//
// 静默阈值分两档, 因为"没有新 item"有两种截然不同的含义:
//   • 尾项是已闭合的文本/工具结果 → agent 真的停了, 2 分钟足够;
//   • 尾项是未回的 tool_use 或未决的 approval → 它在**等**, 一次 build 或一次
//     人工点按可以耗掉很久, 按短档判死会让页面在任务跑到一半时变「已完成」。
const IDLE_MS = 120_000;
const IDLE_AWAIT_MS = 3600_000;

const lastItemOf = (r: TurnDetailRecord): TurnDetailRecord["items"][number] | undefined =>
  r.items.reduce<TurnDetailRecord["items"][number] | undefined>(
    (m, it) => (!m || it.ts >= m.ts ? it : m),
    undefined,
  );

/** 尾项还挂着未回的工具 / 未决的审批 —— 静默是「在等」, 不是「结束了」。 */
const awaitingReply = (r: TurnDetailRecord): boolean => {
  const last = lastItemOf(r);
  if (!last) return false;
  if (last.t === "approval") return last.decision === undefined;
  if (last.t === "tool_use") {
    return !r.items.some((it) => it.t === "tool_result" && it.toolUseId === last.toolUseId);
  }
  return false;
};

/** 该 turn 若再无写入, 到这个时刻就算结束。0 = 已经结束。 */
export const staleAt = (r: TurnDetailRecord): number =>
  r.closed || r.items.some((it) => it.t === "text" && it.final === true)
    ? 0
    : r.updatedAt + (awaitingReply(r) ? IDLE_AWAIT_MS : IDLE_MS);

export const turnDone = (r: TurnDetailRecord, now: number): boolean => {
  const until = staleAt(r);
  return until === 0 || now > until;
};

/** 空壳 turn: 记录建了, 但一条 item、一次 usage 都没落地 —— ack 之后队列被强关 /
 *  daemon 重启 / 注入失败都会留下它。刚建的几秒内是正常的 ack 态, 过了静默期就是
 *  垃圾: 计进轮数与耗时只会污染统计, 渲染出来是个空的 turn 分组。 */
export const isGhostTurn = (r: TurnDetailRecord, now: number): boolean =>
  r.items.length === 0 && !r.usage && now - r.updatedAt > IDLE_MS;

// 老记录没有 ctxLast: 退到这一轮的峰值 (多次调用的累计和不是任何一次的上下文)。
const lastCtx = (u: TurnUsage): number => u.ctxLast ?? u.ctxPeak ?? u.input + u.cacheRead + u.cacheWrite;

const ctxNow = (turns: readonly TurnDetailRecord[]): number => {
  const last = turns
    .filter((r) => !r.agent && r.usage)
    .reduce<TurnDetailRecord | undefined>((a, r) => (!a || r.createdAt >= a.createdAt ? r : a), undefined);
  return last?.usage ? lastCtx(last.usage) : 0;
};

// 同一显示名 + 同一单价并成一行 (claude-opus-5-5 与 claude-opus-5-5[1m] 是一个模型)。
const billKey = (label: string, p: Price | undefined): string => `${label}|${p ? [p.in, p.out, p.cacheWrite, p.cacheRead].join() : ""}`;

const addBill = (bill: readonly BillRow[], model: string, p: Price | undefined, u: TurnUsage, cost: number): BillRow[] => {
  const label = model ? modelLabel(model) : "未知模型";
  const k = billKey(label, p);
  const cur = bill.find((b) => billKey(b.label, b.price) === k);
  const row: BillRow = cur
    ? { ...cur, input: cur.input + u.input, output: cur.output + u.output, cacheRead: cur.cacheRead + u.cacheRead,
        cacheWrite: cur.cacheWrite + u.cacheWrite, calls: cur.calls + u.calls, cost: cur.cost + cost }
    : { model, label, price: p, input: u.input, output: u.output, cacheRead: u.cacheRead, cacheWrite: u.cacheWrite, calls: u.calls, cost };
  return cur ? bill.map((b) => (b === cur ? row : b)) : [...bill, row];
};

const addUsage = (a: AggUsage, r: TurnDetailRecord, now: number): AggUsage => {
  const u = r.usage;
  const p = u && priceOf(r.model);
  const cost = u && p ? costOf(p, u) : 0;
  return {
    input: a.input + (u?.input ?? 0),
    output: a.output + (u?.output ?? 0),
    cacheRead: a.cacheRead + (u?.cacheRead ?? 0),
    cacheWrite: a.cacheWrite + (u?.cacheWrite ?? 0),
    calls: a.calls + (u?.calls ?? 0),
    serviceTier: a.serviceTier ?? u?.serviceTier,
    ctx: a.ctx,
    cost: a.cost + cost,
    unpriced: a.unpriced + (u && !p ? u.calls : 0),
    turns: a.turns + 1,
    tools: a.tools + r.items.filter((it) => it.t === "tool_use").length,
    bill: u ? addBill(a.bill, r.model ?? "", p || undefined, u, cost) : a.bill,
  };
};

export const aggregate = (turns: readonly TurnDetailRecord[], now: number): AggUsage =>
  ({ ...turns.reduce((a, r) => addUsage(a, r, now), ZERO), ctx: ctxNow(turns) });

const stripMd = (s: string): string => s.replace(/[`*_~|#>]/g, "").replace(/\s+/g, " ").trim();

/** Last assistant prose of a turn, else the query that opened it. */
const previewOf = (r: TurnDetailRecord): string => {
  const texts = r.items.filter((it): it is Extract<typeof it, { t: "text" }> => it.t === "text");
  const last = texts[texts.length - 1]?.body ?? "";
  const src = last || r.userQuery || "";
  return stripMd(src).slice(0, 120);
};

// ── keepalive 心跳 ────────────────────────────────────────────────────
// 保温 ping 记成了一轮 (那份花销是真的), 但它不是对话: 挂机一晚能攒出几十轮
// ping/pong, 在时间轴上与真实对话等宽排开, 说过的话就被挤出了屏幕。标出来,
// 让视图把连续的几轮折成一行 (见 web/chat.js 的 foldPings)。识别在 shared/keepalive.ts。

export const isTurn = (r: DetailRecord): r is TurnDetailRecord => r.kind === "turn";

export const isMark = (r: DetailRecord): r is MarkDetailRecord => r.kind === "mark";

export const isPost = (r: DetailRecord): r is PostDetailRecord => r.kind === "post";

/** Real turns of one chat — every ghost dropped exactly once, up front, so the
 *  list / thread / status bar can never disagree about what counts. */
const liveTurns = (records: readonly DetailRecord[], now: number): TurnDetailRecord[] =>
  records.filter(isTurn).filter((r) => !isGhostTurn(r, now));

/** Turns of one session key, oldest first — the thread order. */
export const threadOf = (records: readonly DetailRecord[], target: string, now: number): TurnDetailRecord[] =>
  liveTurns(records, now).filter((r) => r.target === target).sort((a, b) => a.createdAt - b.createdAt);

/** 线程的一格: 一轮对话 (子 agent 轮内联在它的时间轴里), 或一道上下文断点。 */
export type ThreadEntry =
  | { kind: "turn"; turn: TurnDetailRecord; children: TurnDetailRecord[] }
  | { kind: "mark"; mark: MarkDetailRecord };

const entryTs = (e: ThreadEntry): number => (e.kind === "turn" ? e.turn.createdAt : e.mark.createdAt);

/** 线程视图的完整序列: 断点标记 + 顶层 turn, 按时间排序。子 agent 的 turn 不占
 *  顶层位置 —— 它归到派它出去的那一轮名下 (父轮不在本线程时才退回顶层, 否则内容
 *  会整段消失)。 */
export const threadEntries = (records: readonly DetailRecord[], target: string, now: number): ThreadEntry[] => {
  const turns = threadOf(records, target, now);
  const ids = new Set(turns.map((r) => r.id));
  const parentOf = (r: TurnDetailRecord): string | undefined => {
    const p = r.agent?.parentTurnId;
    return p && ids.has(p) ? p : undefined;
  };
  const byParent = turns.reduce((m, r) => {
    const p = parentOf(r);
    return p ? m.set(p, [...(m.get(p) ?? []), r]) : m;
  }, new Map<string, TurnDetailRecord[]>());
  const marks = records.filter(isMark).filter((r) => r.target === target);
  return [
    ...turns.filter((r) => !parentOf(r)).map((turn): ThreadEntry => ({ kind: "turn", turn, children: byParent.get(turn.id) ?? [] })),
    ...marks.map((mark): ThreadEntry => ({ kind: "mark", mark })),
  ].sort((a, b) => entryTs(a) - entryTs(b));
};

export const summarizeTag = (target: string, turns: readonly TurnDetailRecord[], now: number): TagSummary => {
  // 子 agent 的一轮不是"一轮对话" —— 它内联在派它的那一轮里 (见 threadEntries),
  // 所以轮数与预览都只看主会话自己的轮次; token/工具用量仍按全部计 (那是真花销)。
  const main = turns.filter((r) => !r.agent);
  const last = main[main.length - 1] ?? turns[turns.length - 1];
  const tag = tagOfKey(target);
  const until = turns.reduce((m, r) => Math.max(m, staleAt(r)), 0);
  return {
    target,
    tag,
    label: labelFor(tag || target),
    sessionId: last?.sessionId,
    cwd: [...turns].reverse().find((r) => r.cwd)?.cwd,
    model: [...turns].reverse().find((r) => r.model)?.model,
    modelLabel: ((m) => m && modelLabel(m))([...turns].reverse().find((r) => r.model)?.model),
    effort: [...main].reverse().find((r) => r.effort)?.effort,
    turns: main.length,
    lastTs: turns.reduce((m, r) => Math.max(m, r.updatedAt), 0),
    running: until > now,
    runningUntil: until > now ? until : 0,
    preview: last ? previewOf(last) : "",
    origin: [...turns].reverse().find((r) => r.origin)?.origin,
    usage: aggregate(turns, now),
  };
};

// ── Graph runs ────────────────────────────────────────────────────────
// 一个 run 的 pipeline 不存在任何一条记录里 —— 它散在这个 run 派出的每条 turn 的
// origin 上 (各自带着 round/step/tag)。按 step 归并就把步骤序列还原了出来, 无需
// 把整张 spec 逐轮冗余进 detail 存储。
const summarizeRun = (turns: readonly TurnDetailRecord[], now: number): GraphSummary => {
  const os = turns.map((r) => ({ o: r.origin!, r }));
  const head = os[os.length - 1]!;
  const until = turns.reduce((m, r) => Math.max(m, staleAt(r)), 0);
  const byStep = os.reduce((m, { o, r }) => {
    const cur = m.get(o.step);
    return cur && cur.ts >= r.createdAt ? m : m.set(o.step, { step: o.step, tag: tagOfKey(r.target), ts: r.createdAt });
  }, new Map<number, GraphStepView>());
  return {
    runId: head.o.runId,
    rounds: head.o.rounds,
    steps: head.o.steps,
    round: head.o.round,
    step: head.o.step,
    pipeline: [...byStep.values()].sort((a, b) => a.step - b.step),
    startedAt: os[0]!.r.createdAt,
    lastTs: turns.reduce((m, r) => Math.max(m, r.updatedAt), 0),
    running: until > now,
    runningUntil: until > now ? until : 0,
  };
};

/** Group this chat's graph-stamped turns by runId → one summary per run. */
export const graphSummaries = (turns: readonly TurnDetailRecord[], now: number): GraphSummary[] => {
  const byRun = turns
    .filter((r) => r.origin)
    .sort((a, b) => a.createdAt - b.createdAt)
    .reduce((m, r) => m.set(r.origin!.runId, [...(m.get(r.origin!.runId) ?? []), r]), new Map<string, TurnDetailRecord[]>());
  return [...byRun.values()].map((rs) => summarizeRun(rs, now)).sort((a, b) => b.lastTs - a.lastTs);
};

/** Group every turn of one chat by session key → the chat list. Most recently
 *  active tag first; the running ones naturally float up. */
export const chatSummary = (records: readonly DetailRecord[], base: string, now: number): ChatSummary => {
  const mine = liveTurns(records, now).filter((r) => r.target && baseOfKey(r.target) === base);
  const byTarget = mine.reduce((m, r) => {
    const k = r.target!;
    return m.set(k, [...(m.get(k) ?? []), r]);
  }, new Map<string, TurnDetailRecord[]>());
  const tags = [...byTarget.entries()]
    .map(([target, turns]) => summarizeTag(target, [...turns].sort((a, b) => a.createdAt - b.createdAt), now))
    .sort((a, b) => b.lastTs - a.lastTs);
  return { base, at: now, tags, graphs: graphSummaries(mine, now), usage: aggregate(mine, now) };
};
