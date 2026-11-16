import assert from "node:assert/strict";
import { parseNameCommand } from "../daemon/inbound.js";

// /name 解析 (2026-11-16 新语义: 只对管家命名; 截图 bug 是 WeCom 把 @mention 粘进参数)。
assert.deepEqual(parseNameCommand("/name"), { arg: "", confirm: false }, "裸 /name = 读");
assert.deepEqual(parseNameCommand("/name "), { arg: "", confirm: false });
assert.deepEqual(parseNameCommand("/name teststrict@wezard"), { arg: "teststrict", confirm: false }, "粘连 mention (截图场景) 截到 @ 为止");
assert.deepEqual(parseNameCommand("/name teststrict @wezard"), { arg: "teststrict", confirm: false }, "独立 mention token 丢弃");
assert.deepEqual(parseNameCommand("/name @wezard"), { arg: "", confirm: false }, "只有 mention = 裸读");
assert.deepEqual(parseNameCommand("/name -"), { arg: "-", confirm: false });
assert.deepEqual(parseNameCommand("/name fix ok"), { arg: "fix", confirm: true }, "ok = 二次确认");
assert.deepEqual(parseNameCommand("/name fix 确认"), { arg: "fix", confirm: true }, "中文确认词");
assert.deepEqual(parseNameCommand("/name fix@wezard ok"), { arg: "fix", confirm: true }, "粘连 mention + 确认共存");
assert.deepEqual(parseNameCommand("/name fix bar"), { arg: "fix", confirm: false }, "多余 token 不算确认");
assert.deepEqual(parseNameCommand("/NAME fix"), { arg: "fix", confirm: false }, "大小写不敏感");
assert.deepEqual(parseNameCommand("/name .fix"), { arg: ".fix", confirm: false }, "记号由 handler 的 stripSigil 收, 解析层原样给");
assert.equal(parseNameCommand("name fix"), undefined, "非命令不匹配");
assert.equal(parseNameCommand("/names fix"), undefined);
console.log("name-command.test.ts ok");
