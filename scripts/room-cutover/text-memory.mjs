#!/usr/bin/env node
// room 切换 · 单步: 改写 ~/.wezard/memory 下 3 个 md 与 1 个定时任务 prompt 里的旧工具/旧概念。
// 每条规则在文件里必须恰好命中一次, 否则整步中止 (一个字不写)。
//   缺省 dry-run: 每个文件 diff -u
//   --apply: 每个文件先写 <file>.pre-room-<ts>.bak, 再原子落盘; 打印逐文件回退命令
import { readFileSync, writeFileSync, copyFileSync, renameSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, basename } from "node:path";
import { spawnSync } from "node:child_process";

const home = process.env.WEZARD_HOME || join(homedir(), ".wezard");
const apply = process.argv.includes("--apply");
// line: 以该前缀开头的整行 → to (null = 删行); sub: 子串 → to
const RULES = [
  { file: "memory/chats/chat_wrkSFfCgAARRjbH-nA8y9h6gJT63pRIg.md", line: "- aiconfig 群成员表里没有 GraceVance",
    to: "- aiconfig 群里 GraceVance 不是成员: 要在该群发言须由 host 或人 room_invite 拉它入群。" },
  { file: "memory/workspaces/-Users-zyy-develop-Tencent-aiservice-daily-eng-case-triage.md", line: "- 终句正文别写 `@name RESULT:`",
    to: "- 终句不进群、不关账; 交付结论走 chat_reply({re, text, status}), 正文里写不写 @name 都没有路由副作用。" },
  { file: "memory/workspaces/-Users-zyy-develop-Guxi11-cc-wecom.md", line: "严格治理(P7):",
    to: "sparePool.maxTotal 配 4/源码 2。" },
  { file: "memory/workspaces/-Users-zyy-develop-Guxi11-cc-wecom.md", line: "strict 义务链(2026-11-18",
    to: "room 模型(2026-11-19 切换): 沟通只剩 room 账本 (~/.wezard/rooms/*.jsonl); 完成的唯一信号=duty 处理人的 chat_reply status (done/passed/canceled), 终句零语义; 成员即发言权, 唤醒额度每 room 10 分钟 20 次; 未交代的 duty 当轮提醒一次, 再闲升级一条 system 行进 room 并镜像进群。" },
  { file: "memory/workspaces/-Users-zyy-develop-Guxi11-cc-wecom.md", line: "strict 出站不挂义务(2026-11-18",
    to: "出站一次到位: 结论一条 chat_reply 讲完, 带文件同轮 send_file 不重复正文; 不轮换通道试探; 打断别人只用 interrupt:true (限直属 parent / host / 人)。" },
  { file: "tasks/review-summary-nightly-2.task.mjs", sub: "卡住超过 5 分钟就 tell_peer 推动它继续",
    to: "卡住超过 5 分钟就在你们共在的 room 里 chat_say 点它继续" },
];

const byFile = new Map();
for (const r of RULES) byFile.set(r.file, [...(byFile.get(r.file) ?? []), r]);
const plans = [];
for (const [rel, rules] of byFile) {
  const file = join(home, rel);
  const src = readFileSync(file, "utf8");
  let out = src;
  for (const r of rules) {
    if (r.line) {
      const lines = out.split("\n");
      const hit = lines.map((l, i) => (l.startsWith(r.line) ? i : -1)).filter((i) => i >= 0);
      if (hit.length !== 1) { console.error("中止: " + rel + " 前缀命中 " + hit.length + " 次: " + r.line); process.exit(2); }
      if (r.to === null) lines.splice(hit[0], 1); else lines[hit[0]] = r.to;
      out = lines.join("\n");
    } else {
      const n = out.split(r.sub).length - 1;
      if (n !== 1) { console.error("中止: " + rel + " 子串命中 " + n + " 次: " + r.sub); process.exit(2); }
      out = out.replace(r.sub, r.to);
    }
  }
  if (out !== src) plans.push({ file, out });
}
for (const p of plans) {
  const tmp = join(tmpdir(), "wezard-text-memory-" + basename(p.file));
  writeFileSync(tmp, p.out);
  process.stdout.write(spawnSync("diff", ["-u", p.file, tmp], { encoding: "utf8" }).stdout);
}
console.log("\n共 " + plans.length + " 个文件");
if (!apply) { console.log("(dry-run; 加 --apply 落盘)"); process.exit(0); }
const ts = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15);
for (const p of plans) {
  const bak = p.file + ".pre-room-" + ts + ".bak";
  copyFileSync(p.file, bak);
  writeFileSync(p.file + ".tmp", p.out);
  renameSync(p.file + ".tmp", p.file);
  console.log("回退: cp " + JSON.stringify(bak) + " " + JSON.stringify(p.file));
}
