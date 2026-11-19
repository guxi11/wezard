// room 看门狗 (wiring C, 上级拍板): 事件驱动为主 (MirrorDeps.onTurnEnd → hub.onIdle),
// 看门狗只兜「漏了 turn_end / pane 意外消失」两类 —— 一次扫描一条 tmux list-panes 批量取
// 全场, 不按 wizard 逐个探。只看「账本上有未结 duty 且距最后一次事件超过 staleMin」的 wizard:
//   · pane 活且闲 → 当作漏了 turn_end, hub.onIdle + kick 补投;
//   · pane 不存在 → 按实例结束: leaveOps (canceled reply 唤醒提问者) + 每个 room 一行
//     instance-ended 系统消息; 重复扫描不再写 (duty 已关, 天然幂等);
//   · pane 活但忙 → 只 warn (busyForMs / openDuties / name / uid), 不改账本。
import type { Logger } from "pino";
import { DAEMON, holderOf, leaveOps, msgIdOf, openDuties, type RoomOp, type RoomState, type Who } from "../shared/room.js";

export interface WatchdogDeps {
  log?: Logger;
  now?: () => number;
  /** 全场 pane_id 一次拿齐 (一次扫描只调一次 —— 单测④断言的就是它)。 */
  listPanes: () => Promise<readonly string[]>;
  /** uid → { target, name, paneId } (pane 缺省 = 没有绑定)。 */
  wizardOf: (uid: string) => { target: string; name: string; paneId?: string } | undefined;
  isBusy: (target: string) => Promise<boolean>;
  rooms: () => readonly string[];
  stateOf: (room: string) => RoomState | undefined;
  write: (room: string, ops: readonly RoomOp[]) => void;
  onIdle: (uid: string) => Promise<void> | void;
  kick: () => void;
  staleMs: () => number;
}

export const createRoomWatchdog = (deps: WatchdogDeps) => {
  const now = (): number => deps.now?.() ?? Date.now();
  /** target → 最后一次事件 (turn_end / 注入) 的时刻; stale 判定的分母。 */
  const activity = new Map<string, number>();
  /** target → 首次观察到忙的时刻 (warn 的 busyForMs)。 */
  const busySince = new Map<string, number>();
  const touch = (target: string): void => { activity.set(target, now()); busySince.delete(target); };

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

  const scan = async (): Promise<void> => {
    const panes = new Set(await deps.listPanes());
    const at = now();
    for (const [uid, rooms] of holders()) {
      const w = deps.wizardOf(uid);
      if (!w) continue;
      if (at - (activity.get(w.target) ?? 0) < deps.staleMs()) continue;
      const pane = w.paneId;
      if (!pane || !panes.has(pane)) {
        // 实例结束 (契约 §4): 名下 duty 落 canceled (leaveOps 的行带 wake, 提问者被唤醒),
        // 再补一行谁都看得见的 instance-ended; duty 已关, 重复扫描天然不再写。
        let canceled = 0;
        for (const room of rooms) {
          const s = deps.stateOf(room);
          if (!s) continue;
          const who: Who = { kind: "wizard", id: uid };
          if (!s.members.has("wizard:" + uid)) continue;
          canceled += openDuties(s).filter((d) => holderOf(s, d)?.id === uid).length;
          deps.write(room, leaveOps(s, who, DAEMON, at, "pane 不存在 (watchdog)"));
          const s2 = deps.stateOf(room);
          if (s2) deps.write(room, [{ op: "msg", at, room, id: msgIdOf(room, s2.seq + 1), seq: s2.seq + 1, author: DAEMON, ord: 0, speak: "daemon",
            kind: "system", sys: "instance-ended", origin: "daemon",
            text: "[wezard] ." + w.name + " 已结束 (pane 不存在), 名下 " + canceled + " 条未结 duty 已取消", wake: [] }]);
        }
        deps.log?.warn({ mod: "room-watchdog", target: w.target, uid, rooms: [...rooms], canceled }, "pane 消失, 按实例结束处理");
        touch(w.target);
        continue;
      }
      if (await deps.isBusy(w.target)) {
        busySince.set(w.target, busySince.get(w.target) ?? at);
        const duties = [...rooms].reduce((n, room) => {
          const s = deps.stateOf(room);
          return n + (s ? openDuties(s).filter((d) => holderOf(s, d)?.id === uid).length : 0);
        }, 0);
        deps.log?.warn({ mod: "room-watchdog", target: w.target, uid, name: w.name, busyForMs: at - (busySince.get(w.target) ?? at), openDuties: duties }, "pane 忙且持有未结 duty (长活?)");
        continue;
      }
      // pane 闲但没收到 turn_end: 当作漏了轮终, 只补一次 (touch 之后 stale 窗口重置)。
      touch(w.target);
      await deps.onIdle(uid);
    }
    deps.kick();
  };

  return { touch, scan, holders };
};

