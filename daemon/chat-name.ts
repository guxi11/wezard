// 给聊天起名, 让 peer 寻址跨得出去。
//
// 一个 WeCom 聊天的身份是 `chat:wrkSxxxxx…` 这种不可读、不可手打的 id。同一个
// 聊天里的会话靠 `#tag` 互相寻址 (`#fix`), 跨聊天则只有"全局唯一 tag"这一条
// 路: 两个群各有一个 `#fix` 就谁也叫不动谁, 只能让用户回去改名。
//
// 名字把 base principal 变成人能写的 token, 于是地址空间变成两级:
//   `fix`          本聊天的 #fix (老语义, 不变)
//   `daily#fix`    daily 这个聊天里的 #fix
//   `daily#`       daily 的默认会话
//   `chat:wr…#fix` 全量 key, 也当合法地址收 (list_peers 直接吐这个)
// 冲突从此可解: 名字唯一 (存在 config 的 key 上, 结构性保证), tag 只需在自己
// 聊天内唯一。
//
// 落盘走 config.jsonc (`chats`), 与定时表同一套 patchJsonc + in-place cfg 变更 ——
// 名字是用户手写的长期配置, 不是运行时状态, 不该躺在 state 目录里。
import type { Config } from "../shared/config.js";
import { patchJsonc } from "../shared/config-writer.js";
import { baseOfKey, keyOf } from "../shared/session-label.js";

/** 与 `#tag` 同一套字符集: 字母/数字/`_`/`-`, 1~32。名字要能原样写进地址里, 所以
 *  不能含 `#`、`/`、`:` 与空白 —— 那三个都是地址语法的一部分。 */
const NAME_RE = /^[\p{L}\p{N}_-]{1,32}$/u;
const PRINCIPAL_RE = /^(?:chat|user|group|external_user):/;

/** 用户输入的名字: 去引号/空白, 剥掉习惯性前缀的 `@`、`#`。 */
export const normChatName = (raw: string): string =>
  (raw ?? "").trim().replace(/^[\s'"‘’“”`]+|[\s'"‘’“”`]+$/gu, "").replace(/^[@#]+/, "");

/** 名字大小写不敏感 —— 用户在手机上打字, `Daily` 和 `daily` 必须是同一个群。
 *  存的是原样拼写, 比对走这个折叠。 */
const fold = (s: string): string => s.toLowerCase();

const entries = (cfg: Config): Array<[string, string]> => Object.entries(cfg.chats ?? {});

/** 这个聊天 (或它的某个 tagged 会话) 的名字; 没起名返回 ""。 */
export const chatNameOf = (cfg: Config, target: string): string => {
  const base = baseOfKey(target);
  return entries(cfg).find(([, p]) => p === base)?.[0] ?? "";
};

/** 任何一种寻址串 → base principal; 认不出返回 ""。
 *
 *  「聊天名」「裸 principal」「`daily#fix`」「`chat:wr…#fix`」全收 —— 后两种是
 *  wizard_roster / list_peers 吐给模型的那个 `address`, 而模型手里往往只有它:
 *  它知道「那个 wizard 叫 exp、地址 org-archivist#exp」, 要往那个群里说句话时,
 *  唯一能写出来的就是这个串。此前 `name#tag` 被整条拒收 (只有全量 key 那一种因为
 *  前缀命中而侥幸可用), 于是同一个地址空间在 send_peer 那边通、在 notify 这边不通。
 *  会话那一截在这里是多余信息, 剥掉即可 —— 一个 tag 指不出第二个聊天。 */
export const chatBaseOf = (cfg: Config, ref: string): string => {
  const { chat, tag } = parsePeerRef(ref ?? "");
  // 裸 tag (`fix`) 没有聊天那一截 —— parsePeerRef 把它放进 tag。它可能正是一个
  // 聊天的名字, 所以两边都试一次。
  const r = normChatName(chat || tag);
  if (!r) return "";
  if (PRINCIPAL_RE.test(r)) return baseOfKey(r);
  const f = fold(r);
  return entries(cfg).find(([n]) => fold(n) === f)?.[1] ?? "";
};

/** 已命名的聊天, 按名字排序。 */
export const listChatNames = (cfg: Config): Array<{ name: string; base: string }> =>
  entries(cfg)
    .map(([name, base]) => ({ name, base }))
    .sort((a, b) => a.name.localeCompare(b.name));

const writeChats = (cfg: Config, sourcePath: string, next: Record<string, string>): void => {
  cfg.chats = next;
  patchJsonc(sourcePath, [{ path: ["chats"], value: next }]);
};

/** 给 `target` 所在的聊天起名 (改名 = 覆盖, 一个聊天只留一个名字)。名字被别的
 *  聊天占着就拒绝 —— 重名会让 `daily#fix` 指向两个地方, 那正是要消灭的歧义。 */
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

/** 给一批没名字的聊天算名字 (纯函数)。批内互不重名 —— 三个聊天都在 lisct 下就是
 *  lisct / lisct-2 / lisct-3。已有名字的、以及工作区推不出名字的, 都不在结果里。 */
export const planChatNames = (
  cfg: Config,
  chats: ReadonlyArray<{ base: string; cwd: string }>,
): Record<string, string> => {
  const taken = new Set(entries(cfg).map(([n]) => fold(n)));
  return chats.reduce<Record<string, string>>((acc, c) => {
    if (!c.base || chatNameOf(cfg, c.base)) return acc;
    const want = nameFromCwd(c.cwd);
    if (!NAME_RE.test(want)) return acc;
    const name = uniqueChatName(want, taken);
    taken.add(fold(name));
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

// ── 地址 ──────────────────────────────────────────────────────────────
export interface PeerRef {
  /** 聊天名或裸 principal; "" = 调用方自己的聊天。 */
  chat: string;
  /** `#tag` 里的 tag; "" = 该聊天的默认会话。 */
  tag: string;
}

/** `fix` / `#fix` / `daily#fix` / `daily/fix` / `daily#` / `chat:wr…#fix` → {chat, tag}。
 *  裸 principal (无分隔符) 也认成"那个聊天的默认会话"。 */
export const parsePeerRef = (raw: string): PeerRef => {
  const s = (raw ?? "").trim().replace(/^@+/, "");
  const i = s.search(/[#/]/);
  if (i < 0) return PRINCIPAL_RE.test(s) ? { chat: s, tag: "" } : { chat: "", tag: s };
  const chat = s.slice(0, i);
  const tag = s.slice(i + 1).trim().replace(/^[#/]+/, "");
  return { chat, tag };
};

/** 一个 target key 的规范地址 —— 直接能喂回 send_peer / peek_peer 的字符串。
 *  本聊天内退化成裸 tag (`fix`), 跨聊天且对方有名字则 `daily#fix`, 无名字就只能
 *  给全量 key (仍然可用, 只是不好读)。 */
export const peerAddress = (cfg: Config, self: string, target: string): string => {
  const tag = target.includes("#") ? target.slice(target.indexOf("#") + 1) : "";
  if (baseOfKey(self) === baseOfKey(target)) return tag;
  const name = chatNameOf(cfg, target);
  return name ? `${name}#${tag}` : keyOf(baseOfKey(target), tag);
};
