// 单测: restore 的 pane 认领判据 + 静默 heal 退役 (2026-11-19)
// 运行: npx tsx tests/mirror-restore-identity.test.ts
//
// 现场: tmux server 重启后 pane id 从 %0 重新编号, 旧绑定里的 %N 可能落到别人的 pane 上;
// 以及 restore 在「pane 没了 + transcript 也没了」时曾把项目目录里最新、没人绑的 jsonl
// 认领成自己的 —— 那常常是别人的 sid, 于是这一群的镜像接到别人头上。
// 这里钉两件事: ① 绑定存窗口名+pid, restore 按它们核对; ② 不再 heal, 直接丢绑定。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { paneIdentityMatches } from "../daemon/mirror-store.js";

// ── ① 纯判据 ──
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

// ── ② 源码钉: 静默 heal 退役 + 绑定补存 ──
const src = readFileSync(new URL("../daemon/mirror-bridge.ts", import.meta.url), "utf8");
const restore = (() => {
  const a = src.indexOf("const restoreFromStore = async");
  const b = src.indexOf("// We re-attach lazily on demand too", a);
  assert.ok(a >= 0 && b > a, "restoreFromStore 切片");
  return src.slice(a, b);
})();
assert.ok(!restore.includes("latestJsonlForCwd"), "restore 段不再 heal (latestJsonlForCwd 已退出 restore)");
assert.ok(!restore.includes("healed to latest unclaimed"), "不再有「认领目录里最新会话」的日志");
assert.ok(restore.includes("no sid heal"), "pane 没了 + transcript 没了 → fail-closed 丢绑定 (留痕)");
assert.ok(restore.includes("paneIdentityMatches"), "restore 用窗口名+pid 核对 pane 还是不是原来那块");
assert.ok(src.includes("#{pane_id}\\t#{pane_current_path}\\t#{window_name}\\t#{pane_pid}"),
  "boot 快照带上 window_name / pane_pid");
assert.ok(src.includes("绑定补存窗口名 + pid"), "attach 补存窗口名+pid");
const store = readFileSync(new URL("../daemon/mirror-store.ts", import.meta.url), "utf8");
assert.ok(store.includes("tmuxWindow?: string") && store.includes("tmuxPid?: string"), "持久化记录有 tmuxWindow/tmuxPid");
console.log("mirror-restore-identity: 判据矩阵 + heal 退役 + 绑定补存 全过");
