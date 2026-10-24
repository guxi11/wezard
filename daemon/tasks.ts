// 定时任务的调度器 —— 到点把一句 prompt 注入某个 wizard 会话, 等价于那一刻有人在
// 群里对它说了这句话, 所以它会真的去做, 产出照常落在群里。pane 死了 injectText 会
// 自己拉起来, 于是「每个工作日晚上 9:30 自动跑」不要求那台机器上一直开着窗口。
//
// 一次放枪固定四段, 本模块只跑这个骨架, 每一段的**具体代码**住在任务文件里
// (shared/task-file.ts):
//
//   trigger → gate → render → dispatch
//   何时      有活吗  填模板   投给谁
//
// 中间那一段是新的, 也是这次重做的理由: 没有 gate 时「有新 trace 才处理」只能写成
// 「到点先起一个 wizard, 让它自己看一眼, 没有就退出」—— 每一次空转都是一个 pane
// 加一份上下文。gate 在 daemon 侧花几秒钱把这件事问清楚, 没活就连气泡都不出。
import type { WSClient } from "@wecom/aibot-node-sdk";
import type { Logger } from "pino";
import type { Config } from "../shared/config.js";
import { baseOfKey, withTagHeader } from "../shared/session-label.js";
import { interpolate } from "../shared/std.js";
import { describeTrigger, isDue, nextFire } from "../shared/trigger.js";
import { type TaskRecord, type TaskState } from "../shared/task-file.js";
import type { TaskRegistry } from "./task-registry.js";
import { runGate } from "./task-gate.js";
import { createKeyedScheduler } from "../shared/keyed-scheduler.js";
import type { ScheduledDispatchOptions, ScheduledResult } from "./scheduled-delivery.js";

const stripPrefix = (s: string): string => {
  const i = s.indexOf(":");
  return i >= 0 ? s.slice(i + 1) : s;
};

// 一条定时的 prompt 本身就在说「建一个 wizard 去干这件事」时, 它要的显然不是
// 在某个已有会话里续 —— 哪怕排班时点了 tag, 那个 tag 也只是「在谁的聊天/目录下
// 办」。这条推断放在 daemon 而不是靠调用方记得传 fresh: 排班的模型换一个就忘了,
// 而这句话的意思一直写在 prompt 里。否定说法 (「不用新建」「无需另起」) 不算。
const SPAWN = "(?:新建|新起|新开|另起|创建|建立|拉起|开|起|建|spawn|create|new)";
const COUNT = "\\s*(?:一|两|二|三|四|五|[0-9]+)?\\s*(?:个|名|只)?\\s*";
const AGENT = "(?:wizard|分身|clone|会话|session)";
const WISH = new RegExp(SPAWN + COUNT + AGENT, "i");
// 否定说法先抹掉再判: 「不用新建 wizard」里的「建 wizard」照样能被 WISH 咬住,
// 单靠 lookbehind 拦不住 —— 它只挡得住整句里最长的那一次匹配。
const NEGATED = new RegExp("(?:不|别|勿|无|免)(?:用|需|要)?\\s*" + SPAWN + COUNT + AGENT, "gi");

export const promptWantsFreshWizard = (prompt: string): boolean => WISH.test(prompt.replace(NEGATED, ""));

/** 一条任务的 `since`: 上次放枪, 没放过就从建表那一刻算 —— 刚建好不立刻打一枪。 */
export const sinceOf = (s: TaskState): number => s.lastFired ?? s.createdAt ?? Date.now();

/** 列表回显: 规格与下次触发都摊成人话, 调用方直接念给用户听。 */
/** 点名的目标到点正忙, 最多顺延这么久 (之后退回起白板执行)。 */
export const TASK_POSTPONE_MS = 30 * 60_000;
/** 安静任务那一轮最长等它跑多久再看终句 —— 超过就不转发了。 */
export const TASK_QUIET_WAIT_MS = 2 * 3600_000;

export const renderTask = (
  t: TaskRecord,
  s: TaskState,
  now: Date = new Date(),
  error?: string,
): Record<string, unknown> => ({
  id: t.id,
  when: describeTrigger(t.trigger),
  next: !t.enabled ? "(已暂停)" : s.pending ? "(等待执行)"
    : t.trigger.clock.kind === "once" && (s.lastFired ?? 0) >= t.trigger.clock.at ? "(已结束)"
      : new Date(nextFire(t.trigger, sinceOf(s), now)).toLocaleString("zh-CN", { hour12: false }),
  lastFired: s.lastFired ? new Date(s.lastFired).toLocaleString("zh-CN", { hour12: false }) : "",
  note: t.note,
  runIn: t.fresh ? "每次新建一个白板 wizard 执行, 跑完自动回收" : "注入已有会话 (它正忙就等它闲下来, 最多 30 分钟)",
  ...(t.quiet ? { quiet: "有事才说: 不预告, 终句只是 QUIET 就不进群" } : {}),
  target: t.target,
  owner: t.owner,
  prompt: t.prompt,
  /** wizard 要改这条定时, 直接 Read/Edit 这个文件。 */
  file: t.file,
  ...(t.hasGate ? { gate: `有 (上一轮: ${s.lastGate ?? "未跑过"})` } : {}),
  ...(s.lastError ? { lastError: s.lastError } : {}),
  ...(s.pending ? { pending: s.pending.phase } : {}),
  ...(error ? { loadError: error } : {}),
});

// ── 调度器 ────────────────────────────────────────────────────────
// 每 20s 一 tick (足够密以捕获整分钟翻转); 去重、补跑窗口、间隔计时全部由
// `isDue(trigger, now, since)` 一个纯函数判定, 这里只负责放枪与记账。
// 记账(lastFired)先于放枪落地, 也先于 gate: 注入失败不重试 —— 一个每 20s 重试的
// 定时任务会在群里刷屏, 比漏跑一次糟得多; 而 gate 说"没活"同样算这一轮过去了,
// 否则它会在整个间隔里被反复叫起来。
interface SchedulerDeps {
  client: WSClient;
  registry: TaskRegistry;
  log: Logger;
  /** 注入一句话到某个 wizard 会话。只有 mirror 模式给得出; 没有它定时任务只能告警。
   *  `taskId` 让被开出的那一轮带上出处 —— 关系视图据此把"这一轮是定时放的枪"
   *  与"人说的话"分开, 否则一条 9:30 自动跑出来的轮次看着和真人发言一模一样。 */
  inject?: (
    target: string,
    text: string,
    opts: ScheduledDispatchOptions,
  ) => Promise<ScheduledResult>;
  /** 目标 wizard 的工作区 —— gate 里 `sh("git log")` 默认就在那儿跑。 */
  cwdOf?: (target: string) => string;
  /** 任务文件没写 target 时投给谁 (排班者那个机器人的 defaultChat)。 */
  fallbackTarget: (t: TaskRecord) => string;
  /** 会话绑定恢复完毕之后才允许投递。 */
  ready?: Promise<void>;
}

const announce = async (client: WSClient, target: string, markdown: string): Promise<void> => {
  await client.sendMessage(stripPrefix(baseOfKey(target)), {
    msgtype: "markdown",
    markdown: { content: withTagHeader(target, markdown) },
  });
};

export const startScheduler = ({ client, registry, log, inject, cwdOf, fallbackTarget, ready }: SchedulerDeps): { stop: () => void; tick: () => void } => {
  const fires = createKeyedScheduler(4);
  // Gates use task slots; only the injection needs the target's exclusive slot.
  const injections = createKeyedScheduler(4);
  // One readiness waiter per target; waiting does not reserve an injection worker.
  const consumers = createKeyedScheduler(Number.MAX_SAFE_INTEGER);
  const inFlight = new Set<string>();
  const stamps = new Map<string, { at: number; previous?: number }>();
  const current = (t: TaskRecord): TaskRecord | undefined => registry.list().find((r) => r.id === t.id && r.instance === t.instance);
  let restored = !ready;
  const recoverUncertain = (t: TaskRecord): void => {
    const s = registry.stateOf(t.id);
    if (s.pending?.phase !== "dispatching" || inFlight.has(t.id)) return;
    // 落盘与 pane 注入不能组成事务。宁可留一轮待核查, 不重放可能已执行的指令。
    registry.patchState(t.id, { pending: undefined, lastFired: Math.max(s.lastFired ?? 0, s.pending.at), lastError: "reload interrupted delivery; outcome unknown, not replayed" });
    log.warn({ id: t.id }, "scheduled delivery interrupted; not replaying uncertain exposure");
  };
  registry.list().forEach(recoverUncertain);
  const finish = (t: TaskRecord, restore = false): void => {
    inFlight.delete(t.id);
    const stamp = stamps.get(t.id);
    stamps.delete(t.id);
    // Cancellation before physical exposure must not consume a once firing.
    if (!current(t)) return;
    if (restore && stamp
      && registry.stateOf(t.id).pending && registry.stateOf(t.id).lastFired === stamp.at) registry.patchState(t.id, { lastFired: stamp.previous });
    if (restore) return;
    const live = current(t)!;
    if (!live.enabled && registry.stateOf(t.id).pending?.phase !== "dispatching") return;
    registry.patchState(t.id, { pending: undefined });
    if (!fires.signal.aborted && live.enabled && t.trigger.clock.kind === "once") registry.remove(t.id);
  };
  const failed = (t: TaskRecord, e: unknown): void => log.error({ id: t.id, err: (e as Error).message }, "scheduled fire failed");
  const prepare = async (t: TaskRecord, target: string, signal: AbortSignal): Promise<string | undefined> => {
    // gate: 有活才继续。没活是**静默**的 —— 它存在的全部意义就是不惊动任何人。
    const st = registry.stateOf(t.id);
    const v = t.hasGate
      ? await runGate({
        file: t.file,
        task: { id: t.id, target, cwd: cwdOf?.(target) ?? "" },
        state: st.memo ?? {},
        timeoutSec: t.gateTimeoutSec,
        log,
      })
      : { go: true, vars: {}, logs: [] as string[] };
    if (signal.aborted || !current(t)?.enabled) return undefined;
    if (v.logs.length) log.info({ id: t.id, logs: v.logs }, "gate log");
    if (!v.go) {
      // 没活是静默的, 但**炸了**必须出声: gate 一坏这条定时就再也不放枪了, 而它
      // 每一轮的沉默看起来和"今天没活"一模一样 —— 最坏的失败是看不见的失败。
      // 只在由好转坏的那一次说, 否则一个坏 gate 会按间隔刷屏。
      const first = v.error && st.lastGate !== "error";
      registry.patchState(t.id, {
        lastGate: v.error ? "error" : "skip",
        lastGateAt: Date.now(),
        lastError: v.error,
        ...(v.state ? { memo: v.state } : {}),
        pending: undefined,
      });
      log.info({ id: t.id, err: v.error }, v.error ? "task gate errored, holding fire" : "task gate said no, holding fire");
      if (first) {
        await announce(client, target, `⏰ 定时任务 \`${t.id}\` 的 gate 出错, 本轮未放枪 (下次照常重试):\n> ${v.error!.split("\n")[0]!.slice(0, 200)}\n修它: \`${t.file}\``)
          .catch(() => {});
      }
      return undefined;
    }
    registry.patchState(t.id, {
      lastGate: "go", lastGateAt: Date.now(), lastError: undefined,
      ...(v.state ? { memo: v.state } : {}),
      pending: { at: st.pending!.at, phase: "ready", prompt: interpolate(t.prompt, v.vars) },
    });
    return interpolate(t.prompt, v.vars);
  };
  const fire = async (t: TaskRecord, signal: AbortSignal): Promise<boolean> => {
    const target = t.target || fallbackTarget(t);
    if (!inject) { log.warn({ id: t.id, target }, "scheduled task skipped: not in mirror mode"); return false; }
    if (!target) { log.warn({ id: t.id }, "scheduled task skipped: no target"); return false; }
    const pending = registry.stateOf(t.id).pending;
    const prompt = pending?.phase === "ready" ? pending.prompt : await prepare(t, target, signal);
    if (prompt === undefined || signal.aborted) return false;
    // 先 announce 后注入: 被唤醒的 wizard 接下来在群里说的话才有出处, 否则群里凭空
    // 冒出一轮对话, 没人知道是谁点的火。
    const how = t.fresh ? " · 新建 wizard 执行" : "";
    // 安静任务不预告: 「有事才说」, 预告本身就是一句没事也说的话。
    const resource = t.fresh ? `fresh:${t.id}` : target;
    let leg = 0;
    const sent = consumers.schedule(t.id, resource, async (dispatchSignal) => {
      const guard = () => !dispatchSignal.aborted && current(t)?.enabled === true;
      if (!guard()) return undefined;
      if (!t.quiet) await announce(client, target, `⏰ **定时任务** · ${describeTrigger(t.trigger)}${how}\n> ${prompt.split("\n")[0]!.slice(0, 120)}`)
        .catch((e: unknown) => log.warn({ id: t.id, err: (e as Error).message }, "task announce failed"));
      if (!guard()) return undefined;
      return inject(target, prompt, {
        taskId: t.id, fresh: t.fresh, quiet: t.quiet, signal: dispatchSignal, guard,
        submit: async (action) => {
          const r = await injections.schedule(`${t.id}:${++leg}`, resource, async () => {
            if (!guard()) return { ok: false, reason: "scheduled delivery withdrawn", retryable: true };
            const pending = registry.stateOf(t.id).pending!;
            registry.patchState(t.id, { pending: { ...pending, phase: "dispatching" } });
            const result = await action();
            if (!result.ok && result.retryable && !result.uncertain && current(t)) {
              registry.patchState(t.id, { pending: { ...pending, phase: "ready" } });
            }
            return result;
          });
          return r ?? { ok: false, reason: "scheduler stopped", retryable: true };
        },
      });
    });
    if (!sent) return false;
    // Do not retain a gate worker while this target waits for its injection slot.
    let restoreAfterStop = false;
    void sent.then(async (r) => {
      const withdrawn = signal.aborted || !current(t)?.enabled
        || r?.reason === "scheduled delivery withdrawn";
      restoreAfterStop = withdrawn && (!r || (!r.ok && r.retryable === true && !r.uncertain));
      if (!r || signal.aborted) return;
      log.info({ id: t.id, target, ok: r.ok, reason: r.reason }, "scheduled task fired");
      if (!r.ok) await announce(client, target, `⏰ 定时任务注入失败:${r.reason ?? "unknown"}`).catch(() => {});
    }).catch((e: unknown) => failed(t, e)).finally(() => finish(t, restoreAfterStop));
    return true;
  };

  const tick = (): void => {
    if (fires.signal.aborted || !restored) return;
    registry.list().forEach(recoverUncertain);
    const now = new Date();
    const due = registry.list().filter((t) => t.enabled && !inFlight.has(t.id)
      && (registry.stateOf(t.id).pending || isDue(t.trigger, now, sinceOf(registry.stateOf(t.id)))));
    if (!due.length) return;
    for (const t of due) {
      inFlight.add(t.id);
      const fired = fires.schedule(t.id, t.id, async (signal) => {
        if (!current(t)?.enabled) { inFlight.delete(t.id); return true; }
        // Stamp on start: stop must not consume once-tasks still in the queue.
        const at = Date.now();
        stamps.set(t.id, { at, previous: registry.stateOf(t.id).lastFired });
        registry.patchState(t.id, { lastFired: at, pending: registry.stateOf(t.id).pending ?? { at, phase: "gate" } });
        return fire(t, signal);
      });
      void fired?.then((handedToInjection) => { if (!handedToInjection) finish(t, fires.signal.aborted); })
        .catch((e: unknown) => { failed(t, e); finish(t); });
    }
  };
  const timer = setInterval(tick, 20_000);
  if (ready) void ready.then(() => { restored = true; tick(); }).catch((e: unknown) => log.error({ err: (e as Error).message }, "task restore failed"));
  return { tick, stop: () => { clearInterval(timer); fires.stop(); consumers.stop(); injections.stop(); } };
};
