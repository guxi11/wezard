// 名册增量 —— 「你不在场的时候, 这个网络变了」。
//
// charter (wizard.ts) 是 spawn 那一刻的快照: 它列出出生时群里有谁。快照只会越来
// 越假 —— 新分身出生、老 wizard 收工、谁改了职责, 它一概不知道, 除非自己去
// wizard_roster 问。问一次要花一轮, 于是实际上没人问。
//
// 这里是另一半。变动发生时不打扰任何人, 只把一条事件投进每个相关 wizard 的信箱;
// 下一次**无论谁**往它那儿注入点什么 (人在群里说话、同伴派活、定时任务到点),
// 这些行以 `<system-reminder>` 的形式挂在那段文本尾巴上一起进去。不占一轮、不进
// 气泡、不进 transcript (META_RE 会把它剥掉)。点名提示 (mention) 与挂起事项
// (pending) 走同一条边界, 由 noticeSuffixFor 一并拼出。
//
//   感知 = spawn 时的快照 + turn 时的增量。两者都不花额外的轮次。
//
// 尾巴每一轮都要付钱, 所以拼的时候看一眼「近 SEEN_DEPTH 次注入里挂过什么」(SeenRing):
// 同一个 wizard 的点名说明、同一行变动、每段固定的规矩, 窗口里给过就不再给 —— 它们
// 还在模型的上下文里。窗口随会话走: 换了 sid (交接 / 重生)、/clear、压缩、新宪章,
// 都清零重来。窗口落盘, 否则 reload 之后每个 pane 的头一条注入又把整段说明挂一遍。
//
// 信箱投递即清空: 那一次注入失败的话这几行就丢了。通知是提示, 真相永远可以
// wizard_roster 问到; 为一行提示做可靠投递不值当。信箱是纯内存的, daemon 重启即
// 清空 —— 同 graph run, 诚实地说: pane 还在, 没送到的提示没了。
import { homedir } from "node:os";
import { baseOfKey } from "../shared/session-label.js";
import { renderReminder } from "../shared/reminder.js";
import { clipLine } from "../shared/std.js";
import type { JsonMap } from "../shared/json-map-store.js";

/** 一次名册变动。`name` / `by` 是给模型看的称呼 (`.x`)。 */
export type Notice =
  | { op: "born"; name: string; by: string; clone?: boolean; ctx?: string; job?: string; cwd?: string }
  | { op: "ended"; name: string; by?: string; why?: string }
  | { op: "renamed"; name: string; was: string; job?: string }
  | { op: "job"; name: string; job: string }
  | { op: "chat"; name: string }
  | { op: "note"; text: string };

/** 近几次注入里挂过这个键没有。 */
export type Seen = (key: string) => boolean;
/** 尾巴上的一段: 照「近来挂过什么」现算, 交回正文与这次挂了哪些键。 */
export interface Section { text: string; keys: readonly string[] }
export type Part = (seen: Seen) => Section;
const none: Section = { text: "", keys: [] };

/** 这一次注入是从哪来的 —— 人在某个群里说的话, 还是别的 (同伴 / 回执 / 定时)。 */
export interface Via { human?: { channel: string } }

export interface NoticeBox {
  /** 把一条变动投给一批 wizard。自己做的事自己知道, 所以调用方负责把当事人排除在外。
   *  字符串 = 一行自由文字 (note)。 */
  post: (audience: readonly string[], n: Notice | string) => void;
  /** 取走并清空某个 wizard 的待投递变动。 */
  drain: (target: string) => Notice[];
  /** 这一次注入的整条尾巴 (前置段 + 名册 + 挂起事项), 并把挂了什么记进窗口。 */
  suffix: (target: string, via: Via, lead: readonly Part[]) => string;
  /** 它的上下文不再含有之前挂过的那些 (/clear / 压缩 / 新宪章): 窗口清零。 */
  forget: (target: string) => void;
}

// ── 近 N 次注入的窗口 ────────────────────────────────────────────────
export const SEEN_DEPTH = 10;
/** 一个 pane 的窗口: 最近几次注入各挂了哪些键 (新的在后)。`sid` 变了就整份作废。 */
export interface SeenRow { sid: string; at: number; ring: string[][] }

export interface SeenRing {
  of: (target: string) => Seen;
  push: (target: string, keys: readonly string[]) => void;
  reset: (target: string) => void;
}

const STALE_MS = 7 * 24 * 3600_000;
/** 一周没注入过的 pane 不再记。 */
export const gcSeen = (rows: Record<string, SeenRow>, now = Date.now()): Record<string, SeenRow> =>
  Object.fromEntries(Object.entries(rows).filter(([, r]) => now - r.at < STALE_MS));

/** `store` 不给 = 纯内存。`sidOf` 给出此刻的会话 id ("" = 不知道, 不据此作废)。 */
export const createSeenRing = (store: JsonMap<SeenRow> | undefined, sidOf: (t: string) => string, depth = SEEN_DEPTH): SeenRing => {
  const mem = new Map<string, SeenRow>(Object.entries(store?.all() ?? {}));
  const live = (t: string): SeenRow | undefined => {
    const r = mem.get(t);
    const sid = sidOf(t);
    // 没记 sid 的那行 (当时还不知道是哪段会话) 不能证明「这一段见过」: 已知会话下作废。
    return r && (!sid || r.sid === sid) ? r : undefined;
  };
  const put = (t: string, r: SeenRow | undefined): void => {
    if (r) { mem.set(t, r); store?.set(t, r); } else if (mem.delete(t)) store?.drop(t);
  };
  return {
    of: (t) => {
      const ks = new Set((live(t)?.ring ?? []).flat());
      return (k) => ks.has(k);
    },
    push: (t, keys) => {
      const prev = live(t)?.ring ?? [];
      // 一路空着的窗口不必为又一次空注入写盘。
      if (!keys.length && !prev.some((s) => s.length)) return;
      put(t, { sid: sidOf(t) || mem.get(t)?.sid || "", at: Date.now(), ring: [...prev, [...keys]].slice(-depth) });
    },
    reset: (t) => put(t, undefined),
  };
};

// ── 名册变动: 净化与渲染 ─────────────────────────────────────────────
const nameOf = (n: Notice): string | undefined => ("name" in n && n.op !== "chat" ? n.name : undefined);

/** 两次注入之间生了又收掉的: 那一段关于它的全部变动净值为零, 一并略过。
 *  先收后生 (同名顶替) 是真变化, 保留。 */
export const netNotices = (ns: readonly Notice[]): Notice[] => {
  const void_ = ns.flatMap((n, j) => {
    if (n.op !== "ended") return [];
    const i = ns.findIndex((b, k) => k < j && b.op === "born" && b.name === n.name);
    return i < 0 ? [] : [[i, j, n.name] as const];
  });
  return ns.filter((n, k) => !void_.some(([i, j, name]) => k >= i && k <= j && nameOf(n) === name));
};

const HOME = homedir();
export const tildePath = (p: string): string => (p === HOME || p.startsWith(`${HOME}/`) ? `~${p.slice(HOME.length)}` : p);
/** logfmt 的值: 有空白 / 引号 / `=` 才加引号。 */
const val = (s: string): string => (/[\s"=]/.test(s) ? `"${s.replace(/"/g, "'")}"` : s);
const kv = (k: string, v: string | undefined): string => (v ? ` ${k}=${val(v)}` : "");
const clip = (s: string): string => clipLine(s, 80);

/** 一条变动 → 一行 logfmt (`op .name k=v …`)。`cwd` = 收件人自己的工作区: 同一个就不提。 */
export const renderNotice = (n: Notice, cwd = ""): string => {
  switch (n.op) {
    case "born":
      return `born ${n.name}${kv("by", n.by)} ${n.clone ? "clone" : "spawn"}${kv("ctx", n.ctx)}${kv("job", n.job && clip(n.job))}${n.cwd && n.cwd !== cwd ? kv("cwd", tildePath(n.cwd)) : ""}`;
    case "ended":
      return `ended ${n.name}${kv("by", n.by)}${n.why ? ` ${n.why}` : ""}`;
    case "renamed":
      return `renamed ${n.name}${kv("was", n.was)}${kv("job", n.job && clip(n.job))}`;
    case "job":
      return `job ${n.name}${kv("job", clip(n.job))}`;
    case "chat":
      return `chat ${val(n.name)} auto-named (usable as \`chat\` in notify / spawn_wizard)`;
    case "note":
      return `note ${n.text}`;
  }
};

const HOLE = "\u0000";
/** 名字挖掉之后的那一行: 生 / 收的模板相同 = 除了是谁之外处处相同, 可以并成一行。 */
const templateOf = (n: Notice, cwd: string): string =>
  n.op === "born" || n.op === "ended" ? renderNotice({ ...n, name: HOLE }, cwd) : renderNotice(n, cwd);
const listNames = (xs: readonly string[]): string => (xs.length <= 4 ? xs.join(" ") : `${xs.slice(0, 3).join(" ")} …(+${xs.length - 3})`);

/** 同一模板的几条并成一行, 名字依次列出 —— 一批分身一起收掉只占一行, 不是九行。 */
export const groupRows = (ns: readonly Notice[], cwd: string): string[] => {
  const groups = ns.reduce(
    (acc, n) => ((k) => acc.set(k, [...new Set([...(acc.get(k) ?? []), nameOf(n) ?? ""])]))(templateOf(n, cwd)),
    new Map<string, string[]>(),
  );
  return [...groups].map(([tpl, names]) => tpl.replace(HOLE, listNames(names)));
};

/** 群况快照的一行: 此刻在这个聊天里、与收件人相关的一个 wizard。 */
export interface SnapRow { name: string; state: "busy" | "idle" | "-"; job: string }
export const SNAP_MAX = 16;
/** CSV 的值: 有逗号 / 引号才加引号 (内部引号双写)。 */
const csv = (s: string): string => (/[",]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
/** 快照 → `name,state,job` 表; 太多就截断并指路 wizard_roster。 */
export const renderSnapshot = (rows: readonly SnapRow[]): string[] => [
  "name,state,job",
  ...rows.slice(0, SNAP_MAX).map((r) => [r.name, r.state, csv(clip(r.job))].join(",")),
  ...(rows.length > SNAP_MAX ? [`…(+${rows.length - SNAP_MAX}) wizard_roster`] : []),
];
/** 生 / 收 / 改职责 / 改名 —— 快照的表里已经是它们之后的样子。 */
const subsumed = (n: Notice): boolean => n.op === "born" || n.op === "ended" || n.op === "job" || n.op === "renamed";

/** 名册那一段。去重按单条 (`r:<那一行>`) 记, 渲染时再并行; 规矩只在窗口里没给过时给。
 *  `snap` 给了 (长住的收件人) 且窗口里没给过整表: 给一份此刻的群况表 (mode=full) ——
 *  会话一换窗口就清零, 所以交接 / /clear 后的头一条注入必带; 表里已是变动之后的样子,
 *  生收改名那几行一并记作给过, 只剩 note 照挂。 */
export const rosterPart = (ns: readonly Notice[], cwd: string, snap?: () => readonly SnapRow[]): Part => (seen) => {
  const fresh = [...new Map(netNotices(ns).map((n) => [renderNotice(n, cwd), n] as const))].filter(([r]) => !seen(`r:${r}`));
  const table = snap && !seen("roster:full") ? snap() : undefined;
  if (table?.length) {
    const notes = fresh.filter(([, n]) => !subsumed(n));
    return {
      text: renderReminder({ wezard: "roster", mode: "full" }, [
        "Wizards in this chat now (state as of this message; truth: wizard_roster). FYI only — don't reply.",
        ...renderSnapshot(table),
        ...groupRows(notes.map(([, n]) => n), cwd).map((r) => `- ${r}`),
      ]),
      keys: ["roster:full", ...fresh.map(([r]) => `r:${r}`)],
    };
  }
  if (!fresh.length) return none;
  const rows = groupRows(fresh.map(([, n]) => n), cwd);
  const rule = !seen("rule:roster");
  return {
    text: renderReminder({ wezard: "roster" }, [
      ...(rule ? ["Roster changes since your charter snapshot (truth: wizard_roster). FYI only — don't reply or relay; skip if irrelevant."] : []),
      ...rows.map((r) => `- ${r}`),
    ]),
    keys: [...(rule ? ["rule:roster"] : []), ...fresh.map(([r]) => `r:${r}`)],
  };
};

/** `max`: 每个信箱最多攒几条 —— 一个挂了很久的 wizard 不该在醒来时读一部编年史,
 *  溢出时留最新的那些 (旧的那些多半已经被后面的变动覆盖了)。
 *  `probe` 是投递那一刻现算的行 (不是谁投进来的, 而是「此刻它的状态值得提一句」,
 *  如上下文快满); 排在信箱里的那些前面。
 *  `digest` 是另一类搭车的: 投递那一刻现算、自带壳的整段 (挂起事项, 见 pending-items.ts)。 */
export const createNoticeBox = (o: {
  max?: number;
  probe?: (target: string) => string[];
  digest?: (target: string, via: Via) => Part;
  /** 该给群况快照的收件人 → 此刻的表; undefined = 只给变动。 */
  snapshot?: (target: string) => (() => readonly SnapRow[]) | undefined;
  seen?: SeenRing;
  cwdOf?: (target: string) => string;
} = {}): NoticeBox => {
  const max = o.max ?? 24;
  const boxes = new Map<string, Notice[]>();
  const ring = o.seen ?? createSeenRing(undefined, () => "");
  const drain = (target: string): Notice[] => {
    const ns = [...(o.probe?.(target) ?? []).map((text): Notice => ({ op: "note", text })), ...(boxes.get(target) ?? [])];
    boxes.delete(target);
    return ns;
  };
  return {
    post: (audience, n) => {
      const one: Notice = typeof n === "string" ? { op: "note", text: n } : n;
      if (one.op === "note" && !one.text.trim()) return;
      for (const t of new Set(audience)) boxes.set(t, [...(boxes.get(t) ?? []), one].slice(-max));
    },
    drain,
    suffix: (target, via, lead) => {
      const seen = ring.of(target);
      const parts = [...lead, rosterPart(drain(target), o.cwdOf?.(target) ?? "", o.snapshot?.(target)), ...(o.digest ? [o.digest(target, via)] : [])];
      const secs = parts.map((p) => p(seen));
      ring.push(target, secs.flatMap((s) => s.keys));
      return secs.map((s) => s.text).join("");
    },
    forget: (target) => ring.reset(target),
  };
};

// 进程内唯一的信箱。inbound (人说的话) 和 mirror-bridge (同伴/定时注入) 是两条
// 独立的注入路径, 两边都要能挂增量; 为此给各自的安装函数再加一个参数不值当 ——
// 同 bindWizardStore 的取舍。没绑 = 全链路退化成无增量, 行为照旧。
let bound: NoticeBox | undefined;
export const bindNoticeBox = (box: NoticeBox): NoticeBox => (bound = box);
export const noticeBox = (): NoticeBox | undefined => bound;

/** 注入边界上取一次尾巴。`lead` 是排在名册前面的段 (人那条路径上的点名提示)。
 *  slash 命令按行解析, 尾巴上多挂一段会让它不再被识别成命令 —— 这类注入直接跳过
 *  (信箱不清空, 窗口不前进, 等下一条普通消息)。没绑信箱时前置段照样给, 只是不去重。 */
export const noticeSuffixFor = (target: string, text: string, via: Via = {}, lead: readonly Part[] = []): string => {
  if (text.trimStart().startsWith("/")) return "";
  const box = noticeBox();
  return box ? box.suffix(target, via, lead) : lead.map((p) => p(() => false).text).join("");
};

/** 一次生 / 收 / 改职责 / 改名的当事人, 取自注册表。`owners` = 它在册、还开着的工单的发起人。 */
export interface Subject { parent?: string; description?: string; owners?: readonly string[] }

/** 收件人 `t` 该不该听到关于 `who` 的变动 —— 只有会改变它接下来怎么做的才算:
 *  - 长住且有职责的 (没有 parent、写了 description): 同群都该知道, 别人照它的职责派活、按名字找它。
 *  - 分身 / 帮手 (有 parent): 只是生它那位与拉它进工单那位手上的活。不往上走家谱 —— 孙辈是子
 *    wizard 自己的事: 回归测试的一整批临时分身曾这样从跑测试那位一路刷到群管家。
 *  - 没有 parent 也没写职责的 (还没自我介绍的新会话、forget 之后残留的冷记录): 谁也不告诉;
 *    它写下职责那一刻 (job 事件) 才算登场。 */
export const hears = (who: Subject) => (t: string): boolean =>
  !who.parent ? !!who.description?.trim() : t === who.parent || !!who.owners?.includes(t);

/** 同一个聊天里除了当事人之外的所有 wizard —— 一次变动的默认听众。跨聊天的同伴
 *  不在其中: 群成员变动是那个群的事, 别的群只在真的去 send_peer 时才需要知道。 */
export const chatAudience = (
  liveTargets: readonly string[],
  base: string,
  except: readonly string[],
): string[] =>
  liveTargets.filter((t) => baseOfKey(t) === base && !except.includes(t));
