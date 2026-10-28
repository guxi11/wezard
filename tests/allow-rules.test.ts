// 单元测试: shared/allow-rules.ts + shared/claude-permissions.ts — 运行: npx tsx tests/allow-rules.test.ts
import assert from "node:assert";
import { alwaysAllowRulesFor, parseRule, ruleAllows, ruleMatchesAny, splitSegments, WEZARD_MCP_BUILTIN } from "../shared/allow-rules.js";
import { mapClaudePermissions } from "../shared/claude-permissions.js";

let passed = 0;
let failed = 0;
const t = (name: string, fn: () => void): void => {
  try {
    fn();
    passed++;
    console.log(`ok    ${name}`);
  } catch (e) {
    failed++;
    console.error(`FAIL  ${name}: ${(e as Error).message}`);
  }
};

const bash = (cmd: string): { command: string } => ({ command: cmd });

// ── parseRule ───────────────────────────────────────────────────────────
t("parseRule: 裸工具名", () => {
  assert.deepEqual(parseRule("Read"), { tool: "Read", spec: undefined });
});
t("parseRule: Bash 带 specifier", () => {
  assert.deepEqual(parseRule("Bash(git log *)"), { tool: "Bash", spec: "git log *" });
});
t("parseRule: 非法格式返回 undefined", () => {
  assert.equal(parseRule("Bash(git log"), undefined);
  assert.equal(parseRule(""), undefined);
});

// ── 非 Bash 工具 ────────────────────────────────────────────────────────
t("裸工具名精确放行", () => {
  assert.equal(ruleAllows(["Read"], "Read", {}), "Read");
  assert.equal(ruleAllows(["Read"], "Write", {}), undefined);
});
t("mcp server 级规则覆盖其全部工具", () => {
  assert.equal(ruleAllows(["mcp__jira"], "mcp__jira__get_issue", {}), "mcp__jira");
  assert.equal(ruleAllows(["mcp__jira"], "mcp__jira2__get_issue", {}), undefined);
});
t("mcp 单工具规则", () => {
  assert.equal(ruleAllows(["mcp__jira__get_issue"], "mcp__jira__get_issue", {}), "mcp__jira__get_issue");
  assert.equal(ruleAllows(["mcp__jira__get_issue"], "mcp__jira__add_comment", {}), undefined);
});
t("非 Bash 工具的 specifier 规则无效(不误放行)", () => {
  assert.equal(ruleAllows(["Read(/etc/*)"], "Read", { file_path: "/etc/hosts" }), undefined);
});
t("交互卡工具永不可被规则放行", () => {
  assert.equal(ruleAllows(["AskUserQuestion"], "AskUserQuestion", {}), undefined);
  assert.equal(ruleAllows(["ExitPlanMode"], "ExitPlanMode", {}), undefined);
  assert.equal(ruleAllows(["EnterPlanMode"], "EnterPlanMode", {}), undefined);
});

// ── Bash: 精确与前缀 ────────────────────────────────────────────────────
t("Bash 精确匹配(空白归一)", () => {
  assert.equal(ruleAllows(["Bash(git status)"], "Bash", bash("git  status ")), "Bash(git status)");
  assert.equal(ruleAllows(["Bash(git status)"], "Bash", bash("git status -s")), undefined);
});
t("Bash 空格-星前缀", () => {
  const rules = ["Bash(git log *)"];
  assert.ok(ruleAllows(rules, "Bash", bash("git log --oneline -5")));
  assert.ok(ruleAllows(rules, "Bash", bash("git log")));
  assert.equal(ruleAllows(rules, "Bash", bash("git logs")), undefined);
  assert.equal(ruleAllows(rules, "Bash", bash("git push")), undefined);
});
t("Bash 冒号-星前缀", () => {
  assert.ok(ruleAllows(["Bash(npm run test:*)"], "Bash", bash("npm run test -- --watch")));
});
t("Bash 星号紧贴路径的前缀", () => {
  const rules = ["Bash(python3 .claude/skills/*)"];
  assert.ok(ruleAllows(rules, "Bash", bash("python3 .claude/skills/release-doc/scripts/gen_mr_list.py --sprint 91")));
  assert.equal(ruleAllows(rules, "Bash", bash("python3 evil.py")), undefined);
});

// ── Bash: 复合命令与安全语义 ────────────────────────────────────────────
t("复合命令逐段校验: 全命中才放行", () => {
  const rules = ["Bash(date *)", "Bash(cd *)", "Bash(python3 .claude/skills/*)"];
  assert.ok(ruleAllows(rules, "Bash", bash(
    'date "+%Y%m%d%H%M"; cd /Users/x/qm-brain && python3 .claude/skills/release-doc/scripts/gen_mr_list.py --sprint 91',
  )));
});
t("复合命令有一段不命中即整体拒绝(防搭便车)", () => {
  const rules = ["Bash(python3 .claude/skills/*)"];
  assert.equal(ruleAllows(rules, "Bash", bash("python3 .claude/skills/a/b.py && rm -rf /tmp/x")), undefined);
});
t("管道下游同样逐段校验", () => {
  assert.ok(ruleAllows(["Bash(cat *)", "Bash(grep *)"], "Bash", bash("cat a.log | grep ERROR")));
  assert.equal(ruleAllows(["Bash(cat *)"], "Bash", bash("cat a.sh | bash")), undefined);
});
t("段首环境变量前缀剥掉后匹配", () => {
  assert.ok(ruleAllows(["Bash(python3 .claude/skills/*)"], "Bash", bash(
    "timeout=60 python3 .claude/skills/release-doc/scripts/get_jenkins_images.py --service x",
  )));
});
t("命令替换一律不命中", () => {
  assert.equal(ruleAllows(["Bash(echo *)"], "Bash", bash("echo $(whoami)")), undefined);
  assert.equal(ruleAllows(["Bash(echo *)"], "Bash", bash("echo `id`")), undefined);
});
t("裸 Bash 规则放行一切(与 Claude 语义对齐)", () => {
  assert.ok(ruleAllows(["Bash"], "Bash", bash("anything at all")));
});
t("空规则/空命令不放行", () => {
  assert.equal(ruleAllows([], "Bash", bash("ls")), undefined);
  assert.equal(ruleAllows(["Bash(ls *)"], "Bash", bash("  ")), undefined);
  assert.equal(ruleAllows(["Bash(ls *)"], "Bash", {}), undefined);
});

// ── ruleMatchesAny (deny/ask 语义: 任一段命中) ──────────────────────────
t("deny/ask: 复合命令任一段命中即命中", () => {
  assert.equal(ruleMatchesAny(["Bash(rm *)"], "Bash", bash("cd /tmp && rm -rf x")), "Bash(rm *)");
  assert.equal(ruleMatchesAny(["Bash(rm *)"], "Bash", bash("cd /tmp && ls")), undefined);
});
t("deny/ask: 含 $() 的段仍按字面参与匹配", () => {
  assert.equal(ruleMatchesAny(["Bash(rm *)"], "Bash", bash("rm -rf $(pwd)/x")), "Bash(rm *)");
});
t("deny/ask: 非 Bash 工具与 mcp server 级匹配", () => {
  assert.equal(ruleMatchesAny(["Write"], "Write", {}), "Write");
  assert.equal(ruleMatchesAny(["mcp__wecom-mcp"], "mcp__wecom-mcp__send_message", {}), "mcp__wecom-mcp");
});
t("deny/ask: 对交互卡工具无硬保护(收紧方向 fail-closed)", () => {
  assert.equal(ruleMatchesAny(["AskUserQuestion"], "AskUserQuestion", {}), "AskUserQuestion");
});

// ── alwaysAllowRulesFor (「✅总是」规则生成) ─────────────────────────────
t("总是: Bash 取命令+子命令做前缀规则", () => {
  assert.deepEqual(alwaysAllowRulesFor("Bash", bash("git log --oneline -5")), ["Bash(git log *)"]);
});
t("总是: 第二个 token 是 flag 时退化为单命令", () => {
  assert.deepEqual(alwaysAllowRulesFor("Bash", bash("ls -la /tmp")), ["Bash(ls *)"]);
});
t("总是: 路径型第二 token 保留(精确到脚本)", () => {
  assert.deepEqual(
    alwaysAllowRulesFor("Bash", bash("python3 .claude/skills/x/run.py --a b")),
    ["Bash(python3 .claude/skills/x/run.py *)"],
  );
});
t("总是: 复合命令逐段生成并去重", () => {
  assert.deepEqual(
    alwaysAllowRulesFor("Bash", bash("cd /a && python3 x.py | head -3")),
    ["Bash(cd /a *)", "Bash(python3 x.py *)", "Bash(head *)"],
  );
});
t("总是: 段首环境变量前缀剥掉后生成", () => {
  assert.deepEqual(alwaysAllowRulesFor("Bash", bash("timeout=60 python3 x.py")), ["Bash(python3 x.py *)"]);
});
t("总是: 含 $()/反引号不生成(返回空)", () => {
  assert.deepEqual(alwaysAllowRulesFor("Bash", bash("echo $(whoami)")), []);
});
t("总是: 引号内管道符不再误切, 正确生成规则(引号感知升级)", () => {
  assert.deepEqual(
    alwaysAllowRulesFor("Bash", bash('grep -h -iE "proxy|7890|1087" ~/.zshrc | head -8')),
    ["Bash(grep *)", "Bash(head *)"],
  );
});
t("总是: 引号未闭合不生成", () => {
  assert.deepEqual(alwaysAllowRulesFor("Bash", bash('grep "unclosed pattern file.txt')), []);
});
t("匹配: 反斜杠转义的管道/分号不作段分隔(grep 交替、find \\;)", () => {
  assert.equal(
    ruleAllows(["Bash(grep *)", "Bash(cd *)"], "Bash", bash('cd /tmp && grep -n "tidb-ro\\|qm-ro" cfg.py')),
    "Bash(cd *) + Bash(grep *)",
  );
  // 未转义的管道仍然切段
  assert.equal(ruleAllows(["Bash(grep *)"], "Bash", bash("grep a f | bash")), undefined);
});
t("总是: 转义管道的 grep 交替模式可生成规则(实战回归)", () => {
  assert.deepEqual(
    alwaysAllowRulesFor("Bash", bash('cd /tmp/x && grep -n "def foo\\|def bar" main.py')),
    ["Bash(cd /tmp/x *)", "Bash(grep *)"],
  );
});
t("总是: 引号配对的正常管道命令不受影响", () => {
  assert.deepEqual(
    alwaysAllowRulesFor("Bash", bash('grep "ERROR" app.log | head -3')),
    ["Bash(grep *)", "Bash(head *)"],
  );
});
t("总是: 非 Bash 工具生成裸工具名", () => {
  assert.deepEqual(alwaysAllowRulesFor("Write", {}), ["Write"]);
  assert.deepEqual(alwaysAllowRulesFor("mcp__jira__get_issue", {}), ["mcp__jira__get_issue"]);
});
t("总是: 交互卡工具不生成", () => {
  assert.deepEqual(alwaysAllowRulesFor("AskUserQuestion", {}), []);
});
t("总是: 生成的规则能匹配原命令(闭环)", () => {
  const cmd = 'date "+%Y%m%d"; cd /a && timeout=60 python3 .claude/skills/x/run.py --b';
  const rules = alwaysAllowRulesFor("Bash", bash(cmd));
  assert.ok(ruleAllows(rules, "Bash", bash(cmd)), `generated rules should allow original: ${rules.join(", ")}`);
});

// ── 引号感知分段 ────────────────────────────────────────────────────────
t("引号感知: 单引号内的管道不切段(rg 交替实战回归)", () => {
  assert.equal(
    ruleAllows(["Bash(rg *)"], "Bash", bash("rg -il 'commons-processor|cournot|flywheel' /tmp")),
    "Bash(rg *)",
  );
});
t("引号感知: 双引号内的换行与管道不切段(ontology ask 长文实战回归)", () => {
  const cmd = '~/.claude/skills/ontology/ontology ask "第一行\n第二行|带管道; 带分号"';
  assert.equal(
    ruleAllows(["Bash(~/.claude/skills/ontology/ontology ask *)"], "Bash", bash(cmd)),
    "Bash(~/.claude/skills/ontology/ontology ask *)",
  );
});
t("引号感知: python3 -c 整体成单段(正确地卡, 而非切碎地卡)", () => {
  assert.equal(ruleAllows(["Bash(cd *)"], "Bash", bash('cd /tmp && python3 -c "import os\nprint(1)"')), undefined);
});
t("引号感知: 引号外的分隔符照常切段", () => {
  assert.equal(ruleAllows(["Bash(cat *)"], "Bash", bash("cat 'a|b.txt' | bash")), undefined);
  assert.ok(ruleAllows(["Bash(cat *)", "Bash(head *)"], "Bash", bash("cat 'a|b.txt' | head")));
});

// ── fd 重定向的 & ───────────────────────────────────────────────────────
// `2>&1` 的 & 曾被当成后台执行符 → 整条命令放弃分段 → 明明被规则覆盖也发卡,
// 且点「总是」永远存不下规则 (实战回归: ls -la ~/Code/... 2>&1 | head -40)。
t("fd 重定向: 2>&1 不阻断分段(实战回归)", () => {
  assert.deepEqual(
    splitSegments("ls -la ~/Code/x 2>&1 | head -40"),
    ["ls -la ~/Code/x 2>&1", "head -40"],
  );
  assert.ok(ruleAllows(["Bash(ls *)", "Bash(head *)"], "Bash", bash("ls -la ~/Code/x 2>&1 | head -40")));
});
t("fd 重定向: >&2 / &>file / &>>file / 2>&- 各形态均不阻断分段", () => {
  assert.ok(ruleAllows(["Bash(echo *)"], "Bash", bash("echo boom >&2")));
  assert.ok(ruleAllows(["Bash(npm run *)"], "Bash", bash("npm run build &>/tmp/b.log")));
  assert.ok(ruleAllows(["Bash(npm run *)"], "Bash", bash("npm run build &>>/tmp/b.log")));
  assert.ok(ruleAllows(["Bash(ls *)"], "Bash", bash("ls -la 2>&-")));
});
t("fd 重定向: 真正孤立的 & (后台执行) 仍保守拒绝", () => {
  assert.equal(splitSegments("npm run dev &"), undefined);
  assert.equal(splitSegments("sleep 60 & echo done"), undefined);
  assert.equal(ruleAllows(["Bash(sleep *)", "Bash(echo *)"], "Bash", bash("sleep 60 & echo done")), undefined);
});
t("fd 重定向: 带重定向的命令点「总是」能生成规则", () => {
  assert.deepEqual(alwaysAllowRulesFor("Bash", bash("kubectl get pods 2>&1 | head -20")), [
    "Bash(kubectl get *)",
    "Bash(head *)",
  ]);
  assert.deepEqual(alwaysAllowRulesFor("Bash", bash("npm run dev &")), []);
});

// ── 纯变量赋值段 ────────────────────────────────────────────────────────
// `f=a.jsonl` 这种整段都是赋值的段曾被判为"未覆盖段" → 整条命令发卡, 且点「总是」
// 一条规则都存不下 (实战回归: f=a.jsonl; cat $f 命中不了 Bash(cat *))。
t("纯赋值段: 不阻断放行(实战回归)", () => {
  assert.equal(ruleAllows(["Bash(cat *)"], "Bash", bash("f=a.jsonl; cat $f")), "Bash(cat *)");
  assert.ok(ruleAllows(["Bash(cat *)", "Bash(head *)"], "Bash", bash("f=a.jsonl; cat $f | head -3")));
  assert.ok(ruleAllows(["Bash(cd *)", "Bash(cat *)"], "Bash", bash("cd /tmp && f=a.jsonl; cat $f")));
  assert.ok(ruleAllows(["Bash(cat *)"], "Bash", bash("A=1 B=2; cat a.txt")));
});
t("纯赋值段: 点「总是」能生成规则且闭环", () => {
  assert.deepEqual(alwaysAllowRulesFor("Bash", bash("f=a.jsonl; cat $f")), ["Bash(cat *)"]);
  assert.deepEqual(alwaysAllowRulesFor("Bash", bash("cd /tmp && f=x; cat $f")), ["Bash(cd /tmp *)", "Bash(cat *)"]);
  const cmd = "f=a.jsonl; cat $f | head -3";
  const rules = alwaysAllowRulesFor("Bash", bash(cmd));
  assert.ok(ruleAllows(rules, "Bash", bash(cmd)), `generated rules should allow original: ${rules.join(", ")}`);
});
t("纯赋值段: 赋值里的命令替换仍不放行", () => {
  assert.equal(ruleAllows(["Bash(cat *)"], "Bash", bash("f=$(evil); cat $f")), undefined);
  assert.deepEqual(alwaysAllowRulesFor("Bash", bash("f=$(evil); cat $f")), []);
});
t("纯赋值段: 真正的空段仍保守拒绝(不被放宽)", () => {
  assert.equal(ruleAllows(["Bash(a *)", "Bash(b *)"], "Bash", bash("a && && b")), undefined);
  assert.deepEqual(alwaysAllowRulesFor("Bash", bash("a && && b")), []);
});
t("纯赋值段: 通篇只有赋值时不作放行凭据", () => {
  assert.equal(ruleAllows(["Bash(cat *)"], "Bash", bash("f=a.jsonl")), undefined);
  assert.deepEqual(alwaysAllowRulesFor("Bash", bash("f=a.jsonl")), []);
});

// ── heredoc 剥离 ────────────────────────────────────────────────────────
t("heredoc: 带引号 heredoc 正文不参与匹配(写报告场景)", () => {
  const cmd = "cat > /tmp/report.txt <<'EOF'\nh2. 标题 | 内容; rm -rf x\n$(fake)\nEOF";
  assert.equal(ruleAllows(["Bash(cat *)"], "Bash", bash(cmd)), "Bash(cat *)");
});
t("heredoc: 未加引号的 heredoc 正文会展开, 不可剥离(保守发卡)", () => {
  const cmd = "cat > /tmp/x <<EOF\n$(rm -rf /tmp/y)\nEOF";
  assert.equal(ruleAllows(["Bash(cat *)"], "Bash", bash(cmd)), undefined);
});
t("heredoc: deny 扫描对不可剥离的 heredoc 按原文扫(fail-closed)", () => {
  const cmd = "cat > /tmp/x <<EOF\ndd if=/dev/zero\nEOF";
  assert.equal(ruleMatchesAny(["Bash(dd *)"], "Bash", bash(cmd)), "Bash(dd *)");
});
t("heredoc: 总是可对带引号 heredoc 命令生成规则", () => {
  const cmd = "cat > /tmp/x.txt <<'EOF'\n任意正文 | 含分隔符\nEOF";
  assert.deepEqual(alwaysAllowRulesFor("Bash", bash(cmd)), ["Bash(cat *)"]);
});

// ── 生成护栏: 解释器与覆盖过滤 ──────────────────────────────────────────
t("总是: 解释器头部拿不到脚本路径时整体放弃(不生成 Bash(python3 *))", () => {
  assert.deepEqual(alwaysAllowRulesFor("Bash", bash("python3 - <<'PYEOF'\nprint(1)\nPYEOF")), []);
  assert.deepEqual(alwaysAllowRulesFor("Bash", bash("bash -c ls")), []);
});
t("总是: 解释器带脚本路径仍正常生成", () => {
  assert.deepEqual(alwaysAllowRulesFor("Bash", bash("python3 tools/gen.py --x")), ["Bash(python3 tools/gen.py *)"]);
});
t("总是: 已被现有规则覆盖的段不再生成冗余规则", () => {
  assert.deepEqual(
    alwaysAllowRulesFor("Bash", bash("cd service && npx tsc --noEmit && echo TS_OK"),
      ["Bash(cd *)", "Bash(echo *)"]),
    ["Bash(npx tsc *)"],
  );
});

// ── mapClaudePermissions (Claude settings.json 导入映射) ────────────────
t("导入: 三层各自映射且保序去重", () => {
  const m = mapClaudePermissions({
    allow: ["Read", "Bash(git log *)", "mcp__jira", "Read"],
    ask: ["Bash(rm *)", "Bash(sudo *)"],
    deny: ["Bash(dd *)"],
  });
  assert.deepEqual(m.allow, ["Read", "Bash(git log *)", "mcp__jira"]);
  assert.deepEqual(m.ask, ["Bash(rm *)", "Bash(sudo *)"]);
  assert.deepEqual(m.deny, ["Bash(dd *)"]);
  assert.deepEqual(m.skipped, []);
});
t("导入: 引擎不支持的 specifier 跳过并汇报", () => {
  const m = mapClaudePermissions({ allow: ["WebFetch(domain:github.com)", "Read(/etc/*)", "Glob"] });
  assert.deepEqual(m.allow, ["Glob"]);
  assert.deepEqual(m.skipped, ["WebFetch(domain:github.com)", "Read(/etc/*)"]);
});
t("导入: allow 侧交互卡工具跳过, ask/deny 侧不受限", () => {
  const m = mapClaudePermissions({ allow: ["AskUserQuestion"], ask: ["AskUserQuestion"] });
  assert.deepEqual(m.allow, []);
  assert.deepEqual(m.ask, ["AskUserQuestion"]);
  assert.deepEqual(m.skipped, ["AskUserQuestion"]);
});
t("导入: 非法/空/非数组输入安全兜底", () => {
  const m = mapClaudePermissions({ allow: "Read" as unknown, ask: [42, "", "  "] as unknown, deny: undefined });
  assert.deepEqual(m.allow, []);
  assert.deepEqual(m.ask, []);
  assert.deepEqual(m.deny, []);
});

// ── wezard MCP 内置豁免 (判定层短路, 不依赖规则) ───────────────────────
t("wezard 工具直连内置豁免: 零规则/无关规则下都放行 (两种命名形态)", () => {
  assert.equal(ruleAllows([], "mcp__wezard__tell_peer", {}), WEZARD_MCP_BUILTIN);
  assert.equal(ruleAllows(["Read"], "mcp_wezard.delegate", {}), WEZARD_MCP_BUILTIN);
});
t("只豁免 wezard 这一个 server: 撞名前缀不沾光", () => {
  assert.equal(ruleAllows(["Read"], "mcp__wezard2__x", {}), undefined);
  assert.equal(ruleAllows(["Read"], "mcp__wezardfoo__x", {}), undefined);
  assert.equal(ruleAllows(["Read"], "mcp_wezard_extra.y", {}), undefined);
  assert.equal(ruleAllows(["Read"], "mcp_wezard2.y", {}), undefined);
});
t("其它 MCP server 仍走规则, 不受 wezard 豁免影响", () => {
  assert.equal(ruleAllows(["mcp__wezard"], "mcp__jira__get_issue", {}), undefined);
  assert.equal(ruleAllows(["mcp__jira"], "mcp__jira__get_issue", {}), "mcp__jira");
});
t("server 级规则在场时直连仍记内置豁免 (默认规则只是兜底可见性)", () => {
  assert.equal(ruleAllows(["mcp__wezard"], "mcp__wezard__notify", {}), WEZARD_MCP_BUILTIN);
});
t("deny/ask 规则对 wezard 依然优先 (ruleMatchesAny 不吃内置豁免)", () => {
  assert.equal(ruleMatchesAny(["mcp__wezard__tell_peer"], "mcp__wezard__tell_peer", {}), "mcp__wezard__tell_peer");
  assert.equal(ruleMatchesAny(["mcp__wezard"], "mcp__wezard__notify", {}), "mcp__wezard");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
