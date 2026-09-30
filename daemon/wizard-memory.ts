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
// 共享记忆只有一个写入者: wizard 的 `wizard_remember({scope})` 不再直写 md, 而是往
// 同名的收件箱 (`memory/inbox/<chats|workspaces>/<key>.jsonl`) 投一条提议; 定时整理者
// (memory-steward.ts) 把提议按 新增/改写/删除/不动 合并进 md。直接追加的老路在几十个
// wizard 同写一份文件时只会越来越长、互相矛盾, 而每个新 wizard 出生都要把它整份吃下。
// 人照旧可以直接改 md —— 人不是并发写者。
//
// 读写失败一律吞掉: 记忆是锦上添花, 读不到就当没有, 写不进就回报失败, 都不该拖垮 spawn。
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { expandHome } from "../shared/paths.js";

export type MemoryScope = "chat" | "workspace";

/** 任意 key → 一个安全的文件名。`chat:wr4…` → `chat_wr4…`, `/Users/a/b` → `-Users-a-b`。 */
const fileKey = (k: string): string =>
  k.trim().replace(/\/+$/, "").replace(/\//g, "-").replace(/[^\p{L}\p{N}_.-]+/gu, "_").slice(0, 200) || "_";

/** 记忆根目录: stateDir 的兄弟 (`~/.wezard/state` → `~/.wezard/memory`)。 */
export const memoryRoot = (stateDir: string): string => join(dirname(expandHome(stateDir)), "memory");

const scopeDir = (scope: MemoryScope): string => (scope === "chat" ? "chats" : "workspaces");

export const memoryPath = (stateDir: string, scope: MemoryScope, key: string): string =>
  join(memoryRoot(stateDir), scopeDir(scope), `${fileKey(key)}.md`);

/** 提议收件箱: 与 md 同名、同子目录, 整理者据此把一份收件箱对回它的 md。 */
export const inboxPath = (stateDir: string, scope: MemoryScope, key: string): string =>
  join(memoryRoot(stateDir), "inbox", scopeDir(scope), `${fileKey(key)}.jsonl`);

export interface MemoryProposal {
  at: number;
  /** 提议者的名字 (不带点)。 */
  by: string;
  note?: string;
  /** 希望删掉的那条记忆里的一个子串。 */
  forget?: string;
}

/** 投一条提议; 一行一个 json, 追加写 —— 多个 wizard 并发投也不会互相覆盖。 */
export const proposeMemory = (path: string, p: MemoryProposal): boolean => {
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(p)}\n`);
    return true;
  } catch {
    return false;
  }
};

/** 宪章里每份共享记忆的字数上限。超了只截头并指路 —— 压短是整理者的活, 不是渲染器的。 */
export const CHARTER_MEMORY_MAX = 4000;

export const clipForCharter = (text: string, path: string, max: number = CHARTER_MEMORY_MAX): string =>
  text.length <= max ? text : `${text.slice(0, max).replace(/\n[^\n]*$/, "")}\n- …(超长截断, 全文见 \`${path}\`)`;

/** 整份读出 (去掉首尾空白); 不存在 / 读失败 = ""。 */
export const readMemory = (path: string): string => {
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    return "";
  }
};
