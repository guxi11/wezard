// 单元测试: shared/mem-guard.ts — 运行: npx tsx tests/mem-guard.test.ts
import assert from "node:assert";
import { ConfigSchema } from "../shared/config.js";
import { memShortfall, parseMemAvailableMb } from "../shared/mem-guard.js";

const MEMINFO = "MemTotal:        3808256 kB\nMemFree:          205824 kB\nMemAvailable:    1474560 kB\nBuffers:           12345 kB\n";

assert.strictEqual(parseMemAvailableMb(MEMINFO), 1440);
assert.strictEqual(parseMemAvailableMb("MemTotal: 1 kB\n"), undefined, "no MemAvailable line (pre-3.14 kernel) = unknown");
assert.deepStrictEqual(memShortfall(1500, 1440), { availMb: 1440, floorMb: 1500 });
assert.strictEqual(memShortfall(600, 1440), undefined, "enough memory passes");
assert.strictEqual(memShortfall(0, 10), undefined, "floor 0 disables the guard");
assert.strictEqual(memShortfall(600, undefined), undefined, "unmeasurable (non-Linux) passes");

const guard = ConfigSchema.parse({ bot: { botId: "b", secret: "s" } }).wrc.memoryGuard;
assert.deepStrictEqual(guard, { spawnMinMb: 600, spareMinMb: 1500 });
console.log("mem-guard: ok");
