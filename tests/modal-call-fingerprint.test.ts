// 单元测试: modalCallFingerprint (代按前后的按调用指纹) — 运行: npx tsx tests/modal-call-fingerprint.test.ts
// 背景: modalFingerprint 比整屏, 框外实时进度行 ("running 3m ago") 一跳就判
// 「确认框已变更」→ 人在卡上点 ✅ 静默失败 + 反复重发卡。这里守住四条边界:
// 同一调用 + 框外噪声变化 → 允许; 参数不同 → 拒; 认不出 → 拒; 框消失 → 拒。
import assert from "node:assert/strict";
import { modalCallFingerprint, isModalPane } from "../shared/modal-pane.js";

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

const RULE = "─".repeat(80);

// CodeBuddy hook-ask 回退 picker 形态 (complete:false, 命令小节与问题行之间隔
// 一条分隔线) + 框外底部实时进度行 —— 即线上「set -e」三连卡那次现场。
const noisyPicker = (command: string, ago: string): string => `
∴ Thought
● Bash(${command})
${RULE}
 Bash command
   ${command}
${RULE}
 Hook PreToolUse: Bash requires confirmation:
 ❯ 1. Yes
   2. Yes, and don't ask again for session (shift + tab)
   3. No, and tell CodeBuddy what to do differently (escape)

 ● running ${ago}`;

// CodeBuddy 子代理 DeferExecuteTool 形态 (complete:true, 结构化参数) + 进度行。
const boxedPicker = (command: string, ago: string): string => `
╭──────────────────────────────────────────╮
│ Confirm · @worker                        │
│ toolName: "Bash"                        │
│ params: ${JSON.stringify({ command })}   │
│ Would you like to proceed?               │
│ ❯ 1. Yes                                 │
│   2. Yes, and don't ask again             │
│   3. No                                  │
╰──────────────────────────────────────────╯
 ● running ${ago}`;

// Claude .claude/** 编辑确认形态 (complete:false, 调用身份在 diff 里)。
const editConfirm = (line: string, spinner: string): string => `
✻ Cultivating… (${spinner} · ↓ 14.6k tokens)
${RULE}
 Edit file
 .claude/skills/fix-bug/SKILL.md
╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌
 158 +| ${line} |
╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌
 Do you want to make this edit to SKILL.md?
 ❯ 1. Yes
   2. Yes, and allow Claude to edit its own settings for this session
   3. No

 Esc to cancel · Tab to amend`;

// ── 允许代按: 同一调用, 框外噪声怎么变都行 ─────────────────────────────
t("同一调用 + 框外底部进度行变化 → 指纹不变 (hook-ask 形态)", () => {
  assert.ok(isModalPane(noisyPicker("npm test", "3m ago")).modal);
  const a = modalCallFingerprint(noisyPicker("npm test", "3m ago"));
  const b = modalCallFingerprint(noisyPicker("npm test", "5m ago"));
  assert.ok(a !== undefined);
  assert.equal(a, b);
});

t("同一调用 + 框外底部进度行变化 → 指纹不变 (结构化形态)", () => {
  const a = modalCallFingerprint(boxedPicker("git status", "3m ago"));
  const b = modalCallFingerprint(boxedPicker("git status", "5m ago"));
  assert.ok(a !== undefined);
  assert.equal(a, b);
});

t("同一调用 + 框上方 spinner 计时变化 → 指纹不变", () => {
  const a = modalCallFingerprint(editConfirm("字段约定缺失", "6m 22s"));
  const b = modalCallFingerprint(editConfirm("字段约定缺失", "8m 01s"));
  assert.ok(a !== undefined);
  assert.equal(a, b);
});

t("同一调用 + 框上方 agent 输出变化 → 指纹不变", () => {
  const withThought = (thought: string) => noisyPicker("npm test", "3m ago").replace("∴ Thought", `∴ ${thought}`);
  const a = modalCallFingerprint(withThought("Thought"));
  const b = modalCallFingerprint(withThought("Rethinking"));
  assert.ok(a !== undefined);
  assert.equal(a, b);
});

t("同一调用 + 满宽分隔线随 pane 宽度重排 → 指纹不变", () => {
  const narrow = noisyPicker("npm test", "3m ago").split(RULE).join("─".repeat(60));
  assert.equal(modalCallFingerprint(narrow), modalCallFingerprint(noisyPicker("npm test", "3m ago")));
});

t("高亮移动 (❯ 1 → ❯ 3) → 指纹不变", () => {
  const moved = noisyPicker("npm test", "3m ago").replace("❯ 1. Yes", "  1. Yes").replace("  3. No", "❯ 3. No");
  assert.equal(modalCallFingerprint(moved), modalCallFingerprint(noisyPicker("npm test", "3m ago")));
});

// ── 拒绝代按: 换了调用 / 认不出 / 框没了 ────────────────────────────────
t("参数不同 → 指纹变 (hook-ask 形态, 命令在分隔线上方的小节里)", () => {
  const a = modalCallFingerprint(noisyPicker("npm test", "3m ago"));
  const b = modalCallFingerprint(noisyPicker("npm run test", "3m ago"));
  assert.ok(a !== undefined && b !== undefined);
  assert.notEqual(a, b);
});

t("参数不同 → 指纹变 (结构化形态)", () => {
  assert.notEqual(
    modalCallFingerprint(boxedPicker("git status", "3m ago")),
    modalCallFingerprint(boxedPicker("git diff", "3m ago")),
  );
});

t("diff 内容不同 → 指纹变 (编辑确认形态)", () => {
  assert.notEqual(
    modalCallFingerprint(editConfirm("字段约定缺失", "6m 22s")),
    modalCallFingerprint(editConfirm("前端验证失败", "6m 22s")),
  );
});

t("一侧认不出 (确认区只剩问句与选项) → undefined, 判不等 → 拒", () => {
  const generic = `
 Would you like to proceed?
 ❯ 1. Yes
   2. Yes, and don't ask again
   3. No

 Esc to cancel`;
  assert.ok(isModalPane(generic).modal);
  const g = modalCallFingerprint(generic);
  assert.equal(g, undefined);
  const known = modalCallFingerprint(noisyPicker("npm test", "3m ago"));
  assert.ok(known !== undefined && g !== known);
});

t("两侧都认不出 → 均 undefined → 拒 (不因双双认不出而放行)", () => {
  const generic = (q: string) => `
 ${q}
 ❯ 1. Yes
   2. Yes, and don't ask again
   3. No

 Esc to cancel`;
  assert.equal(modalCallFingerprint(generic("Would you like to proceed?")), undefined);
  assert.equal(modalCallFingerprint(generic("Are you sure you want to continue?")), undefined);
});

t("框消失 (空闲输入框) → 无选项 → undefined, isModalPane 亦非 modal", () => {
  const idle = `
  163  任务中断时记录进度，提示可从中断点继续。
  ⎿  1 skill available

✻ Cultivating… (6m 22s · ↓ 14.6k tokens)

${RULE}
❯
${RULE}
  🤖 Opus 5 | 📁 product-engineer | ⚡️ 44.0% · 88.0k tokens   ● high · /effort`;
  assert.equal(isModalPane(idle).modal, false);
  assert.equal(modalCallFingerprint(idle), undefined);
});

t("命令行里的时间词不是计时行: sleep 5m 属于调用本身 → 指纹变", () => {
  assert.notEqual(
    modalCallFingerprint(noisyPicker("sleep 5m", "3m ago")),
    modalCallFingerprint(noisyPicker("sleep 8m", "3m ago")),
  );
});

// ── 真屏回归: CodeBuddy「高危操作逐次确认」框 (2026-10-27 线上现场, pane %2401) ──
// 正文里没有 Confirm 头, 也没有 toolName/params —— complete 恒 false, 而这张卡正是
// 哨兵为「无法完整识别」的框发的。它必须照样有指纹, 否则人点通过永远只换来
// 「代按失败（操作或参数已变更）」, 哨兵还会每拍重发一张同样的卡。
const highRiskPicker = (command: string, desc: string, progress: string): string => `
∴ Thought
● REPL · Run extraction with duplicate corpus
  └ · 6s · 1 command (ctrl+o to expand)
      ✓ Bash  ${command}  48.0s

● REPL · Run extraction again, return raw
  └ ...${progress} → Bash · cd /tmp/dup-demo && cp public/js/testDem…
${RULE}
 Bash command

   ${command}
   ${desc}

${RULE}

 Do you want to proceed(High risk operation detected - requires confirmation every time)?

 > 1. Yes
   2. Yes, and don't ask again for session (shift + tab)
   3. No, and tell CodeBuddy what to do differently (escape)`;

const CMD = 'rm -rf /tmp/dup-demo && cp -R /Users/zyy/develop/Tencent/mail_modules/packages/tools/ww.i18n-cli/test/wwmngxDemo /tmp/dup-demo';

t("真屏高危框: 框外进度行/转录变化 → 指纹不变 (人点通过能真的按下去)", () => {
  assert.ok(isModalPane(highRiskPicker(CMD, "run extract with duplicate corpus", "running 1m ago")).modal);
  const a = modalCallFingerprint(highRiskPicker(CMD, "run extract with duplicate corpus", "running 1m ago"));
  const b = modalCallFingerprint(highRiskPicker(CMD, "run extract with duplicate corpus", "running 3m ago"));
  assert.ok(a !== undefined, "可识别的确认区 → 必须有指纹");
  assert.equal(a, b);
});

t("真屏高危框: 命令差一个字节 / 描述不同 → 指纹变", () => {
  const base = modalCallFingerprint(highRiskPicker(CMD, "run extract with duplicate corpus", "running 1m ago"));
  assert.notEqual(modalCallFingerprint(highRiskPicker(CMD.replace("/tmp/dup-demo", "/tmp/dup-dem0"), "run extract with duplicate corpus", "running 1m ago")), base);
  assert.notEqual(modalCallFingerprint(highRiskPicker(CMD, "run extraction with duplicate corpus", "running 1m ago")), base);
});

t("真屏高危框: 正文缩进/空白变化 → 指纹变 (不归一化)", () => {
  const base = modalCallFingerprint(highRiskPicker(CMD, "run extract with duplicate corpus", "running 1m ago"));
  const indented = highRiskPicker(CMD, "run extract with duplicate corpus", "running 1m ago").replace(`   ${CMD}`, `    ${CMD}`);
  assert.notEqual(modalCallFingerprint(indented), base);
});

t("真屏高危框: heredoc 正文里的空行变化 → 指纹变", () => {
  const heredoc = (body: string) => `${RULE}
 Bash command

   cat > /tmp/a.js <<'EOF'
${body}
   EOF
   write demo file

${RULE}

 Do you want to proceed(High risk operation detected - requires confirmation every time)?

 > 1. Yes
   2. Yes, and don't ask again for session (shift + tab)
   3. No, and tell CodeBuddy what to do differently (escape)`;
  const one = modalCallFingerprint(heredoc("   a();\n   b();"));
  const two = modalCallFingerprint(heredoc("   a();\n\n   b();"));
  assert.ok(one !== undefined && two !== undefined);
  assert.notEqual(one, two);
});

t("真屏高危框: 高亮初始落在放宽项也不影响指纹", () => {
  const moved = highRiskPicker(CMD, "run extract with duplicate corpus", "running 1m ago")
    .replace(" > 1. Yes", "   1. Yes")
    .replace("   2. Yes, and don't ask again", " > 2. Yes, and don't ask again");
  assert.equal(
    modalCallFingerprint(moved),
    modalCallFingerprint(highRiskPicker(CMD, "run extract with duplicate corpus", "running 1m ago")),
  );
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
