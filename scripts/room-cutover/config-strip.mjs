#!/usr/bin/env node
// room 切换 · 单步: config.jsonc 删 chatPolicy.*.topOnly / speech 与 topOnly 注释。
// 缺省 dry-run (只出 diff); --apply 先写 <config>.pre-room-<ts>.bak 再原子落盘。
// 回退: cp <bak> ~/.wezard/config.jsonc (apply 时会打印这条命令)。
import { readFileSync, writeFileSync, copyFileSync, renameSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { modify, applyEdits, parse } from "jsonc-parser";

const file = process.env.WEZARD_CONFIG || join(homedir(), ".wezard", "config.jsonc");
const apply = process.argv.includes("--apply");
const src = readFileSync(file, "utf8");
const cfg = parse(src) ?? {};
let out = src;
const fmt = { formattingOptions: { insertSpaces: true, tabSize: 2 } };
for (const [k, v] of Object.entries(cfg.chatPolicy ?? {}))
  for (const key of ["topOnly", "speech"])
    if (v && typeof v === "object" && key in v) out = applyEdits(out, modify(out, ["chatPolicy", k, key], undefined, fmt));
out = out.replace(/; topOnly: 顶层模式, wizard↔wizard 全部私聊, 不冒泡。/, "。");

if (out === src) { console.log("config-strip: 无变化 (已清过)"); process.exit(0); }
const tmp = join(tmpdir(), "wezard-config-strip.jsonc");
writeFileSync(tmp, out);
process.stdout.write(spawnSync("diff", ["-u", file, tmp], { encoding: "utf8" }).stdout);
if (!apply) { console.log("\n(dry-run; 加 --apply 落盘)"); process.exit(0); }
const ts = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15);
const bak = file + ".pre-room-" + ts + ".bak";
copyFileSync(file, bak);
writeFileSync(file + ".tmp", out);
renameSync(file + ".tmp", file);
console.log("已落盘。回退: cp " + JSON.stringify(bak) + " " + JSON.stringify(file));
