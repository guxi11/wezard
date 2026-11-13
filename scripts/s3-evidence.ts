// S3 验收证据脚本 (只读真机, 判定跑在隔离的临时 stateDir 上):
// ① 前后快照对照: S2 判定 vs S3 判定, 存量 0 变化 + 新建首条 strict
// ② /strict --all 的 dry-run 输出样例 (真机数据, 不写真机)
import { mkdtempSync, mkdirSync, cpSync, readFileSync, writeFileSync, rmSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../shared/config.js";
import { chatPolicyOf } from "../daemon/chat-name.js";
import { resetKnownChatsCache, knownChatsOf } from "../daemon/chat-seen.js";
import { planStrictSwitch, renderSwitchReport, parseStrictCommand } from "../daemon/strict-switch.js";

const { config: cfg, sourcePath } = loadConfig();
const realState = process.env.HOME + "/.wezard/state";
const tmp = mkdtempSync(join(tmpdir(), "s3-evidence-"));
const dir = join(tmp, "state");
mkdirSync(dir, { recursive: true });
// 把「盘上可见的存量痕迹」原样拷进隔离 stateDir (chat-records / channels / members)。
for (const sub of ["chats", "channels"]) {
  const from = join(realState, sub);
  if (existsSync(from)) { mkdirSync(join(dir, sub), { recursive: true }); for (const f of readdirSync(from)) cpSync(join(from, f), join(dir, sub, f)); }
}
if (existsSync(join(realState, "members.json"))) cpSync(join(realState, "members.json"), join(dir, "members.json"));
// cfg 原样 (chats/chatPolicy 键也在册来源里), 但 stateDir 指向隔离目录。
const iso = { ...cfg, daemon: { ...cfg.daemon, stateDir: dir } };

// S3 判定册: 打开即做 boot 快照 (legacy = 隔离目录里的存量)。
resetKnownChatsCache();
const known = knownChatsOf(iso);
const allChats = [...new Set([
  ...Object.values(cfg.chats ?? {}),
  ...Object.keys(cfg.chatPolicy ?? {}),
  ...known.rows().map((r) => r.chat),
])];

let changed = 0, legacyN = 0, strictN = 0;
const rows = [];
for (const base of allChats) {
  const before = (cfg.chatPolicy?.[base]?.speech) ?? "implicit";
  const after = chatPolicyOf(iso, base).speech;
  if (before !== after) changed++;
  if (known.isLegacy(base)) legacyN++; else if (after === "strict") strictN++;
  rows.push({ base, before, after, legacy: known.isLegacy(base) });
}
console.log("① 前后快照对照 (真机聊天全集 " + allChats.length + " 个):");
console.log("   存量 (boot 快照在册 legacy): " + legacyN + " 个; 其中 speech 判定变化: " + rows.filter((r) => r.legacy && r.before !== r.after).length + " 个");
console.log("   S3 后首见将默认 strict 的已登记聊天: " + strictN + " 个 (真机此刻 0 属正常 — 册还没启用)");
console.log("   判定变化总数 (应全来自显式 chatPolicy, 否则 = 存量被动了): " + changed);
const flipped = rows.filter((r) => r.before !== r.after);
if (flipped.length) console.log("   变化明细: " + JSON.stringify(flipped));
// 模拟「S3 后新建聊天」: 隔离册里 record 一个新群, 首条即 strict。
const fresh = "chat:wrS3FRESH" + Date.now();
known.record(fresh);
console.log("   新建聊天首条: " + chatPolicyOf(iso, fresh).speech + " (100% strict)");

// ② dry-run 样例 (真机数据, 隔离册): facts 从真机名册读。
const wiz = JSON.parse(readFileSync(cfg.wrc.mirror.wizardsFile.replace(/^~/, process.env.HOME ?? ""), "utf8")) as Record<string, { name?: string }>;
const facts = {
  chatLabel: (base: string) => cfg.chats ? (Object.entries(cfg.chats).find(([, b]) => b === base)?.[0] ?? base) : base,
  wizardsOf: (base: string) => Object.entries(wiz).filter(([t]) => t.split("#")[0] === base).map(([, w]) => "." + (w.name ?? "?")),
  stewardOf: (base: string) => cfg.chatPolicy?.[base]?.steward ?? "",
  memberCount: (base: string) => {
    try { return Object.keys(JSON.parse(readFileSync(join(dir, "members.json"), "utf8"))).filter((k) => k.split("|")[0] === base).length; } catch { return 0; }
  },
};
const plan = planStrictSwitch(iso, { refs: [], all: true, selfBase: "" }, (ref) => ref, facts);
console.log("");
console.log("② /strict --all dry-run 样例 (候选 " + plan.candidates.length + " 个存量 implicit 群, 截前 6):");
const sample = { ...plan, rows: plan.rows.slice(0, 6) };
console.log(renderSwitchReport(sample, "dry"));
console.log("   (样例截断显示; 完整 " + plan.rows.length + " 行)");

rmSync(tmp, { recursive: true, force: true });
resetKnownChatsCache();
