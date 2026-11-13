// v3 P3 (§3 管家指定): 绑定解析、接待路由、手闸判定面、全局管家落位。
// 验收: config 绑定 → 本群化身 (无则 fresh 描述子, 纯函数不写盘); 存量聊天行为零变化
// (untagged 记录在 → 裸消息仍落 base); 新聊天由全局管家接待 (化身 = 身份, 工作区 = 锚点 cwd);
// 手闸判定跟随绑定 (换绑后旧默认会话不 arm、指定化身 arm); markGlobalSteward 幂等不造幽灵。
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigSchema } from "../shared/config.js";
import { chatPolicyOf } from "../daemon/chat-name.js";
import { loadWizardStore } from "../daemon/wizard.js";
import { appointedSteward, isStewardTarget, markGlobalSteward, stewardIdentityOf, stewardRoute } from "../daemon/steward.js";

const ROOT = mkdtempSync(join(tmpdir(), "steward-"));
const cfgOf = (steward?: Record<string, string>) => ConfigSchema.parse({
  bot: { botId: "test", secret: "test" },
  wrc: { allowFrom: ["user:tester"] },
  defaultChat: "user:home",
  ...(steward ? { chatPolicy: Object.fromEntries(Object.entries(steward).map(([k, v]) => [k, { steward: v }])) } : {}),
});

const store = loadWizardStore(join(ROOT, "wizards.json"));
// 家 (user:home) 的默认会话 = 全局管家锚点; 群A 有存量默认会话; 群B 是全新聊天。
store.upsert("user:home", { identity: "user:home", name: "gsw", description: "全局管家", kind: "global-steward", bornAt: 1 });
store.upsert("chat:A", { identity: "chat:A", name: "groupa", description: "群A管家", bornAt: 2 });
store.upsert("chat:A#fix", { identity: "chat:A#fix", name: "fix", description: "工人", bornAt: 3 });

// ── 1. config: chatPolicy.steward 解析 + 透出 ─────────────────────────────
const cfgBound = cfgOf({ "chat:A": "fix" });
assert.equal(appointedSteward(cfgBound, "chat:A"), "fix");
assert.equal(appointedSteward(cfgBound, "chat:B"), "");
assert.equal(chatPolicyOf(cfgBound, "chat:A#anything").steward, "fix", "chatPolicyOf 透出 steward");
const cfgFree = cfgOf();
assert.equal(chatPolicyOf(cfgFree, "chat:A").steward, undefined);

// ── 2. stewardIdentityOf: 绑定优先, 回落默认会话 ──────────────────────────
assert.equal(stewardIdentityOf(cfgBound, store, "chat:A"), "chat:A#fix", "绑定 → fix 的身份");
assert.equal(stewardIdentityOf(cfgFree, store, "chat:A"), "chat:A", "未绑定 → 默认会话身份");
assert.equal(stewardIdentityOf(cfgFree, store, "chat:B"), undefined, "新聊天没有管家身份");
assert.equal(stewardIdentityOf(cfgOf({ "chat:B": "nobody" }), store, "chat:B"), undefined, "悬空绑定 → 当作没绑");

// ── 3. stewardRoute ②: 存量聊天行为零变化 ────────────────────────────────
assert.deepEqual(stewardRoute(cfgFree, store, "chat:A"), { target: "chat:A" }, "untagged 记录在 → 裸消息仍落 base");
assert.deepEqual(stewardRoute(cfgFree, store, "chat:A", () => "/ws"), { target: "chat:A" }, "cwdOf 不影响 ②");

// ── 4. stewardRoute ①: 绑定的身份在本群的化身; 没有化身 → fresh (纯函数不写盘) ──
assert.deepEqual(stewardRoute(cfgBound, store, "chat:A"), { target: "chat:A#fix" }, "绑定身份已有本群化身 → 它");
// 绑定 fix 到群B (fix 在群B 无化身): 应给出新化身描述子 —— 身份/名字/种类取锚点, 工作区取锚点 cwd。
const cfgB = cfgOf({ "chat:B": "fix" });
const toB = stewardRoute(cfgB, store, "chat:B", (t) => (t === "chat:A#fix" ? "/repo/fix" : ""));
assert.equal(toB.target, "chat:B#fix");
assert.deepEqual(toB.fresh, { identity: "chat:A#fix", name: "fix", kind: "worker", workspace: "/repo/fix" });
assert.ok(!store.get("chat:B#fix"), "纯函数: fresh 不落盘");
// 锚点无 cwd 可取 → workspace 省略。
const toB2 = stewardRoute(cfgB, store, "chat:B");
assert.equal(toB2.fresh?.workspace, undefined);

// ── 5. stewardRoute ③: 新聊天由全局管家接待; 无全局管家回落旧行为 ─────────
const fresh = stewardRoute(cfgFree, store, "chat:B", (t) => (t === "user:home" ? "/home/ws" : ""));
assert.equal(fresh.target, "chat:B#gsw", "全局管家化身 slot 用身份名");
assert.deepEqual(fresh.fresh, { identity: "user:home", name: "gsw", kind: "global-steward", workspace: "/home/ws" });
// 已有化身后 (第二次解析) → 稳定落那个化身, 不再 fresh。
store.upsert("chat:B#gsw", { identity: "user:home", name: "gsw", kind: "global-steward", bornAt: 4 });
assert.deepEqual(stewardRoute(cfgFree, store, "chat:B"), { target: "chat:B#gsw" });
// 没有全局管家 (新装机未被认领) 的新聊天 → base 本身 (= 旧「还没有会话 /new」路径)。
const bare = loadWizardStore(join(ROOT, "bare.json"));
assert.deepEqual(stewardRoute(cfgFree, bare, "chat:NEW"), { target: "chat:NEW" });
// slot 名被占 → uniqueTag 退避, 记录名仍是身份名 (fresh.name 不退避)。
bare.upsert("user:home", { identity: "user:home", name: "gsw", kind: "global-steward", bornAt: 1 });
bare.upsert("chat:NEW#gsw", { identity: "chat:NEW#gsw", name: "别人", bornAt: 2 });
const clash = stewardRoute(cfgFree, bare, "chat:NEW");
assert.equal(clash.target, "chat:NEW#gsw-2");
assert.equal(clash.fresh?.name, "gsw");

// ── 6. isStewardTarget: 手闸判定跟随绑定 ─────────────────────────────────
assert.equal(isStewardTarget(cfgFree, store, "chat:A"), true, "未绑定: 旧默认会话仍是管家 (1:1 行为)");
assert.equal(isStewardTarget(cfgFree, store, "chat:A#fix"), false, "未绑定: 普通分身不 arm");
assert.equal(isStewardTarget(cfgBound, store, "chat:A#fix"), true, "绑定后: 指定化身 arm (虽是 tagged)");
assert.equal(isStewardTarget(cfgBound, store, "chat:A"), false, "绑定后: 旧默认会话不再 arm");
assert.equal(isStewardTarget(cfgFree, store, "user:home"), true, "家 = 全局管家化身, 也是管家");
assert.equal(isStewardTarget(cfgFree, store, "chat:NOSUCH"), false, "没有记录的 target 永远不算");

// ── 7. markGlobalSteward: 落位 + 幂等 + 不造幽灵 ─────────────────────────
const s2 = loadWizardStore(join(ROOT, "w2.json"));
s2.upsert("user:home", { identity: "user:home", name: "home", bornAt: 1 });
assert.deepEqual(markGlobalSteward(s2, "user:home"), { marked: true, target: "user:home" });
assert.equal(s2.get("user:home")?.kind, "global-steward");
assert.deepEqual(markGlobalSteward(s2, "user:home"), { marked: false, target: "user:home" }, "幂等");
assert.equal(markGlobalSteward(loadWizardStore(join(ROOT, "w3.json")), "user:home").marked, false, "home 无记录不造幽灵");
assert.equal(markGlobalSteward(s2, "").marked, false, "空 home (未认领) 不动");

console.log("steward binding: config parse, identity resolution, reception routing, brake targets, global anchor all passed");
