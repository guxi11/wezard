// 交接 (handoff): 一个 wizard 把工作压成简报, 换一个全新的会话接着干 —— 同一个 target、
// 同一个名字, 新的 sid、新的 pane。
//
// 身份、工单、日程、名册信箱都挂在 target / 名字上, 换会话碰不到它们; 会断的是那些
// 隐含着「这个会话」的东西:
//   - 回执的**答方**: 欠着别人的那一句, 答案要么已经在旧 transcript 里 (换了会话
//     replyFor 就读不到了), 要么还没答 —— 义务得跟着简报转进新会话, 而不是把简报那
//     一轮的回复错当成回执;
//   - 回执的**发方**与一切注入: 重开的那几秒 pane 是死的, 此刻投进来的话要么被当成
//     "发话方已经不在"丢掉, 要么 resume 回旧 sid, 要么抢在简报前面成了新会话的开场白;
//   - 交接本身: 旧实现是一段纯内存的 async, reload 落在「杀了旧 pane、还没贴回简报」
//     之间, 新会话就空着醒来, 简报没了。
// 所以这里做三件事: 交接期间立一道闸 (`handingOff` / `handedOff`), 闸内一切注入都等;
// 在旧会话还在的那一刻把欠着的回执清点完 (receipts.transfer); 每一步落盘, boot 时
// 从断点接着做。
import type { Logger } from "pino";
import type { JsonMap } from "../shared/json-map-store.js";
import { waitForIdle } from "./graph.js";
import type { Receipts, Slot } from "./receipts.js";

// ── 闸 ──────────────────────────────────────────────────────────────
// 进程级的单例: 人话的入口 (inbound) 在 mirror 块之前就装好了, 拿不到这里的实例。
const gates = new Map<string, Promise<void>>();

/** 这个 wizard 正在交接。 */
export const handingOff = (target: string): boolean => gates.has(target);

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

/** 简报贴回新会话时要挂的那些信封: 交接时还欠着回执的发话方。 */
export interface Owe {
  from: string;
  channel: string;
  /** 那件活的件号 —— 新会话贴回简报那一句照样挂上, 回执仍按它定位。 */
  turn?: string;
}

export interface Pending {
  target: string;
  /** self = 简报由它自己写在入参里; other = 守护进程让它写。 */
  mode: "self" | "other";
  /** 发起交接的时刻 —— 自我交接时, 在它之前就收口的那一轮才算旧会话答过。 */
  at: number;
  /** 交接前的 sid: reload 后据它分辨「重开」做没做完。 */
  sid: string;
  /** waiting: 等它停下 · briefing: 已请它写简报 (other) · restarting: 已清点回执、正在重开 ·
   *  restarted: 新会话已起, 待贴回简报。 */
  stage: "waiting" | "briefing" | "restarting" | "restarted";
  brief?: string;
  focus?: string;
  owe?: Owe[];
  timeoutMs: number;
}

export interface HandoffDeps {
  isBusy: (target: string) => Promise<boolean>;
  sessionId: (target: string) => string;
  /** 杀旧 pane、起新进程 (同名 / cwd / 模型 / charter)。 */
  restart: (target: string) => Promise<{ ok: boolean; reason?: string }>;
  /** 往会话里贴一段话; `owe` 非空时挂上那些发话方的信封。 */
  inject: (target: string, text: string, owe: readonly Owe[]) => Promise<{ ok: boolean; reason?: string }>;
  lastText: (target: string) => string;
  /** `from` 那一句在 `to` 的**当前** transcript 里, `untilMs` 之前就收口的答案 (见
   *  peers.replyClosedBefore); 定位不到问话 → undefined。 */
  answeredBefore: (to: string, from: string, sinceMs: number, untilMs: number, turn?: string) => string | undefined;
  receipts: Receipts;
  /** 交接没做成时告诉**它自己** (下一条进它会话的话尾巴上捎带)。生命周期事件不进群。 */
  notify: (target: string, text: string) => void;
  log: Logger;
  store?: JsonMap<Pending>;
  /** 简报贴回成功后把它留档 (情景记忆): 新会话第一条消息之外, 简报原本无处可寻。 */
  archive?: (e: { target: string; mode: Pending["mode"]; at: number; sid: string; nextSid: string; brief: string }) => void;
}

export type HandoffResult = { ok: true; brief: string } | { ok: false; status: number; reason: string; brief?: string };

export interface Handoffs {
  /** 自我交接: 立刻返回, 等它这一轮说完再动手。 */
  self: (target: string, brief: string) => { ok: boolean; reason?: string };
  /** 交接别人: 等到简报贴回新会话才返回。 */
  other: (target: string, focus: string, timeoutMs: number) => Promise<HandoffResult>;
  /** 把落盘里没做完的交接接着做。须在 receipts.resume 之前调: 闸要先立起来。 */
  resume: () => number;
}

const SELF_IDLE_MS = 10 * 60_000;

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
  const save = (p: Pending): void => void deps.store?.set(p.target, p);
  const drop = (p: Pending): void => deps.store?.drop(p.target);
  const fail = (p: Pending, status: number, reason: string): HandoffResult => {
    drop(p);
    deps.log.warn({ mod: "handoff", target: p.target, stage: p.stage, reason }, "handoff: 放弃");
    if (p.mode === "self") deps.notify(p.target, `上下文交接没做成: ${reason}`);
    return { ok: false, status, reason, ...(p.brief ? { brief: p.brief } : {}) };
  };
  const idle = (p: Pending, ms: number) => waitForIdle(p.target, deps.isBusy, ms, () => false);

  /** 一步一步推到底; 每一步先落盘再动手, reload 后从 `stage` 接着来。 */
  const step = async (p: Pending): Promise<HandoffResult> => {
    switch (p.stage) {
      case "waiting": {
        // 两种交接都先等它停下: 自我交接要等它把调用这一轮说完; 交接别人时, 简报的
        // 请求排在它手头那一轮后面的话, 它答别人的那段与简报会挤在一起分不开。
        const w = await idle(p, p.mode === "self" ? SELF_IDLE_MS : p.timeoutMs);
        if (!w.idle) return fail(p, 504, `一直没能闲下来 (${w.reason}), 上下文没动`);
        if (p.mode === "self") return step({ ...p, stage: "restarting" });
        const r = await deps.inject(p.target, briefPrompt(p.focus), []);
        if (!r.ok) return fail(p, 502, `summary inject failed: ${r.reason}`);
        return step(saved({ ...p, stage: "briefing" }));
      }
      case "briefing": {
        const w = await idle(p, p.timeoutMs);
        const brief = deps.lastText(p.target);
        // 没等到 idle 就不能重开 —— 那会丢掉这次还在生成的交接总结。
        if (!w.idle) return fail(p, 504, `target still working: ${w.reason}; not restarting to avoid losing the turn`);
        if (!brief.trim()) return fail(p, 502, "target produced no summary text");
        return step({ ...p, brief, stage: "restarting" });
      }
      case "restarting": {
        // reload 落在重开中途: sid 已经换了就是做完了, 别再杀一次新会话。
        if (deps.sessionId(p.target) !== p.sid) return step(saved({ ...p, stage: "restarted" }));
        // 旧会话此刻还在: 欠着的回执就在这里清点 —— 一重开, 旧 transcript 就再也读不到了。
        // 自我交接只认调用之前就收口的那些轮 (调用这一轮的收尾话不是答案); 交接别人时
        // 简报那一句已把它之前的每一轮都关上了。
        const until = p.mode === "self" ? p.at : Number.MAX_SAFE_INTEGER;
        const carried = deps.receipts.transfer(
          p.target,
          (s: Slot) => deps.answeredBefore(p.target, s.from, s.at, until, s.turn) ?? "",
          Date.now(),
        );
        const next = saved({ ...p, stage: "restarting", owe: carried.map((s) => ({ from: s.from, channel: s.channel, ...(s.turn ? { turn: s.turn } : {}) })) });
        const r = await deps.restart(p.target);
        if (!r.ok) return fail(next, 502, `/new failed: ${r.reason ?? "unknown"}`);
        return step(saved({ ...next, stage: "restarted" }));
      }
      case "restarted": {
        const r = await deps.inject(p.target, carryOf(p), p.owe ?? []);
        drop(p);
        deps.log.info({ mod: "handoff", target: p.target, ok: r.ok, reason: r.reason, owe: p.owe?.length ?? 0 }, "handoff: 简报已贴回");
        if (!r.ok) return fail(p, 502, `handoff carry inject failed: ${r.reason}`);
        try {
          deps.archive?.({ target: p.target, mode: p.mode, at: p.at, sid: p.sid, nextSid: deps.sessionId(p.target), brief: p.brief ?? "" });
        } catch (e) { deps.log.warn({ mod: "handoff", target: p.target, err: (e as Error).message }, "handoff: 简报留档失败"); }
        return { ok: true, brief: p.brief ?? "" };
      }
    }
  };
  const saved = (p: Pending): Pending => (save(p), p);

  /** 闸立在整场交接上: 发起之后进来的话 (人、同伴、回执、日程) 都进新会话。 */
  const run = (p: Pending): Promise<HandoffResult> => {
    const release = hold(p.target);
    return step(p)
      .catch((e: unknown) => fail(p, 500, (e as Error).message))
      .finally(release);
  };

  const begin = (target: string, mode: Pending["mode"], extra: Partial<Pending>): Pending | undefined =>
    handingOff(target)
      ? undefined
      : saved({ target, mode, at: Date.now(), sid: deps.sessionId(target), stage: "waiting", timeoutMs: SELF_IDLE_MS, ...extra });

  return {
    self: (target, brief) => {
      const p = begin(target, "self", { brief });
      if (!p) return { ok: false, reason: "已经在交接中" };
      void run(p);
      return { ok: true };
    },
    other: async (target, focus, timeoutMs) => {
      const p = begin(target, "other", { focus, timeoutMs });
      if (!p) return { ok: false, status: 409, reason: "它已经在交接中" };
      return run(p);
    },
    resume: () => {
      const open = Object.values(deps.store?.all() ?? {});
      open.forEach((p) => void run(p));
      if (open.length) deps.log.info({ mod: "handoff", resumed: open.map((p) => `${p.target}@${p.stage}`) }, "handoff: reload 后续做");
      return open.length;
    },
  };
};
