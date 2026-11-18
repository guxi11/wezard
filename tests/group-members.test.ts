// rolepage 群成员 (实例) 列表: 纯函数 groupMembers 的口径 ——
// 本群实例 + 成员表加入的实例按 target 去重 / 管家在前 / 类实例带类名 / 单聊为空。
import assert from "node:assert/strict";
import { groupMembers, isGroupChat } from "../shared/group-members.js";
import type { WorldFactClass, WorldFactMemberRow, WorldFactWizard } from "../shared/world.js";

const now = Date.now();
const wiz = (target: string, name: string, at: number, extra: Partial<WorldFactWizard> = {}): WorldFactWizard => ({
  target, name, description: "", chat: "", cwd: "", model: "", cli: "codebuddy",
  busy: false, alive: false, bornAt: at, lastActivity: at, summary: "", ...extra,
});

const G = "chat:wrG";
const H = "chat:wrH";
const steward = wiz(G, "wezard-1", now - 1000, { identity: "cls-steward", ordinal: 1, steward: true, alive: true });
const worker = wiz(`${G}#fix`, "coder-2", now - 2000, { identity: "cls-coder", ordinal: 2, alive: true, busy: true });
const joined = wiz(`${H}#helper`, "helper-1", now - 3000, { identity: "cls-helper", ordinal: 1 });
const elsewhere = wiz(`${H}#other`, "other", now - 500);
const classes: WorldFactClass[] = [
  { id: "cls-steward", name: "wezard", role: "steward", workspace: "/w" },
  { id: "cls-coder", name: "coder", role: "coder", workspace: "/w" },
  { id: "cls-helper", name: "helper", role: "reviewer", workspace: "/w" },
];
const rows: WorldFactMemberRow[] = [
  { chat: G, target: steward.target, mode: "owner", since: now - 9000, by: "human:T" },
  { chat: G, target: worker.target, mode: "speaker", since: now - 8000, by: "cls-steward" },
  { chat: G, target: joined.target, mode: "mention", since: now - 7000, by: "human:T" },
  { chat: H, target: elsewhere.target, mode: "speaker", since: now - 1, by: "human:T" },
];
const statusOf = (t: string) => (t === steward.target ? { alive: true, busy: false, runningUntil: 0 } : t === worker.target ? { alive: true, busy: true, runningUntil: now + 60_000 } : undefined);

const ms = groupMembers(G, [steward, worker, joined, elsewhere], rows, classes, statusOf);
assert.deepEqual(ms.map((m) => m.target), [steward.target, worker.target, joined.target], "本群实例 + 加入实例, 别的群且没加入的不出现");
assert.equal(ms[0]!.steward, true, "管家标记");
assert.equal(ms[0]!.mode, "owner", "strict 在场方式跟着成员表");
assert.equal(ms[0]!.foreign, false);
assert.equal(ms[1]!.className, "coder", "类实例标出所属类名");
assert.equal(ms[1]!.ordinal, 2);
assert.equal(ms[1]!.status?.busy, true, "活体状态透传");
assert.equal(ms[2]!.foreign, true, "跨群加入");
assert.equal(ms[2]!.mode, "mention");
assert.equal(ms[2]!.className, "helper");

// 去重: 同一 target 同时是名册里的本群实例与成员表行 —— 只出现一次。
const dup = groupMembers(G, [steward, steward], rows, classes);
assert.equal(dup.filter((m) => m.target === steward.target).length, 1);

// 成员表里有、名册里已经没有 (被裁 / 老快照): 名字退回 slot id, 冷状态。
const ghostRow: WorldFactMemberRow = { chat: G, target: `${G}#gone`, mode: "speaker", since: 1, by: "x" };
const withGhost = groupMembers(G, [steward], [ghostRow], []);
assert.equal(withGhost.find((m) => m.target === `${G}#gone`)?.name, "gone");

// 隐式群 (没有成员表行): 成员照旧由名册给, mode 缺省。
const implicit = groupMembers(G, [steward, worker], [], []);
assert.equal(implicit.length, 2);
assert.equal(implicit.some((m) => m.mode !== undefined), false);

// 单聊 / 私聊: 没有群成员。
assert.equal(isGroupChat("user:T03880027A"), false);
assert.deepEqual(groupMembers("user:T03880027A", [steward, worker], rows, classes), []);
assert.deepEqual(groupMembers("", [steward], rows, classes), []);

console.log("group-members: 本群实例+加入实例去重 / 管家在前 / 类名 / 在场方式 / 单聊为空");
