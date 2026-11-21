import { evaluateAllow } from "../shared/allow-rules.js";

/** 测试用的投影: evaluateAllow 命中返回规则说明串, 未命中 undefined (生产侧只用 evaluateAllow 的完整裁决)。 */
export const ruleAllows = (rules: string[], toolName: string, toolInput: unknown): string | undefined => {
  const v = evaluateAllow(rules, toolName, toolInput);
  return v.allowed ? [...new Set(v.hits)].join(" + ") : undefined;
};
