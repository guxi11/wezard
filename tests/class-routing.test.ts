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
  renderClassReport,
} from "../daemon/classes.js";
import {
  identityEditRefusal,
  loadWizardStore,
  manifestationOf,
  openInstance,
  renameNotice,
} from "../daemon/wizard.js";
import { stewardRoute } from "../daemon/steward.js";
import { rewriteStewardBindings } from "../daemon/onboarding.js";

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

  // ── 7. 成员表 (chat, identity) 键 —— 旧 members.json 已退役 ─────────────
  // 成员关系现在只存在于 room 账本 (join / leave 行); 旧键不再被任何路径读取,
  // 原断言 («identity 键各换成自己的实例» / 幂等 / 行内容保留) 随之删除, 见删除记录。

  // ── 8. 合并成员已经单独成类: 报 conflict, 不静默剔除 ──────────────────
  {
    const d = dirOf("merge-classed");
    const f = join(d, "wizards.json");
    // M2 已单独成类且 workspace 与 M1 **不同** —— 别让 twin 同 workspace 碰巧挡住 M1,
    // 这样才真的验到「合并失败后成员不会被 ② 拆成独立类」(否则碎片化会被掩盖)。
    writeFileSync(f, rows([
      rec("chat:M1", { name: "g1", workspace: "/tmp/m1", bornAt: 1 }),
      rec("chat:M2", { name: "g2", workspace: "/tmp/m2", bornAt: 2 }),
    ]));
    const cs = loadClassStore(join(d, "classes.json"));
    cs.create({ id: "chat:M2", bot: "", name: "g2", role: "steward", workspace: "/tmp/m2", nextOrdinal: 2 });
    const st = loadWizardStore(f, () => undefined, cs);
    const pl = planClasses(st.all(), cs.all(), () => "", {
      merges: [{ into: "chat:M1", name: "gg", first: "chat:M1", members: ["chat:M1", "chat:M2"] }],
      exclude: [],
    });
    assert.equal(pl.classes.length, 0, "有成员已经是类 → 整组不并, 且成员不被 ② 拆成独立类");
    assert.deepEqual(pl.renames, [], "被顶掉的合并成员不动名字 / 不落 ordinal");
    assert.ok(pl.conflicts.some((c) => c.includes("已是类 g2")), "报告里说清是哪个成员已类化");
  }

  // ── 9. 自由名落进类名字空间: 自动让位成 类名-wN (不需要人先改) ────────
  {
    const d = dirOf("free-space");
    const f = join(d, "wizards.json");
    writeFileSync(f, rows([
      rec("chat:C1", { name: "kappa", workspace: "/tmp/k", bornAt: 1 }),
      rec("chat:C1#two", { identity: "chat:C1", name: "kappa", bornAt: 2 }),
      { target: "user:W9#wezard", identity: "user:W9#wezard", kind: "worker", name: "kappa-2", description: "", bornAt: 3, memory: [] },
    ]));
    const cs = loadClassStore(join(d, "classes.json"));
    const st = loadWizardStore(f, () => undefined, cs);
    const pl = planClasses(st.all(), [], () => "");
    assert.deepEqual(pl.renames.filter((r) => r.target === "user:W9#wezard").map((r) => r.to), ["kappa-w2"], "-N 形状让位成 -wN (保留序号)");
    assert.equal(migrateClasses(st, cs, f).migrated, 3, "两条实例 + 一条让位");
    assert.equal(st.get("user:W9#wezard")!.name, "kappa-w2");
    assert.equal(st.get("chat:C1#two")!.name, "kappa-2", "实例照常拿到 2 号, 不被让位挤掉");
    assert.equal(migrateClasses(loadWizardStore(f, () => undefined, cs), cs, f).migrated, 0, "第二次 0 写");
  }

  // ── 10. 半迁移自愈: 类在、化身没 ordinal → 再跑补齐并推游标 ──────────
  {
    const d = dirOf("heal");
    const f = join(d, "wizards.json");
    writeFileSync(f, rows([
      rec("chat:H1", { name: "heal", workspace: "/tmp/h", bornAt: 1 }),
      rec("chat:H2#x", { identity: "chat:H1", name: "heal", bornAt: 2 }),
    ]));
    const cs = loadClassStore(join(d, "classes.json"));
    cs.create({ id: "chat:H1", bot: "", name: "heal", role: "steward", workspace: "/tmp/h", nextOrdinal: 2 });
    const st = loadWizardStore(f, () => undefined, cs);
    st.upsert("chat:H1", { name: "heal-1", ordinal: 1 }); // 模拟 create 成功、renames 中途崩
    const m = migrateClasses(st, cs, f);
    assert.equal(m.migrated, 1, "只补缺的那条");
    assert.equal(st.get("chat:H2#x")!.name, "heal-2");
    assert.equal(st.get("chat:H2#x")!.ordinal, 2);
    assert.equal(cs.get("chat:H1")!.nextOrdinal, 3, "游标推到 max+1, 下一个新实例不会撞号");
    assert.equal(migrateClasses(loadWizardStore(f, () => undefined, cs), cs, f).migrated, 0);
  }

  // ── 11. 类改名: 实例变 <新类名>-N, 绑定改写的是类名 (不是实例名), 幂等 ──
  {
    const d = dirOf("rebind");
    const wf = join(d, "wizards.json");
    writeFileSync(wf, rows([
      rec("chat:R1", { name: "alpha-1", ordinal: 1, bornAt: 1 }),
      rec("chat:R2#alpha-2", { identity: "chat:R1", name: "alpha-2", ordinal: 2, bornAt: 2 }),
    ]));
    const cs = loadClassStore(join(d, "classes.json"));
    cs.create({ id: "chat:R1", bot: "", name: "alpha", role: "steward", workspace: "/tmp/r", nextOrdinal: 3 });
    const st = loadWizardStore(wf, () => undefined, cs);
    assert.equal(st.rename("chat:R1", "beta"), "beta-1", "返回的是实例名");
    assert.equal(cs.get("chat:R1")!.name, "beta", "类行是新类名");
    assert.equal(st.get("chat:R2#alpha-2")!.name, "beta-2", "其余实例同步成 新类名-序号");
    // 改名回包的「已被占用」按**类名**判定: 实例名 beta-1 拿去比 asked 永远不等, 会误报。
    assert.equal(renameNotice("beta", cs.get("chat:R1")!.name), "", "全新类名 → 不提示已被占用");
    assert.equal(renameNotice("BETA", "beta"), "", "大小写不敏感");
    assert.match(renameNotice("gamma", cs.get("chat:R1")!.name), /已被占用/, "落定名真的不同才提示");
    const cfgFile = join(d, "config.jsonc");
    writeFileSync(cfgFile, "{}\n");
    const cfg = {
      daemon: { stateDir: d },
      chatPolicy: { "chat:R1": { steward: "alpha" } },
      wrc: { channel: { steward: { topicR: "ALPHA" } as Record<string, string> } },
    } as never;
    // 与 wizard_identity 的善后同一实现: 传的是**类名** alpha → beta (不是 alpha-1)。
    assert.equal(rewriteStewardBindings(cfg as never, cfgFile, [{ from: "alpha", to: "beta" }]), 2);
    const c = cfg as unknown as { chatPolicy: Record<string, { steward: string }>; wrc: { channel: { steward: Record<string, string> } } };
    assert.equal(c.chatPolicy["chat:R1"]!.steward, "beta", "绑定写类名, 不是实例名 beta-1");
    assert.equal(c.wrc.channel.steward.topicR, "beta");
    assert.equal(rewriteStewardBindings(cfg as never, cfgFile, [{ from: "alpha", to: "beta" }]), 0, "幂等");
  }

  // ── 13. 报告不只写 conflicts: 将建类清单 + 全部改名都要在 ─────────────
  {
    const d = dirOf("report");
    const f = join(d, "wizards.json");
    writeFileSync(f, rows([
      rec("chat:RP", { name: "rep", workspace: "/tmp/rep", bornAt: 1 }),
      rec("chat:RP#b", { identity: "chat:RP", bornAt: 2 }),
    ]));
    const st = loadWizardStore(f);
    const plan = planClasses(st.all(), [], () => "");
    const text = renderClassReport(plan, { applied: false, records: 2, at: 0 });
    assert.ok(text.includes("(gated)"), "闸门态写明");
    assert.ok(text.includes("## classes") && text.includes("chat:RP | rep | steward | /tmp/rep | 2 | 3"), "将建的类带实例数/游标");
    assert.ok(text.includes("## renames") && text.includes("chat:RP | rep -> rep-1 | 1"), "每条改名都列");
    assert.ok(text.includes("## conflicts") && text.includes("(none)"), "没有冲突也明说");
  }
} finally {
  rmSync(ROOT, { recursive: true, force: true });
}
console.log("class-routing.test.ts ok");