// Rolepage 的全局搜索 (cmd+k) —— 从视角 role 出发, 一次查三样: role 名字、它的会话名、
// 它看得到的消息正文。纯函数, 无 IO。
//
// 「看得到」与会话窗口同一口径: 公开频道里的每一句 (群窗不按人过滤), 私聊里与我有关的那些;
// 范围是视角参与过的会话 (convsOf), 不受 session 切片 —— 搜的是全部时间, 跳过去时客户端
// 自己把 session 放宽到能看见那一句。保温 ping 不是话, 不进结果。
import { splitReminders } from "./detail-render.js";
import { convKeyOf, convsOf, isPing, unwrapMates, type Directory, type Msg } from "./role-view.js";

export interface RoleHit { id: string; name: string; label: string; wizard: boolean; description: string }
export interface ConvHit { key: string; kind: string; name: string; label: string; preview: string; lastTs: number }
export interface MsgHit {
  id: string;
  conv: string;
  convName: string;
  from: string;
  fromName: string;
  fromLabel: string;
  ts: number;
  snippet: string;
}
export interface SearchResult { roles: RoleHit[]; convs: ConvHit[]; msgs: MsgHit[]; msgTotal: number }

const ROLE_MAX = 8;
const CONV_MAX = 8;
const MSG_MAX = 40;
const SNIP_BEFORE = 30;
const SNIP_LEN = 140;

const termsOf = (q: string): string[] => q.toLowerCase().split(/\s+/).filter(Boolean);
const matches = (terms: readonly string[]) => (s: string): boolean => {
  const low = s.toLowerCase();
  return terms.every((t) => low.includes(t));
};

/** 一条消息可搜的正文: 入 = 问话 (去掉 reminder 与队友包装); 出 = 这一轮说出的全部 text。 */
const textOf = (m: Msg): string =>
  (m.dir === "in"
    ? splitReminders(unwrapMates(m.turn.userQuery ?? "")).body
    : m.turn.items.flatMap((it) => (it.t === "text" ? [it.body] : [])).join("\n"))
    .replace(/\s+/g, " ").trim();

/** 正文里第一处命中的前后一截。 */
const snippetOf = (text: string, terms: readonly string[]): string => {
  const low = text.toLowerCase();
  const at = terms.map((t) => low.indexOf(t)).filter((i) => i >= 0).reduce((a, b) => Math.min(a, b), Infinity);
  const from = Number.isFinite(at) ? Math.max(0, at - SNIP_BEFORE) : 0;
  return (from ? "…" : "") + text.slice(from, from + SNIP_LEN) + (from + SNIP_LEN < text.length ? "…" : "");
};

/** 名字以查询开头的排前, 其余照原序。 */
const prefixFirst = (q: string) => (a: { name: string }, b: { name: string }): number =>
  Number(b.name.toLowerCase().startsWith(q)) - Number(a.name.toLowerCase().startsWith(q));

export const searchRole = (msgs: readonly Msg[], role: string, dir: Directory, q: string, now: number): SearchResult => {
  const terms = termsOf(q);
  if (!terms.length) return { roles: [], convs: [], msgs: [], msgTotal: 0 };
  const hit = matches(terms);
  const head = terms[0]!;

  const humans = [...new Set(msgs.flatMap((m) => [m.from, m.to]))].filter((r) => r.startsWith("human:") && r !== "human:");
  const roles = [...dir.wizards(), ...humans]
    .filter((id) => id !== role)
    .map((id): RoleHit => ({
      id, name: dir.nameOf(id), label: dir.labelOf(id), wizard: dir.isWizard(id), description: dir.fact(id)?.description ?? "",
    }))
    .filter((r) => hit(r.name) || hit(r.description))
    .sort((a, b) => prefixFirst(head)(a, b) || (dir.fact(b.id)?.lastActivity ?? 0) - (dir.fact(a.id)?.lastActivity ?? 0))
    .slice(0, ROLE_MAX);

  const convs = convsOf(msgs, role, dir, now);
  const convName = new Map(convs.map((c) => [c.key, c.name] as const));
  const convHits = convs
    .filter((c) => hit(c.name))
    .sort(prefixFirst(head))
    .slice(0, CONV_MAX)
    .map((c): ConvHit => ({ key: c.key, kind: c.kind, name: c.name, label: c.label, preview: c.preview, lastTs: c.lastTs }));

  // 私聊只有与我有关的那几句进得了我的窗口; 公开频道的每一句都在群窗里。
  const visible = (m: Msg): boolean => (!!m.channel || m.from === role || m.to === role) && convName.has(convKeyOf(m, role));
  const found = msgs
    .filter((m) => !isPing(m) && visible(m))
    .map((m) => ({ m, text: textOf(m) }))
    .filter((x) => x.text && hit(x.text))
    .reverse();
  return {
    roles,
    convs: convHits,
    msgs: found.slice(0, MSG_MAX).map(({ m, text }): MsgHit => {
      const conv = convKeyOf(m, role);
      return {
        id: m.id, conv, convName: convName.get(conv) ?? "",
        from: m.from, fromName: dir.nameOf(m.from), fromLabel: dir.labelOf(m.from),
        ts: m.ts, snippet: snippetOf(text, terms),
      };
    }),
    msgTotal: found.length,
  };
};
