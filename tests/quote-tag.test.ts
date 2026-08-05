// 单元测试: shared/session-label.ts 的 tagsInQuote — 运行: npx tsx tests/quote-tag.test.ts
//
// 「引用继承 tag」的判据层。要点是它**故意**比 inbound 的 TAG_RE 松, 因为它要认
// 两种不同来源的引用文本 (wezard 自己带反引号的 tag 头 / 用户手打的 `#tag 问题`),
// 而企微对引用气泡的 markdown 处理不稳定 —— 有时保留反引号有时剥掉。松带来的
// 误报由调用方的"只认已存在会话"过滤兜住, 所以这里既钉住"该认的都认得出", 也钉住
// "URL fragment 这类明显不是 tag 的不许认"。
import assert from "node:assert";
import { tagsInQuote } from "../shared/session-label.js";

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

// ── wezard 自己的回复: withTagHeader 写的是 "🦊 `#tag`" + 空行 + 正文 ──────
t("bot 头部 (反引号原样保留)", () => {
  assert.deepEqual(tagsInQuote("🦊 `#工作总结`\n\n今天的进展如下"), ["工作总结"]);
});

t("bot 头部 (企微剥掉了反引号)", () => {
  assert.deepEqual(tagsInQuote("🦊 #工作总结\n\n今天的进展如下"), ["工作总结"]);
});

t("bot 头部 (引用气泡把换行压成空格)", () => {
  assert.deepEqual(tagsInQuote("🦊 #工作总结 今天的进展如下"), ["工作总结"]);
});

t("bot 头部带分片序号: `2/5` 不干扰", () => {
  assert.deepEqual(tagsInQuote("🐬 `#长赢自动跟车优化` `2/5`\n\n正文"), ["长赢自动跟车优化"]);
});

// ── 用户自己发过的问题 ────────────────────────────────────────────────
t("用户消息: #tag 开头", () => {
  assert.deepEqual(tagsInQuote("#seeker报表收藏 这个需求怎么改"), ["seeker报表收藏"]);
});

t("用户消息: tag 在句中", () => {
  assert.deepEqual(tagsInQuote("帮我看下 #QMRD46651 的进度"), ["QMRD46651"]);
});

t("tag 允许下划线与连字符, 数字纯 tag 也算", () => {
  assert.deepEqual(tagsInQuote("#a_b-c 和 #123"), ["a_b-c", "123"]);
});

// ── 多候选: 保序 + 去重 (调用方按顺序取第一个已存在的会话) ──────────────
t("多个候选按出现顺序返回", () => {
  assert.deepEqual(tagsInQuote("🦊 #会话A\n\n引用了 #会话B 的说法"), ["会话A", "会话B"]);
});

t("重复的 tag 只留一个", () => {
  assert.deepEqual(tagsInQuote("#dup 前 #dup 后"), ["dup"]);
});

// ── 不该被当成 tag 的 ─────────────────────────────────────────────────
t("URL fragment 不是 tag (# 前面不是空白/反引号)", () => {
  assert.deepEqual(tagsInQuote("见 https://git.example.com/a/b.ts#L45 这一行"), []);
});

t("路径里的 anchor 不是 tag", () => {
  assert.deepEqual(tagsInQuote("docs/readme.md#安装"), []);
});

t("光秃秃的 # 不是 tag", () => {
  assert.deepEqual(tagsInQuote("# 标题\n正文"), []);
});

t("超过 32 字符不算 tag", () => {
  assert.deepEqual(tagsInQuote(`#${"a".repeat(33)}`), []);
});

t("空串 / 无 tag 文本 → 空数组", () => {
  assert.deepEqual(tagsInQuote(""), []);
  assert.deepEqual(tagsInQuote("就是一句普通的话"), []);
});

// ── 已知的宽松误报: 必须靠"只认已存在会话"过滤挡住 ──────────────────────
// 这条不是缺陷而是分工声明 —— 判据层认得出它, 路由层不采信它。改判据前先想清楚
// 谁来挡: 未知 target 会让 gate 自动 spawn 一个新会话 + 新 pane。
t("代码块里的 #include 会被判据层认出 (故意的, 由白名单过滤)", () => {
  assert.deepEqual(tagsInQuote("#include <stdio.h>"), ["include"]);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
