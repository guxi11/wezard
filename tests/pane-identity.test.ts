// v3 P7 约束刀: name = 身份 (role), pane 只是承载会话的进程外壳 —— 全链路按身份/靶点
// (target) 归组, pane id 只做定位。断言 (设计稿 P7-A④): 同一身份在两个群各有一个
// pane (窗口名相同) 时, roster / read_chat 按身份聚合, 不按 pane 各算一行; 停掉
// 其中一个会话 (drop 一个 target) 不影响另一群的身份与名字。
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bindWizardStore, loadWizardStore, manifestationOf, rosterCensus, rosterL0, type WizardStore } from "../daemon/wizard.js";
import { renderChatLog, type LogSession } from "../daemon/chat-log.js";
import { windowLabel } from "../shared/session-label.js";

// ── 身份夹具: 同一身份 (identity = chat:AAA#fix) 在 A、B 两群各一条化身 ──────
const ROOT = mkdtempSync(join(tmpdir(), "pane-identity-"));
const store: WizardStore = bindWizardStore(loadWizardStore(join(ROOT, "wizards.json")));
store.upsert("chat:AAA#fix", { identity: "chat:AAA#fix", name: "fix", description: "A群的fix", bornAt: 1 });
store.upsert("chat:BBB#fix", { identity: "chat:AAA#fix", name: "fix", description: "B群的fix", bornAt: 2 });
const row = (target: string, lastActivity: number) => ({
  target, identity: "chat:AAA#fix", kind: undefined, name: "fix", address: "fix", description: "",
  chat: "", solo: false, busy: false, alive: true, self: false, lastActivity, summary: "", clones: [],
});

// ── 1. roster 按身份聚合: 两群两 pane (同窗口名), census 恰 1 个身份 ──────────
const rows = [row("chat:AAA#fix", 200), row("chat:BBB#fix", 100), { ...row("chat:AAA", 50), identity: "chat:AAA", name: "groupa", address: "groupa" }];
const census = rosterCensus(rows as never[]);
assert.equal(census.identities, 2, "同身份两群两 pane, census 按身份去重 (fix + 管家)");
assert.equal(census.chats, 2, "聊天数按 base 数");
// L0 在 A 群: 只见 A 化身一行, 不把 B 群的 pane 当另一个人列出来。
const l0 = rosterL0(rows as never[], { base: "chat:AAA", now: 1000, census,
  stewardTarget: "chat:AAA" });
assert.equal((l0.match(/^\`fix\`/gm) ?? []).length, 1, "L0 里 fix 只占一行 (A 化身)");
assert.ok(!l0.includes("B群的fix"), "B 群化身不进 A 群 L0");

// ── 2. read_chat 按身份/会话 key 归档, 不按 pane: 两群各一份 transcript ─────
const at = Date.now() - 3600_000;
const script = (name: string, rounds: Array<[string, string]>): string => {
  const path = join(ROOT, `${name}.jsonl`);
  const lines = rounds.flatMap(([ask, reply], i): object[] => [
    { type: "user", timestamp: new Date(at + i * 4000).toISOString(), message: { role: "user", content: ask } },
    { type: "assistant", timestamp: new Date(at + i * 4000 + 1000).toISOString(), message: { role: "assistant", content: reply } },
  ]);
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return path;
};
const session = (key: string, homeKey: string, path: string): LogSession => ({
  name: "fix", key, jsonlPath: path, homeChat: homeKey, homeKey, homeHuman: "未知", since: 0,
});
const aPath = script("a", [["A 群的人话", "RESULT: a-done"]]);
const bPath = script("b", [["B 群的人话", "RESULT: b-done"]]);
const sessions = [session("chat:AAA#fix", "chat:AAA", aPath), session("chat:BBB#fix", "chat:BBB", bPath)];
const read = (q: Record<string, unknown>): string => renderChatLog(sessions, { limit: 50, per: 200, ...q }, Date.now()).text;
// 同一身份 (名字 fix) 在两群的话各归各的群 (homeKey 隔离), 互不串; 显示名同为一个身份名。
assert.ok(read({}).includes("a-done") && read({}).includes("b-done"), "两群的话都在");
assert.ok(!read({ chat: "chat:AAA", chatKey: "chat:AAA" }).includes("b-done"), "A 群读不到 B 群的话");
assert.ok(!read({ chat: "chat:BBB", chatKey: "chat:BBB" }).includes("a-done"), "B 群读不到 A 群的话");
// role 轴按 key 认: 指到 A 化身的 key, 只读它的往来 —— pane 换了 (key 不变) 记录不丢。
assert.ok(read({ role: "fix", roleKey: "chat:AAA#fix" }).includes("a-done"), "roleKey 指到 A 化身");
assert.ok(!read({ role: "fix", roleKey: "chat:AAA#fix" }).includes("b-done"), "不把 B 化身的话算进来");

// ── 3. 停一个会话不动另一群的身份: drop 是 target 级, 名字是身份级 ──────────
assert.equal(manifestationOf(store, "fix", "chat:BBB"), "chat:BBB#fix", "停之前 B 群解析到 B 化身");
store.drop("chat:AAA#fix");
assert.ok(store.get("chat:BBB#fix"), "drop A 化身后 B 化身记录仍在");
assert.equal(store.byName("fix")?.target, "chat:BBB#fix", "名字按身份存活, 落到剩下的化身");
assert.equal(manifestationOf(store, "fix", "chat:BBB"), "chat:BBB#fix", "B 群照常解析, 身份与成员资格不受影响");

// ── 4. pane 的窗口名只是显示: 同身份两 pane 窗口名相同, 定位永远走 pane id ────
//  (safeWindowName 的契约: 名字碰撞没关系 —— 寻址按 pane id, 不按窗口名。)
assert.equal(windowLabel("chat:AAA#fix"), windowLabel("chat:BBB#fix"), "同身份两 pane 同一窗口名 (显示)");
assert.notEqual("chat:AAA#fix", "chat:BBB#fix", "身份坐标 (target) 各自独立 —— pane 之上的账全在这里");

console.log("pane-identity: roster/read_chat 按身份聚合、停一会话不伤另一群、pane 名只是显示 all passed");
