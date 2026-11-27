// 单元测试: danger 的「workspace 内放行」(approval.danger.workspaceAllow, admin 2026-11-27 605) — 运行: npx tsx tests/danger-workspace.test.ts
//
// 只有「批量删除 find」与「清空 truncate」两条规则能被摘掉 (rm / git 丢弃本来就不在名单里, 见 danger.ts 注释)。
// 两侧钉住: 目标能静态确定地落在 cwd 内 → 放行; 相对 / ~ / $HOME / .. / 软链 / glob / 变量 / 命令替换 / 根 / .git / 外部绝对路径 → 照旧发卡。
import assert from "node:assert";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dangerOf } from "../daemon/danger.js";
import type { Config } from "../shared/config.js";

let passed = 0;
let failed = 0;
const t = (name: string, fn: () => void): void => {
  try { fn(); passed++; console.log(`ok    ${name}`); }
  catch (e) { failed++; console.log(`FAIL  ${name}\n      ${(e as Error).message}`); }
};

const base = realpathSync(mkdtempSync(join(tmpdir(), "wz-ws-")));
const WS = join(base, "proj");
const OUT = join(base, "outside");
mkdirSync(join(WS, "sub/deep"), { recursive: true });
mkdirSync(join(WS, ".git"), { recursive: true });
mkdirSync(OUT, { recursive: true });
writeFileSync(join(WS, "a.log"), "x");
writeFileSync(join(OUT, "o.log"), "x");
symlinkSync(OUT, join(WS, "link-out"));          // workspace 内指向外部
symlinkSync(join(WS, "sub"), join(WS, "link-in")); // workspace 内指向内部
symlinkSync(join(OUT, "o.log"), join(WS, "o-link.log"));
const WSLINK = join(base, "ws-alias");           // workspace 自己经软链进入
symlinkSync(WS, WSLINK);

const mk = (workspaceAllow?: boolean): Config =>
  ({ approval: { danger: { enabled: true, builtin: true, allowPatterns: [], commandPatterns: [], toolPatterns: [], pathPatterns: [], ...(workspaceAllow === undefined ? {} : { workspaceAllow }) } } }) as unknown as Config;
const CFG = mk();
const ruleOf = (command: string, cwd: string | null = WS, cfg: Config = CFG): string | undefined =>
  dangerOf(cfg, "Bash", { command }, cwd === null ? undefined : { cwd })?.rule;
const safe = (command: string, cwd?: string | null): void => assert.equal(ruleOf(command, cwd), undefined, `不该发卡, 实际命中「${ruleOf(command, cwd)}」\n      ${command}`);
const danger = (command: string, cwd?: string | null): void => assert.ok(ruleOf(command, cwd), `应发卡, 实际放行\n      ${command}`);
const FIND = "批量删除 find -delete";
const TRUNC = "清空文件 truncate";

// ═══ 放行: 目标都静态落在 workspace 内 ═══════════════════════════════════
t("find 相对子目录 -name -delete", () => safe("find sub -name '*.log' -delete"));
t("find . 带筛选 (最常见: 清 .pyc)", () => safe("find . -name '*.pyc' -delete"));
t("find 缺省搜索根 (= cwd) 带筛选", () => safe("find -name '*.tmp' -delete"));
t("find 绝对路径在 workspace 内", () => safe(`find ${WS}/sub -type f -mtime +7 -delete`));
t("find -exec rm {} \; / +", () => {
  safe("find sub -name '*.o' -exec rm {} \\;");
  safe("find sub -name '*.o' -exec rm -f {} +");
});
t("find 经 workspace 内的软链进到 workspace 内", () => safe("find link-in -name '*.log' -delete"));
t("find 多个根都在内 / 后接 2>/dev/null", () => safe("find sub sub/deep -name '*.log' -delete 2>/dev/null"));
t("truncate 相对 / 绝对 / 多个目标", () => {
  safe("truncate -s 0 a.log");
  safe("truncate -s0 sub/x.log");
  safe(`truncate --size=0 ${WS}/a.log sub/deep/b.log`);
  safe("truncate -c -s 0 ./sub/../a.log");        // .. 归一后仍在内
  safe("truncate -s 0 a.log > /dev/null");        // 重定向到 /dev/null 不是操作数
});
t("truncate -r 参照文件只读, 不是目标 (参照在外也行)", () => safe(`truncate -r ${OUT}/o.log a.log`));
t("cwd 在子目录: 相对路径按该 cwd 解", () => safe("truncate -s 0 x.log", join(WS, "sub")));
t("workspace 自己经软链进入 (cwd = 别名)", () => safe("truncate -s 0 a.log", WSLINK));
t("不存在的新文件 (目录链在内)", () => safe("truncate -s 0 sub/new.log"));
t("多条命令各自都在内", () => safe("truncate -s 0 a.log && find sub -name '*.o' -delete"));

// ═══ 照拦: 逃逸 / 解不出 ═════════════════════════════════════════════════
t("workspace 外的绝对路径", () => {
  assert.equal(ruleOf(`find ${OUT} -name '*.log' -delete`), FIND);
  assert.equal(ruleOf(`truncate -s 0 ${OUT}/o.log`), TRUNC);
  assert.equal(ruleOf("truncate -s 0 /var/log/syslog"), TRUNC);
});
t(".. 逃逸", () => {
  assert.equal(ruleOf("truncate -s 0 ../outside/o.log"), TRUNC);
  assert.equal(ruleOf("truncate -s 0 sub/../../outside/o.log"), TRUNC);
  assert.equal(ruleOf("find .. -name '*.log' -delete"), FIND);
  assert.equal(ruleOf("find sub/../.. -name '*.log' -delete"), FIND);
});
t("前缀相似的兄弟目录不算在内 (proj-evil)", () => {
  mkdirSync(`${WS}-evil`, { recursive: true });
  assert.equal(ruleOf(`truncate -s 0 ${WS}-evil/x`), TRUNC);
});
t("~ / $HOME 指向 workspace 外", () => {
  assert.equal(ruleOf("truncate -s 0 ~/x.log"), TRUNC);
  assert.equal(ruleOf("truncate -s 0 $HOME/x.log"), TRUNC);
  assert.equal(ruleOf("find ~ -name '*.log' -delete"), FIND);
  assert.equal(ruleOf("find $HOME/.cache -name '*.log' -delete"), FIND);
});
t("~ 指向 workspace 内 (HOME = workspace) 时可解析", () => {
  const old = process.env.HOME;
  process.env.HOME = WS;
  try { safe("truncate -s 0 ~/a.log"); } finally { process.env.HOME = old; }
});
t("符号链接出 workspace: 中间目录 / 终点文件 / find 根", () => {
  assert.equal(ruleOf("truncate -s 0 link-out/o.log"), TRUNC);
  assert.equal(ruleOf("truncate -s 0 o-link.log"), TRUNC);
  assert.equal(ruleOf("find link-out -name '*.log' -delete"), FIND);
});
t("find -L / -follow 会跟着软链走出去", () => {
  assert.equal(ruleOf("find -L sub -name '*.log' -delete"), FIND);
  assert.equal(ruleOf("find sub -follow -name '*.log' -delete"), FIND);
});
t("glob / 变量 / 命令替换 / 花括号展开解不出", () => {
  assert.equal(ruleOf("truncate -s 0 *.log"), TRUNC);
  assert.equal(ruleOf("truncate -s 0 sub/?.log"), TRUNC);
  assert.equal(ruleOf("truncate -s 0 $LOGFILE"), TRUNC);
  assert.equal(ruleOf("truncate -s 0 ${DIR}/a.log"), TRUNC);
  assert.equal(ruleOf("truncate -s 0 $(pwd)/a.log"), TRUNC);
  assert.equal(ruleOf("truncate -s 0 `pwd`/a.log"), TRUNC);
  assert.equal(ruleOf("truncate -s 0 {a,b}.log"), TRUNC);
  assert.equal(ruleOf("find $TARGET -name '*.log' -delete"), FIND);
  assert.equal(ruleOf("find $(git rev-parse --show-toplevel) -name '*.log' -delete"), FIND);
  assert.equal(ruleOf("find sub/* -name '*.log' -delete"), FIND);
});
t("workspace 根本身 (truncate .) 与 .git 内目标", () => {
  assert.equal(ruleOf("truncate -s 0 ."), TRUNC);
  assert.equal(ruleOf(`truncate -s 0 ${WS}`), TRUNC);
  assert.equal(ruleOf("truncate -s 0 .git/index"), TRUNC);
  assert.equal(ruleOf("truncate -s 0 sub/../.git/HEAD"), TRUNC);
  assert.equal(ruleOf("find .git -name '*.lock' -delete"), FIND);
  assert.equal(ruleOf(`truncate -s 0 ${WS}/.git/config`), TRUNC);
});
t("find 无筛选 / 筛选恒真: 等于清空整个 workspace", () => {
  assert.equal(ruleOf("find . -delete"), FIND);
  assert.equal(ruleOf("find . -type f -delete"), FIND);
  assert.equal(ruleOf("find . -name '*' -delete"), FIND);
  assert.equal(ruleOf("find -delete"), FIND);
  assert.equal(ruleOf("find . -exec rm -rf {} +"), FIND);
});
t("find 的 -exec 不是纯 rm / 写任意路径 / 交互式", () => {
  assert.equal(ruleOf("find sub -name '*.o' -delete -exec sh -c 'echo {}' \\;"), FIND);
  assert.equal(ruleOf("find sub -name '*.o' -exec rm {} ;"), FIND);           // `;` 没转义: 不是 find 的结束符
  assert.equal(ruleOf("find sub -name '*.o' -delete -fprint /etc/x"), FIND);
  assert.equal(ruleOf("find sub -name '*.o' -exec rm {} /etc/passwd \\;"), FIND);
});
t("cd 之后相对路径的基准变了 (只认绝对路径)", () => {
  assert.equal(ruleOf("cd /tmp && truncate -s 0 a.log"), TRUNC);
  assert.equal(ruleOf("cd .. && find . -name '*.log' -delete"), FIND);
  assert.equal(ruleOf("pushd /var/log; truncate -s 0 syslog"), TRUNC);
  safe(`cd /tmp && truncate -s 0 ${WS}/a.log`); // 绝对路径不受 cd 影响
});
t("子 shell / 命令组 / 经别的命令转手", () => {
  assert.equal(ruleOf("(truncate -s 0 a.log)"), TRUNC);
  assert.equal(ruleOf("sh -c 'truncate -s 0 a.log'"), TRUNC);
  assert.equal(ruleOf("bash -c \"find sub -name '*.o' -delete\""), FIND);
  assert.equal(ruleOf("ssh host truncate -s 0 a.log"), "远程清空文件 truncate");
  assert.equal(ruleOf("xargs truncate -s 0 < list.txt"), TRUNC);
  assert.equal(ruleOf("nice truncate -s 0 a.log"), TRUNC);
});
t("多条命令里有一条出了 workspace 就整条拦", () => {
  assert.equal(ruleOf(`truncate -s 0 a.log && truncate -s 0 ${OUT}/o.log`), TRUNC);
  assert.equal(ruleOf(`find sub -name '*.o' -delete; find ${OUT} -name '*.o' -delete`), FIND);
});
t("无 cwd (CodeBuddy 原生框代按 / 老调用) 一律照旧", () => {
  assert.equal(ruleOf("truncate -s 0 a.log", null), TRUNC);
  assert.equal(ruleOf(`truncate -s 0 ${WS}/a.log`, null), TRUNC);
});
t("相对的 cwd 不接受", () => assert.equal(ruleOf("truncate -s 0 a.log", "proj"), TRUNC));

// ═══ 只摘这两条: 同一条命令里别的危险照拦 ═══════════════════════════════
t("workspace 内的 truncate + sudo / kill -9 / 凭据文件 / DROP", () => {
  assert.equal(ruleOf("truncate -s 0 a.log && sudo systemctl restart app"), "提权 sudo");
  assert.equal(ruleOf("truncate -s 0 a.log; kill -9 1"), "强制杀进程");
  assert.equal(ruleOf("truncate -s 0 a.log && cat .env"), "凭据文件");
  assert.equal(ruleOf("truncate -s 0 a.log && psql -c 'DROP DATABASE x'"), "数据库 DROP/TRUNCATE");
  assert.equal(ruleOf("find sub -name '*.log' -delete && git push --force origin main"), "git 强推");
});
t("workspace 内 truncate 与外部 dd / 设备重定向同条: 仍拦", () => {
  assert.equal(ruleOf("truncate -s 0 a.log && dd if=/dev/zero of=/dev/sda"), "裸设备写入 dd");
  assert.equal(ruleOf("truncate -s 0 a.log > /dev/sda"), "重定向到设备");
});

// ═══ 开关 / 与别的规则的关系 ═════════════════════════════════════════════
t("workspaceAllow:false 回到只按命令文本判", () => {
  assert.equal(ruleOf("truncate -s 0 a.log", WS, mk(false)), TRUNC);
  assert.equal(ruleOf("find sub -name '*.log' -delete", WS, mk(false)), FIND);
  assert.equal(ruleOf("truncate -s 0 a.log", WS, mk(true)), undefined);
});
t("缺省 (配置里没写) = 开", () => assert.equal(ruleOf("truncate -s 0 a.log", WS, mk()), undefined));
t("builtin:false 时本来就不判, 不受影响", () => {
  const cfg = { approval: { danger: { ...(CFG.approval.danger as object), builtin: false } } } as unknown as Config;
  assert.equal(ruleOf("truncate -s 0 /etc/x", WS, cfg), undefined);
});
t("rm / git 丢弃改动 本来就不是 danger (回归: 不因本次改动变成 danger)", () => {
  safe("rm -rf sub");
  safe("rm -rf .");
  safe("git reset --hard");
  safe("git clean -fdx");
  safe(`rm -rf ${OUT}`);
});
t("自配 commandPatterns 读原文, 不被 workspace 放行摘掉", () => {
  const cfg = { approval: { danger: { ...(CFG.approval.danger as object), commandPatterns: ["truncate"] } } } as unknown as Config;
  assert.equal(ruleOf("truncate -s 0 a.log", WS, cfg), "自定义:truncate");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
