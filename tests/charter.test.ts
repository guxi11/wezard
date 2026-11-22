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
for (const stale of ["开工前先问", "默认兜底目录", "keep:true"]) {
  assert.ok(!charter.includes(stale), `charter must not mention retired workspace-question flow: ${stale}`);
}
for (const retired of ["tell_peer", "read_chat", "chat_members", "顶层模式", "严格模式", "RESULT:", "public:true"]) {
  assert.ok(!charter.includes(retired), `charter must not mention retired routing: ${retired}`);
}
for (const tool of ["wizard_roster", "delegate", "chat_ask", "chat_reply", "chat_say", "room_open", "room_read", "room_watch", "handoff"]) {
  assert.ok(charter.includes(tool), `charter must advertise ${tool}`);
}
assert.ok(charter.includes("ARTIFACT:"), "charter must mention ARTIFACT:");
assert.ok(!charter.includes("wait_peer"), "charter must not name the retired wait_peer tool");

const codingChapter = chapter(charter, "## 怎么干活: 编排");
assert.ok(codingChapter.includes("**Coding 默认编排**"));
for (const fragment of ["范围清楚、低风险", "默认用 light", 'tier:"light"', "不递归派 coder"])
  assert.ok(codingChapter.includes(fragment), `coding light-default contract must include ${fragment}`);
for (const fragment of ["多步的活默认开一个跟进 room", "只有需要人和执行者直接对话", "不提前合并或宣告完成", "不守着、不轮询 `peek_peer`"])
  assert.ok(codingChapter.includes(fragment), `orchestration contract must include ${fragment}`);

const roomChapter = chapter(charter, "## room 是唯一的沟通对象");
for (const fragment of ["终句没有任何路由语义", "完成只认 chat_reply 的 status", "被唤醒就要交代", "绑定 room 里每条消息都进企微", "不需要实时就别订阅"])
  assert.ok(roomChapter.includes(fragment), `room contract must include ${fragment}`);

for (const steward of [false, true]) {
  const rendered = renderCharter({ ...base, steward, topOnly: true, speech: "strict" });
  assert.equal(hasHeading(rendered, "## 我是这个 room 的 host (L1)"), steward);
  assert.ok(!hasHeading(rendered, "## 本群开着顶层模式"), "顶层模式节退役");
  assert.ok(!hasHeading(rendered, "## 本群开着严格模式"), "严格模式节退役");
}
const stewardChapter = chapter(renderCharter({ ...base, steward: true }), "## 我是这个 room 的 host (L1)");
for (const fragment of ["分派、收回执、向人交代", "chat_ask", "chat_reply", "多步的活默认开一个跟进 room", "delegate"])
  assert.ok(stewardChapter.includes(fragment), `host contract must include ${fragment}`);

const lead = renderCharter({ ...base, lead: true });
assert.ok(!hasHeading(charter, "## 我是这件活的 lead"));
assert.ok(hasHeading(lead, "## 我是这件活的 lead"));
assert.ok(!hasHeading(lead, "## 我是这个 room 的 host (L1)"));
const leadChapter = chapter(lead, "## 我是这件活的 lead");
for (const fragment of ["chat_reply", "chat_ask", "status"])
  assert.ok(leadChapter.includes(fragment), `lead contract must include ${fragment}`);
assert.ok(!lead.includes("RESULT:"), "lead 不再用行首 RESULT: 收口");

const renamed = renderCharter({ ...base, self: { ...base.self, address: "renamed" } });
assert.ok(renamed.includes("**`renamed`**"));
assert.ok(!renamed.includes("**`.renamed`**"));
assert.ok(!renamed.includes("🧙‍♂️ renamed"));
assert.ok(renamed.includes("人点你写作 `.name`"));

console.log("Charter structure and conditional guidance passed");
