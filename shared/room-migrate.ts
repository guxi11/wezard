// 迁移 (契约 §6): 源数据快照 → 每个 room 要追加的 op + 计数报表。纯函数, 无 IO。
//
// 幂等靠两条, 不需要任何「迁移完成」标记:
//   ① 消息行带确定键 mig:<sha8(源+源键)> —— 账本里已有同键的行就跳过;
//   ② 结构性行 (open / join / seen) 从现有账本 fold 出来的状态判定 —— 已经有了就不写。
// 所以第二次跑必定 0 行。源一律只读, 原文件一个字不改。
//
// 迁进来的两类「还欠着」的行 (未结路由 / queued 事件) 被刻意写成 origin inbound / tool:
// 它们不是历史, 得开 duty 让人还; 而 origin migrate 的历史行既不开 duty, 也不回镜进企微
// (mirrors() 的两条排除)。人话那条也不镜像 —— 人当时就在群里看见了自己那句。
import { createHash } from "node:crypto";
import type { ChatLine } from "./chat-record.js";
import type { LegacyRoute } from "./legacy-routes.js";
import {
  DAEMON, applyOp, dmRoomId, foldRoom, isBoundRoom, msgIdOf, uidOf, whoKey,
  type MsgKind, type MsgOrigin, type MsgRow, type RoomKind, type RoomOp, type RoomState, type SpeakBasis, type Who,
} from "./room.js";
import { baseOfKey, stripSigil } from "./session-label.js";

/** 近 7 天在该群有轮次的 wizard 也算成员。 */
export const RECENT_TURN_MS = 7 * 86_400_000;

// ── 确定键 ─────────────────────────────────────────────────────────────

const sha8 = (s: string): string => createHash("sha1").update(s).digest("hex").slice(0, 8);

/** 一条迁入行的确定键 (源 + 源键)。同一源行算出的键跨机器、跨次运行都一样。 */
export const migKey = (source: string, key: string): string => "mig:" + sha8(source + "|" + key);
/** 账本行的 ext: 确定键 + 老坐标 (老 seq / 老 event id) —— 给人查账, 不参与幂等。 */
export const migExt = (source: string, key: string, legacy: string): string => migKey(source, key) + "|legacy:" + legacy;
/** ext 里的确定键部分 (幂等只看它)。 */
export const migIdOf = (ext: string | undefined): string => {
  const s = ext ?? "";
  const cut = s.indexOf("|");
  return cut < 0 ? s : s.slice(0, cut);
};
const legacyNumberOf = (ext: string): number | undefined => {
  const cut = ext.indexOf("|legacy:");
  if (cut < 0) return undefined;
  const n = Number(ext.slice(cut + 8));
  return Number.isFinite(n) ? n : undefined;
};

// ── 源 (只读快照) ──────────────────────────────────────────────────────

export interface WizardSnap {
  target: string;
  name?: string;
  bornAt?: number;
  uid?: string;
}

/** members.json 的一行 (键 <chat>|<target> 拆开)。 */
export interface MemberSnap {
  chat: string;
  target: string;
  since?: number;
  /** 已消费到的 chat-records seq; -1 / 缺省 = 一条没读。 */
  cursor?: number;
}

/** details.jsonl 里的 turn 行 (只取迁移用得着的三个字段)。 */
export interface TurnSnap {
  target?: string;
  channel?: string;
  at?: number;
}

export interface ChatSnap {
  chat: string;
  lines: readonly ChatLine[];
}

/** message-events.json 的一行 (只取迁移用得着的形状)。 */
export interface StoredEvent {
  id: string;
  execution: string;
  exposure?: string;
  target?: string;
  channel?: string;
  speaker?: string;
  payload?: {
    text?: string;
    human?: { text?: string; speaker?: string; channel?: string };
    peer?: { from?: { from?: string; kind?: string } };
  };
}

export interface MigrateSources {
  now: number;
  wizards: readonly WizardSnap[];
  /** config chatPolicy[chat].steward —— 绑定管家的 wizard 身份名 (裸名)。 */
  stewardOf?: (chat: string) => string | undefined;
  chats: readonly ChatSnap[];
  members: readonly MemberSnap[];
  turns: readonly TurnSnap[];
  /** 老 routes.jsonl fold 出来的未结行 (shared/legacy-routes.ts)。 */
  routes: readonly LegacyRoute[];
  events: readonly StoredEvent[];
  /** 每个 room 已经落盘的行 (rooms/*.jsonl) —— 幂等的唯一依据。 */
  existing: Readonly<Record<string, readonly RoomOp[]>>;
}

// ── 产物 ───────────────────────────────────────────────────────────────

export interface MigrateRoomPlan {
  room: string;
  kind: RoomKind;
  ops: RoomOp[];
}

export interface MigrateReport {
  /** 涉及的 room 数 (含本次 0 行的)。 */
  rooms: number;
  newRooms: number;
  /** 本次要写的行数 (二跑 = 0)。 */
  writes: number;
  joins: number;
  history: number;
  seen: number;
  routes: { chat: number; wizard: number };
  events: { uncertain: number; queuedHuman: number; queuedPeer: number; skipped: number };
  /** 源里有、账本里已有确定键 → 跳过的行数。 */
  duplicate: number;
  /** 传输无法从文件区分、按 wecom-group 处理的 room。 */
  ambiguousKind: string[];
  /** 名册里查不到的 target / 名字 (uid 走 uidOf 的确定回退)。 */
  unknownWizards: string[];
  /** 重名 (取 bornAt 最新的那条记录)。 */
  duplicateNames: string[];
}

export interface MigratePlan {
  rooms: MigrateRoomPlan[];
  /** 原样归档的 uncertain 事件 (写进 rooms/_archive/message-events-uncertain.json)。 */
  archive: StoredEvent[];
  report: MigrateReport;
}

// ── 小工具 ─────────────────────────────────────────────────────────────

const wizardWho = (uid: string): Who => ({ kind: "wizard", id: uid });
const humanWho = (userid: string): Who => ({ kind: "human", id: userid });

/** 聊天键 → room kind。文件里只有键, 分不出 topic 帖 / 微信, 一律按群算 (报表列出)。 */
const kindOf = (room: string): RoomKind => (room.startsWith("user:") ? "wecom-dm" : "wecom-group");
const looksAmbiguous = (room: string): boolean => !/^(user:|chat:wr)/.test(room);
const userIdOf = (raw: string | undefined): string => (raw ?? "").trim().replace(/^user:/, "") || "unknown";
const nameKeyOf = (name: string | undefined): string => stripSigil(name ?? "").toLowerCase();

/** 同一个 id 在文件里可能出现两次 (record 覆盖写也 append) —— 后写的赢, 再按 seq 定序。 */
const normalizeLines = (lines: readonly ChatLine[]): ChatLine[] => {
  const slot = new Map<string, number>();
  const out: ChatLine[] = [];
  for (const l of lines) {
    if (!l || typeof l.seq !== "number" || !Number.isFinite(l.seq)) continue;
    const key = l.id ? "id:" + l.id : "seq:" + l.seq;
    const at = slot.get(key);
    if (at === undefined) {
      slot.set(key, out.length);
      out.push(l);
    } else out[at] = l;
  }
  return out.sort((a, b) => a.seq - b.seq);
};

// ── 内部结构 ───────────────────────────────────────────────────────────

interface Out {
  room: string;
  kind: RoomKind;
  /** 现有账本 + 本次已生成的行 (fold 随写推进, 幂等与 seq 都看它)。 */
  st: RoomState;
  ops: RoomOp[];
  /** 已经落进账本的确定键。 */
  known: Set<string>;
  /** 老 seq → 新 seq (成员游标映射)。 */
  legacy: Array<{ legacy: number; seq: number }>;
}

interface LineDraft {
  author: Who;
  kind: MsgKind;
  text: string;
  origin: MsgOrigin;
  ext: string;
  speak?: SpeakBasis;
  to?: Who[];
  at?: number;
}

/** 作者的发言依据: 人 = human, daemon = daemon, wizard 记 member (当时能说就说明当时是成员)。 */
const speakOf = (who: Who): SpeakBasis => (who.kind === "human" ? "human" : who.kind === "daemon" ? "daemon" : "member");

/** 老记录的一行 → 作者。人 = userid; wizard = 名字查名册; wezard / 空 = daemon。 */
const authorOfLine = (
  l: ChatLine,
  uidByName: (name: string | undefined) => string | undefined,
  unknown: Set<string>,
): Who => {
  const raw = typeof l.author === "string" ? l.author : "";
  if (!raw || raw === "wezard" || l.kind === "system") return DAEMON;
  if (l.kind === "human") return humanWho(raw);
  const uid = uidByName(raw);
  if (uid) return wizardWho(uid);
  unknown.add("name:" + raw);
  return wizardWho(uidOf({ target: "name:" + raw }));
};

// ── 主体 ───────────────────────────────────────────────────────────────

export const migrateRooms = (src: MigrateSources): MigratePlan => {
  const now = src.now;
  const unknown = new Set<string>();
  const dupNames = new Set<string>();
  const ambiguous = new Set<string>();
  const report: MigrateReport = {
    rooms: 0, newRooms: 0, writes: 0, joins: 0, history: 0, seen: 0,
    routes: { chat: 0, wizard: 0 },
    events: { uncertain: 0, queuedHuman: 0, queuedPeer: 0, skipped: 0 },
    duplicate: 0, ambiguousKind: [], unknownWizards: [], duplicateNames: [],
  };

  // ── 名册: target → uid, 名字 → 记录 (重名取 bornAt 最新, 缺 bornAt 的排最后) ──
  const recs = src.wizards.filter((w) => typeof w.target === "string" && w.target !== "");
  const bornOf = (r: WizardSnap): number =>
    typeof r.bornAt === "number" && Number.isFinite(r.bornAt) ? r.bornAt : -Infinity;
  const uidByTarget = new Map(recs.map((r) => [r.target, uidOf(r)]));
  const wizardUid = (target: string): string => {
    const hit = uidByTarget.get(target);
    if (hit) return hit;
    unknown.add(target);
    return uidOf({ target });
  };
  const byName = new Map<string, WizardSnap>();
  for (const r of recs) {
    const k = nameKeyOf(r.name);
    if (!k) continue;
    const prev = byName.get(k);
    if (!prev) {
      byName.set(k, r);
      continue;
    }
    dupNames.add(k);
    const newer = bornOf(r) > bornOf(prev) || (bornOf(r) === bornOf(prev) && r.target < prev.target);
    if (newer) byName.set(k, r);
  }
  const uidByName = (name: string | undefined): string | undefined => {
    const hit = byName.get(nameKeyOf(name));
    return hit ? uidOf(hit) : undefined;
  };

  // ── room 的写入口 ──
  const outs = new Map<string, Out>();
  const emit = (o: Out, op: RoomOp): void => {
    o.ops.push(op);
    applyOp(o.st, op);
  };
  const outOf = (room: string, kind: RoomKind): Out => {
    const hit = outs.get(room);
    if (hit) return hit;
    const prior = src.existing[room] ?? [];
    const st = foldRoom(room, prior);
    const o: Out = {
      room,
      kind: isBoundRoom(room) ? kind : room.startsWith("dm:") ? "dm" : "adhoc",
      st,
      ops: [],
      known: new Set(),
      legacy: [],
    };
    for (const op of prior) {
      if (op.op !== "msg" || !op.ext) continue;
      o.known.add(migIdOf(op.ext));
      const lg = legacyNumberOf(op.ext);
      if (lg !== undefined) o.legacy.push({ legacy: lg, seq: op.seq });
    }
    if (!st.kind) {
      report.newRooms += 1;
      emit(o, { op: "open", at: now, room, kind: o.kind, by: DAEMON });
    }
    outs.set(room, o);
    return o;
  };

  /** 入群。已经在了就不写 (二跑 0 行靠这条)。 */
  const join = (o: Out, uid: string): void => {
    const who = wizardWho(uid);
    if (o.st.members.has(whoKey(who))) return;
    emit(o, { op: "join", at: now, room: o.room, who, ord: o.st.nextOrd, via: "migrate", by: DAEMON });
    report.joins += 1;
  };

  /** 一条消息行。同一个确定键已经在账本里 → 跳过并计数。返回是否真的写了。 */
  const pushLine = (o: Out, d: LineDraft): boolean => {
    const key = migIdOf(d.ext);
    if (o.known.has(key)) {
      report.duplicate += 1;
      return false;
    }
    const seq = o.st.seq + 1;
    const row: MsgRow = {
      op: "msg", at: d.at ?? now, room: o.room, id: msgIdOf(o.room, seq), seq,
      author: d.author,
      ord: d.author.kind === "wizard" ? o.st.members.get(whoKey(d.author))?.ord ?? 0 : 0,
      speak: d.speak ?? speakOf(d.author),
      kind: d.kind,
      text: d.text,
      ...(d.to && d.to.length ? { to: d.to } : {}),
      wake: [],
      origin: d.origin,
      ext: d.ext,
    };
    emit(o, row);
    o.known.add(key);
    const lg = legacyNumberOf(d.ext);
    if (lg !== undefined) o.legacy.push({ legacy: lg, seq });
    return true;
  };

  // ── 绑定 room: chat-records 文件 ∪ members.json 里出现的 chat ──
  const chats = src.chats
    .filter((c) => !!c.chat)
    .map((c) => ({ chat: c.chat, lines: normalizeLines(c.lines) }));

  const membersOf = (chat: string): MemberSnap[] =>
    src.members
      .filter((m) => m.chat === chat)
      .sort((a, b) => (a.since ?? 0) - (b.since ?? 0) || (a.target < b.target ? -1 : a.target > b.target ? 1 : 0));

  /** 管家的记录: 配置里的身份名 → 名册 (优先本群那条, 再取出生最新); 没配就取本群的默认会话。 */
  const founderOf = (chat: string): string | undefined => {
    const want = nameKeyOf(src.stewardOf?.(chat));
    if (want) {
      const best = recs
        .filter((r) => nameKeyOf(r.name) === want)
        .sort((a, b) =>
          Number(baseOfKey(b.target) === chat) - Number(baseOfKey(a.target) === chat)
          || bornOf(b) - bornOf(a)
          || (a.target < b.target ? -1 : 1))[0];
      if (best) return best.target;
    }
    return recs.find((r) => r.target === chat)?.target;
  };

  /** 近 7 天在该群开口过的 wizard (按开口先后)。 */
  const recentTargets = (chat: string): string[] => {
    const cutoff = now - RECENT_TURN_MS;
    const hits = src.turns
      .filter((t) => t.channel === chat && !!t.target && typeof t.at === "number" && t.at >= cutoff)
      .sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
    return [...new Set(hits.map((t) => t.target as string))];
  };

  for (const { chat, lines } of chats) {
    if (looksAmbiguous(chat)) ambiguous.add(chat);
    const o = outOf(chat, kindOf(chat));
    const founder = founderOf(chat);
    if (founder) join(o, wizardUid(founder));
    const rows = membersOf(chat);
    for (const m of rows) join(o, wizardUid(m.target));
    for (const t of recentTargets(chat)) join(o, wizardUid(t));

    // 历史: 每行一句, origin migrate (不开 duty、不回镜)。
    for (const l of lines) {
      pushLine(o, {
        author: authorOfLine(l, uidByName, unknown),
        kind: l.kind === "system" ? "system" : "say",
        text: typeof l.text === "string" ? l.text : "",
        at: typeof l.at === "number" && Number.isFinite(l.at) ? l.at : now,
        origin: "migrate",
        ext: migExt("chats/" + chat, l.id || "seq:" + l.seq, String(l.seq)),
      });
      report.history += 1;
    }

    // 成员游标 (老 seq) → seen 行 (新 seq)。
    const carried = new Set<string>();
    for (const m of rows) {
      const cursor = m.cursor;
      if (typeof cursor !== "number" || cursor < 0) continue;
      const who = wizardWho(wizardUid(m.target));
      carried.add(whoKey(who));
      const seq = o.legacy.reduce((best, p) => (p.legacy <= cursor && p.seq > best ? p.seq : best), 0);
      if (!seq || seq <= (o.st.members.get(whoKey(who))?.seen ?? 0)) continue;
      emit(o, { op: "seen", at: now, room: chat, who, seq });
      report.seen += 1;
    }
    // 没有老游标的人 (管家 / 近 7 天才进来的 / 老表里缺这一行) 不该被整段历史重新喂一遍:
    // 迁进来的历史到此刻为止都算读过。有游标的照它映射 —— 当时没读完的照旧没读完。
    // 界线是「历史最后一条的 seq」而不是 room 的当前 seq: 未结路由 / queued 事件写在历史之后,
    // 对谁都得是未读 (二跑时账本里已经有它们, 拿当前 seq 当界线会把人推过它们)。
    const historyEnd = o.legacy.reduce((best, p) => (p.seq > best ? p.seq : best), 0);
    for (const member of [...o.st.members.values()]) {
      if (member.who.kind !== "wizard" || carried.has(whoKey(member.who))) continue;
      if (historyEnd <= member.seen) continue;
      emit(o, { op: "seen", at: now, room: chat, who: member.who, seq: historyEnd });
      report.seen += 1;
    }
  }

  // ── 未结路由: chat 接收 → 该群一句人话; wizard 接收 → dm room 一条 task ──
  const eventsById = new Map(src.events.map((e) => [e.id, e] as const));
  const routeRows = [...src.routes].sort((a, b) => a.at - b.at || (a.event < b.event ? -1 : a.event > b.event ? 1 : 0));
  for (const r of routeRows) {
    const owner = wizardWho(wizardUid(r.owner));
    if (r.receiver.kind === "chat") {
      const room = r.receiver.channel;
      const o = outOf(room, kindOf(room));
      join(o, owner.id);
      const ev = eventsById.get(r.receiver.message);
      const text = ev?.payload?.human?.text || ev?.payload?.text || "[迁移] 未结人话 " + r.event;
      pushLine(o, {
        author: humanWho(userIdOf(r.asker?.who ?? ev?.speaker)),
        kind: "say",
        speak: "human",
        text,
        to: [owner],
        origin: "inbound",
        ext: migExt("routes.jsonl", r.event, r.event),
      });
      report.routes.chat += 1;
      continue;
    }
    const peer = wizardWho(wizardUid(r.receiver.to));
    if (peer.id === owner.id) {
      unknown.add("routes:" + r.event);
      report.routes.wizard += 1;
      continue;
    }
    const o = outOf(dmRoomId(peer.id, owner.id), "dm");
    join(o, peer.id);
    join(o, owner.id);
    const ev = r.receiver.event ? eventsById.get(r.receiver.event) : undefined;
    pushLine(o, {
      author: peer,
      kind: "task",
      speak: "member",
      text: ev?.payload?.text || "[迁移] 未结派活 " + r.event,
      to: [owner],
      origin: "tool",
      ext: migExt("routes.jsonl", r.event, r.event),
    });
    report.routes.wizard += 1;
  }

  // ── message-events: uncertain 归档, queued 转成 msg, 其余跳过 ──
  const archive: StoredEvent[] = [];
  const eventRows = [...src.events].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const e of eventRows) {
    if (e.execution === "uncertain") {
      archive.push(e);
      report.events.uncertain += 1;
      continue;
    }
    if (e.execution !== "queued") {
      report.events.skipped += 1;
      continue;
    }
    const human = e.payload?.human;
    const peer = e.payload?.peer;
    if (human) {
      const room = e.channel || human.channel || baseOfKey(e.target ?? "");
      if (!room) {
        report.events.skipped += 1;
        continue;
      }
      const o = outOf(room, kindOf(room));
      pushLine(o, {
        author: humanWho(userIdOf(e.speaker || human.speaker)),
        kind: "say",
        speak: "human",
        text: e.payload?.text || human.text || "",
        origin: "inbound",
        ext: migExt("message-events.json", e.id, e.id),
      });
      report.events.queuedHuman += 1;
      continue;
    }
    if (peer) {
      const from = peer.from?.from;
      const to = e.target;
      if (!from || !to) {
        report.events.skipped += 1;
        continue;
      }
      const asker = wizardWho(wizardUid(from));
      const worker = wizardWho(wizardUid(to));
      if (asker.id === worker.id) {
        unknown.add("events:" + e.id);
        report.events.skipped += 1;
        continue;
      }
      const o = outOf(dmRoomId(asker.id, worker.id), "dm");
      join(o, asker.id);
      join(o, worker.id);
      pushLine(o, {
        author: asker,
        kind: "task",
        speak: "member",
        text: e.payload?.text || "",
        to: [worker],
        origin: "tool",
        ext: migExt("message-events.json", e.id, e.id),
      });
      report.events.queuedPeer += 1;
      continue;
    }
    report.events.skipped += 1;
  }

  const rooms: MigrateRoomPlan[] = [...outs.values()]
    .filter((o) => o.ops.length)
    .sort((a, b) => (a.room < b.room ? -1 : a.room > b.room ? 1 : 0))
    .map((o) => ({ room: o.room, kind: o.kind, ops: o.ops }));

  report.rooms = outs.size;
  report.writes = rooms.reduce((n, r) => n + r.ops.length, 0);
  report.ambiguousKind = [...ambiguous].sort();
  report.unknownWizards = [...unknown].sort();
  report.duplicateNames = [...dupNames].sort();
  return { rooms, archive, report };
};

/** 报表正文 (人读; CLI 直接打印)。计数都是「源侧有几条」, 实际写了几行看 writes。 */
export const renderReport = (r: MigrateReport): string => {
  const lines = [
    "room " + r.rooms + " 个 (新建 " + r.newRooms + ") · 本次写入 " + r.writes + " 行" + (r.duplicate ? " · 已迁过跳过 " + r.duplicate : ""),
    "join " + r.joins + " · 历史 " + r.history + " · 游标 " + r.seen,
    "未结路由: 群 " + r.routes.chat + " · wizard " + r.routes.wizard,
    "message-events: uncertain " + r.events.uncertain + " (归档) · queued 人话 " + r.events.queuedHuman + " · queued 派活 " + r.events.queuedPeer + " · 其余跳过 " + r.events.skipped,
  ];
  if (r.ambiguousKind.length) lines.push("传输分不出、按 wecom-group 处理: " + r.ambiguousKind.join(", "));
  if (r.unknownWizards.length) lines.push("名册里查不到 (uid 走确定回退): " + r.unknownWizards.join(", "));
  if (r.duplicateNames.length) lines.push("重名 (取 bornAt 最新): " + r.duplicateNames.join(", "));
  return lines.join("\n");
};
