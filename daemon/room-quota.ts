// room 出站额度 (修复单 §8a, design.md B2/C3): strict 时代的 openSayMeter 改为全量生效。
// 每个 wizard 每轮 ≤3 条、每 room 每分钟 ≤10 条, 超出 409 (文案给出口: 合并成一条 / 下一轮再说)。
// 计入面: wizard 经工具面写进 room 的行 (say / ask / task / file / 带 text 的 reply —— notify 落
// 的也是 say 行); daemon 系统行与人话不计。轮界 = turn_end (hub.onIdle) 重置该 wizard 的计数。
// 纯计数器, 不落盘 —— reload 清零只是多放行几条, 方向安全。
export interface RoomQuotaOpts { perTurn?: number; perRoomPerMin?: number; windowMs?: number }
export interface RoomQuota {
  /** 记一条并判定; ok=false 时这条**没有**被记 (被拒的发言不占额度)。 */
  admit: (uid: string, room: string, at: number) => { ok: boolean; reason?: string };
  /** turn_end: 该 wizard 本轮计数清零。 */
  endTurn: (uid: string) => void;
}

export const createRoomQuota = (opts: RoomQuotaOpts = {}): RoomQuota => {
  const perTurn = opts.perTurn ?? 3;
  const perRoom = opts.perRoomPerMin ?? 10;
  const windowMs = opts.windowMs ?? 60_000;
  const turnCount = new Map<string, number>();   // uid → 本轮已发条数
  const roomTimes = new Map<string, number[]>(); // room → 窗口内各条时刻
  return {
    admit: (uid, room, at) => {
      const turn = (turnCount.get(uid) ?? 0) + 1;
      if (turn > perTurn) return { ok: false, reason: "本轮发言已到 " + perTurn + " 条 (room 出站额度) — 合并成一条, 或等下一轮再说" };
      const win = (roomTimes.get(room) ?? []).filter((t) => at - t < windowMs);
      if (win.length + 1 > perRoom) return { ok: false, reason: "这个 room 最近 1 分钟已发 " + win.length + " 条 (room 出站额度) — 合并成一条, 或稍后再说" };
      turnCount.set(uid, turn);
      roomTimes.set(room, [...win, at]);
      return { ok: true };
    },
    endTurn: (uid) => { turnCount.delete(uid); },
  };
};
