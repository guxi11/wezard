// room 看门狗 (wiring C + 切换前修复单 §1-§3)。规格:
//   · 事件驱动为主 (MirrorDeps.onTurnEnd → hub.onIdle), 看门狗只兜「漏了 turn_end /
//     pane 意外消失」。一次扫描一条 tmux list-panes 批量取全场, 不按 wizard 逐个探。
//   · **首轮只建基线 (B)**: boot 后第一次**成功**扫描只记每个持有者的 lastEvent (= now)
//     与 pane 快照, 不取消、不补判闲、不 warn; 汇总行标 baseline:true。tmux 失败的轮次
//     不算 —— 基线等第一次成功扫描才建立。
//   · **取消两次确认 (A)**: 第一次判 pane 不存在只记「疑似」(内存 Map target → 首次疑似
//     时刻 + pane id), 不写账本、不唤醒; 下一次扫描 (距首次疑似 ≥ intervalSec) 仍不存在
//     才写 canceled + 唤醒提问者 + instance-ended。其间 pane 回来 / 有新事件 (touch) /
//     pane id 变了 → 清掉 (pane id 变了按新 id 重新起算)。
//   · **防静默失效 (D)**: tmux 调用失败或返回 0 个 pane → 本轮整体跳过, failStreak++;
//     成功一轮清零。failStreak 到 3 打一条 warn (只此一条), 恢复成功那轮打一条 recovered。
//   · **冷 wizard**: 只有「绑定里有 pane id 且该 id 不在列表里」才进结束判定; 没有 pane
//     绑定的冷 wizard 不算结束 —— hub 的 paste → injectText 对冷 wizard 是重生 (新 CLI
//     进程自带新工具面), 交给 hub, 这里只计数进汇总行 (cold)。
//   · activity 无记录的 target 首次被看见记为 now (boot 宽限), 不是 0 —— 重启后首轮不得
//     把持有者全算 stale。
//   · 日志形状 (O4): 每次扫描至多一行汇总 (全零降 debug), 不逐 wizard 刷屏; 「结束」事件
//     保留一行 warn (罕见且是状态变化)。
import type { Logger } from "pino";
import { DAEMON, holderOf, leaveOps, msgIdOf, openDuties, type RoomOp, type RoomState, type Who } from "../shared/room.js";

/** tmux list-panes -a -F '#{pane_id}' 的 stdout → pane id 列表。
 * 单字段 format: 逐行切, 去每行首尾空白 (含 CRLF 的 \\r), 空行丢弃 —— 末尾换行 /
 * CRLF / 前后空白都不影响。index.ts 三处 list-panes 共用这一份解析。 */
export const parsePaneIds = (stdout: string): string[] =>
  stdout.split("\n").map((l) => l.trim()).filter(Boolean);

/** 一次 list-panes 的结果: ok=false 或 panes 为空, 对看门狗都是「这一轮什么也别判」。 */
export interface PaneScan { ok: boolean; panes?: readonly string[]; error?: string }

export interface WatchdogDeps {
  log?: Logger;
  now?: () => number;
  /** 全场 pane_id 一次拿齐 (一次扫描只调一次)。 */
  listPanes: () => Promise<PaneScan>;
  /** uid → { target, name, paneId } (pane 缺省 = 没有绑定)。 */
  wizardOf: (uid: string) => { target: string; name: string; paneId?: string } | undefined;
  isBusy: (target: string) => Promise<boolean>;
  rooms: () => readonly string[];
  stateOf: (room: string) => RoomState | undefined;
  write: (room: string, ops: readonly RoomOp[]) => void;
  onIdle: (uid: string) => Promise<void> | void;
  kick: () => void;
  staleMs: () => number;
  /** 两次确认要隔的最低扫描间隔 (= 定时器的 intervalSec)。 */
  intervalMs: () => number;
}

export const createRoomWatchdog = (deps: WatchdogDeps) => {
  const now = (): number => deps.now?.() ?? Date.now();
  /** target → 最后一次事件 (turn_end / 注入) 的时刻; stale 判定的分母。 */
  const activity = new Map<string, number>();
  /** target → 首次观察到忙的时刻 (汇总行 busyList 的 busyForMs)。 */
  const busySince = new Map<string, number>();
  /** (A) target → 首次疑似时刻 + 当时判缺失的 pane id。 */
  const suspect = new Map<string, { at: number; pane: string }>();
  let baseline = false;      // (B) 第一次成功扫描前只算失败计数, 不建基线
  let failStreak = 0;        // (D) 连续拿不到 pane 列表的轮数
  let stalledAt = 0;         // (D) 停摆 warn 只打一次的哨兵 (0 = 还没打)
  let lastError = "";
  let lastScanAt = 0;        // 最后一次成功扫描时刻 (/status 可见)
  const touch = (target: string): void => { activity.set(target, now()); busySince.delete(target); suspect.delete(target); };

  /** 持有未结 duty 的 wizard: uid → 它是成员的 room 集合。 */
  const holders = (): Map<string, Set<string>> => {
    const out = new Map<string, Set<string>>();
    for (const room of deps.rooms()) {
      const s = deps.stateOf(room);
      if (!s) continue;
      for (const d of openDuties(s)) {
        const h = holderOf(s, d);
        if (h?.kind !== "wizard") continue;
        const set = out.get(h.id) ?? new Set<string>();
        set.add(room);
        out.set(h.id, set);
      }
    }
    return out;
  };

  /** (A) 两次确认后的实例结束: leaveOps (canceled reply 唤醒提问者) + 每个 room 一行
   * instance-ended, 计数按 room 分别算 (不跨 room 累加)。 */
  const endInstance = (uid: string, w: { target: string; name: string }, rooms: ReadonlySet<string>, at: number): void => {
    const who: Who = { kind: "wizard", id: uid };
    for (const room of rooms) {
      const s = deps.stateOf(room);
      if (!s || !s.members.has("wizard:" + uid)) continue;
      const mine = openDuties(s).filter((d) => holderOf(s, d)?.id === uid).length;
      deps.write(room, leaveOps(s, who, DAEMON, at, "pane 不存在 (watchdog 两次扫描确认)"));
      const s2 = deps.stateOf(room);
      if (s2) deps.write(room, [{ op: "msg", at, room, id: msgIdOf(room, s2.seq + 1), seq: s2.seq + 1, author: DAEMON, ord: 0, speak: "daemon",
        kind: "system", sys: "instance-ended", origin: "daemon",
        text: "[wezard] ." + w.name + " 已结束 (pane 两轮扫描不存在), 本 room 名下 " + mine + " 条未结 duty 已取消", wake: [] }]);
    }
    deps.log?.warn({ mod: "room-watchdog", target: w.target, uid, rooms: [...rooms] }, "实例结束: pane 两轮扫描不存在, 名下 duty 已取消");
  };

  const summary = (fields: Record<string, unknown>, baselineRow: boolean): void => {
    const counts = ["holders", "stale", "suspect", "idleFixed", "ended", "busy", "cold"] as const;
    const zero = !baselineRow && counts.every((k) => !fields[k]);
    (zero ? deps.log?.debug : deps.log?.info)?.call(deps.log, { mod: "room-watchdog", failStreak, lastScanAt, ...fields }, "room-watchdog 扫描");
  };

  const scan = async (): Promise<void> => {
    const at = now();
    const r = await deps.listPanes();
    if (!r.ok || !r.panes?.length) {
      // (D) 整轮跳过: 不判任何人结束、不建基线。失败也计数 (首轮失败同样++)。
      failStreak++;
      lastError = r.ok ? "tmux list-panes 返回 0 个 pane" : r.error ?? "tmux 调用失败";
      if (failStreak >= 3 && !stalledAt) {
        stalledAt = failStreak;
        deps.log?.warn({ mod: "room-watchdog", failStreak, lastError }, "看门狗连续 3 轮拿不到 pane 列表, 已停摆");
      }
      summary({ holders: 0, stale: 0, suspect: 0, idleFixed: 0, ended: 0, busy: 0, cold: 0 }, false);
      return;
    }
    if (failStreak) {
      deps.log?.info({ mod: "room-watchdog", failedRounds: failStreak }, "看门狗恢复 (recovered)");
      failStreak = 0;
      stalledAt = 0;
    }
    lastScanAt = at;
    const panes = new Set(r.panes ?? []);
    const hs = holders();

    if (!baseline) {
      // (B) 首轮只建基线: lastEvent = now, 什么都不判。
      for (const [uid] of hs) {
        const w = deps.wizardOf(uid);
        if (w) activity.set(w.target, at);
      }
      baseline = true;
      summary({ baseline: true, holders: hs.size, stale: 0, suspect: 0, idleFixed: 0, ended: 0, busy: 0, cold: 0 }, true);
      deps.kick();
      return;
    }

    let stale = 0, suspectCnt = 0, idleFixed = 0, ended = 0, busy = 0, cold = 0;
    const busyList: Array<{ name: string; uid: string; busyForMs: number; openDuties: number }> = [];
    for (const [uid, rooms] of hs) {
      const w = deps.wizardOf(uid);
      if (!w) continue;
      const last = activity.get(w.target);
      if (last === undefined) { activity.set(w.target, at); continue; } // boot 宽限: 首见记 now, 不算 stale
      if (at - last < deps.staleMs()) continue;
      stale++;
      const pane = w.paneId;
      if (!pane) { cold++; continue; } // 冷 wizard: 重生归 hub, 只计数
      if (panes.has(pane)) {
        suspect.delete(w.target); // pane 回来 → 清疑似
        if (await deps.isBusy(w.target)) {
          busy++;
          const since = busySince.get(w.target) ?? at;
          busySince.set(w.target, since);
          busyList.push({ name: w.name, uid, busyForMs: at - since, openDuties: [...rooms].reduce((n, room) => {
            const s = deps.stateOf(room);
            return n + (s ? openDuties(s).filter((d) => holderOf(s, d)?.id === uid).length : 0);
          }, 0) });
          continue;
        }
        // pane 活且闲: 当作漏了 turn_end, 只补一次 (touch 重置 stale 窗口)。
        touch(w.target);
        idleFixed++;
        await deps.onIdle(uid);
        continue;
      }
      const s = suspect.get(w.target);
      if (!s || s.pane !== pane) { suspect.set(w.target, { at, pane }); suspectCnt++; continue; } // 首次疑似 / pane id 变了重新起算
      if (at - s.at < deps.intervalMs()) { suspectCnt++; continue; } // 间隔未到, 继续等下一轮
      // (A) 两次确认: 写账本 + 唤醒 + instance-ended。
      suspect.delete(w.target);
      ended++;
      endInstance(uid, w, rooms, at);
      touch(w.target);
    }
    summary({ holders: hs.size, stale, suspect: suspectCnt, idleFixed, ended, busy, cold, ...(busy ? { busyList } : {}) }, false);
    deps.kick();
  };

  return { touch, scan, holders, status: (): { failStreak: number; lastScanAt: number } => ({ failStreak, lastScanAt }) };
};
