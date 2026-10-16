import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { augmentedPath } from "./exec-path.js";

export const codexSandboxMode = (disabled = false): "danger-full-access" | undefined =>
  disabled ? "danger-full-access" : undefined;

/** Both app-server and TUI accept config overrides; approval stays independent. */
export const codexSandboxLaunchArgs = (disabled = false): string[] =>
  disabled ? ["-c", `sandbox_mode=${JSON.stringify(codexSandboxMode(disabled))}`] : [];

/** Native shortcut flags can override config or also change approval; fail closed. */
export const codexSandboxArgConflict = (args: string[]): string | undefined => args.find(arg =>
  /^(?:--sandbox(?:=|$)|-s(?:=|[^-]|$)|--(?:full-auto|approve-for-me|yolo|dangerously-bypass-approvals-and-sandbox)(?:=|$))/.test(arg));

export interface CodexHook {
  enabled: boolean;
  key: string;
  eventName: string;
  command?: string;
  matcher?: string;
  sourcePath: string;
  currentHash: string;
  trustStatus: string;
}

/** Make a short-lived request through the installed Codex CLI. */
export const codexRequest = <T>(bin: string, cwd: string, method: string, params: unknown, args: string[] = [], homeDir?: string,
  finalize?: (result: T) => { method: string; params: unknown }): Promise<T> =>
  new Promise((resolve, reject) => {
    const child = spawn(bin, ["app-server", "--enable", "hooks", ...args], {
      cwd, env: { ...process.env, TMUX_PANE: undefined, PATH: augmentedPath(process.env.PATH), ...(homeDir ? { CODEX_HOME: homeDir } : {}) }, stdio: ["pipe", "pipe", "pipe"],
    });
    const lines = createInterface({ input: child.stdout });
    let settled = false;
    let stderr = "";
    let initialResult: T | undefined;
    const finish = (err?: Error, result?: T): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      lines.close();
      if (err) { child.kill(); reject(err); return; }
      // EOF lets Codex flush its native thread state before another CLI resumes it.
      child.stdin.end();
      const shutdownTimer = setTimeout(() => { child.kill(); reject(new Error(`Codex ${method} did not close after EOF`)); }, 5000);
      child.once("exit", (code, signal) => {
        clearTimeout(shutdownTimer);
        if (code !== 0) reject(new Error(`Codex ${method} failed during shutdown (${signal ?? code}): ${stderr}`));
        else resolve(result!);
      });
    };
    const timer = setTimeout(() => finish(new Error(`Codex ${method} timed out`)), 20_000);
    const send = (message: unknown): void => { child.stdin.write(JSON.stringify(message) + "\n"); };
    child.stderr.on("data", (b: Buffer) => { stderr = (stderr + b.toString()).slice(-2000); });
    child.stdin.on("error", (err) => finish(err));
    child.on("error", (err) => finish(err));
    child.on("exit", () => finish(new Error(`Codex ${method} exited: ${stderr}`)));
    lines.on("line", (line) => {
      let r: { id?: number; error?: { message: string }; result?: T };
      try { r = JSON.parse(line); } catch { return; }
      if (r.id !== 1 && r.id !== 2 && r.id !== 3) return;
      if (r.error) { finish(new Error(r.error.message)); return; }
      if (r.id === 1) {
        send({ method: "initialized" });
        send({ id: 2, method, params });
      } else if (r.id === 3) {
        finish(undefined, initialResult);
      } else {
        if (r.result === undefined) { finish(new Error(`Codex returned no ${method} result`)); return; }
        if (finalize) {
          initialResult = r.result;
          try { send({ id: 3, ...finalize(r.result) }); }
          catch (e) { finish(e instanceof Error ? e : new Error(String(e))); }
        } else finish(undefined, r.result);
      }
    });
    send({ id: 1, method: "initialize", params: {
      clientInfo: { name: "wezard", version: "2.5.1" }, capabilities: { experimentalApi: true },
    } });
  });

/** Create/resume/fork and persist an empty native thread, without starting a turn. */
export const prepareCodexSession = async (bin: string, cwd: string, name: string, args: string[],
  options: { resumeSessionId?: string; forkSession?: boolean; model?: string; systemPrompt?: string; sandboxMode?: "workspace-write" | "danger-full-access" }): Promise<{ sessionId: string; jsonlPath: string }> => {
  const method = options.resumeSessionId ? options.forkSession ? "thread/fork" : "thread/resume" : "thread/start";
  const result = await codexRequest<{ thread: { id: string; path: string | null } }>(bin, cwd, method, {
    cwd, ...(options.resumeSessionId ? { threadId: options.resumeSessionId } : { ephemeral: false }),
    ...(options.model ? { model: options.model } : {}),
    ...(options.systemPrompt ? { developerInstructions: options.systemPrompt } : {}),
    // Resume/fork can inherit saved permissions: explicitly apply this launch's policy.
    ...(options.sandboxMode ? { sandbox: options.sandboxMode } : {}),
  }, args, undefined, (r) => ({ method: "thread/name/set", params: { threadId: r.thread.id, name } }));
  if (!result.thread.id || !result.thread.path) throw new Error("Codex did not return a persistent thread id/path");
  return { sessionId: result.thread.id, jsonlPath: result.thread.path };
};

export const inspectCodexHooks = async (bin: string, cwd: string, args: string[] = [], homeDir?: string): Promise<CodexHook[]> => {
  const result = await codexRequest<{ data: Array<{ hooks: CodexHook[]; errors?: unknown[] }> }>(bin, cwd, "hooks/list", { cwds: [cwd] }, args, homeDir);
  if (!Array.isArray(result.data)) throw new Error("Codex returned no hooks/list data");
  const errors = result.data.flatMap((d) => d.errors ?? []);
  if (errors.length) throw new Error(`Codex hook config errors: ${JSON.stringify(errors)}`);
  if (result.data.some((entry) => !Array.isArray(entry.hooks))) throw new Error("Codex returned incomplete hooks/list data");
  return result.data.flatMap((d) => d.hooks);
};

/** Persist trust only for the exact hook set a human reviewed, then verify Codex's view. */
export const trustCodexHookSet = async (
  bin: string,
  cwd: string,
  homeDir: string,
  reviewed: Pick<CodexHook, "key" | "currentHash" | "sourcePath">[],
  live?: () => boolean | Promise<boolean>,
): Promise<CodexHook[]> => {
  const assertLive = async (): Promise<void> => {
    if (live && !(await live())) throw new Error("Codex hook review is no longer live; trust was not written");
  };
  await assertLive();
  if (!reviewed.length || new Set(reviewed.map((h) => h.key)).size !== reviewed.length) {
    throw new Error("Codex hook review set is empty or has duplicate keys");
  }
  const current = await inspectCodexHooks(bin, cwd, [], homeDir);
  await assertLive();
  const byKey = new Map(current.map((hook) => [hook.key, hook]));
  const pending = current.filter((hook) => hook.enabled && hook.trustStatus !== "trusted");
  if (pending.length !== reviewed.length || pending.some((hook) => {
    const item = reviewed.find(({ key }) => key === hook.key);
    return !item || item.currentHash !== hook.currentHash || item.sourcePath !== hook.sourcePath;
  })) throw new Error("The pending Codex hook set changed since review; trust was not written");
  if (reviewed.some(({ key, currentHash, sourcePath }) => {
    const hook = byKey.get(key);
    return !hook || hook.currentHash !== currentHash || hook.sourcePath !== sourcePath || !hook.enabled;
  })) throw new Error("Codex hooks changed since review; trust was not written");

  const config = await codexRequest<{
    layers: Array<{
      name: { type: string; profile?: string | null };
      version: string;
      config: { hooks?: { state?: Record<string, { trusted_hash?: string; enabled?: boolean }> } };
    }>;
  }>(bin, cwd, "config/read", { includeLayers: true, cwd }, [], homeDir);
  const user = config.layers.find((layer) => layer.name.type === "user" && !layer.name.profile);
  if (!user) throw new Error("Codex user config layer is unavailable");
  const state = user.config.hooks?.state ?? {};
  const updates = Object.fromEntries(reviewed.map(({ key, currentHash }) => [key, { ...state[key], enabled: true, trusted_hash: currentHash }]));
  // Re-read immediately before the write: hooks may change while config/read
  // is in flight, and the daemon session may have stopped in the meantime.
  const latest = await inspectCodexHooks(bin, cwd, [], homeDir);
  await assertLive();
  const latestPending = latest.filter((hook) => hook.enabled && hook.trustStatus !== "trusted");
  if (latestPending.length !== reviewed.length || latestPending.some((hook) => {
    const item = reviewed.find(({ key }) => key === hook.key);
    return !item || item.currentHash !== hook.currentHash || item.sourcePath !== hook.sourcePath;
  })) throw new Error("The pending Codex hook set changed before trust was written");
  await assertLive();
  await codexRequest(bin, cwd, "config/batchWrite", {
    filePath: `${homeDir.replace(/\/$/u, "")}/config.toml`,
    expectedVersion: user.version,
    edits: [{ keyPath: "hooks.state", value: { ...state, ...updates }, mergeStrategy: "replace" }],
  }, [], homeDir);

  const verified = await inspectCodexHooks(bin, cwd, [], homeDir);
  const trusted = new Map(verified.map((hook) => [hook.key, hook]));
  if (verified.some((hook) => hook.enabled && hook.trustStatus !== "trusted")) {
    throw new Error("New or changed Codex hooks appeared during trust; the review card is stale");
  }
  if (reviewed.some(({ key, currentHash }) => {
    const hook = trusted.get(key);
    return !hook || hook.currentHash !== currentHash || hook.trustStatus !== "trusted";
  })) throw new Error("Codex did not verify trust for the reviewed hooks");
  return verified;
};

export const shellQuote = (value: string): string => `'${value.replace(/'/g, "'\\''")}'`;

export const codexHookCommand = (configPath: string, base: string, entry: string): string =>
  `env WEZARD_CONFIG=${shellQuote(configPath)} WEZARD_DAEMON_BASE=${shellQuote(base)} ${shellQuote(process.execPath)} ${shellQuote(entry)}`;

export const isWezardCodexHook = (command: string | undefined): boolean =>
  Boolean(command?.includes("WEZARD_CONFIG=") && command.includes("WEZARD_DAEMON_BASE=") && /\/cli\/codex-hook\.js'?$/.test(command));

export const codexHookGroups = (command: string, timeout: number, statusMessage = "等待企业微信审批"): string =>
  `[{matcher=".*",hooks=[{type="command",command=${JSON.stringify(command)},timeout=${timeout},statusMessage=${JSON.stringify(statusMessage)}}]}]`;

/** Trust only our exact invocation-local definitions, leaving other hooks alone. */
export const codexHookLaunchArgs = async (bin: string, cwd: string, command: string, timeout: number, approvalEnabled = true): Promise<string[]> => {
  const groups = codexHookGroups(command, timeout);
  const args = ["--enable", "hooks", "-c", `hooks.SessionStart=${codexHookGroups(command, 10, "登记 wezard 会话")}`,
    ...(approvalEnabled ? ["-c", `hooks.PreToolUse=${groups}`, "-c", `hooks.PermissionRequest=${groups}`] : [])];
  const configured = await inspectCodexHooks(bin, cwd, args);
  const hooks = configured.filter((h) => h.sourcePath === "/<session-flags>/config.toml" && h.command === command);
  if (hooks.length !== (approvalEnabled ? 3 : 1)) throw new Error("Codex did not load the wezard session/approval hooks");
  // Global sync may also register wezard; only one copy should run in our panes.
  const disabled = configured.filter((h) => h.sourcePath !== "/<session-flags>/config.toml" && isWezardCodexHook(h.command));
  const state = [
    ...configured.filter((h) => h.command !== command && !isWezardCodexHook(h.command)).map((h) =>
      `${JSON.stringify(h.key)}={enabled=${h.enabled}${h.trustStatus === "trusted" ? `,trusted_hash=${JSON.stringify(h.currentHash)}` : ""}}`),
    ...hooks.map((h) => `${JSON.stringify(h.key)}={trusted_hash=${JSON.stringify(h.currentHash)}}`),
    ...disabled.map((h) => `${JSON.stringify(h.key)}={enabled=false}`),
  ].join(",");
  return [...args, "-c", `hooks.state={${state}}`];
};
