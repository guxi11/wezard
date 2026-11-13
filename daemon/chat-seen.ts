// S3 ① 已知聊天册 (known-chats.json): 「S3 之后首见的聊天默认 strict, 存量不动」的判定底座。
//
// 一份 state 文件记两类在册聊天:
//   • legacy (存量) —— 本模块第一次被打开 (S3 代码上线后的第一次 boot) 时, 把盘上一切
//     可见的聊天快照进来; 之后每次 boot 再扫一遍, 新冒出来的盘上痕迹也按存量并入
//     (boot 增量: 老 daemon 期间安静、S3 后才在盘上留下痕迹的聊天不算「新群」)。
//   • 首见 (S3 后) —— 运行时第一次收到人流/出流时登记 (record), legacy=false → strict。
//
// 判定 (chat-name.chatPolicyOf 的 speech 缺省走这里, mirror-bridge 的 strictBase 同一判定):
//   显式 chatPolicy.<chat>.speech  >  首见 (在册且非 legacy) strict  >  存量 / 未在册 implicit。
// 未在册 = 这个 daemon 还没跟它发生过任何往来 —— 判 implicit (现行行为), 第一次人话进来
// 时 noteHuman 先 record 再进 dispatch, 所以首条就是 strict (验收数字 ①)。
//
// 只对群聊开 strict: 单聊 (user:*) 没有成员制/义务的概念, 私聊口径 (S2: 私聊照旧) 不变,
// 显式 chatPolicy 仍可单独给某个单聊开 strict。
//
// 落盘是全量小 JSON (聊天数 ~几十); 写失败降级为内存态 (最坏 = crash 后一次误判回
// implicit, 方向安全 —— strict 聊天少发一句, 不会多发)。
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "../shared/config.js";
import { expandHome } from "../shared/paths.js";
import { baseOfKey } from "../shared/session-label.js";

interface SeenRow { at: number; legacy: boolean }
type KnownFile = Record<string, SeenRow>;

const LEGACY = true;

/** 盘上可见的「存量聊天」来源: 每一路都是在别的 store 里已有键的聊天, 这里只读不写。 */
const discoverFromDisk = (cfg: Config, stateDir: string): string[] => {
  const out = new Set<string>();
  const add = (x: string): void => { if (x) out.add(x); };
  for (const base of Object.values(cfg.chats ?? {})) add(base);
  for (const base of Object.keys(cfg.chatPolicy ?? {})) add(base);
  // chatRecords: stateDir/chats/<encodeURIComponent(base)>.jsonl
  try {
    for (const f of readdirSync(join(stateDir, "chats"))) {
      if (f.endsWith(".jsonl")) { try { add(decodeURIComponent(f.slice(0, -6))); } catch { add(f.slice(0, -6)); } }
    }
  } catch { /* 目录还没有 = 没记过 */ }
  // 频道缓存: stateDir/channels/<encodeURIComponent(topicId)>.jsonl → chat:<topicId> (频道即群)
  try {
    for (const f of readdirSync(join(stateDir, "channels"))) {
      if (!f.endsWith(".jsonl")) continue;
      let id = f.slice(0, -6);
      try { id = decodeURIComponent(id); } catch { /* 原样 */ }
      add(`chat:${id}`);
    }
  } catch { /* 目录还没有 = 没见过频道 */ }
  // 成员表: stateDir/members.json, 键 `${chat}|${identity}`
  try {
    const db = JSON.parse(readFileSync(join(stateDir, "members.json"), "utf8")) as Record<string, unknown>;
    for (const k of Object.keys(db)) add(k.split("|")[0] ?? "");
  } catch { /* 没有 = 还没开过严格群 */ }
  // wizard 名册 (wrc.mirror.wizardsFile): 每个 wizard 的 home 也是存量聊天。
  try {
    const recs = JSON.parse(readFileSync(expandHome(cfg.wrc.mirror.wizardsFile), "utf8")) as Record<string, unknown>;
    for (const t of Object.keys(recs)) add(baseOfKey(t));
  } catch { /* 没有 = 空名册 */ }
  return [...out];
};

export interface KnownChats {
  /** 在册? (存量或首见都算)。 */
  has(base: string): boolean;
  /** 存量 (S3 上线时已可见 / boot 增量并入) → speech 缺省 implicit。 */
  isLegacy(base: string): boolean;
  /** 首见登记 (已在册 = no-op)。返回登记后的判定。 */
  record(base: string): "strict" | "implicit";
  /** boot 增量: 盘上可见但未在册的聊天按存量并入。 */
  scanBoot(): void;
  /** 全册 (rolepage / 切换命令的候选清单用)。 */
  rows(): Array<{ chat: string; at: number; legacy: boolean }>;
}

const knownPath = (cfg: Config): string => join(expandHome(cfg.daemon.stateDir), "known-chats.json");

const readKnown = (path: string): KnownFile => {
  try {
    const xs = JSON.parse(readFileSync(path, "utf8")) as KnownFile;
    return xs && typeof xs === "object" ? xs : {};
  } catch { return {}; }
};

const open = (cfg: Config): KnownChats => {
  const path = knownPath(cfg);
  const stateDir = expandHome(cfg.daemon.stateDir);
  let file = readKnown(path);
  const save = (): void => {
    try {
      mkdirSync(stateDir, { recursive: true });
      writeFileSync(path, JSON.stringify(file, null, 2) + "\n");
    } catch { /* 写失败降级内存态: 判定仍准, 重启后少一次册 */ }
  };
  const kc: KnownChats = {
    has: (base) => file[base] !== undefined,
    isLegacy: (base) => file[base]?.legacy === LEGACY,
    record: (base) => {
      if (!base || file[base]) return file[base] ? (file[base]!.legacy ? "implicit" : "strict") : "implicit";
      file = { ...file, [base]: { at: Date.now(), legacy: !LEGACY } };
      save();
      return "strict";
    },
    scanBoot: () => {
      let dirty = false;
      for (const base of discoverFromDisk(cfg, stateDir)) {
        if (!base || file[base]) continue;
        file = { ...file, [base]: { at: Date.now(), legacy: LEGACY } };
        dirty = true;
      }
      if (dirty) save();
    },
    rows: () => Object.entries(file).map(([chat, r]) => ({ chat, at: r.at, legacy: r.legacy })),
  };
  kc.scanBoot();
  return kc;
};

/** 同一 stateDir 只开一份 (进程内缓存; reload 换 cfg 对象但 stateDir 相同 → 同一份册)。 */
const cache = new Map<string, KnownChats>();
export const knownChatsOf = (cfg: Config): KnownChats => {
  const key = expandHome(cfg.daemon.stateDir);
  let kc = cache.get(key);
  if (!kc) { kc = open(cfg); cache.set(key, kc); }
  return kc;
};

/** 测试面: 清缓存后同一路径会重开 (模拟 reboot / 换 cfg 重扫)。 */
export const resetKnownChatsCache = (): void => { cache.clear(); };

/** speech 的缺省判定: 首见 (在册且非存量) 的**群聊** strict, 其余 implicit。
 *  显式 chatPolicy 在 chat-name.chatPolicyOf 里优先于此。 */
export const speechDefaultOf = (cfg: Config, base: string): "strict" | "implicit" =>
  base.startsWith("chat:") && knownChatsOf(cfg).has(base) && !knownChatsOf(cfg).isLegacy(base) ? "strict" : "implicit";
