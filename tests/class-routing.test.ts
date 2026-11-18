// 类 / 实例 P2: 路由与改名 (名字进类世界)。
// 验收: 接待/点类名给实例领号 (单调不复用) / 实例名精确寻址 (跨群) / 类名→本群实例 /
// 合并清单生效且幂等 / 旧名→类名的绑定改写 / wizard_identity({to}) 的权限矩阵 /
// 成员表键 (chat, target) 迁移幂等。
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadClassStore,
  migrateClasses,
  planClasses,
} from "../daemon/classes.js";
import {
  identityEditRefusal,
  loadWizardStore,
  manifestationOf,
  openInstance,
} from "../daemon/wizard.js";
import { stewardRoute } from "../daemon/steward.js";
import { rewriteStewardBindings } from "../daemon/onboarding.js";
import { openMembers } from "../daemon/members.js";

const ROOT = mkdtempSync(join(tmpdir(), "class-routing-"));
const dirOf = (name: string): string => { const d = join(ROOT, name); mkdirSync(d, { recursive: true }); return d; };
const rows = (xs: Record<string, unknown>[]): string =>
  JSON.stringify(Object.fromEntries(xs.map((r) => [r.target as string, r])), null, 2);
const rec = (target: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  target, identity: target, kind: "steward", name: "", description: "", bornAt: 1, memory: [], ...extra,
});
const cfgOf = (stateDir: string, chatPolicy: Record<string, unknown> = {}) => ({
  daemon: { stateDir }, chatPolicy, wrc: { channel: { steward: {} as Record<string, string> } },
} as never);

try {
  // ── 1. 领号: 类名-N, 同群幂等, drop 不还号 ───────────────────────────
  const dir = dirOf("inst");
  const wizFile = join(dir, "wizards.json");
  const clsFile = join(dir, "classes.json");
  {
    const classes = loadClassStore(clsFile);
    classes.create({ id: "chat:boss", bot: "", name: "alpha", role: "steward", workspace: "/tmp/a" });
    writeFileSync(wizFile, rows([
      rec("chat:boss", { name: "alpha-1", ordinal: 1, bornAt: 1 }),
      rec("chat:B#alpha-2", { identity: "chat:boss", name: "alpha-2", ordinal: 2, bornAt: 2 }),
    ]));
    writeFileSync(clsFile, readFileSync(clsFile, "utf8"));
  }
  const classes = loadClassStore(clsFile);
  // classes 里面 nextOrdinal 还是 1 (刚建), 这里按记录把游标推到 3 —— 与迁移后的真实形态一致。
  classes.upsert("chat:boss", { nextOrdinal: 3 });
  const store = loadWizardStore(wizFile, () => undefined, classes);

  const c1 = openInstance(store, "chat:C", "chat:boss");
  assert.equal(c1, "chat:C#alpha-3");
  assert.equal(store.get(c1!)!.name, "alpha-3");
  assert.equal(store.get(c1!)!.ordinal, 3);
  assert.equal(store.get(c1!)!.identity, "chat:boss");
  assert.equal(classes.get("chat:boss")!.nextOrdinal, 4, "领一个号 +1");
  assert.equal(openInstance(store, "chat:C", "chat:boss"), c1, "同群已有实例 = 用它, 不再领号");
  assert.equal(classes.get("chat:boss")!.nextOrdinal, 4, "幂等不消耗号");

  store.drop(c1!);
  const c2 = openInstance(store, "chat:C", "chat:boss");
  assert.equal(store.get(c2!)!.name, "alpha-4", "drop 掉的号不回收");
  assert.equal(openInstance(store, "chat:NOPE", "chat:none"), undefined, "没有类 → 旧路径");

  // ── 2. 名字解析: 实例名精确地址 (跨群) / 类名 → 本群实例 ──────────────
  assert.equal(manifestationOf(store, "alpha-2", "chat:ZZZ"), "chat:B#alpha-2", "点实例名 = 那一条 (跨群)");
  assert.equal(manifestationOf(store, "alpha", "chat:B"), "chat:B#alpha-2", "类名 → 本群的实例");
  assert.equal(manifestationOf(store, "alpha", "chat:ZZZ"), "chat:boss", "本群没有实例 → 锚点 (纯函数不新建)");
  assert.equal(manifestationOf(store, "alpha-1", "chat:ZZZ"), "chat:boss");

  // ── 3. 接待: 纯函数带 classId, target 按下一个序号猜 ──────────────────
  const cfg = cfgOf(join(ROOT, "state"), { "chat:NEW": { steward: "alpha" } });
  const r = stewardRoute(cfg as never, store, "chat:NEW", () => "/tmp/a");
  assert.equal(r.target, "chat:NEW#alpha-5", "新群接待按下一个序号落 target");
  assert.equal(r.fresh?.classId, "chat:boss");
  assert.equal(r.fresh?.name, "alpha");

  // ── 4. wizard_identity({to}) 的权限矩阵 ─────────────────────────────
  const me = store.get("chat:boss")!;
  const kid = { ...rec("chat:K#kid"), parent: "chat:boss" } as never;
  const stranger = { ...rec("chat:S#s") } as never;
  const apprentice = { ...rec("chat:AP"), kind: "apprentice" } as never;
  assert.equal(identityEditRefusal(undefined, { sameBot: true, editorIsParent: true, editorIsStewardInstance: false }), "目标不存在");
  assert.match(identityEditRefusal(kid, { sameBot: false, editorIsParent: true, editorIsStewardInstance: true }), /跨机器人/);
  assert.match(identityEditRefusal(apprentice, { sameBot: true, editorIsParent: true, editorIsStewardInstance: true }), /学徒/);
  assert.match(identityEditRefusal(stranger, { sameBot: true, editorIsParent: false, editorIsStewardInstance: false }), /没有权限/);
  assert.equal(identityEditRefusal(stranger, { sameBot: true, editorIsParent: true, editorIsStewardInstance: false }), "", "直属 parent");
  assert.equal(identityEditRefusal(stranger, { sameBot: true, editorIsParent: false, editorIsStewardInstance: true }), "", "管家实例");
  assert.equal(me.ordinal, 1);

  // ── 5. 合并清单: 多组并一个类 + 幂等 + exclude ──────────────────────
  const mdir = dirOf("merge");
  const mFile = join(mdir, "wizards.json");
  const mCls = join(mdir, "classes.json");
  writeFileSync(mFile, rows([
    rec("chat:G1", { name: "n1", workspace: "/tmp/m", bornAt: 1, memory: ["m1"] }),
    rec("chat:G2", { name: "n2", workspace: "/tmp/m", bornAt: 2 }),
    rec("chat:G3#x", { name: "n3", workspace: "/tmp/m", bornAt: 3 }),
    rec("chat:EX", { name: "excluded", workspace: "/tmp/e", bornAt: 4 }),
  ]));
  const merges = {
    merges: [{ into: "chat:G1", name: "m", first: "chat:G1", members: ["chat:G1", "chat:G2", "chat:G3#x"] }],
    exclude: ["chat:EX"],
  };
  const mStore = loadWizardStore(mFile);
  const mClasses = loadClassStore(mCls);
  const mplan = planClasses(mStore.all(), [], () => "", merges);
  assert.equal(mplan.classes.length, 1, "合并组 + 被排除的组都不建类");
  assert.equal(mplan.classes[0]!.id, "chat:G1");
  assert.equal(mplan.classes[0]!.name, "m");
  assert.equal(mplan.classes[0]!.nextOrdinal, 4, "三组各自一条 = 3 个实例");
  assert.deepEqual(mplan.renames.map((x) => [x.target, x.to, x.ordinal, x.identity]).sort(), [
    ["chat:G1", "m-1", 1, undefined],
    ["chat:G2", "m-2", 2, "chat:G1"],
    ["chat:G3#x", "m-3", 3, "chat:G1"],
  ].sort());
  assert.deepEqual(mplan.aliases.map((a) => [a.from, a.to]).sort(), [["n1", "m"], ["n2", "m"], ["n3", "m"]], "每组锚点旧名都指向类名");
  assert.deepEqual(mplan.conflicts, [], "exclude 不报冲突");

  const mr = migrateClasses(mStore, mClasses, mFile, () => "", merges);
  assert.equal(mr.migrated, 3);
  assert.equal(mStore.get("chat:G2")!.identity, "chat:G1", "合并 = identity 改成 into");
  assert.equal(mStore.get("chat:G2")!.name, "m-2");
  assert.equal(mStore.get("chat:EX")!.ordinal, undefined, "exclude 保持旧形态");
  assert.equal(mStore.get("chat:EX")!.name, "excluded");
  const files = [readFileSync(mFile, "utf8"), readFileSync(mCls, "utf8")];
  const mr2 = migrateClasses(loadWizardStore(mFile), loadClassStore(mCls), mFile, () => "", merges);
  assert.equal(mr2.migrated, 0, "第二次 0 写");
  assert.deepEqual([readFileSync(mFile, "utf8"), readFileSync(mCls, "utf8")], files, "文件字节不变");

  // ── 6. 旧名 → 类名的绑定改写 (chatPolicy + 频道表), 幂等 ────────────
  const cfgFile = join(ROOT, "config.jsonc");
  writeFileSync(cfgFile, "{}\n");
  const bindCfg = {
    daemon: { stateDir: join(ROOT, "state2") },
    chatPolicy: { "chat:A": { steward: "n2" }, "chat:B": { steward: "someone" } },
    wrc: { channel: { steward: { topic1: "N3" } as Record<string, string> } },
  } as never;
  const aliases = [{ from: "n2", to: "m" }, { from: "n3", to: "m" }];
  assert.equal(rewriteStewardBindings(bindCfg as never, cfgFile, aliases), 2, "一处 chatPolicy + 一处频道");
  const bc = bindCfg as unknown as { chatPolicy: Record<string, { steward: string }>; wrc: { channel: { steward: Record<string, string> } } };
  assert.equal(bc.chatPolicy["chat:A"]!.steward, "m");
  assert.equal(bc.chatPolicy["chat:B"]!.steward, "someone", "不匹配的不动");
  assert.equal(bc.wrc.channel.steward.topic1, "m");
  assert.equal(rewriteStewardBindings(bindCfg as never, cfgFile, aliases), 0, "改过之后 0 写");

  // ── 7. 成员表键 (chat, identity) → (chat, target) ───────────────────
  const mfile = join(ROOT, "members.json");
  writeFileSync(mfile, JSON.stringify({
    "chat:R|chat:G1": { mode: "owner", since: 1, by: "human:u", cursor: 3 },        // 旧: identity 键
    "chat:R|chat:R#keep": { mode: "mention", since: 2, by: "human:u", cursor: -1 }, // 新: target 键
    "chat:Q|chat:G1": { mode: "speaker", since: 3, by: "chat:R#m-2", cursor: 1 },   // 另一个群, 同一身份
  }, null, 2));
  const members = openMembers(mfile);
  const resolveKey = (chat: string, key: string): string | undefined => {
    if (key === "chat:R#keep") return key; // 已经是本 chat 的实例 target
    if (key === "chat:G1" && chat === "chat:R") return "chat:R#m-2";
    if (key === "chat:G1" && chat === "chat:Q") return "chat:Q#m-7";
    return undefined;
  };
  assert.equal(members.migrateKeys(resolveKey), 2, "两个群的 identity 键各换成自己的实例");
  assert.deepEqual(members.ofChat("chat:R").map((x) => x.target).sort(), ["chat:R#keep", "chat:R#m-2"]);
  assert.equal(members.modeOf("chat:R", "chat:R#m-2"), "owner", "行内容原样保留");
  assert.equal(members.isMember("chat:R", "chat:G1"), false, "旧 identity 键不再存在");
  assert.equal(members.migrateKeys(resolveKey), 0, "第二次 0 写");
  const raw = JSON.parse(readFileSync(mfile, "utf8")) as Record<string, unknown>;
  assert.ok("chat:R|chat:R#m-2" in raw && !("chat:R|chat:G1" in raw));
} finally {
  rmSync(ROOT, { recursive: true, force: true });
}
console.log("class-routing.test.ts ok");