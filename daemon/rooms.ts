// room 账本的落盘 (契约 §1/§2): 一 room 一个 append-only jsonl, 每次 append 同步 fsync。
// journal 纪律沿用 router 那套: 撕裂的尾行 (进程死在写一半) 丢弃; 中段坏行 = 这个 room 拒绝
// 读写 (fail closed, 503), 不猜、不跳过 —— 账本是完成与发言的唯一事实, 宁停不错。
// 状态是 shared/room.ts 的 fold, 在内存里随 append 增量推进; registry 不落盘, 由目录现扫。
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { applyOp, emptyRoom, parseMsgId, roomHash, type Binding, type BindOp, type OpenOp, type RoomOp, type RoomState, type UnbindOp } from "../shared/room.js";

export class RoomBroken extends Error {
  constructor(readonly room: string, reason: string) { super("room " + room + " 账本损坏: " + reason); }
}

const isBindOp = (o: RoomOp): o is BindOp | UnbindOp => o.op === "bind" || o.op === "unbind";

/** 内存索引里的一条: 绑定 + 承载它的 room。 */
export interface SourceBinding extends Binding { room: string }
/** boot 对账闸 (「内存态 = 盘上重放」): ok=false 时拒绝 bind/unbind 写, 路由与读侧回落恒等。 */
export interface BindingGate { ok: boolean; reason?: string }
/** 闸关着时的绑定写被拒 (P3 的路由据此回 503)。 */
export class BindGateClosed extends Error {
  constructor(reason: string) { super("bind 索引对账失败, 拒绝绑定写: " + reason); }
}

export interface RoomStore {
  /** 已存在的 room 状态; 没有文件 = undefined。损坏抛 RoomBroken。 */
  get: (id: string) => RoomState | undefined;
  /** 没有就以 open 行建出来。 */
  ensure: (id: string, open: Omit<OpenOp, "op" | "room">) => RoomState;
  /** 同步落盘 (fsync) 后推进内存状态。 */
  append: (id: string, ops: readonly RoomOp[]) => RoomState;
  ids: () => string[];
  /** 副源 → 承载它的 room (boot 从全部账本折出, 纯缓存可重建)。未绑定 / 闸关 = undefined ——
   *  调用方一律回落恒等 (源自己那条 room), 与存量行为逐字节相同。 */
  roomOfSource: (source: string) => string | undefined;
  /** 当前索引快照 (诊断 / 测试)。 */
  bindings: () => ReadonlyMap<string, SourceBinding>;
  /** boot 对账闸的判定 (只读)。 */
  bindingGate: () => BindingGate;
  roomOfMsg: (msgId: string) => string | undefined;
  /** 8 位 hash → room (注入头 #hash 的反查; 撞车 = undefined, 用完整 id)。 */
  roomByHash: (hash: string) => string | undefined;
  /** 这个 hash 是否撞了 (两个不同 room 同一 hash) —— 房头据此退回全 id。 */
  hashAmbiguous: (hash: string) => boolean;
  /** 每个 room 的文件路径 (迁移脚本 / 测试)。 */
  fileOf: (id: string) => string;
}

export const roomFile = (dir: string, id: string): string => join(dir, encodeURIComponent(id) + ".jsonl");

/** 参数形如 `#hash8` (可省 #) 的 room 简写 → 全 id; 不是这个形状 = undefined (调用方继续按
 *  全 id / 聊天名认); 撞车 = 明确报错, 绝不猜是哪一个。 */
export const resolveHashRef = (store: Pick<RoomStore, "roomByHash" | "hashAmbiguous">, ref: string): { room: string } | { error: string } | undefined => {
  const m = /^#?([0-9a-f]{8})$/.exec((ref ?? "").trim());
  if (!m) return undefined;
  const hash = m[1]!;
  if (store.hashAmbiguous(hash)) return { error: "hash 歧义 (两个 room 同 hash), 请用完整 room id: " + hash };
  const room = store.roomByHash(hash);
  return room ? { room } : undefined;
};

/** 往 hash 索引里放一个 room。同 hash 落到第二个不同 id = 撞车: 记进 collided, 反查一律
 *  让调用方退完整 id —— 静默覆盖会让 #hash 指到另一个 room 的账本去。 */
export const indexRoomHash = (byHash: Map<string, string>, collided: Set<string>, hash: string, id: string): void => {
  const prev = byHash.get(hash);
  if (prev && prev !== id) { collided.add(hash); return; }
  byHash.set(hash, id);
};

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
  const collided = new Set<string>();
  const fileOf = (id: string): string => roomFile(dir, id);
  const ids = (): string[] => readdirSync(dir).filter((f) => f.endsWith(".jsonl")).map((f) => decodeURIComponent(f.slice(0, -6)));
  for (const id of ids()) indexRoomHash(byHash, collided, roomHash(id), id);

  // ── boot 绑定索引 + 对账闸 (§3.2) ────────────────────────────────────
  // 同一批账本走两路推导, 必须逐笔对上: ① 行上自称的容器 (op.room) 按目录序应用成索引;
  // ② 每个账本自己 fold 出的 bindings (容器 = 文件名)。差一笔 = 内存态 ≠ 盘上重放
  // (行写错了 room / 同一源绑进两个 room / 账本读不出来) → fail-closed: 拒绝后续 bind/unbind
  // 写, 路由与读侧回落恒等, 主流程照常。
  const buildBindingIndex = (): { index: Map<string, SourceBinding>; gate: BindingGate } => {
    const index = new Map<string, SourceBinding>();
    const problems: string[] = [];
    let folded = 0;
    for (const id of ids().sort()) {
      let ops: RoomOp[];
      try {
        ops = parseJournal(id, readFileSync(fileOf(id), "utf8"));
      } catch (e) {
        problems.push("账本读不出 (" + id + "): " + (e instanceof Error ? e.message : String(e)));
        continue;
      }
      for (const op of ops) {
        if (!isBindOp(op)) continue;
        if (op.room !== id) { problems.push(op.op + " 行声称 " + op.room + ", 却在 " + id + " 的账本里"); continue; }
        if (op.op === "unbind") { if (index.get(op.source)?.room === id) index.delete(op.source); continue; }
        const prev = index.get(op.source);
        if (prev?.room && prev.room !== id) problems.push("源 " + op.source + " 同时绑在 " + prev.room + " 与 " + id);
        index.set(op.source, { room: id, at: op.at, by: op.by, ...(op.why ? { why: op.why } : {}) });
      }
      const st = ops.reduce(applyOp, emptyRoom(id));
      folded += st.bindings.size;
      for (const source of st.bindings.keys()) {
        const hit = index.get(source);
        if (hit?.room !== id) problems.push("源 " + source + " 在 " + id + " 的 fold 里有, 索引说 " + (hit?.room ?? "没有"));
      }
    }
    if (folded !== index.size) problems.push("绑定总数对不上: fold " + folded + " 笔 / 索引 " + index.size + " 笔");
    return problems.length
      ? { index, gate: { ok: false, reason: problems.slice(0, 5).join("; ") } }
      : { index, gate: { ok: true } };
  };
  const built = buildBindingIndex();
  const bindIndex = built.index;
  const gate = built.gate;
  if (!gate.ok) console.warn("[rooms] 绑定索引对账失败, 拒绝 bind/unbind 写 (路由回落恒等): " + gate.reason);

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
      indexRoomHash(byHash, collided, roomHash(id), id);
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
    if (!gate.ok && ops.some(isBindOp)) throw new BindGateClosed(gate.reason ?? "");
    write(id, ops);
    ops.forEach((o) => applyOp(st, o));
    for (const o of ops) {
      if (o.op === "bind") bindIndex.set(o.source, { room: id, at: o.at, by: o.by, ...(o.why ? { why: o.why } : {}) });
      else if (o.op === "unbind") { if (bindIndex.get(o.source)?.room === id) bindIndex.delete(o.source); }
    }
    cache.set(id, st);
    indexRoomHash(byHash, collided, roomHash(id), id);
    return st;
  };

  return {
    get: load,
    ensure: (id, open) => load(id) ?? append(id, [{ op: "open", room: id, ...open }]),
    append,
    ids,
    roomOfSource: (source) => (gate.ok ? bindIndex.get(source)?.room : undefined),
    bindings: () => bindIndex,
    bindingGate: () => gate,
    roomOfMsg: (msgId) => {
      const p = parseMsgId(msgId);
      return p && !collided.has(p.hash) ? byHash.get(p.hash) : undefined;
    },
    roomByHash: (hash) => (collided.has(hash) ? undefined : byHash.get(hash)),
    hashAmbiguous: (hash) => collided.has(hash),
    fileOf,
  };
};
