// 受限会话的工具面电池 —— 对 tool-face.ts 里注册的**每一个** face 自动跑同一组断言。
// 新注册一个 face 就自动获得全套 (不用再写一遍「REPL 里能调什么」)。
import assert from "node:assert/strict";
import { GUIDE_DESC } from "../daemon/onboarding.js";
import { TOOL_FACES, faceOf, faceRefusal } from "../daemon/tool-face.js";
import type { WizardRecord } from "../daemon/wizard.js";

/** 每个 face 一个能匹配它的记录 (新增 face 时在这里补一条)。 */
const REC_FOR: Record<string, () => WizardRecord> = {
  guide: () => ({ target: "chat:wrG#guide", name: "guide", description: GUIDE_DESC, bornAt: 1 }) as WizardRecord,
  monitor: () => ({ target: "chat:wrG#monitor", name: "mon", description: "", bornAt: 1, kind: "monitor" }) as WizardRecord,
};

// 注册表自检: 名字唯一、白名单非空、都能造出匹配的记录。
assert.ok(TOOL_FACES.length > 0);
assert.equal(new Set(TOOL_FACES.map((f) => f.name)).size, TOOL_FACES.length, "face 名字唯一");
for (const face of TOOL_FACES) {
  assert.ok(face.tools.size > 0, face.name + " 白名单不能为空");
  assert.ok(REC_FOR[face.name], face.name + " 缺测试记录 (REC_FOR)");
  assert.equal(faceOf(REC_FOR[face.name]!())?.name, face.name, face.name + " 的记录能被 match");
  assert.equal(faceRefusal(undefined, "Bash"), "", "没有记录 = 不受限");
  assert.equal(faceRefusal({ target: "chat:wrG", name: "x", description: "", bornAt: 1 } as WizardRecord, "Bash"), "", "没有 face = 不受限");
}

for (const face of TOOL_FACES) {
  const rec = REC_FOR[face.name]!();
  const tools = [...face.tools];
  const other = TOOL_FACES.find((f) => f.name !== face.name);
  const otherTool = other ? [...other.tools].find((t) => !face.tools.has(t)) : undefined;

  // ① 外层白名单: 裸名与 mcp__wezard__ 前缀都放行。
  for (const t of tools) {
    assert.equal(faceRefusal(rec, t), "", face.name + " 外层放行 " + t);
    assert.equal(faceRefusal(rec, "mcp__wezard__" + t), "", face.name + " 外层放行 mcp__wezard__" + t);
  }

  // ② REPL 里调本 face 的白名单 → 放行 (含解构别名)。
  for (const t of tools) {
    assert.equal(faceRefusal(rec, "REPL", { code: "const r = await mcp.wezard." + t + "({}); return r;" }), "", face.name + " REPL 放行 " + t);
  }
  assert.equal(faceRefusal(rec, "REPL", { code: "const { " + tools[0] + " } = mcp.wezard; await " + tools[0] + "({});" }), "", face.name + " REPL 解构别名放行");

  // ③ REPL 里调别的 face 的工具 → 拒。
  if (otherTool) {
    assert.ok(faceRefusal(rec, "REPL", { code: "await mcp.wezard." + otherTool + "({});" }).length > 0, face.name + " REPL 拒别的 face 工具 " + otherTool);
  }

  // ④ 认不出的调用 / new / import / 解析失败 / 无 toolInput → 拒 (fail-closed)。
  assert.ok(faceRefusal(rec, "REPL", { code: "await doSomething();" }).length > 0, face.name + " 认不出的调用拒");
  assert.ok(faceRefusal(rec, "REPL", { code: "await new Foo();" }).length > 0, face.name + " new 拒");
  assert.ok(faceRefusal(rec, "REPL", { code: "await import('fs');" }).length > 0, face.name + " import 拒");
  assert.ok(faceRefusal(rec, "REPL", { code: "await mcp.wezard." + tools[0] + "({" }).length > 0, face.name + " 解析失败拒");
  assert.ok(faceRefusal(rec, "REPL").length > 0, face.name + " 无 toolInput 的 REPL 拒");
  assert.ok(faceRefusal(rec, "REPL", {}).length > 0, face.name + " 没有 code 的 REPL 拒");

  // ⑤ 非 REPL、非白名单 → 拒, 理由里点名那个工具。
  const bad = "Bash";
  const why = faceRefusal(rec, bad);
  assert.ok(why.length > 0, face.name + " 非白名单拒 " + bad);
  assert.ok(why.includes(bad), face.name + " 拒绝理由带工具名: " + why);
}

console.log("tool-face ok: " + TOOL_FACES.map((f) => f.name + "(" + f.tools.size + ")").join(", "));
