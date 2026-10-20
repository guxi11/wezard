// 聊天身份按 key 认: peer/回执信封带 `chat-key`, read_chat 两层匹配 (有 key 按 key,
// 没有回落按名)。名字会被 rename 释放换主 —— 同名的新群不能再把旧群的往来读走,
// 而旧 transcript (信封没带 key、甚至还是老措辞) 必须仍能读出来。
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderPeerEnvelope, renderReceiptEnvelope } from "../daemon/peers.js";
import { parseEnvelope, renderReminder, renderTail } from "../shared/reminder.js";
import { renderChatLog, type LogSession } from "../daemon/chat-log.js";

// ── 信封: peer / 回执带 chat-key 且解析读得回; 私聊不带; renderTail 排序不受新属性影响 ──
const peer = renderPeerEnvelope(".a", "modeck", "chat:wrNEW", { act: "ask" });
assert.match(peer, /^\n<system-reminder wezard="envelope" kind="peer" from="\.a" scope="public" chat="modeck" chat-key="chat:wrNEW"/);
const peerEnv = parseEnvelope(peer)!;
assert.equal(peerEnv.chat, "modeck");
assert.equal(peerEnv.chatKey, "chat:wrNEW");
assert.equal(peerEnv.private, false);
assert.equal(parseEnvelope(renderPeerEnvelope(".a", "modeck"))?.chatKey, undefined, "没给 key 不凭空造一个 (老形状)");
assert.equal(parseEnvelope(renderPeerEnvelope(".a"))?.chat, "", "私聊不带频道");
const rcptEnv = parseEnvelope(renderReceiptEnvelope(".b", "modeck", { job: "j", done: 1, total: 2 }, "done", "e1", undefined, "chat:wrNEW"))!;
assert.equal(rcptEnv.receipt, true);
assert.equal(rcptEnv.chatKey, "chat:wrNEW");
const tail = renderTail(renderReminder({ wezard: "hint" }, ["旁注"]), peer);
assert.ok(tail.indexOf('wezard="envelope"') < tail.indexOf('wezard="hint"'), "信封仍打头");
assert.equal(parseEnvelope(tail)?.chatKey, "chat:wrNEW", "renderTail 不剥新属性");

// ── transcript: 旧群 (名字 modeck 已让出) 与霉用同名的新群 ──
const dir = mkdtempSync(join(tmpdir(), "chat-key-"));
const at = Date.now() - 3600_000;
const script = (name: string, rounds: Array<[string, string]>): string => {
  const path = join(dir, `${name}.jsonl`);
  const rows = rounds.flatMap(([ask, reply], i): object[] => [
    { type: "user", timestamp: new Date(at + i * 4000).toISOString(), message: { role: "user", content: ask } },
    { type: "assistant", timestamp: new Date(at + i * 4000 + 1000).toISOString(), message: { role: "assistant", content: reply } },
  ]);
  writeFileSync(path, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return path;
};
// 属性出现之前的老措辞信封 (shared/reminder.ts LEGACY 表照认的那种)。
const legacyEnvelope = (chat: string): string =>
  `\n<system-reminder wezard="envelope">这一轮是 wizard \`.x\` 在群 **${chat}** 里**公开**说的, 照常执行。</system-reminder>`;

const OLD = "chat:wrOLD";
const NEW = "chat:wrNEW";
// 旧群的 wizard: 会话显示名恰是后来被新群 wizard 霉用的名字 (rename 释放后的复用)。
const oldS: LogSession = {
  name: ".modeck", key: `${OLD}#oldw`, jsonlPath: script("old", [
    ["旧群的同伴轮 (老信封, 无 key)" + renderPeerEnvelope(".x", "modeck"), "RESULT: old-peer"],
    ["旧群的人话 (无信封, home)", "RESULT: old-human"],
    ["更老的措辞信封" + legacyEnvelope("modeck"), "RESULT: old-legacy"],
    ["旧群的私聊轮" + renderPeerEnvelope(".x"), "RESULT: old-private"],
  ]),
  homeChat: "modeck", homeKey: OLD, homeHuman: "未知", since: 0,
};
const newS: LogSession = {
  name: ".neww", key: `${NEW}#neww`, jsonlPath: script("new", [
    ["新群的同伴轮 (新信封, 带 key)" + renderPeerEnvelope(".x", "modeck", NEW), "RESULT: new-peer"],
    ["新群的人话 (无信封, home)", "RESULT: new-human"],
  ]),
  homeChat: "modeck", homeKey: NEW, homeHuman: "未知", since: 0,
};
const sessions = [oldS, newS];
const read = (q: Record<string, unknown>): string =>
  renderChatLog(sessions, { limit: 50, per: 200, ...q }, Date.now()).text;
const has = (text: string, mark: string): boolean => text.includes(mark);

// 查新群 (key=NEW, 名字霉用了 modeck): 新群的轮都在; 旧群**无信封的人话**不再串进来
// (home key 隔离)。旧信封 (无 key) 按名回落仍在 —— 那是「不能全漏」的代价。
const newView = read({ chat: "modeck", chatKey: NEW });
assert.ok(has(newView, "new-peer") && has(newView, "new-human"), "新群自己的轮都在");
assert.ok(!has(newView, "old-human"), "旧群无信封的人话按 home key 隔离, 不再串进同名新群");
assert.ok(has(newView, "old-peer") && has(newView, "old-legacy"), "无 key 的旧轮回落按名 (LEGACY 不全漏)");
assert.ok(!has(newView, "old-private"), "私聊不进群轴");

// 查旧群 (key=OLD): 旧 transcript 完整读得出来 —— 这就是「旧 transcript 仍能读出来」的证据;
// 同名的新群轮进不来 (key 不同压过同名): 修掉的正是这一半。
const oldView = read({ chat: "modeck", chatKey: OLD });
assert.ok(has(oldView, "old-peer") && has(oldView, "old-human") && has(oldView, "old-legacy"), "旧群三种形状都读得出来");
assert.ok(!has(oldView, "new-peer") && !has(oldView, "new-human"), "同名但 key 不同的新群轮不再归给旧群");

// 只按名 (没有 key 的调用方): 行为与从前一致。
const nameOnly = read({ chat: "modeck" });
assert.ok(has(nameOnly, "old-peer") && has(nameOnly, "new-peer") && has(nameOnly, "old-human") && has(nameOnly, "new-human"));

// role 轴: 解析出 key 时会话主人按 session key 认 —— 旧会话显示名 ".modeck" 与查询名
// 相同也不再冒认; 没解析出 key (人 / 已不在的 wizard) 才按名。
const byKey = read({ role: ".modeck", roleKey: `${NEW}#neww` });
assert.ok(has(byKey, "new-peer") && !has(byKey, "old-peer"), "role 轴 key 压过同名的旧会话");
const byName = read({ role: ".modeck" });
assert.ok(has(byName, "old-peer"), "role 轴没 key 回落按名 (旧记录可读)");
const fromSide = read({ role: ".x" });
assert.ok(has(fromSide, "old-peer") && has(fromSide, "new-peer"), "发话方只有名字, 始终按名");

console.log("chat-log-key: all assertions passed");
