// 空闲回收 (wrc.mirror.idleReapMin): 阈值 + 豁免矩阵 (纯函数), 外加 bridge / index 接线的源码钉。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { idleSkipReason, type IdleCandidate } from "../daemon/idle-reap.js";
import { ConfigSchema } from "../shared/config.js";
import { mkdtempSync, writeFileSync, utimesSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lastRecordMs } from "../daemon/peers.js";

const MIN = 60_000;
const now = 1_000_000_000_000;
const idleMs = 60 * MIN;
const idle = (over: Partial<IdleCandidate> = {}): IdleCandidate => ({
  lastActiveAt: now - 61 * MIN, watched: false, inFlight: false, ...over,
});

// ── ① 阈值 ──
assert.equal(idleSkipReason(idle(), now, idleMs), undefined, "闲过 61 分钟 → 收");
assert.equal(idleSkipReason(idle({ lastActiveAt: now - 60 * MIN }), now, idleMs), undefined, "恰好到阈值 → 收");
assert.equal(idleSkipReason(idle({ lastActiveAt: now - 59 * MIN }), now, idleMs), "recent", "59 分钟 → 不收");
assert.equal(idleSkipReason(idle({ lastActiveAt: now - 10 * MIN }), now, 5 * MIN), undefined, "阈值按传入的 idleMs (热改)");
assert.equal(idleSkipReason(idle(), now, 0), "disabled", "0 = 关闭");
assert.equal(idleSkipReason(idle({ lastActiveAt: 0 }), now, idleMs), "activity unknown", "不知道最后活动 → 不收");

// ── ② 豁免 (即使早已闲过阈值) ──
assert.equal(idleSkipReason(idle({ veto: "owns scheduled task" }), now, idleMs), "owns scheduled task", "名下有定时任务");
assert.equal(idleSkipReason(idle({ veto: "pending approval" }), now, idleMs), "pending approval", "挂着审批");
assert.equal(idleSkipReason(idle({ watched: true }), now, idleMs), "watched", "人正 attach 着看");
assert.equal(idleSkipReason(idle({ inFlight: true }), now, idleMs), "in flight", "正在出生 / 有注入在途");

// ── ③ 配置: 默认 60, 热生效 ──
const cfg = ConfigSchema.parse({ bot: { botId: "b", secret: "s" } });
assert.equal(cfg.wrc.mirror.idleReapMin, 60, "idleReapMin 默认 60 分钟");
const conf = readFileSync(new URL("../shared/config.ts", import.meta.url), "utf8");
assert.match(conf, /idleReapMin: hot\(/, "idleReapMin 标记为热生效");

// ── ④ 源码钉: bridge 侧 ──
const src = readFileSync(new URL("../daemon/mirror-bridge.ts", import.meta.url), "utf8");
const reaper = (() => {
  const a = src.indexOf("reapIdle: async (idleMs, skip)");
  const b = src.indexOf("reapUnborn: async (names)", a);
  assert.ok(a >= 0 && b > a, "reapIdle 切片");
  return src.slice(a, b);
})();
assert.ok(reaper.includes("seenAt.get(target)") && reaper.includes("transcriptActiveAt(target)") && !reaper.includes("mtimeMs"), "空闲 = 本进程见到的活动与 transcript 最后一条真记录取晚者, 不看 mtime");
assert.ok(reaper.includes("putDownPane(pane"), "kill 前过 putDownPane (截屏判忙 + watched)");
assert.ok(reaper.includes("skip?.(target, sessionId)"), "外部否决 (任务 / 审批) 生效");
assert.ok(reaper.includes("queues.has(sessionId)") && reaper.includes("spawningPanes.has(pane)"), "出生中 / 注入在途不收");
assert.ok(!reaper.includes("store.drop") && !reaper.includes("downPane("), "只收 pane, 不动绑定");
const putDown = src.slice(src.indexOf("const putDownPane = async"), src.indexOf("const putDownPane = async") + 800);
assert.ok(putDown.includes("paneIsBusy("), "putDownPane 截屏判忙");
assert.ok(/const onItem = \(a: AttachState, item: RenderItem\): void => \{\s*touch\(a\.target\);/.test(src), "tail 每条条目 (含 turn_end) 都刷新活动时钟");
assert.equal((src.match(/touch\((?:a\.)?target\);\s*rememberInject\(/g) ?? []).length, 2, "两条注入路径落 pane 前刷新活动时钟");

// ── ⑤ 源码钉: index 接线现读配置 ──
const idx = readFileSync(new URL("../daemon/index.ts", import.meta.url), "utf8");
const wiring = idx.slice(idx.indexOf("const idleSweep = (): void => {"), idx.indexOf("setInterval(idleSweep"));
assert.ok(wiring.includes("cfg.wrc.mirror.idleReapMin"), "每轮现读 idleReapMin (热生效)");
assert.ok(wiring.includes("reapVeto()"), "与 maxPanes 共用豁免");
assert.ok(!/notify|sendText|replyStream|sendMessage/.test(wiring), "只打日志, 不往群里发");

// ── ⑥ 活动时刻取 transcript 最后一条真记录, 不取 mtime (本次根因) ──
{
  const dir = mkdtempSync(join(tmpdir(), "idle-reap-"));
  try {
    const f = join(dir, "s.jsonl");
    const real = "2026-11-22T03:46:28.758Z";
    writeFileSync(f, [
      { type: "assistant", timestamp: real, message: { role: "assistant", content: [] } },
      { type: "system", subtype: "turn_duration", timestamp: real },
      { type: "data-flow-records", v: 1 },
      { type: "mode", mode: "normal" },
      { type: "last-prompt", lastPrompt: "x" },
    ].map((r) => JSON.stringify(r)).join("\n") + "\n");
    utimesSync(f, new Date(), new Date()); // 外部把闲置会话碰新: mtime = 此刻
    assert.equal(lastRecordMs(f), Date.parse(real), "元数据行 / mtime 都不算活动, 取最后一条带时间戳的记录");
    const g = join(dir, "fresh.jsonl");
    writeFileSync(g, JSON.stringify({ type: "mode", mode: "normal" }) + "\n");
    assert.equal(lastRecordMs(g), 0, "没说过话的会话没有带时间戳的记录 → 0 (调用方回落 mtime)");
    assert.equal(lastRecordMs(join(dir, "missing.jsonl")), 0, "读不到 → 0");
    const h = join(dir, "numeric.jsonl");
    writeFileSync(h, JSON.stringify({ type: "assistant", timestamp: 1_700_000_000_000 }) + "\n");
    assert.equal(lastRecordMs(h), 1_700_000_000_000, "CodeBuddy 的数字时间戳");
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
assert.ok(/const mtimeOf = \(target: string\): number => transcriptActiveAt\(target\) \|\| now;/.test(src), "pane 上限的「最久没动」排序同口径");
assert.ok(idx.slice(idx.indexOf("const idleSweep"), idx.indexOf("setInterval(idleSweep")).includes('"idle reap sweep"') && !/if \(r\.reaped\.length\) log\.info/.test(wiring), "每轮清扫都留日志");

console.log("idle-reap: 阈值 + 豁免矩阵 + 配置 + 接线全过");
