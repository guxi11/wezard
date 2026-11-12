// 单元测试: shared/json-map-store.ts 的同值不落盘与膨胀回调 — 运行: npx tsx tests/json-map-store.test.ts
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadJsonMap } from "../shared/json-map-store.js";

let passed = 0;
let failed = 0;
const t = (name: string, fn: () => void): void => {
  try {
    fn();
    passed++;
    console.log(`ok    ${name}`);
  } catch (e) {
    failed++;
    console.error(`FAIL  ${name}: ${(e as Error).message}`);
  }
};

const dir = mkdtempSync(join(tmpdir(), "wezard-json-map-"));
const file = join(dir, "map.json");
const mtime = (): bigint => statSync(file, { bigint: true }).mtimeNs;

try {
  t("同值 set / merge 不落盘", () => {
    let writes = 0;
    const db = loadJsonMap<{ n: number }>(file, undefined, { warnBytes: 0, onLarge: () => { writes++; } });
    db.set("a", { n: 1 });
    assert.equal(writes, 1);
    const at = mtime();
    const text = readFileSync(file, "utf8");
    db.set("a", { n: 1 });
    db.set("a", { n: 1 });
    db.merge({ a: { n: 1 } });
    assert.equal(writes, 1, "同值写入不该再落盘");
    assert.equal(mtime(), at, "mtime 不该变");
    assert.equal(readFileSync(file, "utf8"), text);
  });

  t("merge 只写真正变了的那几行, 全同则整次不写", () => {
    const db = loadJsonMap<{ n: number }>(file, undefined, { warnBytes: 0, onLarge: () => undefined });
    db.merge({ a: { n: 1 }, b: { n: 2 } });
    const at = mtime();
    db.merge({ a: { n: 1 }, b: { n: 2 } });
    assert.equal(mtime(), at);
    db.merge({ a: { n: 1 }, b: { n: 3 } });
    assert.notEqual(mtime(), at);
    assert.deepStrictEqual(JSON.parse(readFileSync(file, "utf8")), { a: { n: 1 }, b: { n: 3 } });
  });

  t("超过 warnBytes 才回调 onLarge", () => {
    const seen: number[] = [];
    const small = loadJsonMap<{ s: string }>(join(dir, "small.json"), undefined, { warnBytes: 1024, onLarge: (b) => seen.push(b) });
    small.set("a", { s: "x" });
    assert.deepStrictEqual(seen, []);
    const big = loadJsonMap<{ s: string }>(join(dir, "big.json"), undefined, { warnBytes: 16, onLarge: (b) => seen.push(b) });
    big.set("a", { s: "y".repeat(64) });
    assert.equal(seen.length, 1);
    assert.ok(seen[0]! > 16);
  });

  t("strict 库同值也不重写", () => {
    const f = join(dir, "strict.json");
    const db = loadJsonMap<{ n: number }>(f, undefined, { strict: true });
    db.set("k", { n: 1 });
    const at = statSync(f, { bigint: true }).mtimeNs;
    db.set("k", { n: 1 });
    assert.equal(statSync(f, { bigint: true }).mtimeNs, at);
  });
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
