// 共享记忆的整理者 —— 群 / 工作区记忆唯一的写入者 (人除外)。
//
// 它不是一个常驻 wizard, 而是一条定时任务: gate 在 daemon 侧看收件箱有没有提议,
// 有才新起一个白板 wizard 去合并, 合并完即收。整理不放进管家 (default wizard) 的
// 上下文 —— 管家的上下文只留给名册和分派; 这是 Letta 的 sleep-time agent 与主
// agent 分开的同一个理由: 在线的那个不该被后台活拖慢。
//
// 任务文件只在缺失时写一次: 它是源码, 人和 wizard 会直接改 (换频率、改合并规则),
// daemon 不能每次开机都覆盖回去。
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { expandHome } from "../shared/paths.js";
import { TASKS_DIR, fileOfTaskId } from "../shared/task-file.js";

export const STEWARD_TASK_ID = "memory-steward";

// 认领 = 改名 (`x.jsonl` → `x.claimed-<ms>.jsonl`): 认领之后新来的提议落进一个新的
// `x.jsonl`, 等下一轮, 不会和正在合并的那批搅在一起。整理者中途死掉留下的认领
// 超过一小时再认一次 —— 按文件名里的时刻判, 不按 mtime (改名不动 mtime)。
const source = (root: string): string => `// wezard 定时任务 · ${STEWARD_TASK_ID}
// 共享记忆 (群 / 工作区) 的整理者: wizard_remember({scope:"chat"|"workspace"}) 不直写记忆,
// 只往 ${root}/inbox/ 投提议; 这条任务有提议才新起一个白板 wizard 合并进 md。
// 这份文件就是配置, 直接改, 存盘即生效。删掉它 daemon 下次开机会按默认重建;
// 想停用改 enabled: false。
import { existsSync, readdirSync, renameSync } from "node:fs";
import { join } from "node:path";

const ROOT = ${JSON.stringify(root)};
const INBOX = join(ROOT, "inbox");
const RECLAIM_MS = 60 * 60 * 1000;
const CLAIMED = /\\.claimed-(\\d+)\\.jsonl$/;

const inboxes = () => ["chats", "workspaces"].flatMap((d) => {
  const dir = join(INBOX, d);
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".jsonl")).map((f) => join(dir, f)) : [];
});

export default {
  note: "有新的群/工作区记忆提议就合并进共享记忆",
  fresh: true,
  enabled: true,
  when: ({ every }) => every(30),

  gate: async ({ now, log }) => {
    const t = now.getTime();
    const all = inboxes();
    // 重新认领的孤儿也换上这一刻的时间戳, 否则它下一轮还算孤儿, 会被再派一遍。
    const claim = (f) => {
      const c = f.replace(CLAIMED, ".jsonl").replace(/\\.jsonl$/, ".claimed-" + t + ".jsonl");
      renameSync(f, c);
      return c;
    };
    const fresh = all.filter((f) => !CLAIMED.test(f));
    const orphaned = all.filter((f) => t - Number(f.match(CLAIMED)?.[1] ?? t) > RECLAIM_MS);
    const files = [...fresh, ...orphaned].map(claim);
    log("claimed=" + fresh.length + " orphaned=" + orphaned.length);
    if (!files.length) return false;
    return { vars: { files: files.map((f) => "- " + f).join("\\n") } };
  },

  prompt: [
    "整理 wezard 的共享记忆。下面每个文件是一个收件箱, 一行一条别的 wizard 提交的提议 (json: at 时刻, by 提议者, note 要记住的一句, forget 要删掉的那条里的一个子串):",
    "{{files}}",
    "",
    "每个收件箱对应一份记忆 md: 路径去掉 /inbox/, 再把 .claimed-<数字>.jsonl 换成 .md (例: " + ROOT + "/inbox/chats/x.claimed-1.jsonl → " + ROOT + "/chats/x.md; 不存在就新建)。对每一份:",
    "1. 读 md 全文和收件箱的全部提议。",
    "2. 逐条决定: 新增 / 改写已有的那条 (新的更准, 或推翻了旧的) / 删除 (forget 命中, 或已被推翻、过时) / 不动 (重复, 或只是某次任务的临时状态, 不值得跨会话记住)。",
    "3. 重写 md: 每条一行 \\"- 一句话\\", 相近的合并, 同主题的放一起, 全文控制在 3000 字以内。人手写的内容与格式保留, 除非提议明确推翻它。",
    "4. 写完把收件箱归档进审计日志再删掉: cat <收件箱> >> " + ROOT + "/log/<chats 或 workspaces>/<同名>.jsonl && rm <收件箱> (log 目录不存在就先建)。",
    "",
    "只动上面列出的收件箱和它们对应的 md / log, 别的一概不碰。全部处理完用一行 RESULT: 汇报每份记忆 新增/改写/删除 各几条。",
  ].join("\\n"),
};
`;

/** 缺了就写一份默认的整理任务; 已有就不碰 (那是别人可能改过的源码)。 */
export const ensureStewardTask = (memoryRoot: string, tasksDir: string = TASKS_DIR): string => {
  const dir = expandHome(tasksDir);
  const file = fileOfTaskId(dir, STEWARD_TASK_ID);
  if (existsSync(file)) return file;
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, source(memoryRoot));
  return file;
};
