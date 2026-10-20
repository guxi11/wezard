import { basename, dirname, isAbsolute, normalize } from "node:path";
import type { CliBackendName } from "./cli-backends.js";
import { previewPatch } from "./config-writer.js";

const linesOf = (screen: string): string[] => screen.split("\n").map((line) =>
  line.replace(/\x1b\[[0-9;?]*[A-Za-z]/gu, "").replace(/^\s*[│┃]/u, "").replace(/[│┃]\s*$/u, "").trim());

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** Patch only cwd trust/onboarding; extra includes remain separately authorized. */
export const workspaceTrustConfig = (original: string, cwd: string): string => {
  const config: unknown = JSON.parse(original);
  if (!object(config) || (config.projects !== undefined && !object(config.projects))) throw new Error("invalid project config");
  const project = (config.projects as Record<string, unknown> | undefined)?.[cwd];
  if (project !== undefined && !object(project)) throw new Error("invalid project metadata");
  const count = object(project) ? project.projectOnboardingSeenCount : undefined;
  if (count !== undefined && (typeof count !== "number" || !Number.isFinite(count))) throw new Error("invalid onboarding count");
  return previewPatch(original, [
    { path: ["projects", cwd, "hasTrustDialogAccepted"], value: true },
    { path: ["projects", cwd, "projectOnboardingSeenCount"], value: Math.max(Number(count ?? 0), 1) },
  ]);
};

export interface WorkspaceTrustPrompt {
  directory: string;
  /** Position in the displayed options, independent of hidden numeric shortcuts. */
  choice: number;
  selected: number;
  labels: string[];
}

/** 「另需授权」的语义一概不让目录信任的代按沾边 (workspaceTrustPrompt 与
 *  codebuddyTrustPrompt 共用): repo 根授权 / 预开权限 / 沙箱豁免都要人自己点。 */
const EXTRA_GRANT_RE = /(?:Trusting will apply to the repository root|This folder (?:pre-approves|adds|runs commands)|without these permissions|full access|bypass permissions|dangerously|sandbox approval|Would you like to proceed\?|Do you want to proceed\?)/iu;

/** Startup questions must never receive an unscoped retry Enter. */
export const startupConfirmation = (screen: string): boolean =>
  /(?:Accessing workspace:|Trust this folder\?|Do you trust the contents of this directory\?|Folder access|Esc to cancel|Enter to confirm|Would you like to proceed\?|Do you want to proceed\?)/iu.test(screen)
  || /^\s*[❯›>]\s*\d+[.)]\s+\S/mu.test(screen);

/** Recognize only a complete directory-trust picker for the exact authorized cwd. */
export const workspaceTrustPrompt = (
  screen: string,
  backend: CliBackendName,
  cwd: string,
  canonicalize: (path: string) => string = normalize,
): WorkspaceTrustPrompt | undefined => {
  const lines = linesOf(screen);
  const codex = backend === "codex";
  const header = codex
    ? /^(?:Trust this folder\?(?: Codex .*)?|Do you trust the contents of this directory\?|Folder access)$/u
    : /^(?:Accessing workspace:|Do you trust the files in this folder\?|Do you trust this folder\?)$/u;
  if (!lines.some((line) => header.test(line))) return undefined;
  // Folder access can apply to a repository root or pre-approve extra directories/tools.
  // Those grants need their own authorization, even when the visible cwd matches.
  if (EXTRA_GRANT_RE.test(screen)) return undefined;
  const directories = lines.filter((line) => isAbsolute(line));
  if (directories.length !== 1 || !isAbsolute(cwd)) return undefined;
  const directory = directories[0]!;
  try { if (canonicalize(directory) !== canonicalize(cwd)) return undefined; }
  catch { return undefined; }
  const yes = codex ? /^(?:Yes, continue|Trust and continue)$/u : /^Yes, I trust this folder$/u;
  const no = codex ? /^(?:No, quit|Quit|Open restricted)$/u : /^No, exit$/u;
  const options = lines.flatMap((line) => {
    const match = /^(?:([❯›>])\s*)?(?:\d+[.)]\s*)?(.*)$/u.exec(line)!;
    const label = match[2]!;
    return yes.test(label) || no.test(label) ? [{ label, selected: Boolean(match[1]) }] : [];
  });
  if (options.length !== 2 || options.filter((option) => yes.test(option.label)).length !== 1
    || options.filter((option) => option.selected).length !== 1) return undefined;
  // A numeric/highlighted row outside this exact two-option picker is ambiguous.
  if (lines.some((line) => /^(?:[❯›>]\s*)?\d+[.)]\s+/u.test(line)
    && !options.some((option) => line.endsWith(option.label)))) return undefined;
  return {
    directory,
    choice: options.findIndex((option) => yes.test(option.label)),
    selected: options.findIndex((option) => option.selected),
    labels: options.map((option) => option.label),
  };
};

export interface CodebuddyTrustPicker {
  /** 屏上唯一的绝对路径 (canonicalize 后 = 本次 spawn 的 cwd)。 */
  directory: string;
  /** 高亮停在第几项 (0 起)。只做形状证据, 按键策略见 spawn-tmux 的 answerCodebuddyTrust。 */
  selected: number;
  labels: string[];
}

/** CodeBuddy 的四选项目录信任选择器 (实测 v2.167, 200x60): 只认完整已知形状 ——
 *  标题行 + 唯一绝对路径 (= cwd) + 四个与 cwd 逐字对得上的选项行 (Trust folder only /
 *  Trust parent folder / Trust folder and all subdirectories / No, exit) + Enter 尾行。
 *  屏上出现别的数字选项行、或「另需授权」语义 (EXTRA_GRANT_RE) 即拒认 —— 任一不符
 *  返回 undefined, 调用方退回「只通知」路径, 绝不盲发键。 */
export const codebuddyTrustPrompt = (
  screen: string,
  cwd: string,
  canonicalize: (path: string) => string = normalize,
): CodebuddyTrustPicker | undefined => {
  const lines = linesOf(screen);
  if (!lines.some((line) => /^Do you trust the files in this folder\?$/u.test(line))) return undefined;
  if (EXTRA_GRANT_RE.test(screen)) return undefined;
  const directories = lines.filter((line) => isAbsolute(line));
  if (directories.length !== 1 || !isAbsolute(cwd)) return undefined;
  const directory = directories[0]!;
  try { if (canonicalize(directory) !== canonicalize(cwd)) return undefined; }
  catch { return undefined; }
  const want = [
    `Trust folder only (${basename(directory)})`,
    `Trust parent folder (${basename(dirname(directory))}/**)`,
    `Trust folder and all subdirectories (${basename(directory)}/**)`,
  ];
  // 选项行 = 带数字前缀的行; 文本 (去掉前缀与高亮标记) 必须与 want 逐字一致, 顺序也是形状。
  const options: { label: string; selected: boolean }[] = [];
  for (const line of lines) {
    if (!/^(?:[❯›>]\s*)?\d+[.)]\s+/u.test(line)) continue;
    const match = /^(?:([❯›>])\s*)?(?:\d+[.)]\s*)?(.*)$/u.exec(line)!;
    if (!match[2]) return undefined;
    options.push({ label: match[2]!, selected: Boolean(match[1]) });
  }
  const labels = options.map((option) => option.label);
  if (labels.length !== 4
    || labels[0] !== want[0] || labels[1] !== want[1] || labels[2] !== want[2]
    || !/^No, exit(?: \(escape\))?$/u.test(labels[3] ?? "")) return undefined;
  if (options.filter((option) => option.selected).length !== 1) return undefined;
  // 尾行也是形状的一部分 (圆点见过 • 与 · 两种, devcloud 变体是 (escape) 而非 Esc to cancel)。
  if (!lines.some((line) => /^Enter to confirm [•·] Esc to (?:exit|cancel)(?: \(escape\))?$/u.test(line))) return undefined;
  return { directory, selected: options.findIndex((option) => option.selected), labels };
};
