// rolepage 群窗的「群成员 (实例)」—— 打开一个群聊会话时, 这个群里有哪些 wizard 实例。
//
// 两个源头, 按 target 去重:
//   ① 名册: `baseOfKey(target) === 该群 base` 的 wizard 记录 —— 本群的实例
//      (管家实例, 与这个群生出来的 worker / 分身);
//   ② 严格群成员表 (daemon/members.ts): 该群的每一行 —— 行里的实例可能属于别的群,
//      那是「加入」进来的。
// 人不是 wizard 实例, 不进这张表 (会话列表的 subs 才管人)。
//
// 纯函数: 名册 / 成员行 / 类表 / 活体状态都由调用方喂进来 (daemon 有全份, 独立 svr 用
// daemon 推来的快照), 所以同一份判断在两边是一份代码。
import { baseOfKey, labelFor, tagOfKey } from "./session-label.js";
import type { RoleStatus } from "./role-view.js";
import type { WorldFactClass, WorldFactMemberRow, WorldFactWizard } from "./world.js";

export interface GroupMember {
  target: string;
  name: string;
  label: string;
  /** 类实例的所属类名 (名字本身已是 `<类名>-<序号>`); 自由 worker 没有。 */
  className?: string;
  ordinal?: number;
  /** 本群管家身份的实例 (daemon 侧 isStewardTarget)。 */
  steward: boolean;
  /** 严格群成员表的在场方式 (owner / speaker / mention); 隐式群没有这一行 = undefined。 */
  mode?: string;
  /** 从别的群加入 (target 的 base ≠ 本群)。 */
  foreign: boolean;
  status?: RoleStatus;
}

/** 是不是一个群 (而不是与人的单聊 / wizard 私聊): 只有 `chat:` 频道有群成员。 */
export const isGroupChat = (base: string): boolean => base.startsWith("chat:");

const lastSeen = (w: WorldFactWizard | undefined): number => w?.lastActivity || w?.bornAt || 0;

/** 排序: 管家先 (这一栏先回答「谁在这管」), 然后本群实例, 再按最近活动。
 *  名字兜底: 名册 > slot id > target —— 成员表行里的实例可能已不在名册 (老 daemon / 被裁)。 */
const order = (a: { m: GroupMember; at: number }, b: { m: GroupMember; at: number }): number =>
  Number(b.m.steward) - Number(a.m.steward) ||
  Number(a.m.foreign) - Number(b.m.foreign) ||
  b.at - a.at ||
  (a.m.name < b.m.name ? -1 : a.m.name > b.m.name ? 1 : 0);

export const groupMembers = (
  chat: string,
  wizards: readonly WorldFactWizard[],
  rows: readonly WorldFactMemberRow[] = [],
  classes: readonly WorldFactClass[] = [],
  statusOf: (target: string) => RoleStatus | undefined = () => undefined,
): GroupMember[] => {
  if (!isGroupChat(chat)) return [];
  const byTarget = new Map(wizards.map((w) => [w.target, w] as const));
  const joined = new Map(rows.filter((r) => r.chat === chat).map((r) => [r.target, r] as const));
  const local = wizards.filter((w) => baseOfKey(w.target) === chat).map((w) => w.target);
  return [...new Set([...local, ...joined.keys()])]
    .map((target) => {
      const w = byTarget.get(target);
      const row = joined.get(target);
      const name = (w?.name ?? "").trim() || tagOfKey(target) || target;
      const inst = w?.ordinal !== undefined;
      const cls = inst ? classes.find((c) => c.id === (w!.identity ?? target)) : undefined;
      const status = statusOf(target);
      const m: GroupMember = {
        target,
        name,
        label: labelFor(name),
        ...(cls ? { className: cls.name } : {}),
        ...(inst ? { ordinal: w!.ordinal! } : {}),
        steward: !!w?.steward,
        ...(row ? { mode: row.mode } : {}),
        foreign: baseOfKey(target) !== chat,
        ...(status ? { status } : {}),
      };
      return { m, at: lastSeen(w) };
    })
    .sort(order)
    .map(({ m }) => m);
};
