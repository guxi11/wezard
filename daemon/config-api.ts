// config_get / config_set: the whole ConfigSchema, progressively disclosed. Everything a
// model reads here — types, defaults, prose, who may change it, when it bites — comes
// from the schema itself (shared/config-meta.ts); this module only renders and plans.
// The card for a `card`-gated write and the actual file write are the caller's (index.ts).
import type { Config } from "../shared/config.js";
import { ConfigSchema, TIERS, tiersForBackend, configIssues, parseConfigText, readSecrets, type TierName } from "../shared/config.js";
import type { CliBackendName } from "../shared/cli-backends.js";
import { previewPatch, readJsoncText } from "../shared/config-writer.js";
import {
  childKeys, isBranch, parsePath, resolve, toJsonPath, typeOf, writeGate,
  type Apply, type Gate, type Resolved,
} from "../shared/config-meta.js";
import { z } from "zod";
import { sameBot } from "../shared/session-label.js";
import { chatBaseOf } from "./chat-name.js";

type Err = { ok: false; reason: string };
type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
const getIn = (obj: unknown, path: readonly string[]): unknown =>
  path.reduce<unknown>((acc, k) => (acc && typeof acc === "object" ? (acc as Obj)[k] : undefined), obj);

/** 把 `next` 在 `path` 处的值装进 `obj` (原地): 路上缺的祖先 (记录里的新键、没写过的节) 从最浅的那一层
 *  整段取 `next` 的 —— 连同 schema 默认一起补全; 取到 undefined (unset 掉的记录项) 就删键, 不留一个值为
 *  undefined 的键给 `Object.entries` 读。 */
const putFrom = (obj: Obj, path: readonly string[], next: unknown): void => {
  const depth = path.findIndex((_, i) => i < path.length - 1 && !(isObj(getIn(obj, path.slice(0, i + 1))) || Array.isArray(getIn(obj, path.slice(0, i + 1)))));
  const at = depth < 0 ? path : path.slice(0, depth + 1);
  const parent = getIn(obj, at.slice(0, -1)) as Obj;
  const key = at[at.length - 1]!;
  const value = getIn(next, at);
  if (value === undefined) delete parent[key];
  else parent[key] = value;
};

// 默认值从 schema 解析一份空配置得来, 而不是读字段自己的 default: `models.backends.claude.tiers.light.model`
// 的字段默认是 "", 真默认 "haiku" 写在上一层的 `.default({...})` 里。
let defaults: Obj | undefined;
const defaultsOf = (): Obj => (defaults ??= ConfigSchema.parse({ bot: { botId: "-", secret: "-" } }) as Obj);

/** `path` 处的默认值。记录里的项 (`chatPolicy.<chat>.topOnly`) 不在空配置里: 取记录值类型对 `{}` 的解析 ——
 *  没写过的聊天读到的正是它 (chatPolicyOf 就这么读)。 */
const defaultAt = (path: readonly string[]): unknown => {
  const hit = getIn(defaultsOf(), path);
  if (hit !== undefined) return hit;
  const i = path.findIndex((_, j) => resolve(ConfigSchema, path.slice(0, j))?.core instanceof z.ZodRecord);
  if (i < 0) return undefined;
  const rec = resolve(ConfigSchema, path.slice(0, i))!.core as z.ZodRecord;
  const v = rec._def.valueType.safeParse({});
  return v.success ? getIn(v.data, path.slice(i + 1)) : undefined;
};

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
const show = (v: unknown): string => (v === undefined ? "—" : JSON.stringify(v));
const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

// ── 可见性 ──────────────────────────────────────────────────────────────
// hidden 两个来源: schema 标的 (bot / 口令), 以及 secrets.json 里实际出现的任何叶子 ——
// 那里的值叠在 config.jsonc 之上, 读出来是泄密, 写进 config.jsonc 也会被它盖掉。
const fromSecrets = (path: readonly string[], secrets: Obj): boolean =>
  path.some((_, i) => { const v = getIn(secrets, path.slice(0, i + 1)); return v !== undefined && !isObj(v); });

const visible = (r: Resolved, secrets: Obj): boolean => r.gate !== "hidden" && !fromSecrets(r.path, secrets);

const APPLY_WORD: Record<Apply, string> = { hot: "热生效", reload: "需 reload" };
const GATE_WORD: Record<Gate, string> = { free: "wizard 可直接改", card: "改动要人在卡片上确认", hidden: "不可读写" };
const flags = (r: Resolved): string => `${writeGate(r) === "card" ? "✋" : ""}${r.apply === "reload" ? "↻" : ""}`;

const LEGEND = "✋ = 改动要人在卡片上点确认 · ↻ = 改完要 reload (`./cli/wezard.sh reload`) 才生效 · * = 当前值不同于默认";

// ── config_get ──────────────────────────────────────────────────────────
// 节 / 记录只报项数: 它们的子项各有各的值、默认与标记, 往下一层看。节上的 ✋ 只在整节都要
// 确认时才挂 (节自己的 gate), 混着的节 (wrc) 由子项各自标。
const row = (cfg: Config, r: Resolved): string => {
  const key = r.path[r.path.length - 1]!;
  const cur = getIn(cfg, r.path);
  const def = defaultAt(r.path);
  const many = isBranch(r.core) || r.core instanceof z.ZodRecord;
  // 记录里没写的项 (cur 为空) 读到的就是默认, 不算改过。
  const star = !many && cur !== undefined && !same(cur, def) ? "*" : " ";
  const size = isBranch(r.core) ? childKeys(r.core).length : isObj(cur) ? Object.keys(cur).length : 0;
  const val = many ? `${size} 项`
    : cur === undefined && def !== undefined ? `= — (没写, 按默认 ${clip(show(def), 40)})`
    : `= ${clip(show(cur), 80)}${star === "*" ? ` (默认 ${clip(show(def), 40)})` : ""}`;
  const mark = isBranch(r.core) ? (r.gate === "card" ? "✋" : "") : flags(r);
  return `${star} ${[`${key}  ${typeOf(r.core)} ${val}`, mark, r.desc].filter(Boolean).join("  ")}`;
};

const leaf = (cfg: Config, r: Resolved): string => [
  r.path.join("."),
  `  说明: ${r.desc || "—"}`,
  `  类型: ${typeOf(r.core)}${r.optional ? " (可不设)" : ""}`,
  `  当前: ${show(getIn(cfg, r.path))}`,
  `  默认: ${show(defaultAt(r.path))}`,
  `  生效: ${r.apply === "hot" ? "热生效, 改完即用" : "需 reload 才生效 (守护进程启动时读一次)"}`,
  `  权限: ${GATE_WORD[writeGate(r)]}`,
].join("\n");

// 记录 / 数组: 子项是数据而不是 schema 字段, 按数据列。
const entries = (cfg: Config, r: Resolved): string[] => {
  const v = getIn(cfg, r.path);
  const pairs: [string, unknown][] = Array.isArray(v) ? v.map((x, i) => [String(i), x]) : isObj(v) ? Object.entries(v) : [];
  return pairs.length ? pairs.map(([k, x]) => `  ${k} = ${clip(show(x), 120)}`) : ["  (空)"];
};

const missing = (path: string[], secrets: Obj): string => {
  const at = [...path.keys()].reverse().map((i) => path.slice(0, i)).find((p) => resolve(ConfigSchema, p));
  const base = resolve(ConfigSchema, at ?? [])!;
  const kids = childKeys(base.core).filter((k) => visible(resolve(ConfigSchema, [...base.path, k])!, secrets));
  return `没有 \`${path.join(".")}\`${kids.length ? `; \`${base.path.join(".") || "<root>"}\` 下有: ${kids.join(", ")}` : ""}`;
};

/** `path` 这一层的文本: 节点自己一行说明, 再逐项列子项 (或叶子详情)。`evidence` 挂额外依据 (用量等)。 */
export const configGet = (
  cfg: Config,
  sourcePath: string,
  path: string | undefined,
  evidence: (path: string[]) => string[] = () => [],
): { ok: true; text: string } | Err => {
  const p = parsePath(path);
  const secrets = readSecrets();
  const r = resolve(ConfigSchema, p);
  if (!r) return { ok: false, reason: missing(p, secrets) };
  if (!visible(r, secrets)) return { ok: false, reason: `\`${p.join(".")}\` 不可读` };
  const extra = evidence(p);
  const tail = [...(extra.length ? ["", "依据:", ...extra.map((l) => `  ${l}`)] : []), "", LEGEND];
  if (!isBranch(r.core)) {
    const body = r.core instanceof z.ZodRecord || r.core instanceof z.ZodArray
      ? [`${p.join(".")}  ${typeOf(r.core)}  ${flags(r)}  ${r.desc}`, ...entries(cfg, r), "", leaf(cfg, r).split("\n").slice(4).join("\n")]
      : [leaf(cfg, r)];
    return { ok: true, text: [...body, ...tail].join("\n") };
  }
  const head = p.length
    ? `${p.join(".")} · ${r.desc}${r.gate === "card" ? "  ✋" : ""}`
    : `wezard 配置 (${sourcePath}) —— config_get({path}) 逐层展开; config_set({path, value, dryRun:true}) 先看 diff 再改`;
  const kids = childKeys(r.core)
    .map((k) => resolve(ConfigSchema, [...p, k])!)
    .filter((c) => visible(c, secrets))
    .map((c) => row(cfg, c));
  return { ok: true, text: [head, ...kids, ...tail].join("\n") };
};

// ── config_set ──────────────────────────────────────────────────────────
export type Op = "set" | "add" | "remove" | "unset";
export interface SetReq { path?: string; value?: unknown; op?: string; dryRun?: boolean }

export interface Plan {
  ok: true;
  path: string[];
  jsonPath: (string | number)[];
  value: unknown;
  gate: Gate;
  apply: Apply;
  before: unknown;
  after: unknown;
  changed: boolean;
  diff: string;
  /** 改完之后的整份配置 (叠了 secrets) —— 比对「改了会不会动到宪章」时换进去渲染一遍。 */
  next: Config;
}

// 字符串之外的类型收到字符串时先试 JSON.parse —— MCP 那头模型常把 `true` / `5` / `["a"]` 写成字符串。
const coerce = (core: z.ZodTypeAny, v: unknown): unknown => {
  if (typeof v !== "string" || core instanceof z.ZodString || core instanceof z.ZodEnum) return v;
  try { return JSON.parse(v); } catch { return v; }
};

// 行级 diff: 掐掉公共首尾, 中间段前后各留一行上下文。jsonc-parser 的改动总是一段连续区域。
const lineDiff = (a: string, b: string): string => {
  const x = a.split("\n"), y = b.split("\n");
  let s = 0;
  while (s < x.length && s < y.length && x[s] === y[s]) s++;
  let e = 0;
  while (e < x.length - s && e < y.length - s && x[x.length - 1 - e] === y[y.length - 1 - e]) e++;
  const ctx = (l: string | undefined): string[] => (l === undefined ? [] : [`  ${l}`]);
  return [
    ...ctx(x[s - 1]),
    ...x.slice(s, x.length - e).map((l) => `- ${l}`),
    ...y.slice(s, y.length - e).map((l) => `+ ${l}`),
    ...ctx(x[x.length - e]),
  ].join("\n");
};

const parseOp = (op: string | undefined): Op | undefined =>
  op === undefined || op === "" ? "set" : (["set", "add", "remove", "unset"] as const).find((o) => o === op);

/** 算一次写入的全部后果而不落盘: 校验 (整份配置过 zod)、改前改后、jsonc diff、gate / apply。 */
export const planSet = (cfg: Config, sourcePath: string, req: SetReq): Plan | Err => {
  const p = parsePath(req.path);
  if (!p.length) return { ok: false, reason: "path 必填, 例如 'models.backends.claude.tiers.light.model'; 不知道有哪些就先 config_get()" };
  const secrets = readSecrets();
  const r = resolve(ConfigSchema, p);
  if (!r) return { ok: false, reason: missing(p, secrets) };
  const gate = writeGate(r);
  if (gate === "hidden" || getIn(secrets, p) !== undefined || fromSecrets(p, secrets)) return { ok: false, reason: `\`${p.join(".")}\` 不可写` };
  const op = parseOp(req.op);
  if (!op) return { ok: false, reason: `op 只能是 set / add / remove / unset, 收到 ${req.op}` };
  if ((op === "set" || op === "add" || op === "remove") && req.value === undefined) return { ok: false, reason: `op=${op} 要带 value` };

  // 改前取盘上那份 (叠 secrets 后解析) 而不是活的 cfg: reload 项写进文件后活值并不跟着变,
  // 拿活值当 before 会把「文件里已经是 X」说成「还是旧值」。
  const text = readJsoncText(sourcePath);
  const onDisk = parseConfigText(text);
  const before = getIn(onDisk.success ? onDisk.data : cfg, p);
  const value = (() => {
    if (op === "unset") return undefined;
    if (op === "set") return coerce(r.core, req.value);
    const el = (r.core as z.ZodArray<z.ZodTypeAny>).element;
    const items = (Array.isArray(req.value) ? req.value : [req.value]).map((x) => coerce(el, x));
    const cur = Array.isArray(before) ? before : [];
    return op === "add"
      ? [...cur, ...items.filter((x) => !cur.some((c) => same(c, x)))]
      : cur.filter((c) => !items.some((x) => same(c, x)));
  })();
  if ((op === "add" || op === "remove") && !(r.core instanceof z.ZodArray)) return { ok: false, reason: `\`${p.join(".")}\` 不是数组, add / remove 用不了` };

  const jsonPath = toJsonPath(ConfigSchema, p);
  const next = previewPatch(text, [{ path: jsonPath, value }]);
  const parsed = parseConfigText(next);
  if (!parsed.success) return { ok: false, reason: `校验没过, 没写:\n${configIssues(parsed.error)}` };
  const after = getIn(parsed.data, p);
  return {
    ok: true, path: p, jsonPath, value, gate, apply: r.apply, before, after,
    changed: next !== text,
    diff: lineDiff(text, next),
    next: parsed.data,
  };
};

/** 计划的文本形态: dryRun 的回包、确认卡的正文、写完的回执共用。 */
export const renderPlan = (pl: Plan): string => [
  `${pl.path.join(".")}: ${clip(show(pl.before), 300)} → ${clip(show(pl.after), 300)}`,
  `${GATE_WORD[pl.gate]} · ${APPLY_WORD[pl.apply]}`,
  ...(pl.changed ? ["", pl.diff] : ["(文件不变)"]),
].join("\n");

/** 落盘之后把新值装进活的 cfg —— 只对 hot 项: reload 项半途换值, 会让启动时抓住旧值的模块与现读的模块各执一词。 */
export const applyHot = (cfg: Config, pl: Plan): void => {
  if (pl.apply === "hot") putFrom(cfg as unknown as Obj, pl.path, pl.next);
};

/** 只装了这一处改动的顶层节 (深拷贝, 不碰活的 cfg) —— 同节里别人手改了、还没生效的 reload 项不跟着进来。 */
export const patchedTop = (cfg: Config, pl: Plan): unknown => {
  const key = pl.path[0]!;
  const box: Obj = { [key]: structuredClone((cfg as unknown as Obj)[key]) };
  putFrom(box, pl.path, pl.next);
  return box[key];
};

// ── config_get 的依据: 各档的实际用量 ───────────────────────────────────
// 口径是「按模型」: transcript 里只记了模型, 没记它是哪一档生的 —— 管家用的 sonnet 也会算进
// standard。各档在用的 wizard 数取名册里出生时记下的 tier。
export interface UsageTotals { tokens: number; cost: number }
export interface TierUsage { today: Map<string, UsageTotals>; week: Map<string, UsageTotals> }

// 口语模型名的每个词都出现在 id 里就算: 'sonnet 5' ⊂ claude-sonnet-5-5。
const matches = (want: string, id: string): boolean => {
  const words = want.toLowerCase().split(/[\s._-]+/).filter(Boolean);
  return words.length > 0 && words.every((w) => id.toLowerCase().includes(w));
};
const sumFor = (want: string, m: Map<string, UsageTotals>): UsageTotals =>
  [...m].filter(([id]) => matches(want, id)).reduce((a, [, x]) => ({ tokens: a.tokens + x.tokens, cost: a.cost + x.cost }), { tokens: 0, cost: 0 });

export const tierEvidence = (
  cfg: Config,
  path: string[],
  usage: () => TierUsage,
  holders: (tier: TierName) => number,
  fmt: { tokens: (n: number) => string; cost: (usd: number) => string },
): string[] => {
  if (path[0] !== "models") return [];
  const backend = path[1] === "backends" ? path[2] : undefined;
  if (path[1] === "backends" && !backend) return [];
  if (backend && !resolve(ConfigSchema, ["models", "backends", backend])) return [];
  const tiers = tiersForBackend(cfg, backend as CliBackendName | undefined);
  const tierPath = backend ? path.slice(3) : path.slice(1);
  const want = backend
    ? tierPath[0] === "tiers" && tierPath[1] ? [tierPath[1]] : tierPath.length === 0 || tierPath[0] === "tiers" ? [...TIERS] : []
    : tierPath.length === 0 ? [...TIERS] : tierPath[0] === "router" ? [cfg.models.router] : [];
  const rows = want.filter((n): n is TierName => (TIERS as readonly string[]).includes(n));
  if (!rows.length) return [];
  const u = usage();
  const line = (name: TierName): string => {
    const spec = tiers[name];
    const label = `${spec.model || "CLI 默认"}${spec.effort ? `·${spec.effort}` : ""}${name === cfg.models.router ? " · 管家档" : ""}`;
    if (!spec.model) return `${name} (${label}): 用的是 CLI 默认模型, 按模型统计不出来`;
    const w = sumFor(spec.model, u.week), d = sumFor(spec.model, u.today);
    return `${name} (${label}): 本周 ${fmt.tokens(w.tokens)} tok ${fmt.cost(w.cost)} · 今日 ${fmt.tokens(d.tokens)} tok ${fmt.cost(d.cost)} · 名册里记作这一档的 ${holders(name)} 个`;
  };
  return [...rows.map(line), "(用量按模型统计, 同一模型的档外用量也算在内)"];
};

// ── 按聊天的配置键 (多机器人隔离) ──────────────────────────────────────
/** 按聊天的两张表只留与调用方同机器人的 —— 别的机器人的聊天名 / 策略在它眼里不存在。单机器人原样。 */
export const cfgSeenBy = (cfg: Config, self: string): Config => ({
  ...cfg,
  chats: Object.fromEntries(Object.entries(cfg.chats).filter(([, b]) => sameBot(self, b))),
  chatPolicy: Object.fromEntries(Object.entries(cfg.chatPolicy).filter(([b]) => sameBot(self, b))),
});

// chatPolicy 的键一律落成 base principal: 聊天名会改, 拿它当键一改名策略就悄悄失效。写名字照收,
// 换成它此刻指向的 principal; 认不出的拒写 (写错的键静默无效, 比报错难查)。unset 一个盘上原样存在的
// 键不换 —— 留给清理老写法 / 失效的键。
// 多机器人: 指向别的机器人的聊天与「没有这个聊天」同形 (`self` = 调用方); 整表写会抹掉别的机器人的
// 那几行, 有这种行就拒整表写。单机器人时全都 sameBot, 这几道不拦任何东西。
export const pinChatKeys = (cfg: Config, req: SetReq, self: string): SetReq | { ok: false; reason: string } => {
  const p = parsePath(req.path);
  const bad = (k: string) => ({ ok: false as const, reason: `认不出聊天 \`${k}\`: 键写 base principal (\`chat:wr…\` / \`user:…\`) 或聊天名 (/chats)` });
  const foreignRows = (bases: readonly string[]): boolean => bases.some((b) => !sameBot(self, b));
  if (p[0] === "chats") {
    if (p.length === 1) {
      const vals = req.value && typeof req.value === "object" && !Array.isArray(req.value) ? Object.values(req.value as Record<string, unknown>).map(String) : [];
      return foreignRows([...Object.values(cfg.chats), ...vals]) ? { ok: false, reason: "chats 整表写会动到你看不见的聊天 —— 逐个写 chats.<名字>" } : req;
    }
    const cur = Object.entries(cfg.chats).find(([n]) => n.toLowerCase() === p[1]!.toLowerCase())?.[1];
    if (cur && !sameBot(self, cur)) return bad(p[1]!);
    if (typeof req.value === "string" && req.value.trim() && !sameBot(self, req.value.trim())) return bad(req.value.trim());
    return req;
  }
  if (p[0] !== "chatPolicy") return req;
  if (p.length === 1 && foreignRows(Object.keys(cfg.chatPolicy))) return { ok: false, reason: "chatPolicy 整表写会动到你看不见的聊天 —— 逐个写 chatPolicy.<聊天名>" };
  if (p.length === 1) {
    if (req.value === undefined || typeof req.value !== "object" || Array.isArray(req.value)) return req;
    const pairs = Object.entries(req.value as Record<string, unknown>).map(([k, v]) => [k, chatBaseOf(cfg, k), v] as const);
    const miss = pairs.find(([, b]) => !b || !sameBot(self, b));
    return miss ? bad(miss[0]) : { ...req, value: Object.fromEntries(pairs.map(([, b, v]) => [b, v])) };
  }
  const key = p[1]!;
  if (req.op === "unset" && p.length === 2 && key in cfg.chatPolicy) return sameBot(self, key) ? req : bad(key);
  const base = chatBaseOf(cfg, key);
  return base && sameBot(self, base) ? { ...req, path: ["chatPolicy", base, ...p.slice(2)].join(".") } : bad(key);
};

