// 频道换绑 (人 2026-11-23: 「绑定工作区为 cc-wecom」)。
//   ① 建 / 复用目录的管家类, 写频道表 (类名), 帖子级旧绑定清掉;
//   ② 该频道每个 topic room (新口径 topic:<T>/<P> + 存量 chat:<opk> 帖子 room) 坐上新类的**本 room** 实例,
//      host 换人; 存档频道 room (chat:<topic_id>, 2026-11-27 起只读) 不动、也不要求它存在;
//   ③ 旧 host 不离开 room、手上没交代的件一条都不 canceled (leave 会全关);
//   ④ 幂等: 再跑一遍不建类、不重复领号、不写多余 op。
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigSchema } from "../shared/config.js";
import { applyOp, DAEMON, emptyRoom, openDuties, roomHost, type RoomState } from "../shared/room.js";
import { loadClassStore } from "../daemon/classes.js";
import { loadWizardStore, type WizardStore } from "../daemon/wizard.js";
import { rebindChannel } from "../daemon/channel-rebind.js";

const TOPIC = "CiReBindTestAAAA";
const BASE = "chat:" + TOPIC;
const POST_A = "chat:opkReBindA";
const POST_B = "chat:opkReBindB";
const TOPIC_C = "topic:" + TOPIC + "/postC";      // 新口径 topic room
const OLD_WS = "/tmp/nope-old-ws";
const W = (id: string) => ({ kind: "wizard" as const, id });

const world = (tag: string) => {
  const dir = mkdtempSync(join(tmpdir(), "ch-rebind-" + tag + "-"));
  const state = join(dir, "state");
  mkdirSync(state, { recursive: true });
  const newWs = join(dir, "cc-wecom");
  mkdirSync(newWs, { recursive: true });
  writeFileSync(join(state, "channel-posts.json"), JSON.stringify({
    [BASE]: { channel: TOPIC, post: "" },
    [POST_A]: { channel: TOPIC, post: "postA" },
    [POST_B]: { channel: TOPIC, post: "postB" },
  }));
  const cfg = ConfigSchema.parse({
    bot: { botId: "b", secret: "s" },
    daemon: { stateDir: state },
    defaultChat: "user:home",
  });
  cfg.wrc.channel.steward = { [TOPIC]: "wezard" };
  const src = join(dir, "config.jsonc");
  writeFileSync(src, "{\n  \"bot\": { \"botId\": \"b\" }\n}\n");
  const classes = loadClassStore(join(dir, "classes.json"));
  classes.create({ id: "user:T", name: "wezard", role: "steward", workspace: OLD_WS, nextOrdinal: 19 });
  const store: WizardStore = loadWizardStore(join(dir, "wizards.json"), () => undefined, classes);
  store.upsert("user:T", { identity: "user:T", kind: "global-steward", name: "wezard", workspace: OLD_WS, description: "wezard 群管家: 分派与验收" });
  // 三个 room 的旧实例 (每个 room 自己的那个) + 各自的 monitor。
  const seat: Record<string, string> = {};
  for (const [room, name, ord] of [[BASE, "wezard-16", 16], [POST_A, "wezard-17", 17], [POST_B, "wezard-18", 18]] as const) {
    const target = room + "#" + name;
    store.upsert(target, { identity: "user:T", kind: "global-steward", ordinal: ord, name, workspace: OLD_WS });
    store.upsert(room + "#monitor", { identity: room + "#monitor", kind: "monitor", name: "monitor-" + ord });
    seat[room] = store.get(target)!.uid!;
  }
  const rooms = new Map<string, RoomState>();   // BASE = 存档频道 room (不收入站, 换绑不动)
  const open = (id: string) => { const s = emptyRoom(id); applyOp(s, { op: "open", at: 1_000, room: id, kind: "wecom-group", by: DAEMON }); rooms.set(id, s); return s; };
  const seatJoin = (s: RoomState, who: { kind: "wizard"; id: string }, ord: number, role?: "monitor") =>
    applyOp(s, { op: "join", at: 1_000, room: s.id, who, ord, via: "founder", by: DAEMON, ...(role ? { role } : {}) });
  // 频道 room: 旧 host ord 2 (引导 1 号座已空), monitor 3, 旧 host 手上一件没交代的人话。
  const ch = open(BASE);
  seatJoin(ch, W(seat[BASE]!), 2);
  seatJoin(ch, W(store.get(BASE + "#monitor")!.uid!), 3, "monitor");
  applyOp(ch, { op: "msg", at: 2_000, room: BASE, id: BASE + ".1", seq: 1, author: { kind: "human", id: "T" }, ord: 0, speak: "member", kind: "ask", text: "在吗", to: [W(seat[BASE]!)] });
  // 帖子 A: monitor 2, 旧 host 3, 另一个 worker 4。
  const pa = open(POST_A);
  seatJoin(pa, W(store.get(POST_A + "#monitor")!.uid!), 2, "monitor");
  seatJoin(pa, W(seat[POST_A]!), 3);
  store.upsert(POST_A + "#Olive", { identity: POST_A + "#Olive", kind: "worker", name: "Olive" });
  seatJoin(pa, W(store.get(POST_A + "#Olive")!.uid!), 4);
  // 帖子 B: 旧 host 1 号座。
  const pb = open(POST_B);
  seatJoin(pb, W(seat[POST_B]!), 1);
  // topic room C (新口径): 还没有任何 host。
  open(TOPIC_C);
  return { dir, state, newWs, cfg, src, store, classes, rooms, seat };
};

const writes: string[] = [];
const runRebind = (w: ReturnType<typeof world>, over: Partial<Parameters<typeof rebindChannel>[0]> = {}) => {
  writes.length = 0;
  return rebindChannel({
    cfg: w.cfg, sourcePath: w.src, store: w.store,
    stateOf: (room) => w.rooms.get(room),
    roomIds: () => [...w.rooms.keys()],
    write: (room, ops) => { ops.forEach((o) => applyOp(w.rooms.get(room)!, o)); writes.push(room); },
    topicId: TOPIC, workspace: w.newWs, name: "cc-wecom",
    ...over,
  });
};

// ── ① 换绑: 建类 + 换绑 + 每个 room 的 host 换成新实例 ────────────────────
{
  const w = world("basic");
  const r = runRebind(w);
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.createdClass, true);
  assert.equal(r.className, "cc-wecom");
  assert.equal(r.classId, BASE, "新类的锚点 = 频道键 chat:<topic_id> 上的身份记录 (频道没有 room, 它只是身份锚点)");
  assert.equal(w.cfg.wrc.channel.steward?.[TOPIC], "cc-wecom", "频道表写类名");
  assert.equal(w.classes.byName("cc-wecom")!.workspace, w.newWs, "类的工作区 = 目标目录");
  assert.equal(w.classes.byName("cc-wecom")!.description, "wezard 群管家: 分派与验收", "职责从旧绑定的锚点抄一份");
  assert.deepEqual(r.rooms.map((f) => f.room), [POST_A, POST_B, TOPIC_C], "只遍历 topic room (旧帖子 room + 新 topic room), 不含存档频道 room");

  // 三个 room: host 都是新类的本 room 实例, 名字 <类名>-N (1 号是频道键上的身份锚点)。
  const names = r.rooms.map((f) => w.store.get(f.seat)!.name);
  assert.deepEqual(names, ["cc-wecom-2", "cc-wecom-3", "cc-wecom-4"]);
  assert.deepEqual(r.rooms.map((f) => w.store.get(f.seat)!.ordinal), [2, 3, 4]);
  for (const f of r.rooms) {
    const s = w.rooms.get(f.room)!;
    assert.equal(roomHost(s)!.id, w.store.get(f.seat)!.uid, f.room + ": host 换成新实例");
    assert.equal(w.store.get(f.seat)!.identity, BASE, "实例的身份 = 类 id");
  }
  // 存档频道 room 一个字节没动: 旧 host 还在, 手上那件没交代的还在, 也没有新座位。
  const ch = w.rooms.get(BASE)!;
  assert.equal(ch.members.size, 2, "存档频道 room 没坐新实例");
  assert.equal(roomHost(ch)!.id, w.seat[BASE], "存档频道 room 的 host 还是旧的");
  const duty = openDuties(ch).find((d) => d.msg === BASE + ".1");
  assert.ok(duty && !duty.closed, "旧 host 手上的人话没被 canceled");
  assert.equal(duty!.slot, "wizard:" + w.seat[BASE], "件还在旧 host 名下 (换绑不动别人的账)");
  // 旧帖子 room 里的旧 host 也还在 (只是不再是 host)。
  assert.ok([...w.rooms.get(POST_A)!.members.values()].some((m) => m.who.id === w.seat[POST_A]), "旧 host 没有离开帖子 room");

  // 旧实例一个字节没动。
  assert.equal(w.store.get(BASE + "#wezard-16")!.name, "wezard-16");
  assert.equal(w.store.get(POST_B + "#wezard-18")!.name, "wezard-18");

  // ── ④ 幂等 ─────────────────────────────────────────────────────────
  const again = runRebind(w);
  assert.equal(again.ok, true);
  assert.equal(again.createdClass, false, "第二次不再建类");
  assert.deepEqual(again.rooms.map((f) => f.seat), r.rooms.map((f) => f.seat), "复用同一批实例");
  assert.equal(writes.length, 0, "没有新 op");
  assert.equal(roomHost(w.rooms.get(TOPIC_C)!)!.id, w.store.get(r.rooms[2]!.seat)!.uid);
}

// ── ② 目录已有类: 复用 (不建新类), 每个 topic room 只是领一个新实例 ───────────
{
  const w = world("reuse");
  const before = w.classes.byName("wezard")!;
  w.classes.create({ id: "chat:wrOtherX", name: "repo", role: "steward", workspace: w.newWs, nextOrdinal: 2 });
  w.store.upsert("chat:wrOtherX", { identity: "chat:wrOtherX", kind: "steward", ordinal: 1, name: "repo-1", workspace: w.newWs });
  const r = runRebind(w, { name: undefined });
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.createdClass, false);
  assert.equal(r.className, "repo", "按 <bot, role, workspace> 复用已有类");
  assert.equal(w.classes.byName("wezard")!.id, before.id, "旧类不动");
  assert.equal(w.store.get(r.rooms[0]!.seat)!.name, "repo-2");
  assert.equal(w.store.get(r.rooms[2]!.seat)!.name, "repo-4");
}

// ── ③ 拒绝: 同名的类在别的目录 / 不是频道 / 目录不存在 ─────────────────────
{
  const w = world("refuse");
  const bad = runRebind(w, { name: "wezard" });
  assert.equal(bad.ok, false);
  assert.match(bad.reason ?? "", /工作区/);
  const notChannel = runRebind(w, { topicId: "CiUnknown" });
  assert.equal(notChannel.ok, false);
  assert.match(notChannel.reason ?? "", /不是已认出的频道/);
  const noDir = runRebind(w, { workspace: join(w.dir, "missing") });
  assert.equal(noDir.ok, false);
  assert.match(noDir.reason ?? "", /目录不行/);
  assert.equal(w.cfg.wrc.channel.steward?.[TOPIC], "wezard", "拒绝时频道表不动");
}

// ── ④ 帖子级旧绑定: 换绑时清掉 (同频道只留频道表一条) ────────────────────
{
  const w = world("clear");
  w.cfg.chatPolicy = { ...(w.cfg.chatPolicy ?? {}), [POST_A]: { ...(w.cfg.chatPolicy?.[POST_A] ?? {}), steward: "wezard" } } as typeof w.cfg.chatPolicy;
  const r = runRebind(w);
  assert.equal(r.ok, true, r.reason);
  assert.equal(w.cfg.chatPolicy?.[POST_A]?.steward, undefined, "帖子级旧绑定被清掉");
}

// ── ⑤ 频道没有任何 topic room: 只写频道表, 不要求有账本 (2026-11-27) ─────────
{
  const w = world("empty");
  const r = runRebind(w, { roomIds: () => [BASE] });
  assert.equal(r.ok, true, r.reason);
  assert.deepEqual(r.rooms, [], "没有 topic room 就没有座位要坐");
  assert.equal(w.cfg.wrc.channel.steward?.[TOPIC], "cc-wecom", "频道表照写");
}
