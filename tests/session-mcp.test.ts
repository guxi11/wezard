// 单元测试: wezard MCP 的按会话注入产物 — 运行: npx tsx tests/session-mcp.test.ts
//
// 目标: 全机 mcp.json / settings 里不再有 wezard, 改为 spawn 时 `--mcp-config`。
// 钉住: (1) 产物里的入口是真实存在的 relay.js / server.js (指向不存在的路径 = pane 静默少掉整套
// 协作工具), 且带 env.WEZARD_DAEMON_SOCK, 不含口令; (2) 重复调用不重写 (每次 spawn 都会调);
// (3) 新文件名 session-mcp-sock.json, 旧产物被 daemon 启动清理; (4) 参数只加 --mcp-config。
import assert from "node:assert";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as mod from "../shared/session-mcp.js";
import { prepareSessionMcp, removeLegacyMcpFiles, sessionMcpArgs } from "../shared/session-mcp.js";

type McpFile = { mcpServers: Record<string, Record<string, unknown>> };

const dir = mkdtempSync(join(tmpdir(), "wezard-session-mcp-"));
const SOCK = join(dir, "run", "daemon.sock");
try {
  // relay (缺省): 入口是 mcp/relay.js
  const spec = prepareSessionMcp(dir, { socketPath: SOCK, transport: "relay" });
  assert.equal(spec.file, join(dir, "session-mcp-sock.json"), "新文件名 = 起于新控制面的判据");
  const raw = readFileSync(spec.file, "utf8");
  const cfg = JSON.parse(raw) as McpFile;
  const entry = cfg.mcpServers.wezard!;
  const args = entry.args as string[];
  assert.equal(entry.command, "node");
  assert.equal(args.length, 1);
  assert.ok(args[0]!.endsWith("/mcp/relay.js"), `入口应指向 mcp/relay.js, 实际: ${args[0]}`);
  assert.deepEqual(entry.env, { WEZARD_DAEMON_SOCK: SOCK }, "带 socket 路径");
  assert.equal(entry.type, undefined, "不再有 type:http");
  assert.ok(!/token/i.test(raw), "产物里没有口令");
  // dist 没构建时入口文件不存在, 但路径必须落在 dist/mcp 下 (load-bearing)
  assert.ok(/\/dist\/mcp\/relay\.js$/.test(args[0]!) || existsSync(args[0]!), "指向 dist/mcp/relay.js");

  // stdio: 入口是全量 server.js
  const stdio = prepareSessionMcp(dir, { socketPath: SOCK, transport: "stdio" });
  const sargs = (JSON.parse(readFileSync(stdio.file, "utf8")) as McpFile).mcpServers.wezard!.args as string[];
  assert.ok(sargs[0]!.endsWith("/mcp/server.js"), `stdio 入口应指向 mcp/server.js, 实际: ${sargs[0]}`);
  assert.equal(stdio.file, spec.file, "同一个文件名, 内容随传输换");

  // 每次 spawn 都会调: 内容没变就不该重写 (mtime 不动)。
  const before = statSync(spec.file).mtimeMs;
  prepareSessionMcp(dir, { socketPath: SOCK, transport: "stdio" });
  prepareSessionMcp(dir, { socketPath: SOCK, transport: "stdio" });
  assert.equal(statSync(spec.file).mtimeMs, before, "同样内容重复调用不应重写");

  // 参数: 只加 --mcp-config, 绝不加 --strict-mcp-config (那会挡掉用户自己的 MCP)。
  assert.deepEqual(sessionMcpArgs(spec), ["--mcp-config", spec.file]);

  // http 形态与 supportsHttpMcp 已删除
  assert.equal((mod as Record<string, unknown>).supportsHttpMcp, undefined, "supportsHttpMcp 已删除");

  // 旧产物: daemon 启动时清掉 (http 那份里有口令原文), 返回删了哪些; 幂等
  assert.deepEqual(removeLegacyMcpFiles(dir), []);
  writeFileSync(join(dir, "session-mcp.json"), "{}");
  writeFileSync(join(dir, "session-mcp-http.json"), '{"x-wezard-token":"secret"}');
  assert.deepEqual(removeLegacyMcpFiles(dir).sort(), ["session-mcp-http.json", "session-mcp.json"]);
  assert.ok(!existsSync(join(dir, "session-mcp.json")) && !existsSync(join(dir, "session-mcp-http.json")));
  assert.ok(existsSync(spec.file), "新产物不动");
  assert.deepEqual(removeLegacyMcpFiles(dir), [], "重复清理幂等");

  console.log("session-mcp.test: ok");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
