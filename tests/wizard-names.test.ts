import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FIRSTNAMES, LASTNAMES, LAP, autoNameAt, autoOrdinalOf, fullNameAt, lapPosOf, loadAutoNames } from "../daemon/wizard-names.js";
import { loadWizardStore } from "../daemon/wizard.js";

// ── 表: 每个首字母一个, first A→Y, last A→Z ─────────────────────────────
const initials = (xs: readonly string[]): string => xs.map((x) => x[0]).join("");
assert.equal(initials(FIRSTNAMES), "ABCDEFGHIJKLMNOPQRSTUVWXY");
assert.equal(initials(LASTNAMES), "ABCDEFGHIJKLMNOPQRSTUVWXYZ");
assert.equal(LAP, 650);

// ── ① 裸名一段 ────────────────────────────────────────────────────────
assert.deepEqual([0, 1, 2, 24].map(autoNameAt), ["Alice", "Bob", "Carol", "Yara"]);

// ── ② 全名一段: 甲子式对角, aa 之后是 bb ───────────────────────────────
assert.deepEqual([25, 26, 27, 28, 29].map(autoNameAt), ["AliceAdams", "BobBrown", "CarolClark", "DavidDavis", "EmmaEvans"]);
assert.equal(autoNameAt(25 + 24), "YaraYoung");
assert.equal(autoNameAt(25 + 25), "AliceZane", "first 先走完一圈, last 还差一格");
assert.equal(autoNameAt(25 + 26), "BobAdams", "last 走完一圈回到 A");
assert.equal(autoNameAt(25 + 649), "YaraZane");
const lap = Array.from({ length: LAP }, (_, k) => fullNameAt(k));
assert.equal(new Set(lap).size, LAP, "一轮 650 个两两不同 = 覆盖全部组合");
assert.equal(fullNameAt(LAP), fullNameAt(0), "走满一轮回到起点");
for (let k = 0; k < LAP; k++) {
  const i = k % 25, j = k % 26;
  assert.equal(lapPosOf(i, j), k);
  assert.equal(fullNameAt(k + 1), FIRSTNAMES[(i + 1) % 25] + LASTNAMES[(j + 1) % 26], "两个下标一起前进");
}

// ── ③ 带 index 一段: 只在上一轮走完后 +1, base36 ───────────────────────
const third = 25 + LAP;
assert.equal(autoNameAt(third - 1), "YaraZane");
assert.equal(autoNameAt(third), "AliceAdams0");
assert.equal(autoNameAt(third + 1), "BobBrown0");
assert.equal(autoNameAt(third + LAP - 1), "YaraZane0");
assert.equal(autoNameAt(third + LAP), "AliceAdams1");
assert.equal(autoNameAt(third + 10 * LAP), "AliceAdamsA");
assert.equal(autoNameAt(third + 35 * LAP + LAP - 1), "YaraZaneZ");
assert.equal(autoNameAt(third + 36 * LAP), "AliceAdams10", "第 37 轮才变两位");
assert.equal(autoNameAt(third + 36 * 36 * LAP), "AliceAdams100");
assert.throws(() => autoNameAt(-1));
assert.throws(() => autoNameAt(1.5));

// ── 反解 ────────────────────────────────────────────────────────────────
const many = Array.from({ length: 25 + LAP * 40 }, (_, o) => autoNameAt(o));
assert.equal(new Set(many.map((x) => x.toLowerCase())).size, many.length, "大小写折叠后也不重");
many.forEach((x, o) => assert.equal(autoOrdinalOf(x), o, `roundtrip ${x}`));
for (const o of [third + 36 * LAP + 7, third + 1296 * LAP + 649, 10 ** 9]) assert.equal(autoOrdinalOf(autoNameAt(o)), o);
for (const x of ["MayaCarter", "Zoe", "AliceAdams-2", "AliceAdams00", "AliceAdams01", "AliceAdamsa", "aliceadams", "Alicex", ""]) {
  assert.equal(autoOrdinalOf(x), undefined, `not auto: ${x}`);
}

// ── 分配: 游标只进不退, 被占的跳过并消耗, 永不复用 ─────────────────────
const dir = mkdtempSync(join(tmpdir(), "wizard-names-"));
try {
  const seq = join(dir, "seq.json");
  const next = loadAutoNames(seq);
  assert.equal(next(), "Alice");
  assert.equal(next((n) => n === "Bob"), "Carol", "被占的跳过");
  assert.equal(next(), "David", "跳过的不回头");
  assert.deepEqual(JSON.parse(readFileSync(seq, "utf8")), { version: 4, next: 4 });
  assert.equal(loadAutoNames(seq)(), "Emma", "游标落盘");

  // 三段边界
  writeFileSync(seq, JSON.stringify({ version: 4, next: 24 }));
  const edge = loadAutoNames(seq);
  assert.deepEqual([edge(), edge()], ["Yara", "AliceAdams"]);
  writeFileSync(seq, JSON.stringify({ version: 4, next: third - 1 }));
  const carry = loadAutoNames(seq);
  assert.deepEqual([carry(), carry()], ["YaraZane", "AliceAdams0"]);

  // v2 / v3 的游标是别的序, 不迁移: 从头开始, 活着的同名靠 occupied 跳过
  for (const old of [{ version: 2, next: 168 }, { version: 3, next: 9 }]) {
    writeFileSync(seq, JSON.stringify(old));
    assert.equal(loadAutoNames(seq)((n) => n === "Alice"), "Bob");
    assert.deepEqual(JSON.parse(readFileSync(seq, "utf8")), { version: 4, next: 2 });
  }
  for (const bad of [{ version: 5, next: 0 }, { version: 4 }, { version: 4, next: -1 }, { version: 4, next: 0, extra: 1 }]) {
    writeFileSync(seq, JSON.stringify(bad));
    assert.throws(() => loadAutoNames(seq), /invalid wizard name sequence/);
  }

  // 注册表: 大小写不敏感地避开已占; drop 之后名字不回来
  const file = join(dir, "wizards.json");
  const store = loadWizardStore(file);
  store.upsert("chat:a#legacy", { name: "alice" });
  const born = store.nextName();
  assert.equal(born, "Bob");
  store.upsert(`chat:a#${born}`, { name: born });
  store.drop(`chat:a#${born}`);
  assert.equal(store.nextName(), "Carol", "forget 过的名字不复用");
  assert.equal(loadWizardStore(file).nextName(), "David");
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log("wizard-names: ok");
