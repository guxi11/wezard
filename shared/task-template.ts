// 派活正文的「模板文件 + 参数」展开 —— dispatch / tell_peer 的 `taskFile`+`params`。
//
// 为什么由 daemon 在入口展开而不是让调用方自己读文件: 协议卡这类长正文此前由
// 管家 LLM 逐字手抄进 task —— output 单价约为 input 的 5 倍, 而且手抄没有任何
// 完整性校验, 抄丢一节对方不会报错, 直接带着缺规则作答。模板 + 入口展开后,
// 调用方的工具 input/output 只剩路径与参数, 投递正文逐字节来自文件; 模板缺失、
// 缺参、越界都在开行 / 起 wizard 之前变成 400, 调用方回退内联重发即可, 一问不丢。
//
// 失败一律抛 `TemplateError` (reason 是给模型看的人话): 调用方 (daemon 路由) 把它
// 映射成 400。其它异常 (意外的 IO 崩溃等) 原样上抛, 由调用方按 5xx 处理。
import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";
import { expandHome } from "./paths.js";
import { interpolate } from "./std.js";

export const TEMPLATE_ROOT = "~/.wezard/templates";
export const MAX_TEMPLATE_BYTES = 64 * 1024;
/** 参数尺寸上限: 值 8KB / 总量 16KB —— 参数是「这一问的变量」, 不是第二条正文。 */
export const MAX_PARAM_VALUE_BYTES = 8 * 1024;
export const MAX_PARAMS_TOTAL_BYTES = 16 * 1024;

/** 模板/参数类失败 —— 调用方映射 400 (让调用方回退内联重发)。 */
export class TemplateError extends Error {}
const bad = (reason: string): never => {
  throw new TemplateError(reason);
};

/** 展开结果的回溯指针: rolepage 显示「来自模板 x@sha」, sha 随模板内容定版。 */
export interface TemplateRef {
  /** 相对模板根的路径 (统一正斜杠, 供审计显示)。 */
  path: string;
  /** 模板文件内容 sha256 的前 12 位 hex。 */
  sha: string;
}

export interface ExpandTaskInput {
  taskFile: string;
  params?: Record<string, string>;
}

export interface ExpandTaskOptions {
  /** 模板根, 默认 `~/.wezard/templates`。测试注入临时目录用。 */
  root?: string;
  /** 模板体积上限 (字节), 默认 64KB。 */
  maxBytes?: number;
}

export interface ExpandedTask {
  /** 展开后的完整投递正文 —— routes.jsonl 不存文本, 它就是 payload.text 的唯一真相。 */
  text: string;
  templateRef: TemplateRef;
}

// 必须与 shared/std.ts `interpolate` 的占位符语法逐字一致 (\s* 与 `#` 前缀都容):
// 用它提取「模板要哪些参数」, interpolate 才不会留下漏网的 {{…}}。std.ts 在共享
// 工作树里不能动, 这里复制一份 —— 改任何一边必须同步另一边。
const PLACEHOLDER_RE = /\{\{\s*#?([\p{L}\p{N}_-]+)\s*\}\}/gu;
/** 参数键与占位符同一字符集: 收窄到「能被模板引用」的形状, 拼错立刻显形。 */
const PARAM_KEY_RE = /^[\p{L}\p{N}_-]+$/u;

// 注入防护: 行首 (忽略前导空白) 的 `<` 会顶替真信封 —— REMINDER_RE 认行首
// <system-reminder…, withMsg 又取**最后一个**信封, 参数值里一行假信封就能劫持
// 整轮归属 (见 shared/reminder.ts)。只对参数值做: 模板本身是 daemon 侧的受控
// 文件, 没有不受信内容。
const escapeLeadingLt = (v: string): string =>
  v.split("\n").map((line) => line.replace(/^(\s*)</, "$1&lt;")).join("\n");

/** realpath 一条必须存在的路径; 失败折成人话的模板错误 (ENOENT 单说)。 */
const realpathOrBad = async (p: string, enoentReason: string): Promise<string> => {
  try {
    return await realpath(p);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code ?? "?";
    return code === "ENOENT" ? bad(enoentReason) : bad(`cannot resolve ${p}: ${code}`);
  }
};

/**
 * 把「模板 + 参数」展开成投递正文。依次校验 (spec §6): 根存在 (否则视为能力
 * 关闭) → realpath 后仍在根内 → 普通文件且 ≤ maxBytes → 合法 UTF-8 → 占位符
 * 与参数恰好互为补集 → 参数值行首 `<` 转义 → 展开结果非空且不以 `/` 开头。
 */
export const expandTask = async (
  input: ExpandTaskInput,
  opts: ExpandTaskOptions = {},
): Promise<ExpandedTask> => {
  // 根不存在 = 整个能力关闭 (没配模板目录的机器), 说「disabled」而不是 5xx。
  const root = await realpathOrBad(expandHome(opts.root ?? TEMPLATE_ROOT), "templates disabled");

  const real = await realpathOrBad(expandHome(input.taskFile), `template not found: ${input.taskFile}`);
  // relative() 而不是「根 + sep」前缀比对: 根 /a/b 与路径 /a/bb 这类兄弟目录
  // 前缀撞车也挡得住; real === root (taskFile 就是根本身) 一并拒绝。
  const rel = relative(root, real);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) bad("taskFile outside template root");

  // realpath 之后文件被换掉/删掉是极小窗口的竞态, 折成同一个 400 语义。
  const st = await stat(real).catch((e) => bad(`template unreadable: ${(e as NodeJS.ErrnoException).code ?? "?"}`));
  if (!st.isFile()) bad("taskFile is not a regular file");
  const maxBytes = opts.maxBytes ?? MAX_TEMPLATE_BYTES;
  if (st.size > maxBytes) bad(`template too large: ${st.size} bytes > ${maxBytes}`);

  const buf = await readFile(real).catch((e) => bad(`template unreadable: ${(e as NodeJS.ErrnoException).code ?? "?"}`));
  let template: string;
  try {
    // fatal: 坏 UTF-8 直接拒, 别让 U+FFFD 替换字符静默混进投递正文。顺手剥 BOM:
    // 它不算 JS 空白, trimStart 剥不掉, 留着会让「首行是 [qa-session]」这类判定静默失配。
    template = new TextDecoder("utf-8", { fatal: true }).decode(buf).replace(/^\uFEFF/, "");
  } catch {
    return bad("template is not valid UTF-8");
  }

  // 参数先于插值整体校验: interpolate 对未知键原样保留, 不预检就会静默带病。
  const params = input.params ?? {};
  let total = 0;
  for (const [k, v] of Object.entries(params)) {
    if (!PARAM_KEY_RE.test(k)) bad(`invalid param key: ${JSON.stringify(k)}`);
    if (typeof v !== "string") bad(`param value must be a string: ${k}`);
    const n = Buffer.byteLength(v);
    if (n > MAX_PARAM_VALUE_BYTES) bad(`param too large: ${k} (${n} bytes)`);
    total += n;
  }
  if (total > MAX_PARAMS_TOTAL_BYTES) bad(`params too large: ${total} bytes`);

  const wanted = new Set([...template.matchAll(PLACEHOLDER_RE)].map((m) => m[1]!));
  const given = new Set(Object.keys(params));
  const missing = [...wanted].filter((k) => !given.has(k));
  if (missing.length) bad(`missing params: ${missing.join(", ")}`);
  // 多余的键多半是拼写错 (防静默无效参数), 模板零占位符时同理全拒。
  const unknown = [...given].filter((k) => !wanted.has(k));
  if (unknown.length) bad(`unknown params: ${unknown.join(", ")}`);

  const text = interpolate(
    template,
    Object.fromEntries(Object.entries(params).map(([k, v]) => [k, escapeLeadingLt(v)])),
  );
  if (!text.trim()) bad("expanded task is empty");
  // 首字符 `/` 会被注入层当 slash 命令: 轻则丢信封, 重则 /clear 直接清会话
  // (mirror-bridge 的注入分支) —— 模板正文没有以它开头的合法理由。
  if (text.trimStart().startsWith("/")) bad(`expanded task must not start with "/": ${JSON.stringify(text.slice(0, 24))}`);

  return {
    text,
    templateRef: {
      path: rel.split(sep).join("/"),
      sha: createHash("sha256").update(buf).digest("hex").slice(0, 12),
    },
  };
};
