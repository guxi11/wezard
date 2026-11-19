// room 账本的落盘 (契约 §1/§2): 一 room 一个 append-only jsonl, 每次 append 同步 fsync。
// journal 纪律沿用 router 那套: 撕裂的尾行 (进程死在写一半) 丢弃; 中段坏行 = 这个 room 拒绝
// 读写 (fail closed, 503), 不猜、不跳过 —— 账本是完成与发言的唯一事实, 宁停不错。
// 状态是 shared/room.ts 的 fold, 在内存里随 append 增量推进; registry 不落盘, 由目录现扫。
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { applyOp, emptyRoom, parseMsgId, roomHash, type OpenOp, type RoomOp, type RoomState } from "../shared/room.js";

export class RoomBroken extends Error {
  constructor(readonly room: string, reason: string) { super("room " + room + " 账本损坏: " + reason); }
}

export interface RoomStore {
  /** 已存在的 room 状态; 没有文件 = undefined。损坏抛 RoomBroken。 */
  get: (id: string) => RoomState | undefined;
  /** 没有就以 open 行建出来。 */
  ensure: (id: string, open: Omit<OpenOp, "op" | "room">) => RoomState;
  /** 同步落盘 (fsync) 后推进内存状态。 */
  append: (id: string, ops: readonly RoomOp[]) => RoomState;
  ids: () => string[];
  roomOfMsg: (msgId: string) => string | undefined;
  /** 每个 room 的文件路径 (迁移脚本 / 测试)。 */
  fileOf: (id: string) => string;
}

export const roomFile = (dir: string, id: string): string => join(dir, encodeURIComponent(id) + ".jsonl");

/** 解析一份账本文本: 尾部撕裂行丢弃, 中段坏行抛错。 */
export const parseJournal = (id: string, raw: string): RoomOp[] => {
  const lines = raw.split("\n");
  const out: RoomOp[] = [];
  lines.forEach((ln, i) => {
    if (!ln.trim()) return;
    try {
      out.push(JSON.parse(ln) as RoomOp);
    } catch {
      const last = lines.slice(i + 1).every((l) => !l.trim());
      if (!last) throw new RoomBroken(id, "第 " + (i + 1) + " 行不是合法 JSON");
    }
  });
  return out;
};

export const openRoomStore = (dir: string): RoomStore => {
  mkdirSync(dir, { recursive: true });
  const cache = new Map<string, RoomState>();
  const broken = new Map<string, string>();
  const byHash = new Map<string, string>();
  const fileOf = (id: string): string => roomFile(dir, id);
  const ids = (): string[] => readdirSync(dir).filter((f) => f.endsWith(".jsonl")).map((f) => decodeURIComponent(f.slice(0, -6)));
  for (const id of ids()) byHash.set(roomHash(id), id);

  const load = (id: string): RoomState | undefined => {
    const hit = cache.get(id);
    if (hit) return hit;
    const why = broken.get(id);
    if (why) throw new RoomBroken(id, why);
    const f = fileOf(id);
    if (!existsSync(f)) return undefined;
    try {
      const st = parseJournal(id, readFileSync(f, "utf8")).reduce(applyOp, emptyRoom(id));
      cache.set(id, st);
      byHash.set(roomHash(id), id);
      return st;
    } catch (e) {
      const reason = e instanceof RoomBroken ? e.message : String(e);
      broken.set(id, reason);
      throw e instanceof RoomBroken ? e : new RoomBroken(id, reason);
    }
  };

  const write = (id: string, ops: readonly RoomOp[]): void => {
    const f = fileOf(id);
    // 上一次写死在半行: 补一个换行, 让撕裂行留在自己那一行 (读时丢), 新行不被它污染。
    let prefix = "";
    if (existsSync(f)) {
      const raw = readFileSync(f, "utf8");
      if (raw.length && !raw.endsWith("\n")) prefix = "\n";
    }
    const fd = openSync(f, "a");
    try {
      writeSync(fd, prefix + ops.map((o) => JSON.stringify(o)).join("\n") + "\n");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  };

  const append = (id: string, ops: readonly RoomOp[]): RoomState => {
    const st = load(id) ?? emptyRoom(id);
    if (!ops.length) return st;
    if (ops.some((o) => o.room !== id)) throw new Error("append: op.room ≠ " + id);
    write(id, ops);
    ops.forEach((o) => applyOp(st, o));
    cache.set(id, st);
    byHash.set(roomHash(id), id);
    return st;
  };

  return {
    get: load,
    ensure: (id, open) => load(id) ?? append(id, [{ op: "open", room: id, ...open }]),
    append,
    ids,
    roomOfMsg: (msgId) => {
      const p = parseMsgId(msgId);
      return p ? byHash.get(p.hash) : undefined;
    },
    fileOf,
  };
};
