// wireMsg 的 reQuote: chat detail 的引用块数据 (有 re / 多 re / 查不到 三种), 只读、不改正文。
import assert from "node:assert/strict";
import { wireMsg } from "../shared/role-render.js";
import type { MsgRow } from "../shared/room.js";
import type { RoomMsg } from "../shared/room-view.js";

const alice = { kind: "wizard", id: "wA" } as const, admin = { kind: "human", id: "U1" } as const;
const row = (id: string, author: typeof alice | typeof admin, text: string, at: number) => ({ id, author, text, at, room: "chat:g" }) as unknown as MsgRow;
const rows = new Map([
  ["g.1", row("g.1", admin, "\n\n第一行 很长".padEnd(200, "长") + "\n第二行", 100)],
  ["g.2", row("g.2", alice, "我来\n第二行", 200)],
]);
const lookup = (id: string) => rows.get(id);
const nameOf = (w: { id: string }) => (w.id === "wA" ? "alice" : "张三");
const wire = wireMsg(lookup, nameOf);
const msg = (re?: string[]) => ({ id: "g.9", text: "好的", ...(re ? { re } : {}) }) as unknown as RoomMsg;

// 没有 re: 不画 quote
assert.equal((wire(msg()) as { reQuote?: unknown }).reQuote, undefined, "没有 re 就没有 reQuote");
// 单 re: 作者 + 名字 + 首行摘要 (≤80 字 + …) + 时刻 + room
const one = (wire(msg(["g.2"])) as { reQuote?: unknown[] }).reQuote as Array<Record<string, unknown>>;
assert.deepEqual(one, [{ id: "g.2", author: alice, authorName: "alice", snippet: "我来", at: 200, room: "chat:g" }]);
const long = (wire(msg(["g.1"])) as { reQuote?: Array<{ snippet: string }> }).reQuote![0]!.snippet;
assert.ok(long.startsWith("第一行") && long.endsWith("…") && long.length === 81, "首行 80 字截断: " + long.length);
// 多 re: 按序全带 (前端只画第一条, 其余折「+N」); 查不到的降级为 missing
const many = (wire(msg(["g.2", "g.404", "g.1"])) as { reQuote?: Array<Record<string, unknown>> }).reQuote!;
assert.deepEqual(many.map((q) => q.id), ["g.2", "g.404", "g.1"]);
assert.deepEqual(many[1], { id: "g.404", missing: true }, "查不到 = missing, 不编造作者");
// 不带 nameOf 也能跑 (旧调用点)
assert.equal(((wireMsg(lookup)(msg(["g.2"])) as { reQuote?: Array<Record<string, unknown>> }).reQuote![0]!).authorName, undefined);
console.log("re-quote: ok");
