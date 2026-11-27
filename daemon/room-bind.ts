// 源 ↔ room 多对一绑定 (§4.1 / §5.2 / §6): 纯判定 + 绑定证据 (dry-run)。
//
// 绑定的事实只在**目标 room 的账本**里 (bind / unbind op, P1), 这里不写盘也不碰 hub ——
// 路由 (daemon/index.ts) 把 planBind / planUnbind 的结论交给 hub.write, 由 store.append 落 op;
// 对账闸关着时 append 抛 BindGateClosed, 路由回 503 (fail-closed, 主流程照常回落恒等)。
//
// 2026-11-27 (docs/evolve/channel-topic-rooms.md): 频道帖子天然是自己的 topic room, 没有「首触接待」
// 了 —— 帖子源不能再 bind (400), 首触待判定扫描 / 帖子 host 补拉 / room_fork 的判定都已删。绑定只剩
// 群源; 存量的帖子源 bind op 照读 (topicRoomOf 首位尊重它), 仍可 unbind。
import type { Config } from "../shared/config.js";
import { isBoundRoom, openDuties, roomHost, type BindOp, type RoomState, type UnbindOp, type Who } from "../shared/room.js";
import { channelOf, postRefOf } from "./channel-posts.js";
import { isTopicRoomId } from "../shared/topic-room.js";

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

/** 这个 base 能不能当源: 只有群聊 (chat:<群id>)。频道帖子 (topic:<T>/<P> / 旧 chat:<opk…>) 天然是自己的
 *  topic room, 不再并进别的 room (2026-11-27); 频道键 (chat:<topic_id>) 不是 room; 单聊 (user:…) 一人
 *  一 room 收益低 (非目标)。 */
export const bindableSource = (cfg: Config, source: string): boolean => {
  if (!source.startsWith("chat:")) return false;
  return !channelOf(cfg, source);
};

/** 帖子源 (topic room id / 旧帖子 base / 频道键) —— planBind 对它们有单独的拒绝说明。 */
export const isChannelSource = (cfg: Config, source: string): boolean =>
  isTopicRoomId(source) || !!postRefOf(cfg, source)?.post || (source.startsWith("chat:") && !!channelOf(cfg, source));

/** §5.2 硬门 ①-⑤ + §6 权限。全部在 daemon 静态判, 判定面之外没有再放一道。 */
export const planBind = (
  a: BindContext & { source: string; room: string; actor: Who; why?: string },
  now: number,
): BindVerdict => {
  // 对账闸关 (boot 索引 ≠ 盘上重放): 拒绝任何绑定写, 路由继续回落恒等。
  if (!a.gate.ok) return { ok: false, status: 503, reason: "绑定索引对账失败, 暂不接受绑定写: " + (a.gate.reason ?? "") };
  const source = a.source.trim();
  const room = a.room.trim();
  if (!source) return { ok: false, status: 400, reason: "要绑哪个源? 给 source (chat:<群id>)" };
  // ⑤ 源不能是目标 room 的主源 (恒等绑定没有意义)。
  if (source === room) return { ok: false, status: 400, reason: "源就是本 room 的主源, 不需要绑定" };
  // ④ 源类型 = 群。频道帖子每帖一个 room (topic:<T>/<P>), 不再并进别处。
  if (isChannelSource(a.cfg, source)) return { ok: false, status: 400, reason: "频道帖子不能绑进别的 room: 每个帖子自己就是一个 room (topic:<频道>/<帖子>), 回话 = 评论根帖; 要拉别人进来用 room_invite / chat_ask" };
  if (!bindableSource(a.cfg, source)) return { ok: false, status: 400, reason: "这个源不能绑: 只有群聊 (chat:<群id>) 可作为源 (单聊不在本轮范围)" };
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
  lines.push("", "由你判断: 是不是同一件事。绑定用 room_bind({source, room}); 不是就留在这。");
  return lines.join("\n");
};


/** §4.1 源→room 的落点 (纯): 绑定优先; 源自己的 room 已诞生 → 它; 否则 fallback 或源自己。
 *  群源入站 (dispatch 前) 用它; 频道帖子走 channel-posts 的 topicRoomOf。 */
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
