// 宪章 (身份 preamble) 的「还没送到」状态跨 daemon reload 的重建。
//
// claude/codebuddy 的宪章不在 system prompt 里: AttachState.charterPending 挂着它,
// 由这个 pane 的首条非斜杠注入顶在最前带进去, 注入确认后清掉。它原本只在内存 ——
// 会话新起后闲着、daemon reload, 恢复出来的绑定就没有它了, 之后首条消息是一句没身份
// 的裸指令。这里凭两样东西重建: 落盘的欠账标记 (MirrorRecord.charterOwed) 和 transcript
// 里「宪章已经作为 user 行出现过」的硬证据。
//
// 判据 (顺序即优先级):
//   codex                → 不武装 (宪章在 developer_instructions, 再贴是重复)
//   transcript 不存在    → 武装 (新起还没开口; /kill 后由别的路径重建绑定也落在这里)
//   user 行里有宪章块    → 不武装 (已送达; assistant 行 / 工具输出里出现这个字面量不算)
//   落盘标记为 true      → 武装 (挂上过、没确认送达)
//   一条 user 行都没有   → 武装 (同上, 文件还没写第一句)
//   其余                 → 不武装 (2.9.0 之前用 system prompt 起的老会话, 别重复灌)
import { closeSync, existsSync, fstatSync, openSync, readSync } from "node:fs";
import { CLI_BACKEND_DEFAULTS, backendForPath, type CliBackend, type CliBackendName } from "./cli-backends.js";
import { expandHome } from "./paths.js";
import { parseReminders } from "./reminder.js";

export type LineNormalizer = CliBackend["normalizeTranscriptLine"];

/** 宪章 → 首条注入顶在最前的 reminder 块。认/剥/折叠全靠它是合法 reminder 块
 *  (kind "charter", shared/reminder.ts): cleanUserText 剥它, peers.stripMeta 剥它,
 *  rolepage 把它折叠成 `<charter>` 标签。正文里出现闭合标签字面量会截断这些剥离
 *  (懒惰匹配到第一个闭合就停), 顺手转义掉。 */
export const charterPreamble = (charter: string): string =>
  `<system-reminder wezard="charter">\n${charter.trim().replace(/<\/(system-reminder|pasted_content)/g, "<\\/$1")}\n</system-reminder>\n`;

/** transcript 里读到的事实: 说过话没有、宪章送到了没有。 */
export interface CharterFacts {
  /** 有过一条说人话的 user 行 (斜杠命令也算 —— 那说明会话不是全新的)。 */
  spoke: boolean;
  /** 某条 user 行里带着宪章块 (= 这条宪章已经进过上下文)。 */
  delivered: boolean;
}

const hasCharterBlock = (text: string): boolean =>
  parseReminders(text).some((r) => r.attrs.wezard === "charter");

/** content 里的正文: 字符串, 或 text/input_text 块。tool_result / tool_use / thinking
 *  不是「说的活」—— 工具输出里出现宪章字面量 (比如读了 charters/<sid>.md) 不算送达。 */
const blockText = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b): b is { type?: string; text?: string } => !!b && typeof b === "object")
    .filter((b) => (b.type === undefined || b.type === "text" || b.type === "input_text") && typeof b.text === "string")
    .map((b) => b.text ?? "")
    .join("");
};

/** 斜杠命令的包装行 (claude: `<command-name>/clear</command-name>`; codebuddy 同形)。
 *  它不是「一句话」, preamble 也从不出现在它前面 —— 读到它不代表宪章该放弃等待。 */
const isCommandLine = (text: string): boolean =>
  text.trimStart().startsWith("/") || text.includes("<command-name>") || text.startsWith("<local-command");

type LineKind = "charter" | "speech" | "command" | "other";

const classify = (raw: string, normalize: LineNormalizer): LineKind => {
  let row;
  try { row = normalize(JSON.parse(raw)); } catch { return "other"; }
  if (!row || row.isMeta || row.isSidechain) return "other";
  if (row.type !== "user" || row.message?.role !== "user") return "other";
  const text = blockText(row.message.content).trim();
  if (!text) return "other";
  if (hasCharterBlock(text)) return "charter";
  return isCommandLine(text) ? "command" : "speech";
};

/** 一叠完整行里读数: 宪章块 → delivered; 第一句人话/命令 → spoke。命令行不是
 *  「宪章永远不来了」的证明 —— 它本来就不带 preamble —— 但会话不是全新的, 所以停在这里
 *  让落盘标记去决定。 */
const scanLines = (lines: readonly string[], normalize: LineNormalizer): CharterFacts | undefined => {
  for (const line of lines) {
    if (!line.trim()) continue;
    const kind = classify(line, normalize);
    if (kind === "charter") return { spoke: true, delivered: true };
    if (kind === "speech" || kind === "command") return { spoke: true, delivered: false };
  }
  return undefined;
};

/** 纯解析版 (给单测 / 已有原文的调用方): 两种方言都靠 normalize 认。 */
export const charterFacts = (transcript: string, normalize: LineNormalizer): CharterFacts =>
  scanLines(transcript.split("\n"), normalize) ?? { spoke: false, delivered: false };

const CHUNK = 64 * 1024;
/** 首条 user 行总在文件开头几 KB 内; 一兆还没见到就当没有 (只可能是被别的东西写坏的
 *  头部, 按「新会话」处理, 代价是多一份宪章而不是身份丢失)。 */
const MAX_SCAN = 1024 * 1024;

/** 从文件头按行读到**第一条** user 行就停 —— 宪章既可能在它里面 (delivered), 也可能
 *  永远不会来了 (speech); 只有在一条 user 行都没有时才读到底。null = 文件不存在。 */
const readFacts = (path: string, normalize: LineNormalizer): CharterFacts | null => {
  if (!existsSync(path)) return null;
  let fd: number;
  try { fd = openSync(path, "r"); } catch { return null; }
  try {
    const size = fstatSync(fd).size;
    const buf = Buffer.alloc(CHUNK);
    let pending = "";
    let offset = 0;
    const feed = (chunk: string): CharterFacts | undefined => {
      const lines = chunk.split("\n");
      pending = lines.pop() ?? "";
      return scanLines(lines, normalize);
    };
    while (offset < size && offset < MAX_SCAN) {
      const n = readSync(fd, buf, 0, Math.min(CHUNK, size - offset), offset);
      if (n <= 0) break;
      offset += n;
      const hit = feed(pending + buf.toString("utf8", 0, n));
      if (hit) return hit;
    }
    return scanLines([pending], normalize) ?? { spoke: false, delivered: false };
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
};

/** 纯判据 (给定已读出的事实)。 */
export const charterVerdict = (f: { cli?: string; owed?: boolean; facts: CharterFacts | null }): boolean => {
  if (f.cli === "codex") return false;
  if (!f.facts) return true;
  if (f.facts.delivered) return false;
  if (f.owed) return true;
  return !f.facts.spoke;
};

/** 用哪个方言读: 绑定上记着后端就用它 (最准, 不受 transcript 根被改写到别处的影响),
 *  否则按路径认。 */
const normalizerFor = (cli: string | undefined, path: string): LineNormalizer =>
  cli && cli in CLI_BACKEND_DEFAULTS
    ? CLI_BACKEND_DEFAULTS[cli as CliBackendName].normalizeTranscriptLine
    : backendForPath(path).normalizeTranscriptLine;

/** 读转录 + 判据: 这个绑定建立时该不该重新武装宪章。 */
export const shouldRearmCharter = (input: { cli?: string; owed?: boolean; jsonlPath: string }): boolean => {
  if (input.cli === "codex") return false; // 连文件都不必读
  const path = expandHome(input.jsonlPath);
  const facts = readFacts(path, normalizerFor(input.cli, path));
  return charterVerdict({ cli: input.cli, owed: input.owed, facts });
};

/** attach 用: 判据为真时现渲染一份 (调用方给的 render 是 charterFor), 否则 undefined。 */
export const charterToRearm = (input: {
  cli?: string;
  owed?: boolean;
  jsonlPath: string;
  render: () => string | undefined;
}): string | undefined => {
  if (!shouldRearmCharter(input)) return undefined;
  const text = (input.render() ?? "").trim();
  return text || undefined;
};
