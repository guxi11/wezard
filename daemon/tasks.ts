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
import { patchJsonc } from "../shared/config-writer.js";
import { baseOfKey, withTagHeader } from "../shared/session-label.js";
import { interpolate } from "../shared/std.js";
import { describeTrigger, isDue, nextFire, triggerOfLegacyWhen } from "../shared/trigger.js";
import { slugify, uniqueId, type TaskRecord, type TaskState } from "../shared/task-file.js";
import type { TaskRegistry } from "./task-registry.js";
import { runGate } from "./task-gate.js";

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
export const renderTask = (
  t: TaskRecord,
  s: TaskState,
  now: Date = new Date(),
  error?: string,
): Record<string, unknown> => ({
  id: t.id,
  when: describeTrigger(t.trigger),
  next: t.enabled ? new Date(nextFire(t.trigger, sinceOf(s), now)).toLocaleString("zh-CN", { hour12: false }) : "(已暂停)",
  lastFired: s.lastFired ? new Date(s.lastFired).toLocaleString("zh-CN", { hour12: false }) : "",
  note: t.note,
  runIn: t.fresh ? "每次新建一个白板 wizard 执行, 跑完自动回收" : "注入已有会话",
  target: t.target,
  prompt: t.prompt,
  /** wizard 要改这条定时, 直接 Read/Edit 这个文件。 */
  file: t.file,
  ...(t.hasGate ? { gate: `有 (上一轮: ${s.lastGate ?? "未跑过"})` } : {}),
  ...(s.lastError ? { lastError: s.lastError } : {}),
  ...(error ? { loadError: error } : {}),
});

// ── 迁移 ──────────────────────────────────────────────────────────
/** 1.5 之前定时住在 config.jsonc 的 `schedules` 数组里。就地抬成任务文件, 抬完清表
 *  —— 两处都留着会放两次枪。 */
export const migrateLegacySchedules = (
  cfg: Config,
  sourcePath: string,
  registry: TaskRegistry,
  log: Logger,
): number => {
  if (!cfg.schedules.length) return 0;
  const taken = registry.takenIds();
  const moved = cfg.schedules.map((s) => {
    const id = uniqueId(slugify(s.note || s.prompt.slice(0, 24), `task-${s.id}`), taken);
    taken.add(id);
    const r = registry.create({
      id,
      trigger: triggerOfLegacyWhen(s.when),
      prompt: s.prompt,
      target: s.target,
      fresh: s.fresh,
      note: s.note,
      createdBy: s.createdBy,
    });
    if ("error" in r) { log.warn({ old: s.id, err: r.error }, "schedule migration failed"); return 0; }
    if (s.lastFired) registry.patchState(id, { lastFired: s.lastFired, createdAt: s.createdAt });
    else registry.patchState(id, { createdAt: s.createdAt || Date.now() });
    return 1;
  }).reduce<number>((a, b) => a + b, 0);
  cfg.schedules = [];
  patchJsonc(sourcePath, [{ path: ["schedules"], value: [] }]);
  log.info({ moved, dir: registry.dir }, "schedules migrated to task files");
  return moved;
};

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
    opts: { taskId: string; fresh: boolean },
  ) => Promise<{ ok: boolean; reason?: string }>;
  /** 目标 wizard 的工作区 —— gate 里 `sh("git log")` 默认就在那儿跑。 */
  cwdOf?: (target: string) => string;
  /** 任务文件没写 target 时投给谁 (defaultChat)。 */
  fallbackTarget: () => string;
}

const announce = async (client: WSClient, target: string, markdown: string): Promise<void> => {
  await client.sendMessage(stripPrefix(baseOfKey(target)), {
    msgtype: "markdown",
    markdown: { content: withTagHeader(target, markdown) },
  });
};

export const startScheduler = ({ client, registry, log, inject, cwdOf, fallbackTarget }: SchedulerDeps): { stop: () => void } => {
  const fire = async (t: TaskRecord): Promise<void> => {
    const target = t.target || fallbackTarget();
    if (!inject) { log.warn({ id: t.id, target }, "scheduled task skipped: not in mirror mode"); return; }
    if (!target) { log.warn({ id: t.id }, "scheduled task skipped: no target"); return; }

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
      });
      log.info({ id: t.id, err: v.error }, v.error ? "task gate errored, holding fire" : "task gate said no, holding fire");
      if (first) {
        await announce(client, target, `⏰ 定时任务 \`${t.id}\` 的 gate 出错, 本轮未放枪 (下次照常重试):\n> ${v.error!.split("\n")[0]!.slice(0, 200)}\n修它: \`${t.file}\``)
          .catch(() => {});
      }
      return;
    }
    registry.patchState(t.id, {
      lastGate: "go", lastGateAt: Date.now(), lastError: undefined,
      ...(v.state ? { memo: v.state } : {}),
    });

    const prompt = interpolate(t.prompt, v.vars);
    // 先 announce 后注入: 被唤醒的 wizard 接下来在群里说的话才有出处, 否则群里凭空
    // 冒出一轮对话, 没人知道是谁点的火。
    const how = t.fresh ? " · 新建 wizard 执行" : "";
    await announce(client, target, `⏰ **定时任务** · ${describeTrigger(t.trigger)}${how}\n> ${prompt.split("\n")[0]!.slice(0, 120)}`)
      .catch((e: unknown) => log.warn({ id: t.id, err: (e as Error).message }, "task announce failed"));
    const r = await inject(target, prompt, { taskId: t.id, fresh: t.fresh });
    log.info({ id: t.id, target, ok: r.ok, reason: r.reason }, "scheduled task fired");
    if (!r.ok) await announce(client, target, `⏰ 定时任务注入失败:${r.reason ?? "unknown"}`).catch(() => {});
  };

  const tick = async (): Promise<void> => {
    const now = new Date();
    const due = registry.list().filter((t) => t.enabled && isDue(t.trigger, now, sinceOf(registry.stateOf(t.id))));
    if (!due.length) return;
    const firedAt = now.getTime();
    for (const t of due) registry.patchState(t.id, { lastFired: firedAt });
    for (const t of due) {
      try {
        await fire(t);
      } catch (e) {
        log.error({ id: t.id, err: (e as Error).message }, "scheduled fire failed");
      }
      // once 放完这一枪就没有下一枪了, 留着只会让列表越来越脏。
      if (t.trigger.clock.kind === "once") registry.remove(t.id);
    }
  };
  const timer = setInterval(() => { void tick(); }, 20_000);
  return { stop: () => clearInterval(timer) };
};
