// 每个聊天一份 append-only jsonl 的本地记录 (v3 P7-S1) —— 群聊严格治理的账本底座。
// 写法参照 daemon/channel-store.ts (ChannelStore): 内存里每个聊天一份行表 + 单调 seq,
// 落盘 append-only; 读回时容忍半行 (进程被杀在写的中途)。
//
// 与 ChannelStore 的差别在**写失败语义**: 这里的 append 挂在人话入站 / 出站包装的
// 热路径上, 调用方**不 await** (判据⑥: 入站不 await 写盘, 写失败只记日志) ——
// `record()` 同步改内存 (seq 立即生效, 不回退), 异步落盘, 落盘失败 log.warn 后照常生活。
// 本地记录不是事实来源: 企微才是; 丢一段只损失 S2 之后的上下文补发能力。
import { appendFile, mkdir } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Logger } from "pino";
import type { ChatLine } from "../shared/chat-record.js";

export interface ChatRecordsOptions {
  dir: string;
  keepDays: number;
  maxLines: number;
}

/** 单行落盘上限: 记录是上下文原料, 不是存档; 超长由 sliceBatch 的指针语义兜住。 */
const LINE_TEXT_MAX = 4000;

interface ChatState { lines: ChatLine[]; seq: number }

export class ChatRecords {
  private readonly dir: string;
  private readonly keepMs: number;
  private readonly maxLines: number;
  private readonly log?: Logger;
  private readonly chats = new Map<string, ChatState>();

  constructor(o: ChatRecordsOptions, log?: Logger) {
    this.dir = o.dir;
    this.keepMs = Math.max(1, o.keepDays) * 86_400_000;
    this.maxLines = Math.max(100, o.maxLines);
    this.log = log;
  }

  private file(chat: string): string {
    return join(this.dir, `${encodeURIComponent(chat)}.jsonl`);
  }

  private state(chat: string): ChatState {
    const hit = this.chats.get(chat);
    if (hit) return hit;
    // 首触同步读一次 (每聊天每进程一次, 文件被保留上限框住): record() 是同步契约 ——
    // 调用方不 await, 异步装载会在首条记录上分配出与盘上冲突的 seq。
    const st: ChatState = { lines: [], seq: 0 };
    this.chats.set(chat, st);
    try {
      const raw = readFileSync(this.file(chat), "utf8");
      for (const ln of raw.split("\n")) {
        if (!ln.trim()) continue;
        try {
          const m = JSON.parse(ln) as ChatLine;
          if (m && typeof m.seq === "number" && m.seq > st.seq) { st.seq = m.seq; st.lines.push(m); }
        } catch { /* 写到一半的半行, 丢掉 */ }
      }
    } catch { /* ENOENT: 这个聊天还没记过 */ }
    return st;
  }

  /** 记一行。**同步返回, 不落盘等待**: 内存立刻生效 (含 seq 分配), 落盘在后台尽力而为。
   *  同 id 重写覆盖 (重投 / 编辑), 与 ChannelStore 同一语义。 */
  record(chat: string, line: Omit<ChatLine, "chat" | "seq">): ChatLine {
    const st = this.state(chat);
    // 空 id (sendMessage 推送没有流 id) 不参与去重 —— 每次都是新行。
    const prev = line.id ? st.lines.find((l) => l.id === line.id) : undefined;
    const full: ChatLine = { ...line, chat, seq: prev?.seq ?? ++st.seq, text: line.text.slice(0, LINE_TEXT_MAX) };
    if (prev) { const i = st.lines.indexOf(prev); st.lines[i] = full; }
    else {
      st.lines.push(full);
      const cutoff = Date.now() - this.keepMs;
      while (st.lines.length > this.maxLines || (st.lines[0] && st.lines[0]!.at < cutoff && st.lines.length > 1)) st.lines.shift();
    }
    void this.persist(chat, full).catch(() => undefined);
    return full;
  }

  private async persist(chat: string, line: ChatLine): Promise<void> {
    try {
      await mkdir(this.dir, { recursive: true });
      await appendFile(this.file(chat), JSON.stringify(line) + "\n", "utf8");
    } catch (e) {
      // 判据⑥: 只记日志, 不抛、不影响消息处理。
      this.log?.warn({ chat, id: line.id, err: (e as Error).message }, "chat-records: 落盘失败 (记录只在内存)");
    }
  }

  /** 读一个聊天的在存行 (旧→新); 供 chat_members / S3 的 read_chat strict 面用。 */
  lines(chat: string): ChatLine[] {
    return [...this.state(chat).lines];
  }

  count(chat: string): number {
    return this.state(chat).lines.length;
  }
}

/** 聊天键的规范形: 出站包装层手里只有裸 chatid (可能带 `~bot` 后缀), 记录与成员表
 *  统一用 base principal (`chat:wr…` / `user:xxx`)。群 chatid 以 `wr` 开头
 *  (last-response 的 tracker 同一判据); 带前缀的输入原样通过。 */
export const chatPrincipalOf = (chatid: string): string => {
  const bare = (chatid ?? "").trim().replace(/~[^~]+$/, "");
  if (!bare) return "";
  if (/^(chat|user|group):/.test(bare)) return bare;
  return bare.startsWith("wr") ? `chat:${bare}` : `user:${bare}`;
};
