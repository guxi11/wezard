#!/usr/bin/env node
// room 切换 · 2a 步 (只读): 用指定 dist 的 loadConfig 解析一份 config, 不连 WS、不起 daemon。
// 用法: WEZARD_CONFIG=<config 副本> node scripts/room-cutover/config-check.mjs [<dist 目录>]
//   dist 缺省 = 本脚本所在仓库的 dist。exit 0 = 解析通过; exit 1 = 校验失败 (打印 zod 问题清单)。
// 只读: 不写任何文件; secrets.json 照 daemon 的方式合并读入 (只读)。
import { resolve, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { existsSync } from "node:fs";

const here = dirname(fileURLToPath(import.meta.url));
const dist = resolve(process.argv[2] ?? join(here, "..", "..", "dist"));
const mod = join(dist, "shared", "config.js");
if (!existsSync(mod)) { console.error("config-check: 找不到 " + mod + " (先 npm run build)"); process.exit(2); }
if (!process.env.WEZARD_CONFIG) { console.error("config-check: 必须用 WEZARD_CONFIG 指向要检查的副本 (不默认读线上文件)"); process.exit(2); }
const { loadConfig } = await import(pathToFileURL(mod).href);
try {
  const { config, sourcePath } = loadConfig();
  const pol = config.chatPolicy ?? {};
  const legacy = Object.entries(pol).flatMap(([k, v]) => ["topOnly", "speech"].filter((x) => v && typeof v === "object" && x in v).map((x) => k + "." + x));
  console.log("config-check: OK " + sourcePath);
  console.log("  chatPolicy 条目 " + Object.keys(pol).length + ", 残留旧键 " + legacy.length + (legacy.length ? " (" + legacy.join(", ") + "; passthrough 忽略, daemon boot 会 warn)" : ""));
  console.log("  rooms.watchdog " + JSON.stringify(config.rooms?.watchdog));
  process.exit(0);
} catch (e) {
  console.error(String(e?.message ?? e));
  process.exit(1);
}
