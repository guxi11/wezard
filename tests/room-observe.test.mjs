// observe.mjs (修复单 §6) 用 /tmp 夹具过一遍: log / duties / lag / watchdog 四个子命令。
// 只读, 不碰线上文件。duties 依赖 dist/shared/room.js —— 没构建就 SKIP (验收流程先 build)。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const OBSERVE = join(ROOT, "scripts", "room-cutover", "observe.mjs");
const distRoom = join(ROOT, "dist", "shared", "room.js");
const dir = mkdtempSync(join(tmpdir(), "room-observe-"));
const logPath = join(dir, "daemon.log");
const run = (a) => execFileSync("node", [OBSERVE, ...a], { encoding: "utf8" });

// pino 形状的夹具日志: 时间锚在 2026-11-19T10:00:00Z 前后。
const T0 = Date.parse("2026-11-19T10:00:00Z");
const line = (atMin, level, msg, extra = {}) =>
  JSON.stringify({ level, time: T0 + atMin * 60_000, pid: 1, msg, ...extra });
writeFileSync(logPath, [
  line(-600, 30, "boot ok"),                                     // 窗口外 (24h 前)
  line(-30, 40, "老 warn 文案", { mod: "x" }),                   // 对比窗口内 (since 前 24h)
  line(1, 30, "room: mirrored", { mod: "room", room: "chat:wrO", msgId: "a1b2c3d4.1", lagMs: 120 }),
  line(2, 30, "room: delivered", { mod: "room", room: "chat:wrO", msgId: "a1b2c3d4.1", target: "chat:wrO", lagMs: 340 }),
  line(3, 40, "新 warn 文案", { mod: "y" }),
  line(4, 40, "新 warn 文案", { mod: "y" }),
  line(5, 30, "room-watchdog 扫描", { mod: "room-watchdog", baseline: true, holders: 2, stale: 0, suspect: 0, idleFixed: 0, revived: 0, busy: 0, cold: 1, failStreak: 0, lastScanAt: T0 }),
  line(65, 30, "room-watchdog 扫描", { mod: "room-watchdog", holders: 2, stale: 1, suspect: 1, idleFixed: 1, revived: 1, busy: 1, cold: 0, failStreak: 2, lastScanAt: T0 + 65_000 }),
  line(65.03, 40, "pane 两轮扫描不存在, 重建已试满上限", { mod: "room-watchdog", target: "chat:wrO" }),  // 同一次扫描的 warn (2s 内)
  "不是 JSON 的坏行",
].join("\n") + "\n");

// log: level 计数 + warn 聚合 + 新旧对比。
{
  const out = run(["log", "--since", "2026-11-19T10:00:00Z", "--log", logPath]);
  assert.match(out, /info: 4/, "info 计数 (mirrored/delivered/两条 watchdog)");
  assert.match(out, /warn: 3/, "warn 计数");
  assert.match(out, /2\t\[新\] 新 warn 文案/, "新出现的 warn 文案带 [新] 与次数");
  assert.match(out, /1\t\[新\] pane 两轮扫描不存在/, "watchdog 的 warn 也是新文案");
  assert.match(out, /新出现的 warn 文案 2 条/, "只列 since 后的; 窗口外的旧文案不进聚合");
  assert.ok(!out.includes("老 warn 文案"), "since 之前的 warn 不出现在输出里 (只参与新旧对比)");
}

// lag: 两行都找得到, 打出 lagMs。
{
  const out = run(["lag", "a1b2c3d4.1", "--log", logPath]);
  assert.match(out, /room: mirrored: lagMs=120/);
  assert.match(out, /room: delivered: lagMs=340/);
  // 只有一条时退出码非 0。
  let rc = 0;
  try { run(["lag", "nope.9", "--log", logPath]); } catch (e) { rc = e.status ?? 1; }
  assert.notEqual(rc, 0, "找不到的 msg id 非零退出");
}

// watchdog: 聚簇 (65min 与 66min 两行同簇, 5min 那行另一簇), 行数最大值 / 计数和 / failStreak。
{
  const out = run(["watchdog", "--since", "2026-11-19T10:00:00Z", "--log", logPath]);
  assert.match(out, /每次扫描行数最大值: 2/, "warn 与汇总行聚成同一次扫描");
  assert.match(out, /总行数: 3/);
  assert.match(out, /"holders":4/, "两条汇总行 holders 相加");
  assert.match(out, /"revived":1/, "两条汇总行的 revived 相加");
  assert.match(out, /"cold":1/);
  assert.match(out, /failStreak 最大值: 2/);
}

// duties: /tmp 夹具 rooms 目录, 用 dist/shared/room.js 重放。没构建就 SKIP。
{
  if (!existsSync(distRoom)) {
    console.log("room-observe: SKIP duties (dist/shared/room.js 未构建 — npm run build 后再跑)");
  } else {
    const rooms = join(dir, "rooms");
    const room = "chat:wrOBS";
    const { mkdirSync } = await import("node:fs");
    mkdirSync(rooms, { recursive: true });
    // open + join + 一条已关的 ask + 一条未关的 ask → 未结 1。
    const open = { op: "open", at: 1, room, kind: "wecom-group", by: { kind: "daemon", id: "wezard" } };
    const joinOp = { op: "join", at: 1, room, who: { kind: "wizard", id: "w111111111111" }, ord: 1, via: "founder", by: { kind: "daemon", id: "wezard" } };
    const ask = { op: "msg", at: 2, room, id: "aaaa1111.1", seq: 1, author: { kind: "human", id: "T" }, ord: 0, speak: "human", kind: "ask", text: "活", to: [{ kind: "wizard", id: "w111111111111" }], wake: ["w111111111111"], origin: "inbound" };
    const reply = { op: "msg", at: 3, room, id: "aaaa1111.2", seq: 2, author: { kind: "wizard", id: "w111111111111" }, ord: 1, speak: "member", kind: "reply", text: "done", re: ["aaaa1111.1"], status: "done", closes: ["aaaa1111.1@wizard:w111111111111"], wake: [], origin: "tool" };
    const ask2 = { op: "msg", at: 4, room, id: "aaaa1111.3", seq: 3, author: { kind: "human", id: "T" }, ord: 0, speak: "human", kind: "ask", text: "还有一件", to: [{ kind: "wizard", id: "w111111111111" }], wake: ["w111111111111"], origin: "inbound" };
    writeFileSync(join(rooms, encodeURIComponent(room) + ".jsonl"), [open, joinOp, ask, reply, ask2].map((x) => JSON.stringify(x)).join("\n") + "\n");
    const out = run(["duties", "--rooms", rooms, "--dist", distRoom]);
    assert.match(out, /duties: 1 条未结/, "一件未结 (另一件已 done)");
    assert.match(out, new RegExp(room.replace(":", "\\:") + ": 1"), "按 room 列出");
  }
}

console.log("room-observe: log/duties/lag/watchdog 四个子命令在 /tmp 夹具上通过");
process.exit(0);
