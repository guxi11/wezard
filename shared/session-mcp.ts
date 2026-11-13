// wezard 的 MCP 也改成**按会话注入** —— 全机 settings.json / mcp.json 里不再有它。
//
// 为什么: 全局注册会让每个人自己开的 CLI 会话都起一个 `node dist/mcp/server.js`,
// 白付一次进程启动 (实测 initialize 往返约 119ms) 而那个会话根本不会用到 wezard 的工具。
// wezard 自己 spawn 的 pane 在启动行上带 `--mcp-config <file>` (claude / claude-internal /
// codebuddy 都认这个参数, 见各 CLI --help), 工具面一个不少; codex 走它自己的 `-c`
// 覆盖 (daemon/spawn-tmux.ts), 不用这里的产物。
//
// 不加 `--strict-mcp-config`: 那会把用户自己配的 lisct / tapd 等一起挡掉。
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DAEMON_TOKEN_FILE, DAEMON_TOKEN_HEADER, readDaemonToken } from "./daemon-token.js";
import { writeIfChanged } from "./session-hooks.js";

export interface SessionMcpSpec {
  /** stdio 形态: 每个 pane 一个 `node dist/mcp/server.js` 子进程。所有后端都认。 */
  stdioFile: string;
  /** http 形态: 直连 daemon 的 `POST /mcp`; 配了 http 传输且后端认 `type:"http"` 时用它。 */
  httpFile?: string;
}

/** 认 `--mcp-config` 里 `type:"http"` 的后端。本机实测 2026-11-13: claude 2.1.84 /
 *  claude-internal 2.1.154 / codebuddy 2.181 三个都连得上, 且都把 headers 里的
 *  `${TMUX_PANE}` 按进程环境展开。codex 不走 `--mcp-config` (spawn-tmux 的 `-c` 覆盖),
 *  不在名单里 —— 名单之外一律回落 stdio, 否则把默认值改成 http 就等于给那个后端
 *  悄悄摘掉整套协作工具。 */
const HTTP_MCP_BACKENDS = new Set(["claude", "claude-internal", "codebuddy"]);

/** 该后端能否直连 daemon 的 /mcp (spawn 时决定用哪份产物)。 */
export const supportsHttpMcp = (backendName: string): boolean => HTTP_MCP_BACKENDS.has(backendName);

/** dist/shared → dist/mcp/server.js (dev tsx: shared/ → dist/mcp/server.js)。 */
const mcpEntry = (): string => {
  const here = dirname(fileURLToPath(import.meta.url));
  return [resolve(here, "..", "mcp", "server.js"), resolve(here, "..", "dist", "mcp", "server.js")]
    .find((p) => existsSync(p)) ?? resolve(here, "..", "dist", "mcp", "server.js");
};

const stdioConfig = (): string => `${JSON.stringify({
  mcpServers: { wezard: { command: "node", args: [mcpEntry()] } },
}, null, 2)}\n`;

/** 口令是 0600 文件的现读值, 会落进这份配置: 所以写完把它收成 0600。
 *  `${TMUX_PANE}` 是留给 codebuddy 自己展开的字面量, 别改成模板插值。 */
const httpConfig = (port: number, token: string): string => `${JSON.stringify({
  mcpServers: {
    wezard: {
      type: "http",
      url: `http://127.0.0.1:${port}/mcp`,
      headers: {
        [DAEMON_TOKEN_HEADER]: token,
        "x-wezard-pane": "${TMUX_PANE}",
        "x-wezard-session": "${CODEBUDDY_SESSION_ID:-}",
      },
    },
  },
}, null, 2)}\n`;

/** 写产物并返回路径。stdio 那份写不出来直接抛: 没有 MCP 的 pane 会静默少掉整套
 *  协作工具, 比 spawn 失败更难查。 */
export const prepareSessionMcp = (
  stateDir: string,
  opts: { port: number; transport: "stdio" | "http" },
): SessionMcpSpec => {
  const stdioFile = join(stateDir, "session-mcp.json");
  writeIfChanged(stdioFile, stdioConfig());
  if (opts.transport !== "http") return { stdioFile };
  const token = readDaemonToken();
  if (!token) {
    // 与 cli/sync.ts 同口径: 没有口令就到不了 /mcp, 写个进不去的入口不如给 stdio。
    // eslint-disable-next-line no-console
    console.warn(`[wezard] WARN: daemon.mcpTransport=http 但读不到 ${DAEMON_TOKEN_FILE}, 本次回落 stdio 形态。`);
    return { stdioFile };
  }
  const httpFile = join(stateDir, "session-mcp-http.json");
  try {
    writeIfChanged(httpFile, httpConfig(opts.port, token));
    // 这份文件里是口令原文: 权限收紧到只有自己可读。
    chmodSync(httpFile, 0o600);
  } catch (e) {
    // 写不出来只回落 stdio: pane 少几个进程好过少一整套工具面。
    // eslint-disable-next-line no-console
    console.warn(`[wezard] WARN: 写 ${httpFile} 失败 (${(e as Error).message}), 本次回落 stdio 形态。`);
    return { stdioFile };
  }
  return { stdioFile, httpFile };
};

/** 后端对应的注入参数; codex 不用 (它走 spawn-tmux 里的 `-c` 覆盖)。 */
export const sessionMcpArgs = (backendName: string, spec: SessionMcpSpec): string[] =>
  ["--mcp-config", spec.httpFile && supportsHttpMcp(backendName) ? spec.httpFile : spec.stdioFile];
