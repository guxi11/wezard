import assert from "node:assert/strict";
import { renderCharter, type CharterArgs } from "../daemon/wizard.js";

const base: CharterArgs = {
  self: { name: "worker", address: "worker", description: "test role", cwd: "/workspace" },
  chat: "team", principal: "user:admin", inherited: false,
  siblings: [], memory: [], chatMemory: "", workspaceMemory: "", steward: false,
  stewardBudget: 4, lead: false, tiers: [],
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
  const rendered = renderCharter({ ...base, steward });
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

// ── 默认注册的 MCP 工具必须都在 charter 名册里 (charter 是唯一保证进上下文的发现层) ──
const toolNames = async (): Promise<string[]> => {
  const { createWezardServer } = await import("../mcp/tools.js");
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const server = createWezardServer();
  const client = new Client({ name: "probe", version: "0" }, { capabilities: {} });
  const [t1, t2] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(t1), client.connect(t2)]);
  return (await client.listTools()).tools.map((x) => x.name);
};
// `plan_create/get/list/update` → plan_create plan_get plan_list plan_update
const expandSlashForms = (text: string) =>
  text.replace(/\b([a-z]+_)([a-z]+(?:\/[a-z]+)+)/g, (_m, prefix: string, rest: string) =>
    rest.split("/").map((s) => prefix + s).join(" "));
// 豁免表: 不进 charter 的默认工具, 每项写明理由; 名字若已不在工具清单里, 测试同样失败 (防腐烂)。
const charterExempt: Record<string, string> = {
  // 只给新群引导化身用, 见 daemon/onboarding.ts GUIDE_TOOLS
  onboard_bind: "onboarding guide only",
  // 待办, 不是有意排除: 尚未进 charter, 待下次 charter 攒批时决定
  wecom_doc_list_tools: "TODO: decide at next charter batch",
  wecom_doc_call: "TODO: decide at next charter batch",
};
{
  const registered = await toolNames();
  const advertised = new Set(expandSlashForms(renderCharter(base)).split(/[^A-Za-z0-9_]+/));
  const missing = registered.filter((n) => !advertised.has(n) && !(n in charterExempt));
  assert.deepEqual(missing, [], `default MCP tools missing from charter: ${missing.join(", ")}`);
  const stale = Object.keys(charterExempt).filter((n) => !registered.includes(n));
  assert.deepEqual(stale, [], `charterExempt names no longer registered: ${stale.join(", ")}`);
}

console.log("Charter structure and conditional guidance passed");
