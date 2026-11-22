// room 成员清理 (管理路径, POST /room/prune 的纯规划部分)。
// 背景: 2026-11-20 的 room 切换把每个聊天历史上出现过的实例都写成了成员 (via migrate),
// 群成员表因此膨胀到几十上百人; 名册里已经没有的身份 (旧 inbound uid) 也还挂着。
// 规则 (只动 wizard 成员; 人与 daemon 永远保留):
//   · host —— 保留 (移掉会换 host, 且未点名的人话按 host 落账)
//   · 本 room 有未结 duty —— 保留 (移掉会把它的账取消掉)
//   · keepRecentMs 内在本 room 说过话 (origin 不是 migrate) —— 保留
//   · 本群的默认身份 (target === room id) 与本群管家 —— 保留 (群不能因为清理而没人接)
//   · 订阅了这个 room (watch) —— 保留
// 其余 (迁移进来的历史实例 / 名册已无记录的 uid) 一律离开, why 里写清依据。
import { DAEMON, applyOp, holderOf, leaveOps, openDuties, roomHost, sameWho } from "../shared/room.js";
import type { JoinVia, MsgRow, RoomOp, RoomState, Who } from "../shared/room.js";

export interface PruneCtx {
  now: number;
  /** 「近期说过话」的窗口。 */
  keepRecentMs: number;
  /** uid → 名册记录; undefined = 名册已没有这个身份。 */
  rec: (uid: string) => { target: string; name: string } | undefined;
  /** 本群被绑定的管家 uid (没有就是没绑 / 解析不出)。 */
  stewardUid?: string;
}

export interface PruneKeep { who: Who; name: string; why: string }
export interface PruneDrop { who: Who; name: string; via: JoinVia; uid: string; lastAt: number; why: string }
export interface RoomPrunePlan { room: string; title: string; before: number; keep: PruneKeep[]; drop: PruneDrop[] }

const hours = (ms: number): string => Math.round(ms / 3600_000) + "h";

/** 每个 who 在本 room 的最后一次真实发言 (迁移行不算: 那些话不是它在这个 room 说的)。 */
const lastSpokeOf = (s: RoomState): Map<string, number> => {
  const out = new Map<string, number>();
  for (const m of s.msgs as MsgRow[]) {
    if (m.origin === "migrate") continue;
    const k = m.author.kind + ":" + m.author.id;
    out.set(k, Math.max(out.get(k) ?? 0, m.at));
  }
  return out;
};

/** 一个 room 该留谁、该移谁。纯函数: 不改 s。 */
export const selectRoomPrune = (s: RoomState, ctx: PruneCtx): RoomPrunePlan => {
  const host = roomHost(s);
  const lastSpoke = lastSpokeOf(s);
  const duties = openDuties(s);
  const keep: PruneKeep[] = [];
  const drop: PruneDrop[] = [];
  for (const m of [...s.members.values()].sort((a, b) => a.ord - b.ord)) {
    const who = m.who;
    if (who.kind !== "wizard") { keep.push({ who, name: who.id, why: who.kind === "human" ? "人" : "daemon" }); continue; }
    const rec = ctx.rec(who.id);
    const name = rec?.name ?? who.id;
    const lastAt = lastSpoke.get("wizard:" + who.id) ?? 0;
    const mine = duties.filter((d) => sameWho(holderOf(s, d), who)).length;
    const why =
      sameWho(host, who) ? "host"
      : mine ? "duty " + mine
      : lastAt && ctx.now - lastAt <= ctx.keepRecentMs ? hours(ctx.now - lastAt) + " 前说过话"
      : rec && rec.target === s.id ? "本群默认身份"
      : ctx.stewardUid && who.id === ctx.stewardUid ? "本群管家"
      : m.watch ? "订阅中"
      : "";
    if (why) { keep.push({ who, name, why }); continue; }
    drop.push({
      who, name, uid: who.id, via: m.via, lastAt,
      why: rec
        ? (lastAt ? hours(ctx.now - lastAt) : "从未") + " 没在本 room 说话 (via " + m.via + ")"
        : "名册已无此身份 (via " + m.via + ")",
    });
  }
  return { room: s.id, title: s.title ?? "", before: s.members.size, keep, drop };
};

/** 一份计划里所有离开按同一个 seq 序列落账 (带 duty 的成员会先写 canceled reply —— 见 leaveOps)。
 *  只在克隆上 fold, 不动调用方持有的 state。 */
export const pruneLeaveOps = (s: RoomState, drops: readonly PruneDrop[], now: number): RoomOp[] => {
  const clone = (x: RoomState): RoomState => ({ ...x, members: new Map(x.members), msgs: [...x.msgs], byId: new Map(x.byId), duties: new Map(x.duties), everMembers: new Map(x.everMembers) });
  let st = clone(s);
  const out: RoomOp[] = [];
  for (const d of drops) {
    const ops = leaveOps(st, d.who, DAEMON, now, d.why);
    out.push(...ops);
    st = ops.reduce(applyOp, st);
  }
  return out;
};
