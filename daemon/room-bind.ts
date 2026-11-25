// 源 ↔ room 多对一绑定 (§4.1 / §5.1 / §5.2 / §6 / §7): 纯判定 + 待判定扫描 + 频道成员补拉。
//
// 绑定的事实只在**目标 room 的账本**里 (bind / unbind op, P1), 这里不写盘也不碰 hub ——
// 路由 (daemon/index.ts) 把 planBind / planUnbind 的结论交给 hub.write, 由 store.append 落 op;
// 对账闸关着时 append 抛 BindGateClosed, 路由回 503 (fail-closed, 主流程照常回落恒等)。
//
// 待判定 (首触兜底) 与存量补拉都**从账本现算**, 不维护第二份队列: 频道 room 里带 src 的人话行
// 就是「这个帖子源来过、还没被处置」的全部事实; boot 重建后同一个扫描自然接上。
import type { Config } from "../shared/config.js";
import { isBoundRoom, openDuties, roomHost, whoKey, type BindOp, type RoomState, type UnbindOp, type Who } from "../shared/room.js";
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

// ── §5.2 判定证据 (dry-run): daemon 只给证据, 决定权在模型 ─────────────────
// 与 daemon/route.ts 的 route_candidates 同一套词汇与心法: 证据分层 (强→弱) + 硬 veto +
// 显式成本; 不在这里做确定性 decide —— 相关度是语义判断, 留给 host。只读: 不写账本。

const normText = (t: string): string => t.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

/** 规范化后的 trigram 集合 (CJK 按字, 拉丁按字符窗口; <3 字整句算一个)。 */
export const trigramsOf = (t: string): Set<string> => {
  const n = normText(t);
  const out = new Set<string>();
  if (!n) return out;
  if (n.length <= 3) { out.add(n); return out; }
  for (let i = 0; i + 3 <= n.length; i++) out.add(n.slice(i, i + 3));
  return out;
};

/** trigram 规范化重叠率 (Jaccard, 0-1)。 */
export const similarity = (a: string, b: string): number => {
  const A = trigramsOf(a), B = trigramsOf(b);
  if (!A.size || !B.size) return 0;
  let hit = 0;
  for (const g of A) if (B.has(g)) hit++;
  return hit / (A.size + B.size - hit);
};

/** 正文关键词 (CJK 2 字窗 + 拉丁 >=3 字词), 职责匹配用; 去重、最多 40 个。 */
export const keywordsOf = (t: string): string[] => {
  const n = normText(t);
  const out = new Set<string>();
  for (const w of t.toLowerCase().split(/[^\p{L}\p{N}]+/u)) if (w.length >= 3) out.add(w);
  for (let i = 0; i + 2 <= n.length; i++) out.add(n.slice(i, i + 2));
  return [...out].slice(0, 40);
};

export interface BindCandidate {
  room: string;
  host?: Who;
  /** 命中的证据 (强的在前), 空 = 没有交集。 */
  evidence: string[];
  /** daemon 硬判的否决原因; 非空 = 别绑它。 */
  veto: string[];
  score: number;
  /** 这个 room 最近一条消息的时刻 (排序 / 活跃度)。 */
  lastAt: number;
}

export interface CandidateReport {
  /** 全局否决 (源已绑别处): 非空时任何候选都不能直接绑。 */
  blocked: string;
  candidates: BindCandidate[];
  text: string;
}

const clipText = (t: string, n: number): string => { const s = t.replace(/\s+/g, " ").trim(); return s.length > n ? s.slice(0, n) + "…" : s; };

/** §5.2 候选与证据 (纯): 源的首触正文 / 发话人 vs 各 room 近期账本。
 *  证据 同 asker > 近期接待 > 正文相关 (>= simMin) > 职责匹配; veto: 跨 bot / 没有 host /
 *  死 room (busyWindowMin 内无行且无未结 duty) / 源已绑别处 (全局)。 */
export const bindCandidates = (a: {
  cfg: Config;
  source: string;
  text: string;
  asker: string;
  states: readonly RoomState[];
  roomOfSource: (source: string) => string | undefined;
  now: number;
  simMin: number;
  busyWindowMin: number;
  hostInfoOf?: (uid: string) => { name: string; responsibility: string } | undefined;
}): CandidateReport => {
  const bound = a.roomOfSource(a.source);
  const blocked = bound && bound !== a.source ? "这个源已经绑在 " + bound + " —— 想换地方先在那里 room_unbind" : "";
  const busyMs = Math.max(0, a.busyWindowMin) * 60_000;
  const keys = keywordsOf(a.text);
  const out: BindCandidate[] = [];
  for (const s of a.states) {
    if (s.id === a.source) continue;
    if (!isBoundRoom(s.id)) continue;
    const host = roomHost(s);
    const evidence: string[] = [];
    const veto: string[] = [];
    let score = 0;
    const lastAt = s.msgs.reduce((m, x) => Math.max(m, x.at), s.openedAt ?? 0);
    if (!host) veto.push("没有 host (没人接)");
    if (busyMs > 0 && a.now - lastAt > busyMs && openDuties(s).length === 0)
      veto.push("死 room (近 " + Math.round((a.now - lastAt) / 60_000) + " 分钟无活动, 没有未结 duty)");
    // ① 同 asker: 发话人在这个 room 近期说过话 (最强: 人就在那儿)。
    if (a.asker && s.msgs.some((m) => m.author.kind === "human" && m.author.id === a.asker && (busyMs <= 0 || a.now - m.at <= busyMs))) {
      evidence.push("同 asker (发话人在这说过话)");
      score += 4;
    }
    // ② 近期接待: 这个源的话曾经落在这本账 (解绑再来的回访)。
    if (s.msgs.some((m) => m.author.kind === "human" && m.src === a.source)) {
      evidence.push("近期接待 (这个源的话曾落这本账)");
      score += 3;
    }
    // ③ 正文相关: 与本 room 近期行 (最多 50 条) 的最大 trigram 重叠率。
    if (a.text.trim()) {
      let best = 0, bestText = "";
      for (const m of s.msgs.slice(-50)) {
        if (m.kind === "trigger" || m.author.kind === "daemon" || !m.text.trim()) continue;
        const v = similarity(a.text, m.text);
        if (v > best) { best = v; bestText = m.text; }
      }
      if (best >= a.simMin) {
        evidence.push("正文相关 " + Math.round(best * 100) + "% («" + clipText(bestText, 28) + "»)");
        score += 2 * best;
      }
    }
    // ④ 职责匹配: 候选 host 的职责里出现正文关键词。
    const info = host?.kind === "wizard" ? a.hostInfoOf?.(host.id) : undefined;
    if (info?.responsibility && keys.length) {
      const hits = keys.filter((k) => info.responsibility.includes(k));
      if (hits.length) { evidence.push("职责匹配 " + hits.slice(0, 3).join("/")); score += Math.min(1.5, hits.length * 0.5); }
    }
    out.push({ room: s.id, ...(host ? { host } : {}), evidence, veto, score, lastAt });
  }
  out.sort((x, y) => (x.veto.length ? 1 : 0) - (y.veto.length ? 1 : 0) || y.score - x.score || y.lastAt - x.lastAt);
  return { blocked, candidates: out, text: renderCandidates(out, blocked) };
};

const renderCandidates = (list: readonly BindCandidate[], blocked: string): string => {
  const nameOf = (w: Who): string => w.kind === "wizard" ? "." + w.id : w.kind + ":" + w.id;
  const lines: string[] = [blocked, blocked ? "" : "", "候选 room (证据强的在前: 同 asker > 近期接待 > 正文相关 > 职责匹配; 只是线索, 由你判断):"].filter((x) => x !== "");
  if (!list.length) lines.push("· 没有可绑的 room (除源自己以外的 bound room 一个也没有)。");
  for (const c of list) {
    const head = "· " + c.room + (c.host ? " (host " + nameOf(c.host) + ")" : " (没有 host)");
    if (c.veto.length) lines.push(head + " — ✗ " + c.veto.join("; "));
    else if (c.evidence.length) lines.push(head + " — " + c.evidence.join("; "));
    else lines.push(head + " — 没有交集");
  }
  lines.push("", "由你判断: 是不是同一件事。绑定用 room_bind({source, room}); 不是就留在这 (或 room_fork 另起)。");
  return lines.join("\n");
};


/** §4.1 源→room 的落点 (纯): 绑定优先; 帖子 room 已诞生 → 它; 否则 fallback (频道接待处) 或源自己。
 *  入站 (dispatch 前) 与 channelIngest 共用这一条, 保证两路落点一致。 */
export const sourceRoomOf = (a: {
  source: string;
  roomOfSource: (source: string) => string | undefined;
  stateOf: (room: string) => RoomState | undefined;
  fallback?: (source: string) => string | undefined;
}): string => {
  const bound = a.roomOfSource(a.source);
  if (bound) return bound;
  if (a.stateOf(a.source)) return a.source;
  return a.fallback?.(a.source) ?? a.source;
};

export type ForkVerdict =
  | { ok: true; topicId: string; channelRoom: string }
  | { ok: false; status: 400 | 403 | 404 | 409; reason: string };

/** §5.1 出口 3 的显式入口 (room_fork) 的判定 (纯): 只有频道帖子源、只有该频道 room 的 host (或人)、
 *  必须是「首触」(频道里这个源有人话) 且还没绑 / 帖子 room 还没诞生。幂等判据与超时兜底同一套。 */
export const planFork = (a: {
  cfg: Config;
  source: string;
  actor: Who;
  stateOf: (room: string) => RoomState | undefined;
  roomOfSource: (source: string) => string | undefined;
}): ForkVerdict => {
  const source = a.source.trim();
  const ref = source ? postRefOf(a.cfg, source) : undefined;
  if (!ref?.post) return { ok: false, status: 400, reason: "只有频道帖子源可以另起 (chat:<opk…>); 群源请用 room_bind 绑进一个已有 room" };
  const channelRoom = "chat:" + ref.channel;
  const cs = a.stateOf(channelRoom);
  if (!cs) return { ok: false, status: 404, reason: "这个频道还没有 room 账本: " + channelRoom };
  const host = roomHost(cs);
  if (!(a.actor.kind === "human" || (host?.kind === "wizard" && host.id === a.actor.id)))
    return { ok: false, status: 403, reason: "只有这个频道 room 的 host 能另起 (它不是你的接待面)" };
  const bound = a.roomOfSource(source);
  if (bound) return { ok: false, status: 409, reason: "这个源已绑在 " + bound + " —— 先解绑再另起" };
  if (a.stateOf(source)) return { ok: false, status: 409, reason: "帖子 room 已经诞生: " + source };
  if (!cs.msgs.some((m) => m.author.kind === "human" && m.src === source))
    return { ok: false, status: 409, reason: "这个源还没有首触 (频道里没有它的话), 不另起" };
  return { ok: true, topicId: ref.channel, channelRoom };
};

