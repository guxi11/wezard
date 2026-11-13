// 频道上下文: 把「这次该让 wizard 看见多少历史」压成一段预算内的文本。
//
// 纯函数 —— 取数 (本地缓存 / 官方接口) 在 channel.ts, 这里只负责选与截断。
// 优先级固定为 当前线程 > 最近 > 搜索命中: 超出预算先丢搜索, 再丢最旧的最近消息;
// 线程几乎总该留下 —— 一条评论脱离父帖就没意义了。
import type { ChannelMsg } from "./channel-store.js";

export interface ChannelContextInput {
  topicId: string;
  postId?: string;
  /** 父帖 + 它最近的评论。 */
  thread?: ChannelMsg[];
  /** 频道最近 N 条帖子。 */
  recent?: ChannelMsg[];
  /** 本地/官方搜索命中。 */
  hits?: ChannelMsg[];
  query?: string;
  /** 判官的一句话理由。 */
  reason?: string;
  /** 判官的意图识别: 这条消息想干什么。 */
  intent?: string;
  /** 触发消息本身是评论时的 reply_id; 缺省 = 这次触发的就是帖子本身。 */
  replyId?: string;
  /** 入站帧 id —— 主 agent 靠它指回原始消息 (read_channel / 回复引用)。 */
  msgid?: string;
  /** 本频道最近活跃的其他机器人 (§6 邻居感知): bot:<id> → 条数, 自动机器人已剔除。 */
  bots?: Array<{ id: string; n: number }>;
  budget: number;
}

const LINE_MAX = 300;

const pad = (n: number): string => String(n).padStart(2, "0");

const clock = (ms: number): string => {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

const clip = (s: string, n = LINE_MAX): string => (s.length > n ? s.slice(0, n) + "…" : s);

const oneLine = (m: ChannelMsg): string => `${clock(m.at)} ${m.author}: ${clip(m.text)}`;

/** 触发消息本身在正文里已经有一份; 上下文里再出现一次只是噪声。 */
export const withoutMsg = (list: ChannelMsg[] | undefined, skipId?: string): ChannelMsg[] =>
  (list ?? []).filter((m) => m.id !== skipId);

export const formatChannelContext = (i: ChannelContextInput): string => {
  const sections = [
    i.thread?.length ? { title: "当前线程:", lines: i.thread.map((m, k) => (k === 0 ? "  " : "  └ ") + oneLine(m)) } : undefined,
    i.recent?.length ? { title: "最近:", lines: i.recent.map((m) => "  " + oneLine(m)) } : undefined,
    i.hits?.length ? { title: `搜索命中${i.query ? ` (${clip(i.query, 40)})` : ""}:`, lines: i.hits.map((m) => "  " + oneLine(m)) } : undefined,
  ].filter((s): s is { title: string; lines: string[] } => !!s);

  const head = `[频道上下文] topic=${i.topicId}${i.postId ? ` post=${i.postId}` : ""}${i.replyId ? ` reply=${i.replyId}` : ""}${i.msgid ? ` msgid=${i.msgid}` : ""}`;
  const out: string[] = [head];
  const tail = (i.reason ? 220 : 0) + (i.intent ? 260 : 0);
  let left = Math.max(300, i.budget - head.length - tail);
  // 邻居感知 (§6): 频道是跨 bot 的总线, 主 wizard 要一眼看到谁也在场 ——
  // 身份只认 bot:<id>, 消息头里的自称名要从历史行里读。
  if (i.bots?.length) {
    const line = `本频道最近活跃的机器人: ${i.bots.map((b) => `${b.id} (${b.n})`).join("、")}`;
    out.push(line);
    left -= line.length + 1;
  }
  for (const s of sections) {
    if (left <= s.title.length) continue;
    out.push(s.title);
    left -= s.title.length + 1;
    let shown = 0;
    for (const line of s.lines) {
      if (line.length + 1 > left) break;
      out.push(line);
      left -= line.length + 1;
      shown += 1;
    }
    if (shown < s.lines.length) out.push(`  …(另 ${s.lines.length - shown} 条没放下)`);
  }
  if (i.reason) out.push(`[判官] ${clip(i.reason, 200)}`);
  if (i.intent) out.push(`[判官] 意图: ${clip(i.intent, 200)}`);
  return out.join("\n");
};

/** 指代 / 错误现场才值得去翻历史, 否则每条消息都搜一遍只是白花钱。 */
const REFERENCE_RE = /刚才|上面|之前|前面|那个|这个|这条|那条|上次|报错|错误|失败|异常|日志|error|exception|traceback/i;

export const wantsHistory = (text: string): boolean =>
  REFERENCE_RE.test(text) || text.includes("\u0060") || /[0-9]{3,}/.test(text) ||
  text.split(/\s+/).some((w) => w.startsWith("/") && w.length >= 4);

/** 从一句话里挑一个搜索词: 反引号里的词 > 路径 > 最长的英文标识符 / 错误码。 */
export const pickQuery = (text: string): string => {
  const open = text.indexOf("\u0060");
  const close = open >= 0 ? text.indexOf("\u0060", open + 1) : -1;
  if (close > open + 2) return text.slice(open + 1, close).trim().slice(0, 40);
  const tokens = text.split(/[\s，。、；：:()（）]+/).map((t) => t.replace(/[?!,.;]+$/, ""));
  const path = tokens.filter((t) => t.startsWith("/") && t.length >= 4).sort((a, b) => b.length - a.length)[0];
  if (path) return path.slice(0, 40);
  const word = tokens
    .filter((t) => /^[A-Za-z_][A-Za-z0-9_.-]{2,39}$/.test(t) || /^[0-9]{3,}$/.test(t))
    .sort((a, b) => b.length - a.length)[0];
  return (word ?? "").slice(0, 40);
};
