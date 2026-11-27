// 事件循环延迟监控: daemon 是单线程, 任何同步重活 (几百份 transcript 的尾读、账本 fold) 都会让所有请求
// 一起停摆 —— 工具调用在回环上超时、卡片迟迟不出。以前这件事只能靠「并发探 /healthz」间接看见;
// 这里直接量: 每个窗口读一次 monitorEventLoopDelay 的 p99 / max, 超线打一条 warn (带当时在跑的路由),
// 并把最近一个窗口和开机以来的最大值放进 /status 的 eventLoopLagMs。
//
// 为什么 p99 之外还看 max: 直方图按 resolution 采样, 一次 3s 的卡顿只贡献 1 个样本, 在一个窗口的几百个
// 样本里进不了 p99 —— 而「名册卡 1~3 秒」恰恰就是这种单发长停顿。所以 p99 超线 或 max 超 maxWarnMs 都报。
import { monitorEventLoopDelay } from "node:perf_hooks";

export interface LoopLagSnapshot {
  /** 最近一个窗口的 p99 / max (ms)。窗口还没走完时为 0。 */
  p99: number;
  max: number;
  /** 开机以来见过的最大停顿 (ms) 及它出现的时刻 (epoch ms)。 */
  maxSinceBoot: number;
  maxAt: number;
  /** 最近一个窗口收口的时刻 (epoch ms), 0 = 还没有。 */
  sampledAt: number;
}

export interface LoopLagLog { warn: (fields: Record<string, unknown>, msg: string) => void }

export interface LoopLagOpts {
  log: LoopLagLog;
  /** 当时在处理的路由 (http.ts inflightRoutes), 只用于告警里指认嫌疑人。 */
  inflight?: () => string[];
  /** 采样窗口 (ms), 缺省 10s。 */
  windowMs?: number;
  /** 直方图分辨率 (ms), 缺省 20。 */
  resolutionMs?: number;
  /** p99 超过它就 warn, 缺省 500。 */
  p99WarnMs?: number;
  /** 单发最大停顿超过它也 warn, 缺省 1000。 */
  maxWarnMs?: number;
  now?: () => number;
}

export interface LoopLagMonitor {
  snapshot: () => LoopLagSnapshot;
  stop: () => void;
}

const nsToMs = (ns: number): number => Math.round(ns / 1e6);

/** 超线判定 (纯): 哪一条触发, 都返回 true。 */
export const lagExceeds = (s: { p99: number; max: number }, p99WarnMs: number, maxWarnMs: number): boolean =>
  s.p99 > p99WarnMs || s.max > maxWarnMs;

export const startLoopLagMonitor = (opts: LoopLagOpts): LoopLagMonitor => {
  const { log, inflight = () => [], windowMs = 10_000, resolutionMs = 20, p99WarnMs = 500, maxWarnMs = 1000, now = Date.now } = opts;
  const h = monitorEventLoopDelay({ resolution: resolutionMs });
  let snap: LoopLagSnapshot = { p99: 0, max: 0, maxSinceBoot: 0, maxAt: 0, sampledAt: 0 };
  h.enable();
  const timer = setInterval(() => {
    // 直方图记的是「定时器比预定晚了多少」, 已含 resolution 本身的基线 (≈ resolutionMs): 扣掉它再比。
    const p99 = Math.max(0, nsToMs(h.percentile(99)) - resolutionMs);
    const max = Math.max(0, nsToMs(h.max) - resolutionMs);
    h.reset();
    const at = now();
    snap = { p99, max, maxSinceBoot: Math.max(snap.maxSinceBoot, max), maxAt: max > snap.maxSinceBoot ? at : snap.maxAt, sampledAt: at };
    if (lagExceeds({ p99, max }, p99WarnMs, maxWarnMs)) {
      log.warn({ p99Ms: p99, maxMs: max, windowMs, inflight: inflight() }, "event loop lag (daemon 主线程被同步重活堵住; inflight = 此刻还在跑的路由, 嫌疑人在里面)");
    }
  }, windowMs);
  // 监控自己不许拖住进程退出。
  timer.unref();
  return {
    snapshot: () => snap,
    stop: () => { clearInterval(timer); h.disable(); },
  };
};
