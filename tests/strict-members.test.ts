import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openMembers } from "../daemon/members.js";

// P7-S2 成员表原语 (⑥ 的可测面): join 升级式、leaveEverywhere 全群摘除。
const tmp = mkdtempSync(join(tmpdir(), "strict-members-"));
const members = openMembers(join(tmp, "members.json"));
const chat = "chat:wrS", other = "chat:wrO";
const idA = "chat:wrS#a", idB = "chat:wrS#b";

// join 升级式: mention → speaker 刷新 by、保留最早 since
members.join(chat, idA, "mention", "human:u1");
const since = members.rowOf(chat, idA)!.since;
members.join(chat, idA, "speaker", "chat:wrS#b");
assert.equal(members.modeOf(chat, idA), "speaker");
assert.equal(members.rowOf(chat, idA)!.since, since, "since 保留最早的");
assert.equal(members.rowOf(chat, idA)!.by, idB, "by 刷新为带入者");
assert.equal(members.isMember(chat, idA), true);
assert.equal(members.isMember(other, idA), false, "成员资格按聊天隔离");

// 游标只进不退
members.advance(chat, idA, 7);
members.advance(chat, idA, 3);
assert.equal(members.rowOf(chat, idA)!.cursor, 7);
members.advance(chat, idA, 9);
assert.equal(members.rowOf(chat, idA)!.cursor, 9);

// leaveEverywhere: 身份退役从所有群摘掉
members.join(other, idA, "mention", "human:u1");
members.join(chat, idB, "speaker", "human:u1");
const left = members.leaveEverywhere(idA);
assert.deepEqual([...left].sort(), [chat, other].sort(), "两群都摘掉");
assert.equal(members.isMember(chat, idA), false);
assert.equal(members.isMember(other, idA), false);
assert.equal(members.isMember(chat, idB), true, "别的身份不受影响");

// ofChat 列表
assert.deepEqual(members.ofChat(chat).map((x) => x.identity), [idB]);

rmSync(tmp, { recursive: true, force: true });
console.log("strict-members: join 升级式 / 游标只进 / leaveEverywhere 全群摘除");
