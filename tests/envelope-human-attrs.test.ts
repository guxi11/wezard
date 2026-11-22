// 人话信封 (2026-11-22 删): 写侧没了 —— 谁说的 = 账本行作者, 哪个群 = room 唤醒头。
// 读侧保留: 老转录 / 老账本行里的人话信封 (含 chat / chat-key 老属性) 仍读回, rolepage 老数据不丢频道归属。
import assert from "node:assert/strict";
import { envelopeAttrs, parseEnvelope, renderReminder } from "../shared/reminder.js";

assert.equal("human" in envelopeAttrs, false, "写侧: 没有人话信封的渲染器");
assert.deepEqual(Object.keys(envelopeAttrs), ["task"], "信封只剩定时任务在写");

const home = '<system-reminder wezard="envelope" kind="human" from="admin">\n</system-reminder>';
const h = parseEnvelope(home);
assert.equal(h?.kind, "human", "老 home 群人话信封照读");
assert.equal(h?.from, "admin");
assert.equal(h?.chatKey, undefined);

const away = '<system-reminder wezard="envelope" kind="human" from="admin" chat-key="chat:B">\n</system-reminder>';
assert.equal(parseEnvelope(away)?.chatKey, "chat:B", "老的非 home 群信封: chat-key 读回");

const legacy = '<system-reminder wezard="envelope" kind="human" from="admin" chat="某群" chat-key="chat:wrX" msg="h1">\n</system-reminder>';
const env = parseEnvelope(legacy);
assert.equal(env?.chatKey, "chat:wrX", "更老的信封 (带 chat 显示名) 的 chat-key 仍读回 (rolepage / 频道归属)");
assert.equal(env?.eventId, "h1");
assert.equal(env?.from, "admin");

// 定时任务信封仍是写侧唯一的信封, chat-key 写注入频道。
const task = renderReminder(envelopeAttrs.task("t1", "chat:G"), []);
assert.equal(parseEnvelope(task)?.chatKey, "chat:G");
console.log("envelope-human-attrs: ok");
