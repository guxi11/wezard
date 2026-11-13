// 单元测试: wezard MCP 的按会话注入产物 — 运行: npx tsx tests/session-mcp.test.ts
//
// 目标: 全机 mcp.json / settings 里不再有 wezard, 改为 spawn 时 `--mcp-config`。
// 这里钉住四件事: (1) 产物里的入口是真实存在的 dist/mcp/server.js (指向不存在的
// 路径 = pane 静默少掉整套协作工具); (2) 重复调用不重写 (每次 spawn 都会调);
// (3) 后端 → 参数映射 (codebuddy 在 http 传输下换用 http 那份);
// (4) http 形态带口令头, 且没口令时回落 stdio 而不是写个进不去的入口。
import assert from "node:assert";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareSessionMcp, sessionMcpArgs } from "../shared/session-mcp.js";

type McpFile = { mcpServers: Record<string, Record<string, unknown>> };

const dir = mkdtempSync(join(tmpdir(), "wezard-session-mcp-"));
try {
  const spec = prepareSessionMcp(dir, { port: 17890, transport: "stdio" });
  const stdio = JSON.parse(readFileSync(spec.stdioFile, "utf8")) as McpFile;
  const entry = stdio.mcpServers.wezard!;
  const args = entry.args as string[];
  assert.equal(entry.command, "node");
  assert.equal(args.length, 1);
  assert.ok(args[0]!.endsWith("/mcp/server.js"), `入口应指向 dist/mcp/server.js, 实际: ${args[0]}`);
  assert.ok(existsSync(args[0]!), "入口文件必须真实存在");
  assert.equal(spec.httpFile, undefined, "stdio 传输不该写 http 那份");

  // 每次 spawn 都会调: 内容没变就不该重写 (mtime 不动)。
  const before = statSync(spec.stdioFile).mtimeMs;
  prepareSessionMcp(dir, { port: 17890, transport: "stdio" });
  assert.equal(statSync(spec.stdioFile).mtimeMs, before, "同样内容重复调用不应重写");

  // 后端 → 参数: 只加 --mcp-config, 绝不加 --strict-mcp-config (那会挡掉用户自己的 MCP)。
  assert.deepEqual(sessionMcpArgs("claude", spec), ["--mcp-config", spec.stdioFile]);
  assert.deepEqual(sessionMcpArgs("claude-internal", spec), ["--mcp-config", spec.stdioFile]);
  assert.deepEqual(sessionMcpArgs("codebuddy", spec), ["--mcp-config", spec.stdioFile]);

  console.log("session-mcp.test: ok");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
