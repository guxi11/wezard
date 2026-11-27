// peers.ts 的尾读缓存: 文件没动 = 命中 (不再读不再解析); 追加 / 截断 = 立刻失效读到新值; 容量有界 (LRU)。
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cacheTtlSec, contextMaterials, lastContextTokens, lastExchange, lastModel, makeStatMemo,
  peersMemoClear, peersMemoStats, recentAsks, summarizeTail,
} from "../daemon/peers.js";

const dir = mkdtempSync(join(tmpdir(), "peers-memo-"));
const path = join(dir, "s.jsonl");
let ts = Date.parse("2026-11-27T10:00:00Z");
const stamp = (): string => new Date((ts += 1000)).toISOString();
const user = (text: string): string =>
  JSON.stringify({ type: "user", timestamp: stamp(), message: { role: "user", content: text } }) + "\n";
const asst = (text: string, model = "claude-sonnet-5-5", input = 1000): string =>
  JSON.stringify({
    type: "assistant", timestamp: stamp(),
    message: { role: "assistant", model, stop_reason: "end_turn", content: [{ type: "text", text }],
      usage: { input_tokens: input, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, cache_creation: { ephemeral_1h_input_tokens: 10 } } },
  }) + "\n";

try {
  writeFileSync(path, user("问题一") + asst("答案一", "claude-sonnet-5-5", 1000));
  peersMemoClear();

  // 第一次: 全 miss, 读到的值正确。
  assert.match(lastExchange(path, 80), /▸ 问题一 ◂ 答案一/);
  assert.equal(lastModel(path), "claude-sonnet-5-5");
  assert.equal(lastContextTokens(path), 1000);
  assert.equal(cacheTtlSec(path), 3600);
  assert.deepEqual(recentAsks(path, 12), ["问题一"]);
  assert.match(summarizeTail(path, 3, 80), /你: 问题一 · AI: 答案一/);
  contextMaterials(path);
  const afterFirst = peersMemoStats();
  assert.equal(afterFirst.scalar.hits, 0, "第一次不可能命中");
  assert.equal(afterFirst.scalar.misses, 6);
  assert.equal(afterFirst.materials.misses, 1);

  // 文件没动: 全命中, 值不变, 且不新增 miss。
  assert.match(lastExchange(path, 80), /▸ 问题一 ◂ 答案一/);
  assert.equal(lastModel(path), "claude-sonnet-5-5");
  assert.equal(lastContextTokens(path), 1000);
  assert.equal(cacheTtlSec(path), 3600);
  assert.deepEqual(recentAsks(path, 12), ["问题一"]);
  assert.match(summarizeTail(path, 3, 80), /你: 问题一/);
  contextMaterials(path);
  const afterSecond = peersMemoStats();
  assert.equal(afterSecond.scalar.hits, 6, "未变 = 6 个全命中");
  assert.equal(afterSecond.scalar.misses, 6, "没有新增 miss");
  assert.equal(afterSecond.materials.hits, 1);

  // 参数不同是不同的键: per 变了不能拿到旧的截断结果。
  assert.notEqual(lastExchange(path, 2), lastExchange(path, 80), "不同 per 各算各的");

  // 追加: size / mtime 变 → 立刻读到新值。
  appendFileSync(path, user("问题二") + asst("答案二", "claude-opus-5-5", 4321));
  assert.match(lastExchange(path, 80), /▸ 问题二 ◂ 答案二/, "追加后读到新一轮");
  assert.equal(lastModel(path), "claude-opus-5-5", "模型换了读到新的");
  assert.equal(lastContextTokens(path), 4321, "ctx 读到新的");
  assert.deepEqual(recentAsks(path, 12), ["问题一", "问题二"]);
  assert.match(summarizeTail(path, 3, 80), /问题二/);

  // 同 mtime、只有 size 变 (同一毫秒的追加): 照样失效。
  const mtimeBefore = (await import("node:fs")).statSync(path).mtime;
  appendFileSync(path, user("问题三"));
  utimesSync(path, mtimeBefore, mtimeBefore);
  assert.deepEqual(recentAsks(path, 12), ["问题一", "问题二", "问题三"], "mtime 没变, size 变了也要失效");

  // 返回的数组是副本: 调用方改它不污染缓存。
  const a1 = recentAsks(path, 12); a1.push("脏");
  assert.equal(recentAsks(path, 12).length, 3, "recentAsks 返回副本");
  const m1 = contextMaterials(path); m1.push({} as never);
  assert.equal(contextMaterials(path).length, 0, "contextMaterials 返回副本");

  // 不存在的路径: 不缓存、不抛, 走原有「没有 transcript」的分支。
  const ghost = join(dir, "nope.jsonl");
  assert.equal(lastModel(ghost), "");
  assert.equal(lastContextTokens(ghost), 0);
  assert.equal(summarizeTail(ghost, 3, 80), "(新会话 · 暂无对话)");
  peersMemoClear();
  const before = peersMemoStats().scalar;
  assert.equal(before.size, 0, "clear 后清空");

  // LRU 有界: 容量 3, 写 5 个 key 只留最近 3 个; 命中会刷新新近度。
  const f = join(dir, "lru.jsonl"); writeFileSync(f, "x");
  const memo = makeStatMemo<number>(3);
  let computed = 0;
  const get = (k: string): number => memo.get(k, f, () => (computed += 1));
  ["a", "b", "c"].forEach(get);
  get("a"); // a 变最近; 淘汰顺序 b → c → a
  get("d"); // 淘汰 b
  assert.equal(memo.stats().size, 3, "不超过容量");
  const c0 = computed;
  get("a"); get("c"); get("d");
  assert.equal(computed, c0, "a / c / d 仍在");
  get("b");
  assert.equal(computed, c0 + 1, "b 已被淘汰, 要重算");
  for (let i = 0; i < 50; i++) get("k" + i);
  assert.equal(memo.stats().size, 3, "无论写多少都不超容量");

  console.log("peers-memo ok");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
