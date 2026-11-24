// room 模型的唯一 append 口子 + 唤醒泵 (契约 §2 / §3 / §3a / §3b / §5)。
//
// 人 (inbound) 与 wizard (工具) 都从 append 进: judge (ACL / status 写入权 / 覆盖 / 去重 /
// 唤醒 / 预算) → 落盘 → 扇出 (镜像进企微 + 唤醒泵)。被拒的发言不成行。
//
// 唤醒泵不持有任何队列事实: 「谁该被叫、给它看什么」每次都从账本现算 —— 某 room 里有
// wake∋uid 且 seq > 它的 seen 游标的行 = 待唤醒。投递成功才写 seen 行; 不确定就不推游标,
// 下次重投时标「可能已读过」。所以 reload / teardown 清掉内存, 未投的消息也不会丢。
//
// 终句零语义: 本文件不读 transcript。一轮结束 (mirror 报 idle) 时只看账本: 唤醒它的 duty
// 还开着、它在最近一次被唤醒之后又没 chat_reply 过 (任何 status, progress / need 也算交代)
// → 当轮提醒一次; 再闲下来仍没交代 → 给提问者写一条系统行。
// 带 Stop hook 的后端 (onStop) 把「提醒一次」提前到轮内: CLI 要结束时 hook 来问, 有欠账就
// block 让它同一轮接着交代; 轮终这条路只在 hook 没来问时兜底。
import type { Logger } from "pino";
import {
  DAEMON, afterIsFake, afterTriggerText, afterWakeDue, dutyAnswered, hasMonitor, holderOf, isBoundRoom, judge, mirrors, coversBubble, openDuties,
  renderMsgLine, replyHintDue, sameWho, unreadFor, whoKey, type Draft, type JudgeCtx, type MsgRow, type RoomOp, type RoomState, type Verdict, type Who,
  isDirectParent,
} from "../shared/room.js";
import type { WakeTail } from "./notices.js";
import type { RoomStore } from "./rooms.js";
import { sleep } from "../shared/std.js";

/** gone = 目标没有任何会话绑定 (stop_wizard end / /kill 丢掉了它): 重试也贴不进去, 要有人重生或改派。 */
export type PasteResult = "ok" | "uncertain" | "failed" | "gone";

export interface HubPorts {
  store: RoomStore;
  log?: Logger;
  now?: () => number;
  /** uid → 现在的 target 与名字 (投递 / 渲染那一刻现查)。 */
  wizardOf: (uid: string) => { target: string; name: string; parentUid?: string } | undefined;
  /** 名字渲染: wizard → .名字, 人 → userid (或人名), daemon → wezard。 */
  nameOf: (w: Who) => string;
  roomLabel: (room: string) => string;
  /** 绑定 room 的镜像出站 (§3a)。cover = 被这一行覆盖占位气泡的那条人话行。
   * 返回 true = 已成功交给传输 (O3 的 room: mirrored 以它为准)。 */
  mirror: (row: MsgRow, cover?: MsgRow) => Promise<boolean>;
  /** pane 原语: 有无活 pane / 空闲判定 / 先 Esc / 粘贴一段文本。cold 的目标不算忙 ——
   *  贴进去时 injectText 会为它重生, 所以缺省 live 视为 true 的老行为。 */
  live?: (target: string) => Promise<boolean>;
  idle: (target: string) => Promise<boolean>;
  interrupt: (target: string) => Promise<void>;
  /** `tail` = 这次唤醒要挂的提醒尾巴 (见 tailOf); pane 放行之后才由 injectText 渲染。 */
  paste: (target: string, text: string, tail?: WakeTail) => Promise<PasteResult>;
  /** 唤醒时才挂的提醒尾巴 (管家自查 / 点名提示): 按「被唤醒的 target + 触发它的行」现算, 不写进账本行。
   *  只对人话触发行挂 (见 wake-tail.ts); 没有就不挂。 */
  tailOf?: (target: string, triggers: readonly MsgRow[]) => WakeTail | undefined;
  /** 有 duty 被关账之后 (任何 status, 任何来路) —— lead 摘章等对账用; 抛错不影响 append。 */
  onClosed?: () => void;
  /** 轮终等 Stop hook 的 grace (ms, 缺省 3000; 测试给 0)。只对来问过 hook 的 wizard 生效。 */
  stopGraceMs?: number;
  /** 「你要交代」用法提示的节流窗口 (= 最近多少次唤醒批次; 0 / 缺省 = 每次都附)。热读。 */
  replyHintWindow?: () => number;
  /** 感知门控的懒建钩子 (2026-11-24): 人话 say 落绑定 room、未点名、未 @bot、本 room 还没有
   *  perceptron 时, append 在进 judge **之前**回调它 (它写 join op 使 hasMonitor 成立),
   *  judge 的 toMonitor 据此把这一行交给 perceptron。门控在 index.ts (有 wizard 成员即建,
   *  单聊 / .me / 引导中不建)。 */
  ensurePerceptron?: (room: string) => void;
}

interface AfterScan { closed?: readonly string[]; fake?: boolean; only?: readonly string[] }
export interface AfterDue { room: string; msg: string; holder: Who; asker: Who; after: string[]; at: number; fake: boolean }

/** 一轮里它被什么唤醒、交代了什么 (只在内存: 轮界由 mirror 报, reload 后从账本重算唤醒)。 */
interface Owed { room: string; key: string; msg: string; asker: Who }
interface TurnWake { rooms: Set<string>; msgs: Set<string>; replied: Set<string>; at: number }

export const REMIND_TEXT = (ids: readonly string[]): string =>
  "[wezard] 你这一轮被唤醒处理的 " + ids.join(", ") + " 还没交代 —— 终句不会送到任何人那里。用 chat_reply({re, text, status}) 交代; 不需要答就 chat_reply({re}) 记 passed。";

/** Stop hook 拦截时给模型的话 (同一轮里接着做, 不是新的一轮)。 */
export const STOP_TEXT = (ids: readonly string[]): string =>
  "[wezard] 结束这一轮之前: 唤醒你的 " + ids.join(", ") + " 还没交代 —— 终句不会送到任何人那里。现在用 chat_reply({re, text, status}) 交代 (还在做就 status:\"progress\", 要对方补信息就 \"need\"; 不需要答就 chat_reply({re}) 记 passed), 然后再结束。";

export const createRoomHub = (p: HubPorts) => {
  const now = (): number => p.now?.() ?? Date.now();
  const turns = new Map<string, TurnWake>();      // uid → 本轮
  const inflight = new Set<string>();              // uid 正在被粘贴
  const uncertain = new Map<string, Set<string>>(); // uid → 上次不确定投递过的 room
  const reminded = new Set<string>();              // duty key: 已提醒过 (轮终贴提醒 / Stop hook 拦一次)
  const stopChecked = new Map<string, number>();   // uid → 它的 Stop hook 最近一次来问的时刻
  const failedAs = new Map<string, PasteResult>(); // uid → 上次投递失败的结果 (只在状态变化时打 warn, 30s 重踢不刷屏)
  let running: Promise<void> | undefined;
  let again = false;

  const state = (room: string): RoomState | undefined => p.store.get(room);
  const closedHook = (): void => { try { p.onClosed?.(); } catch (e) { p.log?.warn({ err: (e as Error).message }, "room: onClosed 失败 (不影响 append)"); } };

  /** 唯一的 append 口子。成功 → 已落盘并已触发扇出。 */
  const append = (room: string, d: Draft, extra: Partial<JudgeCtx> = {}): Verdict => {
    const s = state(room);
    if (!s) return { ok: false, status: 400, reason: "没有这个 room: " + room };
    // perceptron 的发言权是硬的 (§2.2, 2026-11-23 人定): **一行消息都不写** —— 判决走 perceive op
    // (room_activate), 不进消息记录; 不发言、不派活、不关账。
    if (s.members.get(whoKey(d.author))?.role === "monitor")
      return { ok: false, status: 403, reason: "perceptron 不写任何消息行: 判决用 room_activate (perceive op)" };
    // 懒建 (2026-11-24): 第一条需要感知的人话先建 perceptron (join op 落在本 state 上), 再进 judge ——
    // judge 的 toMonitor 立刻看得见它。回调抛错不拦 append (建不成 = 照旧落 host)。
    if (p.ensurePerceptron && d.kind === "say" && d.author.kind === "human" && isBoundRoom(room)
      && d.mention !== "bot" && !(d.to ?? []).some((t) => t.kind === "wizard") && !hasMonitor(s)) {
      try { p.ensurePerceptron(room); } catch (e) { p.log?.warn({ room, err: String(e) }, "room: ensurePerceptron 失败 (本行照旧落 host)"); }
    }
    const v = judge(s, d, {
      now: now(),
      isParent: (parent, child) => isDirectParent((u) => p.wizardOf(u)?.parentUid, parent, child),
      closedDone: (msg) => closedDoneAnywhere(msg),
      ...extra,
    });
    if (!v.ok || v.duplicate) return v;
    p.store.append(room, [v.row]);
    if (v.degraded.length) p.log?.info({ room, id: v.row.id, degraded: v.degraded }, "room: 回合预算用尽, 这几位只推游标不唤醒");
    if (d.author.kind === "wizard" && v.row.kind === "reply") markReplied(d.author.id, v.row);
    fanout(room, v.row);
    if (v.row.closes?.length) closedHook();
    // 以 done 关账 = 可能有 after 等着它: 只重算 after 含被关消息的那些 duty (trigger 行无 closes, 不递归)。
    if (v.row.closes?.length && v.row.status === "done") reconcileAfter({ closed: v.row.re ?? [] });
    return v;
  };

  /** 非 msg 行 (join / leave / move / watch / open) 的落盘口; leave 带出的 canceled 行照常扇出。 */
  const write = (room: string, ops: readonly RoomOp[]): RoomState => {
    const s = p.store.append(room, ops);
    ops.forEach((o) => { if (o.op === "msg") fanout(room, o); });
    if (ops.some((o) => o.op === "msg" && o.closes?.length)) closedHook();
    return s;
  };

  const closedDoneAnywhere = (msg: string): boolean => {
    const room = p.store.roomOfMsg(msg);
    const s = room ? state(room) : undefined;
    if (!s) return false;
    const ds = [...s.duties.values()].filter((x) => x.msg === msg);
    return ds.length > 0 && ds.every((x) => x.closed?.status === "done");
  };

  const fanout = (room: string, row: MsgRow): void => {
    if (mirrors(row)) {
      const s = state(room)!;
      const cover = coversBubble(s, row);
      void p.mirror(row, cover ? s.byId.get(cover) : undefined)
        .then((sent) => { if (sent) p.log?.info({ room, msgId: row.id, lagMs: now() - row.at }, "room: mirrored"); }) // O3: 账本行 at → 镜像进企微成功 (字段名 msgId: pino 的 msg 键是日志文案, 再放消息 id 会撞成重复键)
        .catch((e) => p.log?.warn({ room, id: row.id, err: String(e) }, "room: 镜像失败 (只影响传输, 不回滚)"));
    }
    if (row.wake.length || row.interrupt) kick();
  };

  // ── after 补唤醒 ────────────────────────────────────────────────────

  /** 欠补唤醒的 after duty (从账本现算; 判定见 shared/room.ts afterWakeDue)。
   *  closed: 只看 after 含这些消息的 (关账时); 缺省全扫 (boot / 管理入口)。
   *  fake: 全扫时也收 after 全是假 id "undefined" 的旧受害行 —— 缺省不收, 要人确认清单后经管理入口补。
   *  only: 只补这几条 ask/task。 */
  const afterDue = (o: AfterScan = {}): AfterDue[] => {
    const out: AfterDue[] = [];
    for (const room of p.store.ids()) {
      let s: RoomState | undefined;
      try { s = state(room); } catch { continue; }
      if (!s) continue;
      for (const d of openDuties(s)) {
        if (!d.after?.length) continue;
        if (o.closed && !d.after.some((id) => o.closed!.includes(id))) continue;
        if (o.only && !o.only.includes(d.msg)) continue;
        if (!o.closed && !o.fake && afterIsFake(d.after)) continue;
        const holder = afterWakeDue(s, d, closedDoneAnywhere);
        if (holder) out.push({ room, msg: d.msg, holder, asker: d.asker, after: d.after, at: d.at, fake: afterIsFake(d.after) });
      }
    }
    return out;
  };

  /** 给每条欠账写一条 trigger 行 (to = holder, re = 原 ask): 不开新 duty, 渲染的「你要交代」经 re 指回原 ask。
   *  不占回合预算 —— 补唤醒被预算降级就等于又丢一次, 而它本该在原 ask 那一刻就花掉这一份。 */
  const reconcileAfter = (o: AfterScan & { dryRun?: boolean } = {}): { due: AfterDue[]; written: string[] } => {
    const due = afterDue(o);
    if (o.dryRun) return { due, written: [] };
    const written: string[] = [];
    for (const x of due) {
      const ask = state(x.room)?.byId.get(x.msg);
      if (!ask) continue;
      const v = append(x.room, {
        author: DAEMON, kind: "trigger", origin: "daemon", sys: "after-wake", to: [x.holder], re: [x.msg],
        text: afterTriggerText(ask, p.nameOf(x.asker)),
      }, { budget: Number.MAX_SAFE_INTEGER });
      if (v.ok) written.push(v.row.id);
      else p.log?.warn({ room: x.room, msgId: x.msg, reason: v.reason }, "room: after 补唤醒写入被拒");
    }
    if (written.length) p.log?.info({ written, msgIds: due.map((x) => x.msg) }, "room: after 前置满足, 补唤醒");
    return { due, written };
  };

  const markReplied = (uid: string, row: MsgRow): void => {
    const t = turns.get(uid);
    if (t) (row.re ?? []).forEach((id) => t.replied.add(id));
  };

  // ── 唤醒泵 ──────────────────────────────────────────────────────────

  /** 每个 wizard 待唤醒的 room 与触发行 (从账本现算)。 */
  const pending = (): Map<string, Map<string, MsgRow[]>> => {
    const out = new Map<string, Map<string, MsgRow[]>>();
    for (const room of p.store.ids()) {
      let s: RoomState | undefined;
      try { s = state(room); } catch { continue; }
      if (!s) continue;
      for (const m of s.members.values()) {
        if (m.who.kind !== "wizard") continue;
        // 触发行: 原 wake 列表 (游标之后); 或 monitor 判决 assign 在这条人话上开的账 —— 没有 trigger 行,
        // 行本身在未读里就该投; 已经读过的行 (别的唤醒把游标推过去了) 只有「判决晚于它最近一次唤醒批次」时才补投。
        const rows = s.msgs.filter((r) => {
          if (r.seq > m.seen && r.wake.includes(m.who.id)) return true;
          const d = openDuties(s).find((x) => x.msg === r.id && x.via === "assign" && sameWho(holderOf(s, x), m.who));
          return !!d && (r.seq > m.seen || d.at > (m.batches[m.batches.length - 1] ?? 0));
        });
        if (!rows.length) continue;
        const per = out.get(m.who.id) ?? new Map<string, MsgRow[]>();
        per.set(room, rows);
        out.set(m.who.id, per);
      }
    }
    return out;
  };

  /** uid 当前所在的全部 room 状态 (内存里的 fold, 只做成员判断)。 */
  const roomsOf = (uid: string): RoomState[] => {
    const k = whoKey({ kind: "wizard", id: uid });
    return p.store.ids().flatMap((id) => { try { const s = state(id); return s?.members.has(k) ? [s] : []; } catch { return []; } });
  };

  /** 渲染一次唤醒: 每个 room 一段 (游标之后没看过的行, 触发行全文), 末尾列出它要交代的 duty。 */
  const render = (uid: string, rooms: Map<string, MsgRow[]>): { text: string; seen: Array<{ room: string; seq: number }>; msgs: string[] } => {
    const who: Who = { kind: "wizard", id: uid };
    const names = { nameOf: p.nameOf, roomLabel: p.roomLabel };
    const parts: string[] = [];
    const seen: Array<{ room: string; seq: number }> = [];
    const msgs: string[] = [];
    const again = uncertain.get(uid);
    // 用法半句是教学不是事实: 它最近 N 批唤醒里自己回过 chat_reply 就不再重复 (id 与「这是你的 duty」照旧给)。
    const usage = replyHintDue(roomsOf(uid), uid, p.replyHintWindow?.() ?? 0) ? " —— 用 chat_reply({re, text, status}) 交代。" : "";
    for (const [room, triggers] of rooms) {
      const s = state(room)!;
      const u = unreadFor(s, who, triggers.map((t) => t.id));
      const label = p.roomLabel(room);
      const head = "【" + label + "】(" + room + ")" + (again?.has(room) ? " · 上次投递不确定, 下面可能有你已读过的" : "") + (u.more ? " · 更早还有 " + u.more + " 条没列, 用 room_read 翻" : "");
      const lines = u.rows.map((r) => renderMsgLine(r, names, triggers.some((t) => t.id === r.id) ? 100_000 : 500));
      const held = openDuties(s).filter((d) => sameWho(holderOf(s, d), who));
      const owe = held.filter((d) => triggers.some((t) => t.id === d.msg || (t.re ?? []).includes(d.msg)));
      // 绑定 room 里同伴说的每一行都真的进了企微 (mirrors) —— 人已经看见。它手上还欠着人的话时,
      // 这一轮多半正要向人交代: 说清这一点, 免得 host 把同伴的结论再转述一遍
      // (人报: 同一个 room 里 host 复述 member 的话)。只数本批真会出站的 reply / say ——
      // 派活的 ask、trigger 不算「同伴说了一句」。
      const seenByHuman = !isBoundRoom(room) ? [] : [...new Set(u.rows
        .filter((r) => (r.kind === "reply" || r.kind === "say") && mirrors(r))
        .map((r) => p.nameOf(r.author)))];
      const peerSeen = seenByHuman.length && held.some((d) => d.asker.kind === "human");
      const humanHint = peerSeen
        ? "人已经在群里看过上面 " + seenByHuman.join(" / ") + " 的发言 —— 向人关账只补人还不知道的 (commit / 取舍 / 下一步), 它说过的别再复述。"
        : "";
      // 它反问过人、人另发一条新话 (不带引用) 作答: 原 duty 没被本批触发行碰到, 但答复很可能就在上面 —— 附在后面提醒一并关掉 (只是提示, 不改 seen / turns)。
      const answered = held.filter((d) => !owe.includes(d) && d.last?.status === "need" && d.asker.kind === "human" && triggers.some((t) => sameWho(t.author, d.asker)));
      const oweLine = owe.length || answered.length
        ? "你要交代: " + [
          ...owe.map((d) => d.msg + " (" + d.kind + ", 来自 " + p.nameOf(d.asker) + ")"),
          ...answered.map((d) => d.msg + " (" + d.kind + ", 来自 " + p.nameOf(d.asker) + " · 你反问过, 对方的答复可能就在上面)"),
        ].join("; ") + usage : "";
      parts.push([head, ...lines, ...(humanHint ? [humanHint] : []), ...(oweLine ? [oweLine] : [])].join("\n"));
      seen.push({ room, seq: s.seq });
      msgs.push(...triggers.map((t) => t.id));
    }
    return { text: parts.join("\n\n"), seen, msgs };
  };

  const deliver = async (uid: string, rooms: Map<string, MsgRow[]>): Promise<void> => {
    const w = p.wizardOf(uid);
    if (!w) return;
    const wantsInterrupt = [...rooms.values()].some((rows) => rows.some((r) => r.interrupt));
    // 没有活 pane ≠ 忙: 那是冷会话 (reload 后没重挂 / pane 已死), 贴进去会把它重生。
    // 只有活着的 pane 才需要等它闲 (或按 interrupt 先 Esc)。
    const live = p.live ? await p.live(w.target) : true;
    if (live && !(await p.idle(w.target))) {
      if (!wantsInterrupt) return;
      await p.interrupt(w.target); // 先 Esc 打断再投, 不拆 pane (§3b I-1); 被打断那一轮的 duty 不关
    }
    const { text, seen, msgs } = render(uid, rooms);
    const res = await p.paste(w.target, text, p.tailOf?.(w.target, [...rooms.values()].flat()));
    if (res === "ok") {
      for (const [room, rows] of rooms) for (const t of rows)
        p.log?.info({ room, msgId: t.id, target: w.target, lagMs: now() - t.at }, "room: delivered"); // O3: 账本行 at → 注入成功 (msgId 同上, 避开 pino 的 msg 键)
      const batchAt = now(); // 同一批跨 room 共用一个 at: 「最近 N 批」按它去重
      for (const { room, seq } of seen) p.store.append(room, [{ op: "seen", at: batchAt, room, who: { kind: "wizard", id: uid }, seq, batch: true }]);
      uncertain.delete(uid);
      const t: TurnWake = turns.get(uid) ?? { rooms: new Set(), msgs: new Set(), replied: new Set(), at: now() };
      seen.forEach(({ room }) => t.rooms.add(room));
      msgs.forEach((m) => t.msgs.add(m));
      turns.set(uid, t);
    } else if (res === "uncertain") {
      // 不推游标: 下次重投 (同一批 msg id), 标「可能已读过」。
      uncertain.set(uid, new Set(seen.map((x) => x.room)));
    }
    if (res === "ok") failedAs.delete(uid);
    else if (res !== "uncertain" && failedAs.get(uid) !== res) {
      failedAs.set(uid, res);
      p.log?.warn({ uid, target: w.target, result: res, msgs }, "room: 唤醒投递失败, 游标不动, 30s 后重试");
    }
    if (res === "gone") reportGone(uid, rooms);
  };

  /** 目标没有会话 (被 stop_wizard 结束): 它名下被这批行唤醒的 duty 各给提问者写一条系统行 ——
   *  不然 chat_ask 只落在账本里, 提问方以为对方在做, 泵每 30s 静默重试到天荒地老。
   *  游标不推: 之后同名 spawn_wizard 重生的它照样读得到这些行。账本里有即不重复 (同 escalate)。 */
  const reportGone = (uid: string, rooms: Map<string, MsgRow[]>): void => {
    const who: Who = { kind: "wizard", id: uid };
    for (const [room, rows] of rooms) {
      const s = state(room);
      if (!s) continue;
      for (const d of openDuties(s)) {
        if (!sameWho(holderOf(s, d), who) || !rows.some((r) => r.id === d.msg || (r.re ?? []).includes(d.msg))) continue;
        if (s.msgs.some((m) => m.sys === "undelivered" && (m.re ?? []).includes(d.msg) && m.text.includes(uid))) continue;
        append(room, {
          author: DAEMON, kind: "system", origin: "daemon", sys: "undelivered", re: [d.msg],
          ...(d.asker.kind !== "daemon" ? { to: [d.asker] } : {}),
          text: "[wezard] " + p.nameOf(who) + " 没有会话 (已被结束), " + d.msg + " 投不进去 (" + uid + "): 用 spawn_wizard 同名重生它, 或改派别人",
        });
      }
    }
  };

  /** 串行泵: 跑着时再踢只记一笔「再来一轮」, 返回的是正在跑的那一轮 (调用方 await 到它跑完)。 */
  const pump = (): Promise<void> => {
    if (running) { again = true; return running; }
    running = drain().finally(() => { running = undefined; });
    return running;
  };
  const drain = async (): Promise<void> => {
    {
      do {
        again = false;
        const work = [...pending().entries()].filter(([uid]) => !inflight.has(uid));
        await Promise.all(work.map(async ([uid, rooms]) => {
          inflight.add(uid);
          try { await deliver(uid, rooms); }
          catch (e) { p.log?.warn({ uid, err: String(e) }, "room: 唤醒投递失败, 下轮重试"); }
          finally { inflight.delete(uid); }
        }));
      } while (again);
    }
  };
  const kick = (): void => { void pump(); };

  // ── 轮界 (§5, F-1) ──────────────────────────────────────────────────

  /** 唤醒过它、它仍持有、未关、且最近一次被唤醒后还没 chat_reply 过的 duty。
   *  顺手清掉已交代者的提醒记号: 之后被同一 duty 再唤醒 (need 被补答) 又没交代时重新从「提醒一次」开始。
   *  delivered: 只算已经贴进它输入框的 (Stop hook 当轮拦截不能拿它没见过的行催它)。 */
  const scanOwed = (uid: string, t: TurnWake | undefined, delivered = false): Owed[] => {
    const who: Who = { kind: "wizard", id: uid };
    const owed: Owed[] = [];
    for (const room of p.store.ids()) {
      let s: RoomState | undefined;
      try { s = state(room); } catch { continue; }
      const me = s?.members.get(whoKey(who));
      if (!s || !me) continue;
      for (const d of openDuties(s)) {
        if (!sameWho(holderOf(s, d), who)) continue;
        const row = s.byId.get(d.msg);
        // 原 ask 唤醒过它, 或 after / overdue 的 trigger 行 (re 原 ask) 唤醒过它;
        // monitor 判决 (assign) 开的账没有 trigger 行, 人话行自己就是叫醒它的那一行。
        const waker = row?.wake.includes(uid) ? row
          : s.msgs.find((r) => r.kind === "trigger" && (r.re ?? []).includes(d.msg) && r.wake.includes(uid))
          ?? (d.via === "assign" ? row : undefined);
        if (!waker && !t?.msgs.has(d.msg)) continue;
        if (delivered && (!waker || waker.seq > me.seen)) continue;
        // progress / need 交代过: duty 照常开着等 done, 但这一轮的账算清了 —— 不提醒、不告状。
        if (dutyAnswered(s, d, who)) { reminded.delete(d.key); continue; }
        owed.push({ room, key: d.key, msg: d.msg, asker: d.asker });
      }
    }
    return owed;
  };

  /** 已提醒过仍未交代 → 给提问者写系统行 (账本里有即不重复)。正文自带 [wezard], 镜像不再叠 (roomBubble)。 */
  const escalate = (uid: string, owed: readonly Owed[]): void => {
    const who: Who = { kind: "wizard", id: uid };
    for (const o of owed.filter((x) => reminded.has(x.key))) {
      const s = state(o.room)!;
      const done = s.msgs.some((m) => m.sys === "undelivered" && (m.re ?? []).includes(o.msg) && m.text.includes(uid));
      if (done) continue;
      append(o.room, {
        author: DAEMON, kind: "system", origin: "daemon", sys: "undelivered", re: [o.msg],
        ...(o.asker.kind !== "daemon" ? { to: [o.asker] } : {}),
        text: "[wezard] " + p.nameOf(who) + " 被提醒后仍没有交代 " + o.msg + " (" + uid + ")",
      });
    }
  };

  /** CLI 的 Stop hook 在它要结束这一轮时同步来问 (hooks/stop.sh → POST /room/stop-check):
   *  有没提醒过的欠账 → 返回 reason, hook 用 decision:"block" 让它同一轮接着 chat_reply (算「提醒一次」);
   *  全都提醒过仍欠着 → 放行并立刻写系统行。每条 duty 至多拦一次, 所以不会无限 block。 */
  const onStop = (uid: string): { block?: string } => {
    stopChecked.set(uid, now());
    const owed = scanOwed(uid, turns.get(uid), true);
    const fresh = owed.filter((o) => !reminded.has(o.key));
    if (fresh.length) {
      fresh.forEach((o) => reminded.add(o.key));
      return { block: STOP_TEXT(fresh.map((o) => o.msg)) };
    }
    escalate(uid, owed);
    return {};
  };

  /** mirror 报「这个 wizard 闲下来了」时调: 当轮提醒一次, 之后仍未交代就给提问者写系统行。
   *  带 Stop hook 的 pane 由 onStop 在轮内判过了 —— 这里先等一个 grace (hook 与 tail 谁先到不定),
   *  这段时间里 hook 来问过就不再插手; hook 没来 (老 pane / 不支持的后端 / hook 连不上) 才走下面的老路兜底。 */
  const onIdle = async (uid: string): Promise<void> => {
    const t = turns.get(uid);
    turns.delete(uid);
    const idleAt = now();
    const grace = p.stopGraceMs ?? 3000;
    if (stopChecked.has(uid) && grace > 0) await sleep(grace);
    if ((stopChecked.get(uid) ?? -Infinity) >= idleAt - grace) return;
    const w = p.wizardOf(uid);
    const owed = scanOwed(uid, t);
    const fresh = owed.filter((o) => !reminded.has(o.key) && (!t || !t.replied.has(o.msg)));
    if (fresh.length && w && t) {
      fresh.forEach((o) => reminded.add(o.key));
      const res = await p.paste(w.target, REMIND_TEXT(fresh.map((o) => o.msg)));
      if (res !== "ok") fresh.forEach((o) => reminded.delete(o.key));
      return;
    }
    escalate(uid, owed);
  };

  /** 工具缺省 room: 本轮唤醒它的 room; 多个 → undefined (调用方 400 要求显式给)。 */
  const defaultRoom = (uid: string): { room?: string; many: string[] } => {
    const rooms = [...(turns.get(uid)?.rooms ?? [])];
    return rooms.length === 1 ? { room: rooms[0], many: rooms } : { many: rooms };
  };

  /** 派活工具缺省的 `for` (血缘): 本轮唤醒它、且仍由它持有未关的那一条 duty 的 msg id。
   *  「唤醒」= 本轮贴进来的行里有这条 duty 的 msg, 或有一条 re 指向它的 trigger (overdue-remind / after 补唤醒);
   *  恰好一条才返回, 零条 / 多条 → undefined —— 多条有歧义, 不猜。 */
  const defaultFor = (uid: string): string | undefined => {
    const t = turns.get(uid);
    if (!t?.msgs.size) return undefined;
    const who: Who = { kind: "wizard", id: uid };
    const ids = new Set<string>();
    for (const room of t.rooms) {
      let s: RoomState | undefined;
      try { s = state(room); } catch { continue; }
      if (!s) continue;
      const woke = (msg: string): boolean => t.msgs.has(msg) || [...t.msgs].some((id) => {
        const r = s!.byId.get(id);
        return r?.kind === "trigger" && (r.re ?? []).includes(msg);
      });
      openDuties(s)
        .filter((d) => d.kind !== "join-req" && sameWho(holderOf(s!, d), who) && woke(d.msg))
        .forEach((d) => ids.add(d.msg));
    }
    return ids.size === 1 ? [...ids][0] : undefined;
  };

  /** 派活工具的 for: 显式给的那条必须仍是**开着的** duty 才算血缘 —— 关掉的 / 写错的 id 挂不上
   *  任何下游 (buildOpenChildDuties / buildDescendantActivity 都按 msg id 索引), 结果就是子件在干活、
   *  上游却在自己名下被反复催; 这种 for 当没给, 回落到 defaultFor。 */
  const resolveFor = (uid: string, explicit?: string): string | undefined => {
    const want = (explicit ?? "").toString().trim();
    if (!want) return defaultFor(uid);
    const room = p.store.roomOfMsg(want);
    const s = room ? state(room) : undefined;
    if (s && openDuties(s).some((d) => d.msg === want)) return want;
    p.log?.info({ uid, for: want }, "room: 显式 for 指向的 duty 已不在开着, 按本轮唤醒重算血缘");
    return defaultFor(uid);
  };

  return { append, write, pump, kick, onIdle, onStop, defaultRoom, defaultFor, resolveFor, pending, isBoundRoom, reconcileAfter };
};

export type RoomHub = ReturnType<typeof createRoomHub>;