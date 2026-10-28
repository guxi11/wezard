// 危险操作名单。命中者 **必须逐次单独审批**:
//   · 不吃 auto-window (approval.windowMinutes 的「N 分钟全过」)
//   · 不吃 session cache (同参数重复调用也要再点一次)
//   · 不参与批量合流 (永远独占一张卡, 不会被 ×N 聚合掉)
//   · 卡上没有「全过」按钮, 只有 ✅ / ❌
//   · fallbackOnError=allow 时降级为 ask (超时/断线不静默放行危险操作)
// 纯函数, 只做匹配; 所有副作用留在 approval.ts。
import type { Config } from "../shared/config.js";
import { COMMAND_KEYS, replBashCommands, replFallbackCommands } from "../shared/repl-script.js";
import { splitSegments } from "../shared/allow-rules.js";

export interface DangerHit {
  /** 人类可读的规则名, 直接渲染到卡片上 — 用户要知道「哪一条」判定它危险。 */
  rule: string;
}

type Rule = readonly [label: string, re: RegExp];

// 「命令词位置」前缀: 行首 / 换行 / `;` `&&` `||` `(` 之后 / 引号紧邻处 /
// 包装器命令之后 / `do` `then` `else` 之后 / `--` 参数分隔符之后。
//
// 为什么需要它: 名单是对**整条命令文本**做 test 的, 光靠 `\b` 界定的词只要在
// 任何位置出现就算命中 —— 而 `-` `/` 都是非单词字符, 于是分支名、文件名、参数值
// 里带上这些词就会让所有沾边的命令被判危险。真实案例: 分支
// `feature/graceful-shutdown` 让 `git checkout` / `git push` /
// `npm run test -- graceful-shutdown.spec.ts` 全部命中「关机/重启」必发单卡,
// 流程被审批卡堵死; 同族的 `\brm\b` 还会把 `docker run --rm` 判成删除文件。
//
// 包装器 (提权/计时/限流/改环境, 自己不干事只把后面的命令包一层跑) 是开放集合,
// 初版只列了 sudo·nohup·exec·xargs·env·time, 于是 `command rm` / `timeout 5 rm` /
// `nice rm` / `env FOO=1 rm` / `watch reboot` 全部漏报 —— 这里尽量收全, 并允许
// 包装器与命令之间隔一串参数 token。token 只认 `-` 开头的选项 / 纯数字时长 /
// `K=V` 赋值: 普通单词会打断链条, `timeout 5 rg -n sudo` 里的检索词钓不出命中。
const WRAPPERS = String.raw`sudo|doas|nohup|exec|xargs|env|time|command|builtin|timeout|nice|ionice|stdbuf|setsid|watch|caffeinate|do|then|else`;
const WRAP_ARG = String.raw`(?:-[^\s;|&]*|\d+(?:\.\d+)?[smhd]?|\w+=[^\s;|&]*)\s+`;
const CMD_HEAD = String.raw`(?:^|[\n;&|(]\s*|["'\`]\s*|\b(?:${WRAPPERS})\s+(?:${WRAP_ARG})*|--\s+)`;

// 「远程执行」上下文: 命令把动作送到别的机器/容器里跑时, 位置约束失效 ——
// `ssh host rm -rf /`、`kubectl exec pod -- halt` 里危险词前面是主机名或 `--`。
// 因为前置了 ssh / exec 才触发, 不会误伤本机的普通命令, 所以这里保持宽匹配。
const REMOTE_CTX = String.raw`\b(?:ssh|(?:kubectl|docker)\s+exec)\b[\s\S]*\b`;

/**
 * 给「词本身太常见、只有出现在命令位置才危险」的规则配一对正则: 本机版带
 * 命令词位置约束, 远程版在 ssh/exec 上下文里放宽。
 *
 * 只用于纯单词触发的规则 —— `kubectl delete`、`dd if=` 这类自带结构约束的
 * 不需要, 它们的第二个 token 已经把误伤面挡住了。
 */
const cmdWord = (label: string, words: string, flags = ""): Rule[] => [
  // `\\?`: `\rm` 这种反斜杠转义 (绕开 alias 的惯用写法) 仍处于命令词位置。
  [label, new RegExp(`${CMD_HEAD}\\\\?(?:${words})\\b`, flags)],
  [`远程${label}`, new RegExp(`${REMOTE_CTX}(?:${words})\\b`, flags)],
];

// git 匿名整树 pathspec 的判定: "." ".." ":/" "*" (可带引号), 前后须有词界。
// 只挂在 checkout -- / restore 分支后面, 不约束 reset --hard / clean 两个整树分支。
const GIT_WILDTREE = String.raw`(?=[^;&|\n]*[\s"'](?:\.\.?|:/|\*)(?=$|[\s"';&|]))`;

// ── rm 临时区豁免 (2026-10-28 人的口径) ────────────────────────────────
// 「rm 一次性目录里的东西」不判危险: 那里的文件本就是用后即焚的。只豁免 rm 的
// **所有**目标都落在临时区的调用 —— 混合目标 (临时区 + 工作区/家目录) 不豁免;
// 解析不出 (相对路径 / 变量 / 裸通配 / .. 逃逸 / 引号未闭合) 一律 fail-closed
// 不豁免。判据是路径解析, 不是子串: /tmp-foo、~/develop/tmpdata 不是 /tmp 下面。
// 临时区清单 (复核口径):
//   /tmp、/private/tmp (macOS 同一目录) —— 共享区, 只豁免「严格在下面」的目标,
//     删区根本身清掉的是全机所有用户的临时文件, 仍危险;
//   $TMPDIR / ${TMPDIR} 字面前缀, 及其展开形态 /var/folders/<a>/<b>/T (含
//     /private 前缀) —— 每用户一份, 根本身也豁免;
//   不进清单: /var/tmp (跨重启保留, 不是一次性), ~/.cache (可再生成但不是
//     scratch 契约), /dev/shm (Linux 全机共享, 影响面超出本人)。

/** 引号感知 token 化 (剥包裹引号, 引号内不分词)。undefined = 引号未闭合。 */
const tokenize = (s: string): string[] | undefined => {
  const toks: string[] = [];
  let cur = "";
  let quote: '"' | "'" | undefined;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (quote === "'") { cur += ch; if (ch === "'") quote = undefined; continue; }
    if (quote === '"') { cur += ch; if (ch === "\\") { cur += s[++i] ?? ""; continue; } if (ch === '"') quote = undefined; continue; }
    if (ch === "\\") { cur += ch + (s[++i] ?? ""); continue; }
    if (ch === "'" || ch === '"') { quote = ch; continue; }
    if (/\s/.test(ch)) { if (cur) { toks.push(cur); cur = ""; } continue; }
    cur += ch;
  }
  if (quote !== undefined) return undefined;
  if (cur) toks.push(cur);
  return toks;
};

/** 词法归一: 合并 //、消解 . / ..、去尾斜杠。跨出根的 .. 按停在根处理。 */
const normPath = (p: string): string => {
  const out: string[] = [];
  for (const part of p.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") { out.pop(); continue; }
    out.push(part);
  }
  return out.length ? "/" + out.join("/") : "/";
};

const TMPDIR_LIT = /^\$\{TMPDIR\}(?=\/|$)|^\$TMPDIR(?=\/|$)/;

/** rm 目标 token 的归类: temp = 临时区内; outside = 区外; unknown = 解析不出。 */
const classifyRmTarget = (tok: string): "temp" | "outside" | "unknown" => {
  const lit = TMPDIR_LIT.exec(tok);
  if (lit) {
    const rest = tok.slice(lit[0].length);
    return rest.includes("..") || rest.includes("$") ? "unknown" : "temp";
  }
  // 其余任何未展开的变量 (含 $TMPDIRfoo 这种撞名前缀的别的变量) 都解析不出
  if (tok.includes("$")) return "unknown";
  if (tok.startsWith("~")) return "outside";
  if (tok.startsWith("/")) {
    const p = normPath(tok);
    if (p === "/tmp" || p === "/private/tmp") return "outside"; // 共享区根本身
    if (p.startsWith("/tmp/") || p.startsWith("/private/tmp/")) return "temp";
    if (/^\/(private\/)?var\/folders\/[^/]+\/[^/]+\/T(\/|$)/.test(p)) return "temp";
    return "outside";
  }
  return "unknown"; // 相对路径 / 裸 glob / . / ..
};

/** 段内 rm 调用的目标是否全在临时区。none = 段里没有 rm; bad = 有但不可豁免。 */
const segmentRmStatus = (toks: string[]): "none" | "temp" | "bad" => {
  let status: "none" | "temp" | "bad" = "none";
  let i = 0;
  while (i < toks.length) {
    const t = toks[i]!;
    if (t !== "rm" && t !== "\\rm") { i++; continue; }
    let j = i + 1;
    let dashdash = false;
    let targets = 0;
    let allTemp = true;
    while (j < toks.length) {
      const a = toks[j]!;
      // 重定向之后不再是 rm 的目标 (rm -rf /tmp/x >/dev/null 2>&1 是最常见的形态)
      if (/^(?:\d*>&|>|>>|<|&>)/.test(a)) break;
      if (!dashdash) {
        if (a === "--") { dashdash = true; j++; continue; }
        if (a.startsWith("-")) { j++; continue; }
      }
      targets++;
      if (classifyRmTarget(a) !== "temp") allTemp = false;
      j++;
    }
    status = targets > 0 && allTemp ? (status === "bad" ? "bad" : "temp") : "bad";
    i = j;
  }
  return status;
};

/** 一条命令里所有 rm 的目标都落在临时区 → 豁免「删除文件 rm」。解析不出 → false。 */
const rmAllTemp = (cmd: string): boolean => {
  const segs = splitSegments(cmd);
  if (segs === undefined) return false;
  let anyTemp = false;
  for (const seg of segs) {
    const toks = tokenize(seg);
    if (toks === undefined) return false;
    const st = segmentRmStatus(toks);
    if (st === "bad") return false;
    if (st === "temp") anyTemp = true;
  }
  return anyTemp;
};

// ── 内置命令名单 (Bash / 任何带 command 的工具) ────────────────────────
const CMD_RULES: readonly Rule[] = [
  ...cmdWord("删除文件 rm", "rm"),
  // rmdir 2026-10-28 移出: 只能删空目录, 没有数据可丢 (mkdir 即恢复), 不够「不可逆」。
  ["批量删除 find -delete", /\bfind\b[\s\S]*(-delete|-exec\s+rm)\b/],
  // xargs 传参形态 (`xargs -I{} rm {}`) 里 rm 前面是 `}`, 命令词位置约束够不着,
  // 靠这条宽规则兜住 —— 有 xargs 前置, 同样不会误伤普通命令。
  ["管道删除 xargs rm", /\bxargs\b[\s\S]*\brm\b/],
  ...cmdWord("清空文件 truncate", "truncate"),
  ["裸设备写入 dd", /\bdd\s+(if|of)=/],
  ["格式化 mkfs", /\bmkfs\b|\bdiskutil\s+(erase|partition)/],
  ["重定向到设备", />\s*\/dev\/(?!null\b|stdout\b|stderr\b)/],
  ...cmdWord("提权 sudo", "sudo"),
  ["切换用户 su", /\bsu\s+-/],
  ["递归改权限", /\bch(mod|own)\b[\s\S]*(-R|\b777\b)/],
  ["强制杀进程", /\bkill\s+-9\b/],
  ...cmdWord("强制杀进程", "killall|pkill"),
  ...cmdWord("关机/重启", "shutdown|reboot|halt|poweroff"),
  ["服务停用", /\blaunchctl\s+(unload|bootout|remove)\b|\bsystemctl\s+(stop|disable|mask)\b/],
  ["git 强推", /\bgit\b[\s\S]*\bpush\b[\s\S]*(--force|-f\b)/],
  // git 丢弃改动 —— 只留「整树」形态: reset --hard / clean, 以及匿名整树 pathspec
  // ("." ".." ":/" "*", 可带引号) 的 checkout -- / restore。路径级 discard
  // (git restore <path> / git checkout -- <path>) 2026-10-28 起降为普通审批:
  // 它是共享工作树里最日常的「撤销自己刚改的那几个文件」, 每次红卡单审把流程
  // 堵死; 危害面限定在「所列路径的未提交改动」, 普通卡 (⏱窗口 / ✅总是 / 缓存)
  // 的摩擦刚好, 用户还能用 Bash(git restore *) 自己调档。整树形态一次抹掉全组
  // 人的 WIP, 维持必发单卡。裸 git checkout -- / git restore (无 pathspec) 是
  // no-op/报错 (实测 2.x), 不算整树; ":/<具体路径>" 按具名路径降档。token 的
  // 前后界 (空格/引号/段分隔) 防止 src/. / .hidden / file.txt 被误判成整树 ".";
  // 扫描窗口止于 ;&| 换行, 不跨进同一条复合命令里别的段。
  ["git 丢弃改动", new RegExp(
    String.raw`\bgit\s+(?:reset\s+--hard|clean\b|checkout\s+[^;&|\n]*?--${GIT_WILDTREE}|restore\b${GIT_WILDTREE})`,
  )],
  // git 删分支 2026-10-28 拆分: 本地 branch -D 移出 —— 提交仍在 reflog 里
  // (默认 90 天), git 里拿得回来; 远程 push --delete 保留 —— 动的是共享远端,
  // 别人的克隆不一定有副本, 拿不回来。
  ["git 删远程分支", /\bgit\s+push\b[\s\S]*--delete\b/],
  ["发布包", /\bnpm\s+(publish|unpublish)\b|\byarn\s+publish\b|\bpnpm\s+publish\b/],
  // 容器 2026-10-28 按「数据在哪」拆分: 容器/镜像/无 -v 的 compose down 是牲口
  // (compose up / 重新 pull 即恢复) → 移出; volume 和 prune 动的是数据卷 ——
  // 数据不在 git 也不在别处, 拿不回来 → 保留。附带补上 volume prune (整批卷,
  // 比 volume rm 更狠, 原名单漏了)。
  ["容器数据删除", /\bdocker\s+(volume\s+(rm|prune)|system\s+prune)\b|\bdocker\s+compose\s+down\s+[^\n;&|]*?(-v\b|--volumes\b)/],
  ["k8s 删除", /\bkubectl\s+delete\b/],
  ["基础设施销毁", /\bterraform\s+destroy\b/],
  ["云资源删除", /\baws\s+[\s\S]*\b(rm|rb|delete-|terminate-)|\bgcloud\s+[\s\S]*\bdelete\b/],
  ["GitHub 删除", /\bgh\s+(repo|release|secret|ssh-key)\s+delete\b/],
  ["数据库 DROP/TRUNCATE", /\b(drop|truncate)\s+(table|database|schema|index)\b/i],
  ["无条件 DELETE", /\bdelete\s+from\b(?![\s\S]*\bwhere\b)/i],
  // flushall/flushdb 是 redis-cli 的**子命令**, 永远不在 shell 命令词位置, 所以
  // 这里用 redis 上下文约束而不是 CMD_HEAD —— 同样挡住 `feat/flushdb-guard`
  // 这类分支名, 又不会漏掉 `redis-cli -h h flushall`。
  ["Redis 清库", /\bredis(-cli)?\b[\s\S]*\bflush(all|db)\b/i],
  ["下载即执行", /\b(curl|wget)\b[\s\S]*\|\s*(sudo\s+)?(ba)?sh\b/],
  ["fork 炸弹", /:\(\)\s*\{.*\|.*&.*\}/],
  // history -c 2026-10-28 移出: 丢的只是 shell 历史, 没有可恢复性问题的数据;
  // defaults delete 保留 —— 删的是 macOS 系统偏好 (plist), 不在 git 里, 删了拿不回。
  ["清系统偏好", /\bdefaults\s+delete\b/],
];

// ── 内置工具名名单 (MCP / 内置工具, 按名字判定) ────────────────────────
const TOOL_RULES: readonly Rule[] = [
  ["删除类工具", /(^|_|__|\b)(delete|remove|destroy|drop|purge|revoke|uninstall)/i],
];

// ── 内置敏感路径名单 (任何工具的任意字符串入参) ────────────────────────
const PATH_RULES: readonly Rule[] = [
  ["SSH 密钥", /(^|\/)\.ssh\/|id_(rsa|ed25519|ecdsa)\b|authorized_keys\b/],
  ["凭据文件", /(^|\/)\.(env|npmrc|netrc|aws|gnupg)\b|credentials\b|secrets?\.(json|ya?ml|env)\b/],
  ["系统目录", /^\/(etc|System|Library\/LaunchDaemons|usr\/bin|bin|sbin)\//],
  ["家目录根/根目录", /^\s*(~|\/|\$HOME)\/?\s*$/],
];

const compile = (sources: readonly string[]): Rule[] =>
  sources.flatMap((s) => {
    try {
      return [[`自定义:${s}`, new RegExp(s, "i")] as Rule];
    } catch {
      return []; // 坏正则不应该让整条审批链挂掉
    }
  });

const firstHit = (rules: readonly Rule[], text: string): DangerHit | undefined => {
  const hit = rules.find(([, re]) => re.test(text));
  return hit ? { rule: hit[0] } : undefined;
};

// 递归收集入参里的字符串叶子 (深度/数量有界 — 入参可能很大)。
const MAX_NODES = 200;
const strings = (v: unknown, depth = 0, acc: string[] = []): string[] => {
  if (acc.length >= MAX_NODES || depth > 4) return acc;
  if (typeof v === "string") { acc.push(v); return acc; }
  if (Array.isArray(v)) { v.forEach((x) => strings(x, depth + 1, acc)); return acc; }
  if (v && typeof v === "object") {
    Object.values(v as Record<string, unknown>).forEach((x) => strings(x, depth + 1, acc));
  }
  return acc;
};

// command 类入参: Bash.command, 以及任何叫 command/script/cmd 的字段 —— 值会被
// shell 执行, 做命令级判定 (键表与 REPL 兜底共用一份, 见 shared/repl-script.ts)。
// 其余顶层入参不扫命令: Edit/Write/Read 直连时本就不进命令判定。
// 脚本类入参: CodeBuddy REPL (PTC) 把每个工具调用包进 `code` 里 —— 命令在脚本内部,
// 顶层只有一段 JS。不下钻的话 `rm -rf` 藏在字符串里, 危险名单一条也命中不了。
const SCRIPT_KEYS = new Set(["code"]);
const commandsOf = (input: unknown): string[] => {
  if (!input || typeof input !== "object") return [];
  return Object.entries(input as Record<string, unknown>).flatMap(([k, v]): string[] => {
    if (typeof v !== "string") return [];
    if (COMMAND_KEYS.has(k)) return [v];
    if (!SCRIPT_KEYS.has(k)) return [];
    // 内层 Bash 命令字面量 + 兜底字面量 (命令键的值 / 裸赋值 / 陌生键的值 ——
    // 数据键的值不是命令, 见 replFallbackCommands)。旧的「整段脚本兜底」会把
    // Edit 的内容、Read 的路径当 shell 文本误判, 2026-10-28 按键语义拆掉;
    // 变量拼的 'rm -rf x' (裸赋值) 仍被兜底抓住, 宁可多一张卡。
    return [...replBashCommands(v), ...replFallbackCommands(v)];
  });
};

// 路径类入参: 只看看起来像路径的字符串, 避免拿正文去撞路径规则。
const pathish = (s: string): boolean => s.length < 512 && /^[~$/.]|\//.test(s);

/**
 * danger 模式下这次调用是否可以免卡直接放行。
 * 名单关掉时不生效 (退回全量审批) —— 「模式=danger + 名单=off」不该等于全放行。
 */
export const dangerModeSkips = (cfg: Config, hit: DangerHit | undefined): boolean =>
  cfg.approval.mode === "danger" && cfg.approval.danger.enabled && !hit;

/** danger.skip: 命中危险名单也免卡直接放行 (显式的「跳过 danger」)。 */
export const dangerSkips = (cfg: Config, hit: DangerHit | undefined): boolean =>
  !!hit && cfg.approval.danger.skip;

/**
 * 上面两个开关合起来的早退判定。undefined = 不早退, 继续走审批链。
 *
 * `forcedByOthers` = 这次调用**除 danger 之外**还有别的必发卡理由 (当前唯一来源是
 * askRules 命中, 或 `.claude/**` 写守卫生效)。danger 的两个开关只表达「我不在乎
 * 危险名单」, 不表达「我不在乎另外那两条」—— 所以有其它理由时一律不早退:
 *   • askRules: 用户显式配的强制审批, 被 danger 开关顺手关掉就成了假配置;
 *   • `.claude/**` 守卫: 更硬 —— 早退意味着 settleClaudeConfigModal 不会执行,
 *     CC 随后立起的原生确认框没人去按, pane 无限期卡死。守卫存在的全部意义
 *     就是消灭这个死锁。
 *
 * 注意不能拿「mustCard」当这个参数: danger 命中本身就会置位 mustCard, 那样
 * dangerSkips 永远不触发, 等于把上游这个特性废掉。
 */
export const dangerEarlyExit = (
  cfg: Config,
  hit: DangerHit | undefined,
  forcedByOthers: boolean,
): "danger_skip" | "danger_mode_skip" | undefined => {
  if (forcedByOthers) return undefined;
  if (dangerSkips(cfg, hit)) return "danger_skip";
  if (dangerModeSkips(cfg, hit)) return "danger_mode_skip";
  return undefined;
};

/** 判定一次工具调用是否落在危险名单里。undefined = 安全。 */
export const dangerOf = (cfg: Config, toolName: string, toolInput: unknown): DangerHit | undefined => {
  const d = cfg.approval.danger;
  if (!d.enabled) return undefined;

  const cmds = commandsOf(toolInput);
  const allow = compile(d.allowPatterns);
  // 白名单优先: 任一命令被豁免则整条调用豁免 (显式覆盖内置的宽规则)。
  if (allow.length > 0 && [toolName, ...cmds].some((t) => firstHit(allow, t))) return undefined;

  const cmdRules = [...(d.builtin ? CMD_RULES : []), ...compile(d.commandPatterns)];
  const toolRules = [...(d.builtin ? TOOL_RULES : []), ...compile(d.toolPatterns)];
  const pathRules = [...(d.builtin ? PATH_RULES : []), ...compile(d.pathPatterns)];

  return (
    firstHit(toolRules, toolName) ??
    cmds.reduce<DangerHit | undefined>((acc, c) => {
      if (acc) return acc;
      // rm 全部目标都在临时区 → 只摘掉 rm 那两条规则, 其余规则照判 (sudo rm 还有
      // 提权、xargs rm 目标不可知, 都不能被 rm 的豁免顺手放掉)。
      const rules = rmAllTemp(c)
        ? cmdRules.filter(([label]) => !/删除文件 rm$/.test(label))
        : cmdRules;
      return firstHit(rules, c);
    }, undefined) ??
    strings(toolInput).filter(pathish).reduce<DangerHit | undefined>(
      (acc, s) => acc ?? firstHit(pathRules, s),
      undefined,
    )
  );
};

/** 屏面解不出结构时的危险判定 (pane 宽度截断 / 裸命令 / REPL 包裹): 可见正文是
 *  裸 shell 文本 (或 REPL 代码的展示), 不是 JS —— 直接整段按 Bash 命令判: 命令位
 *  正则本就认得出文本里的字面量形命令 (2026-10-27 真机回归: `cd /tmp && rm -rf …`)。
 *  REPL 的 JS 分层解析 (注释/数据键/命令键) 只用于 hook 路径的真实 code 入参。
 *  「看得见的操作里有没有真危险」与「这次操作看不清」是两件事: 只有前者进「危险」行。 */
export const dangerOfScript = (cfg: Config, text: string): DangerHit | undefined =>
  text.trim() ? dangerOf(cfg, "Bash", { command: text }) : undefined;

// 入参里任意深度的 key=value 对 (DeferExecuteTool 之类的包装可能把真实入参套一层)。
const deepEntries = (v: unknown): [string, unknown][] =>
  v && typeof v === "object"
    ? Object.entries(v as Record<string, unknown>).flatMap(([k, x]) => [[k, x] as [string, unknown], ...deepEntries(x)])
    : [];

/** wezard 自家工具里改全机设置的「写」: set_model scope:"default"。hook 的自家工具白名单把它
 *  放回审批; 这里让它**必发卡** —— 不吃 danger 的两个开关、⏱窗口和会话缓存。只有 skipAll /
 *  bypass (人主动选的全关) 压得过它。config_set 不在这里: 它按路径分级, 放权项由守护进程自己
 *  推确认卡 (/config/set), 那张卡连 skipAll 都压不过; 再在 hook 拦一道就成了一次改动两张卡。 */
export const selfConfigWriteOf = (toolName: string, toolInput: unknown): DangerHit | undefined => {
  const tool = /wezard__(set_model)$/.exec(toolName)?.[1];
  const kv = tool ? deepEntries(toolInput) : [];
  if (tool === "set_model" && kv.some(([k, v]) => k === "scope" && v === "default")) return { rule: "改全局默认模型 (set_model scope:default)" };
  return undefined;
};
