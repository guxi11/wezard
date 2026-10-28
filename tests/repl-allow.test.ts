// 单元测试: REPL (CodeBuddy PTC) 的白名单下钻 — 运行: npx tsx tests/repl-allow.test.ts
//
// 为什么钉这一组: CodeBuddy 把每个工具调用包进 REPL 的 code 脚本, hook 只看得见
// "REPL" 这一层 —— 此前 evaluateAllow 对它只能整工具判定, 用户白名单里的
// Read / Bash(grep *) 对 REPL 调用全部失明, 每条都发「REPL 未在白名单」的卡。
// 现在按内层调用判: 档位跟着内层操作走 (与 danger.ts 的内层命令判定同一原则)。
// 两侧都要钉住: 内层全被规则覆盖的要放行 (降噪), 认不出/未覆盖的必须发卡 (安全)。
import assert from "node:assert";
import { alwaysAllowRulesFor, evaluateAllow, ruleMatchesAny } from "../shared/allow-rules.js";

let passed = 0;
let failed = 0;
const t = (name: string, fn: () => void): void => {
  try {
    fn();
    passed++;
    console.log(`ok    ${name}`);
  } catch (e) {
    failed++;
    console.log(`FAIL  ${name}\n      ${(e as Error).message}`);
  }
};

const RULES = ["Read", "Grep", "Bash(grep *)", "Bash(head *)"];
const repl = (code: string): { code: string; description: string } => ({ code, description: "test" });
const verdict = (code: string) => evaluateAllow(RULES, "REPL", repl(code));

// ── 放行侧: 内层全部被规则覆盖 → 不再发卡 ────────────────────────────
t("内层读类工具全在白名单 → 放行", () => {
  const v = verdict('const a = await Read({ file_path: "x" }); const b = await Grep({ pattern: "y" }); return [a, b];');
  assert.equal(v.allowed, true);
});
t("内层 Bash 命令命中 Bash(grep *) → 放行 (反引号/双引号/单引号三态)", () => {
  assert.equal(verdict("await Bash({ command: \`grep -n foo src\` })").allowed, true);
  assert.equal(verdict('await Bash({ command: "grep foo | head -3" })').allowed, true);
  assert.equal(verdict("await Bash({ command: 'head -5 x' })").allowed, true);
});
t("内层 Bash 段未命中 → segment_unmatched, 段文本可定位", () => {
  const v = verdict('await Bash({ command: "git status" })');
  assert.equal(v.allowed, false);
  if (v.allowed || v.reason.kind !== "segment_unmatched") { assert.fail("expected segment_unmatched"); return; }
  assert.equal(v.reason.segment, "git status");
  assert.equal(v.reason.rule, "Bash(git status *)");
});
t("内层工具未列 → tool_not_listed 报内层工具名 (不再是 REPL)", () => {
  const v = verdict('await Write({ file_path: "x", content: "y" })');
  assert.equal(v.allowed, false);
  if (v.allowed || v.reason.kind !== "tool_not_listed") { assert.fail("expected tool_not_listed"); return; }
  assert.equal(v.reason.tool, "Write");
});
t("读 + 未列 Write 混合 → 整条拒, 理由落在 Write", () => {
  const v = verdict('await Read({ file_path: "x" }); await Write({ file_path: "y", content: "z" })');
  assert.equal(v.allowed, false);
  assert.equal(v.allowed === false && v.reason.kind, "tool_not_listed");
});
t("裸 REPL 规则 = 显式整工具放行 (旧「总是」语义保留)", () => {
  const v = evaluateAllow([...RULES, "REPL"], "REPL", repl("anything at all"));
  assert.equal(v.allowed, true);
});
t("MCP 内层 server.tool 形态 ↔ mcp__server__tool 规则互通 (server 级/单工具)", () => {
  assert.equal(evaluateAllow(["mcp__lisct"], "REPL", repl('await mcp_lisct.add_elements({ set: "a" })')).allowed, true);
  assert.equal(evaluateAllow(["mcp__lisct__add_elements"], "REPL", repl('await mcp_lisct.add_elements({ set: "a" })')).allowed, true);
});
t("内层交互卡工具 → never_allow, 规则写了也不放行", () => {
  const v = evaluateAllow(["AskUserQuestion"], "REPL", repl("await AskUserQuestion({ questions: [] })"));
  assert.equal(v.allowed === false && v.reason.kind, "never_allow", JSON.stringify(v));
});
t("普通 JS 不当工具调用: .map(({…})) / new Set({…}) 不产生未列名", () => {
  const v1 = verdict('const rows = (await Read({ file_path: "x" })).split("\n").map((l) => l.trim()); return rows;');
  assert.equal(v1.allowed, true, JSON.stringify(v1));
  const v2 = verdict('const s = new Set({ a: 1 }); await Grep({ pattern: "x" }); return s;');
  assert.equal(v2.allowed, true, JSON.stringify(v2));
});

// ── 拒绝侧: 认不出就不放行 (fail-closed) ─────────────────────────────
t("命令是变量拼的 → repl_opaque (认不出的 Bash 形状计数兜底)", () => {
  const v = verdict('const cmd = "ls"; await Bash({ command: cmd });');
  assert.equal(v.allowed, false);
  assert.equal(v.allowed === false && v.reason.kind, "repl_opaque");
});
t("纯计算无可识别调用 → repl_opaque", () => {
  const v = verdict("return 1 + 1;");
  assert.equal(v.allowed, false);
  assert.equal(v.allowed === false && v.reason.kind, "repl_opaque");
});
t("code 解不出 (无 code 字段) → 落回整工具名判定 (现状)", () => {
  const v = evaluateAllow(RULES, "REPL", { description: "no code" });
  assert.equal(v.allowed === false && v.reason.kind, "tool_not_listed");
  if (v.allowed || v.reason.kind !== "tool_not_listed") return;
  assert.equal(v.reason.tool, "REPL");
});
t("规则为空 → no_rules (不提示)", () => {
  const v = evaluateAllow([], "REPL", repl("await Read({ file_path: 'x' })"));
  assert.equal(v.allowed === false && v.reason.kind, "no_rules");
});

// ── deny/ask 下钻: 藏在 REPL 里的命令照样抓 ──────────────────────────
t("deny Bash(rm *) 命中 REPL 内层的 rm 命令", () => {
  assert.equal(ruleMatchesAny(["Bash(rm *)"], "REPL", repl('await Bash({ command: "rm -rf x" })')), "Bash(rm *)");
});
t("deny 工具名命中 REPL 内层工具 (含 mcp 规范名)", () => {
  assert.equal(ruleMatchesAny(["Write"], "REPL", repl('await Write({ file_path: "x" })')), "Write");
  assert.equal(ruleMatchesAny(["mcp__lisct"], "REPL", repl('await mcp_lisct.add_elements({ set: "a" })')), "mcp__lisct");
});
t("deny 裸 REPL 规则命中整条", () => {
  assert.equal(ruleMatchesAny(["REPL"], "REPL", repl("anything")), "REPL");
});
t("deny 无命中 → undefined (白名单侧 repl_opaque 仍会兜住发卡)", () => {
  assert.equal(ruleMatchesAny(["Bash(rm *)"], "REPL", repl('await Bash({ command: "ls" })')), undefined);
});

// ── 「总是」生成: 按内层生成, 不再生成整工具放行的 "REPL" ─────────────
t("总是: 内层 Bash 逐段 + 工具名, 已覆盖的跳过", () => {
  const rules = alwaysAllowRulesFor("REPL", repl('await Read({ file_path: "x" }); await Bash({ command: "git status" })'), ["Read"]);
  assert.deepEqual(rules, ["Bash(git status *)"]);
});
t("总是: 变量拼的命令不生成 (保持一次性放行)", () => {
  assert.deepEqual(alwaysAllowRulesFor("REPL", repl('const c = "ls"; await Bash({ command: c });'), []), []);
});
t("总是: MCP 内层生成 Claude 式规范名", () => {
  assert.deepEqual(alwaysAllowRulesFor("REPL", repl('await mcp_lisct.add_elements({ set: "a" })'), []), ["mcp__lisct__add_elements"]);
});
t("总是: 生成的规则能放行原调用 (闭环)", () => {
  const code = 'await Read({ file_path: "x" }); await Bash({ command: "git status" })';
  const rules = alwaysAllowRulesFor("REPL", repl(code), []);
  assert.ok(evaluateAllow(rules, "REPL", repl(code)).allowed, `generated rules should allow original: ${rules.join(", ")}`);
});
t("总是: 内层交互卡工具不生成", () => {
  assert.deepEqual(alwaysAllowRulesFor("REPL", repl("await AskUserQuestion({ questions: [] })"), []), []);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
