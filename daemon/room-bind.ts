// 源 ↔ room 多对一绑定 (§4.1 / §5.1 / §5.2 / §6 / §7): 纯判定 + 待判定扫描 + 频道成员补拉。
//
// 绑定的事实只在**目标 room 的账本**里 (bind / unbind op, P1), 这里不写盘也不碰 hub ——
// 路由 (daemon/index.ts) 把 planBind / planUnbind 的结论交给 hub.write, 由 store.append 落 op;
// 对账闸关着时 append 抛 BindGateClosed, 路由回 503 (fail-closed, 主流程照常回落恒等)。
//
// 待判定 (首触兜底) 与存量补拉都**从账本现算**, 不维护第二份队列: 频道 room 里带 src 的人话行
// 就是「这个帖子源来过、还没被处置」的全部事实; boot 重建后同一个扫描自然接上。
import type { Config } from "../shared/config.js";
import { roomHost, whoKey, type BindOp, type RoomState, type UnbindOp, type Who } from "../shared/room.js";
import { botOfKey } from "../shared/session-label.js";
import { channelOf, postRefOf } from "./channel-posts.js";

/** 绑定的判定面: 索引 / 账本 / 对账闸都由调用方现取 (hot, 不缓存)。 */
export interface BindContext {
  cfg: Config;
  /** 源 → 承载 room (P1 boot 索引); 未绑定 / 闸关 = undefined。 */
  roomOfSource: (source: string) => string | undefined;
  stateOf: (room: string) => RoomState | undefined;
  gate: { ok: boolean; reason?: string };
}

export type BindVerdict =
  | { ok: true; op: BindOp; already: boolean }
  | { ok: false; status: 400 | 403 | 404 | 409 | 503; reason: string };

/** 这个 base 能不能当源: 群聊 (chat:<群id>) 或频道帖子 (chat:<opk…>)。频道自己 (chat:<topic_id>)
 *  与单聊 (user:…) 都不是源 —— 前者本来就是一个 room, 后者一人一 room 收益低 (非目标)。 */
export const bindableSource = (cfg: Config, source: string): boolean => {
  if (!source.startsWith("chat:")) return false;
  const topic = channelOf(cfg, source);
  return !(topic && source === "chat:" + topic);
};

/** §5.2 硬门 ①-⑤ + §6 权限。全部在 daemon 静态判, 判定面之外没有再放一道。 */
export const planBind = (
  a: BindContext & { source: string; room: string; actor: Who; why?: string },
  now: number,
): BindVerdict => {
  // 对账闸关 (boot 索引 ≠ 盘上重放): 拒绝任何绑定写, 路由继续回落恒等。
  if (!a.gate.ok) return { ok: false, status: 503, reason: "绑定索引对账失败, 暂不接受绑定写: " + (a.gate.reason ?? "") };
  const source = a.source.trim();
  const room = a.room.trim();
  if (!source) return { ok: false, status: 400, reason: "要绑哪个源? 给 source (chat:<群id> 或 chat:<opk…>)" };
  // ⑤ 源不能是目标 room 的主源 (恒等绑定没有意义)。
  if (source === room) return { ok: false, status: 400, reason: "源就是本 room 的主源, 不需要绑定" };
  // ④ 源类型 ∈ {群, 帖子}。
  if (!bindableSource(a.cfg, source)) return { ok: false, status: 400, reason: "这个源不能绑: 只有群聊 (chat:<群id>) 与频道帖子 (chat:<opk…>) 可作为源 (频道自己就是一个 room; 单聊不在本轮范围)" };
  // ① 同 bot: 跨机器人的源与 room 之间没有收发通路。
  if (botOfKey(source) !== botOfKey(room)) return { ok: false, status: 400, reason: "跨机器人的源与 room 不能绑定 (" + (botOfKey(source) || "主机器人") + " ≠ " + (botOfKey(room) || "主机器人") + ")" };
  // ③ 目标 room 存在且有 host。
  const s = a.stateOf(room);
  if (!s) return { ok: false, status: 404, reason: "没有这个 room: " + room };
  const host = roomHost(s);
  if (!host) return { ok: false, status: 409, reason: "目标 room 还没有 host: " + room + " (先在 room 里有人接手, 再绑)" };
  // §6 权限: 目标 room 的 host 或人可写; 其他一律拒 (让它先 chat_ask 目标 host)。
  if (!(a.actor.kind === "human" || (host.kind === "wizard" && host.id === a.actor.id))) {
    return { ok: false, status: 403, reason: "只有目标 room 的 host 或人能绑定 —— 先 chat_ask " + (host.kind === "wizard" ? "那个 room 的 host" : "目标 room 里的人") + ", 让它自己 room_bind" };
  }
  // ② 一源一 room: 已绑在本 room = 幂等成功; 绑在别处 = 先 unbind。
  const bound = a.roomOfSource(source);
  if (bound && bound !== room) return { ok: false, status: 409, reason: "这个源已经绑在 " + bound + " —— 想换先在那里 room_unbind" };
  const why = a.why?.trim();
  return {
    ok: true,
    already: bound === room,
    op: { op: "bind", at: now, room, source, by: a.actor, ...(why ? { why } : {}) },
  };
};

export type UnbindVerdict =
  | { ok: true; op: UnbindOp }
  | { ok: false; status: 400 | 403 | 404 | 409 | 503; reason: string };

export const planUnbind = (
  a: BindContext & { source: string; room: string; actor: Who; why?: string },
  now: number,
): UnbindVerdict => {
  if (!a.gate.ok) return { ok: false, status: 503, reason: "绑定索引对账失败, 暂不接受解绑写: " + (a.gate.reason ?? "") };
  const source = a.source.trim();
  const room = a.room.trim();
  if (!source) return { ok: false, status: 400, reason: "要解哪个源? 给 source" };
  const s = a.stateOf(room);
  if (!s) return { ok: false, status: 404, reason: "没有这个 room: " + room };
  const host = roomHost(s);
  if (!(a.actor.kind === "human" || (host?.kind === "wizard" && host.id === a.actor.id))) {
    return { ok: false, status: 403, reason: "只有目标 room 的 host 或人能解绑" };
  }
  if (!s.bindings.has(source)) return { ok: false, status: 409, reason: "这个源没有绑在本 room: " + source };
  const why = a.why?.trim();
  return { ok: true, op: { op: "unbind", at: now, room, source, by: a.actor, ...(why ? { why } : {}) } };
};

/** 首触待判定的一条: 频道 room 收了这个源的@, host 至今没有 bind, 帖子 room 也还没诞生。 */
export interface PendingFirstTouch {
  channelRoom: string;
  topicId: string;
  source: string;
  /** 这个源在频道 room 里最近一条人话的时刻 (判定窗口的起点)。 */
  at: number;
}

/** §5.1 兜底扫描 (纯): 从账本现算「超时该另起的首触」。判据全部是事实, 没有内存态:
 *   - 频道 room (kind "channel") 有 wizard host (引导期不兜底, 引导接一切人话);
 *   - 行是人话、带 src、src 属于本频道、帖子 room 还没诞生、源也没绑在别处;
 *   - 距今 >= timeoutMs。同一源只出一条 (取最近一条人话)。
 *  已绑 / 已诞生 / 已另起 的下一次扫描自然不再命中 —— 幂等由判据本身给, 不靠标记。 */
export const pendingFirstTouches = (a: {
  cfg: Config;
  states: readonly RoomState[];
  roomOfSource: (source: string) => string | undefined;
  stateOf: (room: string) => RoomState | undefined;
  now: number;
  timeoutMs: number;
}): PendingFirstTouch[] => {
  if (!(a.timeoutMs > 0)) return [];
  const out: PendingFirstTouch[] = [];
  for (const s of a.states) {
    if (s.kind !== "channel") continue;
    const host = roomHost(s);
    if (host?.kind !== "wizard") continue;
    const topicId = s.id.startsWith("chat:") ? s.id.slice("chat:".length) : "";
    if (!topicId) continue;
    const latest = new Map<string, number>();
    for (const m of s.msgs) {
      if (m.author.kind !== "human" || m.kind !== "say") continue;
      const src = m.src;
      if (!src || src === s.id) continue;
      if (postRefOf(a.cfg, src)?.channel !== topicId) continue;
      const prev = latest.get(src);
      if (prev === undefined || m.at > prev) latest.set(src, m.at);
    }
    for (const [source, at] of latest) {
      if (a.roomOfSource(source)) continue;          // 已经绑了 (本 room 或别处)
      if (a.stateOf(source)) continue;               // 帖子 room 已经诞生 (另起过)
      if (a.now - at < a.timeoutMs) continue;
      out.push({ channelRoom: s.id, topicId, source, at });
    }
  }
  return out;
};

/** boot 补拉 (§7) 的一条: 把一个已存在的帖子 room 的 host 实例补进频道 room。 */
export interface BackfillSeat {
  channelRoom: string;
  who: Who;
  /** 已有的帖子 host 实例的 target (日志用)。 */
  target: string;
}

/** §7 存量补拉 (纯): 帖子 room 的 host 实例进频道 room —— 让频道 host 在成员表里看得到每个帖子
 *  host。条件: 频道 room 存在、有 wizard host (引导期 / 空频道不拉)、帖子 room 有 wizard host
 *  且实例仍在册 (stop / forget 的跳过)、还不是频道成员。幂等: 已在成员表就不出。 */
export const planChannelBackfill = (a: {
  cfg: Config;
  rooms: readonly string[];
  stateOf: (room: string) => RoomState | undefined;
  targetOf: (uid: string) => string | undefined;
}): BackfillSeat[] => {
  const out: BackfillSeat[] = [];
  const seen = new Set<string>();
  for (const room of a.rooms) {
    const ref = postRefOf(a.cfg, room);
    if (!ref?.post) continue;
    const channelRoom = "chat:" + ref.channel;
    const cs = a.stateOf(channelRoom);
    const ps = a.stateOf(room);
    if (!cs || !ps) continue;
    const chHost = roomHost(cs);
    const postHost = roomHost(ps);
    if (chHost?.kind !== "wizard" || postHost?.kind !== "wizard") continue;
    const target = a.targetOf(postHost.id);
    if (!target) continue;                       // 实例不在册 (已 stop / 忘了) 不拉
    const key = channelRoom + "\n" + postHost.id;
    if (seen.has(key)) continue;
    if (cs.members.has(whoKey(postHost))) continue;
    seen.add(key);
    out.push({ channelRoom, who: postHost, target });
  }
  return out;
};
