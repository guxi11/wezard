// rolepage 的搜索 (⌘K) —— room 账本时代的版本: 一次查三样: room 名、成员、消息正文。
// 纯函数, 无 IO; 名字由调用方注入 (与 room-view 同一口径)。
//
// 行为照 main 的 role-search: 空格分词、各词都要命中 (不分大小写); 名字以查询开头的排前;
// 消息新的在前, 只回前 MSG_MAX 条但报总数; 片段在第一处命中前后各留一截, 起点落在词/句边界上。
import { splitInline } from "./role-render.js";
import type { RoomFact } from "./room-view.js";
import { rowText, whoKey, type RenderNames, type RoomState, type Who } from "./room.js";

/** 有人参与的 room = 群聊 (绑定企微的群 / 单聊 / topic / 微信, 或账本里有人发过话); 其余 (wizard 之间的 dm / adhoc) = 会话。 */
export const isPeopleRoom = (r: Pick<RoomFact, "bound" | "kind" | "members">): boolean =>
  r.bound || (r.kind !== "dm" && r.kind !== "adhoc") || r.members.some((m) => m.who.kind === "human");

export interface RoomHit { id: string; kind: string; name: string; group: boolean; preview: string; lastAt: number; members: number }
export interface MemberHit { who: Who; name: string; rooms: number; lastAt: number }
export interface RowHit {
  id: string;
  room: string;
  roomName: string;
  roomKind: string;
  group: boolean;
  author: Who;
  authorName: string;
  toNames: string[];
  at: number;
  snippet: string;
  /** 这一句里命中的处数 (各词出现次数之和)。 */
  hits: number;
}
export interface RoomSearchResult { rooms: RoomHit[]; members: MemberHit[]; msgs: RowHit[]; msgTotal: number }

const ROOM_MAX = 8;
const MEMBER_MAX = 8;
const MSG_MAX = 40;
const SNIP_BEFORE = 24;
const SNIP_LEN = 90;
const SNAP = 12;

const termsOf = (q: string): string[] => q.toLowerCase().split(/\s+/).filter(Boolean);
const matches = (terms: readonly string[]) => (s: string): boolean => {
  const low = s.toLowerCase();
  return terms.every((t) => low.includes(t));
};

/** markdown 记号读出来是噪音: 代码围栏、反引号、粗斜体、标题井号、表格竖线与分隔行、链接的 url。 */
const plain = (s: string): string =>
  s.replace(/```[^\n]*\n?/g, " ")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s*\|?(\s*:?-{3,}:?\s*\|)+\s*:?-*:?\s*$/gm, " ")
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+/gm, "")
    .replace(/[`*_~|]+/g, " ")
    .replace(/\s+/g, " ").trim();

const countOf = (low: string, t: string): number => low.split(t).length - 1;

const BOUNDARY = /[\s,.;:!?，。；：！？、)\]）】」]/;
const snapAt = (text: string, i: number): number => {
  const j = text.slice(i, i + SNAP).search(BOUNDARY);
  return j < 0 ? i : i + j + 1;
};

const snippetOf = (text: string, terms: readonly string[]): string => {
  if (text.length <= SNIP_LEN) return text;
  const low = text.toLowerCase();
  const at = terms.map((t) => low.indexOf(t)).filter((i) => i >= 0).reduce((a, b) => Math.min(a, b), Infinity);
  const raw = Number.isFinite(at) ? Math.max(0, at - SNIP_BEFORE) : 0;
  const from = raw > 0 ? Math.min(snapAt(text, raw), at) : 0;
  const end = from + SNIP_LEN;
  return (from ? "…" : "") + text.slice(from, end).trim() + (end < text.length ? "…" : "");
};

/** 名字与查询全等的最前, 以查询开头的其次, 其余照原序。 */
const rank = (q: string, name: string): number => { const n = name.toLowerCase(); return n === q ? 2 : n.startsWith(q) ? 1 : 0; };
const prefixFirst = (q: string) => (a: { name: string }, b: { name: string }): number => rank(q, b.name) - rank(q, a.name);

/**
 * `facts` 决定搜哪些 room (调用方已按票据裁过); `roomName` = 显示名 (title > 聊天名 > 短代号)。
 * 消息正文剥掉 reminder / pasted_content 再搜 —— 与气泡里看到的是同一段字。
 */
export const searchRooms = (
  states: readonly RoomState[], facts: readonly RoomFact[], n: RenderNames, roomName: (id: string) => string, q: string,
): RoomSearchResult => {
  const terms = termsOf(q);
  if (!terms.length) return { rooms: [], members: [], msgs: [], msgTotal: 0 };
  const hit = matches(terms);
  const head = terms[0]!;
  const factBy = new Map(facts.map((f) => [f.id, f] as const));
  // roomName 已带上没起名 dm / adhoc 的成员名兜底 (shared/room-label.ts), 与列表 / 图同口径。
  const nameOf = roomName;

  const rooms = facts
    .map((f): RoomHit => ({
      id: f.id, kind: f.kind, name: nameOf(f.id), group: isPeopleRoom(f),
      preview: f.last ? (f.last.authorName ? f.last.authorName + ": " : "") + f.last.preview : "",
      lastAt: f.last?.at ?? 0, members: f.members.length,
    }))
    .filter((r) => hit(r.name))
    .sort((a, b) => prefixFirst(head)(a, b) || b.lastAt - a.lastAt)
    .slice(0, ROOM_MAX);

  const people = new Map<string, MemberHit>();
  for (const f of facts) for (const m of f.members) {
    const k = whoKey(m.who);
    const was = people.get(k);
    const at = f.last?.at ?? 0;
    people.set(k, was ? { ...was, rooms: was.rooms + 1, lastAt: Math.max(was.lastAt, at) } : { who: m.who, name: m.name, rooms: 1, lastAt: at });
  }
  const members = [...people.values()]
    .filter((m) => hit(m.name))
    .sort((a, b) => prefixFirst(head)(a, b) || b.lastAt - a.lastAt)
    .slice(0, MEMBER_MAX);

  const found: RowHit[] = [];
  for (const s of states) {
    const f = factBy.get(s.id);
    if (!f) continue;
    for (const m of s.msgs) {
      const files = (m.files ?? []).map((x) => x.name).join(" ");
      const text = plain(splitInline(rowText({ text: m.text ?? "", origin: m.origin })).body + (files ? " 📎 " + files : ""));
      if (!text || !hit(text)) continue;
      const low = text.toLowerCase();
      found.push({
        id: m.id, room: s.id, roomName: nameOf(s.id), roomKind: f.kind, group: isPeopleRoom(f),
        author: m.author, authorName: n.nameOf(m.author), toNames: (m.to ?? []).map((w) => n.nameOf(w)),
        at: m.at, snippet: snippetOf(text, terms), hits: terms.reduce((k, t) => k + countOf(low, t), 0),
      });
    }
  }
  found.sort((a, b) => b.at - a.at);
  return { rooms, members, msgs: found.slice(0, MSG_MAX), msgTotal: found.length };
};
