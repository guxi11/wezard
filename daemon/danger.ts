// 危险操作名单。命中者 **必须逐次单独审批**:
//   · 不吃 auto-window (approval.windowMinutes 的「N 分钟全过」)
//   · 不吃 session cache (同参数重复调用也要再点一次)
//   · 不参与批量合流 (永远独占一张卡, 不会被 ×N 聚合掉)
//   · 卡上没有「全过」按钮, 只有 ✅ / ❌
//   · fallbackOnError=allow 时降级为 ask (超时/断线不静默放行危险操作)
// 纯函数, 只做匹配; 所有副作用留在 approval.ts。
import type { Config } from "../shared/config.js";

export interface DangerHit {
  /** 人类可读的规则名, 直接渲染到卡片上 — 用户要知道「哪一条」判定它危险。 */
  rule: string;
}

type Rule = readonly [label: string, re: RegExp];

// 「命令词位置」前缀: 行首 / 换行 / `;` `&&` `||` `(` 之后 / 引号紧邻处 /
// sudo·nohup·exec·xargs·time·env 这类前缀命令之后 / `do` `then` `else` 之后 /
// `--` 参数分隔符之后。
//
// 为什么需要它: 名单是对**整条命令文本**做 test 的, 光靠 `\b` 界定的词只要在
// 任何位置出现就算命中 —— 而 `-` `/` 都是非单词字符, 于是分支名、文件名、参数值
// 里带上这些词就会让所有沾边的命令被判危险。真实案例: 分支
// `feature/graceful-shutdown` 让 `git checkout` / `git push` /
// `npm run test -- graceful-shutdown.spec.ts` 全部命中「关机/重启」必发单卡,
// 流程被审批卡堵死; 同族的 `\brm\b` 还会把 `docker run --rm` 判成删除文件。
const CMD_HEAD = String.raw`(?:^|[\n;&|(]\s*|["'\`]\s*|\b(?:sudo|nohup|exec|xargs|env|time|do|then|else)\s+|--\s+)`;

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
  [label, new RegExp(`${CMD_HEAD}(?:${words})\\b`, flags)],
  [`远程${label}`, new RegExp(`${REMOTE_CTX}(?:${words})\\b`, flags)],
];

// ── 内置命令名单 (Bash / 任何带 command 的工具) ────────────────────────
const CMD_RULES: readonly Rule[] = [
  ...cmdWord("删除文件 rm", "rm"),
  ...cmdWord("删除目录 rmdir", "rmdir"),
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
  ["git 丢弃改动", /\bgit\s+(reset\s+--hard|clean\b|checkout\s+--\s|restore\b)/],
  ["git 删分支", /\bgit\s+branch\s+-D\b|\bgit\s+push\b[\s\S]*--delete\b/],
  ["发布包", /\bnpm\s+(publish|unpublish)\b|\byarn\s+publish\b|\bpnpm\s+publish\b/],
  ["容器删除", /\bdocker\s+(rm|rmi|system\s+prune|volume\s+rm|compose\s+down)\b/],
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
  ["清历史", /\bhistory\s+-c\b|\bdefaults\s+delete\b/],
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

// command 类入参: Bash.command, 以及任何叫 command/script/cmd 的字段。
const COMMAND_KEYS = new Set(["command", "cmd", "script", "shell"]);
const commandsOf = (input: unknown): string[] => {
  if (!input || typeof input !== "object") return [];
  return Object.entries(input as Record<string, unknown>)
    .filter(([k, v]) => COMMAND_KEYS.has(k) && typeof v === "string")
    .map(([, v]) => v as string);
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
    cmds.reduce<DangerHit | undefined>((acc, c) => acc ?? firstHit(cmdRules, c), undefined) ??
    strings(toolInput).filter(pathish).reduce<DangerHit | undefined>(
      (acc, s) => acc ?? firstHit(pathRules, s),
      undefined,
    )
  );
};
