// 只读活体验收: v3 管家接待对现场数据的解析表 (模拟 v3 boot)。不写现场文件、不碰 daemon。
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, copyFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { loadConfig } from "../dist/shared/config.js";
import { loadWizardStore, migrateIdentities } from "../dist/daemon/wizard.js";
import { stewardRoute, isStewardTarget, appointedSteward, markGlobalSteward } from "../dist/daemon/steward.js";
const home = homedir();
const tmp = mkdtempSync(join(tmpdir(), "probe-"));
const wizFile = join(tmp, "wizards.json");
copyFileSync(join(home, ".wezard/wizards.json"), wizFile);
const cfgRes = loadConfig(join(home, ".wezard/config.jsonc"));
const cfg = cfgRes.config ?? cfgRes;
const store = loadWizardStore(wizFile, () => undefined);
const mig = migrateIdentities(store, wizFile);
const gsBoot = markGlobalSteward(store, cfg.defaultChat);
const mirror = JSON.parse(readFileSync(join(home, ".wezard/mirror-attachments.json"), "utf8"));
const cwdOf = (t) => { const a = mirror[t]; return (a && (a.cwd || a.pendingCwd)) || ""; };
const attached = (t) => !!mirror[t];
const raw = JSON.parse(readFileSync(wizFile, "utf8"));
const bases = new Set();
for (const t of Object.keys(raw)) { const b = t.split("#")[0]; if (!b.startsWith("wezard:")) bases.add(b); }
for (const c of Object.values(cfg.chats ?? {})) bases.add(c);
for (const k of Object.keys(cfg.chatPolicy ?? {})) if (k !== "wezard") bases.add(k);
for (const t of Object.keys(mirror)) { const b = t.split("#")[0]; if (!b.startsWith("wezard:")) bases.add(b); }
const chatName = (b) => Object.entries(cfg.chats ?? {}).find(([, v]) => v === b)?.[0] ?? "";
const N = (t) => store.get(t)?.name ?? "";
const rows = [];
const flags = [];
for (const base of [...bases].sort()) {
  const bound = appointedSteward(cfg, base);
  const r = stewardRoute(cfg, store, base, cwdOf);
  const untagged = store.get(base);
  let source;
  if (bound) { source = store.byName(bound) ? "config 绑定 " + bound : "悬空绑定 " + bound + " (回落)"; }
  else if (untagged) source = "untagged 默认会话";
  else if (r.target !== base) source = "全局管家接待 (新开化身)";
  else source = "落空";
  const arm = isStewardTarget(cfg, store, r.target) ? (attached(r.target) ? "arm" : "arm(冷)") : "-";
  const kind = store.get(r.target)?.kind ?? "";
  rows.push(["| " + base, chatName(base) || "-", r.target, N(r.target) || "?", kind || "-", source, arm, r.fresh ? "是" : ""].join(" | ") + " |");
  if (r.target === base && !untagged) flags.push(base + (chatName(base) ? " (" + chatName(base) + ")" : "") + ": 落空 (无 untagged 记录、无绑定、无全局管家)");
  if (bound && !store.byName(bound)) flags.push(base + ": 悬空绑定 steward=" + bound);
  if (attached(base) && !isStewardTarget(cfg, store, base)) flags.push(base + ": 默认会话在跑但新判定不是管家");
}
const all = store.all();
const identities = new Set(all.map((w) => w.identity || w.target));
const chatCount = new Set(all.map((w) => w.target.split("#")[0]).filter((b) => !b.startsWith("wezard:"))).size;
const gs = all.filter((w) => w.kind === "global-steward").map((w) => w.target);
const out = [];
out.push("== 管家接待解析表 (v3 dd8c890; 现场副本模拟 v3 boot: 迁移 " + mig.migrated + " 条, 全局管家锚点 " + gsBoot.target + ") ==");
out.push("全机: " + all.length + " 记录 / " + identities.size + " 身份 / " + chatCount + " 群; defaultChat = " + cfg.defaultChat + "; global-steward = " + (gs.join(", ") || "无"));
out.push("");
out.push("| 聊天 | 名字 | 管家化身 | 管家名 | kind | 绑定来源 | 手闸 | 新开 |");
out.push("|---|---|---|---|---|---|---|---|");
out.push(...rows);
out.push("");
out.push("== 落空 / 落错 / 行为变化点 ==");
out.push(flags.length ? flags.map((f) => "- " + f).join(" ") : "(无)");
console.log(out.join(String.fromCharCode(10)));