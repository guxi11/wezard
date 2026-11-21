// 单元测试: shared/allow-rules.ts 的 evaluateAllow / DenyReason
// 运行: npx tsx tests/deny-reason.test.ts
//
// 覆盖"为什么这条命令没被白名单放行" —— 卡片「审核」行的数据源。ruleAllows
// 的既有 56 条测试锁住"放不放行", 这里锁住"不放行时给出的理由对不对"。
import assert from "node:assert";
import { evaluateAllow, ruleForSegment } from "../shared/allow-rules.js";
import { ruleAllows } from "./allow-rules-helper.js";

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

const bash = (command: string): { command: string } => ({ command });
const RULES = ["Bash(git status)", "Bash(git log *)", "Bash(cd *)", "Read"];

// ── 放行路径与旧包装保持一致 ──────────────────────────────────────────
t("命中: hits 与 ruleAllows 输出一致", () => {
  const v = evaluateAllow(RULES, "Bash", bash("git status"));
  assert.equal(v.allowed, true);
  assert.equal(ruleAllows(RULES, "Bash", bash("git status")), "Bash(git status)");
});

t("命中: 复合命令逐段命中, 规则去重", () => {
  const v = evaluateAllow(RULES, "Bash", bash("cd /tmp && cd /var"));
  assert.equal(v.allowed, true);
  assert.equal(ruleAllows(RULES, "Bash", bash("cd /tmp && cd /var")), "Bash(cd *)");
});

// ── segment_unmatched: 最常见, 要能定位到段 ──────────────────────────
t("某段未命中: 报出段序号/总数/段文本", () => {
  const v = evaluateAllow(RULES, "Bash", bash("cd /tmp && npm publish --access public"));
  assert.equal(v.allowed, false);
  if (v.allowed) return;
  assert.equal(v.reason.kind, "segment_unmatched");
  if (v.reason.kind !== "segment_unmatched") return;
  assert.equal(v.reason.index, 2);
  assert.equal(v.reason.total, 2);
  assert.equal(v.reason.segment, "npm publish --access public");
});

t("某段未命中: 带上「总是」会生成的规则", () => {
  const v = evaluateAllow(RULES, "Bash", bash("cd /tmp && npm publish"));
  if (v.allowed || v.reason.kind !== "segment_unmatched") { assert.fail("expected segment_unmatched"); return; }
  assert.equal(v.reason.rule, "Bash(npm publish *)");
});

t("某段未命中: 解释器头部拿不到子命令 → 不给规则 (防全放行)", () => {
  const v = evaluateAllow(RULES, "Bash", bash("python3"));
  if (v.allowed || v.reason.kind !== "segment_unmatched") { assert.fail("expected segment_unmatched"); return; }
  assert.equal(v.reason.rule, undefined);
});

t("第一个未命中的段即报, 不看后面", () => {
  const v = evaluateAllow(RULES, "Bash", bash("npm publish && rm -rf /"));
  if (v.allowed || v.reason.kind !== "segment_unmatched") { assert.fail("expected segment_unmatched"); return; }
  assert.equal(v.reason.index, 1);
});

// ── 其余原因分支 ──────────────────────────────────────────────────────
t("含 $() → substitution", () => {
  const v = evaluateAllow(RULES, "Bash", bash("cd $(pwd)"));
  assert.equal(v.allowed === false && v.reason.kind, "substitution");
});

t("反引号 → substitution", () => {
  const v = evaluateAllow(RULES, "Bash", bash("cd `pwd`"));
  assert.equal(v.allowed === false && v.reason.kind, "substitution");
});

t("引号未闭合 → unparsable", () => {
  const v = evaluateAllow(RULES, "Bash", bash('git log "unclosed'));
  assert.equal(v.allowed === false && v.reason.kind, "unparsable");
});

t("孤立 & (后台执行) → unparsable", () => {
  const v = evaluateAllow(RULES, "Bash", bash("git status & sleep 1"));
  assert.equal(v.allowed === false && v.reason.kind, "unparsable");
});

t("空命令 → unparsable", () => {
  const v = evaluateAllow(RULES, "Bash", bash("   "));
  assert.equal(v.allowed === false && v.reason.kind, "unparsable");
});

t("非 Bash 工具未列 → tool_not_listed 且带工具名", () => {
  const v = evaluateAllow(RULES, "mcp__ontology__ask", {});
  assert.equal(v.allowed, false);
  if (v.allowed || v.reason.kind !== "tool_not_listed") { assert.fail("expected tool_not_listed"); return; }
  assert.equal(v.reason.tool, "mcp__ontology__ask");
});

t("非 Bash 工具已列 → 放行", () => {
  assert.equal(evaluateAllow(RULES, "Read", {}).allowed, true);
});

t("交互卡工具 → never_allow (即使规则里写了)", () => {
  const v = evaluateAllow([...RULES, "AskUserQuestion"], "AskUserQuestion", {});
  assert.equal(v.allowed === false && v.reason.kind, "never_allow");
});

t("规则为空 → no_rules (卡上不提示, 避免每张卡都挂噪声)", () => {
  const v = evaluateAllow([], "Bash", bash("anything"));
  assert.equal(v.allowed === false && v.reason.kind, "no_rules");
});

t("有规则但无 Bash 规则 → no_rules", () => {
  const v = evaluateAllow(["Read"], "Bash", bash("git status"));
  assert.equal(v.allowed === false && v.reason.kind, "no_rules");
});

// ── ruleForSegment 与「总是」生成同源 ────────────────────────────────
t("ruleForSegment: 命令+子命令两段式前缀", () => {
  assert.equal(ruleForSegment("npm run build --watch"), "Bash(npm run *)");
});

t("ruleForSegment: 第二 token 是 flag → 退化单命令", () => {
  assert.equal(ruleForSegment("ls -la"), "Bash(ls *)");
});

t("ruleForSegment: 段首 VAR= 前缀剥掉", () => {
  assert.equal(ruleForSegment("TZ=UTC date +%s"), "Bash(date *)");
});

t("ruleForSegment: 异形段首 → undefined", () => {
  assert.equal(ruleForSegment('"quoted" arg'), undefined);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
