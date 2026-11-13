// 审批 hook 的**按会话**注入 —— 全机 settings.json / 插件里不再注册 wezard 的 hook。
//
//   claude / codebuddy : `--settings <settingsFile>` (settings.hooks.PreToolUse)
//   claude-internal 1.x: 没有 --settings, 用 `--plugin-dir <pluginDir>` 载一个
//     只带 hooks 的最小插件 (实测 1.1.9 生效)
//   codex             : 走它自己的 `-c` 覆盖 (shared/codex-hooks.ts), 不在这里
//
// 两份产物只取决于 config, 所有 pane 共用一个文件/目录; 这样「没碰过 wezard 的人
// 在自己的终端里跑 CLI」既不会多一条配置, 也不会每次工具调用多起一个脚本进程。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface SessionHookSpec {
  /** --settings 用的文件 (claude / codebuddy)。 */
  settingsFile: string;
  /** --plugin-dir 用的最小插件目录 (claude-internal)。 */
  pluginDir: string;
}

/** 同内容就不写 (mtime 稳定, 免得每次 spawn 都让 CLI 重读配置)。 */
export const writeIfChanged = (file: string, content: string): void => {
  try { if (readFileSync(file, "utf8") === content) return; } catch { /* 没有就是该写 */ }
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content, "utf8");
};

/** 仓库里的 hook 脚本。dist/shared → ../../hooks, dev (tsx shared/) → ../hooks。 */
const hookScript = (): string => {
  const here = dirname(fileURLToPath(import.meta.url));
  return [resolve(here, "..", "..", "hooks", "pre-tool-use.sh"), resolve(here, "..", "hooks", "pre-tool-use.sh")]
    .find((p) => existsSync(p)) ?? resolve(here, "..", "..", "hooks", "pre-tool-use.sh");
};

const hookSettings = (script: string, timeoutSec: number): string => `${JSON.stringify({
  hooks: { PreToolUse: [{ matcher: ".*", hooks: [{ type: "command", command: script, timeout: timeoutSec }] }] },
}, null, 2)}\n`;

/** 写两份产物并返回路径。写失败直接抛: 没有 hook 的 pane 会静默失去审批,
 *  那种「看起来在跑、其实没人审批」的状态不能由吞异常换来。 */
export const prepareSessionHooks = (stateDir: string, hookTimeoutSec: number): SessionHookSpec => {
  const timeout = hookTimeoutSec + 10; // 与原来 hooks.json 的 timeout 语义一致: 必须大于 longPoll
  const settingsFile = join(stateDir, "session-hooks.json");
  const pluginDir = join(stateDir, "session-hook-plugin");
  const json = hookSettings(hookScript(), timeout);
  writeIfChanged(settingsFile, json);
  writeIfChanged(join(pluginDir, ".claude-plugin", "plugin.json"),
    `${JSON.stringify({ name: "wezard-session-hooks", version: "0.0.0", description: "wezard 审批 hook (按会话注入)" }, null, 2)}\n`);
  writeIfChanged(join(pluginDir, "hooks", "hooks.json"), json);
  return { settingsFile, pluginDir };
};

/** 后端对应的注入参数; codex 不用 (它的 hook 走 -c 覆盖)。 */
export const sessionHookArgs = (backendName: string, spec: SessionHookSpec): string[] =>
  backendName === "claude-internal" ? ["--plugin-dir", spec.pluginDir] : ["--settings", spec.settingsFile];
