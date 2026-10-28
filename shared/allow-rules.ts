// Claude-Code-style allow rules for the approval flow (`approval.allowRules`).
//
// 语法对齐 Claude Code 官方 permission 规则的常用子集, 让用户在两边维护同一套
// 心智模型:
//   "Read"                      → 放行整个工具
//   "mcp__server"               → 放行该 MCP server 的全部工具
//   "mcp__server__tool"         → 放行单个 MCP 工具
//   "Bash(git status)"          → Bash 精确命令 (空白归一后全等)
//   "Bash(git log *)"           → Bash 前缀匹配 (空格-星, Claude 现行写法)
//   "Bash(npm run test:*)"      → Bash 前缀匹配 (冒号-星, Claude 早期写法)
//   "Bash(python3 .claude/skills/*)" → 星号紧跟路径亦可 (前缀=去掉末尾 *)
//
// 与 Claude 一致的安全语义:
//   • 复合命令 (&&, ||, ;, |, 换行) 逐段拆开, 每一段都必须命中某条 Bash 规则 —
//     `python3 x.py *` 匹配不了 `python3 x.py && rm -rf`;
//   • 段首的 VAR=value 环境变量前缀在匹配前剥掉 (`timeout=60 python3 …`);
//   • 含命令替换 ($(…) / 反引号) 的命令一律不命中 (fail-safe 交回发卡);
//   • 星号只支持结尾位置 (Claude 同款), 中间通配不支持;
//   • 仅 Bash 支持括号 specifier; 其他工具带 specifier 的规则视为无效 (不放行),
//     避免 "Read(/etc/*)" 被误实现成放行全部 Read。
//
// 交互卡依赖拦截的工具永不可被规则放行 (放行会让企微远端失去问答/计划审批能力)。
export const NEVER_RULE_ALLOW = new Set(["AskUserQuestion", "ExitPlanMode", "EnterPlanMode"]);

// CodeBuddy REPL (PTC): 工具调用包在 code 脚本里, hook 只看得见 REPL 这一层。
// 白名单对 REPL 下钻到内层调用 —— 与 danger.ts 的内层命令判定同一原则:
// REPL 只是传输层, 档位跟着内层操作走。下钻只认 toolName === "REPL" + code 字符串:
// 放行方向的过宽匹配是不安全的 (别的工具恰好有 code 入参会被误放行), 不像
// danger 侧的宽匹配 (多一张卡) 是安全方向。
import { replBashCallCount, replBashCommands, replToolNames } from "./repl-script.js";

const replCodeOf = (toolInput: unknown): unknown =>
  toolInput && typeof toolInput === "object"
    ? (toolInput as Record<string, unknown>).code
    : undefined;

/** 内层工具名的规则侧候选: REPL 里 MCP 工具写作 mcp_<server>.<tool>
 *  (mcp_lisct.add_elements), 规则侧是 Claude 式 mcp__<server>__<tool> —— 两种形态都认。 */
const replRuleNames = (name: string): string[] =>
  /^mcp_[A-Za-z0-9_]+\./.test(name)
    ? [name, name.replace(/^mcp_([A-Za-z0-9_]+)\./, "mcp__$1__")]
    : [name];

/** 一个内层工具名是否被裸名规则覆盖 (Bash 除外 —— 它由命令字面量逐段判)。 */
const replNameHit = (parsed: ParsedRule[], name: string): string | undefined => {
  for (const r of parsed) {
    if (r.spec !== undefined) continue;
    for (const cand of replRuleNames(name)) {
      if (r.tool === cand) return r.tool;
      if (r.tool.startsWith("mcp__") && cand.startsWith(`${r.tool}__`)) return r.tool;
    }
  }
  return undefined;
};

/** REPL 整条调用的放行判定: 每个内层调用都必须被规则覆盖, 一条不在线上就不放行。 */
const replVerdict = (parsed: ParsedRule[], bashSpecs: Array<string | undefined>, code: string): AllowVerdict => {
  const names = replToolNames(code);
  const commands = replBashCommands(code);
  // Bash 调用形状多于认出的命令字面量 = 有变量拼的命令 → 整条不可证明安全
  if (replBashCallCount(code) > commands.length) return { allowed: false, reason: { kind: "repl_opaque" } };
  // 一个调用都认不出 (纯计算) → 无凭据放行
  if (names.length === 0 && commands.length === 0) return { allowed: false, reason: { kind: "repl_opaque" } };
  const hits: string[] = [];
  for (const cmd of commands) {
    const v = bashCommandAllowed(bashSpecs, cmd);
    if (!v.allowed) return v;
    hits.push(...v.hits);
  }
  for (const name of names) {
    if (name === "Bash") continue; // 由命令字面量逐段判
    if (NEVER_RULE_ALLOW.has(name)) return { allowed: false, reason: { kind: "never_allow", tool: name } };
    const hit = replNameHit(parsed, name);
    if (!hit) return { allowed: false, reason: { kind: "tool_not_listed", tool: name } };
    hits.push(hit);
  }
  return { allowed: true, hits };
};

interface ParsedRule {
  tool: string;
  spec?: string;
}

const RULE_RE = /^([A-Za-z][A-Za-z0-9_-]*)(?:\((.*)\))?$/s;

export const parseRule = (raw: string): ParsedRule | undefined => {
  const m = RULE_RE.exec(raw.trim());
  if (!m || !m[1]) return undefined;
  return { tool: m[1], spec: m[2] };
};

const norm = (s: string): string => s.trim().replace(/\s+/g, " ");

// 段首环境变量赋值前缀: `timeout=60 FOO=bar python3 …` → `python3 …`
const ENV_ASSIGN_RE = /^[A-Za-z_][A-Za-z0-9_]*=\S*$/;
const stripEnvPrefix = (segment: string): string => {
  const toks = segment.split(" ");
  let i = 0;
  while (i < toks.length && ENV_ASSIGN_RE.test(toks[i]!)) i++;
  return toks.slice(i).join(" ");
};

// 纯变量赋值段 (`f=a.jsonl`, `A=1 B=2`): 赋值后没有跟命令, 这一段不执行任何东西 →
// 无害, 逐段校验与规则生成都应当**跳过**它, 不能当成"未覆盖段"发卡 (实战回归:
// `f=a.jsonl; cat $f` 明明有 Bash(cat *) 也要发卡, 且点「总是」一条规则都存不下)。
// 与"真正的空段"(`a && && b` 切出来的段) 严格区分: 后者剥离前就是空的, 属异常输入,
// 继续走保守路径。`f=$(cmd)` / 反引号形式在更早处已被 HAS_SUBSTITUTION 整体挡下。
const isPureAssignment = (segment: string): boolean => {
  const s = norm(segment);
  return s !== "" && stripEnvPrefix(s) === "";
};

const bashSpecMatches = (spec: string, segment: string): boolean => {
  const seg = stripEnvPrefix(norm(segment));
  if (!seg) return false;
  const s = norm(spec);
  if (s === "") return false;
  if (s.endsWith(":*")) {
    return seg.startsWith(s.slice(0, -2));
  }
  if (s.endsWith("*")) {
    // "git log *" → 前缀 "git log " (含空格); "…/skills/*" → 前缀 "…/skills/"。
    // 同时接受去掉尾随空格后的全等: "git log *" 匹配裸 "git log"。
    const prefix = s.slice(0, -1);
    return seg.startsWith(prefix) || seg === prefix.trimEnd();
  }
  return seg === s;
};

// 含命令替换的整条命令直接不命中 — 规则匹配的是字面前缀, 而 $(…)/反引号的实际
// 行为取决于运行时展开, 字面匹配给不出可信判断。
const HAS_SUBSTITUTION = /[`]|\$\(/;

// 带引号的 heredoc (<<'EOF') 正文是喂给 stdin 的纯数据 (shell 不做任何展开),
// 不是要执行的命令 — 剥掉正文只留命令行参与分段/匹配, 否则 `cat > x <<'EOF'`
// 这类高频写文件命令永远匹配不上规则。未加引号的 heredoc (<<EOF) 正文会被
// shell 展开 ($() 会执行!), 不可安全剥离 → 返回 undefined, 调用方走保守路径。
const stripQuotedHeredocs = (cmd: string): string | undefined => {
  if (!cmd.includes("<<")) return cmd;
  const lines = cmd.split(/\r?\n/);
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const m = /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/.exec(line);
    out.push(line);
    i++;
    if (!m) continue;
    if (!m[1]) return undefined; // 未加引号的 heredoc: 正文会被展开, 不可剥离
    const marker = m[2]!;
    let closed = false;
    while (i < lines.length) {
      const bodyLine = lines[i]!;
      i++;
      if (bodyLine.trim() === marker) { closed = true; break; }
    }
    if (!closed) return undefined; // 未闭合, 解析不确定
  }
  return out.join("\n");
};
// 兜底用的纯文本切分 (deny/ask 扫描在引号感知失败时用它, fail-closed 多扫不漏扫)
const RAW_SPLIT = /\r?\n|&&|\|\||(?<!\\)[;|]/;

// 引号感知分段: 只有引号外的 \n ; | || && 才是段分隔符。
// rg 'a|b|c'、ontology ask "多行长文"、python3 -c "代码" 里的分隔符都是数据,
// 纯文本 split 会把它们切成碎段导致永远匹配不上规则 (实战最大误卡来源)。
// 语义: 单引号内无转义; 双引号内 \x 转义; 引号外 \x 转义 (覆盖 \| \; )。
// 未闭合引号 / 孤立 & (后台执行) → 返回 undefined, 调用方走保守路径。
// fd 重定向里的 & (`2>&1` `>&2` `&>file`) 不算孤立 &, 是普通字符。
// 导出给 claude-config-path.ts 复用: 那里也要"复合命令逐段判定", 分段语义必须
// 与规则匹配完全一致, 各写一份必然漂移。
export const splitSegments = (cmd: string): string[] | undefined => {
  const segs: string[] = [];
  let cur = "";
  let quote: '"' | "'" | undefined;
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i]!;
    if (quote === "'") {
      cur += ch;
      if (ch === "'") quote = undefined;
      continue;
    }
    if (quote === '"') {
      cur += ch;
      if (ch === "\\" && i + 1 < cmd.length) { cur += cmd[++i]; continue; }
      if (ch === '"') quote = undefined;
      continue;
    }
    if (ch === "\\" && i + 1 < cmd.length) { cur += ch + cmd[++i]; continue; }
    if (ch === "'" || ch === '"') { quote = ch; cur += ch; continue; }
    if (ch === "\n" || ch === ";") { segs.push(cur); cur = ""; continue; }
    if (ch === "|") {
      if (cmd[i + 1] === "|") i++;
      segs.push(cur); cur = ""; continue;
    }
    if (ch === "&") {
      if (cmd[i + 1] === "&") { i++; segs.push(cur); cur = ""; continue; }
      // fd 重定向的 & 是重定向语法的一部分, 不是后台执行符: `2>&1` `>&2` `2>&-`
      // (& 紧跟在 > 后) 与 `&>file` `&>>file` (& 紧接 >)。漏掉这一条会让每个
      // `cmd 2>&1 | head` 整体放弃分段 → 明明被规则覆盖也要发卡, 且「总是」存不下规则。
      if (cmd[i - 1] === ">" || cmd[i + 1] === ">") { cur += ch; continue; }
      return undefined; // 真正孤立的 & : 后台执行, 保守处理
    }
    if (ch === "\r") continue;
    cur += ch;
  }
  if (quote !== undefined) return undefined; // 引号未闭合
  segs.push(cur);
  return segs.map((s) => s.trim());
};

// 段首 token 必须长得像命令 (字母数字/路径字符); 括号引号等异形首 token 一律放弃。
const TOKEN_RE = /^[A-Za-z0-9_.~/+-]+$/;

/**
 * 单段 → 「✅总是」会为它生成的规则。undefined = 该段提炼不出可靠前缀
 * (异形段首、或解释器头部拿不到子命令 —— 后者生成出来等于任意代码执行全放行)。
 * alwaysAllowRulesFor 与 DenyReason 共用它, 避免两处前缀逻辑漂移。
 */
export const ruleForSegment = (rawSeg: string): string | undefined => {
  const seg = stripEnvPrefix(norm(rawSeg));
  if (!seg) return undefined;
  const toks = seg.split(" ");
  const head = toks[0]!;
  if (!TOKEN_RE.test(head)) return undefined;
  // 第二个 token 只有长得像子命令/路径时才纳入前缀 (flag、引号值等退化为单命令)。
  const second = toks[1];
  const useSecond = Boolean(second && !second.startsWith("-") && TOKEN_RE.test(second));
  if (!useSecond && INTERPRETER_HEADS.has(head.split("/").pop() ?? head)) return undefined;
  return `Bash(${useSecond ? `${head} ${second}` : head} *)`;
};

/** 未放行的具体原因 —— 卡片上「审核」那一行的数据源。 */
export type DenyReason =
  /** 复合命令里第 index/total 段没命中任何规则。rule = 「总是」会为它生成的
   *  规则 (拿不到可靠前缀时 undefined)。这是最常见、也最该告诉用户的一种。 */
  | { kind: "segment_unmatched"; index: number; total: number; segment: string; rule?: string }
  /** 含 $() / 反引号 —— 实际行为取决于运行时展开, 字面规则描述不了。 */
  | { kind: "substitution" }
  /** 引号未闭合 / 孤立 & / 不可剥离的 heredoc / 空段 —— 分不出段就不敢放行。 */
  | { kind: "unparsable" }
  /** 非 Bash 工具, 工具名不在白名单里 (REPL 下钻时 = 内层那个工具名)。 */
  | { kind: "tool_not_listed"; tool: string }
  /** 交互卡工具硬保护 (AskUserQuestion / ExitPlanMode / EnterPlanMode)。 */
  | { kind: "never_allow"; tool: string }
  /** REPL 内层认不出: 命令是变量拼的 / 纯计算无可识别调用 —— 无法证明可放行。 */
  | { kind: "repl_opaque" }
  /** 压根没配相关规则 —— 用户没在用白名单模式, 卡上不必提示。 */
  | { kind: "no_rules" };

export type AllowVerdict =
  | { allowed: true; hits: string[] }
  | { allowed: false; reason: DenyReason };

const bashCommandAllowed = (
  bashSpecs: Array<string | undefined>,
  command: string,
): AllowVerdict => {
  const stripped = stripQuotedHeredocs(command);
  if (stripped === undefined) return { allowed: false, reason: { kind: "unparsable" } };
  // 剥离后再查命令替换: 带引号 heredoc 正文里的 $() 是惰性数据, 不该连坐
  if (HAS_SUBSTITUTION.test(stripped)) return { allowed: false, reason: { kind: "substitution" } };
  const segments = splitSegments(stripped);
  if (segments === undefined || segments.length === 0) {
    return { allowed: false, reason: { kind: "unparsable" } };
  }
  const hits: string[] = [];
  for (const [i, seg] of segments.entries()) {
    if (isPureAssignment(seg)) continue; // 纯赋值段无执行能力, 不计入未命中
    // 空段 (如 "a && && b") 视为异常, 交回发卡
    if (!seg) return { allowed: false, reason: { kind: "unparsable" } };
    let matched: string | undefined;
    for (const spec of bashSpecs) {
      if (spec === undefined) {
        matched = "Bash"; // 裸 "Bash" 规则: 放行一切 (不建议配置, 但语义与 Claude 对齐)
        break;
      }
      if (bashSpecMatches(spec, seg)) {
        matched = `Bash(${spec})`;
        break;
      }
    }
    if (!matched) {
      return {
        allowed: false,
        reason: {
          kind: "segment_unmatched",
          index: i + 1,
          total: segments.length,
          segment: seg,
          rule: ruleForSegment(seg),
        },
      };
    }
    hits.push(matched);
  }
  // 全是赋值段 (`f=1; g=2`): 没有任何段被规则覆盖过, 不作放行凭据, 保守发卡。
  return hits.length > 0
    ? { allowed: true, hits }
    : { allowed: false, reason: { kind: "unparsable" } };
};

/**
 * 判定 (toolName, toolInput) 是否被 allowRules 放行。
 * 返回命中说明 (用于日志/审计 reason), 未命中返回 undefined。
 */
export const evaluateAllow = (
  rules: string[],
  toolName: string,
  toolInput: unknown,
): AllowVerdict => {
  if (NEVER_RULE_ALLOW.has(toolName)) {
    return { allowed: false, reason: { kind: "never_allow", tool: toolName } };
  }
  if (rules.length === 0) return { allowed: false, reason: { kind: "no_rules" } };

  const parsed = rules.map(parseRule).filter((r): r is ParsedRule => r !== undefined);
  const bashSpecs = parsed.filter((r) => r.tool === "Bash").map((r) => r.spec);

  if (toolName === "Bash") {
    const cmd = toolInput && typeof toolInput === "object"
      ? (toolInput as Record<string, unknown>).command
      : undefined;
    if (typeof cmd !== "string" || !cmd.trim()) {
      return { allowed: false, reason: { kind: "unparsable" } };
    }
    if (bashSpecs.length === 0) return { allowed: false, reason: { kind: "no_rules" } };
    return bashCommandAllowed(bashSpecs, cmd);
  }

  // REPL (CodeBuddy PTC): 按内层调用判。裸 "REPL" 规则 = 显式整工具放行
  // (旧「总是」按钮生成的就是这条), 内层不再逐条判; 其余情况每条内层调用
  // 都要过规则 —— 读类内层 (在白名单) 不再整条发卡, 写类内层照样问。
  if (toolName === "REPL") {
    const code = replCodeOf(toolInput);
    if (typeof code === "string") {
      if (parsed.some((r) => r.spec === undefined && r.tool === "REPL")) {
        return { allowed: true, hits: ["REPL"] };
      }
      return replVerdict(parsed, bashSpecs, code);
    }
    // code 解不出 → 落到下面的名字判定 (REPL 未列 → tool_not_listed, 同现状)
  }

  for (const r of parsed) {
    if (r.spec !== undefined) continue; // 非 Bash 工具不支持 specifier
    if (r.tool === toolName) return { allowed: true, hits: [r.tool] };
    // MCP server 级规则: "mcp__server" 覆盖 "mcp__server__*"
    if (r.tool.startsWith("mcp__") && toolName.startsWith(`${r.tool}__`)) {
      return { allowed: true, hits: [r.tool] };
    }
  }
  return { allowed: false, reason: { kind: "tool_not_listed", tool: toolName } };
};

/** 旧签名薄包装: 命中返回规则说明串, 未命中 undefined。调用方只关心"放不放行"
 *  时用它; 要向用户解释"为什么不放行"时用 evaluateAllow。 */
export const ruleAllows = (
  rules: string[],
  toolName: string,
  toolInput: unknown,
): string | undefined => {
  const v = evaluateAllow(rules, toolName, toolInput);
  return v.allowed ? [...new Set(v.hits)].join(" + ") : undefined;
};

/**
 * deny / ask 规则的匹配判定 — 与 allow 的量词相反:
 * Bash 复合命令**任一段**命中即命中 (拒绝/追问要抓到藏在复合命令里的危险段,
 * 而放行必须确保没有夹带)。含 $()/反引号不豁免匹配 (字面段仍参与判定)。
 * 不做 NEVER_RULE_ALLOW 保护 — deny/ask 都是收紧方向, fail-closed 无害。
 * 返回命中的规则原文, 未命中返回 undefined。
 */
export const ruleMatchesAny = (
  rules: string[],
  toolName: string,
  toolInput: unknown,
): string | undefined => {
  if (rules.length === 0) return undefined;
  const parsed = rules.map(parseRule).filter((r): r is ParsedRule => r !== undefined);

  if (toolName === "Bash") {
    const cmd = toolInput && typeof toolInput === "object"
      ? (toolInput as Record<string, unknown>).command
      : undefined;
    if (typeof cmd !== "string" || !cmd.trim()) return undefined;
    const bashRules = parsed.filter((r) => r.tool === "Bash");
    // deny/ask 方向: heredoc 剥不掉按原文、引号感知失败退回纯文本切 (fail-closed)
    const base = stripQuotedHeredocs(cmd) ?? cmd;
    const segments = (splitSegments(base) ?? base.split(RAW_SPLIT)).map((s) => s.trim()).filter(Boolean);
    for (const seg of segments) {
      for (const r of bashRules) {
        if (r.spec === undefined) return "Bash";
        if (bashSpecMatches(r.spec, seg)) return `Bash(${r.spec})`;
      }
    }
    return undefined;
  }

  // REPL 下钻 (与 evaluateAllow 同口径): 内层任一调用命中即命中 —— 拒绝/追问要
  // 抓到藏在 REPL 里的那条命令。认不出的内层 (变量拼的) 匹配不上 → undefined,
  // 但白名单侧同样拒 (repl_opaque), 净效果仍是发卡, fail-closed。
  if (toolName === "REPL") {
    const code = replCodeOf(toolInput);
    if (typeof code === "string") {
      if (parsed.some((r) => r.spec === undefined && r.tool === "REPL")) return "REPL";
      const bashRules = parsed.filter((r) => r.tool === "Bash");
      for (const cmd of replBashCommands(code)) {
        const base = stripQuotedHeredocs(cmd) ?? cmd;
        const segments = (splitSegments(base) ?? base.split(RAW_SPLIT)).map((s) => s.trim()).filter(Boolean);
        for (const seg of segments) {
          for (const r of bashRules) {
            if (r.spec === undefined) return "Bash";
            if (bashSpecMatches(r.spec, seg)) return `Bash(${r.spec})`;
          }
        }
      }
      for (const name of replToolNames(code)) {
        if (name === "Bash") continue; // 已由命令字面量逐段判
        const hit = replNameHit(parsed, name);
        if (hit) return hit;
      }
      return undefined;
    }
  }

  for (const r of parsed) {
    if (r.spec !== undefined) continue;
    if (r.tool === toolName) return r.tool;
    if (r.tool.startsWith("mcp__") && toolName.startsWith(`${r.tool}__`)) return r.tool;
  }
  return undefined;
};

// 解释器/shell 头部: 单命令级前缀规则 (如 `Bash(python3 *)`) 等于放行任意代码
// 执行, 永不自动生成 — 必须带上子命令/脚本路径 (如 `Bash(python3 /path/x.py *)`)。
const INTERPRETER_HEADS = new Set([
  "python", "python2", "python3", "node", "deno", "bun", "ruby", "perl", "php",
  "bash", "sh", "zsh", "fish", "eval", "exec", "xargs", "awk",
  "npx", "bunx", "uvx", "uv", "tsx",
]);

/** 「总是」为一条 Bash 命令逐段生成前缀规则; undefined = 这条命令生成不出
 *  可靠规则 (异形/动态构造), 调用方整体放弃。Bash 与 REPL 内层共用, 别各写一版。 */
const alwaysBashRules = (
  cmd: string,
  existingBashSpecs: Array<string | undefined>,
): string[] | undefined => {
  const stripped = stripQuotedHeredocs(cmd);
  if (stripped === undefined) return undefined; // 不可剥离的 heredoc, 放弃
  if (HAS_SUBSTITUTION.test(stripped)) return undefined;
  const segments = splitSegments(stripped);
  if (segments === undefined) return undefined; // 引号未闭合/孤立 &, 不生成
  const rules: string[] = [];
  for (const rawSeg of segments) {
    if (isPureAssignment(rawSeg)) continue; // 纯赋值段不执行命令, 无需为它生成规则
    const seg = stripEnvPrefix(norm(rawSeg));
    if (!seg) return undefined; // 空段异常, 整体放弃生成
    // 已被现有规则覆盖的段不再生成 (避免 `Bash(cd service *)` 这类冗余堆积)
    if (existingBashSpecs.some((s) => s === undefined || bashSpecMatches(s, seg))) continue;
    const rule = ruleForSegment(seg);
    if (!rule) return undefined; // 异形段首 / 解释器无子命令 —— 整体放弃生成
    rules.push(rule);
  }
  return rules;
};

/**
 * 「✅ 总是」按钮的规则生成: 由本次调用推导要写入 allowRules 的规则。
 * - 非 Bash: 裸工具名 (mcp 工具即完整 mcp__server__tool);
 * - Bash: 逐段取「命令 + 第二个 token」做前缀规则 `Bash(a b *)`;
 *   第二个 token 是 flag (-开头) 或不存在时退化为单 token `Bash(a *)`;
 *   已被 existingRules 覆盖的段跳过 (不生成冗余规则);
 *   解释器头部不允许退化为单命令规则 (防生成 `Bash(python3 *)` 级别的全放行);
 *   含 $()/反引号、不可剥离的 heredoc → 返回 [] (调用方保持一次性放行)。
 * - 交互卡工具永不生成规则。
 * - REPL: 按内层调用生成 (内层 Bash 逐段 + 内层工具名), 不生成整工具放行的
 *   "REPL" —— 那会连内层没见过的调用也一并放行。
 */
export const alwaysAllowRulesFor = (
  toolName: string,
  toolInput: unknown,
  existingRules: string[] = [],
): string[] => {
  if (NEVER_RULE_ALLOW.has(toolName)) return [];

  // REPL: 按内层调用生成 —— 每条内层 Bash 命令一段规则 + 每个内层工具名一条,
  // 不再生成整工具放行的 "REPL" (那会连内层没见过的调用也一并放行)。认不出
  // 内层 (变量拼的 / 无调用) 生成不出能证明覆盖的规则, 保持一次性放行。
  if (toolName === "REPL") {
    const code = replCodeOf(toolInput);
    if (typeof code !== "string" || !code.trim()) return [toolName];
    const names = replToolNames(code);
    const commands = replBashCommands(code);
    if (replBashCallCount(code) > commands.length) return [];
    if (names.length === 0 && commands.length === 0) return [];
    const existingParsed = existingRules
      .map(parseRule)
      .filter((r): r is ParsedRule => r !== undefined);
    const existingBashSpecs = existingParsed.filter((r) => r.tool === "Bash").map((r) => r.spec);
    const rules: string[] = [];
    for (const cmd of commands) {
      const per = alwaysBashRules(cmd, existingBashSpecs);
      if (per === undefined) return [];
      rules.push(...per);
    }
    for (const name of names) {
      if (name === "Bash" || NEVER_RULE_ALLOW.has(name)) continue;
      // 规则侧形态: MCP 内层写作 server.tool, 生成 Claude 式 mcp__server__tool
      const cands = replRuleNames(name);
      const canonical = cands[cands.length - 1] ?? name;
      if (existingParsed.some((r) => r.spec === undefined
        && (r.tool === canonical || (r.tool.startsWith("mcp__") && canonical.startsWith(`${r.tool}__`)))
      )) continue;
      rules.push(canonical);
    }
    return [...new Set(rules)];
  }

  if (toolName !== "Bash") return [toolName];

  const raw = toolInput && typeof toolInput === "object"
    ? (toolInput as Record<string, unknown>).command
    : undefined;
  if (typeof raw !== "string" || !raw.trim()) return [];
  const existingBashSpecs = existingRules
    .map(parseRule)
    .filter((r): r is ParsedRule => r !== undefined && r.tool === "Bash")
    .map((r) => r.spec);
  const rules = alwaysBashRules(raw, existingBashSpecs);
  return rules === undefined ? [] : [...new Set(rules)];
};
