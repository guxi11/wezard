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
  if (r.type === "turn_context") return { type: "assistant", timestamp: r.timestamp, effort: p.effort ?? p.collaboration_mode?.settings?.reasoning_effort, message: { role: "assistant", content: [], model: p.model } };
  if (r.type === "token_usage_record" && p.usage) {
    const u = p.usage;
    const cached = Number(u.cached_input_tokens ?? 0);
    return { type: "assistant", timestamp: r.timestamp, message: { role: "assistant", content: [], id: p.response_id, usage: {
      // Keep Codex total input intact: the shared accounting layer splits cache once.
      input_tokens: Number(u.input_tokens ?? 0),
      cache_creation_input_tokens: Number(u.cache_write_input_tokens ?? 0),
      cache_read_input_tokens: cached, output_tokens: Number(u.output_tokens ?? 0),
    } } };
  }
  if (r.type === "event_msg" && ["task_complete", "task_completed", "turn_complete"].includes(p.type))
    return { type: "system", subtype: "turn_duration", timestamp: r.timestamp };
  if (r.type !== "response_item") return null;
  const base = { uuid: p.id, timestamp: r.timestamp };
  if (p.type === "message" && ["user", "assistant"].includes(p.role)) {
    const blocks = Array.isArray(p.content) ? p.content : [];
    const withImages = p.role === "user" && blocks.some((b: any) => b.type === "input_image");
    // Keep the image shape so the mirror reconciles CLI-added [Image #N]
    // with the injected query. Codex's separate image wrapper is transport metadata.
    const content = blocks.flatMap((b: any) => {
      if (withImages && b.type === "input_image") return [{ type: "image" }];
      if (!["input_text", "output_text", "text"].includes(b.type)) return [];
      const text = b.text ?? "";
      if (withImages && /^(?:<image\s+name=[^>]*>|<\/image>)$/.test(text.trim())) return [];
      return [{ type: "text", text }];
    });
    const text = content.map((b: { text?: string }) => b.text ?? "").join("\n");
    // Codex persists repository instructions/environment as a user message.
    // Only a complete context wrapper is metadata; an actual prompt appended
    // to it must still open a turn and retain its wezard envelope.
    if (p.role === "user" && !(Array.isArray(p.content) ? p.content : []).some((b: any) => b.type === "input_image") && text.trim() && /^(?:# AGENTS\.md instructions for [^\n]+\n+\s*<INSTRUCTIONS>[\s\S]*?<\/INSTRUCTIONS>\s*)?(?:<environment_context>[\s\S]*?<\/environment_context>\s*)?$/.test(text.trim()))
      return { ...base, type: "user", isMeta: true, message: { role: "user", content: text } };
    return { ...base, type: p.role, awaitTurnEnd: p.phase === "final_answer", mid: p.role === "assistant" && p.phase === "commentary", message: { role: p.role, content: p.role === "user" ? (withImages ? content : text) : [{ type: "text", text }], ...(p.phase === "final_answer" ? { stop_reason: "end_turn" } : {}) } };
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
