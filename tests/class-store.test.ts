// 类表 (P1): ClassRecord 的写穿存储 + 名字空间纯函数。
// 验收: <bot, role, workspace> 唯一 / 类名唯一 (大小写不敏感) / 序号单调不复用 /
// 类名校验 / 名字空间判据 (含 <类名>-数字)。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CLASS_NAME_MAX,
  inClassSpace,
  instanceName,
  loadClassStore,
  normPath,
  parseInstanceName,
  validClassName,
} from "../daemon/classes.js";

const ROOT = mkdtempSync(join(tmpdir(), "class-store-"));
try {
  // ── 纯函数: 实例名 ⇄ 类名 / 类名校验 / 名字空间 ────────────────────────
  assert.equal(instanceName("boss", 3), "boss-3");
  assert.deepEqual(parseInstanceName("boss-3"), { className: "boss", ordinal: 3 });
  assert.deepEqual(parseInstanceName("boss-x-12"), { className: "boss-x", ordinal: 12 });
  assert.equal(parseInstanceName("boss"), undefined, "没有序号不是实例名");
  assert.equal(parseInstanceName("boss-0"), undefined, "序号从 1 起");
  assert.equal(parseInstanceName("boss-2x"), undefined);

  assert.ok(validClassName("boss"));
  assert.ok(validClassName("a_b-1c"), "-N 之外的短横与数字都行");
  assert.ok(validClassName("管-家"));
  assert.equal(validClassName(""), false);
  assert.equal(validClassName("a b"), false, "空白不在名字字符集里");
  assert.equal(validClassName("boss-2"), false, "以 -数字 结尾 = 长得像实例");
  assert.equal(validClassName("x".repeat(CLASS_NAME_MAX)), true);
  assert.equal(validClassName("x".repeat(CLASS_NAME_MAX + 1)), false);

  assert.equal(inClassSpace("boss", ["boss"]), true);
  assert.equal(inClassSpace("BOSS-7", ["boss"]), true, "大小写不敏感");
  assert.equal(inClassSpace("boss-7", []), false, "没有类就没有类名字空间");
  assert.equal(inClassSpace("bossy-7", ["boss"]), false, "前缀相同不算");

  // ── 写穿表: 唯一性 / 规范化 / 落盘 ───────────────────────────────────
  const file = join(ROOT, "classes.json");
  const classes = loadClassStore(file);
  const a = classes.create({ id: "chat:A", name: "boss", role: "steward", workspace: "/tmp/ws-a/", description: "A 群管家", memory: ["m1"] });
  assert.equal(a.workspace, "/tmp/ws-a", "workspace 规范化 (去尾 /)");
  assert.equal(a.nextOrdinal, 1);
  assert.equal(classes.byName("BOSS")?.id, "chat:A", "类名大小写不敏感");
  assert.equal(classes.byKey("steward", "/tmp/ws-a/")?.id, "chat:A", "byKey 走同一把规范化尺子");
  assert.equal(classes.byKey("steward", ""), undefined, "workspace \"\" 不参与判重");

  assert.throws(() => classes.create({ id: "chat:B", name: "Boss", role: "steward", workspace: "/tmp/ws-b" }), /class name taken/);
  assert.throws(() => classes.create({ id: "chat:C", name: "other", role: "steward", workspace: "/tmp/ws-a" }), /class key taken/);
  assert.throws(() => classes.create({ id: "chat:A", name: "again", role: "steward" }), /already exists/);
  assert.throws(() => classes.create({ id: "chat:D", name: "bad-2", role: "steward" }), /invalid class name/);
  assert.throws(() => classes.upsert("nope", { description: "x" }), /unknown class/);

  // 序号: 单调递增, 落盘的是「下一个」; drop 掉的实例不还号。
  assert.equal(classes.allocOrdinal("chat:A"), 1);
  assert.equal(classes.allocOrdinal("chat:A"), 2);
  assert.equal(classes.allocOrdinal("chat:A"), 3);
  const reloaded = loadClassStore(file);
  assert.equal(reloaded.get("chat:A")?.nextOrdinal, 4, "游标随表落盘");
  assert.equal(reloaded.allocOrdinal("chat:A"), 4, "重开进程也不回收");

  // 改名: 只改类行; 名字回到自由池之后可以再被别人用。
  const renamed = reloaded.rename("chat:A", "chief");
  assert.equal(renamed.name, "chief");
  assert.equal(reloaded.byName("boss"), undefined);
  assert.equal(reloaded.create({ id: "chat:E", name: "boss", role: "steward" }).name, "boss");

  // upsert: 只动给的字段; 记忆超上限按 wizard.ts 的同一截断。
  const patched = reloaded.upsert("chat:A", { description: "改过的职责", memory: Array.from({ length: 80 }, (_, i) => "m" + i) });
  assert.equal(patched.name, "chief", "没给的字段不动");
  assert.equal(patched.description, "改过的职责");
  assert.equal(patched.memory.length, 60, "memory 截到 MEMORY_MAX");
  assert.equal(patched.memory.at(-1), "m79");

  // 表就是一个普通 JSON 对象 (迁移的备份/回滚都按文件算)。
  const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, { name: string }>;
  assert.equal(raw["chat:A"]?.name, "chief");
  assert.deepEqual(Object.keys(raw).sort(), ["chat:A", "chat:E"], "抛错的 create 一条都没落");

  // 坏表: strict 读 → 抛 (类表是人物设定, 不是可丢的恢复状态)。
  const broken = join(ROOT, "broken.json");
  writeFileSync(broken, "{not json");
  assert.throws(() => loadClassStore(broken).all());

  assert.equal(normPath(""), "");
  assert.equal(normPath("  ~ "), normPath("~"));
} finally {
  rmSync(ROOT, { recursive: true, force: true });
}
console.log("class-store.test.ts ok");
process.exit(0);
