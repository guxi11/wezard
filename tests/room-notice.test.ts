// 群公告: notice op 的 fold (设 / 覆盖 / 清除)、权限 (host 才能改, 人不受限)、长度与归一化、
// 读侧 (RoomFact.notice / room_read 头部)、daemon 系统行 (绑定 room 镜像 / 不唤醒)、charter 带上、/notice 解析。
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openRoomStore } from "../daemon/rooms.js";
import { createRoomHub } from "../daemon/room-hub.js";
import { parseNoticeCommand } from "../daemon/inbound.js";
import { renderCharter, type CharterArgs } from "../daemon/wizard.js";
import { canNotice, DAEMON, foldRoom, judgeNotice, mirrors, NOTICE_MAX, type RoomOp, type Who } from "../shared/room.js";
import { buildRoomFact, renderRoomRead } from "../shared/room-view.js";
import { H, uid, W } from "./room-fixture.js";

const A = uid(1), B = uid(2), C = uid(3);
const room = "adhoc:abcd1234";
const base: RoomOp[] = [
  { op: "open", at: 1, room, kind: "adhoc", by: W(A) },
  { op: "join", at: 1, room, who: W(A), ord: 1, via: "founder", by: W(A) },
  { op: "join", at: 2, room, who: W(B), ord: 2, via: "invite", by: W(A) },
];
const notice = (at: number, text: string, by: Who = W(A)): RoomOp => ({ op: "notice", at, room, text, by });
const names = { nameOf: (w: Who) => w.id, roomLabel: (r: string) => r };

// fold: 没有 → 设 → 覆盖 → 清除; 不是消息, 不推进 seq / 不动成员
{
  assert.equal(foldRoom(room, base).notice, undefined);
  const s1 = foldRoom(room, [...base, notice(3, "本周只修 bug")]);
  assert.equal(s1.notice, "本周只修 bug");
  assert.equal(s1.seq, 0);
  assert.equal(s1.members.size, 2);
  assert.equal(foldRoom(room, [...base, notice(3, "旧"), notice(4, "新")]).notice, "新");
  const cleared = foldRoom(room, [...base, notice(3, "旧"), notice(4, "")]);
  assert.equal(cleared.notice, undefined, "空串 = 清除");
  assert.equal(foldRoom(room, [...base, notice(3, "旧"), notice(4, "   ")]).notice, undefined, "纯空白也算清除");
  assert.equal(foldRoom(room, [...base, notice(3, "旧"), notice(4, ""), notice(5, "又来")]).notice, "又来", "清除后可再设");
  // name 与 notice 互不干扰
  const both = foldRoom(room, [...base, notice(3, "规矩"), { op: "name", at: 4, room, title: "账单", by: W(A) }]);
  assert.equal(both.notice, "规矩");
  assert.equal(both.title, "账单");
}

// 权限: 只有 host wizard; 非 host / 非成员 403, 人不受限 (人的授权在 inbound 的 allowFrom 门)
{
  const s = foldRoom(room, base);
  assert.ok(canNotice(s, W(A)));
  assert.ok(!canNotice(s, W(B)));
  assert.ok(!canNotice(s, W(C)));
  assert.ok(canNotice(s, H("T1")));
  const denied = judgeNotice(s, W(B), "我想改");
  assert.equal(denied.ok, false);
  if (!denied.ok) assert.equal(denied.status, 403);
  const denied2 = judgeNotice(s, W(C), "非成员");
  assert.ok(!denied2.ok && denied2.status === 403);
  assert.ok(judgeNotice(s, W(A), "host 改").ok);
  assert.ok(judgeNotice(s, H("T1"), "人改").ok);
  // host 换人: 前 host 不再能改
  const after = foldRoom(room, [...base, { op: "leave", at: 5, room, who: W(A), by: W(A) }]);
  assert.ok(!judgeNotice(after, W(A), "x").ok);
  assert.ok(judgeNotice(after, W(B), "x").ok);
}

// 归一化 / 长度 / 无变化
{
  const s = foldRoom(room, [...base, notice(3, "a b")]);
  const j = judgeNotice(s, W(A), "  a \n\n  b  ");
  assert.ok(j.ok && j.notice === "a b" && !j.changed, "空白折成单空格后与现有相同 = 无变化");
  const j2 = judgeNotice(s, W(A), "c");
  assert.ok(j2.ok && j2.changed);
  const j3 = judgeNotice(foldRoom(room, base), W(A), "");
  assert.ok(j3.ok && !j3.changed, "没有公告时清除 = 无变化");
  assert.ok(judgeNotice(s, W(A), "字".repeat(NOTICE_MAX)).ok);
  const long = judgeNotice(s, W(A), "字".repeat(NOTICE_MAX + 1));
  assert.ok(!long.ok && long.status === 400);
}

// 读侧: RoomFact.notice (/api/room 与 /api/world 的 room 节点共用) 与 room_read 头部
{
  const s0 = foldRoom(room, base);
  assert.equal(buildRoomFact(s0, names).notice, "");
  const s1 = foldRoom(room, [...base, notice(3, "本周重点: 发版")]);
  assert.equal(buildRoomFact(s1, names).notice, "本周重点: 发版");
  const txt = renderRoomRead(s1, W(A), { room }, names).text;
  assert.ok(txt.startsWith("📌 群公告: 本周重点: 发版"), "room_read 头部带公告");
  assert.ok(!renderRoomRead(s0, W(A), { room }, names).text.includes("群公告"), "没有公告就没有这一行");
}

// daemon 系统行: 绑定 room 的 notice 系统行镜像进企微、不唤醒任何人; adhoc 不镜像
{
  const dir = mkdtempSync(join(tmpdir(), "room-notice-"));
  const store = openRoomStore(dir);
  const mirrored: string[] = [];
  const log = { info: () => {}, warn: () => {}, child: () => log } as never;
  const wiz: Record<string, { target: string; name: string }> = { [A]: { target: "chat:wrG", name: "a" }, [B]: { target: "chat:wrG#b", name: "b" } };
  const hub = createRoomHub({
    store, log, now: () => 5_000, wizardOf: (u) => wiz[u], nameOf: (w) => w.id, roomLabel: (r) => r,
    mirror: async (row) => { mirrored.push(row.text); return true; }, live: async () => false, idle: async () => true,
    interrupt: async () => {}, paste: async () => "ok",
  });
  const bound = "chat:wrG";
  store.ensure(bound, { at: 1, kind: "wecom-group", by: DAEMON });
  hub.write(bound, [
    { op: "join", at: 1, room: bound, who: W(A), ord: 1, via: "founder", by: DAEMON },
    { op: "join", at: 2, room: bound, who: W(B), ord: 2, via: "spawn", by: W(A) },
  ]);
  hub.write(bound, [{ op: "notice", at: 3, room: bound, text: "只修 bug", by: H("T1") }]);
  const v = hub.append(bound, { author: DAEMON, kind: "system", origin: "daemon", sys: "notice", text: "[wezard] 📌 群公告: 只修 bug" });
  assert.ok(v.ok);
  if (v.ok) {
    assert.deepEqual(v.row.wake, [], "系统行不唤醒任何成员");
    assert.ok(mirrors(v.row), "绑定 room 的系统行会镜像");
    assert.ok(!mirrors({ ...v.row, kind: "reply", status: "done", text: "" }), "空正文无文件的纯关账行不出站");
  }
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(mirrored.some((t) => t.includes("📌 群公告: 只修 bug")), "镜像到了企微");
  assert.equal(store.get(bound)!.notice, "只修 bug", "状态来自账本 fold");
  hub.write(bound, [{ op: "notice", at: 4, room: bound, text: "", by: H("T1") }]);
  assert.equal(store.get(bound)!.notice, undefined);
  // 落盘重读 (fold 重放) 仍是清除后的状态
  assert.equal(openRoomStore(dir).get(bound)!.notice, undefined);
  hub.write(bound, [{ op: "notice", at: 6, room: bound, text: "重启后还在", by: H("T1") }]);
  assert.equal(openRoomStore(dir).get(bound)!.notice, "重启后还在");
}

// charter: 有公告出一节, 没有不出现
{
  const args: CharterArgs = {
    self: { name: "worker", address: "worker", description: "t", cwd: "/w" },
    chat: "team", principal: "chat:wrG", inherited: false,
    siblings: [], memory: [], chatMemory: "", workspaceMemory: "", steward: false,
    stewardBudget: 4, lead: false, tiers: [],
  };
  assert.ok(!renderCharter(args).includes("本群公告"));
  assert.ok(!renderCharter({ ...args, notice: "" }).includes("本群公告"));
  const c = renderCharter({ ...args, notice: "本周只修 bug" });
  assert.ok(c.includes("## 本群公告") && c.includes("📌 本周只修 bug"));
  assert.ok(c.indexOf("## 本群公告") < c.indexOf("## 我能做什么"), "公告在能力清单之前");
}

// /notice 解析
{
  assert.deepEqual(parseNoticeCommand("/notice"), { op: "show" });
  assert.deepEqual(parseNoticeCommand(" /notice  "), { op: "show" });
  assert.deepEqual(parseNoticeCommand("/notice clear"), { op: "clear" });
  assert.deepEqual(parseNoticeCommand("/NOTICE CLEAR"), { op: "clear" });
  assert.deepEqual(parseNoticeCommand("/notice 清除"), { op: "clear" });
  assert.deepEqual(parseNoticeCommand("/notice 本周只修 Bug"), { op: "set", text: "本周只修 Bug" });
  assert.deepEqual(parseNoticeCommand("/notice clear all the bugs"), { op: "set", text: "clear all the bugs" });
  assert.deepEqual(parseNoticeCommand("/notice 第一行\n第二行"), { op: "set", text: "第一行\n第二行" });
  assert.equal(parseNoticeCommand("/noticeboard"), undefined);
  assert.equal(parseNoticeCommand("notice 你好"), undefined);
}
console.log("room-notice ok");
