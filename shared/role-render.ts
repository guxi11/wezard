// Rolepage 的消息片段 —— 一条消息的正文 HTML, 左右对齐与头像由客户端按视角包装
// (同一条消息, 从发话方看靠右、从收信方看靠左, 服务端不该替它决定)。
//
//   入   发话方说的那句 (userQuery), markdown 由客户端渲染
//   出   该 wizard 这一轮的回复: 复用 renderTurnGroup (文本 + 工具细节), 去掉问句 ——
//        问句已经是上面那条入消息了; 本轮用量单独走 `meta`, 客户端写在名字那一行
//   断点 视角 role 自己的 /clear /new
import { renderCutMark, renderTurnGroup, splitReminders, escHtml, fmtTs, hashStr, tagSig, turnUsageChips, type Handoff, type HandoffDeco, type TurnFragment } from "./detail-render.js";
import { isTurn, staleAt, turnDone } from "./chat-view.js";
import { isKeepaliveTurn } from "./keepalive.js";
import type { DetailRecord, MarkDetailRecord, TurnDetailRecord } from "./detail-store.js";
import type { WorldFactJob } from "./world.js";
import { channelOf, injectTurnsOf, teammateOf, unwrapMates, type Directory, type Msg } from "./role-view.js";

export interface MsgFragment {
  /** `<turnId>:in` / `<turnId>:out` / `m:<markId>`。 */
  id: string;
  turnId: string;
  dir: "in" | "out" | "mark";
  from: string;
  to: string;
  fromName: string;
  fromLabel: string;
  toName: string;
  toLabel: string;
  /** 公开频道 base; "" = 私聊。 */
  channel: string;
  ts: number;
  /** 保温 ping —— 客户端把相邻的几条折成一行, 不当气泡画。 */
  ping: boolean;
  html: string;
  /** 出消息这一轮的账 (呼吸点 + 模型 / token / 耗时) —— 写在气泡外名字那一行; 其余为 ""。 */
  meta: string;
  sig: string;
  /** 见 chat-view.staleAt; 0 = 已结束。 */
  staleAt: number;
}

// 入消息顶上的一行归因: 这句话不是人打的字时说清是谁派的。
// 没有「公开」标记 —— 公开与否是**会话窗口**这一层的事, 不是消息这一层的:
// send_peer 的 channel 就是 `isPublic ? channelOf(self) : ""` (daemon/index.ts),
// convKeyOf 又只按 channel 分窗, 于是公开的一句必在 `c:<base>` 群窗、私聊的必在
// `p:<对端>` 私窗。在群窗里标「公开」等于给每条消息盖一个恒真的章。
// 时刻不在这里 —— 它写在气泡外的 .mwho 上 (每条消息只报一次时间), 所以
// 没有归因要说时整行省掉, 免得留下一条空的内边距。
const mateChip = (mate: string | undefined): string =>
  mate === undefined ? "" : `<span class="mchip sys">agent team${mate ? ` · ${escHtml(mate)}` : ""}</span>`;

/** 工单 badge: 只写工单号, 标题与进度由客户端按此刻的账填 (账会变, 片段的 sig 不该跟着变)。 */
const jobChip = (r: TurnDetailRecord): string =>
  r.from?.kind === "peer" && r.from.job ? `<button class="mchip job" data-job="${escHtml(r.from.job)}"></button>` : "";

const inMeta = (r: TurnDetailRecord): string => {
  const bits = [
    r.origin ? `<span class="mchip graph" title="graph ${escHtml(r.origin.runId)}">🕸 轮 ${r.origin.round}/${r.origin.rounds} · 步 ${r.origin.step}/${r.origin.steps}</span>` : "",
    r.from?.kind === "task" ? `<span class="mchip task">⏰ 定时 ${escHtml(r.from.taskId ?? "")}</span>` : "",
    mateChip(teammateOf(r.userQuery)),
    jobChip(r),
  ].filter(Boolean);
  return bits.length ? `<div class="mmeta">${bits.join("")}</div>` : "";
};

// 回执的定论 —— 标在交回结论的那一方 (答话方) 那一轮的出消息上: 那条消息才是回执;
// 收回执那一方的回执轮只是读到了它, 不再挂。
const RCPT: Readonly<Record<string, string>> = {
  done: "已交", need: "反问", error: "报错", timeout: "超时", silent: "没答", dead: "失联", canceled: "撤回",
};
const turnsWhere = (records: readonly DetailRecord[], pick: (t: TurnDetailRecord) => boolean): TurnDetailRecord[] =>
  records.filter(isTurn).filter(pick).sort((a, b) => a.createdAt - b.createdAt);

/** 派活的那些句: 开一轮的问话, 加上插进别人那一轮的插话 (各自一个轮次外形, 见 injectTurnsOf)。 */
const asksWhere = (records: readonly DetailRecord[], pick: (t: TurnDetailRecord) => boolean): TurnDetailRecord[] =>
  records.filter(isTurn).flatMap((t) => [t, ...injectTurnsOf(t)]).filter(pick).sort((a, b) => a.createdAt - b.createdAt);

/** 一件活的派活那句 = 收信方接手的那一轮的入消息 (续问共用活号, 取最早那一轮)。 */
const dispatchOf = (records: readonly DetailRecord[], turn: string): TurnDetailRecord | undefined =>
  asksWhere(records, (t) => t.from?.kind === "peer" && !t.from.receipt && t.from.turn === turn && !!t.userQuery?.trim())[0];

/** 跳到派活那句要的坐标。派活那句常常不在点击处这个会话窗口里 (私聊派的活, 回执落在群里),
 *  所以带上它自己的消息 id / 时刻 / 频道 / 两端 —— 会话键随视角而变, 由客户端算 (片段与视角无关)。 */
const gotoAttrs = (turn: string, d: TurnDetailRecord): string =>
  ` data-goto="${escHtml(turn)}" data-gid="${escHtml(d.id)}:in" data-gts="${d.createdAt}" data-gch="${escHtml(channelOf(d))}"` +
  ` data-gfrom="${escHtml(d.from?.from ?? "")}" data-gto="${escHtml(d.target ?? "")}"`;

const squash = (s: string): string => s.replace(/\s+/g, " ").trim();
/** 一轮的终句 (说不清 final 的后端退回最后一段话)。 */
const finalOf = (t: TurnDetailRecord): string => {
  const texts = t.items.filter((it): it is Extract<typeof it, { t: "text" }> => it.t === "text");
  return (texts.filter((it) => it.final).at(-1) ?? texts.at(-1))?.body ?? "";
};

/** 一份回执是答话方哪一轮交回来的。回执轮的那句话就是答话方那一轮的终句原样贴进来 ——
 *  按正文认: 链式续回时终句在它后来的回执轮里, 活号对不上。认不出 (超时 / 失联这类合成的
 *  定论没有正文) 就退回它接手这件活的最后一轮。 */
const answerOf = (rc: TurnDetailRecord, records: readonly DetailRecord[]): TurnDetailRecord | undefined => {
  const f = rc.from;
  if (f?.kind !== "peer" || !f.receipt || !f.from) return undefined;
  const d = f.turn ? dispatchOf(records, f.turn) : undefined;
  const mine = turnsWhere(records, (t) => t.target === f.from && !t.agent && t.createdAt <= rc.createdAt && t.createdAt >= (d?.createdAt ?? 0));
  const said = squash(rc.userQuery ?? "");
  const byText = mine.filter((t) => ((p) => p.length >= 4 && said.includes(p))(squash(finalOf(t)).slice(0, 60))).at(-1);
  return byText ?? mine.filter((t) => t.from?.kind === "peer" && !t.from.receipt && t.from.turn === f.turn).at(-1);
};

/** 答话方的轮次 id → 交回它的那份回执 (同一轮被认领多次取最新)。按 records 快照记一次: 每条出消息都要查。 */
const RECEIPTS = new WeakMap<readonly DetailRecord[], Map<string, TurnDetailRecord>>();
const receiptsByAnswer = (records: readonly DetailRecord[]): Map<string, TurnDetailRecord> => {
  const hit = RECEIPTS.get(records);
  if (hit) return hit;
  const m = turnsWhere(records, (t) => t.from?.kind === "peer" && !!t.from.receipt)
    .reduce((acc, rc) => ((a) => (a ? acc.set(a.id, rc) : acc))(answerOf(rc, records)), new Map<string, TurnDetailRecord>());
  RECEIPTS.set(records, m);
  return m;
};

/** 回执 chip: 挂在答话方交回结论的那一轮上 —— 定论 + 工单里第几份; 找得到派活那句才可点,
 *  点它跳过去 (跨会话也行)。 */
const receiptChip = (r: TurnDetailRecord, records: readonly DetailRecord[], dir: Directory): string => {
  const rc = receiptsByAnswer(records).get(r.id), f = rc?.from;
  if (!rc || f?.kind !== "peer") return "";
  const st = f.status ?? "done";
  const seq = f.job && f.total ? ` · ${escHtml(f.job)} 第 ${f.done ?? 0}/${f.total} 份` : "";
  const d = f.turn ? dispatchOf(records, f.turn) : undefined;
  const what = `.${dir.nameOf(r.target ?? "")} 把 ${f.turn ? `${f.turn} ` : ""}的结论交回给 .${dir.nameOf(rc.target ?? "")}`;
  const [tag, attrs] = f.turn && d
    ? ["button", `${gotoAttrs(f.turn, d)} title="${escHtml(`${what} · 点击跳到派活那句`)}"`]
    : ["span", ` title="${escHtml(`${what} · 派活那句已不在记录里`)}"`];
  return `<${tag} class="mchip rcpt st-${escHtml(st)}"${attrs}>↩ 回执 · ${RCPT[st] ?? escHtml(st)}${seq}</${tag}>`;
};

/** 这一行移交落成的那句。同一个活号续问多次就有多句 (每次 tell_peer 一句): 按原文认 ——
 *  落地的那句就是原文贴进去的 (外面裹着信封), 取首段比对; 认不出 (没原文) 退回最早那句。 */
const dispatchFor = (records: readonly DetailRecord[], h: Handoff & { turn: string }): TurnDetailRecord | undefined => {
  const all = asksWhere(records, (t) => t.from?.kind === "peer" && !t.from.receipt && t.from.turn === h.turn && !!t.userQuery?.trim());
  const head = squash(h.text).slice(0, 80);
  return (head.length >= 4 ? all.find((t) => squash(t.userQuery ?? "").includes(head)) : undefined) ?? all[0];
};

/** 整行点了要开的那段往来: 移交双方 (发话方 = 这一轮的 role, 收信方) 在哪个频道 —— 派活那句在就以它为准
 *  并带上落点; 还没接手就按这次调用公开与否推 (公开的落在发话方此刻的群)。会话键随视角, 由客户端算。 */
const pairAttrs = (r: TurnDetailRecord, to: string, h: Handoff, d: TurnDetailRecord | undefined): string =>
  ` data-hfrom="${escHtml(r.target ?? "")}" data-hto="${escHtml(to)}" data-hch="${escHtml(d ? channelOf(d) : h.public ? channelOf(r) : "")}"` +
  (d ? ` data-gid="${escHtml(d.id)}:in" data-gts="${d.createdAt}"` : "");

const FAIL = new Set(["timeout", "silent", "dead", "canceled"]);

/** 移交行的 rolepage 那一半: 对方是名录里的谁 (头像 + 名字), 整行点了开双方的那段往来并落到这一句,
 *  这件活此刻到了哪一步 —— 这一句之后的第一份回执就是它的定论 (need 之后续问再交, 那是下一行的),
 *  没落定就看它接手了没有。每次请求现算, 不进轮次缓存: 回执比派活那一轮晚到, 气泡的 sig 得跟着它变。 */
const handoffDeco = (r: TurnDetailRecord, records: readonly DetailRecord[], dir: Directory, now: number): HandoffDeco => {
  // 老的 clone / spawn 回包不带活号: 分身的开场白就是这件活, 从它收到的第一句 (r 的主人私聊派来的) 读回来。
  const turnOf = (h: Handoff): string | undefined => h.turn ?? ((id) => id && (h.via === "clone" || h.via === "spawn")
    ? asksWhere(records, (t) => t.target === id && t.from?.kind === "peer" && !t.from.receipt && t.from.from === r.target && t.createdAt >= r.createdAt)[0]?.from?.turn
    : undefined)(dir.resolve(h.name));
  const landed = (h: Handoff): TurnDetailRecord | undefined => ((turn) => (turn ? dispatchFor(records, { ...h, turn }) : undefined))(turnOf(h));
  return {
    who: (name) => {
      const id = dir.resolve(name);
      return id
        ? `<span class="ho-who"><span class="av">${escHtml(dir.labelOf(id))}</span><span class="nm wizard">${escHtml(dir.nameOf(id))}</span></span>`
        : `<span class="ho-nm">.${escHtml(name)}</span>`;
    },
    role: (name) => ((id) => (id ? ` data-hrole="${escHtml(id)}" title="${escHtml(`以 .${dir.nameOf(id)} 为 viewpoint 看它的往来`)}"` : ""))(dir.resolve(name)),
    plan: () => (r.target ? ` data-hplan="${escHtml(r.target)}"` : ""),
    attrs: (h) => {
      const id = dir.resolve(h.name);
      return id ? `${pairAttrs(r, id, h, landed(h))} title="${escHtml(`打开 .${dir.nameOf(r.target ?? "")} 与 .${dir.nameOf(id)} 的往来, 定位到这一句`)}"` : "";
    },
    status: (h0) => {
      const h = { ...h0, turn: turnOf(h0) };
      if (!h.turn || !h.receipt) return { key: "plain", tip: h.kind === "fyi" ? "只是知会, 不等回执" : "不等回执" };
      const d = landed(h);
      const rc = turnsWhere(records, (t) => t.from?.kind === "peer" && !!t.from.receipt && t.from.turn === h.turn && t.createdAt >= (d?.createdAt ?? 0))[0];
      if (!rc) return { key: "run", tip: d ? "在办 · 等回执" : "等它接手" };
      const st = rc.from?.status ?? "done";
      const key = st === "done" || st === "need" || st === "error" ? st : FAIL.has(st) ? "fail" : "run";
      return { key, tip: `回执 · ${RCPT[st] ?? st}` };
    },
    acct: (h) => ((d) => (d ? turnUsageChips(d, now) : ""))(((d) => d && hostOf(d, records))(landed(h))),
  };
};

/** 派活 / 续问那句带上它的活号, 回执凭它定位回来。 */
const pturnAttr = (r: TurnDetailRecord): string =>
  r.from?.kind === "peer" && r.from.turn && !r.from.receipt ? ` data-pturn="${escHtml(r.from.turn)}"` : "";

const renderIn = (r: TurnDetailRecord): string => {
  const q = splitReminders(unwrapMates(r.userQuery ?? ""));
  return tagSig(`<section class="bubble mq" data-key="${escHtml(r.id)}:in"${pturnAttr(r)}>${inMeta(r)}` +
    `<div class="md-body"></div><script type="text/plain" class="md-src">${escHtml(q.body)}</script>${q.html}</section>`);
};

/** 子 agent 的轮次内联进父轮 —— 与旧线程视图同一规则 (见 chat-view.threadEntries)。 */
const childrenOf = (records: readonly DetailRecord[], turnId: string, now: number, deco: HandoffDeco): TurnFragment[] =>
  records.filter(isTurn)
    .filter((r) => r.agent?.parentTurnId === turnId)
    .sort((a, b) => a.createdAt - b.createdAt)
    .map((c) => renderTurnGroup(c, now, [], true, deco));

const base = (m: Pick<Msg, "from" | "to" | "channel">, dir: Directory) => ({
  from: m.from, to: m.to, channel: m.channel,
  fromName: dir.nameOf(m.from), fromLabel: dir.labelOf(m.from),
  toName: dir.nameOf(m.to), toLabel: dir.labelOf(m.to),
});

/** `who` 在 `ts` 这一刻正跑着的主会话轮次 —— 它这一刻说出去的话 (派活、插话、notify) 都记在这一轮的账上。 */
const turnAt = (records: readonly DetailRecord[], who: string, ts: number): TurnDetailRecord | undefined =>
  records.filter(isTurn)
    .filter((t) => t.target === who && !t.agent && t.createdAt <= ts)
    .reduce<TurnDetailRecord | undefined>((best, t) => (!best || t.createdAt > best.createdAt ? t : best), undefined);

/** 插话的轮次外形 (id `<轮>~<序号>`) 没有自己的账: 它落进的那一轮才是。 */
const hostOf = (t: TurnDetailRecord, records: readonly DetailRecord[]): TurnDetailRecord | undefined =>
  t.id.includes("~") ? records.filter(isTurn).find((x) => x.id === t.id.slice(0, t.id.indexOf("~"))) : t;

/** 同伴派来的那句是发话方某一轮里说出去的: 它的账 (模型 / ctx / 耗时) 就是这条入消息的描述 ——
 *  与答话那一侧同一份 chips, 两方会话里同样只藏模型 / ctx。人说的、定时任务放的没有自己的账。 */
const senderTurn = (r: TurnDetailRecord, records: readonly DetailRecord[]): TurnDetailRecord | undefined =>
  r.from?.kind === "peer" && r.from.from ? turnAt(records, r.from.from, r.createdAt) : undefined;

/** notify 贴的那段话装在一个零时长的轮次外形里 (见 messageOfPost): 账记在发话 wizard 贴它时跑着的那一轮。 */
const POSTS = new WeakMap<readonly DetailRecord[], Set<string>>();
const isPostTurn = (r: TurnDetailRecord, records: readonly DetailRecord[]): boolean =>
  (POSTS.get(records) ?? ((s) => (POSTS.set(records, s), s))(new Set(records.filter((x) => x.kind === "post").map((x) => x.id)))).has(r.id);

/** 片段里读了 `r` 这一轮的账或结论的**别的**记录 —— `r` 变了它们得跟着重推:
 *  记在 `r` 账上的入消息 / notify, `r` 接手 (或回执) 的那件活所在的移交行, 回执认领的答话轮。 */
export const dependentsOf = (r: TurnDetailRecord, records: readonly DetailRecord[]): string[] => {
  // 先按「r 之后、r 的主人说的」收窄, 再逐条认账 —— 每个脏轮都要算一遍, 不能对全表两两比。
  const mine = (at: number): boolean => at >= r.createdAt && turnAt(records, r.target ?? "", at)?.id === r.id;
  const said = records.filter((x) =>
    x.kind === "post" ? x.target === r.target && mine(x.createdAt)
      : isTurn(x) && (x.from?.kind === "peer" && x.from.from === r.target && mine(x.createdAt) ||
        // 插话那句的入消息渲染在它落进的那一轮里, 重推的是那一轮
        (x.injects ?? []).some((i) => i.from?.kind === "peer" && i.from.from === r.target && mine(i.ts))));
  const f = r.from?.kind === "peer" ? r.from : undefined;
  const owner = f?.turn ? (f.receipt ? r.target : f.from) : undefined;
  const handed = owner ? records.filter(isTurn).filter((t) => t.target === owner && t.items.some((it) => it.t === "tool_result" && it.body.includes(f!.turn!))) : [];
  const answered = f?.receipt ? [answerOf(r, records)].filter((t): t is TurnDetailRecord => !!t) : [];
  return [...new Set([...said, ...handed, ...answered].map((x) => x.id))].filter((id) => id !== r.id);
};

export const renderMsg = (m: Msg, records: readonly DetailRecord[], dir: Directory, now: number): MsgFragment => {
  const r = m.turn;
  const acct = (t: TurnDetailRecord | undefined) => (t ? turnUsageChips(t, now) : "");
  const out = (g: TurnFragment) => ({
    html: g.html,
    meta: receiptChip(r, records, dir) + jobChip(r) + (isPostTurn(r, records) ? acct(turnAt(records, r.target ?? "", r.createdAt)) : g.meta),
  });
  const { html, meta } = m.dir === "in"
    ? { html: renderIn(r), meta: acct(senderTurn(r, records)) }
    : out(((deco) => renderTurnGroup(r, now, childrenOf(records, r.id, now, deco), false, deco))(handoffDeco(r, records, dir, now)));
  const live = m.dir === "out" && !turnDone(r, now);
  return {
    id: m.id, turnId: r.id, dir: m.dir, ...base(m, dir), ts: m.ts,
    ping: isKeepaliveTurn(r),
    html, meta, sig: hashStr(html + meta),
    staleAt: live ? staleAt(r) : 0,
  };
};

export const renderMark = (mk: MarkDetailRecord, role: string, dir: Directory): MsgFragment => {
  const f = renderCutMark(mk);
  return {
    id: `m:${mk.id}`, turnId: mk.id, dir: "mark", ...base({ from: role, to: role, channel: "" }, dir),
    ts: mk.createdAt, ping: false, html: f.html, meta: "", sig: f.sig, staleAt: 0,
  };
};

// 工单窗口的开工 / 收工两行: 不是哪一轮的消息, 是账本上的两个时刻。收工那行按成员列定论与交付物,
// 工单不再进群, 这两行就是收工结论唯一的落点; 还开着时开工那行列成员此刻的进度。
const OUTCOME: Readonly<Record<string, string>> = { ...RCPT, "": "在干" };
// 老 daemon 的快照不记成员定论: 收了工却没有定论的, 不说它「在干」。
const memberLine = (mm: WorldFactJob["members"][number], dir: Directory, closed: boolean): string =>
  `<li><span class="jo st-${escHtml(mm.outcome ?? (closed ? "none" : "run"))}">${escHtml(mm.outcome ? OUTCOME[mm.outcome] ?? mm.outcome : closed ? "—" : OUTCOME[""]!)}</span>` +
  (dir.isWizard(mm.target)
    ? `<button class="go" data-r="${escHtml(mm.target)}">${escHtml(dir.labelOf(mm.target))} .${escHtml(dir.nameOf(mm.target))}</button>`
    : `<span>${escHtml(dir.labelOf(mm.target))} ${escHtml(dir.nameOf(mm.target))}</span>`) +
  (mm.task ? `<em title="${escHtml(mm.task.trim())}">${escHtml(mm.task.trim())}</em>` : "") +
  (mm.artifacts ?? []).map((a) => `<div class="ja">↳ ${escHtml(a.path)}${a.note ? ` — ${escHtml(a.note)}` : ""}</div>`).join("") + "</li>";

export const renderJobMarks = (j: WorldFactJob, dir: Directory): MsgFragment[] => {
  const owner = { from: j.owner, to: j.owner, channel: j.base };
  const members = j.members.length ? `<ul class="jmem">${j.members.map((mm) => memberLine(mm, dir, j.status === "closed")).join("")}</ul>` : "";
  const row = (phase: "open" | "close", ts: number, body: string): MsgFragment => {
    const html = tagSig(`<div class="tg-job ${phase}" data-key="j:${escHtml(j.id)}:${phase}">${body}</div>`);
    return { id: `j:${j.id}:${phase}`, turnId: j.id, dir: "mark", ...base(owner, dir), ts, ping: false, html, meta: "", sig: hashStr(html), staleAt: 0 };
  };
  // 计划 / 结论是人写的 markdown, 换行要留着: 交给客户端同一个 markdown 渲染 (breaks:true)。
  const md = (cls: string, text?: string) =>
    text?.trim() ? `<div class="md-body ${cls}"></div><script type="text/plain" class="md-src">${escHtml(text.trim())}</script>` : "";
  const head = (verb: string) =>
    `<div class="jh">📋 <b>${escHtml(j.id)}</b> ${verb} · <span class="jt">${escHtml(j.title)}</span><span class="s">${escHtml(fmtTs(verb === "开工" ? j.openedAt : j.closedAt ?? 0))}</span></div>`;
  return [
    row("open", j.openedAt, head("开工") + md("jplan", j.plan) + (j.status === "open" ? members : "")),
    ...(j.status === "closed" && j.closedAt
      ? [row("close", j.closedAt, head("收工") + members + md("jsum", j.summary))]
      : []),
  ];
};
