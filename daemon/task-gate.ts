// gate 的执行体 —— 任务文件里那段「放枪前先看一眼有没有活」的代码。
//
// 跑在子进程里, 不在 daemon 里: gate 是用户/wizard 写的, 会跑 git fetch 这类要几秒
// 的命令, 偶尔还会写出死循环。daemon 的 tick 每 20s 一次, 被一个 gate 卡住就等于
// 所有定时任务一起停摆 —— 所以它必须能被 kill。超时、抛错、崩溃三者同义:
// **这一轮不放枪**, 下一轮照常再来。
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import type { Logger } from "pino";
import { augmentedPath } from "../shared/exec-path.js";

const SENTINEL = "<<WEZARD_GATE>>";

export interface GateVerdict {
  go: boolean;
  vars: Record<string, string>;
  state?: Record<string, unknown>;
  logs: string[];
  error?: string;
}

const SKIP = (error?: string): GateVerdict => ({ go: false, vars: {}, logs: [], ...(error ? { error } : {}) });

// 子进程里跑的那段。刻意不 import 任何 wezard 代码: 它唯一要做的事是把任务文件
// import 进来、调 gate、把结果用哨兵包着写回 stdout —— gate 自己的 console.log
// 混在前面也不会破坏解析。
const runner = (fileUrl: string): string => `
import { exec } from "node:child_process";
const ctx = JSON.parse(process.env.WEZARD_GATE_CTX ?? "{}");
const logs = [];
const sh = (cmd, opts = {}) => new Promise((res, rej) => exec(cmd, {
  cwd: opts.cwd || ctx.task?.cwd || undefined,
  timeout: (opts.timeoutSec ?? 120) * 1000,
  maxBuffer: 8 * 1024 * 1024,
  shell: "/bin/bash",
}, (e, so, se) => (e ? rej(new Error(String(e.message || e) + (se ? "\\n" + se : ""))) : res(so))));
let out;
try {
  const mod = (await import(${JSON.stringify(fileUrl)})).default;
  if (typeof mod?.gate !== "function") out = { ok: true, r: true, logs };
  else {
    const r = await mod.gate({
      now: new Date(ctx.nowMs), task: ctx.task, state: ctx.state ?? {}, sh,
      log: (m) => logs.push(typeof m === "string" ? m : JSON.stringify(m)),
    });
    out = { ok: true, r: r === undefined ? true : r, logs };
  }
} catch (e) {
  out = { ok: false, error: String(e?.stack || e?.message || e), logs };
}
process.stdout.write("\\n" + ${JSON.stringify(SENTINEL)} + JSON.stringify(out));
`;

const parseVerdict = (stdout: string): GateVerdict => {
  const i = stdout.lastIndexOf(SENTINEL);
  if (i < 0) return SKIP("gate 没有产出结果 (进程提前退出?)");
  const payload = JSON.parse(stdout.slice(i + SENTINEL.length)) as {
    ok: boolean; r?: unknown; error?: string; logs?: string[];
  };
  const logs = payload.logs ?? [];
  if (!payload.ok) return { ...SKIP(payload.error ?? "gate 抛错"), logs };
  const r = payload.r;
  if (r === false) return { go: false, vars: {}, logs };
  if (r === true || r === null || r === undefined) return { go: true, vars: {}, logs };
  const o = r as { go?: boolean; vars?: Record<string, unknown>; state?: Record<string, unknown> };
  return {
    go: o.go !== false,
    // 模板只会往 prompt 里贴字符串, 对象顺手摊平成 json —— 不然 gate 回一个数组,
    // prompt 里就是 [object Object]。
    vars: Object.fromEntries(Object.entries(o.vars ?? {}).map(([k, v]) => [k, typeof v === "string" ? v : JSON.stringify(v)])),
    ...(o.state && typeof o.state === "object" ? { state: o.state } : {}),
    logs,
  };
};

export interface GateInput {
  file: string;
  task: { id: string; target: string; cwd: string };
  state: Record<string, unknown>;
  timeoutSec: number;
  log: Logger;
}

/** 跑一次 gate。任何失败都收敛成「这一轮不放枪」, 永不抛。 */
export const runGate = async ({ file, task, state, timeoutSec, log }: GateInput): Promise<GateVerdict> =>
  new Promise<GateVerdict>((resolve) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", runner(pathToFileURL(file).href)], {
      env: {
        ...process.env,
        PATH: augmentedPath(process.env.PATH),
        WEZARD_GATE_CTX: JSON.stringify({ nowMs: Date.now(), task, state }),
      },
      cwd: task.cwd || undefined,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (b: Buffer) => { out += b.toString(); });
    child.stderr.on("data", (b: Buffer) => { err += b.toString(); });
    const killer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve(SKIP(`gate 超时 (${timeoutSec}s)`));
    }, timeoutSec * 1000);
    child.on("error", (e) => { clearTimeout(killer); resolve(SKIP(`gate 起不来: ${e.message}`)); });
    child.on("close", () => {
      clearTimeout(killer);
      try {
        const v = parseVerdict(out);
        if (v.error) log.warn({ task: task.id, err: v.error, stderr: err.slice(-400) }, "gate failed");
        resolve(v);
      } catch (e) {
        resolve(SKIP(`gate 结果解析失败: ${(e as Error).message}${err ? ` · ${err.slice(-200)}` : ""}`));
      }
    });
  });
