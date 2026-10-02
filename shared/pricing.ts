// 按模型计费: 价格表是 LiteLLM 的快照 (model-prices.ts, scripts/update-prices.mjs 生成),
// 这里只做「transcript 里的模型名 → 表里的键」与单价乘法。纯函数, daemon 与独立 svr 共用。
//
// 快照而非运行时拉取: svr 可能跑在拿不到 GitHub 的机器上, 且同一份记录今天和明天算出的账
// 不该因为上游改表而变; 也不引依赖 —— LiteLLM 没有只含价格表的 npm 包。
// 不分档: Claude 早期型号 >200k 上下文的加价按单次调用计, 而轮次只存了累计数。
import { MODEL_PRICES } from "./model-prices.js";

export interface Price { in: number; out: number; cacheWrite: number; cacheRead: number }
export interface Tokens { input: number; output: number; cacheWrite: number; cacheRead: number }

const REGION = /^(?:us-gov|us|eu|apac|au|jp|global)\./;
const VENDOR = /^(?:anthropic|deepseek|zai|moonshotai|moonshot|openai|google|meta|mistral|qwen|minimax|amazon|cohere)\./;

/** 去掉各后端 / 网关给模型名加的壳: `[1m]`、`vendor/`、bedrock 前缀与 `-v1:0`、`@日期`。 */
const unwrap = (m: string): string =>
  m.toLowerCase().trim()
    .replace(/\[1m\]$/, "")
    .replace(/^.*\//, "")
    .replace(REGION, "").replace(VENDOR, "")
    .replace(/-v\d+(?::\d+)?$/, "")
    .replace(/@(\d{8})$/, "-$1");

// 同一个模型的几种写法, 依次去表里找: 原样 → 去日期 → 网关倒装 (claude-4.7-opus) → 点号版本 (claude-opus-4.7)。
const spellings = (m: string): string[] => {
  const undated = m.replace(/-\d{8}$/, "");
  const flipped = undated.replace(/^claude-(\d+)(?:[.-](\d+))?-(opus|sonnet|haiku|fable|mythos)\b/, (_, a, b, f) => `claude-${f}-${a}${b ? `-${b}` : ""}`);
  const dashed = flipped.replace(/^(claude-[a-z]+-\d+)\.(\d+)/, "$1-$2");
  return [...new Set([m, undated, flipped, dashed])];
};

const KEYS = Object.keys(MODEL_PRICES).sort((a, b) => b.length - a.length);

/** 都没精确命中: 表里最长的、是它前缀的键 (claude-opus-5-5-preview → claude-opus-5-5)。 */
const byPrefix = (m: string): string | undefined => KEYS.find((k) => m.startsWith(`${k}-`));

const toPrice = (row: readonly (number | null)[]): Price => {
  const [i = 0, o = 0, cw, cr] = row;
  // 表里没有缓存档 = 该家不单独计缓存价: 写按输入价, 读也按输入价 (宁高勿低)。
  return { in: i ?? 0, out: o ?? 0, cacheWrite: cw ?? i ?? 0, cacheRead: cr ?? i ?? 0 };
};

const memo = new Map<string, Price | undefined>();

/** 模型的单价 (USD / 百万 token); 表里认不出 → undefined, 由调用方记成「未计价」, 不瞎猜。 */
export const priceOf = (model: string | undefined): Price | undefined => {
  if (!model) return undefined;
  if (memo.has(model)) return memo.get(model);
  const names = spellings(unwrap(model));
  const key = names.find((n) => n in MODEL_PRICES) ?? names.map(byPrefix).find(Boolean);
  const p = key ? toPrice(MODEL_PRICES[key]!) : undefined;
  memo.set(model, p);
  return p;
};

export const costOf = (p: Price, t: Tokens): number =>
  (t.input * p.in + t.output * p.out + t.cacheWrite * p.cacheWrite + t.cacheRead * p.cacheRead) / 1_000_000;
