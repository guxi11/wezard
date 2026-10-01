// 回执: 一次 tell_peer 之后, 对方干完那一轮, 守护进程把它的结论**自动**送回发话方
// 的输入框。
//
// 在这之前, 发话方只有两条路: 挂在 wait_peer 上阻塞等 (把一个能干活的 pane 锁死在
// 轮询里, 而且一次只能等一批、等完才醒), 或者自己记得回头 peek —— 后者实际上没人做。
// 异步回执把「问」和「收」拆开: 问完就接着干自己的事, 答案到了作为新的一轮进来。
//
// 这不是第二个编排器, 是一条投递通路。它只做四件事, 每一件都复用现成的判定:
//   等对方停下 (graph.waitForIdle, 与 wait_peer 同一套) → 取它答**这一句**的那段话
//   (peers.replyToPeer, 按信封定位而不是按时刻) → 等发话方停下 → paste 进去。
// 控制流仍在发话方自己的上下文里: 它没有被阻塞, 也没有被谁代理。
//
// 登记落盘 (`store`), boot 时把没收尾的重新守起来。不能纯内存: 这个仓库里被派活的
// wizard 自己就常以 `build + reload` 收尾 —— reload 恰好落在它那一轮里, 内存里的
// watcher 跟着进程一起没了, 发话方永远等不到回执。答案本来就在对方的 transcript 里
// (按信封定位), 重启后接着守, 取到的还是同一段。
import type { Logger } from "pino";
import type { JsonMap } from "../shared/json-map-store.js";
import { waitForIdle } from "./graph.js";

/** 对方最长允许干多久 (超过就放弃这一份回执, 不占着内存等到天亮)。 */
const TARGET_WAIT_SEC = 3600;
/** 发话方正忙时最长等它多久再投。 */
const SENDER_WAIT_SEC = 1800;
/** 对方停下来了却还没答我们这一句 (我们那一句排在别人后面) —— 再等下一次停下。
 *  连着这么多次都没答就认定它不会答了, 别守到天亮。 */
const MAX_FRUITLESS = 3;

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
}

export interface ReceiptDeps {
  isBusy: (target: string) => Promise<boolean>;
  /** 发话方还在不在。死了就把回执丢掉 —— 为了送一份结论把一个已经收工的 wizard
   *  重新拉起来是本末倒置。 */
  paneLive: (target: string) => Promise<boolean>;
  /** `to` 答 `fromName` 那一句的那段话。三态, 缺一不可 (见 peers.replyToPeer):
   *  非空 = 答案; `""` = 问话在, 但还没答 (接着等); `undefined` = 连问话都定位不到
   *  (对方是个还不挂信封的老 wizard) —— 那就只能按时刻取, 由调用方兜。 */
  replyFor: (to: string, fromName: string, sinceMs: number) => string | undefined;
  /** 把回执 paste 进发话方的输入框 (调用方负责拼信封)。 */
  deliver: (to: string, body: string, meta: ReceiptMeta) => Promise<{ ok: boolean; reason?: string }>;
  nameOf: (target: string) => string;
  log: Logger;
  /** 登记的落盘处。缺省 = 纯内存 (reload 即丢)。 */
  store?: JsonMap<Slot>;
}

export interface Tell {
  from: string;
  to: string;
  channel: string;
  job?: string;
  /** 发话时刻。注入**之前**取的那个 —— 晚于那一句落盘的话, 回执定位的下界就偏了。 */
  at?: number;
}

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
  /** 这一份有了定论 (答了 / 没答 / 超时) —— 工单计数只数它。 */
  resolved: boolean;
  /** 收尾了 (送达 / 不回注 / 被 wait_peer 取走 / 放弃) —— boot 时只续守没收尾的。
   *  与 `claimed` 分开: claimed 在投递**之前**就占位, 投到一半 reload 仍要重投。 */
  settled?: boolean;
}

/** 落盘的登记留多久。比对方最长允许干的时长宽, 好让续守的那一份仍数得进工单。 */
const KEEP_MS = 24 * 3600_000;

export interface Receipts {
  /** 登记这一次发话。`watch=false` 只记时刻 (供 wait_peer 定位「这一次」), 不守回执
   *  —— 调用方明说了不要自动回注。 */
  register: (tell: Tell, watch?: boolean) => { at: number };
  /** wait_peer 取走了这一次的回复。返回「是否已经 paste 过」。 */
  claim: (from: string, to: string) => boolean;
  /** 这一次发话的时刻 (0 = 没登记过) —— wait_peer 的 sinceMs。 */
  sentAt: (from: string, to: string) => number;
  /** 还没有定论的那些 (名字), 供诊断与退化后的 wait_peer 回话。 */
  outstanding: (from: string, job?: string) => string[];
  /** 把落盘里没收尾的那些重新守起来。调用方在 mirror 恢复完之后调一次。 */
  resume: () => number;
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

  // 同一个 pane 的回执串行投递。两份回执同时等到发话方 idle 时, 两次 paste 会挤进
  // 同一个输入框被当成一轮读掉 —— 正是异步化最容易带进来的那个故障。
  const chains = new Map<string, Promise<unknown>>();
  const serial = <T>(k: string, job: () => Promise<T>): Promise<T> => {
    const next = (chains.get(k) ?? Promise.resolve()).then(job, job);
    chains.set(k, next.catch(() => undefined));
    return next;
  };

  const arm = (s: Slot): void => {
    void watch(s).catch((e: unknown) => deps.log.warn({ err: (e as Error).message }, "receipt watch failed"));
  };

  /** 守到对方答出**我们这一句**为止。信封是比发话时刻更硬的锚 (见 peers.replyToPeer):
   *  对方正忙时我们那一句是排队的, 它先吐出来的是上一件事的结论 —— 按时刻取就会把
   *  旧结论当成这一次的回执。所以"停下了但还没答我们"要接着等, 不能将就。 */
  const awaitReply = async (s: Slot): Promise<string> => {
    // 锚在发话时刻而不是此刻: reload 后续守的那一份不该重新领一整份时长。
    const deadline = s.at + TARGET_WAIT_SEC * 1000;
    for (let fruitless = 0; fruitless < MAX_FRUITLESS && Date.now() < deadline; ) {
      const wr = await waitForIdle(s.to, deps.isBusy, deadline - Date.now(), () => s.claimed || stale(s));
      if (!wr.idle || s.claimed || stale(s)) return "";
      const got = deps.replyFor(s.to, deps.nameOf(s.from), s.at);
      // undefined = 定位不到问话 (老 wizard 不挂信封): 没有更好的锚, 按时刻取。
      if (got === undefined) return deps.replyFor(s.to, deps.nameOf(s.from), 0) ?? "";
      if (got.trim()) return got;
      fruitless++;
    }
    return "";
  };

  const watch = async (s: Slot): Promise<void> => {
    const lg = deps.log.child({ mod: "receipt", from: deps.nameOf(s.from), to: deps.nameOf(s.to), ...(s.job ? { job: s.job } : {}) });
    const body = await awaitReply(s);
    if (stale(s)) return;
    if (s.claimed) { s.resolved = true; settle(s); return; } // wait_peer 抢先取走了
    s.resolved = true;
    if (!body.trim()) {
      lg.info("receipt: 没有答这一句, 不回注");
      settle(s);
      return;
    }
    if (!(await deps.paneLive(s.from))) {
      lg.info("receipt: 发话方已经不在了, 丢弃");
      settle(s);
      return;
    }
    s.claimed = true; // 占位先于投递: 这中间来的 wait_peer 不该把同一段再取一遍
    const peers = s.job ? ofJob(s.from, s.job) : [s];
    const meta: ReceiptMeta = {
      from: s.to,
      channel: s.channel,
      job: s.job,
      done: peers.filter((x) => x.resolved).length,
      total: peers.length,
    };
    await serial(s.from, async () => {
      if (stale(s)) return;
      // 发话方正在生成 → 等它这一轮说完。ramp 给 0: 它此刻就闲着的话立刻投。
      if (await deps.isBusy(s.from)) {
        const w = await waitForIdle(s.from, deps.isBusy, SENDER_WAIT_SEC * 1000, () => false, { rampMs: 0, confirm: 2 });
        if (!w.idle) { lg.warn({ reason: w.reason }, "receipt: 发话方一直忙, 放弃回注"); settle(s); return; }
      }
      const r = await deps.deliver(s.from, body, meta);
      s.delivered = r.ok;
      settle(s);
      lg.info({ ok: r.ok, reason: r.reason, len: body.length, done: meta.done, total: meta.total }, "receipt: 回注");
    });
  };

  return {
    register: (tell, watchIt = true) => {
      const k = keyOfPair(tell.from, tell.to);
      const s: Slot = {
        ...tell,
        job: tell.job ?? "",
        at: tell.at ?? Date.now(),
        gen: (slots.get(k)?.gen ?? 0) + 1,
        claimed: false,
        delivered: false,
        resolved: false,
      };
      slots.set(k, s);
      if (watchIt) arm(s);
      else { s.claimed = true; s.resolved = true; s.settled = true; } // 不守 = 这一份没人会投
      save(s);
      return { at: s.at };
    },
    claim: (from, to) => {
      const s = slots.get(keyOfPair(from, to));
      if (!s) return false;
      s.claimed = true;
      s.resolved = true;
      settle(s);
      return s.delivered;
    },
    sentAt: (from, to) => slots.get(keyOfPair(from, to))?.at ?? 0,
    outstanding: (from, job) =>
      [...slots.values()]
        .filter((s) => s.from === from && !s.resolved && (job === undefined || s.job === job))
        .map((s) => deps.nameOf(s.to)),
    resume: () => {
      const open = [...slots.values()].filter((s) => !s.settled);
      // 投到一半被 reload 打断的那份: claimed 是上一个进程的占位, 这里重新来过。
      open.forEach((s) => { s.claimed = false; arm(s); });
      if (open.length) deps.log.info({ mod: "receipt", resumed: open.map((s) => `${deps.nameOf(s.from)}←${deps.nameOf(s.to)}`) }, "receipt: reload 后续守");
      return open.length;
    },
  };
};
