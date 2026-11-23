// 绑定只绑**身份** (类名), 化身按 room 解析 (人 2026-11-23: 「不同的 room 要用不同的实例」)。
//
// 早先的 bind-existing 在目录命中一个类时绑的是**锚点实例名** (OliveBrown-1), 还把那条别的
// room 的化身 join 进了新 room 当 host。onboarding 侧已改 (judgeOnboarding 绑类名 +
// applyOnboarding 按 room 解析化身), 这里负责把**已经落坏的数据**自愈掉, 幂等、可复跑:
//   ① 绑定里的实例名改回类名 (chatPolicy + wrc.channel.steward 两张表);
//   ② 任何 room 里属于**别的 room** 的类实例成员请出去, 换成本 room 的实例 (没有就领号新开);
//   ③ 其余 room 一个字节都不动 (dhtpm 群的 OliveBrown-1 原样留着)。
import { DAEMON, applyOp, leaveOps, whoKey, type RoomOp, type RoomState, type Who } from "../shared/room.js";
import { instanceName } from "./classes.js";
import { baseOfKey } from "../shared/session-label.js";
import { localManifestation } from "./steward.js";
import { identityOf, type WizardRecord, type WizardStore } from "./wizard.js";

export interface StewardRepairResult {
  /** 改写的绑定条数 (实例名 → 类名)。 */
  rebound: number;
  /** 修过的 room 数。 */
  rooms: number;
  /** 请出去的 (room, 别的 room 的实例 target)。 */
  left: Array<{ room: string; target: string }>;
  /** 补进来的 (room, 本 room 的实例 target)。 */
  joined: Array<{ room: string; target: string }>;
  /** 撞号的实例记录改了序号 (from → to)。 */
  renamed: Array<{ target: string; from: string; to: string }>;
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

/** 同一个类里**撞号**的实例记录 (每组留身份锚点那条, 其余是坏数据) —— 撞号的后果是两个
 *  不同 room 的实例同名 (人看到的就是「两边都叫 OliveBrown-1」)。 */
export const duplicateInstanceRecords = (store: WizardStore | undefined): WizardRecord[] => {
  const classes = store?.classes;
  if (!store || !classes) return [];
  const groups = new Map<string, WizardRecord[]>();
  for (const rec of store.all()) {
    if (rec.ordinal === undefined) continue;
    const id = identityOf(rec);
    if (!classes.get(id)) continue;
    const key = id + "#" + rec.ordinal;
    groups.set(key, [...(groups.get(key) ?? []), rec]);
  }
  const losers: WizardRecord[] = [];
  for (const list of groups.values()) {
    if (list.length < 2) continue;
    const sorted = list.slice().sort((a, b) =>
      Number(a.target !== identityOf(a)) - Number(b.target !== identityOf(b)) || a.bornAt - b.bornAt || (a.target < b.target ? -1 : 1));
    losers.push(...sorted.slice(1));
  }
  return losers;
};

/** 直绑 room 里「记录在、pane 没有」的管家实例 target —— boot 兜底 (人 2026-11-23 t7)。
 *  room 里已有这个实例的成员、但 hasPane=false → 收进来, 调用方补起会话。自愈只写成员, 起不了
 *  pane; 这一步管存量恢复 (频道那个 OliveBrown-2) 与今后任何 pane 丢失的漂移。
 *  幂等: hasPane 为真就不收。同一实例被多个 room 看见 (频道 + 它的帖子 room) 只收一次;
 *  帖子 room 里坐的是**频道**管家 (base 不是它) —— 那不是它的实例, 不在这里补。 */
export const unspawnedStewards = (a: {
  store: WizardStore | undefined;
  rooms: readonly string[];
  stateOf: (room: string) => RoomState | undefined;
  boundClassOf: (room: string) => string;
  hasPane: (target: string) => boolean;
}): string[] => {
  const out: string[] = [];
  const seen = new Set<string>();
  if (!a.store) return out;
  for (const room of a.rooms) {
    const classId = a.boundClassOf(room);
    if (!classId) continue;
    const s = a.stateOf(room);
    if (!s) continue;
    // 本 room 的实例必须已经在座 (成员) —— 缺成员是落定 (settle) 的事, 不在这里造记录。
    const seated = [...s.members.values()].some((m) => {
      if (m.who.kind !== "wizard") return false;
      const rec = a.store!.byUid(m.who.id);
      return !!rec && identityOf(rec) === classId && baseOfKey(rec.target) === room;
    });
    if (!seated) continue;
    // 与落定路径同一把尺子解析 (成员已在座 → localManifestation 只会原样返回它, 不写盘)。
    const local = localManifestation(a.store, room, classId);
    if (!local || seen.has(local)) continue;
    seen.add(local);
    if (!a.hasPane(local)) out.push(local);
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
  const res: StewardRepairResult = { rebound: 0, rooms: 0, left: [], joined: [], renamed: [] };
  // 撞号先改号 (记录本身留着: uid / 会话 / 房间成员都不动, 只把名字与序号纠正到下一个空号)。
  for (const rec of duplicateInstanceRecords(a.store)) {
    const id = identityOf(rec);
    const cls = a.store!.classes!.get(id);
    if (!cls) continue;
    const used = a.store!.all().filter((w) => identityOf(w) === id && w.target !== rec.target).map((w) => w.ordinal ?? 0);
    const ordinal = Math.max(cls.nextOrdinal, ...used.map((n) => n + 1));
    const to = instanceName(cls.name, ordinal);
    const from = rec.name;
    a.store!.upsert(rec.target, { name: to, ordinal });
    if (a.store!.classes!.get(id)!.nextOrdinal <= ordinal) a.store!.classes!.upsert(id, { nextOrdinal: ordinal + 1 });
    res.renamed.push({ target: rec.target, from, to });
  }
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
