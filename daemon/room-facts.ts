// room 账本 → WorldFacts.rooms 的组装 —— daemon 侧唯一把 room 状态喂给 rolepage 的地方。
//
// 纯读: 每个 room 一个文件, 坏文件 (RoomBroken) 跳过并留一行日志 —— 一个坏账本不该让整张
// 关系图消失。名字在 daemon 侧现查 (wizards.json 的 uid → 名字), 独立 svr 用的是随快照带
// 过来的那一份 (见 shared/world.ts 的 names / rooms)。
import { uidOf, type RenderNames, type Who } from "../shared/room.js";
import { buildRoomFacts, type RoomFact } from "../shared/room-view.js";
import type { RoomStore } from "./rooms.js";

export interface WizardLike { target: string; name: string; uid?: string; bornAt?: number }

export interface RoomFactsOpts {
  /** 绑定 room 的显示名 (聊天名)。 */
  chatName?: (base: string) => string;
  /** 人的显示名 (缺省 userid)。 */
  humanName?: (id: string) => string;
  /** 坏账本的行 —— 调用方接日志。 */
  onBroken?: (room: string, err: unknown) => void;
}

/** WorldFacts.names: who.id → 名字 (wizard 是 uid, 人是 userid)。 */
export const nameTable = (wizards: readonly WizardLike[], opts: Pick<RoomFactsOpts, "humanName"> = {}): Record<string, string> =>
  Object.fromEntries(wizards.filter((w) => w.uid || w.target).map((w) => [uidOf(w), w.name] as const));

const namesFor = (wizards: readonly WizardLike[], opts: RoomFactsOpts): RenderNames => {
  const byUid = new Map(wizards.map((w) => [uidOf(w), w.name] as const));
  const labelOf = new Map<string, string>();
  return {
    nameOf: (w: Who) =>
      w.kind === "wizard" ? byUid.get(w.id) ?? w.id
      : w.kind === "human" ? opts.humanName?.(w.id) ?? w.id
      : "wezard",
    roomLabel: (room) => (labelOf.get(room) ?? (opts.chatName?.(room) || room)),
  };
};

/** 每个已有 room 的一条快照 (最近的在前)。坏账本跳过。 */
export const roomFacts = (store: RoomStore, wizards: readonly WizardLike[], opts: RoomFactsOpts = {}): RoomFact[] => {
  const n = namesFor(wizards, opts);
  const states = store.ids().flatMap((id) => {
    try {
      const s = store.get(id);
      return s ? [s] : [];
    } catch (err) {
      opts.onBroken?.(id, err);
      return [];
    }
  });
  return buildRoomFacts(states, n);
};
