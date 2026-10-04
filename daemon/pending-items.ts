// 挂起事项 —— 一个 wizard 派出去、还没了结的事, 由守护进程记, 不靠模型记。
//
// 管家同时挂着好几件活时, 忘事的方式很固定: 某件回来问人拍板, 人隔了半小时才答, 那时
// 管家的上下文里早已是别的事, 人的那句话就被当成一件新活; 某件一直没回执, 没人想起来
// 去看; 交接 / `/clear` / 压缩之后, 手上挂着什么整个没了。这三种都不是「判断」出错,
// 是「记账」出错 —— 记账是确定性的事, 放进 daemon。
//
// 一行 = 一次派活 (tell_peer / spawn 带 task): 件号、对象、一句话题、为谁派的。状态不
// 由模型报: 在飞的那几种 (working / blocked / deferred) 读时从回执登记现算, 落定的那
// 一刻由回执回调写一次。「等人」= 回执是 NEED; 人在那件活的群里再开口 → 记「人已回话」,
// 发话方续问 (`re`) 或同一对改派 → 消掉。
//
// 提醒分两档, 都搭 notices 的那趟车 (注入边界上的 `<system-reminder>`), 不另占一轮:
//   增量 —— 只挂必要的一行: 某件刚变成「等人」、人在那个群里开口了、某件派出很久还没回执;
//   全表 —— 只在模型「快忘了」时给一次: 会话换了 (交接)、`/clear` 或压缩过、
//            离上次全表隔了很多轮或 ctx 涨了很多、某件挂了很久没动静。给了全表就不再挂增量。
// 平时不带整张表: 每轮都带的东西, 模型很快就学会不看了。
import type { JsonMap } from "../shared/json-map-store.js";
import type { Asker } from "../shared/detail-store.js";
import { renderReminder, type ReceiptStatus } from "../shared/reminder.js";
import type { TurnState } from "../shared/turn-state.js";
import { clipLine } from "../shared/std.js";
import type { ParentK } from "./receipts.js";

export interface Item {
  turn: string;
  /** 派活的那方 (target key)。 */
  owner: string;
  to: string;
  /** 派活文本的头一句。 */
  topic: string;
  /** 为谁派的: 群里哪句人话 / 上游哪件 (回执的父 k)。 */
  for?: ParentK;
  asker?: Asker;
  job?: string;
  at: number;
  /** 最近一次有动静 (派出 / 续问 / 回执) —— 「挂了很久没人提」从它算。 */
  touched: number;
  /** 最近一份回执的 status; 没有 = 还在飞。 */
  status?: ReceiptStatus;
  /** NEED 的那一问。 */
  ask?: string;
  /** 变成「等人」的时刻。 */
  waitHuman?: number;
  /** 那之后人在这件活的群里最近一次开口的时刻 (提示过一次; 是不是在答它由发话方判断)。 */
  heard?: number;
  closed?: { at: number; why: string };
  /** 每件每种提醒只提一次。 */
  told?: Partial<Record<Nudge, true>>;
}
type Nudge = "need" | "slow" | "idle";

/** 在飞的那件此刻的状态 (receipts.states 按件号给)。 */
export type LiveOf = (turn: string) => { state: TurnState } | undefined;

// ── 账本 ────────────────────────────────────────────────────────────

const KEEP_CLOSED_MS = 24 * 3600_000;
/** 开着没人管的也不留一辈子: 回执登记只留 24h, 过了它状态就算不出来了。 */
const EXPIRE_OPEN_MS = 48 * 3600_000;

const gc = (now: number) => (m: Record<string, Item>): Record<string, Item> =>
  Object.fromEntries(Object.entries(m).filter(([, x]) => (x.closed ? now - x.closed.at < KEEP_CLOSED_MS : now - x.touched < EXPIRE_OPEN_MS)));
export const pendingGc = (m: Record<string, Item>): Record<string, Item> => gc(Date.now())(m);

/** 派活文本 → 一句话题: 首个非空行, 去掉 markdown 起头符号。 */
export const topicOf = (text: string): string =>
  clipLine((text.split("\n").map((l) => l.replace(/^[\s>#*\-\d.、)]+/, "").trim()).find(Boolean) ?? ""), 60);

const isFailure = (st?: ReceiptStatus): boolean => st === "timeout" || st === "silent" || st === "dead" || st === "canceled";

export interface Ledger {
  /** 一次新派活。同一对之前还开着的那件被顶掉 (回执登记也是一对一份, 旧那份不会再回来)。 */
  open: (x: { turn: string; owner: string; to: string; text: string; for?: ParentK; asker?: Asker; job?: string; at: number }) => void;
  /** 续问 (`re`) —— 同一件接着说: 清掉「等人」, 回到在飞; 已关掉的重新打开。 */
  touch: (owner: string, turn: string) => void;
  /** 回执落了一份。`bySender` = 发话方自己收掉 / 取走的, 它自己知道, 直接关。 */
  outcome: (owner: string, turn: string, status: ReceiptStatus, body: string, bySender?: boolean) => void;
  /** 显式消项; 返回消掉的。 */
  drop: (owner: string, turns: readonly string[], why: string) => Item[];
  closeJob: (job: string) => void;
  openOf: (owner: string) => Item[];
  /** 改一行 (提醒标记 / 人已回话)。 */
  put: (x: Item) => void;
}

export const createLedger = (store: JsonMap<Item>, now: () => number = Date.now): Ledger => {
  const all = (): Item[] => Object.values(store.all());
  const close = (x: Item, why: string): void => { store.set(x.turn, { ...x, closed: { at: now(), why } }); };
  const find = (owner: string, turn: string): Item | undefined => {
    const x = store.get(turn);
    return x && x.owner === owner && !x.closed ? x : undefined;
  };
  return {
    open: ({ text, ...x }) => {
      all().filter((y) => !y.closed && y.owner === x.owner && y.to === x.to && y.turn !== x.turn).forEach((y) => close(y, "同一对又派了一件, 旧的回执不会再来"));
      store.set(x.turn, { ...x, topic: topicOf(text), touched: x.at });
    },
    touch: (owner, turn) => {
      // 关掉了的也认: 对 done / drop / 失败的那件 re, 这一句又在飞了。
      const x = store.get(turn);
      if (!x || x.owner !== owner) return;
      const { status: _s, ask: _a, waitHuman: _w, heard: _h, told: _t, closed: _c, ...rest } = x;
      store.set(turn, { ...rest, touched: now() });
    },
    outcome: (owner, turn, status, body, bySender) => {
      const x = find(owner, turn);
      if (!x) return;
      if (status === "done" || bySender) { close(x, bySender ? "你自己收掉 / 取走了" : "done"); return; }
      // 有了新回执就是有动静: 「挂太久」「派出太久」的提醒从这里重新计。
      const base = { ...x, status, touched: now(), told: { ...x.told, idle: undefined, slow: undefined } };
      // 为上游 wizard 派的活, 反问是问发话方的 (它去问上游), 不挂「等人」。
      const ask = clipLine(body.replace(/^[\s\S]*NEED\s*[:：]\s*/, ""), 120);
      store.set(turn, status !== "need" ? base
        : x.for?.kind === "peer" ? { ...base, ask }
          : { ...base, ask, waitHuman: now(), heard: undefined, told: { ...base.told, need: undefined } });
    },
    drop: (owner, turns, why) => {
      const hit = turns.map((t) => find(owner, t.replace(/[`\s]/g, ""))).filter((x): x is Item => !!x);
      hit.forEach((x) => close(x, why || "发话方消掉"));
      return hit;
    },
    closeJob: (job) => all().filter((x) => !x.closed && x.job === job).forEach((x) => close(x, "工单收了")),
    openOf: (owner) => all().filter((x) => !x.closed && x.owner === owner).sort((a, b) => a.at - b.at),
    put: (x) => { store.set(x.turn, x); },
  };
};

// ── 渲染 ────────────────────────────────────────────────────────────

export const ago = (ms: number): string =>
  ms < 60_000 ? "刚刚" : ms < 3_600_000 ? `${Math.round(ms / 60_000)}m` : `${Math.round(ms / 3_600_000)}h`;

/** 一行的状态词。等人 / 人已回话 / 没结论 优先于在飞的细分。 */
export const stateOf = (x: Item, live: LiveOf, at: number): string =>
  x.waitHuman ? (x.heard ? `等人拍板 (人${at - x.heard < 60_000 ? "刚" : ` ${ago(at - x.heard)} 前`}在群里开过口, 是不是在答它由你判断)` : "等人拍板")
    : x.status === "need" ? "它在反问, 等你答"
      : x.status === "error" ? "CLI 报错停了"
        : isFailure(x.status) ? `没结论 (${x.status})`
          : live(x.turn)?.state ?? "在飞";

export interface Names {
  nameOf: (target: string) => string;
  chatOf: (base: string) => string;
}

const forOf = (x: Item, n: Names): string =>
  x.for?.kind === "peer" ? `为 ${n.nameOf(x.for.from)} 的 \`${x.for.turn}\``
    : x.for?.kind === "chat" ? `为群 ${n.chatOf(x.for.channel)}${x.asker ? ` 的 ${x.asker.who.replace(/^user:/, "")}` : ""}`
      : "";

export const renderRow = (x: Item, live: LiveOf, n: Names, at: number): string =>
  [
    `- \`${x.turn}\` → ${n.nameOf(x.to)} · ${stateOf(x, live, at)} ${ago(at - (x.waitHuman ?? x.at))}`,
    `「${x.topic}」`,
    forOf(x, n),
    x.job ? `工单 ${x.job}` : "",
  ].filter(Boolean).join(" · ") + (x.ask ? `\n  它问: ${x.ask}` : "");

const HOWTO = "答它 / 转达人的话 → `tell_peer({name, re: 件号})`; 没结论的改派或 re 追问; 不再要了 → `pending_items({drop:[件号]})`";

/** 等人验收的一行: 需求已交付、根单还开着, 等人说「好」或「不对」。 */
export const renderAwaiting = (title: string, job: string, deliveredAt: number, at: number): string =>
  `- 等验收 · ${title} (${job}) 交付于 ${at - deliveredAt < 60_000 ? "刚刚" : `${ago(at - deliveredAt)} 前`}`;

/** lead 没交差的一行: 要管家重派或关单。 */
export const renderStalled = (title: string, job: string, status: string): string =>
  `- lead 没交差 (${status}) · ${title} (${job})`;

const ACCEPT_HOWTO = "等验收的: 人认可 → `close_job(单号)` 归档; 人说不对 → `tell_peer({name: lead, re, job: 单号})` 返工 (同一张单); 人说不要了 → `close_job({job, as:\"cancel\"})`; 先放着 → `close_job({job, as:\"shelve\"})` (停提醒, 不关单)。对人别提单号。";
const SHELVED_HOWTO = "搁置的: 人又提起 → `close_job({job, as:\"resume\"})` 恢复 (给 lead `re` 或带 `job` 派话也会自动恢复); 不要了 → `as:\"cancel\"`。";

/** 搁置的一行: 需求根单被人说先放着, 账本留着、不再冒泡提醒。 */
export const renderShelved = (title: string, job: string, heldAt: number, at: number): string =>
  `- 搁置 · ${title} (${job}) 搁置于 ${at - heldAt < 60_000 ? "刚刚" : at - heldAt >= 24 * 3_600_000 ? `${Math.floor((at - heldAt) / (24 * 3_600_000))} 天前` : `${ago(at - heldAt)} 前`}`;
const STALLED_HOWTO = "lead 没交差的: lead 还在 → `tell_peer({name: lead, re, job})` 叫它续; 否则 `close_job(单号)` 关掉, 需要的话重新 `dispatch({lead:true})` 开新单。";

/** 读全表 (pending_items 的回包)。`awaiting` = 等验收的根单行 (见 renderAwaiting)。 */
export const renderTable = (xs: readonly Item[], live: LiveOf, n: Names, at: number, awaiting: readonly string[] = [], stalled: readonly string[] = [], shelved: readonly string[] = []): string =>
  xs.length || awaiting.length || stalled.length || shelved.length
    ? [
        ...(xs.length ? [`派出去还没了结的 ${xs.length} 件 (守护进程按回执算的):`, ...xs.map((x) => renderRow(x, live, n, at)), HOWTO] : []),
        ...(awaiting.length ? [`等人验收的 ${awaiting.length} 件:`, ...awaiting, ACCEPT_HOWTO] : []),
        ...(stalled.length ? [`卡住的需求单 ${stalled.length} 件:`, ...stalled, STALLED_HOWTO] : []),
        ...(shelved.length ? [`搁置的 ${shelved.length} 件:`, ...shelved, SHELVED_HOWTO] : []),
      ].join("\n")
    : "没有挂着的事。";

// ── 提醒 ────────────────────────────────────────────────────────────

/** 隔这么多次注入没给过全表, 再给一次。 */
export const FULL_EVERY = 15;
/** ctx 比上次全表时涨了这么多, 前面的账多半已经沉到底了。 */
export const FULL_CTX_GROWTH = 80_000;
/** 在飞这么久还没回执 → 提一行。 */
export const SLOW_MS = 30 * 60_000;
/** 「等人」的件, 人在那个群里再开口时提示「可能在答它」—— 同一件至多这么久提一次。 */
export const HEARD_EVERY_MS = 10 * 60_000;
/** 这么久没动静 (没回执、没续问) → 给一次全表。 */
export const IDLE_MS = 2 * 3600_000;

/** 上次给全表时的样子, 以及之后注入过几次。纯内存: reload 后头一次见到只立基线。 */
export interface Mark { sid: string; ctx: number; ctxAtFull: number; drains: number }

export interface DigestIn {
  items: readonly Item[];
  mark: Mark | undefined;
  session: { sid: string; ctx: number } | undefined;
  /** 上次注入之后上下文被 /clear 或压缩截断过 (mirror 的 onContextCut)。 */
  cut?: "clear" | "compact";
  /** 这次注入是人在 `channel` 里说的话。 */
  human?: { channel: string };
  now: number;
  nameOf: (target: string) => string;
}

export interface DigestOut {
  /** 全表的理由; 空 = 不给全表。 */
  full: string;
  /** 增量行 (全表时只有「这句可能在答哪件」)。 */
  lines: string[];
  /** 要写回账本的那几行 (提醒标记 / 人已回话)。 */
  touched: Item[];
  mark: Mark;
}

const chatOfItem = (x: Item): string => (x.for?.kind === "chat" ? x.for.channel : x.asker?.chat ?? "");

/** 这一次注入该挂什么 —— 纯函数: 全表的触发、增量的那几行、要记下的「提过了」。 */
export const digest = (d: DigestIn): DigestOut => {
  const cur = d.session ?? { sid: d.mark?.sid ?? "", ctx: d.mark?.ctx ?? 0 };
  const base: Mark = { sid: cur.sid, ctx: cur.ctx, ctxAtFull: cur.ctx, drains: 0 };
  if (!d.items.length) return { full: "", lines: [], touched: [], mark: base };
  // 头一次见到 (reload 后 / 第一件刚挂上): 只立基线, 不给全表; 增量照算。
  const m = d.mark ?? base;
  const idle = d.items.filter((x) => !x.told?.idle && d.now - x.touched >= IDLE_MS);
  const why = !d.mark ? "" : [
    m.sid && cur.sid && m.sid !== cur.sid ? "会话换过 (交接 / /clear), 之前的账不在你上下文里了" : "",
    d.cut ? (d.cut === "clear" ? "刚 /clear 过" : "上下文刚被压缩过") : "",
    m.drains + 1 >= FULL_EVERY ? `离上次全表已经 ${m.drains + 1} 轮` : "",
    cur.ctx - m.ctxAtFull >= FULL_CTX_GROWTH ? `离上次全表 ctx 又涨了 ${Math.round((cur.ctx - m.ctxAtFull) / 1000)}k` : "",
    idle.length ? `${idle.map((x) => `\`${x.turn}\``).join(" ")} 挂了 ${ago(d.now - Math.min(...idle.map((x) => x.touched)))} 没动静` : "",
  ].filter(Boolean)[0] ?? "";
  const to = (x: Item): string => d.nameOf(x.to);
  const inChat = (x: Item): boolean => !!d.human && (!chatOfItem(x) || chatOfItem(x) === d.human.channel);
  // 「这句可能在答哪件」与全表无关: 全表只摆出等人的件, 不知道人此刻开了口。
  const heard = (x: Item): boolean => !!x.waitHuman && inChat(x) && (!x.heard || d.now - x.heard >= HEARD_EVERY_MS);
  const heardLine = (x: Item): string => `heard? ${x.turn} ${to(x)} asked: ${x.ask ?? x.topic}`;
  if (why) {
    // 全表把各件都摆出来了: 它们各自那一行增量不必再提。
    const touched = d.items.map((x) => ({
      ...x,
      ...(heard(x) ? { heard: d.now } : {}),
      told: { ...x.told, ...(d.now - x.touched >= IDLE_MS ? { idle: true as const } : {}), ...(x.waitHuman ? { need: true as const } : {}), ...(d.now - x.touched >= SLOW_MS ? { slow: true as const } : {}) },
    }));
    return { full: why, lines: d.items.filter(heard).map(heardLine), touched, mark: base };
  }
  const steps = d.items.map((x): { line: string; next: Item } | undefined => {
    if (heard(x)) return { line: heardLine(x), next: { ...x, heard: d.now, told: { ...x.told, need: true } } };
    if (x.waitHuman && !x.told?.need) {
      return { line: `need ${x.turn} ${to(x)} asks the human: ${x.ask ?? x.topic}`, next: { ...x, told: { ...x.told, need: true } } };
    }
    if (!x.status && !x.told?.slow && d.now - x.touched >= SLOW_MS) {
      return { line: `slow ${x.turn} → ${to(x)} ${ago(d.now - x.touched)} since ${x.touched > x.at ? "re-ask" : "sent"}, no receipt: ${x.topic}`, next: { ...x, told: { ...x.told, slow: true } } };
    }
    return undefined;
  });
  const hit = steps.filter((s): s is { line: string; next: Item } => !!s);
  return {
    full: "",
    lines: hit.map((s) => s.line),
    touched: hit.map((s) => s.next),
    mark: { ...m, sid: cur.sid || m.sid, ctx: cur.ctx || m.ctx, drains: m.drains + 1 },
  };
};

/** 增量那几行 (need / heard? / slow) 怎么接 —— 窗口里没给过才挂 (`rule`)。 */
const RULE = "Pending (daemon-tracked). need: the human must answer → relay via tell_peer({name, re}). heard?: their line may be that answer → relay, else ignore. slow: no receipt yet, peek_peer if stuck. FYI — don't reply; pending_items = full list.";

/** 增量那几行 / 全表 → 挂在注入尾巴上的那段。 */
export const renderDigest = (o: DigestOut, table: string, rule = true): string =>
  o.full
    ? renderReminder({ wezard: "pending", mode: "full" }, [
        ...(rule ? [RULE] : []),
        `Full list (${o.full}):`,
        table,
        ...o.lines.map((l) => `- ${l}`),
      ])
    : o.lines.length
      ? renderReminder({ wezard: "pending", mode: "delta" }, [
          ...(rule ? [RULE] : []),
          ...o.lines.map((l) => `- ${l}`),
        ])
      : "";
