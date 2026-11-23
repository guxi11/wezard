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
import { identityWorkspaceOf, loadWizardStore } from "../daemon/wizard.js";
import { applyOnboarding, bindSteward, judgeOnboarding, loadOnboardingStore, rewriteStewardBindings } from "../daemon/onboarding.js";
import { repairStewardInstances } from "../daemon/steward-repair.js";
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

  const dhtpm: RoomState = mkRoom("chat:wrD", [S1]);
  const ch: RoomState = mkRoom("chat:wrCH", [S1]);
  applyOp(ch, { op: "join", at: 2_000, room: ch.id, who: M, ord: ch.nextOrd, via: "invite", by: DAEMON, role: "monitor" });
  // 帖子的 room: 成员是**频道管家** (同一个实例), 成员关系表达归属 —— 这不是绑错, 不许换。
  const post: RoomState = mkRoom("chat:opkCH", [S1]);
  const rooms = new Map<string, RoomState>([["chat:wrD", dhtpm], ["chat:wrCH", ch], ["chat:opkCH", post]]);
  const writes: Array<{ room: string; ops: unknown[] }> = [];
  const run = () => repairStewardInstances({
    store, rooms: [...rooms.keys()], stateOf: (room) => rooms.get(room),
    write: (room, ops) => { writes.push({ room, ops }); for (const o of ops) applyOp(rooms.get(room)!, o); },
    rewriteBindings: (aliases) => rewriteStewardBindings(cfg, src, aliases),
    // 直绑: 频道表按裸 topic 只对频道 room 自己 (帖子 room 用频道管家不算错)。
    boundClassOf: (room) => {
      const bare = room.startsWith("chat:") ? room.slice(5) : "";
      const name = cfg.wrc.channel.steward?.[bare] ?? cfg.chatPolicy?.[room]?.steward ?? "";
      return name ? (classes.byName(name)?.id ?? "") : "";
    },
    now: () => 5_000,
  });

  const r1 = run();
  assert.equal(r1.rebound, 1, "绑定里的实例名改回类名");
  assert.equal(cfg.wrc.channel.steward.wrCH, "OliveBrown");
  assert.equal(r1.rooms, 1, "只修错的那个 room");
  assert.deepEqual(r1.left, [{ room: "chat:wrCH", target: "chat:wrD" }], "把 dhtpm 的实例请出去");
  assert.equal(r1.joined.length, 1);
  const localTarget = r1.joined[0]!.target;
  assert.equal(localTarget, "chat:wrCH#OliveBrown-2", "建本 room 的实例 (序号 2)");
  const local = W(store.get(localTarget)!.uid!);
  assert.equal(store.get(localTarget)!.identity, "chat:wrD");
  assert.equal(ch.members.has(whoKey(S1)), false, "频道 room 里没有 OliveBrown-1");
  assert.equal(ch.members.has(whoKey(local)), true);
  assert.deepEqual(roomHost(ch), local, "本 room 的实例当 host (monitor 不抢)");
  assert.deepEqual(writes.map((w) => w.room), ["chat:wrCH"]);
  // dhtpm 群原样不动; 帖子 room 的频道管家实例也不动。
  assert.deepEqual([...dhtpm.members.keys()], [whoKey(S1)]);
  assert.deepEqual(roomHost(dhtpm), S1);
  assert.deepEqual([...post.members.keys()], [whoKey(S1)]);

  // 幂等: 第二遍无操作 (不领新号、不写 room、不再改绑定)。
  const before = writes.length;
  const r2 = run();
  assert.equal(r2.rebound, 0);
  assert.equal(r2.rooms, 0);
  assert.deepEqual(r2.left, []);
  assert.equal(writes.length, before, "第二遍零写入");
  assert.equal(classes.get("chat:wrD")!.nextOrdinal, 3, "没有多领号");
  assert.equal(dhtpm.members.has(whoKey(S1)), true);
}

console.log("steward-instance ok");
