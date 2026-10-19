import assert from "node:assert/strict";
import { unknownStartupNotice } from "../shared/startup-notice.js";

// 认不出的启动确认框 → 通知正文 + 去重指纹。与 spawn-tmux waitForTuiReady 的
// 「同一 pane 同一形状只发一次」频控契约: fp 是唯一去重依据, 调用方按 fp 相等跳过。
const screen = `\u001b[1m│ Do you want to proceed? \u001b[0m│\n│❯ 1. Yes, enable experimental mode│\n│  2. No│\n`;
const first = unknownStartupNotice({ who: ".fix", pane: "%12", tmuxSession: "wezard", cwd: "/Users/zyy/work", screen });

// 同一屏 (即使 ANSI 序列重复渲染成不同字节串) → 同指纹 → 只发一次
const again = unknownStartupNotice({ who: ".fix", pane: "%12", tmuxSession: "wezard", cwd: "/Users/zyy/work",
  screen: screen.replace("\u001b[1m", "\u001b[0;1m").replace("\u001b[0m", "\u001b[m") });
assert.equal(first.fp, again.fp);
assert.ok(first.fp && !first.fp.includes("\u001b"));

// 形状变了 → 新指纹 → 允许再发
const changed = unknownStartupNotice({ who: ".fix", pane: "%12", tmuxSession: "wezard", cwd: "/Users/zyy/work",
  screen: `${screen}\n  3. Open restricted` });
assert.notEqual(changed.fp, first.fp);

// 收件人可认 + 可行动: 谁、哪个 pane (含 attach 指引)、哪个目录、屏上原文进摘要、
// 明确说不代按任何键、无需点击。
for (const needle of [".fix", "%12", "tmux attach -t wezard", "/Users/zyy/work",
  "Do you want to proceed?", "Yes, enable experimental mode", "不会替你按任何键", "无需点击"]) {
  assert.ok(first.text.includes(needle), needle);
}
// 框线剥除: 摘要行不带 │ 边框
assert.ok(first.text.includes("> Do you want to proceed?"));
assert.ok(!first.text.includes("│"));

console.log("Unknown startup notice text/fingerprint/dedup checks passed");
