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
t("行首 rm -rf", () => danger("rm -rf node_modules"));
t("&& 后 rm", () => danger("cd /tmp && rm -rf build"));
t("分号后 rm", () => danger("cd /tmp; rm -rf build"));
t("sudo rm", () => danger("sudo rm -rf /var/log/app"));
t("管道后 rm", () => danger("ls | rm"));
t("find -exec rm", () => danger("find . -name '*.log' -exec rm {} \\;"));
t("xargs -I 传参 rm", () => danger("git ls-files | xargs -I{} rm {}"));
t("for 循环体里 rm", () => danger("for f in *.tmp; do rm $f; done"));
t("$() 里 rm", () => danger("echo $(rm -rf x)"));
t("rmdir", () => danger("rmdir /tmp/empty"));
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

// ── 远程执行: 位置约束失效, 靠 ssh/exec 上下文兜住 ────────────────────
t("ssh 裸 reboot", () => danger("ssh host reboot"));
t("ssh 带参数 + 引号", () => danger('ssh -p 22 host "shutdown -r now"'));
t("ssh 远程 rm", () => danger("ssh host rm -rf /data/tmp"));
t("kubectl exec -- halt", () => danger("kubectl exec pod -- halt"));
t("docker exec halt", () => danger("docker exec -it c1 halt"));
// 反面: 远程规则不该被「有 ssh 字样 + 文件名带危险词」钓出来。
t("scp 传带 shutdown 的文件名", () => safe("scp graceful-shutdown.md host:/tmp/"));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
