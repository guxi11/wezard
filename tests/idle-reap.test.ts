// 空闲回收 (wrc.mirror.idleReapMin): 阈值 + 豁免矩阵 (纯函数), 外加 bridge / index 接线的源码钉。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { idleSkipReason, lastActiveOf, paneBornAt, type IdleCandidate } from "../daemon/idle-reap.js";
import { ConfigSchema } from "../shared/config.js";
import { mkdtempSync, writeFileSync, utimesSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lastRecordMs, openToolUses } from "../daemon/peers.js";

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

// ── ⑦ 刚重生的 pane 不被回收 (BobZane 每 5 分钟被杀又拉起的死循环) ──
{
  const staleTranscript = now - 304 * MIN; // transcript 最后一条真记录: 5 小时前
  const justBorn = paneBornAt(now, 29); // 29s 前 respawn
  assert.equal(justBorn, now - 29_000, "etime 折成出生时刻");
  assert.equal(paneBornAt(now, undefined), 0, "认不出年龄 → 0, 不参与取最晚");
  const young = lastActiveOf({ transcriptAt: staleTranscript, paneBornAt: justBorn });
  assert.equal(idleSkipReason(idle({ lastActiveAt: young }), now, idleMs), "recent", "旧 transcript + 刚重生 → 不收");
  // 旧 transcript + pane 早就起来了且之后毫无动静 → 照旧回收
  const old = lastActiveOf({ transcriptAt: staleTranscript, paneBornAt: paneBornAt(now, 200 * 60) });
  assert.equal(idleSkipReason(idle({ lastActiveAt: old }), now, idleMs), undefined, "旧 transcript + 旧 pane + 无新活动超过 idleReapMin → 照旧收");
  assert.equal(lastActiveOf({ seenAt: now - MIN, transcriptAt: staleTranscript, paneBornAt: 0 }), now - MIN, "三个时钟取最晚");
  assert.equal(lastActiveOf({}), 0, "全不知道 → 0 (activity unknown, 不收)");
}
assert.ok(reaper.includes("lastActiveOf(") && reaper.includes("paneBornAt(now") && reaper.includes("psSnap()"), "reapIdle 把 pane 出生时刻并进活动时钟");
assert.ok(!reaper.includes("lastRecordMs") && !reaper.includes("mtimeMs"), "仍不信外部 mtime");
assert.ok(wiring.length > 0 && idx.slice(idx.indexOf("const reapVeto"), idx.indexOf("const serialReap")).includes('"wake owed"'), "有待投唤醒行的 pane 不收");

// ── ⑧ 上一个进程留下的悬空 tool_use 不算「停在审批卡」 (唤醒贴不进去的根因) ──
{
  const dir = mkdtempSync(join(tmpdir(), "idle-reap-hang-"));
  try {
    const f = join(dir, "s.jsonl");
    const t0 = Date.parse("2026-11-22T15:13:00.165Z");
    writeFileSync(f, JSON.stringify({ type: "assistant", timestamp: "2026-11-22T15:13:00.165Z", message: { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }] } }) + "\n");
    assert.deepEqual(openToolUses(f), ["Bash"], "不给 sinceMs: 照旧悬着");
    assert.deepEqual(openToolUses(f, t0 - 1), ["Bash"], "CLI 进程在它之前启动 → 它可能在等审批, 照旧悬着");
    assert.deepEqual(openToolUses(f, t0 + 1), [], "CLI 进程在它之后才启动 (resume 出来的) → 不可能在等审批, 不算悬着");
    const g = join(dir, "nots.jsonl");
    writeFileSync(g, JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "t2", name: "Read", input: {} }] } }) + "\n");
    assert.deepEqual(openToolUses(g, t0 + 1), ["Read"], "认不出时间戳 → 朝『有人在等』的方向失败");
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
const hangingSrc = src.slice(src.indexOf("const hanging = ("), src.indexOf("const parkedNow"));
assert.ok(hangingSrc.includes("openToolUses(jsonl, startedAt)"), "hanging 只数本 CLI 进程启动之后发出的调用");
assert.ok(src.includes("live.startedAt)") && (src.match(/hanging\(target, live\.sessionId, live\.startedAt\)/g) ?? []).length === 2, "idleVerdict / parkedNow 都带上进程启动时刻");

console.log("idle-reap: 阈值 + 豁免矩阵 + 配置 + 接线全过");
