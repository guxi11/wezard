// v3 P7-S3 ① 新群默认 strict: known-chats 册 + speech 缺省判定。
// 判定链: 显式 chatPolicy.speech > 首见 (在册且非 legacy) strict > 存量 / 未在册 implicit。
// 验收数字 ① 的机制面: 新建聊天首条 100% strict + 存量 0 变化 (运行时面的前后快照对照在
// strict-chat 夹具, 这里测判定核本身)。
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chatPolicyOf } from "../daemon/chat-name.js";
import { knownChatsOf, resetKnownChatsCache, speechDefaultOf } from "../daemon/chat-seen.js";
import { ConfigSchema, type Config } from "../shared/config.js";

const tmp = mkdtempSync(join(tmpdir(), "strict-default-"));
const cfgOf = (stateDir: string, extra: Record<string, unknown> = {}): Config =>
  ConfigSchema.parse({ bot: { botId: "t", secret: "t" }, daemon: { stateDir }, ...extra });

// ── 1. 空 daemon (没有任何存量): 一切聊天未在册 → implicit; 首见登记后 → strict ──
{
  resetKnownChatsCache();
  const dir = join(tmp, "fresh");
  const cfg = cfgOf(dir);
  assert.equal(speechDefaultOf(cfg, "chat:wrNEW"), "implicit", "未在册 (无往来) → implicit");
  assert.equal(knownChatsOf(cfg).record("chat:wrNEW"), "strict", "首见登记 → strict");
  assert.equal(speechDefaultOf(cfg, "chat:wrNEW"), "strict", "在册且非 legacy → strict");
  // 单聊不受首见 strict 影响 (私聊口径 S2 起照旧)
  knownChatsOf(cfg).record("user:alice");
  assert.equal(speechDefaultOf(cfg, "user:alice"), "implicit", "单聊不默认 strict");
}

// ── 2. 存量快照: boot 前盘上已有痕迹的聊天 = legacy → implicit, 显式 chatPolicy 优先 ──
{
  resetKnownChatsCache();
  const dir = join(tmp, "legacy");
  mkdirSync(join(dir, "chats"), { recursive: true });
  writeFileSync(join(dir, "chats", "chat%3AwrOLD.jsonl"), JSON.stringify({ chat: "chat:wrOLD", seq: 1, at: 1, id: "m1", author: "u", kind: "human", text: "x" }) + "\n");
  writeFileSync(join(dir, "members.json"), JSON.stringify({ "chat:wrMEM|chat:wrMEM#a": { mode: "mention", since: 1, by: "human:u", cursor: -1 } }));
  const cfg = cfgOf(dir);
  assert.equal(speechDefaultOf(cfg, "chat:wrOLD"), "implicit", "chatRecords 有痕迹 → 存量 implicit");
  assert.equal(speechDefaultOf(cfg, "chat:wrMEM"), "implicit", "members.json 有键 → 存量 implicit");
  assert.equal(speechDefaultOf(cfg, "chat:wrNEW2"), "implicit", "没痕迹的群未在册 → implicit");
  knownChatsOf(cfg).record("chat:wrNEW2");
  assert.equal(speechDefaultOf(cfg, "chat:wrNEW2"), "strict", "同一 daemon 里首见的新群 → strict");
  // 显式 chatPolicy 永远优先 (两个方向)
  const explicit = cfgOf(join(tmp, "legacy"), { chatPolicy: { "chat:wrOLD": { speech: "strict" }, "chat:wrNEW2": { speech: "implicit" } } });
  assert.equal(chatPolicyOf(explicit, "chat:wrOLD").speech, "strict", "显式 strict 盖过存量 implicit");
  assert.equal(chatPolicyOf(explicit, "chat:wrNEW2").speech, "implicit", "显式 implicit 盖过首见 strict");
}

// ── 3. boot 增量: 重启后新冒头的盘上痕迹按存量并入; 已登记的首见不翻案 ──
{
  resetKnownChatsCache();
  const dir = join(tmp, "reboot");
  const cfg = cfgOf(dir);
  knownChatsOf(cfg).record("chat:wrAFTER"); // S3 后首见 → strict
  assert.ok(existsSync(join(dir, "known-chats.json")), "册落盘");
  // 模拟下一个 boot 前盘上多了一个老 daemon 留下的聊天
  mkdirSync(join(dir, "chats"), { recursive: true });
  writeFileSync(join(dir, "chats", "chat%3AwrQUIET.jsonl"), "{}\n");
  resetKnownChatsCache(); // reboot
  const cfg2 = cfgOf(dir);
  assert.equal(speechDefaultOf(cfg2, "chat:wrQUIET"), "implicit", "boot 增量: 新冒头的盘上痕迹按存量并入");
  assert.equal(speechDefaultOf(cfg2, "chat:wrAFTER"), "strict", "首见登记跨 boot 不翻案");
  // 册文件内容可读回
  const saved = JSON.parse(readFileSync(join(dir, "known-chats.json"), "utf8")) as Record<string, { at: number; legacy: boolean }>;
  assert.equal(saved["chat:wrAFTER"]?.legacy, false);
  assert.equal(saved["chat:wrQUIET"]?.legacy, true);
}

// ── 4. cfg 侧来源: chats 命名表与 chatPolicy 键也算存量; wizards 名册 home 同样 ──
{
  resetKnownChatsCache();
  const dir = join(tmp, "named");
  const wizFile = join(tmp, "named-wizards.json");
  writeFileSync(wizFile, JSON.stringify({ "chat:wrHOME#fix": { name: "fix" } }));
  const cfg = cfgOf(dir, { chats: { "old-group": "chat:wrNAMED" }, chatPolicy: { "chat:wrPOL": { steward: "fix" } }, wrc: { mirror: { wizardsFile: wizFile } } });
  assert.equal(speechDefaultOf(cfg, "chat:wrNAMED"), "implicit", "chats 命名表 → 存量");
  assert.equal(speechDefaultOf(cfg, "chat:wrPOL"), "implicit", "chatPolicy 键 (哪怕只写 steward) → 存量");
  assert.equal(speechDefaultOf(cfg, "chat:wrHOME"), "implicit", "wizard 名册 home → 存量");
  assert.equal(knownChatsOf(cfg).isLegacy("chat:wrHOME"), true, "名册 home 真的进了册 (不是靠「未在册也 implicit」碰巧通过)");
}

// ── 5. 频道也是聊天: chat:<topic_id> 首见 → strict; 已有频道缓存 → 存量 ──
{
  resetKnownChatsCache();
  const dir = join(tmp, "topics");
  mkdirSync(join(dir, "channels"), { recursive: true });
  writeFileSync(join(dir, "channels", "topicOLD.jsonl"), "{}\n");
  const cfg = cfgOf(dir);
  assert.equal(speechDefaultOf(cfg, "chat:topicOLD"), "implicit", "已有频道缓存 → 存量");
  knownChatsOf(cfg).record("chat:topicNEW");
  assert.equal(speechDefaultOf(cfg, "chat:topicNEW"), "strict", "新频道首见 → strict");
}

rmSync(tmp, { recursive: true, force: true });
resetKnownChatsCache();
console.log("strict-default: 首见 strict / 存量 implicit / boot 增量 / 显式优先 / 频道同权");
