import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { contextFiles, contextMaterials } from "../daemon/peers.js";
import { commonStems, decide, isSmallTask, rankCandidates, renderCandidates, routeReceiptDutiesOf, tierFor, type RouteRow } from "../daemon/route.js";
import type { InFlight } from "../daemon/dispatch.js";

const now = 1_000_000;
const ttlMs = 60_000;
const cwd = "/repo/a";
const row = (patch: Partial<RouteRow> = {}): RouteRow => {
  const r = {
    name: "worker", address: "worker", cwd, description: "路由任务实现", busy: false, alive: true,
    lastActivity: now, contextTokens: 20_000, files: [`${cwd}/daemon/route.ts`],
    asks: ["实现 daemon/route.ts 的自动路由约束"], summary: "已交付路由约束", ...patch,
  };
  return { ...r, materials: patch.materials ?? r.files.map((path) => ({
    path, kind: "read", source: "Read/result", at: now - 100, cwd: r.cwd,
    task: r.asks[0] ?? "", taskAt: now - 200, turn: "task", session: "session", call: "read",
    confirmed: true, truncated: false,
  })) };
};
const candidates = (task: string, rows = [row()], taskCwd = cwd) => rankCandidates(task, taskCwd, rows, { now, ttlMs });
const decision = (task: string, rows = [row()], force = false, tier?: Parameters<typeof decide>[5]) =>
  decide(task, candidates(task, rows), now, ttlMs, force, tier);
const followup = "完善 daemon/route.ts 的路由约束";

// 确认材料与近期任务同对象、空闲且成本合适；独立新活也可复用。
assert.equal(decision(followup).kind, "existing");
for (const task of [
  "刚才做过 daemon/route.ts，这次独立核实同一文件是否存在",
]) {
  assert.equal(decision(task, [row()], true).kind, "spawn", task);
}

for (const task of [
  "独立核实 daemon/route.ts 文件是否存在",
]) assert.equal(decision(task).kind, "existing", task);
assert.equal(decision(followup, [row({ materials: [] })]).kind, "spawn", "files-only 不升级为确认读取");

// 真实供数保留 Bash 相对路径, 应以候选 cwd 解析而非 daemon 的 process.cwd()。
const fixtureDir = mkdtempSync(join(tmpdir(), "router-context-paths-"));
try {
  const fixture = join(fixtureDir, "transcript.jsonl");
  writeFileSync(fixture, JSON.stringify({ type: "assistant", message: { role: "assistant", content: [
    { type: "tool_use", id: "read-route", name: "Bash", input: { command: "cat daemon/route.ts" } },
  ] } }) + "\n");
  const files = contextFiles(fixture);
  assert.deepEqual(files, ["daemon/route.ts"]);
  assert.equal(decision(followup, [row({ files, materials: contextMaterials(fixture) })]).kind, "spawn", "无结果的调用不作强证据");
  assert.equal(decision(followup, [row({ cwd: "/repo/b", files })]).kind, "spawn");
  writeFileSync(fixture, [
    { type: "user", timestamp: new Date(now - 200).toISOString(), cwd, sessionId: "session", message: { role: "user", content: "核查 daemon/route.ts" } },
    { type: "assistant", timestamp: new Date(now - 150).toISOString(), cwd, message: { role: "assistant", content: [{ type: "tool_use", id: "r", name: "Read", input: { file_path: "daemon/route.ts" } }] } },
    { type: "user", timestamp: new Date(now - 100).toISOString(), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "r", content: "source" }] } },
  ].map((r) => JSON.stringify(r)).join("\n") + "\n");
  assert.equal(decision(followup, [row({ files, materials: contextMaterials(fixture) })]).kind, "existing");
} finally { rmSync(fixtureDir, { recursive: true, force: true }); }
assert.equal(decision("核实 daemon/route.ts 文件存在").kind, "existing");
assert.equal(decision("实现路由任务自动约束", [row({ files: [] })]).kind, "spawn");
assert.equal(decision(followup, [row({ asks: ["核实别的文件存在"] })]).kind, "spawn");
assert.equal(decision(followup, [row({ busy: true })], true).kind, "spawn");
assert.equal(decision(followup, [row({ alive: false })], true).kind, "spawn");

// 公共指引在单候选池也固定降权, 不经职责/专长/问话再次升级。
for (const file of ["AGENTS.md", "CLAUDE.md", "README.md", "CONTRIBUTING.md", "CODE_OF_CONDUCT.md", "GEMINI.md", "copilot-instructions.md"]) {
  const task = `继续核实 ${file} 文件存在及加载路径`;
  const rows = [row({ files: [`${cwd}/${file}`], description: file, expertise: file, asks: [task] })];
  const cands = candidates(task, rows);
  assert.equal(cands.length, 1);
  assert.equal(cands[0]!.files.length, 0);
  assert.deepEqual(cands[0]!.desc, []);
  assert.deepEqual(cands[0]!.exp, []);
  assert.equal(decide(task, cands, now, ttlMs, true).kind, "spawn");
  assert.match(renderCandidates(task, cands, now, ttlMs), /降权的公共文件/);
}
for (const task of [
  "确认下项目内有agents.md,并会load claude.md",
  "核实项目是否有 AGENTS.md，以及实际如何加载 CLAUDE.md，并在交付中给出检查路径和依据",
]) {
  assert.equal(isSmallTask(task), true, task);
  assert.equal(tierFor(task, false), "light", task);
  const lead = row({ lead: true, contextTokens: 300_000,
    description: "核实项目检查路径和加载依据", files: [`${cwd}/AGENTS.md`, `${cwd}/CLAUDE.md`], asks: [task] });
  assert.equal(decision(task, [lead], true, "light").kind, "spawn", "实际核查语句不能经公共指引/职责/问话复用 lead");
}
const popular = [row(), row({ name: "second" }), row({ name: "third" })];
assert(commonStems(popular).has(`${cwd}/daemon/route.ts`));
assert.equal(decide(followup, candidates(followup, popular), now, ttlMs, true).kind, "spawn", "统计公共文件也不作强证据");
const guidanceWords = "继续核实 AGENTS.md 文件存在及加载路径";
assert.equal(decision(guidanceWords, [row({ description: guidanceWords, asks: [guidanceWords] })], true).kind, "spawn");

// 同名文件的工作区或目录不一致不能证明连续性。
for (const patch of [
  { cwd: "/repo/b", files: ["/repo/b/daemon/route.ts"], asks: ["实现 daemon/route.ts"] },
  { files: [`${cwd}/other/route.ts`], asks: ["实现 other/route.ts"] },
]) {
  const cands = candidates(followup, [row(patch)]);
  assert.equal(decide(followup, cands, now, ttlMs, true).kind, "spawn");
  assert.match(renderCandidates(followup, cands, now, ttlMs), /路径未对上/);
}
assert.equal(decision("继续完善刚才 route.ts", [row()]).kind, "spawn", "裸同名文件不能替代路径");
assert.equal(decision(followup, [row({ files: [`${cwd}/daemon/route.ts`, `/repo/b/daemon/route.ts`] })]).kind, "existing", "另一同名路径不覆盖准确命中");

const receiverDuty = routeReceiptDutiesOf([
  { from: "caller", to: "worker", turn: "t1", state: "needs-input" as const },
], "worker");
assert.deepEqual(receiverDuty, ["t1 欠着 caller: needs-input"]);
for (const patch of [ { lead: true }, { duties: receiverDuty } ]) {
  const rows = [row(patch)];
  assert.equal(decision(followup, rows).kind, "spawn");
  assert.equal(decision(followup, rows, true).kind, "spawn", "force 不绕占用保护");
  assert.match(renderCandidates(followup, candidates(followup, rows), now, ttlMs), /自动复用: (?:lead 身份|任务占用)/);
}
const ranked = candidates(followup, [row({ lead: true }), row({ name: "free", address: "free" })]);
const free = decide(followup, ranked, now, ttlMs);
assert(free.kind === "existing");
assert.equal(free.row.name, "free");

// 前五个词面更强但都被保护, 不得在 veto 前截断而漏掉第六个。
const crowded = candidates(followup, [
  ...Array.from({ length: 5 }, (_, i) => row({ name: `occupied-${i}`, address: `occupied-${i}`,
    files: [], description: followup, asks: [followup],
    ...(i < 3 ? { lead: true } : { duties: ["J1 未落定任务"] }),
  })),
  row({ name: "sixth", address: "sixth", description: "" }),
]);
assert.equal(crowded[5]!.row.name, "sixth");
assert.equal(decide(followup, crowded.slice(0, 5), now, ttlMs).kind, "spawn");
const sixth = decide(followup, crowded, now, ttlMs);
assert(sixth.kind === "existing");
assert.equal(sixth.row.name, "sixth");

// 每个状态验证 incoming 占用；另用一个 outgoing 样本验证 child 归属与「在等」方向。
const receipt = (state: InFlight["state"], outgoing = false): InFlight => ({
  from: outgoing ? "worker" : "caller", to: outgoing ? "child" : "worker",
  turn: "t123456", state, ageMs: 1000,
});
for (const state of ["working", "blocked", "needs-input", "deferred", "errored", "queued"] as const) {
  const inflight = [receipt(state)];
  const duties = routeReceiptDutiesOf(inflight, "worker");
  assert.equal(duties.length, 1);
  assert.deepEqual(duties, routeReceiptDutiesOf(inflight, "worker"));
  assert.match(duties[0]!, /欠着 caller/);
  assert(duties[0]!.includes(state));
  const rows = [row({ busy: false, duties })];
  assert.equal(decision(followup, rows, true).kind, "spawn", state);
  assert.match(renderCandidates(followup, candidates(followup, rows), now, ttlMs), /自动复用: 任务占用/);
  assert.deepEqual(routeReceiptDutiesOf(inflight, "unrelated"), []);
}
const outgoing = [receipt("working", true)];
const outgoingDuties = routeReceiptDutiesOf(outgoing, "worker");
assert.deepEqual(outgoingDuties, routeReceiptDutiesOf(outgoing, "worker"));
assert.match(outgoingDuties[0]!, /在等 child/);
assert.equal(decision(followup, [row({ busy: false, duties: outgoingDuties })], true).kind, "spawn");
assert.deepEqual(routeReceiptDutiesOf(outgoing, "unrelated"), []);
for (const state of ["done", "timeout", "silent", "dead", "canceled"] as const)
  assert.deepEqual(routeReceiptDutiesOf([receipt(state)], "worker"), []);
assert.equal(routeReceiptDutiesOf([receipt("needs-input"), receipt("deferred", true)], "worker").length, 2);

// 成本与任务档位都参与复用决策, force 不把弱连续性升级。
const cold = row({ contextTokens: 100_000, lastActivity: now - ttlMs - 1 });
assert.equal(decision(followup, [cold], false, "hard").kind, "spawn");
assert.equal(decision(followup, [cold], true, "hard").kind, "existing");
assert.equal(decision(followup, [cold], true, "light").kind, "spawn");
assert.equal(decision("核实 daemon/route.ts 文件存在", [cold], true, "hard").kind, "existing");
const large = row({ contextTokens: 160_000 });
const simpleFollowup = "继续核实 daemon/route.ts 文件存在";
assert.equal(decision(simpleFollowup, [large]).kind, "spawn");
assert.equal(decision(simpleFollowup, [large], false, "hard").kind, "existing", "复用时也使用显式 tier");
assert.equal(decision(followup, [large], false, "mini").kind, "spawn");

for (const task of ["架构设计", "疑难排障", "审查方案", "评审改动", "设计 API", "debug deadlock", "architecture review"]) {
  assert.equal(isSmallTask(task), false, task);
  // 默认不上 hard: 措辞里带「设计 / 排障 / 审查」不再是升档依据 (hard 只由调用方显式给)。
  assert.equal(tierFor(task, false), "standard", task);
}
for (const task of ["核实 AGENTS.md 文件存在", "核实 AGENTS.md 是否存在", "确认 CLAUDE.md 从哪加载", "确认 CLAUDE.md 加载路径", "检查 README.md 文件是否存在", "verify file exists", "修正错别字", "改文案"]) {
  assert.equal(isSmallTask(task), true, task);
  assert.equal(tierFor(task, false), "light", task);
}
for (const task of ["看看", "处理一下", "核实路由行为", "查一下故障", "实现新功能"]) {
  assert.equal(tierFor(task, false), "standard", task);
}
assert.equal(tierFor("核实文件存在", true), "hard");
console.log("Router routing: guidance, continuity, occupancy, force and task tiers passed");
