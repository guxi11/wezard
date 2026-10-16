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
import { resolve, basename, dirname, isAbsolute } from "node:path";
import type { JobRecord } from "./jobs.js";
import type { InFlight } from "./dispatch.js";
import { addr, agoOf, ctxOf, type WizardBrief } from "./wizard.js";
import type { ContextMaterial } from "./peers.js";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import type { TierName } from "../shared/config.js";

export interface RouteRow extends WizardBrief {
  busy: boolean;
  /** 身份上的 lead 与所有开放工单占用, 不随 spinner 消失。 */
  lead?: boolean;
  duties?: readonly string[];
  alive: boolean;
  lastActivity: number;
  contextTokens: number;
  /** 它的缓存实际按多长 TTL 写的 (transcript 的 cache_creation 分档; 订阅下是 1h); 缺 = 用调用方给的默认。 */
  cacheTtlMs?: number;
  /** 缓存最近一次被碰的时刻 = 最近一次真实请求的开始 (cacheTouchMs); 缺 = 退回 lastActivity (mtime)。 */
  cacheAt?: number;
  /** 这段上下文里碰过的文件 (contextFiles), 相对路径以候选 cwd 为基准。 */
  files: readonly string[];
  materials?: readonly ContextMaterial[];
  sessionId?: string;
  birthToken?: string;
  target?: string;
  model?: string;
  /** 最近几句问话。 */
  asks: readonly string[];
  /** 最近一个来回的一行摘要。 */
  summary: string;
}

interface Evidence {
  row: RouteRow;
  desc: string[];
  /** 专长 (WizardRecord.expertise) 与这件活重叠的词。 */
  exp: string[];
  asks: string[];
  files: string[];
  /** 点到了、但几乎人人读过的公共文件: 不计证据, 只摆出来说明为什么被降权。 */
  common: string[];
  sameCwd: boolean;
  continuity: boolean;
  matched: ContextMaterial[];
  objects: string[];
  materialIssues: string[];
  targetRoles: { direct: string[]; operationSources: string[]; referenceObjects: string[]; snapshots: string[]; archiveBackground: string[] };
  clues: string[];
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

// 项目指引不因候选池小、职责或最近问话里又提到而升级成强证据。
const GUIDANCE = new Set(["agents", "claude", "readme", "contributing", "code_of_conduct", "changelog", "license", "copilot-instructions", "gemini"]);
const withoutGuidance = (text: string): string => text.replace(/[A-Za-z0-9_][A-Za-z0-9_.\-/]{2,}/g,
  (w) => GUIDANCE.has(stemOf(w).toLowerCase()) ? " " : w);
const fileRefs = (text: string): string[] => text.match(/(?:\/|\.\/|\.\.\/)?[A-Za-z0-9_][A-Za-z0-9_.\/-]*\.[A-Za-z][A-Za-z0-9]*(?![A-Za-z0-9_.\/-])/g) ?? [];
const UNSETTLED = new Set<InFlight["state"]>(["working", "blocked", "needs-input", "deferred", "errored", "queued"]);
type RouteInFlight = Pick<InFlight, "from" | "to" | "turn" | "state">;

/** 没开工单的任务也占用: 接入的欠着, 派出的在等; spinner 闲不代表已交差。 */
export const routeReceiptDutiesOf = (inflight: readonly RouteInFlight[], target: string): string[] => inflight
  .filter((x) => UNSETTLED.has(x.state))
  .flatMap((x) => [
    ...(x.to === target ? [`${x.turn} 欠着 ${x.from}: ${x.state}`] : []),
    ...(x.from === target ? [`${x.turn} 在等 ${x.to}: ${x.state}`] : []),
  ]);

/** 只读全表占用: 自己开的、跨群的单同样占用; 落定成员可释放, owner 要等关单。 */
export const routeDutiesOf = (jobs: readonly JobRecord[], target: string, inflight: readonly RouteInFlight[] = []): string[] => [
  ...jobs.filter((j) => j.status === "open").flatMap((j) => [
    ...(j.owner === target ? [`${j.id} 开单者: ${j.title}`] : []),
    ...j.members.filter((m) => m.target === target && !m.outcome)
      .map((m) => `${j.id} ${m.role ?? "exec"}: ${m.task || j.title}`),
  ]),
  ...routeReceiptDutiesOf(inflight, target),
];

const shared = (task: Set<string>, text: string): string[] => [...termsOf(withoutGuidance(text))].filter((t) => task.has(t));

const relTo = (cwd: string, p: string): string => (cwd && p.startsWith(`${cwd}/`) ? p.slice(cwd.length + 1) : p);

/** `daemon/mirror-bridge.ts` → `mirror-bridge`。 */
const stemOf = (p: string): string => (p.split("/").pop() ?? "").replace(/\.[^.]+$/, "");

const near = (a: string, b: string): boolean => !!a && !!b && (a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`));

/** 这件活点到的文件名: 每个英文词取最后一段去扩展名 —— `daemon/wizard.ts` 只贡献
 *  `wizard`, 不贡献目录 `daemon` (否则 daemon.log 也算命中)。 */
const stemsOf = (text: string): Set<string> =>
  new Set((text.match(/[A-Za-z0-9_][A-Za-z0-9_.\-/]{2,}/g) ?? []).map((w) => stemOf(w).toLowerCase()).filter((w) => w.length >= 3 && !STOP.has(w)));

/** 同名文件可能是不同任务的材料, 只去除重复路径。 */
const uniqueFiles = (files: readonly string[]): string[] => [...new Set(files)];

/** 公共文件: 按规范化完整路径、每候选一次统计 (web/chat.js、shared/role-view.ts 这类) —— 谁都读过, 不构成选人理由。
 *  统计类至少 3 个候选读过且占到池子的三成; 项目指引在任何池子里固定降权。 */
const fullPath = (cwd: string, path: string): string => {
  try {
    const p = path.startsWith("file://") ? fileURLToPath(path) : path.startsWith("~/") ? resolve(homedir(), path.slice(2)) : path;
    return cwd || isAbsolute(p) ? resolve(cwd, p) : "";
  }
  catch { return ""; }
};

export const commonStems = (rows: readonly RouteRow[]): Set<string> => {
  const need = Math.max(3, Math.ceil(rows.length * 0.3));
  const tally = rows.flatMap((r) => [...new Set((r.materials ?? []).filter((m) => m.confirmed).map((m) => fullPath(r.cwd, m.path)))])
    .reduce((m, p) => m.set(p, (m.get(p) ?? 0) + 1), new Map<string, number>());
  return new Set([...tally].filter(([, n]) => n >= need).map(([p]) => p));
};

// Strong targets use a small affirmative instruction grammar, not arbitrary prose.
// Negated/conditional/reference clauses and unsupported sentence shapes stay unknown.
const TARGET_ACTION = /^(?:(?:请|只读|独立|本次|这次|现在|直接|继续|先|再|负责|帮我|协助|需要|实际|只|已|已经)\s*)*(?:检查|核查|核实|查看|查明|查找|读取|读|扫描|审查|审阅|评审|修复|实现|完善|优化|修改|调整|维护|验证|确认|迁移|移动|移除|卸载|删除|定位|排查|搜索|查验|找出|找到|更新|完成|交付|check\b|verify\b|inspect\b|read\b|scan\b|audit\b|review\b|fix\b|implement\b|update\b|move\b|remove\b|uninstall\b|delete\b|locate\b|find\b|search\b)/i;
const targetText = (text: string): string => text.split(/[。；;\n，,]/).map((clause) => clause.trim()
  .replace(/^(?:(?:用户(?:原话|要求|问)|任务|目标|需求|RESULT)\s*[:：]\s*)+/i, "")
  .replace(/^[『「“"'`]+/, "")).filter((clause) =>
  !/[不别勿未无非()（）\[\]【】{}]|依据|基于|根据|参照|借助|对照|用作|作为|例如|比如|否定|否认|禁止|停止|取消|省略|免于|避免|排除|忽略|之外|以外|背景|历史|刚才|此前|上次|上一轮|已知|已确证|已有核查|归档副本|当前上下文|来源路径|另有|参考|示例|假设|假如|如果|\b(?:no|not|never|without|except|exclude|skip|avoid|ignore|omit|stop|cancel|background|previous|unless|if)\b/i.test(clause)
  && !/(?:使用|用 |应用|遵循|请读取|先.*读|use |using |apply ).*(?:skill|技能|SKILL\.md)/i.test(clause)
  && TARGET_ACTION.test(clause)).filter((clause) => {
    const paths = refsOf(clause, "/");
    if (paths.size !== 1) return paths.size === 0;
    const object = clause.replace(TARGET_ACTION, "").trim().replace(/^(?:文件|目录|技能|模块|代码文件|路径|对)\s*/, "");
    const first = /^(?:[`"']([^`"']+)[`"']|(\S+))/.exec(object);
    // A path must be the instruction's direct object, not an incidental reference later
    // in an otherwise positive sentence. Multiple/unknown path roles remain ambiguous.
    return !!first && paths.has(fullPath("/", first[1] ?? first[2]!));
  }).join("\n");
// Match a whole token once, including ~/ and its trailing slash. Searching separately
// for absolute/relative fragments invented extra paths inside the same operand.
const pathTokensOf = (text: string, cwd: string): { path: string; start: number; end: number }[] => {
  const local = text.replace(/\b(?!file:)[a-z][a-z0-9+.-]*:\/\/[^\s`"'，。；;<>]+/gi, (url) => " ".repeat(url.length));
  return [...local.matchAll(/[`"']([^`"'\n]+)[`"']|(?<![A-Za-z0-9_./~%+:一-鿿-])((?:file:\/\/)?[A-Za-z0-9_./~%+-]+)/g)].flatMap((m) => {
    const raw = m[1] ?? m[2]!;
    if (!raw.includes("/") && !/\.[a-z][a-z0-9]*$/i.test(raw)) return [];
    if (!m[1] && raw.endsWith("/") && /[^\s，。；;、:：)）\]]/.test(local[m.index! + m[0].length] ?? "")) return [];
    const path = fullPath(cwd, raw);
    return path ? [{ path, start: m.index!, end: m.index! + m[0].length }] : [];
  });
};
const refsOf = (text: string, cwd: string): Set<string> => new Set(pathTokensOf(text, cwd).map((p) => p.path));
const roleClauses = (text: string): string[] => text.split(/[。；;\n，,]/).map((s) => s.trim().replace(/^RESULT\s*[:：]\s*/i, "")).filter(Boolean);
const NEGATIVE_ROLE = /[不别勿未无非]|否认|否定|禁止|停止|取消|省略|免于|避免|排除|忽略|之外|以外|假设|假如|如果|\b(?:no|not|never|without|except|exclude|skip|avoid|ignore|omit|stop|cancel|unless|if)\b/i;

/** Only a label followed by exactly one path can assert a snapshot/authority location. */
const labeledLocations = (text: string, cwd: string, label: RegExp): Set<string> => new Set(roleClauses(text).flatMap((clause) => {
  if (NEGATIVE_ROLE.test(clause) || TARGET_ACTION.test(clause)) return [];
  const value = label.exec(clause)?.[1]?.trim();
  if (!value) return [];
  const paths = pathTokensOf(value, cwd);
  return paths.length === 1 && paths[0]!.start === 0 && !value.slice(paths[0]!.end).trim() ? [paths[0]!.path] : [];
}));

/** A delivered location list states where the objects are, without claiming any file read. */
const deliveredLocations = (text: string, cwd: string): Set<string> => new Set(roleClauses(text).flatMap((clause) => {
  if (NEGATIVE_ROLE.test(clause) || /背景|示例|参考|假设/.test(clause)) return [];
  const value = /^(?:[一-鿿A-Za-z -]{0,24})(?:目录|路径|位置)(?:是|为|[:：])\s*(.+)$/.exec(clause)?.[1];
  if (!value) return [];
  const paths = pathTokensOf(value, cwd);
  const remainder = paths.reduceRight((v, p) => v.slice(0, p.start) + v.slice(p.end), value);
  return paths.length && /^(?:\s|和|及|以及|and|、)*$/i.test(remainder) ? paths.map((p) => p.path) : [];
}));

/** Unknown operation suffixes cannot confirm a source, even without repeating its path. */
const affirmativeOperationTail = (tail: string): boolean => {
  const bare = "[~./A-Za-z0-9_<>-][A-Za-z0-9_<>./~-]*/[A-Za-z0-9_<>./~-]*";
  const path = `(?:${[bare, ...["`", '"', "'"].map((q) => `${q}${bare}${q}`)].join("|")})`;
  const location = new RegExp(`^(?:${path}|(?:扫描|原)路径之外的(?:带时间戳)?备份目录)$`);
  const suggestions = new RegExp(`^建议\\s*${path}(?:\\s*(?:和|及|以及|、|and)\\s*${path})*$`);
  const [destination, ...constraints] = tail.split(/[，,]/).map((c) => c.trim());
  const target = /^(?:到|至|进|出|回)\s*(.+)$/.exec(destination ?? "")?.[1];
  return (!destination || !!target && location.test(target)) && constraints.every((c) =>
    suggestions.test(c) || /^保留(?:各自|原有)?来源层级$/.test(c) || /^不覆盖(?:已有|现有)?备份$/.test(c));
};

/** Operation roles are closed: unclassified qualifications retract prior sources. */
const allowsOperationSource = (clause: string, sources: readonly string[], cwd: string): boolean => {
  const paths = pathTokensOf(clause, cwd);
  // Only a complete direct instruction can prove that a path names another object.
  if (paths.length === 1 && sources.every((p) => !near(p, paths[0]!.path))
    && /^(?:不|不要|别|勿|无需|不需要)?(?:检查|核查|扫描|读取|移动|迁移|删除|复制|备份|操作)\s*$/.test(clause.slice(0, paths[0]!.start))
    && !clause.slice(paths[0]!.end).trim()) return true;
  if (paths.length === 1 && /^(?:检查|核查|扫描|读取|验证|确认)\s*$/.test(clause.slice(0, paths[0]!.start))
    && !clause.slice(paths[0]!.end).trim()) return true;
  if (/^(?:保留(?:各自|原有)?来源层级|不覆盖(?:已有|现有)?备份|(?:移动|迁移)链接本身|(?:勿|不要|不)操作链接目标)$/.test(clause)) return true;
  if (/^(?:验证|检查|核查|确认)(?:移动|迁移|复制|备份)(?:结果|完整性|数量|项完整|是否完成|成功)$/.test(clause)
    || /^验证备份项完整(?:、原扫描路径(?:用户)?(?:技能|文件|目录|资源|对象)已移出)?$/.test(clause)
    || /^(?:交付|报告)(?:确切)?备份(?:绝对)?路径(?:、(?:移动|迁移|复制|备份)数量(?:与原目录状态)?)?$/.test(clause)
    || /^(?:移动|迁移|复制|备份)数量(?:与原目录状态)?$/.test(clause)
    || /^先核查当前实物后(?:移动|迁移|移除|复制|备份)所有(?:该范围)?(?:用户)?(?:技能|文件|目录|资源|对象)$/.test(clause)
    || /^(?:此为|这是)?用户(?:明确)?授权的可逆(?:移动|迁移|复制|备份)$/.test(clause)) return true;
  // Resource inventories are data-only lists, not free-form background prose.
  if (/^(?:已知\s+)?[A-Za-z0-9_-]+\s+有\s+[A-Za-z0-9_.-]+(?:、[A-Za-z0-9_.-]+)*$/.test(clause)) return true;
  if (paths.length === 1 && /^明确排除\s*$/.test(clause.slice(0, paths[0]!.start))
    && /^(?:系统技能|系统文件|系统目录)(?:、插件缓存和 [A-Za-z0-9_-]+ 内容存储)?$/.test(clause.slice(paths[0]!.end).trim())) return true;
  if (/^(?:包括(?:目录|文件)(?:或符号链接)?|无需再次确认|不要自动重启会话)$/.test(clause)
    || /^不(?:改|修改)(?:任何)?(?:配置真源|配置|锁文件|项目文档)(?:、(?:配置真源|配置|锁文件|项目文档))*(?:或(?:配置真源|配置|锁文件|项目文档))?$/.test(clause)
    || /^说明(?:当前)?会话启动快照(?:仍)?可能显示旧清单(?:即可)?$/.test(clause)) return true;
  // Every later clause needs a complete known role. Unrecognized wording is not
  // evidence that the operation still stands, regardless of nouns or pronouns.
  return false;
};

/** A supported 将/把 source list and its complete operation must be affirmative. */
const operationSources = (text: string, cwd: string): Set<string> => {
  const denied = new Set(roleClauses(text).filter((c) => NEGATIVE_ROLE.test(c)).flatMap((c) => [...refsOf(c, cwd)]));
  const sentences = text.split(/[。；;\n]/);
  return new Set(sentences.flatMap((sentence, index) => {
    const operation = /^(?:请\s*)?(?:将|把)\s+(.+?)\s*(?:实际|统一|全部)?(?:移动|迁移|移除|删除|复制|搬移|备份)(?=到|至|进|出|回|[，,]|$)/.exec(sentence.trim());
    const source = operation?.[1];
    if (!source || NEGATIVE_ROLE.test(source) || !affirmativeOperationTail(sentence.trim().slice(operation[0].length))) return [];
    const entries = source.replace(/[，,]\s*$/, "").split(/[，,]\s*(?:以及|和|及|and)?\s*|\s+and\s+/i);
    const paths = entries.map((entry) => {
      const value = entry.trim(), tokens = pathTokensOf(value, cwd);
      if (tokens.length !== 1 || tokens[0]!.start !== 0) return "";
      const selector = value.slice(tokens[0]!.end).trim();
      return !selector || /^下(?:的)?[一-鿿A-Za-z0-9_ -]{0,32}(?:技能|文件|目录|资源|对象)$/.test(selector) ? tokens[0]!.path : "";
    });
    const later = roleClauses(sentences.slice(index + 1).join("。").replace(/[()（）]/g, "，"));
    const objects = [...paths, ...refsOf(sentence, cwd)];
    return paths.length && paths.every(Boolean) && later.every((c) => allowsOperationSource(c, objects, cwd))
      ? paths.filter((p) => !denied.has(p)) : [];
  }));
};

const mentions = (text: string, object: string): boolean => object.length >= 4 && !["skills", "plugins", "cache", "tree", ".system"].includes(object)
  && new RegExp(`(?<![A-Za-z0-9_-])${object.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z0-9_-])`, "i").test(text);

const evidenceOf = (text: string, task: Set<string>, stems: Set<string>, common: Set<string>, taskCwd: string, now: number) => (row: RouteRow): Evidence => {
  const active = targetText(text);
  const positions = refsOf(text, taskCwd);
  const sources = operationSources(text, taskCwd);
  const targets = new Set([...refsOf(active, taskCwd), ...sources]);
  const clauses = roleClauses(text);
  const denied = new Set(clauses.filter((c) => NEGATIVE_ROLE.test(c)).flatMap((c) => [...refsOf(c, taskCwd)]));
  const referenceObjects = clauses.flatMap((c) => {
    if (NEGATIVE_ROLE.test(c)) return [];
    const ref = /^指(?:刚刚|刚)?(?:找到|查到|发现|确认)的\s*[`"']?([A-Za-z0-9_][A-Za-z0-9_.-]*)[`"']?(?:\s*[（(][^（）()]*[）)])?$/.exec(c);
    return ref ? [ref[1]!] : [];
  });
  const identityQuery = active.split("\n").some((c) => /^(?:其|该技能的?|该对象的?|它的|这个技能的?)(?:上游)?(?:来源|身份|出处|作者|仓库|元数据)/.test(c.replace(TARGET_ACTION, "").trim()));
  const snapshots = labeledLocations(text, taskCwd, /^(?:已知)?本地快照\s*[:：]?\s*(.+)$/);
  const archives = labeledLocations(text, taskCwd, /^(?:[A-Za-z0-9_.-]+\s+)?归档副本\s*[:：]?\s*(.+)$/);
  const materials = row.materials ?? [];
  const hit = uniqueFiles(row.files.map((f) => fullPath(row.cwd, f)).filter((f) => stems.has(stemOf(f).toLowerCase())));
  const isCommon = (f: string): boolean => GUIDANCE.has(stemOf(f).toLowerCase()) || common.has(f);
  const current = materials.filter((m) => m.confirmed && m.task && m.taskAt > 0 && m.at >= m.taskAt
    && now >= m.at && now - m.taskAt <= 3_600_000 && now - m.at <= 3_600_000
    && (!row.sessionId || m.session === row.sessionId));
  const related = current.filter((m) => {
    const path = fullPath(row.cwd, m.path);
    if (isCommon(path)) return false;
    const object = basename(dirname(path));
    const skill = basename(path).toLowerCase() === "skill.md";
    // A helper's skill read is not expertise. The skill itself must be the delivered object.
    if (skill) {
      if (m.kind !== "read") return false;
      const instance = dirname(path);
      // Explicit child files constrain the instance too. Unknown/negative positions cannot
      // be recovered through a same-name fallback, even when that costs a valid reuse.
      const discovered = refsOf(m.reply ?? "", m.cwd).has(path) && (m.reply ?? "").split(/[。；;\n]/).some((clause) =>
        !NEGATIVE_ROLE.test(clause) && mentions(clause, object) && /最匹配|找到|找出|发现|\bfound\b|\bidentified\b|\bmatch\b/i.test(clause));
      const authority = labeledLocations(m.reply ?? "", m.cwd, /^(?:权威源文件|源文件|技能文件|技能路径)\s*[:：]\s*(.+)$/);
      const excluded = [...denied].some((p) => p === instance || p.startsWith(`${instance}/`));
      const archiveQuery = clauses.some((c) => /归档副本/.test(c)
        && !labeledLocations(c, taskCwd, /^(?:[A-Za-z0-9_.-]+\s+)?归档副本\s*[:：]?\s*(.+)$/).size);
      const deliveredObjects = roleClauses(m.reply ?? "").flatMap((c) => {
        if (NEGATIVE_ROLE.test(c)) return [];
        const name = /^(?:最匹配的是|找到的(?:技能|对象)是|发现的(?:技能|对象)是|已找到|已确认)\s*([A-Za-z0-9_][A-Za-z0-9_.-]*)$/.exec(c.replace(/[*`"']/g, ""))?.[1];
        return name ? [name] : [];
      });
      const sameObject = (name: string) => name.toLowerCase() === object.toLowerCase();
      const referenced = !excluded && identityQuery && referenceObjects.some(sameObject) && referenceObjects.every(sameObject)
        && deliveredObjects.some(sameObject) && deliveredObjects.every(sameObject)
        && snapshots.size === 1 && snapshots.has(path) && authority.size === 1 && authority.has(path) && discovered;
      const compatible = [...positions].every((p) => referenced && (snapshots.has(p) || archives.has(p) && !targets.has(p) && !archiveQuery)
        || targets.has(p) && (p === instance || p.startsWith(`${instance}/`)));
      if (!compatible) return false;
      const helper = m.task.split(/[。；;\n，,]/).some((clause) => mentions(clause, object)
        && /(?:使用|应用|遵循|用(?!户|途)|\buse\b|\busing\b|\bapply\b)/i.test(clause));
      if (helper || !mentions(m.reply ?? "", object)) return false;
      const originalTarget = refsOf(targetText(m.task), m.cwd).has(path);
      return (originalTarget || discovered) && (referenced || targets.has(path)
        || active.split("\n").some((clause) => /skill|技能/i.test(clause) && mentions(clause, object)));
    }
    if (m.kind === "scan" && [fullPath(row.cwd, "."), "/", homedir()].includes(path)) return false;
    // Scans match that exact directory only; they never claim files under it were read.
    return targets.has(path) && (refsOf(targetText(m.task), m.cwd).has(path) || refsOf(targetText(m.reply ?? ""), m.cwd).has(path) || deliveredLocations(m.reply ?? "", m.cwd).has(path));
  });
  const files = uniqueFiles(related.filter((m) => m.kind === "read").map((m) => fullPath(row.cwd, m.path)));
  return {
    row, continuity: related.length > 0, matched: related,
    targetRoles: { direct: [...refsOf(active, taskCwd)], operationSources: [...sources], referenceObjects,
      snapshots: [...snapshots], archiveBackground: [...archives] },
    objects: [...new Set(related.map((m) => basename(m.path).toLowerCase() === "skill.md" ? basename(dirname(m.path)) : m.path))],
    materialIssues: [
      ...(materials.some((m) => !m.confirmed) ? ["未确认的工具形状仅作线索, 不计材料"] : []),
      ...(!materials.length ? ["无确认材料 (缺失、尾部截断或最新轮无可识别读取)"] : []),
      ...(materials.some((m) => m.truncated) ? ["仅取 compact 后 1MB 尾部, 更早证据未知"] : []),
      ...(materials.length && !current.length ? ["材料不属已知当前任务/session 或已超过 1 小时"] : []),
    ],
    clues: hit.filter((f) => !isCommon(f) && !files.includes(f)),
    desc: shared(task, row.description), exp: shared(task, row.expertise ?? ""),
    asks: [...new Set(row.asks.flatMap((a) => shared(task, a)))], files,
    common: uniqueFiles([...hit, ...materials.map((m) => fullPath(row.cwd, m.path))].filter(isCommon)),
    sameCwd: near(row.cwd, taskCwd),
  };
};

// 排序只是让最有证据的先被看到: 文件命中 (它真读过) > 职责 > 最近的话; 同工作区只用来打破平手。
// 专长是它自己声明的「熟哪块」, 与职责同权。
const weight = (e: Evidence): number => e.matched.length * 3 + e.clues.length + (e.desc.length + e.exp.length) * 2 + e.asks.length;

/** 有交集的候选, 证据最强的在前。 */
export const rankCandidates = (task: string, taskCwd: string, rows: readonly RouteRow[], hot?: { now: number; ttlMs: number }): Evidence[] => {
  // 平手时缓存热的优先 (同一把尺 wakeCostOf: 没冷 = 唤醒只读缓存); 不给 hot 就不分。
  const warm = (r: RouteRow): number => (hot && !wakeCostOf(r.contextTokens, touchOf(r), hot.now, r.cacheTtlMs ?? hot.ttlMs).cold ? 1 : 0);
  return rows
    .map(evidenceOf(task, termsOf(withoutGuidance(task)), stemsOf(task), commonStems(rows), taskCwd, hot?.now ?? Date.now()))
    .sort((x, y) => weight(y) - weight(x) || Number(y.sameCwd) - Number(x.sameCwd) || warm(y.row) - warm(x.row) || y.row.lastActivity - x.row.lastActivity);
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

/** 缓存计时的起点: 有真实请求时刻就用它, 否则退回 mtime。 */
const touchOf = (r: RouteRow): number => r.cacheAt || r.lastActivity;

/** `touchedAt` = 缓存最近一次被碰 (请求开始) 的时刻: TTL 从那里起算, 不是从 transcript 写完起算。 */
export const wakeCostOf = (ctx: number, touchedAt: number, now: number, ttlMs: number): WakeCost => {
  const cold = !touchedAt || now - touchedAt > ttlMs;
  return { cold, write: cold ? ctx : 0, times: Math.round((ctx / FRESH_CTX) * 10) / 10 };
};

/** tell_peer 回包里的一句: 这次唤醒的是冷且大的 wizard, 付了多少缓存重写 —— 让派活的下次先算这笔账。 */
export const wakeNoteOf = (ctx: number, touchedAt: number, now: number, ttlMs: number): string => {
  const w = wakeCostOf(ctx, touchedAt, now, ttlMs);
  return w.cold && ctx >= BIG_COLD
    ? `这次唤醒的缓存已冷 (超过 TTL ${Math.round(ttlMs / 60_000)} 分钟没动), 要整段重写 ~${k(ctx)} 缓存 ≈ 白板 spawn 的 ${w.times} 倍; 这件活若不依赖它那段上下文, 下次白板 spawn 更省`
    : "";
};

// tell_peer 派新活的门槛: 冷且这么大的, 先退回让派活的算账再说。点名、职责对口只说明
// 相关, 不说明划算 —— 一句「直接转给它」就把整段 ctx 重写了一遍 (.relock 526k 那次)。
export const COLD_GATE = 100_000;

/** 冷且 ctx ≥ COLD_GATE → 退回的那一行; 否则空串 (放行)。 */
export const coldGateOf = (name: string, ctx: number, touchedAt: number, now: number, ttlMs: number): string => {
  const w = wakeCostOf(ctx, touchedAt, now, ttlMs);
  return w.cold && ctx >= COLD_GATE
    ? `${name} 冷 · ctx ${k(ctx)} · 唤醒约等于白板 spawn 的 ${w.times} 倍; 真依赖它的上下文就带 \`force:true\` 重发, 否则白板 spawn`
    : "";
};

/** 短句不等于简单: 先排除需要判断的任务, 再认明确的跑腿/单点动作。 */
const COMPLEX_RE = /架构|疑难|排障|诊断|根因|设计|审查|评审|重构|竞态|死锁|性能|安全|architecture|design|review|debug|diagnos|root cause|refactor|race condition|deadlock/i;
const SMALL_RE = /改(?:名|文案|颜色|字号|字体|间距|边距|圆角)|重命名|typo|错别字|拼写|(?:修改|调整).*(?:css|border|颜色|字号|字体|间距|边距|圆角)|(?:核实|确认|检查|查一下|查看|check|verify).*(?:文件.*(?:存在|加载|路径)|加载路径|file.*(?:exist|load|path))|(?:文件.*(?:存在|加载路径)).*(?:核实|确认|检查)|rename|fix (?:a )?typo/i;
const FILE_CHECK_RE = /(?:核实|确认|检查|查一下|查看|check|verify).*(?:存在|加载|路径|exists?|load|path)/i;
export const isSmallTask = (task: string): boolean => task.length <= 160 && !COMPLEX_RE.test(withoutGuidance(task))
  && (SMALL_RE.test(task) || (fileRefs(task).length > 0 && FILE_CHECK_RE.test(task)));
const smallFor = (task: string, tier?: TierName): boolean => tier ? tier === "mini" || tier === "light" : isSmallTask(task);

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

interface Ctx { now: number; home: string; ttlMs: number; small: boolean; force: boolean }

const costLines = (e: Evidence, c: Ctx): string[] => {
  const ctx = e.row.contextTokens;
  if (!ctx) return [];
  const ttlMs = e.row.cacheTtlMs ?? c.ttlMs;
  const w = wakeCostOf(ctx, touchOf(e.row), c.now, ttlMs);
  const ttl = `${Math.round(ttlMs / 60_000)} 分钟`;
  const wake = w.cold
    ? `缓存冷 (超过 TTL ${ttl}) · 唤醒要重写 ~${k(w.write)} 缓存 ≈ 白板 spawn 的 ${w.times} 倍${ctx >= BIG_COLD ? c.force ? " · force 已越过冷成本门槛" : " · 大 ctx 已冷, 默认不转" : ""}`
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
    e.exp.length ? `专长${quoted(e.exp)}` : "",
    e.asks.length ? `最近的话${quoted(e.asks)}` : "",
    e.common.length ? `降权的公共文件 ${e.common.slice(-4).map((f) => relTo(r.cwd, f)).join(" ")}${e.common.length > 4 ? ` +${e.common.length - 4}` : ""} (公共指引或多人读过, 不计证据)` : "",
  ].filter(Boolean);
  return [
    [`\`${addr(r)}\` ${r.busy ? "忙" : r.alive ? "闲" : "冷"}`, where, ctxOf(r.contextTokens) || "ctx ?", r.model || "model ?", agoOf(r.lastActivity, now)]
      .filter(Boolean).join(" · "),
    ...(r.description ? [`  职责: ${r.description}`] : []),
    ...(r.expertise ? [`  专长: ${r.expertise}`] : []),
    `  命中: ${hits.join(" · ")}`,
    ...(e.clues.length ? [`  同名文件线索: ${e.clues.map((f) => basename(f)).join(" ")} (路径未对上, 不证明连续性)`] : []),
    ...(r.lead ? ["  占用: lead 身份"] : []),
    ...(r.duties?.length ? [`  占用: ${r.duties.join(" · ")}`] : []),
    `  材料关联: ${e.continuity ? e.matched.map((m) => `${m.kind} ${m.path} · ${m.source} · ${agoOf(m.at, now)}`).join("; ") : "未证实"}`,
    ...e.materialIssues.map((x) => `  证据范围: ${x}`),
    `  自动复用: ${vetoOf(e, now, c.ttlMs, c.small, c.force) || "可选; 真实续篇优先 tell_peer re"}`,
    ...(r.files.length ? [`  上下文: 读过 ${r.files.length} 个文件 (${spread(r.cwd, r.files)})`] : []),
    ...costLines(e, c),
    ...(r.summary ? [`  最近: ${r.summary}`] : []),
  ];
};

/** 给管家读的候选表。末尾永远留着「新 spawn」这一项 —— 它是没有好候选时的默认。 */
export const renderCandidates = (task: string, cands: readonly Evidence[], now: number, ttlMs: number, home = "", options: { tier?: TierName; force?: boolean } = {}): string => {
  const c: Ctx = { now, home, ttlMs, small: smallFor(task, options.tier), force: options.force === true };
  return [
    cands.length
      ? `和这件活有交集的已有 wizard ${cands.length} 个, 证据强的在前 (文件命中 = 它真读过; 词面重叠只是线索):`
      : "没有哪个已有 wizard 的职责、最近的话或读过的文件和这件活有交集。",
    ...(c.small ? ["体量: 看着是小活 (明确简单动作) —— 默认白板 spawn 或交给 ctx 小的, 除非它真依赖某段上下文。"] : []),
    ...cands.flatMap((e) => renderOne(e, c)),
    "",
    `· 新 spawn —— 白板起步, 不背任何历史 (起步 ctx 约 ${k(FRESH_CTX)})。`,
    "由你判断: 交集是不是同一件事; 接着用它那段上下文省下的重读, 值不值得唤醒时的缓存重写和往后每一轮背着的 ctx。标了 ⚠ 的默认不转, 除非你看得出这件活确实离不开它那段上下文。",
  ].join("\n");
};

// ── dispatch: 管家派活的默认决定 ──────────────────────────────────────
// 上面的表是给模型读的; 这里把同一套事实收成一个默认决定 —— 管家愚笨也不会派错的那一半:
// 证据够强、不忙、划算、过得了冷门控的头一个候选 → 转给它; 都不是 → 按档白板 spawn。
// `to` 显式点名保留人为选择; `force` 只越缓存成本, 不越复用保护。

export type Decision =
  | { kind: "existing"; row: RouteRow; why: string }
  | { kind: "spawn"; why: string };

/** 一个候选为什么不转给它; "" = 可以转。 */
const vetoesOf = (e: Evidence, now: number, ttlMs: number, small: boolean, force: boolean): string[] => {
  const r = e.row, ctx = r.contextTokens;
  const w = wakeCostOf(ctx, touchOf(r), now, r.cacheTtlMs ?? ttlMs);
  return [
    ...(r.lead ? ["lead 身份, 独立任务不自动复用 (续篇用 tell_peer re)"] : []),
    ...(r.duties?.length ? [`任务占用 (${r.duties.join(" · ")})`] : []),
    ...(!r.alive ? ["不在线"] : []), ...(r.busy ? ["正忙"] : []),
    ...(!(ctx > 0 && Number.isFinite(ctx)) ? ["ctx 未知, 不能按免费上下文复用"] : []),
    ...(!e.continuity ? ["未证实近期真实任务的实际材料关联"] : []),
    ...(notWorth(e, w, small, ctx) ? [`不划算 (${small ? "小活" : "证据弱"}却要${w.cold ? "整段重写" : "一直背着"} ${k(ctx)})`] : []),
    ...(w.cold && ctx >= BIG_COLD && !force ? [`缓存冷且 ctx ${k(ctx)} (大 ctx 已冷默认不转; 活真依赖它的上下文就 to+force)`] : []),
  ];
};
const vetoOf = (e: Evidence, now: number, ttlMs: number, small: boolean, force: boolean): string =>
  vetoesOf(e, now, ttlMs, small, force).join("; ");

export const routeDiagnostics = (task: string, cands: readonly Evidence[], now: number, ttlMs: number, force = false, tier?: TierName) => ({
  total: cands.length, shown: cands.length, truncated: false,
  scope: "current session, latest real task, compact boundary / 1MB tail, <=1h",
  candidates: cands.map((e) => ({
    name: e.row.address || e.row.name, sessionId: e.row.sessionId, model: e.row.model || "unknown",
    targetRoles: e.targetRoles,
    matchedPaths: e.matched.map((m) => m.path), objects: e.objects, materials: e.matched,
    observed: (e.row.materials ?? []).map(({ path, kind, source, at, taskAt, turn, session, confirmed }) => ({ path, kind, source, at, taskAt, turn, session, confirmed })),
    common: e.common, issues: e.materialIssues, contextTokens: e.row.contextTokens || null, contextKnown: e.row.contextTokens > 0,
    cache: wakeCostOf(e.row.contextTokens, touchOf(e.row), now, e.row.cacheTtlMs ?? ttlMs),
    veto: vetoOf(e, now, ttlMs, smallFor(task, tier), force),
    vetoes: vetoesOf(e, now, ttlMs, smallFor(task, tier), force),
  })),
});

const evidenceLine = (e: Evidence): string =>
  [
    e.matched.length ? `实际材料 ${e.matched.map((m) => `${m.kind} ${m.path}`).join(", ")}` : "",
    e.desc.length ? `职责${quoted(e.desc, 3)}` : "",
    e.exp.length ? `专长${quoted(e.exp, 3)}` : "",
    e.row.contextTokens ? ctxOf(e.row.contextTokens) : "",
  ].filter(Boolean).join(" · ");

/** 默认决定: 候选按证据排好 (rankCandidates), 取头一个没被否决的; 一个都没有 → spawn, 理由保留全部候选的否决。 */
export const decide = (task: string, cands: readonly Evidence[], now: number, ttlMs: number, force = false, tier?: TierName): Decision => {
  const small = smallFor(task, tier);
  const vetoes = cands.map((e) => ({ e, veto: vetoOf(e, now, ttlMs, small, force) }));
  const hit = vetoes.find((v) => !v.veto);
  if (hit) return { kind: "existing", row: hit.e.row, why: `转给 ${addr(hit.e.row)}: ${evidenceLine(hit.e)}` };
  return {
    kind: "spawn",
    why: vetoes.length
      ? `白板 spawn —— ${vetoes.map((v) => `${addr(v.e.row)} ${v.veto}`).join("; ")}`
      : "白板 spawn —— 没有哪个已有 wizard 和这件活有交集",
  };
};

/** spawn 时的默认档: 明确简单动作 → light; 其余 standard —— 默认不上 hard。
 *  以前按 COMPLEX_RE 把「设计 / 排障 / 审查」这类措辞自动升到 hard, 而这些词在真活里太常见,
 *  于是几乎每个派出去的活都落 opus; 现在 hard / ultra 只由调用方显式给 (`tier:"hard"`),
 *  lead 是唯一的例外 (它本来就是「要判断」的那一档)。 */
export const tierFor = (task: string, lead: boolean): TierName =>
  lead ? "hard" : isSmallTask(task) ? "light" : "standard";
