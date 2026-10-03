// 管家分派的确定性那一半: 「这件活该不该转给某个已有 wizard」拆成可以算的事实
// 与必须判断的权衡。
//
// 能算的: 它的职责 / 最近的话和这件活重叠了哪些词, 它的上下文里读过哪些文件、
// 其中哪些被这件活点到, 它在哪个工作区、忙不忙、上下文多大。不能算的: 那些重叠
// 是不是真的同一件事, 以及「接着用它那段上下文」省下的重读值不值得背着整段历史
// 往下走 —— 这是经济账, 留给读表的管家。所以这里只做两件事: 把没有任何交集的
// 候选滤掉, 把剩下的按证据强弱排好、连证据一起摆出来; 不出分数, 不替它拍板。
//
// 唯一替管家先算好的一笔账是**唤醒成本**: 它在 prompt cache TTL 之外 = 缓存已冷,
// 下一轮要把整段 ctx 重新 cache write 一遍, 这是能按 token 算的事实; 再配上
// 「这件活要用到它那段上下文多少」(点到的文件 / 它读过的文件), 证据弱又贵的
// 打上「不划算」—— 默认偏向省钱, 但仍只是标记, 拍板的还是管家。
//
// 全是纯函数: 候选的原料 (文件集 / 最近的话 / ctx) 由调用方从 transcript 读好送进来。
import { addr, agoOf, ctxOf, type WizardBrief } from "./wizard.js";

export interface RouteRow extends WizardBrief {
  busy: boolean;
  alive: boolean;
  lastActivity: number;
  contextTokens: number;
  /** 它的缓存实际按多长 TTL 写的 (transcript 的 cache_creation 分档; 订阅下是 1h); 缺 = 用调用方给的默认。 */
  cacheTtlMs?: number;
  /** 这段上下文里碰过的文件 (contextFiles), 绝对路径。 */
  files: readonly string[];
  /** 最近几句问话 (去掉了保温 ping)。 */
  asks: readonly string[];
  /** 最近一个来回的一行摘要。 */
  summary: string;
}

interface Evidence {
  row: RouteRow;
  desc: string[];
  asks: string[];
  files: string[];
  /** 点到了、但几乎人人读过的公共文件: 不计证据, 只摆出来说明为什么被降权。 */
  common: string[];
  sameCwd: boolean;
}

// 这类词两边都常见, 撞上了也说明不了是同一件事。
const STOP = new Set([
  "the", "and", "for", "with", "this", "that", "from", "into", "src", "lib", "dist", "index",
  "users", "develop", "home", "tmp", "json", "jsonl", "md", "ts", "js", "tsx", "mjs",
  "一个", "这个", "那个", "什么", "怎么", "可以", "需要", "我们", "你们", "他们", "现在", "然后",
  "还是", "就是", "不是", "没有", "是否", "进行", "一下", "看看", "问题", "时候", "如果",
]);

/** 一段话 → 用来比对的词: 英文/标识符按驼峰与分隔符切开 (整串也留着), 中文取相邻两字。 */
export const termsOf = (text: string): Set<string> => {
  const ascii = (text.match(/[A-Za-z0-9_][A-Za-z0-9_.\-/]{2,}/g) ?? []).flatMap((w) => [
    w.toLowerCase(),
    ...w.split(/[/.\-_]|(?<=[a-z])(?=[A-Z])/).map((p) => p.toLowerCase()),
  ]);
  const han = (text.match(/[一-鿿]{2,}/g) ?? []).flatMap((run) =>
    Array.from({ length: run.length - 1 }, (_, i) => run.slice(i, i + 2)));
  return new Set([...ascii, ...han].filter((t) => t.length >= 2 && !STOP.has(t) && !/^\d+$/.test(t)));
};

const shared = (task: Set<string>, text: string): string[] => [...termsOf(text)].filter((t) => task.has(t));

const relTo = (cwd: string, p: string): string => (cwd && p.startsWith(`${cwd}/`) ? p.slice(cwd.length + 1) : p);

/** `daemon/mirror-bridge.ts` → `mirror-bridge`。 */
const stemOf = (p: string): string => (p.split("/").pop() ?? "").replace(/\.[^.]+$/, "");

const near = (a: string, b: string): boolean => !!a && !!b && (a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`));

/** 这件活点到的文件名: 每个英文词取最后一段去扩展名 —— `daemon/wizard.ts` 只贡献
 *  `wizard`, 不贡献目录 `daemon` (否则 daemon.log 也算命中)。 */
const stemsOf = (text: string): Set<string> =>
  new Set((text.match(/[A-Za-z0-9_][A-Za-z0-9_.\-/]{2,}/g) ?? []).map((w) => stemOf(w).toLowerCase()).filter((w) => w.length >= 3 && !STOP.has(w)));

/** 同一个文件名只留最后碰的那一次 (`./wizard.js` 与 `daemon/wizard.ts` 是一回事)。 */
const byStem = (files: readonly string[]): string[] =>
  files.filter((f, i) => !files.slice(i + 1).some((g) => stemOf(g) === stemOf(f)));

/** 公共文件: 池子里不少候选都读过的文件名 (web/chat.js、shared/role-view.ts 这类) —— 谁都读过, 不构成选人理由。
 *  至少 3 个候选读过且占到池子的三成才算; 池子太小 (<3) 没有统计意义, 不判。 */
export const commonStems = (rows: readonly RouteRow[]): Set<string> => {
  const need = Math.max(3, Math.ceil(rows.length * 0.3));
  const tally = rows.flatMap((r) => [...new Set(r.files.map((f) => stemOf(f).toLowerCase()))])
    .reduce((m, s) => m.set(s, (m.get(s) ?? 0) + 1), new Map<string, number>());
  return new Set([...tally].filter(([, n]) => n >= need).map(([s]) => s));
};

const evidenceOf = (task: Set<string>, stems: Set<string>, common: Set<string>, taskCwd: string) => (row: RouteRow): Evidence => {
  // 文件只认整个文件名被点到: 目录名 (daemon/、web/) 几乎每个文件都带, 文件名里的
  // 半截词 (role-render 的 render) 又太常见 —— 撞上它们说明不了读过这一个。
  const hit = byStem(row.files.filter((f) => stems.has(stemOf(f).toLowerCase())));
  const isCommon = (f: string): boolean => common.has(stemOf(f).toLowerCase());
  return {
    row,
    desc: shared(task, row.description),
    asks: [...new Set(row.asks.flatMap((a) => shared(task, a)))],
    files: hit.filter((f) => !isCommon(f)),
    common: hit.filter(isCommon),
    sameCwd: near(row.cwd, taskCwd),
  };
};

// 排序只是让最有证据的先被看到: 文件命中 (它真读过) > 职责 > 最近的话; 同工作区只用来打破平手。
const weight = (e: Evidence): number => e.files.length * 3 + e.desc.length * 2 + e.asks.length;

/** 有交集的候选, 证据最强的在前。 */
export const rankCandidates = (task: string, taskCwd: string, rows: readonly RouteRow[]): Evidence[] => {
  return rows
    .map(evidenceOf(termsOf(task), stemsOf(task), commonStems(rows), taskCwd))
    .filter((e) => weight(e) > 0 || e.common.length > 0)
    .sort((x, y) => weight(y) - weight(x) || Number(y.sameCwd) - Number(x.sameCwd) || y.row.lastActivity - x.row.lastActivity);
};

// 白板 spawn 的起步 ctx: CLI 自带 system prompt + charter (~2.6k) + 工具定义 (~18k)。
// 唤醒一个冷的大 ctx wizard, 和它比才看得出贵了几倍。
export const FRESH_CTX = 25_000;
// 证据弱时「多大算大」: 缓存冷了按要整段重写算, 60k 已是白板的两倍多; 缓存还热,
// 唤醒只是 0.1x 的读, 贵在往后每轮都背着它, 到 150k 才算重。
const BIG_COLD = 60_000;
const BIG_WARM = 150_000;

const k = (n: number): string => `${Math.round(n / 1000)}k`;

/** 唤醒一个 wizard 这一下要付的缓存代价: 冷 = 距上次活动超过 TTL, 整段 ctx 要重新 cache write。 */
export interface WakeCost {
  cold: boolean;
  /** 唤醒那一轮要重写进缓存的 token 数; 缓存还热 = 0。 */
  write: number;
  /** 相当于白板 spawn 起步的几倍 (按 ctx 比)。 */
  times: number;
}

export const wakeCostOf = (ctx: number, lastActivity: number, now: number, ttlMs: number): WakeCost => {
  const cold = !lastActivity || now - lastActivity > ttlMs;
  return { cold, write: cold ? ctx : 0, times: Math.round((ctx / FRESH_CTX) * 10) / 10 };
};

/** tell_peer 回包里的一句: 这次唤醒的是冷且大的 wizard, 付了多少缓存重写 —— 让派活的下次先算这笔账。 */
export const wakeNoteOf = (ctx: number, lastActivity: number, now: number, ttlMs: number): string => {
  const w = wakeCostOf(ctx, lastActivity, now, ttlMs);
  return w.cold && ctx >= BIG_COLD
    ? `这次唤醒的缓存已冷 (超过 TTL ${Math.round(ttlMs / 60_000)} 分钟没动), 要整段重写 ~${k(ctx)} 缓存 ≈ 白板 spawn 的 ${w.times} 倍; 这件活若不依赖它那段上下文, 下次白板 spawn 更省`
    : "";
};

// tell_peer 派新活的门槛: 冷且这么大的, 先退回让派活的算账再说。点名、职责对口只说明
// 相关, 不说明划算 —— 一句「直接转给它」就把整段 ctx 重写了一遍 (.relock 526k 那次)。
export const COLD_GATE = 100_000;

/** 冷且 ctx ≥ COLD_GATE → 退回的那一行; 否则空串 (放行)。 */
export const coldGateOf = (name: string, ctx: number, lastActivity: number, now: number, ttlMs: number): string => {
  const w = wakeCostOf(ctx, lastActivity, now, ttlMs);
  return w.cold && ctx >= COLD_GATE
    ? `${name} 冷 · ctx ${k(ctx)} · 唤醒约等于白板 spawn 的 ${w.times} 倍; 真依赖它的上下文就带 \`force:true\` 重发, 否则白板 spawn`
    : "";
};

/** 一句话就说得清的小活: 改样式 / 文案 / 单点修改 / 简单查询 —— 用不上谁的长上下文。 */
const SMALL_RE = /样式|css|border|颜色|字号|字体|间距|边距|圆角|阴影|对齐|图标|文案|措辞|改名|重命名|typo|错别字|拼写|一行|单点|查一下|看一下|问一下|是多少|在哪/i;
export const isSmallTask = (task: string): boolean => task.length <= 40 || (task.length <= 160 && SMALL_RE.test(task));

/** 证据弱 (没碰过这件活点到的文件; 小活则少于 3 个) 又贵 (冷且 ≥60k, 或热但 ≥150k) → 不划算。 */
const notWorth = (e: Evidence, w: WakeCost, small: boolean, ctx: number): boolean =>
  (e.files.length === 0 || (small && e.files.length < 3)) && ctx >= (w.cold ? BIG_COLD : BIG_WARM);

const quoted = (ts: readonly string[], max = 6): string =>
  ts.slice(0, max).map((t) => `「${t}」`).join("") + (ts.length > max ? ` +${ts.length - max}` : "");

/** 文件集落在哪几个顶层目录 —— 一眼看出它的上下文是专注还是摊得很开。 */
const spread = (cwd: string, files: readonly string[]): string => {
  const tally = files
    .map((f) => relTo(cwd, f))
    .map((r) => (r.startsWith("/") ? "(工作区外)" : r.includes("/") ? `${r.split("/")[0]}/` : "(根)"))
    .reduce((m, d) => m.set(d, (m.get(d) ?? 0) + 1), new Map<string, number>());
  return [...tally].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([d, n]) => `${d} ${n}`).join(", ");
};

interface Ctx { now: number; home: string; ttlMs: number; small: boolean }

const costLines = (e: Evidence, c: Ctx): string[] => {
  const ctx = e.row.contextTokens;
  if (!ctx) return [];
  const ttlMs = e.row.cacheTtlMs ?? c.ttlMs;
  const w = wakeCostOf(ctx, e.row.lastActivity, c.now, ttlMs);
  const ttl = `${Math.round(ttlMs / 60_000)} 分钟`;
  const wake = w.cold
    ? `缓存冷 (超过 TTL ${ttl}) · 唤醒要重写 ~${k(w.write)} 缓存 ≈ 白板 spawn 的 ${w.times} 倍${ctx >= BIG_COLD ? " · 大 ctx 已冷, 默认不转" : ""}`
    : `缓存热 (TTL ${ttl}内) · 唤醒只读缓存`;
  const need = e.files.length
    ? `这件活点到它读过的 ${e.files.length}/${e.row.files.length} 个文件`
    : `这件活没点到它读过的任何文件 (只有词面重叠)`;
  return [
    `  代价: ${wake}; 往后每轮都背着 ${k(ctx)} · 相关: ${need}`,
    ...(notWorth(e, w, c.small, ctx) ? [`  ⚠ 不划算, 建议白板 spawn —— ${c.small ? "小活" : "证据弱"}却要${w.cold ? "整段重写" : "一直背着"} ${k(ctx)}`] : []),
  ];
};

const renderOne = (e: Evidence, c: Ctx): string[] => {
  const { now, home } = c;
  const r = e.row;
  const where = e.sameCwd ? "同工作区" : home && r.cwd.startsWith(home) ? `~${r.cwd.slice(home.length)}` : r.cwd;
  const hits = [
    e.files.length ? `读过的文件 ${e.files.slice(-4).map((f) => relTo(r.cwd, f)).join(" ")}${e.files.length > 4 ? ` +${e.files.length - 4}` : ""}` : "",
    e.desc.length ? `职责${quoted(e.desc)}` : "",
    e.asks.length ? `最近的话${quoted(e.asks)}` : "",
    e.common.length ? `降权的公共文件 ${e.common.slice(-4).map((f) => relTo(r.cwd, f)).join(" ")}${e.common.length > 4 ? ` +${e.common.length - 4}` : ""} (不少人都读过, 不计证据)` : "",
  ].filter(Boolean);
  return [
    [`\`${addr(r)}\` ${r.busy ? "忙" : r.alive ? "闲" : "冷"}`, where, ctxOf(r.contextTokens) || "ctx ?", agoOf(r.lastActivity, now)]
      .filter(Boolean).join(" · "),
    ...(r.description ? [`  职责: ${r.description}`] : []),
    `  命中: ${hits.join(" · ")}`,
    ...(r.files.length ? [`  上下文: 读过 ${r.files.length} 个文件 (${spread(r.cwd, r.files)})`] : []),
    ...costLines(e, c),
    ...(r.summary ? [`  最近: ${r.summary}`] : []),
  ];
};

/** 给管家读的候选表。末尾永远留着「新 spawn」这一项 —— 它是没有好候选时的默认。 */
export const renderCandidates = (task: string, cands: readonly Evidence[], now: number, ttlMs: number, home = ""): string => {
  const c: Ctx = { now, home, ttlMs, small: isSmallTask(task) };
  return [
    cands.length
      ? `和这件活有交集的已有 wizard ${cands.length} 个, 证据强的在前 (文件命中 = 它真读过; 词面重叠只是线索):`
      : "没有哪个已有 wizard 的职责、最近的话或读过的文件和这件活有交集。",
    ...(c.small ? ["体量: 看着是小活 (一句话 / 样式 / 单点修改 / 简单查询) —— 默认白板 spawn 或交给 ctx 小的, 除非它真依赖某段上下文。"] : []),
    ...cands.flatMap((e) => renderOne(e, c)),
    "",
    `· 新 spawn —— 白板起步, 不背任何历史 (起步 ctx 约 ${k(FRESH_CTX)})。`,
    "由你判断: 交集是不是同一件事; 接着用它那段上下文省下的重读, 值不值得唤醒时的缓存重写和往后每一轮背着的 ctx。标了 ⚠ 的默认不转, 除非你看得出这件活确实离不开它那段上下文。",
  ].join("\n");
};

// ── dispatch: 管家派活的默认决定 ──────────────────────────────────────
// 上面的表是给模型读的; 这里把同一套事实收成一个默认决定 —— 管家愚笨也不会派错的那一半:
// 证据够强、不忙、划算、过得了冷门控的头一个候选 → 转给它; 都不是 → 按档白板 spawn。
// 模型不同意就显式推翻 (`to` 点名 / `force` 越过冷门控), 不推翻就照这个办。

export type Decision =
  | { kind: "existing"; row: RouteRow; why: string }
  | { kind: "spawn"; why: string };

/** 「真的是同一件事」的最低证据: 它读过这件活点到的文件, 或职责撞上两个以上的词。 */
const strong = (e: Evidence): boolean => e.files.length > 0 || e.desc.length >= 2;

/** 一个候选为什么不转给它; "" = 可以转。 */
const vetoOf = (e: Evidence, now: number, ttlMs: number, small: boolean, force: boolean): string => {
  const r = e.row;
  const ctx = r.contextTokens;
  const w = wakeCostOf(ctx, r.lastActivity, now, r.cacheTtlMs ?? ttlMs);
  return !strong(e) ? "证据弱 (只有词面重叠)"
    : r.busy ? "正忙"
      : notWorth(e, w, small, ctx) ? `不划算 (${small ? "小活" : "证据弱"}却要${w.cold ? "整段重写" : "一直背着"} ${k(ctx)})`
        : w.cold && ctx >= BIG_COLD && !force ? `缓存冷且 ctx ${k(ctx)} (大 ctx 已冷默认不转; 活真依赖它的上下文就 to+force)`
          : "";
};

const evidenceLine = (e: Evidence): string =>
  [
    e.files.length ? `读过点到的 ${e.files.length} 个文件` : "",
    e.desc.length ? `职责${quoted(e.desc, 3)}` : "",
    e.row.contextTokens ? ctxOf(e.row.contextTokens) : "",
  ].filter(Boolean).join(" · ");

/** 默认决定: 候选按证据排好 (rankCandidates), 取头一个没被否决的; 一个都没有 → spawn, 理由写前几个为什么不行。 */
export const decide = (task: string, cands: readonly Evidence[], now: number, ttlMs: number, force = false): Decision => {
  const small = isSmallTask(task);
  const vetoes = cands.map((e) => ({ e, veto: vetoOf(e, now, ttlMs, small, force) }));
  const hit = vetoes.find((v) => !v.veto);
  if (hit) return { kind: "existing", row: hit.e.row, why: `转给 ${addr(hit.e.row)}: ${evidenceLine(hit.e)}` };
  return {
    kind: "spawn",
    why: vetoes.length
      ? `白板 spawn —— ${vetoes.slice(0, 3).map((v) => `${addr(v.e.row)} ${v.veto}`).join("; ")}`
      : "白板 spawn —— 没有哪个已有 wizard 和这件活有交集",
  };
};

/** spawn 时的默认档: lead 要判断 → hard; 一句话的小活 → light; 其余 standard。 */
export const tierFor = (task: string, lead: boolean): "hard" | "light" | "standard" =>
  lead ? "hard" : isSmallTask(task) ? "light" : "standard";
