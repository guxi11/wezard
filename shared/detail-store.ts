// Detail record store — factory pattern so daemon (local, sits behind card links)
// and svr (standalone, chat 端浏览器直连的公网/共享网络机) can each own an isolated
// instance. Pure state + IO. Rendering lives in ./detail-render.
//
// Persistence: append-only JSONL → <stateDir>/details.jsonl, replay on init;
// TTL 24h, LRU 上限 1000 条; 超过 COMPACT_BYTES 时按 store 快照重写整个文件。
import { mkdirSync, existsSync, readFileSync, appendFileSync, writeFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Logger } from "pino";
import { expandHome } from "./paths.js";

export type ApprovalDecision =
  | "allow"
  | "allow_session"
  | "allow_window"
  | "allow_always"
  | "deny"
  | "timeout"
  | "swept";

export interface ToolDetailRecord {
  kind: "tool";
  id: string;
  createdAt: number;
  toolName: string;
  toolInput: unknown;
  toolResult?: string;
  resultAt?: number;
  target?: string;
  sessionId?: string;
}

export interface ApprovalDetailRecord {
  kind: "approval";
  id: string;
  createdAt: number;
  toolName: string;
  toolInput: unknown;
  cwd: string;
  sessionId: string;
  transcriptTail: string;
  decision?: ApprovalDecision;
  decidedBy?: string;
  decidedAt?: number;
}

// Brief 模式聚合: 一个 turn 内所有中间事件的时间线快照。turnId = mirror-bridge
// 侧生成的 turnId (t<base36-time><rand6>);同一 turn 多次 append 覆盖前值 (put 语义)。
export type TurnItem =
  | { t: "text"; body: string; ts: number; final?: boolean }
  | { t: "tool_use"; toolUseId: string; toolName: string; toolInput: unknown; ts: number }
  | { t: "tool_result"; toolUseId: string; body: string; ts: number }
  | { t: "approval"; approvalId: string; toolName: string; decision?: ApprovalDecision; ts: number };

// 累计一个 turn 内所有 assistant 行的 token usage — 每次 assistant 行都拿到独立
// 的 usage 值 (Anthropic Messages API 语义), 需要字段级累加。serviceTier 只保留
// 首见值; calls 记录累加了几次 (不是 tool 调用数, 是 API 调用数)。
export interface TurnUsage {
  input: number;
  output: number;
  cacheRead: number;   // cache_read_input_tokens — 累计, 含跨调用重读同一前缀
  cacheWrite: number;  // cache_creation_input_tokens — 累计
  serviceTier?: string;
  calls: number;
  // 单次 API 调用送入的上下文 (input+cacheRead+cacheWrite) 的峰值 = 窗口占用高水位。
  // 与上面的累计字段不同: 不随调用次数增长, 反映"窗口有多满"而非"总共读了多少"。
  // delta 传入时可缺省 (mirror 侧按单调用发, 由 store 计算并落库)。
  ctxPeak?: number;
}

// 上下文断点 —— 本轮开始前上下文发生了什么。渲染成 turn 卡片顶部的断点条,
// 让"这一轮读不到上一轮"这件事在时间线上可见:
//   clear  = /clear 清空 (成因确定, 上文全丢)
//   new    = /new 另起会话 (新 pane / 新 sid)
//   switch = sessionId 轮换但成因未知 (resume fork / worktree drift / daemon 重启)。
//            这些路径上下文通常是延续的, 所以只中性地标"换过会话", 不宣称已清空。
export type CtxCut = "clear" | "new" | "switch";

// Graph 归因 —— 这一轮不是人打的字, 是 loop graph 某一轮的某一步注入的。
// 必须落在 turn 记录里, 而不是只挂在 graph.ts 的内存 run 上: run 是 in-memory 的,
// 一次 reload 就没了, 而 details 走 append-only JSONL —— 归因得跟着记录过夜, 否则
// 重启后历史 turn 永远说不清自己是谁派的, 看着就是某个 tag 在自说自话。
// pipeline 的全貌不存在这里: 同一 runId 的所有 turn 各自带着 (round, step, tag),
// 合起来就能把步骤序列反推出来 (见 chat-view.graphSummaries), 不必逐轮冗余整张 spec。
export interface TurnOrigin {
  runId: string;
  /** 1-based, 与 rounds 一起构成 "轮 3/5"。 */
  round: number;
  rounds: number;
  /** 1-based step index within one round. */
  step: number;
  steps: number;
  /** 上一步的 tag —— 它的回复正是本步 `{{last}}` 的内容; 整个 run 的第一步没有。 */
  fromTag?: string;
}

// Subagent 归属 —— 这一轮不是主会话的 turn, 是 Task/Agent 工具派出的子 agent
// 在自己的 transcript (`<sid>/subagents/agent-<id>.jsonl`) 里跑出来的。与 origin
// 一样落在记录里: chat 线程按时间轴内联渲染 subagent turn, 没有这个字段就分不出
// 「主 agent 自己的一轮」和「子 agent 的一轮」。
export interface TurnAgentMeta {
  /** 文件名里的 agent id (不含 `agent-` 前缀与扩展名)。 */
  id: string;
  /** 派发时指定的 subagent_type (Explore / general-purpose / 自定义)。 */
  type?: string;
  /** 派发描述 (Task input.description)。 */
  description?: string;
}

export interface TurnDetailRecord {
  kind: "turn";
  id: string;
  createdAt: number;
  updatedAt: number;
  closed: boolean;
  target?: string;
  sessionId?: string;
  cwd?: string;        // 本轮运行时该 pane 的实际工作目录 (可能与 cfg.wrc.cwd 不同)
  userQuery?: string;  // 触发本轮的用户输入原文 (mirror 侧 dispatch 的 text)
  cut?: CtxCut;        // 本轮之前的上下文断点; undefined = 与上一轮同一上下文
  origin?: TurnOrigin; // 本轮由 graph 注入; undefined = 人 (或 peer) 直接发起
  agent?: TurnAgentMeta; // 本轮是 subagent 跑的; undefined = 主会话自身的 turn
  items: TurnItem[];
  model?: string;      // 首个见到的 model 名
  modelAlt?: number;   // 与 model 不同的后续行数, 用于渲染 "+N"
  usage?: TurnUsage;
  // 已入账的 Anthropic message.id — Claude Code jsonl 会把一次 API 响应拆成
  // 多条 assistant 行 (如 thinking + tool_use 各一条), 两条共享同一 message.id
  // 且各自都带 usage 快照。按 id 去重, 避免 usage 被 N 倍夸大。
  usageMsgIds?: string[];
}

export type DetailRecord = ToolDetailRecord | ApprovalDetailRecord | TurnDetailRecord;

export interface DetailStore {
  recordTool(rec: Omit<ToolDetailRecord, "kind" | "createdAt"> & { createdAt?: number }): void;
  recordToolResult(toolUseId: string, full: string): void;
  recordApproval(
    rec: Omit<ApprovalDetailRecord, "kind" | "createdAt" | "decision" | "decidedAt" | "decidedBy"> & { createdAt?: number },
  ): void;
  recordApprovalDecision(reqId: string, decision: ApprovalDecision, decidedBy?: string): void;
  startTurn(
    rec: Omit<TurnDetailRecord, "kind" | "createdAt" | "updatedAt" | "closed" | "items"> & { createdAt?: number },
  ): void;
  appendTurnItem(id: string, item: TurnItem): void;
  addTurnUsage(id: string, delta: { model?: string; messageId?: string; usage: TurnUsage }): void;
  closeTurn(id: string): void;
  // 收尾所有仍开着的 turn (可选按 target / sessionId 限定, 可选排除若干 id)。返回被
  // 关闭的 id。用途: 新一轮发出 finish 消息时, 把此前遗留未关闭的 turn 一并标记结束。
  // sessionId 必须传: 同一个 chat 下的多个 #tag 会话共享 target, 只按 target 收尾会
  // 把兄弟 agent 正在跑的 turn 页面提前打成「已完成」(页面随即停止轮询, 看着像卡死)。
  // exceptIds 是复数: 当前 turn 之外, 还要保住排队中尚未激活的 turn。
  closeOpenTurns(scope: { target?: string; sessionId?: string; exceptIds?: readonly string[] }): string[];
  put(rec: DetailRecord): void;
  get(id: string): DetailRecord | undefined;
  /** Live snapshot of every retained record. Callers filter/derive; never mutate. */
  list(): DetailRecord[];
  /** Fires after every put — the single source the SSE feed hangs off, so a
   *  record reaching the store (locally OR via svr's POST /d) pushes identically. */
  subscribe(fn: (rec: DetailRecord) => void): () => void;
}

const TTL_MS = 24 * 3600_000;
const MAX = 1000;
const COMPACT_BYTES = 5 * 1024 * 1024;

export const createDetailStore = (opts: { stateDir: string; log?: Logger }): DetailStore => {
  const store = new Map<string, DetailRecord>();
  const dir = expandHome(opts.stateDir);
  mkdirSync(dir, { recursive: true });
  const logPath = join(dir, "details.jsonl");

  const gc = (): void => {
    const cutoff = Date.now() - TTL_MS;
    for (const [k, v] of store) if (v.createdAt < cutoff) store.delete(k);
    if (store.size > MAX) {
      const sorted = [...store.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt);
      for (let i = 0; i < sorted.length - MAX; i++) store.delete(sorted[i]![0]);
    }
  };

  const lastTurnOf = (target: string): TurnDetailRecord | undefined =>
    [...store.values()].reduce<TurnDetailRecord | undefined>(
      (m, r) =>
        r.kind === "turn" && r.target === target && (!m || r.createdAt > m.createdAt) ? r : m,
      undefined,
    );

  const persist = (rec: DetailRecord): void => {
    try { appendFileSync(logPath, `${JSON.stringify(rec)}\n`); } catch { /* ignore */ }
  };

  const compact = (): void => {
    const lines = [...store.values()].map((r) => JSON.stringify(r));
    try { writeFileSync(logPath, lines.length ? `${lines.join("\n")}\n` : ""); } catch { /* ignore */ }
  };

  const maybeCompact = (): void => {
    try { if (statSync(logPath).size > COMPACT_BYTES) compact(); } catch { /* ignore */ }
  };

  if (existsSync(logPath)) {
    const cutoff = Date.now() - TTL_MS;
    let replayed = 0, dropped = 0;
    try {
      const text = readFileSync(logPath, "utf8");
      for (const line of text.split("\n")) {
        if (!line) continue;
        try {
          const r = JSON.parse(line) as DetailRecord;
          if (!r?.id || (r.kind !== "tool" && r.kind !== "approval" && r.kind !== "turn")) continue;
          if (typeof r.createdAt !== "number" || r.createdAt < cutoff) { dropped++; continue; }
          store.set(r.id, r);
          replayed++;
        } catch { /* skip malformed line */ }
      }
    } catch (e) {
      opts.log?.warn({ err: (e as Error).message }, "detail store: replay failed");
    }
    gc();
    compact();
    opts.log?.info({ logPath, replayed, dropped, kept: store.size }, "detail store: replay done");
  } else {
    opts.log?.info({ logPath }, "detail store: fresh log");
  }

  // 订阅者异常不该拖垮写入路径 (一个断掉的 SSE 连接 ≠ 丢一条 detail)。
  const subscribers = new Set<(rec: DetailRecord) => void>();
  const notify = (rec: DetailRecord): void => {
    for (const fn of subscribers) { try { fn(rec); } catch { /* ignore */ } }
  };

  const put = (rec: DetailRecord): void => {
    store.set(rec.id, rec);
    if (store.size > MAX) gc();
    persist(rec);
    maybeCompact();
    notify(rec);
  };

  return {
    put,
    get: (id) => store.get(id),
    list: () => [...store.values()],
    subscribe: (fn) => {
      subscribers.add(fn);
      return () => { subscribers.delete(fn); };
    },
    recordTool: (rec) => {
      put({ kind: "tool", ...rec, createdAt: rec.createdAt ?? Date.now() });
    },
    recordToolResult: (toolUseId, full) => {
      const r = store.get(toolUseId);
      if (!r || r.kind !== "tool") return;
      put({ ...r, toolResult: full, resultAt: Date.now() });
    },
    recordApproval: (rec) => {
      put({ kind: "approval", ...rec, createdAt: rec.createdAt ?? Date.now() });
    },
    recordApprovalDecision: (reqId, decision, decidedBy) => {
      const r = store.get(reqId);
      if (!r || r.kind !== "approval") return;
      put({ ...r, decision, decidedBy, decidedAt: Date.now() });
    },
    startTurn: (rec) => {
      const now = Date.now();
      // 断点成因由 caller 给 (它才知道刚注入的是 /clear 还是 /new); 没给就退回观测:
      // 同 target 的上一轮 sid 与本轮不同 ⇒ 上下文不连续, 至少要标出来。
      const prev = rec.target ? lastTurnOf(rec.target) : undefined;
      const rotated = !!prev?.sessionId && !!rec.sessionId && prev.sessionId !== rec.sessionId;
      put({
        kind: "turn",
        ...rec,
        cut: rec.cut ?? (rotated ? "switch" : undefined),
        createdAt: rec.createdAt ?? now,
        updatedAt: now,
        closed: false,
        items: [],
      });
    },
    appendTurnItem: (id, item) => {
      const r = store.get(id);
      if (!r || r.kind !== "turn") return;
      put({ ...r, items: [...r.items, item], updatedAt: Date.now() });
    },
    addTurnUsage: (id, delta) => {
      const r = store.get(id);
      if (!r || r.kind !== "turn") return;
      // 同一 message.id 的重复行只入账一次 (thinking / tool_use 拆行, 共享 usage)。
      // 无 messageId 时保守累加 — 兼容早期 caller 或 headless (cc-bridge) 路径。
      const seenIds = r.usageMsgIds ?? [];
      const dupe = delta.messageId ? seenIds.includes(delta.messageId) : false;
      const cur = r.usage;
      const nextUsage: TurnUsage = dupe
        ? (cur ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, calls: 0 })
        : (() => {
            // 这一次调用送入的上下文 = 新鲜输入 + 缓存读 + 缓存写 (delta 恒为单次调用)。
            const callCtx = delta.usage.input + delta.usage.cacheRead + delta.usage.cacheWrite;
            return cur
              ? {
                  input: cur.input + delta.usage.input,
                  output: cur.output + delta.usage.output,
                  cacheRead: cur.cacheRead + delta.usage.cacheRead,
                  cacheWrite: cur.cacheWrite + delta.usage.cacheWrite,
                  serviceTier: cur.serviceTier ?? delta.usage.serviceTier,
                  calls: cur.calls + delta.usage.calls,
                  ctxPeak: Math.max(cur.ctxPeak ?? 0, callCtx),
                }
              : { ...delta.usage, ctxPeak: callCtx };
          })();
      const nextIds = delta.messageId && !dupe ? [...seenIds, delta.messageId] : seenIds;
      let model = r.model;
      let modelAlt = r.modelAlt;
      if (delta.model) {
        if (!model) model = delta.model;
        else if (model !== delta.model) modelAlt = (modelAlt ?? 0) + 1;
      }
      put({ ...r, model, modelAlt, usage: nextUsage, usageMsgIds: nextIds.length ? nextIds : undefined, updatedAt: Date.now() });
    },
    closeTurn: (id) => {
      const r = store.get(id);
      if (!r || r.kind !== "turn" || r.closed) return;
      put({ ...r, closed: true, updatedAt: Date.now() });
    },
    closeOpenTurns: ({ target, sessionId, exceptIds }) => {
      const now = Date.now();
      const keep = new Set(exceptIds ?? []);
      const closed: string[] = [];
      for (const [id, r] of store) {
        if (r.kind !== "turn" || r.closed) continue;
        if (keep.has(id)) continue;
        if (target && r.target !== target) continue;
        if (sessionId && r.sessionId !== sessionId) continue;
        put({ ...r, closed: true, updatedAt: now });
        closed.push(id);
      }
      return closed;
    },
  };
};
