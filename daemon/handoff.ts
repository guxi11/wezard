// 交接 (handoff): 一个 wizard 把工作压成简报, 换一个全新的上下文接着干 —— 同一个 target
// 与名字。普通交接沿用 pane/CLI 并原生 /clear; 有 pending workspace 时启动新 CLI 进程。
//
// 身份、plans、日程、名册信箱都挂在 target / 名字上, 换会话碰不到它们; 会断的是那些
// 隐含着「这个会话」的东西:
//   - 回执的**答方**: 欠着别人的那一句, 换了会话旧 transcript 就读不到了 —— 义务得跟着
//     简报转进新会话, 而不是把简报那一轮的回复错当成回执;
//   - 回执的**发方**与一切注入: 重开的那几秒 pane 是死的, 此刻投进来的话要么被当成
//     "发话方已经不在"丢掉, 要么 resume 回旧 sid, 要么抢在简报前面成了新会话的开场白;
//   - 交接本身: reload 落在「清空了旧上下文、还没贴回简报」
//     之间, 新会话就空着醒来, 简报没了。
// 所以这里做三件事: 交接期间立一道闸 (`handingOff` / `handedOff`), 闸内一切注入都等;
// 简报贴回新会话, 然后**按路由表**把它交接前还欠着、还没交代的那几笔一笔一轮地
// 「继续 `<event>`」(T8 起; 从前是 receipts.transfer 在旧会话还在那一刻清点答案 ——
// 那条路要把答案钉在旧 transcript 上, 换会话就断, 欠账反倒没了下文)。
// 每一步落盘, boot 时从断点接着做。
//
// 自我交接是「调用即受理」(2026-10-28 重构): 请求合理 (简报能生成) 就立刻返回, daemon 自己
// 排期 —— pane 忙就先给这一轮一个短窗自然收口, 到点 Esc 打断直接交接 (2026-11-12: 回执本就
// 跨交接有效 —— 欠账由路由表兜着、终句由 cut 扣着、闸内的注入等在新会话, 没必要等轮终),
// 已有一场正在执行就排队到它之后再做一次,
// 残余的失败记录不参与 self 的准入。人拿到的永远是「已受理」, 不是「这次交接在等什么/为什么
// 失败」。交接别人仍走同步等待 + 失败记录准入 (调用方在场, 记录挡的是对半清会话的二次清空)。
import type { Logger } from "pino";
import type { JsonMap } from "../shared/json-map-store.js";
import { sleep, truncate } from "../shared/std.js";
import { waitForIdle, type IdleOpts, type IdleResult } from "./wait-idle.js";
import type { EventId } from "./router.js";

// ── 闸 ──────────────────────────────────────────────────────────────
// 进程级的单例: 人话的入口 (inbound) 在 mirror 块之前就装好了, 拿不到这里的实例。
const gates = new Map<string, Promise<void>>();

/** 这个 wizard 正在交接。 */
export const handingOff = (target: string): boolean => gates.has(target);

/** 自我交接从发起到旧会话被重开之前: 它手上这一轮是被交接切断的 —— 收尾那句 (「已交接」/ 抢答)
 *  不是它欠着的那几笔的答案, 那几笔由新会话里的「继续 <event>」逐笔续答 (见 resumeOwed)。 */
const cutting = new Set<string>();
export const cuttingTurn = (target: string): boolean => cutting.has(target);

/** 等它交接完; 没在交接就立刻返回。一次交接收尾后紧接着又开了一次, 接着等。 */
export const handedOff = async (target: string): Promise<void> => {
  for (let g = gates.get(target); g; g = gates.get(target)) await g;
};

const hold = (target: string): (() => void) => {
  let open!: () => void;
  const g = new Promise<void>((r) => (open = r));
  gates.set(target, g);
  return () => {
    if (gates.get(target) === g) gates.delete(target);
    open();
  };
};

// ── 一次交接 ────────────────────────────────────────────────────────

export interface ClearAttempt {
  pane: string;
  pid: number;
  panePid?: number;
  /** Stable identity persisted before a workspace replacement process is spawned. */
  spawnSid?: string;
  nextSid?: string;
  sid: string;
  at: number;
  /** Destination applied by a handoff-created fresh CLI, retained for reload recovery. */
  workspaceCwd?: string;
}

export interface Pending {
  target: string;
  /** self = 简报由它自己写在入参里; other = 守护进程让它写。 */
  mode: "self" | "other";
  /** 发起交接的时刻 —— 自我交接时, 在它之前就收口的那一轮才算旧会话答过; 也是这一场交接的
   *  代数 (欠账续答的注入幂等 id 按它区分: 同一场重放同一条, 换一场才配新的)。 */
  at: number;
  /** 交接前的 sid: reload 后据它分辨「重开」做没做完。 */
  sid: string;
  /** waiting: self = 已受理, 排队等它这一轮说完 (无超时失败) · other = 等它停下 · briefing:
   *  已请它写简报 (other) · restarting: 正在重开 (已不再清点回执, 欠账由路由表兜着) · restarted:
   *  新会话已起, 待贴回简报 · resuming: 简报已贴回, 正逐笔续答它还欠着的那些 (reload 落在这里
   *  就重放一次, 注入幂等不会重复催)。 */
  stage: "waiting" | "briefing" | "restarting" | "restarted" | "resuming";
  brief?: string;
  focus?: string;
  /** 自我交接那一刻它这一轮的频道 ("" = 私聊): 重开后「接着干」那一轮还在答同一件 ask,
   *  终句回同一处。交接别人时它是闲着的, 没有在答的 ask —— "". */
  channel?: string;
  /** 重开时往家里群发「📂 当前项目」气泡 —— 换工作区 (set_workspace) 给人的回执;
   *  普通交接是生命周期事件, 静默。 */
  announce?: boolean;
  timeoutMs: number;
  /** 自我交接切断的那一轮里被扣下没落定的终句 (注入事件 id): 交接做成了由新会话「继续 <event>」
   *  续答, 用不着它们; 交接没做成就得按原行补投回去, 否则那几笔再没人交代。 */
  cut?: string[];
  /** 已受理、排在当前这场之后执行的 self 交接 (调用即受理: 正在执行时新请求排队, 不拒绝)。
   *  开工时与旧记录的 cut、当时的前沿事件合并成新一场的 cut。 */
  queued?: { brief: string; at: number; cut?: string[] }[];
  clear?: ClearAttempt;
  failure?: { status: number; reason: string; compensated?: boolean };
}

export interface HandoffDeps {
  isBusy: (target: string) => Promise<boolean>;
  currentEvents?: (target: string) => readonly string[];
  suppress?: (events: readonly string[]) => void;
  sessionId: (target: string) => string;
  /** 原生清空, 或在有 pending workspace 时启动新 CLI; 重启动作凭证须先落盘。 */
  restart: (target: string, p: Pending, submitted: (attempt: ClearAttempt) => void) => Promise<{ ok: boolean; reason?: string }>;
  /** 往会话里贴一段话; 这一轮的频道是 `channel` ("" = 私聊)。简报那一句不挂任何信封 ——
   *  它不服务任何一笔, 回执不会误落到它上面。 */
  inject: (target: string, text: string, channel: string, id: string, timeoutMs: number, clear?: ClearAttempt) => Promise<{ ok: boolean; reason?: string }>;
  /** 它此刻这一轮的频道 ("" = 私聊)。 */
  channelOf: (target: string) => string;
  lastText: (target: string) => string;
  summary: (id: string) => string | undefined;
  /** 交接前它欠着、还没交代的那几笔 (路由表 `owedBy(W)` 里 status 仍 open 的, 见 §9.5)。 */
  owed: (target: string) => readonly EventId[];
  /** 让它接着干那一笔: 注入「继续 `<event>`」, 该轮的终句因此落到那一行上, 回执照常闭合。
   *  `at` = 这一场交接的起点 —— 同一场重放用同一条注入 (幂等), 换一场才配新的。 */
  resume: (target: string, event: EventId, at: number) => Promise<{ ok: boolean; reason?: string }>;
  /** 交接没做成时告诉**它自己** (下一条进它会话的话尾巴上捎带)。生命周期事件不进群。 */
  notify: (target: string, text: string) => void;
  /** 交接没做成: 切断那一轮扣下的终句 (注入事件 id) 按原行补投。 */
  uncut: (target: string, events: readonly string[]) => void;
  log: Logger;
  store?: JsonMap<Pending>;
  /** self 等待的节拍 (测试注入用): 自然收口窗/打断后静置窗 / grace 每片等多久 / idle 判定的 ramp 与 confirm。 */
  selfWait?: { sliceMs?: number; rampMs?: number; confirm?: number; graceMs?: number; settleMs?: number };
  /** Esc 打断 target 在飞的那一轮 (与 stop_wizard 的那一下同源, 无 teardown)。没有它就退回
   *  旧的排队语义 (等这一轮自然收口), 不打断。 */
  interrupt?: (target: string) => Promise<{ ok: boolean; reason?: string }>;
  /** 只看 pane 本身闲没闲 (不含「这一轮的事件账落没落定」)。打断之后用: 被切断的轮不会再有
   *  终句, 事件账永远 pending, 带 isBusy 的等待会永远等下去。 */
  paneIdle?: (target: string) => Promise<boolean>;
  /** 简报贴回成功后把它留档 (情景记忆): 新会话第一条消息之外, 简报原本无处可寻。 */
  archive?: (e: { target: string; mode: Pending["mode"]; at: number; sid: string; nextSid: string; brief: string }) => void;
}

export type HandoffResult = { ok: true; brief: string } | { ok: false; status: number; reason: string; brief?: string };

/** /handoff/status 的一行: 一个目标当前那场交接的状态与排队深度 —— 是排队 (已受理), 不是欠账。 */
export interface HandoffQueueEntry {
  target: string;
  mode: "self" | "other";
  stage: Pending["stage"];
  state: "queued" | "executing" | "failed";
  at: number;
  waitedMs: number;
  queuedBehind: number;
  waitingFor: string;
}

/** 失败记录的无主兜底: 失败终态是「没有人会再来核查它」的终态 (resume 跳过 compensated), 所以
 *  值守会话即便还活着, 过了这段时间也放掉 —— 否则一条含糊的失败就能把那个 wizard 永久锁死。 */
export const FAILED_STALE_MS = 30 * 60_000;

/** 下一次交接能不能开工 (begin 的准入, 纯函数)。**只用于交接别人**: self 的准入不查记录
 *  (调用即受理, 见 `Handoffs.self`) —— 挡它的只有入口能力缺失, 不在这里。
 *
 *  值守对象 = 这场交接还欠着核查的那个会话: 失败前绑定的那个 (p.sid), 以及重启已提交时就位的
 *  那一个 (clear.sid / nextSid / spawnSid)。挡住重开的全部意义是「别在可能已经清了一半的会话上
 *  再清一次」, 所以:
 *   - 没有失败终态 (waiting/briefing/restarting/restarted/resuming) → 在飞, 一律不开;
 *   - 失败终态还没 compensated → fail() 的补偿写盘没走完, reload 还会接着做, 一律不开;
 *   - 已 compensated 的失败: 值守会话已不是当前绑定 (target 重建成别的会话, 或根本没有活会话)
 *     → 它守的东西已经不存在, 放;
 *   - 值守会话仍是当前绑定 → 只有当记录老于 FAILED_STALE_MS 才放 (证据不足时宁可多等)。 */
export type Admission = { admit: true; release: string } | { admit: false; why: string };

export const handoffAdmission = (p: Pending, now: number, liveSid: string): Admission => {
  if (!p.failure) return { admit: false, why: `在飞: stage=${p.stage}` };
  if (!p.failure.compensated) return { admit: false, why: `失败于 ${p.stage} 但补偿未落盘, reload 还要接着做` };
  const failed = `失败于 ${p.stage} (${p.failure.status}: ${p.failure.reason})`;
  const guarded = [...new Set([p.sid, p.clear?.sid, p.clear?.nextSid, p.clear?.spawnSid].filter((s): s is string => !!s))];
  const age = now - p.at;
  const stale = `${failed}; 记录已超时 ${Math.round(age / 60_000)}min, 没人会再核查它`;
  if (!liveSid) {
    // 没有活会话: 没提交过重启就没有破坏在飞 (新的交接本来也只能另起一个会话), 放; 提交过则可能
    // 只是镜像还没把绑定恢复回来, 宁可等超时。
    return age > FAILED_STALE_MS || !p.clear
      ? { admit: true, release: `${failed}; 该 target 现在没有活会话` }
      : { admit: false, why: `${failed}; 当前没有活会话, 但重启凭证还在 (可能是绑定尚未恢复)` };
  }
  if (!guarded.includes(liveSid)) return { admit: true, release: `${failed}; 值守会话 ${guarded.join("/") || "(未记)"} 已不是当前绑定 (${liveSid})` };
  if (age > FAILED_STALE_MS) return { admit: true, release: `${stale} (值守会话 ${liveSid} 仍是当前绑定)` };
  return { admit: false, why: `${failed}; 值守会话 ${liveSid} 仍是当前绑定` };
};

export interface Handoffs {
  /** 自我交接: 调用即受理 —— 立刻返回 scheduled, daemon 给在飞这一轮一个短窗收口, 到点 Esc
   *  打断直接交接 (欠账/回执跨交接有效, 由路由表 + resumeOwed 兜着); 已有一场在执行时排队到
   *  它之后 (queuedBehind)。不因 pane 忙、未落定事件或旧失败记录而拒绝。 */
  self: (target: string, brief: string) => { ok: boolean; reason?: string; queuedBehind?: boolean };
  /** 交接别人: 等到简报贴回新会话才返回。`extra.announce` = 重开时发「📂 当前项目」气泡。 */
  other: (target: string, focus: string, timeoutMs: number, extra?: { announce?: boolean }) => Promise<HandoffResult>;
  /** 把落盘里没做完的交接接着做。须在注入队列 resume 之前调: 闸要先立起来。 */
  resume: () => number;
  /** 交接队列的可观测性 (/handoff/status): 每个目标当前那场的阶段、排队深度与它在等什么。 */
  status: () => HandoffQueueEntry[];
  /** 切断那一轮的终句被扣下了 (`cuttingTurn` 为真时): 记在这场交接上, 失败时补投。 */
  cut: (target: string, event: string) => void;
  /** 切断那一轮的终句其实就是那一笔的交代 (见 `settlesCut`): 从这场交接的扣下集合里摘掉,
   *  照常落定 —— 交接做成了也不再续问它, 没做成也不再补投第二遍。 */
  keep: (target: string, event: string) => void;
}

/** 交接切断那一轮的终句算不算那一笔的交代 —— 算就照常落定投出, 不留成欠账给新会话续问。
 *  - 结论回**群里** (`chat`): 新会话贴回简报那一轮本就在同一个群里说话, 收尾即便只是「已交接」
 *    也不丢东西; 扣下它反倒让新会话再被「继续 <event>」点一次, 而它手里只有一个事件号
 *    (set_workspace 那一轮就这样被重问, 新管家去 read_chat 猜, 撞上了复用的群名)。
 *  - 结论回 **wizard**: 简报那一轮是私聊、不服务任何一笔, 抢答 (「已交接, 新会话接着干」)
 *    一旦落定, 真结论就再也到不了派活方 —— 只有显式 `RESULT:` / `NEED:` 才算数, 未标记的照旧扣下。 */
export const settlesCut = (receiver: "chat" | "wizard" | undefined, closing: "need" | "result" | undefined): boolean =>
  receiver === "chat" || (receiver === "wizard" && closing !== undefined);

/** 交接要等的那「一轮」: transcript 里开当前这一轮的那句信封所指的注入事件, 加上绑在同一个
 *  turn 上的兄弟事件 —— 只有它们会被这次切断误伤。
 *
 *  为什么不能等整个台账 (2026-10-28 收窄): 一条 execution:"uncertain" 的旧事件永远不会落定
 *  (`settled` 只认 complete+finalized / canceled), 它在等, 交接就空耗满 SELF_IDLE_MS 再 504。
 *  8 次 idle 超时里的每一条 cut 都长这样: 卡住的事件比失败早 27min~10h 注入, 期间 pane 一直判闲。
 *  跨轮卡住的旧账由 cut / uncut 与 resumeOwed 兜底, 不在这里等。
 *
 *  不参与: `handoff:*` 内部事件 (简报/续问)、还没贴进 pane 的 (exposure none —— 交接闸
 *  handingOff 把 peer 注入 held 住, 本来也落不了定)、已经显式释放的 (releasedAt)。
 *  `dispatching` 例外: 那不是历史, 是此刻还在往 pane 里写。 */
export interface RoundEvent {
  id: string;
  target: string;
  turn?: string;
  exposure: string;
  execution: string;
  releasedAt?: number;
}
export const handoffRound = <T extends RoundEvent>(target: string, active: string | undefined, rows: readonly T[]): T[] => {
  const opener = active ? rows.find((e) => e.id === active && e.target === target) : undefined;
  // 开场那条还没贴进 pane / 已被释放 → 这一轮没有会被切掉的终句, 也就不等。
  const live = opener && opener.exposure !== "none" && !opener.releasedAt ? opener : undefined;
  const turn = live?.turn;
  return rows.filter((e) => e.target === target && !e.id.startsWith("handoff:") && e.exposure !== "none" && !e.releasedAt
    && (e.execution === "dispatching" || (!!live && (e.id === live.id || (!!turn && e.turn === turn)))));
};

/** 这一轮还没收口: 还有事件既没落定也没被撤。传进来的行应是 reconcile 之后的最新状态。 */
export const roundPending = (round: readonly { execution: string; finalized?: boolean }[]): boolean =>
  round.some((e) => e.execution !== "canceled" && !e.finalized);

const quote = (s: string): string => s.trim().split("\n").map((l) => `> ${l}`).join("\n");

/** 交接后续答那一笔的注入正文: 带上谁问的、原话、交接切断那一轮被扣下的收尾。新会话没有旧
 *  transcript, 只给事件号它只能去翻记录猜; 有了原话与收尾, 那一笔若其实已答完 (假欠账),
 *  它一句 RESULT 就能自己收掉。 */
export const resumeText = (event: string, ctx: { asker?: string; ask?: string; closing?: string; receiver?: string }): string =>
  [
    `继续 ${event} —— 这是你还没交代的同一项任务。核对已有结果后续办，不要重复已完成或交付未知的操作。`,
    ctx.asker ? `问的是: ${ctx.asker}` : "",
    ctx.ask?.trim() ? `原话:\n${quote(ctx.ask)}` : "",
    ctx.closing?.trim() ? `已有结果与上次收尾:\n${quote(ctx.closing)}` : "",
    ctx.ask?.trim() || ctx.closing?.trim()
      ? `就按上面这件事收口；已做完就用 ${ctx.receiver ? `@.${ctx.receiver.replace(/^\./, "")} RESULT:` : "RESULT:"} 交差。需要补信息时用 tell_peer({kind:"ask"})。`
      : "",
  ].filter(Boolean).join("\n\n");

const SELF_IDLE_MS = 10 * 60_000;
// self 排队等待的节拍与防死排队上限: 每片等一次 idle; 到上限只是把日志升到 warn、记录仍是
// 「仍在队列」—— 排队等待不产生失败记录 (失败会反过来锁住后续, 正是这次重构拆掉的旧病)。
const SELF_WAIT_SLICE_MS = 10 * 60_000;
const SELF_QUEUE_CAP_MS = 6 * 60 * 60_000;
// self 的「不再等」节拍 (2026-11-12): 在飞这一轮先给一个短窗自然收口 (常见: 调完 handoff
// 收个尾, 几秒就完); 窗口用尽还忙就 Esc 打断直接交接。欠着的每笔不因打断失效 —— 路由表
// 记的欠账在新会话由 resumeOwed 逐笔续答, 切断那一轮的终句由 cut/uncut 扣着, 交接闸内的
// 注入也都在新会话里等。Esc 之后只等 pane 静置 (被切断的轮没有终句, 事件账不会落定)。
const SELF_GRACE_MS = 45 * 1000;
const SELF_GRACE_SLICE_MS = 10 * 1000;
const SELF_SETTLE_MS = 60 * 1000;

const briefPrompt = (focus?: string): string =>
  [
    "把你当前会话的全部工作压缩成一份**交接简报**,目标是让一个零上下文的全新会话仅凭这份简报就能无缝接手。必须自洽、具体、可执行,涵盖:",
    "1. 总目标 / 用户到底想要什么",
    "2. 已完成的事、关键决策与其理由",
    "3. 当前状态:改到哪了、什么能跑、什么还没跑通",
    "4. 下一步该做什么(有序)",
    "5. 涉及的关键文件/路径/符号,以及非显而易见的坑",
    focus ? `特别强调:${focus}` : "",
    "只输出这份简报本身,不要寒暄、不要反问。",
  ].filter(Boolean).join("\n");

const carryOf = (p: Pending): string =>
  p.mode === "self"
    ? `以下是你自己上一段会话压缩出来的交接简报, 据此无缝接着干:\n\n${p.brief}`
    : `以下是上一个会话交接过来的工作简报,请据此无缝接手并继续:\n\n${p.brief}`;

export const createHandoffs = (deps: HandoffDeps): Handoffs => {
  /** 每场交接扣下的终句: step 一路传的是不可变快照, 扣下发生在它之外 —— 记在这里, 落盘时并进去。 */
  const cuts = new Map<string, readonly string[]>();
  const withCut = (p: Pending): Pending => { const c = cuts.get(p.target); return c?.length ? { ...p, cut: [...c] } : p; };
  /** 落盘前并上排队伍: step 走的是不可变快照, 可能早于一次「排队」写入 —— 不并上会把已受理的请求丢掉。 */
  const save = (p: Pending): void => {
    const prev = deps.store?.get(p.target);
    void deps.store?.set(p.target, withCut(!p.queued?.length && prev?.queued?.length ? { ...p, queued: prev.queued } : p));
  };
  /** 代数守卫的收尾: 记录已被新一场 (接替 / 排队开工) 顶掉时, 别把别人的记录删了。 */
  const drop = (p: Pending): void => {
    const cur = deps.store?.get(p.target);
    if (deps.store && cur && cur.at !== p.at) return;
    cuts.delete(p.target); deps.store?.drop(p.target);
  };
  /** 新一场的代数: 严格递增, 同毫秒的两次请求也分得开 (简报/续答的注入 id 按它区分)。 */
  const nextAt = (p?: Pending): number => Math.max(Date.now(), (p?.at ?? 0) + 1);
  const selfSliceMs = deps.selfWait?.sliceMs ?? SELF_WAIT_SLICE_MS;
  const selfIdleOpts: IdleOpts = { rampMs: deps.selfWait?.rampMs, confirm: deps.selfWait?.confirm };
  // grace 探测不带 ramp: 这里的「忙」含事件账 (roundPending), 没有「输入还没开始处理」的
  // 误判窗 —— 检闲要快, 一个本来就闲的交接不能白等 ramp 那 20s。
  const graceIdleOpts: IdleOpts = { rampMs: 0, confirm: deps.selfWait?.confirm ?? 2 };
  /** 已受理的排队请求开工: 前一场已了结 (或已失败 —— self 不被失败记录挡) 时, 顶掉旧记录开一场新的。
   *  `evenWhileResuming`: 简报已贴回、还在续答欠账的那场也照样接 (剩下的欠账由新一场的续答兜着)。 */
  const drainQueued = (target: string, evenWhileResuming = false): void => {
    if (handingOff(target)) return;
    const rec = deps.store?.get(target);
    if (!rec?.queued?.length) return;
    if (rec.stage === "resuming" && !rec.failure && !evenWhileResuming) return;
    const [head, ...rest] = rec.queued;
    if (!head) return;
    const cut = [...new Set([...(rec.cut ?? []), ...(head.cut ?? []), ...(deps.currentEvents?.(target) ?? [])])];
    cuts.set(target, cut);
    deps.log.info({ mod: "handoff", target, behind: rec.at }, "handoff: 排队请求开工 (前一场已了结)");
    drop(rec);
    void run({ target, mode: "self", at: nextAt(rec), sid: deps.sessionId(target), stage: "waiting", timeoutMs: SELF_IDLE_MS,
      channel: deps.channelOf(target), brief: head.brief, cut, ...(rest.length ? { queued: rest } : {}) });
  };
  const fail = (p: Pending, status: number, reason: string): HandoffResult => {
    const cut = withCut(p).cut ?? [];
    // Resume compensation after a crash, rather than restarting the handoff.
    const failure = { status, reason, ...(p.failure?.compensated ? { compensated: true } : {}) };
    save({ ...p, failure });
    deps.log.warn({ mod: "handoff", target: p.target, stage: p.stage, reason, cut }, "handoff: 放弃");
    if (p.mode === "self" && !failure.compensated) {
      deps.notify(p.target, `上下文交接没做成: ${reason}`);
      // 简报没接上, 没人会「继续 <event>」: 切断那一轮扣下的终句就是那几笔仅有的交代。
      if (cut.length) deps.uncut(p.target, cut);
    }
    if (!failure.compensated) save({ ...p, failure: { ...failure, compensated: true } });
    // 保留简报与可能已暴露的 clear 凭证, 失败后不自动重做破坏性清空。
    return { ok: false, status, reason, ...(p.brief ? { brief: p.brief } : {}) };
  };
  const idle = (p: Pending, ms: number, opts?: IdleOpts) => waitForIdle(p.target, deps.isBusy, ms, () => false, opts);

  /** 新会话接住简报的凭证: 转忙, 或新 transcript 里出现它的话 (重开后 lastText 读的就是新会话)。 */
  const landed = async (p: Pending, ms: number): Promise<boolean> => {
    for (const end = Date.now() + ms; Date.now() < end; await sleep(2000)) {
      if (await deps.isBusy(p.target)) return true;
      if (deps.lastText(p.target).trim()) return true;
    }
    return false;
  };

  /** 简报贴回之后: 它交接前欠着、还 open 的每一笔, 一笔一轮地接着说 (§9.5)。
   *  简报那一轮没挂信封、服务不着任何一笔 —— 让那些回执闭合的只有这几句。逐笔等它闲下来
   *  再贴下一句, 免得两句挤成一轮 (注入本身也按 id 幂等, reload 重放不会催第二遍)。
   *  这一步不阻塞交接的收尾 (闸已经放了), 失败只记日志: 交接本身已经做成了。
   *  等不到它闲下来就**留着这一行** (stage 还是 resuming): 那几笔还没催到, 下一次 reload 接着催
   *  —— 丢了这一行就等于把这笔债悄悄丢了, 正是交接最容易出的那个事故。 */
  const resumeOwed = async (p: Pending): Promise<void> => {
    let done = true;
    try {
      for (const event of deps.owed(p.target)) {
        const w = await idle(p, p.timeoutMs);
        if (!w.idle) { deps.log.warn({ mod: "handoff", target: p.target, event, reason: w.reason }, "handoff: 欠账续答放弃 (它一直没闲下来), 留待 reload 再催"); done = false; break; }
        const r = await deps.resume(p.target, event, p.at);
        deps.log.info({ mod: "handoff", target: p.target, event, ok: r.ok, reason: r.reason }, "handoff: 欠账续答 (继续)");
        if (r.ok) await landed(p, 60_000);
        else done = false;
      }
    } catch (e) {
      done = false;
      deps.log.warn({ mod: "handoff", target: p.target, err: (e as Error).message }, "handoff: 欠账续答中断");
    }
    // 排队在后的已受理请求开工: 记录还在时由 drain 顶掉 (下面的 drop 因代数不同自动跳过)。
    // resumeOwed 是 step 返回前同步启动的, 空欠账时走到这里闸还没放 —— 先让出一步, 等
    // run.finally 释放了闸, 排队请求才开得了工。
    await sleep(0);
    drainQueued(p.target, true);
    if (done) drop(p);
  };

  /** 一步一步推到底; 每一步先落盘再动手, reload 后从 `stage` 接着来。 */
  const step = async (p: Pending): Promise<HandoffResult> => {
    save(p);
    if (p.mode === "self" && !p.failure?.compensated && p.cut?.length) deps.suppress?.(p.cut);
    if (p.failure) return fail(p, p.failure.status, p.failure.reason);
    switch (p.stage) {
      case "waiting": {
        // 交接别人: 先等它停下 —— 简报的请求排在它手头那一轮后面的话, 它答别人的那段与
        // 简报会挤在一起分不开。这是同步等待 (调用方在场), 超时即失败。
        if (p.mode !== "self") {
          const w = await idle(p, p.timeoutMs);
          if (!w.idle) return fail(p, 504, `一直没能闲下来 (${w.reason}), 上下文没动`);
          // 守护进程请它写简报, 不是谁在群里问的: 私聊。
          const r = await deps.inject(p.target, briefPrompt(p.focus), "", `handoff:${p.target}:${p.at}:summary`, p.timeoutMs);
          if (!r.ok) return fail(p, 502, `summary inject failed: ${r.reason}`);
          return step(saved({ ...p, stage: "briefing" }));
        }
        // 自我交接: 先给在飞这一轮一个短窗自然收口 (常见: 它调完 handoff 收个尾, 几秒就完);
        // 窗口用尽还忙就 Esc 打断直接交接, 不再排它身后。打断不亏欠任何一笔: 它欠着的每笔由
        // 路由表兜着 (新会话里 resumeOwed 逐笔续答), 切断那一轮的终句由 cut/uncut 扣着, 闸内的
        // 注入也都等在新会话。等待期间来了新简报: 就地接替, 不另起一场。
        const graceMs = deps.selfWait?.graceMs ?? SELF_GRACE_MS;
        const graceSlice = Math.max(1, deps.selfWait?.sliceMs ?? SELF_GRACE_SLICE_MS);
        const adopt = (): Pending | undefined => {
          const fresh = deps.store?.get(p.target);
          return fresh && fresh.at !== p.at && fresh.mode === "self" && fresh.stage === "waiting" ? fresh : undefined;
        };
        for (let waited = 0; waited < graceMs; ) {
          let w: IdleResult;
          try { w = await idle(p, Math.min(graceSlice, graceMs - waited), graceIdleOpts); }
          catch (e) { deps.log.warn({ mod: "handoff", target: p.target, err: (e as Error).message }, "handoff: 排队探测失败, 继续等"); await sleep(5000); continue; }
          const fresh = adopt();
          if (fresh) { p = fresh; waited = 0; continue; }
          if (w.idle) return step({ ...p, stage: "restarting" });
          waited += graceSlice;
          deps.log.info({ mod: "handoff", target: p.target, waitedMs: waited, graceMs }, "handoff: 收口窗口内仍在忙");
        }
        // 窗口用尽: 打断在飞这一轮, 只看 pane 静没静下来 —— 被切断的轮不会再有终句,
        // 事件账永远 pending, 不能再拿 isBusy 等 (那会等成死队)。
        const fresh = adopt();
        if (fresh) p = fresh;
        if (deps.interrupt) {
          const esc = await deps.interrupt(p.target);
          deps.log.info({ mod: "handoff", target: p.target, ok: esc.ok, reason: esc.reason }, "handoff: 收口窗口用尽, 打断在飞这一轮直接交接");
          const settle = await waitForIdle(p.target, deps.paneIdle ?? deps.isBusy, deps.selfWait?.settleMs ?? SELF_SETTLE_MS, () => false, { rampMs: 0, confirm: 2 });
          const latest = adopt();
          if (latest) p = latest;
          if (settle.idle) return step({ ...p, stage: "restarting" });
          deps.log.warn({ mod: "handoff", target: p.target, reason: settle.reason }, "handoff: 打断后仍未静下来, 退回排队等待");
        }
        // 没有 interrupt 能力 / Esc 没能让它静下来: 维持旧的排队语义兜底 (等这一轮自然收口,
        // 无超时失败; SELF_QUEUE_CAP_MS 只把日志升到 warn, 不产生失败记录)。
        for (let waited = 0; ; ) {
          let w: IdleResult;
          try { w = await idle(p, selfSliceMs, selfIdleOpts); }
          catch (e) { deps.log.warn({ mod: "handoff", target: p.target, err: (e as Error).message }, "handoff: 排队探测失败, 继续等"); await sleep(5000); continue; }
          const fresh = adopt();
          if (fresh) { p = fresh; waited = 0; continue; }
          if (w.idle) return step({ ...p, stage: "restarting" });
          waited += selfSliceMs;
          deps.log[waited >= SELF_QUEUE_CAP_MS ? "warn" : "info"]({ mod: "handoff", target: p.target, waitedMs: waited }, "handoff: 仍在队列 (等当前这一轮收口; 是排队, 不是欠账)");
        }
      }
      case "briefing": {
        const w = await idle(p, p.timeoutMs);
        const brief = deps.summary(`handoff:${p.target}:${p.at}:summary`) ?? "";
        // 没等到 idle 就不能重开 —— 那会丢掉这次还在生成的交接总结。
        if (!w.idle) return fail(p, 504, `target still working: ${w.reason}; not restarting to avoid losing the turn`);
        if (!brief.trim()) return fail(p, 502, "target produced no summary text");
        return step({ ...p, brief, stage: "restarting" });
      }
      case "restarting": {
        // 每次物理提交前先保存, reload 只核对凭证, 不能再次发送 /clear。
        const r = await deps.restart(p.target, p, (clear) => { p = saved({ ...p, clear }); });
        if (!r.ok) return fail(p, 502, `/clear failed: ${r.reason ?? "unknown"}`);
        cutting.delete(p.target);
        return step(saved({ ...p, stage: "restarted" }));
      }
      case "restarted": {
        if (!p.clear?.nextSid || !p.clear.panePid) return fail(p, 409, "handoff has no complete original-pane clear evidence; refusing carry replay");
        // 同一场交接始终用同一事件 id; reload 从收件事件恢复, 不凭忙闲猜测后重贴。
        const r = await deps.inject(p.target, carryOf(p), p.channel ?? "", `handoff:${p.target}:${p.at}:carry`, p.timeoutMs, p.clear);
        deps.log.info({ mod: "handoff", target: p.target, ok: r.ok, reason: r.reason }, "handoff: 简报已贴回");
        if (!r.ok) return fail(p, 502, `handoff carry inject failed: ${r.reason}`);
        try {
          deps.archive?.({ target: p.target, mode: p.mode, at: p.at, sid: p.sid, nextSid: deps.sessionId(p.target), brief: p.brief ?? "" });
        } catch (e) { deps.log.warn({ mod: "handoff", target: p.target, err: (e as Error).message }, "handoff: 简报留档失败"); }
        // 欠账续答排在最后一步: 先落盘再动手 —— reload 正好落在这一刻就重放它 (注入幂等)。
        // 交接做成了: 扣下的终句由「继续 <event>」续答取代, 不再补投。
        cuts.delete(p.target);
        const next = saved({ ...p, cut: undefined, stage: "resuming" });
        void resumeOwed(next);
        return { ok: true, brief: p.brief ?? "" };
      }
      case "resuming": {
        // reload 落在续答中途: 重放一次 —— 已经贴过的那几笔按 id 判重, 不会催第二遍。
        void resumeOwed(p);
        return { ok: true, brief: p.brief ?? "" };
      }
    }
  };
  const saved = (p: Pending): Pending => (save(p), p);

  /** 闸立在整场交接上: 发起之后进来的话 (人、同伴、回执、日程) 都进新会话。 */
  const run = (p: Pending): Promise<HandoffResult> => {
    const release = hold(p.target);
    if (p.cut?.length) cuts.set(p.target, p.cut);
    if (p.mode === "self" && ["waiting", "restarting"].includes(p.stage)) cutting.add(p.target);
    return step(p)
      .catch((e: unknown): HandoffResult => {
        const latest = deps.store?.get(p.target) ?? p;
        try { return fail(latest, 500, (e as Error).message); }
        catch (persistError) {
          deps.log.error({ target: p.target, err: String(persistError) }, "handoff: durable state unavailable, refusing further input");
          deps.notify(p.target, `交接存储失败，已停止自动交接: ${String(persistError)}`);
          return { ok: false, status: 500, reason: "handoff durable state unavailable; automatic continuation stopped", ...(latest.brief ? { brief: latest.brief } : {}) };
        }
      })
      .finally(() => { cutting.delete(p.target); release(); drainQueued(p.target); });
  };

  /** 开工判断。self 的准入不查旧记录: 失败/残场一律被新请求顶掉 (cut 与排队伍都带过去) ——
   *  30 分钟窗口与「值守会话仍是当前绑定就拒」只留给交接别人: 那是同步调用, 记录挡的是
   *  「在可能已清了一半的会话上再清一次」与对已坏路径的即刻反复重试。释放一定留痕。 */
  const begin = (target: string, mode: Pending["mode"], extra: Partial<Pending>): { p: Pending } | { blocked: string } => {
    if (handingOff(target)) return { blocked: "正在交接中" };
    const existing = deps.store?.get(target);
    if (existing) {
      if (mode === "self") deps.log.warn({ mod: "handoff", target, at: existing.at, stage: existing.stage, failure: existing.failure }, "handoff: self 交接不查旧记录, 残余记录被新请求顶掉");
      else {
        const a = handoffAdmission(existing, Date.now(), deps.sessionId(target));
        if (!a.admit) return { blocked: a.why };
        deps.log.warn({ mod: "handoff", target, at: existing.at, stage: existing.stage, sid: existing.sid, nextSid: existing.clear?.nextSid, failure: existing.failure, why: a.release }, "handoff: 释放已失效的失败记录");
      }
      drop(existing);
    }
    return { p: saved({ target, mode, at: nextAt(existing), sid: deps.sessionId(target), stage: "waiting", timeoutMs: SELF_IDLE_MS, channel: mode === "self" ? deps.channelOf(target) : "", ...extra }) };
  };

  return {
    self: (target, brief) => {
      const existing = deps.store?.get(target);
      if (handingOff(target)) {
        // 还没动手 (waiting): 新简报就地接替 —— 排队等待循环按代数自动跟新记录, 不另起一场。
        if (existing?.mode === "self" && existing.stage === "waiting") {
          const cut = [...new Set([...(existing.cut ?? []), ...(cuts.get(target) ?? []), ...(deps.currentEvents?.(target) ?? [])])];
          cuts.set(target, cut);
          save({ ...existing, at: nextAt(existing), sid: deps.sessionId(target), channel: deps.channelOf(target), brief, cut });
          deps.log.info({ mod: "handoff", target }, "handoff: 等待中的交接被新简报就地接替");
          return { ok: true };
        }
        // 已动手 (restarting/restarted/resuming) 或是交接别人的一场: 排队到它之后再执行一次, 不拒绝。
        if (existing) {
          save({ ...existing, queued: [...(existing.queued ?? []), { brief, at: Date.now(), cut: [...(deps.currentEvents?.(target) ?? [])] }] });
          deps.log.info({ mod: "handoff", target, behind: existing.at, stage: existing.stage }, "handoff: 已有一场在执行, 新请求排队到它之后");
          return { ok: true, queuedBehind: true };
        }
        return { ok: false, reason: "正在交接中 (无落盘记录)" };
      }
      const b = begin(target, "self", { brief, queued: existing?.queued,
        cut: [...new Set([...(existing?.cut ?? []), ...(cuts.get(target) ?? []), ...(deps.currentEvents?.(target) ?? [])])] });
      if (!("p" in b)) return { ok: false, reason: `已有交接记录 (${b.blocked}), 不重复清空` };
      void run(b.p);
      return { ok: true };
    },
    other: async (target, focus, timeoutMs, extra) => {
      const b = begin(target, "other", { focus, timeoutMs, ...extra });
      if (!("p" in b)) return { ok: false, status: 409, reason: `已有交接记录 (${b.blocked}), 不重复清空` };
      return run(b.p);
    },
    resume: () => {
      const all = Object.values(deps.store?.all() ?? {});
      const open = all.filter((p) => !p.failure || !p.failure.compensated);
      open.forEach((p) => void run(p));
      // 已了结的失败记录里可能还压着已受理的排队请求: self 不被失败记录挡, 一并放行。
      all.filter((p) => !!p.failure?.compensated).forEach((p) => drainQueued(p.target));
      if (open.length) deps.log.info({ mod: "handoff", resumed: open.map((p) => `${p.target}@${p.stage}`) }, "handoff: reload 后续做");
      return open.length;
    },
    status: () => Object.values(deps.store?.all() ?? {}).map((p): HandoffQueueEntry => ({
      target: p.target,
      mode: p.mode,
      stage: p.stage,
      at: p.at,
      waitedMs: Date.now() - p.at,
      queuedBehind: p.queued?.length ?? 0,
      state: p.failure ? "failed" : p.stage === "waiting" ? "queued" : "executing",
      waitingFor: p.failure
        ? `失败 (${p.failure.status}: ${p.failure.reason}); 不阻断后续 self 交接`
        : p.stage === "waiting"
          ? p.mode === "self" ? "收口窗口内等当前这一轮, 到点打断直接交接" : "等目标闲下来 (交接别人; 同步等待)"
          : p.stage === "briefing" ? "等它写完简报"
          : p.stage === "restarting" ? "正在清空 / 重开会话"
          : p.stage === "restarted" ? "简报贴回中"
          : "欠账续答中 (继续 <event>)",
    })),
    cut: (target, event) => {
      const p = deps.store?.get(target);
      if (deps.store && !p) throw new Error("handoff transaction unavailable; refusing non-durable final suppression");
      const cut = [...new Set([...(p?.cut ?? []), ...(cuts.get(target) ?? []), event])];
      // 先保存事务凭证, 再发布内存切断状态; 写失败后的重试也必须重新尝试落盘。
      if (p) deps.store!.set(target, { ...p, cut });
      cuts.set(target, cut);
    },
    keep: (target, event) => {
      const p = deps.store?.get(target);
      const cut = (xs?: readonly string[]): string[] => (xs ?? []).filter((x) => x !== event);
      // 先落盘再改内存, 与 cut 同序: 崩在中间 = 事件仍带切断标记, 退回旧行为 (由新会话续答)。
      if (p?.cut?.includes(event)) deps.store!.set(target, { ...p, cut: cut(p.cut) });
      if (cuts.has(target)) cuts.set(target, cut(cuts.get(target)));
    },
  };
};
