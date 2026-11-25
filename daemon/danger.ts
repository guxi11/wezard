// 危险操作名单。命中者 **必须逐次单独审批**:
//   · 不吃 auto-window (approval.windowMinutes 的「N 分钟全过」)
//   · 不吃 session cache (同参数重复调用也要再点一次)
//   · 不参与批量合流 (永远独占一张卡, 不会被 ×N 聚合掉)
//   · 卡上没有「全过」按钮, 只有 ✅ / ❌
//   · fallbackOnError=allow 时降级为 ask (超时/断线不静默放行危险操作)
// 判据必须来自「看懂了的操作」(人 2026-10-28): 认不出 / 解析不完整 / 动态拼接
// 的一律不立 danger, 交回普通审批; 每次命中的理由要具体到命令与目标, 卡片可见。
// 纯函数, 只做匹配; 所有副作用留在 approval.ts。
import type { Config } from "../shared/config.js";
import { COMMAND_KEYS, replBashCommands, replFallbackCommands } from "../shared/repl-script.js";
import { WRAPPER_NAMES, scrubCommand, shellWords } from "./danger-scrub.js";

export interface DangerHit {
  /** 人类可读的规则名, 直接渲染到卡片上 — 用户要知道「哪一条」判定它危险。 */
  rule: string;
}

// 多数规则是正则; 要「看清参数是哪几个词」的 (pkill 的目标宽不宽、凭据文件是被读还是只被 ls) 用谓词。
type Rule = readonly [label: string, test: RegExp | ((text: string) => boolean)];

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
const WRAPPERS = WRAPPER_NAMES;
const WRAP_ARG = String.raw`(?:-[^\s;|&]*|\d+(?:\.\d+)?[smhd]?|\w+=[^\s;|&]*)\s+`;
const CMD_HEAD = String.raw`(?:^|[\n;&|(]\s*|["'\`]\s*|\b(?:${WRAPPERS})\s+(?:${WRAP_ARG})*|--\s+)`;

// 「远程执行」上下文: 命令把动作送到别的机器/容器里跑时, 位置约束失效 ——
// `ssh host reboot`、`kubectl exec pod -- halt` 里危险词前面是主机名或 `--`。
// 因为前置了 ssh / exec 才触发, 不会误伤本机的普通命令, 所以这里保持宽匹配。
const REMOTE_CTX = String.raw`\b(?:ssh|(?:kubectl|docker)\s+exec)\b[\s\S]*\b`;

/**
 * 给「词本身太常见、只有出现在命令位置才危险」的规则配一对正则: 本机版带
 * 命令词位置约束, 远程版在 ssh/exec 上下文里放宽。
 *
 * 只用于纯单词触发的规则 —— `kubectl delete`、`dd if=` 这类自带结构约束的
 * 不需要, 它们的第二个 token 已经把误伤面挡住了。
 */const cmdWord = (label: string, words: string, flags = "", tail = ""): Rule[] => [
  // `\\?`: `\rm` 这种反斜杠转义 (绕开 alias 的惯用写法) 仍处于命令词位置。
  [label, new RegExp(`${CMD_HEAD}\\\\?(?:${words})\\b${tail}`, flags)],
  [`远程${label}`, new RegExp(`${REMOTE_CTX}(?:${words})\\b${tail}`, flags)],
];

// rm / git 丢弃改动 (2026-11-03 人口径「不要再判 danger」): 整类移出名单 ——
// rm (含包装器 / ssh 远程 / xargs 传参形态) 与 git 丢弃 (reset --hard / clean /
// checkout -- / restore, 整树与路径级都算) 都不再立 danger, 走普通审批卡。原先按
// 临时区 / 路径词法给 rm 分档的整套结构 (tokenize / normPath / 临时区清单 /
// rmOutsideTargets / GIT_WILDTREE) 随判据一并删除 —— 分类不存在了, 留着是死代码。
// 边界: 批量删除 find -delete 是独立的批量删除规则 (find 扫全树删, 不只是 rm),
// 不属这两类, 保持原样。
// `git [全局选项] push` 与「到本子句末尾」: 子句以 `;` `&` `|` `)` 换行收尾 (反斜杠续行不算)。
const GIT_PUSH = String.raw`\bgit\b(?:\s+(?:-[Cc]\s+\S+|--?[\w-]+(?:=\S+)?))*\s+push\b`;
const PUSH_CLAUSE = String.raw`(?:[^\n;&|)]|\\\n)*?`;

// pkill 的参数里是否有「宽」的目标 (见 CMD_RULES 里的说明)。纯函数, 可单测。
const PKILL_ARGS = new RegExp(`(?:${CMD_HEAD})\\\\?pkill\\b([^\\n;&|)]*)`, "g");
const PKILL_ANY = /\bpkill\b([^\n;&|)]*)/g;
const REMOTE_START = /\b(?:ssh|(?:kubectl|docker)\s+exec)\b/;
const pkillArgsRisky = (args: string): boolean => {
  const words = shellWords(args);
  const skip = new Set<number>();
  const forced = words.some((w, i) => /^-(?:9|KILL|SIGKILL)$/.test(w) || (w === "--signal" && /^(?:9|KILL|SIGKILL)$/.test(words[i + 1] ?? "")));
  const widening = words.some((w) => /^--(?:euid|uid|group|pgroup|session|terminal|inverse)\b/.test(w) || /^-[a-z]*[ugstv][a-z]*$/.test(w) || w === "-U" || w === "-G");
  words.forEach((w, i) => { if (w === "-P" || w === "-F") skip.add(i + 1); });
  const pattern = words.filter((w, i) => !skip.has(i) && !w.startsWith("-")).pop();
  // 没有模式 pkill 自己会报错; 有模式但太短 (< 8 字符) / 含变量 (看不见实际杀谁) → 当宽杀。
  const wide = pattern !== undefined && (/[$`]/.test(pattern) || pattern.length < 8);
  return forced || widening || wide;
};
export const pkillRisky = (text: string): boolean => {
  const local = [...text.matchAll(PKILL_ARGS)].map((m) => m[1] ?? "");
  const at = REMOTE_START.exec(text)?.index;
  const remote = at === undefined ? [] : [...text.slice(at).matchAll(PKILL_ANY)].map((m) => m[1] ?? "");
  return [...local, ...remote].some(pkillArgsRisky);
};

// ── 内置命令名单 (Bash / 任何带 command 的工具) ────────────────────────
const CMD_RULES: readonly Rule[] = [
  // rmdir 2026-10-28 移出: 只能删空目录, 没有数据可丢 (mkdir 即恢复), 不够「不可逆」。
  ["批量删除 find -delete", /\bfind\b[\s\S]*(-delete|-exec\s+rm)\b/],
  ...cmdWord("清空文件 truncate", "truncate"),
  ["裸设备写入 dd", /\bdd\s+(if|of)=/],
  ["格式化 mkfs", /\bmkfs\b|\bdiskutil\s+(erase|partition)/],
  ["重定向到设备", />\s*\/dev\/(?!null\b|stdout\b|stderr\b)/],
  ...cmdWord("提权 sudo", "sudo"),
  ["切换用户 su", /\bsu\s+-/],
  // 递归改权限 2026-10-28 移出: chmod/chown -R 只动权限位, 文件内容一个字节没变,
  // 重新 chmod 回去即可复原 —— 按「丢了能不能恢复」这条口径不够 danger。原规则把
  // 777 写在同一分支里, 拆出来立成独立一条: 全局可写是「别人能改我的文件」的洞,
  // 被改过的内容不留底 (git 只认得已提交的那版), 与递归改权限不是一件事。
  ["全局可写 chmod 777", /\bch(mod|own)\b[\s\S]*\b777\b/],
  // 强制杀进程 (人 2026-11-25 D): 只留 SIGKILL (kill -9 / pkill -9 / killall) 与「宽杀」。
  //  · kill -9 / -KILL 要在命令词位置 (原先无位置约束, echo / 提交信息里的字样也中);
  //  · killall 按名字杀光同名进程, 本身就是宽杀;
  //  · pkill 看目标: 带具体模式的 `pkill -f "next dev -p 3100"` (SIGTERM) 是正常收尾 → 普通档;
  //    -9 / 按用户·组·会话·终端选 / 反选 / 模式太短 (`pkill -f node`) 或看不见 (`$X`) → 仍 danger。
  ...cmdWord("强制杀进程", "kill", "", String.raw`\s+(?:-9|-KILL|-SIGKILL|-s\s+(?:9|KILL|SIGKILL))\b`),
  ...cmdWord("强制杀进程", "killall"),
  ["强制杀进程", pkillRisky],
  ...cmdWord("关机/重启", "shutdown|reboot|halt|poweroff"),
  ["服务停用", /\blaunchctl\s+(unload|bootout|remove)\b|\bsystemctl\s+(stop|disable|mask)\b/],
  // 强推 / 删远程分支 (人 2026-11-25 B): 旗标必须落在**同一条 push 子句**里。原正则
  // `git … push … --force` 跨分隔符匹配, `git push origin x:main && git worktree remove --force`
  // 的 --force 属于 worktree, 却被判强推。口径不变: --force 前缀照旧算 (含
  // --force-with-lease / --force-if-includes), 另补 +refspec 强推 (`git push origin +main`)。
  ["git 强推", new RegExp(`${GIT_PUSH}${PUSH_CLAUSE}(?:\\s--force\\b|\\s-[a-zA-Z]*f[a-zA-Z]*(?=\\s|$)|\\s["']?\\+\\S)`)],
  // git 删分支 2026-10-28 拆分: 本地 branch -D 移出 —— 提交仍在 reflog 里
  // (默认 90 天), git 里拿得回来; 远程 push --delete 保留 —— 动的是共享远端,
  // 别人的克隆不一定有副本, 拿不回来。
  ["git 删远程分支", new RegExp(`${GIT_PUSH}${PUSH_CLAUSE}\\s(?:--delete\\b|-d\\b)`)],
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

// ── 内置敏感路径名单 ────────────────────────────────────────────────────
// 两个战场, 判据不同:
//   · 文件路径入参 (Read / Edit / Write 的 file_path 等): 路径本身就是目标, 正则直接判;
//   · 命令文本 (Bash.command): 路径只是命令的一个词 —— `ls -l .env`、`ln -s … .env`、
//     `cat ~/.ssh/config` 都不泄露什么 (人 2026-11-25 C / E: 近 24h 82 张卡的大头), 凭据文件
//     按「动词 + 路径」判 (见 credentialAccess), SSH 目录只拦私钥与授权文件。
// SSH: 私钥 / 授权文件 / `.ssh/` 下除 config·known_hosts·cm/·*.pub 之外的一切 (反向排除:
// 私钥文件名可以随便起, 白名单私钥名会漏 `deploy_key` 这类)。
const SSH_BENIGN = String.raw`config\b|known_hosts[\w.]*|cm\/|[^\s/"']*\.pub(?![\w.])|environment\b|rc\b|sockets?\/|control[\w-]*\/`;
const SSH_KEY = new RegExp(
  String.raw`(?:^|[\/\s"'=:])\.ssh\/(?!(?:${SSH_BENIGN}))|(?<![\w-])id_(?:rsa|dsa|ecdsa|ed25519)(?:_sk)?\b(?!\.pub)|(?<![\w-])authorized_keys\b`,
);
const CRED_FILE = /(^|\/)\.(env\b(?!\.(?:example|sample|template|dist|defaults?)\b)|npmrc|netrc|aws|gnupg)\b|credentials\b|secrets?\.(json|ya?ml|env)\b/;
const PATH_RULES: readonly Rule[] = [
  ["SSH 密钥", SSH_KEY],
  ["凭据文件", CRED_FILE],
  ["系统目录", /^\/(etc|System|Library\/LaunchDaemons|usr\/bin|bin|sbin)\//],
  ["家目录根/根目录", /^\s*(~|\/|\$HOME)\/?\s*$/],
];

// ── 凭据文件: 只拦会泄露内容的读法 / 拷出 / 写入 (人 2026-11-25 E「在使用侧限制」) ─────────
// 放行: ls / stat / md5 / ln -s / file / wc / test / chmod / rm / `source .env && psql` /
//   `docker run --env-file .env` / `grep -c KEY .env` (只数不露) / `cat .env | cut -d= -f1` (打码)。
// 拦: cat·head·tail·less·无打码 grep·sed·awk 等把内容读出来; cp·mv·scp·rsync·tar·curl -d @ 等拷出;
//   重定向 / tee / sed -i / cp 写入; python·node 等脚本里直接 open 它; ssh 远端的同类读法。
const CRED_NAME = String.raw`(?:\.env(?!\.(?:example|sample|template|dist|defaults?)(?![\w-]))(?:\.[\w-]+)?|\.npmrc|\.netrc|\.pgpass|\.aws(?:\/\S*)?|\.gnupg(?:\/\S*)?|credentials(?:\.\w+)?|secrets?\.(?:json|ya?ml|env))`;
const CRED_ARG = String.raw`(?<![\w.-])(?:[^\s"'|;&<>()=]*\/)?${CRED_NAME}(?![\w-])`;
const PRINTERS = String.raw`cat|tac|head|tail|less|more|bat|batcat|nl|od|xxd|hexdump|strings|base64|sed|awk|gawk|cut|sort|uniq|paste|column|diff|cmp|comm|grep|egrep|fgrep|zgrep|rg|ag|ack|jq|yq`;
const MOVERS = String.raw`cp|mv|scp|rsync|tar|zip|7z|gzip|bzip2|xz|dd|install|tee|curl|wget|nc|ncat|socat|pbcopy|xclip|xsel|python[\d.]*|node|nodejs|ruby|perl|php|tsx|deno|bun`;
const VERB = String.raw`(?:[^\s"'|;&<>()]*\/)?(${PRINTERS}|${MOVERS})\b`;
const CRED_READ = new RegExp(`${CMD_HEAD}\\\\?${VERB}[^\\n;&|)]*?${CRED_ARG}`, "dg");
// 脚本解释器的参数是引号里的一整段代码 (`python -c "import os; open('.env')"`), 里面的 `;` `)`
// 不是命令分隔符 —— 一律扫到行尾 (代价: `node build.js && ls .env` 这种并列句也会中, 可接受)。
const CRED_INTERP = new RegExp(`${CMD_HEAD}\\\\?(?:[^\\s"'|;&<>()]*\\/)?(?:python[\\d.]*|node|nodejs|ruby|perl|php|tsx|deno|bun)\\b[^\\n]*?${CRED_ARG}`);
const CRED_REMOTE = new RegExp(String.raw`\b(?:ssh|(?:kubectl|docker)\s+exec)\b[^\n;&|]*?\b(?:${PRINTERS}|${MOVERS})\b[^\n;&|)]*?${CRED_ARG}`);
const CRED_WRITE = new RegExp(String.raw`\d*>>?\|?[ \t]*["']?(?:[^\s"'|;&<>()]*\/)?${CRED_NAME}(?![\w-])`);
const CRED_FIND = new RegExp(String.raw`\bfind\b[^\n;&|]*${CRED_ARG}[^\n;&|]*-exec(?:dir)?\s+(?:${PRINTERS}|${MOVERS})\b`);
const CRED_XARGS = new RegExp(String.raw`${CRED_ARG}[^\n;&|]*\|\s*xargs\s+(?:-\S+\s+)*(?:${PRINTERS}|${MOVERS})\b`);
const COUNT_ONLY = /(?:^|\s)-[a-zA-Z]*[clLq][a-zA-Z]*(?=\s|$)|--(?:count|files-with-matches|files-without-match|quiet|silent)\b/;
const MASKED_PIPE = /^\|\s*(?:cut\b[^|]*(?:-d\s*['"]?=|-f\s*1\b)|sed\b[^|]*\bs(.)[^\n|]*=|awk\b[^|]*-F\s*['"]?=|wc\b)/;
const PRINT_ONLY = new RegExp(`^(?:${PRINTERS})$`);
const IN_PLACE = /(?:^|\s)(?:-[a-zA-Z]*i|--in-place)\b/;

export const credentialAccess = (text: string): boolean => {
  const read = [...text.matchAll(CRED_READ)].some((m) => {
    const verb = m[1] ?? "";
    if (!PRINT_ONLY.test(verb)) return true; // 拷出 / 写入 / 脚本读: 没有「打码」一说
    const at = m.indices?.[1]?.[0] ?? m.index ?? 0; // 动词自己的位置 (m.index 还带着命令词前缀)
    const seg = text.slice(at).split(/[\n;&|)]/, 1)[0] ?? "";
    if (verb === "sed" && IN_PLACE.test(seg)) return true;
    if (/^(?:e?grep|fgrep|zgrep|rg|ag|ack)$/.test(verb) && COUNT_ONLY.test(seg)) return false;
    return !MASKED_PIPE.test(text.slice(at + seg.length));
  });
  return read || CRED_INTERP.test(text) || CRED_WRITE.test(text) || CRED_REMOTE.test(text) || CRED_FIND.test(text) || CRED_XARGS.test(text);
};

// 命令文本上的路径类规则 (已 scrub): SSH 与凭据按上面的口径, 其余沿用路径正则。
const CMD_PATH_RULES: readonly Rule[] = [
  ["SSH 密钥", SSH_KEY],
  ["凭据文件", credentialAccess],
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
  const hit = rules.find(([, t]) => (typeof t === "function" ? t(text) : t.test(text)));
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
    // 变量拼的 'docker volume rm x' (裸赋值) 仍被兜底抓住, 宁可多一张卡。
    return [...replBashCommands(v), ...replFallbackCommands(v)];
  });
};

// 路径类入参: 只看看起来像路径的字符串, 避免拿正文去撞路径规则。
const pathish = (s: string): boolean => s.length < 512 && /^[~$/.]|\//.test(s);

// 路径规则读哪些入参 (人 2026-11-25 A「Edit / Write 只对 file_path 跑路径规则, 不扫 new_string /
// content」): 内置文件类工具只看它们的路径键; Bash 的路径在命令里, 由命令级规则判, 它的
// description / timeout 之类不是路径。其余 (MCP / REPL 的 code …) 仍扫全部字符串叶子, 但
// 跳过明显是「正文」的键 —— 写进文件的内容不是被访问的路径。
const FILE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit", "Read", "Glob", "Grep", "Bash"]);
const PATH_KEYS = ["file_path", "notebook_path", "path"] as const;
const BODY_KEYS = new Set(["new_string", "old_string", "content", "new_source"]);

const leaves = (v: unknown, depth = 0, acc: string[] = []): string[] => {
  if (acc.length >= MAX_NODES || depth > 4) return acc;
  if (typeof v === "string") { acc.push(v); return acc; }
  if (Array.isArray(v)) { v.forEach((x) => leaves(x, depth + 1, acc)); return acc; }
  if (v && typeof v === "object") {
    Object.entries(v as Record<string, unknown>).forEach(([k, x]) => { if (!BODY_KEYS.has(k)) leaves(x, depth + 1, acc); });
  }
  return acc;
};

/** 路径规则要扫的字符串叶子。 */
export const pathLeaves = (toolName: string, toolInput: unknown): string[] => {
  if (!FILE_TOOLS.has(toolName)) return leaves(toolInput);
  const o = toolInput && typeof toolInput === "object" ? (toolInput as Record<string, unknown>) : {};
  return PATH_KEYS.flatMap((k) => (typeof o[k] === "string" ? [o[k] as string] : []));
};

/**
 * danger 模式下这次调用是否可以免卡直接放行 (mode=danger 是默认档: 普通卡
 * 不再发, 见 config.ts 的 mode 枚举; "off" 档的放行不在这里 —— 它有专用分支,
 * 连 askRules 都压过, 与旧 skipAll 语义一致)。
 */
export const dangerModeSkips = (cfg: Config, hit: DangerHit | undefined): boolean =>
  cfg.approval.mode === "danger" && !hit;

/**
 * 早退判定。undefined = 不早退, 继续走审批链。
 *
 * `forcedByOthers` = 这次调用**除 danger 之外**还有别的必发卡理由 (当前唯一来源是
 * askRules 命中, 或 `.claude/**` 写守卫生效)。danger 档只表达「非 danger 不发卡」,
 * 不表达「我不在乎另外那两条」—— 所以有其它理由时一律不早退:
 *   • askRules: 用户显式配的强制审批, 被 danger 档顺手关掉就成了假配置;
 *   • `.claude/**` 守卫: 更硬 —— 早退意味着 settleClaudeConfigModal 不会执行,
 *     CC 随后立起的原生确认框没人去按, pane 无限期卡死。守卫存在的全部意义
 *     就是消灭这个死锁。
 */
export const dangerEarlyExit = (
  cfg: Config,
  hit: DangerHit | undefined,
  forcedByOthers: boolean,
): "danger_mode_skip" | undefined => {
  if (forcedByOthers) return undefined;
  if (dangerModeSkips(cfg, hit)) return "danger_mode_skip";
  return undefined;
};

/** 判定一次工具调用是否落在危险名单里。undefined = 安全。 */
export const dangerOf = (cfg: Config, toolName: string, toolInput: unknown): DangerHit | undefined => {
  const d = cfg.approval.danger;
  const cmds = commandsOf(toolInput);
  const allow = compile(d.allowPatterns);
  // 白名单优先: 任一命令被豁免则整条调用豁免 (显式覆盖内置的宽规则)。
  if (allow.length > 0 && [toolName, ...cmds].some((t) => firstHit(allow, t))) return undefined;

  // 内置命令规则读预处理后的文本 (heredoc 数据体 / grep·echo 的引号参数已抹掉, 见
  // danger-scrub.ts); 用户自配的 commandPatterns 读原文 —— 那是人明确要拦的字样, 不替它放宽。
  const scrubbed = cmds.map(scrubCommand);
  const builtinCmd = d.builtin ? CMD_RULES : [];
  const toolRules = [...(d.builtin ? TOOL_RULES : []), ...compile(d.toolPatterns)];
  const builtinPath = d.builtin ? PATH_RULES : [];
  const customPath = compile(d.pathPatterns);

  const cmdHit = (c: string, raw: string): DangerHit | undefined =>
    firstHit(builtinCmd, c) ??
    firstHit(compile(d.commandPatterns), raw) ??
    (d.builtin ? firstHit(CMD_PATH_RULES, c) : undefined) ??
    // 命令里的路径类规则只留「命令即路径」的两条 (系统目录 / 家目录根, 锚定整串开头)。
    (d.builtin && pathish(c) ? firstHit(PATH_RULES.slice(2), c) : undefined);

  return (
    firstHit(toolRules, toolName) ??
    scrubbed.reduce<DangerHit | undefined>((acc, c, i) => acc ?? cmdHit(c, cmds[i] ?? c), undefined) ??
    pathLeaves(toolName, toolInput).filter(pathish).reduce<DangerHit | undefined>(
      (acc, s) => acc ?? firstHit(builtinPath, s),
      undefined,
    ) ??
    // 自配 pathPatterns 沿用老口径: 扫全部字符串叶子 (含命令文本)。
    strings(toolInput).filter(pathish).reduce<DangerHit | undefined>(
      (acc, s) => acc ?? firstHit(customPath, s),
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
