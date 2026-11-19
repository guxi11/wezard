#!/usr/bin/env node
// room 切换 · 单步: 改写 wizards.json 里各 wizard self 记忆中引用旧工具/旧概念的条目。
// 只动 memory 数组, 不碰其它字段。必须在 daemon 停着时跑 (daemon 会写 wizards.json)。
//   缺省 dry-run: 逐身份列出 before → after
//   --apply: 写 <wizards.json>.pre-room-<ts>.bak + 反向补丁 <...>.room-memory-<ts>.patch.json, 原子落盘
//   --revert <patch>: 只把「当前 memory 仍等于 after」的身份还原成 before, 其余报冲突跳过
//                     (切换后新 spawn 的身份、daemon 回填的 uid 都不会被冲掉)
import { readFileSync, writeFileSync, copyFileSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const file = join(process.env.WEZARD_HOME || join(homedir(), ".wezard"), "wizards.json");
const argv = process.argv.slice(2);
const save = (obj) => { writeFileSync(file + ".tmp", JSON.stringify(obj, null, 2) + "\n"); renameSync(file + ".tmp", file); };
const db = JSON.parse(readFileSync(file, "utf8"));

if (argv[0] === "--revert") {
  const patch = JSON.parse(readFileSync(argv[1], "utf8"));
  let ok = 0, skip = 0;
  for (const p of patch) {
    const cur = db[p.key];
    if (cur && JSON.stringify(cur.memory ?? []) === JSON.stringify(p.after)) { cur.memory = p.before; ok++; }
    else { console.log("冲突跳过 (memory 已被改动或身份已不在): " + p.key); skip++; }
  }
  save(db);
  console.log("revert: 还原 " + ok + " 个身份, 跳过 " + skip);
  process.exit(0);
}

// 规则: startsWith 命中整条; to = null 删除 / string 整条替换 / [from, to] 条内替换
const RULES = [
  { startsWith: "对人说话的终句不要带 RESULT:/NEED: 前缀",
    to: "终句不进任何群、不关任何 duty: 给人的结论用 chat_reply({re, text}) 交付; 正文别写 RESULT:/NEED: 这类旧回执标记。" },
  { startsWith: "技术取舍不归管家裁决",
    to: ["把人的原话转回原执行者 (tell_peer re), 让它自己继续", "把人的原话转回原执行者 (同一 room 里 chat_ask 点它), 让它自己继续"] },
  { startsWith: "wezard 回执轮终句必须以行首", to: null },
  { startsWith: "ledger resume 死循环的正解", to: null },
  { startsWith: ".review-1029 的 route e242a15.1", to: null },
  { startsWith: "S2 已放行 (wezard 2026-11-13", to: ['read_chat({role:"wezard"}) 可读全文', "room_read 可读全文"] },
];

const patch = [];
for (const [key, rec] of Object.entries(db)) {
  const before = rec?.memory;
  if (!Array.isArray(before) || !before.length) continue;
  const after = [];
  for (const m of before) {
    const r = typeof m === "string" ? RULES.find((x) => m.startsWith(x.startsWith)) : undefined;
    if (!r) { after.push(m); continue; }
    if (r.to === null) continue;
    if (typeof r.to === "string") { after.push(r.to); continue; }
    if (!m.includes(r.to[0])) { console.error("规则未命中条内片段, 中止: " + key + " / " + r.startsWith); process.exit(2); }
    after.push(m.replace(r.to[0], r.to[1]));
  }
  if (JSON.stringify(after) !== JSON.stringify(before)) patch.push({ key, before, after });
}

const cut = (s) => (s.length > 90 ? s.slice(0, 90) + "…" : s);
for (const p of patch) {
  console.log("== " + p.key);
  const gone = p.before.filter((m) => !p.after.includes(m));
  const added = p.after.filter((m) => !p.before.includes(m));
  gone.forEach((m) => console.log("  - " + cut(m)));
  added.forEach((m) => console.log("  + " + cut(m)));
}
console.log("\n共 " + patch.length + " 个身份、" + patch.reduce((n, p) => n + p.before.filter((m) => !p.after.includes(m)).length, 0) + " 条变更");
if (!argv.includes("--apply")) { console.log("(dry-run; 加 --apply 落盘)"); process.exit(0); }
if (!patch.length) process.exit(0);
const ts = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15);
const bak = file + ".pre-room-" + ts + ".bak";
const pf = file + ".room-memory-" + ts + ".patch.json";
copyFileSync(file, bak);
writeFileSync(pf, JSON.stringify(patch, null, 2));
for (const p of patch) db[p.key].memory = p.after;
save(db);
console.log("已落盘。回退: node scripts/room-cutover/wizard-memory.mjs --revert " + JSON.stringify(pf) + "  (整份兜底: " + bak + ")");
