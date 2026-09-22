// MCP server `wezard`. Stdio transport. Single tool `wrc` = "wecom remote
// control": attaches the *current* Claude session for WeCom mirror — session
// resolved via CLAUDE_CODE_SESSION_ID env (Claude Code populates this for
// every child process), so multiple windows can each /wrc without trampling.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { spawn } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import { z } from "zod";

const DAEMON_BASE = process.env.WEZARD_DAEMON_BASE ?? "http://127.0.0.1:17890";

const ok = (data: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(data) }],
});
const fail = (msg: string) => ({
  isError: true,
  content: [{ type: "text" as const, text: msg }],
});

// Project-dir encoding is backend-specific:
//   Claude Code / claude-internal: `/` `.` → `-`  (yields leading `-`)
//   CodeBuddy:                     strip leading `/`, then `/` `.` → `-`  (no leading `-`)
const encodeClaude = (absCwd: string): string => absCwd.replace(/[/.]/g, "-");
const encodeCodebuddy = (absCwd: string): string =>
  absCwd.replace(/^[/]+/, "").replace(/[/.]/g, "-");

interface ProjectRoot {
  dir: string;
  encode: (absCwd: string) => string;
}
const PROJECT_ROOTS: ProjectRoot[] = [
  { dir: join(homedir(), ".claude-internal", "projects"), encode: encodeClaude },
  { dir: join(homedir(), ".claude", "projects"), encode: encodeClaude },
  { dir: join(homedir(), ".codebuddy", "projects"), encode: encodeCodebuddy },
];

const findProjectDir = (cwd: string): string | undefined => {
  for (const root of PROJECT_ROOTS) {
    const p = join(root.dir, root.encode(cwd));
    if (existsSync(p)) return p;
  }
  return undefined;
};

const latestJsonlByMtime = (projectDir: string): string | null => {
  const files = readdirSync(projectDir).filter((n) => n.endsWith(".jsonl"));
  if (files.length === 0) return null;
  return files
    .map((n) => ({ p: join(projectDir, n), m: statSync(join(projectDir, n)).mtimeMs }))
    .reduce((a, b) => (b.m > a.m ? b : a)).p;
};

const resolveCallerSession = ():
  | { sessionId: string; jsonlPath: string }
  | { error: string } => {
  // CodeBuddy exports CODEBUDDY_PROJECT_DIR / CODEBUDDY_SESSION_ID (native) and
  // also CLAUDE_PROJECT_DIR / CLAUDE_SESSION_ID (compat). Check native first so
  // a codebuddy session inside a claude project dir doesn't mis-resolve.
  const cwd = process.env.CODEBUDDY_PROJECT_DIR
    ?? process.env.CLAUDE_PROJECT_DIR
    ?? process.cwd();
  const projectDir = findProjectDir(cwd);
  if (!projectDir) return { error: `no claude project dir for cwd ${cwd}` };

  // Primary: env tells us exactly which session invoked us. Trust it
  // unconditionally — claude only writes the jsonl after the first user
  // message lands, so a fresh session (e.g. /clear-then-/wrc, or a brand-new
  // CLI window) will have envSid set but no file yet. The daemon's tail
  // tolerates a missing path (see mirror-bridge.ts attach()), and any
  // existsSync gate here would mis-route to a stale jsonl picked by mtime.
  const envSid = process.env.CODEBUDDY_SESSION_ID
    ?? process.env.CLAUDE_CODE_SESSION_ID
    ?? process.env.CLAUDE_SESSION_ID;
  if (envSid) return { sessionId: envSid, jsonlPath: join(projectDir, `${envSid}.jsonl`) };
  // Fallback: most-recently-written jsonl. Only reached when env is absent
  // (older claude versions, exotic launchers).
  const jsonlPath = latestJsonlByMtime(projectDir);
  if (!jsonlPath) return { error: `no .jsonl under ${projectDir}` };
  return { sessionId: basename(jsonlPath, ".jsonl"), jsonlPath };
};

// Resolve the current pane's tmux session name. `tmux display-message -p` runs
// against the tmux server pointed at by $TMUX (set in every process running
// inside tmux), so it returns the session containing *this* pane without us
// needing to pass a target. Returns undefined if not in tmux or query failed.
const detectTmuxSession = (): Promise<string | undefined> =>
  new Promise((resolve) => {
    if (!process.env.TMUX) return resolve(undefined);
    const p = spawn("tmux", ["display-message", "-p", "#{session_name}"], { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    p.stdout?.on("data", (c: Buffer) => (out += c.toString("utf8")));
    p.on("error", () => resolve(undefined));
    p.on("close", (code) => resolve(code === 0 ? out.trim() || undefined : undefined));
  });

const server = new McpServer(
  { name: "wezard", version: "0.0.1" },
  { capabilities: { tools: {} } },
);

// Accept user-friendly prefixes from the LLM: vid:<id> → user:<id>, chatid:<id> → chat:<id>.
// Pass anything else (already user:/chat:/group:, or empty) through unchanged.
const normalizeTarget = (raw: string | undefined): string | undefined => {
  if (!raw) return undefined;
  if (raw.startsWith("vid:")) return `user:${raw.slice(4)}`;
  if (raw.startsWith("chatid:")) return `chat:${raw.slice(7)}`;
  return raw;
};

server.registerTool(
  "wrc",
  {
    title: "WeCom remote control",
    description: "wecom remote control — attach the current agent session to a WeCom chat for live mirror push",
    inputSchema: {
      target: z
        .string()
        .optional()
        .describe(
          'Optional push target. Accepts "vid:<userid>" (DM), "chatid:<chatid>" (group), or raw "user:<id>"/"chat:<id>". Empty → use config defaultChat / mirror.pushChat.',
        ),
    },
  },
  async ({ target }) => {
    const r = resolveCallerSession();
    if ("error" in r) return fail(r.error);
    const normalizedTarget = normalizeTarget(target);
    // tmux sets $TMUX_PANE for every process inside a pane (e.g. `%5`); we
    // inherit it through claude → MCP child, so each /wrc auto-picks its own
    // pane without the user touching config. Pane ids are not stable across
    // tmux server restarts, so we also capture the session name — the daemon
    // uses it to re-derive a fresh paneId after reload, and as the "user wants
    // a tmux pane" signal that drives respawn when their pane dies.
    const tmuxPane = process.env.TMUX_PANE?.trim();
    const tmuxSession = tmuxPane ? await detectTmuxSession() : undefined;
    const { j } = await daemonPost("/mirror/attach", {
      sessionId: r.sessionId,
      jsonlPath: r.jsonlPath,
      ...(normalizedTarget ? { target: normalizedTarget } : {}),
      ...(tmuxPane ? { tmuxPane } : {}),
      ...(tmuxSession ? { tmuxSession } : {}),
    });
    return j.ok
      ? ok({ ok: true, sessionId: r.sessionId, target: j.target })
      : fail(`attach failed: ${(j.reason as string) ?? "unknown"}`);
  },
);

// set_workspace — one-shot project switch: the daemon applies the switch
// itself by walking the exact /new path — setPendingCwd → kill pane →
// respawn in the new cwd → attach → "📂 当前项目" push. NOTE: when the
// caller IS the chat's session being replaced (the common case), its own
// pane is killed mid-tool-call — the tool result never returns, and the
// project-info bubble in the chat is the receipt. On spawn failure the
// pendingCwd stays queued, so a manual /new from WeCom still completes
// the switch.
server.registerTool(
  "set_workspace",
  {
    title: "Switch workspace directory",
    description:
      "一步换掉这个 wizard 的**工作区**: 杀掉当前 pane, 在给定目录下重开一个全新的会话 —— 等价于往那个目录 `/new`。群里收到新会话的 📂 项目信息气泡当回执; 对话上下文**不会**带过去 (和 /new 一样是全新会话, 但身份的系统提示还在)。调用方就是被替换的那一个时, 它在调用当口就被终结 —— 这是预期行为, 群里那条气泡就是回执。用绝对路径 (或 `~` 开头)。想换目录又想保住手上的上下文: 先 wizard_handoff_self 把工作压成简报, 或者 spawn_clone({inherit:false, cwd}) 让一个分身去那边干。",
    inputSchema: {
      cwd: z.string().describe("Absolute project path, e.g. /Users/foo/projects/bar. ~ is expanded."),
      target: z
        .string()
        .optional()
        .describe(
          'Optional target override. "vid:<userid>" / "chatid:<chatid>" / raw "user:<id>"/"chat:<id>". Empty → derive from the calling session.',
        ),
    },
  },
  async ({ cwd, target }) => {
    const { sessionId, tmuxPane } = selfRef();
    const normalizedTarget = normalizeTarget(target);
    const { j } = await daemonPost("/mirror/workspace", {
      cwd,
      ...(normalizedTarget ? { target: normalizedTarget } : {}),
      ...(sessionId ? { sessionId } : {}),
      ...(tmuxPane ? { tmuxPane } : {}),
    });
    if (!j.ok) {
      const queued = j.pendingCwd ? ` (switch queued for ${j.pendingCwd as string} — send /new from WeCom to apply)` : "";
      return fail(`set_workspace failed: ${(j.reason as string) ?? "unknown"}${queued}`);
    }
    return ok({ ok: true, target: j.target, sessionId: j.sessionId, cwd: j.cwd });
  },
);

// 企业微信 doc / smartsheet / contact MCP 桥接。把 daemon 远端的 MCP 转发
// 给本地 Claude: list_tools 列工具, call_tool 调用 (创建文档 / 写表格 / 读
// 内容)。category 当前可选: "doc" | "smartsheet" | "contact"。
// 大模型先调 list_tools 看可用方法和入参 schema, 再 call_tool。
server.registerTool(
  "wecom_doc_list_tools",
  {
    title: "List WeCom doc/smartsheet tools",
    description:
      "List available WeCom MCP tools for a given category. Categories: 'doc' (online documents), 'smartsheet' (smart sheets), 'contact'. Returns tool names + JSON Schema. Call this BEFORE wecom_doc_call to discover method names and required arguments.",
    inputSchema: {
      category: z.string().describe("MCP category: 'doc' | 'smartsheet' | 'contact'."),
      requesterUserId: z
        .string()
        .optional()
        .describe(
          "WeCom userid that owns the resulting docs. Optional — daemon falls back to config.wedoc.requesterUserId or defaultChat. 'user:xxx' prefix accepted.",
        ),
    },
  },
  async ({ category, requesterUserId }) => {
    const r = await daemonPost("/wedoc/list", { category, ...(requesterUserId ? { requesterUserId } : {}) });
    return unwrap("wecom_doc_list_tools", r, (j) => j.result);
  },
);

server.registerTool(
  "wecom_doc_call",
  {
    title: "Call WeCom doc/smartsheet tool",
    description:
      "Invoke a specific WeCom MCP tool (after discovering it via wecom_doc_list_tools). Typical flow: list tools for 'doc' → pick a method like 'doc_create' → call it with args matching its inputSchema. Daily quota: 20 docs per requesterUserId.",
    inputSchema: {
      category: z.string().describe("MCP category: 'doc' | 'smartsheet' | 'contact'."),
      method: z.string().describe("Tool name from wecom_doc_list_tools (e.g. 'doc_create', 'smartsheet_add_records')."),
      args: z
        .record(z.string(), z.unknown())
        .optional()
        .describe("JSON object matching the tool's inputSchema. Empty object if the tool takes no params."),
      requesterUserId: z
        .string()
        .optional()
        .describe(
          "WeCom userid acting as document owner. Optional — daemon falls back to config / defaultChat. 'user:xxx' prefix accepted.",
        ),
    },
  },
  async ({ category, method, args, requesterUserId }) => {
    const r = await daemonPost("/wedoc/call", {
      category,
      method,
      args: args ?? {},
      ...(requesterUserId ? { requesterUserId } : {}),
    });
    return unwrap("wecom_doc_call", r, (j) => j.result);
  },
);

// ── Session discovery / switching (conversational) ─────────────────────────
// These let the WeCom-side Claude answer "列出所有 claude session" / "切到 xxx
// 那个" / "在 /path 下新建一个 session" in natural language. The daemon does the
// host-wide /proc + tmux scan (an MCP tool can only see its OWN session).
server.registerTool(
  "list_claude_sessions",
  {
    title: "List running agent sessions",
    description:
      "本机 tmux 里**所有**正在跑的 agent 会话 (claude / claude-internal / codebuddy 都算), 每个带一个稳定的动物 emoji、工作目录、tmux 位置和最近在干嘛的一行摘要。注意这是**机器级**的清单: 里面既有绑定了聊天的 wizard, 也有人在终端里自己开的、与企微无关的会话。用户说「列出所有 session」「有哪些会话在跑」「我想切换 session」时调它, 结果按 emoji + 目录 + 摘要 排成可读的编号列表, 并标出当前正被镜像的那个 (`current: true`)。只想看 wizard (名字/职责/家谱/忙闲) 用 wizard_roster。",
    inputSchema: {},
  },
  async () => {
    return unwrap("list_claude_sessions", await daemonGet("/sessions/list"));
  },
);

server.registerTool(
  "switch_claude_session",
  {
    title: "Switch WeCom mirror to another agent session",
    description:
      "把企微镜像**改接**到另一个已经在跑的会话上 —— 从此这个聊天镜像的、注入的都是它。换句话说: 让那个会话成为这个聊天的 wizard。用户挑了一个要切过去时调 —— 「切到 wezard 那个」「镜像第 2 个」「换到 🦊 那个会话」。先用 list_claude_sessions 把用户的自然语言指代 (emoji / 目录 / 话题) 解析成具体 sessionId, 再传进来。",
    inputSchema: {
      sessionId: z.string().describe("The target session's sessionId (a UUID), as returned by list_claude_sessions."),
    },
  },
  async ({ sessionId }) => {
    return unwrap("switch_claude_session", await daemonPost("/sessions/switch", { sessionId }));
  },
);

// ── wizard ↔ wizard (一个聊天里的同伴) ────────────────────────────────────
// 一个企微聊天里可以同时住着好几个 wizard, 每个用 `#tag` 寻址 (`#fix`、`#docs`…),
// 各自可以跑不同的 CLI / 模型 / 项目。它们互为同伴 (peer): 看得见彼此, 也驱动得动
// 彼此 —— 下面这组工具就是那条通路。本进程只看得见**自己**, 所以任何关于同伴的
// 问题都要问守护进程, 它才是持有全部 attachment 的那个。
//
// `selfRef` is how the daemon figures out which session is asking: sessionId
// from env (frozen at MCP spawn — goes stale after a `/clear`) plus TMUX_PANE
// (stable for the pane's lifetime), so one of the two always resolves.
const selfRef = (): { sessionId?: string; tmuxPane?: string } => {
  const sessionId =
    process.env.CODEBUDDY_SESSION_ID ??
    process.env.CLAUDE_CODE_SESSION_ID ??
    process.env.CLAUDE_SESSION_ID;
  const tmuxPane = process.env.TMUX_PANE?.trim();
  return { ...(sessionId ? { sessionId } : {}), ...(tmuxPane ? { tmuxPane } : {}) };
};

interface DaemonReply {
  j: Record<string, unknown>;
  status: number;
}

const daemonPost = async (path: string, body: Record<string, unknown>): Promise<DaemonReply> => {
  const resp = await fetch(`${DAEMON_BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...selfRef(), ...body }),
  });
  return { j: (await resp.json().catch(() => ({}))) as Record<string, unknown>, status: resp.status };
};

const daemonGet = async (path: string): Promise<DaemonReply> => {
  const resp = await fetch(`${DAEMON_BASE}${path}`);
  return { j: (await resp.json().catch(() => ({}))) as Record<string, unknown>, status: resp.status };
};

// Routes answer with either `reason` or `error`; `pick` narrows a payload that
// is nested rather than spread at the top level (wedoc's `result`).
const unwrap = (name: string, { j, status }: DaemonReply, pick: (j: Record<string, unknown>) => unknown = (x) => x) =>
  j.ok ? ok(pick(j)) : fail(`${name} failed: ${(j.reason ?? j.error ?? `http ${status}`) as string}`);

// 地址语法只有一套, 每个吃地址的工具都把它原样重述一遍: 模型单看一个 schema
// 时没有别的地方能学到它, 而猜出来的地址会安静地指向另一个 wizard 的终端。
const ADDRESS_DOC =
  "wizard 的地址。`''` = 本聊天的默认 wizard (没有 `#tag` 的那个)。裸 tag 如 `'fix'` = 本聊天的 `#fix`; 本聊天没有就退回到全机唯一的那个 `#fix`。`'daily#fix'` 直接指名聊天 —— 跨聊天可靠的形式, 也是好几个聊天各有一个 `#fix` 时唯一有效的形式; 裸聊天名 `'daily'` = 那个聊天的默认 wizard。**心里想的是别的聊天里那个 wizard, 就别图省事传裸 tag** —— 如果你自己这个聊天里恰好也有个同名 `#tag`, 裸 tag 会不声不响地先命中它, 活派错了地方也不报错; 目标是某个**特定**聊天就永远写 `聊天名#tag`。永远别自己拼: wizard_roster / list_peers / list_chats 返回的 `address`, 或 spawn_clone 409 里的 `address`, 就是要原样传回来的那个串。";

// 造一个 wizard 是本地操作, 不是全局操作: 它落在调用方自己的聊天里 (所以走
// `selfRef`), 带自己的 `#tag`; 或者 —— 给了 `chat` —— 落在另一个**起过名字**的
// 聊天里, 这正是给聊天起名换来的东西。
server.registerTool(
  "new_claude_session",
  {
    title: "Spawn a blank new wizard",
    description:
      "在指定项目目录下长出一个**全新的 wizard** —— 自己的 tmux pane、自己的 `#tag` 地址, 默认活在你这个聊天里, 等价于人在群里敲 `/new #tag`。它**不继承任何上下文**(白纸一张): 要一个开局就带着你读过的材料的分身, 用 spawn_clone({inherit:true})。新 wizard 在群里说话时气泡头是 `emoji #tag`, 之后用 wizard_roster / peek_peer / send_peer / wait_peer 驱动它。用户说「在 /path 下新建一个会话」「帮我在 xxx 目录起个 agent」时调它。给 `chat` 就把它生在**另一个**聊天里(「在 daily 群里开一个 #ingest 跑这个目录」)—— 那个聊天必须起过名字(list_chats 能看到); 这是让一个还不存在的跨群协作者就位的办法, 不必让人跑去那边手敲 `/new`。目录不存在会自动创建。绝不会顶掉一个聊天的默认 wizard。",
    inputSchema: {
      cwd: z.string().describe("Absolute project path to start the new session in, e.g. /Users/foo/projects/bar. Created if missing."),
      tag: z
        .string()
        .optional()
        .describe("新 wizard 的 tag, 不带 '#' (如 'fix'、'docs') —— 它既是地址也是名字, 挑一个说明它干什么的短词, 之后用它 send_peer / peek_peer。目标聊天里不能重名 —— 不确定先 list_peers / list_chats。省略则按目录名生成。"),
      chat: z
        .string()
        .optional()
        .describe("把它生在哪个聊天里 (list_chats 里显示的名字)。省略 = 你自己的聊天, 用户绝大多数时候指的就是这个。只有**起过名字**的聊天能被指名 —— 没名字就没有地址, 得先有人在那边发一次 `/name <名字>`。"),
      cli: z
        .enum(["claude", "claude-internal", "codebuddy"])
        .optional()
        .describe("用哪个 CLI 启动。用户没点名就省略, 它会继承那个聊天当前的后端。多个后端可以并存。"),
      model: z
        .string()
        .optional()
        .describe("这个 wizard 跑在哪个模型上, 口语化随便写 ('opus' / 'sonnet' / '最新的 opus' / 'claude-sonnet-5' 都行) —— 不是直接塞给启动参数, 而是等 pane 起来后真的敲 `/model` 校验, 认不出就翻一遍这台 CLI 此刻的目录再重试, 所以返回里的 `model` 才是真正落地的那个, 可能跟你传的字符串不完全一样; 万一没匹配上会带 `modelWarning`, 那时 wizard 还在跑但停在了原来的模型上, 不是失败。省略用该 CLI 的默认。同一个聊天里的 wizard 可以各跑各的模型 —— 又长又要判断的活给 opus, 跑腿的 lint/grep 给 haiku。"),
      keepalive: z
        .boolean()
        .optional()
        .describe("这个 wizard 要不要被 keepalive 心跳保温 (空闲时定期 ping 一下防 prompt cache 过期)。false = 永远不保温, 省下那份 ping 的钱 —— 适合跑腿一次就收工的临时会话; true = 明确要保温。省略则按 daemon 配置的默认值。"),
    },
  },
  async ({ cwd, tag, chat, cli, model, keepalive }) =>
    unwrap("new_claude_session", await daemonPost("/sessions/new", {
      cwd,
      ...(tag ? { tag } : {}),
      ...(chat ? { chat } : {}),
      ...(cli ? { cli } : {}),
      ...(model ? { model } : {}),
      ...(keepalive !== undefined ? { keepalive } : {}),
    })),
);

// ── Chat naming (the cross-chat address space) ─────────────────────────────
// A WeCom chat's identity is an unreadable `chat:wrkS…` id, so before naming,
// the ONLY way to reach across chats was a tag that happened to be globally
// unique. A name turns the chat into a token a human can type and an agent can
// pass, which is what makes `daily#fix` — and spawning into `daily` — possible.
server.registerTool(
  "name_chat",
  {
    title: "Name this WeCom chat",
    description:
      "给**这个聊天**起个短名字, 别的聊天里的 wizard 从此能以 `名字#tag` 叫到这里、也能把新 wizard 生进来。没起过名字的聊天不会一直没名字 —— 第一次有人用到名字时 (名册 / 聊天列表 / 分身出生) 守护进程按它的工作区自动补一个 (`~/develop/foo` → `foo`, 撞名加序号), 所以这个工具的用途是**起一个更好的名字**, 而不是从无到有。聊天的名字同时就是这里默认 wizard 的名字 —— 所以 `wizard_identity({name})` 在默认 wizard 身上会连带写这里。用户说「给这个群起名叫 daily」「这个群叫什么」(不传 `name` 就是读) 「取消命名」(传 '-') 时调它。名字全机唯一、大小写不敏感; 改名即覆盖, 照着旧名字写的地址从此解析不到。起完名告诉用户别的聊天该怎么写地址 (`名字#tag`)。",
    inputSchema: {
      name: z
        .string()
        .optional()
        .describe("The new name: 1-32 chars, letters/digits/'_'/'-' only (no spaces, '#', '/', ':'). Omit to read the current name without changing it. Pass '-' to remove the name."),
    },
  },
  async ({ name }) =>
    name === undefined
      ? unwrap("name_chat", await daemonPost("/chats/list", {})) // read-only path: roster carries this chat's name
      : unwrap("name_chat", await daemonPost("/chats/name", { name })),
);

server.registerTool(
  "list_chats",
  {
    title: "List every chat and its sessions",
    description:
      "跨聊天目录: 守护进程知道的每一个企微聊天、它的名字 (空 = 没起名)、是不是你住的那个 (`self`), 以及每个聊天里住着哪些 wizard 及其 `address`。用户指向这个聊天之外的活时调它 —— 「别的群有谁在跑」「把这个交给 daily 群」「在 sanitizer 群里开个会话」—— 或者一个地址解析失败、你需要真正的那个串时。没起名的聊天既寻址不到也生不进去; 要用它, 得有人在那个群里发一次 `/name <名字>`。",
    inputSchema: {},
  },
  async () => unwrap("list_chats", await daemonPost("/chats/list", {})),
);

server.registerTool(
  "list_peers",
  {
    title: "List the wizards sharing this chat",
    description:
      "和你住在**同一个聊天**里的其他 wizard。一个聊天里住着一个默认 wizard 加任意多个 `#tag` wizard (`#fix`、`#review`…), 各有各的 pane、CLI、模型和工作区。每一个返回: tag、要传给其他工具的 `address`、emoji、工作区、CLI、pane 是否还活着、此刻是否在生成 (`busy`)、最后动过是什么时候、最近在聊什么的一行摘要; `self: true` 是你自己。另外返回 `foreignPeers`: 别的聊天里你**叫得动**的 wizard —— 要么它的 `#tag` 全机唯一, 要么它的聊天有名字, 那时 `address` 是 `聊天名#tag` 的完整形式。地址一律原样回传, 别自己拼。用户提到另一个 agent 或某个 tag 时先调它 —— 「#fix 进展如何」「还有谁在跑」「让 #docs 也看看」—— 再用 peek_peer / send_peer / wait_peer 真正协作。想连**名字、职责、家谱**一起看 (谁是谁生的、它是干什么的), 用 wizard_roster; 想看还没有 wizard 的聊天, 用 list_chats。",
    inputSchema: {},
  },
  async () => unwrap("list_peers", await daemonPost("/peers/list", {})),
);

server.registerTool(
  "peek_peer",
  {
    title: "Read what another wizard has been saying",
    description:
      "**不打扰**地观察另一个 wizard: 返回 `dialog` —— 它最近 N 轮真实对话 (从它的 transcript 读的, `▸` 是别人说的, `◂` 是它答的), 外加它此刻是否在生成 (`busy`) 与它最后一条完整回复 (`lastText`)。这是「它和驱动它的人到底说了什么」的可读记录: 回答「#fix 进展如何」「它们聊到哪了」, 或者判断要不要推它一把, 都读这里。用户消息里写的 `#tag` 指的就是那个 wizard —— 守护进程会在消息尾部挂一条 system-reminder 点名每一个解析得出的 tag, 所以 prompt 里的 `#b` 是 wizard `b`: 去 peek 它, 别猜它在干嘛, 更别替它回答。它还没有可读 transcript 时, `pane` 兜底给它终端的原始尾巴。`foreign: true` 表示这个 tag 落在别的聊天里。只读, 随便轮询。",
    inputSchema: {
      tag: z.string().describe(ADDRESS_DOC),
      turns: z.number().optional().describe("How many recent conversation turns to return (1-40, default 6)."),
    },
  },
  async ({ tag, turns }) => unwrap("peek_peer", await daemonPost("/peers/peek", { tag, ...(turns ? { turns } : {}) })),
);

server.registerTool(
  "send_peer",
  {
    title: "Say something to another wizard",
    description:
      "跟另一个 wizard 说话 —— 文本原样落进它的输入框, 它当成新的一轮接手。这是你**驱动**同伴的唯一方式: 派活、解它的阻塞、回答它的提问、叫它继续。「推动 #fix 干到底」的典型循环: peek_peer 看它在哪 → send_peer 说该说的 → wait_peer 等它停下 → 再 peek。跨聊天同理: 目标 wizard 住在别的群, 用全机唯一的 tag 或 `聊天名#tag` 寻址, 守护进程自己路由。对方还不存在就自己造: 要它继承你的上下文用 spawn_clone, 要一个白纸一张的新 wizard 用 new_claude_session。\n" +
      "**这条消息会以 `你 → 它` 的气泡出现在群里, 人看得见**。所以直说: 要什么、给什么、结论是什么, 不用寒暄、不用引用原文、不用复述它刚说过的话。拒绝对自己发送。",
    inputSchema: {
      tag: z.string().describe(ADDRESS_DOC),
      text: z.string().describe("Message to inject. Plain prompt text; slash commands like '/clear' also work."),
      when: z
        .enum(["now", "idle"])
        .optional()
        .describe(
          "什么时候投。`now` (默认) 立刻投 —— 对方正在生成时这句话会排在它这一轮后面, 回答它的提问、打断它、催它都该用这个。`idle` 先等它闲下来再投: **派一件新活给一个正在忙的同伴时用它**, 否则你和别人的两段文本会挤进同一个输入框被当成一轮读掉。返回里的 `wasBusy` 告诉你投的时候它忙不忙。",
        ),
      waitSec: z.number().optional().describe("`when:'idle'` 最多等多少秒 (10-3600, 默认 600)。等不到就返回失败, 不会强行投。"),
      job: z.string().optional().describe("这次派活归到某个工单名下 (open_job 给的 id) —— 不再单独出气泡, 攒进 close_job 那一条。"),
    },
  },
  async ({ tag, text, when, waitSec, job }) =>
    unwrap("send_peer", await daemonPost("/peers/send", { tag, text, ...(when ? { when } : {}), ...(waitSec ? { waitSec } : {}), ...(job ? { job } : {}) })),
);

server.registerTool(
  "notify",
  {
    title: "Post a message into a chat for people to read",
    description:
      "把一段 markdown 贴进一个企微聊天**给人看**。和 send_peer 分工明确: send_peer 是把话塞进另一个 agent 的输入框 (驱动它干活), notify 是说给人听 —— 不会触发任何一轮对话。\n" +
      "`to` 省略 = 自己所在的聊天 (等于你正常回复, 只是不用等这一轮结束就能先播一条); 要发到别的群就写聊天名 (`list_chats` 里那个), 一次可以写多个。跨群时气泡头自动写成 `源聊天#你` 并挂上你的 chat 详情页链接, 那边的人一眼知道是谁从哪说过来的。\n" +
      "什么时候用: 长活跑完了要通知另一个群的人; 一批分身收工后把汇总播给发起那个群; 定时任务 (schedule_task) 到点跑完把结论送到该看的人那里。别拿它跟同群的人说话 —— 那是你的正常回复。",
    inputSchema: {
      to: z
        .array(z.string())
        .optional()
        .describe("收件聊天。**任何一种地址都收**: 聊天名 (`daily`)、裸 principal (`chat:wr…` / `user:…`), 以及 wizard_roster / list_peers 给的那个 wizard 地址 (`daily#fix`、`chat:wr…#fix`) —— 后者会自动落到它所在的那个聊天, 所以「知道某个 wizard 叫什么」就等于「能往它那个群里说话」, 哪怕那个群没起过名字。省略 = 自己所在的聊天。认不出的整条拒绝并列出来, 不会部分送达。"),
      markdown: z.string().describe("正文, markdown。头 (是谁发的) 由守护进程自动加, 别自己写。"),
    },
  },
  async ({ to, markdown }) => unwrap("notify", await daemonPost("/notify", { ...(to ? { to } : {}), markdown })),
);

server.registerTool(
  "wait_peer",
  {
    title: "Wait until another wizard stops working",
    description:
      "挂起, 直到点名的 wizard 停下来 (它的终端不再显示中断提示), 然后返回它最新的回复。send_peer 之后就该用它 —— 这样你拿到的是写完的答案, 而不是写了一半的。超时先到则返回 `idle: false` 与原因: 它只是还在干, 你可以 peek 一眼再等。很便宜: 守护进程轮询的是 pane, 不烧 token。同一个聊天里它的回复本来就会以它自己的气泡出现在群里, 所以你拿到结论后**别再复述一遍**, 只说你据此做了什么。\n" +
      "**派了一批活就用 `tags` 一次等一组**, 别一个一个等: 它们本来在同时干活, 串行等的墙钟是所有人之和, 并行等只等最慢的那一个。`results` 按你给的顺序逐个回 `idle` / `lastText`。`need` 决定满几个就返回 (默认全部; `need:1` = 谁先完事就先处理谁, 剩下的还在跑, 再调一次接着等)。",
    inputSchema: {
      tag: z.string().optional().describe(`${ADDRESS_DOC} 等一组时改用 \`tags\`。`),
      tags: z
        .array(z.string())
        .optional()
        .describe("一次等多个 wizard 的地址 (最多 16 个), 每个的写法同 `tag`。fan-out 之后的 join 用它 —— 五个分身并行等只花最慢那一个的时间。"),
      need: z
        .number()
        .optional()
        .describe("满几个就返回 (1 到地址个数, 默认全部)。`1` = 任意一个先完事就返回; 中间值 = 法定人数。满足后剩下的等待会被撤掉, 它们照常继续干活, 结果里 `idle:false`。"),
      timeoutSec: z.number().optional().describe("Max seconds to wait (10-7200, default 900)."),
    },
  },
  async ({ tag, tags, need, timeoutSec }) =>
    unwrap("wait_peer", await daemonPost("/peers/wait", {
      ...(tags?.length ? { tags } : { tag: tag ?? "" }),
      ...(need ? { need } : {}),
      ...(timeoutSec ? { timeoutSec } : {}),
    })),
);

server.registerTool(
  "run_agent_graph",
  {
    title: "Run a loop graph over several tagged agents",
    description:
      "把这个聊天里的几个 wizard 串成一条**会循环的流水线**, 交给守护进程去驱动。`nodes` 是参与的 `#tag` wizard (每个可以自选 cli / 模型 / 工作区; 不存在的当场造出来, 已经在跑的原样复用、上下文不动)。`steps` 是有序管线 —— 每一步向一个 wizard 发一段提示、等它干完、抓住它的回复、喂给下一步。整张 step 表会被走 `rounds` 遍, 这才叫**循环**: `fix → review → fix → review …` 直到某个回复里出现 `until` 或轮次用完。提示模板可以引用前面的产出: `{{last}}` = 上一步的回复, `{{<tag>}}` = 那个 wizard 最新的回复, `{{round}}` = 第几轮。立刻返回 runId 并把进度播报进群; 用 graph_status 查、stop_graph 停。用户要「几个 agent 互相评审/迭代到收敛」时用它。只是推一个 wizard 一把, 用 send_peer + wait_peer。要它们开局就共享同一批材料, 先 spawn_clone 出这些节点再跑图。",
    inputSchema: {
      nodes: z
        .array(
          z.object({
            tag: z.string().describe("wizard 的 tag, 不带 '#', 如 'fix'。"),
            cli: z.enum(["claude", "claude-internal", "codebuddy"]).optional().describe("这个 wizard 用哪个 CLI。省略则继承本聊天的。"),
            model: z.string().optional().describe("要现造这个 wizard 时跑在哪个模型上, 口语化随便写 ('opus' / 'haiku' / '最新的 opus' 都行) —— 起来后会用 `/model` 实测校验。已经在跑的不受影响。"),
            cwd: z.string().optional().describe("这个 wizard 的工作区绝对路径。省略则继承本聊天的。"),
          }),
        )
        .describe("参与的 wizard。每个 step 的 `to` 都必须点到这里面的某个 tag。"),
      steps: z
        .array(
          z.object({
            to: z.string().describe("这一步驱动哪个 wizard 的 tag。"),
            prompt: z.string().describe("Prompt template. Supports {{last}}, {{<tag>}}, {{round}}."),
          }),
        )
        .describe("Ordered pipeline, replayed once per round."),
      rounds: z.number().optional().describe("How many times to walk the step list (1-50, default 1). >1 makes it a genuine loop."),
      until: z.string().optional().describe("Case-insensitive substring; when a node's reply contains it the run stops early and reports 'converged'. E.g. 'LGTM' or 'DONE'."),
      idleTimeoutSec: z.number().optional().describe("Per-step ceiling on waiting for a node to finish (30-7200, default 900). A timeout is reported but the graph keeps walking."),
    },
  },
  async ({ nodes, steps, rounds, until, idleTimeoutSec }) =>
    unwrap(
      "run_agent_graph",
      await daemonPost("/graph/run", {
        nodes,
        steps,
        ...(rounds ? { rounds } : {}),
        ...(until ? { until } : {}),
        ...(idleTimeoutSec ? { idleTimeoutSec } : {}),
      }),
    ),
);

server.registerTool(
  "graph_status",
  {
    title: "Inspect running / finished agent graphs",
    description:
      "看 run_agent_graph 起的流水线跑到哪了: 每一步的轮次、目标 wizard、状态 (running / done / timeout / error) 以及每个 wizard 交出来的回复。不给 runId 就列出本聊天的全部。注意图只活在守护进程内存里 —— reload 会把它清掉 (wizard 本身还活着)。",
    inputSchema: {
      runId: z.string().optional().describe("Run id from run_agent_graph. Omit to list all runs for this chat."),
    },
  },
  async ({ runId }) => {
    const qs = runId ? `?runId=${encodeURIComponent(runId)}` : "";
    return unwrap("graph_status", await daemonGet(`/graph/status${qs}`));
  },
);

server.registerTool(
  "stop_graph",
  {
    title: "Cancel a running agent graph",
    description:
      "在当前这一步之后停掉流水线。**不会**打断正在生成的那个 wizard —— 它把话说完, 之后不再派新的步骤。用户说「别跑了」时用。要立刻打断某个 wizard 用 stop_wizard({mode:'interrupt'})。",
    inputSchema: { runId: z.string().describe("Run id from run_agent_graph.") },
  },
  async ({ runId }) => unwrap("stop_graph", await daemonPost("/graph/stop", { runId })),
);

server.registerTool(
  "handoff",
  {
    title: "Hand another wizard's work over to a fresh context",
    description:
      "给**另一个** wizard 做交接, 原地完成: 守护进程让它把当前工作压成一份自洽的交接简报, 等它写完抓取, 再往**同一个 pane** 注入 `/clear` (上下文清零、新 sessionId、cwd 不变、身份的系统提示还在), 然后把简报作为新会话的第一条消息贴回去。它的上下文撑不住了、或者用户说「让 #fix 交接一下」「叫它压缩上下文重开」时用。按 tmux `pane` id (`%5`, 来自 wizard_roster / list_claude_sessions) 或按 `tag` 寻址。**要交接的是你自己就用 wizard_handoff_self** —— 这里拒绝对自身操作 (会死锁: 你没法在自己生成的当口再被问一次)。返回被带过去的那份简报。",
    inputSchema: {
      pane: z.string().optional().describe("目标 tmux pane id, 如 '%5'。优先于 tag。从 wizard_roster / list_claude_sessions 拿。"),
      tag: z.string().optional().describe("wizard 的 tag, 不带 '#'。空串 = 本聊天的默认 wizard。非空时先找本聊天, 找不到再退回全机唯一的那个。给了 pane 就忽略它。"),
      focus: z.string().optional().describe("交接简报里要特别交代的点, 如 '重点交代还没跑通的测试'。可选。"),
      timeoutSec: z.number().optional().describe("Max seconds to wait for the summary before aborting (30-7200, default 600)."),
    },
  },
  async ({ pane, tag, focus, timeoutSec }) =>
    unwrap(
      "handoff",
      await daemonPost("/handoff", {
        ...(pane ? { pane } : {}),
        ...(tag !== undefined ? { tag } : {}),
        ...(focus ? { focus } : {}),
        ...(timeoutSec ? { timeoutSec } : {}),
      }),
    ),
);

// 定时任务 —— 到点把一句话说给一个 wizard 听。和人在群里 at 它说同一句话完全等价:
// pane 死了会被拉起来, 它干完的活照常出现在群里和详情页。这是 claude/codebuddy 自带
// 定时器给不了的那一半: 它们的循环活在会话里, 会话一死就没了; 这个活在 daemon 里。
server.registerTool(
  "schedule_task",
  {
    title: "Schedule a prompt to run in a wizard session, on a recurring or one-off schedule",
    description:
      "给某个 wizard 排一个**到点自动执行**的活: 到时间了, daemon 把 `prompt` 原样说给它听 —— 等价于那一刻有人在群里对它说了这句话, 所以它会真的去做, 产出照常落在群里。守护进程级, 跨 CLI 重启/会话结束仍在, 目标 pane 死了会被自动拉起来。用户说「每个工作日晚上 9:30 自动跑一下 xxx」「每天早上帮我看看 yyy」「每 2 小时同步一次 zzz」「明早 9 点提醒并整理 www」时调它。\n`when` 用人话原样写, 别自己翻译成 cron: 「每个工作日晚上9:30」「每天 8:00」「每周三下午3点」「每隔两小时」「每 30 分钟」「20 分钟后」「明早 9 点」都认。解析不出会报错并列出能认的说法 —— 这时把原话回给用户让他重说, 别自己猜一个时间存进去。\n存成功后**必须把回显的 `when` 和 `next` 念给用户**确认 (例: 「每个工作日 21:30, 下次 2026-09-21 21:30」)。`prompt` 要写成一句完整的、零上下文也能执行的指令 —— 到点时那个会话可能早已 /clear 过, 它只看得见这句话。",
    inputSchema: {
      when: z.string().describe("什么时候跑, 人话原样传: 「每个工作日晚上9:30」「每天早上9点」「每周三下午3点」「每隔2小时」「每30分钟」「20分钟后」「明早9点」。"),
      prompt: z.string().describe("到点要说给那个 wizard 听的话。写成自洽的完整指令 (要做什么、在哪个目录/文件上、做完怎么汇报), 别依赖当前对话的上下文。"),
      tag: z.string().optional().describe(`排给谁干。省略 = 排给你自己 (最常见: 给自己定一个夜里跑的活)。${ADDRESS_DOC}`),
      note: z.string().optional().describe("给人看的一句话备注, 只在 list_tasks 里回显。"),
    },
  },
  async ({ when, prompt, tag, note }) =>
    unwrap("schedule_task", await daemonPost("/tasks/schedule", { when, prompt, tag: tag ?? "", note: note ?? "" })),
);

server.registerTool(
  "list_tasks",
  {
    title: "List scheduled tasks on this host",
    description:
      "列出本机所有定时任务: `id` (取消要用)、`when` (人话回显)、`next` (下次触发时刻)、`lastFired`、目标 wizard 的 `address` 与 `prompt`。用户问「有哪些定时任务」「我设了什么定时」「下次什么时候跑」时调它。只读。`mine:true` 只看排给你自己的。",
    inputSchema: {
      mine: z.boolean().optional().describe("true = 只列排给调用方自己的任务。默认列全机。"),
    },
  },
  async ({ mine }) => unwrap("list_tasks", await daemonPost("/tasks/list", { mine: mine === true })),
);

server.registerTool(
  "cancel_task",
  {
    title: "Cancel one scheduled task by id",
    description:
      "按 id 删掉一条定时任务 (id 从 list_tasks 拿)。用户说「取消那个定时」「别再每天跑了」时调它: 先 list_tasks 把候选念给用户确认是哪一条, 再删。删的是日程本身, 不影响任何正在跑的活。",
    inputSchema: {
      id: z.string().describe("Schedule id from list_tasks."),
    },
  },
  async ({ id }) => unwrap("cancel_task", await daemonPost("/tasks/cancel", { id })),
);

// ── Config ──────────────────────────────────────────────────────────
server.registerTool(
  "config_set",
  {
    title: "Wezard config",
    description:
      "Read or modify wezard daemon configuration. Supported keys: allow_from (add/remove authorized chats/users), approval_window (auto-approve window minutes), approval_cache (session decision cache minutes), danger_skip (auto-allow ONLY calls hitting the danger list), danger_skip_all (skip ALL approvals), danger_enabled (toggle danger detection), approval_mode (all|danger), cwd (default workspace), default_chat (outbound target), log_level (trace|debug|info|warn|error), slash_ack_first_line (/clear & /new acks reply first line only, no project info/tip). Use action='add'/'remove' for array keys (allow_from), 'set' for scalars. Keywords: 设置、配置、cfg、wezard、allowFrom、授权、自动通过、时间窗口、danger skip、跳过审批、workspace、回执精简、斜杠命令简洁.",
    inputSchema: {
      key: z
        .enum(["allow_from", "approval_window", "approval_cache", "danger_skip", "danger_skip_all", "danger_enabled", "approval_mode", "cwd", "default_chat", "log_level", "slash_ack_first_line"])
        .describe("Config key to read or modify."),
      value: z
        .string()
        .optional()
        .describe("New value. Omit to read current value. For booleans: 'true'/'false'. For arrays with action=set: JSON array string."),
      action: z
        .enum(["set", "add", "remove"])
        .optional()
        .describe("For array keys (allow_from): 'add' appends, 'remove' deletes an item. Scalars always use 'set'. Default: 'set'."),
    },
  },
  async ({ key, value, action }) => {
    if (value === undefined) {
      return unwrap("config_set", await daemonPost("/config/get", { key }));
    }
    return unwrap("config_set", await daemonPost("/config/set", { key, value, action: action ?? "set" }));
  },
);

// ── Wizard: 会话的身份 ─────────────────────────────────────────────────────
// 一个绑定到聊天的会话就是一个 wizard —— 有名字、有工作区、有职责、有记忆、能生
// 分身。这些工具是它认识自己、认识同伴、以及扩编/收编的全部入口。身份本身在
// spawn 时已经写进了系统提示, 所以这里回答的是"此刻"的部分: 上下文用到哪了、
// 分身还剩几个、别人是谁。
server.registerTool(
  "wizard_whoami",
  {
    title: "Who am I",
    description:
      "你自己是谁: 名字、地址 (别人用它找你)、所在聊天、工作区、职责、记忆、家谱 (谁生的你、你生了谁), 以及此刻的 contextTokens 与 handoffSuggested。用户问「你是谁」「你叫什么」「你在哪个目录」「你有几个分身」时先调它; 要做任何编排之前也先调它 —— 你得知道自己的工作区在哪、手里已经有哪些分身。handoffSuggested=true 表示上下文该交接了 (见 wizard_handoff_self)。",
    inputSchema: {},
  },
  async () => unwrap("wizard_whoami", await daemonPost("/wizard/whoami", {})),
);

server.registerTool(
  "wizard_identity",
  {
    title: "Name yourself / declare your job",
    description:
      "给自己起名字、写职责。名字就是别人喊你的那个词: 你若是聊天的默认会话, 起名同时给这个聊天起名 (等价于 /name), 别的聊天从此能以 `名字#tag` 找到这里; 你若是带 tag 的分身, 名字只属于你自己。职责是一句话的「我是干什么的」—— 别的 wizard 在名册里读到它, 据此决定该不该找你。用户说「你以后叫 X」「这个群叫 X」「你负责 X」时调它; 你自己发现 whoami 里名字或职责是空的, 也应当主动补上。只传要改的那个字段。",
    inputSchema: {
      name: z.string().optional().describe("新名字, 1-32 位字母/数字/`_`/`-`, 全机唯一 (默认会话的名字即聊天名)。不改就别传。"),
      description: z.string().optional().describe("一句话职责, 例如 '盯 wezard 主仓的重构与发版'。不改就别传。"),
    },
  },
  async ({ name, description }) =>
    unwrap("wizard_identity", await daemonPost("/wizard/identity", {
      ...(name !== undefined ? { name } : {}),
      ...(description !== undefined ? { description } : {}),
    })),
);

server.registerTool(
  "wizard_roster",
  {
    title: "Every wizard and clone",
    description:
      "这个世界上所有的 wizard 与 clone: 每一个的名字、地址、**所在聊天**、**工作区**、职责、忙闲 (busy)、是否还活着 (alive)、最近在干嘛 (summary), 以及家谱 (parent / clones / ancestors)。跨聊天的也在里面。这是你感知同伴的唯一入口 —— 用户说「还有谁在跑」「谁在弄那个项目」「让懂 X 的那个来看看」时先调它, 拿到目标的 `address` 再 send_peer / peek_peer / wait_peer; 要往它**所在的群里对人说话**则把它的 `address` (或 `chat`) 交给 notify。\n" +
      "**这是一张索引, 不是一份名单**: 整台机器上可能有几百个会话, 所以默认只回最相关的一页 (自己 → 活着的 → 最近动过的), 并告诉你 `total` / `matched` 有多少。找人就带上条件: `query` 匹配名字/职责/地址, `cwd` 匹配工作区路径 (「谁在这个目录里干活」), `chat` 限定某个聊天, `alive:true` 只看还活着的。别不带条件硬拉全表。",
    inputSchema: {
      query: z.string().optional().describe("在名字 / 职责 / 地址 / target 里做子串匹配 (不分大小写)。「让懂 X 的那个来看看」就把 X 写在这里。"),
      chat: z.string().optional().describe("只看某个聊天里的 wizard: 聊天名, 或者聊天 principal 的一段 (无名聊天用它)。"),
      cwd: z.string().optional().describe("只看工作区路径包含这一段的 wizard —— 「谁在 /path 下干活」的反查。"),
      alive: z.boolean().optional().describe("true = 只看 pane 还活着的。默认全给 (冷会话发消息就会被唤醒)。"),
      limit: z.number().optional().describe("最多回多少条 (1-300, 默认 40)。"),
    },
  },
  async ({ query, chat, cwd, alive, limit }) =>
    unwrap("wizard_roster", await daemonPost("/wizard/roster", {
      ...(query ? { query } : {}),
      ...(chat ? { chat } : {}),
      ...(cwd ? { cwd } : {}),
      ...(alive ? { alive } : {}),
      ...(limit ? { limit } : {}),
    })),
);

server.registerTool(
  "spawn_clone",
  {
    title: "Spawn a clone of yourself",
    description:
      "生一个分身 —— 一个新的 wizard, 活在同一个聊天 (或指名的另一个聊天) 里, 有自己的 tmux pane、自己的 `#tag` 地址、自己的职责, 归你管。\n" +
      "`inherit` 必填, 它决定这是哪一种分身:\n" +
      "• inherit=true —— **fork 你此刻的上下文**: 它开局就拥有你已经读过的一切 (规范、目录结构、刚啃完的那份文档), 不必重读。代价是它必须留在你当前的工作区 (换 cwd 会自动退化成 false)。这是编排一组「共享同一批材料」的任务的正确姿势: 你先把公共材料读进自己的上下文, 再 fork 出 N 个分身, 材料只读一遍却进了 N 份上下文。\n" +
      "• inherit=false —— 空白分身: 只继承身份, 不继承上下文。适合干一件与你手头无关的事, 或者要在别的目录/别的聊天里干活。\n" +
      "带上 `task` 可以在它就位的同时把第一件活派下去, 省掉一次 send_peer。之后用 send_peer 继续派活、wait_peer 等它做完、stop_wizard 收掉它。分身自己也能再 spawn_clone, 层级不限。分身是有成本的 (一个 pane + 一份上下文), 任务少于两三件时你自己做完更快。",
    inputSchema: {
      inherit: z
        .boolean()
        .describe("true = fork 你此刻的上下文 (它开局就有你读过的材料, 必须留在同一工作区); false = 空白分身, 只继承身份。必填, 没有默认值。"),
      description: z.string().describe("这个分身负责什么, 一句话。它会写进分身的系统提示, 也会出现在名册里让别人看到。"),
      tag: z.string().optional().describe("分身的地址 tag, 不带 '#' (如 'docs'、'fix')。同一聊天内不能重名。省略则按 description 首词生成。"),
      task: z.string().optional().describe("就位后立刻派下去的第一件活。省略则它就位待命。"),
      cwd: z.string().optional().describe("分身的工作区绝对路径。只在 inherit=false 时有意义 —— 换目录与继承上下文互斥。"),
      chat: z.string().optional().describe("把分身生在另一个聊天里 (list_chats 里的名字)。省略 = 你自己的聊天, 这是绝大多数情况。"),
      cli: z.enum(["claude", "claude-internal", "codebuddy"]).optional().describe("分身用哪个 CLI。省略则继承。"),
      model: z.string().optional().describe("分身跑在哪个模型上, 口语化随便写 ('opus' / 'sonnet' / '最新的 opus' / 'claude-sonnet-5' 都行) —— 不是直接塞给启动参数, 而是等 pane 起来后真的敲 `/model` 校验, 认不出就翻一遍这台 CLI 此刻的目录再重试, 所以返回里的 `model` 才是真正落地的那个, 可能跟你传的字符串不完全一样; 万一没匹配上会带 `modelWarning`, 那时分身还在跑但停在了原来的模型上, 不是失败。省略用该 CLI 的默认。分身可以和你跑在不同模型上: 要判断力的那一路给 opus, 跑腿的 (grep、跑测试、照着清单改) 给 haiku —— 一批分身不必齐步走。"),
      job: z
        .string()
        .optional()
        .describe("把这个分身归到某个工单名下 (open_job 给的 id)。归了工单的分身出生/派活不再逐条出气泡 —— 五路 fan-out 就是十条交叉气泡, 人读不出结构; 它们攒到 close_job 那一条里一起交代, 过程照旧在各自的详情页。close_job 还会把它们整批回收掉。"),
      keepalive: z
        .boolean()
        .optional()
        .describe("这个分身要不要被 keepalive 心跳保温 (空闲时定期 ping 一下防 prompt cache 过期)。false = 永远不保温, 省下那份 ping 的钱 —— 适合跑腿一次就收工的临时分身; true = 明确要保温 —— 适合会长期挂着、随时可能被叫醒接手的分身。省略则按 daemon 配置的默认值。"),
    },
  },
  async ({ inherit, description, tag, task, cwd, chat, cli, model, job, keepalive }) =>
    unwrap("spawn_clone", await daemonPost("/wizard/clone", {
      inherit,
      description,
      ...(tag ? { tag } : {}),
      ...(task ? { task } : {}),
      ...(job ? { job } : {}),
      ...(cwd ? { cwd } : {}),
      ...(chat ? { chat } : {}),
      ...(cli ? { cli } : {}),
      ...(model ? { model } : {}),
      ...(keepalive !== undefined ? { keepalive } : {}),
    })),
);

// ── Job: 一次 fan-out 的工单 ────────────────────────────────────────────────
// 工单不是第二个编排器: 控制流始终在你自己的上下文里 (你自己 spawn、自己 wait、
// 自己汇总)。守护进程只替你记一本账 —— 谁属于这个活、谁是临时生的、群里出哪两条
// 气泡、收工时该回收谁。
server.registerTool(
  "open_job",
  {
    title: "Open a job for a fan-out",
    description:
      "开一个**工单**: 你接下来要同时派出两个以上的分身干同一件事时, 先开它。返回一个 id, 把这个 id 传给 spawn_clone / send_peer 的 `job` 参数, 它们就归到这个工单名下。\n" +
      "开了工单之后有三件事不一样: ① 群里只出两条气泡 —— 这里的「开工」和 close_job 的「收工」, 中间每个分身的出生和每一次派活不再各刷一条 (五路 fan-out 本来会刷十条交叉气泡, 人从里面读不出结构; 过程照旧在各自的 chat 详情页里, 收工那条会把成员和各自那段活列出来)。② close_job 会把为这个工单生出来的分身**整批回收**, 不必一个个 stop_wizard —— 忘记回收是常态, 每个分身都占着一个 pane 和一份上下文。③ list_jobs 能看到还开着哪些活。\n" +
      "派活时顺手让每个分身**把结论收口成一行** `RESULT: …` (交付物写进文件就回传路径): wait_peer 会把这一行单独摘出来放进 `result`, 你汇总时不必再从八百字里找结论。\n" +
      "只派一个分身、或者只是推某个同伴一把, 不用开工单 —— 那时逐条气泡正是人想看的。",
    inputSchema: {
      title: z.string().describe("一句话说清这个工单要干成什么 —— 它会出现在群里的开工气泡上。"),
      plan: z.string().optional().describe("要在开工气泡里一并说明的计划 (打算分几路、各干什么)。省略则只出标题。"),
    },
  },
  async ({ title, plan }) => unwrap("open_job", await daemonPost("/jobs/open", { title, ...(plan ? { plan } : {}) })),
);

server.registerTool(
  "close_job",
  {
    title: "Close a job and recycle its clones",
    description:
      "收工: 把汇总结论发进群 (连同成员清单和各自那段活, 每个名字挂它自己的 chat 详情页), 并**把为这个工单生出来的分身整批回收**。被拉来帮忙的长期 wizard 不在回收之列, 你自己也不会被收。\n" +
      "拿到所有分身的结果、汇总完就调它 —— 分身留着不收, 下一次编排就会撞到分身上限。`stop:false` 只结账不回收 (那些分身后面还有用)。",
    inputSchema: {
      job: z.string().describe("open_job 返回的工单 id。"),
      summary: z.string().optional().describe("汇总结论, 发进群给人看。这是人在群里看到的唯一一条结果 —— 写清楚做成了什么、有什么没做成。"),
      stop: z.boolean().optional().describe("是否回收为这个工单生出来的分身。默认 true。"),
    },
  },
  async ({ job, summary, stop }) =>
    unwrap("close_job", await daemonPost("/jobs/close", { job, ...(summary ? { summary } : {}), ...(stop === false ? { stop: false } : {}) })),
);

server.registerTool(
  "list_jobs",
  {
    title: "Open jobs in this chat",
    description:
      "这个聊天里还开着的工单: id、标题、谁开的、成员和各自那段活。用来回答「那批分身在干什么」「上次那个活收了没」, 以及在继续派活前拿回工单 id。",
    inputSchema: {},
  },
  async () => unwrap("list_jobs", await daemonPost("/jobs/list", {})),
);

server.registerTool(
  "stop_wizard",
  {
    title: "Interrupt or end another wizard",
    description:
      "收掉一个 wizard/分身。mode='interrupt' 只打断它当前这一轮 (等价于群里的 /stop, 它还活着, 可以继续派活); mode='end' 结束它并回收 tmux pane (等价于 /kill, 之后再找它会重新长出一个空白会话)。活干完了就把临时分身 end 掉 —— 每个分身都占着一个 pane 和一份上下文。加 forget=true 连它的身份记录一起抹掉 (名字、职责、记忆), 只在它彻底不会再回来时用。用户说「让 #x 停下」「把那些分身收了」时调它。终结自己也是合法的 (分身干完活自我了结), 只是这次调用不会返回 —— 群里的通知就是回执。",
    inputSchema: {
      tag: z.string().describe(ADDRESS_DOC),
      mode: z.enum(["end", "interrupt"]).optional().describe("'end' 结束并回收 pane (默认); 'interrupt' 只打断当前这一轮。"),
      forget: z.boolean().optional().describe("仅对 end 有效: 连身份记录 (名字/职责/记忆) 一起删除。默认 false —— 身份留着, 下次它回来还是它。"),
    },
  },
  async ({ tag, mode, forget }) =>
    unwrap("stop_wizard", await daemonPost("/wizard/stop", { tag, ...(mode ? { mode } : {}), ...(forget ? { forget } : {}) })),
);

server.registerTool(
  "wizard_remember",
  {
    title: "Write something into your long-term memory",
    description:
      "写一条只属于你的长期记忆。它不在对话里 —— 它在注册表里, 每次你 (重)开会话时重新压进你的系统提示。所以这是唯一能跨 /clear、跨交接、跨重启活下来的东西: 用户的口味偏好、这个项目的硬约束、踩过的坑、'发版前必须更新 CHANGELOG' 这种规矩。一条一句话, 越具体越有用。传 forget (子串匹配) 删掉过时的那条。别拿它存这次任务的临时状态 —— 那种东西属于交接简报。",
    inputSchema: {
      note: z.string().optional().describe("要记住的一句话。"),
      forget: z.string().optional().describe("要忘掉的记忆里的一个子串, 命中的整条删除。"),
    },
  },
  async ({ note, forget }) =>
    unwrap("wizard_remember", await daemonPost("/wizard/remember", {
      ...(note ? { note } : {}),
      ...(forget ? { forget } : {}),
    })),
);

server.registerTool(
  "wizard_handoff_self",
  {
    title: "Hand your own work over to a fresh context",
    description:
      "给自己做交接: 你把当前工作压成一份自洽的简报写在 `brief` 里, 守护进程等你这一轮说完、会话空下来之后, 在同一个 pane 里 /clear (上下文清零、cwd 不变、身份的系统提示还在), 再把简报作为新会话的第一条消息贴回去。wizard_whoami 的 handoffSuggested=true, 或者你自己感觉上下文塞满了、开始记不住前面的事时, 主动调它 —— 不必等人下令。简报要写到「零上下文的自己仅凭它就能接着干」: 总目标 / 已完成与关键决策 / 当前状态 (改到哪、什么能跑、什么没跑通) / 下一步 (有序) / 关键文件路径与非显然的坑。要交接的是别人 (某个分身上下文爆了), 用 handoff 而不是这个。",
    inputSchema: {
      brief: z.string().describe("交接简报全文。自洽、具体、可执行 —— 接手的是一个什么都不记得的你。"),
    },
  },
  async ({ brief }) => unwrap("wizard_handoff_self", await daemonPost("/wizard/handoff-self", { brief })),
);

const transport = new StdioServerTransport();
await server.connect(transport);
