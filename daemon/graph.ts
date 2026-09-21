// Loop graph: drive several tagged sessions in one chat as a pipeline.
//
// A graph binds `#tag` sessions (each free to run a different CLI / model /
// cwd) into an ordered list of steps, then walks that list `rounds` times:
//
//   send(step.prompt) → wait for that agent to go idle → capture its reply
//   → feed it forward as `{{last}}` into the next step
//
// It is a *loop* graph because the step list cycles: `fix → review → fix →
// review …` until the `until` sentinel shows up in a reply or the round budget
// runs out. That covers the useful shape (propose/critique, build/test,
// draft/edit) without inventing a scheduler — the ordering IS the graph.
//
// The runner owns no session state: every effect goes through injected deps
// backed by the mirror bridge, so a graph step is exactly what a human typing
// `#fix …` into WeCom would do. Runs live in memory only — a daemon reload
// cancels them, which is honest: the panes survive, the automation doesn't.
import { randomUUID } from "node:crypto";
import type { Logger } from "pino";
import type { CliBackendName } from "../shared/cli-backends.js";
import type { TurnOrigin } from "../shared/detail-store.js";

export interface GraphNodeSpec {
  /** Session tag, without `#`. */
  tag: string;
  cli?: CliBackendName;
  /** Model slug passed to the CLI at spawn (`--model`). Only honored when the
   *  node has to be created; an already-running pane keeps its model. */
  model?: string;
  cwd?: string;
}

export interface GraphStepSpec {
  /** Tag of the node this step drives. */
  to: string;
  /** Prompt template. `{{last}}` = previous step's reply, `{{<tag>}}` = that
   *  node's latest reply, `{{round}}` = 1-based round number. */
  prompt: string;
}

export interface GraphSpec {
  base: string;
  nodes: GraphNodeSpec[];
  steps: GraphStepSpec[];
  /** How many times to walk the step list. Default 1 (a plain pipeline). */
  rounds?: number;
  /** Case-insensitive substring; when a reply contains it the run stops early
   *  and is reported as converged. */
  until?: string;
  /** Per-step ceiling on the wait-for-idle phase. Default 900s. */
  idleTimeoutSec?: number;
}

export interface StepRecord {
  round: number;
  tag: string;
  prompt: string;
  reply: string;
  status: "running" | "done" | "timeout" | "error";
  reason?: string;
  startedAt: number;
  endedAt?: number;
}

export interface GraphRun {
  runId: string;
  base: string;
  spec: GraphSpec;
  status: "running" | "done" | "converged" | "stopped" | "error";
  history: StepRecord[];
  startedAt: number;
  endedAt?: number;
  error?: string;
}

export interface GraphDeps {
  /** Create the tagged session if it isn't already live; no-op otherwise. */
  ensureNode: (target: string, node: GraphNodeSpec) => Promise<{ ok: boolean; reason?: string }>;
  /** `origin` is attribution, not routing: it rides along so the turn this
   *  inject opens can say in chat details who sent it and on which round. */
  send: (target: string, text: string, origin: TurnOrigin) => Promise<{ ok: boolean; reason?: string }>;
  isBusy: (target: string) => Promise<boolean>;
  lastText: (target: string) => Promise<string>;
  /** Push a progress bubble to the chat so the human sees the loop advance. */
  notify: (base: string, markdown: string) => void;
  log: Logger;
}

// ── Pure helpers ──────────────────────────────────────────────────────
const targetOf = (base: string, tag: string): string => (tag ? `${base}#${tag}` : base);

/** Substitute `{{…}}` refs from the accumulated reply context. Unknown keys are
 *  left verbatim — a prompt legitimately containing `{{foo}}` shouldn't be
 *  silently emptied. */
export const interpolate = (
  template: string,
  ctx: Readonly<Record<string, string>>,
): string =>
  template.replace(/\{\{\s*#?([\p{L}\p{N}_-]+)\s*\}\}/gu, (whole, key: string) =>
    key in ctx ? ctx[key]! : whole,
  );

/** Reply satisfies the convergence sentinel. */
export const converged = (reply: string, until: string | undefined): boolean =>
  !!until && reply.toLowerCase().includes(until.toLowerCase());

const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));

// ── Idle detection ────────────────────────────────────────────────────
// After an inject the pane needs a moment to pick the text up, so "not busy"
// right away means nothing. Ramp: give the turn RAMP_MS to start; once we have
// seen it busy (or the ramp expires), require IDLE_CONFIRM consecutive quiet
// polls before declaring the turn finished — a single quiet sample lands in
// the gap between two tool calls often enough to matter.
const POLL_MS = 2500;
const RAMP_MS = 20_000;
const IDLE_CONFIRM = 3;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export interface IdleResult { idle: boolean; reason?: string }

/** `rampMs` / `confirm` 只在一个场景下需要改: 「投递前先看它闲不闲」。那里没有
 *  刚注入的一轮要等, ramp 反而会把"现在就闲着"硬拖 20 秒。 */
export interface IdleOpts { rampMs?: number; confirm?: number }

export const waitForIdle = async (
  target: string,
  isBusy: (t: string) => Promise<boolean>,
  timeoutMs: number,
  aborted: () => boolean,
  opts: IdleOpts = {},
): Promise<IdleResult> => {
  const deadline = Date.now() + timeoutMs;
  const rampUntil = Date.now() + (opts.rampMs ?? RAMP_MS);
  const confirmN = Math.max(1, opts.confirm ?? IDLE_CONFIRM);
  let sawBusy = false;
  let quiet = 0;
  while (Date.now() < deadline) {
    if (aborted()) return { idle: false, reason: "stopped" };
    await sleep(POLL_MS);
    const busy = await isBusy(target);
    if (busy) {
      sawBusy = true;
      quiet = 0;
      continue;
    }
    // Still inside the ramp and the turn never started — keep waiting for it
    // rather than mistaking "hasn't begun" for "already done".
    if (!sawBusy && Date.now() < rampUntil) continue;
    if (++quiet >= confirmN) return { idle: true };
  }
  return { idle: false, reason: "idle wait timed out" };
};

/** 等一组 wizard, 满 `need` 个就返回 —— fan-out 之后的 join。
 *
 *  这是 wait 从"一个一个等"变成"并行等"的那一步: 串行地 waitForIdle 五个分身,
 *  墙钟是五个之和, 并行则是最慢的那一个。`need` 同时把 all / any / 过半三种语义
 *  收进一个数字: need = n 是全等, need = 1 是谁先完事就返回谁, 中间值是法定人数。
 *
 *  满足之后剩下的等待立刻撤掉 (它们的 `aborted` 就是这个标志), 所以调用方不会为
 *  已经不关心的目标多等一秒。被撤掉的那些结果 reason 写成"仍在干活", 而不是
 *  waitForIdle 内部的 "stopped" —— 对调用方来说它们不是被停了, 是还没轮到。 */
export const waitForQuorum = async (
  targets: readonly string[],
  isBusy: (t: string) => Promise<boolean>,
  timeoutMs: number,
  need: number,
  aborted: () => boolean = () => false,
): Promise<IdleResult[]> => {
  const quota = clamp(need, 1, Math.max(1, targets.length));
  let done = 0;
  const enough = (): boolean => done >= quota;
  const results = await Promise.all(
    targets.map(async (t): Promise<IdleResult> => {
      const r = await waitForIdle(t, isBusy, timeoutMs, () => aborted() || enough());
      if (r.idle) done++;
      return r;
    }),
  );
  return results.map((r) =>
    r.idle || r.reason !== "stopped" ? r : { idle: false, reason: aborted() ? "stopped" : "仍在干活 (法定人数已满, 不再等它)" },
  );
};

// ── Runner ────────────────────────────────────────────────────────────
const runs = new Map<string, GraphRun>();
const abortFlags = new Map<string, boolean>();

export const getRun = (runId: string): GraphRun | undefined => runs.get(runId);
export const listRuns = (base?: string): GraphRun[] =>
  Array.from(runs.values()).filter((r) => !base || r.base === base);
export const stopRun = (runId: string): boolean => {
  const r = runs.get(runId);
  if (!r || r.status !== "running") return false;
  abortFlags.set(runId, true);
  return true;
};

const renderStep = (s: StepRecord, total: number): string =>
  `轮 ${s.round}/${total} · \`#${s.tag}\` ${s.status === "done" ? "✅" : s.status === "timeout" ? "⏱" : "❌"}`;

const clip = (s: string, max: number): string => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
};

/** A step bubble carries the traffic, not just the tick: `▸` what the graph
 *  asked, `◂` what the node answered — same glyphs peek_peer renders a peer
 *  conversation with. Otherwise the whole exchange happens in panes nobody is
 *  watching and the chat only ever sees "2/6 ✅". */
const renderTraffic = (s: StepRecord, total: number, runId: string): string =>
  [`🕸 \`${runId}\` ${renderStep(s, total)}`, `▸ ${clip(s.prompt, 500)}`, s.reply ? `◂ ${clip(s.reply, 900)}` : ""]
    .filter(Boolean)
    .join("\n");

/** Validate a spec before spending a spawn on it. Returns "" when valid. */
export const validateSpec = (spec: GraphSpec): string => {
  if (!spec.base.trim()) return "base (chat) 未解析";
  if (spec.steps.length === 0) return "steps 不能为空";
  const known = new Set(spec.nodes.map((n) => n.tag));
  const orphan = spec.steps.find((s) => !known.has(s.to));
  if (orphan) return `step 指向未声明的节点 \`#${orphan.to}\``;
  const selfless = spec.nodes.find((n) => !n.tag.trim());
  if (selfless) return "node.tag 不能为空 —— 每个节点都必须是带 tag 的会话";
  return "";
};

export const startGraph = (spec: GraphSpec, deps: GraphDeps): GraphRun => {
  const runId = randomUUID().slice(0, 8);
  const rounds = clamp(spec.rounds ?? 1, 1, 50);
  const idleTimeoutMs = clamp(spec.idleTimeoutSec ?? 900, 30, 7200) * 1000;
  const run: GraphRun = { runId, base: spec.base, spec, status: "running", history: [], startedAt: Date.now() };
  runs.set(runId, run);
  abortFlags.set(runId, false);
  const aborted = (): boolean => abortFlags.get(runId) === true;

  const finish = (status: GraphRun["status"], error?: string): void => {
    run.status = status;
    run.endedAt = Date.now();
    if (error) run.error = error;
    abortFlags.delete(runId);
    const done = run.history.filter((h) => h.status === "done").length;
    deps.notify(
      spec.base,
      [
        `🕸 图 \`${runId}\` ${status === "converged" ? "已收敛" : status === "done" ? "完成" : status === "stopped" ? "已停止" : "异常终止"}`,
        `完成 ${done}/${run.history.length} 步${error ? ` · ${error}` : ""}`,
      ].join("\n"),
    );
    deps.log.info({ runId, status, steps: run.history.length, error }, "graph: finished");
  };

  const loop = async (): Promise<void> => {
    // Reply context, keyed by tag plus the rolling `last`. Rebuilt as the walk
    // proceeds so a step can quote either its immediate predecessor or any
    // named node's most recent output.
    const ctx: Record<string, string> = { last: "" };
    for (let round = 1; round <= rounds; round++) {
      ctx.round = String(round);
      for (const [i, step] of spec.steps.entries()) {
        if (aborted()) { finish("stopped"); return; }
        const node = spec.nodes.find((n) => n.tag === step.to)!;
        const target = targetOf(spec.base, step.to);
        const prompt = interpolate(step.prompt, ctx);
        // fromTag = 上一个**走过**的步骤 (跨轮时是上一轮的末步), 也就是 `{{last}}`
        // 的来源。取自 history 而不是 spec.steps[i-1] —— 早退/超时后两者会分叉。
        const prev = run.history[run.history.length - 1];
        const origin: TurnOrigin = {
          runId, round, rounds, step: i + 1, steps: spec.steps.length,
          ...(prev ? { fromTag: prev.tag } : {}),
        };
        const rec: StepRecord = { round, tag: step.to, prompt, reply: "", status: "running", startedAt: Date.now() };
        run.history.push(rec);
        deps.notify(spec.base, `🕸 \`${runId}\` 轮 ${round}/${rounds} → \`#${step.to}\` 开始`);

        const ready = await deps.ensureNode(target, node);
        if (!ready.ok) {
          rec.status = "error";
          rec.reason = ready.reason;
          rec.endedAt = Date.now();
          finish("error", `节点 #${step.to} 就绪失败: ${ready.reason ?? "unknown"}`);
          return;
        }
        const sent = await deps.send(target, prompt, origin);
        if (!sent.ok) {
          rec.status = "error";
          rec.reason = sent.reason;
          rec.endedAt = Date.now();
          finish("error", `注入 #${step.to} 失败: ${sent.reason ?? "unknown"}`);
          return;
        }
        const idle = await waitForIdle(target, deps.isBusy, idleTimeoutMs, aborted);
        rec.endedAt = Date.now();
        rec.reply = await deps.lastText(target);
        ctx[step.to] = rec.reply;
        ctx.last = rec.reply;
        if (!idle.idle) {
          rec.status = idle.reason === "stopped" ? "error" : "timeout";
          rec.reason = idle.reason;
          if (idle.reason === "stopped") { finish("stopped"); return; }
          // A timeout is not fatal: the agent may simply be slow, and the reply
          // captured so far is still worth handing to the next node. Report and
          // keep walking — stalling the whole graph on one slow step is worse.
          deps.notify(spec.base, `${renderTraffic(rec, rounds, runId)}\n(超时, 继续)`);
          continue;
        }
        rec.status = "done";
        deps.notify(spec.base, renderTraffic(rec, rounds, runId));
        if (converged(rec.reply, spec.until)) { finish("converged"); return; }
      }
    }
    finish("done");
  };

  void loop().catch((e: unknown) => finish("error", (e as Error).message));
  return run;
};
