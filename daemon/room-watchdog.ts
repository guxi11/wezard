// room 看门狗 (wiring C + 切换前修复单 §1-§3)。规格:
//   · 事件驱动为主 (MirrorDeps.onTurnEnd → hub.onIdle), 看门狗只兜「漏了 turn_end /
//     pane 意外消失」。一次扫描一条 tmux list-panes 批量取全场, 不按 wizard 逐个探。
//   · **首轮只建基线 (B)**: boot 后第一次**成功**扫描只记每个持有者的 lastEvent (= now)
//     与 pane 快照, 不取消、不补判闲、不 warn; 汇总行标 baseline:true。tmux 失败的轮次
//     不算 —— 基线等第一次成功扫描才建立。
//   · **pane 没了 = 重建 pane 叫醒, 不判实例结束** (人 2026-11-24: 「如果 pane 里没有,
//     那就应该重建 pane 唤醒呀」): 绑定与转录都还在, 唯一正确的动作是 --resume 重生一块
//     pane 再投递 —— 写一条 trigger 行 (re = 它欠的 duty) 交给唤醒泵, 泵投递时 injectText
//     探活 gone, 会重生 pane 再把这一批贴进去。**不写 canceled、不把它移出 room**: 「已结束」
//     只在确实没有会话绑定时才成立, 那是泵的 unattachedVerdict → reportGone (写一条 system
//     行, 也不关账)。重生上限 REVIVE_MAX 次 (真起不来的 pane 不反复 spawn), 之后只 warn
//     一次, duty 交给逾期扫描升级; 只有观察到 pane 活着 / 换了 id 才清零 —— 计数不随事件
//     重置, 否则又成死循环。
//   · **两次扫描确认**: 第一次判 pane 不存在只记「疑似」(内存 Map target → 首次疑似
//     时刻 + pane id), 不写账本、不唤醒; 下一次扫描 (距首次疑似 ≥ intervalSec) 仍不存在
//     才走上面的重建。其间 pane 回来 / 有新事件 (touch) / pane id 变了 → 清掉。
//   · **防静默失效 (D)**: tmux 调用失败或返回 0 个 pane → 本轮整体跳过, failStreak++;
//     成功一轮清零。failStreak 到 3 打一条 warn (只此一条), 恢复成功那轮打一条 recovered。
//   · **冷 wizard**: 只有「绑定里有 pane id 且该 id 不在列表里」才进重建判定; 没有 pane
//     绑定的冷 wizard 不归这里 —— hub 的 paste → injectText 对冷 wizard 是重生 (新 CLI
//     进程自带新工具面), 交给 hub, 这里只计数进汇总行 (cold)。
//   · activity 无记录的 target 首次被看见记为 now (boot 宽限), 不是 0 —— 重启后首轮不得
//     把持有者全算 stale。
//   · 日志形状 (O4): 每次扫描至多一行汇总 (全零降 debug), 不逐 wizard 刷屏; 重建试满上限
//     保留一行 warn (罕见且是状态变化)。
import type { Logger } from "pino";
import { holderOf, openDuties, type RoomState } from "../shared/room.js";

/** tmux list-panes -a -F '#{pane_id}' 的 stdout → pane id 列表。
 * 单字段 format: 逐行切, 去每行首尾空白 (含 CRLF 的 \\r), 空行丢弃 —— 末尾换行 /
 * CRLF / 前后空白都不影响。index.ts 三处 list-panes 共用这一份解析。 */
export const parsePaneIds = (stdout: string): string[] =>
  stdout.split("\n").map((l) => l.trim()).filter(Boolean);

/** 一次 list-panes 的结果: ok=false 或 panes 为空, 对看门狗都是「这一轮什么也别判」。 */
export interface PaneScan { ok: boolean; panes?: readonly string[]; error?: string }

/** 同一块死 pane 最多重建几次。真起不来的 pane (ENOMEM / 后端坏了) 不反复 spawn ——
 *  试满就只留一条 warn, duty 照旧开着交给逾期扫描升级; 之后它被任何一条真消息叫醒
 *  (走 dispatch 的冷启动) 或 pane 观察到活着, 计数清零。 */
export const REVIVE_MAX = 3;

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
  /** pane 不在了、会话绑定还在: 落一条 trigger 行 (re = 它在本 room 欠的 duty) 唤醒它 ——
   *  泵投递时 injectText 探活 gone, 会用 --resume 重建 pane 再贴。false = 行被拒
   *  (没有这个 room / 它已不是成员)。不走唤醒预算: 这是本该早就送到的那一下。 */
  revive: (room: string, uid: string, duties: readonly string[], text: string) => boolean;
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
  /** 重建次数 (REVIVE_MAX 上限) + 试满那一轮是否已 warn; 只在观察到 pane 活着时清零。 */
  const revives = new Map<string, { n: number; warned: boolean }>();
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

  /** (A) 两次确认后的重建: 每个 room 落一条 trigger 行 (re = 本 room 里它欠的 duty) 唤醒它,
   *  泵投递时 injectText 探活 gone → --resume 重生 pane 再把这批贴进去。不关账、不退出 room。 */
  const revivePanes = (uid: string, rooms: ReadonlySet<string>, attempt: number): number => {
    let written = 0;
    // 正文带第几次: judge 的去重 (同作者 / 同正文 / 同 re, 10 分钟内) 会把这几次重试吞成
    // 「已有一条」—— 重试就白记了; 带次数也是给模型的事实 (它知道这是重建而不是新活)。
    const text = "[wezard] 你的 pane 不在了 (两次扫描确认), 会话与绑定都还在 —— 正在重建 pane (第 " + attempt + " 次), 起来就是这同一个会话。你名下的 duty 仍开着 (见下): 接着做完, 用 chat_reply 交代。";
    for (const room of rooms) {
      const s = deps.stateOf(room);
      if (!s || !s.members.has("wizard:" + uid)) continue;
      const mine = openDuties(s).filter((d) => holderOf(s, d)?.id === uid).map((d) => d.msg);
      if (!mine.length) continue;
      if (deps.revive(room, uid, mine, text)) written++;
    }
    return written;
  };

  const summary = (fields: Record<string, unknown>, baselineRow: boolean): void => {
    const counts = ["holders", "stale", "suspect", "idleFixed", "revived", "busy", "cold"] as const;
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
      summary({ holders: 0, stale: 0, suspect: 0, idleFixed: 0, revived: 0, busy: 0, cold: 0 }, false);
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
      summary({ baseline: true, holders: hs.size, stale: 0, suspect: 0, idleFixed: 0, revived: 0, busy: 0, cold: 0 }, true);
      deps.kick();
      return;
    }

    let stale = 0, suspectCnt = 0, idleFixed = 0, revived = 0, busy = 0, cold = 0;
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
        revives.delete(w.target); // 活着的 pane 是新起点: 重建次数清零
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
      // (A) 两次确认: 重建 pane 叫醒它 (§4a, 2026-11-24)。试满上限就停手 —— 再 spawn 也是
      // 白生一块马上又死, duty 不关, 交给逾期扫描升级。
      suspect.delete(w.target);
      const tried = revives.get(w.target)?.n ?? 0;
      if (tried >= REVIVE_MAX) {
        if (!revives.get(w.target)?.warned) {
          revives.set(w.target, { n: tried, warned: true });
          deps.log?.warn({ mod: "room-watchdog", target: w.target, uid, rooms: [...rooms], pane, attempts: tried },
            "pane 两轮扫描不存在, 重建已试满上限: 停手 (duty 不关, 等它被下一条真消息叫醒或逾期升级)");
        }
        touch(w.target);
        continue;
      }
      const written = revivePanes(uid, rooms, tried + 1);
      revives.set(w.target, { n: tried + 1, warned: false });
      if (written) revived++;
      else deps.log?.warn({ mod: "room-watchdog", target: w.target, uid, rooms: [...rooms], pane }, "pane 两轮扫描不存在, 重建行没写进任何 room");
      touch(w.target); // 重建也算事件: 下一轮重新起算 stale / 疑似 (= 两次重建之间的退避)
    }
    summary({ holders: hs.size, stale, suspect: suspectCnt, idleFixed, revived, busy, cold, ...(busy ? { busyList } : {}) }, false);
    deps.kick();
  };

  return { touch, scan, holders, status: (): { failStreak: number; lastScanAt: number } => ({ failStreak, lastScanAt }) };
};
