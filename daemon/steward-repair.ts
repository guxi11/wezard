// 绑定只绑**身份** (类名), 化身按 room 解析 (人 2026-11-23: 「不同的 room 要用不同的实例」)。
//
// 早先的 bind-existing 在目录命中一个类时绑的是**锚点实例名** (OliveBrown-1), 还把那条别的
// room 的化身 join 进了新 room 当 host。onboarding 侧已改 (judgeOnboarding 绑类名 +
// applyOnboarding 按 room 解析化身), 这里负责把**已经落坏的数据**自愈掉, 幂等、可复跑:
//   ① 绑定里的实例名改回类名 (chatPolicy + wrc.channel.steward 两张表);
//   ② 任何 room 里属于**别的 room** 的类实例成员请出去, 换成本 room 的实例 (没有就领号新开);
//   ③ 其余 room 一个字节都不动 (dhtpm 群的 OliveBrown-1 原样留着)。
import { DAEMON, applyOp, leaveOps, whoKey, type RoomOp, type RoomState, type Who } from "../shared/room.js";
import { baseOfKey } from "../shared/session-label.js";
import { localManifestation } from "./steward.js";
import { identityOf, type WizardStore } from "./wizard.js";

export interface StewardRepairResult {
  /** 改写的绑定条数 (实例名 → 类名)。 */
  rebound: number;
  /** 修过的 room 数。 */
  rooms: number;
  /** 请出去的 (room, 别的 room 的实例 target)。 */
  left: Array<{ room: string; target: string }>;
  /** 补进来的 (room, 本 room 的实例 target)。 */
  joined: Array<{ room: string; target: string }>;
}

/** 绑定里可能出现的「实例名 → 类名」改写表: 每条带序号的记录, 它的身份是一个类。 */
export const instanceAliases = (store: WizardStore | undefined): Array<{ from: string; to: string }> => {
  const classes = store?.classes;
  if (!store || !classes) return [];
  const out: Array<{ from: string; to: string }> = [];
  const seen = new Set<string>();
  for (const rec of store.all()) {
    if (!rec.name || rec.ordinal === undefined) continue;
    const cls = classes.get(identityOf(rec));
    if (!cls || cls.name === rec.name || seen.has(rec.name)) continue;
    seen.add(rec.name);
    out.push({ from: rec.name, to: cls.name });
  }
  return out;
};

/** 这个 room 里属于**别的 room** 的类实例成员 (按身份去重: 一个类在别人的 room 里只用一条)。 */
export const foreignClassMembers = (
  store: WizardStore | undefined,
  room: string,
  s: RoomState,
): Array<{ identity: string; who: Who; target: string }> => {
  const classes = store?.classes;
  if (!store || !classes) return [];
  const out: Array<{ identity: string; who: Who; target: string }> = [];
  const seen = new Set<string>();
  for (const m of s.members.values()) {
    if (m.who.kind !== "wizard") continue;
    const rec = store.byUid(m.who.id);
    if (!rec || rec.ordinal === undefined || baseOfKey(rec.target) === room) continue;
    const identity = identityOf(rec);
    if (!classes.get(identity) || seen.has(identity)) continue;
    seen.add(identity);
    out.push({ identity, who: m.who, target: rec.target });
  }
  return out;
};

/** 跑一遍自愈 (幂等)。写回走调用方的 room write (daemon 的 hub), 本期不手改任何 JSONL。 */
export const repairStewardInstances = (a: {
  store: WizardStore | undefined;
  rooms: readonly string[];
  stateOf: (room: string) => RoomState | undefined;
  write: (room: string, ops: RoomOp[]) => void;
  /** 改写绑定 (chatPolicy + 频道表), 返回改了几条 —— 生产上是 onboarding.rewriteStewardBindings。 */
  rewriteBindings: (aliases: Array<{ from: string; to: string }>) => number;
  /** 这个 room **自己**绑的管家是哪个类 (类 id; 不是 / 没绑 = "")。只认直绑: 频道表只对频道
   *  room 自己 —— 帖子 room 的成员是频道管家 (同一个实例), 那不是错, 不许换。 */
  boundClassOf: (room: string) => string;
  now?: () => number;
}): StewardRepairResult => {
  const now = a.now ?? (() => Date.now());
  const res: StewardRepairResult = { rebound: 0, rooms: 0, left: [], joined: [] };
  const aliases = instanceAliases(a.store);
  if (aliases.length) res.rebound = a.rewriteBindings(aliases);
  for (const room of a.rooms) {
    const classId = a.boundClassOf(room);
    if (!classId) continue;
    const s0 = a.stateOf(room);
    if (!s0) continue;
    const foreign = foreignClassMembers(a.store, room, s0).filter((f) => f.identity === classId);
    if (!foreign.length) continue;
    // 连算多条 op 用副本: applyOp 就地改对象, 直接改 live state 会与调用方 write 的落账重复。
    const cur = structuredClone(s0);
    const ops: RoomOp[] = [];
    const push = (list: RoomOp[]): void => { ops.push(...list); list.forEach((o) => applyOp(cur, o)); };
    const at = now();
    for (const f of foreign) {
      const local = localManifestation(a.store, room, f.identity);
      const rec = local ? a.store?.get(local) : undefined;
      if (!local || !rec?.uid) continue;
      push(leaveOps(cur, f.who, DAEMON, at, "换成本 room 的实例"));
      res.left.push({ room, target: f.target });
      const want: Who = { kind: "wizard", id: rec.uid };
      if (!cur.members.has(whoKey(want))) {
        push([{ op: "join", at, room, who: want, ord: cur.nextOrd, via: "invite", by: DAEMON }]);
        res.joined.push({ room, target: local });
      }
    }
    if (!ops.length) continue;
    a.write(room, ops);
    res.rooms += 1;
  }
  return res;
};
