// 详情页工具正文: input / input raw / output / output raw 的分区与递归值视图。
// 契约是「人读的那份」—— 换行照换、JSON 字符串拆开、原文另留一份 raw。
import assert from "node:assert/strict";
import { renderToolBody } from "../shared/detail-render.js";
import type { TurnDetailRecord, TurnItem } from "../shared/detail-store.js";

const code = [
  "const r = await mcp_wezard.delegate({",
  "  task: \"line one\\nline two\",",
  "  tier: \"light\",",
  "});",
].join("\n");
const use: Extract<TurnItem, { t: "tool_use" }> = { t: "tool_use", toolUseId: "u1", toolName: "REPL", toolInput: { code }, ts: 1 };
const shell = (result: unknown, stdout = "") => JSON.stringify({ result, stdout, stderr: "" });
const record = (body: string): TurnDetailRecord => ({ kind: "turn", id: "t", createdAt: 1, updatedAt: 2, closed: true,
  target: "user:admin", items: [use, { t: "tool_result", toolUseId: "u1", body, ts: 3 }] });

const reply = { ok: true, name: "worker", decision: "spawn", event: "e1" };
const html = renderToolBody(record(shell(JSON.stringify(reply))), "u1")!;
assert.match(html, /<summary>input<\/summary>/);
assert.match(html, /<summary>input raw<\/summary>/);
assert.match(html, /<summary>output<\/summary>/);
assert.match(html, /<summary>output raw<\/summary>/);
// 代码里的换行是真换行 (不是一行转义过的 \\n); 原文那份仍在 input raw 里。
assert.ok(html.includes("class=\"vt-str\">const r = await mcp_wezard.delegate({\n  task:"), "输入字符串应按原文换行");
assert.ok(/<summary>input raw<\/summary><pre><code>[^]*?\\\\n/.test(html), "input raw 应保留转义换行");
// 结果里套了一层 JSON 字符串: 拆开渲染, 带 json 角标。
assert.ok(html.includes("class=\"vt-flag\">json</span>"), "JSON 字符串应拆开渲染");
assert.ok(html.includes("class=\"vt-k\">decision"), "键应成列");
assert.ok(html.includes("<span class=\"vt-str\">spawn</span>"), "值应可读");
// 结构化的那份不是一行 JSON。
assert.ok(!/<summary>output<\/summary><pre><code>/.test(html), "output 应是结构化视图, 不是一行 JSON");

// 不是 JSON 的结果: 只有一份 output (原文), 不硬造结构。
const plain = renderToolBody(record("hello\nworld\n"), "u1")!;
assert.match(plain, /<summary>output<\/summary>/);
assert.ok(!plain.includes("class=\"vt-flag\""), "非 JSON 结果不该有 json 角标");
assert.ok(!plain.includes("<summary>output raw</summary>"), "非 JSON 结果不该重复一份 raw");
assert.ok(plain.includes("hello\nworld"), "非 JSON 结果按原文显示");

// 没结果: 明说尚未捕获, 不留空区块。
const none = renderToolBody({ kind: "turn", id: "t2", createdAt: 1, updatedAt: 2, closed: false, target: "user:admin", items: [use] }, "u1")!;
assert.ok(none.includes("(尚未捕获)"));
console.log("Detail input/output partition and recursive value view checks passed");
