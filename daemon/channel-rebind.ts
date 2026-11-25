// 频道换绑到一个工作区 (人 2026-11-23: 「绑定工作区为 cc-wecom」)。
//
// 频道 = 一条 (steward, workspace) 的类绑定 (wrc.channel.steward.<topic> 存**类名**)。
// 「换绑到目录 D」= 找到 / 新建 D 的管家类 → 写频道表 → 频道 room 与它每个帖子 room 里坐上
// **新类在本 room 的实例**。换绑之后这个频道的管家身份就是 D 的那个类: 各 room 的旧管家不再是
// 本 room 的 host (手闸 / 宪章随之不再算它), 但它**不离开 room** —— 它手上可能还有没交代的件,
// leave 会把它们全部 canceled (那是人的提问, 见 leaveOps)。
//
// host = 加入序最小的 wizard 成员 (shared/room.ts hostOf)。新实例要当 host 只能坐最前面:
// 它的 ord 取 1 (空着就用 1), 不抢任何人的号、不动任何人的成员记录。
//
// 幂等: 已经绑这个类 = 只补座位; 本 room 已有这个类的实例 = 一个字节都不写。
import type { Config } from "../shared/config.js";
import { DAEMON, applyOp, roomHost, sameWho, whoKey, type RoomOp, type RoomState } from "../shared/room.js";
import { baseOfKey } from "../shared/session-label.js";
import { channelOf, postsOfChannel } from "./channel-posts.js";
import { instanceName, normPath, validClassName } from "./classes.js";
import { bindChannelSteward, validateWorkspace } from "./onboarding.js";
import { anchorOf, identityOf, type WizardStore } from "./wizard.js";
import { appointedSteward, localManifestation, stewardIdentityOf } from "./steward.js";

export interface ChannelRebindArgs {
  cfg: Config;
  /** config.jsonc —— 频道表要热写回文件 (patchJsonc)。 */
  sourcePath: string;
  store: WizardStore;
  stateOf: (room: string) => RoomState | undefined;
  write: (room: string, ops: RoomOp[]) => void;
  /** 裸 topic_id (频道 id, 不是帖子 opk… 群 id)。 */
  topicId: string;
  workspace: string;
  /** 新类的名字; 缺省 = 目录已有类就复用它, 没有就自动中性名。 */
  name?: string;
  now?: () => number;
}

export interface ChannelRebindSeat {
  room: string;
  /** 本 room 的实例 target (空 = 没落成 / 没有账本)。 */
  seat: string;
  /** 换绑之后本 room 的 host (wizard uid; 空 = 没有 wizard 成员)。 */
  host: string;
  /** 没换 / 没换成的理由。 */
  note?: string;
}

export interface ChannelRebindResult {
  ok: boolean;
  reason?: string;
  topicId: string;
  className: string;
  classId: string;
  /** 这次新建了类 (false = 复用 / 只是补座位)。 */
  createdClass: boolean;
  rooms: ChannelRebindSeat[];
}

/** 把一个频道绑到 `workspace` 的管家类, 并让每个 room 的 host 换成本 room 的新实例。 */
export const rebindChannel = (a: ChannelRebindArgs): ChannelRebindResult => {
  const now = a.now ?? (() => Date.now());
  const topicId = (a.topicId ?? "").trim();
  const base = "chat:" + topicId;
  const fail = (reason: string): ChannelRebindResult => ({
    ok: false, reason, topicId, className: "", classId: "", createdClass: false, rooms: [],
  });
  if (!topicId) return fail("topicId 必填 (裸频道 id)");
  if (!channelOf(a.cfg, base)) return fail("不是已认出的频道: " + topicId);
  const v = validateWorkspace(a.workspace ?? "");
  if (!v.ok) return fail("目录不行: " + v.reason);
  const want = normPath(v.abs);
  const classes = a.store.classes;
  if (!classes) return fail("类表不可用");

  const wantName = (a.name ?? "").trim();
  const named = wantName ? classes.byName(wantName) : undefined;
  if (named) {
    if (named.role !== "steward") return fail("." + named.name + " 不是管家类");
    if (named.workspace !== want) {
      return fail("类 " + named.name + " 的工作区是 " + (named.workspace || "(空)") + " —— 换目录要另起一个类 (不给 name 即自动)");
    }
  }
  let cls = named ?? classes.byKey("steward", want);
  let createdClass = false;
  if (!cls) {
    // 新建: 锚点 target 必须是空闲的 —— 它在频道 room 的默认会话位置上, 顶掉别人的记录 = 顶掉别人的会话。
    const at = a.store.get(base);
    if (at && identityOf(at) !== base) {
      return fail("锚点 " + base + " 上已经有别的身份的记录 (" + (at.name || identityOf(at)) + ")");
    }
    const clsName = wantName || a.store.nextName();
    if (!validClassName(clsName)) return fail("类名不合法: " + clsName);
    // 人物的设定 (职责 / 专长) 跟人走, 不跟目录走 —— 从旧绑定的锚点抄一份。
    const prev = stewardIdentityOf(a.cfg, a.store, base);
    const prevAnchor = prev ? anchorOf(a.store, prev) : undefined;
    cls = classes.create({
      id: base, name: clsName, role: "steward", workspace: want,
      description: prevAnchor?.description ?? "",
      ...(prevAnchor?.expertise !== undefined ? { expertise: prevAnchor.expertise } : {}),
    });
    a.store.upsert(base, {
      kind: "steward", workspace: want, identity: cls.id, ordinal: 1, name: instanceName(cls.name, 1),
    });
    createdClass = true;
  }

  // 频道表 + 帖子级的旧绑定 (同频道只留一条绑定)。
  const posts = postsOfChannel(a.cfg, topicId);
  const rooms = [base, ...posts];
  if (((a.cfg.wrc.channel.steward ?? {})[topicId] ?? "") !== cls.name) {
    bindChannelSteward(a.cfg, a.sourcePath, topicId, cls.name, rooms.filter((b) => !!appointedSteward(a.cfg, b)));
  }

  const seats: ChannelRebindSeat[] = [];
  for (const room of rooms) {
    const s = a.stateOf(room);
    if (!s) { seats.push({ room, seat: "", host: "", note: "没有 room 账本" }); continue; }
    const seat = localManifestation(a.store, room, cls.id);
    const rec = seat ? a.store.get(seat) : undefined;
    if (!seat || !rec?.uid) { seats.push({ room, seat: "", host: "", note: "新实例没落成" }); continue; }
    const who = { kind: "wizard" as const, id: rec.uid };
    const host0 = roomHost(s);
    if (s.members.has(whoKey(who))) {
      seats.push({
        room, seat, host: host0?.id ?? "",
        ...(sameWho(host0, who) ? {} : { note: "这个实例已在座, 但不是 host (座位没动)" }),
      });
      continue;
    }
    // 坐到最前面: 1 号空着就用 1 号, 否则取现有最小 ord 再往前一格。
    const used = new Set([...s.members.values()].map((m) => m.ord));
    let ord = 1;
    while (used.has(ord)) ord -= 1;
    const cur = structuredClone(s);
    const ops: RoomOp[] = [{ op: "join", at: now(), room, who, ord, via: "invite", by: DAEMON }];
    ops.forEach((o) => applyOp(cur, o));
    a.write(room, ops);
    seats.push({ room, seat, host: roomHost(cur)?.id ?? "" });
  }
  return { ok: true, topicId, className: cls.name, classId: cls.id, createdClass, rooms: seats };
};
