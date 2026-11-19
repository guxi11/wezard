// room 看门狗 (wiring C): 假 tmux + 假时钟, 不起真 pane。四条验收:
// ① pane 消失 → staleMin 后一轮扫描内账本出现 canceled reply + instance-ended 且唤醒提问者, 重复扫描不再写;
// ② pane 闲但没收到 turn_end → staleMin 后 onIdle 恰好一次; ③ pane 忙 → 账本不变, warn 带 busyForMs/openDuties;
// ④ 一次扫描只调一次 listPanes。
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openRoomStore } from "../daemon/rooms.js";
import { createRoomWatchdog } from "../daemon/room-watchdog.js";
import { DAEMON, openDuties, type Who } from "../shared/room.js";
import { uid } from "./room-fixture.js";

const mk = () => {
  const dir = mkdtempSync(join(tmpdir(), "room-wd-"));
  const store = openRoomStore(dir);
  const room = "chat:wrG";
  store.ensure(room, { at: 1, kind: "wecom-group", by: DAEMON });
  return { store, room };
};
const W = uid(1), A = uid(2);
const wiz: Record<string, { target: string; name: string; paneId?: string }> = {
  [W]: { target: "chat:wrG", name: "w", paneId: "%1" },
};
const human: Who = { kind: "human", id: "T1" };

const setupDuty = (store: ReturnType<typeof openRoomStore>, room: string): void => {
  store.append(room, [
    { op: "join", at: 1, room, who: { kind: "wizard", id: W }, ord: 1, via: "founder", by: DAEMON },
  ])
};

let clock = 100_000;
const now = () => clock;

// ① pane 消失 → canceled + instance-ended + 唤醒提问者; 重复扫描不再写。
{
  const { store, room } = mk();
  setupDuty(store, room);
  store.append(room, [{ op: "msg", at: 2, room, id: "a1b2c3d4.1", seq: 1, author: human, ord: 0, speak: "human", kind: "ask", text: "干活", to: [{ kind: "wizard", id: W }], wake: [W], origin: "inbound" }]);
  let idle = 0;
  let panes: string[] = []; // 空 = pane 消失
  const wd = createRoomWatchdog({
    now, listPanes: async () => panes, wizardOf: (u) => wiz[u],
    isBusy: async () => false,
    rooms: store.ids, stateOf: (id) => store.get(id),
    write: (id, ops) => { store.append(id, ops); },
    onIdle: () => { idle++; }, kick: () => {}, staleMs: () => 5 * 60_000,
  });
  clock += 6 * 60_000;
  await wd.scan();
  const s = store.get(room)!;
  assert(openDuties(s).length === 0, "duty 已被 canceled");
  assert(s.msgs.some((m) => m.kind === "reply" && m.status === "canceled" && (m.re ?? []).includes("a1b2c3d4.1")), "canceled reply 落账并唤醒提问者");
  const ended = s.msgs.filter((m) => m.sys === "instance-ended");
  assert(ended.length === 1, "恰好一行 instance-ended");
  const before = s.msgs.length;
  clock += 6 * 60_000;
  await wd.scan();
  assert(store.get(room)!.msgs.length === before, "重复扫描不再写");
}

// ② pane 闲但没收到 turn_end → onIdle 恰好一次 (touch 重置 stale 窗口)。
{
  const { store, room } = mk();
  setupDuty(store, room);
  store.append(room, [{ op: "msg", at: 2, room, id: "a1b2c3d4.1", seq: 1, author: human, ord: 0, speak: "human", kind: "ask", text: "干活", to: [{ kind: "wizard", id: W }], wake: [W], origin: "inbound" }]);
  let idle = 0;
  const wd = createRoomWatchdog({
    now, listPanes: async () => ["%1"], wizardOf: (u) => wiz[u],
    isBusy: async () => false,
    rooms: store.ids, stateOf: (id) => store.get(id),
    write: (id, ops) => { store.append(id, ops); },
    onIdle: () => { idle++; }, kick: () => {}, staleMs: () => 5 * 60_000,
  });
  clock += 6 * 60_000;
  await wd.scan();
  clock += 60_000;
  await wd.scan();
  assert.equal(idle, 1, "onIdle 恰好一次");
}

// ③ pane 忙 → 账本不变, warn 带 busyForMs / openDuties; ④ 一次扫描只调一次 listPanes。
{
  const { store, room } = mk();
  setupDuty(store, room);
  store.append(room, [{ op: "msg", at: 2, room, id: "a1b2c3d4.1", seq: 1, author: human, ord: 0, speak: "human", kind: "ask", text: "干活", to: [{ kind: "wizard", id: W }], wake: [W], origin: "inbound" }]);
  const warns: Array<Record<string, unknown>> = [];
  let listCalls = 0;
  const wd = createRoomWatchdog({
    now,
    log: { warn: (f: Record<string, unknown>) => { warns.push(f); } } as never,
    listPanes: async () => { listCalls++; return ["%1"]; },
    wizardOf: (u) => wiz[u],
    isBusy: async () => true,
    rooms: store.ids, stateOf: (id) => store.get(id),
    write: (id, ops) => { store.append(id, ops); },
    onIdle: () => { throw new Error("忙的不该 onIdle"); }, kick: () => {}, staleMs: () => 5 * 60_000,
  });
  clock += 6 * 60_000;
  await wd.scan();
  clock += 60_000;
  await wd.scan();
  assert.equal(store.get(room)!.msgs.length, 1, "账本行数不变 (只有那条 ask)");
  assert(warns.length >= 2 && warns.every((w) => typeof w.busyForMs === "number" && w.openDuties === 1 && !!w.name && !!w.uid), "warn 带 busyForMs/openDuties/name/uid");
  assert.equal(listCalls, 2, "每次扫描恰好一次 listPanes");
}

console.log("room-watchdog: pane 消失→canceled+instance-ended+幂等; 漏 turn_end→onIdle 一次; 忙→只 warn; 单次扫描单次 list-panes");

