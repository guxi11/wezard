// 共享记忆的整理者 —— 群 / 工作区记忆唯一的写入者 (人除外)。
//
// 它不是一个常驻 wizard, 也不是一条定时任务: daemon 开机就挂一个内部定时器, 每轮
// 看收件箱有没有提议, 有才起一个白板 wizard 去合并, 合并完即收。整理不放进管家
// (default wizard) 的上下文 —— 管家的上下文只留给名册和分派; 这是 Letta 的 sleep-time
// agent 与主 agent 分开的同一个理由: 在线的那个不该被后台活拖慢。
//
// 不走 tasks.ts 是因为它不是谁排的日程: 任务会出现在 list_tasks / 日程里, 放枪要发
// ⏰ 气泡, 执行体落在某个群里 —— 而整理是 daemon 自己的家务, 不该惊动任何群。所以
// 执行体住在一个不属于任何聊天的内部 key 上 (`INTERNAL_BASE`), 私聊信封、零气泡,
// 结果只留在它的 rolepage 和 `memory/log/` 的审计日志里。
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import type { Logger } from "pino";
import { expandHome } from "../shared/paths.js";
import { envelopeAttrs, renderReminder } from "../shared/reminder.js";
import { INTERNAL_BASE, keyOf } from "../shared/session-label.js";
import { TASKS_DIR, fileOfTaskId } from "../shared/task-file.js";

export const STEWARD_ID = "memory-steward";
/** 执行体的 key: 内部 base, 不进任何群的名册。每轮复用同一个 —— 同时只跑一轮。 */
export const STEWARD_TARGET = keyOf(INTERNAL_BASE, "steward");
export const STEWARD_EVERY_MS = 30 * 60_000;
/** 执行体一轮的上限; 超了照样收掉, 认领留着等孤儿回收。 */
export const STEWARD_RUN_MS = 30 * 60_000;

// 认领 = 改名 (`x.jsonl` → `x.claimed-<ms>.jsonl`): 认领之后新来的提议落进一个新的
// `x.jsonl`, 等下一轮, 不会和正在合并的那批搅在一起。整理者中途死掉留下的认领
// 超过一小时再认一次 —— 按文件名里的时刻判, 不按 mtime (改名不动 mtime)。
const RECLAIM_MS = 60 * 60_000;
const CLAIMED = /\.claimed-(\d+)\.jsonl$/;

// ── 纯函数 ─────────────────────────────────────────────────────────
const claimedAt = (f: string): number => Number(f.match(CLAIMED)?.[1] ?? NaN);

/** 这一轮该认领哪些: 没认领过的, 以及认领超过 `reclaimMs` 还没归档的孤儿。 */
export const planRound = (
  files: readonly string[],
  now: number,
  reclaimMs: number = RECLAIM_MS,
): { fresh: string[]; orphaned: string[] } => ({
  fresh: files.filter((f) => !CLAIMED.test(f)),
  orphaned: files.filter((f) => CLAIMED.test(f) && now - claimedAt(f) > reclaimMs),
});

/** 认领后的文件名。孤儿也换上这一刻的时间戳, 否则它下一轮还算孤儿, 会被再派一遍。 */
export const claimedName = (f: string, t: number): string =>
  f.replace(CLAIMED, ".jsonl").replace(/\.jsonl$/, `.claimed-${t}.jsonl`);

/** 收件箱 → 它要并进的那份 md: 去掉 `/inbox/`, `.claimed-<ms>.jsonl` → `.md`。 */
export const mdOfInbox = (root: string, f: string): string =>
  join(root, relative(join(root, "inbox"), f)).replace(CLAIMED, ".md").replace(/\.jsonl$/, ".md");

/** 收件箱 → 审计日志: `log/<chats|workspaces>/<同名>.jsonl`。 */
export const logOfInbox = (root: string, f: string): string =>
  join(root, "log", relative(join(root, "inbox"), f)).replace(CLAIMED, ".jsonl");

/** 一份 md 的只读参考源 (CLAUDE.md、auto-memory 的 MEMORY.md …): 由 daemon 注入, 它才知道
 *  md 对应哪个 cwd、哪个 backend。返回不存在的路径无妨, 渲染时按行列出、由执行体去读。 */
export type RefsOf = (md: string) => readonly string[];

const pairLines = (root: string, refsOf?: RefsOf) => (f: string): string[] => {
  const md = mdOfInbox(root, f);
  const refs = refsOf?.(md) ?? [];
  return [`- ${f} → ${md}`, ...(refs.length ? [`  只读参考: ${refs.join(" , ")}`] : [])];
};

export const stewardPrompt = (root: string, files: readonly string[], refsOf?: RefsOf): string => [
  "整理 wezard 的共享记忆。下面每一行是一对 收件箱 → 记忆 md; 收件箱一行一条别的 wizard 提交的提议 (json: at 时刻, by 提议者, note 要记住的一句, forget 要删掉的那条里的一个子串):",
  ...files.flatMap(pairLines(root, refsOf)),
  "",
  "md 不存在就新建。对每一对:",
  "1. 读 md 全文和收件箱的全部提议; 带「只读参考」的, 把参考文件也读了 (不存在就跳过) —— 那是已经生效的规矩, 你不改它。",
  "2. 逐条决定: 新增 / 改写已有的那条 (新的更准, 或推翻了旧的) / 删除 (forget 命中, 或已被推翻、过时) / 不动 (重复, 或只是某次任务的临时状态, 不值得跨会话记住, 或参考文件里已经写了)。跟参考文件矛盾的提议不收进 md (参考文件是人写的, 优先), 记作冲突。",
  "3. 重写 md: 每条一行 \"- 一句话\", 相近的合并, 同主题的放一起, 全文控制在 3000 字以内。人手写的内容与格式保留, 除非提议明确推翻它。",
  "",
  "只动上面列出的 md, 收件箱和参考文件只读不改 (归档由守护进程在你收工后做), 别的一概不碰。全部处理完用一行 RESULT: 汇报每份记忆 新增/改写/删除 各几条; 有冲突的, 在 RESULT 之前每条一行 `冲突: <md> · <提议原文> ↔ <参考文件>`。",
].join("\n");

/** 私聊信封: 这一轮不属于任何群, 回复哪儿也不发。 */
export const stewardEnvelope = (): string =>
  renderReminder({ ...envelopeAttrs.task(STEWARD_ID), scope: "private" }, [
    "这一轮是守护进程内建的共享记忆整理放进来的, 不属于任何群、没有人在等 —— 照常执行, 回复只留在 rolepage, 不要 notify / tell_peer 任何人。",
  ]);

// ── 边界 IO ────────────────────────────────────────────────────────
const inboxes = (root: string): string[] =>
  ["chats", "workspaces"].flatMap((d) => {
    const dir = join(root, "inbox", d);
    return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".jsonl")).map((f) => join(dir, f)) : [];
  });

const claim = (t: number) => (f: string): string => {
  const c = claimedName(f, t);
  renameSync(f, c);
  return c;
};

const contentOf = (f: string): string => (existsSync(f) ? readFileSync(f, "utf8") : "");

const archive = (root: string) => (f: string): void => {
  if (!existsSync(f)) return;
  const dest = logOfInbox(root, f);
  mkdirSync(dirname(dest), { recursive: true });
  appendFileSync(dest, readFileSync(f));
  unlinkSync(f);
};

/** 老版本把整理者写成了一条定时任务。改名停用而不是删 —— 那份文件人可能改过;
 *  留着它就是两路并跑。返回停用后的路径, 没有就 undefined。 */
export const retireStewardTask = (tasksDir: string = TASKS_DIR): string | undefined => {
  const file = fileOfTaskId(expandHome(tasksDir), STEWARD_ID);
  if (!existsSync(file)) return undefined;
  const to = `${file}.retired`;
  renameSync(file, to);
  return to;
};

interface StewardDeps {
  root: string;
  log: Logger;
  /** 起一个执行体跑这句 prompt, 收工 (闲下来并收掉) 才 resolve。ok=false = 没跑完,
   *  认领留着, 一小时后作为孤儿重认。 */
  run: (prompt: string) => Promise<{ ok: boolean; reason?: string }>;
  everyMs?: number;
  refsOf?: RefsOf;
  /** 一轮成功收工后, 内容真的变了的那些 md (按前后内容比, 不信执行体的 RESULT)。 */
  onMerged?: (mds: readonly string[]) => void;
}

export const startSteward = ({ root, log, run, everyMs = STEWARD_EVERY_MS, refsOf, onMerged }: StewardDeps): { stop: () => void } => {
  let running = false;
  const round = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      const t = Date.now();
      const { fresh, orphaned } = planRound(inboxes(root), t);
      if (!fresh.length && !orphaned.length) return;
      const files = [...fresh, ...orphaned].map(claim(t));
      log.info({ fresh: fresh.length, orphaned: orphaned.length }, "memory steward: claimed");
      // 同一份 md 可能对着两个收件箱 (新提议 + 孤儿), 去重后再拍快照。
      const mds = [...new Set(files.map((f) => mdOfInbox(root, f)))];
      const before = new Map(mds.map((md) => [md, contentOf(md)]));
      const r = await run(stewardPrompt(root, files, refsOf));
      if (!r.ok) { log.warn({ reason: r.reason, files }, "memory steward: run did not finish, claims left for reclaim"); return; }
      files.forEach(archive(root));
      const changed = mds.filter((md) => contentOf(md) !== before.get(md));
      log.info({ archived: files.length, changed }, "memory steward: merged");
      if (changed.length) {
        try { onMerged?.(changed); } catch (e) { log.warn({ err: (e as Error).message }, "memory steward: onMerged threw"); }
      }
    } catch (e) {
      log.warn({ err: (e as Error).message }, "memory steward: round failed");
    } finally {
      running = false;
    }
  };
  // 开机后先跑一轮: 定时器随每次 reload 重新计时, 频繁 reload 时只靠间隔会一直轮不到。
  const first = setTimeout(() => { void round(); }, 60_000);
  const timer = setInterval(() => { void round(); }, everyMs);
  first.unref();
  timer.unref();
  return { stop: () => { clearTimeout(first); clearInterval(timer); } };
};
