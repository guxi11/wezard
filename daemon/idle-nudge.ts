// 闲置追问: 派出去的活, 对方闲着不动、也没有回执 —— 守护进程代发话方问一句「进展如何 / 卡在哪」。
//
// 回执 watcher 只管「等它停下、取它答这一句的话」; 停下了却一直没有定论的那段时间没人看。
// 这里补的就是那段: 每隔一会儿扫一遍在飞的件 (路由表), 对方**持续**闲够阈值
// (没在忙、没停在审批卡上、没在交接), 就在同一笔上续问一次 (件号 / 链头 / 期限
// 沿用原件) —— 它的答复照常作为那件活的回执回给发话方。
//
// 工作中的 route 和等答复/报错的 route 都可续办；挂起等子活、审批阻塞、交接与已落定 route 跳过。
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
}

export interface Watch {
  asks: number;
  anchor: number;
  /** 这一段持续闲置从什么时候起; 没在闲 = undefined。 */
  idleSince?: number;
}

/** 锚是 now − ageMs 现算的, 两次读之间差几毫秒; 这么近的算同一个。 */
const ANCHOR_SLACK_MS = 2000;

const askable = (o: Obs): boolean => ["working", "needs-input", "errored"].includes(o.state);

/** 一件过一次巡检: 下一刻的样子, 以及这一刻要不要问。纯函数。 */
export const step = (w: Watch | undefined, o: Obs, now: number, p: Policy): { next: Watch; ask: boolean } => {
  const asks = w?.asks ?? 0;
  const sameAnchor = !!w && Math.abs(w.anchor - o.anchor) < ANCHOR_SLACK_MS;
  if (!askable(o) || !o.idle) return { next: { asks: asks >= p.max ? 0 : asks, anchor: o.anchor }, ask: false };
  const since = sameAnchor && w.idleSince !== undefined ? w.idleSince : now;
  if (asks >= p.max) {
    const reset = p.afterMs > 0 && now - since >= p.afterMs;
    return { next: { asks: reset ? 0 : asks, anchor: o.anchor, idleSince: reset ? now : since }, ask: false };
  }
  const due = p.afterMs > 0 && asks < p.max && now - since >= p.afterMs;
  // 问过之后从头计: 再满一整段闲置才可能问下一次。
  return due ? { next: { asks: asks + 1, anchor: o.anchor, idleSince: now }, ask: true } : { next: { asks, anchor: o.anchor, idleSince: since }, ask: false };
};

/** 追问那一句 (进对方输入框, 以发话方的名义、件号沿用)。 */
export const nudgeText = (fromName: string, turn: string, idleMs: number, n: number, max: number, state: TurnState = "working"): string =>
  state === "needs-input" || state === "errored"
    ? `（守护进程代 ${fromName} 提醒${max > 1 ? ` (${n}/${max})` : ""}: 任务 (${turn}) 正等你回应${state === "errored" ? "（执行方遇到错误）" : "（执行方有反问）"}。请用 tell_peer({name:"${fromName}", re:true}) 回答或续办；需要新信息时用 kind:"ask"。）`
    : `（守护进程代 ${fromName} 追问${max > 1 ? ` (${n}/${max})` : ""}: 这件活 (${turn}) 你已经闲了 ${Math.max(1, Math.round(idleMs / 60_000))} 分钟, 还没有交回结论。进展如何? 卡在哪? 做完了就按约定收口 \`RESULT: <结论>\`; 还在等什么 (后台任务 / 别人) 就说清楚在等什么、大概多久。）`;

export interface NudgeDeps {
  /** 在飞的件 (index.ts 的 routeInFlight)。 */
  inflight: () => readonly { from: string; to: string; turn: string; state: TurnState; ageMs: number; fromBlocked?: boolean }[];
  sweep?: () => Promise<void>;
  idleNow: (target: string) => Promise<boolean>;
  handingOff: (target: string) => boolean;
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
      const target = x.state === "working" ? x.to : x.from;
      const o: Obs = { state: x.state, anchor: now - x.ageMs,
        idle: !(x.state !== "working" && x.fromBlocked) && await idle(target) };
      const { next, ask } = step(prev, o, now, p);
      mem.set(k, next);
      if (!ask) continue;
      deps.store.set(k, { asks: next.asks });
      const idleMs = now - (prev?.idleSince ?? now);
      const from = x.state === "working" ? x.from : x.to;
      const to = x.state === "working" ? x.to : x.from;
      const ok = await deps.ask({ from, to, turn: x.turn, text: nudgeText(deps.nameOf(from), x.turn, idleMs, next.asks, p.max, x.state) }).catch(() => false);
      deps.log[ok ? "info" : "warn"]({ mod: "idle-nudge", from: deps.nameOf(from), to: deps.nameOf(to), turn: x.turn, n: next.asks, idleMin: Math.round(idleMs / 60_000) }, ok ? "idle-nudge: 追问进展" : "idle-nudge: 追问没投出去");
    }
  };
  const run = (): void => {
    if (busy) return;
    busy = true;
    void (async () => { await deps.sweep?.(); await tick(); })()
      .catch((e: unknown) => deps.log.warn({ err: (e as Error).message }, "idle-nudge: 巡检出错"))
      .finally(() => { busy = false; });
  };
  const timer = setInterval(run, TICK_MS);
  timer.unref?.();
  run();
  return () => clearInterval(timer);
};
