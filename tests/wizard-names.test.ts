import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FIRSTNAMES, LASTNAMES, ROUND, autoNameAt, autoOrdinalOf, loadAutoNames, roundSuffix } from "../daemon/wizard-names.js";
import { loadWizardStore } from "../daemon/wizard.js";

// ── 表: 每个首字母一个, first A→Y, last A→Z ─────────────────────────────
const initials = (xs: readonly string[]): string => xs.map((x) => x[0]).join("");
assert.equal(initials(FIRSTNAMES), "ABCDEFGHIJKLMNOPQRSTUVWXY");
assert.equal(initials(LASTNAMES), "ABCDEFGHIJKLMNOPQRSTUVWXYZ");
assert.equal(ROUND, 650);

// ── 口径: 首字母即坐标, 第 n 个 (1 起) = ordinal n-1 ───────────────────
assert.equal(autoNameAt(0), "AliceAdams");
assert.equal(autoNameAt(31), "BobFord");
assert.equal(autoNameAt(499), "TessFord");
assert.equal(autoNameAt(649), "YaraZane");
assert.equal(autoNameAt(650), "AliceAdams0");
assert.equal(autoNameAt(650 * 36 + 649), "YaraZaneZ");
assert.equal(autoNameAt(650 * 37), "AliceAdams00");
assert.equal(autoNameAt(650 * (37 + 36 * 36)), "AliceAdams000");
assert.deepEqual([0, 1, 10, 36, 37, 38, 36 + 36 * 36, 37 + 36 * 36].map(roundSuffix), ["", "0", "9", "Z", "00", "01", "ZZ", "000"]);
assert.throws(() => autoNameAt(-1));
assert.throws(() => autoNameAt(1.5));

// ── 每一轮内严格字典序 (大小写折叠后亦然), 轮与轮之间名字不重 ─────────
const lap = (r: number): string[] => Array.from({ length: ROUND }, (_, i) => autoNameAt(r * ROUND + i));
for (const r of [0, 1, 36, 37, 1333]) {
  const xs = lap(r);
  assert.ok(xs.every((x, i) => i === 0 || xs[i - 1]! < x), `round ${r} lexicographic`);
  assert.ok(xs.every((x, i) => i === 0 || xs[i - 1]!.toLowerCase() < x.toLowerCase()), `round ${r} folded`);
}
const many = Array.from({ length: ROUND * 40 }, (_, i) => autoNameAt(i).toLowerCase());
assert.equal(new Set(many).size, many.length);

// ── 反解 ────────────────────────────────────────────────────────────────
for (const o of [0, 31, 499, 649, 650, 651, 650 * 36 + 649, 650 * 37, 650 * 37 + 123, 650 * 1400 + 7]) {
  assert.equal(autoOrdinalOf(autoNameAt(o)), o, `roundtrip ${o}`);
}
for (const x of ["Alice", "MayaCarter", "Zoe", "AliceAdams-2", "AliceAdamsa", "aliceadams", "Bob", ""]) {
  assert.equal(autoOrdinalOf(x), undefined, `not auto: ${x}`);
}

// ── 分配: 游标只进不退, 被占的跳过并消耗, 永不复用 ─────────────────
const dir = mkdtempSync(join(tmpdir(), "wizard-names-"));
try {
  const seq = join(dir, "seq.json");
  const next = loadAutoNames(seq);
  assert.equal(next(), "AliceAdams");
  assert.equal(next((n) => n === "AliceBrown"), "AliceClark", "被占的跳过");
  assert.equal(next(), "AliceDavis", "跳过的不回头");
  assert.deepEqual(JSON.parse(readFileSync(seq, "utf8")), { version: 3, next: 4 });
  assert.equal(loadAutoNames(seq)(), "AliceEvans", "游标落盘");

  // 第一轮用完自动进位, 不会耗尽
  writeFileSync(seq, JSON.stringify({ version: 3, next: 649 }));
  const lap = loadAutoNames(seq);
  assert.deepEqual([lap(), lap()], ["YaraZane", "AliceAdams0"]);
  writeFileSync(seq, JSON.stringify({ version: 3, next: 650 * 37 - 1 }));
  const carry = loadAutoNames(seq);
  assert.deepEqual([carry(), carry()], ["YaraZaneZ", "AliceAdams00"]);

  // v2 (旧 31×37 对角序) 的游标不迁移, 从头开始, 活着的同名靠 occupied 跳过
  writeFileSync(seq, JSON.stringify({ version: 2, next: 168 }));
  assert.equal(loadAutoNames(seq)((n) => n === "AliceAdams"), "AliceBrown");
  assert.deepEqual(JSON.parse(readFileSync(seq, "utf8")), { version: 3, next: 2 });
  for (const bad of [{ version: 4, next: 0 }, { version: 3 }, { version: 3, next: -1 }, { version: 3, next: 0, extra: 1 }]) {
    writeFileSync(seq, JSON.stringify(bad));
    assert.throws(() => loadAutoNames(seq), /invalid wizard name sequence/);
  }

  // 注册表: 大小写不敏感地避开已占; drop 之后名字不回来
  const file = join(dir, "wizards.json");
  const store = loadWizardStore(file);
  store.upsert("chat:a#legacy", { name: "aliceadams" });
  const born = store.nextName();
  assert.equal(born, "AliceBrown");
  store.upsert(`chat:a#${born}`, { name: born });
  store.drop(`chat:a#${born}`);
  assert.equal(store.nextName(), "AliceClark", "forget 过的名字不复用");
  assert.equal(loadWizardStore(file).nextName(), "AliceDavis");
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log("wizard-names: ok");
