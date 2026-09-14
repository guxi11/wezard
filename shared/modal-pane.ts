// Detect whether a captured tmux pane is sitting on a MODAL Claude Code picker
// (tool-permission confirm, /model chooser, plan review, AskUserQuestion …).
//
// Why the mirror cares: a modal picker eats pasted text and reads Enter as
// "confirm the highlighted option". Injecting a WeCom message into one loses
// the message AND answers a permission prompt on the user's behalf — the user
// sees their session silently skip their input while a file edit they never
// approved goes through.
//
// The blocking case that motivated this: editing any file under `.claude/**`
// makes Claude Code raise its own "allow Claude to edit its own settings"
// confirm. That confirm does NOT go through the PreToolUse hook, so weclaude
// never learns about it, never sends a card, and the pane blocks until someone
// presses a key locally.
//
// Kept as a pure function over captured text so it is unit-testable without a
// live tmux server.

// A highlighted numbered option row: "❯ 1. Yes". The `❯` glyph alone is NOT
// evidence — the normal input box renders one too — so the digit + dot +
// non-space content are all load-bearing.
const MODAL_OPTION_ROW = /^\s*[❯>]\s*\d+\.\s+\S/mu;

// Picker footer. Present on Claude Code's pickers; CodeBuddy 的权限确认框没有它
// (快捷键提示内联在选项文案里, 如 "(escape)"), 由三件套形状判据补位, 见 isModalPane。
const MODAL_FOOTER = /Esc to cancel/iu;

// Title line of the confirm, surfaced in the failure reason so the user knows
// what is waiting for them. Optional — detection never depends on it.
// "Are you sure …?" 是 CodeBuddy 权限确认框的问句形态。
const MODAL_TITLE = /^\s*((?:(?:Do|Would|Should) you|Are you sure) .+?)\s*$/mu;

// CodeBuddy 把确认框画成整圈圆角边框, capture-pane 的每一行都带 `│` 前后缀,
// 所有行首锚定的判据 (选项行/标题/footer) 因此全部落空 —— 这正是 skipAll 哨兵
// 在 CodeBuddy 子代理 confirm 上失明的成因之一。判定前逐行剥掉行首行尾的框线;
// 内容中间的字面 `|` (管道) 不受影响。
const stripBoxBorders = (pane: string): string =>
  pane
    .split("\n")
    .map((l) => l.replace(/^\s*[│┃|]/u, "").replace(/\s*[│┃|]\s*$/u, ""))
    .join("\n");

export interface ModalPaneVerdict {
  modal: boolean;
  /** Confirm title, when the pane exposed a recognizable one. */
  title?: string;
}

/**
 * Conservative by construction: an option row PLUS a second independent piece of
 * evidence must both be present — either the "Esc to cancel" footer (Claude
 * Code 系全部 picker), or the permission three-piece option shape (裸 Yes +
 * "Yes, and…" + No, CodeBuddy 的权限确认框没有 footer, 这是它唯一的稳定指纹)。
 * A false positive blocks a legitimate message, which is worse than missing an
 * exotic picker layout — pasted text cannot fabricate a highlighted numbered
 * option row, and a message that merely lists "1. …" fabricates neither the
 * footer nor the full Yes/Yes,and/No triple.
 */
export const isModalPane = (pane: string): ModalPaneVerdict => {
  const p = stripBoxBorders(pane ?? "");
  if (!p || !MODAL_OPTION_ROW.test(p)) return { modal: false };
  if (!MODAL_FOOTER.test(p) && !hasPermissionShape(parseModalOptions(p))) return { modal: false };
  return { modal: true, title: p.match(MODAL_TITLE)?.[1] };
};

// ── 选项解析 + 代按 ────────────────────────────────────────────────────
// 只服务一个场景: 用户刚在企微卡片上显式批准了某次调用, 而 Claude Code 在 hook
// 返回后又立起它自己的原生确认框(见文件头 `.claude/**` 那段)。此时把答案按进
// pane 是"完成用户已经作出的决定", 不是替他做决定。
//
// 因此这里刻意只认**权限确认框**、只挑**一次性 Yes**:
//   • 标题必须长得像 "Do you want to …" —— /model 选择器、plan review 之类同样
//     是 modal, 但按下去的语义完全不同, 一律不碰;
//   • "Yes, and don't ask again …" / "Yes, and allow …" 这类会放宽后续权限的
//     选项永不选中 —— 用户要的就是"每次都点", 代按不能顺手把门拆了。
// 解析不出可信选项 → 返回 undefined, 调用方走取消+告知的兜底路径。

/** 编号选项行: "❯ 1. Yes" / "  2. No, and tell Claude…"。 */
const OPTION_ROW = /^\s*(?:[❯>]\s*)?(\d+)\.\s+(\S.*?)\s*$/u;

/** 权限确认框的标题形状。plan review("Would you like to proceed?")也在此列 —— 但它
 *  的选项文案不是裸 "Yes", pickModalAnswer 会自然放弃, 不需要在标题上再排除。
 *  "Are you sure …" 是 CodeBuddy 权限确认框的问句。 */
const PERMISSION_TITLE = /^(?:(?:Do|Would|Should) you|Are you sure) /iu;

export interface ModalOption {
  index: number;
  label: string;
  /** 当前高亮项(`❯` 打头) —— 仅供日志/展示, 代按不依赖它。 */
  selected: boolean;
}

/**
 * 抽出**最后一组**连续编号选项(从 1 开始)。
 * 为什么取最后一组: 当前屏上可能同时留着一个已答完的旧确认(它的选项行还在),
 * 取全部会把两个框的选项混成一锅 —— 按错框就是替用户批准了别的东西。
 */
export const parseModalOptions = (pane: string): ModalOption[] => {
  const groups: ModalOption[][] = [];
  let cur: ModalOption[] = [];
  for (const line of stripBoxBorders(pane ?? "").split("\n")) {
    const m = OPTION_ROW.exec(line);
    if (!m) {
      // 选项行之间允许空行(部分布局会插一行), 非空的非选项行才断组。
      if (line.trim() === "") continue;
      if (cur.length > 0) { groups.push(cur); cur = []; }
      continue;
    }
    const index = Number(m[1]);
    const opt: ModalOption = { index, label: m[2]!, selected: /^\s*[❯>]/u.test(line) };
    // 编号回到 1 = 新的一组开始。
    if (index === 1 && cur.length > 0) { groups.push(cur); cur = []; }
    cur.push(opt);
  }
  if (cur.length > 0) groups.push(cur);
  const last = groups.filter((g) => g[0]?.index === 1).pop();
  return last ?? [];
};

export interface ModalAnswer {
  index: number;
  label: string;
}

// AskUserQuestion 提交页的判据: 选项组里出现 "Submit answers" 行。到了这一页,
// 一个 Enter 就能收工。用最后一组编号选项 (parseModalOptions) 找它, 天然排除
// 屏上残留的旧确认框。纯函数, 供 mirror 侧「聊聊这个」收尾读屏确认复用。
const SUBMIT_LABEL = /submit\s+answer/iu;
export const isAskqSubmitPage = (pane: string): boolean =>
  parseModalOptions(pane).some((o) => SUBMIT_LABEL.test(o.label));

/**
 * 从选项里挑出"一次性同意"。挑不出返回 undefined(宁可不按)。
 * `title` 缺失或不像权限确认 → 直接放弃, 避免按到 /model 之类的选择器上。
 */
export const pickModalAnswer = (options: ModalOption[], title?: string): ModalAnswer | undefined => {
  if (!title || !PERMISSION_TITLE.test(title)) return undefined;
  const plainYes = options.find((o) => /^yes\s*$/iu.test(o.label));
  if (!plainYes) return undefined;
  return { index: plainYes.index, label: plainYes.label };
};

/** 权限确认框的三件套形状: 裸 "Yes" + "Yes, and/allow…" 放宽变体 + "No" 打头的
 *  拒绝项齐全。AskUserQuestion 的是非题只有 Yes/No 两项、plan review 没有裸
 *  "Yes" —— 都天然不命中。既是哨兵选材的判据, 也是无 footer 布局 (CodeBuddy)
 *  下 isModalPane 的 modal 证据。 */
const hasPermissionShape = (options: ModalOption[]): boolean =>
  options.some((o) => /^yes\s*$/iu.test(o.label))
  && options.some((o) => /^yes,\s/iu.test(o.label))
  && options.some((o) => /^no\b/iu.test(o.label));

/**
 * skipAll 哨兵版选材 (mirror 主动读屏, 无任何审批上下文): 按**选项形状**
 * (hasPermissionShape) 认权限确认框, 不看标题 —— CodeBuddy 的 MCP 权限 picker
 * 标题只有一个 "Confirm", PERMISSION_TITLE 认不出。
 * 仍只挑一次性裸 "Yes": 放宽静态权限的变体永不自动选中。挑不出返回 undefined。
 */
export const pickAutoAllowAnswer = (options: ModalOption[]): ModalAnswer | undefined => {
  if (!hasPermissionShape(options)) return undefined;
  const plainYes = options.find((o) => /^yes\s*$/iu.test(o.label));
  if (!plainYes) return undefined;
  return { index: plainYes.index, label: plainYes.label };
};

// ── 权限确认框上下文提取 (审批卡渲染用) ────────────────────────────────
// CodeBuddy 子代理的 confirm 完全不过 hook, 卡片能拿到的唯一事实就是屏上这只框。
// DeferExecuteTool 布局在正文里带 `toolName: "…"` 与 `params: {…}`, 直接下钻成
// 真实工具; 其它布局退回正文首行。解析失败也要给出可渲染的兜底 —— 卡片信息糙一点
// 仍胜过确认框在远端隐形。纯函数。
export interface ConfirmContext {
  toolName: string;
  toolInput: unknown;
  /** "Confirm · @tag" 头里的子代理名, 有则供卡片标注来源。 */
  agent?: string;
}

const CONFIRM_HEADER = /^\s*Confirm\b(?:\s*[·:]\s*(@?\S+))?/u;
// 框顶线 / 分隔线: 只由框线字符与空白组成的行。空行也命中 (正文为空时继续上溯)。
const BOX_RULE = /^[\s─━╭╮╰╯┌┐└┘├┤┬┴═║╔╗╚╝]*$/u;
const CONFIRM_QUESTION = /^\s*(?:(?:Do|Would|Should) you|Are you sure)\b.*\?\s*$/iu;

export const parseConfirmContext = (pane: string): ConfirmContext => {
  const lines = stripBoxBorders(pane ?? "").split("\n");
  // 正文的下界 = 最后一组选项的 "1." 行; 上界 = Confirm 头 / 框线(正文已开始时)。
  let firstOpt = lines.length;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/^\s*(?:[❯>]\s*)?1\.\s+\S/u.test(lines[i]!)) { firstOpt = i; break; }
  }
  let agent: string | undefined;
  const body: string[] = [];
  // 正文收完后 (bodyDone) 继续上溯只为找 Confirm 头 —— 正文与头之间隔着空行,
  // 一碰空行就停会把 `@子代理名` 丢掉; 碰到头以外的实际内容才真正停。
  let bodyDone = false;
  for (let i = firstOpt - 1; i >= 0; i--) {
    const line = lines[i]!;
    const h = CONFIRM_HEADER.exec(line);
    if (h) { agent = h[1] || undefined; break; }
    if (BOX_RULE.test(line)) { bodyDone = body.length > 0; continue; }
    if (CONFIRM_QUESTION.test(line) || OPTION_ROW.test(line)) continue;
    if (bodyDone) break;
    body.unshift(line.trim());
  }
  const text = body.join("\n");
  const inner = /(?:^|[^\w])toolName:\s*"([^"]+)"/u.exec(text)?.[1];
  const params = /params:\s*(\{[\s\S]*)$/u.exec(text)?.[1]?.trim();
  let input: unknown;
  // params 可能被 pane 宽度截断 → JSON.parse 失败时保留原文, 卡上仍可读。
  if (params !== undefined) {
    try { input = JSON.parse(params); } catch { input = { params }; }
  }
  const first = body.find((l) => l.length > 0);
  const toolName = inner ?? (first && first.length <= 60 ? first : undefined) ?? "权限确认";
  if (input === undefined) {
    const rest = body.filter((l) => l && l !== toolName).join("\n").trim();
    input = rest ? { 参数: rest } : {};
  }
  return { toolName, toolInput: input, agent };
};
