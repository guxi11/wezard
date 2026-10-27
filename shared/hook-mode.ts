// 审批 hook 的运行时开关: 一次工具调用的裁决权在谁手里。
//  - "wecom" (默认, 文件不存在) — hook 把调用长轮询给 daemon, 决策变成群里的卡片。
//  - "cli"                     — hook 什么都不答 (exit 0), CLI 用自己的权限流程在本地面板问人。
//
// 为什么是状态文件而不是配置项: daemon 停着、配置写坏了、reload 空窗里, hook 仍然
// 要能独立判出「这一轮别拦我」。读配置得先起 node 解析 jsonc, 一个 `cat` 做不到的事
// 就不该压在这个每次工具调用都要跑的热路径上。
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { expandHome } from "./paths.js";

export type HookMode = "wecom" | "cli";

export const hookModePath = (stateDir: string): string => join(expandHome(stateDir), "approval-mode");

export const readHookMode = (stateDir: string): HookMode =>
  (() => {
    try {
      return readFileSync(hookModePath(stateDir), "utf8").trim() === "cli" ? "cli" : "wecom";
    } catch {
      return "wecom";
    }
  })();

// 回到 wecom = 删文件, 不在盘上留一个「与默认同值」的残留: 默认只写在一处, 读侧就
// 不会出现「配置说 A、文件说 B」的二义。
export const writeHookMode = (stateDir: string, mode: HookMode): void => {
  const path = hookModePath(stateDir);
  if (mode === "wecom") {
    rmSync(path, { force: true });
    return;
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "cli\n");
};
