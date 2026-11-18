// 闲置追问: 派出去的活, 对方闲着不动、也没有回执 —— 守护进程代发话方问一句「进展如何 / 卡在哪」。
//
// 回执 watcher 只管「等它停下、取它答这一句的话」; 停下了却一直没有定论的那段时间没人看。
// 这里补的就是那段: 每隔一会儿扫一遍在飞的件 (路由表), 对方**持续**闲够阈值
// (没在忙、没停在审批卡上、没在交接), 就在同一笔上续问一次 (件号 / 链头 / 期限
// 沿用原件) —— 它的答复照常作为那件活的回执回给发话方。
//
// 工作中的 route 和等答复/报错的 route 都可续办；挂起等子活、审批阻塞、交接与已落定 route 跳过。
//
// 状态: 已问次数与冷却轮次落盘 (同一件的上限扛得住 reload); 闲了多久只在内存 —— reload 之后从头计,
// 宁可晚问, 不会早问。
//
// 一条卡住 16 天的 route 曾被追问 3171 次, 每次都是一个新的续办载体 —— 追问本身要有尽。
import { clipLine } from "../shared/std.js";
import type { TurnState } from "../shared/turn-state.js";

export interface Policy {
  /** 持续闲这么久才问; 0 = 关。 */
  afterMs: number;
  /** 同一件最多问几次。 */
  max: number;
  /** 冷却轮次上限 (缺省 MAX_CYCLES): 一组问满、冷却完再重开一轮就 +1。1 = 问满这一组就闭嘴,
   *  不开新一轮 —— strict 群「答了没出站」用它 (它已经答过, 再问只是往池子里堆载体)。 */
  cycles?: number;
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
  /** 冷却轮次: 一组追问用满、冷却完再重开一轮就 +1; 到 MAX_CYCLES 即用尽。 */
  cycles?: number;
  anchor: number;
  /** 这一段持续闲置从什么时候起; 没在闲 = undefined。 */
  idleSince?: number;
  /** 已经为第几轮追问报过「问到上限还没收口」(每轮恰好一次)。 */
  escalatedCycle?: number;
}

/** 锚是 now − ageMs 现算的, 两次读之间差几毫秒; 这么近的算同一个。 */
const ANCHOR_SLACK_MS = 2000;
/** 重开的上限: 一共 max × MAX_CYCLES 次追问之后不再开口 (对方真没反应, 再问只是往池子里堆载体)。 */
export const MAX_CYCLES = 6;
const MAX_COOLDOWN_MS = 24 * 3600_000;

const askable = (o: Obs): boolean => ["working", "needs-input", "errored"].includes(o.state);
const cooldownOf = (p: Policy, cycles: number): number => Math.min(p.afterMs * 2 ** cycles, MAX_COOLDOWN_MS);

/** 一件过一次巡检: 下一刻的样子, 以及这一刻要不要问 / 要不要上报。纯函数。
 *  p.cycles 是本口径的冷却轮次上限 (缺省 MAX_CYCLES)。
 *  escalate = 这一轮追问已经问到上限而这件事还挂着 —— 必须有一条人来看得见的上报 (不许无限
 *  静默重投); 每一轮追问恰好报一次 (按 cycles 区分), 总次数仍由 MAX_CYCLES 兜住。 */
export const step = (w: Watch | undefined, o: Obs, now: number, p: Policy): { next: Watch; ask: boolean; escalate: boolean } => {
  const sameAnchor = !!w && Math.abs(w.anchor - o.anchor) < ANCHOR_SLACK_MS;
  // 真有新动静 = 从头计: 已问次数与冷却轮次都不该赖在上一段上。
  const asks = sameAnchor ? w.asks : 0;
  const cycles = sameAnchor ? w.cycles ?? 0 : 0;
  const escalatedCycle = sameAnchor ? w!.escalatedCycle : undefined;
  const keep = escalatedCycle !== undefined ? { escalatedCycle } : {};
  // 忙 / 不可问不再把用满的次数清零: 追问自己引起的那一轮忙曾经借此绕过冷却,
  // 变成每忙一次就重开一组的永动追问源。
  if (!askable(o) || !o.idle) return { next: { asks, cycles, anchor: o.anchor, ...keep }, ask: false, escalate: false };
  const since = sameAnchor && w.idleSince !== undefined ? w.idleSince : now;
  const maxCycles = Math.max(1, p.cycles ?? MAX_CYCLES);
  if (asks >= p.max) {
    // 冷却走完还能再开一轮吗。开不了 = 这一组用尽了: 没有下一组, 也就没得再上报。
    const canReopen = p.max > 0 && p.afterMs > 0 && cycles + 1 < maxCycles && now - since >= cooldownOf(p, cycles);
    if (!canReopen) {
      // 这一轮的追问用完了、行还挂着: 报到人那里 (每轮恰好一次; 用尽的最后一轮不报)。
      const escalate = p.max > 0 && p.afterMs > 0 && escalatedCycle !== cycles;
      return { next: { asks, cycles, anchor: o.anchor, idleSince: since, ...(escalate ? { escalatedCycle: cycles } : keep) },
        ask: false, escalate };
    }
    return { next: { asks: 0, cycles: cycles + 1, anchor: o.anchor, idleSince: now, ...keep }, ask: false, escalate: false };
  }
  const due = p.afterMs > 0 && asks < p.max && now - since >= p.afterMs;
  // 问过之后从头计: 再满一整段闲置才可能问下一次。
  return due
    ? { next: { asks: asks + 1, cycles, anchor: o.anchor, idleSince: now, ...keep }, ask: true, escalate: false }
    : { next: { asks, cycles, anchor: o.anchor, idleSince: since, ...keep }, ask: false, escalate: false };
};

/** 追问那一句 (进对方输入框, 以发话方的名义、件号沿用)。 */
export const nudgeText = (fromName: string, turn: string, idleMs: number, n: number, max: number, state: TurnState = "working"): string =>
  state === "needs-input" || state === "errored"
    ? `（守护进程代 ${fromName} 提醒${max > 1 ? ` (${n}/${max})` : ""}: 任务 (${turn}) 正等你回应${state === "errored" ? "（执行方遇到错误）" : "（执行方有反问）"}。请用 tell_peer({name:"${fromName}", re:true}) 回答或续办；需要新信息时用 kind:"ask"。）`
    : `（守护进程代 ${fromName} 追问${max > 1 ? ` (${n}/${max})` : ""}: 这件活 (${turn}) 你已经闲了 ${Math.max(1, Math.round(idleMs / 60_000))} 分钟, 还没有交回结论。进展如何? 卡在哪? 做完了就在行首直接写 RESULT: <结论> (行首不加反引号/引号/加粗); 还在等什么 (后台任务 / 别人) 就说清楚在等什么、大概多久。）`;

/** strict 群「答了但没交付」的追问那一句 —— 它答过了, 通用追问「进展如何 / 还没交回结论」是错题
 *  (它以为自己答完了); 要说的是「这笔义务还没用 chat_reply 交付销账」(2026-11-18 放宽后
 *  chat_say 也能发言, 但只有 chat_reply 销账 —— 发过话不等于交付)。re = 那条义务消息的信封 msg。 */
export const strictDeliveryNudge = (x: { chat: string; re: string }): string =>
  `（守护进程: ${x.chat} 是严格模式, 你这一轮已经写出了结论, 但这笔义务**还没用 chat_reply 交付** (仍开着 —— 严格群里发过话不等于交付, 终句也不进出站门)。请用 chat_reply({re: "${x.re}", text: <你刚才那份结论>}) 把它正式交付; 确实不该发就不带 text 记 passed。这件活只追问这一次, 再不回会上报。）`;

/** 追问之后仍无交付: 发进群的那一行 (人要看得出「答了没交付」, 不是卡死)。 */
export const strictDeliveryReport = (x: { who: string; event: string; re: string; asks: number; last?: string }): string =>
  `[wezard] ⚠️ ${x.who} 已经答了, 但这笔义务还没用 chat_reply 交付 (仍开着) — 本群是严格模式, 销账只走 chat_reply 的显式答复。已追问 ${x.asks} 次仍无交付; 行 ${x.event} 还开着 (义务账): 可以让它用 chat_reply 补发, 或用 stop_wizard 收掉。`
  + (x.last ? `\n\n它最后说的: ${clipLine(x.last, 300)}` : "");

/** 一件在飞活的追问口径 (缺省用全局 idleNudge 配置)。 */
export interface NudgeTarget {
  from: string; to: string; turn: string; state: TurnState; ageMs: number; fromBlocked?: boolean;
  /** 这一件专用的上限 / 冷却轮次与话术 —— strict 群「答了没出站」只问 1 次 (cycles:1)。 */
  nudge?: { policy: Policy; text: string };
}

export interface NudgeDeps {
  /** 在飞的件 (index.ts 的 routeInFlight)。 */
  inflight: () => readonly NudgeTarget[];
  sweep?: () => Promise<void>;
  idleNow: (target: string) => Promise<boolean>;
  handingOff: (target: string) => boolean;
  policy: () => Policy;
  /** 同件号代发话方续问; 返回是否注入成功。 */
  ask: (x: { from: string; to: string; turn: string; text: string }) => Promise<boolean>;
  nameOf: (target: string) => string;
  /** 追问用满仍未收口: 上报给人看 (群系统行 / 管家)。同一件事每轮追问至多一次。 */
  escalate?: (x: { from: string; to: string; turn: string; asks: number; cycles: number }) => unknown;
  /** 已问次数、冷却轮次与已上报轮次的落盘处。 */
  store: { get: (k: string) => { asks: number; cycles?: number; escalatedCycle?: number } | undefined;
    set: (k: string, v: { asks: number; cycles?: number; escalatedCycle?: number }) => unknown;
    drop: (k: string) => void; all: () => Record<string, { asks: number; cycles?: number; escalatedCycle?: number }> };
  log: { info: (o: object, msg: string) => void; warn: (o: object, msg: string) => void };
}

const TICK_MS = 30_000;

/** 一次巡检 (定时器与单测共用): 扫一遍在飞的件, 该问的问、该报的报。 */
export const createIdleNudgeTick = (deps: NudgeDeps): (() => Promise<void>) => {
  const SEP = String.fromCharCode(0);
  const keyOf = (x: { from: string; to: string; turn: string }): string => `${x.from}${SEP}${x.to}${SEP}${x.turn}`;
  const mem = new Map<string, Watch>();
  return async (): Promise<void> => {
    const now = Date.now();
    const base = deps.policy();
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
      const saved = deps.store.get(k);
      const prev = mem.get(k) ?? (saved ? { asks: saved.asks, cycles: saved.cycles, escalatedCycle: saved.escalatedCycle,
        anchor: now - x.ageMs } : undefined);
      const target = x.state === "working" ? x.to : x.from;
      const o: Obs = { state: x.state, anchor: now - x.ageMs,
        idle: !(x.state !== "working" && x.fromBlocked) && await idle(target) };
      // 这一件自己的口径 (缺省全局配置): strict 群「答了没出站」问一次就闭嘴。
      const p = x.nudge?.policy ?? base;
      const cap = Math.max(1, p.cycles ?? MAX_CYCLES);
      const wasExhausted = (prev?.cycles ?? 0) >= cap;
      const { next, ask, escalate } = step(prev, o, now, p);
      mem.set(k, next);
      // 次数、轮次与已上报轮次都要扛 reload; 冷却轮次与上报的推进都不伴随追问, 也得落盘。
      if (!saved || saved.asks !== next.asks || (saved.cycles ?? 0) !== (next.cycles ?? 0)
          || (saved.escalatedCycle ?? -1) !== (next.escalatedCycle ?? -1))
        deps.store.set(k, { asks: next.asks, ...(next.cycles ? { cycles: next.cycles } : {}),
          ...(next.escalatedCycle !== undefined ? { escalatedCycle: next.escalatedCycle } : {}) });
      if (escalate) {
        // 这一轮的追问用完了还挂着: 留一条能被人看见的上报 (行本身不伪造终态)。
        deps.log.warn({ mod: "idle-nudge", from: deps.nameOf(x.from), to: deps.nameOf(x.to), turn: x.turn,
          asks: next.asks, cycles: next.cycles ?? 0 }, "idle-nudge: 追问用满仍未收口, 上报");
        await Promise.resolve(deps.escalate?.({ from: x.from, to: x.to, turn: x.turn,
          asks: next.asks, cycles: next.cycles ?? 0 })).catch(() => undefined);
      }
      if (!wasExhausted && (next.cycles ?? 0) >= cap)
        deps.log.warn({ mod: "idle-nudge", from: deps.nameOf(x.from), to: deps.nameOf(x.to), turn: x.turn, cycles: next.cycles },
          "idle-nudge: 追问用尽, 不再追问");
      if (!ask) continue;
      const idleMs = now - (prev?.idleSince ?? now);
      const from = x.state === "working" ? x.from : x.to;
      const to = x.state === "working" ? x.to : x.from;
      const text = x.nudge?.text ?? nudgeText(deps.nameOf(from), x.turn, idleMs, next.asks, p.max, x.state);
      const ok = await deps.ask({ from, to, turn: x.turn, text }).catch(() => false);
      deps.log[ok ? "info" : "warn"]({ mod: "idle-nudge", from: deps.nameOf(from), to: deps.nameOf(to), turn: x.turn, n: next.asks, idleMin: Math.round(idleMs / 60_000) }, ok ? "idle-nudge: 追问进展" : "idle-nudge: 追问没投出去");
    }
  };
};

export const startIdleNudge = (deps: NudgeDeps): (() => void) => {
  const tick = createIdleNudgeTick(deps);
  let busy = false;
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

// ── P7-S2 义务观测 (严格群的 chat 接收行) ──────────────────────────────
// 严格群里义务不随终句自动关账 (chat_reply 才关), 逾期要有人看:
//   本轮 idle 且义务未关 → 提醒恰好 1 次; 再 idle 仍未关 → overdue 上报恰好 1 次
//   (成员违约私聊告知管家, 管家违约发群系统行 —— 上报的路由在 index.ts 的接线里)。
//   注入 10 分钟没提交 (uncertain / 排队卡死) 只提示不判超时; **不按墙钟判逾期,
//   不伪造 timeout** —— 行保持原状态, 时间只是观察窗, 状态机里没有「到点自动落定」
//   这一步 (判据⑥: 假时钟快进 24h 无事件时状态迁移 0)。

export interface ObligationObs {
  /** 注入已提交给 owner (它确实收到了)。 */
  delivered: boolean;
  /** owner 此刻闲着 (轮已结束、没在交接)。 */
  idle: boolean;
  /** 距开行多久。 */
  ageMs: number;
}
export interface ObligationWatch {
  /** 已提醒过的时刻。 */
  remindedAt?: number;
  /** 已上报 overdue。 */
  overdue?: true;
  overdueAt?: number;
}

/** 一条义务过一次巡检: 纯。 */
export const stepObligation = (
  w: ObligationWatch | undefined,
  o: ObligationObs,
  now: number,
  stalledAfterMs = 10 * 60_000,
): { next: ObligationWatch; remind: boolean; escalate: boolean; stalled: boolean } => {
  const base: ObligationWatch = w ?? {};
  // 没提交的不判违约 —— 卡在注入里的义务提醒 owner 没有意义, 只提示。
  if (!o.delivered) return { next: base, remind: false, escalate: false, stalled: o.ageMs > stalledAfterMs };
  if (!o.idle) return { next: base, remind: false, escalate: false, stalled: false };
  if (!base.remindedAt) return { next: { ...base, remindedAt: now }, remind: true, escalate: false, stalled: false };
  if (!base.overdue) return { next: { remindedAt: base.remindedAt, overdue: true, overdueAt: now }, remind: false, escalate: true, stalled: false };
  // 已上报过: 不再有动作 —— 提醒/上报各恰好 1 次 (判据⑥)。
  return { next: base, remind: false, escalate: false, stalled: false };
};

export interface ObligationRow {
  /** 路由行 id。 */
  event: string;
  /** 义务的 owner (wizard target)。 */
  owner: string;
  /** 严格群的 base principal。 */
  channel: string;
  /** chatlog/提醒里带的 msg (chat_reply 的 re)。 */
  message: string;
  ageMs: number;
}

export interface ObligationDeps {
  /** 在看的义务行 (未落定的 chat 接收行; 严格群由调用方过滤)。 */
  rows: () => readonly ObligationRow[];
  /** 该行的注入是否已提交给 owner。 */
  delivered: (row: ObligationRow) => boolean;
  idleNow: (target: string) => Promise<boolean>;
  handingOff: (target: string) => boolean;
  /** 提醒 owner (注入它的 pane); 返回是否投出去。 */
  remind: (row: ObligationRow) => Promise<boolean>;
  /** 上报违约 (管家或私聊告知, 由调用方定)。 */
  escalate: (row: ObligationRow) => Promise<void>;
  /** 已问次数/轮次的落盘处 (键 = 行 id)。 */
  store: { get: (k: string) => ObligationWatch | undefined; set: (k: string, v: ObligationWatch) => unknown;
    drop: (k: string) => void; all: () => Record<string, ObligationWatch> };
  log: { info: (o: object, msg: string) => void; warn: (o: object, msg: string) => void };
}

export const startObligationWatch = (deps: ObligationDeps): (() => void) => {
  const stalledNoted = new Set<string>();
  let busy = false;
  const tick = async (): Promise<void> => {
    const now = Date.now();
    const rows = deps.rows();
    const live = new Set(rows.map((r) => r.event));
    // 落定 / 被顶掉的义务不再看: 内存与盘上的都清。
    Object.keys(deps.store.all()).filter((k) => !live.has(k)).forEach((k) => deps.store.drop(k));
    for (const row of rows) {
      const idle = !deps.handingOff(row.owner) && await deps.idleNow(row.owner);
      const o: ObligationObs = { delivered: deps.delivered(row), idle, ageMs: row.ageMs };
      const { next, remind, escalate, stalled } = stepObligation(deps.store.get(row.event), o, now);
      const prev = deps.store.get(row.event);
      if (!prev || JSON.stringify(prev) !== JSON.stringify(next)) deps.store.set(row.event, next);
      if (stalled && !stalledNoted.has(row.event)) {
        stalledNoted.add(row.event);
        deps.log.warn({ mod: "obligation-watch", event: row.event, owner: row.owner, ageMin: Math.round(row.ageMs / 60_000) },
          "obligation-watch: 注入 10 分钟未提交 — 只提示, 不判超时");
      }
      if (!stalled) stalledNoted.delete(row.event);
      if (remind) {
        const ok = await deps.remind(row).catch(() => false);
        deps.log[ok ? "info" : "warn"]({ mod: "obligation-watch", event: row.event, owner: row.owner }, ok ? "obligation-watch: 违约提醒 (1/1)" : "obligation-watch: 提醒没投出去");
      }
      if (escalate) {
        await deps.escalate(row).catch((e) => deps.log.warn({ mod: "obligation-watch", err: (e as Error).message }, "obligation-watch: 上报失败"));
        deps.log.warn({ mod: "obligation-watch", event: row.event, owner: row.owner }, "obligation-watch: 义务逾期, 已上报 (1/1)");
      }
    }
  };
  const run = (): void => {
    if (busy) return;
    busy = true;
    void tick()
      .catch((e: unknown) => deps.log.warn({ err: (e as Error).message }, "obligation-watch: 巡检出错"))
      .finally(() => { busy = false; });
  };
  const timer = setInterval(run, 30_000);
  timer.unref?.();
  return () => clearInterval(timer);
};
