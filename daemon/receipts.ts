// 回执: 一次 tell_peer 之后, 对方干完那一轮, 守护进程把它的结论**自动**送回发话方
// 的输入框。
//
// 在这之前, 发话方只有两条路: 挂在 wait_peer 上阻塞等 (把一个能干活的 pane 锁死在
// 轮询里, 而且一次只能等一批、等完才醒), 或者自己记得回头 peek —— 后者实际上没人做。
// 异步回执把「问」和「收」拆开: 问完就接着干自己的事, 答案到了作为新的一轮进来。
//
// 这不是第二个编排器, 是一条投递通路。它只做四件事, 每一件都复用现成的判定:
//   等对方停下 (mirror.untilIdle, 注册表判闲) → 取它答**这一句**的那段话
//   (peers.replyToPeer, 按信封定位而不是按时刻) → 等发话方停下 → paste 进去。
// 控制流仍在发话方自己的上下文里: 它没有被阻塞, 也没有被谁代理。
//
// 登记落盘 (`store`), boot 时把没收尾的重新守起来。不能纯内存: 这个仓库里被派活的
// wizard 自己就常以 `build + reload` 收尾 —— reload 恰好落在它那一轮里, 内存里的
// watcher 跟着进程一起没了, 发话方永远等不到回执。答案本来就在对方的 transcript 里
// (按信封定位), 重启后接着守, 取到的还是同一段。
import { randomBytes } from "node:crypto";
import type { Logger } from "pino";
import type { JsonMap } from "../shared/json-map-store.js";
import type { IdleResult } from "./graph.js";
import type { PeerReply } from "./peers.js";
import type { Envelope, ReceiptStatus } from "../shared/reminder.js";
import { sleep, truncate } from "../shared/std.js";

/** 对方最长允许干多久 (超过就投一份 timeout 回执, 不占着内存等到天亮)。默认值;
 *  tell_peer 的 `deadline` 可在 [MIN, MAX] 里改 —— 上限留在 KEEP_MS 之内, 超时那份
 *  回执还得数得进工单。 */
const TARGET_WAIT_SEC = 3600;
const DEADLINE_MIN_SEC = 60;
const DEADLINE_MAX_SEC = 12 * 3600;
/** 交接把义务转进新会话时, 至少再给它这么久: 不然对方一交接, 这份就提前超时。 */
const CARRY_GRACE_MS = 10 * 60_000;

/** 一件活的编号: 注入之前生成, 写进信封, 回执按它定位答句。 */
export const newTurn = (): string => `t${randomBytes(3).toString("hex")}`;

/** `at` 发出、给了 `sec` 秒 (缺省 / 越界取默认或夹到边上) 的期限。 */
export const deadlineOf = (at: number, sec?: number): number =>
  at + 1000 * (sec === undefined || !Number.isFinite(sec) ? TARGET_WAIT_SEC : Math.min(Math.max(sec, DEADLINE_MIN_SEC), DEADLINE_MAX_SEC));
/** 对方 pane 不在了, 隔这么久再看一眼才判 dead: 非交接的 pane 换新 (respawn) 也有
 *  几秒是死的。 */
const DEAD_GRACE_MS = 5000;
/** 对方读进了我们这一句、停下了却没答 —— 再等下一次停下。连着这么多次都没答就认定
 *  它不会答了, 别守到天亮。我们那一句还没被读进 (排在别的轮后面) 的那几次不算: 那是
 *  在等前面的轮, 不是它不答; 只有整段 ramp 都闲着、问话仍不在 transcript 里, 才算一次
 *  (那一句多半丢了)。 */
const MAX_FRUITLESS = 3;
/** 等对方「动起来」的窗口: 注册表在它读进这一句之前仍报 idle, 不等这一下就会在它开工
 *  之前读 transcript, 读到的还是上一件事。轮询放慢到 2s: idleNow 与 answered 都同步读
 *  tail, 十几路 fan-out 同时 ramp 时 1s 一次会压住事件循环。 */
const RAMP_MS = 20_000;
const RAMP_POLL_MS = 2000;
/** 每次最多等对方这么久就回来重读 deadline: 交接 transfer 会把 s.at 往后推, 一次定死的
 *  超时会早于新的 deadline 放弃。 */
const IDLE_STEP_MS = 5 * 60_000;
/** codebuddy 没有注册表, 判闲靠 pane 采样 —— 它停在本地对话框上时 spinner 也会消失,
 *  仍会被算作闲 (P1 在那边没修), 多采一次压低误判。发话方投递路径保持 2。 */
const IDLE_CONFIRM = 3;

export interface ReceiptMeta {
  /** 答话方的 target key。 */
  from: string;
  /** 原来那一句说在哪 ("" = 私聊) —— 回执跟着同一个频道, 公开轮的后续仍在群里。 */
  channel: string;
  /** 工单 id ("" = 不在工单里)。 */
  job: string;
  /** 这是该工单第几份 / 一共几份 —— 「齐了吗」由守护进程数, 不让模型猜。 */
  done: number;
  total: number;
  status: ReceiptStatus;
  turn: string;
  /** 这份回执进去之后, 发话方那一轮的终句去哪 (见 routeOf); 缺省 = 只进 rolepage。 */
  replyTo?: ParentK;
  /** 发话方当初派这件活时的父 k —— 写进信封给下一跳继承 (见 parentOf)。 */
  k?: ParentK;
  /** 同一个父 k 下还有几份没回 (>0 时这一轮不外发)。 */
  pending?: number;
}

/** 发出这次 tell_peer 的那一轮, 结论本该交给谁 (docs/evolve/b2-reply-routing.md §3.1):
 *  `chat` = 那一轮是人 / 定时任务 / 公开 peer 发起的, 结论进那个群;
 *  `peer` = 那一轮是 `from` 私聊派来的 (件号 `turn`), 结论作为那一份回执回给它。 */
export type ParentK =
  | { kind: "chat"; channel: string; turn: string }
  | { kind: "peer"; from: string; turn: string };

/** 信封属性上的 k: `chat:<turn>:<base>` / `peer:<turn>:<key>` —— 只给机器读。chat 的
 *  `turn` 是开那一轮的那句人话的时刻: 人先后问的两件事各派了活, 不能被当成兄弟。 */
export const kAttr = (k: ParentK): string => `${k.kind}:${k.turn}:${k.kind === "chat" ? k.channel : k.from}`;
export const kOfAttr = (a: string): ParentK | undefined => {
  const m = a.match(/^(chat|peer):([^:]+):(.+)$/);
  return !m ? undefined : m[1] === "chat" ? { kind: "chat", turn: m[2]!, channel: m[3]! } : { kind: "peer", turn: m[2]!, from: m[3]! };
};
const sameK = (a: ParentK, b: ParentK): boolean => kAttr(a) === kAttr(b);

/** 等出来的结果。失败的那几种 `body` 是合成的说明 + 对方最后一句, 照样投回去:
 *  发话方等的是一个定论, 「没有答案」也是定论 —— 静默丢弃它就只能永远等。 */
export interface Outcome { status: ReceiptStatus; body: string }

export interface ReceiptDeps {
  /** 能接新一轮了吗 (轮已结束、没停在审批上) / 等到那一刻 —— 投递时机用, 见 tell_peer when:"idle"。 */
  idleNow: (target: string) => Promise<boolean>;
  untilIdle: (target: string, timeoutMs: number, opts?: { aborted?: () => boolean; confirm?: number }) => Promise<IdleResult>;
  /** 发话方还在不在。死了就把回执丢掉 —— 为了送一份结论把一个已经收工的 wizard
   *  重新拉起来是本末倒置。 */
  paneLive: (target: string) => Promise<boolean>;
  /** `to` 答 `fromName` 那一句的那段话。三态, 缺一不可 (见 peers.replyToPeer):
   *  非空 = 答案; `""` = 问话在, 但还没答 (接着等); `undefined` = 连问话都定位不到
   *  (还排在输入框里没读进) —— 接着等, 绝不退回按时刻取 (取到的是上一件事的结论)。 */
  replyFor: (to: string, fromName: string, sinceMs: number, turn?: string) => PeerReply | undefined;
  /** 对方在 `sinceMs` 之后最后说的一句 —— 失败回执里给发话方一点线索 (早于发话的
   *  那句是上一件事的, 引它只会误导)。 */
  lastWords?: (to: string, sinceMs: number) => string;
  /** 把回执 paste 进发话方的输入框 (调用方负责拼信封)。 */
  deliver: (to: string, body: string, meta: ReceiptMeta) => Promise<{ ok: boolean; reason?: string }>;
  nameOf: (target: string) => string;
  /** 工单账本里的成员数 —— 「一共几份」的下限。只数回执登记会漏: 登记按发话方 →
   *  答话方一对一份, 同一对后来又说了一句不带工单的 (或别的工单的), 这份就被顶掉,
   *  总数跟着少一, 「全部到齐」就提前报了。 */
  jobTotal?: (job: string) => number;
  log: Logger;
  /** 登记的落盘处。缺省 = 纯内存 (reload 即丢)。 */
  store?: JsonMap<Slot>;
  /** 这个 wizard 正在交接 (见 handoff.ts): 旧会话就要换掉, 此刻读它的 transcript /
   *  往它的输入框里投, 都可能落在要被杀掉的那个 pane 或还没贴回简报的新会话上。 */
  handingOff?: (target: string) => boolean;
  /** 等它交接完 (没在交接 = 立刻 resolve)。 */
  handedOff?: (target: string) => Promise<void>;
}

export interface Tell {
  from: string;
  to: string;
  channel: string;
  job?: string;
  /** 发话时刻。注入**之前**取的那个 —— 晚于那一句落盘的话, 回执定位的下界就偏了。 */
  at?: number;
  /** 件号与第几个来回 (见 prepare)。注入之前就定了, 因为要写进信封。 */
  turn?: string;
  legs?: number;
  /** 到这一刻还没答完就投 timeout (见 deadlineOf)。 */
  deadlineAt?: number;
  /** 发话方那一轮的父 k (见 parentOf) —— 这份回执回来那一轮的终句据此续回。 */
  k?: ParentK;
}

/** 这一句该挂的件号: 新活领一个新的; `re` 续问沿用那件活的件号、工单与频道。 */
export interface Turn { turn: string; legs: number; job?: string; channel?: string; reUnknown?: true }

export interface Slot extends Tell {
  job: string;
  /** 发话时刻 —— replyFor 的下界, 也是 wait_peer 判断「这一次」的那个锚。 */
  at: number;
  /** 同一对 wizard 又说了一句 → 旧 watcher 作废 (后一句的回执才是要的那个)。 */
  gen: number;
  /** 已经有人取走/送出 → 不再投第二遍。 */
  claimed: boolean;
  /** 真的 paste 进去了 (wait_peer 据此告诉调用方「这段已经在你会话里了」)。 */
  delivered: boolean;
  /** 这一份有了定论 (答了 / 没答 / 超时 / pane 没了) —— 工单计数只数它。 */
  resolved: boolean;
  /** 等出来的结果, 写一次不再改 (`error` 除外: 那只是一份中途的失败回执, 之后续跑
   *  答出来的照样投)。先于投递落盘: reload 打断投递后重投的仍是同一份, 迟到的答案
   *  不会把已投的 timeout 改写成 done。 */
  outcome?: Outcome;
  /** 投递失败 (paste 没成) —— 留给观察面, 不重试。 */
  undelivered?: true;
  /** 收尾了 (送达 / 不回注 / 被 wait_peer 取走 / 放弃) —— boot 时只续守没收尾的。
   *  与 `claimed` 分开: claimed 在投递**之前**就占位, 投到一半 reload 仍要重投。 */
  settled?: boolean;
  /** 交接时在旧会话里已经收口的那段答案 (见 Receipts.transfer) —— 换了会话之后
   *  replyFor 读的是新 transcript, 旧答案只能在交接当口取出来存在这里。 */
  answer?: string;
  /** 对方答完了, 但那一轮又派了活 (children) —— 那句「已派」不是定论, 先不投、不计数;
   *  最后一份子回执进去时由 relay 把锚挪到那一句、重新守 (§3.2/§3.3)。挂起期间没有
   *  watcher, 也就没有自己的期限: 超时交给子活各自的 deadline —— 它们一定落定 (失败
   *  也是定论), 落定时由 relay / release 把这一份叫醒。 */
  deferred?: true;
}

/** 落盘的登记留多久。比对方最长允许干的时长宽, 好让续守的那一份仍数得进工单。 */
const KEEP_MS = 24 * 3600_000;

export interface Receipts {
  /** 登记这一次发话。`watch=false` 只记时刻 (供 wait_peer 定位「这一次」), 不守回执
   *  —— 调用方明说了不要自动回注。 */
  register: (tell: Tell, watch?: boolean) => { at: number; turn: string };
  /** 注入之前定件号。`re` 只认同一对 (from → to) 正在守的那件 —— 方向反了、过了保留期、
   *  写错了都当新活 (`reUnknown`), 不拒绝。 */
  prepare: (from: string, to: string, re?: string) => Turn;
  /** wait_peer 取走了这一次的回复。返回「是否已经 paste 过」。 */
  claim: (from: string, to: string) => boolean;
  /** 这一次发话的时刻 (0 = 没登记过) —— wait_peer 的 sinceMs。 */
  sentAt: (from: string, to: string) => number;
  /** 还没有定论的那些 (名字), 供诊断与退化后的 wait_peer 回话。 */
  outstanding: (from: string, job?: string) => string[];
  /** 把落盘里没收尾的那些重新守起来。调用方在 mirror 恢复完之后调一次。 */
  resume: () => number;
  /** 交接当口 (旧会话已停、还没重开): `to` 欠着的每一份回执, `answered` 在旧会话里
   *  取得到答案的就钉住那段; 取不到的义务跟着简报转进新会话 —— 发话时刻改锚到
   *  `carryAt`, 新会话贴回简报那一句挂着发话方的信封, 照常按信封定位。返回转过去的那些。 */
  transfer: (to: string, answered: (s: Slot) => string, carryAt: number) => Slot[];
  /** `self` 此刻这一轮 (开头那句的信封 `env`, 没有 = 人) 派出去的活, 父 k 是什么。
   *  `channel` = 它这一轮的公开频道。私聊来的而发话方没在等 (wait_peer 取走 / 不要回执)
   *  → undefined, 退回现状。 */
  parentOf: (self: string, env: Envelope | undefined, channel: string, opening: string) => ParentK | undefined;
}

export const createReceipts = (deps: ReceiptDeps): Receipts => {
  const keyOfPair = (from: string, to: string): string => `${from}\u0000${to}`;
  const live = (s: Slot): boolean => Date.now() - s.at < KEEP_MS;
  const slots = new Map<string, Slot>(
    Object.values(deps.store?.all() ?? {}).filter(live).map((s) => [keyOfPair(s.from, s.to), s]),
  );
  /** 写穿到磁盘。被同一对的新一句顶掉的旧 slot 不写 —— 它的 key 已经归新的了。 */
  const save = (s: Slot): void => {
    if (!stale(s)) deps.store?.set(keyOfPair(s.from, s.to), s);
  };
  const settle = (s: Slot): void => { s.settled = true; save(s); };
  const stale = (s: Slot): boolean => slots.get(keyOfPair(s.from, s.to))?.gen !== s.gen;
  const ofJob = (from: string, job: string): Slot[] =>
    [...slots.values()].filter((x) => x.from === from && x.job === job);
  /** P 的答话方在答 P 的那一轮里又派出去、还没落定的活。 */
  const children = (p: Slot): Slot[] =>
    [...slots.values()].filter((c) => c.from === p.to && c.k?.kind === "peer" && c.k.from === p.from && c.k.turn === p.turn && !c.settled);
  /** 与 c 同一个发话方、同一个父 k、定论还没送进去的那几份 (不含 c)。送进去的只是一份
   *  error 的那种还没落定: 续跑出来的真答案还要来。 */
  const siblings = (c: Slot): Slot[] =>
    [...slots.values()].filter((x) => x !== c && x.from === c.from && !!x.k && sameK(x.k, c.k!) && !x.settled && !(x.delivered && x.resolved));
  /** 这份回执送进去之后, 发话方那一轮的终句去哪 (§3.3)。只在投递那一刻算: 兄弟们是
   *  陆续回来的, 早算一步就会两份都以为自己不是最后一份。 */
  const routeOf = (s: Slot, final: boolean): { channel: string; k?: ParentK; replyTo?: ParentK; pending?: number; parent?: Slot } => {
    const k = s.k;
    if (!k || !final) return { channel: s.channel, ...(k ? { k } : {}) };
    const pending = siblings(s).length;
    if (pending) return { channel: "", k, pending };
    if (k.kind === "chat") return { channel: k.channel, k, replyTo: k };
    const p = slots.get(keyOfPair(k.from, s.from));
    return p && p.turn === k.turn && !p.resolved && !p.claimed ? { channel: "", k, replyTo: k, parent: p } : { channel: s.channel, k };
  };
  /** 续回: 上游那一份改锚到刚送进去的那份回执 (answerOf 按 reply-to 认它), 重新守。
   *  正在守的那个 watcher 自己会发现锚变了; 挂起 (deferred) 的才要重新 arm。 */
  const relay = (p: Slot, at: number): void => {
    p.at = at;
    p.deadlineAt = Math.max(p.deadlineAt ?? 0, deadlineOf(at));
    wake(p);
  };
  const wake = (p: Slot): void => {
    const was = p.deferred;
    delete p.deferred;
    save(p);
    if (was) arm(p, true);
  };
  /** 子活落定了却没有一份回执送进发话方 (发话方不在了 / 等不到它闲 / wait_peer 取走):
   *  它若是挂起的上游等着的最后一份, 照样叫醒上游 —— 不然上游连一份 dead 都收不到。
   *  锚不动: 上游按原来那一句重新守, 答话方不在了就落成 dead。 */
  const release = (s: Slot): void => {
    const p = routeOf(s, true).parent;
    if (p) wake(p);
  };

  // 同一个 pane 的回执串行投递。两份回执同时等到发话方 idle 时, 两次 paste 会挤进
  // 同一个输入框被当成一轮读掉 —— 正是异步化最容易带进来的那个故障。
  const chains = new Map<string, Promise<unknown>>();
  const serial = <T>(k: string, job: () => Promise<T>): Promise<T> => {
    const next = (chains.get(k) ?? Promise.resolve()).then(job, job);
    chains.set(k, next.catch(() => undefined));
    return next;
  };

  // 一份 slot 同时只有一个 watcher: reload 续守与 relay 叫醒可能撞在一起, 两个 watcher
  // 会把同一个答案投两遍。叫醒挂起的那份要 `force`: 挂起那一刻旧 watcher 已经同步返回,
  // 只是 finally 还没跑; 用 token 免得旧的 finally 删掉新登记的那个。
  const watching = new Map<Slot, symbol>();
  const arm = (s: Slot, force = false): void => {
    if (watching.has(s) && !force) return;
    const token = Symbol();
    watching.set(s, token);
    void watch(s)
      .catch((e: unknown) => deps.log.warn({ err: (e as Error).message }, "receipt watch failed"))
      .finally(() => { if (watching.get(s) === token) watching.delete(s); });
  };

  /** 对方这一轮结束了。判闲以注册表为准 (`untilIdle`): pane 的 spinner 在本地对话框上
   *  (hook 回落成 ask / AskUserQuestion) 和长工具调用的间隙里都会消失, 按它判闲会把
   *  一个停在对话框上的 wizard 当成「答完了却没答」, 扑空三次就把回执扔了。
   *  先等它动起来 (`rampEnd` 之前): 还没读进这一句的会话注册表照样报 idle; 已经答出
   *  来了 (`answered`, 太快的一轮可能在两次采样之间就跑完) 就不必等满。
   *  `quiet` = 整段 ramp 它都闲着、什么也没答 —— 调用方据此判断那一句是不是丢了。 */
  const settled = async (
    to: string,
    rampEnd: number,
    deadline: () => number,
    aborted: () => boolean,
    answered: () => boolean,
  ): Promise<IdleResult & { quiet?: true }> => {
    for (;;) {
      if (aborted()) return { idle: false, reason: "stopped" };
      if (Date.now() >= rampEnd) return { idle: true, quiet: true };
      if (!(await deps.idleNow(to)) || answered()) break;
      await sleep(RAMP_POLL_MS);
    }
    for (;;) {
      const left = deadline() - Date.now();
      if (left <= 0) return { idle: false, reason: "timeout" };
      const r = await deps.untilIdle(to, Math.min(left, IDLE_STEP_MS), { aborted, confirm: IDLE_CONFIRM });
      if (r.idle || aborted()) return r;
    }
  };

  /** 守到对方答出**我们这一句**为止。信封是比发话时刻更硬的锚 (见 peers.replyToPeer):
   *  对方正忙时我们那一句是排队的, 它先吐出来的是上一件事的结论 —— 按时刻取就会把
   *  旧结论当成这一次的回执。所以"停下了但还没答我们"要接着等, 不能将就; 定位不到
   *  问话 (undefined) 也只说明它还没读进, 绝不退回按时刻取。
   *  那一轮以 CLI 报错收尾 → `error`; 报过一次之后只等续跑出来的真答案, 不再计扑空。
   *  `undefined` = 被 wait_peer 取走或被新的一句顶掉, 调用方自己知道。 */
  const awaitReply = async (s: Slot): Promise<Outcome | undefined> => {
    // 锚在发话时刻而不是此刻: reload 后续守的那一份不该重新领一整份时长。交接转过来
    // 的那份改锚到贴回简报的时刻, 所以每圈重算。
    const deadline = (): number => s.deadlineAt ?? s.at + TARGET_WAIT_SEC * 1000;
    const aborted = (): boolean => s.claimed || stale(s);
    const reported = (): boolean => s.outcome?.status === "error";
    const reply = (): PeerReply | undefined => deps.replyFor(s.to, deps.nameOf(s.from), s.at, s.turn);
    const news = (r: PeerReply | undefined): boolean => !!r?.text.trim() && !(r.error && reported());
    const failed = (status: ReceiptStatus): Outcome => ({ status, body: failure(s, status) });
    for (let fruitless = 0; fruitless < MAX_FRUITLESS; ) {
      if (Date.now() >= deadline()) return failed("timeout");
      // 对方 pane 没了 (被收掉 / 崩了): 不会再答, 别空转三次 ramp。交接重开的那几秒
      // pane 也是死的, 先等交接收尾再看; 别的换新 (respawn) 给一小段 grace。
      await deps.handedOff?.(s.to);
      if (s.answer !== undefined) return { status: "done", body: s.answer };
      if (!(await deps.paneLive(s.to))) {
        await sleep(DEAD_GRACE_MS);
        await deps.handedOff?.(s.to);
        if (s.answer !== undefined) return { status: "done", body: s.answer };
        if (!(await deps.paneLive(s.to))) return failed("dead");
      }
      const wr = await settled(s.to, Math.min(deadline(), Date.now() + RAMP_MS), deadline, aborted, () => news(reply()));
      if (aborted()) return undefined;
      if (!wr.idle) { if (wr.reason === "timeout") return failed("timeout"); continue; }
      // 它停下是因为在交接: 等交接收尾, 答案要么已钉在 s.answer, 要么义务转进了新会话
      // (那就接着守新会话)。这一段与下面的 replyFor 之间不能有 await —— 交接一旦
      // 开始就在旧会话还在时把 transfer 做完, 同步读到的必然还是旧 transcript。
      const handing = deps.handingOff?.(s.to) ?? false;
      if (handing) await deps.handedOff?.(s.to);
      if (s.answer !== undefined) return { status: "done", body: s.answer };
      if (handing) continue;
      const got = reply();
      if (got && news(got)) return { status: got.error ? "error" : "done", body: got.text };
      // 读进了没答 = 扑空一次; 还没读进 = 前面有别的轮, 接着等 —— 除非整段 ramp 都静着。
      // 报过 error 之后它停着是在等人续跑, 不算扑空, 守到期限。
      if (!reported() && (got !== undefined || wr.quiet)) fruitless++;
    }
    return failed("silent");
  };

  /** 失败回执的正文: 守护进程的一句说明 + 对方最后一句 (给发话方一点线索)。 */
  const failure = (s: Slot, status: ReceiptStatus): string => {
    const why: Partial<Record<ReceiptStatus, string>> = {
      timeout: `等了 ${Math.round((Date.now() - s.at) / 60_000)} 分钟它还没答完`,
      silent: `它停下了 ${MAX_FRUITLESS} 次, 都没答这一句`,
      dead: "它的 pane 没了",
    };
    const last = deps.lastWords?.(s.to, s.at).trim();
    return `（守护进程: ${deps.nameOf(s.to)} 没有给出结论 —— ${why[status] ?? status}。）${last ? `\n它最后说的: ${truncate(last, 600)}` : ""}`;
  };

  const watch = async (s: Slot): Promise<void> => {
    const lg = deps.log.child({ mod: "receipt", from: deps.nameOf(s.from), to: deps.nameOf(s.to), ...(s.job ? { job: s.job } : {}) });
    const anchor = s.at;
    // 终态写一次不再改: reload 打断投递后续守的那一份直接重投同一个结果, 不再重等。
    const out = s.outcome && s.outcome.status !== "error" ? s.outcome : await awaitReply(s);
    if (stale(s)) return;
    if (s.claimed || !out) { s.resolved = true; settle(s); return; } // wait_peer 抢先取走了
    // 下面到 save 之间不能有 await: relay 与这里的判定必须看到同一个状态。
    // 锚被 relay 挪到了回执那一句: 刚取到的是旧锚的答案 (那句「已派」), 重来。
    if (s.at !== anchor) return watch(s);
    // 它这一轮又派了活, 结论要等那些回来 —— 这一句不是定论: 不投、不计数 (§3.2)。
    if (out.status === "done" && children(s).length) {
      s.deferred = true;
      save(s);
      lg.info({ children: children(s).map((c) => deps.nameOf(c.to)) }, "receipt: 答话方又派了活, 等子回执回来再续");
      return;
    }
    const final = out.status !== "error";
    s.outcome = out;
    s.resolved = final;
    save(s);
    // 发话方自己在交接: 重开的那几秒里 pane 是死的, 别把这当成"已经不在了"。
    await deps.handedOff?.(s.from);
    if (!(await deps.paneLive(s.from))) {
      lg.info({ status: out.status }, "receipt: 发话方已经不在了, 丢弃");
      settle(s);
      if (final) release(s);
      return;
    }
    if (final) s.claimed = true; // 占位先于投递: 这中间来的 wait_peer 不该把同一段再取一遍
    const peers = s.job ? ofJob(s.from, s.job) : [s];
    const meta: ReceiptMeta = {
      from: s.to,
      channel: s.channel,
      job: s.job,
      done: peers.filter((x) => x.resolved).length,
      total: Math.max(peers.length, s.job ? deps.jobTotal?.(s.job) ?? 0 : 0),
      status: out.status,
      turn: s.turn ?? "",
    };
    const sent = await serial(s.from, async () => {
      // 发话方正在生成 → 等它这一轮说完, 一结束就投。它的 pane 还活着就一直等 (上限是
      // 登记的保留期): 回执到了却因为它在跑长活而扔掉, 它就只能永远等。
      // 等的过程中它开始交接 → 等交接完再来一圈: 投进旧会话会被交接一并带走 (简报
      // 已经写完了, 不含这一段), 投进还没贴回简报的新会话会抢在简报前面。
      // 每圈都查 stale: 等发话方闲下来可能要很久, 同一对的新一句正是在这期间来的。
      for (;;) {
        await deps.handedOff?.(s.from);
        // settled 只可能是 wait_peer 在这期间取走了 (watcher 自己投完才 settle)。
        if (stale(s) || s.settled) return false;
        if (Date.now() >= s.at + KEEP_MS || !(await deps.paneLive(s.from))) {
          lg.warn({ status: out.status }, "receipt: 发话方一直没空或已不在, 放弃回注");
          return false;
        }
        if (!(await deps.idleNow(s.from))) {
          await deps.untilIdle(s.from, Math.min(IDLE_STEP_MS, s.at + KEEP_MS - Date.now()), { aborted: () => stale(s) });
          continue;
        }
        if (!deps.handingOff?.(s.from)) break;
      }
      const { parent, ...route } = routeOf(s, final);
      const at = Date.now();
      const r = await deps.deliver(s.from, out.body, { ...meta, ...route });
      if (r.ok) s.delivered = true;
      else s.undelivered = true;
      if (r.ok && parent) relay(parent, at);
      lg.info({ ok: r.ok, reason: r.reason, status: out.status, len: out.body.length, done: meta.done, total: meta.total, ...(route.replyTo ? { replyTo: kAttr(route.replyTo) } : {}), ...(route.pending ? { pending: route.pending } : {}) }, "receipt: 回注");
      return true;
    });
    if (stale(s)) { lg.info("receipt: 被同一对的新一句顶掉, 不回注"); return; }
    // error 只是中途报了一声: 接着守续跑出来的答案。
    if (!final && sent) return watch(s);
    settle(s);
    if (!s.delivered) release(s);
  };

  return {
    register: (tell, watchIt = true) => {
      const k = keyOfPair(tell.from, tell.to);
      const at = tell.at ?? Date.now();
      const s: Slot = {
        ...tell,
        job: tell.job ?? "",
        at,
        turn: tell.turn ?? newTurn(),
        legs: tell.legs ?? 1,
        deadlineAt: tell.deadlineAt ?? deadlineOf(at),
        gen: (slots.get(k)?.gen ?? 0) + 1,
        claimed: false,
        delivered: false,
        resolved: false,
      };
      slots.set(k, s);
      if (watchIt) arm(s);
      else { s.claimed = true; s.resolved = true; s.settled = true; } // 不守 = 这一份没人会投
      save(s);
      return { at: s.at, turn: s.turn! };
    },
    prepare: (from, to, re) => {
      const want = re?.replace(/[`\s]/g, "");
      const s = want ? slots.get(keyOfPair(from, to)) : undefined;
      return s?.turn && s.turn === want
        ? { turn: s.turn, legs: (s.legs ?? 1) + 1, job: s.job, channel: s.channel }
        : { turn: newTurn(), legs: 1, ...(re ? { reUnknown: true as const } : {}) };
    },
    claim: (from, to) => {
      const s = slots.get(keyOfPair(from, to));
      if (!s) return false;
      const fresh = !s.settled;
      s.claimed = true;
      s.resolved = true;
      settle(s);
      if (fresh) release(s);
      return s.delivered;
    },
    sentAt: (from, to) => slots.get(keyOfPair(from, to))?.at ?? 0,
    outstanding: (from, job) =>
      [...slots.values()]
        .filter((s) => s.from === from && !s.resolved && (job === undefined || s.job === job))
        .map((s) => deps.nameOf(s.to)),
    transfer: (to, answered, carryAt) => {
      const owed = [...slots.values()].filter((s) => s.to === to && !s.resolved && !s.claimed);
      const carried = owed.filter((s) => {
        const got = answered(s);
        if (got.trim()) s.answer = got;
        else {
          s.at = carryAt;
          s.deadlineAt = Math.max(s.deadlineAt ?? 0, carryAt + CARRY_GRACE_MS);
        }
        save(s);
        return !got.trim();
      });
      if (owed.length) deps.log.info({ mod: "receipt", to: deps.nameOf(to), answered: owed.length - carried.length, carried: carried.map((s) => deps.nameOf(s.from)) }, "receipt: 交接时转交");
      return carried;
    },
    parentOf: (self, env, channel, opening) => {
      if (env?.receipt) return env.k ? kOfAttr(env.k) : undefined;
      if (env?.kind === "peer" && env.private) {
        const p = [...slots.values()].find((x) => x.to === self && !x.resolved && !x.claimed && (env.turn ? x.turn === env.turn : deps.nameOf(x.from) === env.from));
        return p && { kind: "peer", from: p.from, turn: p.turn! };
      }
      return { kind: "chat", channel, turn: opening };
    },
    resume: () => {
      // 挂起且子活还没落定的不守: 叫醒它是 relay / release 的事, 这里再 arm 一个就是两个 watcher。
      const open = [...slots.values()].filter((s) => !s.settled && !(s.deferred && children(s).length));
      // 投到一半被 reload 打断的那份: claimed 是上一个进程的占位, 这里重新来过。
      open.forEach((s) => { s.claimed = false; arm(s); });
      if (open.length) deps.log.info({ mod: "receipt", resumed: open.map((s) => `${deps.nameOf(s.from)}←${deps.nameOf(s.to)}`) }, "receipt: reload 后续守");
      return open.length;
    },
  };
};
