// daemon 写敏感路由 (/config/set) 的口令。HTTP 在 127.0.0.1 上谁都连得到, 请求体里的
// sessionId / tmuxPane 又都猜得出 —— 所以写配置要出示一个只有本机这个用户读得到的
// 文件 (0600) 里的值: wezard 自己的 MCP server 与 CLI 读它, 模型要 `cat` 它得先过审批卡。
// daemon 开机生成 (已有就沿用), 别的进程只读不建。
import { readFileSync } from "node:fs";
import { expandHome } from "./paths.js";

export const DAEMON_TOKEN_FILE = "~/.wezard/daemon-token";
export const DAEMON_TOKEN_HEADER = "x-wezard-token";

/** 读出口令; 文件不在 / 读不了 = ""。 */
export const readDaemonToken = (file: string = DAEMON_TOKEN_FILE): string => {
  try {
    return readFileSync(expandHome(file), "utf8").trim();
  } catch {
    return "";
  }
};
