// 微信 ClawBot 那一侧的文本形态 —— 全是纯函数。
//
// 微信 ClawBot 会话渲染 markdown 的一个子集 (链接、粗体、代码、表格、H1-H4), 但没有卡片按钮。
// 企微那一侧的输出 (markdown 气泡、模板卡片) 在这里被降到那个子集; 卡片降成「编号菜单」, 人回的数字再被解析回卡片上那个按钮的
// key —— 于是审批 / 提问 / 计划选择的全部逻辑不必知道微信存在。

/** ilink_user_id (`o9cq80…@im.wechat`) → 群聊 id `wx_o9cq80…`。确定性: 同一人重扫得到同一个群。 */
export const chatIdOfUser = (ilinkUserId: string): string =>
  `wx_${(ilinkUserId.split("@")[0] ?? "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 48) || "anon"}`;

/** 微信合成帧的 req_id 前缀 (`wx:<chatId>:<n>`): 帧本身就说明它属于微信, 不必查账号表。 */
export const WX_REQ = "wx:";
/** 这一帧来自微信 —— 没有企微 stream 的 ~6 分钟窗口, 也就不需要到点强制收口。 */
export const isWxFrame = (frame: unknown): boolean => {
  const id = (frame as { headers?: { req_id?: unknown } } | undefined)?.headers?.req_id;
  return typeof id === "string" && id.startsWith(WX_REQ);
};

/** 取不到昵称时的群名: `wx-o9cq80`。 */
export const shortNameOf = (ilinkUserId: string): string =>
  `wx-${(ilinkUserId.split("@")[0] ?? "").replace(/[^A-Za-z0-9]/g, "").slice(0, 6) || "user"}`;

/** 确认响应里若带了昵称类字段就用 (协议文档没有, 防服务端哪天给了)。 */
export const nickOf = (body: Record<string, unknown>): string =>
  ["nickname", "nick_name", "nickName", "user_name", "username", "display_name"]
    .map((k) => body[k])
    .find((v): v is string => typeof v === "string" && v.trim() !== "")?.trim() ?? "";

// ── 企微 markdown → 微信 ClawBot 认的子集 ─────────────────────────────
// 对齐官方插件 StreamingMarkdownFilter (2.1.3 起): 链接 / 粗体 / 代码 / 表格 / H1-H4 / 引用原样留着,
// 只剥它不认的。别再整段降纯文本 —— `[字](url)` 降成「字」就把链接吃了。
const rules: ReadonlyArray<readonly [RegExp, string]> = [
  [/!\[([^\]]*)\]\([^)]*\)/g, "$1"], // 图: 留 alt
  [/<\/?font[^>]*>/gi, ""], // 企微 markdown 的颜色标签
  [/^#{5,6}\s+/gm, ""],
  [/\n{3,}/g, "\n\n"],
];
export const wxMarkdown = (md: string): string => rules.reduce((s, [re, to]) => s.replace(re, to), md ?? "").trim();

/** 按段落 → 行 → 硬切的优先级切成 ≤max 字的片 (官方插件 4000)。 */
export const chunkText = (s: string, max = 4000): string[] => {
  if (s.length <= max) return s ? [s] : [];
  const cut = [s.lastIndexOf("\n\n", max), s.lastIndexOf("\n", max)].find((i) => i > max / 2) ?? max;
  return [s.slice(0, cut).trimEnd(), ...chunkText(s.slice(cut).trimStart(), max)];
};

// ── 卡片 → 编号菜单 ──────────────────────────────────────────────────
interface CardLike {
  card_type?: string;
  task_id?: string;
  main_title?: { title?: string; desc?: string };
  sub_title_text?: string;
  quote_area?: { title?: string; quote_text?: string };
  emphasis_content?: { title?: string; desc?: string };
  horizontal_content_list?: Array<{ keyname?: string; value?: string }>;
  button_list?: Array<{ text?: string; key?: string }>;
  checkbox?: { question_key?: string; mode?: number; option_list?: Array<{ id?: string; text?: string }> };
  submit_button?: { text?: string; key?: string };
}

/** 回数字之后要合成的那个点击: 按钮卡 = 第 n 个按钮的 key; 投票卡 = 提交键 + 选中的选项。 */
export type Choices =
  | { kind: "button"; keys: string[] }
  | { kind: "vote"; submitKey: string; questionKey: string; optionIds: string[]; multi: boolean }
  | { kind: "none" };

export const choicesOf = (c: CardLike): Choices => {
  const buttons = (c.button_list ?? []).filter((b) => b.key);
  if (buttons.length) return { kind: "button", keys: buttons.map((b) => b.key!) };
  const opts = c.checkbox?.option_list ?? [];
  if (opts.length && c.submit_button?.key) {
    return { kind: "vote", submitKey: c.submit_button.key, questionKey: c.checkbox?.question_key ?? "", optionIds: opts.map((o) => o.id ?? ""), multi: c.checkbox?.mode === 1 };
  }
  return { kind: "none" };
};

const labels = (c: CardLike): string[] =>
  (c.button_list?.length ? c.button_list.filter((b) => b.key).map((b) => b.text ?? "") : (c.checkbox?.option_list ?? []).map((o) => o.text ?? ""));

/** 卡片 → 一条纯文本。只认结构不认语义: 审批 / 提问 / 计划卡共用。 */
export const renderCard = (c: CardLike, code: string): string => {
  const ch = choicesOf(c);
  const body = [
    [c.main_title?.title, c.main_title?.desc].filter(Boolean).join(" · "),
    c.emphasis_content?.title && `${c.emphasis_content.title}${c.emphasis_content.desc ? ` ${c.emphasis_content.desc}` : ""}`,
    c.sub_title_text,
    c.quote_area?.title,
    c.quote_area?.quote_text,
    ...(c.horizontal_content_list ?? []).map((h) => `${h.keyname ?? ""}: ${h.value ?? ""}`),
  ].filter((x): x is string => !!x && x.trim() !== "").map(wxMarkdown);
  const menu = labels(c).map((t, i) => `【${i + 1}】${t}`);
  const how = ch.kind === "none" ? "" : ch.kind === "vote" && ch.multi ? `回数字作答 (可多选, 如 "1 3") · 短码 ${code}` : `回数字作答 · 短码 ${code}`;
  return [...body, menu.join("  "), how].filter(Boolean).join("\n");
};

/** 卡片被点之后的新卡 → 一行回执 (按钮被替换成了一个说明结果的按钮)。 */
export const renderAck = (c: CardLike, code: string): string => {
  const verdict = c.button_list?.[0]?.text || c.submit_button?.text || c.main_title?.title || "已处理";
  return `${code} → ${wxMarkdown(verdict)}`;
};

/** `1` / `k7q 1` / `k7q 1 3` / `1,3` → {code?, picks}; 不是菜单回复返回 undefined。 */
export const parseMenuReply = (text: string): { code?: string; picks: number[] } | undefined => {
  const m = /^\s*(?:([a-z0-9]{3})\s+)?(\d{1,2}(?:\s*[,，\s]\s*\d{1,2})*)\s*$/i.exec(text ?? "");
  if (!m) return undefined;
  const picks = (m[2] ?? "").split(/[\s,，]+/).filter(Boolean).map(Number);
  return { ...(m[1] ? { code: m[1].toLowerCase() } : {}), picks };
};

/** 菜单回复 → 合成点击要的 {event_key, selected_items}; 越界 / 单选多填返回 undefined。 */
export const clickOf = (ch: Choices, picks: readonly number[]): { eventKey: string; selected?: Array<{ question_key: string; option_ids: string[] }> } | undefined => {
  if (ch.kind === "button") {
    const k = picks.length === 1 ? ch.keys[(picks[0] ?? 0) - 1] : undefined;
    return k ? { eventKey: k } : undefined;
  }
  if (ch.kind === "vote") {
    const ids = picks.map((p) => ch.optionIds[p - 1]);
    if (!ids.length || ids.some((x) => x === undefined) || (!ch.multi && ids.length > 1)) return undefined;
    return { eventKey: ch.submitKey, selected: [{ question_key: ch.questionKey, option_ids: ids as string[] }] };
  }
  return undefined;
};

/** 3 位短码, 避开已占用的。 */
export const mintCode = (taken: ReadonlySet<string>, rnd: () => number = Math.random): string => {
  const alphabet = "abcdefghjkmnpqrstuvwxyz23456789";
  const one = (): string => Array.from({ length: 3 }, () => alphabet[Math.floor(rnd() * alphabet.length)]).join("");
  const walk = (n: number): string => ((c) => (taken.has(c) && n < 50 ? walk(n + 1) : c))(one());
  return walk(0);
};
