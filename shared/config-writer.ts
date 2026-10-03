// Surgical edits to ~/.wezard/config.jsonc and secrets.json — preserves
// comments + formatting via jsonc-parser's `modify` patches.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { applyEdits, modify, parse as parseJsonc, type JSONPath } from "jsonc-parser";
import { expandHome } from "./paths.js";

const FORMAT = { tabSize: 2, insertSpaces: true, eol: "\n" };

const readText = (abs: string): string =>
  existsSync(abs) ? readFileSync(abs, "utf8") : "{}\n";

const writeText = (abs: string, txt: string): void => {
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, txt.endsWith("\n") ? txt : `${txt}\n`, "utf8");
};

export type JsoncPatch = { path: JSONPath; value: unknown };

/** The file's current text ("{}" when absent) — the base a preview patches. */
export const readJsoncText = (filePath: string): string => readText(expandHome(filePath));

/** Pure: `txt` with the patches applied, comments and formatting kept. value=undefined deletes. */
export const previewPatch = (txt: string, patches: JsoncPatch[]): string =>
  patches.reduce((acc, { path, value }) => applyEdits(acc, modify(acc, path, value, { formattingOptions: FORMAT })), txt);

/** Apply a sequence of (path, value) patches to a JSONC file. value=undefined deletes. */
export const patchJsonc = (filePath: string, patches: JsoncPatch[]): void => {
  const abs = expandHome(filePath);
  writeText(abs, previewPatch(readText(abs), patches));
};

/** Append `value` into a string array at `path`, deduped. No-op if already present. */
export const appendUnique = (filePath: string, path: JSONPath, value: string): void => {
  const abs = expandHome(filePath);
  const txt = readText(abs);
  const tree = (parseJsonc(txt) ?? {}) as Record<string, unknown>;
  const cur = path.reduce<unknown>((acc, key) => {
    if (acc && typeof acc === "object") return (acc as Record<string, unknown>)[String(key)];
    return undefined;
  }, tree);
  const arr = Array.isArray(cur) ? (cur as string[]).slice() : [];
  if (arr.includes(value)) return;
  arr.push(value);
  patchJsonc(filePath, [{ path, value: arr }]);
};
