// room 看门狗 (修复单 §1-§3): 假 tmux + 假时钟, 不起真 pane。
// 覆盖清单 ①-⑨: 两次确认取消 / pane 回来不取消 / 首轮基线零动作 / 真机 fixture 解析 /
// 分隔符用例 / 停摆与恢复 / 失败两轮零 warn / 一次扫描一行 / tmux 失败与冷 wizard 零结束。
// 解析输入一律用真机 fixture 或字节构造的字符串, 不许手写数组 (§1 C)。
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openRoomStore } from "../daemon/rooms.js";
import { createRoomWatchdog, parsePaneIds } from "../daemon/room-watchdog.js";
import { DAEMON, openDuties, type Who } from "../shared/room.js";
import { uid } from "./room-fixture.js";

// ── §1: parsePaneIds (fixture 来源: tmux list-panes -a -F '#{pane_id}', 2026-11-19 19:00:49 +0800, 本机 48 pane) ──
{
  const FIX = readFileSync(join(import.meta.dirname, "fixtures", "tmux-list-panes-real.txt"), "utf8");
  const nonEmpty = FIX.split("\n").filter((l) => l.trim()).length;
  const ids = parsePaneIds(FIX);
  assert.equal(ids.length, nonEmpty, "④ 真机 fixture: 解析出的 pane 数 = 文件非空行数");
  assert.ok(ids.every((x) => /^%\d+$/.test(x)), "真机 pane id 形如 %N");
  assert.ok(FIX.endsWith("\n"), "fixture 保留末尾换行 (字节原样)");

  // ⑤ 含分隔符用例 (单字段 format): 末尾空行 / CRLF / 前后空白。
  assert.deepEqual(parsePaneIds("%1\n%2\n\n"), ["%1", "%2"], "⑤ 末尾空行不产 pane");
  assert.deepEqual(parsePaneIds("%1\r\n%2\r\n"), ["%1", "%2"], "⑤ CRLF 解对");
  assert.deepEqual(parsePaneIds("  %1  \n\t%2\t\n"), ["%1", "%2"], "⑤ 前后空白剥掉");
  assert.deepEqual(parsePaneIds(""), [], "空输出 0 pane");
  assert.deepEqual(parsePaneIds("\n\n"), [], "只有空行 0 pane");
  assert.deepEqual(parsePaneIds("%1\n%2\n%3\n"), ["%1", "%2", "%3"], "多 pane 全解析 (旧 bug: 字面 \\n 切分会把整串当一个 id)");
}

// ── 共用夹具 ─────────────────────────────────────────────────────────
const mk = () => {
  const dir = mkdtempSync(join(tmpdir(), "room-wd-"));
  const store = openRoomStore(dir);
  const room = "chat:wrG";
  store.ensure(room, { at: 1, kind: "wecom-group", by: DAEMON });
  return { store, room };
};
const W = uid(1), A = uid(2), B = uid(3), C = uid(4);
const human: Who = { kind: "human", id: "T1" };
const setupDuty = (store: ReturnType<typeof openRoomStore>, room: string, holder: string): void => {
  store.append(room, [
    { op: "join", at: 1, room, who: { kind: "wizard", id: holder }, ord: 1, via: "founder", by: DAEMON },
    { op: "msg", at: 2, room, id: "a1b2c3d4.1", seq: 1, author: human, ord: 0, speak: "human", kind: "ask", text: "干活", to: [{ kind: "wizard", id: holder }], wake: [holder], origin: "inbound" },
  ]);
};
interface Line { level: string; fields: Record<string, unknown>; msg: string }
const mkLog = () => {
  const lines: Line[] = [];
  const log = {
    info: (f: Record<string, unknown>, m: string) => lines.push({ level: "info", fields: f, msg: m }),
    warn: (f: Record<string, unknown>, m: string) => lines.push({ level: "warn", fields: f, msg: m }),
    debug: (f: Record<string, unknown>, m: string) => lines.push({ level: "debug", fields: f, msg: m }),
  };
  return { lines, log };
};
let clock = 100_000;
const now = () => clock;
const STALE = 5 * 60_000, INTERVAL = 60_000;
type Wiz = Record<string, { target: string; name: string; paneId?: string }>;

const mkWd = (o: {
  store: ReturnType<typeof openRoomStore>;
  wiz: Wiz;
  panes: () => string[];
  ok?: boolean;
  busy?: boolean;
  onIdle?: () => void;
  log?: ReturnType<typeof mkLog>["log"];
}) => {
  let listCalls = 0;
  const wd = createRoomWatchdog({
    now, log: o.log as never,
    listPanes: async () => { listCalls++; return { ok: o.ok ?? true, panes: o.panes() }; },
    wizardOf: (u) => o.wiz[u],
    isBusy: async () => o.busy ?? false,
    rooms: o.store.ids, stateOf: (id) => o.store.get(id),
    write: (id, ops) => { o.store.append(id, ops); },
    onIdle: o.onIdle ?? (() => {}), kick: () => {},
    staleMs: () => STALE, intervalMs: () => INTERVAL,
  });
  return { wd, listCalls: () => listCalls };
};

// ── ③ boot 首轮只建基线: 零动作 (连 onIdle 都不调), 汇总行 baseline:true ──
{
  const { store, room } = mk();
  setupDuty(store, room, W);
  const wiz: Wiz = { [W]: { target: "chat:wrG", name: "w", paneId: "%1" } };
  let idle = 0;
  const { lines, log } = mkLog();
  const { wd } = mkWd({ store, wiz, panes: () => ["%1"], onIdle: () => { idle++; }, log });
  clock += 6 * 60_000; // 早就过了 staleMin —— 基线轮也不许动手
  await wd.scan();
  assert.equal(idle, 0, "③ 首轮连 onIdle 都不调");
  assert.equal(store.get(room)!.msgs.length, 1, "③ 首轮零写账");
  const base = lines.filter((l) => l.fields.mod === "room-watchdog");
  assert.equal(base.length, 1, "③ 首轮恰好一行汇总");
  assert.equal(base[0]!.fields.baseline, true, "③ 汇总行标 baseline:true");
  assert.equal(base[0]!.fields.ended, 0, "③ 首轮结束计数 = 0 (O4)");
  console.log("首轮基线扫描日志原文:", JSON.stringify({ level: base[0]!.level, fields: base[0]!.fields, msg: base[0]!.msg }));
  // 基线后 lastEvent=now: 紧接着的一轮不到 stale 窗口, 也不动手。
  clock += 60_000;
  await wd.scan();
  assert.equal(idle, 0, "基线后未到 stale 窗口不动");
}

// ── ① 一次疑似不取消, 第二次 (≥ intervalSec) 才取消; 重复扫描幂等 ──
{
  const { store, room } = mk();
  setupDuty(store, room, W);
  const wiz: Wiz = { [W]: { target: "chat:wrG", name: "w", paneId: "%1" } };
  const { lines, log } = mkLog();
  const { wd } = mkWd({ store, wiz, panes: () => ["%9"], log }); // %1 消失, 但 tmux 正常
  await wd.scan();            // 基线
  clock += 6 * 60_000;
  await wd.scan();            // 第一次判不存在 → 疑似
  const s1 = store.get(room)!;
  assert.equal(openDuties(s1).length, 1, "① 一次疑似不取消");
  assert.ok(!s1.msgs.some((m) => m.sys === "instance-ended"), "① 疑似轮不写 instance-ended");
  const susp = lines.filter((l) => l.fields.mod === "room-watchdog" && l.level !== "warn");
  assert.equal(susp[susp.length - 1]!.fields.suspect, 1, "① 疑似计数进汇总行");
  clock += 30_000;
  await wd.scan();            // 距首次疑似 < intervalSec → 仍只是疑似
  assert.equal(openDuties(store.get(room)!).length, 1, "① 间隔不到 intervalSec 不取消");
  clock += 31_000;            // ≥ 60s
  await wd.scan();            // 第二次确认 → 取消 + instance-ended
  const s2 = store.get(room)!;
  assert.equal(openDuties(s2).length, 0, "① 第二次 (≥ intervalSec) 才取消");
  assert.ok(s2.msgs.some((m) => m.kind === "reply" && m.status === "canceled" && (m.re ?? []).includes("a1b2c3d4.1")), "① canceled reply 落账唤醒提问者");
  assert.equal(s2.msgs.filter((m) => m.sys === "instance-ended").length, 1, "① 恰好一行 instance-ended");
  assert.ok(s2.msgs.some((m) => m.sys === "instance-ended" && m.text.includes("1 条未结 duty")), "① 正文计数按 room 算");
  const warns = lines.filter((l) => l.level === "warn");
  assert.equal(warns.length, 1, "① 结束事件保留一行 warn");
  const before = s2.msgs.length;
  clock += 6 * 60_000;
  await wd.scan();
  assert.equal(store.get(room)!.msgs.length, before, "① duty 已关, 重复扫描天然不再写");
}

// ── ② 两次之间 pane 回来 → 不取消; touch / pane id 变化 → 清疑似 ──
{
  const { store, room } = mk();
  setupDuty(store, room, W);
  const wiz: Wiz = { [W]: { target: "chat:wrG", name: "w", paneId: "%1" } };
  let panes = ["%9"];
  let idle = 0;
  const { wd } = mkWd({ store, wiz, panes: () => panes, onIdle: () => { idle++; } });
  await wd.scan();            // 基线
  clock += 6 * 60_000;
  await wd.scan();            // 疑似
  assert.equal(openDuties(store.get(room)!).length, 1, "② 疑似后 duty 仍开着");
  panes = ["%1"];             // pane 回来了
  clock += 60_000;
  await wd.scan();            // pane 在 → 清疑似 + 闲 → 补判闲 (onIdle)
  const s = store.get(room)!;
  assert.equal(openDuties(s).length, 1, "② pane 回来不取消");
  assert.ok(!s.msgs.some((m) => m.sys === "instance-ended"), "② 无 instance-ended");
  assert.ok(idle >= 1, "② pane 活且闲 → 补判闲 (onIdle)");
}
{
  // touch 清疑似: 疑似之后有新事件 → 下一轮按新疑似时刻重新起算。
  const { store, room } = mk();
  setupDuty(store, room, W);
  const wiz: Wiz = { [W]: { target: "chat:wrG", name: "w", paneId: "%1" } };
  const { wd } = mkWd({ store, wiz, panes: () => ["%9"] });
  await wd.scan();            // 基线
  clock += 6 * 60_000;
  await wd.scan();            // 疑似 (at = clock)
  wd.touch("chat:wrG");       // 有新事件
  clock += 60_000 + 1;
  await wd.scan();            // 仍 stale (touch 之后 60s < staleMin? 不, touch=now → 未到 stale 窗口)
  assert.equal(openDuties(store.get(room)!).length, 1, "touch 清疑似, 不取消");
  clock += 6 * 60_000;
  await wd.scan();            // 重新疑似 (at = clock)
  clock += 6 * 60_000;
  await wd.scan();            // 这才够 intervalSec → 取消
  assert.equal(openDuties(store.get(room)!).length, 0, "重新起算后第二次确认才取消");
}

// ── ⑧ 3 个忙 wizard 一次扫描只出 1 行日志 (busyList 折进行内) ──
{
  const { store, room } = mk();
  store.append(room, [{ op: "join", at: 1, room, who: { kind: "wizard", id: W }, ord: 1, via: "founder", by: DAEMON }]);
  const other = (r: string, h: string, n: number): void => {
    const s = store.ensure("chat:wr" + n, { at: 1, kind: "wecom-group", by: DAEMON });
    store.append("chat:wr" + n, [
      { op: "join", at: 1, room: "chat:wr" + n, who: { kind: "wizard", id: h }, ord: 1, via: "founder", by: DAEMON },
      { op: "msg", at: 2, room: "chat:wr" + n, id: "b" + n + "cdef01." + (s.seq + 1), seq: s.seq + 1, author: human, ord: 0, speak: "human", kind: "ask", text: "活" + n, to: [{ kind: "wizard", id: h }], wake: [h], origin: "inbound" },
    ]);
  };
  other(room, A, 2); other(room, B, 3); other(room, C, 4); // 三个 room 各一个忙 wizard… W 也在 chat:wrG 有 duty
  setupDuty(store, room, W);
  const wiz: Wiz = {
    [W]: { target: "chat:wrG", name: "w", paneId: "%1" },
    [A]: { target: "chat:wr2", name: "a", paneId: "%2" },
    [B]: { target: "chat:wr3", name: "b", paneId: "%3" },
    [C]: { target: "chat:wr4", name: "c", paneId: "%4" },
  };
  const { lines, log } = mkLog();
  const { wd } = mkWd({ store, wiz, panes: () => ["%1", "%2", "%3", "%4"], busy: true, log });
  await wd.scan();            // 基线
  lines.length = 0;
  clock += 6 * 60_000;
  await wd.scan();
  const wdLines = lines.filter((l) => l.fields.mod === "room-watchdog");
  assert.equal(wdLines.length, 1, "⑧ 4 个忙 wizard 一次扫描只出 1 行");
  assert.equal(wdLines[0]!.level, "info", "⑧ 有事的一轮是 info");
  const busyList = wdLines[0]!.fields.busyList as Array<Record<string, unknown>>;
  assert.equal(busyList.length, 4, "⑧ busyList 折进同一行");
  assert.ok(busyList.every((x) => typeof x.busyForMs === "number" && typeof x.openDuties === "number" && !!x.name && !!x.uid), "⑧ busyList 带 busyForMs/openDuties/name/uid");
  // 全零的一轮降 debug。
  lines.length = 0;
  clock += 60_000;
  await wd.scan();            // touch 过的? 没有 —— busy 轮不 touch, 仍 stale, 再出一行 info (busy>0)
  clock += 60_000;
  const zero = lines.filter((l) => l.fields.mod === "room-watchdog");
  assert.ok(zero.length >= 1 && zero.every((l) => l.level === "info" || l.fields.busy > 0), "非零轮保持 info");
}

// ── ⑨ 冷 wizard 零结束: 没有 pane 绑定只计数, 不写账本 ──
{
  const { store, room } = mk();
  setupDuty(store, room, W);
  const wiz: Wiz = { [W]: { target: "chat:wrG", name: "w" } }; // 无 paneId = 冷
  const { lines, log } = mkLog();
  const { wd } = mkWd({ store, wiz, panes: () => ["%9"], log });
  await wd.scan();            // 基线
  lines.length = 0;
  clock += 6 * 60_000;
  await wd.scan();
  clock += 60_000;
  await wd.scan();
  const s = store.get(room)!;
  assert.equal(openDuties(s).length, 1, "⑨ 冷 wizard 不算结束 (重生归 hub)");
  assert.ok(!s.msgs.some((m) => m.sys === "instance-ended"), "⑨ 零 instance-ended");
  const last = lines.filter((l) => l.fields.mod === "room-watchdog").at(-1)!;
  assert.equal(last.fields.cold, 1, "⑨ cold 计数进汇总行");
  assert.equal(last.fields.ended, 0, "⑨ ended = 0");
}

// ── ⑥ 连续 5 次失败只 1 条停摆 warn; 第 6 次成功 1 条 recovered 且归零 (⑨ tmux 失败零结束) ──
{
  const { store, room } = mk();
  setupDuty(store, room, W);
  const wiz: Wiz = { [W]: { target: "chat:wrG", name: "w", paneId: "%1" } };
  const { lines, log } = mkLog();
  let ok = false;
  const wd = createRoomWatchdog({
    now, log: log as never,
    listPanes: async () => (ok ? { ok: true, panes: ["%9"] } : { ok: false, error: "tmux boom" }),
    wizardOf: (u) => wiz[u],
    isBusy: async () => false,
    rooms: store.ids, stateOf: (id) => store.get(id),
    write: (id, ops) => { store.append(id, ops); },
    onIdle: () => { throw new Error("⑥ 失败轮不该到这"); }, kick: () => {},
    staleMs: () => STALE, intervalMs: () => INTERVAL,
  });
  const msgs0 = store.get(room)!.msgs.length;
  for (let i = 0; i < 5; i++) { clock += 6 * 60_000; await wd.scan(); }
  assert.equal(store.get(room)!.msgs.length, msgs0, "⑥/⑨ tmux 失败零结束 (整轮跳过, 不写账)");
  const stallWarns = lines.filter((l) => l.level === "warn" && l.msg.includes("停摆"));
  assert.equal(stallWarns.length, 1, "⑥ 连续 5 次失败只 1 条停摆 warn");
  assert.equal(stallWarns[0]!.fields.failStreak, 3, "⑥ warn 在第 3 轮打, 带 failStreak");
  assert.equal(stallWarns[0]!.fields.lastError, "tmux boom", "⑥ warn 带 lastError");
  ok = true;
  clock += 60_000;
  await wd.scan();            // 第 6 次成功 = 基线轮
  const recov = lines.filter((l) => l.msg.includes("recovered"));
  assert.equal(recov.length, 1, "⑥ 成功那轮 1 条 recovered");
  assert.equal(recov[0]!.fields.failedRounds, 5, "⑥ recovered 带 failedRounds");
  const base = lines.filter((l) => l.fields.baseline === true);
  assert.equal(base.length, 1, "⑥ 基线等第一次成功扫描才建立");
  assert.equal(wd.status().failStreak, 0, "⑥ failStreak 归零");
  assert.ok(wd.status().lastScanAt > 0, "⑥ lastScanAt 有值");
}

// ── ⑦ 失败 2 次后成功: 零 warn ──
{
  const { store, room } = mk();
  setupDuty(store, room, W);
  const wiz: Wiz = { [W]: { target: "chat:wrG", name: "w", paneId: "%1" } };
  const { lines, log } = mkLog();
  let ok = false;
  const wd = createRoomWatchdog({
    now, log: log as never,
    listPanes: async () => (ok ? { ok: true, panes: ["%1"] } : { ok: false, error: "x" }),
    wizardOf: (u) => wiz[u],
    isBusy: async () => false,
    rooms: store.ids, stateOf: (id) => store.get(id),
    write: (id, ops) => { store.append(id, ops); },
    onIdle: () => {}, kick: () => {},
    staleMs: () => STALE, intervalMs: () => INTERVAL,
  });
  await wd.scan(); await wd.scan();
  ok = true;
  await wd.scan();
  assert.equal(lines.filter((l) => l.level === "warn").length, 0, "⑦ 失败 2 次后成功, 零 warn");
  assert.equal(lines.filter((l) => l.msg.includes("recovered")).length, 1, "⑦ recovered 照打 (info)");
  assert.equal(wd.status().failStreak, 0, "⑦ failStreak 归零");
}

// ── 漏 turn_end → onIdle 恰好一次; boot 宽限 (基线后新持有者首见记 now) ──
{
  const { store, room } = mk();
  setupDuty(store, room, W);
  const wiz: Wiz = { [W]: { target: "chat:wrG", name: "w", paneId: "%1" } };
  let idle = 0;
  const { wd, listCalls } = mkWd({ store, wiz, panes: () => ["%1"], onIdle: () => { idle++; } });
  await wd.scan();            // 基线
  clock += 6 * 60_000;
  await wd.scan();            // 闲 → 补一次 onIdle
  assert.equal(idle, 1, "漏 turn_end → onIdle 恰好一次");
  clock += 60_000;
  await wd.scan();
  assert.equal(idle, 1, "touch 之后 stale 窗口重置, 不重复补");
  assert.equal(listCalls(), 3, "每次扫描恰好一次 listPanes");
}
{
  // 基线后新出现的持有者 (从未 touch 过): 首见记 now, 不算 stale。
  const { store, room } = mk();
  setupDuty(store, room, W);
  const wiz: Wiz = { [W]: { target: "chat:wrG", name: "w", paneId: "%1" }, [A]: { target: "chat:wrG", name: "a", paneId: "%2" } };
  let idle = 0;
  const { wd } = mkWd({ store, wiz, panes: () => ["%1", "%2"], onIdle: () => { idle++; } });
  await wd.scan();            // 基线 (只有 W 持有)
  clock += 6 * 60_000;
  await wd.scan();
  assert.equal(idle, 1, "W 补判闲一次");
  // 给 A 开一条 duty (基线之后才成为持有者, activity 无记录)。
  const s = store.get(room)!;
  store.append(room, [{ op: "msg", at: 3, room, id: "a1b2c3d4." + (s.seq + 1), seq: s.seq + 1, author: human, ord: 0, speak: "human", kind: "ask", text: "还有你", to: [{ kind: "wizard", id: A }], wake: [A], origin: "inbound" }]);
  clock += 60_000;
  await wd.scan();            // A 首见 → 记 now, 不动手
  assert.equal(idle, 1, "boot 宽限: activity 无记录的首见不算 stale");
  clock += 6 * 60_000;
  await wd.scan();            // 现在够了 → 补
  assert.equal(idle, 2, "宽限一轮后才补判闲");
}

console.log("room-watchdog: parse fixture+分隔符; 基线零动作; 两次确认取消/pane 回来不取消; 停摆与恢复; 一次扫描一行; 冷 wizard 与 tmux 失败零结束");
process.exit(0);
