// 闲置追问: 派出去的活, 对方闲着不动、也没有回执 —— 守护进程代发话方问一句「进展如何 / 卡在哪」。
//
// 回执 watcher 只管「等它停下、取它答这一句的话」; 停下了却一直没有定论的那段时间没人看。
// 这里补的就是那段: 每隔一会儿扫一遍在飞的件 (receipts.states), 对方**持续**闲够阈值
// (没在忙、没停在审批卡上、没在交接), 就同件号续问一次 (receipts.reask, 父 k / 链头 / 期限
// 沿用原件) —— 它的答复照常作为那件活的回执回给发话方。
//
// 只追问还在「干活」的件: 反问着的 (needs-input) 在等发话方、挂起等子活的 (deferred) 在等
// 别人、停在审批卡上的 (blocked) 在等人点、报错停了的 (errored) 已经有一份回执交回去了 ——
// 这几种闲着都不是它的问题。件一落定 (done / timeout / silent / dead / canceled) 就不在
// states 里, 监控随之结束; 工单收了也不再问。
//
// 状态: 已问次数落盘 (同一件的上限扛得住 reload); 闲了多久只在内存 —— reload 之后从头计,
// 宁可晚问, 不会早问。
import type { TurnState } from "../shared/turn-state.js";

export interface Policy {
  /** 持续闲这么久才问; 0 = 关。 */
  afterMs: number;
  /** 同一件最多问几次。 */
  max: number;
}

/** 一件此刻的样子。`anchor` = 回执锚 (发话 / 续问 / 续回的时刻): 变了就是有了新的一句, 重新计。 */
export interface Obs {
  state: TurnState;
  anchor: number;
  /** 对方闲着: 轮已结束、没停在审批上、没在交接。 */
  idle: boolean;
  /** 不在工单里, 或工单还开着。 */
  jobOpen: boolean;
}

export interface Watch {
  asks: number;
  anchor: number;
  /** 这一段持续闲置从什么时候起; 没在闲 = undefined。 */
  idleSince?: number;
}

/** 锚是 now − ageMs 现算的, 两次读之间差几毫秒; 这么近的算同一个。 */
const ANCHOR_SLACK_MS = 2000;

const askable = (o: Obs): boolean => o.state === "working" && o.jobOpen;

/** 一件过一次巡检: 下一刻的样子, 以及这一刻要不要问。纯函数。 */
export const step = (w: Watch | undefined, o: Obs, now: number, p: Policy): { next: Watch; ask: boolean } => {
  const asks = w?.asks ?? 0;
  const sameAnchor = !!w && Math.abs(w.anchor - o.anchor) < ANCHOR_SLACK_MS;
  if (!askable(o) || !o.idle) return { next: { asks, anchor: o.anchor }, ask: false };
  const since = sameAnchor && w.idleSince !== undefined ? w.idleSince : now;
  const due = p.afterMs > 0 && asks < p.max && now - since >= p.afterMs;
  // 问过之后从头计: 再满一整段闲置才可能问下一次。
  return due ? { next: { asks: asks + 1, anchor: o.anchor, idleSince: now }, ask: true } : { next: { asks, anchor: o.anchor, idleSince: since }, ask: false };
};

/** 追问那一句 (进对方输入框, 以发话方的名义、件号沿用)。 */
export const nudgeText = (fromName: string, turn: string, idleMs: number, n: number, max: number): string =>
  `（守护进程代 ${fromName} 追问${max > 1 ? ` (${n}/${max})` : ""}: 这件活 (${turn}) 你已经闲了 ${Math.max(1, Math.round(idleMs / 60_000))} 分钟, 还没有交回结论。进展如何? 卡在哪? 做完了就按约定收口 \`RESULT: <结论>\`; 缺信息 \`NEED: <问题>\`; 还在等什么 (后台任务 / 别人) 就说清楚在等什么、大概多久。）`;

export interface NudgeDeps {
  /** 在飞的件 (receipts.states)。 */
  inflight: () => readonly { from: string; to: string; turn: string; job: string; state: TurnState; ageMs: number }[];
  idleNow: (target: string) => Promise<boolean>;
  handingOff: (target: string) => boolean;
  jobOpen: (job: string) => boolean;
  policy: () => Policy;
  /** 同件号代发话方续问; 返回是否注入成功。 */
  ask: (x: { from: string; to: string; turn: string; text: string }) => Promise<boolean>;
  nameOf: (target: string) => string;
  /** 已问次数的落盘处。 */
  store: { get: (k: string) => { asks: number } | undefined; set: (k: string, v: { asks: number }) => unknown; drop: (k: string) => void; all: () => Record<string, { asks: number }> };
  log: { info: (o: object, msg: string) => void; warn: (o: object, msg: string) => void };
}

const TICK_MS = 30_000;

export const startIdleNudge = (deps: NudgeDeps): (() => void) => {
  const keyOf = (x: { from: string; to: string; turn: string }): string => `${x.from}\u0000${x.to}\u0000${x.turn}`;
  const mem = new Map<string, Watch>();
  let busy = false;
  const tick = async (): Promise<void> => {
    const now = Date.now();
    const p = deps.policy();
    const xs = deps.inflight().filter((x) => x.turn);
    const live = new Set(xs.map(keyOf));
    // 落定 / 被顶掉的件不再看: 内存与盘上的都清。
    [...mem.keys()].filter((k) => !live.has(k)).forEach((k) => mem.delete(k));
    Object.keys(deps.store.all()).filter((k) => !live.has(k)).forEach((k) => deps.store.drop(k));
    const probed = new Map<string, boolean>();
    const idle = async (t: string): Promise<boolean> =>
      probed.get(t) ?? probed.set(t, !deps.handingOff(t) && (await deps.idleNow(t))).get(t)!;
    for (const x of xs) {
      const k = keyOf(x);
      const prev = mem.get(k) ?? (deps.store.get(k) ? { asks: deps.store.get(k)!.asks, anchor: now - x.ageMs } : undefined);
      const o: Obs = { state: x.state, anchor: now - x.ageMs, idle: x.state === "working" && (await idle(x.to)), jobOpen: !x.job || deps.jobOpen(x.job) };
      const { next, ask } = step(prev, o, now, p);
      mem.set(k, next);
      if (!ask) continue;
      deps.store.set(k, { asks: next.asks });
      const idleMs = now - (prev?.idleSince ?? now);
      const ok = await deps.ask({ from: x.from, to: x.to, turn: x.turn, text: nudgeText(deps.nameOf(x.from), x.turn, idleMs, next.asks, p.max) }).catch(() => false);
      deps.log[ok ? "info" : "warn"]({ mod: "idle-nudge", from: deps.nameOf(x.from), to: deps.nameOf(x.to), turn: x.turn, n: next.asks, idleMin: Math.round(idleMs / 60_000) }, ok ? "idle-nudge: 追问进展" : "idle-nudge: 追问没投出去");
    }
  };
  const timer = setInterval(() => {
    if (busy) return;
    busy = true;
    void tick().catch((e: unknown) => deps.log.warn({ err: (e as Error).message }, "idle-nudge: 巡检出错")).finally(() => { busy = false; });
  }, TICK_MS);
  timer.unref?.();
  return () => clearInterval(timer);
};
