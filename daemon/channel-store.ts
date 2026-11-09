// 频道消息的本地有界缓存: 每个 topic 一份 append-only jsonl。
//
// 为什么 daemon 也要存一份, 而不是每条消息都当场打官方接口:
//  - 判官对**每条**频道消息都要看最近 N 条, 一次 1–2 个 API 调用既拖慢判断又撞限流;
//  - reload / 断线有十几秒空窗 (2026-11-09 实测 21:03:14–21:03:29), 这期间的事件服务端
//    不会补发, 本地有缓存还能接着用;
//  - read_channel 的常见问法是「刚才那个 / 上面那條」, 本地 grep 立刻能答。
// 但本地不是事实来源: 离线期间与入群之前的历史它没有, 语义搜索也只有服务端有 ——
// 所以读取顺序永远是「本地够用就用本地, 不够再回填 / 搜索」。
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";

export interface ChannelMsg {
  /** post_id 或 reply_id —— 同 id 后写的覆盖先写的 (编辑后的正文)。 */
  id: string;
  kind: "post" | "reply";
  postId: string;
  /** epoch ms。 */
  at: number;
  /** userid, 或 `bot:<aibotid 前十位>`。 */
  author: string;
  text: string;
}

export interface ChannelStoreOptions {
  dir: string;
  keepDays: number;
  maxMessages: number;
}

/** 单条落盘上限: 频道消息一般不长, 长文也只留够 read_channel 用的部分。 */
const LINE_MAX = 2000;

export class ChannelStore {
  private readonly dir: string;
  private readonly keepMs: number;
  private readonly maxMessages: number;
  private readonly topics = new Map<string, ChannelMsg[]>();

  constructor(o: ChannelStoreOptions) {
    this.dir = o.dir;
    this.keepMs = Math.max(1, o.keepDays) * 86_400_000;
    this.maxMessages = Math.max(100, o.maxMessages);
  }

  private file(topicId: string): string {
    return join(this.dir, `${encodeURIComponent(topicId)}.jsonl`);
  }

  /** 同 id 覆盖 (编辑事件 / 重投), 再按条数截断。 */
  private trim(list: ChannelMsg[]): ChannelMsg[] {
    const byId = new Map<string, ChannelMsg>();
    for (const m of list) byId.set(m.id, m);
    return [...byId.values()].slice(-this.maxMessages);
  }

  private async ensure(topicId: string): Promise<ChannelMsg[]> {
    const cached = this.topics.get(topicId);
    if (cached) return cached;
    const list: ChannelMsg[] = [];
    try {
      const raw = await readFile(this.file(topicId), "utf8");
      for (const ln of raw.split("\n")) {
        if (!ln.trim()) continue;
        try {
          const m = JSON.parse(ln) as ChannelMsg;
          if (m?.id && m.text) list.push(m);
        } catch { /* 进程被杀在写的中途留下的半行, 丢掉 */ }
      }
    } catch { /* ENOENT: 这个频道还没存过 */ }
    const kept = this.trim(list.filter((m) => Date.now() - m.at <= this.keepMs));
    this.topics.set(topicId, kept);
    return kept;
  }

  /** 追加一条。落盘是尽力而为 —— 缓存坏掉不能影响消息处理本身。 */
  async append(topicId: string, msg: ChannelMsg): Promise<void> {
    const list = await this.ensure(topicId);
    this.topics.set(topicId, this.trim([...list, msg]));
    try {
      await mkdir(this.dir, { recursive: true });
      await appendFile(this.file(topicId), JSON.stringify({ ...msg, text: msg.text.slice(0, LINE_MAX) }) + "\n", "utf8");
    } catch { /* 只丢本地缓存能力 */ }
  }

  async recentPosts(topicId: string, limit: number): Promise<ChannelMsg[]> {
    const list = await this.ensure(topicId);
    return list.filter((m) => m.kind === "post").slice(-limit);
  }

  /** 一个帖子 + 它最近 maxReplies 条评论 (旧→新)。 */
  async thread(topicId: string, postId: string, maxReplies: number): Promise<ChannelMsg[]> {
    const list = await this.ensure(topicId);
    const root = list.filter((m) => m.kind === "post" && m.postId === postId);
    const replies = list.filter((m) => m.kind === "reply" && m.postId === postId).slice(-Math.max(0, maxReplies));
    return [...root, ...replies];
  }

  async count(topicId: string): Promise<number> {
    return (await this.ensure(topicId)).length;
  }

  /** read_channel 用: 按时间窗 / 条数取, 帖子与评论混排。 */
  async slice(topicId: string, o: { since?: number; until?: number; limit: number }): Promise<ChannelMsg[]> {
    const list = await this.ensure(topicId);
    return list
      .filter((m) => (o.since === undefined || m.at >= o.since) && (o.until === undefined || m.at < o.until))
      .slice(-o.limit);
  }

  async search(topicId: string, query: string, limit: number): Promise<ChannelMsg[]> {
    const needle = query.trim().toLowerCase();
    if (!needle) return [];
    const list = await this.ensure(topicId);
    return list.filter((m) => m.text.toLowerCase().includes(needle)).slice(-limit);
  }
}
