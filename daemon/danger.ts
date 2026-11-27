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
import { posix } from "node:path";
import { WRAPPER_NAMES, leadWords, scrubCommand, shellWords } from "./danger-scrub.js";

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

// ── 凭据文件: 只拦会泄露内容的读法 / 拷出 / 写入 (人 2026-11-25 E「在使用侧限制」; 2026-11-27 再收窄 + 白名单) ─────
// 放行: ls / stat / md5 / ln -s / file / wc / test / chmod / rm / `source .env && psql` /
//   `docker run --env-file .env` / `grep -c KEY .env` (只数不露) / `cat .env | cut -d= -f1` (打码) /
//   `cp ../x/.env .env` (同名拷贝: 名字不变, 事后读它仍会被本规则认出) / `ls -a | grep "^\.env"` (模式不是文件) /
//   `U=$(grep ^DB_URL .env …)` 且之后没把 $U 原样回显 / `cmp·diff -q` (只报「相同与否」)。
// 拦: cat·head·tail·less·无打码 grep·sed·awk 等把内容读出来; cp·mv 改名或拷到公开目录 / host:, scp·rsync·tar·curl -d @ 等拷出;
//   重定向 / tee / sed -i / cp 写入; python·node 等脚本里直接 open 它; ssh 远端的同类读法。
// 白名单 `approval.danger.credentialAllow` 只豁免这一条规则里的「读 (打码) / 同机拷贝 / 元数据」, 写入、外发永远拦。
const CRED_NAME = String.raw`(?:\.env(?!\.(?:example|sample|template|dist|defaults?)(?![\w-]))(?:\.[\w-]+)?|\.npmrc|\.netrc|\.pgpass|\.aws(?:\/\S*)?|\.gnupg(?:\/\S*)?|credentials(?:\.\w+)?|secrets?\.(?:json|ya?ml|env))`;
const CRED_ARG = String.raw`(?<![\w.-])(?:[^\s"'|;&<>()=]*\/)?${CRED_NAME}(?![\w-])`;
const PRINTERS = String.raw`cat|tac|head|tail|less|more|bat|batcat|nl|od|xxd|hexdump|strings|base64|sed|awk|gawk|cut|sort|uniq|paste|column|diff|cmp|comm|grep|egrep|fgrep|zgrep|rg|ag|ack|jq|yq`;
const MOVERS = String.raw`cp|mv|scp|rsync|tar|zip|7z|gzip|bzip2|xz|dd|install|tee|curl|wget|nc|ncat|socat|pbcopy|xclip|xsel|python[\d.]*|node|nodejs|ruby|perl|php|tsx|deno|bun`;
const VERB = String.raw`(?:[^\s"'|;&<>()]*\/)?(${PRINTERS}|${MOVERS})\b`;
// 只找「命令词位置的动词」; 它的文件操作数里有没有凭据, 交给 verbLeaks 按引号感知的段落判 (旧写法的 `[^;&|)]*?` 在引号里的 `|` `)` 处就断了)。
const CRED_VERB = new RegExp(`${CMD_HEAD}\\\\?${VERB}`, "dg");
// 脚本解释器的参数是引号里的一整段代码 (`python -c "import os; open('.env')"`), 里面的 `;` `)`
// 不是命令分隔符 —— 一律扫到行尾 (代价: `node build.js && ls .env` 这种并列句也会中, 可接受)。
const CRED_INTERP = new RegExp(`${CMD_HEAD}\\\\?(?:[^\\s"'|;&<>()]*\\/)?(?:python[\\d.]*|node|nodejs|ruby|perl|php|tsx|deno|bun)\\b[^\\n]*?${CRED_ARG}`);
// 远端形态: ssh / exec 之后的动词不在命令词位置 (前面是主机名), 单独找; 找到的动词照样走下面同一套逐动词判定。
const CRED_REMOTE = new RegExp(String.raw`\b(?:ssh|(?:kubectl|docker)\s+exec)\b[^\n;&|]*?\b(${PRINTERS}|${MOVERS})\b[^\n;&|)]*?${CRED_ARG}`, "d");
const CRED_WRITE = new RegExp(String.raw`\d*>>?\|?[ \t]*["']?(?:[^\s"'|;&<>()]*\/)?${CRED_NAME}(?![\w-])`);
const CRED_FIND = new RegExp(String.raw`\bfind\b[^\n;&|]*${CRED_ARG}[^\n;&|]*-exec(?:dir)?\s+(?:${PRINTERS}|${MOVERS})\b`);
const CRED_XARGS = new RegExp(String.raw`${CRED_ARG}[^\n;&|]*\|\s*xargs\s+(?:-\S+\s+)*(?:${PRINTERS}|${MOVERS})\b`);
const COUNT_ONLY = /(?:^|\s)-[a-zA-Z]*[clLq][a-zA-Z]*(?=\s|$)|--(?:count|files-with-matches|files-without-match|quiet|silent)\b/;
const PRINT_ONLY = new RegExp(`^(?:${PRINTERS})$`);
const GREP_VERB = /^(?:e?grep|fgrep|zgrep|rg|ag|ack)$/;
const IN_PLACE = /(?:^|\s)(?:-[a-zA-Z]*i|--in-place)\b/;
const CRED_TOKEN = new RegExp(CRED_ARG);

// ── 下游「已打码」判定 ──────────────────────────────────────────────────
// sed 替换段里带 `*` 或 REDACT/MASK 字样才算打码 (`s/=.*/=***/`、`s#//[^@]*@#//***@#`)。
const SED_SUBST = /(?<![\w-])s([^\w\s\\'"])((?:\\.|(?!\1).)*)\1((?:\\.|(?!\1).)*)\1/g;
const sedMasks = (stage: string): boolean =>
  [...stage.matchAll(SED_SUBST)].some((m) => /\*|redact|mask|hidden|xxx/i.test(m[3] ?? ""));
const KEYS_ONLY_CUT = /\bcut\b(?=[^|]*-d\s*['"]?=)(?=[^|]*-f\s*1(?![\d,-]))/;
const KEYS_ONLY_AWK = /\bawk\b(?=[^|]*-F\s*['"]?=)[^|]*\{\s*print\s+\$1\s*\}/;
const HASH_ONLY = /^(?:md5sum|md5|sha\d*sum|shasum|cksum)\b/;
const chainHas = (rest: string): boolean =>
  [...(/^(?:&\d+\s*)?(?:\|(?!\|)[^|\n;&)]*)+/.exec(rest)?.[0] ?? "").matchAll(/\|\s*(cut|sed|g?awk)\b/g)].length > 0;
/** `rest` 是命令段之后的文本: 紧跟的管道下游第一段是否把内容打了码 / 只留了键名 / 只数行 / 只出摘要。 */
const maskedPipe = (rest: string, loose = false): boolean => {
  const stage = /^\|(?!\|)\s*([^|\n]*)/.exec(rest.replace(/^&\d+\s*/, ""))?.[1]?.trimStart() ?? ""; // `2>&1 | …` 的 `&1` 不挡管道
  if (!stage) return false;
  return (
    /^wc\b/.test(stage) || HASH_ONLY.test(stage) ||
    (/^cut\b/.test(stage) && KEYS_ONLY_CUT.test(stage)) ||
    (/^(?:g?awk)\b/.test(stage) && KEYS_ONLY_AWK.test(stage)) ||
    (/^sed\b/.test(stage) && sedMasks(stage)) ||
    (/^(?:e?grep|fgrep|rg)\b/.test(stage) && COUNT_ONLY.test(stage)) ||
    // 白名单里的 read-masked: 管道链上任一段是 cut/sed/awk 就信它是在打码 (守护进程验证不了这几段的参数)。
    (loose && chainHas(rest))
  );
};

// `VAR=$(… 读凭据 …)`: 读出来的值进了变量, 不回显给模型就不泄露。回显 (echo/printf/cat/tee/here-string) 须自己再打码, 外发工具拿到它直接算泄露。
const ASSIGN = /\b([A-Za-z_]\w*)=\$\(/g;
const captured = (text: string, at: number): { name: string; end: number } | undefined => {
  for (const m of text.matchAll(ASSIGN)) {
    const from = (m.index ?? 0) + m[0].length;
    if (at < from) continue;
    const end = [...text.slice(from)].reduce<{ depth: number; at: number }>((acc, ch, i) =>
      acc.at >= 0 ? acc : ch === "(" ? { ...acc, depth: acc.depth + 1 } : ch === ")" ? (acc.depth === 0 ? { ...acc, at: from + i } : { ...acc, depth: acc.depth - 1 }) : acc,
    { depth: 0, at: -1 }).at;
    if (end >= at) return { name: m[1] ?? "", end };
  }
  return undefined;
};
const ECHOERS = new Set(["echo", "printf", "cat", "tee", "print"]);
const OUTBOUND = new Set(["curl", "wget", "nc", "ncat", "socat", "scp", "rsync", "pbcopy", "xclip", "xsel"]);
const ANY_VERB = new RegExp(`${CMD_HEAD}\\\\?(?:[^\\s"'|;&<>()]*\\/)?([\\w.-]+)`, "dg");
const SCRIPTERS = /^(?:python[\d.]*|node|nodejs|ruby|perl|php|tsx|deno|bun)$/;
const varLeaks = (text: string, qmap: Uint8Array, name: string, from: number): boolean => {
  const ref = new RegExp(String.raw`\$\{?${name}(?![\w])`);
  return [...text.slice(from).matchAll(ANY_VERB)].some((m) => {
    const at = from + (m.indices?.[1]?.[0] ?? m.index ?? 0);
    const seg = segmentAt(text, at, qmap);
    if (!ref.test(seg)) return false;
    const verb = m[1] ?? "";
    if (OUTBOUND.has(verb) || SCRIPTERS.test(verb)) return true;
    return (ECHOERS.has(verb) || /<<</.test(seg)) && !maskedPipe(text.slice(at + seg.length));
  });
};

// ── cp / mv: 只放行「同名拷贝」 ─────────────────────────────────────────
// 名字不变 → 事后 `cat` 那份拷贝同样被本规则认出; 改名 (`cp .env notes.txt`) 就脱了钩, 拦。
// 目的地在公开目录 (/tmp 之类) / 带 `host:` / 动态拼接 (`$(…)`) 也拦; 凭据只出现在目的地 (`cp .env.example .env` = 写入) 也拦。
const PUBLIC_DIR = /^(?:\/(?:private\/)?tmp|\/(?:private\/)?var\/tmp|\/dev\/shm|\/Users\/Shared|\/(?:mnt|media|Volumes|srv)|\/var\/www|(?:~|\$HOME|\$\{HOME\}|\/(?:home|Users)\/[^/]+)\/Downloads|\$\{?TMPDIR\}?)(?:\/|$)/;
const REMOTE_DEST = /^[^/\s]*:/;
const baseOf = (p: string): string => p.replace(/\/+$/, "").replace(/^.*\//, "");
const redirectFree = (words: readonly string[]): string[] =>
  words.reduce<{ out: string[]; skip: boolean }>((acc, w) =>
    acc.skip ? { out: acc.out, skip: false }
    : /^\d*>>?&?\d*$/.test(w) ? { out: acc.out, skip: true }
    : /^\d*>/.test(w) ? acc
    : /^<+$/.test(w) ? acc // 输入重定向: 去掉 `<` 本身, 后面的文件仍是被读的操作数
    : /^<+./.test(w) ? { out: [...acc.out, w.replace(/^<+/, "")], skip: false }
    : { out: [...acc.out, w], skip: false },
  { out: [], skip: false }).out;

interface CopyShape { sources: string[]; dest: string; dirDest: boolean }
const copyShape = (words: readonly string[]): CopyShape | undefined => {
  const dd = words.indexOf("--");
  const opts = dd < 0 ? words : words.slice(0, dd);
  const tIdx = opts.findIndex((w) => w === "-t" || w === "--target-directory" || /^--target-directory=/.test(w) || /^-[a-zA-Z]*t$/.test(w));
  const tDir = tIdx < 0 ? undefined : /^--target-directory=/.test(opts[tIdx]!) ? opts[tIdx]!.slice("--target-directory=".length) : opts[tIdx + 1];
  const operands = words.filter((w, i) => (dd >= 0 && i > dd) || (!w.startsWith("-") && !(tIdx >= 0 && i === tIdx + 1 && !/=/.test(opts[tIdx]!))));
  if (tIdx >= 0) return tDir ? { sources: operands, dest: tDir, dirDest: true } : undefined;
  return operands.length < 2 ? undefined : { sources: operands.slice(0, -1), dest: operands[operands.length - 1]!, dirDest: false };
};
const dynamic = (w: string): boolean => /\$\(|`/.test(w);
/** 这条 cp/mv 是否「只是同名拷贝」(不泄露、不外发、不改名)。 */
const sameNameCopy = (words: readonly string[], text: string, at: number): boolean => {
  const shape = copyShape(redirectFree(words));
  if (!shape) return false;
  const { sources, dest } = shape;
  const creds = sources.filter((w) => CRED_TOKEN.test(w));
  if (!creds.length || [...sources, dest].some(dynamic)) return false;
  if (PUBLIC_DIR.test(dest) || REMOTE_DEST.test(dest)) return false;
  if (/\bcd\s+["']?(?:\/(?:private\/)?tmp|\/(?:private\/)?var\/tmp|\/dev\/shm)(?:[\/\s"';&]|$)/.test(text.slice(0, at))) return false; // 先 cd 进公开目录再拷相对名
  const dirDest = shape.dirDest || dest === "." || dest === ".." || dest.endsWith("/");
  if (!dirDest && sources.length > 1) return false;
  return creds.every((c) => dirDest || baseOf(c) === baseOf(dest));
};

// ── approval.danger.credentialAllow: 放行指定凭据文件的「读 (打码) / 同机拷贝 / 元数据」 ─────────────
export type CredVerb = "copy" | "read-masked" | "list";
export type CredAllowEntry = string | { path: string; verbs?: readonly CredVerb[] };
export interface CredCtx { cwd?: string; allow?: readonly CredAllowEntry[] }
const ALL_VERBS: readonly CredVerb[] = ["copy", "read-masked", "list"];
const homeOf = (): string => process.env.HOME ?? "";
const expandHomeVars = (p: string): string =>
  p.replace(/^(?:~|\$HOME|\$\{HOME\})(?=\/|$)/, homeOf());
/** 路径 → 绝对路径 (展开 ~ / $HOME, 相对的按 cwd); 带变量 / 命令替换 (或 token 里带通配) 的解不出, 返回 undefined。 */
const absPath = (p: string, cwd: string | undefined, glob = false): string | undefined => {
  const e = expandHomeVars(p);
  if (/[$`]/.test(e) || (!glob && /[*?]/.test(e))) return undefined;
  if (e.startsWith("/")) return posix.normalize(e);
  return cwd ? posix.normalize(posix.join(cwd, e)) : undefined;
};
const globRe = (g: string): RegExp =>
  new RegExp("^" + g
    .replace(/[.+^${}()|\\]/g, "\\$&")
    .replace(/\*\*\//g, "\0A")
    .replace(/\*\*/g, "\0B")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]")
    .replace(/\0A/g, "(?:.*/)?")
    .replace(/\0B/g, ".*") + "$");
const credAllowed = (tok: string, verb: CredVerb, ctx: CredCtx | undefined): boolean => {
  const allow = ctx?.allow ?? [];
  if (!allow.length) return false;
  const abs = absPath(tok, ctx?.cwd);
  if (!abs) return false;
  return allow.some((e) => {
    const entry = typeof e === "string" ? { path: e, verbs: ALL_VERBS } : { path: e.path, verbs: e.verbs ?? ALL_VERBS };
    const pat = entry.path.startsWith("**") ? entry.path : absPath(entry.path, ctx?.cwd, true);
    return !!pat && entry.verbs.includes(verb) && globRe(pat).test(abs);
  });
};

/** 每个字符所处的引号: 0 = 不在引号里, 1 = 单引号内, 2 = 双引号内 (开引号自身记 0)。一趟扫完, 供 segmentAt 判断一个动词是不是长在外层引号里。 */
const quoteMap = (text: string): Uint8Array => {
  const map = new Uint8Array(text.length);
  let q = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (q) {
      if (ch === "\\" && q === '"') { map[i] = 2; if (i + 1 < text.length) map[++i] = 2; continue; }
      if (ch === q) { q = ""; continue; }
      map[i] = q === "'" ? 1 : 2;
    } else if (ch === '"' || ch === "'") q = ch;
  }
  return map;
};

/** 从 `at` 起到命令分隔符为止的一段; 引号里的 `|` `;` `)` 不算分隔 (`grep -E "KEY|TOKEN" .env`)。
 *  动词若本身就在一层外层引号里 (`bin/mx 'grep … .env'`), 那层引号一闭合 (收尾的 `'`) 这一段就结束 ——
 *  不让它跟后面下一个 `'…'` 配成对; 内层再开的另一种引号照常整段跳过; 内层没闭合的引号在它开处截断。 */
const segmentAt = (text: string, at: number, qmap: Uint8Array): string => {
  const outer = qmap[at] === 1 ? "'" : qmap[at] === 2 ? '"' : "";
  let q = "";
  let open = -1;
  let depth = 0; // 段内自己开的括号 (`$(pwd)/.env`): 它们的 `)` 不算分隔, 只有属于外层的 `)` 才算
  for (let i = at; i < text.length; i++) {
    const ch = text[i]!;
    if (q) { if (ch === q) q = ""; continue; }
    if (outer && ch === outer) return text.slice(at, i);
    if (ch === '"' || ch === "'") { q = ch; open = i; continue; }
    if (ch === "(") { depth++; continue; }
    if (ch === ")" && depth > 0) { depth--; continue; }
    if (ch === "\n" || ch === ";" || ch === "&" || ch === "|" || ch === ")") return text.slice(at, i);
  }
  return text.slice(at, q ? open : text.length);
};

/** 命令段里的「文件操作数」: grep 族去掉第一个非选项词 (它是模式, 不是文件; 给了 -e / -f 则没有模式词)。 */
const operandsOf = (verb: string, words: readonly string[]): string[] => {
  if (!GREP_VERB.test(verb)) return [...words];
  const patternFlag = (w: string): boolean => /^(?:-[a-zA-Z]*e|--regexp)$/.test(w); // 下一个词是模式
  const viaFlag = words.some((w) => patternFlag(w) || /^--regexp=|^-[a-zA-Z]*f/.test(w) || w === "--file");
  const at = viaFlag ? -1 : words.findIndex((w) => !w.startsWith("-"));
  return words.filter((w, i) => i !== at && !(i > 0 && patternFlag(words[i - 1]!)) && !/^--regexp=/.test(w));
};

/** 一个动词 + 它这段命令: true = 会泄露 / 外发 / 写入 (该发卡)。`at` 是动词在整段文本里的位置。 */
const verbLeaks = (text: string, qmap: Uint8Array, verb: string, at: number, ctx: CredCtx | undefined): boolean => {
  const seg = segmentAt(text, at, qmap);
  const words = shellWords(seg).slice(1);
  const rest = text.slice(at + seg.length);
  if (!words.some((w) => CRED_TOKEN.test(w))) return false; // 这一段没碰凭据文件
  if (verb === "cp" || verb === "mv") {
    if (sameNameCopy(words, text, at)) return false;
    const shape = copyShape(redirectFree(words));
    if (!shape) return true;
    const creds = shape.sources.filter((w) => CRED_TOKEN.test(w));
    const writesCred = CRED_TOKEN.test(shape.dest) && creds.length < shape.sources.length; // 非凭据 → 凭据文件 = 写入
    // 白名单的同机拷贝: 任意改名 / 任意本机目的地 (含 /tmp), 但仍不放 host: / 动态拼接 / 写入凭据文件。
    return !(creds.length > 0 && !writesCred && ![...shape.sources, shape.dest].some(dynamic) && !REMOTE_DEST.test(shape.dest)
      && creds.every((c) => credAllowed(c, "copy", ctx)));
  }
  if (!PRINT_ONLY.test(verb)) return true; // 外发 / 写入 / 脚本读: 没有「打码」一说
  const operands = operandsOf(verb, redirectFree(words));
  const creds = operands.filter((w) => CRED_TOKEN.test(w));
  if (!creds.length) return false; // 只在模式 / 选项里提到它: 不是在读这个文件
  if (verb === "sed" && IN_PLACE.test(seg)) return true;
  if (GREP_VERB.test(verb) && COUNT_ONLY.test(seg)) return false;
  if (verb === "cmp" && !/(?:^|\s)(?:-[a-zA-Z]*[lbi]|--verbose|--print-bytes)/.test(seg)) return false; // 只报第一处不同的位置
  if (verb === "diff" && /(?:^|\s)(?:-[a-zA-Z]*q|--brief)\b/.test(seg)) return false; // 只报「不同」二字
  if (verb === "cut" && KEYS_ONLY_CUT.test(seg)) return false;
  if ((verb === "awk" || verb === "gawk") && KEYS_ONLY_AWK.test(seg)) return false;
  if (maskedPipe(rest)) return false;
  const cap = captured(text, at);
  if (cap && !varLeaks(text, qmap, cap.name, cap.end)) return false;
  return !(creds.every((c) => credAllowed(c, "read-masked", ctx)) && maskedPipe(rest, true));
};

export const credentialAccess = (text: string, ctx?: CredCtx): boolean => {
  const found = [
    ...[...text.matchAll(CRED_VERB)].map((m) => ({ verb: m[1] ?? "", at: m.indices?.[1]?.[0] ?? m.index ?? 0 })),
    ...[CRED_REMOTE.exec(text)].flatMap((m) => (m ? [{ verb: m[1] ?? "", at: m.indices?.[1]?.[0] ?? m.index }] : [])),
  ];
  const qmap = quoteMap(text);
  return found.some((f) => verbLeaks(text, qmap, f.verb, f.at, ctx))
    || CRED_INTERP.test(text) || CRED_WRITE.test(text) || CRED_FIND.test(text) || CRED_XARGS.test(text);
};

// 命令文本上的路径类规则 (已 scrub): SSH 与凭据按上面的口径, 其余沿用路径正则。
const cmdPathRules = (cred: CredCtx): readonly Rule[] => [
  ["SSH 密钥", SSH_KEY],
  ["凭据文件", (t) => credentialAccess(t, cred)],
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
export const dangerOf = (cfg: Config, toolName: string, toolInput: unknown, ctx?: { cwd?: string }): DangerHit | undefined => {
  const d = cfg.approval.danger;
  // credentialAllow 每次现读 (config_set 热生效); 相对路径按这次调用的会话 cwd 解析。
  const credRules = cmdPathRules({ cwd: ctx?.cwd || undefined, allow: d.credentialAllow ?? [] });
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
    (d.builtin ? firstHit(credRules, c) : undefined) ??
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
