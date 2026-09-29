// 群记忆 / 工作区记忆: wizard 自己的 memory 之外的两份**共享**记忆。
//
// 一个 wizard 的 memory 跟着它自己走 (wizards.json), 可很多东西不属于某一个 wizard:
// 「这个群里人习惯先出方案再动手」属于这个群, 「这个仓库没有测试、reload 要先 build」
// 属于这个工作区。它们各存一份 markdown, 任何 wizard 出生时两份都注进宪章 —— 于是
// 一个新来的不必被人再教一遍。是 md 而不是 json: 人也会直接打开改它。
//
//   ~/.wezard/memory/chats/<base>.md
//   ~/.wezard/memory/workspaces/<cwd 编码>.md
//
// 读写失败一律吞掉: 记忆是锦上添花, 读不到就当没有, 写不进就回报失败, 都不该拖垮 spawn。
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { expandHome } from "../shared/paths.js";

export type MemoryScope = "chat" | "workspace";

/** 任意 key → 一个安全的文件名。`chat:wr4…` → `chat_wr4…`, `/Users/a/b` → `-Users-a-b`。 */
const fileKey = (k: string): string =>
  k.trim().replace(/\/+$/, "").replace(/\//g, "-").replace(/[^\p{L}\p{N}_.-]+/gu, "_").slice(0, 200) || "_";

/** 记忆根目录: stateDir 的兄弟 (`~/.wezard/state` → `~/.wezard/memory`)。 */
export const memoryRoot = (stateDir: string): string => join(dirname(expandHome(stateDir)), "memory");

export const memoryPath = (stateDir: string, scope: MemoryScope, key: string): string =>
  join(memoryRoot(stateDir), scope === "chat" ? "chats" : "workspaces", `${fileKey(key)}.md`);

/** 整份读出 (去掉首尾空白); 不存在 / 读失败 = ""。 */
export const readMemory = (path: string): string => {
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    return "";
  }
};

/** 追加一条 `- note`。 */
export const appendMemory = (path: string, note: string): boolean => {
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `- ${note.replace(/\s*\n\s*/g, " ").trim()}\n`);
    return true;
  } catch {
    return false;
  }
};

/** 按子串删掉匹配的行 (模型记得大意, 记不住原文), 返回删了几条。 */
export const forgetMemory = (path: string, needle: string): number => {
  const cur = readMemory(path);
  if (!cur || !needle) return 0;
  const lines = cur.split("\n");
  const kept = lines.filter((l) => !l.includes(needle));
  if (kept.length === lines.length) return 0;
  try {
    writeFileSync(path, kept.length ? `${kept.join("\n")}\n` : "");
    return lines.length - kept.length;
  } catch {
    return 0;
  }
};
