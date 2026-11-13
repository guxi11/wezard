// v3 P2 切片一: 身份系统地基 —— WizardRecord.identity/role/kind、boot 幂等迁移、
// 名字唯一性升到身份级。验收: 迁移 1:1 + 备份 + 幂等; 失败不覆盖原文件;
// 同名跨群两化身互不串; 旧 routes/message-events 迁移后照常 replay。
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  evictStaleName,
  identityOf,
  loadWizardStore,
  MIGRATION_BACKUP_SUFFIX,
  migrateIdentities,
  referencedTargets,
  type WizardStore,
} from "../daemon/wizard.js";
import { allRows, foldJournal, ops } from "../daemon/router.js";
import { gcEvents } from "../daemon/message-events.js";
import { NO_DEADLINE } from "../shared/turn-state.js";

const ROOT = mkdtempSync(join(tmpdir(), "wiz-ident-"));
const scratch = (name: string): string => { const d = join(ROOT, name); mkdirSync(d, { recursive: true }); return d; };

// v2 形状的存量名册: 群默认会话 (untagged)、分身 (tagged, 含一个 clone)、
// 没 claim 过名字的空名记录、私聊默认会话。
const V2_ROSTER = {
  "chat:wrGROUPA": { target: "chat:wrGROUPA", name: "groupa", description: "群A管家", bornAt: 1700000000000, memory: [] },
  "chat:wrGROUPA#fix": { target: "chat:wrGROUPA#fix", name: "fix", description: "修 bug", bornAt: 1700000001000, memory: [], parent: "chat:wrGROUPA" },
  "chat:wrGROUPB": { target: "chat:wrGROUPB", name: "", description: "", bornAt: 1700000002000, memory: [] },
  "chat:wrGROUPB#regress": { target: "chat:wrGROUPB#regress", name: "regress", description: "回归", bornAt: 1700000003000, memory: [] },
  "user:wrU1": { target: "user:wrU1", name: "steward", description: "私聊管家", bornAt: 1700000004000, memory: [] },
};
const v2File = (dir: string): string => {
  const f = join(dir, "wizards.json");
  writeFileSync(f, JSON.stringify(V2_ROSTER, null, 2));
  return f;
};
const bytes = (f: string): string => readFileSync(f, "utf8");

// ── 1. 迁移: 1:1 生成身份 + 备份 + 幂等 ──────────────────────────────────
{
  const dir = scratch("migrate");
  const file = v2File(dir);
  const original = bytes(file);

  const store = loadWizardStore(file);
  const r1 = migrateIdentities(store, file);
  assert.equal(r1.migrated, 5);
  assert.equal(r1.backup, file + MIGRATION_BACKUP_SUFFIX);
  // 备份必须是原文件的原样字节 —— 回滚 = 把它拷回去。
  assert.equal(bytes(r1.backup!), original);
  // 1:1: identity = 自己的 target; kind: untagged 默认会话 = steward, 分身 = worker; role 留空。
  for (const [t, rec] of store.all().map((w) => [w.target, w] as const)) {
    assert.equal(rec.identity, t, `${t}: identity 1:1`);
    assert.equal(rec.role, undefined);
    assert.equal(rec.kind, t.includes("#") ? "worker" : "steward", `${t}: kind`);
  }
  // 名字与既有字段原样保留 (1:1 迁移不产生新名字冲突)。
  assert.equal(store.byName("fix")?.target, "chat:wrGROUPA#fix");
  assert.equal(store.byName("groupa")?.target, "chat:wrGROUPA");
  assert.equal(store.get("chat:wrGROUPB")?.name, "");

  // 幂等 (顺序跑两遍): 第二遍一条不写, 文件字节不变, 备份仍是原始 v2。
  const before = bytes(file);
  const r2 = migrateIdentities(loadWizardStore(file), file);
  assert.equal(r2.migrated, 0);
  assert.equal(bytes(file), before);
  assert.equal(bytes(file + MIGRATION_BACKUP_SUFFIX), original);

  // 幂等 (同一份原始数据各跑一遍, 结果一致): 拷一份原始数据独立迁移, 终态与上面逐字节相同。
  const dirB = scratch("migrate-again");
  const fileB = v2File(dirB);
  migrateIdentities(loadWizardStore(fileB), fileB);
  migrateIdentities(loadWizardStore(fileB), fileB);
  assert.equal(bytes(fileB), bytes(file));
  console.log("migration: 1:1 identity, pristine backup, idempotent (sequential + fresh-copy) passed");
}

// ── 2. 失败安全: 备份写不出来 / 表里有畸形记录 → 原文件一个字节不动 ────────
{
  const dir = scratch("fail-backup");
  const file = v2File(dir);
  const original = bytes(file);
  // 备份路径被一个目录占着 → copyFileSync 必败。
  mkdirSync(file + MIGRATION_BACKUP_SUFFIX);
  const r = migrateIdentities(loadWizardStore(file), file);
  assert.equal(r.migrated, 0);
  assert.ok(r.skipped?.includes("backup failed"));
  assert.equal(bytes(file), original);
  console.log("failure: unwritable backup leaves wizards.json untouched passed");

  const dir2 = scratch("fail-bad-row");
  const bad = { ...V2_ROSTER, "chat:wrBROKEN": { name: "x", bornAt: 1, memory: [] } };
  const file2 = join(dir2, "wizards.json");
  writeFileSync(file2, JSON.stringify(bad, null, 2));
  const before2 = bytes(file2);
  const r2 = migrateIdentities(loadWizardStore(file2), file2);
  assert.equal(r2.migrated, 0);
  assert.ok(r2.skipped?.includes("invalid wizard record"));
  assert.equal(bytes(file2), before2);
  assert.ok(!r2.backup);
  console.log("failure: malformed record aborts migration without writes passed");
}

// ── 3. 同名跨群两化身互不串 (名字唯一性在身份级) ─────────────────────────
{
  const dir = scratch("manifestations");
  const file = join(dir, "wizards.json");
  const store = loadWizardStore(file);
  // 同一身份 (identity = chat:AAA#fix) 在 A、B 两个群各有一条化身, 共用名字 fix。
  store.upsert("chat:AAA#fix", { identity: "chat:AAA#fix", name: "fix", description: "A群的fix", bornAt: 1 });
  store.upsert("chat:BBB#fix", { identity: "chat:AAA#fix", name: "fix", description: "B群的fix", bornAt: 2 });

  // 不串之一: 记录按 target 各自独立 —— 两条化身谁也不吞并谁。
  assert.equal(store.get("chat:AAA#fix")?.description, "A群的fix");
  assert.equal(store.get("chat:BBB#fix")?.description, "B群的fix");
  store.upsert("chat:BBB#fix", { description: "只改B" });
  assert.equal(store.get("chat:AAA#fix")?.description, "A群的fix");
  assert.equal(store.get("chat:BBB#fix")?.description, "只改B");

  // 不串之二: byName 回到身份锚点 (target === identity 那条), 恒定可复现。
  assert.equal(store.byName("fix")?.target, "chat:AAA#fix");
  assert.equal(store.byName("fix")?.target, store.byName("fix")?.target);

  // 同身份的新化身直接领身份的名字, 不挂 -N。
  store.upsert("chat:CCC#fix", { identity: "chat:AAA#fix" });
  assert.equal(store.claim("chat:CCC#fix", "anything"), "fix");

  // 改名是身份级的: 一处改名同步全部化身。
  assert.equal(store.rename("chat:BBB#fix", "refix"), "refix");
  for (const t of ["chat:AAA#fix", "chat:BBB#fix", "chat:CCC#fix"]) {
    assert.equal(store.get(t)?.name, "refix", `${t}: 化身同步改名`);
  }
  assert.equal(store.byName("refix")?.target, "chat:AAA#fix");
  assert.equal(store.byName("fix"), undefined);

  // 别的身份撞名照旧退避: 唯一性从 wizard 级升到身份级, 不许第二个身份占同一个名字。
  store.upsert("chat:AAA#other", { name: "other", bornAt: 3 });
  const taken = store.rename("chat:AAA#other", "refix");
  assert.notEqual(taken, "refix");
  assert.ok(taken.startsWith("refix"), `foreign identity must retreat to ${taken}`);
  console.log("manifestations: distinct records, anchor byName, identity-wide rename, foreign -N passed");
}

// ── 4. 腾名字按身份算: 任一化身新鲜就不腾; 全冷才收 ──────────────────────
{
  const dir = scratch("evict");
  const now = 1800000000000;
  const mk = (): { store: WizardStore; retired: string[] } => {
    const s = loadWizardStore(join(dir, `wizards-${Math.random().toString(36).slice(2)}.json`));
    const retired: string[] = [];
    return { store: s, retired };
  };

  // 4a. 锚点冷了, 但 B 群的化身还新鲜 → 名字不腾。
  {
    const { store } = mk();
    store.upsert("chat:A#fix", { identity: "chat:A#fix", name: "fix", bornAt: 1 });
    store.upsert("chat:B#fix", { identity: "chat:A#fix", name: "fix", bornAt: 1 });
    const gone = await evictStaleName(store, "fix", [], {
      lastActivity: (t) => (t === "chat:B#fix" ? now : 0),
      retire: () => Promise.resolve({ ok: true }),
    }, now);
    assert.equal(gone, undefined);
    assert.ok(store.get("chat:A#fix") && store.get("chat:B#fix"));
  }

  // 4b. 全冷 → 身份的全部 slot 化身一起收掉。
  {
    const { store, retired } = mk();
    store.upsert("chat:A#fix", { identity: "chat:A#fix", name: "fix", bornAt: 1 });
    store.upsert("chat:B#fix", { identity: "chat:A#fix", name: "fix", bornAt: 1 });
    const gone = await evictStaleName(store, "fix", [], {
      lastActivity: () => 0,
      retire: (t) => { retired.push(t); return Promise.resolve({ ok: true }); },
    }, now);
    assert.equal(gone?.target, "chat:A#fix");
    assert.deepEqual([...retired].sort(), ["chat:A#fix", "chat:B#fix"]);
    assert.equal(store.get("chat:A#fix"), undefined);
    assert.equal(store.get("chat:B#fix"), undefined);
    assert.equal(store.byName("fix"), undefined);
  }

  // 4c. 默认会话 (untagged) 只让出名字, 记录与入口保留 —— 与旧行为一致。
  {
    const { store, retired } = mk();
    store.upsert("chat:D", { identity: "chat:D", name: "dd", bornAt: 1 });
    const gone = await evictStaleName(store, "dd", [], {
      lastActivity: () => 0,
      retire: (t) => { retired.push(t); return Promise.resolve({ ok: true }); },
    }, now);
    assert.equal(gone?.target, "chat:D");
    assert.deepEqual(retired, []);
    assert.equal(store.get("chat:D")?.name, "");
    assert.ok(store.get("chat:D"));
  }
  console.log("evict: identity-wide freshness, all-cold sweep, untagged name-release passed");
}

// ── 5. 旧账 replay: routes fold + message-events gc + 名册解析 ────────────
{
  const dir = scratch("replay");
  const file = v2File(dir);
  const store = loadWizardStore(file);
  migrateIdentities(store, file);

  // 旧 routes.jsonl 的行: owner/receiver 都是 v2 的 target 字符串 (含真实 deadline 的老形态)。
  const journal = [
    ops.open({ event: "eaa1122334", owner: "chat:wrGROUPA#fix", receiver: { kind: "chat", channel: "chat:wrGROUPB", message: "m1" }, deadlineAt: 9999999999999, at: 1 }),
    ops.open({ event: "eaa1122335", owner: "chat:wrGROUPB", receiver: { kind: "wizard", to: "chat:wrGROUPA#fix" }, deadlineAt: NO_DEADLINE, at: 2 }),
  ].map((op) => JSON.stringify(op)).join("\n");
  const { table } = foldJournal(journal);
  const rows = allRows(table);
  assert.equal(rows.length, 2);
  for (const r of rows) {
    const w = store.get(r.owner);
    assert.ok(w, `旧 routes owner ${r.owner} 在迁移后的名册里仍解析`);
    // 迁移后的读取兼容: 旧账的 owner 字符串本身就是身份 id (1:1), 归并不需要改写任何一行。
    assert.equal(identityOf(w), r.owner);
  }
  // 旧 message-events 行照常过 boot 的 gc 读取路径, 不炸。
  const events = gcEvents(1800000000000)({
    "habc0000000000001": {
      id: "habc0000000000001", target: "chat:wrGROUPB#regress", speaker: "human", channel: "chat:wrGROUPB",
      priority: "normal", deadline: NO_DEADLINE, payload: { text: "跑一下回归" },
      fingerprint: "f1", at: 1700000100000, execution: "complete", exposure: "consumed", attempts: 1, endedAt: 1700000200000,
    },
  });
  assert.equal(Object.keys(events).length, 1);

  // 对账入口 (referencedTargets) 拿到的旧 target 全部落进已迁移名册。
  const refs = referencedTargets({
    routes: rows.map((r) => ({ owner: r.owner, receiver: r.receiver })),
    events: ["chat:wrGROUPB#regress"],
    tasks: [],
    plans: [],
    live: store.all().map((w) => w.target),
  });
  for (const t of ["chat:wrGROUPA#fix", "chat:wrGROUPB", "chat:wrGROUPB#regress"]) {
    assert.ok(refs.has(t) && store.get(t), `referenced target ${t} resolvable`);
  }
  console.log("replay: old routes fold + events gc + referenced targets resolve passed");
}

rmSync(ROOT, { recursive: true, force: true });
console.log("wizard identity migration: all checks passed");
