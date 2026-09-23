// 一条定时任务 = 一份**可注入代码的配置**: `~/.wezard/tasks/<id>.task.mjs`。
//
// 为什么是文件而不是 config 里的一行记录: 定时任务天生是「到点跑一段逻辑」, 而
// 逻辑写不进 json。旧形状里 wizard 只能通过人话解析器间接碰到「什么时候」, 碰不到
// 的说法就做不到; 「放枪前先看一眼有没有活」更是完全无处安放, 只能到点先起一个
// wizard 再让它自己判断要不要干 —— 每一次空转都是一个 pane 加一份上下文。
//
// 现在这份文件就是配置本身: wizard 用 Read/Edit 直接改它, 存盘即生效。它导出四件
// 事, 每一件都可以被单独替换 (Strategy):
//
//   when    何时放枪 —— 人话, 或 helpers 组合出的规约 (shared/trigger.ts)
//   gate    放枪前的检查 (可选) —— 有副作用、可以跑命令; 返回 false 这一轮就不放
//   prompt  到点说给 wizard 听的话, `{{var}}` 由 gate 填
//   target/fresh  在谁的聊天/目录下办, 是否每次新起一个白板 wizard
//
// 本模块只做纯的那一半: 形状、校验、模板渲染、路径。加载与执行在 daemon/。
import { basename, join } from "node:path";
import type { Trigger, TriggerHelpers } from "./trigger.js";
import { describeTrigger, toTrigger } from "./trigger.js";

export const TASKS_DIR = "~/.wezard/tasks";
export const TASK_EXT = ".task.mjs";

/** gate 拿到的环境。`sh` 的 cwd 默认就是这条任务目标 wizard 的工作区。 */
export interface TaskContext {
  now: Date;
  task: { id: string; target: string; cwd: string };
  /** 跑一条 shell 命令, 返回 stdout。非零退出抛错 (gate 抛错 = 这一轮不放枪)。 */
  sh: (cmd: string, opts?: { cwd?: string; timeoutSec?: number }) => Promise<string>;
  /** 上一次 gate 留下的东西 —— 「上次拉到哪个 trace」这类跨轮记忆放这里。 */
  state: Record<string, unknown>;
  log: (msg: unknown) => void;
}

/** `false` = 这一轮不放枪; `true`/无返回 = 放; 对象 = 放, 并带上模板变量与新状态。 */
export type GateResult =
  | boolean
  | void
  | { go?: boolean; vars?: Record<string, unknown>; state?: Record<string, unknown> };

/** 任务文件 `export default` 的形状。 */
export interface TaskModule {
  when: string | Trigger | ((h: TriggerHelpers) => Trigger);
  prompt: string;
  note?: string;
  /** 在谁的聊天/目录下办。省略 = 排班时那个 wizard。 */
  target?: string;
  /** true = 每次到点新起一个白板 wizard 执行, 跑完回收。 */
  fresh?: boolean;
  /** false = 留着文件但不再放枪 (暂停)。 */
  enabled?: boolean;
  gate?: (ctx: TaskContext) => GateResult | Promise<GateResult>;
  gateTimeoutSec?: number;
  createdBy?: string;
}

/** 规范化之后的一条任务 —— registry 与调度器只认这个形状。 */
export interface TaskRecord {
  id: string;
  file: string;
  trigger: Trigger;
  when: string;
  prompt: string;
  note: string;
  target: string;
  fresh: boolean;
  enabled: boolean;
  hasGate: boolean;
  gateTimeoutSec: number;
  createdBy: string;
}

/** 运行时状态。任务文件是源码 (人与 AI 写), 状态由 daemon 写 —— 两者不混住一个文件。 */
export interface TaskState {
  /** 建表那一刻。第一次 isDue 的 `since` —— 刚建好的任务不立刻打一枪。 */
  createdAt?: number;
  lastFired?: number;
  /** 上一轮 gate 的去向, 只为回显: go = 放了, skip = 被 gate 挡下, error = gate 炸了。 */
  lastGate?: "go" | "skip" | "error";
  lastGateAt?: number;
  lastError?: string;
  /** gate 自己攒的跨轮记忆。 */
  memo?: Record<string, unknown>;
}

const DEFAULT_GATE_TIMEOUT = 120;

export const taskIdOfFile = (file: string): string => basename(file).replace(/\.task\.mjs$/, "");
export const fileOfTaskId = (dir: string, id: string): string => join(dir, `${id}${TASK_EXT}`);

/** 文件名即 id, 所以它必须既好认又能当路径。 */
export const slugify = (raw: string, fallback: string): string => {
  const s = raw.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").slice(0, 24).replace(/^-+|-+$/g, "");
  return s || fallback;
};

export const uniqueId = (want: string, taken: ReadonlySet<string>): string =>
  taken.has(want) ? [...Array(99).keys()].map((i) => `${want}-${i + 2}`).find((c) => !taken.has(c)) ?? `${want}-${Date.now() % 1000}` : want;

/** 模块 → 记录。认不出的 when / 空 prompt 在这里被挡住, 连带一句人话的理由。 */
export const normalizeTask = (
  mod: unknown,
  id: string,
  file: string,
  now: Date = new Date(),
): { ok: true; task: TaskRecord } | { ok: false; reason: string } => {
  if (!mod || typeof mod !== "object") return { ok: false, reason: "任务文件要 `export default { when, prompt }`" };
  const m = mod as TaskModule;
  const prompt = (m.prompt ?? "").toString().trim();
  if (!prompt) return { ok: false, reason: "prompt 不能为空" };
  const tr = toTrigger(m.when, now);
  if (!tr.ok) return { ok: false, reason: tr.reason };
  return {
    ok: true,
    task: {
      id,
      file,
      trigger: tr.trigger,
      when: describeTrigger(tr.trigger),
      prompt,
      note: (m.note ?? "").toString(),
      target: (m.target ?? "").toString(),
      fresh: m.fresh !== false,
      enabled: m.enabled !== false,
      hasGate: typeof m.gate === "function",
      gateTimeoutSec: Math.max(5, Math.min(900, m.gateTimeoutSec ?? DEFAULT_GATE_TIMEOUT)),
      createdBy: (m.createdBy ?? "").toString(),
    },
  };
};

// ── 生成 ────────────────────────────────────────────────────────────
const js = (s: string): string => JSON.stringify(s);

/** 人话 → 源码里那一行 `when`。认出来是什么就写什么, 别把原话塞进去 ——
 *  「20 分钟后」在下一次 reload 时会重新往后数 20 分钟。 */
const renderWhen = (tr: Trigger): string => {
  const guards = tr.guards.map((g) =>
    g.kind === "between" ? `between("${String(g.from.hour).padStart(2, "0")}:${String(g.from.minute).padStart(2, "0")}", "${String(g.to.hour).padStart(2, "0")}:${String(g.to.minute).padStart(2, "0")}")`
      : g.kind === "onDays" ? `onDays(${JSON.stringify(g.days)})`
        : `not(/* ${g.kind} */)`,
  );
  const c = tr.clock;
  const clock = c.kind === "every" ? `every(${c.minutes})`
    : c.kind === "once" ? `at(${c.at})`
      : `daily(${c.times.map((t) => `"${String(t.hour).padStart(2, "0")}:${String(t.minute).padStart(2, "0")}"`).join(", ")})`;
  const helpers = [
    ...(guards.length ? ["and"] : []),
    ...(c.kind === "every" ? ["every"] : c.kind === "once" ? ["at"] : ["daily"]),
    ...new Set(tr.guards.map((g) => (g.kind === "between" ? "between" : g.kind === "onDays" ? "onDays" : "not"))),
  ];
  const body = guards.length ? `and(${clock}, ${guards.join(", ")})` : clock;
  return `({ ${helpers.join(", ")} }) => ${body}`;
};

export interface TaskDraft {
  id: string;
  trigger: Trigger;
  prompt: string;
  target: string;
  fresh: boolean;
  note: string;
  createdBy: string;
}

/**
 * 新任务的源码。头上那段注释是 wizard 唯一的说明书 —— 它 Read 这个文件时看到的
 * 就是这些, 所以写全: 能改什么、gate 拿得到什么、改完要不要重启 (不要)。
 */
export const renderTaskFile = (d: TaskDraft): string => `// wezard 定时任务 · ${d.id}
// 这份文件**就是配置**: 直接改, 存盘即生效 (守护进程盯着这个目录, 不用 reload)。
//
//   when   何时放枪。人话 ("每个工作日晚上9:30") 或组合:
//            every("1h") | daily("09:00","18:00") | at(<epoch ms>)   ← 产生时刻
//            between("08:00","20:00") | onDays("工作日") | not(…)     ← 只做筛选
//            and(every("1h"), between("08:00","20:00"))              ← 时钟 ∧ 筛子
//   gate   放枪前的检查, 可选。**没拉到活就别惊动 wizard** 用它:
//            返回 false        → 这一轮不放枪 (不起 wizard, 群里也不出声)
//            返回 { vars }     → 放枪, vars 填进 prompt 里的 {{名字}}
//            返回 { state }    → 存下来, 下一轮从 ctx.state 拿得到
//          ctx = { now, task:{id,target,cwd}, sh(cmd), state, log }
//          sh 的 cwd 默认是目标 wizard 的工作区; 抛错等同于返回 false。
//   prompt 到点说给 wizard 听的话。写成零上下文也能执行的完整指令 —— 到点接活的
//          多半是个刚出生的白板 wizard, 它只看得见这一句。
//
// 停掉这条任务: enabled: false (留档), 或直接删掉本文件。
export default {
  note: ${js(d.note)},
  target: ${js(d.target)},
  fresh: ${d.fresh},
  enabled: true,
  createdBy: ${js(d.createdBy)},

  when: ${renderWhen(d.trigger)},

  // gate: async ({ sh, state, log }) => {
  //   const out = await sh("git fetch -q && git log --oneline HEAD..@{u}");
  //   if (!out.trim()) return false;            // 没新东西 → 这一轮不放枪
  //   return { vars: { commits: out.trim() } }; // 有 → prompt 里的 {{commits}}
  // },

  prompt: ${JSON.stringify(d.prompt)},
};
`;
