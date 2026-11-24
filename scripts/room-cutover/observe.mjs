#!/usr/bin/env node
// 只读观察工具 (docs/room/fix-task.md §6, cutover 第 9 步 O1-O4)。不写任何文件。
//   log      --since <ISO> [--log <path>]   按 level 计数 + warn 按 msg 聚合, 与 since 前 24h 对比列新 warn
//   duties   [--rooms <dir>] [--dist <room.js>]  rooms/ 账本重放 (dist/shared/room.js 的 fold), 输出未结 duty 数
//   lag      <msgId> [--log <path>]         取 room: mirrored / room: delivered 两行打 lagMs
//   watchdog --since <ISO> [--log <path>]   每次扫描行数最大值 / 总行数 / 各计数和 / failStreak 最大值
// 注: 投递日志的消息 id 字段名是 msgId (不是 msg) —— pino 的 msg 键就是日志文案, 撞名会输出
// 重复键, JSON 解析取后者, id 会丢。见 room-hub.ts。
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const LEVELS = { 10: "trace", 20: "debug", 30: "info", 40: "warn", 50: "error", 60: "fatal" };
const args = process.argv.slice(2);
const cmd = args[0];
const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : def; };
const die = (msg) => { console.error(msg); process.exit(2); };

const readLog = (path) =>
  readFileSync(path, "utf8").split("\n").filter((l) => l.trim()).flatMap((l) => {
    try { const j = JSON.parse(l); return typeof j.time === "number" ? [j] : []; } catch { return []; }
  });
const sinceMs = (raw) => {
  const t = Date.parse(raw ?? "");
  if (!Number.isFinite(t)) die("--since 要一个 ISO 时间串, 拿到的是: " + raw);
  return t;
};
const num = (n) => (typeof n === "number" ? n : 0);
const defaultLog = () => join(homedir(), ".wezard", "daemon.log");

if (cmd === "log") {
  const path = opt("--log", defaultLog());
  if (!existsSync(path)) die("日志不存在: " + path);
  const since = sinceMs(opt("--since"));
  const rows = readLog(path);
  const after = rows.filter((r) => r.time >= since);
  const before = rows.filter((r) => r.time >= since - 24 * 3600_000 && r.time < since);
  const counts = {};
  for (const r of after) { const lv = LEVELS[r.level] ?? String(r.level); counts[lv] = (counts[lv] ?? 0) + 1; }
  const warnAfter = {}, warnBefore = new Set();
  for (const r of after) if (r.level === 40) warnAfter[r.msg] = (warnAfter[r.msg] ?? 0) + 1;
  for (const r of before) if (r.level === 40) warnBefore.add(r.msg);
  console.log("log:", path);
  console.log("since:", new Date(since).toISOString(), "· 行数", after.length, "· 对比窗口 (前 24h):", before.length, "行");
  for (const lv of ["trace", "debug", "info", "warn", "error", "fatal"]) if (counts[lv]) console.log("  " + lv + ": " + counts[lv]);
  const warnEntries = Object.entries(warnAfter).sort((a, b) => b[1] - a[1]);
  console.log("warn 按 msg 聚合:");
  for (const [msg, n] of warnEntries) console.log("  " + n + "\t" + (warnBefore.has(msg) ? "" : "[新] ") + msg);
  const fresh = warnEntries.filter(([m]) => !warnBefore.has(m));
  console.log(fresh.length ? "新出现的 warn 文案 " + fresh.length + " 条 (切换前 24h 没出现过):" : "没有新出现的 warn 文案");
} else if (cmd === "duties") {
  const distRoom = opt("--dist", join(import.meta.dirname, "..", "..", "dist", "shared", "room.js"));
  if (!existsSync(distRoom)) die("dist/shared/room.js 不存在 (先 npm run build): " + distRoom);
  const { emptyRoom, applyOp, openDuties, roomsDirOf } = await import(distRoom);
  // 缺省目录与 daemon 同一处推导 (stateDir 来自配置) —— 不再硬编码 ~/.wezard/rooms;
  // 给了 --rooms 就完全不碰配置 (配置坏了也能对着指定目录重放)。
  const dir = opt("--rooms") ?? await (async () => {
    const distConfig = join(import.meta.dirname, "..", "..", "dist", "shared", "config.js");
    if (!existsSync(distConfig)) die("dist/shared/config.js 不存在 (先 npm run build), 或用 --rooms 显式指定: " + distConfig);
    try {
      const stateDir = (await import(distConfig)).loadConfig().config.daemon.stateDir;
      return roomsDirOf(stateDir);
    } catch (e) {
      die("默认 rooms 目录从配置推导失败 (" + e.message + "); 可用 --rooms 显式指定");
    }
  })();
  if (!existsSync(dir)) die("rooms 目录不存在: " + dir);
  let total = 0, rooms = 0;
  for (const file of readdirSync(dir).filter((x) => x.endsWith(".jsonl")).sort()) {
    const id = decodeURIComponent(file.slice(0, -6));
    const ops = readFileSync(join(dir, file), "utf8").split("\n").filter((l) => l.trim()).flatMap((l) => {
      try { return [JSON.parse(l)]; } catch { return []; } // 尾部撕裂行: 只读工具, 跳过
    });
    const n = openDuties(ops.reduce(applyOp, emptyRoom(id))).length;
    total += n; rooms++;
    if (n) console.log("  " + id + ": " + n);
  }
  console.log("duties: " + total + " 条未结 (" + rooms + " 个 room, 重放自 " + dir + ")");
} else if (cmd === "lag") {
  const path = opt("--log", defaultLog());
  if (!existsSync(path)) die("日志不存在: " + path);
  const id = args.slice(1).find((a) => !a.startsWith("--"));
  if (!id) die("用法: observe.mjs lag <msgId> [--log <path>]");
  const hits = readLog(path).filter((r) => r.msgId === id && (r.msg === "room: mirrored" || r.msg === "room: delivered"));
  const byKind = Object.fromEntries(hits.map((r) => [r.msg, r]));
  let missing = 0;
  for (const kind of ["room: mirrored", "room: delivered"]) {
    if (byKind[kind]) console.log(kind + ": lagMs=" + byKind[kind].lagMs + " (room=" + byKind[kind].room + (byKind[kind].target ? ", target=" + byKind[kind].target : "") + ")");
    else { console.log(kind + ": 未找到"); missing++; }
  }
  if (missing) process.exit(1);
} else if (cmd === "watchdog") {
  const path = opt("--log", defaultLog());
  if (!existsSync(path)) die("日志不存在: " + path);
  const since = sinceMs(opt("--since"));
  const rows = readLog(path).filter((r) => r.time >= since && r.mod === "room-watchdog");
  // 按时间聚簇: 间隔 > 10s = 新一次扫描 (rooms.watchdog.intervalSec 下限 10)。
  const scans = [];
  for (const r of rows.sort((a, b) => a.time - b.time)) {
    const last = scans[scans.length - 1];
    if (last && r.time - last.at <= 10_000) { last.rows.push(r); last.at = Math.max(last.at, r.time); }
    else scans.push({ at: r.time, rows: [r] });
  }
  // ended → revived: 2026-11-24 起 pane 消失是「重建 pane 叫醒」, 不再判实例结束。
  const sums = { holders: 0, stale: 0, suspect: 0, idleFixed: 0, revived: 0, busy: 0, cold: 0 };
  let maxFailStreak = 0, summaries = 0;
  for (const s of scans) for (const r of s.rows) {
    if (r.holders !== undefined) {
      summaries++;
      for (const k of Object.keys(sums)) sums[k] += num(r[k]);
    }
    maxFailStreak = Math.max(maxFailStreak, num(r.failStreak));
  }
  console.log("watchdog:", path, "· since", new Date(since).toISOString());
  console.log("  扫描次数 (聚簇): " + scans.length + " · 每次扫描行数最大值: " + (scans.length ? Math.max(...scans.map((s) => s.rows.length)) : 0) + " · 总行数: " + rows.length);
  console.log("  各计数和 (来自 " + summaries + " 条汇总行): " + JSON.stringify(sums));
  console.log("  failStreak 最大值: " + maxFailStreak);
} else {
  die("子命令只认 log / duties / lag / watchdog (fix-task §6)");
}
