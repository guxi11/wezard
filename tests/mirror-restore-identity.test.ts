// 单测: restore 的 pane 认领/认回判据 + 静默 heal 退役 (2026-11-19)
// 运行: npx tsx tests/mirror-restore-identity.test.ts
//
// 现场: tmux server 重启后 pane id 从 %0 重新编号, 旧绑定里的 %N 可能落到别人的 pane 上;
// 以及 restore 在「pane 没了 + transcript 也没了」时曾把项目目录里最新、没人绑的 jsonl
// 认领成自己的 —— 那常常是别人的 sid, 于是这一群的镜像接到别人头上。
// 这里钉四件事: ① 绑定存窗口名+pid, restore 按它们核对 (%N 还是原来那块 pane 吗);
// ② %N 失效后按「注册表 sid / 窗口名+pid」认回, 窗口名单独永远不认; ③ 不再 heal,
// 丢失时保留绑定 + 人可见提示 (去重), 绝不静默改绑/静默新开; ④ pane cap 对最近活跃的
// target 只 detach 不 kill, 孤儿清扫放过 store 还绑着的 pane。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { paneIdentityMatches, paneReclaimMatches } from "../daemon/mirror-store.js";

// ── ① 纯判据: %N 核对 ──
// 老记录 (两样都没存): 只认 pane id, 向后兼容。
assert.equal(paneIdentityMatches({}, undefined), true, "老记录无身份字段 → 通过 (仅凭 pane id)");
assert.equal(paneIdentityMatches({}, { window: "w", pid: "1" }), true, "老记录 + 有 meta → 通过");
// 存了身份: 必须窗口名与 pid 都对上。
const rec = { tmuxWindow: "wezard-alice", tmuxPid: "4242" };
assert.equal(paneIdentityMatches(rec, { window: "wezard-alice", pid: "4242" }), true, "窗口名+pid 都对上 → 通过");
assert.equal(paneIdentityMatches(rec, { window: "wezard-bob", pid: "4242" }), false, "窗口名对不上 (id 被重发号) → 拒");
assert.equal(paneIdentityMatches(rec, { window: "wezard-alice", pid: "9999" }), false, "pid 对不上 → 拒");
assert.equal(paneIdentityMatches(rec, undefined), false, "问不出 meta → 拒 (不猜)");
assert.equal(paneIdentityMatches({ tmuxWindow: "wezard-alice" }, { window: "wezard-alice", pid: "" }), true,
  "只存了窗口名: 只核窗口名");
assert.equal(paneIdentityMatches({ tmuxPid: "4242" }, { window: "", pid: "4242" }), true, "只存了 pid: 只核 pid");

// ── ② 纯判据: %N 失效后的认回 ──
const tree = (root: number, want: number): boolean => root === 100 && want === 4242; // 假树: 100 下挂着 4242
// 窗口名对上 + shell pid 等值 → 认回。
assert.equal(paneReclaimMatches({ tmuxWindow: "w", tmuxPid: "100" }, { window: "w", pid: "100" }, tree), true,
  "窗口名+shell pid 等值 → 认回");
// 窗口名对上 + 存过的 CLI pid 在候选 pane 的进程树里 → 认回 (codebuddy 注册表无 tmux 字段的补充判据)。
assert.equal(paneReclaimMatches({ tmuxWindow: "w", cliPid: 4242 }, { window: "w", pid: "100" }, tree), true,
  "窗口名+CLI pid 在进程树里 → 认回");
// 窗口名单独猜, 一律不认。
assert.equal(paneReclaimMatches({ tmuxWindow: "w" }, { window: "w", pid: "100" }, tree), false,
  "只有窗口名对上 → 不认 (绝不按名字串门)");
// 存过窗口名就必须对上: pid 等值也救不回来。
assert.equal(paneReclaimMatches({ tmuxWindow: "other", tmuxPid: "100" }, { window: "w", pid: "100" }, tree), false,
  "存过窗口名且对不上 → 不认");
assert.equal(paneReclaimMatches({ tmuxWindow: "w", cliPid: 1 }, { window: "w", pid: "100" }, tree), false,
  "CLI pid 不在候选树里 → 不认");
// 没存窗口名时 shell pid 等值 (精确) 可以认; 两样都没存的老记录不认回 (退化到原行为)。
assert.equal(paneReclaimMatches({ tmuxPid: "100" }, { window: "whatever", pid: "100" }, tree), true,
  "没存窗口名, shell pid 等值 → 认回");
assert.equal(paneReclaimMatches({}, { window: "w", pid: "100" }, tree), false, "老记录无凭据 → 不认回");

// ── ③ 源码钉: 静默 heal 退役 + 保留绑定 + 人可见提示 ──
const src = readFileSync(new URL("../daemon/mirror-bridge.ts", import.meta.url), "utf8");
const restore = (() => {
  const a = src.indexOf("const restoreFromStore = async");
  const b = src.indexOf("// We re-attach lazily on demand too", a);
  assert.ok(a >= 0 && b > a, "restoreFromStore 切片");
  return src.slice(a, b);
})();
assert.ok(!restore.includes("latestJsonlForCwd"), "restore 段不再 heal (latestJsonlForCwd 已退出 restore)");
assert.ok(!restore.includes("healed to latest unclaimed"), "不再有「认领目录里最新会话」的日志");
assert.ok(!restore.includes("deps.store.drop(principal)"), "丢失时不再悄悄丢绑定 (静默新开)");
assert.ok(restore.includes("keeping binding, resume will fail visibly"), "pane 没了 + transcript 没了 → 保留绑定, --resume 由 CLI 报错");
assert.ok(restore.includes("notifySessionLost(restored)"), "懒恢复时发人可见的丢失提示");
assert.ok(src.includes("mirror-lost-notices.json"), "丢失提示按 (target,sid) 去重 (state 文件)");

// ── ③b 源码钉: %N 失效后的认回 ──
assert.ok(restore.includes("paneByIdentity(rec, jsonlAbs)"), "%N 认不到先按身份认回原 pane");
assert.ok(src.includes("认回原 pane (免 respawn 换代)"), "认回要留痕 (日志)");
assert.ok(src.includes("sessionBySid"), "注册表 sid 是认回的最强判据");
assert.ok(restore.includes("paneIdentityMatches"), "restore 用窗口名+pid 核对 pane 还是不是原来那块");

// ── ③c 源码钉: 绑定补存 ──
assert.ok(src.includes("#{pane_id}\\t#{pane_current_path}\\t#{window_name}\\t#{pane_pid}"),
  "boot 快照带上 window_name / pane_pid");
assert.ok(src.includes("refreshPaneIdentity"), "attach/respawn 后异步补存窗口名+pid+CLI pid");
const store = readFileSync(new URL("../daemon/mirror-store.ts", import.meta.url), "utf8");
assert.ok(store.includes("tmuxWindow?: string") && store.includes("tmuxPid?: string") && store.includes("cliPid?: number"),
  "持久化记录有 tmuxWindow/tmuxPid/cliPid");

// ── ④ 源码钉: pane cap 对最近活跃只 detach; 孤儿清扫放过 store 绑定的 pane ──
const reaper = (() => {
  const a = src.indexOf("reapOverflow: async (max, skip)");
  const b = src.indexOf("submitPane: async (target)", a);
  assert.ok(a >= 0 && b > a, "reapOverflow 切片");
  return src.slice(a, b);
})();
assert.ok(reaper.includes("RECENT_TALK_MS") && reaper.includes("pane cap (recent)"),
  "最近活跃 (<24h) 的 target 只 detach 不 kill");
assert.ok(reaper.includes("storeBoundPanes.has(pane)"), "孤儿清扫放过 store 还绑着的 pane (detach-only 的前提)");
console.log("mirror-restore-identity: 判据矩阵 + 认回 + heal 退役 + 人可见提示 + reaper 全过");
