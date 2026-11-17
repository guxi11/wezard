// 身份级字段在化身之间复用: upsertIdentity 同步写 + reconcileKin 开机收敛。
// 验收: 同身份两条记录同步、别的身份不动; 记忆并集保序、空描述补上、二次跑 0;
// 并集超 MEMORY_MAX 整组跳过 (不截断别人的记忆)。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { anchorOf, IDENTITY_FIELDS, identityFieldsOf, loadWizardStore, MEMORY_MAX, reconcileKin } from "../daemon/wizard.js";

const ROOT = mkdtempSync(join(homedir(), ".tmp-identity-kin-"));
try {
  // ── anchorOf: 每身份一条锚点 ─────────────────────────────────────────
  const store = loadWizardStore(join(ROOT, "wizards.json"));
  store.upsert("chat:AAA", { identity: "chat:AAA", kind: "steward", name: "boss", description: "A 群管家", memory: ["m1"], bornAt: 1 });
  store.upsert("chat:BBB#boss", { identity: "chat:AAA", kind: "steward", name: "boss", description: "", memory: ["m2"], bornAt: 2 });
  store.upsert("chat:CCC", { identity: "chat:CCC", kind: "steward", name: "other", description: "C 群管家", memory: ["c1"], bornAt: 3 });
  assert.equal(anchorOf(store, "chat:AAA")?.target, "chat:AAA", "target === identity 的那条是锚点");
  assert.equal(anchorOf(store, "chat:CCC")?.target, "chat:CCC");
  assert.equal(anchorOf(store, "chat:nope"), undefined, "没有记录 → undefined");
  assert.deepEqual([...IDENTITY_FIELDS], ["description", "expertise", "memory", "role"], "身份级字段清单");

  // ── upsertIdentity: 同身份全部化身一起写, 别的身份不碰 ────────────────
  store.upsertIdentity("chat:BBB#boss", { description: "共用职责", memory: ["m1", "m2", "m3"] });
  assert.equal(store.get("chat:AAA")!.description, "共用职责", "从化身写也同步到锚点");
  assert.deepEqual(store.get("chat:AAA")!.memory, ["m1", "m2", "m3"]);
  assert.equal(store.get("chat:CCC")!.description, "C 群管家", "别的身份不动");
  store.upsertIdentity("chat:DDD#solo", { role: "reviewer" });
  assert.equal(store.get("chat:DDD#solo")!.role, "reviewer", "target 不存在时照常 upsert 它");
  assert.deepEqual(identityFieldsOf(store.get("chat:AAA")),
    { description: "共用职责", memory: ["m1", "m2", "m3"] }, "只挑身份级字段, 缺省的不带");
  assert.deepEqual(identityFieldsOf(undefined), {});

  // ── reconcileKin: 记忆并集保序 + 空描述补上 ─────────────────────────
  const kin = loadWizardStore(join(ROOT, "kin.json"));
  kin.upsert("chat:K1", { identity: "chat:K1", kind: "steward", name: "k", description: "", memory: ["a", "b"], bornAt: 1 });
  kin.upsert("chat:K2#k", { identity: "chat:K1", kind: "steward", name: "k", description: "第二群的写法", memory: ["b", "c"], bornAt: 2 });
  kin.upsert("chat:K3#k", { identity: "chat:K1", kind: "steward", name: "k", description: "", memory: ["a"], bornAt: 3 });
  assert.equal(reconcileKin(kin), 3, "三条都变了 (记忆并集)");
  for (const t of ["chat:K1", "chat:K2#k", "chat:K3#k"]) {
    assert.deepEqual(kin.get(t)!.memory, ["a", "b", "c"], t + " 的记忆 = 锚点 + 其余按出生并入 (去重保序)");
    assert.equal(kin.get(t)!.description, "第二群的写法", t + " 的空描述补上组里第一个非空");
  }
  assert.equal(reconcileKin(kin), 0, "二次运行幂等");

  // ── 并集超 MEMORY_MAX: 整组跳过, 不截断 ────────────────────────────
  const big = loadWizardStore(join(ROOT, "big.json"));
  const many = (prefix: string, n: number): string[] => Array.from({ length: n }, (_, i) => prefix + i);
  const m1 = many("a", MEMORY_MAX - 20);
  const m2 = many("b", 30);
  big.upsert("chat:B1", { identity: "chat:B1", kind: "steward", name: "big", memory: m1, bornAt: 1 });
  big.upsert("chat:B2#big", { identity: "chat:B1", kind: "steward", name: "big", memory: m2, bornAt: 2 });
  assert.ok(m1.length + m2.length > MEMORY_MAX);
  assert.equal(reconcileKin(big), 0, "并集超上限 = 跳过");
  assert.deepEqual(big.get("chat:B1")!.memory, m1, "一条都不动");
  assert.deepEqual(big.get("chat:B2#big")!.memory, m2);
} finally { rmSync(ROOT, { recursive: true, force: true }); }
console.log("identity-kin.test.ts ok");
process.exit(0);
