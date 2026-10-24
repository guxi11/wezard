// 给聊天起名。
//
// 一个 WeCom 聊天的身份是 `chat:wrkSxxxxx…` 这种不可读、不可手打的 id。wizard 早已
// 不靠聊天寻址 —— 每个 wizard 有全局唯一的名字 (`.fix`, 见 wizard.ts); 聊天名要解决
// 的是**指到一个群**: notify 发到哪、spawn_wizard / clone_wizard 把 home 设在哪,
// 以及一个群的默认 wizard 出生时取什么名字。
//
// 落盘走 config.jsonc (`chats`), 与定时表同一套 patchJsonc + in-place cfg 变更 ——
// 名字是用户手写的长期配置, 不是运行时状态, 不该躺在 state 目录里。
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ChatPolicy, type Config, type TierName } from "../shared/config.js";
import { patchJsonc } from "../shared/config-writer.js";
import { expandHome } from "../shared/paths.js";
import { baseOfKey, isInternalKey, tagOfKey } from "../shared/session-label.js";
import { settleName, wizardStore } from "./wizard.js";

/** 一次会动到宪章的写入 (见 index.ts 的宪章守卫): 聊天名、chatPolicy 都进宪章, 已在跑的 wizard 看不见,
 *  要 handoff 才换上。`what` 是提醒里点名的改动; `self` = 发起的 wizard (它受影响就在回话里直说);
 *  `byHuman` = 人发起的; `reload` = 守护进程 reload 后才生效; `after` = 写后的宪章 (默认按此刻的活 cfg 渲染)。 */
export interface CharterChange {
  what: string;
  self?: string;
  byHuman?: boolean;
  reload?: boolean;
  after?: (targets: readonly string[]) => Map<string, string>;
}
/** 写前写后各渲染一遍宪章, 变了的 wizard 挂 handoff 提醒。`write` 同步执行 (快照到写完之间不能有 await);
 *  `change` 由写的结果判断这次算不算一次改动 (undefined = 没写, 不比对)。`note` = 给调用方的那段话。 */
export type CharterGuard = <T>(write: () => T, change: (r: T) => CharterChange | undefined) => { r: T; note: Promise<string> };

/** 与 wizard 名字同一套字符集: 字母/数字/`_`/`-`, 1~32。名字要能原样写进地址里, 所以
 *  不能含 `#`、`/`、`:` 与空白 —— 那三个都是地址语法的一部分。 */
const NAME_RE = /^[\p{L}\p{N}_-]{1,32}$/u;
const PRINCIPAL_RE = /^(?:chat|user|group|external_user):/;
const TARGET_KEY_RE = /^(?:chat|user|group|external_user):[^#/]+(?:#[^#/]+)?$/;

/** 用户输入的名字: 去引号/空白, 剥掉习惯性前缀的 `@`、`#`、`.`。 */
export const normChatName = (raw: string): string =>
  (raw ?? "").trim().replace(/^[\s'"‘’“”`]+|[\s'"‘’“”`]+$/gu, "").replace(/^[@#.]+/, "");

/** 名字大小写不敏感 —— 用户在手机上打字, `Daily` 和 `daily` 必须是同一个群。
 *  存的是原样拼写, 比对走这个折叠。 */
const fold = (s: string): string => s.toLowerCase();

const entries = (cfg: Config): Array<[string, string]> => Object.entries(cfg.chats ?? {});

/** 这个聊天 (或它的某个 tagged 会话) 的名字; 没起名返回 ""。 */
export const chatNameOf = (cfg: Config, target: string): string => {
  const base = baseOfKey(target);
  return entries(cfg).find(([, p]) => p === base)?.[0] ?? "";
};

/** 当前聊天全名或 canonical principal/target key → base principal; friendly wizard 地址不解析。 */
export const chatBaseOf = (cfg: Config, ref: string): string => {
  const r = normChatName(ref ?? "");
  if (!r) return "";
  if (TARGET_KEY_RE.test(r)) return baseOfKey(r);
  if (PRINCIPAL_RE.test(r) || /[#/]/.test(r)) return "";
  const f = fold(r);
  return entries(cfg).find(([n]) => fold(n) === f)?.[1] ?? "";
};

/** `target` 所在聊天的群聊级策略 (`chatPolicy`, 键是 base principal)。 */
// topOnly 没写 = **开** (2026-10-15 起): 顶层模式是每个聊天的默认规矩, 只有人显式写 `false` 才关。
// 此前默认只覆盖 wezard 与微信 ClawBot 群聊, 其余群靠管家问人一句才开 —— 每新起一个群都要人再点一次头,
// 漏掉的那个群里 wizard 之间就当着人派活、回复也进群 (pagesite 就是这样冒的泡)。
// 默认不落盘, 已有的聊天不必迁移。
export const chatPolicyOf = (cfg: Config, target: string): ChatPolicy & { topOnly: boolean } =>
  ((p) => ({ ...p, topOnly: p.topOnly ?? true }))(ChatPolicy.parse(cfg.chatPolicy?.[baseOfKey(target)] ?? {}));

/** 群的默认会话就是 router; 统一取 models.router, 非管家不套档。
 *  内部 key (daemon 内建的记忆整理执行体, `wezard:internal#steward`) 同属管家型: 它带着 slot 名,
 *  但既不属于任何群、也不是谁的分身 —— 不给档它就落 CLI 自己的默认模型 (本机那个目录实测是
 *  opus/high, 转录里 providerData.model=claude-opus-5.5), 比 router 那档重得多。真 slot 分身才不套档。 */
export const stewardTierOf = (cfg: Config, target: string): TierName | undefined =>
  isInternalKey(target) || !tagOfKey(target) ? cfg.models.router : undefined;

/** 已命名的聊天, 按名字排序。 */
export const listChatNames = (cfg: Config): Array<{ name: string; base: string }> =>
  entries(cfg)
    .map(([name, base]) => ({ name, base }))
    .sort((a, b) => a.name.localeCompare(b.name));

const writeChats = (cfg: Config, sourcePath: string, next: Record<string, string>): void => {
  retire(cfg, [...Object.keys(cfg.chats ?? {}), ...Object.keys(next)]);
  cfg.chats = next;
  patchJsonc(sourcePath, [{ path: ["chats"], value: next }]);
};

// ── 墓碑 ──────────────────────────────────────────────────────────────
// 名字是读侧的身份: read_chat / rolepage 按信封里的聊天名认「这个群的往来」。一个名字被人
// rename 释放、再自动分给新聊天, 新聊天里的 wizard 就把上一任持有者的全部记录读成自己群的
// (cc-wecom-3 一天里先后属于 modeck、bias、mail_modules 三个群)。所以凡在 `chats` 里出现过
// 的名字都留墓碑, 自动命名永不再分配; 人手动 `/name` 不受限 —— 那是人自己指定的。
// 墓碑是运行时历史, 不是人写的配置: 落在 state 目录, 不进 config.jsonc。
const retiredPath = (cfg: Config): string => join(expandHome(cfg.daemon.stateDir), "chat-names-retired.json");

/** 出现过的全部聊天名 (已折叠大小写)。读不到当空 —— 下一次写会把当前 `chats` 并进来。 */
export const retiredChatNames = (cfg: Config): Set<string> => {
  try {
    const xs: unknown = JSON.parse(readFileSync(retiredPath(cfg), "utf8"));
    return new Set(Array.isArray(xs) ? xs.filter((x): x is string => typeof x === "string").map(fold) : []);
  } catch { return new Set(); }
};

/** 把这些名字并进墓碑。写失败不抛: 丢一次墓碑最坏是一个名字可能被复用, 不该搞崩命名本身。 */
const retire = (cfg: Config, names: readonly string[]): void => {
  const have = retiredChatNames(cfg);
  const next = [...new Set([...have, ...names.map(fold)])].sort();
  if (next.length === have.size) return;
  try {
    mkdirSync(dirname(retiredPath(cfg)), { recursive: true });
    writeFileSync(retiredPath(cfg), JSON.stringify(next, null, 2) + "\n");
  } catch { /* 见上 */ }
};

/** 给 `target` 所在的聊天起名 (改名 = 覆盖, 一个聊天只留一个名字)。名字被别的
 *  聊天占着就拒绝 —— 聊天名必须唯一解析。 */
export const setChatName = (
  cfg: Config,
  sourcePath: string,
  target: string,
  raw: string,
): { ok: true; name: string; base: string } | { ok: false; reason: string } => {
  const name = normChatName(raw);
  const base = baseOfKey(target);
  if (!base) return { ok: false, reason: "no chat to name" };
  if (!NAME_RE.test(name)) {
    return { ok: false, reason: `invalid name '${raw}' — 1-32 chars, letters/digits/_/- only (no space, #, /, :)` };
  }
  const taken = entries(cfg).find(([n, p]) => fold(n) === fold(name) && p !== base);
  if (taken) return { ok: false, reason: `name '${name}' already belongs to ${taken[1]}` };
  const next = Object.fromEntries([
    ...entries(cfg).filter(([n, p]) => p !== base && fold(n) !== fold(name)),
    [name, base],
  ]);
  writeChats(cfg, sourcePath, next);
  return { ok: true, name, base };
};

// ── 自动命名 ──────────────────────────────────────────────────────────
// 没名字的聊天在别的聊天眼里只有一串 `chat:wr4-87DwAA…` 的 key —— 能寻址, 但模型
// 抄错一个字符就找不到, 而人根本读不出那是哪个群。实测这台机器上 16 个聊天只有 3
// 个起过名字, 于是超过一半的 wizard 的 `chat` 字段是空的。
//
// 名字不该等人想起来去起。一个聊天天然带着一个可读的标识: 它在干哪个项目。所以
// 没名字就按工作区补一个 —— `~/develop/Guxi11/weclaude` → `weclaude`。这只填空,
// 永远不覆盖人起过的名字。

/** 工作区路径 → 名字候选。取最后一段, 非法字符折成 `-`; 推不出返回 ""
 *  (宁可没名字, 也不造一个 `chat-wr4` 这种同样不可读的东西)。 */
export const nameFromCwd = (cwd: string): string =>
  ((cwd ?? "").replace(/\/+$/, "").split("/").filter(Boolean).pop() ?? "")
    .replace(/[^\p{L}\p{N}_-]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);

/** 在一组已占用的名字里给 `want` 挑一个不冲突的: `lisct` → `lisct-2` → `lisct-3`。
 *  大小写不敏感, 与 setChatName 的冲突判定同一把尺子。 */
export const uniqueChatName = (want: string, taken: ReadonlySet<string>): string => {
  const walk = (n: number): string => {
    const cand = n === 1 ? want : `${want.slice(0, 29)}-${n}`;
    return taken.has(fold(cand)) ? walk(n + 1) : cand;
  };
  return walk(1);
};

/** 自动名只递增、永不回填: 取 `want` 这一支 (`want` / `want-N`) 在 `used` (占用 ∪ 墓碑) 里的最大序号 +1。
 *  空号也不回填 —— 空号多半是某个已改名的群留下的, 它的旧往来还挂在这个名字上。 */
export const nextAutoName = (want: string, used: ReadonlySet<string>): string => {
  const w = fold(want);
  const seq = (name: string): number => {
    if (name === w) return 1;
    const m = /^(.*)-(\d+)$/.exec(name);
    return m && m[1] === w.slice(0, 31 - m[2]!.length) ? Number(m[2]) : 0;
  };
  const n = Math.max(0, ...[...used].map(seq)) + 1;
  return n === 1 ? want : `${want.slice(0, 31 - String(n).length)}-${n}`;
};

/** 给一批没名字的聊天算名字 (纯函数)。批内互不重名 —— 三个聊天都在 lisct 下就是
 *  lisct / lisct-2 / lisct-3。已有名字的、以及工作区推不出名字的, 都不在结果里。
 *  `retired` = 出现过的全部名字 (墓碑), 默认读盘。 */
export const planChatNames = (
  cfg: Config,
  chats: ReadonlyArray<{ base: string; cwd: string }>,
  retired: ReadonlySet<string> = retiredChatNames(cfg),
): Record<string, string> => {
  const used = new Set([...entries(cfg).map(([n]) => fold(n)), ...retired]);
  return chats.reduce<Record<string, string>>((acc, c) => {
    if (!c.base || chatNameOf(cfg, c.base)) return acc;
    const want = nameFromCwd(c.cwd);
    if (!NAME_RE.test(want)) return acc;
    const name = nextAutoName(want, used);
    used.add(fold(name));
    return { ...acc, [c.base]: name };
  }, {});
};

/** 落盘, 一次 patchJsonc (而不是一个聊天写一次 —— 首次补名会一口气命中十几个)。
 *  写失败不抛: 自动命名是锦上添花, 不该把一次 roster 查询搞崩。 */
export const applyChatNames = (
  cfg: Config,
  sourcePath: string,
  plan: Readonly<Record<string, string>>,
): Record<string, string> => {
  const pairs = Object.entries(plan);
  if (pairs.length === 0) return {};
  const next = Object.fromEntries([...entries(cfg), ...pairs.map(([base, name]) => [name, base] as [string, string])]);
  try {
    writeChats(cfg, sourcePath, next);
  } catch {
    cfg.chats = next; // 盘上没写成也让本进程认得这些名字, 下次启动再补
  }
  return plan;
};

/** 取消命名。返回被摘掉的名字 ("" = 本来就没名字)。 */
export const clearChatName = (cfg: Config, sourcePath: string, target: string): string => {
  const base = baseOfKey(target);
  const cur = chatNameOf(cfg, base);
  if (!cur) return "";
  writeChats(cfg, sourcePath, Object.fromEntries(entries(cfg).filter(([, p]) => p !== base)));
  return cur;
};

/** 一个 target key 的地址 —— 它的全局名字, 可直接用于当前 wizard 寻址。 */
export const peerAddress = (cfg: Config, target: string): string =>
  settleName(wizardStore(), chatNameOf(cfg, target), target);
