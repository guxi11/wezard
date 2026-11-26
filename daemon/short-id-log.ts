// 「最近投递过哪些行」的持久记录 —— 短 id (纯 seq) 补全的唯一依据。
//
// 注入文本里的行 id 只写 seq (hash 段在块头); 模型过一会儿才回 `re: "229"`, 那时这一轮早已
// 轮终、daemon 也可能 reload 过 —— 内存里的 turns 已经没了。所以按**投递事实**记账: 每次
// 注入成功写下这一批渲染过的 {room, seqs}, 保留最近 N 批 / 时间窗内, 落 stateDir 下一个小
// json (读写都不抛, 坏了当空重开 —— 它只是补全依据, 丢了顶多让短 id 退回可行动报错)。
import { loadJsonMap } from "../shared/json-map-store.js";

export interface DeliveryBatch {
  at: number;
  /** 这一批注入里渲染过的 room 与行号 (row id 的 seq 段)。 */
  rooms: Array<{ room: string; seqs: number[] }>;
}

export interface ShortIdLog {
  /** 记一批成功的投递 (同一批跨 room 共用一个 at)。 */
  record: (uid: string, batch: DeliveryBatch) => void;
  /** 这个 uid 最近投递过 seq 的 room (去重); 0 个 = 没投过 / 已出窗。 */
  roomsOfSeq: (uid: string, seq: number) => string[];
  /** 诊断 / 测试: 这个 uid 现存的批次 (已出窗的不算)。 */
  batches: (uid: string) => DeliveryBatch[];
}

/** 保留最近 20 批, 且只认 60 分钟内的 —— 再早的引用该用全形 (块头 hash + 行号) 自救。 */
export const SHORT_ID_MAX_BATCHES = 20;
export const SHORT_ID_WINDOW_MS = 60 * 60_000;

export const openShortIdLog = (
  filePath: string,
  opts: { now?: () => number; maxBatches?: number; windowMs?: number } = {},
): ShortIdLog => {
  const now = opts.now ?? Date.now;
  const max = opts.maxBatches ?? SHORT_ID_MAX_BATCHES;
  const win = opts.windowMs ?? SHORT_ID_WINDOW_MS;
  const fresh = (rows: readonly DeliveryBatch[]): DeliveryBatch[] => {
    const at = now();
    return rows.filter((b) => !!b && typeof b.at === "number" && at - b.at <= win).slice(-max);
  };
  // gc: 每次落盘前清过期批次, 文件不会无限长。
  const store = loadJsonMap<DeliveryBatch[]>(filePath, (all) => {
    const out: Record<string, DeliveryBatch[]> = {};
    for (const [uid, rows] of Object.entries(all)) {
      const keep = Array.isArray(rows) ? fresh(rows) : [];
      if (keep.length) out[uid] = keep;
    }
    return out;
  });
  return {
    record: (uid, batch) => store.set(uid, fresh([...(store.get(uid) ?? []), batch])),
    roomsOfSeq: (uid, seq) => {
      const hits = new Set<string>();
      for (const b of fresh(store.get(uid) ?? [])) {
        for (const r of b.rooms ?? []) if ((r.seqs ?? []).includes(seq)) hits.add(r.room);
      }
      return [...hits];
    },
    batches: (uid) => fresh(store.get(uid) ?? []),
  };
};
