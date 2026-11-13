// 只读探针: 量现有 renderRoster 在现场数据上的实际行宽/总量 —— P4 预算的依据。不写现场文件、不碰 daemon。
import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { loadConfig } from "../dist/shared/config.js";
import { loadWizardStore, migrateIdentities, renderRoster, handoffAt } from "../dist/daemon/wizard.js";
const home = homedir();
const cfg = (loadConfig(join(home, ".wezard/config.jsonc"))).config;
const raw = JSON.parse(readFileSync(join(home, ".wezard/wizards.json"), "utf8"));
const mirror = JSON.parse(readFileSync(join(home, ".wezard/mirror-attachments.json"), "utf8"));
import { mkdtempSync, copyFileSync } from "node:fs"; import { tmpdir } from "node:os";
const tmp = mkdtempSync(join(tmpdir(), "measure-"));
copyFileSync(join(home, ".wezard/wizards.json"), join(tmp, "w.json"));
const store = loadWizardStore(join(tmp, "w.json"), () => undefined);
migrateIdentities(store, join(tmp, "w.json"));
const chatName = (b) => Object.entries(cfg.chats ?? {}).find(([, v]) => v === b)?.[0] ?? "";
const rows = store.all().map((w) => ({
  name: w.name || "?", address: w.name || "?", description: w.description || "",
  ...(w.expertise ? { expertise: w.expertise } : {}),
  cwd: (mirror[w.target]?.cwd) || "", chat: chatName(w.target.split("#")[0]), solo: w.target.startsWith("user:"),
  busy: false, alive: !!mirror[w.target], self: false, lastActivity: mirror[w.target] ? Date.now() : 0,
  summary: "", clones: [], parent: undefined, turns: "", model: "", contextTokens: 0,
}));
const text = renderRoster(rows, Date.now(), home);
const ls = text.split(String.fromCharCode(10));
const withDesc = ls.filter((l) => l.startsWith("  ")).length;
const head = ls.filter((l) => !l.startsWith("  "));
const avgHead = head.reduce((a, l) => a + l.length, 0) / Math.max(head.length, 1);
const avgAll = ls.reduce((a, l) => a + l.length, 0) / Math.max(ls.length, 1);
console.log("rows:", rows.length, "rendered lines:", ls.length, "(head", head.length, "+ sub", withDesc, ")");
console.log("avg head line chars:", avgHead.toFixed(0), "| avg all line chars:", avgAll.toFixed(0));
console.log("full-machine flat render chars:", text.length, "≈ tokens(x0.55):", Math.round(text.length * 0.55));
console.log("L0=12 lines ≈ chars:", Math.round(avgAll * 12), "≈ tokens:", Math.round(avgAll * 12 * 0.55));
console.log("L1=40 lines ≈ chars:", Math.round(avgAll * 40), "≈ tokens:", Math.round(avgAll * 40 * 0.55));
console.log("handoffAt(claude-opus-5.5):", handoffAt("claude-opus-5.5"), "| handoffAt(glm-5.3):", handoffAt("glm-5.3"));
console.log("chats:", new Set(rows.map((r) => r.chat)).size, "| named:", [...new Set(rows.map((r) => r.chat))].filter(Boolean).length);