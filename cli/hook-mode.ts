#!/usr/bin/env node
// 审批 hook 的开关: wezard use cli | wecom | status
// 只动 <stateDir>/approval-mode, 不碰 hook 注册 —— 注册留着, 切回来的成本才是一次
// 写文件, 而不是重写一遍各 CLI 的 settings.json。
import { loadConfig } from "../shared/config.js";
import { hookModePath, readHookMode, writeHookMode, type HookMode } from "../shared/hook-mode.js";

const argv = process.argv.slice(2);
const cmd = (argv[0] ?? "status").toLowerCase();
const { config: cfg } = loadConfig();
const stateDir = cfg.daemon.stateDir;

const describe = (mode: HookMode): string =>
  mode === "cli"
    ? "cli — hook 不拦, 工具调用交给本地 CLI 自己的权限框"
    : "wecom — hook 转发到 daemon, 审批卡发到企微";

if (cmd === "status") {
  console.log(`approval hook: ${describe(readHookMode(stateDir))}`);
  console.log(`  ${hookModePath(stateDir)}`);
} else if (cmd === "cli" || cmd === "wecom") {
  writeHookMode(stateDir, cmd);
  console.log(`[wezard] approval hook → ${describe(cmd)}`);
  // hook 每次调用都现读这个文件, 所以对已在跑的会话立即生效; 唯一例外是切换那一刻
  // 已经发出去的长轮询 (卡还挂在群里) —— 它按原路结束。
  console.log("[wezard] 已在跑的命令行会话无需重启; 切换前已发出的审批卡仍按原路结束。");
} else {
  console.error("usage: wezard use <cli|wecom|status>");
  process.exit(2);
}
