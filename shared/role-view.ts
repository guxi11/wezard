// Rolepage 的视图模型 —— 从**一个 role 的视角**重新折叠 turn 记录。纯函数, 无 IO。
//
// chat-view 折的是「一个聊天里有哪些会话」; 名字全局唯一以后这个轴不对了: wizard
// 不属于某个聊天, 它在好几个群里被人叫、跟好几个同伴私聊。人想看的是它的 IM ——
// 它参与了哪些群聊与单聊、在每一处说了什么、听到了什么。
//
// 一轮 turn 在这里拆成两条消息:
//   入  发话方 → 该 wizard     userQuery
//   出  该 wizard → 发话方     本轮的回复 (文本 + 工具细节)
// 发话方: 同伴 (from.kind=peer) / 定时任务 (task) / 人 (speaker; 认不出是谁就归
// 系统 wezard —— 不另立一个「未知」role)。消息落在哪个会话由 channel 决定 —— 公开频道 (群 / 与人的单聊) 按 base
// 归并, 私聊按对端 wizard 归并。
//
// role id: wizard 就是它的 target key; 人是 `human:<userid>`;
// 定时任务是 `task:<id>` —— 它只发不收, 不能切成视角。系统是 `system:` (名为 wezard):
// 认不出是谁的发话方 / 听话方都归它; agent team 队友的话以 `<teammate-message>` 写进 transcript 的 user 行, 长得和人在
// 终端里打的字一样, 但不是人说的 —— 归给系统, 同样不能切成视角。人不用 `user:<id>`: 那正是
// 「与这个人的单聊」里默认 wizard 的 target, 两者字面相同, 同一条消息会变成自己对自己说。
import { baseOfKey, labelFor, stripSigil, tagOfKey } from "./session-label.js";
import { isGhostTurn, isMark, isPost, isTurn, staleAt, summarizeTag, type TagSummary } from "./chat-view.js";
import { isKeepaliveTurn } from "./keepalive.js";
import type { Asker, DetailRecord, MarkDetailRecord, PostDetailRecord, TurnDetailRecord } from "./detail-store.js";
import { jobProgress, type WorldFactJob, type WorldFacts, type WorldFactWeixin, type WorldFactWizard } from "./world.js";

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
  if (r.from?.kind === "peer") return r.from.from || SYSTEM;
  if (r.from?.kind === "task") return `task:${r.from.taskId || "?"}`;
  // 保温 ping 是守护进程打的, 不是人: 频道上挂着的 speaker 是上一句人话留下的。
  if (isKeepaliveTurn(r)) return SYSTEM;
  // 先于 speaker: 队友的话落进来时, 频道上挂着的可能还是上一句人话的 speaker。
  const mate = teammateOf(r.userQuery);
  if (mate !== undefined) return SYSTEM;
  if (r.speaker) return humanOf(r.speaker);
  const ch = channelOf(r);
  // 与人的单聊里发话的只可能是那个人。
  return ch.startsWith("user:") ? humanOf(ch) : SYSTEM;
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
 *  系统 wezard, 不拿群里别的开口的人去猜: 一个 wizard 可能同时在答好几个人。 */
export const audienceOf = (channel: string, asker: Asker | undefined): string =>
  channel.startsWith("user:") ? humanOf(channel) : asker?.chat === channel ? humanOf(asker.who) : SYSTEM;

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
  /** 微信通道群 (`chat:wx_…`) 的账号状态; 不是微信群 / 老 daemon 没给 = undefined。 */
  weixin: (base: string) => WorldFactWeixin | undefined;
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
    return id.startsWith("human:") ? facts.humanNames?.[id] || id.slice(6) : id;
  };
  const labelOf = (id: string): string =>
    id.startsWith("task:") ? "⏰" : id === SYSTEM ? "🧙‍♂️" : wizards.has(id) ? labelFor(nameOf(id)) : "👤";
  const byName = new Map([...wizards].map((t) => [fold(nameOf(t)), t] as const));
  const resolve = (ref: string): string | undefined => {
    const r = (ref ?? "").trim();
    if (!r) return undefined;
    if (wizards.has(r)) return r;
    const named = byName.get(fold(r));
    if (named) return named;
    // 老链接里的 `human:` (从前「未知」的那个人) 就是现在的系统 wezard。
    if (r === "human:") return SYSTEM;
    if (/^human:[^#]+$/.test(r)) return r;
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
  const wx = new Map((facts.weixin ?? []).map((w) => [w.base, w] as const));
  return { nameOf, labelOf, resolve, fact: (id) => facts_.get(id), chatName, weixin: (base) => wx.get(base), isWizard: (id) => wizards.has(id), status, wizards: () => [...wizards] };
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
  /** 它在这个频道里的全部记录 (不按成对过滤) —— 侧栏「chat 内全部」下与我无往来的那几项用它。 */
  whole: Glance & { count: number };
  /** 这一项的未读账 (见 Ledger): 成对的按「我与它」那一窗切, 与我无往来的按它在群里的全部记录切 —— 都是点开它看到的那一份。 */
  heard: Heard[];
  theirs?: Heard[];
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
  /** 点开这里看得见的未读 (见 Ledger), 最近的在后; 群还并上它各子项的 —— 收起时群这一行替子项们说。 */
  heard: Heard[];
  /** 私聊对端在这里看不见的未读 (名字旁); 群没有主人, 不给。 */
  theirs?: Heard[];
  /** 群里的其他 role (只对公开频道)。 */
  subs: ConvSub[];
  /** 这处往来里出现过的工单 (侧栏一行的 📋 标记); 没有 = 不给。 */
  jobs?: string[];
  /** 微信通道群的状态标记 (见 wxMark); 企微群 / 私聊没有。 */
  wx?: WxMark;
  /** 工单 (`j:<id>`) 的账: 开着没有、落定几份 / 一共几份。 */
  job?: { id: string; owner: string; status: "open" | "closed"; done: number; total: number; parent?: string; kind?: "req"; stage?: string };
}

// ── 微信通道 ─────────────────────────────────────────────────────────
/** 群行 / 群详情头部名字旁的小标记: 怎么判、写什么只在这里, 页面照抄 text / tip。 */
export interface WxMark { state: "live" | "paused" | "down"; text: string; tip: string }
const agoText = (ms: number): string =>
  ms < 60_000 ? "刚刚" : ms < 3600_000 ? `${Math.floor(ms / 60_000)} 分钟前` : ms < 86400_000 ? `${Math.floor(ms / 3600_000)} 小时前` : `${Math.floor(ms / 86400_000)} 天前`;
export const wxMark = (w: WorldFactWeixin, now: number): WxMark => {
  const state = w.state === "expired" ? "down" : w.pausedUntil > now ? "paused" : "live";
  const head = { live: "🟢 微信", paused: "⏸️ 微信频控", down: "🔴 微信掉线" }[state];
  const tip = [
    state === "down" ? "微信通道掉线 —— 在企微单聊发 /wx bind 重新扫码" : "微信通道在线",
    `对方最近开口: ${w.lastInAt ? agoText(now - w.lastInAt) : "从没有"}`,
    ...(state === "down" ? [] : [`这一轮还能发 ${w.budget} 条 (对方每说一句补一份额度)`]),
    ...(w.held ? [`压着 ${w.held} 条没发出, ${state === "down" ? "重新绑定后" : "对方再说一句就"}取回`] : []),
    ...(state === "paused" ? [`频控暂停出站, 还剩 ${Math.ceil((w.pausedUntil - now) / 60_000)} 分钟`] : []),
  ].join("\n");
  return { state, text: head + (w.held ? ` · 📬 压着 ${w.held}` : ""), tip };
};

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

/** 一句未读 `[说完的时刻, 发话方, 收信方, 消息 id]` (见 UnreadIndex / Ledger)。
 *  已读只有一份: 客户端按 id 记「这句话说完的样子在详情里上过屏」, 换视角、换视图都不重记。 */
export type Heard = [number, string, string, string];
const HEARD_MAX = 100;

/** 一条消息说完的时刻, 没说完就是 undefined。人 / 同伴 / 定时的问话一发出就是完整的;
 *  wizard 的回复要等终句 —— 说不清 final 的后端 (软收口) 以轮次关闭为准。
 *  只看 dir=out 会把人漏光: 人在群里说的话永远只是入消息。与视角无关 —— 详情片段也带它 (见 MsgFragment.fin)。 */
export const doneAt = (m: Msg): number | undefined => {
  if (m.dir === "in") return m.ts;
  const t = [...m.turn.items].reverse().find((it): it is Extract<typeof it, { t: "text" }> =>
    it.t === "text" && (it.final === true || (it.final === undefined && !!m.turn.closed)));
  return t?.ts;
};

/** 开口之后才进来的话才可能没读过: 回过话 = 读到了那里。回话要有正文 ——
 *  只开了轮次、还在调工具没吐字的那条出消息不算开口 (saidOf 会退回轮次开始的时刻, 那会把
 *  同时进来的问话误当成已读)。 */
const spokeBy = (role: string) => (ms: readonly Msg[]): number =>
  ms.filter((m) => m.from === role).reduce((t, m) => {
    const said = m.dir === "in" ? m.ts : m.turn.items.filter((it) => it.t === "text").reduce((a, it) => Math.max(a, it.ts ?? 0), 0);
    return Math.max(t, said);
  }, 0);

/** 按频道分好的消息, 按数组对象记: 同一份消息只分一遍。 */
const CHANNELS = new WeakMap<readonly Msg[], Map<string, Msg[]>>();
const channelsOf = (all: readonly Msg[]) => (ch: string): Msg[] => {
  const idx = CHANNELS.get(all) ?? ((v) => (CHANNELS.set(all, v), v))(new Map<string, Msg[]>());
  return idx.get(ch) ?? ((v) => (idx.set(ch, v), v))(all.filter((m) => m.channel === ch));
};

const memo = <T>(f: (k: string) => T): ((k: string) => T) => {
  const m = new Map<string, T>();
  return (k) => (m.has(k) ? m.get(k)! : ((v) => (m.set(k, v), v))(f(k)));
};

/** 未读的判定 —— 侧栏会话项 / 子项、关系图卡片的红点与名字旁的他人未读都从这一份派生。一句话算 role 的未读:
 *  别人说完的; 它听得到 —— 私聊里说给它的, 或它开过口的群里的 (没开过口的群不在它的会话列表里, 切过去也看不到);
 *  且晚于它在那一处最后开口的 (回过话 = 读到了那里)。「那一处」: 私聊 / 群里说给它的 = 它与发话方的往来, 群里其余的 =
 *  整个群 —— 在群里说过话不等于读过别的线程。水位看全部消息, 不看窗口: 同一句话对同一个 role, 在哪一项里问都是同一个答案。 */
export interface UnreadIndex {
  /** 这句是不是 role 的未读。 */
  of: (role: string) => (m: Msg) => boolean;
  /** role 自己的全部未读 —— 切到它的视角会看到的那一份。 */
  all: (role: string) => Msg[];
}

export const unreadIndex = (all_: readonly Msg[]): UnreadIndex => {
  const all = all_.filter((m) => !isPing(m));
  const inChannel = channelsOf(all);
  // 谁在哪个群里开过口、私聊里说给谁的 —— 一遍建好, 每个 role 只看它听得到的那几处。
  const speakers = all.reduce((idx, m) => (m.channel ? idx.set(m.channel, (idx.get(m.channel) ?? new Set<string>()).add(m.from)) : idx), new Map<string, Set<string>>());
  const dmTo = all.reduce((idx, m) => {
    if (!m.channel) (idx.get(m.to) ?? idx.set(m.to, []).get(m.to)!).push(m);
    return idx;
  }, new Map<string, Msg[]>());
  // 说完的时刻要倒着翻一轮的条目, 每个 role 都问一遍 —— 按消息记一次。
  const fins = new Map<Msg, number | undefined>();
  const finOf = (m: Msg): number | undefined => (fins.has(m) ? fins.get(m) : ((v) => (fins.set(m, v), v))(doneAt(m)));
  const of = memo((role: string) => {
    const said = spokeBy(role);
    // `<频道>\0<发话方>` = 它与发话方在那一处的往来; 只有频道 = 整个群。
    const mark = memo((k: string): number => {
      const [ch = "", from] = k.split("\0");
      return said(from === undefined ? inChannel(ch) : talkOf(inChannel(ch), role, [from]));
    });
    return (m: Msg): boolean => {
      if (m.from === role || isPing(m) || (m.channel ? !speakers.get(m.channel)?.has(role) : m.to !== role)) return false;
      const ts = finOf(m);
      return ts !== undefined && ts > mark(m.to === role || !m.channel ? `${m.channel}\0${m.from}` : m.channel);
    };
  });
  const allOf = memo((role: string): Msg[] =>
    [...(dmTo.get(role) ?? []), ...[...speakers].filter(([, who]) => who.has(role)).flatMap(([ch]) => inChannel(ch))].filter(of(role)));
  return { of, all: allOf };
};

/** 一项 (侧栏会话项 / 子项、关系图卡片) 的未读账, 按点开它看到的消息 (windowOf —— 与详情区渲染同一个函数) 切成不相交的两份:
 *  heard  = 这里看得见的未读 (红点): 页面视角的, 加上这一项主人的 —— 点开就读到, 只记在这里;
 *  theirs = 主人在这里看不见的未读 (名字旁): 切到它的视角才看得到。点开这一项读到的不会在这里。
 *  主人缺省 / 就是视角 (群项、视角自己那张卡片) 就没有名字旁。 */
export interface Ledger { heard: Heard[]; theirs?: Heard[] }

/** keep: 服务端已知不算的 (基线前说完的、记过已读的) 先筛掉, 再按说完的时刻留最近 HEARD_MAX 句。 */
export const ledgerOf = (ix: UnreadIndex, viewer: string, keep: (h: Heard) => boolean = () => true) => {
  const mine = ix.of(viewer);
  const heardOf = (ms: readonly Msg[]): Heard[] =>
    ms.map((m): Heard => [doneAt(m) ?? 0, m.from, m.to, m.id]).filter(keep).sort((a, b) => a[0] - b[0]).slice(-HEARD_MAX);
  return (win: readonly Msg[], owner?: string): Ledger => {
    if (!owner || owner === viewer) return { heard: heardOf(win.filter(mine)) };
    const theirs = ix.of(owner);
    const here = new Set(win.map((m) => m.id));
    return { heard: heardOf(win.filter((m) => mine(m) || theirs(m))), theirs: heardOf(ix.all(owner).filter((m) => !here.has(m.id))) };
  };
};

/** 一个 role 的会话项键: 它开过口的群 + 有往来的私聊。mine = talkOf(msgs, role)。 */
const convKeysOf = (mine: readonly Msg[], role: string): string[] =>
  [...new Set(mine.filter((m) => !m.channel || m.from === role).map((m) => convKeyOf(m, role)))];

const party = (r: string): boolean => !!r && !r.startsWith("task:") && r !== SYSTEM;

/** 同一句只留一份 (按 id), 时间序。 */
const mergeHeard = (...hss: ReadonlyArray<readonly Heard[]>): Heard[] =>
  [...new Map(hss.flat().map((h) => [h[3], h] as const)).values()].sort((a, b) => a[0] - b[0]).slice(-HEARD_MAX);

export interface ConvsOpts {
  /** 视角选的 session 段: 列哪些项、条数与预览只看这一段; 未读账按点开时的窗口 (windowOf) 切, 裁不裁由 spanFor 定。 */
  span?: SessionSpan;
  /** 未读账 (ledgerOf); 不给 = 不算 (搜索只要名字与预览)。 */
  ledger?: (win: readonly Msg[], owner?: string) => Ledger;
}

/** 一个 role 参与的全部会话, 最近活动在前。群聊只列它**自己开过口**的 —— 住在里面
 *  (home) 或只是被人叫过一声却没答话的, 都不算参与; 私聊则有往来就在列。 */
export const convsOf = (all_: readonly Msg[], role: string, dir: Directory, now: number, opts: ConvsOpts = {}): Conv[] => {
  // 会话列表讲的是"谁跟谁说过什么", ping 不是话: 条数与预览都不该被它顶掉。
  const msgs = all_.filter((m) => !isPing(m) && inSpan(opts.span)(m.ts));
  const mine = talkOf(msgs, role);
  // 每一项的账都拿点开它时的那一窗来切 —— 详情区取消息的同一个 windowOf。
  const book = (key: string, withRole: string | undefined, owner: string | undefined): Ledger =>
    opts.ledger ? opts.ledger(windowOf(all_, role, key, withRole, opts.span), owner) : { heard: [] };
  return convKeysOf(mine, role)
    .map((key): Conv => {
      if (key.startsWith("p:")) {
        const peer = key.slice(2);
        const ms = talkOf(mine, role, [peer], "");
        return {
          key, kind: "wizard", name: dir.nameOf(peer), label: dir.labelOf(peer), base: "", peer,
          status: dir.status(peer, now),
          ...glanceOr(ms, speakerPrefix(dir, role, [peer])), count: ms.length, ...book(key, undefined, peer), subs: [], ...withJobs(ms),
        };
      }
      const base = key.slice(2);
      const all = channelsOf(msgs)(base);
      const others = [...new Set(all.flatMap((m) => [m.from, m.to]))].filter((r) => r !== role && party(r));
      // 子项成对: 群里与视角有往来的每个 role 一项, 内容是「我与它」在这个群里的对话 (与点进去的窗口同一份 talkOf)。
      // 没往来的 count 为 0, 默认不列; 「chat 内全部」下用 whole (它在群里的全部记录) 列出来。
      // 两份 glance 都走 glanceOfTalk —— 关系图卡片 (/api/glance) 的同一个实现。
      const subs = others
        .map((r): ConvSub => {
          const pair = talkOf(all, role, [r]);
          const whole = talkOf(all, r);
          return {
            role: r, name: dir.nameOf(r), label: dir.labelOf(r), count: pair.length,
            ...glanceOfTalk(all, role, dir, role, [r], base), status: dir.status(r, now),
            whole: { count: whole.length, ...glanceOfTalk(all, role, dir, r, [], base) }, ...withJobs(pair),
            // 点它打开的窗: 成对 = 群里「我与它」(chat.js subRow), 与我无往来 = 它在群里的全部记录 (chat.js farKey)。
            ...book(pair.length ? key : `a:${r}||${base}`, pair.length ? r : undefined, r),
          };
        })
        // 成对的排前 (默认只列它们), 其余按它们自己的记录排 —— 截断时先丢与我无往来的。
        .sort((a, b) => Number(b.count > 0) - Number(a.count > 0) || (a.count ? b.lastTs - a.lastTs : b.whole.lastTs - a.whole.lastTs))
        .slice(0, SUB_MAX);
      // 群这一行的红点并上子项的: 子项看得见的也都在群窗里, 收起时群替它们说 —— 子项的数不会大过群。
      // 与我无往来的子项不按 session 段裁, 落在段外的那几句不在群窗里, 不并。
      const inGroup = new Set(all.map((m) => m.id));
      const own = book(key, undefined, undefined).heard;
      return {
        key, kind: "group", base,
        name: dir.chatName(base) || (base.startsWith("user:") ? dir.nameOf(humanOf(base)) : base.replace(/^chat:/, "").slice(0, 10)),
        label: "💬",
        ...((w) => (w ? { wx: wxMark(w, now) } : {}))(dir.weixin(base)),
        ...glanceOr(all, speakerPrefix(dir, role)), count: all.length,
        heard: mergeHeard(own, ...subs.map((s) => s.heard.filter((h) => inGroup.has(h[3])))), subs, ...withJobs(all),
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
        count: ms.length, heard: [], subs: [],
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

/** 一个窗口受不受视角的 session 段裁: 「某人的全部对话」(a:) 与工单 (j:) 不裁 —— 那是视角自己的时间分段, 与那个人 / 工单无关。 */
export const spanFor = (key: string, span: SessionSpan | undefined): SessionSpan | undefined =>
  key.startsWith("a:") || key.startsWith("j:") ? undefined : span;

/** 点开一项看到的消息 (断点与工单行另画) —— 详情区按它渲染, 这一项的未读账 (Ledger) 也按它切: 两边同一个函数,
 *  「看得见」才不会两处各算一套。span = 视角选的 session 段, 裁不裁由 spanFor 定。 */
export const windowOf = (msgs: readonly Msg[], role: string, key: string, withRole: string | undefined, span: SessionSpan | undefined): Msg[] =>
  ((sp) => convMessages(msgs, role, key, withRole).filter((m) => inSpan(sp)(m.ts)))(spanFor(key, span));

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
