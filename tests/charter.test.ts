import assert from "node:assert/strict";
import { renderCharter, type CharterArgs } from "../daemon/wizard.js";

const base: CharterArgs = {
  self: { name: "worker", address: "worker", description: "test role", cwd: "/workspace" },
  chat: "team", principal: "user:admin", inherited: false,
  siblings: [], memory: [], chatMemory: "", workspaceMemory: "", steward: false,
  stewardBudget: 4, lead: false, tiers: [], topOnly: false, speech: "implicit",
};

const hasHeading = (text: string, heading: string) => text.split("\n").includes(heading);
const chapter = (text: string, heading: string) => {
  const start = text.indexOf(heading);
  assert.notEqual(start, -1, `missing chapter ${heading}`);
  const next = text.indexOf("\n## ", start + heading.length);
  return text.slice(start, next < 0 ? undefined : next);
};
const charter = renderCharter(base);
assert.match(charter, /worker/);
assert.match(charter, /user:admin/);
assert.match(charter, /\/workspace/);
// v3 §2 切片二: 「开工前先问工作区」问句随 set_workspace 语义退役, 宪章不再出现旧流程话术。
for (const stale of ["开工前先问", "默认兜底目录", "keep:true"]) {
  assert.ok(!charter.includes(stale), `charter must not mention retired workspace-question flow: ${stale}`);
}
for (const tool of ["wizard_roster", "delegate", "tell_peer", "handoff"]) {
  assert.ok(charter.includes(tool), `charter must advertise ${tool}`);
}
for (const marker of ["RESULT:", "NEED:", "ARTIFACT:"]) assert.ok(charter.includes(marker));

const codingChapter = chapter(charter, "## 怎么干活: 编排");
assert.ok(codingChapter.includes("**Coding 默认编排**"));
for (const fragment of ["范围清楚、低风险", "默认用 light", 'tier:"light"', "不递归派 coder"])
  assert.ok(codingChapter.includes(fragment), `coding light-default contract must include ${fragment}`);

for (const [stewardEnabled, topOnlyEnabled] of [[false, false], [false, true], [true, false], [true, true]]) {
  const rendered = renderCharter({ ...base, steward: stewardEnabled, topOnly: topOnlyEnabled });
  assert.equal(hasHeading(rendered, "## 我是这个群的管家 (L1)"), stewardEnabled && topOnlyEnabled);
  assert.equal(hasHeading(rendered, "## 本群开着顶层模式"), topOnlyEnabled);
}
const topOnly = renderCharter({ ...base, topOnly: true });
const topOnlyChapter = chapter(topOnly, "## 本群开着顶层模式");
for (const fragment of ["长等待、阻塞", "完成 fyi", "原群 `notify`", "仍 pending", "本身不代表 ledger done", "普通私聊 fyi 不授权对人通知"])
  assert.ok(topOnlyChapter.includes(fragment), `top-only completion notice contract must include ${fragment}`);
const orchestration = chapter(topOnly, "## 怎么干活: 编排");
for (const fragment of ["不提前合并或宣告完成", "必须 `notify` 原群"])
  assert.ok(orchestration.includes(fragment), `top-only orchestration contract must include ${fragment}`);
// P7-S2 严格模式宪章: speech=strict 时 renderStrictChat 替换顶层模式那一节。
const strict = renderCharter({ ...base, topOnly: true, speech: "strict" });
assert.ok(hasHeading(strict, "## 本群开着严格模式"), "strict 群带严格模式节");
assert.ok(!hasHeading(strict, "## 本群开着顶层模式"), "strict 群不带顶层模式节 (被替换)");
for (const fragment of ["chat_reply", "chat_say", "chat_ask", "义务不随终句自动关账", "/owed", "每轮 ≤3"])
  assert.ok(strict.includes(fragment), `strict charter must include ${fragment}`);
assert.equal(hasHeading(renderCharter({ ...base, steward: true, speech: "strict", topOnly: false }), "## 我是这个群的管家 (L1)"),
  true, "手闸条件 topOnly || strict: strict 群的管家也带管家章");
assert.equal(hasHeading(renderCharter({ ...base, speech: "implicit", topOnly: true }), "## 本群开着顶层模式"),
  true, "implicit 群照旧顶层模式节");

const lead = renderCharter({ ...base, lead: true });
assert.ok(!hasHeading(charter, "## 我是这件活的 lead"));
assert.ok(hasHeading(lead, "## 我是这件活的 lead"));
assert.ok(!hasHeading(lead, "## 我是这个群的管家 (L1)"));
assert.ok(!hasHeading(lead, "## 本群开着顶层模式"));
const renamed = renderCharter({ ...base, self: { ...base.self, address: "renamed" } });
// v3 面 × 表示 (设计稿 §1.5): charter 是系统面 —— 名字行是裸 name, 无点无记号;
// 人点名的写法 (`.name`) 与人面气泡头 (🧙‍♂️) 在名字行里只作说明文字出现。
assert.ok(renamed.includes("**`renamed`**"));
assert.ok(!renamed.includes("**`.renamed`**"));
assert.ok(!renamed.includes("🧙‍♂️ renamed"));
assert.ok(renamed.includes("人点你写作 `.name`"));

console.log("Charter structure and conditional guidance passed");
