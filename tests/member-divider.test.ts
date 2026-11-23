// rolepage 成员栏: human / wizard 之间的分割线只在两组都非空时才画 (web/chat.js groupBreak, 按标记截出来跑)。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../web/chat.js", import.meta.url), "utf8");
const m = /\/\/ <group-break>[^\n]*\n([\s\S]*?)\/\/ <\/group-break>/.exec(src);
assert.ok(m, "chat.js 里找得到 group-break 标记");
const groupBreak = new Function(m![1]!.replace("var groupBreak =", "return") + "\n")() as (xs: Array<{ kind: string }>) => number;
const h = { kind: "human" }, w = { kind: "wizard" };

assert.equal(groupBreak([w, w, w]), -1, "没有 human: 不画 (曾把线画在第 1、2 个 wizard 之间)");
assert.equal(groupBreak([w]), -1);
assert.equal(groupBreak([h, h]), -1, "只有 human: 不画");
assert.equal(groupBreak([]), -1);
assert.equal(groupBreak([h, w, w]), 1, "有 human 且有 wizard: 线在第一个 wizard 上方");
assert.equal(groupBreak([h, h, w]), 2);
console.log("member-divider ok");
