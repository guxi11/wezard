// wezard 的 MCP 也改成**按会话注入** —— 全机 settings.json / mcp.json 里不再有它。
//
// 为什么: 全局注册会让每个人自己开的 CLI 会话都起一个 `node dist/mcp/server.js`,
// 白付一次进程启动 (实测 initialize 往返约 119ms) 而那个会话根本不会用到 wezard 的工具。
// wezard 自己 spawn 的 pane 在启动行上带 `--mcp-config <file>` (claude / claude-internal /
// codebuddy 都认这个参数, 见各 CLI --help), 工具面一个不少; codex 走它自己的 `-c`
// 覆盖 (daemon/spawn-tmux.ts), 不用这里的产物。
//
// 不加 `--strict-mcp-config`: 那会把用户自己配的 lisct / tapd 等一起挡掉。
//
// 传输: 一律 stdio 子进程 (默认是 mcp/relay.js, 经 unix socket 转给 daemon 的 POST /mcp) ——
// 不再有 `type:"http"` 直连: 任何留给 MCP 的 TCP 端口都能在 daemon 重启空窗被抢占。
import { existsSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { writeIfChanged } from "./session-hooks.js";

/** relay = 每 pane 一个只用 node 内建模块的小进程 (mcp/relay.js, 默认); stdio = 全量 mcp/server.js (排障用)。 */
export type McpTransport = "relay" | "stdio";

export interface SessionMcpSpec {
  /** `--mcp-config` 指向的产物。 */
  file: string;
}

/** 新文件名本身就是「这个 pane 起于新控制面 (unix socket)」的判据: 旧版的
 *  session-mcp.json / session-mcp-http.json 不再生成, daemon 启动时清掉 (见 `removeLegacyMcpFiles`)。 */
export const SESSION_MCP_FILE = "session-mcp-sock.json";

/** 旧版产物。http 那份里是口令原文, 留在盘上就是个泄露点。 */
export const LEGACY_MCP_FILES = ["session-mcp.json", "session-mcp-http.json"] as const;

/** dist/shared → dist/mcp/<name>.js (dev tsx: shared/ → dist/mcp/<name>.js)。 */
const mcpScript = (name: string): string => {
  const here = dirname(fileURLToPath(import.meta.url));
  return [resolve(here, "..", "mcp", name), resolve(here, "..", "dist", "mcp", name)]
    .find((p) => existsSync(p)) ?? resolve(here, "..", "dist", "mcp", name);
};

/** 按传输选入口: relay.js (默认) 或全量 server.js —— 两个 dist 路径都是 load-bearing。 */
export const mcpEntry = (transport: McpTransport): string => mcpScript(transport === "stdio" ? "server.js" : "relay.js");

const configOf = (transport: McpTransport, socketPath: string): string => `${JSON.stringify({
  mcpServers: { wezard: { command: "node", args: [mcpEntry(transport)], env: { WEZARD_DAEMON_SOCK: socketPath } } },
}, null, 2)}\n`;

/** 写产物并返回路径。写不出来直接抛: 没有 MCP 的 pane 会静默少掉整套协作工具,
 *  比 spawn 失败更难查。里面没有口令 (relay 每次现读口令文件), 不必收紧权限。 */
export const prepareSessionMcp = (
  stateDir: string,
  opts: { socketPath: string; transport: McpTransport },
): SessionMcpSpec => {
  const file = join(stateDir, SESSION_MCP_FILE);
  writeIfChanged(file, configOf(opts.transport, opts.socketPath));
  return { file };
};

/** 后端对应的注入参数; codex 不用 (它走 spawn-tmux 里的 `-c` 覆盖)。 */
export const sessionMcpArgs = (spec: SessionMcpSpec): string[] => ["--mcp-config", spec.file];

/** daemon 启动时调: 删掉旧版产物, 返回删掉了哪些 (不存在的不算)。 */
export const removeLegacyMcpFiles = (stateDir: string): string[] =>
  LEGACY_MCP_FILES.filter((name) => {
    const p = join(stateDir, name);
    if (!existsSync(p)) return false;
    try { rmSync(p, { force: true }); return true; } catch { return false; }
  });
