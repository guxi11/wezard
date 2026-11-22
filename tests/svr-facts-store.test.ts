// 单元测试: svr/facts-store.ts — 运行: npx tsx tests/svr-facts-store.test.ts
import assert from "node:assert";
import { mkdtempSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadFacts, saveFacts } from "../svr/facts-store.js";
import { EMPTY_FACTS } from "../shared/world.js";

const dir = mkdtempSync(join(tmpdir(), "facts-"));
const p = join(dir, "facts.json");
const facts = { ...EMPTY_FACTS, wizards: [] };
const NOW = 1_000_000, TTL = 150_000;

assert.deepStrictEqual(loadFacts(join(dir, "none.json"), NOW, TTL).size, 0); // 缺失
saveFacts(p, new Map([["a", { at: NOW - 10_000, facts }], ["old", { at: NOW - TTL - 1, facts }]]));
const r = loadFacts(p, NOW, TTL);
assert.deepStrictEqual([...r.keys()], ["a"]); // 写后读回 + 过期被丢
assert.strictEqual(r.get("a")!.at, NOW - 10_000);
saveFacts(p, new Map([["edge", { at: NOW - TTL, facts }], ["in", { at: NOW - TTL + 1, facts }]]));
assert.deepStrictEqual([...loadFacts(p, NOW, TTL).keys()], ["in"]); // 边界: at == now-ttl 过期
writeFileSync(p, "{not json");
assert.strictEqual(loadFacts(p, NOW, TTL).size, 0); // 损坏
writeFileSync(p, JSON.stringify({ x: { at: "no" }, y: 3 }));
assert.strictEqual(loadFacts(p, NOW, TTL).size, 0); // 形状不对
assert.ok(!readdirSync(dir).some((f) => f.endsWith(".tmp"))); // 无残留临时文件
console.log("ok svr-facts-store");
