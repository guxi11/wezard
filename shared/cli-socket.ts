// CLI 进程 (init / audit / wx) 找 daemon 控制面 socket: env → 能读到的配置 → 缺省。
// 与 daemon-addr.ts 分开放: 那个文件只许依赖 node 内建 (relay 每 pane 一个进程), 而这里要读配置。
import { loadConfig } from "./config.js";
import { clientSocketPath } from "./daemon-addr.js";

/** 配置读不出来 (init 早期还没有) 就退到 env / 缺省路径, 不抛。 */
export const cliSocketPath = (): string => {
  try { return clientSocketPath(loadConfig().config); } catch { return clientSocketPath(); }
};
