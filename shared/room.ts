// room 模型的纯核心 (契约: docs/room/contract.md, 已拍板)。
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
import { stripLegacyTail } from "./reminder.js";

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

export type RoomKind = "wecom-group" | "wecom-dm" | "topic-post" | "channel" | "wx" | "dm" | "adhoc";

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
/** 成员角色: "monitor" = 本 room 的监视者 —— 不发言、不当 host、不持有 duty, 只写 activate 行。 */
export type MemberRole = "monitor";
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
/** 群公告: 每个 room 一条, 让 room 里所有 wizard 一直知道一句话 (本周重点 / 某条规矩)。
 *  与 NameOp 同构, 但空串 = 清除 (name 的空串是忽略)。最后一条生效; 不另存文件, 状态是 fold 出来的。 */
export interface NoticeOp extends OpBase { op: "notice"; text: string; by: Who }
/** 公告正文上限 (字)。 */
export const NOTICE_MAX = 500;
export interface JoinOp extends OpBase { op: "join"; who: Who; ord: number; via: JoinVia; by: Who; role?: MemberRole }
export interface LeaveOp extends OpBase { op: "leave"; who: Who; by: Who; why?: string }
/** batch: true = 一次成功的唤醒投递写下的游标 (入座时的 history 游标不带) —— 「最近 N 次唤醒」的计数来源。 */
export interface SeenOp extends OpBase { op: "seen"; who: Who; seq: number; batch?: true }
export interface MoveOp extends OpBase { op: "move"; duty: string; from: Who; to: Who; by: Who }
export interface WatchOp extends OpBase { op: "watch"; who: Who; on: boolean }
/** monitor 的判决 (2026-11-23 人定: 判决不进消息记录): 不写 msg 行, 直接给 re 那条人话在 `to` 名下开 duty。
 *  被激活者只看到人的原话 + 「你要交代」; 留痕只在 daemon.log。`to` 缺省 (判不回应) 不落 op。 */
export interface AssignOp extends OpBase { op: "assign"; duty: string; to: Who; asker: Who; by: Who }
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
  /** 入站显式给出: "bot" = 人 @ 了机器人 (等同点名 host, 由入站按事件写, 不从正文猜)。 */
  mention?: "bot";
  /** 频道 room 里这一行属于哪个帖子 (post_id; 帖子 room 还没诞生时用它表达归属)。 */
  post?: string;
  /** 这一行从哪个副源进来 (副源 base principal); 缺省 = 主源 = room id (不落字段)。
   *  入站落行时写死, 重放不再推断; 出站 re 到它时按它回出去 (P1 只加字段, 读写路径在 P2/P3)。 */
  src?: string;
  /** 人话交给了本 room 的 monitor (只唤醒 monitor, 不在 host 槽位开 duty)。judge 落定, 重放照旧。 */
  monitor?: true;
  /** 带 interrupt 投递 (先 Esc 打断再投)。 */
  interrupt?: boolean;
  for?: string;
  after?: string[];
  planId?: string;
  files?: FileRef[];
  origin: MsgOrigin;
  ext?: string;
  bubble?: { stream: string; expires: number };
  /** daemon 系统行的机器语义 (undelivered / left …), 用于去重, 不给模型推断。 */
  sys?: string;
}
/** 把一个副源 (信息源 base principal: 群 / 频道帖子) 绑进本 room: 该源的入站落本 room,
 *  re 到本 room 的回复按源回出去。事实只在账本里 (fold 出 bindings); room 字段必须就是承载
 *  它的那个账本 —— boot 索引对账拿行上自称的 room 与本账本目录比对 (§3.2 对账闸)。 */
export interface BindOp extends OpBase { op: "bind"; source: string; by: Who; why?: string }
/** 解绑: 该源回落恒等 (自己那条 1:1 room), 不立即补开任何东西 (lazy)。 */
export interface UnbindOp extends OpBase { op: "unbind"; source: string; by: Who; why?: string }
export type RoomOp = OpenOp | NameOp | NoticeOp | JoinOp | LeaveOp | SeenOp | MoveOp | WatchOp | AssignOp | BindOp | UnbindOp | MsgRow;

// ── fold ───────────────────────────────────────────────────────────────

export interface Member { who: Who; ord: number; via: JoinVia; since: number; by: Who; seen: number; watch: boolean;
  /** 加入时声明的角色 (monitor 跳过 host, 也不继承上一任的 role 变化)。 */
  role?: MemberRole;
  /** 它最近几次成功唤醒批次的时刻 (SeenOp.batch 的 at, 去重、最多 BATCH_KEEP 个, 旧→新); 不是 batch 的 seen 不记。 */
  batches: number[] }

/** duty 的处理人槽位: "host" = 读时求值的当前 host (未点名人话 / join-req); 其余 = whoKey。 */
export type Slot = string;
export const HOST_SLOT = "host";
export const dutyKey = (msg: string, slot: Slot): string => msg + "@" + slot;

export interface Duty {
  key: string;
  msg: string;
  seq: number;
  slot: Slot;
  asker: Who;
  /** need = wizard 向人反问 (chat_reply status need) 在人名下开的账: asker = 那个 wizard, msg = 那条 reply 的 id。 */
  kind: "ask" | "task" | "human" | "join-req" | "need";
  at: number;
  after?: string[];
  planId?: string;
  for?: string;
  /** 老账本里最近一条 move 行的时刻 (room_transfer 已删, 只读侧折叠) —— 逾期计时把它当一次活动。 */
  movedAt?: number;
  /** "assign" = monitor 判决直接开的账 (没有 trigger 消息行); 泵靠它 + 人话行本身在未读里唤醒。 */
  via?: "assign";
  /** 最近一条 holder 写的非终态 status (need / progress / error)。 */
  last?: { status: ReplyStatus; seq: number };
  closed?: { by: string; status: ReplyStatus; at: number };
}

export interface RoomState {
  id: string;
  kind?: RoomKind;
  /** 显示别名 (host 起), 不是索引: 寻址永远用 id。 */
  title?: string;
  /** 群公告 (最近一条 notice 行); undefined = 没有 / 已清除。 */
  notice?: string;
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
  /** 成员进出的时间线 (fold 出来, 不落第二份): 新成员入座 / 在座成员离开各一条, rolepage 画成系统通知。
   *  已在座者的再次 join (只改 via / by) 不算进出。 */
  memberLog: MemberEvent[];
  /** 绑进本 room 的副源, key = 源 base principal。room 的归属由承载它的账本决定, 条目里不存 room。 */
  bindings: Map<string, Binding>;
}

/** 一条绑定的审计信息 (谁在何时为什么; unbind 即删条目)。 */
export interface Binding { at: number; by: Who; why?: string }

export interface MemberEvent {
  at: number;
  op: "join" | "leave";
  who: Who;
  by: Who;
  /** join 才有。 */
  via?: JoinVia;
  /** leave 才有 (stop_wizard end / 离开原因)。 */
  why?: string;
}

export const emptyRoom = (id: string): RoomState => ({
  id, seq: 0, nextOrd: 1, members: new Map(), msgs: [], byId: new Map(), duties: new Map(), everMembers: new Map(), memberLog: [], bindings: new Map(),
});

const slotOfWho = (w: Who): Slot => whoKey(w);

/** 一条 msg 行开出的 duty (fold 与 judge 共用)。reAuthorOf = 按 msgId 查作者 (applyOp 传 byId 查询),
 *  只给 activate 判决行定 asker 用: 那条 duty 的源头是 re 的原话人, 不是发判决的 monitor (查不到回落 row.author)。 */
export const dutiesOpenedBy = (row: MsgRow, reAuthorOf?: (id: string) => Who | undefined): Array<Omit<Duty, "key">> => {
  const base = { msg: row.id, seq: row.seq, asker: row.author, at: row.at,
    ...(row.after?.length ? { after: row.after } : {}), ...(row.planId ? { planId: row.planId } : {}), ...(row.for ? { for: row.for } : {}) };
  if (row.kind === "ask" || row.kind === "task")
    // 点名的 wizard 与人 (人名下开的 ask / task 靠人的下一句话关账, 见 judge 的 humanCloses)。
    return (row.to ?? []).filter((t) => t.kind === "wizard" || t.kind === "human").map((t) => ({ ...base, slot: slotOfWho(t), kind: row.kind as "ask" | "task" }));
  // wizard 的 need 回复: judge 把 re 里 duty 的人提问者补进 to —— 球传到人那边, 人名下开一条 need。
  if (row.kind === "reply" && row.status === "need" && row.author.kind === "wizard")
    return (row.to ?? []).filter((t) => t.kind === "human").map((t) => ({ ...base, slot: slotOfWho(t), kind: "need" as const }));
  if (row.kind === "join-req") return [{ ...base, slot: HOST_SLOT, kind: "join-req" }];
  // monitor 的 activate: 为 re 里那条人话在 to 名下开 duty (人话自己不再开 host 槽位)。to 为空 = 判定不回应。
  if (row.kind === "trigger" && row.sys === "activate") {
    const target = row.to?.[0];
    if (!(target && target.kind === "wizard")) return [];
    const asker = (row.re?.[0] ? reAuthorOf?.(row.re[0]) : undefined) ?? row.author;
    return [{ ...base, asker, msg: row.re?.[0] ?? row.id, slot: slotOfWho(target), kind: "human" as const }];
  }
  // 绑定 room 里的人话: 点名开给被点名者; 交给 monitor 的不开 duty; 其余开给 host。
  if (row.author.kind === "human" && row.kind === "say" && isBoundRoom(row.room) && row.origin !== "migrate") {
    if (row.monitor) return [];
    const named = (row.to ?? []).filter((t) => t.kind === "wizard");
    return named.length ? named.map((t) => ({ ...base, slot: slotOfWho(t), kind: "human" as const })) : [{ ...base, slot: HOST_SLOT, kind: "human" }];
  }
  return [];
};

/** 单步 fold —— 就地推进 (调用方持有状态; 纯度在「同一串行 = 同一状态」上)。 */
export const BATCH_KEEP = 64;
export const applyOp = (s: RoomState, op: RoomOp): RoomState => {
  switch (op.op) {
    case "open":
      s.kind = op.kind; if (op.title) s.title = op.title; s.openedAt ??= op.at; break;
    case "name": if (op.title) s.title = op.title; break;
    case "notice": if (op.text.trim()) s.notice = op.text; else delete s.notice; break;
    case "join": {
      const k = whoKey(op.who);
      const prev = s.members.get(k);
      if (!prev) s.memberLog.push({ at: op.at, op: "join", who: op.who, by: op.by, via: op.via });
      s.members.set(k, prev
        ? { ...prev, via: op.via, by: op.by, ...(op.role ? { role: op.role } : {}) }
        : { who: op.who, ord: op.ord, via: op.via, since: op.at, by: op.by, seen: 0, watch: false, batches: [], ...(op.role ? { role: op.role } : {}) });
      s.everMembers.set(k, op.who);
      s.nextOrd = Math.max(s.nextOrd, op.ord + 1);
      break;
    }
    case "leave":
      if (s.members.has(whoKey(op.who))) s.memberLog.push({ at: op.at, op: "leave", who: op.who, by: op.by, ...(op.why ? { why: op.why } : {}) });
      s.members.delete(whoKey(op.who));
      break;
    case "seen": {
      const m = s.members.get(whoKey(op.who));
      if (m && op.seq > m.seen) m.seen = op.seq;
      if (m && op.batch && m.batches[m.batches.length - 1] !== op.at) m.batches = [...m.batches, op.at].slice(-BATCH_KEEP);
      break;
    }
    case "watch": {
      const m = s.members.get(whoKey(op.who));
      if (m) m.watch = op.on;
      break;
    }
    // bind 设 / 覆盖条目, unbind 删条目 —— 判定在 append 时已算死, 重放只照抄。
    case "bind": s.bindings.set(op.source, { at: op.at, by: op.by, ...(op.why ? { why: op.why } : {}) }); break;
    case "unbind": s.bindings.delete(op.source); break;
    case "move": {
      const from = s.duties.get(dutyKey(op.duty, slotOfWho(op.from))) ?? s.duties.get(dutyKey(op.duty, HOST_SLOT));
      if (!from || from.closed) break;
      s.duties.delete(from.key);
      const key = dutyKey(op.duty, slotOfWho(op.to));
      s.duties.set(key, { ...from, key, slot: slotOfWho(op.to), movedAt: op.at });
      break;
    }
    case "assign": {
      // monitor 判决: 不占 seq、不写消息行, 只开 duty (重放一致)。
      const key = dutyKey(op.duty, slotOfWho(op.to));
      if (!s.duties.has(key)) {
        const row = s.byId.get(op.duty);
        s.duties.set(key, { key, msg: op.duty, seq: row?.seq ?? 0, slot: slotOfWho(op.to), asker: op.asker, kind: "human", at: op.at, via: "assign" });
      }
      break;
    }
    case "msg": {
      s.seq = Math.max(s.seq, op.seq);
      s.msgs.push(op);
      s.byId.set(op.id, op);
      s.everMembers.set(whoKey(op.author), op.author);
      for (const d of dutiesOpenedBy(op, (id) => s.byId.get(id)?.author)) {
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

/** host = 当前 wizard 成员里加入序最小的那个; 人不参与, monitor 也不当 host (它的活是激活, 不是回答)。
 *  每次读时算, 不落盘。undefined = 没有 wizard 成员 (人兜底 / 绑定 room 下一句人话触发 onboarding)。 */
export const hostOf = (members: Iterable<{ who: Who; ord: number; role?: MemberRole }>): Who | undefined => {
  let best: { who: Who; ord: number } | undefined;
  for (const m of members) if (m.who.kind === "wizard" && m.role !== "monitor" && (!best || m.ord < best.ord)) best = m;
  return best?.who;
};
export const roomHost = (s: RoomState): Who | undefined => hostOf(s.members.values());

/** 本 room 的 monitor 成员 (不发言、不当 host、不持有 duty)。 */
export const monitorsOf = (s: RoomState): Who[] =>
  [...s.members.values()].filter((m) => m.role === "monitor" && m.who.kind === "wizard").map((m) => m.who);
export const hasMonitor = (s: RoomState): boolean =>
  [...s.members.values()].some((m) => m.role === "monitor" && m.who.kind === "wizard");

/** 起名 / 改名只有当前 host 能做 (人也不行 —— 人的意见走人话)。 */
export const canRename = (s: RoomState, who: Who): boolean => sameWho(roomHost(s), who);
/** 改公告的权限同起名: 只有当前 host。人不受此限 (人的授权在 inbound 的 allowFrom 门)。 */
export const canNotice = (s: RoomState, who: Who): boolean => who.kind === "human" || canRename(s, who);

/** 一次改公告的裁决: 权限 + 归一化 (空白折成单空格) + 长度。空串 = 清除, 与现有相同 = changed:false。 */
export const judgeNotice = (s: RoomState, who: Who, raw: string):
  | { ok: true; notice: string; changed: boolean }
  | { ok: false; status: 403 | 400; reason: string } => {
  if (!canNotice(s, who)) return { ok: false, status: 403, reason: "只有本 room 的 host 能改公告" };
  const notice = raw.replace(/\s+/g, " ").trim();
  if (notice.length > NOTICE_MAX) return { ok: false, status: 400, reason: "公告太长 (最多 " + NOTICE_MAX + " 字, 现在 " + notice.length + ")" };
  return { ok: true, notice, changed: notice !== (s.notice ?? "") };
};

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
/** 人 who 的下一句话关哪些 duty (key): 它在本 room 名下全部未关的; `re` (企微引用) 命中其中几条就只关那几条 ——
 *  引用的不是它名下的账 (引了别的消息 / 引用没对上行) 不算「指定了哪一条」, 照全关, 免得一句答话挂着账不落。 */
export const humanCloses = (s: RoomState, who: Who, re: readonly string[]): string[] => {
  const mine = dutiesHeldBy(s, who);
  const quoted = mine.filter((x) => re.includes(x.msg));
  return (quoted.length ? quoted : mine).map((x) => x.key);
};

const uniqWho = (ws: readonly Who[]): Who[] => ws.filter((w, i) => ws.findIndex((x) => sameWho(x, w)) === i);

/** 企微的引用只带文字、不带消息 id: 把引用正文对回本 room 里的一行 (别人 / daemon 说的、正文互相包含、取最近一条)。
 *  只比字母数字 (镜像出去的气泡带名字头、markdown 会被企微改样), 太短 (< 4 字) 不认 —— 对不上就是没引用,
 *  人话关账按「没指定哪一条」处理 (全关)。 */
export const quotedRowIds = (s: RoomState, quoted: string, author?: Who): string[] => {
  const canon = (t: string): string => t.replace(/[^\p{L}\p{N}]/gu, "");
  const q = canon(quoted);
  if (q.length < 4) return [];
  const hit = [...s.msgs].reverse().find((m) => !sameWho(m.author, author) && m.kind !== "trigger" && ((c) => c.length >= 4 && (c.includes(q) || q.includes(c)))(canon(m.text)));
  return hit ? [hit.id] : [];
};

/** judge 替这一行补的收话人 (进行里的 `to`, 重放不再推断):
 *  wizard 的 need 回复 → re 里它所持 duty 的**人**提问者 (fold 据此在人名下开 need);
 *  人的话关了谁的账 → 那些账的 wizard 提问者 (仍在 room 里的): 这句就是答给它们的, 与点名同义 —— 唤醒它们、
 *  且不再当「没点名的人话」落给 host。 */
const judgeAddressees = (s: RoomState, d: Draft, re: readonly string[], status: ReplyStatus | undefined, closes: readonly string[]): Who[] => {
  if (d.kind === "reply" && status === "need" && d.author.kind === "wizard")
    return uniqWho(openDuties(s).filter((x) => re.includes(x.msg) && holderMatches(s, x, d.author)).map((x) => x.asker).filter((a) => a.kind === "human"));
  if (d.kind === "say" && d.author.kind === "human")
    return uniqWho(closes.flatMap((k) => { const a = s.duties.get(k)?.asker; return a?.kind === "wizard" && s.members.has(whoKey(a)) ? [a] : []; }));
  return [];
};

/** holder 在最近一次被这条 duty 唤醒之后, 是否已用 chat_reply 交代过 —— 任何 status 都算
 *  (progress / need 不关账, 但已经「交代过这一轮」, 不该再被提醒、更不该给提问者写系统行)。
 *  按唤醒算而不按「曾经回过」: need 之后提问者补了信息再唤醒它, 那一轮仍要重新交代。 */
export const dutyAnswered = (s: RoomState, d: Duty, who: Who): boolean => {
  const touches = (r: MsgRow): boolean => r.id === d.msg || (r.re ?? []).includes(d.msg);
  const wokeAt = s.msgs.reduce((at, r) => (touches(r) && r.wake.includes(who.id) ? Math.max(at, r.seq) : at), 0);
  return s.msgs.some((r) => r.kind === "reply" && r.seq > wokeAt && sameWho(r.author, who) && (r.re ?? []).includes(d.msg));
};

/** 2026-11-20 起 idList 修好之前, 没给 after 的 chat_ask 落成了 after:["undefined"] —— 这个假 id
 *  不指向任何消息, 视为「没有前置」(否则前置永不满足, 被点名者永不唤醒)。 */
export const FAKE_AFTER_ID = "undefined";
/** after 前置是否全部以 done 关闭 (跨 room 的前置由调用方给查询函数)。 */
export const afterSatisfied = (after: readonly string[] | undefined, closedDone: (msg: string) => boolean): boolean =>
  !after?.length || after.every((id) => id === FAKE_AFTER_ID || closedDone(id));
/** 这条 after 只由假 id 构成 (旧 bug 的受害行, 不是真在等谁)。 */
export const afterIsFake = (after: readonly string[] | undefined): boolean =>
  !!after?.length && after.every((id) => id === FAKE_AFTER_ID);

/** 带 after 的 duty 是否欠一次补唤醒 —— 欠则返回该叫的 holder。
 *  judge 在前置未满足时把 wake 落成 [] 存进行里, 之后前置关了没人重算; 而 holder 的 seen 游标可能早已
 *  越过那一行, pending() 现算也救不回来, 所以由 daemon 追加一条 trigger 行 (新 seq, 必在游标之后)。
 *  欠 ⇔ 前置此刻满足 ∧ duty 仍开 ∧ holder 是 wizard 成员 ∧ 账本里没有任何一行 (原 ask / re 它的行)
 *  唤醒过 holder ∧ 没有已写给 holder 的 trigger (幂等: 预算降级也不重写) ∧ holder 从没 re 过它
 *  (它已经从游标里读到并交代过, 不必再叫)。 */
export const afterWakeDue = (s: RoomState, d: Duty, closedDone: (msg: string) => boolean): Who | undefined => {
  if (d.closed || !d.after?.length || !afterSatisfied(d.after, closedDone)) return undefined;
  const holder = holderOf(s, d);
  if (holder?.kind !== "wizard" || !s.members.has(whoKey(holder))) return undefined;
  const touches = (r: MsgRow): boolean => r.id === d.msg || (r.re ?? []).includes(d.msg);
  const handled = s.msgs.some((r) => touches(r) && (
    r.wake.includes(holder.id)
    || (r.kind === "trigger" && (r.to ?? []).some((t) => sameWho(t, holder)))
    || (r.id !== d.msg && sameWho(r.author, holder))));
  return handled ? undefined : holder;
};

/** 补唤醒 trigger 行的正文: 原 ask 可能已在 holder 的游标之前 (渲染时不会再列), 所以带上原文。 */
export const afterTriggerText = (ask: MsgRow, askerName: string): string =>
  (afterIsFake(ask.after)
    ? "[wezard] 补投: " + ask.id + " 当时因 after 写坏 (假 id \"undefined\") 没有唤醒你, 它其实没有前置, 现在补上。"
    : "[wezard] 前置 " + (ask.after ?? []).join(", ") + " 已完成, " + ask.id + " 现在轮到你了。")
  + "\n原话 (" + ask.kind + ", 来自 " + askerName + "): " + ask.text;
export const msgClosedDone = (s: RoomState, msg: string): boolean => {
  const ds = [...s.duties.values()].filter((d) => d.msg === msg);
  return ds.length > 0 && ds.every((d) => d.closed?.status === "done");
};

// ── 镜像规则 (§3a) ─────────────────────────────────────────────────────

/** 一行进企微 ⇔ room 绑定了传输 ∧ 是 msg ∧ origin ∉ {inbound, migrate} ∧ kind ≠ trigger
 *  ∧ 有内容 (正文或文件至少一样)。空正文无文件的行 (纯 status 关账, 2026-11-23 人报: 空交代被发成
 *  只有身份头的空评论) 不出站 —— 账本里它照常存在并关账, 只是没东西可给人看。 */
export const mirrors = (row: RoomOp): boolean =>
  row.op === "msg" && isBoundRoom(row.room) && row.origin !== "inbound" && row.origin !== "migrate" && row.kind !== "trigger"
  && (String(row.text ?? "").trim() !== "" || (row.files?.length ?? 0) > 0);

// ── 出站: 一行的目标源 (§4.2, 纯判定; 传输句柄由 daemon 注入) ──────────

/** 这一行的目标源: reply 跟它所 re 那一行的 src (缺省 = 主源 = room id), 其余 (say / file / …) 回主源。
 *  re 一条都查不到 (不在本 room 账本) → 回落主源并置 fellBack, 调用方记日志 —— 不炸也不丢话。 */
export const outboundSourceOf = (row: Pick<MsgRow, "kind" | "re" | "room">, rowOf: (id: string) => MsgRow | undefined):
  { source: string; fellBack: boolean } => {
  if (row.kind !== "reply") return { source: row.room, fellBack: false };
  const hit = (row.re ?? []).map(rowOf).find((r) => !!r);
  if (!hit) return { source: row.room, fellBack: true };
  return { source: hit.src || row.room, fellBack: false };
};

/** 人话行的发生源 (src, 缺省主源): 占位气泡盖在哪条流上。cover 机制本身不动, 只拿它确认
 *  盖的流与这行的目标源是同一个 —— 不是就别盖, 免得把回复塞进另一个源的流里。 */
export const bubbleSourceOf = (row: Pick<MsgRow, "src" | "room">): string => row.src || row.room;

export type OutboundPlan =
  | { via: "wx"; chatId: string }
  | { via: "channel"; topicId: string; action: "post" | "reply"; post?: string }
  | { via: "post"; channel: string; post: string }
  | { via: "group"; chatId: string };

export interface OutboundDeps {
  /** 自管道 (wx) 是否接管这个裸 chat id。 */
  wxOwns: (chatId: string) => boolean;
  /** 该 base 是不是频道 (chat:<topic_id>)。 */
  isTopic: (base: string) => boolean;
  /** 帖子 base 的 {频道, 根帖} (channel-posts 映射); 没配对 = undefined。 */
  postRefOf: (base: string) => { channel: string; post: string } | undefined;
  /** 频道 room 里这行该评论哪条帖 (现行 channelOutboundOf 口径); 缺省 = 发新帖。 */
  channelAction?: (row: MsgRow) => { action: "post" } | { action: "reply"; post: string };
}

/** 目标源 → 传输 (设计稿 §4.2 表): wx > 频道 > 帖子 (有配对) > 群。
 *  帖子源仍查 channel-posts 的 {频道, 根帖} 拿企微侧地址; 绑定本身不改企微地址。 */
export const planOutbound = (source: string, row: MsgRow, d: OutboundDeps): OutboundPlan => {
  const chatId = source.replace(/^(user|chat|group):/, "");
  if (d.wxOwns(chatId)) return { via: "wx", chatId };
  if (d.isTopic(source)) {
    const topicId = source.replace(/^chat:/, "");
    const a = d.channelAction?.(row) ?? { action: "post" as const };
    return a.action === "reply" ? { via: "channel", topicId, action: "reply", post: a.post } : { via: "channel", topicId, action: "post" };
  }
  const ref = d.postRefOf(source);
  if (ref) return { via: "post", channel: ref.channel, post: ref.post };
  return { via: "group", chatId };
};

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
  /** 入站显式给出: "bot" = 人 @ 了机器人 (等同点名 host)。 */
  mention?: "bot";
  /** 频道 room 里这一行属于哪个帖子 (帖子 room 诞生前, 评论都记在频道 room 并带 post)。 */
  post?: string;
  /** 这一行从哪个副源进来 (multi-source-binding §3.3): 入站时写死, 缺省 = 本 room 主源。 */
  src?: string;
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

/** 这条人话是否已被 monitor 判过 (存量 activate trigger 行 / 新的 assign duty 都算)。 */
export const wasActivated = (s: RoomState, msgId: string): boolean =>
  s.msgs.some((m) => m.kind === "trigger" && m.sys === "activate" && (m.re ?? []).includes(msgId))
  || [...s.duties.values()].some((d) => d.msg === msgId && d.via === "assign");

/** room_activate 新路径的判定 (判决不写消息行): re 必须本 room 最后一条人话, to 至多一个本 room 的 wizard 成员,
 *  同一条人话只激活一次 (与旧 judge 的 activate 校验同口径)。ok 之后由调用方落一条 assign op。 */
export const judgeActivate = (
  s: RoomState, actor: Who, re: readonly string[], to: Who | undefined,
): { ok: true } | { ok: false; status: 400 | 403 | 409; reason: string } => {
  if (s.members.get(whoKey(actor))?.role !== "monitor")
    return { ok: false, status: 403, reason: "只有本 room 的 monitor 能写 activate 判决" };
  if (re.length !== 1) return { ok: false, status: 400, reason: "re 只收一条 (最后一条人话的消息 id)" };
  const target = s.byId.get(re[0]!);
  if (!target) return { ok: false, status: 400, reason: "re 不在这个 room: " + re[0] };
  if (target.author.kind !== "human" || target.kind !== "say")
    return { ok: false, status: 400, reason: "activate 的 re 必须是本 room 的人话: " + target.id };
  if (s.msgs.some((m) => m.seq > target.seq && m.author.kind === "human" && m.kind === "say"))
    return { ok: false, status: 409, reason: "activate 只能激活本 room 最后一条人话 (它之后还有人说话)" };
  if (wasActivated(s, target.id)) return { ok: false, status: 409, reason: "这条人话已经被激活过: " + target.id };
  if (to && to.kind !== "wizard") return { ok: false, status: 400, reason: "activate 只能激活 wizard" };
  if (to && !s.members.has(whoKey(to))) return { ok: false, status: 400, reason: "只能激活本 room 的成员" };
  return { ok: true };
};

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
  // activate 是 monitor 唯一能写的 trigger 行 (它的判决), 其余 trigger / system 只有 daemon 能写。
  const activate = d.kind === "trigger" && d.sys === "activate";
  if (!isDaemon && (d.kind === "system" || (d.kind === "trigger" && !activate))) return fail(403, d.kind + " 行只有 daemon 能写");
  if (activate && member?.role !== "monitor") return fail(403, "activate 行只有本 room 的 monitor 能写");
  if (d.kind === "join-req" && member) return fail(409, "你已经是成员");
  // activate 可以不带正文 (判决 "不回应" 就是一行空话)。
  if (!d.text.trim() && d.kind !== "reply" && !d.files?.length && !activate) return fail(400, "text required");

  // ② re 必须都在本 room
  const re = [...new Set(d.re ?? [])];
  const missing = re.filter((id) => !s.byId.has(id));
  if (missing.length) return fail(400, "re 不在这个 room: " + missing.join(", "));
  if (d.kind === "reply" && !re.length) return fail(400, "reply 必须带 re");

  // activate 的合法形状: re 恰一条本 room 最后一条人话; to 至多一个 wizard; 同一条人话只激活一次。
  if (activate) {
    if (re.length !== 1) return fail(400, "activate 必须且只能带一条 re (最后一条人话的 id)");
    const target = s.byId.get(re[0]!)!;
    if (target.author.kind !== "human" || target.kind !== "say") return fail(400, "activate 的 re 必须是本 room 的人话: " + re[0]);
    if (s.msgs.some((m) => m.seq > target.seq && m.author.kind === "human" && m.kind === "say"))
      return fail(409, "activate 只能激活本 room 最后一条人话 (它之后还有人说话)");
    if (wasActivated(s, target.id)) return fail(409, "这条人话已经被激活过: " + target.id);
    if ((d.to ?? []).length > 1) return fail(400, "activate 至多激活一个 wizard");
    if ((d.to ?? []).some((t) => t.kind !== "wizard")) return fail(400, "activate 只能激活 wizard");
  }

  // ③ status 写入权: 只有 holder (人超集; error 只有 daemon)
  let closes: string[] = [];
  let status: ReplyStatus | undefined;
  if (d.kind === "reply") {
    if (d.statusGiven && d.status === "error" && !isDaemon) return fail(403, "error 只有 daemon 能写");
    // 提问方可以撤回自己开在人名下的账 (不再需要了): 只认显式的 canceled / passed, done 仍只有人 (或人话关账) 能写。
    const retire = !!d.statusGiven && (d.status === "canceled" || d.status === "passed");
    const retirable = (x: Duty): boolean => retire && holderOf(s, x)?.kind === "human" && sameWho(x.asker, d.author);
    const mine = (id: string): Duty[] => openDuties(s).filter((x) => x.msg === id && (isHuman || isDaemon ? true : holderMatches(s, x, d.author) || retirable(x)));
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
        // 提问者自己撤回: 没有「提问者的补充」要先读。
        const newer = sameWho(duty.asker, d.author) ? [] : s.msgs.filter((m) => sameWho(m.author, duty.asker) && m.seq > holderSeen && (m.re ?? []).includes(duty.msg));
        if (newer.length && !isHuman && !isDaemon) return fail(409, "先读 seq " + newer[newer.length - 1]!.seq + ": 提问者对 " + duty.msg + " 有你还没读到的补充");
        closes.push(duty.key);
      }
    }
  } else if (d.statusGiven) return fail(400, "status 只用于 reply");

  // 人话关账: 人的下一句话关掉它名下 (本 room) 未关的 duty —— 带 re 且 re 命中其中几条就只关被引用的,
  // 否则 (没引用 / 引用的不是它的账) 全关。被关账的提问 wizard 就是这句话的收话人 (judge 补进 to, 下面)。
  if (isHuman && d.kind === "say") closes = humanCloses(s, d.author, re);

  // ⑤ to 只认成员 (人话的 .name 点名由调用方先拉进来)
  const given = (d.to ?? []).filter((t, i, a) => a.findIndex((x) => sameWho(x, t)) === i);
  if (!isDaemon) {
    const outsiders = given.filter((t) => !s.members.has(whoKey(t)));
    if (outsiders.length) return fail(409, "这些不是本 room 成员: " + outsiders.map((t) => t.id).join(", ") + " — 先邀请, 或改去 dm room");
  }
  if ((d.kind === "ask" || d.kind === "task") && !given.some((t) => t.kind === "wizard" || t.kind === "human")) return fail(400, d.kind + " 至少点名一个 wizard 或人成员");
  // judge 自己补的收话人 (落进行里, 重放不再推断): need → 被反问的人 (开 need duty); 人话关账 → 提问的 wizard。
  const addressees = judgeAddressees(s, d, re, status, closes);
  const to = [...given, ...addressees.filter((a) => !given.some((t) => sameWho(t, a)))];

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
  // 绑定 room 里没点名、也没 @ 机器人的人话: 交给 monitor 处置 (只唤醒它, 不在 host 槽位开 duty)。
  const toMonitor = isHuman && d.kind === "say" && isBoundRoom(s.id) && d.mention !== "bot" && !to.some((t) => t.kind === "wizard") && hasMonitor(s);
  const seq = s.seq + 1;
  const draftRow: MsgRow = {
    op: "msg", at: ctx.now, room: s.id, id: msgIdOf(s.id, seq), seq, author: d.author, ord: member?.ord ?? 0, speak,
    kind: d.kind, text: d.text, ...(to.length ? { to } : {}), ...(re.length ? { re } : {}), ...(status ? { status } : {}),
    ...(d.mention ? { mention: d.mention } : {}), ...(d.post ? { post: d.post } : {}), ...(d.src ? { src: d.src } : {}), ...(toMonitor ? { monitor: true as const } : {}),
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

/** 这一行该唤醒谁 (wizard uid, 不含作者自己)。B-3: 点名 + host 兜底 + 订阅, 其余只推游标。
 *  人话关了谁名下的账, 谁 (提问者) 就在 `to` 里 (judge 补的, 见 judgeAddressees) —— 走 named, 与 host 兜底天然去重。 */
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
      // 绑定 room 里没点名的人话 → monitor (有的话, 不开 duty) / host。@ 了机器人的直达 host。
      if (row.author.kind === "human" && !named.length && isBoundRoom(row.room)) {
        if (row.monitor) monitorsOf(s).forEach(add);
        else add(roomHost(s));
      }
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
/** 行正文的读法: 人话行 (origin inbound) 曾把提醒尾巴一起写进 text, 老行不改写、读侧剥掉 (见 stripLegacyTail);
 *  新行只存原话, 剥一遍是空操作。只有 inbound 行带过尾巴, 别的来源的 text 原样返回。 */
export const rowText = (m: Pick<MsgRow, "text" | "origin">): string => (m.origin === "inbound" ? stripLegacyTail(m.text) : m.text);
export const renderMsgLine = (m: MsgRow, n: RenderNames, max = 500): string => {
  // monitor 的 activate 判决是系统行为, 不是 monitor 发言 (§2.2): 输出系统形态, 不以 monitor 名义出现。
  // 只精确匹配 sys:"activate"; 其他 trigger (after-wake / overdue / 定时任务) 照旧按消息行渲染 (author 是 wezard, 带正文)。
  if (m.kind === "trigger" && m.sys === "activate") {
    const re = m.re?.length ? " (re " + m.re.join(",") + ")" : "";
    const targets = (m.to ?? []).filter((t) => t.kind === "wizard").map(n.nameOf).join(", ");
    return "[" + m.id + "] [" + n.nameOf(DAEMON) + "] monitor 判决: " + (targets ? "交给 " + targets + " 回应" : "不回应") + re;
  }
  const to = m.to?.length ? " → " + m.to.map(n.nameOf).join(", ") : "";
  const re = m.re?.length ? " (re " + m.re.join(",") + ")" : "";
  const body = rowText(m).replace(/\s+/g, " ").trim();
  const files = m.files?.length ? " 📎" + m.files.map((f) => f.name).join(",") : "";
  return "[" + m.id + "] " + n.nameOf(m.author) + to + re + statusTag(m) + ": " + (body.length > max ? body.slice(0, max) + "…(+" + (body.length - max) + ")" : body) + files;
};

/** who 的游标之后、别人说的行数 (不含自己) —— rolepage 的未读角标; 与 unreadFor 同一口径, 不装预算。 */
export const unreadCount = (s: RoomState, who: Who): number => {
  const seen = s.members.get(whoKey(who))?.seen ?? 0;
  return s.msgs.reduce((n, m) => (m.seq > seen && !sameWho(m.author, who) ? n + 1 : n), 0);
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
    const cost = triggers.includes(m.id) ? 0 : Math.min(rowText(m).length, 500);
    if (picked.length && used + cost > budget && !triggers.includes(m.id)) continue;
    picked.unshift(m);
    used += cost;
  }
  return { rows: picked, more: eligible.length - picked.length, to: s.seq };
};
/** 被拉者入座时能读到多少旧话: none | 最近 N 条 | from:<msgId> | all (缺省)。 */
export type HistoryArg = "none" | "all" | number | `from:${string}`;

/** 入座时的初始 seen 游标 (null = 不写, 保持 0 = 全部可读); 输入不合法 → {error}。纯函数。
 *  seen 只往前推, 所以新成员 (从 0 起) 写这条 seen 就等于「只看游标之后」。 */
export const historyCursor = (s: RoomState, history: unknown): number | null | { error: string } => {
  if (history === undefined || history === null || history === "" || history === "all") return null;
  if (history === "none") return s.seq;
  const asNum = typeof history === "number" ? history : typeof history === "string" && /^\d+$/.test(history.trim()) ? Number(history) : NaN;
  if (Number.isFinite(asNum)) {
    if (!Number.isInteger(asNum) || asNum < 1) return { error: "history 的数字要是正整数 (得到 " + asNum + ")" };
    return s.msgs.length <= asNum ? null : s.msgs[s.msgs.length - asNum]!.seq - 1;
  }
  if (typeof history === "string" && history.startsWith("from:")) {
    const row = s.byId.get(history.slice(5).trim());
    return row ? row.seq - 1 : { error: "history 的 from: 指向的消息不在本 room: " + history.slice(5) };
  }
  return { error: 'history 取值: "none" | 正整数 N | "from:<msgId>" | "all"' };
};

/** 入座那一批 op 后面跟的 seen (游标 ≤ 0 或 null 时没有)。 */
export const seatSeenOps = (s: RoomState, who: Who, at: number, history: unknown): SeenOp[] | { error: string } => {
  const c = historyCursor(s, history);
  if (c !== null && typeof c === "object") return c;
  return c ? [{ op: "seen", at, room: s.id, who, seq: c }] : [];
};

export type DmPlan =
  | { kind: "create" }
  | { kind: "use" }
  | { kind: "rejoin"; missing: string[] }
  | { kind: "pair-adhoc" };

/** dm:A|B 现状 → 怎么用: 不存在 → 建; 只有 A/B → 用 (缺人先补回); 混进第三人 → 不再落进它, 另找 / 另开 adhoc。 */
export const planDm = (s: RoomState | undefined, a: string, b: string): DmPlan => {
  if (!s) return { kind: "create" };
  const ms = [...s.members.values()].map((m) => m.who);
  if (ms.some((w) => !(w.kind === "wizard" && (w.id === a || w.id === b)))) return { kind: "pair-adhoc" };
  const missing = [a, b].filter((u) => !s.members.has(whoKey({ kind: "wizard", id: u })));
  return missing.length ? { kind: "rejoin", missing } : { kind: "use" };
};

/** 在 adhoc room 里找当前成员恰好等于 uids (wizard uid 集合, 顺序无关) 的那个; 多个取最近活动 (最后一条消息, 无则 open) 的。 */
export const findSetAdhoc = (states: readonly RoomState[], uids: readonly string[]): string | undefined => {
  const want = new Set(uids.map((u) => whoKey({ kind: "wizard", id: u })));
  return states
    .filter((s) => s.id.startsWith("adhoc:") && s.members.size === want.size && [...want].every((k) => s.members.has(k)))
    .map((s) => ({ id: s.id, at: s.msgs.length ? s.msgs[s.msgs.length - 1]!.at : s.openedAt ?? 0 }))
    .sort((x, y) => y.at - x.at)[0]?.id;
};
/** 两人的特例。 */
export const findPairAdhoc = (states: readonly RoomState[], a: string, b: string): string | undefined => findSetAdhoc(states, [a, b]);

/** parent 是不是 child 的直属 parent (judge ⑥ interrupt 限权的判据; hub 与自动 adhoc 落点共用)。 */
export const isDirectParent = (parentUidOf: (childUid: string) => string | undefined, parent: Who, child: Who): boolean =>
  parent.kind === "wizard" && child.kind === "wizard" && parentUidOf(child.id) === parent.id;

/** 「你要交代」的用法提示这次该不该附: 它最近 window 次成功唤醒批次 (跨 room 按 at 去重) 里写过任何 chat_reply 行 → 不附; 批次不足 window / 窗口内没写过 / window ≤ 0 → 附。
 *  states = 它所在的各 room; 只从尾往前扫到窗口起点为止。 */
export const replyHintDue = (states: readonly RoomState[], uid: string, window: number): boolean => {
  if (window <= 0) return true;
  const me = whoKey({ kind: "wizard", id: uid });
  const ats = [...new Set(states.flatMap((s) => s.members.get(me)?.batches ?? []))].sort((a, b) => b - a);
  if (ats.length < window) return true;
  const cutoff = ats[window - 1]!;
  return !states.some((s) => {
    for (let i = s.msgs.length - 1; i >= 0; i--) {
      const r = s.msgs[i]!;
      if (r.at < cutoff) return false;
      if (r.kind === "reply" && r.author.kind === "wizard" && r.author.id === uid) return true;
    }
    return false;
  });
};
