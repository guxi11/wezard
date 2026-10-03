// Rolepage 的视图模型 —— 从**一个 role 的视角**重新折叠 turn 记录。纯函数, 无 IO。
//
// chat-view 折的是「一个聊天里有哪些会话」; 名字全局唯一以后这个轴不对了: wizard
// 不属于某个聊天, 它在好几个群里被人叫、跟好几个同伴私聊。人想看的是它的 IM ——
// 它参与了哪些群聊与单聊、在每一处说了什么、听到了什么。
//
// 一轮 turn 在这里拆成两条消息:
//   入  发话方 → 该 wizard     userQuery
//   出  该 wizard → 发话方     本轮的回复 (文本 + 工具细节)
// 发话方: 同伴 (from.kind=peer) / 定时任务 (task) / 人 (speaker; 认不出就是
// 「未知」)。消息落在哪个会话由 channel 决定 —— 公开频道 (群 / 与人的单聊) 按 base
// 归并, 私聊按对端 wizard 归并。
//
// role id: wizard 就是它的 target key; 人是 `human:<userid>` (`human:` = 不知道是谁);
// 定时任务是 `task:<id>` —— 它只发不收, 不能切成视角。系统是 `system:` (名为 wezard):
// agent team 队友的话以 `<teammate-message>` 写进 transcript 的 user 行, 长得和人在
// 终端里打的字一样, 但不是人说的 —— 归给系统, 同样不能切成视角。人不用 `user:<id>`: 那正是
// 「与这个人的单聊」里默认 wizard 的 target, 两者字面相同, 同一条消息会变成自己对自己说。
import { baseOfKey, labelFor, stripSigil, tagOfKey } from "./session-label.js";
import { isGhostTurn, isMark, isPost, isTurn, staleAt, summarizeTag, type TagSummary } from "./chat-view.js";
import { isKeepaliveTurn } from "./keepalive.js";
import type { Asker, DetailRecord, MarkDetailRecord, PostDetailRecord, TurnDetailRecord } from "./detail-store.js";
import { jobProgress, type WorldFactJob, type WorldFacts, type WorldFactWizard } from "./world.js";

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
  // 保温 ping 是守护进程打的, 不是人: 频道上挂着的 speaker 是上一句人话留下的。
  if (isKeepaliveTurn(r)) return SYSTEM;
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
export const isPing = (m: Msg): boolean =>
  PINGS.get(m.turn) ?? ((v) => (PINGS.set(m.turn, v), v))(isKeepaliveTurn(m.turn));
/** 按轮次对象记: 判定要对问话跑一串正则, 而 /api/glance 每张卡片都把全部消息筛一遍 ——
 *  关系图几十张卡片就是几十万次。store 里的对象跨请求不变, 轮次一写就换新对象。 */
const PINGS = new WeakMap<TurnDetailRecord, boolean>();

/** 一个公开频道里听话的那一方: 与人的单聊是那个人; 群里是这条链的链头 (守护进程写 turn /
 *  post 时顺着派活链记下的, 见 Asker) —— 只在他正是在这个群里开的口时才算; 认不出就是
 *  `human:` (未知), 不拿群里别的开口的人去猜: 一个 wizard 可能同时在答好几个人。 */
export const audienceOf = (channel: string, asker: Asker | undefined): string =>
  channel.startsWith("user:") ? humanOf(channel) : asker?.chat === channel ? humanOf(asker.who) : "human:";

/** 回执轮: 守护进程把同伴那一轮的终句原样转进发话方的会话。 */
const isReceipt = (r: TurnDetailRecord): boolean => r.from?.kind === "peer" && r.from.receipt === true;

/** 一轮 → 入/出两条消息。没问话的 (/clear 之后的续跑) 只有出; 还没产出也没在跑
 *  的只有入。
 *  回执轮例外: 入那一句就是同伴自己那一轮的出 (同一段话, 已在同伴的出消息里), 再画
 *  一遍就是重复, 所以没有入; 它的出是在频道里对那里的人说的 —— 公开频道答给人, 只有
 *  私聊回执 ("" 频道, 回复不进任何群) 才仍是对那个同伴。 */
/** 一轮里的插话 → 各自一个只有问话的轮次外形 (id `<轮>~<序号>`): 出处、频道、发话人都是它自己的,
 *  不随被插的那一轮。它没有自己的回复 —— 回复在被插的那一轮的出消息里。 */
export const injectTurnsOf = (r: TurnDetailRecord): TurnDetailRecord[] =>
  (r.injects ?? []).map((x, i) => ({
    kind: "turn", id: `${r.id}~${i}`, createdAt: x.ts, updatedAt: x.ts, closed: true, items: [],
    target: r.target, sessionId: r.sessionId, userQuery: x.body, channel: x.channel,
    ...(x.from ? { from: x.from } : {}), ...(x.speaker ? { speaker: x.speaker } : {}),
  }));

export const messagesOfTurn = (r: TurnDetailRecord): Msg[] => {
  const w = r.target!;
  const who = senderOf(r);
  const channel = channelOf(r);
  const receipt = isReceipt(r);
  const to = receipt && channel ? audienceOf(channel, r.from?.asker) : who;
  const firstOut = r.items.reduce((m, it) => Math.min(m, it.ts), Infinity);
  const inMsg: Msg[] = r.userQuery?.trim() && !receipt
    ? [{ id: `${r.id}:in`, turn: r, dir: "in", from: who, to: w, channel, ts: r.createdAt }]
    : [];
  const outMsg: Msg[] = r.items.length > 0 || !r.closed
    ? [{ id: `${r.id}:out`, turn: r, dir: "out", from: w, to, channel, ts: Math.max(r.createdAt + 1, Number.isFinite(firstOut) ? firstOut : r.createdAt + 1) }]
    : [];
  const injected: Msg[] = injectTurnsOf(r).map((t) => ({ id: `${t.id}:in`, turn: t, dir: "in", from: senderOf(t), to: w, channel: t.channel ?? "", ts: t.createdAt }));
  return [...inMsg, ...outMsg, ...injected];
};

/** notify 贴进群的一段话 → 发话 wizard 在那个频道里的一条出消息, 对着那里的人说。
 *  装进一个已收口、只有一段终句的轮次外形, 渲染与未读水位都照出消息的老规矩走。 */
export const messageOfPost = (p: PostDetailRecord): Msg => ({
  id: `${p.id}:out`,
  turn: {
    kind: "turn", id: p.id, createdAt: p.createdAt, updatedAt: p.createdAt, closed: true,
    target: p.target, channel: p.channel, items: [{ t: "text", body: p.body, ts: p.createdAt, final: true }],
  },
  dir: "out",
  from: p.target,
  to: audienceOf(p.channel, p.asker),
  channel: p.channel,
  ts: p.createdAt,
});

export const allMessages = (records: readonly DetailRecord[], now: number): Msg[] =>
  [...convTurns(records, now).flatMap(messagesOfTurn), ...records.filter(isPost).map(messageOfPost)]
    .sort((a, b) => a.ts - b.ts);

// ── 名录 ─────────────────────────────────────────────────────────────
/** 一个 wizard 此刻的活体状态。「执行中」由客户端判: busy || 现在 < runningUntil ——
 *  pane 的转圈 (busy) 在长工具调用里也亮着, 但它是名册快照、会过期; turn 记录
 *  (runningUntil) 随写入即时, 但静默久了会误熄。两个信号互补, 任一成立就算在跑。 */
export interface RoleStatus {
  alive: boolean;
  busy: boolean;
  /** 同 TagSummary.runningUntil: 无新写入时到这个时刻自动算结束, 0 = 已停。 */
  runningUntil: number;
  /** 停在哪些工具调用上等人点; 缺省 = 没在等。优先于「执行中」—— 审批长轮询期间 pane 可能还在转圈。 */
  waiting?: string[];
}

export interface Directory {
  nameOf: (id: string) => string;
  labelOf: (id: string) => string;
  /** `.fix` / `fix` / target / `user:x` → role id; undefined = 不认识。 */
  resolve: (ref: string) => string | undefined;
  fact: (id: string) => WorldFactWizard | undefined;
  chatName: (base: string) => string;
  isWizard: (id: string) => boolean;
  /** undefined = 不是 wizard (人 / 定时 / 系统没有「执行中」)。 */
  status: (id: string, now: number) => RoleStatus | undefined;
  /** 认得的全部 wizard。 */
  wizards: () => string[];
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
    if (id === "human:") return "未知";
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
  // 只有摘要要状态, 而 makeDirectory 每次 flush 都会建 —— 用到才扫一遍。
  let until: Map<string, number> | undefined;
  const untilOf = (id: string): number =>
    (until ??= records.filter(isTurn).reduce(
      (m, r) => (r.target ? m.set(r.target, Math.max(m.get(r.target) ?? 0, staleAt(r))) : m),
      new Map<string, number>(),
    )).get(id) ?? 0;
  const status = (id: string, now: number): RoleStatus | undefined => {
    if (!wizards.has(id)) return undefined;
    const f = facts_.get(id);
    const t = untilOf(id);
    return { alive: f?.alive ?? false, busy: f?.busy ?? false, runningUntil: t > now ? t : 0, ...(f?.waiting?.length ? { waiting: f.waiting } : {}) };
  };
  return { nameOf, labelOf, resolve, fact: (id) => facts_.get(id), chatName, isWizard: (id) => wizards.has(id), status, wizards: () => [...wizards] };
};

// ── 会话 ─────────────────────────────────────────────────────────────
// key 相对于视角 role: `c:<base>` 公开频道, `p:<对端>` 私聊。
// 有人在的频道一律是群聊 (与人的「单聊」也是: 人 + 住在里面的 wizard); 只有 wizard
// 之间的才是私聊。
export type ConvKind = "group" | "wizard" | "job";

export interface ConvSub {
  role: string;
  name: string;
  label: string;
  /** 它与当前 role 在这个频道里的往来条数 (与点进去看到的窗口同一份)。 */
  count: number;
  lastTs: number;
  /** 这一对往来的最后一句。 */
  preview: string;
  /** 我与它在这里最后一次开口的时刻 (0 = 没开过口) —— 这一对的默认已读水位。 */
  mine: number;
  /** 它在这个频道里的全部记录 (不按成对过滤) —— 侧栏「chat 内全部」下与我无往来的那几项用它。 */
  whole: Glance & { count: number };
  /** 它是 wizard 时才有。 */
  status?: RoleStatus;
  /** 这一对往来里出现过的工单 (侧栏一行的 📋 标记)。 */
  jobs?: string[];
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
  /** 私聊对端的状态 (群没有)。 */
  status?: RoleStatus;
  lastTs: number;
  preview: string;
  count: number;
  /** 别人在这里说完的话, 最近的在后 —— 客户端拿它对自己的已读水位点未读 (见 Heard)。 */
  heard: Heard[];
  /** 我在这里最后一次开口的时刻 —— 不属于任何一对的那些话的默认已读水位。 */
  mine: number;
  /** 群里的其他 role (只对公开频道)。 */
  subs: ConvSub[];
  /** 这处往来里出现过的工单 (侧栏一行的 📋 标记); 没有 = 不给。 */
  jobs?: string[];
  /** 工单 (`j:<id>`) 的账: 开着没有、落定几份 / 一共几份。 */
  job?: { id: string; owner: string; status: "open" | "closed"; done: number; total: number; parent?: string; kind?: "req"; stage?: string };
}

const involves = (m: Msg, role: string): boolean => m.from === role || m.to === role;
const other = (m: Msg, role: string): string => (m.from === role ? m.to : m.from);
export const convKeyOf = (m: Msg, role: string): string => (m.channel ? `c:${m.channel}` : `p:${other(m, role)}`);

/** 「某 role 与某些对端的往来」—— 侧栏会话项 / 子项、会话窗口、关系图卡片的窗口都是它。
 *  peers 空 = 不限对端 (role 参与的全部); chat 给了就只在那个频道 ("" = 私聊), 不给 = 不限。
 *  保温 ping 的对端是系统, 不是这一对里的谁 —— 限定了对端时按它保温的那个 wizard 归:
 *  保温的是 role 或其中一个对端就留着。时间序不变。 */
export const talkOf = (msgs: readonly Msg[], role: string, peers: readonly string[] = [], chat?: string): Msg[] => {
  const pick = new Set(peers);
  const withPeer = (m: Msg): boolean =>
    isPing(m) ? m.turn.target === role || pick.has(m.turn.target ?? "") : involves(m, role) && pick.has(other(m, role));
  return msgs.filter((m) => (chat === undefined || m.channel === chat) && (pick.size ? withPeer(m) : involves(m, role)));
};

/** `a:<x>` = x 参与的全部对话; `a:<x>|<p1>,<p2>` = x 与这几个对端之间的 —— 不分会话, 按时间排开。
 *  再带一段 `|<base>` 就只在那个频道里 (`a:<x>||<base>` = x 在那个群里的全部记录, 对端不限)。 */
export const parseTalkKey = (key: string): { who: string; peers: string[]; chat?: string } | undefined => {
  if (!key.startsWith("a:")) return undefined;
  const [who = "", rest, chat] = key.slice(2).split("|");
  return { who, peers: rest ? rest.split(",").filter(Boolean) : [], ...(chat ? { chat } : {}) };
};

const stripMd = (s: string): string => s.replace(/[`*_~|#>]/g, "").replace(/\s+/g, " ").trim();
/** 一条消息里最后那句话与它说出的时刻: 入 = 问话 (轮次开始); 出 = 最后一段 text ——
 *  工具调用之间的独白也算, 时刻取那段 text 自己的, 而不是这一轮开口的时刻。 */
const saidOf = (m: Msg): { body: string; ts: number } => {
  if (m.dir === "in") return { body: stripMd(unwrapMates(m.turn.userQuery ?? "")).slice(0, 80), ts: m.ts };
  const t = [...m.turn.items].reverse().find((it): it is Extract<typeof it, { t: "text" }> => it.t === "text");
  return { body: stripMd(t?.body ?? "").slice(0, 80), ts: t?.ts ?? m.ts };
};

export interface Glance { preview: string; lastTs: number }
/** 会话列表一行的预览与时间 —— 取自同一句话: 所有有正文的消息里**最晚说出**的那句
 *  (按 text 自己的时刻比, 不按消息排序: 一轮长跑的独白可能晚于之后才进来的问话)。
 *  只有工具调用、或还在跑没吐字的那一轮没有可预览的话, 越过它落在上一句真话上;
 *  一句话都没有才退回最后一条消息的时刻。`who` 给出正文前的发话人前缀 (群聊用)。 */
const glance = (ms: readonly Msg[], who: (m: Msg) => string = () => ""): Glance | undefined =>
  ms.reduce<Glance | undefined>((best, m) => {
    const s = saidOf(m);
    return s.body && s.ts >= (best?.lastTs ?? -Infinity) ? { preview: who(m) + s.body, lastTs: s.ts } : best;
  }, undefined);
const glanceOr = (ms: readonly Msg[], who?: (m: Msg) => string): Glance =>
  glance(ms, who) ?? { preview: "", lastTs: ms[ms.length - 1]?.ts ?? 0 };

/** 一行预览前的说话人: 这一项的对端不是恰好一个 (不限 / 多个) 时才写「.x: 」, 视角自己说的不写。
 *  peers 就是打开这一项时 talkOf 的入参 (整个公开频道 = 不限) —— 会话项、子项、关系图卡片都从这里拿。 */
const speakerPrefix = (dir: Directory, viewer: string, peers?: readonly string[]): ((m: Msg) => string) | undefined =>
  peers?.length === 1
    ? undefined
    : (m) => (m.from === viewer ? "" : `${dir.isWizard(m.from) ? "." : ""}${dir.nameOf(m.from)}: `);

/** 一个 talkOf 窗口在列表里的那一行: 最近一句 (按上面的规则带说话人) 与时刻。ping 不是话。 */
export const glanceOfTalk = (msgs: readonly Msg[], viewer: string, dir: Directory, who: string, peers: readonly string[], chat?: string): Glance => {
  const ms = talkOf(msgs.filter((m) => !isPing(m)), who, peers, chat);
  return glanceOr(ms, speakerPrefix(dir, viewer, peers));
};

const SUB_MAX = 40;

/** 别人说完的一句 `[说完的时刻, 发话方, 收信方]`。说给视角的那句属于「我与发话方」那个成对子项,
 *  其余只属于群 —— 客户端据此给群和每个子项点未读。
 *  水位按时刻而不按条数: 条数随 span / 记录清理伸缩, 时刻不会 —— 且群与子项共用一份,
 *  读完一个子项只抹掉它的, 群的账不必再做加减。 */
export type Heard = [number, string, string];
const HEARD_MAX = 100;

/** 一条消息「说完」的时刻, 没说完 (或是自己说的) 就是 undefined。人 / 同伴 / 定时的问话
 *  一发出就是完整的; wizard 的回复要等终句 —— 说不清 final 的后端 (软收口) 以轮次关闭为准。
 *  只看 dir=out 会把人漏光: 人在群里说的话永远只是入消息。 */
const saidAt = (role: string) => (m: Msg): number | undefined => {
  if (m.from === role) return undefined;
  if (m.dir === "in") return m.ts;
  const t = [...m.turn.items].reverse().find((it): it is Extract<typeof it, { t: "text" }> =>
    it.t === "text" && (it.final === true || (it.final === undefined && !!m.turn.closed)));
  return t?.ts;
};

const heardBy = (role: string) => (ms: readonly Msg[]): Heard[] =>
  ms.flatMap((m): Heard[] => {
    const ts = saidAt(role)(m);
    return ts === undefined ? [] : [[ts, m.from, m.to]];
  }).sort((a, b) => a[0] - b[0]).slice(-HEARD_MAX);
/** 开口之后才进来的话才可能没读过: 回过话 = 读到了那里。回话要有正文 ——
 *  只开了轮次、还在调工具没吐字的那条出消息不算开口 (saidOf 会退回轮次开始的时刻, 那会把
 *  同时进来的问话误当成已读)。 */
const spokeBy = (role: string) => (ms: readonly Msg[]): number =>
  ms.filter((m) => m.from === role).reduce((t, m) => {
    const said = m.dir === "in" ? m.ts : m.turn.items.filter((it) => it.t === "text").reduce((a, it) => Math.max(a, it.ts ?? 0), 0);
    return Math.max(t, said);
  }, 0);

/** 一个 role 参与的全部会话, 最近活动在前。群聊只列它**自己开过口**的 —— 住在里面
 *  (home) 或只是被人叫过一声却没答话的, 都不算参与; 私聊则有往来就在列。 */
export const convsOf = (all_: readonly Msg[], role: string, dir: Directory, now: number): Conv[] => {
  // 会话列表讲的是"谁跟谁说过什么", ping 不是话: 条数与预览都不该被它顶掉。
  const msgs = all_.filter((m) => !isPing(m));
  const heard = heardBy(role);
  const spoke = spokeBy(role);
  const mine = talkOf(msgs, role);
  const keys = [...new Set(mine.filter((m) => !m.channel || m.from === role).map((m) => convKeyOf(m, role)))];
  return keys
    .map((key): Conv => {
      if (key.startsWith("p:")) {
        const peer = key.slice(2);
        const ms = talkOf(mine, role, [peer], "");
        return {
          key, kind: "wizard", name: dir.nameOf(peer), label: dir.labelOf(peer), base: "", peer,
          status: dir.status(peer, now),
          ...glanceOr(ms, speakerPrefix(dir, role, [peer])), count: ms.length, heard: heard(ms), mine: spoke(ms), subs: [], ...withJobs(ms),
        };
      }
      const base = key.slice(2);
      const all = msgs.filter((m) => m.channel === base);
      const others = [...new Set(all.flatMap((m) => [m.from, m.to]))].filter((r) => r !== role && !r.startsWith("task:") && r !== SYSTEM);
      // 子项成对: 群里与视角有往来的每个 role 一项, 内容是「我与它」在这个群里的对话 (与点进去的窗口同一份 talkOf)。
      // 没往来的 count 为 0, 默认不列; 「chat 内全部」下用 whole (它在群里的全部记录) 列出来。
      // 两份 glance 都走 glanceOfTalk —— 关系图卡片 (/api/glance) 的同一个实现。
      const subs = others
        .map((r): ConvSub => {
          const pair = talkOf(all, role, [r]);
          return {
            role: r, name: dir.nameOf(r), label: dir.labelOf(r), count: pair.length, mine: spoke(pair),
            ...glanceOfTalk(all, role, dir, role, [r], base), status: dir.status(r, now),
            whole: { count: talkOf(all, r).length, ...glanceOfTalk(all, role, dir, r, [], base) }, ...withJobs(pair),
          };
        })
        // 成对的排前 (默认只列它们), 其余按它们自己的记录排 —— 截断时先丢与我无往来的。
        .sort((a, b) => Number(b.count > 0) - Number(a.count > 0) || (a.count ? b.lastTs - a.lastTs : b.whole.lastTs - a.whole.lastTs))
        .slice(0, SUB_MAX);
      return {
        key, kind: "group", base,
        name: dir.chatName(base) || (base.startsWith("user:") ? dir.nameOf(humanOf(base)) : base.replace(/^chat:/, "").slice(0, 10)),
        label: "💬",
        ...glanceOr(all, speakerPrefix(dir, role)), count: all.length, heard: heard(all), mine: spoke(all), subs, ...withJobs(all),
      };
    })
    .sort((a, b) => b.lastTs - a.lastTs);
};

// ── 工单 ─────────────────────────────────────────────────────────────
// `j:<id>` 是一张工单的全部往来: 归在它名下的派活、各成员的答话、送回开单者的回执 —— 不分
// 谁对谁, 也不按视角的 session 段裁 (成员各有各的 session)。开工 / 收工两行不是消息, 由
// chat-http 按 facts 现画。
export const jobOfKey = (key: string): string | undefined => (key.startsWith("j:") ? key.slice(2) : undefined);
export const jobMessages = (msgs: readonly Msg[], id: string): Msg[] => msgs.filter((m) => m.turn.from?.job === id);
/** 一组消息里出现过的工单号, 去重保序。 */
export const jobsIn = (msgs: readonly Msg[]): string[] => [...new Set(msgs.map((m) => m.turn.from?.job ?? "").filter(Boolean))];
const withJobs = (msgs: readonly Msg[]): { jobs?: string[] } => ((js) => (js.length ? { jobs: js } : {}))(jobsIn(msgs));

/** 视角开的、或在里面的工单 —— 主区工单列表的一行, 数据与群 / 私聊同一套 (glance)。不进侧栏。 */
export const jobConvsOf = (all_: readonly Msg[], role: string, dir: Directory, jobs: readonly WorldFactJob[]): Conv[] => {
  const msgs = all_.filter((m) => !isPing(m));
  return jobs
    .filter((j) => j.owner === role || j.members.some((mm) => mm.target === role))
    .map((j): Conv => {
      const ms = jobMessages(msgs, j.id);
      const g = glanceOr(ms, speakerPrefix(dir, role));
      return {
        key: `j:${j.id}`, kind: "job", name: j.title, label: "📋", base: j.base,
        preview: g.preview, lastTs: Math.max(g.lastTs, j.closedAt ?? j.openedAt),
        // 工单里的每句话同时也在某个群 / 私聊里, 未读只记在那一处 —— 两边各记一份, 读了一边另一边还亮着。
        count: ms.length, heard: [], mine: 0, subs: [],
        job: { id: j.id, owner: j.owner, status: j.status, ...(j.parent ? { parent: j.parent } : {}), ...(j.kind ? { kind: j.kind } : {}), ...(j.stage ? { stage: j.stage } : {}), ...jobProgress(j) },
      };
    });
};

/** 每个 role 对应的全部叶子项 —— 群里的成对子项 (它与某个 role 在那个群里有往来, 与 convsOf 的子项
 *  同一口径) 与私聊项 (有往来就算)。侧栏名字旁的「+N」= 这份减去那一项自己。
 *  key 取绝对的 (`c:<base>|<a>|<b>` / `p:<a>|<b>`, 两端排序), 与视角无关。定时与系统不是聊天的一方。 */
export const chatKeysOf = (all_: readonly Msg[]): Record<string, string[]> => {
  const party = (r: string): boolean => !!r && !r.startsWith("task:") && r !== SYSTEM;
  const index = all_.filter((m) => !isPing(m)).reduce((idx, m) => {
    const add = (r: string, k: string) => idx.set(r, (idx.get(r) ?? new Set<string>()).add(k));
    if (party(m.from) && party(m.to)) {
      const pair = [m.from, m.to].sort().join("|");
      const k = m.channel ? `c:${m.channel}|${pair}` : `p:${pair}`;
      add(m.from, k); add(m.to, k);
    }
    return idx;
  }, new Map<string, Set<string>>());
  return Object.fromEntries([...index].map(([r, ks]) => [r, [...ks]] as const));
};

/** 一个会话窗口里的消息。`withRole` 只对公开频道有意义: 当前 role 与它在这个频道里的往来。
 *  整个公开频道 (不带 withRole) 是频道里所有人说的话, 不是某个 role 的往来 —— 唯一不走 talkOf 的。 */
export const convMessages = (msgs: readonly Msg[], role: string, key: string, withRole?: string): Msg[] => {
  const job = jobOfKey(key);
  if (job) return jobMessages(msgs, job);
  const t = talkArgs(role, key, withRole);
  return t ? talkOf(msgs, t.who, t.peers, t.chat) : msgs.filter((m) => m.channel === key.slice(2));
};

export interface TalkArgs { who: string; peers: string[]; chat?: string }
/** 一个窗口交给 talkOf 的入参; 整个公开频道不是谁的往来, 没有。群里选中一个子项 (withRole)
 *  看的是视角与它在这个群里的往来。 */
export const talkArgs = (role: string, key: string, withRole?: string): TalkArgs | undefined => {
  const t = parseTalkKey(key);
  if (t) return t;
  if (key.startsWith("p:")) return { who: role, peers: [key.slice(2)], chat: "" };
  return withRole ? { who: role, peers: [withRole], chat: key.slice(2) } : undefined;
};

/** 纯 wizard↔wizard 的私聊窗口 (两端都是 wizard、没限定到某个群): 里面不画断点 ——
 *  /new 的是 wizard 自己的上下文 (handoff 重开也记一条), 不是这场对话的边界, 署名还会落到人头上。 */
export const isWizardDm = (role: string, key: string, withRole: string | undefined, dir: Pick<Directory, "isWizard">): boolean => {
  const t = talkArgs(role, key, withRole);
  return !!t && !t.chat && t.peers.length > 0 && [t.who, ...t.peers].every(dir.isWizard);
};

/** 窗口是视角与恰好另一个 role 之间的往来时, 那个 role; 否则 (群 / 多个对端 / 不含视角) 没有。 */
export const counterpartOf = (viewer: string, t: TalkArgs | undefined): string | undefined => {
  if (t?.peers.length !== 1) return undefined;
  const [p] = t.peers;
  return t.who === viewer ? p : p === viewer ? t.who : undefined;
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
export interface RoleInfo extends RoleStatus {
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
  /** fork 自父亲的哪个 sessionId; "" = 不是分身。 */
  forkedFrom: string;
}

const COLD: RoleStatus = { alive: false, busy: false, runningUntil: 0 };

export const roleInfo = (id: string, dir: Directory, facts: WorldFacts, stats: TagSummary | undefined, now: number): RoleInfo => {
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
    ...(dir.status(id, now) ?? COLD),
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
  talkOf(msgs, role).some((m) => m.turn.from?.kind === "peer");
