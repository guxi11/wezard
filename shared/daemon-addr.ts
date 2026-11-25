// 控制面地址的单一派生: daemon 的 unix socket 路径只在这里拼, 别处不许本地拼
// (hook 脚本是 shell, 它抄一份同样的规则, 见 hooks/pre-tool-use.sh)。
//
// 只依赖 node 内建模块: mcp/relay.ts 每个 pane 一个进程, 不能为这一个函数拖进 zod / SDK。
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** 解析用的最小配置形状 (daemon.socket / daemon.stateDir), 免得这里 import 整个 Config。 */
export interface DaemonAddrCfg {
  daemon: { socket?: string; stateDir: string };
}

/** sun_path: macOS 104 字节 / Linux 108, 都含结尾 NUL —— 取小的那个减一。 */
export const MAX_SOCK_PATH_BYTES = 103;

const expand = (p: string): string =>
  p.startsWith("~") ? resolve(homedir(), p.slice(p.startsWith("~/") ? 2 : 1)) : resolve(p);

const SOCK_REL = join("run", "daemon.sock");

/** 缺省路径: `<stateDir>/run/daemon.sock`。 */
export const defaultSocketIn = (stateDir: string): string => join(expand(stateDir), SOCK_REL);

/** daemon 侧 (已读到配置): `daemon.socket` 非空用它, 否则 `<stateDir>/run/daemon.sock`。 */
export const daemonSocketPath = (cfg: DaemonAddrCfg): string =>
  cfg.daemon.socket?.trim() ? expand(cfg.daemon.socket.trim()) : defaultSocketIn(cfg.daemon.stateDir);

/** 读不到配置的客户端 (hook / relay): env `WEZARD_DAEMON_SOCK` → `${WEZARD_STATE_DIR:-~/.wezard/state}/run/daemon.sock`。 */
export const socketFromEnv = (env: NodeJS.ProcessEnv = process.env): string =>
  env.WEZARD_DAEMON_SOCK?.trim() || defaultSocketIn(env.WEZARD_STATE_DIR?.trim() || "~/.wezard/state");

/** 能读配置的客户端 (CLI): env 优先 (daemon 起的子进程都带), 其次配置, 最后缺省。 */
export const clientSocketPath = (cfg?: DaemonAddrCfg, env: NodeJS.ProcessEnv = process.env): string =>
  env.WEZARD_DAEMON_SOCK?.trim() || (cfg ? daemonSocketPath(cfg) : socketFromEnv(env));

/** 路径过长则返回人话错误, 否则 undefined (启动时检查, 超长直接报错退出)。 */
export const sockPathProblem = (path: string): string | undefined =>
  Buffer.byteLength(path) > MAX_SOCK_PATH_BYTES
    ? `unix socket 路径过长 (${Buffer.byteLength(path)} 字节 > ${MAX_SOCK_PATH_BYTES}, sun_path 的上限): ${path} —— 把 daemon.socket 设短一点, 例如 ~/.wezard/d.sock`
    : undefined;
