// 群聊严格治理的成员表 (v3 P7-S1): 一个聊天里有哪些**实例**、以什么身份在场。
// 键 = `${chat}|${target}` —— **chat × 实例, 零 pane 维度** (约束刀 A③: pane 只是进程
// 外壳, 定位在注入/停止那一刻临时解析, 不进任何账本键)。`chat` 是 base principal
// (`chat:wr…` / `user:xxx`, 与 chat-records / chatPolicy 同一键空间), `target` 是实例
// 的地址。人 2026-11-18 改键: 身份(类)是人物设定, 在场的是它在这个聊天的那条实例 ——
// 同一个人的两个群各是一行, 退役一个实例也不该把另一个群的那行摘掉。
// 旧表 (`${chat}|${identity}`) 由 migrateMemberKeys 在 boot 一次迁到 target, 幂等。
//
// 落盘走 shared/json-map-store (write-through, 容错读写): 成员表是治理状态不是恢复态,
// 但丢了的代价只是重新 join 一次, 不值得 strict 期刊。S1 只建表与 API, 尚无写入方
// (join 的接面 —— delegate/spawn 的 join 参数、点名入群 —— 随 S2 落)。
import { copyFileSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { loadJsonMap } from "../shared/json-map-store.js";

/** 在场方式: owner = 本群的管家绑定; speaker / mention = 普通成员 —— 发言权相同
 *  (2026-11-18 人拍板「入群即发言权」), mode 只记录入群方式 (speaker = 成员带入,
 *  mention = 人点名带入), 出站门不再按它区分。 */
export type MemberMode = "owner" | "speaker" | "mention";

export interface MemberRow {
  mode: MemberMode;
  /** 入场时刻 (epoch ms)。 */
  since: number;
  /** 谁带进来的: 身份 id 或 "human:<userid>" (人行首点名 = 隐式邀请)。 */
  by: string;
  /** 已消费到的聊天记录 seq (chat-records 的游标; -1 = 一条没读)。 */
  cursor: number;
}

export interface Members {
  join: (chat: string, target: string, mode: MemberMode, by: string) => MemberRow;
  leave: (chat: string, target: string) => void;
  isMember: (chat: string, target: string) => boolean;
  modeOf: (chat: string, target: string) => MemberMode | undefined;
  /** 游标推进: 只进不退 (传入比现存小的值是 no-op)。 */
  advance: (chat: string, target: string, cursor: number) => void;
  rowOf: (chat: string, target: string) => MemberRow | undefined;
  ofChat: (chat: string) => Array<{ target: string; row: MemberRow }>;
  /** 有成员表的全部聊天键 (P7-S3 rolepage/roster 面板用)。 */
  chats: () => string[];
  /** 实例退役: 从所有聊天里摘掉**这一条实例** (P7-S2, 返回摘掉的聊天键)。 */
  leaveEverywhere: (target: string) => string[];
  /** 键的第二个分量由 identity 迁到 target (人 2026-11-18)。`resolve(chat, key)` 给出
   *  这个 key 在该聊天对应的实例 target: 已经是一个 target → 它自己; 还是一个 identity →
   *  那个聊天里它的实例; 都不是 → undefined (保持原键, 不丢历史)。返回改了几行 (幂等: 0)。 */
  migrateKeys: (resolve: (chat: string, key: string) => string | undefined) => number;
}

const keyOf = (chat: string, target: string): string => `${chat}|${target}`;

/** `legacyOf` = target → 它的身份 id: 盘上还留着旧键 (`chat|identity`) 而这一版读路径按
 *  target 查时的回落 (人 2026-11-18)。迁移闸门没开 (classes.apply 不存在) 的那段时间,
 *  旧键的行必须照常可读 —— 否则 tagged 成员被 403、chatlog 游标归 -1 全量重放。apply 之后
 *  键都成了 target, 回落自然不再命中。 */
export const openMembers = (file: string, legacyOf?: (target: string) => string | undefined): Members => {
  const db = loadJsonMap<MemberRow>(file);
  const legacyKey = (chat: string, target: string): string | undefined => {
    const id = legacyOf?.(target);
    return id && id !== target ? keyOf(chat, id) : undefined;
  };
  /** 这一次读写该落哪个键: 已是 target 键就用它, 只有旧键就沿用旧键 (游标才不会丢)。 */
  const keyFor = (chat: string, target: string): string =>
    db.get(keyOf(chat, target)) ? keyOf(chat, target) : legacyKey(chat, target) ?? keyOf(chat, target);
  const rowOf = (chat: string, target: string): MemberRow | undefined =>
    db.get(keyOf(chat, target)) ?? (() => { const k = legacyKey(chat, target); return k ? db.get(k) : undefined; })();
  return {
    // 重复 join = 升级在场方式 (mention → speaker) 并刷新 by; since 保留最早的。
    join: (chat, target, mode, by) => {
      const prev = rowOf(chat, target);
      const next: MemberRow = prev
        ? { ...prev, mode, by: by || prev.by }
        : { mode, since: Date.now(), by, cursor: -1 };
      const stale = legacyKey(chat, target);
      if (stale) db.drop(stale); // 旧键并进 target 键, 不留两行
      return db.set(keyOf(chat, target), next);
    },
    leave: (chat, target) => {
      db.drop(keyOf(chat, target));
      const stale = legacyKey(chat, target);
      if (stale) db.drop(stale);
    },
    isMember: (chat, target) => rowOf(chat, target) !== undefined,
    modeOf: (chat, target) => rowOf(chat, target)?.mode,
    advance: (chat, target, cursor) => {
      const prev = rowOf(chat, target);
      if (prev && cursor > prev.cursor) db.set(keyFor(chat, target), { ...prev, cursor });
    },
    rowOf,
    ofChat: (chat) => Object.entries(db.all())
      .filter(([k]) => k.startsWith(`${chat}|`))
      .map(([k, row]) => ({ target: k.slice(chat.length + 1), row })),
    chats: () => [...new Set(Object.keys(db.all()).map((k) => k.split("|")[0] ?? "").filter(Boolean))],
    leaveEverywhere: (target) => {
      const suffix = `|${target}`;
      const chats = Object.keys(db.all()).filter((k) => k.endsWith(suffix)).map((k) => k.slice(0, -suffix.length));
      chats.forEach((chat) => db.drop(`${chat}|${target}`));
      return chats;
    },
    migrateKeys: (resolve) => {
      // 先备份原文件 (迁移前那份), 再逐行换键。只写真的变了的行 —— 第二次跑 0 写。
      const moves = Object.entries(db.all()).flatMap(([k, row]) => {
        const i = k.indexOf("|");
        if (i < 0) return [];
        const chat = k.slice(0, i);
        const key = k.slice(i + 1);
        const target = resolve(chat, key);
        return target && target !== key ? [{ from: k, to: `${chat}|${target}`, row }] : [];
      });
      if (!moves.length) return 0;
      try {
        const backup = file + ".pre-targets.bak";
        if (!(existsSync(backup) && statSync(backup).isFile())) copyFileSync(file, backup);
      } catch { /* 备份失败也照迁: 丢的最坏是重 join 一次 */ }
      moves.forEach((m) => { db.drop(m.from); db.set(m.to, m.row); });
      return moves.length;
    },
  };
};