// 人话信封: 只写代码要读的属性。`chat` (显示名) 已无写入方; `chat-key` 仅在不是 home 群时写;
// 老转录里带 chat / chat-key 的信封读侧照常认。
import assert from "node:assert/strict";
import { envelopeAttrs, parseEnvelope, renderReminder } from "../shared/reminder.js";

const home = renderReminder(envelopeAttrs.human("admin"), []);
assert.equal(home, '\n<system-reminder wezard="envelope" kind="human" from="admin">\n</system-reminder>', "home 群说话: 信封只剩出处");
assert.equal(parseEnvelope(home)?.chatKey, undefined);

const away = renderReminder(envelopeAttrs.human("admin", "chat:B"), []);
assert.ok(away.includes(' chat-key="chat:B"') && !away.includes(' chat="'), "别的群说话: 只写 chat-key");
assert.equal(parseEnvelope(away)?.chatKey, "chat:B");

const legacy = '<system-reminder wezard="envelope" kind="human" from="admin" chat="某群" chat-key="chat:wrX" msg="h1">\n</system-reminder>';
const env = parseEnvelope(legacy);
assert.equal(env?.chatKey, "chat:wrX", "老信封的 chat-key 仍读回 (rolepage / 频道归属)");
assert.equal(env?.eventId, "h1");
assert.equal(env?.from, "admin");
console.log("envelope-human-attrs: ok");
