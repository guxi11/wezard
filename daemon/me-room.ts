// .me 用户全局分身 (2026-11-24 人拍板):
// 每个用户一个 me wizard (注册表普通记录, kind "me", 以自己名义) + 一个私有 me-room
// (id `me:<userid>`)。用户在任何地方说 `.me …` 都路由到他自己的 me —— 行只落
// me-room, 发生地 room 零行 (不开、不唤醒 monitor/host、不耗发生地预算);
// me 的回复按发生地 frame 覆盖占位气泡回发 (正文末尾带独立对话标注); 发生地是频道 / 帖子
// (那行带 src) 就评论回原帖, 被拒回退新帖 (人 2026-11-24 拍板); 其余 (群聊 / 主动开口)
// 落用户私聊。me 不进已有 room (wiring B 的 auto-join 对 me 分流到 me-room),
// 找 host / 其他 wizard 走 chat_ask 自动落的 dm/adhoc —— 与普通 wizard 一致。
//
// id 形状: `me:` 不以 dm:/adhoc: 开头 → isBoundRoom = true —— 这是有意的:
// dutiesOpenedBy 只给绑定 room 的人话开 duty, humanCloses / host 兜底 / 唤醒
// 全套照常; 出站不因此走群镜像, roomMirror 的 me 分支接管 (本文件 meRowMirror)。
// 审批卡无需改动: me 会话 target `user:<uid>#me` 在 approval targetChatId
// 剥 #tag 后就是用户 DM chatid。
import { dirname } from "node:path";
import { DAEMON, whoKey, type Draft, type FileRef, type MsgRow, type RoomOp, type RoomState, type Verdict, type Who } from "../shared/room.js";
import { allNames, baseOfKey, keyOf, normalizeTag, tagOfKey } from "../shared/session-label.js";
import { roomBubble } from "./message-format.js";
import type { WizardStore } from "./wizard.js";

/** 保留别名: `.me` / `🧙 me` 路由到说话人自己的分身 (inbound resolve 分流)。 */
export const ME_TAG = "me";
/** me 回复的末尾固定标注: 让人一眼看出这是独立在外的 .me 对话、不进本群记录。 */
export const ME_MARK = "独立对话 · 不入本群记录";

/** userid 归一到 id 字符集 (WeCom userid 本就 [A-Za-z0-9_-], 实际恒等)。 */
const meUser = (userid: string): string => normalizeTag(userid);
export const meRoomId = (userid: string): string => "me:" + meUser(userid);
export const isMeRoom = (room: string): boolean => room.startsWith("me:");
export const meUserOf = (room: string): string => meUser(room.slice(3));
/** me 的会话 target: 用户私聊 base 上的 "me" 槽 —— 审批卡/出站剥 #tag 后即用户 DM。 */
export const meTargetOf = (userid: string): string => keyOf("user:" + meUser(userid), ME_TAG);
export const isMeTarget = (target: string): boolean => baseOfKey(target).startsWith("user:") && tagOfKey(target) === ME_TAG;

/** me 的默认工作区 (人 2026-11-24 纠正「不要这个目录, 换成用户 wezard 配置目录」): 用户的
 *  wezard 配置根 —— 就是 config 的 sourcePath 所在目录 (缺省 `~/.wezard`), 不是某条业务仓库。
 *  me 是用户自己的分身, 不属于任何项目。 */
export const meWorkspaceOf = (sourcePath: string): string => (sourcePath ? dirname(sourcePath) : "");

/** 惰性落 me wizard 记录 (首次 .me 时): 普通记录 + kind "me"、无 parent, 名字
 *  `me-<userid>` 起手 (撞名退 -N), 绝不占保留字 "me"。幂等。返回 target。
 *  `workspace` = me 的默认工作区 (meWorkspaceOf); 存量记录缺它 (旧版本没写) 就补上,
 *  已经有的不动 —— 显式给过的值优先。 */
export const ensureMeWizard = (store: WizardStore | undefined, userid: string, workspace = ""): string => {
  const target = meTargetOf(userid);
  if (!store) return target;
  const prev = store.get(target);
  if (prev) {
    if (workspace && !prev.workspace) store.upsert(target, { workspace });
    return target;
  }
  store.upsert(target, {
    kind: "me",
    identity: target,
    bornAt: Date.now(),
    parent: undefined,
    lead: undefined,
    leadOf: undefined,
    description: "用户的个人分身 (.me): 用户在任何地方说 .me 都路由到这里, 对话只进私有 me-room, 不进任何群账本; 回复发回用户说话的地方。它是普通 wizard —— 不进已有 room, 找 host / 其他 wizard 用 chat_ask 开 dm。向用户交代用 chat_reply (re 用户在 me-room 的行)。",
    ...(workspace ? { workspace } : {}),
  });
  store.claim(target, normalizeTag("me-" + meUser(userid)) || "me-proxy");
  return target;
};

export interface MeRoomDeps {
  state: (room: string) => RoomState | undefined;
  write: (room: string, ops: readonly RoomOp[]) => void;
  /** me wizard 的 uid (记录已由 ensureMeWizard 落)。 */
  meUid: () => string | undefined;
  now?: () => number;
}

/** me-room 不存在时开出来: open (kind dm, 成员对恰两人) + me (founder, host) +
 *  人 (invite —— me 反问/派活时 chat_ask 点 human:<userid> 要成员资格)。幂等。 */
export const ensureMeRoom = (d: MeRoomDeps, userid: string): string => {
  const room = meRoomId(userid);
  const s = d.state(room);
  const me: Who | undefined = (uid => uid ? { kind: "wizard", id: uid } : undefined)(d.meUid());
  const human: Who = { kind: "human", id: meUser(userid) };
  if (s && (!me || s.members.has(whoKey(me))) && s.members.has(whoKey(human))) return room;
  const at = d.now?.() ?? Date.now();
  let ord = s?.nextOrd ?? 1;
  const ops: RoomOp[] = [];
  if (!s) ops.push({ op: "open", at, room, kind: "dm", by: DAEMON });
  if (me && !(s?.members.has(whoKey(me)))) ops.push({ op: "join", at, room, who: me, ord: ord++, via: "founder", by: DAEMON });
  if (!s?.members.has(whoKey(human))) ops.push({ op: "join", at, room, who: human, ord: ord++, via: "invite", by: DAEMON });
  if (ops.length) d.write(room, ops);
  return room;
};

/** 这句里点名了 `.me` 吗 (`.me` / `🧙 me` 与 `.名字` 同一套记号)。频道 / 帖子没有
 *  「开头那个 tag 才是路由」的概念 —— 人话整段都在一处, 出现即点名。 */
export const namesMe = (text: string): boolean => allNames(text).includes(ME_TAG);

export interface MeChannelDeps {
  store: WizardStore | undefined;
  /** me 的默认工作区 (meWorkspaceOf(sourcePath))。 */
  workspace?: string;
  state: (room: string) => RoomState | undefined;
  write: (room: string, ops: readonly RoomOp[]) => void;
  append: (room: string, d: Draft) => Verdict;
  /** me 还没起会话时起一个 (与 inbound 派发同一条路: 泵贴不进没有绑定的 pane)。 */
  ensureSession?: (target: string) => void;
}

/** 频道 / 帖子人话点名 `.me` (人 2026-11-24): 没 @ 机器人也直达说话人的 me —— 行只落他的
 *  私有 me-room, **发生地零行** (host / perceptron 看不见这句, 不耗发生地预算), 与群聊里
 *  `.me` 被 resolve 分流到 me-room 是同一条规矩。返回 undefined = 这句不是点 me, 调用方照旧
 *  落发生地 room。text / files 由调用方拼好 (与发生地那一行同一口径: 图片 `@path` 随行)。 */
export const meChannelSay = (
  d: MeChannelDeps,
  e: { author: string; text: string; files?: readonly FileRef[]; src?: string; post?: string },
): Verdict | undefined => {
  if (!e.author || !namesMe(e.text)) return undefined;
  const target = ensureMeWizard(d.store, e.author, d.workspace);
  const uid = d.store?.get(target)?.uid;
  if (!uid) return undefined;
  const room = ensureMeRoom({ state: d.state, write: d.write, meUid: () => uid }, e.author);
  const v = d.append(room, {
    author: { kind: "human", id: meUser(e.author) }, kind: "say", text: e.text, origin: "inbound",
    ...(e.src ? { src: e.src } : {}), ...(e.post ? { post: e.post } : {}),
    ...(e.files?.length ? { files: [...e.files] } : {}),
  });
  if (v.ok && !v.duplicate) d.ensureSession?.(target);
  return v;
};

export interface MeMirrorDeps {
  /** wizard uid → 会话 target (气泡作者头)。 */
  authorTargetOf: (uid: string) => string | undefined;
  /** 覆盖发生地的占位气泡 (用户 .me 行的 frame)。 */
  coverBubble: (msgid: string, md: string) => Promise<boolean>;
  sendMedia: (principal: string, f: { path: string; kind: "image" | "file" | "voice" | "video"; name: string; description?: string }) => Promise<{ ok: boolean; reason?: string }>;
  /** 兜底私发 (markdown)。 */
  notify: (principal: string, md: string) => void;
  /** me-room 账本里按 id 取行 —— 用来找被答复的那句人话, 看它有没有 src (发生地)。 */
  rowById?: (room: string, id: string) => MsgRow | undefined;
  /** 那句人话发生在频道 / 帖子 (行上有 src): 答复评论回原帖 (被拒由实现回退发新帖,
   *  带引用标注), 不发私聊。false = 认不出发生地, 照旧走私聊兜底。 */
  replyToSource?: (row: MsgRow, src: MsgRow, md: string) => Promise<boolean>;
}

/** me-room 出站 (roomMirror 的 me 分支): 占位气泡覆盖 > 人话发生在频道/帖子就评论回原帖
 *  (被拒回退新帖) > 文件走用户私聊 > 正文兜底私发。正文末尾带 ME_MARK 标注。
 *  空正文无文件不出站 (与 mirrors() 同口径)。 */
export const meRowMirror = async (row: MsgRow, cover: MsgRow | undefined, d: MeMirrorDeps): Promise<boolean> => {
  const user = "user:" + meUserOf(row.room);
  const authorTarget = row.author.kind === "wizard" ? d.authorTargetOf(row.author.id) : undefined;
  const text = row.text.trim();
  const files = row.files ?? [];
  if (!text && !files.length) return false;
  const plain = text || (files.length ? "📎 " + files.map((f) => f.name).join(", ") : "");
  const md = roomBubble(authorTarget, plain + "\n\n" + ME_MARK);
  if (cover?.ext && text && await d.coverBubble(cover.ext, md)) return true;
  // 人话是在频道 / 帖子里点的名 (那行带 src): 答复评论回原帖, 被拒回退新帖 (带引用),
  // 不再发私聊 (人 2026-11-24 拍板「评论回原帖」)。私聊只留给认不出发生地的情形。
  const said = (row.re ?? []).map((id) => d.rowById?.(row.room, id)).find((r) => r?.author.kind === "human" && r.src);
  if (said && d.replyToSource && await d.replyToSource(row, said, md)) return true;
  for (const f of files) {
    const r = await d.sendMedia(user, { path: f.path, kind: f.kind, name: f.name, ...(text ? { description: row.text } : {}) });
    if (!r.ok) return false;
  }
  if (!text) return true;
  d.notify(user, md);
  return true;
};
