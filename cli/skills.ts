#!/usr/bin/env node
// wezard skills —— 内置 skill (包内 skills/) 的落地状态, 以及人主动的三种操作:
// 不想要了 (remove) / 我自己管 (pin) / 强制重装 (install --force)。
// 自动路径不在这里: wezard init 收尾和每次 spawn 前的 ensureBundledSkills 都会物化,
// 所以 list 只是给人看一眼的镜子。拉 GitHub 的 update 是二期 (一期跟发版)。
import { join } from "node:path";
import { loadConfig } from "../shared/config.js";
import { expandHome } from "../shared/paths.js";
import {
  bundleRoot, bundledSkillNames, clearSkillHold, materializeSkill, packageVersion, pinSkill, readStamps,
  removeSkill, scanSkillDir, skillDirOf,
  type SkillStamp,
} from "../shared/skill-sync.js";

const c = {
  dim: (s: string) => "\x1b[2m" + s + "\x1b[0m",
  bold: (s: string) => "\x1b[1m" + s + "\x1b[0m",
  green: (s: string) => "\x1b[32m" + s + "\x1b[0m",
  yellow: (s: string) => "\x1b[33m" + s + "\x1b[0m",
  red: (s: string) => "\x1b[31m" + s + "\x1b[0m",
};

const stateDir = (): string => {
  try { return expandHome(loadConfig().config.daemon.stateDir); } catch { return expandHome("~/.wezard/state"); }
};

const stampLine = (stamp: SkillStamp | undefined): string =>
  stamp?.pinned ? "pinned (wezard 不管它)"
  : stamp?.removed ? "已移除 (不会被自动装回)"
  : stamp ? "wezard 管理, 上次物化于 " + stamp.version
  : "无 stamp (不是 wezard 装的: 内容不同则永不覆盖)";

const diffCount = (installed: Array<{ rel: string; sha: string }>, bundled: Array<{ rel: string; sha: string }>): number => {
  const want = new Map(bundled.map((f) => [f.rel, f.sha]));
  return installed.filter((f) => want.get(f.rel) !== f.sha).length;
};

const list = (dir: string): void => {
  const names = bundledSkillNames();
  if (!names.length) {
    console.log(c.yellow("包内没有内置 skill (skills/ 目录缺失?)"));
    return;
  }
  const stamps = readStamps(dir);
  console.log(c.dim("包内版本 " + packageVersion() + " · 落地目录 " + join(dir, "skills")));
  for (const name of names) {
    const bundled = scanSkillDir(join(bundleRoot(), name)) ?? [];
    const installed = scanSkillDir(skillDirOf(dir, name));
    console.log("\n  " + c.bold(name) + c.dim("  包内 " + bundled.length + " 文件"));
    if (!installed) {
      console.log("    未安装 · " + c.dim(stampLine(stamps[name])));
      continue;
    }
    const diff = diffCount(installed, bundled);
    console.log("    落地 " + installed.length + " 文件" + (diff ? c.yellow(" · " + diff + " 个与包内不同 (会保留)") : c.dim(" · 与包内一致")));
    console.log("    " + c.dim(stampLine(stamps[name])));
  }
  console.log(c.dim("\n  wezard skills install [名字] [--force]  ·  remove  ·  pin / unpin  ·  update (二期)"));
};

const main = (): void => {
  const cmd = process.argv[2] ?? "list";
  const name = process.argv.slice(3).find((a) => !a.startsWith("--"));
  const force = process.argv.includes("--force");
  const dir = stateDir();
  const names = bundledSkillNames();
  const targets = name ? names.filter((n) => n === name) : names;
  if (name && !targets.length) {
    console.error(c.red("包内没有名为 " + name + " 的 skill"));
    process.exit(1);
  }
  switch (cmd) {
    case "list": return list(dir);
    case "install": {
      for (const n of targets) {
        // 显式 install = 「我要它装好」: 清掉 pinned / removed 并按包内这版装回,
        // 但仍不覆盖用户改过或自己写过的文件 —— 那要 --force。
        if (!force) clearSkillHold(dir, n);
        const r = materializeSkill(dir, n, { force, revive: !force });
        console.log(c.green("  ✓ " + n + ": " + r.mode + " (" + r.wrote + " 文件)") +
          (r.skipped.length ? c.dim("  保留你改过的: " + r.skipped.join(", ")) : ""));
        if (r.mode === "foreign") console.log(c.yellow("    这个目录不是 wezard 装的且内容不同, 未覆盖; 要覆盖加 --force"));
      }
      return;
    }
    case "remove": {
      for (const n of targets) {
        removeSkill(dir, n);
        console.log(c.green("  ✓ 已移除 " + n) + c.dim("  (之后不会再自动装回; 想装回用 wezard skills install)"));
      }
      return;
    }
    case "pin":
    case "unpin": {
      for (const n of targets) {
        pinSkill(dir, n, cmd === "pin");
        console.log(c.green("  ✓ " + n + ": " + (cmd === "pin" ? "pinned, wezard 不再改它" : "unpinned, 回到 wezard 管理")));
      }
      return;
    }
    case "update":
      console.log(c.yellow("  update 从 GitHub 拉最新版是二期, 本期跟 wezard 发版走: 升级 wezard 后第一次 spawn 自动合并。"));
      console.log(c.dim("  想立刻拿包内这版: wezard skills install --force"));
      return;
    default:
      console.error("用法: wezard skills [list|install|remove|pin|unpin|update] [名字] [--force]");
      process.exit(1);
  }
};

try { main(); }
catch (e) {
  console.error(c.red("[wezard-skills] " + (e as Error).message));
  process.exit(1);
}
