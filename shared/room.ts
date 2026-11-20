// room 模型的纯核心 (契约: /tmp/wezard-room-contract.md, 已拍板)。
//
// 一条总原则: **完成信号、出处、发言权都是账本行上的显式字段**, 不从 transcript / 终句 /
// 信封里推断。room 是唯一的沟通对象 —— 企微群 / 单聊 / topic 帖是绑定了传输的 room,
// wizard 之间的两人对话是不绑定传输的 dm room。人和 wizard 走同一个 append 口子。
//
// 本文件无 IO: 账本行的类型、fold (行 → 状态)、append 前的判定 (ACL / status 写入权 /
// 覆盖检查 / 去重 / 唤醒 / 预算)、host 求值、镜像规则、uid 与 room id 的派生。落盘在
// daemon/rooms.ts, 接线在 daemon/room-hub.ts。
import { createHash } from "node:crypto";
import { join } from "node:path";
import { expandHome } from "./paths.js";

// ── 身份 ───────────────────────────────────────────────────────────────

export type WhoKind = "human" | "wizard" | "daemon";
/** wizard.id = 实例 uid (不含名字, 改名不变); human.id = userid; daemon.id = "wezard" | "task:<id>"。 */
export interface Who { kind: WhoKind; id: string }
export const whoKey = (w: Who): string => w.kind + ":" + w.id;
export const sameWho = (a: Who | undefined, b: Who | undefined): boolean => !!a && !!b && a.kind === b.kind && a.id === b.id;
export const DAEMON: Who = { kind: "daemon", id: "wezard" };

const UID_RE = /^w[0-9a-f]{12}$/;
export const isUid = (s: string | undefined): s is string => !!s && UID_RE.test(s);

const sha1 = (s: string): string => createHash("sha1").update(s).digest("hex");

/** 实例的稳定身份 id。已落盘的 uid 永远优先 (只读); 没有的按 target + bornAt 现算 ——
 *  迁移脚本与 daemon boot 回填走同一个函数, 算出同一个值。bornAt 缺失 (或非有限数) 时
 *  用确定的回退 \`target|-\`, 绝不把 undefined 拼进去。 */
export const uidOf = (rec: { uid?: string; target: string; bornAt?: number }): string => {
  if (isUid(rec.uid)) return rec.uid;
  if (!rec.target) throw new Error("uidOf: target required");
  const born = typeof rec.bornAt === "number" && Number.isFinite(rec.bornAt) ? String(rec.bornAt) : "-";
  const uid = "w" + sha1(rec.target + "|" + born).slice(0, 12);
  if (!isUid(uid)) throw new Error("uidOf: bad uid " + uid);
  return uid;
};

/** 新建实例时铸一个 uid (调用方给随机源, 保持本文件纯)。 */
export const mintUid = (randomHex: string): string => {
  const uid = "w" + randomHex.toLowerCase().replace(/[^0-9a-f]/g, "").slice(0, 12);
  if (!isUid(uid)) throw new Error("mintUid: need ≥12 hex chars");
  return uid;
};

// ── 账本目录 ────────────────────────────────────────────────────────────

/** room 账本目录 = <stateDir>/rooms, 唯一推导。daemon 读、迁移写、observe 重放都必须
 *  从这里取 —— 2026-11-19 切换失败就是迁移自己拼了 <home>/rooms 而 daemon 读 <stateDir>/rooms,
 *  新 daemon 起来账本为空 (内存 1 / 账本重放 17)。谁都不许再本地 join 一个 rooms 出来。 */
export const roomsDirOf = (stateDir: string): string => join(expandHome(stateDir), "rooms");

// ── room id ────────────────────────────────────────────────────────────

export type RoomKind = "wecom-group" | "wecom-dm" | "topic-post" | "wx" | "dm" | "adhoc";

/** 两个 wizard 的 dm room: uid 排序后 \`|\` 拼接, 同一对唯一。名字 / target 绝不进 id。 */
export const dmRoomId = (a: string, b: string): string => {
  if (!isUid(a) || !isUid(b)) throw new Error("dmRoomId: both sides must be uids (got " + a + ", " + b + ")");
  if (a === b) throw new Error("dmRoomId: a wizard has no dm with itself");
  return "dm:" + [a, b].sort().join("|");
};
export const adhocRoomId = (randomHex: string): string => {
  const h = randomHex.toLowerCase().replace(/[^0-9a-f]/g, "").slice(0, 8);
  if (h.length !== 8) throw new Error("adhocRoomId: need ≥8 hex chars");
  return "adhoc:" + h;
};
/** 绑定传输的 room = base principal 原样 (\`chat:…\` / \`user:…\`, 含 \`~bot\`); 无绑定的是 dm: / adhoc:。 */
export const isBoundRoom = (room: string): boolean => !!room && !room.startsWith("dm:") && !room.startsWith("adhoc:");
export const dmPeers = (room: string): [string, string] | undefined => {
  if (!room.startsWith("dm:")) return undefined;
  const [a, b] = room.slice(3).split("|");
  return isUid(a) && isUid(b) ? [a, b] : undefined;
};

/** room 的 8 位 hash —— 消息 id 的前缀, 使 id 全机唯一且能反查 room。 */
export const roomHash = (room: string): string => sha1("room|" + room).slice(0, 8);
export const msgIdOf = (room: string, seq: number): string => roomHash(room) + "." + seq;
export const parseMsgId = (id: string): { hash: string; seq: number } | undefined => {
  const m = /^([0-9a-f]{8})\.(\d+)$/.exec((id ?? "").trim());
  return m ? { hash: m[1]!, seq: Number(m[2]) } : undefined;
};

// ── 账本行 ─────────────────────────────────────────────────────────────

export type JoinVia = "founder" | "invite" | "approve" | "mention" | "spawn" | "transfer" | "inbound" | "migrate";
export type MsgKind = "say" | "ask" | "task" | "reply" | "file" | "join-req" | "system" | "trigger";
export type ReplyStatus = "done" | "need" | "progress" | "passed" | "canceled" | "error";
/** 关 duty 的终态。need / progress / error 不关。 */
export const CLOSING: ReadonlySet<ReplyStatus> = new Set<ReplyStatus>(["done", "passed", "canceled"]);
/** 发言权判定结果 (放行依据)。被拒的发言不成行。 */
export type SpeakBasis = "member" | "human" | "daemon" | "join-req";
export type MsgOrigin = "inbound" | "tool" | "daemon" | "migrate";
export interface FileRef { path: string; kind: "image" | "file" | "voice" | "video"; name: string }

interface OpBase { at: number; room: string }
export interface OpenOp extends OpBase { op: "open"; kind: RoomKind; title?: string; by: Who }
/** 给 room 起显示名 (host 专用)。名字只是别名, 不参与寻址: 账本文件、消息 id、room 参数
 *  一律用 id 原样; 同名的两个 room 互不干扰。 */
export interface NameOp extends OpBase { op: "name"; title: string; by: Who }
export interface JoinOp extends OpBase { op: "join"; who: Who; ord: number; via: JoinVia; by: Who }
export interface LeaveOp extends OpBase { op: "leave"; who: Who; by: Who; why?: string }
export interface SeenOp extends OpBase { op: "seen"; who: Who; seq: number }
export interface MoveOp extends OpBase { op: "move"; duty: string; from: Who; to: Who; by: Who }
export interface WatchOp extends OpBase { op: "watch"; who: Who; on: boolean }
export interface MsgRow extends OpBase {
  op: "msg";
  id: string;
  seq: number;
  author: Who;
  /** 作者此刻的加入序; 人 / daemon = 0。 */
  ord: number;
  speak: SpeakBasis;
  kind: MsgKind;
  text: string;
  to?: Who[];
  re?: string[];
  status?: ReplyStatus;
  /** 本行实际关掉的 duty key (\`<msgId>@<slot>\`) —— 完成的唯一事实, append 时算定。 */
  closes?: string[];
  /** 本行实际唤醒的 wizard uid (预算降级的不在内)。 */
  wake: string[];
  /** 带 interrupt 投递 (先 Esc 打断再投)。 */
  interrupt?: boolean;
  for?: string;
  after?: string[];
  planId?: string;
  files?: FileRef[];
  origin: MsgOrigin;
  ext?: string;
  bubble?: { stream: string; expires: number };
  /** daemon 系统行的机器语义 (undelivered / left / quota …), 用于去重, 不给模型推断。 */
  sys?: string;
}
export type RoomOp = OpenOp | NameOp | JoinOp | LeaveOp | SeenOp | MoveOp | WatchOp | MsgRow;

// ── fold ───────────────────────────────────────────────────────────────

export interface Member { who: Who; ord: number; via: JoinVia; since: number; by: Who; seen: number; watch: boolean }

/** duty 的处理人槽位: "host" = 读时求值的当前 host (未点名人话 / join-req); 其余 = whoKey。 */
export type Slot = string;
export const HOST_SLOT = "host";
export const dutyKey = (msg: string, slot: Slot): string => msg + "@" + slot;
export const splitDutyKey = (key: string): { msg: string; slot: Slot } => {
  const i = key.indexOf("@");
  return i < 0 ? { msg: key, slot: "" } : { msg: key.slice(0, i), slot: key.slice(i + 1) };
};

export interface Duty {
  key: string;
  msg: string;
  seq: number;
  slot: Slot;
  asker: Who;
  kind: "ask" | "task" | "human" | "join-req";
  at: number;
  after?: string[];
  planId?: string;
  for?: string;
  /** 最近一条 holder 写的非终态 status (need / progress / error)。 */
  last?: { status: ReplyStatus; seq: number };
  closed?: { by: string; status: ReplyStatus; at: number };
}

export interface RoomState {
  id: string;
  kind?: RoomKind;
  /** 显示别名 (host 起), 不是索引: 寻址永远用 id。 */
  title?: string;
  openedAt?: number;
  seq: number;
  nextOrd: number;
  /** 当前成员, key = whoKey。离开即删 (再进拿新 ord)。 */
  members: Map<string, Member>;
  msgs: MsgRow[];
  byId: Map<string, MsgRow>;
  duties: Map<string, Duty>;
  /** 历史上出现过的全部成员 (含已离开), 给 rolepage 的二部图与 W-1 视图用。 */
  everMembers: Map<string, Who>;
}

export const emptyRoom = (id: string): RoomState => ({
  id, seq: 0, nextOrd: 1, members: new Map(), msgs: [], byId: new Map(), duties: new Map(), everMembers: new Map(),
});

const slotOfWho = (w: Who): Slot => whoKey(w);

/** 一条 msg 行开出的 duty (fold 与 judge 共用)。 */
export const dutiesOpenedBy = (row: MsgRow): Array<Omit<Duty, "key">> => {
  const base = { msg: row.id, seq: row.seq, asker: row.author, at: row.at,
    ...(row.after?.length ? { after: row.after } : {}), ...(row.planId ? { planId: row.planId } : {}), ...(row.for ? { for: row.for } : {}) };
  if (row.kind === "ask" || row.kind === "task")
    return (row.to ?? []).filter((t) => t.kind === "wizard").map((t) => ({ ...base, slot: slotOfWho(t), kind: row.kind as "ask" | "task" }));
  if (row.kind === "join-req") return [{ ...base, slot: HOST_SLOT, kind: "join-req" }];
  // 绑定 room 里的人话: 点名开给被点名者, 没点名开给 host。
  if (row.author.kind === "human" && row.kind === "say" && isBoundRoom(row.room) && row.origin !== "migrate") {
    const named = (row.to ?? []).filter((t) => t.kind === "wizard");
    return named.length ? named.map((t) => ({ ...base, slot: slotOfWho(t), kind: "human" as const })) : [{ ...base, slot: HOST_SLOT, kind: "human" }];
  }
  return [];
};

/** 单步 fold —— 就地推进 (调用方持有状态; 纯度在「同一串行 = 同一状态」上)。 */
export const applyOp = (s: RoomState, op: RoomOp): RoomState => {
  switch (op.op) {
    case "open":
      s.kind = op.kind; if (op.title) s.title = op.title; s.openedAt ??= op.at; break;
    case "name": if (op.title) s.title = op.title; break;
    case "join": {
      const k = whoKey(op.who);
      const prev = s.members.get(k);
      s.members.set(k, prev ? { ...prev, via: op.via, by: op.by } : { who: op.who, ord: op.ord, via: op.via, since: op.at, by: op.by, seen: 0, watch: false });
      s.everMembers.set(k, op.who);
      s.nextOrd = Math.max(s.nextOrd, op.ord + 1);
      break;
    }
    case "leave": s.members.delete(whoKey(op.who)); break;
    case "seen": {
      const m = s.members.get(whoKey(op.who));
      if (m && op.seq > m.seen) m.seen = op.seq;
      break;
    }
    case "watch": {
      const m = s.members.get(whoKey(op.who));
      if (m) m.watch = op.on;
      break;
    }
    case "move": {
      const from = s.duties.get(dutyKey(op.duty, slotOfWho(op.from))) ?? s.duties.get(dutyKey(op.duty, HOST_SLOT));
      if (!from || from.closed) break;
      s.duties.delete(from.key);
      const key = dutyKey(op.duty, slotOfWho(op.to));
      s.duties.set(key, { ...from, key, slot: slotOfWho(op.to) });
      break;
    }
    case "msg": {
      s.seq = Math.max(s.seq, op.seq);
      s.msgs.push(op);
      s.byId.set(op.id, op);
      s.everMembers.set(whoKey(op.author), op.author);
      for (const d of dutiesOpenedBy(op)) {
        const key = dutyKey(d.msg, d.slot);
        if (!s.duties.has(key)) s.duties.set(key, { ...d, key });
      }
      for (const key of op.closes ?? []) {
        const d = s.duties.get(key);
        if (d && !d.closed) d.closed = { by: op.id, status: op.status ?? "done", at: op.at };
      }
      // 非终态 status 记在 holder 名下的那条 duty 上 (need 反向唤醒提问者的依据)。
      if (op.kind === "reply" && op.status && !CLOSING.has(op.status))
        for (const re of op.re ?? []) for (const d of s.duties.values())
          if (d.msg === re && !d.closed && holderMatches(s, d, op.author)) d.last = { status: op.status, seq: op.seq };
      break;
    }
  }
  return s;
};

export const foldRoom = (id: string, ops: readonly RoomOp[]): RoomState => ops.reduce(applyOp, emptyRoom(id));

// ── host ───────────────────────────────────────────────────────────────

/** host = 当前 wizard 成员里加入序最小的那个; 人不参与; 每次读时算, 不落盘。
 *  undefined = 没有 wizard 成员 (人兜底 / 绑定 room 下一句人话触发 onboarding)。 */
export const hostOf = (members: Iterable<{ who: Who; ord: number }>): Who | undefined => {
  let best: { who: Who; ord: number } | undefined;
  for (const m of members) if (m.who.kind === "wizard" && (!best || m.ord < best.ord)) best = m;
  return best?.who;
};
export const roomHost = (s: RoomState): Who | undefined => hostOf(s.members.values());

/** 起名 / 改名只有当前 host 能做 (人也不行 —— 人的意见走人话)。 */
export const canRename = (s: RoomState, who: Who): boolean => sameWho(roomHost(s), who);

/** duty 此刻的处理人 (host 槽位读时求值)。 */
export const holderOf = (s: RoomState, d: Duty): Who | undefined => {
  if (d.slot === HOST_SLOT) return roomHost(s);
  const i = d.slot.indexOf(":");
  return { kind: d.slot.slice(0, i) as WhoKind, id: d.slot.slice(i + 1) };
};
const holderMatches = (s: RoomState, d: Duty, who: Who): boolean => sameWho(holderOf(s, d), who);

export const openDuties = (s: RoomState): Duty[] => [...s.duties.values()].filter((d) => !d.closed);
/** who 在这个 room 手上未关的 duty。 */
export const dutiesHeldBy = (s: RoomState, who: Who): Duty[] => openDuties(s).filter((d) => holderMatches(s, d, who));
/** who 提出、仍未关的 duty。 */
export const dutiesAskedBy = (s: RoomState, who: Who): Duty[] => openDuties(s).filter((d) => sameWho(d.asker, who));

/** after 前置是否全部以 done 关闭 (跨 room 的前置由调用方给查询函数)。 */
export const afterSatisfied = (after: readonly string[] | undefined, closedDone: (msg: string) => boolean): boolean =>
  !after?.length || after.every(closedDone);
export const msgClosedDone = (s: RoomState, msg: string): boolean => {
  const ds = [...s.duties.values()].filter((d) => d.msg === msg);
  return ds.length > 0 && ds.every((d) => d.closed?.status === "done");
};

// ── 镜像规则 (§3a) ─────────────────────────────────────────────────────

/** 一行进企微 ⇔ room 绑定了传输 ∧ 是 msg ∧ origin ∉ {inbound, migrate} ∧ kind ≠ trigger。没有别的例外。 */
export const mirrors = (row: RoomOp): boolean =>
  row.op === "msg" && isBoundRoom(row.room) && row.origin !== "inbound" && row.origin !== "migrate" && row.kind !== "trigger";

/** 人话行的占位气泡由**第一条** re 它且带正文的 reply 覆盖; 之后的作为新消息。 */
export const coversBubble = (s: RoomState, row: MsgRow): string | undefined => {
  if (row.kind !== "reply" || !row.text.trim()) return undefined;
  for (const re of row.re ?? []) {
    const target = s.byId.get(re);
    if (!target?.bubble) continue;
    const earlier = s.msgs.some((m) => m !== row && m.kind === "reply" && m.text.trim() && m.seq < row.seq && (m.re ?? []).includes(re));
    if (!earlier) return re;
  }
  return undefined;
};

// ── append 前的判定 ────────────────────────────────────────────────────

export interface Draft {
  author: Who;
  kind: MsgKind;
  text: string;
  origin: MsgOrigin;
  to?: Who[];
  re?: string[];
  /** reply 显式给的 status; 缺省见 resolveStatus。 */
  status?: ReplyStatus;
  /** 是否显式给了 status (区分「没给」与默认)。 */
  statusGiven?: boolean;
  interrupt?: boolean;
  for?: string;
  after?: string[];
  planId?: string;
  files?: FileRef[];
  ext?: string;
  bubble?: { stream: string; expires: number };
  sys?: string;
}

export interface JudgeCtx {
  now: number;
  /** 某 wizard 是不是 target 的直属 parent (interrupt 限权)。 */
  isParent?: (parent: Who, child: Who) => boolean;
  /** 跨 room 的 after 前置判定; 缺省只看本 room。 */
  closedDone?: (msg: string) => boolean;
  /** 回合预算 M (10 分钟窗内每 room 唤醒数上限)。 */
  budget?: number;
}

export type Verdict =
  | { ok: true; row: MsgRow; duplicate?: false; degraded: string[] }
  | { ok: true; row: MsgRow; duplicate: true; degraded: string[] }
  | { ok: false; status: 400 | 403 | 409; reason: string };

export const WAKE_BUDGET = 20;
export const WAKE_WINDOW_MS = 10 * 60_000;
export const DEDUP_WINDOW_MS = 10 * 60_000;

const fail = (status: 400 | 403 | 409, reason: string): Verdict => ({ ok: false, status, reason });

/** 去重键: (author, kind, text, to, re, status) —— 10 分钟内同键视为同一次发言, 返回已有行。 */
const dedupKey = (author: Who, kind: MsgKind, text: string, to: readonly Who[] | undefined, re: readonly string[] | undefined, status?: ReplyStatus): string =>
  [whoKey(author), kind, sha1(text).slice(0, 12), (to ?? []).map(whoKey).sort().join(","), (re ?? []).join(","), status ?? ""].join("|");

/** 请求体里的 id 列表: 缺省 = []。别写成 [x].map(String) —— undefined 会变成假 id "undefined"
 *  (2026-11-20: chat_ask 没给 after 时 after=["undefined"], 前置永不算满足, 被点名的人永不唤醒)。 */
export const idList = (x: unknown): string[] =>
  x == null ? [] : (Array.isArray(x) ? x : [x]).map((v) => String(v).trim()).filter(Boolean);

/** 10 分钟窗内这个 room 已经花掉的唤醒数 (从账本算, 重启不丢)。 */
export const wakesInWindow = (s: RoomState, now: number, windowMs = WAKE_WINDOW_MS): number =>
  s.msgs.reduce((n, m) => (now - m.at < windowMs ? n + m.wake.length + (m.interrupt ? 1 : 0) : n), 0);

/** reply 的 status: 显式给的原样; 没给且调用方是 re 里某条 duty 的 holder → text ? done : passed;
 *  没给且不是 holder → undefined (普通线程回复)。 */
const resolveStatus = (d: Draft, holdsAny: boolean): ReplyStatus | undefined =>
  d.statusGiven && d.status ? d.status : holdsAny ? (d.text.trim() ? "done" : "passed") : undefined;

/** 判定一条发言能不能落成行; 能 → 算好 seq / id / ord / speak / closes / wake。纯函数。 */
export const judge = (s: RoomState, d: Draft, ctx: JudgeCtx): Verdict => {
  const member = s.members.get(whoKey(d.author));
  const isHuman = d.author.kind === "human";
  const isDaemon = d.author.kind === "daemon";
  // ① 发言权 (落盘时判, 被拒不成行)
  let speak: SpeakBasis;
  if (isDaemon) speak = "daemon";
  else if (isHuman) speak = "human";
  else if (member) speak = "member";
  else if (d.kind === "join-req") speak = "join-req";
  else return fail(403, "非成员: 先 room_join 申请入群 (或请 host / 人邀请你)");
  if (!isDaemon && (d.kind === "system" || d.kind === "trigger")) return fail(403, d.kind + " 行只有 daemon 能写");
  if (d.kind === "join-req" && member) return fail(409, "你已经是成员");
  if (!d.text.trim() && d.kind !== "reply" && !d.files?.length) return fail(400, "text required");

  // ② re 必须都在本 room
  const re = [...new Set(d.re ?? [])];
  const missing = re.filter((id) => !s.byId.has(id));
  if (missing.length) return fail(400, "re 不在这个 room: " + missing.join(", "));
  if (d.kind === "reply" && !re.length) return fail(400, "reply 必须带 re");

  // ③ status 写入权: 只有 holder (人超集; error 只有 daemon)
  let closes: string[] = [];
  let status: ReplyStatus | undefined;
  if (d.kind === "reply") {
    if (d.statusGiven && d.status === "error" && !isDaemon) return fail(403, "error 只有 daemon 能写");
    const mine = (id: string): Duty[] => openDuties(s).filter((x) => x.msg === id && (isHuman || isDaemon ? true : holderMatches(s, x, d.author)));
    const holds = re.map((id) => ({ id, duties: mine(id) }));
    const holdsAny = holds.some((h) => h.duties.length);
    status = resolveStatus(d, holdsAny);
    if (status && !isHuman && !isDaemon) {
      const notMine = holds.filter((h) => !h.duties.length).map((h) => h.id);
      if (notMine.length) return fail(403, "status 只有 duty 的处理人能写; 这几条不归你 (或已关): " + notMine.join(", "));
    }
    if (status && CLOSING.has(status)) {
      // ④ 覆盖检查: 提问者在线程里有 holder 还没读到的补充 → 先读
      const holderSeen = member?.seen ?? Number.MAX_SAFE_INTEGER;
      for (const h of holds) for (const duty of h.duties) {
        const newer = s.msgs.filter((m) => sameWho(m.author, duty.asker) && m.seq > holderSeen && (m.re ?? []).includes(duty.msg));
        if (newer.length && !isHuman && !isDaemon) return fail(409, "先读 seq " + newer[newer.length - 1]!.seq + ": 提问者对 " + duty.msg + " 有你还没读到的补充");
        closes.push(duty.key);
      }
    }
  } else if (d.statusGiven) return fail(400, "status 只用于 reply");

  // ⑤ to 只认成员 (人话的 .name 点名由调用方先拉进来)
  const to = (d.to ?? []).filter((t, i, a) => a.findIndex((x) => sameWho(x, t)) === i);
  if (!isDaemon) {
    const outsiders = to.filter((t) => !s.members.has(whoKey(t)));
    if (outsiders.length) return fail(409, "这些不是本 room 成员: " + outsiders.map((t) => t.id).join(", ") + " — 先邀请, 或改去 dm room");
  }
  if ((d.kind === "ask" || d.kind === "task") && !to.some((t) => t.kind === "wizard")) return fail(400, d.kind + " 至少点名一个 wizard 成员");

  // ⑥ interrupt 限权: 直属 parent / host / 人
  if (d.interrupt) {
    if (d.kind !== "ask" && d.kind !== "task" && d.kind !== "say") return fail(400, "interrupt 只用于 chat_ask / chat_say");
    const targets = to.filter((t) => t.kind === "wizard");
    if (!targets.length) return fail(400, "interrupt 要点名被打断的 wizard");
    const host = roomHost(s);
    const allowed = (t: Who): boolean => isHuman || sameWho(host, d.author) || !!ctx.isParent?.(d.author, t);
    const denied = targets.filter((t) => !allowed(t));
    if (denied.length) return fail(403, "interrupt 只有直属 parent / 本 room 的 host / 人能用: " + denied.map((t) => t.id).join(", "));
  }

  // ⑦ 去重 (幂等: 返回已有行)
  const key = dedupKey(d.author, d.kind, d.text, to, re, status);
  const dup = [...s.msgs].reverse().find((m) => ctx.now - m.at < DEDUP_WINDOW_MS && dedupKey(m.author, m.kind, m.text, m.to, m.re, m.status) === key);
  if (dup && d.origin !== "inbound") return { ok: true, row: dup, duplicate: true, degraded: [] };

  // ⑧ 唤醒 + 回合预算
  const seq = s.seq + 1;
  const draftRow: MsgRow = {
    op: "msg", at: ctx.now, room: s.id, id: msgIdOf(s.id, seq), seq, author: d.author, ord: member?.ord ?? 0, speak,
    kind: d.kind, text: d.text, ...(to.length ? { to } : {}), ...(re.length ? { re } : {}), ...(status ? { status } : {}),
    ...(closes.length ? { closes } : {}), wake: [], ...(d.interrupt ? { interrupt: true } : {}),
    ...(d.for ? { for: d.for } : {}), ...(d.after?.length ? { after: d.after } : {}), ...(d.planId ? { planId: d.planId } : {}),
    ...(d.files?.length ? { files: d.files } : {}), origin: d.origin, ...(d.ext ? { ext: d.ext } : {}),
    ...(d.bubble ? { bubble: d.bubble } : {}), ...(d.sys ? { sys: d.sys } : {}),
  };
  const want = wakeTargets(s, draftRow, ctx);
  const budget = ctx.budget ?? WAKE_BUDGET;
  const used = wakesInWindow(s, ctx.now);
  if (d.interrupt && used + want.length + 1 > budget) return fail(409, "本 room 10 分钟内的唤醒预算 (" + budget + ") 已用完, interrupt 不放行");
  const room = Math.max(0, budget - used);
  const wake = want.slice(0, room);
  const degraded = want.slice(room);
  return { ok: true, row: { ...draftRow, wake }, degraded };
};

/** 这一行该唤醒谁 (wizard uid, 不含作者自己)。B-3: 点名 + host 兜底 + 订阅, 其余只推游标。 */
export const wakeTargets = (s: RoomState, row: MsgRow, ctx: Pick<JudgeCtx, "closedDone"> = {}): string[] => {
  const out: string[] = [];
  const add = (w: Who | undefined): void => {
    if (w?.kind === "wizard" && !sameWho(w, row.author) && !out.includes(w.id)) out.push(w.id);
  };
  const named = (row.to ?? []).filter((t) => t.kind === "wizard");
  const closedDone = ctx.closedDone ?? ((m: string) => msgClosedDone(s, m));
  switch (row.kind) {
    case "ask": case "task":
      if (afterSatisfied(row.after, closedDone)) named.forEach(add);
      break;
    case "join-req": add(roomHost(s)); break;
    case "reply": {
      if (row.status === "progress") break;
      for (const id of row.re ?? []) add(s.byId.get(id)?.author);
      break;
    }
    case "trigger": named.forEach(add); break;
    default:
      named.forEach(add);
      // 绑定 room 里没点名的人话 → host
      if (row.author.kind === "human" && !named.length && isBoundRoom(row.room)) add(roomHost(s));
  }
  // 订阅 (B-3): 只在人话 / 带终态的 reply 时唤醒订阅者
  const watchable = (row.author.kind === "human" && row.kind === "say") || (row.kind === "reply" && !!row.status && CLOSING.has(row.status));
  if (watchable) for (const m of s.members.values()) if (m.watch) add(m.who);
  return out;
};

// ── 离开 (§4): 手上的 duty 由 daemon 写 canceled, 唤醒提问者 ──────────

/** 成员离开要落的行: 每条它名下 (静态槽位) 未关的 duty 一行 canceled reply, 然后 leave。
 *  host 槽位的 duty 不取消 —— 它们随 host 求值自然落到下一位。 */
export const leaveOps = (s: RoomState, who: Who, by: Who, now: number, why = ""): RoomOp[] => {
  const mine = openDuties(s).filter((d) => d.slot !== HOST_SLOT && d.slot === whoKey(who));
  const byMsg = new Map<string, Duty[]>();
  for (const d of mine) byMsg.set(d.msg, [...(byMsg.get(d.msg) ?? []), d]);
  let seq = s.seq;
  const rows: RoomOp[] = [...byMsg.entries()].map(([msg, ds]) => {
    seq += 1;
    const asker = ds[0]!.asker;
    return {
      op: "msg", at: now, room: s.id, id: msgIdOf(s.id, seq), seq, author: DAEMON, ord: 0, speak: "daemon",
      kind: "reply", text: "[wezard] " + who.id + " 已离开" + (why ? " (" + why + ")" : "") + ", 这条没有答案了", re: [msg],
      status: "canceled", closes: ds.map((d) => d.key), wake: asker.kind === "wizard" && !sameWho(asker, who) ? [asker.id] : [],
      origin: "daemon", sys: "left",
    } satisfies MsgRow;
  });
  return [...rows, { op: "leave", at: now, room: s.id, who, by, ...(why ? { why } : {}) }];
};

// ── 渲染 (注入头只给模型看, 任何读侧都不把它解析回来当事实) ─────────

export interface RenderNames { nameOf: (w: Who) => string; roomLabel: (room: string) => string }

const statusTag = (m: MsgRow): string => (m.status ? " [" + m.status + "]" : "");
export const renderMsgLine = (m: MsgRow, n: RenderNames, max = 500): string => {
  const to = m.to?.length ? " → " + m.to.map(n.nameOf).join(", ") : "";
  const re = m.re?.length ? " (re " + m.re.join(",") + ")" : "";
  const body = m.text.replace(/\s+/g, " ").trim();
  const files = m.files?.length ? " 📎" + m.files.map((f) => f.name).join(",") : "";
  return "[" + m.id + "] " + n.nameOf(m.author) + to + re + statusTag(m) + ": " + (body.length > max ? body.slice(0, max) + "…(+" + (body.length - max) + ")" : body) + files;
};

export const UNREAD_BUDGET = 6000;
/** 游标之后、who 没看过的行 (不含自己说的), 触发行全文, 其余从新到旧装到预算为止。 */
export const unreadFor = (s: RoomState, who: Who, triggers: readonly string[] = [], budget = UNREAD_BUDGET): { rows: MsgRow[]; more: number; to: number } => {
  const seen = s.members.get(whoKey(who))?.seen ?? 0;
  const eligible = s.msgs.filter((m) => m.seq > seen && !sameWho(m.author, who));
  const picked: MsgRow[] = [];
  let used = 0;
  for (let i = eligible.length - 1; i >= 0; i--) {
    const m = eligible[i]!;
    const cost = triggers.includes(m.id) ? 0 : Math.min(m.text.length, 500);
    if (picked.length && used + cost > budget && !triggers.includes(m.id)) continue;
    picked.unshift(m);
    used += cost;
  }
  return { rows: picked, more: eligible.length - picked.length, to: s.seq };
};