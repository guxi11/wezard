import assert from "node:assert/strict";
import { renderCharter, type CharterArgs } from "../daemon/wizard.js";

const base: CharterArgs = {
  self: { name: "worker", address: "worker", description: "test role", cwd: "/workspace" },
  chat: "team", principal: "user:admin", inherited: false, cwdUnconfirmed: false,
  siblings: [], memory: [], chatMemory: "", workspaceMemory: "", steward: false,
  stewardBudget: 4, lead: false, tiers: [], topOnly: false,
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
const lead = renderCharter({ ...base, lead: true });
assert.ok(!hasHeading(charter, "## 我是这件活的 lead"));
assert.ok(hasHeading(lead, "## 我是这件活的 lead"));
assert.ok(!hasHeading(lead, "## 我是这个群的管家 (L1)"));
assert.ok(!hasHeading(lead, "## 本群开着顶层模式"));
const renamed = renderCharter({ ...base, self: { ...base.self, address: "renamed" } });
assert.ok(renamed.includes("**`.renamed`**"));
assert.ok(!renamed.includes("**`.worker`**"));

console.log("Charter structure and conditional guidance passed");
