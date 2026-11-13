// v3 P2 切片二: resolveName 化身解析 + set_workspace 问句退役。
// 验收: 同身份两群化身, A 群寻址只落 A 化身不串 B; 无本群化身回落锚点 (= 旧行为);
// 旧 target 形态全仍可解析; 1:1 世界行为零变化; charter 不再含工作区问句。
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bindWizardStore, identityOf, loadWizardStore, manifestationOf, type WizardStore } from "../daemon/wizard.js";
import { resolveName } from "../daemon/inbound.js";

const ROOT = mkdtempSync(join(tmpdir(), "wiz-manifest-"));
const file = join(ROOT, "wizards.json");
writeFileSync(file, JSON.stringify({}, null, 2));

const store: WizardStore = bindWizardStore(loadWizardStore(file));
// 同一身份 (identity = chat:AAA#fix) 在 A、B 两群各一条化身; 另有 1:1 记录数条。
store.upsert("chat:AAA#fix", { identity: "chat:AAA#fix", name: "fix", description: "A群的fix", bornAt: 1 });
store.upsert("chat:BBB#fix", { identity: "chat:AAA#fix", name: "fix", description: "B群的fix", bornAt: 2 });
store.upsert("chat:AAA", { name: "groupa", description: "A群管家", bornAt: 3 });
store.upsert("chat:CCC", { name: "ccc", description: "C群管家", bornAt: 4 });
store.upsert("chat:CCC#solo", { name: "solo", description: "C群分身", bornAt: 5 });

// ── 1. manifestationOf: 名字 → 身份 → base 聊天的化身 ─────────────────────
assert.equal(manifestationOf(store, "fix", "chat:AAA"), "chat:AAA#fix", "A 群解析到 A 化身");
assert.equal(manifestationOf(store, "fix", "chat:BBB"), "chat:BBB#fix", "B 群解析到 B 化身");
assert.equal(manifestationOf(store, "fix", "chat:CCC"), "chat:AAA#fix", "无本群化身回落锚点 (不自动新建)");
assert.equal(manifestationOf(store, "nobody", "chat:AAA"), undefined, "查无此名 → undefined");
assert.equal(manifestationOf(undefined, "fix", "chat:AAA"), undefined, "无 store → undefined");

// ── 2. resolveName (行首点名 / quote 路由的寻址层): A 群注入只落 A 化身 ───
assert.equal(resolveName("chat:AAA", "fix"), "chat:AAA#fix", "A 群点名 → A 化身, 不串 B");
assert.equal(resolveName("chat:BBB", "fix"), "chat:BBB#fix", "B 群点名 → B 化身, 不串 A");
assert.equal(resolveName("chat:CCC", "fix"), "chat:AAA#fix", "C 群点名 → 锚点化身 (= 旧跨群点名行为)");
assert.equal(resolveName("chat:AAA", ""), "chat:AAA", "裸消息 → 本聊天默认会话");
assert.equal(resolveName("chat:CCC", "newbie"), "chat:CCC#newbie", "不认识的名字 → 本聊天新 slot");
assert.equal(resolveName("chat:AAA", "groupa"), "chat:AAA", "untagged 管家名 → 管家 (本群)");

// ── 3. 旧 target 形态全仍可解析 ─────────────────────────────────────────
for (const t of ["chat:AAA", "chat:AAA#fix", "chat:BBB#fix", "chat:CCC", "chat:CCC#solo"]) {
  const rec = store.get(t);
  assert.ok(rec, `旧 target ${t} 仍可按 target 解析`);
  assert.equal(typeof identityOf(rec), "string");
}
assert.equal(store.byName("ccc")?.target, "chat:CCC", "untagged 管家名可解析");
assert.equal(store.byName("solo")?.target, "chat:CCC#solo", "tagged 名可解析");
assert.equal(store.byName("groupa")?.target, "chat:AAA", "1:1 锚点名可解析");

// ── 4. 1:1 世界零变化: 名册命中的名字, 无论从哪个聊天点名都落同一个 target ──
//  (旧 resolveName 契约: 命中即 rec.target; 多化身世界里「本群化身」优先, 1:1 时两者恒等)
{
  const one = loadWizardStore(join(ROOT, "one.json"));
  one.upsert("chat:X#k1", { identity: "chat:X#k1", name: "k1", bornAt: 1 });
  one.upsert("chat:Y", { identity: "chat:Y", name: "yy", bornAt: 2 });
  bindWizardStore(one);
  for (const [name, target] of [["k1", "chat:X#k1"], ["yy", "chat:Y"]] as const) {
    for (const base of ["chat:X", "chat:Y", "chat:Z"]) {
      assert.equal(manifestationOf(one, name, base), target, `1:1: ${name} from ${base}`);
      assert.equal(resolveName(base, name), target, `1:1 resolveName: ${name} from ${base}`);
    }
  }
  bindWizardStore(store); // 还原, 后续断言不受影响
}

console.log("manifestation resolution: A/B 化身隔离、锚点回落、旧 target 解析、1:1 零变化 all passed");
