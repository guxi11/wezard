// 回执路由表: 一件活 = 一行 `<event, owner, receiver>`, 表状态 = 对 append-only 日志的 fold。
// (方案见 docs/evolve/receipt-router.md §9, 本文件 = §8 的第 1 步「纯核心」。)
//
// 为什么要一张表: 旧机制把「这一笔欠谁的」拆在三个地方 —— 信封里的父 k / reply-to、回执
// 槽的 `from→to`、冻结栈 —— 一件活在飞时谁也说不清到底谁在等谁。这里只有一条边
// (`receiver`), 其余全是派生查询: 不落第二份数据, 就没有第二份说错的机会。
//
// 为什么是 jsonl 而不是 json: 状态机的每一步都是「记下要干什么」, 记全了才能重放。
// 撕裂的尾行 (写一半崩了) 丢掉即可; 中间行坏 = 表不可信 = 拒绝启动 —— 丢表 = 丢回执,
// 这与 json-map-store「坏了当空表」正好相反: 那些是缓存, 这是账。
//
// 纯核心: `step` / 派生查询 / op 构造器都是纯函数, IO 只在两端 (boot 的 foldJournal +
// 文件读写, commit 的 appendFileSync)。daemon 单进程、事件循环串行, 无锁。
import { appendFileSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { expandHome } from "../shared/paths.js";
import { clipLine } from "../shared/std.js";
import type { Asker } from "../shared/detail-store.js";
import type { Terminal } from "../shared/turn-state.js";
// 收口标记的语法只有一份 (peers.parseClosing)。router 只认标记不解释正文 (见 §5) ——
// 但标记长什么样必须与回执 watcher 完全同源, 所以借它的解析而不是自己再写一遍正则。
import { clipMiddle, parseClosing } from "./peers.js";

// ── 行 (§9.1) ────────────────────────────────────────────────────────────

/** 层级 id `<root>.<n>.<n>…`: 只用于追踪与展示 —— 语义一律走 receiver 边, 不解析前缀 (transfer 后两者不一致)。 */
export type EventId = string;
/** target key, 不是名字: 改名 / handoff 都不动它。 */
export type Key = string;

/** 定论交给谁: `chat` = 群里那句人话 (message-event id) 的答复气泡; `wizard` = 进它的收件箱。
 *  `event` 缺省 = detach: 结论只进收件箱, 不挂在它任何一笔欠账上。 */
export type Receiver =
  | { kind: "chat"; channel: string; message: string }
  | { kind: "wizard"; to: Key; event?: EventId };

export type Status =
  | "held"      // after 前置未落定, 尚未投给 owner
  | "open"      // 已投给 owner, 在干 (含挂着子行)
  | "need"      // owner 交了 NEED, 已转给 receiver, 等对方 re
  | "error"     // owner 的 CLI 报错停了, 已告知 receiver, 等续跑 / re
  | "answered"  // 定论已定 (outbox 已落盘), 还没进 receiver 的收件箱
  | "handed";   // 已入 receiver 收件箱 / 已排进群的答复 = 墓碑

export interface Outcome {
  status: Terminal;
  body: string;
  /** `sha256(body).slice(0,12)`: 投递幂等键 (`rcpt:<event>:<rev>`) 的一半, 与内容绑定 ——
   *  同 body 重放同 rev, 改了内容就是新 rev。 */
  rev: string;
}

export interface Route {
  event: EventId;
  owner: Key;
  receiver: Receiver;
  status: Status;
  at: number;
  /** 绝对时刻, reload 后照算。 */
  deadlineAt: number;
  /** 父行的「下一个子行序号」; 子行 open 时由子行 id 顶起来, 不单独落 op。 */
  seq: number;
  job?: string;
  /** 仅 held: 这几笔落定 (且都是 done) 才投给 owner (见 §4.2 「held 前置失败」)。 */
  after?: EventId[];
  outcome?: Outcome;
  /** 最近一次落定 (`answer`) 的时刻 —— 墓碑回收的起点 (§4.6); 追述会把它往后推。 */
  settledAt?: number;
  /** 第一次落定的结局, 只写一次: 追述换掉 outcome 之后, 还认得出这一行起初是 daemon 合成的失败 (§4.3)。 */
  settledAs?: Terminal;
  /** 落定之后 owner 又追述过 (失败后的真答 / done 后的 `RESULT:`) —— 当前 outcome 是追述的那份。 */
  late?: true;
  /** 开轮那一刻从信封拷入 (rolepage audience / pending 投影展示用), 不参与路由判定。 */
  asker?: Asker;
}

/** 逻辑上每个 wizard 一个数组 (owner 是它的行), 物理上一张表 —— transfer 要把一行从
 *  W 的数组挪到 B 的数组, 分两个文件就没有原子性。 */
export type Table = Readonly<Record<EventId, Route>>;
export const EMPTY: Table = {};

// ── op (§9.2) ────────────────────────────────────────────────────────────

/** 每条 op 都带 `at` (日志的审计时刻; 只有 open / row 会写进行里)。`row` = 压实快照行,
 *  fold 时等价于把该行整体置为这份状态。 */
export type Op =
  | { op: "open"; at: number; event: EventId; owner: Key; receiver: Receiver; deadlineAt: number; job?: string; asker?: Asker; after?: EventId[]; status?: "open" | "held" }
  | { op: "release"; at: number; event: EventId }
  | { op: "mark"; at: number; event: EventId; status: "open" | "need" | "error"; body?: string; rev?: string }
  | { op: "move"; at: number; event: EventId; owner: Key }
  | { op: "answer"; at: number; event: EventId; outcome: Outcome; late?: true }
  | { op: "hand"; at: number; event: EventId; inbox: string }
  | { op: "drop"; at: number; event: EventId }
  | { op: "gc"; at: number; event: EventId }
  | ({ op: "row" } & Route);

const WAITING: ReadonlySet<Status> = new Set<Status>(["held", "open", "need", "error", "answered"]);
/** `handed` 是墓碑 = 只读的投递路标: 子行沿它往上走 chain / 升级, owner 的追述沿它的 receiver
 *  原路再投 (§4.3); 落定满 TOMBSTONE_TTL_MS 后在压实时回收 (§4.6)。 */
const isLive = (r: Route): boolean => r.status !== "handed";

/** 子行 open 时把父行的序号顶到 max(现序号, 本行序号)。子行 id 就是父行 id + "." + 序号。 */
const parentOfId = (table: Table, event: EventId): Route | undefined => {
  const cut = event.lastIndexOf(".");
  return cut <= 0 ? undefined : table[event.slice(0, cut)];
};
const bumpParentSeq = (table: Table, child: EventId): Table => {
  const cut = child.lastIndexOf(".");
  if (cut <= 0) return table;
  const parent = parentOfId(table, child);
  const n = Number(child.slice(cut + 1));
  if (!parent || !Number.isInteger(n) || n <= parent.seq) return table;
  return { ...table, [parent.event]: { ...parent, seq: n } };
};

/** 子行的期限不超过父行的剩余期限 (§4.2, gRPC deadline propagation): 父已经超时的活, 子再干也没人等。
 *  开行时夹一次 —— 父由 event id 的前缀认出, 于是每条开行路径都自动带上, 不落第二条 op。 */
const clampDeadline = (table: Table, event: EventId, deadlineAt: number): number => {
  const parent = parentOfId(table, event);
  return parent ? Math.min(deadlineAt, parent.deadlineAt) : deadlineAt;
};

/** 唯一的状态机。纯: 同一个表 + 同一条 op → 同一个表; 恒等 (no-op) 的 op 原样返回。 */
export const step = (table: Table, op: Op): Table => {
  switch (op.op) {
    case "open": {
      // 重放同一段日志不该分叉: 同一个 event 只认第一次插行。
      if (table[op.event]) return table;
      const row: Route = {
        event: op.event, owner: op.owner, receiver: op.receiver,
        status: op.status ?? "open", at: op.at, deadlineAt: clampDeadline(table, op.event, op.deadlineAt), seq: 0,
        ...(op.job ? { job: op.job } : {}),
        ...(op.asker ? { asker: op.asker } : {}),
        ...(op.after?.length ? { after: [...op.after] } : {}),
      };
      return bumpParentSeq({ ...table, [op.event]: row }, op.event);
    }
    case "release": {
      const r = table[op.event];
      return r && r.status === "held" ? { ...table, [op.event]: { ...r, status: "open" } } : table;
    }
    case "mark": {
      const r = table[op.event];
      // 定论写一次: need / error 不改写已落定的行 (不变量 2)。
      if (!r || r.status === "answered" || r.status === "handed" || r.status === op.status) return table;
      return { ...table, [op.event]: { ...r, status: op.status } };
    }
    case "move": {
      const r = table[op.event];
      return r && r.owner !== op.owner ? { ...table, [op.event]: { ...r, owner: op.owner } } : table;
    }
    case "answer": {
      const r = table[op.event];
      if (!r) return table;
      // 落定过的行只有 `late` (owner 的追述) 能再写; 每写一次都推后 settledAt, settledAs 只认第一次。
      if ((r.status === "answered" || r.status === "handed") && !op.late) return table;
      return { ...table, [op.event]: {
        ...r, status: "answered", outcome: op.outcome, settledAt: op.at,
        settledAs: r.settledAs ?? r.outcome?.status ?? op.outcome.status,
        ...(op.late ? { late: true as const } : {}),
      } };
    }
    case "hand": {
      const r = table[op.event];
      // 先 answer 再入箱, 入箱成功才 hand (不变量 1): 只有落定过的行能变墓碑。
      if (!r || r.status !== "answered") return table;
      return { ...table, [op.event]: { ...r, status: "handed" } };
    }
    case "drop": {
      const r = table[op.event];
      if (!r || r.receiver.kind !== "wizard" || r.receiver.event === undefined) return table;
      return { ...table, [op.event]: { ...r, receiver: { kind: "wizard", to: r.receiver.to } } };
    }
    case "gc": {
      if (!table[op.event]) return table;
      const { [op.event]: _gone, ...rest } = table;
      return rest;
    }
    case "row": {
      const { op: _tag, ...snapshot } = op as { op: "row" } & Route;
      return { ...table, [snapshot.event]: snapshot };
    }
  }
};

// ── op 构造器 (`at` 缺省取当前时刻: 构造器是这一层唯一碰时钟的地方) ─────────

/** 定论 / 中途态正文的指纹: 投递幂等键 (`rcpt:<event>:<rev>`) 的一半, 与内容绑定 ——
 *  同 body 重放同 rev, 改了内容就是新 rev (§9.1)。 */
export const contentRev = (body: string): string => createHash("sha256").update(body).digest("hex").slice(0, 12);

/** 定论。`rev` 与内容绑定, 见 contentRev。 */
export const makeOutcome = (status: Terminal, body: string): Outcome =>
  ({ status, body, rev: contentRev(body) });

export const ops = {
  /** 插行。带 `after` = held (前置未落定, 先不投给 owner), 否则 open。 */
  open: (p: { event: EventId; owner: Key; receiver: Receiver; deadlineAt: number; at?: number; job?: string; asker?: Asker; after?: readonly EventId[] }): Op => ({
    op: "open", at: p.at ?? Date.now(), event: p.event, owner: p.owner, receiver: p.receiver, deadlineAt: p.deadlineAt,
    status: p.after?.length ? "held" : "open",
    ...(p.job ? { job: p.job } : {}),
    ...(p.asker ? { asker: p.asker } : {}),
    ...(p.after?.length ? { after: [...p.after] } : {}),
  }),
  /** held → open: 前置全落定。 */
  release: (p: { event: EventId; at?: number }): Op => ({ op: "release", at: p.at ?? Date.now(), event: p.event }),
  /** 中途态。带 body = 这份正文同时要进 receiver 收件箱 (`rcpt:<event>:<rev>`, §9.3); `rev`
   *  不给就按正文算 (与 outcome 同一个指纹)。 */
  mark: (p: { event: EventId; status: "open" | "need" | "error"; body?: string; rev?: string; at?: number }): Op => {
    const rev = p.rev ?? (p.body === undefined ? undefined : contentRev(p.body));
    return {
      op: "mark", at: p.at ?? Date.now(), event: p.event, status: p.status,
      ...(p.body !== undefined ? { body: p.body } : {}),
      ...(rev !== undefined ? { rev } : {}),
    };
  },
  /** transfer: 改 owner (前置 `waiting(event)` 为空, 否则 409 —— 校验在入口层)。 */
  move: (p: { event: EventId; owner: Key; at?: number }): Op => ({ op: "move", at: p.at ?? Date.now(), event: p.event, owner: p.owner }),
  /** 定论落 outbox。`late` = 行已落定之后 owner 的追述 (§4.3)。 */
  answer: (p: { event: EventId; outcome: Outcome; late?: true; at?: number }): Op => ({
    op: "answer", at: p.at ?? Date.now(), event: p.event, outcome: p.outcome, ...(p.late ? { late: true as const } : {}),
  }),
  /** 已入 receiver 收件箱 / 已排进群答复; `inbox` = 投递幂等 id。 */
  hand: (p: { event: EventId; inbox: string; at?: number }): Op => ({ op: "hand", at: p.at ?? Date.now(), event: p.event, inbox: p.inbox }),
  /** `pending_items({drop})`: 摘掉 receiver 挂的那一笔 (变 detach), 行不动。 */
  drop: (p: { event: EventId; at?: number }): Op => ({ op: "drop", at: p.at ?? Date.now(), event: p.event }),
  /** 墓碑回收。 */
  gc: (p: { event: EventId; at?: number }): Op => ({ op: "gc", at: p.at ?? Date.now(), event: p.event }),
};

// ── 派生查询 (§2.2): 全是现算, 不另存 ────────────────────────────────────

/** 行的稳定次序: 先按插入时刻, 再按 id —— 派生的列表 (waiting / chain / 名册) 都靠它定序。 */
const byAt = (rows: readonly Route[]): Route[] =>
  [...rows].sort((a, b) => a.at - b.at || (a.event < b.event ? -1 : a.event > b.event ? 1 : 0));
export const allRows = (table: Table): Route[] => byAt(Object.values(table));
export const routesOf = (table: Table, owner: Key): Route[] => byAt(Object.values(table).filter((r) => r.owner === owner));

/** receiver 指向 e 的行 (不论落定没有) —— 沿它往上走就是 chain / subtree 用的那条边。 */
const childrenOf = (table: Table, event: EventId): Route[] =>
  byAt(Object.values(table).filter((r) => r.receiver.kind === "wizard" && r.receiver.event === event));

/** receiver 指向 e、还没落定的行 —— 扇出的兄弟 / 挂着的子行 / 停在等 re 的 need。 */
export const waiting = (table: Table, event: EventId): Route[] => childrenOf(table, event).filter((r) => WAITING.has(r.status));

/** 沿 receiver 边往上走到 chat 或 detach (带环保护), 含起点那一行。方向闸 / 升级 / 判环用。 */
export const chain = (table: Table, event: EventId): Route[] => {
  const out: Route[] = [];
  const seen = new Set<EventId>();
  let cur: EventId | undefined = event;
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    const row: Route | undefined = table[cur];
    if (!row) break;
    out.push(row);
    cur = row.receiver.kind === "wizard" ? row.receiver.event : undefined;
  }
  return out;
};

/** receiver 边的传递闭包, 叶子先出 (级联取消按这个顺序落)。不含 e 自己。
 *  跨越 handed 的中间行: 父行先收口后, 它的子行是孤儿 (见 §4.3) —— 少走这一步就丢了一整支,
 *  而墓碑本身对取消是 no-op (定论写一次)。 */
export const subtree = (table: Table, event: EventId): Route[] => {
  const out: Route[] = [];
  const walk = (id: EventId, seen: Set<EventId>): void =>
    childrenOf(table, id).forEach((child) => {
      if (seen.has(child.event)) return;
      seen.add(child.event);
      walk(child.event, seen);
      out.push(child);
    });
  walk(event, new Set<EventId>([event]));
  return out;
};

/** 这一笔的定论是给人 / 群看的 —— topOnly 收口、eventFinalGate 三套推断都退化成这一条。 */
export const speaksToHuman = (table: Table, event: EventId): boolean => table[event]?.receiver.kind === "chat";

/** W 欠着的行 (含 held 的), 未 handed 的才算欠。 */
export const owedBy = (table: Table, owner: Key): Route[] => byAt(Object.values(table).filter((r) => r.owner === owner && isLive(r)));

/** 派给 W、还没了结的行 —— pending_items 的「我派出去还没了结的」。 */
export const awaitedBy = (table: Table, owner: Key): Route[] =>
  byAt(Object.values(table).filter((r) => r.receiver.kind === "wizard" && r.receiver.to === owner && isLive(r)));

/** 派给 W 的件里**已经有回执要交还给它的**那些 (含已 `handed` 的墓碑) —— `handed` 只说那份已进
 *  收件箱, 而收件箱里可能还排着队没投; `wait_peer` 按 event 取 outcome 从这里 (§9.5)。
 *  `awaitedBy` 是它的「还没了结」版: 一份定论一交付就出了 `awaitedBy`, 恰恰是这里要取的那份。 */
export const settledTo = (table: Table, owner: Key): Route[] =>
  byAt(Object.values(table).filter((r) => r.receiver.kind === "wizard" && r.receiver.to === owner
    && (r.outcome !== undefined || r.status === "need" || r.status === "error")));

// ── 工具参数的引用解析: 模型只说「对谁」, 那一笔由表推断 ──────────────────

/** 模型抄来的引用 → event id: 剥掉信封上 message-event 的 `route:` / `rcpt:` 前缀与
 *  `:rN` / `:resume` / `:<rev>` 后缀 (最常见的抄错就是抄了那一个)。 */
export const eventRef = (raw: unknown): string =>
  String(raw ?? "").replace(/[`\s]/g, "").replace(/^(?:route|rcpt|canceled|chat):/, "").replace(/:.*$/, "");
/** 是 event id (`e<hex>[.n…]`, T10 前的老件号 `t<hex>`) 而不是名字。 */
export const isEventRef = (s: string): boolean => /^[et][0-9a-f]{6,}(?:\.\d+)*$/.test(s);

const PAIR_LIVE: ReadonlySet<Status> = new Set<Status>(["held", "open", "need", "error"]);
export type PairPick = { ok: true; row?: Route } | { ok: false; many: Route[] };
/** `from` 派给 `to` (此刻的 owner, transfer 过就是接手方) 的「那一笔」: `hint` (本轮在读的那份回执)
 *  命中 → 它; 在飞的唯一 → 它; 多于一笔 → 歧义, 交给调用方列出来让模型指明; 没有在飞的 →
 *  最近一笔 (可能已落定, 也可能从没派过 = undefined)。 */
export const pickPair = (table: Table, from: Key, to: Key, hint?: EventId): PairPick => {
  // hint 不看 receiver: 沿链升级投来的回执, 行上的 receiver 还是那个已不在的 wizard。
  const hit = hint !== undefined && table[hint]?.owner === to ? table[hint] : undefined;
  if (hit) return { ok: true, row: hit };
  const rows = byAt(Object.values(table).filter((r) => r.receiver.kind === "wizard" && r.receiver.to === from && r.owner === to)).reverse();
  const live = rows.filter((r) => PAIR_LIVE.has(r.status));
  return live.length > 1 ? { ok: false, many: live } : { ok: true, ...(live[0] ?? rows[0] ? { row: live[0] ?? rows[0] } : {}) };
};

// ── 投递前的两处判定: 孤儿 (§4.3) 与升级 (§4.4) ────────────────────────────

/** 一笔结论实际要投给谁 —— 升级之后可能与行上写的 receiver 不同。 */
export interface Delivery {
  receiver: Receiver;
  /** 这一轮该服务的那一笔 (收方自己欠的): wizard 收方 = 它的 `receiver.event`, 群收方 = 没有 ("")。 */
  serves: EventId;
  /** 被跳过的、已经不在的 wizard (由近及远) —— 信封的 `via`。 */
  via: Key[];
}

/** 升级 (§4.4): 收方那个 wizard 已经不在注册表里 (被 stop / 注销) → 沿 receiver 边往上找第一个
 *  还活着的 receiver, 定论改投给它, 信封标 `via .W (已不在)`; 一路走到 chat 根 = Dead Letter
 *  (进那个群, 由那个群的顶层 wizard 收)。
 *
 *  - 「还活着」只认注册表: 注销 (forget) 才抹记录 —— 只是 pane 离线、或还没生出来的, 仍是它,
 *    定论留在它的持久化收件箱里等 (现状: 不为送回执重开会话)。
 *  - 认不出更上一层 (父行已 gc) 或链上成环 → 无处可升, 照旧进原收方的收件箱 (结论不丢)。
 *  原样能投 = undefined (调用方照旧走行上的 receiver)。 */
export const escalate = (table: Table, event: EventId, alive: (k: Key) => boolean): Delivery | undefined => {
  const start = table[event];
  if (!start || start.receiver.kind !== "wizard" || alive(start.receiver.to)) return undefined;
  const via: Key[] = [];
  const seen = new Set<EventId>([event]);
  let r: Receiver = start.receiver;
  while (r.kind === "wizard" && !alive(r.to)) {
    via.push(r.to);
    const up: Route | undefined = r.event !== undefined ? table[r.event] : undefined;
    if (!up || seen.has(up.event)) return undefined;
    seen.add(up.event);
    r = up.receiver;
  }
  return r.kind === "wizard" ? { receiver: r, serves: r.event ?? "", via } : { receiver: r, serves: "", via };
};

/** 孤儿 (§4.3): 这一笔的结论要服务的那一笔已经收口 (`answered` / `handed`), 或已不在表上 ——
 *  结论照投 (信封标迟到); 那一轮的终句要再往上冒, 得作为 f 的追述被 onFinal 收下 (见 retellOps),
 *  f 已回收 (gc) 就只进 rolepage。 */
export const isOrphaned = (table: Table, serves: EventId): boolean => {
  if (!serves) return false;
  const row = table[serves];
  return !row || row.status === "answered" || row.status === "handed";
};

// ── 终句 → op (§3.2 / §9.4): 纯函数, 落盘与投递是副作用层的事 ──────────────

/** owner 这一轮的终句 (注入事件的 result 正文)。 */
export interface FinalVerdict {
  text: string;
  /** 这一轮以 CLI 报错收尾 —— 中途态: 报给 receiver 等它续跑 / re, 不改写定论 (§2.3)。 */
  error?: boolean;
}

export type FinalKind = "need" | "result" | "progress" | "done";

/** 终句的语义: 显式标记优先 (NEED 是反问、RESULT 是定论), 未标记只看 `waiting(e)` ——
 *  还挂着子行 = 进展 (只进 rolepage, 行不动), 没有 = 定论 (§3.2)。 */
export const finalKind = (table: Table, event: EventId | undefined, text: string): FinalKind => {
  const kind = parseClosing(text).kind;
  if (kind === "need") return "need";
  if (kind === "result") return "result";
  return event !== undefined && waiting(table, event).length > 0 ? "progress" : "done";
};

/** owner 一轮结束时该落的那几条 op (§3.2 的表)。
 *
 *  - `serves` 缺省 / 没有这一行 = 这一轮不服务任何一笔 (人在 CLI 里敲的、detach 回执) → 无 op。
 *    没有行就没有 receiver, 也就无处投递 —— 所以这里不是「漏了」, 是没得投 (§9.4)。
 *  - 行已经 transfer 给别人 = 旧 owner 的终句不再算数 (§3.4) → 无 op。
 *  - held (还没投给 owner) 的行不收终句 → 无 op; 已落定的行只收 owner 的追述 (retellOps)。
 *  - NEED / error 是中途态, 行留着; 重复报同一状态也不再产 op (行状态就是那个去重记号)。 */
export const onFinal = (table: Table, owner: Key, serves: EventId | undefined, verdict: FinalVerdict): Op[] => {
  const row = serves !== undefined && serves !== "" ? table[serves] : undefined;
  if (!row || row.owner !== owner) return [];
  if (row.status === "answered" || row.status === "handed") return retellOps(table, row, verdict);
  if (row.status === "held") return [];
  if (verdict.error) return row.status === "error" ? [] : [ops.mark({ event: row.event, status: "error", body: verdict.text })];
  const kind = finalKind(table, row.event, verdict.text);
  if (kind === "need") return row.status === "need" ? [] : [ops.mark({ event: row.event, status: "need", body: verdict.text })];
  if (kind === "progress") return [];
  return [ops.answer({ event: row.event, outcome: makeOutcome("done", verdict.text) })];
};

/** daemon 合成的失败: 不是 owner 的定论, 所以它之后未标记的真答也算数。 */
const SYNTH: ReadonlySet<Terminal> = new Set<Terminal>(["timeout", "silent", "dead"]);

/** 已落定的行再收 owner 一轮终句 = 追述 (§4.3): 行的 receiver 边一直在, 追述沿它原路再投一次
 *  (新内容 = 新 rev, 同内容重放 = 无 op)。收不收由 owner 的标记定 (daemon 定路由, LLM 定语义):
 *  - 起初是合成失败 (timeout / silent / dead): 未标记的定论也收, 可收多次;
 *  - 起初是 done: 只收显式 `RESULT:` —— 未标记的是收到回执后的随口一句, 只进 rolepage;
 *  - `canceled` 一律不收: 那一笔是被人 / 随工单收掉的, 子树整支 TERMINATE (§4.2)。 */
const retellOps = (table: Table, row: Route, verdict: FinalVerdict): Op[] => {
  const o = row.outcome;
  if (verdict.error || !o || o.status === "canceled" || contentRev(verdict.text) === o.rev) return [];
  const kind = finalKind(table, row.event, verdict.text);
  const take = kind === "result" || (kind === "done" && SYNTH.has(row.settledAs ?? o.status));
  return take ? [ops.answer({ event: row.event, outcome: makeOutcome("done", verdict.text), late: true })] : [];
};

/** 这一轮的终句该不该进群 (eventFinalGate, §9.5): 没有行 = 老事件照放; held = 还没轮到它;
 *  在飞 = 不再挂着未落定的子行; 已落定 = 只放追述 —— 表上的 outcome 就是这句 (onFinal 已收下),
 *  或这句带 `RESULT:`、owner 还是它、那一笔没被收掉 (onFinal 会收下, 与它谁先跑无关)。 */
export const finalReleased = (table: Table, owner: Key, serves: EventId | undefined, body: string): boolean => {
  const row = serves ? table[serves] : undefined;
  if (!row) return true;
  if (row.status === "held") return false;
  if (row.status !== "answered" && row.status !== "handed") return waiting(table, row.event).length === 0;
  const o = row.outcome;
  return row.owner === owner && !!o && o.status !== "canceled"
    && (o.rev === contentRev(body) || parseClosing(body).kind === "result");
};

// ── 失败合成 (§4.2): 和 done 走同一条 outbox ──────────────────────────────
// 失败不是特例: timeout / silent / dead / canceled 都是一份定论 (`answer`), 走同一个
// receiver、同一条投递通路。合成完全在 daemon 这边做 —— 模型不报失败, 它只会没声。

/** 期限常量 (§9.6: 自 receipts 迁入): 对方最长允许干多久 / 期限的上下限。上限留在工单
 *  保留期内, 超时那份回执还得数得进账。 */
export const TARGET_WAIT_SEC = 3600;
export const DEADLINE_MIN_SEC = 60;
export const DEADLINE_MAX_SEC = 12 * 3600;
/** `at` 发出、给了 `sec` 秒 (缺省 / 越界取默认或夹到边上) 的期限。 */
export const deadlineOf = (at: number, sec?: number): number =>
  at + 1000 * (sec === undefined || !Number.isFinite(sec) ? TARGET_WAIT_SEC : Math.min(Math.max(sec, DEADLINE_MIN_SEC), DEADLINE_MAX_SEC));
/** pane 不在了, 隔这么久再看一眼才判 dead: 非交接的 pane 换新 (respawn) 也有几秒是死的。 */
export const DEAD_GRACE_MS = 5000;
/** 对方读进了我们这一句、停下了却没答 —— 连着这么多次就认定它不会答了 (§9.4)。 */
export const MAX_FRUITLESS = 3;

/** 失败回执的正文 (与 receipts 的 watcher 同一套文案): 守护进程的一句说明 + 对方最后一句
 *  (给发话方一点线索)。 */
export const failureText = (p: { who: string; why: string; last?: string }): string =>
  `（守护进程: ${p.who} 没有给出结论 —— ${p.why}。）${p.last ? `\n它最后说的: ${clipMiddle(p.last, 600)}` : ""}`;
/** 三种合成失败的「理由」半句 (主语由 failureText 写)。 */
export const failureWhy = (p: { status: "timeout" | "silent" | "dead"; minutes?: number; need?: boolean }): string =>
  p.status === "timeout"
    ? (p.need ? `它的反问 (NEED) 等了 ${p.minutes} 分钟没人答` : `等了 ${p.minutes} 分钟它还没答完`)
    : p.status === "silent" ? `它停下了 ${MAX_FRUITLESS} 次, 都没答这一句` : "它的 pane 没了";
/** 被收掉 / 打断 / 前置失败 的正文 (§4.2 canceled)。`reason` 是一整句 (含句号), 因为它
 *  有三种来路: 被谁收掉、随工单收了、等的前置以某结局收场。 */
export const canceledText = (p: { who?: string; reason: string; last?: string }): string =>
  `（守护进程: ${p.who ? `${p.who} ` : ""}${p.reason}）${p.last ? `\n它最后说的: ${clipMiddle(p.last, 600)}` : ""}`;

/** sweeper 的只读判据: 全是现算, 不落第二份数据 (不变量 4)。 */
export interface SweepSignals {
  now: number;
  /** owner 的 pane 已经死了多久 (没死 / 不知道 = undefined) —— 宽限的记账在 `sweep`。 */
  paneDeadForMs: (owner: Key) => number | undefined;
  /** 这一笔的注入事件停下没答了几次 (§9.4): `serves === event` 且 finished 无 result 的轮数。 */
  fruitless: (event: EventId) => number;
  /** owner 正在交接: pane 新旧交替的那几秒是死的, 别判 dead (旧 watcher 的 handedOff 同义)。 */
  handingOff?: (owner: Key) => boolean;
  /** owner 的称呼 / 它最后一句 —— 正文里的主语与线索。 */
  nameOf?: (owner: Key) => string;
  lastWords?: (owner: Key, since: number) => string | undefined;
}

/** 扫一遍在飞的行, 合成失败定论 (§4.2)。判定顺序即优先级: held 前置失败 → timeout → dead → silent
 *  —— 期限到了就是期限到了, 死没死都得报 timeout (旧 watcher 同序)。纯函数: 只产 op,
 *  落盘与投递在副作用层。 */
export const sweepOps = (table: Table, p: SweepSignals): Op[] => {
  const who = (w: Key): string => p.nameOf?.(w) ?? w;
  const last = (w: Key, since: number): string | undefined => p.lastWords?.(w, since)?.trim() || undefined;
  const failed = (r: Route, body: string, status: Terminal): Op =>
    ops.answer({ at: p.now, event: r.event, outcome: makeOutcome(status, body) });
  return allRows(table).flatMap((r): Op[] => {
    if (r.status === "held") {
      // 前置以非 done 收场: 这件没投, 也不投 —— 但发话方得知道, 附上前置的结局快照 (§4.2)。
      const bad = (r.after ?? []).map((a) => [a, table[a]] as const).find(([, x]) => !!x?.outcome && x.outcome.status !== "done");
      if (!bad) return [];
      const [a, x] = bad;
      const snap = `${a} (${who(x!.owner)}) 以 ${x!.outcome!.status} 收场`;
      return [failed(r, canceledText({ who: who(r.owner), reason: `等的前置 ${snap}, 这件 (${r.event}) 没投。`, last: last(r.owner, r.at) }), "canceled")];
    }
    if (r.status !== "open" && r.status !== "need" && r.status !== "error") return [];
    if (r.deadlineAt <= p.now) {
      const why = failureWhy({ status: "timeout", minutes: Math.round((p.now - r.at) / 60_000), need: r.status === "need" });
      return [failed(r, failureText({ who: who(r.owner), why, last: last(r.owner, r.at) }), "timeout")];
    }
    if ((p.paneDeadForMs(r.owner) ?? 0) >= DEAD_GRACE_MS && !(p.handingOff?.(r.owner) ?? false))
      return [failed(r, failureText({ who: who(r.owner), why: failureWhy({ status: "dead" }), last: last(r.owner, r.at) }), "dead")];
    if (p.fruitless(r.event) >= MAX_FRUITLESS)
      return [failed(r, failureText({ who: who(r.owner), why: failureWhy({ status: "silent" }), last: last(r.owner, r.at) }), "silent")];
    return [];
  });
};

/** 级联取消 (§4.2 TERMINATE): `subtree(e)` 全部 canceled —— **叶子先落**, 根最后 (父若先落,
 *  子行的失败就没处冒了)。返回要落的 op (按顺序): 谁该收到回执由副作用层判 —— 发起者
 *  就是 receiver 的那份不投 (它自己知道), 但行照样得落成墓碑, 不然一直挂在 owedBy 上。 */
export const cancelOps = (table: Table, roots: readonly EventId[], p: { reason: (r: Route) => string; at?: number; nameOf?: (w: Key) => string; lastWords?: (w: Key, since: number) => string | undefined }): Op[] => {
  const at = p.at ?? Date.now();
  const seen = new Set<EventId>();
  const order: Route[] = [];
  roots.forEach((root) => {
    [...subtree(table, root), table[root]].forEach((r) => {
      if (r && !seen.has(r.event)) { seen.add(r.event); order.push(r); }
    });
  });
  return order.flatMap((r): Op[] => {
    // 定论写一次 (不变量 2): 已 answered / handed 的行不再改写。
    if (r.status === "answered" || r.status === "handed") return [];
    const last = p.lastWords?.(r.owner, r.at)?.trim() || undefined;
    const body = canceledText({ who: (p.nameOf?.(r.owner) ?? r.owner), reason: p.reason(r), last });
    return [ops.answer({ at, event: r.event, outcome: makeOutcome("canceled", body) })];
  });
};

// ── 墓碑回收 (§4.6): compact 时的纯过滤 ──────────────────────────────────

/** 墓碑落定后保留多久: 这段时间里它仍是追述 / 升级 / 孤儿判定的路标。与工单已关行的保留期对齐。 */
export const TOMBSTONE_TTL_MS = 24 * 3600_000;

/** 能回收的行: 自己是满 TTL 的墓碑、没有 held 行的 `after` 等着它, 且整棵子树都能回收 ——
 *  子树闭合 (收一行必收它全部后代), 于是留下的行往上走 chain 永远走得通。没有 settledAt 的
 *  老行按 deadlineAt 起算 (合成 timeout 的时刻, 正常定论只会更早)。 */
export const collectable = (table: Table, now: number): Set<EventId> => {
  const rows = Object.values(table);
  const awaited = new Set(rows.flatMap((r) => (r.status === "held" ? r.after ?? [] : [])));
  const kids = rows.reduce((m, r) => {
    const up = r.receiver.kind === "wizard" ? r.receiver.event : undefined;
    return up === undefined ? m : m.set(up, [...(m.get(up) ?? []), r]);
  }, new Map<EventId, Route[]>());
  const memo = new Map<EventId, boolean>();
  const ok = (r: Route): boolean => {
    const hit = memo.get(r.event);
    if (hit !== undefined) return hit;
    memo.set(r.event, false); // 环保护: 回到自己 = 不收
    const v = r.status === "handed" && now - (r.settledAt ?? r.deadlineAt) >= TOMBSTONE_TTL_MS
      && !awaited.has(r.event) && (kids.get(r.event) ?? []).every(ok);
    memo.set(r.event, v);
    return v;
  };
  return new Set(rows.filter(ok).map((r) => r.event));
};

/** 表减去能回收的墓碑。 */
export const collect = (table: Table, now: number): Table => {
  const gone = collectable(table, now);
  return gone.size ? Object.fromEntries(Object.entries(table).filter(([e]) => !gone.has(e))) : table;
};

// ── 日志 (§2.3): 一行一条 op, 中间行坏 = 拒绝启动 ────────────────────────

/** `~/.wezard/routes.jsonl`。与 wizards.json 同级 (stateDir 在 state/ 下, 那是运行态)。 */
export const ROUTES_FILE = "~/.wezard/routes.jsonl";
/** 日志超过这么多行就压一次 —— 重放的成本压在 boot 上, 别让它随 daemon 的寿命长。 */
const COMPACT_AT = 512;

const OP_FIELDS: Readonly<Record<Op["op"], readonly string[]>> = {
  open: ["event", "owner", "receiver", "at", "deadlineAt"],
  release: ["event", "at"],
  mark: ["event", "status", "at"],
  move: ["event", "owner", "at"],
  answer: ["event", "outcome", "at"],
  hand: ["event", "inbox", "at"],
  drop: ["event", "at"],
  gc: ["event", "at"],
  row: ["event", "owner", "receiver", "status", "at", "deadlineAt", "seq"],
};
const STATUSES: ReadonlySet<string> = new Set<Status>(["held", "open", "need", "error", "answered", "handed"]);
const OPEN_STATUSES: ReadonlySet<string> = new Set(["open", "held"]);
/** mark 只落中途态 (`handed` 是墓碑, 不给 mark)。 */
const MARK_STATUSES: ReadonlySet<string> = new Set(["open", "need", "error"]);
const OUTCOME_STATUSES: ReadonlySet<string> = new Set<string>(["done", "timeout", "silent", "dead", "canceled"]);

const nonEmpty = (v: unknown): v is string => typeof v === "string" && v !== "";
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const receiverOk = (v: unknown): boolean => {
  const r = v as Receiver | undefined;
  if (!r) return false;
  return r.kind === "chat"
    ? typeof r.channel === "string" && nonEmpty(r.message)
    : r.kind === "wizard" && nonEmpty(r.to) && (r.event === undefined || typeof r.event === "string");
};
const outcomeOk = (v: unknown): boolean => {
  const o = v as Outcome | undefined;
  return !!o && OUTCOME_STATUSES.has(o.status) && typeof o.body === "string" && typeof o.rev === "string";
};

/** 一行日志 → 一条 op。认不出 = undefined —— 调用方据此判撕裂 (尾行) / 判坏行 (中间行)。
 *  形态要核到字段: 只认得出 `op` 还不够, 半行坏字段 fold 进表就是一行的错。 */
export const parseOp = (raw: string): Op | undefined => {
  let obj: unknown;
  try { obj = JSON.parse(raw); } catch { return undefined; }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return undefined;
  const o = obj as Record<string, unknown>;
  const op = o.op as Op["op"];
  if (!Object.prototype.hasOwnProperty.call(OP_FIELDS, op)) return undefined;
  if (!OP_FIELDS[op].every((f) => o[f] !== undefined)) return undefined;
  if (!nonEmpty(o.event) || !finite(o.at)) return undefined;
  if ("owner" in o && !nonEmpty(o.owner)) return undefined;
  if ("receiver" in o && !receiverOk(o.receiver)) return undefined;
  // status 按 op 分别核: mark 只落中途态, open 只开 open/held, row 快照必须给全。
  if (op === "mark" && !MARK_STATUSES.has(String(o.status))) return undefined;
  if (op === "open" && o.status !== undefined && !OPEN_STATUSES.has(String(o.status))) return undefined;
  if (op === "row" && !STATUSES.has(String(o.status))) return undefined;
  if (op === "row" && !finite(o.seq)) return undefined;
  if (op === "row" && o.settledAt !== undefined && !finite(o.settledAt)) return undefined;
  if (op === "row" && o.settledAs !== undefined && !OUTCOME_STATUSES.has(String(o.settledAs))) return undefined;
  if (op === "answer" && !outcomeOk(o.outcome)) return undefined;
  if (op === "hand" && !nonEmpty(o.inbox)) return undefined;
  return o as unknown as Op;
};

/** 逐行 parse 后 fold。只有最后一行容许撕裂 (崩溃中途写的半行), 丢掉它;
 *  中间行坏 = 表不可信 = 抛错拒绝启动。 */
export const foldJournal = (raw: string): { table: Table; commits: number; dropped: number } => {
  const lines = raw.split("\n").filter((l) => l.trim() !== "");
  const parsed = lines.map(parseOp);
  const lastAt = parsed.length - 1;
  const bad = parsed.findIndex((op, i) => !op && i !== lastAt);
  if (bad >= 0) {
    throw new Error(`routes.jsonl 第 ${bad + 1} 行不是一条合法 op —— 丢表 = 丢回执, 拒绝启动: ${clipLine(lines[bad] ?? "", 120)}`);
  }
  const commits = parsed.filter((op): op is Op => !!op);
  return { table: commits.reduce(step, EMPTY), commits: commits.length, dropped: parsed.length - commits.length };
};

/** tmp + rename 原子替换 (与 json-map-store 的严格写同形)。 */
const writeAtomic = (file: string, text: string): void => {
  const tmp = `${file}.${randomUUID()}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600 });
  const fd = openSync(tmp, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(tmp, file);
  const dir = openSync(dirname(file), "r");
  try { fsyncSync(dir); } finally { closeSync(dir); }
};

const fmtReceiver = (r: Receiver): string =>
  r.kind === "chat" ? `chat ${r.channel || "-"}#${r.message}` : `${r.to}${r.event ? `:${r.event}` : " (detach)"}`;

/** 诊断一行 (GET /routes): 一笔一行, 给人看。 */
export const renderRoute = (r: Route): string =>
  [
    r.event, r.status, `owner=${r.owner}`, `→ ${fmtReceiver(r.receiver)}`,
    `at=${new Date(r.at).toISOString()}`, `dl=${new Date(r.deadlineAt).toISOString()}`,
    r.seq ? `seq=${r.seq}` : "", r.job ? `job=${r.job}` : "",
    r.after?.length ? `after=${r.after.join(",")}` : "",
    r.outcome ? `${r.outcome.status}: ${clipLine(r.outcome.body, 80)}` : "",
    r.late ? "late" : "",
  ].filter(Boolean).join("  ");

export interface RouteDiagnostics {
  file: string;
  /** 盘上现在几行 (commit / 压实后跟着走)。 */
  opLines: number;
  /** 表里几行 (含 handed 的墓碑)。 */
  count: number;
  rows: Route[];
  /** 渲染好的正文 (空表 = "")。 */
  text: string;
}

export type Note = (msg: string, extra?: Record<string, unknown>) => void;

/** sweeper 的探针: 全是只读的, 由 daemon 注入 —— router 不认识 pane / transcript / 收件箱。 */
export interface SweepDeps {
  /** owner 的 pane 还在吗 (dead 判定)。一个 owner 每个 tick 只问一次 (它要 spawn tmux)。 */
  paneLive: (owner: Key) => Promise<boolean>;
  /** 这一笔的注入事件停下没答了几次 (§9.4) —— 由收件箱自己算, 不落第二份。 */
  fruitless: (event: EventId) => number;
  /** owner 正在交接 (pane 新旧交替的那几秒是死的)。 */
  handingOff?: (owner: Key) => boolean;
  nameOf?: (owner: Key) => string;
  lastWords?: (owner: Key, since: number) => string | undefined;
  now?: number;
}

export interface Router {
  readonly file: string;
  /** 当前 fold 结果 (只读快照)。 */
  table: () => Table;
  rows: () => Route[];
  get: (event: EventId) => Route | undefined;
  waiting: (event: EventId) => Route[];
  chain: (event: EventId) => Route[];
  subtree: (event: EventId) => Route[];
  speaksToHuman: (event: EventId) => boolean;
  owedBy: (owner: Key) => Route[];
  awaitedBy: (owner: Key) => Route[];
  /** `awaitedBy` 的含墓碑版: 有回执等着 W 取的 (wait_peer)。 */
  settledTo: (owner: Key) => Route[];
  /** 投递前的升级判定 (§4.4): 收方已注销 → 沿链找第一个还活着的 receiver; 原样能投 = undefined。 */
  escalate: (event: EventId, alive: (k: Key) => boolean) => Delivery | undefined;
  /** 孤儿判定 (§4.3): 结论要服务的那一笔已经收口 —— 结论照投, 标 `late`。 */
  isOrphaned: (serves: EventId) => boolean;
  /** 这一轮终句该不该进群 (eventFinalGate)。 */
  finalReleased: (owner: Key, serves: EventId | undefined, body: string) => boolean;
  /** 终句的语义 (need / result / progress / done) —— 诊断与影子对账要看的那一个词。 */
  finalKind: (serves: EventId | undefined, text: string) => FinalKind;
  /** owner 一轮结束时该落的 op (§3.2)。做完就交副作用层: 先落盘再投递 (§9.3)。 */
  onFinal: (owner: Key, serves: EventId | undefined, verdict: FinalVerdict) => Op[];
  /** 扫一遍在飞的行, 合成失败定论 (§4.2): 探一次 pane 死活 (5s 宽限由这里记账),
   *  其余判据现算。做完照旧交副作用层 —— 投递与 done 同一条路。 */
  sweep: (deps: SweepDeps) => Promise<Op[]>;
  /** 先落盘再改内存 —— 内存里有的, 盘上一定有 (不变量 1)。 */
  commit: (op: Op) => Table;
  /** 把 fold 结果重写成一组 row 快照行 (tmp + rename)。 */
  compact: () => void;
  diagnose: (owner?: Key) => RouteDiagnostics;
}

/** boot: 建表 (fold 一次), 之后每次 commit 先落盘。`note` = 日志回调 (省得 router 依赖 pino)。 */
export const openRouter = (opts: { file?: string; note?: Note } = {}): Router => {
  const file = expandHome(opts.file ?? ROUTES_FILE);
  const note: Note = opts.note ?? ((): void => {});
  let table: Table = EMPTY;
  let opLines = 0;
  let sinceCompact = 0;
  /** owner 的 pane 第一眼看到死掉的时刻 (§4.2 的 5s 宽限: 换新 / respawn 也有几秒是死的)。 */
  const deadSince = new Map<Key, number>();

  // 墓碑回收挂在压实上: 本来就要整份重写, 少写几行不多一次 IO。
  const compact = (): void => {
    const kept = collect(table, Date.now());
    const live = allRows(kept);
    writeAtomic(file, live.map((r) => `${JSON.stringify({ op: "row", ...r })}\n`).join(""));
    const gced = allRows(table).length - live.length;
    table = kept;
    opLines = live.length;
    sinceCompact = 0;
    note("routes journal compacted", { file, rows: live.length, gced });
  };

  if (existsSync(file)) {
    const { table: folded, commits, dropped } = foldJournal(readFileSync(file, "utf8"));
    table = folded;
    opLines = commits;
    note("routes journal folded", { file, commits, dropped, rows: allRows(table).length });
    // 撕裂的尾行 / 长日志: 就地压实一次, 让盘上不再留着已经丢掉的半行。
    if (dropped > 0 || commits > COMPACT_AT) compact();
  } else {
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, "");
    note("routes journal created", { file });
  }

  const commit = (op: Op): Table => {
    appendFileSync(file, `${JSON.stringify(op)}\n`);
    table = step(table, op);
    opLines += 1;
    if (++sinceCompact > COMPACT_AT) compact();
    return table;
  };

  return {
    file,
    table: () => table,
    rows: () => allRows(table),
    get: (event) => table[event],
    waiting: (event) => waiting(table, event),
    chain: (event) => chain(table, event),
    subtree: (event) => subtree(table, event),
    speaksToHuman: (event) => speaksToHuman(table, event),
    owedBy: (owner) => owedBy(table, owner),
    awaitedBy: (owner) => awaitedBy(table, owner),
    settledTo: (owner) => settledTo(table, owner),
    escalate: (event, alive) => escalate(table, event, alive),
    isOrphaned: (serves) => isOrphaned(table, serves),
    finalReleased: (owner, serves, body) => finalReleased(table, owner, serves, body),
    finalKind: (serves, text) => finalKind(table, serves, text),
    onFinal: (owner, serves, verdict) => onFinal(table, owner, serves, verdict),
    sweep: async (deps) => {
      const now = deps.now ?? Date.now();
      const live = allRows(table).filter((r) => r.status === "open" || r.status === "need" || r.status === "error");
      const owners = [...new Set(live.map((r) => r.owner))];
      // 一个 owner 只探一次: paneLive 要 spawn tmux, 十几路 fan-out 别按行探。
      for (const w of owners) {
        if (await deps.paneLive(w)) deadSince.delete(w);
        else if (!deadSince.has(w)) deadSince.set(w, now);
      }
      // 已经不在飞了, 别把它的死记账留着 (下次出生会白捡一个宽限)。
      for (const w of [...deadSince.keys()]) if (!owners.includes(w)) deadSince.delete(w);
      const since = (w: Key): number | undefined => { const t = deadSince.get(w); return t === undefined ? undefined : now - t; };
      return sweepOps(table, {
        now, paneDeadForMs: since, fruitless: deps.fruitless,
        ...(deps.handingOff ? { handingOff: deps.handingOff } : {}),
        ...(deps.nameOf ? { nameOf: deps.nameOf } : {}), ...(deps.lastWords ? { lastWords: deps.lastWords } : {}),
      });
    },
    commit,
    compact,
    diagnose: (owner) => {
      const rows = owner ? routesOf(table, owner) : allRows(table);
      return { file, opLines, count: rows.length, rows, text: rows.map(renderRoute).join("\n") };
    },
  };
};
