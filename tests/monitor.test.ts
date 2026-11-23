// monitor (§2.2): 宪章 / 工具面硬限 / 发言权硬限 (hub append) —— 纯逻辑 + hub 闸。
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { openRoomStore } from "../daemon/rooms.js";
import { createRoomHub } from "../daemon/room-hub.js";
import { DAEMON, openDuties, type Who } from "../shared/room.js";
import { MONITOR_TOOLS, monitorRefusal, renderCharter, type WizardRecord } from "../daemon/wizard.js";
import { room as mkRoom, uid, W } from "./room-fixture.js";

const M = W(uid(9));
const rec = (kind: string) => ({ target: "chat:t#monitor", name: "mon", description: "", bornAt: 1, kind } as unknown as WizardRecord);

// ① 宪章: monitor 用专用宪章 (没有编排 / 派活 / 发言那几节), 讲清唯一判决动作。
const charter = renderCharter({
  self: { name: "mon", address: "mon", description: "monitor", cwd: "/w", kind: "monitor" },
  chat: "", principal: "chat:topicT", inherited: false, siblings: [], memory: [],
  chatMemory: "", workspaceMemory: "", steward: false, stewardBudget: 0, lead: false, tiers: [],
});
assert.ok(charter.includes("# 你是这个 room 的 monitor"));
assert.ok(charter.includes("room_activate"));
assert.ok(!charter.includes("## 怎么干活: 编排"), "monitor 宪章不带编排节");
assert.ok(!charter.includes("## 怎么说话"), "monitor 宪章不带发言节");
// 普通 wizard 的宪章不受影响。
const normal = renderCharter({
  self: { name: "w", address: "w", description: "", cwd: "/w", kind: "worker" },
  chat: "", principal: "chat:x", inherited: false, siblings: [], memory: [],
  chatMemory: "", workspaceMemory: "", steward: false, stewardBudget: 0, lead: false, tiers: [],
});
assert.ok(normal.includes("## 怎么干活: 编排"));
assert.ok(!normal.includes("room_activate"), "room_activate 不进普通 wizard 的工具清单");

// ② 工具面: 五件放行, 其余 (含 REPL / 内置工具 / 别的 MCP 工具) 全拒; 非 monitor 不受影响。
for (const t of ["room_read", "read_channel", "wizard_roster", "room_activate", "handoff", "mcp__wezard__room_read"]) {
  assert.equal(monitorRefusal(rec("monitor"), t), "", t + " 放行");
}
for (const t of ["chat_say", "chat_reply", "chat_ask", "notify", "send_file", "room_members", "REPL", "Bash", "Write", "spawn_wizard"]) {
  assert.ok(monitorRefusal(rec("monitor"), t).length > 0, t + " 被拒");
}
assert.equal(monitorRefusal(rec("worker"), "chat_say"), "", "非 monitor 不受限");

// ②b CodeBuddy 只暴露 REPL: 工具面下钻脚本 (白名单五件), 与引导同型 (2026-11-23 .monitor-2 实录)。
const repl = (code: unknown) => monitorRefusal(rec("monitor"), "REPL", code === undefined ? undefined : { code });
assert.equal(repl("const r = await mcp.wezard.room_read({ room: 'chat:x' }); return r;"), "", "REPL 调 room_read 放行");
assert.equal(repl("await mcp.wezard.room_activate({ re: 'a.1', to: 'x' });"), "", "REPL 调 room_activate 放行");
assert.equal(repl("const { room_read } = mcp.wezard; await room_read({});"), "", "解构别名按同一身份认");
assert.ok(repl("await mcp.wezard.chat_say({ text: 'x' });").includes("chat_say"), "REPL 调 chat_say 拒");
assert.ok(repl("await mcp.wezard.spawn_wizard({ inherit: false });").length > 0, "REPL 调 spawn_wizard 拒");
assert.ok(repl("await fetchCommon();").length > 0, "认不出的调用拒");
assert.ok(repl("await new Foo();").length > 0, "new 拒");
assert.ok(repl("await mcp.wezard.room_read({").includes("解析不了"), "解析失败拒");
assert.ok(repl(undefined).length > 0, "无 toolInput 的 REPL 拒");
assert.ok(monitorRefusal(rec("monitor"), "REPL", { code: 42 }).length > 0, "code 不是字符串也拒");
assert.deepEqual([...MONITOR_TOOLS].sort(), ["handoff", "read_channel", "room_activate", "room_read", "wizard_roster"]);

// ③ hub 闸: monitor 写 say / reply / ask 一律 403; activate 判决照常落成 (并开 duty)。
const dir = mkdtempSync(join(tmpdir(), "monitor-hub-"));
const store = openRoomStore(dir);
const log = { info: () => {}, warn: () => {}, child: () => log } as never;
const hub = createRoomHub({
  store, log, now: () => 1_000,
  wizardOf: (u) => ({ target: u === M.id ? "chat:t#monitor" : "chat:t", name: u === M.id ? "mon" : "host" }),
  nameOf: (w: Who) => (w.kind === "wizard" ? "." + (w.id === M.id ? "mon" : "host") : w.id),
  roomLabel: (r) => r, mirror: async () => true, live: async () => false, idle: async () => true,
  interrupt: async () => {}, paste: async () => "ok",
});
store.ensure("chat:t", { at: 1, kind: "wecom-group", by: DAEMON });
const H: Who = { kind: "human", id: "u1" };
const A = W(uid(1));
hub.write("chat:t", [
  { op: "join", at: 1, room: "chat:t", who: A, ord: 1, via: "founder", by: DAEMON },
  { op: "join", at: 2, room: "chat:t", who: M, ord: 2, via: "invite", by: DAEMON, role: "monitor" },
]);
const human = hub.append("chat:t", { author: H, kind: "say", text: "谁能看下", origin: "inbound" });
assert.ok(human.ok);
for (const kind of ["say", "reply", "ask"] as const) {
  const v = hub.append("chat:t", { author: M, kind, text: "x", origin: "tool", ...(kind === "reply" ? { re: [human.ok ? human.row.id : ""] } : {}) });
  assert.equal(v.ok, false, "monitor 不能写 " + kind);
  if (!v.ok) assert.equal(v.status, 403);
}
assert.deepEqual(openDuties(store.get("chat:t")!).length, 0, "monitor 的人话不开 duty");
// 2026-11-23 人定: 判决完全不写消息行 —— monitor 连 trigger activate 行也不能 append。
const actV = hub.append("chat:t", { author: M, kind: "trigger", sys: "activate", text: "", re: [human.ok ? human.row.id : ""], to: [A], origin: "tool" });
assert.equal(actV.ok, false, "monitor 不写任何 msg 行 (含 activate)");
if (!actV.ok) assert.equal(actV.status, 403);
// 判决走 assign op: 开 duty, 不写消息行。
const humanId = human.ok ? human.row.id : "";
const msgsBefore = store.get("chat:t")!.msgs.length;
hub.write("chat:t", [{ op: "assign", at: 3, room: "chat:t", duty: humanId, to: A, asker: H, by: M }]);
assert.deepEqual(openDuties(store.get("chat:t")!).map((d) => d.slot), ["wizard:" + A.id]);
assert.equal(openDuties(store.get("chat:t")!)[0]!.via, "assign");
assert.equal(store.get("chat:t")!.msgs.length, msgsBefore, "assign 不写消息行");

console.log("monitor ok");
