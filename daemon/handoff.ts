// 交接 (handoff): 一个 wizard 把工作压成简报, 换一个全新的上下文接着干 —— 同一个 target
// 与名字。普通交接沿用 pane/CLI 并原生 /clear; 有 pending workspace 时启动新 CLI 进程。
//
// 身份、工单、日程、名册信箱都挂在 target / 名字上, 换会话碰不到它们; 会断的是那些
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
import type { Logger } from "pino";
import type { JsonMap } from "../shared/json-map-store.js";
import { sleep } from "../shared/std.js";
import { waitForIdle } from "./graph.js";
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
  /** waiting: 等它停下 · briefing: 已请它写简报 (other) · restarting: 正在重开 (已不再清点
   *  回执, 欠账由路由表兜着) · restarted: 新会话已起, 待贴回简报 · resuming: 简报已贴回,
   *  正逐笔续答它还欠着的那些 (reload 落在这里就重放一次, 注入幂等不会重复催)。 */
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
  /** 简报贴回成功后把它留档 (情景记忆): 新会话第一条消息之外, 简报原本无处可寻。 */
  archive?: (e: { target: string; mode: Pending["mode"]; at: number; sid: string; nextSid: string; brief: string }) => void;
}

export type HandoffResult = { ok: true; brief: string } | { ok: false; status: number; reason: string; brief?: string };

export interface Handoffs {
  /** 自我交接: 立刻返回, 等它这一轮说完再动手。 */
  self: (target: string, brief: string) => { ok: boolean; reason?: string };
  /** 交接别人: 等到简报贴回新会话才返回。`extra.announce` = 重开时发「📂 当前项目」气泡。 */
  other: (target: string, focus: string, timeoutMs: number, extra?: { announce?: boolean }) => Promise<HandoffResult>;
  /** 把落盘里没做完的交接接着做。须在注入队列 resume 之前调: 闸要先立起来。 */
  resume: () => number;
  /** 切断那一轮的终句被扣下了 (`cuttingTurn` 为真时): 记在这场交接上, 失败时补投。 */
  cut: (target: string, event: string) => void;
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
  /** 每场交接扣下的终句: step 一路传的是不可变快照, 扣下发生在它之外 —— 记在这里, 落盘时并进去。 */
  const cuts = new Map<string, readonly string[]>();
  const withCut = (p: Pending): Pending => { const c = cuts.get(p.target); return c?.length ? { ...p, cut: [...c] } : p; };
  const save = (p: Pending): void => void deps.store?.set(p.target, withCut(p));
  const drop = (p: Pending): void => { cuts.delete(p.target); deps.store?.drop(p.target); };
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
  const idle = (p: Pending, ms: number) => waitForIdle(p.target, deps.isBusy, ms, () => false);

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
    if (done) drop(p);
  };

  /** 一步一步推到底; 每一步先落盘再动手, reload 后从 `stage` 接着来。 */
  const step = async (p: Pending): Promise<HandoffResult> => {
    save(p);
    if (p.mode === "self" && !p.failure?.compensated && p.cut?.length) deps.suppress?.(p.cut);
    if (p.failure) return fail(p, p.failure.status, p.failure.reason);
    switch (p.stage) {
      case "waiting": {
        // 两种交接都先等它停下: 自我交接要等它把调用这一轮说完; 交接别人时, 简报的
        // 请求排在它手头那一轮后面的话, 它答别人的那段与简报会挤在一起分不开。
        const w = await idle(p, p.mode === "self" ? SELF_IDLE_MS : p.timeoutMs);
        if (!w.idle) return fail(p, 504, `一直没能闲下来 (${w.reason}), 上下文没动`);
        if (p.mode === "self") return step({ ...p, stage: "restarting" });
        // 守护进程请它写简报, 不是谁在群里问的: 私聊。
        const r = await deps.inject(p.target, briefPrompt(p.focus), "", `handoff:${p.target}:${p.at}:summary`, p.timeoutMs);
        if (!r.ok) return fail(p, 502, `summary inject failed: ${r.reason}`);
        return step(saved({ ...p, stage: "briefing" }));
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
      .finally(() => { cutting.delete(p.target); release(); });
  };

  const begin = (target: string, mode: Pending["mode"], extra: Partial<Pending>): Pending | undefined =>
    (handingOff(target) || !!deps.store?.get(target))
      ? undefined
      : saved({ target, mode, at: Date.now(), sid: deps.sessionId(target), stage: "waiting", timeoutMs: SELF_IDLE_MS, channel: mode === "self" ? deps.channelOf(target) : "", ...extra });

  return {
    self: (target, brief) => {
      const p = begin(target, "self", { brief, cut: [...(deps.currentEvents?.(target) ?? [])] });
      if (!p) return { ok: false, reason: "已有交接记录 (可能失败待核查), 不重复清空" };
      void run(p);
      return { ok: true };
    },
    other: async (target, focus, timeoutMs, extra) => {
      const p = begin(target, "other", { focus, timeoutMs, ...extra });
      if (!p) return { ok: false, status: 409, reason: "已有交接记录 (可能失败待核查), 不重复清空" };
      return run(p);
    },
    resume: () => {
      const open = Object.values(deps.store?.all() ?? {}).filter((p) => !p.failure || !p.failure.compensated);
      open.forEach((p) => void run(p));
      if (open.length) deps.log.info({ mod: "handoff", resumed: open.map((p) => `${p.target}@${p.stage}`) }, "handoff: reload 后续做");
      return open.length;
    },
    cut: (target, event) => {
      const p = deps.store?.get(target);
      if (deps.store && !p) throw new Error("handoff transaction unavailable; refusing non-durable final suppression");
      const cut = [...new Set([...(p?.cut ?? []), ...(cuts.get(target) ?? []), event])];
      // 先保存事务凭证, 再发布内存切断状态; 写失败后的重试也必须重新尝试落盘。
      if (p) deps.store!.set(target, { ...p, cut });
      cuts.set(target, cut);
    },
  };
};
