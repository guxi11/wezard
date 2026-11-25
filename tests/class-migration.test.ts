// 类迁移 (P1): 管家身份 → 类 + 有序号实例; 计划是纯函数, 执行幂等且失败安全。
// 验收: 5 化身按 bornAt → x-1..x-5 (锚点 target / identity 不变) / 第二次 0 写 /
// 冲突整组跳过 (同 workspace、-数字 结尾、无名、超长、撞名) / 类改名同步实例名 /
// byName 类名 → 锚点实例 / 自由名避开类名空间。
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CLASS_BACKUP_SUFFIX,
  loadClassStore,
  migrateClasses,
  planClasses,
} from "../daemon/classes.js";
import { identityWorkspaceOf, instancesOf, loadWizardStore, pickName } from "../daemon/wizard.js";

const ROOT = mkdtempSync(join(tmpdir(), "class-mig-"));
const scratch = (name: string): string => {
  const d = join(ROOT, name);
  mkdirSync(d, { recursive: true });
  return d;
};
const bytes = (f: string): string => readFileSync(f, "utf8");

const wiz = (target: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  target,
  identity: target,
  kind: "steward",
  name: "",
  description: "",
  bornAt: 1,
  memory: [],
  ...extra,
});

const seed = (file: string, rows: Record<string, unknown>[]): void => {
  writeFileSync(file, JSON.stringify(Object.fromEntries(rows.map((r) => [r.target as string, r])), null, 2));
};

try {
  // ── 1. 计划 + 执行: 5 个化身按出生先后编成 x-1..x-5 ────────────────────
  {
    const wizFile = join(scratch("mig"), "wizards.json");
    const clsFile = join(scratch("mig"), "classes.json");
    seed(wizFile, [
      wiz("chat:A", { name: "x", description: "A 群管家", memory: ["记住 A"], bornAt: 10, workspace: "/tmp/ws/" }),
      wiz("chat:C#two", { identity: "chat:A", name: "x", bornAt: 20, description: "C 的写法" }),
      wiz("chat:D#three", { identity: "chat:A", name: "x", bornAt: 30 }),
      wiz("chat:E#four", { identity: "chat:A", name: "x", bornAt: 40 }),
      wiz("chat:B#one", { identity: "chat:A", name: "x", bornAt: 50 }),
      // 非管家: 一个字节都不迁。
      { target: "chat:W#worker", identity: "chat:W#worker", kind: "worker", name: "w1", description: "", bornAt: 5, memory: [] },
      { target: "chat:AP", identity: "chat:AP", kind: "apprentice", name: "app", description: "", bornAt: 6, memory: [] },
    ]);
    const original = bytes(wizFile);
    const store = loadWizardStore(wizFile);
    const classes = loadClassStore(clsFile);

    const plan = planClasses(store.all(), [], () => "");
    assert.equal(plan.classes.length, 1, "只有管家那组建类");
    const cls = plan.classes[0]!;
    assert.equal(cls.id, "chat:A", "类 id = 原 identity (锚点 target)");
    assert.equal(cls.name, "x");
    assert.equal(cls.role, "steward");
    assert.equal(cls.workspace, "/tmp/ws", "workspace 规范化");
    assert.equal(cls.description, "A 群管家", "身份字段取锚点");
    assert.deepEqual(cls.memory, ["记住 A"]);
    assert.equal(cls.nextOrdinal, 6, "nextOrdinal = n + 1");
    assert.equal(cls.createdAt, 10, "createdAt = 组内最早出生");
    assert.deepEqual(plan.conflicts, []);
    assert.deepEqual(
      plan.renames.map((r) => [r.target, r.to, r.ordinal]),
      [
        ["chat:A", "x-1", 1],
        ["chat:C#two", "x-2", 2],
        ["chat:D#three", "x-3", 3],
        ["chat:E#four", "x-4", 4],
        ["chat:B#one", "x-5", 5],
      ],
      "按 bornAt (同刻按 target) 编号, 锚点排第一",
    );

    const r = migrateClasses(store, classes, wizFile);
    assert.equal(r.migrated, 5);
    assert.equal(r.backup, wizFile + CLASS_BACKUP_SUFFIX);
    assert.equal(bytes(r.backup!), original, "备份是原文件的原样字节");
    assert.deepEqual(r.conflicts, []);
    // target / identity 一个都不改 (旧账字符串全部照旧解析), 只落 name + ordinal。
    for (const [t, name, ordinal] of [["chat:A", "x-1", 1], ["chat:C#two", "x-2", 2], ["chat:D#three", "x-3", 3], ["chat:E#four", "x-4", 4], ["chat:B#one", "x-5", 5]] as const) {
      const rec = store.get(t)!;
      assert.equal(rec.name, name);
      assert.equal(rec.ordinal, ordinal);
      assert.equal(rec.identity, "chat:A");
      assert.equal(rec.target, t);
    }
    // 非管家组原样。
    assert.equal(store.get("chat:W#worker")!.ordinal, undefined);
    assert.equal(store.get("chat:W#worker")!.name, "w1");
    assert.equal(store.get("chat:AP")!.name, "app");
    assert.equal(classes.get("chat:A")!.nextOrdinal, 6);

    // ── 2. 幂等: 第二次 0 写, 两边的文件字节都不动 ─────────────────────
    const wizAfter = bytes(wizFile);
    const clsAfter = bytes(clsFile);
    const r2 = migrateClasses(loadWizardStore(wizFile), loadClassStore(clsFile), wizFile);
    assert.equal(r2.migrated, 0);
    assert.ok(!r2.backup, "没写盘就不碰备份");
    assert.equal(bytes(wizFile), wizAfter);
    assert.equal(bytes(clsFile), clsAfter);
    assert.equal(bytes(wizFile + CLASS_BACKUP_SUFFIX), original, "备份永远是迁移前那份");

    // ── 3. 命名接线: byName / instancesOf / claim / 类改名 / 身份级写 ────
    const bound = loadWizardStore(wizFile, () => undefined, loadClassStore(clsFile));
    assert.equal(bound.byName("x")!.target, "chat:A", "类名 → 锚点实例");
    assert.equal(bound.byName("X-3")!.target, "chat:D#three", "实例名 → 那条实例 (大小写不敏感)");
    assert.deepEqual(instancesOf(bound, "chat:A").map((w) => w.name), ["x-1", "x-2", "x-3", "x-4", "x-5"], "按序号排");
    assert.equal(bound.claim("chat:B#one", "随便"), "x-5", "类实例直接返回已有名");
    assert.equal(identityWorkspaceOf(bound, "chat:C#two"), "/tmp/ws", "工作区读类行");

    // 类改名: 全部实例换前缀, 序号不变; 目标那条返回自己的新名。
    assert.equal(bound.rename("chat:C#two", "leader"), "leader-2");
    assert.deepEqual(instancesOf(bound, "chat:A").map((w) => [w.target, w.name, w.ordinal]), [
      ["chat:A", "leader-1", 1],
      ["chat:C#two", "leader-2", 2],
      ["chat:D#three", "leader-3", 3],
      ["chat:E#four", "leader-4", 4],
      ["chat:B#one", "leader-5", 5],
    ]);
    assert.equal(bound.byName("leader")!.target, "chat:A");
    assert.equal(bound.byName("x-1"), undefined, "旧前缀不再可解析");
    assert.equal(loadClassStore(clsFile).get("chat:A")!.name, "leader", "类行同步改名");

    // 类名不合法 / 撞名: 说清原因抛错, 类行与实例名都不动。
    assert.throws(() => bound.rename("chat:A", "leader-9"), /invalid class name/);
    assert.throws(() => bound.rename("chat:A", "大 家"), /invalid class name/);
    bound.upsert("chat:FREE#x", { name: "someone" });
    assert.throws(() => bound.rename("chat:A", "someone"), /class name taken/, "与自由 wizard 同名也拒");
    assert.equal(bound.get("chat:A")!.name, "leader-1", "失败的改名一个字节都没落");

    // 身份级字段写: wizard 记录与类行同时更新。
    bound.upsertIdentity("chat:E#four", { description: "共用职责", memory: ["m-new"] });
    assert.equal(bound.get("chat:A")!.description, "共用职责");
    assert.equal(loadClassStore(clsFile).get("chat:A")!.description, "共用职责");
    assert.deepEqual(loadClassStore(clsFile).get("chat:A")!.memory, ["m-new"]);

    // ── 4. 自由名避开类名空间 ──────────────────────────────────────────
    assert.equal(pickName("leader", [], ["leader"]), "leader-w2", "撞类名 → 换 -wN (不形如实例)");
    const fresh = loadWizardStore(join(scratch("mig"), "free.json"), () => undefined, loadClassStore(clsFile));
    fresh.upsert("chat:FREE#y", { name: "" });
    const got = fresh.rename("chat:FREE#y", "leader");
    assert.notEqual(got, "leader");
    assert.ok(!/^leader-\d+$/.test(got), "不许落成类实例的形状: " + got);
  }

  // ── 5. 冲突: 整组跳过不写, 每行自带 skip / note 前缀 ──────────────────
  {
    const wizFile = join(scratch("conflict"), "wizards.json");
    const clsFile = join(scratch("conflict"), "classes.json");
    seed(wizFile, [
      wiz("chat:P", { name: "boss", bornAt: 1, workspace: "/tmp/p" }),
      wiz("chat:Q", { name: "boss2", bornAt: 2, workspace: "/tmp/p/" }),
      wiz("chat:R", { name: "queen-2", bornAt: 3, workspace: "/tmp/r" }),
      wiz("chat:S", { name: "", bornAt: 4, workspace: "/tmp/s" }),
      wiz("chat:T", { name: "y".repeat(29), bornAt: 5, workspace: "/tmp/t" }),
      wiz("chat:U", { name: "taken", bornAt: 6, workspace: "/tmp/u" }),
      wiz("chat:V", { name: "nows", bornAt: 7 }),
    ]);
    const store = loadWizardStore(wizFile);
    const classes = loadClassStore(clsFile);
    classes.create({ id: "chat:U0", name: "taken", role: "steward", workspace: "/tmp/u0" });

    const plan = planClasses(store.all(), classes.all(), () => "");
    assert.deepEqual(plan.classes.map((c) => c.id).sort(), ["chat:P", "chat:V"], "只建能建的");
    assert.deepEqual(plan.renames.map((r) => r.target).sort(), ["chat:P", "chat:V"]);
    const skipped = plan.conflicts.filter((c) => c.startsWith("skip:"));
    assert.equal(skipped.length, 5);
    assert.ok(skipped.some((c) => c.includes("chat:Q") && c.includes("同占")), "同 workspace 两个管家 → 待人确认合并");
    assert.ok(skipped.some((c) => c.includes("chat:R") && c.includes("-数字")), "名字以 -2 结尾");
    assert.ok(skipped.some((c) => c.includes("chat:S") && c.includes("没有名字")));
    assert.ok(skipped.some((c) => c.includes("chat:T") && c.includes("28")));
    assert.ok(skipped.some((c) => c.includes("chat:U") && c.includes("撞名")));
    assert.ok(plan.conflicts.some((c) => c.startsWith("note:") && c.includes("chat:V")), "推不出 workspace 只提示, 照建");

    const r = migrateClasses(store, classes, wizFile);
    assert.equal(r.migrated, 2);
    for (const t of ["chat:Q", "chat:R", "chat:S", "chat:T", "chat:U"]) {
      assert.equal(store.get(t)!.ordinal, undefined, t + " 跳过 = 不写");
    }
    assert.equal(store.get("chat:P")!.name, "boss-1");
    assert.equal(store.get("chat:V")!.name, "nows-1");
    assert.equal(loadClassStore(clsFile).get("chat:V")!.workspace, "", "推不出就落空串, 等人补");
    assert.equal(loadClassStore(clsFile).get("chat:P")!.workspace, "/tmp/p");

    // 已存在的类 id: 再跑不会重复建 / 重复编号。
    const again = migrateClasses(loadWizardStore(wizFile), loadClassStore(clsFile), wizFile);
    assert.equal(again.migrated, 0);
    assert.ok(!again.backup);
  }

  // ── 6. 失败安全: 备份写不出来 → 原文件一个字节不动 ────────────────────
  {
    const dir = scratch("nobackup");
    const wizFile = join(dir, "wizards.json");
    seed(wizFile, [wiz("chat:X", { name: "solo", bornAt: 1, workspace: "/tmp/x" })]);
    const original = bytes(wizFile);
    mkdirSync(wizFile + CLASS_BACKUP_SUFFIX); // 备份路径被目录占着 → copyFileSync 必败
    const r = migrateClasses(loadWizardStore(wizFile), loadClassStore(join(dir, "classes.json")), wizFile);
    assert.equal(r.migrated, 0);
    assert.match(r.skipped!, /backup failed/);
    assert.equal(bytes(wizFile), original, "没备份成功就什么都没写");
  }
} finally {
  rmSync(ROOT, { recursive: true, force: true });
}
console.log("class-migration.test.ts ok");
process.exit(0);
