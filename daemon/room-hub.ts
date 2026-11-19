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
// 还开着、这一轮又没 chat_reply 过 → 当轮提醒一次; 再闲下来仍没关 → 给提问者写一条系统行。
import type { Logger } from "pino";
import { createRoomQuota } from "./room-quota.js";
import {
  DAEMON, holderOf, isBoundRoom, judge, mirrors, coversBubble, openDuties, renderMsgLine, sameWho, unreadFor, whoKey,
  type Draft, type JudgeCtx, type MsgRow, type RoomOp, type RoomState, type Verdict, type Who,
} from "../shared/room.js";
import type { RoomStore } from "./rooms.js";

export type PasteResult = "ok" | "uncertain" | "failed";

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
  /** pane 原语: 空闲判定 / 先 Esc / 粘贴一段文本。 */
  idle: (target: string) => Promise<boolean>;
  interrupt: (target: string) => Promise<void>;
  paste: (target: string, text: string) => Promise<PasteResult>;
}

/** 一轮里它被什么唤醒、交代了什么 (只在内存: 轮界由 mirror 报, reload 后从账本重算唤醒)。 */
interface TurnWake { rooms: Set<string>; msgs: Set<string>; replied: Set<string>; at: number }

export const REMIND_TEXT = (ids: readonly string[]): string =>
  "[wezard] 你这一轮被唤醒处理的 " + ids.join(", ") + " 还没交代 —— 终句不会送到任何人那里。用 chat_reply({re, text, status}) 交代; 不需要答就 chat_reply({re}) 记 passed。";

export const createRoomHub = (p: HubPorts) => {
  const now = (): number => p.now?.() ?? Date.now();
  const turns = new Map<string, TurnWake>();      // uid → 本轮
  const quota = createRoomQuota();                 // §8a 出站额度: 每轮 ≤3 / 每 room 每分钟 ≤10
  const inflight = new Set<string>();              // uid 正在被粘贴
  const uncertain = new Map<string, Set<string>>(); // uid → 上次不确定投递过的 room
  const reminded = new Set<string>();              // duty key: 已当轮提醒过
  let running: Promise<void> | undefined;
  let again = false;

  const state = (room: string): RoomState | undefined => p.store.get(room);

  /** 唯一的 append 口子。成功 → 已落盘并已触发扇出。 */
  const append = (room: string, d: Draft, extra: Partial<JudgeCtx> = {}): Verdict => {
    const s = state(room);
    if (!s) return { ok: false, status: 400, reason: "没有这个 room: " + room };
    const v = judge(s, d, {
      now: now(),
      isParent: (parent, child) => parent.kind === "wizard" && child.kind === "wizard" && p.wizardOf(child.id)?.parentUid === parent.id,
      closedDone: (msg) => closedDoneAnywhere(msg),
      ...extra,
    });
    if (!v.ok || v.duplicate) return v;
    // §8a 出站额度: wizard 经工具面写进来的行 (say / ask / task / file / 带 text 的 reply;
    // notify 落的也是 say 行) 才计 —— daemon 系统行与人话不计。被拒的行不落盘也不占额度。
    if (d.author.kind === "wizard" && d.origin === "tool" && d.kind !== "join-req" && (d.kind !== "reply" || !!(d.text ?? "").trim())) {
      const q = quota.admit(d.author.id, room, now());
      if (!q.ok) return { ok: false, status: 409, reason: q.reason! };
    }
    p.store.append(room, [v.row]);
    if (v.degraded.length) p.log?.info({ room, id: v.row.id, degraded: v.degraded }, "room: 回合预算用尽, 这几位只推游标不唤醒");
    if (d.author.kind === "wizard" && v.row.kind === "reply") markReplied(d.author.id, v.row);
    fanout(room, v.row);
    return v;
  };

  /** 非 msg 行 (join / leave / move / watch / open) 的落盘口; leave 带出的 canceled 行照常扇出。 */
  const write = (room: string, ops: readonly RoomOp[]): RoomState => {
    const s = p.store.append(room, ops);
    ops.forEach((o) => { if (o.op === "msg") fanout(room, o); });
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
        const rows = s.msgs.filter((r) => r.seq > m.seen && r.wake.includes(m.who.id));
        if (!rows.length) continue;
        const per = out.get(m.who.id) ?? new Map<string, MsgRow[]>();
        per.set(room, rows);
        out.set(m.who.id, per);
      }
    }
    return out;
  };

  /** 渲染一次唤醒: 每个 room 一段 (游标之后没看过的行, 触发行全文), 末尾列出它要交代的 duty。 */
  const render = (uid: string, rooms: Map<string, MsgRow[]>): { text: string; seen: Array<{ room: string; seq: number }>; msgs: string[] } => {
    const who: Who = { kind: "wizard", id: uid };
    const names = { nameOf: p.nameOf, roomLabel: p.roomLabel };
    const parts: string[] = [];
    const seen: Array<{ room: string; seq: number }> = [];
    const msgs: string[] = [];
    const again = uncertain.get(uid);
    for (const [room, triggers] of rooms) {
      const s = state(room)!;
      const u = unreadFor(s, who, triggers.map((t) => t.id));
      const label = p.roomLabel(room);
      const head = "【" + label + "】(" + room + ")" + (again?.has(room) ? " · 上次投递不确定, 下面可能有你已读过的" : "") + (u.more ? " · 更早还有 " + u.more + " 条没列, 用 room_read 翻" : "");
      const lines = u.rows.map((r) => renderMsgLine(r, names, triggers.some((t) => t.id === r.id) ? 100_000 : 500));
      const owe = openDuties(s).filter((d) => sameWho(holderOf(s, d), who) && triggers.some((t) => t.id === d.msg || (t.re ?? []).includes(d.msg)));
      const oweLine = owe.length ? "你要交代: " + owe.map((d) => d.msg + " (" + d.kind + ", 来自 " + p.nameOf(d.asker) + ")").join("; ") + " —— 用 chat_reply({re, text, status}) 交代。" : "";
      parts.push([head, ...lines, ...(oweLine ? [oweLine] : [])].join("\n"));
      seen.push({ room, seq: s.seq });
      msgs.push(...triggers.map((t) => t.id));
    }
    return { text: parts.join("\n\n"), seen, msgs };
  };

  const deliver = async (uid: string, rooms: Map<string, MsgRow[]>): Promise<void> => {
    const w = p.wizardOf(uid);
    if (!w) return;
    const wantsInterrupt = [...rooms.values()].some((rows) => rows.some((r) => r.interrupt));
    if (!(await p.idle(w.target))) {
      if (!wantsInterrupt) return;
      await p.interrupt(w.target); // 先 Esc 打断再投, 不拆 pane (§3b I-1); 被打断那一轮的 duty 不关
    }
    const { text, seen, msgs } = render(uid, rooms);
    const res = await p.paste(w.target, text);
    if (res === "ok") {
      for (const [room, rows] of rooms) for (const t of rows)
        p.log?.info({ room, msgId: t.id, target: w.target, lagMs: now() - t.at }, "room: delivered"); // O3: 账本行 at → 注入成功 (msgId 同上, 避开 pino 的 msg 键)
      for (const { room, seq } of seen) p.store.append(room, [{ op: "seen", at: now(), room, who: { kind: "wizard", id: uid }, seq }]);
      uncertain.delete(uid);
      const t: TurnWake = turns.get(uid) ?? { rooms: new Set(), msgs: new Set(), replied: new Set(), at: now() };
      seen.forEach(({ room }) => t.rooms.add(room));
      msgs.forEach((m) => t.msgs.add(m));
      turns.set(uid, t);
    } else if (res === "uncertain") {
      // 不推游标: 下次重投 (同一批 msg id), 标「可能已读过」。
      uncertain.set(uid, new Set(seen.map((x) => x.room)));
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

  /** mirror 报「这个 wizard 闲下来了」时调: 当轮提醒一次, 之后仍未交代就给提问者写系统行。 */
  const onIdle = async (uid: string): Promise<void> => {
    const t = turns.get(uid);
    turns.delete(uid);
    quota.endTurn(uid); // §8a: 轮终重置该 wizard 的本轮发言计数
    const who: Who = { kind: "wizard", id: uid };
    const w = p.wizardOf(uid);
    // 唤醒过它、它仍持有、未关的 duty。
    const owed: Array<{ room: string; key: string; msg: string; asker: Who }> = [];
    for (const room of p.store.ids()) {
      let s: RoomState | undefined;
      try { s = state(room); } catch { continue; }
      if (!s || !s.members.has(whoKey(who))) continue;
      for (const d of openDuties(s)) {
        if (!sameWho(holderOf(s, d), who)) continue;
        const woke = s.byId.get(d.msg)?.wake.includes(uid) || t?.msgs.has(d.msg);
        if (woke) owed.push({ room, key: d.key, msg: d.msg, asker: d.asker });
      }
    }
    const fresh = owed.filter((o) => !reminded.has(o.key) && (!t || !t.replied.has(o.msg)));
    if (fresh.length && w && t) {
      fresh.forEach((o) => reminded.add(o.key));
      const res = await p.paste(w.target, REMIND_TEXT(fresh.map((o) => o.msg)));
      if (res !== "ok") fresh.forEach((o) => reminded.delete(o.key));
      return;
    }
    // 已提醒过仍未交代 → 系统行 (账本里有即不重复)。
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

  /** 工具缺省 room: 本轮唤醒它的 room; 多个 → undefined (调用方 400 要求显式给)。 */
  const defaultRoom = (uid: string): { room?: string; many: string[] } => {
    const rooms = [...(turns.get(uid)?.rooms ?? [])];
    return rooms.length === 1 ? { room: rooms[0], many: rooms } : { many: rooms };
  };

  return { append, write, pump, kick, onIdle, defaultRoom, pending, isBoundRoom };
};

export type RoomHub = ReturnType<typeof createRoomHub>;