// wizard 时间轴分页: 最近一页 + 游标往前翻, 同 ts 的行不跨页, 翻完无缺口无重复。
import assert from "node:assert/strict";
import { STREAM_PAGE, streamPage } from "../shared/stream-page.js";

const rows = Array.from({ length: 150 }, (_, i) => ({ id: "r" + i, ts: 1000 + i }));

// 少于一页: 全给, 没有 earlier
assert.deepEqual(streamPage(rows.slice(0, 10)), { rows: rows.slice(0, 10) });
assert.equal(streamPage(rows.slice(0, STREAM_PAGE)).earlier, undefined);

// 超过一页: 最近 limit 行 + 游标 = 本页第一行 ts
const p1 = streamPage(rows, { limit: 60 });
assert.equal(p1.rows.length, 60);
assert.equal(p1.rows[0]!.id, "r90");
assert.equal(p1.earlier, 1090);

// 按游标往前翻到头: 拼起来 = 原序列, 无缺口无重复
const p2 = streamPage(rows, { limit: 60, before: p1.earlier });
const p3 = streamPage(rows, { limit: 60, before: p2.earlier });
assert.equal(p3.earlier, undefined);
assert.deepEqual([...p3.rows, ...p2.rows, ...p1.rows].map((r) => r.id), rows.map((r) => r.id));

// limit ≤ 0 = 不分页
assert.equal(streamPage(rows, { limit: 0 }).rows.length, 150);

// 同 ts 的一组不被页边界劈开 (否则下一页 ts < 游标取不到那几行)
const ties = [...rows.slice(0, 100), { id: "t1", ts: 5000 }, { id: "t2", ts: 5000 }, { id: "t3", ts: 5000 }, ...rows.slice(100, 110).map((r) => ({ ...r, ts: r.ts + 9000 }))];
const t1 = streamPage(ties, { limit: 12 });   // 边界落在 t2 / t3 之间
assert.deepEqual(t1.rows.slice(0, 3).map((r) => r.id), ["t1", "t2", "t3"]);
const t2 = streamPage(ties, { limit: 12, before: t1.earlier });
assert.deepEqual([...t2.rows, ...t1.rows].slice(-13).map((r) => r.id).filter((x) => x.startsWith("t")), ["t1", "t2", "t3"]);

// 空
assert.deepEqual(streamPage([]), { rows: [] });
console.log("stream-page ok");
