// Rolepage 的视图模型 —— 从**一个 role 的视角**重新折叠 turn 记录。纯函数, 无 IO。
//
// chat-view 折的是「一个聊天里有哪些会话」; 名字全局唯一以后这个轴不对了: wizard
// 不属于某个聊天, 它在好几个群里被人叫、跟好几个同伴私聊。人想看的是它的 IM ——
// 它参与了哪些群聊与单聊、在每一处说了什么、听到了什么。
//
// 一轮 turn 在这里拆成两条消息:
//   入  发话方 → 该 wizard     userQuery
//   出  该 wizard → 发话方     本轮的回复 (文本 + 工具细节)
// 发话方: 同伴 (from.kind=peer) / 定时任务 (task) / 人 (speaker; 老记录没有就是
// 「人」)。消息落在哪个会话由 channel 决定 —— 公开频道 (群 / 与人的单聊) 按 base
// 归并, 私聊按对端 wizard 归并。
//
// role id: wizard 就是它的 target key; 人是 `human:<userid>` (`human:` = 不知道是谁);
// 定时任务是 `task:<id>` —— 它只发不收, 不能切成视角。系统是 `system:` (名为 wezard):
// agent team 队友的话以 `<teammate-message>` 写进 transcript 的 user 行, 长得和人在
// 终端里打的字一样, 但不是人说的 —— 归给系统, 同样不能切成视角。人不用 `user:<id>`: 那正是
// 「与这个人的单聊」里默认 wizard 的 target, 两者字面相同, 同一条消息会变成自己对自己说。
import { baseOfKey, labelFor, stripSigil, tagOfKey } from "./session-label.js";
import { isGhostTurn, isKeepaliveTurn, isMark, isTurn, summarizeTag, type TagSummary } from "./chat-view.js";
import type { DetailRecord, MarkDetailRecord, TurnDetailRecord } from "./detail-store.js";
import type { WorldFacts, WorldFactWizard } from "./world.js";

export type RoleKind = "wizard" | "human" | "task";

export interface Msg {
  /** `<turnId>:in` / `<turnId>:out`。 */
  id: string;
  turn: TurnDetailRecord;
  dir: "in" | "out";
  from: string;
  to: string;
  /** 公开频道的 base; "" = wizard 之间的私聊。 */
  channel: string;
  ts: number;
}

// ── 频道与发话方 ─────────────────────────────────────────────────────
/** 见 TurnDetailRecord.channel: 老记录按 from 推 —— peer 私聊, 其余在 home。 */
export const channelOf = (r: TurnDetailRecord): string =>
  r.channel !== undefined
    ? r.channel
    : r.from?.kind === "peer" && !r.from.public
      ? ""
      : baseOfKey(r.target ?? "");

/** `user:<id>` (speaker / 单聊 base) → 人的 role id。 */
export const humanOf = (principal: string): string => `human:${principal.replace(/^user:/, "").replace(/#.*$/, "")}`;

export const SYSTEM = "system:";
const MATE_RE = /^\s*<teammate-message\b([^>]*)>/;
/** 这句是不是 agent team 队友递进来的; 是就给出它的 teammate_id ("" = 没标)。 */
export const teammateOf = (q: string | undefined): string | undefined => {
  const attrs = q?.match(MATE_RE)?.[1];
  return attrs === undefined ? undefined : attrs.match(/\bteammate_id="([^"]*)"/)?.[1] ?? "";
};
/** 去掉 `<teammate-message …>` 包装, 只留它说的话。 */
export const unwrapMates = (q: string): string =>
  q.replace(/<teammate-message\b[^>]*>\s*/g, "").replace(/\s*<\/teammate-message>/g, "");

export const senderOf = (r: TurnDetailRecord): string => {
  if (r.from?.kind === "peer") return r.from.from || "human:";
  if (r.from?.kind === "task") return `task:${r.from.taskId || "?"}`;
  // 先于 speaker: 队友的话落进来时, 频道上挂着的可能还是上一句人话的 speaker。
  const mate = teammateOf(r.userQuery);
  if (mate !== undefined) return SYSTEM;
  if (r.speaker) return humanOf(r.speaker);
  const ch = channelOf(r);
  // 与人的单聊里发话的只可能是那个人。
  return ch.startsWith("user:") ? humanOf(ch) : "human:";
};

/** 顶层会话里的轮次: 去空壳、去子 agent (它内联在父轮里)。保温 ping 留着 ——
 *  它不是对话, 但它是真花销, 时间轴上抹掉就等于说这段时间什么都没发生;
 *  视图把它折成一行 (见 isPing)。 */
const convTurns = (records: readonly DetailRecord[], now: number): TurnDetailRecord[] =>
  records.filter(isTurn).filter((r) => !!r.target && !r.agent && !isGhostTurn(r, now));

/** 保温 ping 的那一条 —— 进时间轴, 但不进会话列表的条数/预览, 也不算一条关系。 */
export const isPing = (m: Msg): boolean => isKeepaliveTurn(m.turn);

/** 一轮 → 入/出两条消息。没问话的 (/clear 之后的续跑) 只有出; 还没产出也没在跑
 *  的只有入。 */
export const messagesOfTurn = (r: TurnDetailRecord): Msg[] => {
  const w = r.target!;
  const who = senderOf(r);
  const channel = channelOf(r);
  const firstOut = r.items.reduce((m, it) => Math.min(m, it.ts), Infinity);
  const inMsg: Msg[] = r.userQuery?.trim()
    ? [{ id: `${r.id}:in`, turn: r, dir: "in", from: who, to: w, channel, ts: r.createdAt }]
    : [];
  const outMsg: Msg[] = r.items.length > 0 || !r.closed
    ? [{ id: `${r.id}:out`, turn: r, dir: "out", from: w, to: who, channel, ts: Math.max(r.createdAt + 1, Number.isFinite(firstOut) ? firstOut : r.createdAt + 1) }]
    : [];
  return [...inMsg, ...outMsg];
};

export const allMessages = (records: readonly DetailRecord[], now: number): Msg[] =>
  convTurns(records, now).flatMap(messagesOfTurn).sort((a, b) => a.ts - b.ts);

// ── 名录 ─────────────────────────────────────────────────────────────
export interface Directory {
  nameOf: (id: string) => string;
  labelOf: (id: string) => string;
  /** `.fix` / `fix` / target / `user:x` → role id; undefined = 不认识。 */
  resolve: (ref: string) => string | undefined;
  fact: (id: string) => WorldFactWizard | undefined;
  chatName: (base: string) => string;
  isWizard: (id: string) => boolean;
}

const fold = (s: string): string => stripSigil(s).toLowerCase();

export const makeDirectory = (records: readonly DetailRecord[], facts: WorldFacts): Directory => {
  const facts_ = new Map(facts.wizards.map((w) => [w.target, w] as const));
  const turnTargets = new Set(records.filter(isTurn).map((r) => r.target).filter((t): t is string => !!t));
  const wizards = new Set([...facts_.keys(), ...turnTargets]);
  const chatName = (base: string): string => facts.chatNames[base] ?? "";
  const nameOf = (id: string): string => {
    if (id.startsWith("task:")) return `定时 ${id.slice(5)}`;
    if (id === SYSTEM) return "wezard";
    if (wizards.has(id)) return (facts_.get(id)?.name ?? "").trim() || tagOfKey(id) || chatName(baseOfKey(id)) || id;
    if (id === "human:") return "人";
    return id.startsWith("human:") ? id.slice(6) : id;
  };
  const labelOf = (id: string): string =>
    id.startsWith("task:") ? "⏰" : id === SYSTEM ? "🧙" : wizards.has(id) ? labelFor(nameOf(id)) : "👤";
  const byName = new Map([...wizards].map((t) => [fold(nameOf(t)), t] as const));
  const resolve = (ref: string): string | undefined => {
    const r = (ref ?? "").trim();
    if (!r) return undefined;
    if (wizards.has(r)) return r;
    const named = byName.get(fold(r));
    if (named) return named;
    if (/^human:[^#]*$/.test(r)) return r;
    return /^user:[^#]+$/.test(r) ? humanOf(r) : undefined;
  };
  return { nameOf, labelOf, resolve, fact: (id) => facts_.get(id), chatName, isWizard: (id) => wizards.has(id) };
};

// ── 会话 ─────────────────────────────────────────────────────────────
// key 相对于视角 role: `c:<base>` 公开频道, `p:<对端>` 私聊。
// 有人在的频道一律是群聊 (与人的「单聊」也是: 人 + 住在里面的 wizard); 只有 wizard
// 之间的才是私聊。
export type ConvKind = "group" | "wizard";

export interface ConvSub {
  role: string;
  name: string;
  label: string;
  /** 与当前 role 在这个频道里的往来条数。 */
  count: number;
  lastTs: number;
  /** 与我往来的最后一条 (没有就是它在这个频道里的最后一条)。 */
  preview: string;
}

export interface Conv {
  key: string;
  kind: ConvKind;
  name: string;
  label: string;
  /** 公开频道的 base; 私聊为 ""。 */
  base: string;
  /** 私聊的对端。 */
  peer?: string;
  lastTs: number;
  preview: string;
  count: number;
  /** 群里的其他 role (只对公开频道)。 */
  subs: ConvSub[];
}

const involves = (m: Msg, role: string): boolean => m.from === role || m.to === role;
const other = (m: Msg, role: string): string => (m.from === role ? m.to : m.from);
export const convKeyOf = (m: Msg, role: string): string => (m.channel ? `c:${m.channel}` : `p:${other(m, role)}`);

const stripMd = (s: string): string => s.replace(/[`*_~|#>]/g, "").replace(/\s+/g, " ").trim();
const msgText = (m: Msg): string => {
  if (m.dir === "in") return unwrapMates(m.turn.userQuery ?? "");
  const t = [...m.turn.items].reverse().find((it): it is Extract<typeof it, { t: "text" }> => it.t === "text");
  return t?.body ?? "";
};
const previewOf = (m: Msg | undefined, dir: Directory): string =>
  m ? `${dir.nameOf(m.from)}: ${stripMd(msgText(m)).slice(0, 80)}` : "";

const SUB_MAX = 40;

/** 一个 role 参与的全部会话, 最近活动在前。wizard 的 home 频道即使还没说过话也在列。 */
export const convsOf = (all_: readonly Msg[], role: string, dir: Directory): Conv[] => {
  // 会话列表讲的是"谁跟谁说过什么", ping 不是话: 条数与预览都不该被它顶掉。
  const msgs = all_.filter((m) => !isPing(m));
  const mine = msgs.filter((m) => involves(m, role));
  const homes = dir.isWizard(role) ? [`c:${baseOfKey(role)}`] : [];
  const keys = [...new Set([...mine.map((m) => convKeyOf(m, role)), ...homes])];
  return keys
    .map((key): Conv => {
      if (key.startsWith("p:")) {
        const peer = key.slice(2);
        const ms = mine.filter((m) => !m.channel && other(m, role) === peer);
        const last = ms[ms.length - 1];
        return {
          key, kind: "wizard", name: dir.nameOf(peer), label: dir.labelOf(peer), base: "", peer,
          lastTs: last?.ts ?? 0, preview: previewOf(last, dir), count: ms.length, subs: [],
        };
      }
      const base = key.slice(2);
      const all = msgs.filter((m) => m.channel === base);
      const last = all[all.length - 1];
      const others = [...new Set(all.flatMap((m) => [m.from, m.to]))].filter((r) => r !== role && !r.startsWith("task:") && r !== SYSTEM);
      const subs = others
        .map((r): ConvSub => {
          const pair = all.filter((m) => involves(m, role) && other(m, role) === r);
          const seen = all.filter((m) => involves(m, r));
          const last = pair[pair.length - 1] ?? seen[seen.length - 1];
          return {
            role: r, name: dir.nameOf(r), label: dir.labelOf(r), count: pair.length,
            lastTs: last?.ts ?? 0, preview: previewOf(last, dir),
          };
        })
        // 与我有往来的排前, 再按最近。
        .sort((a, b) => Number(b.count > 0) - Number(a.count > 0) || b.lastTs - a.lastTs)
        .slice(0, SUB_MAX);
      return {
        key, kind: "group", base,
        name: dir.chatName(base) || (base.startsWith("user:") ? dir.nameOf(humanOf(base)) : base.replace(/^chat:/, "").slice(0, 10)),
        label: "💬",
        lastTs: last?.ts ?? 0, preview: previewOf(last, dir), count: all.length, subs,
      };
    })
    .sort((a, b) => b.lastTs - a.lastTs);
};

/** 一个会话窗口里的消息。`withRole` 只对公开频道有意义: 当前 role 与它在这个频道里的往来。 */
export const convMessages = (msgs: readonly Msg[], role: string, key: string, withRole?: string): Msg[] => {
  if (key.startsWith("p:")) {
    const peer = key.slice(2);
    return msgs.filter((m) => !m.channel && involves(m, role) && other(m, role) === peer);
  }
  const base = key.slice(2);
  const ch = msgs.filter((m) => m.channel === base);
  return withRole ? ch.filter((m) => involves(m, role) && other(m, role) === withRole) : ch;
};

// ── session ───────────────────────────────────────────────────────────
// 同一个名字下的多个 session (/clear /new 轮换, handoff 重开): 按 sessionId 分段,
// 每段的时间窗 = [首轮, 下一段首轮)。切换 session 就是按时间窗过滤 —— 同一时段里
// 群里别人说的话也一并留着, 那是那段 session 听到的上下文。
export interface SessionSpan {
  sessionId: string;
  start: number;
  end: number;
  turns: number;
  lastTs: number;
}

export const sessionsOf = (records: readonly DetailRecord[], role: string, now: number): SessionSpan[] => {
  const turns = records.filter(isTurn).filter((r) => r.target === role && !r.agent && !isGhostTurn(r, now))
    .sort((a, b) => a.createdAt - b.createdAt);
  const groups = turns.reduce<Array<{ sessionId: string; rs: TurnDetailRecord[] }>>((acc, r) => {
    const sid = r.sessionId ?? "";
    const cur = acc[acc.length - 1];
    return cur && cur.sessionId === sid ? [...acc.slice(0, -1), { sessionId: sid, rs: [...cur.rs, r] }] : [...acc, { sessionId: sid, rs: [r] }];
  }, []);
  return groups.map((g, i) => ({
    sessionId: g.sessionId,
    start: g.rs[0]!.createdAt,
    end: groups[i + 1]?.rs[0]?.createdAt ?? Infinity,
    turns: g.rs.length,
    lastTs: g.rs.reduce((m, r) => Math.max(m, r.updatedAt), 0),
  }));
};

export const inSpan = (span: SessionSpan | undefined) => (ts: number): boolean =>
  !span || (ts >= span.start && ts < span.end);

/** 视角 role 自己的上下文断点 (/clear /new) —— 画在它参与的每个会话窗口里。 */
export const marksOf = (records: readonly DetailRecord[], role: string): MarkDetailRecord[] =>
  records.filter(isMark).filter((m) => m.target === role);

// ── 身份 ─────────────────────────────────────────────────────────────
export interface RoleInfo {
  id: string;
  kind: RoleKind;
  name: string;
  label: string;
  description: string;
  cwd: string;
  model: string;
  bornAt?: number;
  /** home 聊天的名字。 */
  chat: string;
  parent?: { id: string; name: string; label: string };
  /** 分身: 从某个 session 节点 fork 出来的, 开局带着那一刻的上下文。 */
  clones: Array<{ id: string; name: string; label: string }>;
  /** 子 wizard: spawn 出来的白板, 只有出身、没有继承。 */
  spawns: Array<{ id: string; name: string; label: string }>;
  alive: boolean;
  busy: boolean;
  /** fork 自父亲的哪个 sessionId; "" = 不是分身。 */
  forkedFrom: string;
}

export const roleInfo = (id: string, dir: Directory, facts: WorldFacts, stats: TagSummary | undefined): RoleInfo => {
  const f = dir.fact(id);
  const ref = (t: string) => ({ id: t, name: dir.nameOf(t), label: dir.labelOf(t) });
  const wiz = dir.isWizard(id);
  const kids = facts.wizards.filter((w) => w.parent === id);
  return {
    id,
    kind: wiz ? "wizard" : id.startsWith("task:") ? "task" : "human",
    name: dir.nameOf(id),
    label: dir.labelOf(id),
    description: f?.description ?? "",
    cwd: f?.cwd || stats?.cwd || "",
    model: f?.model || stats?.model || "",
    bornAt: f?.bornAt,
    chat: wiz ? dir.chatName(baseOfKey(id)) : "",
    parent: f?.parent ? ref(f.parent) : undefined,
    clones: kids.filter((w) => w.clonedFrom).map((w) => ref(w.target)),
    spawns: kids.filter((w) => !w.clonedFrom).map((w) => ref(w.target)),
    alive: f?.alive ?? false,
    busy: f?.busy ?? false,
    forkedFrom: f?.clonedFrom ?? "",
  };
};

/** 页脚总账: 视角 role 自己跑过的全部轮次 (含子 agent 与 ping —— 那都是真花销)。 */
export const roleStats = (records: readonly DetailRecord[], role: string, now: number, span?: SessionSpan): TagSummary | undefined => {
  const turns = records.filter(isTurn)
    .filter((r) => r.target === role && !isGhostTurn(r, now) && inSpan(span)(r.createdAt))
    .sort((a, b) => a.createdAt - b.createdAt);
  return turns.length ? summarizeTag(role, turns, now) : undefined;
};

/** 一个会话窗口的账: 窗口里那几轮, 连同它们派出的子 agent (那也是这段往来的花销)。
 *  人自己不跑轮次, 没有 roleStats —— 它看的是「我与这个 wizard 在这个群里」花了多少。 */
export const windowStats = (records: readonly DetailRecord[], msgs: readonly Msg[], target: string, now: number): TagSummary | undefined => {
  const ids = new Set(msgs.map((m) => m.turn.id));
  const turns = records.filter(isTurn)
    .filter((r) => ids.has(r.id) || ids.has(r.agent?.parentTurnId ?? ""))
    .sort((a, b) => a.createdAt - b.createdAt);
  return turns.length ? summarizeTag(target, turns, now) : undefined;
};

/** 与别的 role 有没有关系 (家谱 / 私聊 / 派活) —— 决定顶栏要不要出「关系图」入口。 */
export const hasRelations = (msgs: readonly Msg[], role: string, info: RoleInfo): boolean =>
  !!info.parent || info.clones.length > 0 || info.spawns.length > 0 ||
  msgs.some((m) => involves(m, role) && (m.turn.from?.kind === "peer"));
