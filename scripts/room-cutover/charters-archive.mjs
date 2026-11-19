#!/usr/bin/env node
// room 切换 · 单步: state/charters/*.md (旧宪章) 整体移到 state/archive/charters-<ts>/, 不删。
// 缺省 dry-run: 列计数与目标目录; --apply 执行 rename (同卷, 原子); 打印回退命令。
// 回退: mv <archive>/*.md state/charters/
import { readdirSync, mkdirSync, renameSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const state = join(process.env.WEZARD_HOME || join(homedir(), ".wezard"), "state");
const src = join(state, "charters");
const files = existsSync(src) ? readdirSync(src).filter((f) => f.endsWith(".md")) : [];
const ts = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15);
const dst = join(state, "archive", "charters-" + ts);
console.log(files.length + " 份旧宪章: " + src + " → " + dst);
if (!process.argv.includes("--apply")) { console.log("(dry-run; 加 --apply 执行)"); process.exit(0); }
if (!files.length) process.exit(0);
mkdirSync(dst, { recursive: true });
for (const f of files) renameSync(join(src, f), join(dst, f));
console.log("已移走 " + files.length + " 份。回退: mv " + JSON.stringify(dst) + "/*.md " + JSON.stringify(src) + "/");
