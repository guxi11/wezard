// 同一个管家类在不同 room 里要用不同的实例 (人 2026-11-23: 「不同的 room 要用不同的实例」)。
//   ① 目录命中类 → 绑**类名** (不是锚点实例名);
//   ② 落定按本 room 解析化身: 没有就领号新开, 同一个 room 不重复领号;
//   ③ 人给实例名 / 类名 → 都落类名;
//   ④ 既有错误绑定自愈幂等: 绑定改回类名, 别的 room 的实例请出去、换成本 room 的实例,
//      它自己那个 room 一个字节都不动。
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigSchema } from "../shared/config.js";
import { applyOp, DAEMON, leaveOps, roomHost, whoKey, type RoomState } from "../shared/room.js";
import { loadClassStore } from "../daemon/classes.js";
import { identityWorkspaceOf, loadWizardStore, openInstance } from "../daemon/wizard.js";
import { applyOnboarding, bindSteward, judgeOnboarding, loadOnboardingStore, rewriteStewardBindings } from "../daemon/onboarding.js";
import { repairStewardInstances, unspawnedStewards } from "../daemon/steward-repair.js";
import { baseOfKey } from "../shared/session-label.js";
import { H, room as mkRoom, uid, W } from "./room-fixture.js";

const dirOf = (tag: string): string => mkdtempSync(join(tmpdir(), "steward-inst-" + tag + "-"));
const cfgOf = (dir: string) => ConfigSchema.parse({
  bot: { botId: "b", secret: "s" }, daemon: { stateDir: join(dir, "state") }, defaultChat: "user:home",
});
const srcOf = (dir: string) => { const p = join(dir, "config.jsonc"); writeFileSync(p, "{\n  \"bot\": { \"botId\": \"b\" }\n}\n"); return p; };

// ── ①②③ 判定 + 按 room 落定 ─────────────────────────────────────────
{
  const dir = dirOf("bind");
  const cfg = cfgOf(dir);
  const src = srcOf(dir);
  const classes = loadClassStore(join(dir, "classes.json"));
  const store = loadWizardStore(join(dir, "wizards.json"), () => undefined, classes);
  const ws = join(dir, "dhtpm");
  mkdirSync(ws, { recursive: true });
  classes.create({ id: "chat:wrD", bot: "", name: "OliveBrown", role: "steward", workspace: ws, nextOrdinal: 2 });
  store.upsert("chat:wrD", { identity: "chat:wrD", ordinal: 1, name: "OliveBrown-1", kind: "steward", workspace: ws });
  const S1 = store.get("chat:wrD")!;
  const binds: string[] = [];
  const bindOn = (base: string) => (n: string): void => { binds.push(n); bindSteward(cfg, src, base, n); };
  const wsOf = (t: string): string => identityWorkspaceOf(store, t);

  // ① 目录命中类: 绑类名, 不绑锚点实例名 (锚点在 dhtpm 群)。
  const v = judgeOnboarding(store, "chat:wrNEW", { kind: "workspace", path: ws });
  assert.deepEqual(v, { kind: "bind-existing", name: "OliveBrown", target: "chat:wrD", identity: "chat:wrD", classId: "chat:wrD" },
    "目录命中类 → 绑类名 (不是 OliveBrown-1)");

  // ② 落定: 本 room 的实例 = 新领号的 OliveBrown-2.
  const onb = loadOnboardingStore(cfg);
  onb.begin("chat:wrNEW");
  const b1 = applyOnboarding(store, onb, "chat:wrNEW", v, bindOn("chat:wrNEW"), wsOf);
  assert.equal(b1.name, "OliveBrown", "绑定写类名");
  assert.equal(b1.instance, "OliveBrown-2");
  assert.equal(b1.target, "chat:wrNEW#OliveBrown-2");
  assert.equal(b1.classId, "chat:wrD");
  assert.equal(b1.fresh, false);
  assert.equal(b1.workspace, ws, "工作区跟类走");
  const r2rec = store.get("chat:wrNEW#OliveBrown-2")!;
  assert.equal(r2rec.identity, "chat:wrD", "实例的身份 = 类 id");
  assert.equal(r2rec.ordinal, 2);
  assert.equal(cfg.chatPolicy?.["chat:wrNEW"]?.steward, "OliveBrown");
  assert.equal(store.get("chat:wrD")!.name, "OliveBrown-1", "锚点实例原样不动");
  assert.deepEqual(binds, ["OliveBrown"]);

  // 第二个 room 同一个类 → 再领一个号, 不重用本 room 已有的。
  const v2 = judgeOnboarding(store, "chat:wrNEW2", { kind: "workspace", path: ws });
  const b2 = applyOnboarding(store, loadOnboardingStore(cfg), "chat:wrNEW2", v2, bindOn("chat:wrNEW2"), wsOf);
  assert.equal(b2.instance, "OliveBrown-3", "不同 room 不同实例");
  assert.notEqual(b2.target, b1.target);
  // 同一个 room 再落一次: 复用它, 不领新号。
  const b1again = applyOnboarding(store, loadOnboardingStore(cfg), "chat:wrNEW", v, bindOn("chat:wrNEW"), wsOf);
  assert.equal(b1again.instance, "OliveBrown-2", "本 room 已有实例 → 复用 (幂等)");
  assert.equal(classes.get("chat:wrD")!.nextOrdinal, 4, "只领了 2 / 3 两个号");

  // ③ 人给实例名 / 类名 → 都落类名。
  const byInstance = judgeOnboarding(store, "chat:wrN3", { kind: "names", names: ["OliveBrown-1"] });
  assert.equal(byInstance.kind, "bind-existing");
  assert.equal((byInstance as { name: string }).name, "OliveBrown", "实例名 → 类名");
  assert.equal((byInstance as { classId?: string }).classId, "chat:wrD");
  const byClass = judgeOnboarding(store, "chat:wrN4", { kind: "names", names: ["OliveBrown"] });
  assert.equal((byClass as { name: string }).name, "OliveBrown", "类名 → 类名");
  assert.equal((byClass as { classId?: string }).classId, "chat:wrD");

  // 存量类的 nextOrdinal 落后于已用序号 (现场就是 1): 领号必须跳过, 否则又造一个同名实例。
  const wsZ = join(dir, "zedws");
  mkdirSync(wsZ, { recursive: true });
  classes.create({ id: "chat:wrZ", bot: "", name: "Zed", role: "steward", workspace: wsZ, nextOrdinal: 1 });
  store.upsert("chat:wrZ", { identity: "chat:wrZ", ordinal: 1, name: "Zed-1", kind: "steward", workspace: wsZ });
  const zt = openInstance(store, "chat:wrNEWZ", "chat:wrZ")!;
  assert.equal(store.get(zt)!.name, "Zed-2", "跳过已用序号 (不发第二个 Zed-1)");
  assert.equal(store.get(zt)!.ordinal, 2);
  assert.equal(classes.get("chat:wrZ")!.nextOrdinal, 3);
}

// ── ④ 既有错误绑定的自愈 (幂等) ─────────────────────────────────────
{
  const dir = dirOf("repair");
  const cfg = cfgOf(dir);
  const src = srcOf(dir);
  const classes = loadClassStore(join(dir, "classes.json"));
  const store = loadWizardStore(join(dir, "wizards.json"), () => undefined, classes);
  const ws = join(dir, "dhtpm");
  mkdirSync(ws, { recursive: true });
  classes.create({ id: "chat:wrD", bot: "", name: "OliveBrown", role: "steward", workspace: ws, nextOrdinal: 2 });
  store.upsert("chat:wrD", { identity: "chat:wrD", ordinal: 1, name: "OliveBrown-1", kind: "steward", workspace: ws });
  const S1 = W(store.get("chat:wrD")!.uid!);
  const M = W(uid(9));
  cfg.wrc.channel.steward = { wrCH: "OliveBrown-1" };   // 现场那种错绑定 (频道表 + 实例名)

  // 撞号的坏数据: 另一个 room 里有条 ordinal 也是 1 的实例 (现场就是这么来的)。
  store.upsert("chat:wrDUP#OliveBrown-1", { identity: "chat:wrD", ordinal: 1, name: "OliveBrown-1", kind: "steward", workspace: ws });
  const DUP = W(store.get("chat:wrDUP#OliveBrown-1")!.uid!);

  const dhtpm: RoomState = mkRoom("chat:wrD", [S1]);
  const ch: RoomState = mkRoom("chat:wrCH", [S1]);
  applyOp(ch, { op: "join", at: 2_000, room: ch.id, who: M, ord: ch.nextOrd, via: "invite", by: DAEMON, role: "monitor" });
  // 帖子的 room: 老口径把频道 room 的实例坐进来 (同一个实例) —— 现在这也是绑错 (人 2026-11-23:
  // 不同的 room 要用不同的实例), 帖子的 room 也要换成本 room 自己的实例。
  const post: RoomState = mkRoom("chat:opkCH", [S1]);
  const rooms = new Map<string, RoomState>([["chat:wrD", dhtpm], ["chat:wrCH", ch], ["chat:opkCH", post]]);
  const writes: Array<{ room: string; ops: unknown[] }> = [];
  const run = () => repairStewardInstances({
    store, rooms: [...rooms.keys()], stateOf: (room) => rooms.get(room),
    write: (room, ops) => { writes.push({ room, ops }); for (const o of ops) applyOp(rooms.get(room)!, o); },
    rewriteBindings: (aliases) => rewriteStewardBindings(cfg, src, aliases),
    // 直绑按频道表 / chatPolicy; 帖子 room 按它所属的频道 (生产上走 channel-posts 的映射)。
    boundClassOf: (room) => {
      const bare = room === "chat:opkCH" ? "wrCH" : room.startsWith("chat:") ? room.slice(5) : "";
      const name = cfg.wrc.channel.steward?.[bare] ?? cfg.chatPolicy?.[room]?.steward ?? "";
      return name ? (classes.byName(name)?.id ?? "") : "";
    },
    now: () => 5_000,
  });

  const r1 = run();
  assert.deepEqual(r1.renamed.map((x) => x.to), ["OliveBrown-2"], "撞号的实例记录先改号 (不再有两条 OliveBrown-1)");
  assert.equal(store.get("chat:wrDUP#OliveBrown-1")!.name, "OliveBrown-2");
  assert.equal(store.get("chat:wrDUP#OliveBrown-1")!.ordinal, 2);
  assert.equal(r1.rebound, 1, "绑定里的实例名改回类名");
  assert.equal(cfg.wrc.channel.steward.wrCH, "OliveBrown");
  assert.equal(r1.rooms, 2, "频道 room 与帖子的 room 都修");
  assert.deepEqual(r1.left, [{ room: "chat:wrCH", target: "chat:wrD" }, { room: "chat:opkCH", target: "chat:wrD" }],
    "把 dhtpm 的实例从频道 room 和帖子的 room 里都请出去");
  assert.equal(r1.joined.length, 2, "两个 room 各领一个本 room 的实例");
  const localTarget = r1.joined[0]!.target;
  assert.equal(localTarget, "chat:wrCH#OliveBrown-3", "建频道 room 的实例 (撞号那条占了 2)");
  const postTarget = r1.joined[1]!.target;
  assert.equal(postTarget, "chat:opkCH#OliveBrown-4", "帖子的 room 也另开一个 (不是频道 room 那个)");
  const local = W(store.get(localTarget)!.uid!);
  assert.equal(store.get(localTarget)!.identity, "chat:wrD");
  assert.equal(ch.members.has(whoKey(S1)), false, "频道 room 里没有 OliveBrown-1");
  assert.equal(ch.members.has(whoKey(local)), true);
  assert.deepEqual(roomHost(ch), local, "本 room 的实例当 host (monitor 不抢)");
  assert.deepEqual(writes.map((w) => w.room), ["chat:wrCH", "chat:opkCH"]);
  // dhtpm 群原样不动; 帖子的 room 换成本 room 那个实例当 host。
  assert.deepEqual([...dhtpm.members.keys()], [whoKey(S1)]);
  assert.deepEqual(roomHost(dhtpm), S1);
  const postLocal = W(store.get(postTarget)!.uid!);
  assert.equal(post.members.has(whoKey(S1)), false, "帖子的 room 里不再坐频道那个实例");
  assert.deepEqual(roomHost(post), postLocal, "帖子的 room 自己的实例当 host");

  // 幂等: 第二遍无操作 (不领新号、不写 room、不再改绑定)。
  const before = writes.length;
  const r2 = run();
  assert.equal(r2.rebound, 0);
  assert.equal(r2.rooms, 0);
  assert.deepEqual(r2.left, []);
  assert.equal(writes.length, before, "第二遍零写入");
  assert.equal(classes.get("chat:wrD")!.nextOrdinal, 5, "没有多领号");
  assert.equal(dhtpm.members.has(whoKey(S1)), true);
}

// ── ⑤ 有记录没 pane 的管家实例: boot 兜底只收「记录在、pane 没有」的那个 ─────
{
  const dir = dirOf("spawn");
  const classes = loadClassStore(join(dir, "classes.json"));
  const store = loadWizardStore(join(dir, "wizards.json"), () => undefined, classes);
  const ws = join(dir, "dhtpm");
  mkdirSync(ws, { recursive: true });
  classes.create({ id: "chat:wrD", bot: "", name: "OliveBrown", role: "steward", workspace: ws, nextOrdinal: 2 });
  store.upsert("chat:wrD", { identity: "chat:wrD", ordinal: 1, name: "OliveBrown-1", kind: "steward", workspace: ws });
  const CH = "chat:wrCH";
  const chTarget = openInstance(store, CH, "chat:wrD")!;
  const chWho = W(store.get(chTarget)!.uid!);
  const dhtpmWho = W(store.get("chat:wrD")!.uid!);
  const ch = mkRoom(CH, [chWho]);
  const dhtpm = mkRoom("chat:wrD", [dhtpmWho]);
  // 帖子的 room: 里面坐的是频道那个实例 (base 不是它) —— 那不是本 room 的实例, 这里既不算「已坐」
  // 也不在 boot 兜底里造记录 (等第一次唤醒冷启动); 这里只验证去重。
  const post = mkRoom("chat:opkCH", [chWho]);
  const rooms = new Map<string, RoomState>([[CH, ch], ["chat:wrD", dhtpm], ["chat:opkCH", post]]);
  const collect = (panes: Set<string>): string[] => unspawnedStewards({
    store, rooms: [...rooms.keys()], stateOf: (room) => rooms.get(room),
    boundClassOf: () => "chat:wrD",                 // 故意连帖子 room 也给类, 测「不重复收集」
    hasPane: (t) => panes.has(t),
  });
  // dhtpm 的 OliveBrown-1 有 pane → 不收; 频道那个没 pane → 收; 帖子 room 去重。
  assert.deepEqual(collect(new Set(["chat:wrD"])), [chTarget], "只收本 room 那个没 pane 的实例");
  assert.deepEqual(collect(new Set([chTarget, "chat:wrD"])), [], "有 pane 就不再收 (幂等)");
  assert.equal(store.all().filter((w) => baseOfKey(w.target) === "chat:opkCH").length, 0, "boot 兜底不替帖子的 room 造记录");
}

console.log("steward-instance ok");
