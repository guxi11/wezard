// 注入门控的确定性信号源 —— 能从 AI 会话自己写的 json 里读到的, 就不去读 tmux pane。
//
//   1. 活跃会话注册表 `<homeDir>/sessions/<pid>.json`: 交互式 CC 进程一起来就写,
//      带 `tmux: "wezard:@56.%56"` (→ 它住在哪个 pane)、`sessionId`、`status`
//      (idle / busy / shell) 与 `statusUpdatedAt`。于是「pane 里的会话建好并进入了
//      吗」「回车后它开始干活了吗」都是读一个小 json 的事。
//   2. transcript jsonl: 提交落盘后会出现一条 `type:"user"` 行; 会话正忙时回车只是
//      排队, 被消费时落成 `attachment.queued_command`。两者都带 timestamp。
//
// jsonl 在首条消息之前根本不存在 (`--session-id` 新建与 `--fork-session` 都一样),
// 所以「就绪」只能靠注册表; 「已提交」则注册表 (busy 翻转) 与 jsonl 任一确认即可。
// 没有可用注册表的后端一律返回 undefined, 由调用方退回读 pane。注意目录在 ≠
// 注册表可用: codebuddy 2.143+ 也写 sessions/<pid>.json, 但 schema 不同 (无
// tmux/status 字段) —— 有没有 tmux 字段才是「这个注册表我们读得懂」的判据。
import { closeSync, openSync, readdirSync, readFileSync, readSync, statSync, watch } from "node:fs";
import { join } from "node:path";
import { expandHome } from "../shared/paths.js";

export interface LiveSession {
  pid: number;
  sessionId: string;
  /** `idle` = 输入框等人; `busy` = 正在跑一轮; 其它值原样透传。 */
  status: string;
  statusUpdatedAt: number;
  /** `%N`; 进程不在 tmux 里时为 ""。 */
  pane: string;
  name: string;
}

export const registryDirOf = (homeDir: string): string => join(expandHome(homeDir), "sessions");

/** 这个后端写的注册表我们读得懂吗 —— 目录在不算数 (codebuddy 也写 sessions/,
 *  但行里没有 tmux/status), 得至少有一行解析成功且带 `tmux` 字段 (不看值: 不在
 *  tmux 里的进程会写空串)。半写/解析失败的行跳过; 目录很小, 不缓存。 */
export const hasRegistry = (homeDir: string): boolean => {
  let files: string[];
  try { files = readdirSync(registryDirOf(homeDir)); } catch { return false; }
  return files
    .filter((f) => f.endsWith(".json"))
    .some((f) => {
      try {
        const r = JSON.parse(readFileSync(join(registryDirOf(homeDir), f), "utf8")) as Record<string, unknown>;
        return "tmux" in r;
      } catch { return false; }
    });
};

// 崩掉的进程会留下 pid 文件, 而 tmux server 重启后 `%N` 从头编号 —— 不核对 pid,
// 一份陈年文件就能冒充新 pane 上的会话。EPERM = 进程在, 只是不归我们管。
const pidAlive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
};

const paneOf = (tmux: unknown): string => (typeof tmux === "string" ? tmux.slice(tmux.lastIndexOf(".") + 1) : "");

const parseRow = (raw: string): LiveSession | undefined => {
  try {
    const r = JSON.parse(raw) as Record<string, unknown>;
    if (typeof r.pid !== "number" || typeof r.sessionId !== "string") return undefined;
    return {
      pid: r.pid,
      sessionId: r.sessionId,
      status: typeof r.status === "string" ? r.status : "",
      statusUpdatedAt: typeof r.statusUpdatedAt === "number" ? r.statusUpdatedAt : 0,
      pane: paneOf(r.tmux),
      name: typeof r.name === "string" ? r.name : "",
    };
  } catch {
    return undefined; // 半写状态的文件
  }
};

/** 注册表全量 (目录很小: 每个活着的交互式进程一份)。不核对 pid —— 只要名字的调用方不在乎。 */
export const readRegistry = (homeDir: string): LiveSession[] => {
  const dir = registryDirOf(homeDir);
  let files: string[];
  try { files = readdirSync(dir); } catch { return []; }
  return files
    .filter((f) => f.endsWith(".json"))
    .map((f) => { try { return parseRow(readFileSync(join(dir, f), "utf8")); } catch { return undefined; } })
    .filter((r): r is LiveSession => r !== undefined);
};

/** 住在 `pane` 里、进程还活着的那个会话。同一 pane 先后起过几个进程时取最近更新的。 */
export const sessionOnPane = (homeDir: string, pane: string): LiveSession | undefined =>
  readRegistry(homeDir)
    .filter((r) => r.pane === pane && pidAlive(r.pid))
    .sort((a, b) => b.statusUpdatedAt - a.statusUpdatedAt)[0];

/** 注册表目录一有写入就回调 —— status 翻转的事件源, 省得按固定间隔去抽样。
 *  CC 以整文件改写 (可能是 rename) 落盘, 所以看目录而不是单个文件。返回撤销函数;
 *  目录不在 / watch 起不来时是空操作, 调用方自带的兜底轮询照样能收尾。 */
export const watchRegistry = (homeDir: string, onChange: () => void): (() => void) => {
  try {
    const w = watch(registryDirOf(homeDir), () => onChange());
    w.on("error", () => w.close());
    return () => w.close();
  } catch {
    return () => {};
  }
};

/** 注册表里进程还活着的会话各住在哪个 pane —— 「这个 pane 是不是会话 pane」的正面证据。 */
export const sessionPanes = (homeDir: string): Set<string> =>
  new Set(readRegistry(homeDir).filter((r) => r.pane && pidAlive(r.pid)).map((r) => r.pane));

/** 注册表里进程还活着的会话 pid —— 不要求注册表带 `tmux` 字段 (codebuddy 的没有),
 *  「这个 pane 里住着活会话吗」用它对 pane 的进程树认, 而不是对 pane id 认。 */
export const liveSessionPids = (homeDir: string): Set<number> =>
  new Set(readRegistry(homeDir).filter((r) => pidAlive(r.pid)).map((r) => r.pid));

// ── 提交确认 ──────────────────────────────────────────────────────────

const normalize = (s: string): string => s.replace(/\s+/gu, "");

/** 取文本的归一化探针: 去空白后的前 48 字 —— 足以区分, 又不会被 CC 对长文的处理截掉。 */
export const probeOf = (text: string): string => normalize(text).slice(0, 48);

/** 一个 jsonl 的「从这里往后看」书签。文件还不存在时 offset=0 (首条消息 / fork 会新建它)。 */
export interface TranscriptMark { path: string; offset: number }
export const markTranscript = (path: string): TranscriptMark => {
  try { return { path, offset: statSync(path).size }; } catch { return { path, offset: 0 }; }
};

const readFrom = (path: string, offset: number): string => {
  let fd: number | undefined;
  try {
    const size = statSync(path).size;
    if (size <= offset) return "";
    const buf = Buffer.allocUnsafe(size - offset);
    fd = openSync(path, "r");
    const n = readSync(fd, buf, 0, buf.length, offset);
    return buf.subarray(0, n).toString("utf8");
  } catch {
    return "";
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* ignore */ } }
  }
};

const textOfContent = (c: unknown): string =>
  typeof c === "string"
    ? c
    : Array.isArray(c)
      ? c.map((b) => (b && (b as { type?: string }).type === "text" ? String((b as { text?: unknown }).text ?? "") : "")).join("")
      : "";

/** 一行 jsonl 若是一次人类提交 (直接落成 user 行, 或忙时排队后落成 queued_command), 返回它的文本与时刻。 */
const submissionOf = (line: string): { text: string; at: number } | undefined => {
  if (!line.includes('"user"') && !line.includes("queued_command")) return undefined; // 便宜的预过滤
  try {
    const r = JSON.parse(line) as Record<string, unknown>;
    const at = Date.parse(String(r.timestamp ?? ""));
    if (r.type === "user" && r.isMeta !== true) return { text: textOfContent((r.message as { content?: unknown } | undefined)?.content), at };
    const att = r.attachment as { type?: string; prompt?: unknown } | undefined;
    if (r.type === "attachment" && att?.type === "queued_command") return { text: textOfContent(att.prompt), at };
  } catch { /* 写到一半的行 */ }
  return undefined;
};

/** 书签之后有没有出现一条带着 `probe`、且不早于 `since` 的提交。
 *  时间门挡的是 fork: 新建的 fork 文件从 0 读, 里面整段是父会话的旧对话,
 *  一条内容相同的旧消息不能冒充这次的提交。 */
export const submittedSince = (marks: readonly TranscriptMark[], probe: string, since: number): boolean =>
  Boolean(probe) && marks.some((m) =>
    readFrom(m.path, m.offset)
      .split("\n")
      .map(submissionOf)
      .some((s) => s !== undefined && !(s.at < since) && normalize(s.text).includes(probe)));
