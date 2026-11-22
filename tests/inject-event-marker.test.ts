import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { carriesMsg, envelopeFor, renderTail, withMsg } from "../shared/reminder.js";
import { markTranscript, submittedEventSince } from "../daemon/wezard-session.js";

// 回归: 无信封注入 (handoff 简报) 带 eventId 却不挂标记 → 提交确认永远 "转录里没有这一笔"。
const id = "handoff:abc:carry";
const sent = (text: string, ev?: string, env?: string) => text + renderTail(envelopeFor(text, env, ev));

assert.ok(carriesMsg(sent("简报", id), id), "无信封 + eventId → 带标记");
const room = withMsg('<system-reminder wezard="envelope" kind="peer" from=".a">x</system-reminder>', "m1");
assert.equal(envelopeFor("hi", room, id), room, "已有信封不改写");
assert.ok(carriesMsg(sent("hi", id, room), "m1") && !carriesMsg(sent("hi", id, room), id));
assert.equal(envelopeFor("/clear", undefined, id), "", "斜杠命令不加");
assert.equal(envelopeFor("简报", undefined, undefined), "", "无 eventId 不加");

const dir = mkdtempSync(join(tmpdir(), "marker-"));
const path = join(dir, "s.jsonl");
writeFileSync(path, "");
const mark = markTranscript(path);
writeFileSync(path, JSON.stringify({ type: "user", timestamp: new Date().toISOString(), message: { role: "user", content: sent("简报", id) } }) + "\n");
assert.ok(submittedEventSince([mark], id, 0), "转录里带标记的 user 行 → 已提交");
assert.ok(!submittedEventSince([mark], "other", 0));
console.log("ok");
