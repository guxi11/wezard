import { existsSync, mkdirSync, readFileSync, writeFileSync, realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { parse } from "jsonc-parser";
import { patchJsonc } from "../shared/config-writer.js";
import { codexRequest, inspectCodexHooks, isWezardCodexHook } from "../shared/codex-hooks.js";

interface HookHandler { type?: string; command?: string; [key: string]: unknown }
interface HookGroup { hooks?: HookHandler[]; [key: string]: unknown }
const EVENTS = ["PreToolUse", "PermissionRequest", "SessionStart"] as const;

/** Own only wezard handlers and their exact trust hashes in Codex's hooks.json. */
export const syncCodexHooks = async (path: string, bin: string, cwd: string, command: string, timeout: number, remove: boolean): Promise<void> => {
  if (basename(path) !== "hooks.json") throw new Error("Codex sync target must be hooks.json, not config.toml/settings.json");
  mkdirSync(dirname(path), { recursive: true });
  const canonicalPath = join(realpathSync(dirname(path)), basename(path));
  const original = existsSync(path) ? readFileSync(path, "utf8") : "{}\n";
  const doc = parse(original) as { hooks?: Record<string, HookGroup[]>; state?: Record<string, { trusted_hash?: string; enabled?: boolean }> };
  if (!doc || typeof doc !== "object") throw new Error("Invalid Codex hooks.json");
  const current = await inspectCodexHooks(bin, cwd, [], dirname(path));
  const own = current.filter((h) => h.sourcePath === canonicalPath && isWezardCodexHook(h.command));
  const configPath = join(dirname(path), "config.toml");
  const read = await codexRequest<{ layers: Array<{ name: { type: string; file?: string; profile?: string | null }; version: string; config: { hooks?: { state?: Record<string, { trusted_hash?: string; enabled?: boolean }> } } }> }>(
    bin, cwd, "config/read", { includeLayers: true, cwd }, [], dirname(path),
  );
  const userLayer = read.layers.find((l) => l.name.type === "user" && !l.name.profile);
  const previousState = userLayer?.config.hooks?.state ?? {};
  const cleanedState = Object.fromEntries(Object.entries(previousState).filter(([key, value]) =>
    !own.some((h) => h.key === key && h.currentHash === value.trusted_hash)));
  const writeTrust = async (state: typeof previousState): Promise<void> => {
    await codexRequest(bin, cwd, "config/batchWrite", {
      filePath: configPath, expectedVersion: userLayer?.version,
      edits: [{ keyPath: "hooks.state", value: state, mergeStrategy: "replace" }],
    }, [], dirname(path));
  };
  const groups = EVENTS.map((event) => {
    const others = (doc.hooks?.[event] ?? []).flatMap((group) => {
      const hooks = (group.hooks ?? []).filter((h) => !isWezardCodexHook(h.command));
      return hooks.length ? [{ ...group, hooks }] : [];
    });
    return { path: ["hooks", event], value: remove ? others : [...others, {
      matcher: ".*", hooks: [{ type: "command", command, timeout: event === "SessionStart" ? 10 : timeout, statusMessage: event === "SessionStart" ? "登记 wezard 会话" : "等待企业微信审批" }],
    }] };
  });
  patchJsonc(path, [
    ...groups,
    ...own.filter((h) => doc.state?.[h.key]?.trusted_hash === h.currentHash).map((h) => ({ path: ["state", h.key], value: undefined })),
  ]);
  try {
    if (remove) { if (own.length) await writeTrust(cleanedState); return; }
    const added = (await inspectCodexHooks(bin, cwd, [], dirname(path))).filter((h) => h.sourcePath === canonicalPath && h.command === command);
    if (added.length !== EVENTS.length) throw new Error("Codex did not load the wezard session/approval hooks");
    // Trust state belongs in config.toml, not hooks.json; use Codex's writer to
    // preserve TOML and update only exact reviewed definitions, never all hooks.
    await writeTrust({ ...cleanedState, ...Object.fromEntries(added.map((h) => [h.key, { enabled: true, trusted_hash: h.currentHash }])) });
    const verified = (await inspectCodexHooks(bin, cwd, [], dirname(path))).filter((h) => h.sourcePath === canonicalPath && h.command === command);
    if (verified.length !== EVENTS.length || verified.some((h) => h.trustStatus !== "trusted")) throw new Error("Codex did not trust the exact wezard hook definitions");
  } catch (err) {
    writeFileSync(path, original);
    throw err;
  }
};
