// Headless Claude Code bridge. Spawns `claude -p` per WeCom message, streams
// stdout (stream-json) back via WeCom replyStream. One in-flight subprocess
// per principal; subsequent messages queue.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { WSClient, WsFrameHeaders } from "@wecom/aibot-node-sdk";
import type { Logger } from "pino";
import type { Config } from "../shared/config.js";
import { expandHome } from "../shared/paths.js";
import { augmentedPath } from "../shared/exec-path.js";
import { resolveCliBackend } from "../shared/cli-backends.js";
import type { SessionStore } from "./sessions.js";


// Anything that looks like a delta-bearing event in `claude -p --output-format stream-json --verbose`.
// Two text sources, mutually exclusive in practice:
//   1. partial stream events:    { type:"stream_event", event:{ type:"content_block_delta",
//                                  delta:{ type:"text_delta", text:"..." } } }    ← incremental
//   2. assistant message events: { type:"assistant", message:{ content:[{type:"text",text:"..."}, ...] } } ← whole turn
// Streaming runs always emit (1); (2) is also emitted at end-of-turn carrying the SAME text. Mixing
// both doubles every turn (visible as a sudden bubble jump after the first tool_use). So we treat
// (2) as a fallback only used when no delta was ever seen (e.g. cached / non-streaming responses).
interface StreamLine {
  type?: string;
  subtype?: string;
  session_id?: string;
  message?: { content?: Array<{ type?: string; text?: string }> };
  event?: {
    type?: string;
    delta?: { type?: string; text?: string };
  };
  result?: string;
  is_error?: boolean;
}

const FLUSH_INTERVAL_MS = 250;

const deltaText = (line: StreamLine): string | undefined => {
  if (
    line.type === "stream_event" &&
    line.event?.type === "content_block_delta" &&
    line.event.delta?.type === "text_delta"
  ) {
    return line.event.delta.text ?? "";
  }
  return undefined;
};

const assistantText = (line: StreamLine): string | undefined => {
  if (line.type === "assistant" && line.message?.content) {
    return line.message.content
      .filter((b) => b.type === "text" && typeof b.text === "string")
      .map((b) => b.text!)
      .join("");
  }
  return undefined;
};

interface RunArgs {
  text: string;
  resumeSid?: string;
  cfg: Config;
  log: Logger;
  client: WSClient;
  frame: WsFrameHeaders;
  streamId: string;
  /** 用于 stream 终止后补发预览消息的目标 (chatid)。WeCom 对 stream 类型硬编码 "…" 列表预览，
   *  发一条 markdown 才能覆盖。principal 形如 "user:xxx" / "chat:xxx"，剥前缀后即 chatid。 */
  principal: string;
  /** Called once we observe `system/init` with the (possibly fresh) session_id. */
  onSession: (sid: string) => void;
}

const runOne = async (args: RunArgs): Promise<void> => {
  const { text, resumeSid, cfg, log, client, frame, streamId, principal, onSession } = args;

  const cliArgs = [
    "-p",
    text,
    "--output-format",
    "stream-json",
    ...resolveCliBackend(cfg.wrc).headlessStreamingArgs,
    ...cfg.wrc.extraArgs,
  ];
  if (resumeSid) cliArgs.push("--resume", resumeSid);

  log.info({ resumeSid, claudeBin: cfg.wrc.claudeBin }, "spawn claude");

  const proc = spawn(cfg.wrc.claudeBin, cliArgs, {
    cwd: expandHome(cfg.wrc.cwd),
    env: { ...process.env, PATH: augmentedPath(process.env.PATH) },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let acc = "";
  let lastSent = "";
  let sawDelta = false; // gate assistant-event fallback (see deltaText/assistantText comment)
  let flushTimer: NodeJS.Timeout | undefined;
  let stderrTail = "";

  const sendFlush = async (finish: boolean): Promise<void> => {
    if (acc === lastSent && !finish) return;
    lastSent = acc;
    try {
      await client.replyStream(frame, streamId, acc || " ", finish);
    } catch (e) {
      log.warn({ err: (e as Error).message, finish }, "replyStream failed");
    }
  };

  const scheduleFlush = (): void => {
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
      flushTimer = undefined;
      void sendFlush(false);
    }, FLUSH_INTERVAL_MS);
  };

  const stdout = proc.stdout;
  const stderr = proc.stderr;
  if (!stdout || !stderr) {
    throw new Error("claude subprocess missing stdio pipes");
  }

  // ENOENT / EACCES 等 spawn 失败走 'error' 事件，不监听会 crash 整个 daemon。
  let spawnError: Error | undefined;
  proc.on("error", (err: Error) => {
    spawnError = err;
    log.error({ err: err.message, code: (err as NodeJS.ErrnoException).code }, "spawn error");
  });

  const rl = createInterface({ input: stdout });
  rl.on("line", (raw) => {
    if (!raw.trim()) return;
    let line: StreamLine;
    try {
      line = JSON.parse(raw) as StreamLine;
    } catch {
      log.debug({ raw: raw.slice(0, 200) }, "non-JSON stdout line");
      return;
    }
    if (line.type === "system" && line.subtype === "init" && line.session_id) {
      onSession(line.session_id);
      return;
    }
    const delta = deltaText(line);
    if (delta) {
      sawDelta = true;
      acc += delta;
      scheduleFlush();
    } else {
      const whole = assistantText(line);
      // Fallback only if we never saw any delta (e.g. cached / non-streaming response).
      if (whole && !sawDelta) {
        acc += whole;
        scheduleFlush();
      }
    }
    if (line.type === "result") {
      // result.result is the final assistant text in cases where no assistant event was emitted (e.g. no_response).
      if (!acc && typeof line.result === "string") acc = line.result;
    }
  });

  proc.stderr?.on("data", (chunk: Buffer) => {
    const s = chunk.toString("utf8");
    stderrTail = (stderrTail + s).slice(-2000);
  });

  await new Promise<void>((resolve) => {
    proc.on("close", async (code: number | null) => {
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = undefined;
      }
      if (spawnError || code !== 0) {
        const reason = spawnError
          ? `spawn ${cfg.wrc.claudeBin}: ${spawnError.message}`
          : `claude exited ${code}`;
        log.error({ code, spawnErr: spawnError?.message, stderrTail: stderrTail.slice(-500) }, "claude failure");
        const fallback = acc
          ? `${acc}\n\n[${reason}]`
          : `[wezard] ${reason}\n${stderrTail.slice(-500)}`;
        acc = fallback;
      }
      await sendFlush(true);
      // WeCom 列表对 stream 消息硬编码 "…" 预览，唯一覆盖方式是在 stream 终止后补发一条普通消息。
      // 取 acc 按空行切分的最后一段——对应"最后一段话"，多段冗长输出不会全压进列表。
      const tail = acc.split(/\n{2,}/).filter((s) => s.trim()).pop();
      if (tail) {
        const chatId = principal.includes(":") ? principal.slice(principal.indexOf(":") + 1) : principal;
        try {
          await client.sendMessage(chatId, { msgtype: "markdown", markdown: { content: tail } });
        } catch (e) {
          log.warn({ err: (e as Error).message }, "preview push failed");
        }
      }
      log.info({ code, chars: acc.length }, "claude done");
      resolve();
    });
  });
};

// ── Per-principal queue ───────────────────────────────────────────────
type Job = () => Promise<void>;
const queues = new Map<string, Promise<void>>();

const enqueue = (key: string, job: Job): Promise<void> => {
  const prev = queues.get(key) ?? Promise.resolve();
  const next = prev.then(job, job).catch(() => undefined);
  queues.set(
    key,
    next.finally(() => {
      if (queues.get(key) === next) queues.delete(key);
    }),
  );
  return next;
};

export interface BridgeDeps {
  cfg: Config;
  log: Logger;
  client: WSClient;
  sessions: SessionStore;
}

export interface DispatchArgs {
  principal: string;
  text: string;
  /** Absolute paths to image files. Headless mode prepends `@<path>` to text
   *  (Claude Code parses @-mentions and inlines as image content blocks at
   *  submit time). Mirror mode handles these via clipboard+Ctrl+V. */
  images?: string[];
  frame: WsFrameHeaders;
  streamId: string;
}

export const makeBridge = (deps: BridgeDeps) => {
  return {
    dispatch: ({ principal, text, images, frame, streamId }: DispatchArgs): Promise<void> =>
      enqueue(principal, () => {
        const refs = (images ?? []).map((p) => `@${p}`).join("\n");
        const finalText = refs ? (text ? `${refs}\n${text}` : refs) : text;
        return runOne({
          text: finalText,
          resumeSid: deps.sessions.get(principal),
          cfg: deps.cfg,
          log: deps.log.child({ principal }),
          client: deps.client,
          frame,
          streamId,
          principal,
          onSession: (sid) => deps.sessions.set(principal, sid),
        });
      }),
  };
};

export type Bridge = ReturnType<typeof makeBridge>;
