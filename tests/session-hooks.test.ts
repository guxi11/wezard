// 单元测试: 审批 hook 的按会话注入产物 — 运行: npx tsx tests/session-hooks.test.ts
//
// 目标: 全机 settings / 插件里不再注册 wezard 的 hook, 改为 spawn 时按会话注入。
// 这里钉住三件事: (1) 两份产物都指向真实存在的 hook 脚本 + timeout 严格大于
// longPoll; (2) 重复调用不重写 (每次 spawn 都会调); (3) 三种后端各自拿到对的参数。
import assert from "node:assert";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareSessionHooks, sessionHookArgs } from "../shared/session-hooks.js";

const dir = mkdtempSync(join(tmpdir(), "wezard-session-hooks-"));
try {
  const spec = prepareSessionHooks(dir, 43200);
  const settings = JSON.parse(readFileSync(spec.settingsFile, "utf8")) as {
    hooks: { PreToolUse: Array<{ matcher: string; hooks: Array<{ type: string; command: string; timeout: number }> }> };
  };
  const entry = settings.hooks.PreToolUse[0]!;
  const hook = entry.hooks[0]!;
  assert.equal(entry.matcher, ".*");
  assert.equal(hook.type, "command");
  assert.ok(hook.command.endsWith("/hooks/pre-tool-use.sh"), `command 应指向仓库的 hook 脚本, 实际: ${hook.command}`);
  assert.ok(existsSync(hook.command), "hook 脚本必须真实存在 — 指向 dist/hooks 之类不存在的路径 = 静默无审批");
  assert.ok((statSync(hook.command).mode & 0o111) !== 0, "hook 脚本必须可执行");
  assert.equal(hook.timeout, 43210, "timeout = hookTimeoutSec + 10 (必须严格大于 longPollSec)");

  // claude-internal 走 --plugin-dir: 最小插件目录里 hooks/hooks.json 的内容必须一致。
  const pluginHooks = JSON.parse(readFileSync(join(spec.pluginDir, "hooks", "hooks.json"), "utf8")) as typeof settings;
  assert.equal(pluginHooks.hooks.PreToolUse[0]!.hooks[0]!.command, hook.command);
  const manifest = JSON.parse(readFileSync(join(spec.pluginDir, ".claude-plugin", "plugin.json"), "utf8")) as { name: string };
  assert.equal(manifest.name, "wezard-session-hooks");

  // 每次 spawn 都会调: 内容没变就不该重写 (mtime 不动)。
  const before = statSync(spec.settingsFile).mtimeMs;
  prepareSessionHooks(dir, 43200);
  assert.equal(statSync(spec.settingsFile).mtimeMs, before, "同样内容重复调用不应重写");

  // 后端 → 参数
  assert.deepEqual(sessionHookArgs("claude", spec), ["--settings", spec.settingsFile]);
  assert.deepEqual(sessionHookArgs("codebuddy", spec), ["--settings", spec.settingsFile]);
  assert.deepEqual(sessionHookArgs("claude-internal", spec), ["--plugin-dir", spec.pluginDir]);

  console.log("session-hooks.test: ok");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
