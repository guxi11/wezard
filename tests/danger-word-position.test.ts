// 单元测试: 命令词位置约束 (CMD_HEAD / REMOTE_CTX) — 运行: npx tsx tests/danger-word-position.test.ts
//
// 为什么钉这一组: 危险名单是对**整条命令文本**做正则 test 的, 而 rm / shutdown /
// truncate / sudo 这些词又短又常见。原规则只有 `\b` 界定, 于是分支名、文件名、
// 参数值里出现这些词就让所有沾边命令被判危险 —— 真实案例是分支
// `feature/graceful-shutdown`, 连 `git checkout` 都要单独审批,
// 流程被审批卡堵死 (卡片会无限期挂住, 用户不在时就是死等)。
//
// 收紧的代价是可能漏报, 所以两侧都要钉住: 下面每条「误报侧」都是收紧前会发卡的
// 真实命令, 每条「漏报侧」都是收紧后仍必须发卡的真实危险命令。
import assert from "node:assert";
import { dangerOf } from "../daemon/danger.js";
import type { Config } from "../shared/config.js";

let passed = 0;
let failed = 0;
const t = (name: string, fn: () => void): void => {
  try {
    fn();
    passed++;
    console.log(`ok    ${name}`);
  } catch (e) {
    failed++;
    console.log(`FAIL  ${name}\n      ${(e as Error).message}`);
  }
};

// 只造 dangerOf 真正读到的那几个字段。
const CFG = {
  approval: {
    danger: {
      enabled: true,
      builtin: true,
      allowPatterns: [],
      commandPatterns: [],
      toolPatterns: [],
      pathPatterns: [],
    },
  },
} as unknown as Config;

const ruleOf = (command: string): string | undefined => dangerOf(CFG, "Bash", { command })?.rule;

// 直连 (非 REPL 包裹) 的工具入参形态。
const safe2 = (tool: string, input: Record<string, unknown>): void =>
  assert.equal(dangerOf(CFG, tool, input)?.rule, undefined, `不该命中, 实际命中「${dangerOf(CFG, tool, input)?.rule}」`);
const danger2 = (tool: string, input: Record<string, unknown>): void =>
  assert.ok(dangerOf(CFG, tool, input)?.rule, `应命中危险名单, 实际放行`);
// REPL (PTC) 包裹形态: 命令在 code 脚本里。
const viaRepl = (code: string): string | undefined => dangerOf(CFG, "REPL", { code, description: "split chunks" })?.rule;

const safe = (command: string): void =>
  assert.equal(ruleOf(command), undefined, `不该命中, 实际命中「${ruleOf(command)}」`);

/** 只断言「命中了」而非命中哪一条 —— 谁先匹配上是规则顺序的实现细节, 都发卡。 */
const danger = (command: string): void =>
  assert.ok(ruleOf(command), `应命中危险名单, 实际放行`);

const BR = "feature/graceful-shutdown";

// ── 误报侧: 分支名 / 文件名 / 参数值里的词不算命令 ────────────────────
t("git checkout 带 shutdown 的分支名", () => safe(`git checkout ${BR}`));
t("git push 带 shutdown 的分支名", () => safe(`git push origin ${BR}`));
t("分支名带引号", () => safe(`git checkout "${BR}"`));
t("git 复合命令带分支名", () => safe(`git fetch origin && git log --oneline origin/${BR} -5`));
t("测试文件名", () => safe("npm run test -- graceful-shutdown.spec.ts"));
t("grep 关键词", () => safe("rg -n 'graceful shutdown' src/"));
t("变量名/标识符", () => safe("node -e 'console.log(gracefulShutdownTimeout)'"));
t("分支名带 rm", () => safe("git checkout feat/rm-dead-code"));
t("docker run --rm", () => safe("docker run --rm -it node:20 npm ci"));
t("rm 出现在检索词里", () => safe("rg -n rm-cache scripts/"));
t("分支名带 truncate", () => safe("git checkout fix/truncate-log"));
t("分支名带 sudo", () => safe("rg -n sudo docs/deploy.md"));
t("分支名带 flushdb", () => safe("git checkout feat/flushdb-guard"));
t("分支名带 pkill", () => safe("git checkout feat/pkill-worker"));

// ── 漏报侧: 真正的危险命令一条都不能放过 ──────────────────────────────
t("sudo rm (提权本身仍 danger)", () => danger("sudo rm -rf /var/log/app"));
t("find -delete (find 扫树删, 非 rm 类)", () => danger("find . -name '*.log' -delete"));
t("find -exec rm", () => danger("find . -name '*.log' -exec rm {} \\;"));
t("xargs rm (随 rm 类一起移出) → 不判", () => safe("git ls-files | xargs -I{} rm {}"));
t("管道后 rm 无目标 → 不判", () => safe("ls | rm"));
t("truncate 清空文件", () => danger("truncate -s 0 app.log"));
t("裸 shutdown", () => danger("shutdown -h now"));
t("分号后 reboot", () => danger("make build; reboot"));
t("&& 后 reboot", () => danger("make build && reboot"));
t("换行后 poweroff", () => danger("echo bye\npoweroff"));
t("子 shell 里 halt", () => danger("(halt)"));
t("pkill", () => danger("pkill -f node"));
t("kill -9", () => danger("kill -9 12345"));
t("redis flushall", () => danger("redis-cli -h h flushall"));
t("su -", () => danger("su - root"));
// 包装器形态 (#19 合并后的漏报): 包装器之后仍是命令词位置。
t("反斜杠转义 reboot", () => danger("\\reboot"));
t("command 包装 shutdown", () => danger("command shutdown -h now"));
t("timeout 包装 reboot", () => danger("timeout 5 reboot"));
t("nice 包装 reboot", () => danger("nice reboot"));
t("env 赋值后 reboot", () => danger("env FOO=1 reboot"));
t("watch reboot", () => danger("watch reboot"));

// ── 远程执行: 位置约束失效, 靠 ssh/exec 上下文兜住 ────────────────────
t("ssh 裸 reboot", () => danger("ssh host reboot"));
t("ssh 带参数 + 引号", () => danger('ssh -p 22 host "shutdown -r now"'));
t("ssh 远程 rm (rm 类已移出 → 不判)", () => safe("ssh host rm -rf /data"));
t("kubectl exec -- halt", () => danger("kubectl exec pod -- halt"));
t("docker exec halt", () => danger("docker exec -it c1 halt"));
// 反面: 远程规则不该被「有 ssh 字样 + 文件名带危险词」钓出来。
t("scp 传带 shutdown 的文件名", () => safe("scp graceful-shutdown.md host:/tmp/"));

// ── git 丢弃改动整体移出名单 (2026-11-03 人口径「不要再判 danger」) ──────
// 整树 (reset --hard / clean / 匿名整树 pathspec 的 checkout -- / restore) 与
// 路径级 (具名路径) 同一口径: 都不再立 danger, 走普通审批卡; 按 pathspec 形状
// 分档的 GIT_WILDTREE 随判据一起删除。
t("git reset --hard (整树) → 不判", () => safe("git reset --hard"));
t("git reset --hard HEAD~3 → 不判", () => safe("git reset --hard HEAD~3"));
t("git clean -fd → 不判", () => safe("git clean -fd"));
t("git checkout -- . / \".\" / HEAD -- . → 不判", () => {
  safe("git checkout -- .");
  safe('git checkout -- "."');
  safe("git checkout HEAD -- .");
});
t("git restore . / .. / :/ / * → 不判", () => {
  safe("git restore .");
  safe("git restore ..");
  safe("git restore :/");
  safe("git restore *");
});
t("git restore -s HEAD~1 . / --source=HEAD~1 . → 不判", () => {
  safe("git restore -s HEAD~1 .");
  safe("git restore --source=HEAD~1 .");
});
t("git checkout -- . && make / restore x && clean -fd → 不判", () => {
  safe("git checkout -- . && make");
  safe("git restore x && git clean -fd");
});
t("git restore <路径> / --staged / checkout -- .env → 不判", () => {
  safe("git restore src/index.ts");
  safe("git checkout -- src/index.ts");
  safe("git restore --staged x.ts");
  safe("git checkout -- .env");
});
t("git checkout 换分支 → 不算丢弃", () => safe("git checkout main"));
t("git checkout -b 新分支 → 不算丢弃", () => safe("git checkout -b feat/x"));
t("git push --delete 动共享远端 → 仍 danger", () => danger("git push origin --delete feat/x"));

// ── 危险名单第二批降档 (2026-10-28): 判据 = 丢了能不能从 git 或别处恢复 ──
t("rmdir 只删空目录, mkdir 即恢复 → 降普通档", () => safe("rmdir /tmp/empty"));
t("git rm → 索引/历史里拿得回来 (本就不在名单)", () => safe("git rm src/x.ts"));
t("git mv → 纯改名, 本就不在名单", () => safe("git mv a.ts b.ts"));
t("git stash drop → stash 提交仍在对象库里 (本就不在名单)", () => safe("git stash drop stash@{1}"));
t("git branch -D → 提交仍在 reflog → 降普通档", () => safe("git branch -D feat/x"));
t("git push --delete → 动共享远端, 别人未必有副本 → 仍 danger", () => danger("git push origin --delete feat/x"));
t("docker rm / rmi → 容器镜像是牲口, 重建即恢复 → 降普通档", () => {
  safe("docker rm c1");
  safe("docker rmi img:latest");
});
t("docker compose down (无 -v) → compose up 即恢复 → 降普通档", () => safe("docker compose down"));
t("docker volume rm → 数据卷不在 git 也不在别处 → 仍 danger", () => danger("docker volume rm db-data"));
t("docker volume prune → 整批卷, 比单删更狠 → 补进 danger (原漏)", () => danger("docker volume prune"));
t("docker system prune → 停止容器的可写层/卷一并清 → 仍 danger", () => danger("docker system prune -af"));
t("docker compose down -v / --volumes → 连数据卷一起删 → 仍 danger", () => {
  danger("docker compose down -v");
  danger("docker compose down --volumes");
});
t("chmod/chown -R → 只动权限位, 改回去即复原 → 降普通档", () => {
  safe("chmod -R 755 ~/develop");
  safe("chmod -R u+w dist/");
  safe("chown -R $USER:$USER ~/develop");
  safe("chmod +x dist/cli/init.js"); // npm run build 自己就在干这个
});
t("chmod 777 → 全局可写, 保留 danger (与原「递归改权限」拆开)", () => {
  danger("chmod 777 deploy.sh");
  danger("chmod -R 777 /var/www"); // 同一分支里的 777, 不因 -R 移出而漏
});
t("history -c → 只丢 shell 历史 → 降普通档", () => safe("history -c"));
t("defaults delete → 删 macOS 系统偏好, 不在 git 里 → 仍 danger", () => danger("defaults delete com.apple.dock"));

// ── rm 整体移出名单 (2026-11-03 人口径「不要再判 danger」) ──────────────
// 临时区 / 非临时区 / 解析不出 的三档分类随判据一并删除 (tokenize / normPath /
// 临时区清单 / rmOutsideTargets): rm 在任何目标上都不再立 danger, 走普通审批卡。
t("rm 非临时区不再判 (原「删除文件 rm」)", () => {
  safe("rm -rf /var/log/app");
  safe("rm -rf ~/develop");
  safe("rm -rf /Users/zyy/develop");
  safe("rm -rf /tmp");          // 共享区根本身: 原口径里也判, 现在不判
  safe("rm -rf /tmp/x ~/develop/y");
});
t("rm 任何形态都不再判 (临时区/相对/变量/glob/引号未闭合/词法逃逸)", () => {
  safe("rm -f /tmp/foo");
  safe("rm -rf /private/tmp/x");
  safe("rm -rf $TMPDIR/x");
  safe("rm -rf build");
  safe("rm -rf *");
  safe("rm -rf $x");
  safe('rm -rf "unclosed ~/x');
  safe("rm -rf /tmp/../etc/passwd");
  safe("rm -rf /Users/zyy/tmp-modeck-test && echo cleaned");
});
t("rm 的包装器形态也不判 (只有提权仍单独算)", () => {
  safe("timeout 5 rm -rf ~/x");
  safe("env FOO=1 rm -rf ~/x");
  safe("\\rm -rf ~/x");
  danger("sudo rm -rf ~/x"); // 命中「提权 sudo」, 与 rm 无关
});

// ── 工具语义分界 (2026-10-28 人第三条口径): 只有真会交给 shell 执行的才做 ──
// 命令级判定。Edit/Write 的内容、Read 的路径是数据, 不是命令; 误报原先全部来自
// REPL 的「整段脚本兜底」—— 现在只认命令键 (command/cmd/script/shell) 的值。
t("直连 Edit 写含 rm -rf 的文本 → 数据, 不判 danger", () =>
  safe2("Edit", { file_path: "deploy.sh", new_string: "rm -rf build" }));
t("直连 Read 文件名带 rm → 不判 danger", () =>
  safe2("Read", { file_path: "/notes/rm-me.md" }));
t("直连 Bash rm -rf 相对目标 (解析不出 → 不判, 走普通卡)", () =>
  safe2("Bash", { command: "rm -rf build" }));
t("直连 Bash rm -rf 非临时区也不再判", () =>
  safe2("Bash", { command: "rm -rf ~/develop/build" }));
t("REPL 包 Edit 写含 rm -rf 的内容 → 不判 (原先整段兜底误报)", () =>
  assert.equal(viaRepl('await Edit({ file_path: "deploy.sh", new_string: "rm -rf build" })'), undefined));
t("REPL 包 Read 文件名带 rm → 不判", () =>
  assert.equal(viaRepl('const r = await Read({ file_path: "rm-me.md" }); return r;'), undefined));
t("REPL 包 Write 脚本内容含 rm → 内容是数据, 不判 (执行另有 Bash 判)", () =>
  assert.equal(viaRepl('await Write({ file_path: "x.sh", content: "rm -rf /tmp/build" })'), undefined));
t("REPL 包 Grep/Agent 的检索词与提示语含 rm → 不判", () => {
  assert.equal(viaRepl('await Grep({ pattern: "rm -rf", path: "daemon" })'), undefined);
  assert.equal(viaRepl('await Agent({ prompt: "fix the rm -rf bug in danger.ts" })'), undefined);
});
t("REPL 陌生键的值不立 danger (认不准不判, 需要审走普通卡)", () =>
  assert.equal(viaRepl('await mcp_x.run({ blob: "rm -rf x" })'), undefined));
t("REPL 命令键 script 的值 (mcp run_script) 仍判", () =>
  assert.ok(viaRepl('await mcp_x.run_script({ script: "git push --force origin main" })')));
t("REPL 混合: 内层 Bash grep + Edit 写 rm 内容 → 不判", () =>
  assert.equal(viaRepl('await Bash({ command: "grep x y" }); await Edit({ new_string: "rm -rf build" })'), undefined));
t("REPL 字面量内部再像键值对也不拆 (整体消费)", () =>
  assert.equal(viaRepl('await Edit({ new_string: "cmd: rm -rf x" })'), undefined));
t("REPL 注释里的 rm 不判 (注释层分离)", () => {
  assert.equal(viaRepl("// don't run rm -rf here, use the cleanup script"), undefined);
  assert.equal(viaRepl("/* 历史: 曾用 rm -rf 清目录 */\nreturn 1;"), undefined);
});
t("REPL 注释里的引号不吞后面的代码; 裸赋值的命令认不准 → 不判", () =>
  assert.equal(viaRepl("// don't do this\nconst cmd = 'rm -rf x';\nawait Bash({ command: cmd });"), undefined));
t("REPL 正则字面量里的引号不吞后面的代码; 裸赋值认不准 → 不判", () =>
  assert.equal(viaRepl("const q = /['\"]/.source;\nconst cmd = 'rm -rf x';\nawait Bash({ command: cmd });"), undefined));
t("REPL 动态拼接的碎片不立 danger (认不准)", () =>
  assert.equal(viaRepl('const cmd = "rm -" + "rf /x"; await Bash({ command: cmd });'), undefined));
t("REPL eval 字符串不立 danger (认不准)", () =>
  assert.equal(viaRepl('eval("rm -rf x")'), undefined));

// ── REPL / PTC 包裹: 命令在脚本里 ─────────────────────────────────────
// CodeBuddy 把每次工具调用包进 REPL 的 code 参数。只看顶层 key 会整条漏掉 ——
// 2026-10-27 真机: 卡上写着「无法完整识别」, 而脚本里是 `rm -rf b64chunks`。
t("REPL 反引号里的 rm (两类目标都不再判)", () => {
  assert.equal(viaRepl("const w = await Bash({ command: `cd /tmp && rm -rf b64chunks` });"), undefined);
  assert.equal(viaRepl("const w = await Bash({ command: `rm -rf ~/develop/x` });"), undefined);
});
t("REPL 双引号里的强推", () => assert.ok(viaRepl('await Bash({ command: "git push --force origin main" })')));
t("REPL 单引号里的 shutdown", () => assert.ok(viaRepl("await Bash({ command: 'shutdown -h now' })")));
t("REPL 变量拼的命令 (无字面量, 认不准 → 不判, 走普通卡)", () => assert.equal(viaRepl("const cmd = 'rm -rf x';\nawait Bash({ command: cmd });"), undefined));
t("REPL 里只是读", () => assert.equal(viaRepl("const r = await Bash({ command: `git status` });"), undefined));
t("REPL 正文提到危险词但没调用", () => assert.equal(viaRepl("// 别在这里 rm -rf, 用清理脚本"), undefined));
t("REPL 里的整树 / 路径级 restore 都不判", () => {
  assert.equal(viaRepl("await Bash({ command: 'git restore .' })"), undefined);
  assert.equal(viaRepl("await Bash({ command: 'git restore src/x.ts' })"), undefined);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
