// 群聊严格治理的成员表 (v3 P7-S1): 一个聊天里有哪些身份、以什么身份在场。
// 键 = `${chat}|${identity}` —— **chat × 身份, 零 pane 维度** (约束刀 A③: pane 只是
// 进程外壳, 定位在注入/停止那一刻临时解析, 不进任何账本键)。`chat` 是 base principal
// (`chat:wr…` / `user:xxx`, 与 chat-records / chatPolicy 同一键空间), `identity` 是
// 身份 id (wizard.ts 的 identityOf —— 不是 pane, 也不是 target)。
//
// 落盘走 shared/json-map-store (write-through, 容错读写): 成员表是治理状态不是恢复态,
// 但丢了的代价只是重新 join 一次, 不值得 strict 期刊。S1 只建表与 API, 尚无写入方
// (join 的接面 —— delegate/spawn 的 join 参数、点名入群 —— 随 S2 落)。
import { loadJsonMap } from "../shared/json-map-store.js";

/** 在场方式: owner = 本群的管家绑定; speaker = 可主动开口 (chat_say); mention = 只能
 *  chat_reply 答指向自己的义务 (人拍板: 成员默认不入群, 入群默认 mention)。 */
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
  join: (chat: string, identity: string, mode: MemberMode, by: string) => MemberRow;
  leave: (chat: string, identity: string) => void;
  isMember: (chat: string, identity: string) => boolean;
  modeOf: (chat: string, identity: string) => MemberMode | undefined;
  /** 游标推进: 只进不退 (传入比现存小的值是 no-op)。 */
  advance: (chat: string, identity: string, cursor: number) => void;
  rowOf: (chat: string, identity: string) => MemberRow | undefined;
  ofChat: (chat: string) => Array<{ identity: string; row: MemberRow }>;
  /** 有成员表的全部聊天键 (P7-S3 rolepage/roster 面板用)。 */
  chats: () => string[];
  /** 身份退役: 从所有聊天里摘掉 (P7-S2, 返回摘掉的聊天键)。 */
  leaveEverywhere: (identity: string) => string[];
}

const keyOf = (chat: string, identity: string): string => `${chat}|${identity}`;

export const openMembers = (file: string): Members => {
  const db = loadJsonMap<MemberRow>(file);
  const rowOf = (chat: string, identity: string): MemberRow | undefined => db.get(keyOf(chat, identity));
  return {
    // 重复 join = 升级在场方式 (mention → speaker) 并刷新 by; since 保留最早的。
    join: (chat, identity, mode, by) => {
      const prev = rowOf(chat, identity);
      const next: MemberRow = prev
        ? { ...prev, mode, by: by || prev.by }
        : { mode, since: Date.now(), by, cursor: -1 };
      return db.set(keyOf(chat, identity), next);
    },
    leave: (chat, identity) => db.drop(keyOf(chat, identity)),
    isMember: (chat, identity) => rowOf(chat, identity) !== undefined,
    modeOf: (chat, identity) => rowOf(chat, identity)?.mode,
    advance: (chat, identity, cursor) => {
      const prev = rowOf(chat, identity);
      if (prev && cursor > prev.cursor) db.set(keyOf(chat, identity), { ...prev, cursor });
    },
    rowOf,
    ofChat: (chat) => Object.entries(db.all())
      .filter(([k]) => k.startsWith(`${chat}|`))
      .map(([k, row]) => ({ identity: k.slice(chat.length + 1), row })),
    chats: () => [...new Set(Object.keys(db.all()).map((k) => k.split("|")[0] ?? "").filter(Boolean))],
    leaveEverywhere: (identity) => {
      const suffix = `|${identity}`;
      const chats = Object.keys(db.all()).filter((k) => k.endsWith(suffix)).map((k) => k.slice(0, -suffix.length));
      chats.forEach((chat) => db.drop(`${chat}|${identity}`));
      return chats;
    },
  };
};
