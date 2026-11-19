// room 的成员列表 —— rolepage 的「成员」一栏与关系图的另一侧读同一份。
//
// room 模型里成员是账本的一行 (join op): 谁、以什么方式进来、加入序、是否 host 都是事实,
// 不再从 members.json / 名册的 base 推。这里只把 uid 对回名册, 补上「此刻在不在跑」
// 与类名 —— 纯函数, 名册 / 类表由调用方喂。
import { baseOfKey, labelFor } from "./session-label.js";
import type { WorldFactClass, WorldFactWizard } from "./world.js";
import type { RoomFact } from "./room-view.js";
import type { JoinVia } from "./room.js";

export interface RoomMemberView {
  /** wizard = 实例 uid; 人 = userid。 */
  id: string;
  kind: "wizard" | "human";
  name: string;
  label: string;
  via: JoinVia;
  /** 加入序 (room 内单调); 人是 0。 */
  ord: number;
  since: number;
  /** 此刻的 host。 */
  host: boolean;
  /** 类实例的所属类名 (名字本身已是 <类名>-<序号>); 自由 worker 没有。 */
  className?: string;
  ordinal?: number;
  alive?: boolean;
  busy?: boolean;
  /** 从别的群加入 (实例的 home base ≠ 本 room)。 */
  foreign?: boolean;
}

/** 是不是一个绑定的群 (而不是单聊 / dm / adhoc): 只有企微群有「群成员」这一说。 */
export const isGroupChat = (base: string): boolean => base.startsWith("chat:");

const order = (a: RoomMemberView, b: RoomMemberView): number =>
  Number(b.host) - Number(a.host) ||
  (a.kind === b.kind ? 0 : a.kind === "wizard" ? -1 : 1) ||
  a.ord - b.ord;

export const roomMembers = (
  room: RoomFact,
  wizards: readonly WorldFactWizard[] = [],
  classes: readonly WorldFactClass[] = [],
): RoomMemberView[] => {
  const byUid = new Map(wizards.filter((w) => w.uid).map((w) => [w.uid!, w] as const));
  return room.members
    .map((m): RoomMemberView => {
      const w = m.who.kind === "wizard" ? byUid.get(m.who.id) : undefined;
      const cls = w?.ordinal !== undefined ? classes.find((c) => c.id === (w.identity ?? w.target)) : undefined;
      return {
        id: m.who.id,
        kind: m.who.kind === "wizard" ? "wizard" : "human",
        name: m.name,
        label: labelFor(m.name),
        via: m.via,
        ord: m.ord,
        since: m.since,
        host: m.host,
        ...(cls ? { className: cls.name } : {}),
        ...(w?.ordinal !== undefined ? { ordinal: w.ordinal } : {}),
        ...(w ? { alive: w.alive, busy: w.busy } : {}),
        ...(w && isGroupChat(room.id) && baseOfKey(w.target) !== room.id ? { foreign: true } : {}),
      };
    })
    .sort(order);
};
