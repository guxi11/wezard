// 企业微信等"只该在 wezard 会话里出现"的 skill 也走**按会话注入** —— 全机
// ~/.codebuddy/skills / ~/.claude/skills 里不留任何东西, 人自己开的 CLI 会话看不见它。
//
//   claude / claude-internal / codebuddy : `--plugin-dir <pluginDir>`
//   codex: 没有这个参数, 不注入 (它的 skill 面不走这里)
//
// 插件目录只是壳, skills/ 里每一项是指向 <stateDir>/skills/<name> 的相对软链 ——
// 升级某个 skill 只替换内容, 启动行不用动。
import { existsSync, mkdirSync, readlinkSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { join, relative } from "node:path";
import { writeIfChanged } from "./session-hooks.js";

export interface SessionSkillSpec {
  /** --plugin-dir 用的插件目录。 */
  pluginDir: string;
  /** 这次实际挂上的 skill 名 (目录里有 SKILL.md 才算)。 */
  names: string[];
}

const skillDirs = (stateDir: string): Array<{ name: string; dir: string }> => {
  const root = join(stateDir, "skills");
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory() || d.isSymbolicLink())
    .map((d) => ({ name: d.name, dir: join(root, d.name) }))
    .filter((s) => existsSync(join(s.dir, "SKILL.md")))
    .sort((a, b) => a.name.localeCompare(b.name));
};

/** 写插件壳并把 <stateDir>/skills/* 软链进去。没有 skill 就返回 undefined ——
 *  daemon 照常跑, 只是 pane 里少了这批工具知识。 */
export const prepareSessionSkills = (stateDir: string): SessionSkillSpec | undefined => {
  const skills = skillDirs(stateDir);
  if (!skills.length) return undefined;
  const pluginDir = join(stateDir, "session-skill-plugin");
  const dir = join(pluginDir, "skills");
  mkdirSync(dir, { recursive: true });
  writeIfChanged(join(pluginDir, ".claude-plugin", "plugin.json"),
    `${JSON.stringify({ name: "wezard-session-skills", version: "0.0.0", description: "wezard 按会话注入的 skill" }, null, 2)}\n`);
  const names = skills.map((s) => s.name);
  // 上游删掉的 skill / 改名的目录: 插件里别留死链, 否则 CLI 还报它可用。
  for (const entry of readdirSync(dir)) if (!names.includes(entry)) rmSync(join(dir, entry), { force: true });
  for (const s of skills) {
    const link = join(dir, s.name);
    const target = relative(dir, s.dir);
    try { if (readlinkSync(link) === target) continue; } catch { /* 没有或不是软链: 重建 */ }
    try { rmSync(link, { force: true }); symlinkSync(target, link, "dir"); } catch { /* 单项失败不影响其它 */ }
  }
  return { pluginDir, names };
};

/** 后端对应的注入参数; codex 没有 --plugin-dir。 */
export const sessionSkillArgs = (backendName: string, spec: SessionSkillSpec): string[] =>
  backendName === "codex" ? [] : ["--plugin-dir", spec.pluginDir];
