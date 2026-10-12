import { isAbsolute, normalize } from "node:path";
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
  if (/(?:Trusting will apply to the repository root|This folder (?:pre-approves|adds|runs commands)|without these permissions|full access|bypass permissions|dangerously|sandbox approval|Would you like to proceed\?|Do you want to proceed\?)/iu.test(screen)) return undefined;
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
