import { readdirSync, openSync, readSync, closeSync, readFileSync, mkdirSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import type { NormalizedTranscriptLine } from "./cli-backends.js";
import { expandHome } from "./paths.js";

export interface CodexPaneSession {
  sessionId: string;
  jsonlPath: string;
  cwd: string;
  pane: string;
  startedAt: number;
}
let stateDir = "~/.wezard/state";
export const bindCodexStateDir = (dir: string): void => { stateDir = dir; };

/** SessionStart supplies the actual thread/pane identity, even before a prompt. */
export const recordCodexPaneSession = (session: CodexPaneSession, dir = stateDir): void => {
  if (!/^%\d+$/.test(session.pane)) return;
  const root = join(expandHome(dir), "codex-panes");
  mkdirSync(root, { recursive: true });
  const path = join(root, `${session.pane.slice(1)}.json`);
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(session));
  renameSync(temp, path);
};

export const codexSessionForPane = (pane: string, dir = stateDir): CodexPaneSession | undefined => {
  if (!/^%\d+$/.test(pane)) return undefined;
  try {
    const s = JSON.parse(readFileSync(join(expandHome(dir), "codex-panes", `${pane.slice(1)}.json`), "utf8")) as CodexPaneSession;
    return s.pane === pane && typeof s.sessionId === "string" && typeof s.jsonlPath === "string" && typeof s.cwd === "string" && typeof s.startedAt === "number" ? s : undefined;
  } catch { return undefined; }
};

/** Codex rollouts are date-partitioned; cwd and session id live in session_meta. */
export const codexSessions = (root: string, cwd?: string): Array<{ sessionId: string; jsonlPath: string }> => {
  const walk = (dir: string): string[] => {
    try { return readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
      d.isDirectory() ? walk(join(dir, d.name)) : d.name.endsWith(".jsonl") ? [join(dir, d.name)] : []); }
    catch { return []; }
  };
  return walk(root).flatMap((jsonlPath) => {
    try {
      const fd = openSync(jsonlPath, "r");
      let head: string;
      try { const buf = Buffer.alloc(256 * 1024); head = buf.subarray(0, readSync(fd, buf, 0, buf.length, 0)).toString("utf8"); }
      finally { closeSync(fd); }
      const meta = JSON.parse(head.split("\n", 1)[0]!).payload;
      const sessionId = meta?.id ?? meta?.session_id;
      return typeof sessionId === "string" && (!cwd || meta.cwd === cwd) ? [{ sessionId, jsonlPath }] : [];
    } catch { return []; }
  });
};

export const normalizeCodex = (raw: unknown): NormalizedTranscriptLine | null => {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, any>;
  const p = r.payload;
  if (!p || typeof p !== "object") return null;
  if (r.type === "turn_context") return { type: "assistant", timestamp: r.timestamp, effort: p.effort, message: { role: "assistant", content: [], model: p.model } };
  if (r.type === "token_usage_record" && p.usage) {
    const u = p.usage;
    const cached = Number(u.cached_input_tokens ?? 0);
    return { type: "assistant", timestamp: r.timestamp, message: { role: "assistant", content: [], usage: {
      input_tokens: Math.max(0, Number(u.input_tokens ?? 0) - cached),
      cache_read_input_tokens: cached, output_tokens: Number(u.output_tokens ?? 0),
    } } };
  }
  if (r.type === "event_msg" && ["task_complete", "task_completed", "turn_complete"].includes(p.type))
    return { type: "assistant", message: { role: "assistant", content: [], stop_reason: "end_turn" } };
  if (r.type !== "response_item") return null;
  const base = { uuid: p.id, timestamp: r.timestamp };
  if (p.type === "message" && ["user", "assistant"].includes(p.role)) {
    const text = (Array.isArray(p.content) ? p.content : []).filter((b: any) => ["input_text", "output_text", "text"].includes(b.type)).map((b: any) => b.text ?? "").join("\n");
    return { ...base, type: p.role, message: { role: p.role, content: p.role === "user" ? text : [{ type: "text", text }], ...(p.phase === "final_answer" ? { stop_reason: "end_turn" } : {}) } };
  }
  if (["function_call", "custom_tool_call"].includes(p.type)) {
    let input: unknown = p.input ?? {};
    if (p.arguments) { try { input = JSON.parse(p.arguments); } catch { input = p.arguments; } }
    return { ...base, type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: p.call_id, name: p.name, input }] } };
  }
  if (["function_call_output", "custom_tool_call_output"].includes(p.type))
    return { ...base, type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: p.call_id, content: typeof p.output === "string" ? p.output : JSON.stringify(p.output) }] } };
  if (p.type === "reasoning") {
    const thinking = (p.summary ?? []).map((b: any) => b.text ?? "").join("\n");
    return thinking ? { ...base, type: "assistant", message: { role: "assistant", content: [{ type: "thinking", thinking }] } } : null;
  }
  return null;
};
