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

/** 名字或裸 principal → base principal; 认不出返回 ""。 */
export const chatBaseOf = (cfg: Config, ref: string): string => {
  const r = normChatName(ref);
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
