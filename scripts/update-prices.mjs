#!/usr/bin/env node
// 从 LiteLLM 的 model_prices_and_context_window.json (ccusage 用的同一张表) 生成
// shared/model-prices.ts: 只留 chat 模型, 键归一成裸模型名, 单价换成 USD / 百万 token。
// 用法: node scripts/update-prices.mjs [本地 json 路径]   (缺省从 GitHub 拉)
import { readFileSync, writeFileSync } from "node:fs";

const SRC = "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";
const OUT = new URL("../shared/model-prices.ts", import.meta.url);

const src = process.argv[2]
  ? JSON.parse(readFileSync(process.argv[2], "utf8"))
  : await (await fetch(SRC)).json();

// 区域前缀 (bedrock 跨区) 价格上浮, 只在没有更干净的来源时用。
const REGION = /^(?:us-gov|us|eu|apac|au|jp|global)\./;
const VENDOR = /^(?:anthropic|deepseek|zai|moonshotai|moonshot|openai|google|meta|mistral|qwen|minimax|amazon|cohere)\./;
const bare = (k) => k.replace(REGION, "").replace(VENDOR, "").replace(/-v\d+(?::\d+)?$/, "").replace(/@(\d{8})$/, "-$1");
const rank = (k) => (k.startsWith("global.") ? 1 : REGION.test(k) ? 3 : VENDOR.test(k) ? 2 : 0);
const M = (x) => Math.round(x * 1e6 * 1e4) / 1e4;

const best = Object.entries(src)
  .filter(([k, v]) => !k.includes("/") && v.mode === "chat" && v.input_cost_per_token > 0 && v.output_cost_per_token > 0)
  .reduce((m, [k, v]) => {
    const b = bare(k).toLowerCase();
    const cur = m.get(b);
    return cur && cur.rank <= rank(k) ? m : m.set(b, { rank: rank(k), v });
  }, new Map());

const rows = [...best.entries()]
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([k, { v }]) => {
    const p = [M(v.input_cost_per_token), M(v.output_cost_per_token)];
    const cw = v.cache_creation_input_token_cost, cr = v.cache_read_input_token_cost;
    // 0 是「这家缓存不另收钱」, 与缺省 (表里没写) 不同 —— 缺省才交给 pricing.ts 兜底。
    const has = (x) => typeof x === "number";
    const tail = has(cw) || has(cr) ? [has(cw) ? M(cw) : null, has(cr) ? M(cr) : null] : [];
    return `  ${JSON.stringify(k)}: ${JSON.stringify([...p, ...tail])},`;
  });

writeFileSync(OUT, `// 生成文件, 别手改: node scripts/update-prices.mjs
// 来源 LiteLLM model_prices_and_context_window.json, 快照于 ${new Date().toISOString().slice(0, 10)}。
// 每项 = [输入, 输出, 缓存写?, 缓存读?] USD / 百万 token; 缓存档缺省 (null / 省略) 由 pricing.ts 兜底。
export const MODEL_PRICES: Readonly<Record<string, readonly (number | null)[]>> = {
${rows.join("\n")}
};
`);
console.log(`${rows.length} models → ${OUT.pathname}`);
