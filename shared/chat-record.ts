// 群聊严格治理 (v3 P7-S1) 的记录原子: 纯函数, 无 IO —— 落盘在 daemon/chat-records.ts,
// 这里只有「怎么切一批上下文」与「怎么渲染」。
//
// 一行 = 一个聊天里的一句可见话: 人 (kind=human, author=userid) / wizard (裸名) /
// 系统 ([wezard]·[mirror] 通知、卡片)。`chat` 是稳定聊天键 (base principal, `chat:wr…` /
// `user:xxx` —— 与 chatPolicy / 信封 chat-key 同一键空间); `seq` 每聊天单调递增,
// 是成员游标 (members.cursor) 与 chatlog 信封 from/to 的度量单位。

export interface ChatLine {
  /** 稳定聊天键 (base principal, 带 `chat:` / `user:` 前缀)。 */
  chat: string;
  /** 每聊天单调递增的序号; 游标与批量边界都按它。 */
  seq: number;
  /** epoch ms。 */
  at: number;
  /** 行 id: 人话 = 消息 msgid, 出站 = 流/终句 id, 系统 = 合成 id。全聊天唯一。 */
  id: string;
  /** 人 = userid; wizard = 裸名 (不带记号); 系统 = "wezard" / ""。 */
  author: string;
  kind: "human" | "wizard" | "system";
  text: string;
  /** 它回答的那一行 (wizard 行 → 触发它的人话行 id); S1 记录侧先不写, 语义位留给 S2。 */
  re?: string;
}

/** 单行正文上限 (字)。触发消息全文不受它约束。 */
export const CHAT_LINE_MAX = 300;
/** 一批的默认字符预算 (≈2k token; S2 验收口径整批 ≤6KB)。 */
export const CHAT_BATCH_BUDGET = 3600;

/** 卡片类系统行的标记前缀 (记录侧统一写它, 读取侧统一剔它 —— 两端同一个词)。 */
export const CARD_LINE_MARK = "[卡片]";

const isCardSystem = (l: ChatLine): boolean =>
  l.kind === "system" && (l.text.startsWith(CARD_LINE_MARK) || !l.text.trim());

/** 溢出行的一行指针: 正文不进批, 留 id 供详情页 / read_chat 追全文。 */
const pointerOf = (l: ChatLine): string => `‹长文 ${l.id} · ${l.text.length} 字›`;

/** 一行渲染成一行文本 (换行压平 —— 批里一行就是一句)。`full` = 触发消息全文。 */
export const renderLine = (l: ChatLine, full = false): string => {
  const who = l.author || "wezard";
  const head = `[${l.seq}] ${who}: `;
  const body = full || l.text.length <= CHAT_LINE_MAX ? l.text.replace(/\s+/g, " ").trim() : pointerOf(l);
  return head + body;
};

export interface ChatBatch {
  /** 批里第一条的 seq (chatlog 信封的 from)。 */
  from: number;
  /** 批里最后一条的 seq —— 新游标 (committed 后 members.advance 到它)。 */
  to: number;
  /** 触发行 (最新一条) 的 id —— 拿了全文的那条。 */
  trigger: string;
  /** 选中的行, 旧→新。 */
  lines: ChatLine[];
  /** 渲染好的批正文。 */
  render: string;
  /** 游标之后还有没进批的行 (预算用尽被裁掉)。 */
  more: boolean;
}

/** 从游标之后取一批上下文: 触发消息 (最新一条) 给全文, 其余从新到旧装到预算为止,
 *  超长行写成一行指针; 剔除 self 自己说过的话与卡片类系统行。`cursor` = 已消费的
 *  最大 seq (-1 = 从头)。没有可选行 → undefined。 */
export const sliceBatch = (
  lines: readonly ChatLine[],
  cursor: number,
  budget = CHAT_BATCH_BUDGET,
  self = "",
): ChatBatch | undefined => {
  const eligible = lines.filter((l) => l.seq > cursor && l.author !== self && !isCardSystem(l));
  if (!eligible.length) return undefined;
  const trigger = eligible[eligible.length - 1]!;
  // 从新到旧装箱; 第一条 (触发行) 无论多大都收 —— 没有它的批没有意义。
  const picked: ChatLine[] = [];
  let used = 0;
  for (let i = eligible.length - 1; i >= 0; i--) {
    const l = eligible[i]!;
    const cost = l === trigger || l.text.length <= CHAT_LINE_MAX ? l.text.length : pointerOf(l).length;
    if (picked.length && used + cost > budget) break;
    picked.unshift(l);
    used += cost;
  }
  return {
    from: picked[0]!.seq,
    to: picked[picked.length - 1]!.seq,
    trigger: trigger.id,
    lines: picked,
    render: renderBatch(picked, trigger.id),
    more: picked.length < eligible.length,
  };
};

/** 整批渲染: 触发行全文, 其余单行截断/指针 (sliceBatch 的 render 就是它; 独立留着
 *  给测试与 S3 面板复用)。 */
export const renderBatch = (lines: readonly ChatLine[], triggerId = ""): string =>
  lines.map((l) => renderLine(l, l.id === triggerId)).join("\n");
