// MCP server `wezard`. Stdio transport, stateless: every tool POSTs to the
// resident daemon over loopback. Sessions are opened from the chat side (the
// daemon spawns the pane), so nothing here attaches a session.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const DAEMON_BASE = process.env.WEZARD_DAEMON_BASE ?? "http://127.0.0.1:17890";

const ok = (data: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(data) }],
});
const fail = (msg: string) => ({
  isError: true,
  content: [{ type: "text" as const, text: msg }],
});

const server = new McpServer(
  { name: "wezard", version: "0.0.1" },
  { capabilities: { tools: {} } },
);

// 地址参数改名 (`tag`/`tags` → `name`/`names`) 的兼容层。客户端的工具 schema 是会话
// 开局时拿的, 进程却可能已经换成新代码 (插件重连就会重起它): 旧 schema 发来 `tag`,
// zod 把不认识的字段静默剥掉, 地址落成 "" = 调用方聊天的默认 wizard —— 活派错了人
// 而且不报错。所以凡是带 `name`/`names` 的工具都顺带收下老字段并折回来; 原本必填的
// `name` 放宽成可选, 两个都没给时由这里报错, 不让它退化成空地址。
type Shape = Record<string, z.ZodTypeAny>;
const withLegacyAddress = (shape: Shape): Shape => {
  const extra: Shape = {
    ...("name" in shape ? { tag: z.string().optional().describe("旧名, 同 `name`。") } : {}),
    ...("names" in shape ? { tags: z.array(z.string()).optional().describe("旧名, 同 `names`。") } : {}),
  };
  const name = shape.name;
  return { ...shape, ...(name && !name.isOptional() ? { name: name.optional() } : {}), ...extra };
};
const foldLegacyAddress = (required: boolean) => (args: Record<string, unknown>): Record<string, unknown> => {
  const { tag, tags, ...rest } = args;
  const next = {
    ...rest,
    ...(rest.name === undefined && tag !== undefined ? { name: tag } : {}),
    ...(rest.names === undefined && tags !== undefined ? { names: tags } : {}),
  };
  if (required && next.name === undefined) throw new Error("missing `name` (the wizard's global name, e.g. 'fix')");
  return next;
};
const registerTool = server.registerTool.bind(server);
server.registerTool = ((toolName: string, config: { inputSchema?: Shape }, cb: (args: Record<string, unknown>, extra: unknown) => unknown) => {
  const shape = config.inputSchema;
  if (!shape || !("name" in shape || "names" in shape)) return registerTool(toolName, config as never, cb as never);
  const fold = foldLegacyAddress(!!shape.name && !shape.name.isOptional());
  return registerTool(toolName, { ...config, inputSchema: withLegacyAddress(shape) } as never, ((args: Record<string, unknown>, extra: unknown) => cb(fold(args), extra)) as never);
}) as typeof server.registerTool;

// Accept user-friendly prefixes from the LLM: vid:<id> → user:<id>, chatid:<id> → chat:<id>.
// Pass anything else (already user:/chat:/group:, or empty) through unchanged.
const normalizeTarget = (raw: string | undefined): string | undefined => {
  if (!raw) return undefined;
  if (raw.startsWith("vid:")) return `user:${raw.slice(4)}`;
  if (raw.startsWith("chatid:")) return `chat:${raw.slice(7)}`;
  return raw;
};

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
      "一步换掉这个 wizard 的**工作区**: 杀掉当前 pane, 在给定目录下重开一个全新的会话 —— 等价于往那个目录 `/new`。群里收到新会话的 📂 项目信息气泡当回执; 对话上下文**不会**带过去 (和 /new 一样是全新会话, 但身份的系统提示还在)。调用方就是被替换的那一个时, 它在调用当口就被终结 —— 这是预期行为, 群里那条气泡就是回执。用绝对路径 (或 `~` 开头)。想换目录又想保住手上的上下文: 先 wizard_handoff_self 把工作压成简报, 或者 spawn_wizard({cwd}) 生一个子 wizard 去那边干。\n"
      + "**`keep:true` 是另一支**: 人回答「不用换, 就用现在这个目录」时调它 —— 不重开会话, 只把「这个工作区是人认过的」记下来, 此后新会话的开局不再问这件事。一个新聊天的第一个 wizard 落在默认兜底目录里, 开局会被要求先问一句要去哪个项目; 人给路径就走 `cwd`, 人说不用换就走 `keep`。",
    inputSchema: {
      cwd: z.string().optional().describe("Absolute project path, e.g. /Users/foo/projects/bar. ~ is expanded. 与 `keep` 二选一。"),
      keep: z
        .boolean()
        .optional()
        .describe("人回答了「不用换, 就用现在这个目录」时传 `true` (不要传 cwd)。只记一笔确认 —— 不重开会话、不动上下文, 此后再没人问这件事。"),
      target: z
        .string()
        .optional()
        .describe(
          'Optional target override. "vid:<userid>" / "chatid:<chatid>" / raw "user:<id>"/"chat:<id>". Empty → derive from the calling session.',
        ),
    },
  },
  async ({ cwd, keep, target }) => {
    if (!cwd && !keep) return fail("set_workspace 要么给 cwd (换到那个目录), 要么给 keep:true (确认沿用当前目录)");
    const { sessionId, tmuxPane } = selfRef();
    const normalizedTarget = normalizeTarget(target);
    const { j } = await daemonPost("/mirror/workspace", {
      ...(cwd ? { cwd } : {}),
      ...(keep ? { keep: true } : {}),
      ...(normalizedTarget ? { target: normalizedTarget } : {}),
      ...(sessionId ? { sessionId } : {}),
      ...(tmuxPane ? { tmuxPane } : {}),
    });
    if (!j.ok) {
      const queued = j.pendingCwd ? ` (switch queued for ${j.pendingCwd as string} — send /new from WeCom to apply)` : "";
      return fail(`set_workspace failed: ${(j.reason as string) ?? "unknown"}${queued}`);
    }
    return ok({ ok: true, target: j.target, sessionId: j.sessionId, cwd: j.cwd, ...(j.confirmed ? { confirmed: true } : {}) });
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
// 每个 wizard 有一个全局唯一的名字, 人在群里写 `.fix`、wizard 之间传 `fix` 就叫到它,
// 与它住在哪个群无关; 各自可以跑不同的 CLI / 模型 / 项目。它们互为同伴 (peer): 看得见彼此, 也驱动得动
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

// 读侧工具 (名册 / 对话 / 聊天记录) 的回执是守护进程排好的**文本**, 原样交出去:
// 这些东西是给模型读的, 包一层 json 只是让它为字段名和转义的换行多付 token。
const unwrapText = (name: string, r: DaemonReply) =>
  r.j.ok && typeof r.j.text === "string" ? { content: [{ type: "text" as const, text: r.j.text }] } : unwrap(name, r);

// 地址语法只有一套, 每个吃地址的工具都把它原样重述一遍: 模型单看一个 schema
// 时没有别的地方能学到它, 而猜出来的地址会安静地指向另一个 wizard 的终端。
const ADDRESS_DOC =
  "wizard 的名字 —— 全机唯一, 它就是地址: `'fix'` 或 `'.fix'` 都行, 不分它住在哪个群。`''` = 你这个聊天的默认 wizard。永远别自己拼 key: wizard_roster / spawn_wizard / clone_wizard 返回的名字 (或 409 里的 `address`) 原样传回来。老的 `聊天名#tag` 写法仍然认, 但别再写。";

// 造一个 wizard: 它的 home 默认是调用方自己的聊天 (所以走 `selfRef`); 给了 `chat`
// 就落在另一个**起过名字**的聊天里。名字全局唯一, 与 home 无关。
server.registerTool(
  "new_claude_session",
  {
    title: "Spawn a blank new wizard",
    description:
      "在指定项目目录下长出一个**全新的 wizard** —— 自己的 tmux pane、自己的全局名字 (`.name`), home 默认是你这个聊天, 等价于人在群里敲 `/new .name`。它**不继承任何上下文**(白纸一张): 要一个开局就带着你读过的材料的分身, 用 clone_wizard; 要一个归你管、干完可回收的白板子 wizard, 用 spawn_wizard。这个工具生的 wizard 独立长住, 不挂在谁名下。新 wizard 在群里说话时气泡头是 `emoji .name`, 之后用 wizard_roster / peek_peer / send_peer / wait_peer 驱动它。用户说「在 /path 下新建一个会话」「帮我在 xxx 目录起个 agent」时调它。给 `chat` 就把它的 home 设在**另一个**聊天里 —— 那个聊天必须起过名字(list_chats 能看到)。目录不存在会自动创建。绝不会顶掉一个聊天的默认 wizard。名字全局唯一: 撞上的 wizard 静默超过一天就直接顶掉它、名字归新的; 撞上一个还在的 wizard 返回 409, 返回里的 `name` 是最终落定的名字。",
    inputSchema: {
      cwd: z.string().describe("Absolute project path to start the new session in, e.g. /Users/foo/projects/bar. Created if missing."),
      name: z
        .string()
        .optional()
        .describe("新 wizard 的名字 (如 'fix'、'docs', 带不带 '.' 都行) —— 全机唯一, 它就是地址, 挑一个说明它干什么的短词, 之后用它 send_peer / peek_peer。省略则按目录名生成。"),
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
        .describe("这个 wizard 跑在哪个模型上, 口语化随便写 ('opus' / 'sonnet 5' / '最新的 opus' / 'claude-haiku-4-5' 都行) —— 不是塞给启动参数, 而是等 pane 起来后打开它自己的 `/model` 列表, 在里面挑最接近的一项选中, 所以返回里的 `model` 是列表里真正落地的那一项 (如 'Opus 5.5'), 可能跟你传的字符串不一样; 列表里对不上会带 `modelWarning`, 那时 wizard 还在跑但停在了原来的模型上, 不是失败。省略用该 CLI 的默认。同一个聊天里的 wizard 可以各跑各的模型 —— 又长又要判断的活给 opus, 跑腿的 lint/grep 给 haiku。之后要换用 set_model。"),
      keepalive: z
        .boolean()
        .optional()
        .describe("这个 wizard 要不要被 keepalive 心跳保温 (空闲时定期 ping 一下防 prompt cache 过期)。false = 永远不保温, 省下那份 ping 的钱 —— 适合跑腿一次就收工的临时会话; true = 明确要保温。省略则按 daemon 配置的默认值。"),
    },
  },
  async ({ cwd, name, chat, cli, model, keepalive }) =>
    unwrap("new_claude_session", await daemonPost("/sessions/new", {
      cwd,
      ...(name ? { name } : {}),
      ...(chat ? { chat } : {}),
      ...(cli ? { cli } : {}),
      ...(model ? { model } : {}),
      ...(keepalive !== undefined ? { keepalive } : {}),
    })),
);

// ── Chat naming ────────────────────────────────────────────────────────────
// A WeCom chat's identity is an unreadable `chat:wrkS…` id. Wizards are addressed
// by their own global names; a chat name is what notify / new_claude_session
// point at, and what a chat's default wizard is born named after.
server.registerTool(
  "name_chat",
  {
    title: "Name this WeCom chat",
    description:
      "给**这个聊天**起个短名字: notify 的收件人、new_claude_session / spawn_wizard / clone_wizard 的 `chat` 从此能指到这里。没起过名字的聊天不会一直没名字 —— 第一次有人用到时守护进程按它的工作区自动补一个 (`~/develop/foo` → `foo`, 撞名加序号), 所以这个工具的用途是**起一个更好的名字**。这里的默认 wizard 出生时取聊天名; 它若还叫旧聊天名, 会跟着改 (wizard 的名字全局唯一, 撞名加后缀, 返回里的 `wizardRenamed` 就是它的新名字)。wizard 自己的名字用 wizard_identity 改, 与这里无关。用户说「给这个群起名叫 daily」「这个群叫什么」(不传 `name` 就是读) 「取消命名」(传 '-') 时调它。名字全机唯一、大小写不敏感。",
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
      "跨聊天目录: 守护进程知道的每一个企微聊天、它的名字 (空 = 没起名)、是不是你住的那个 (`self`), 以及以每个聊天为 home 的 wizard 及其名字。用户指向这个聊天之外的活时调它 —— 「别的群有谁在跑」「把这个结论发到 daily 群」「在 sanitizer 群里开个会话」。wizard 本身不必经过聊天就能叫到 (名字全局唯一); 聊天名用于 notify 与在那边生新 wizard。",
    inputSchema: {},
  },
  async () => unwrap("list_chats", await daemonPost("/chats/list", {})),
);

server.registerTool(
  "peek_peer",
  {
    title: "Read what another wizard has been saying",
    description:
      "**不打扰**地读另一个 wizard 的会话: 首行是它此刻的状态 (正在生成 / 空闲 / 停在哪个工具调用上等人点), 下面是它最近 N 轮对话的正文 —— `▸` 是别人对它说的, `◂` 是它答的, 最后一条 `◂` 就是它的最新回复 (给得最全)。全部从它的 transcript 读: 只有说出来的话, 没有工具调用的过程, 保温的 ping/pong 已经剔掉。回答「.fix 进展如何」「它卡在哪」, 或者判断要不要推它一把, 都读这里。用户消息里写的 `.name` 指的就是那个 wizard —— 去 peek 它, 别猜它在干嘛, 更别替它回答。这是**一个会话**的视角 (它从各处听到的都在里面); 要看**一个群**里谁对谁说了什么、或你和它的私聊往来, 用 read_chat。只读, 随便轮询。",
    inputSchema: {
      name: z.string().describe(ADDRESS_DOC),
      turns: z.number().optional().describe("How many recent conversation turns to return (1-40, default 6)."),
    },
  },
  async ({ name, turns }) => unwrapText("peek_peer", await daemonPost("/peers/peek", { name, ...(turns ? { turns } : {}) })),
);

server.registerTool(
  "read_chat",
  {
    title: "Read chat history like a person would",
    description:
      "像人翻聊天记录那样读往来, 一行一句: `[时刻] 谁 → 谁: 说了什么`。三级收窄, 每一级都可以不给: `role` (谁的视角 —— 只留它说的或听的) → `chat` (哪个群 —— 只留那个群里公开说的) → `target` (和谁 —— 只留与它的往来)。什么都不给 = 你这一轮所在的群: 人说的、各个 wizard 答的、wizard 之间公开说的都在里面。只给 `target` = 你和它的全部往来 (含 send_peer 默认走的私聊, 群里看不见的那部分); `role` + `target` = 那两方之间; 只给 `role` = 它在所有群与私聊里的往来; 再加 `chat` 就限定在那个群里。没给 `chat` 时每行会标出这句是在哪个群 / 私聊里说的。\n" +
      "按时间和条数读: 默认回最新的 `limit` 条; `until` = 只看那之前的 (往回翻页), `since` = 从那时起 (只给 `since` 就从它往后数 `limit` 条)。回执末尾给出翻页用的时刻, 原样传回即可。\n" +
      "只有正文: 每个来回取问话和终句, 工具调用的过程不在里面, 保温的 ping/pong 已经剔掉。记录是从各个 wizard 当前会话的 transcript 现拼的: 一个 wizard `/clear` 或交接之前说的不在里面, 除点名的 role / target 外只并最近一周动过的会话。用户说「群里刚才聊了什么」「.fix 之前怎么答的」「我上次让 .docs 干了什么」, 或者你被叫进一个已经聊了一阵的群、需要来龙去脉时调它。要读**某一个 wizard** 会话里的原始对话用 peek_peer。",
    inputSchema: {
      role: z.string().optional().describe("谁的视角: wizard 的名字 ('fix' / '.fix') 或人的 userid。省略 = 不限 (给了 `target` 时默认是你自己)。"),
      chat: z.string().optional().describe("哪个群: 聊天名 (list_chats 里那个) 或裸 principal。省略 = 不限群 (公开与私聊都算); 三个都省略 = 你这一轮所在的群。"),
      target: z.string().optional().describe("和谁的往来: wizard 的名字或人的 userid。"),
      since: z.string().optional().describe("从什么时候起: `2h` / `30m` / `3d` (多久以前)、`14:30` (今天)、`09-30 14:30`、或 ISO 时间。"),
      until: z.string().optional().describe("到什么时候为止 (不含), 写法同 `since`。往回翻页就把回执里的「更早的」时刻传进来。"),
      limit: z.number().optional().describe("最多回多少条 (1-200, 默认 30)。"),
      per: z.number().optional().describe("单条正文最多多少字 (40-4000, 默认 500); 超出的部分标成 `…(+N)`。"),
    },
  },
  async ({ role, chat, target, since, until, limit, per }) =>
    unwrapText("read_chat", await daemonPost("/chats/read", {
      ...(role ? { role } : {}),
      ...(chat ? { chat } : {}),
      // `target` 在守护进程的请求体里是「调用方是谁」的覆盖 (resolveSelf), 不能占用。
      ...(target ? { with: target } : {}),
      ...(since ? { since } : {}),
      ...(until ? { until } : {}),
      ...(limit ? { limit } : {}),
      ...(per ? { per } : {}),
    })),
);

server.registerTool(
  "send_peer",
  {
    title: "Say something to another wizard",
    description:
      "跟另一个 wizard 说话 —— 文本原样落进它的输入框, 它当成新的一轮接手。这是你**驱动**同伴的唯一方式: 派活、解它的阻塞、回答它的提问、叫它继续。「推动 .fix 干到底」的典型循环: peek_peer 看它在哪 → send_peer 说该说的 → wait_peer 等它停下 → 再 peek。名字全局唯一, 目标住在哪个群都一样叫。对方还不存在就自己造: 要它继承你的上下文用 clone_wizard, 要一个白纸一张的子 wizard 用 spawn_wizard。\n" +
      "**默认是私聊**: 不出任何群气泡, 只记在你们双方的 rolepage 里; 它那一轮的回复也不进群, 用 wait_peer 取。**`public:true` 则在公开频道说** —— 你这一轮所在的群里出一条 `.你 → .它` 的气泡, 它那一轮的回复也发进这个群。公开与否由你判断: 需要人知道的、或本该当着人讨论的 (关键决策、给人的结论、要人拍板的分歧) 用 public; 过程性的派活、催进度、对齐细节用私聊。无论哪种都直说: 要什么、给什么、结论是什么, 不用寒暄、不用引用原文。`text` 只写活本身 —— 守护进程会在后面挂一段信封, 告诉对方这是谁发的、私聊还是公开、回执写在它最后一条消息里并收口成 `RESULT: …`, 这些别自己再写。拒绝对自己发送。",
    inputSchema: {
      name: z.string().describe(ADDRESS_DOC),
      text: z.string().describe("Message to inject. Plain prompt text; slash commands like '/clear' also work."),
      when: z
        .enum(["now", "idle"])
        .optional()
        .describe(
          "什么时候投。`now` (默认) 立刻投 —— 对方正在生成时这句话会排在它这一轮后面, 回答它的提问、打断它、催它都该用这个。`idle` 先等它闲下来再投: **派一件新活给一个正在忙的同伴时用它**, 否则你和别人的两段文本会挤进同一个输入框被当成一轮读掉。返回里的 `wasBusy` 告诉你投的时候它忙不忙。",
        ),
      waitSec: z.number().optional().describe("`when:'idle'` 最多等多少秒 (10-3600, 默认 600)。等不到就返回失败, 不会强行投。"),
      public: z
        .boolean()
        .optional()
        .describe("true = 在公开频道 (你这一轮所在的群) 里说: 群里出 `.你 → .它` 气泡, 它的回复也进群。默认 false = 私聊, 只记在 rolepage。需要人知道 / 该当着人讨论才用 true。"),
      job: z.string().optional().describe("这次派活归到某个工单名下 (open_job 给的 id) —— 收工那一条会把各自那段活列出来。"),
    },
  },
  async ({ name, text, when, waitSec, job, public: pub }) =>
    unwrap("send_peer", await daemonPost("/peers/send", { name, text, ...(when ? { when } : {}), ...(waitSec ? { waitSec } : {}), ...(job ? { job } : {}), ...(pub ? { public: true } : {}) })),
);

server.registerTool(
  "notify",
  {
    title: "Post a message into a chat for people to read",
    description:
      "把一段 markdown 贴进一个企微聊天**给人看**。和 send_peer 分工明确: send_peer 是把话塞进另一个 agent 的输入框 (驱动它干活), notify 是说给人听 —— 不会触发任何一轮对话。\n" +
      "`to` 省略 = 你这一轮所在的群 (人从哪个群叫的你就是哪个; 私聊轮则是你的 home 群); 要发到别的群就写聊天名 (`list_chats` 里那个), 一次可以写多个。气泡头自动写成 `emoji .你的名字` 并挂上你的 rolepage 链接, 那边的人一眼知道是谁。\n" +
      "什么时候用: 长活跑完了要通知另一个群的人; 一批分身收工后把汇总播给发起那个群; 定时任务 (schedule_task) 到点跑完把结论送到该看的人那里。别拿它跟同群的人说话 —— 那是你的正常回复。",
    inputSchema: {
      to: z
        .array(z.string())
        .optional()
        .describe("收件聊天: 聊天名 (`daily`) 或裸 principal (`chat:wr…` / `user:…`)。省略 = 你这一轮所在的群。认不出的整条拒绝并列出来, 不会部分送达。"),
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
      "挂起, 直到点名的 wizard 停下来 (它的终端不再显示中断提示), 然后返回它最新的回复。send_peer 之后就该用它 —— 这样你拿到的是写完的答案, 而不是写了一半的。超时先到则返回 `idle: false` 与原因: 它只是还在干, 你可以 peek 一眼再等。很便宜: 守护进程轮询的是 pane, 不烧 token。回的只算**你上次 send_peer 之后**它说的: 它收口了 `RESULT: …` 就只回 `result` (`omitted` = 正文还有多少字没给, 要读用 peek_peer), 没收口才回 `lastText` (超长掐中间); `stale: true` = 它停下了却没有新回复 (卡在弹窗上, 或那句话没被接住) —— peek_peer 看一眼, 别把它当成答完了。私聊轮的回复不进群 —— 人需要知道结论时, 用你自己的话收口给人, 别把原话再念一遍; 公开轮的回复已经在群里了, 更不必复述。\n" +
      "**派了一批活就用 `names` 一次等一组**, 别一个一个等: 它们本来在同时干活, 串行等的墙钟是所有人之和, 并行等只等最慢的那一个。等一组时 `results` 按你给的顺序逐个回, 只等一个则直接摊平在顶层。`need` 决定满几个就返回 (默认全部; `need:1` = 谁先完事就先处理谁, 剩下的还在跑, 再调一次接着等)。",
    inputSchema: {
      name: z.string().optional().describe(`${ADDRESS_DOC} 等一组时改用 \`names\`。`),
      names: z
        .array(z.string())
        .optional()
        .describe("一次等多个 wizard 的名字 (最多 16 个), 每个的写法同 `name`。fan-out 之后的 join 用它 —— 五个分身并行等只花最慢那一个的时间。"),
      need: z
        .number()
        .optional()
        .describe("满几个就返回 (1 到地址个数, 默认全部)。`1` = 任意一个先完事就返回; 中间值 = 法定人数。满足后剩下的等待会被撤掉, 它们照常继续干活, 结果里 `idle:false`。"),
      timeoutSec: z.number().optional().describe("Max seconds to wait (10-7200, default 900)."),
    },
  },
  async ({ name, names, need, timeoutSec }) =>
    unwrap("wait_peer", await daemonPost("/peers/wait", {
      ...(names?.length ? { names } : { name: name ?? "" }),
      ...(need ? { need } : {}),
      ...(timeoutSec ? { timeoutSec } : {}),
    })),
);

server.registerTool(
  "run_agent_graph",
  {
    title: "Run a loop graph over several tagged agents",
    description:
      "把这个聊天里的几个 wizard 串成一条**会循环的流水线**, 交给守护进程去驱动。`nodes` 是参与的 `#tag` wizard (每个可以自选 cli / 模型 / 工作区; 不存在的当场造出来, 已经在跑的原样复用、上下文不动)。`steps` 是有序管线 —— 每一步向一个 wizard 发一段提示、等它干完、抓住它的回复、喂给下一步。整张 step 表会被走 `rounds` 遍, 这才叫**循环**: `fix → review → fix → review …` 直到某个回复里出现 `until` 或轮次用完。提示模板可以引用前面的产出: `{{last}}` = 上一步的回复, `{{<tag>}}` = 那个 wizard 最新的回复, `{{round}}` = 第几轮。立刻返回 runId 并把进度播报进群; 用 graph_status 查、stop_graph 停。用户要「几个 agent 互相评审/迭代到收敛」时用它。只是推一个 wizard 一把, 用 send_peer + wait_peer。要它们开局就共享同一批材料, 先 clone_wizard 出这些节点再跑图。",
    inputSchema: {
      nodes: z
        .array(
          z.object({
            tag: z.string().describe("wizard 的 tag, 不带 '#', 如 'fix'。"),
            cli: z.enum(["claude", "claude-internal", "codebuddy"]).optional().describe("这个 wizard 用哪个 CLI。省略则继承本聊天的。"),
            model: z.string().optional().describe("要现造这个 wizard 时跑在哪个模型上, 口语化随便写 ('opus' / 'haiku' / '最新的 opus' 都行) —— 起来后在它的 `/model` 列表里挑最接近的一项选中。已经在跑的不受影响。"),
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
      "给**另一个** wizard 做交接, 原地完成: 守护进程让它把当前工作压成一份自洽的交接简报, 等它写完抓取, 再往**同一个 pane** 注入 `/clear` (上下文清零、新 sessionId、cwd 不变、身份的系统提示还在), 然后把简报作为新会话的第一条消息贴回去。它的上下文撑不住了、或者用户说「让 .fix 交接一下」「叫它压缩上下文重开」时用。按 tmux `pane` id (`%5`, 来自 wizard_roster / list_claude_sessions) 或按 `name` 寻址。**要交接的是你自己就用 wizard_handoff_self** —— 这里拒绝对自身操作 (会死锁: 你没法在自己生成的当口再被问一次)。返回被带过去的那份简报。",
    inputSchema: {
      pane: z.string().optional().describe("目标 tmux pane id, 如 '%5'。优先于 name。从 wizard_roster / list_claude_sessions 拿。"),
      name: z.string().optional().describe(`${ADDRESS_DOC} 给了 pane 就忽略它。`),
      focus: z.string().optional().describe("交接简报里要特别交代的点, 如 '重点交代还没跑通的测试'。可选。"),
      timeoutSec: z.number().optional().describe("Max seconds to wait for the summary before aborting (30-7200, default 600)."),
    },
  },
  async ({ pane, name, focus, timeoutSec }) =>
    unwrap(
      "handoff",
      await daemonPost("/handoff", {
        ...(pane ? { pane } : {}),
        ...(name !== undefined ? { name } : {}),
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
      "排一个**到点自动执行**的活, **归在你名下** (你的 rolepage「日程」里看得到): 到时间了, daemon 起一个**全新的白板 wizard** (名字 `<你>-task-xxxx`, 挂在你的家谱下), 把 `prompt` 原样说给它听, 它干完活自动收掉 —— 产出照常落在群里。守护进程级, 跨 CLI 重启/会话结束仍在。用户说「每个工作日晚上 9:30 自动跑一下 xxx」「每天早上帮我看看 yyy」「每 2 小时同步一次 zzz」「明早 9 点提醒并整理 www」时调它。\n" +
      "**每条任务落成一份你能直接改的代码文件** `~/.wezard/tasks/<id>.task.mjs` (返回值里的 `file`)。这个工具只管最常见的那条路 (什么时候 + 说什么); 要更细的东西就**用 Read/Edit 改那个文件**, 存盘即生效, 不用 reload:\n" +
      "· 触发条件可组合 —— `when: ({every, daily, at, between, onDays, and, not}) => and(every(\"1h\"), between(\"08:00\",\"20:00\"), onDays(\"工作日\"))`。`every/daily/at` 产生时刻, `between/onDays/not` 只做筛选。\n" +
      "· **放枪前先探一眼**用 `gate` —— 一段在 daemon 侧跑的异步函数, 返回 `false` 这一轮就不放枪 (不起 wizard、群里不出声), 返回 `{vars}` 则填进 prompt 里的 `{{名字}}`, 返回 `{state}` 下一轮还拿得到。`gate: async ({sh, state}) => { const out = await sh(\"git fetch -q && git log --oneline HEAD..@{u}\"); return out.trim() ? {vars:{commits: out}} : false; }`。「有新东西才处理」这类需求必须用它, 别写成「到点起个 wizard 让它自己看一眼没有就退出」—— 那是每次空转一个 pane 加一份上下文。\n" +
      "· `enabled: false` 暂停而不删。\n" +
      "**默认新建, 不在任何已有会话里续**: 定时的活是一件独立的事, 塞进一个常驻 wizard 会把两件不相关的事挤进同一个 transcript, 那个 wizard 正忙时还会连触发时刻一起被拖走。只有用户明确说了「在 .foo 里继续 / 让 .foo 每天…」才传 `name` 点名它 —— 这时到点直接投进它那一轮 (它正忙则仍然另起白板执行)。`prompt` 本身就在说「建两个 wizard 去干 xxx」时, 就算给了 `name` 也照新建办 —— 守护进程自己认这句话, 那个名字只决定在谁的聊天/目录下办。要强行在它那一轮里续, 显式传 `fresh:false`。\n" +
      "`when` 用人话原样写, 别自己翻译成 cron: 「每个工作日晚上9:30」「每天 8:00」「每周三下午3点」「每隔两个小时」「每小时」「每 30 分钟」「20 分钟后」「明早 9 点」都认, 还能叠时间窗口 —— 「白天每隔一个小时」「工作时间每半小时」「8点到20点每小时」。解析不出会报错并列出能认的说法 —— 这时把原话回给用户让他重说, 别自己猜一个时间存进去。\n" +
      "存成功后**必须把回显的 `when` 和 `next` 念给用户**确认 (例: 「每个工作日 21:30, 下次 2026-09-21 21:30」)。`prompt` 要写成一句完整的、零上下文也能执行的指令 —— 到点接活的多半是个刚出生的白板 wizard, 它只看得见这句话。",
    inputSchema: {
      when: z.string().describe("什么时候跑, 人话原样传: 「每个工作日晚上9:30」「每天早上9点」「白天每隔一个小时」「工作时间每半小时」「每30分钟」「20分钟后」「明早9点」。时间窗口 (白天 / 工作时间 / 8点到20点) 会被解析成筛子, 窗外的那些枪直接吞掉。"),
      prompt: z.string().describe("到点要说给那个 wizard 听的话。写成自洽的完整指令 (要做什么、在哪个目录/文件上、做完怎么汇报), 别依赖当前对话的上下文。里面可以留 `{{名字}}` 占位, 由任务文件里的 gate 填。"),
      name: z.string().optional().describe(`点名在**哪个已有 wizard**里跑 —— 只有用户要求「在它那儿继续」时才传。省略 = 到点新建一个白板 wizard 干完就收 (默认, 也是「定时新建 wizard 干 xxx」要的那个)。传了它还想要新建, 再加 \`fresh:true\`: 那时它只当模板, 新 wizard 继承它的聊天/目录/模型。${ADDRESS_DOC}`),
      fresh: z.boolean().optional().describe("覆盖默认: true = 每次到点新建白板 wizard 执行 (给了 name 时用来表达「在它的目录下新开一个干」), false = 注入 name 指向的已有会话。默认由 name 推断 (给了 name = false, 没给 = true)。"),
      id: z.string().optional().describe("任务 id, 同时也是文件名 (`~/.wezard/tasks/<id>.task.mjs`)。省略则从 note/prompt 生成。取个好认的短名 —— 之后你要改这条任务, 改的就是那个文件。"),
      note: z.string().optional().describe("给人看的一句话备注, 在 list_tasks 里回显。"),
    },
  },
  async ({ when, prompt, name, note, fresh, id }) =>
    unwrap("schedule_task", await daemonPost("/tasks/schedule", {
      when, prompt, name: name ?? "", note: note ?? "", id: id ?? "",
      ...(fresh === undefined ? {} : { fresh }),
    })),
);

server.registerTool(
  "list_tasks",
  {
    title: "List scheduled tasks on this host",
    description:
      "列出本机所有定时任务: `id` (取消要用)、`when` (人话回显)、`next` (下次触发时刻)、`lastFired`、`runIn` (到点是新建白板 wizard 还是注入已有会话)、目标 wizard 的 `address` 与 `prompt`。用户问「有哪些定时任务」「我设了什么定时」「下次什么时候跑」时调它。只读。`mine:true` 只看排给你自己的。\n" +
      "`file` 是这条任务的源码 (`~/.wezard/tasks/<id>.task.mjs`) —— 要改触发条件、加 gate、暂停 (`enabled:false`) 就 Read/Edit 它, 存盘即生效。`gate` 说明这条任务有没有放枪前的探查以及上一轮的去向 (go 放了 / skip 没活 / error 炸了), `lastError` 与 `loadError` 是它上次为什么没跑成 —— 改坏了的文件也会出现在列表里, 带着理由。",
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
      "按 id 删掉一条定时任务 (id 从 list_tasks 拿), 连同它那份任务文件一起。用户说「取消那个定时」「别再每天跑了」时调它: 先 list_tasks 把候选念给用户确认是哪一条, 再删。删的是日程本身, 不影响任何正在跑的活。**一条定时的 prompt 要求「没活就停掉这个定时」时, 到点接活的那个 wizard 就该自己调它**: list_tasks 按 note/prompt 认出是哪一条, 再 cancel_task。只想暂时停就改任务文件的 `enabled: false`, 留档。",
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
      "你自己是谁: 全局唯一的名字 (即地址, 别人用它找你)、home 聊天、工作区、职责、记忆、家谱 (谁生的你、你生了谁), 以及此刻的 contextTokens 与 handoffSuggested。用户问「你是谁」「你叫什么」「你在哪个目录」「你有几个分身」时先调它; 要做任何编排之前也先调它 —— 你得知道自己的工作区在哪、手里已经有哪些分身。handoffSuggested=true 表示上下文该交接了 (见 wizard_handoff_self)。",
    inputSchema: {},
  },
  async () => unwrap("wizard_whoami", await daemonPost("/wizard/whoami", {})),
);

server.registerTool(
  "wizard_identity",
  {
    title: "Name yourself / declare your job",
    description:
      "改名字、写职责。名字就是别人喊你的那个词 (`.name`), **全机唯一**, 与聊天名无关 (给聊天起名用 name_chat): 撞名时自动加 `-N` 后缀, 返回里的 `name` 是落定的那个, `renamed` 会告诉你发生了改写。职责是一句话的「我是干什么的」—— 别的 wizard 在名册里读到它, 据此决定该不该找你。用户说「你以后叫 X」「你负责 X」时调它; 你自己发现 whoami 里职责是空的, 也应当主动补上。只传要改的那个字段。",
    inputSchema: {
      name: z.string().optional().describe("新名字, 1-32 位字母/数字/`_`/`-`, 全机唯一。不改就别传。"),
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
      "这个世界上所有的 wizard 与 clone, 一个一行: 名字 (全局唯一, 即地址)、忙闲 (忙 = 正在生成 / 闲 = 活着没在跑 / 冷 = 没有 pane, 发消息会唤醒)、**home 聊天**、**工作区**、模型、多久没动、家谱 (父 / 分身); 写了职责的多一行职责, 活着的多一行「最近」—— 它最近几句话的摘要。跨聊天的也在里面。这是你感知同伴的唯一入口 —— 用户说「还有谁在跑」「这个群里有谁」「谁在弄那个项目」「让懂 X 的那个来看看」时先调它, 拿到目标的名字再 send_peer / peek_peer / wait_peer; 要往某个群里对人说话则把那个群名交给 notify。\n" +
      "**这是一张索引, 不是一份名单**: 整台机器上可能有几百个会话, 所以默认只回最相关的一页 (自己 → 活着的 → 最近动过的), 并告诉你 `total` / `matched` 有多少。找人就带上条件: `query` 匹配名字/职责/地址, `cwd` 匹配工作区路径 (「谁在这个目录里干活」), `chat` 限定某个聊天, `alive:true` 只看还活着的。「同群有谁」就是 `chat` 写你自己的群名。别不带条件硬拉全表。",
    inputSchema: {
      query: z.string().optional().describe("在名字 / 职责 / target 里做子串匹配 (不分大小写)。「让懂 X 的那个来看看」就把 X 写在这里。"),
      chat: z.string().optional().describe("只看某个聊天里的 wizard: 聊天名, 或者聊天 principal 的一段 (无名聊天用它)。"),
      cwd: z.string().optional().describe("只看工作区路径包含这一段的 wizard —— 「谁在 /path 下干活」的反查。"),
      alive: z.boolean().optional().describe("true = 只看 pane 还活着的。默认全给 (冷会话发消息就会被唤醒)。"),
      limit: z.number().optional().describe("最多回多少条 (1-300, 默认 40)。"),
    },
  },
  async ({ query, chat, cwd, alive, limit }) =>
    unwrapText("wizard_roster", await daemonPost("/wizard/roster", {
      ...(query ? { query } : {}),
      ...(chat ? { chat } : {}),
      ...(cwd ? { cwd } : {}),
      ...(alive ? { alive } : {}),
      ...(limit ? { limit } : {}),
    })),
);

// 换模型和 spawn 时挑模型是同一条路: 守护进程在目标 pane 里打开 `/model` 列表,
// 读出这台 CLI 此刻真有的每一项, 挑最接近的, 方向键移过去选中。
server.registerTool(
  "set_model",
  {
    title: "Switch a wizard's model",
    description:
      "给一个**已经在跑**的 wizard 换模型 —— 默认换你自己, `name` 点名就换那个 wizard。口语化写要什么 ('opus' / 'haiku' / 'sonnet 5' / '最新的 opus' / '默认'), 守护进程在它的 pane 里打开 `/model` 列表, 读出这台 CLI 此刻真有的每一项, 挑最接近的一项选中; 返回里的 `model` 是真正落地的那一项, `catalog` 是列表里的全部 —— 对不上时 (`ok:false`) 照着 `catalog` 重说一遍。默认只对这一个会话生效 (`scope:'session'`), 不改新开会话的默认模型; `scope:'default'` 则同时把它设成这台 CLI 此后**每个新会话**的默认模型 —— 那是全机的设置, 只在人明说「以后默认都用 X」时才用。返回里的 `scope` 是实际落在哪一档。它之后被重启也会回到这个模型上。正在干活的也能换 (从下一次请求起生效), 但换模型会让它的对话缓存整份重读一遍 —— 别来回切。用户说「换成 opus」「这个用 haiku 跑就行」「把 .fix 切到 sonnet」时调它; 你自己判断手上的活配不上/撑不起当前模型时也可以主动换。",
    inputSchema: {
      model: z.string().describe("要换到哪个模型, 口语化写: 'opus' / 'haiku' / 'sonnet 5' / 'opus 4.7' / '最新的 fable' / '默认'。只写家族名 = 那个家族最新的一个。"),
      name: z.string().optional().describe("换谁的 —— wizard 的名字 ('fix' / '.fix')。省略 = 换你自己。"),
      scope: z
        .enum(["session", "default"])
        .optional()
        .describe("'session' (默认) = 只换这一个会话; 'default' = 换这个会话, 并设为此后所有新会话的默认模型 (改的是 CLI 的全局设置, 不指定模型的新 wizard 都会跟着变)。"),
    },
  },
  async ({ model, name, scope }) =>
    unwrap("set_model", await daemonPost("/wizard/model", { model, ...(name ? { name } : {}), ...(scope ? { scope } : {}) })),
);

// 生孩子与分身是两个操作, 不是一个开关的两档: 一个白纸起步、可以去别的目录;
// 一个 fork 调用方此刻的上下文、必须留在原地。拆成两个工具, 模型选的是动词,
// 而不是在一个布尔上猜。两者落到同一条路由 (`inherit` 由工具定死)。
const offspringShape = {
  description: z.string().describe("它负责什么, 一句话。它会写进它的系统提示, 也会出现在名册里让别人看到。"),
  name: z.string().optional().describe("它的名字 (如 'docs'、'fix', 带不带 '.' 都行)。全机唯一。省略则按 description 首词生成。"),
  task: z.string().optional().describe("就位后立刻派下去的第一件活 (私聊)。省略则它就位待命。"),
  chat: z.string().optional().describe("把它生在另一个聊天里 (list_chats 里的名字)。省略 = 你自己的聊天, 这是绝大多数情况。"),
  cli: z.enum(["claude", "claude-internal", "codebuddy"]).optional().describe("用哪个 CLI。省略则继承。"),
  model: z.string().optional().describe("跑在哪个模型上, 口语化随便写 ('opus' / 'sonnet 5' / '最新的 opus' / 'claude-haiku-4-5' 都行) —— 不是塞给启动参数, 而是等 pane 起来后打开它自己的 `/model` 列表, 在里面挑最接近的一项选中, 所以返回里的 `model` 是列表里真正落地的那一项 (如 'Opus 5.5'), 可能跟你传的字符串不一样; 列表里对不上会带 `modelWarning`, 那时它还在跑但停在了原来的模型上, 不是失败。省略用该 CLI 的默认。要判断力的给 opus, 跑腿的 (grep、跑测试、照着清单改) 给 haiku —— 一批不必齐步走。之后要换用 set_model。"),
  job: z
    .string()
    .optional()
    .describe("归到某个工单名下 (open_job 给的 id)。它们攒到 close_job 那一条里一起交代, 过程在各自的 rolepage; close_job 还会把它们整批回收掉。"),
  keepalive: z
    .boolean()
    .optional()
    .describe("要不要被 keepalive 心跳保温 (空闲时定期 ping 一下防 prompt cache 过期)。false = 永远不保温, 省下那份 ping 的钱 —— 适合跑腿一次就收工的; true = 明确要保温 —— 适合会长期挂着、随时可能被叫醒接手的。省略则按 daemon 配置的默认值。"),
};

type Offspring = { description: string; name?: string; task?: string; from?: string; cwd?: string; chat?: string; cli?: string; model?: string; job?: string; keepalive?: boolean };

const bear = (tool: string, inherit: boolean) => async (a: Offspring) =>
  unwrap(tool, await daemonPost("/wizard/clone", {
    inherit,
    description: a.description,
    ...(a.name ? { name: a.name } : {}),
    ...(a.task ? { task: a.task } : {}),
    ...(a.from ? { from: a.from } : {}),
    ...(a.job ? { job: a.job } : {}),
    ...(a.cwd ? { cwd: a.cwd } : {}),
    ...(a.chat ? { chat: a.chat } : {}),
    ...(a.cli ? { cli: a.cli } : {}),
    ...(a.model ? { model: a.model } : {}),
    ...(a.keepalive !== undefined ? { keepalive: a.keepalive } : {}),
  }));

const OFFSPRING_TAIL =
  "名字全局唯一: 撞上的 wizard 静默超过一天就直接顶掉它、名字归新的; 撞上一个还在的 wizard 返回 409 (附它的死活), 返回里的 `name` 是落定的名字。之后用 send_peer 继续派活、wait_peer 等它做完、stop_wizard 收掉它。它自己也能再 spawn_wizard / clone_wizard, 层级不限。每一个都有成本 (一个 pane + 一份上下文), 名下同时活着的有上限; 任务少于两三件时你自己做完更快。";

server.registerTool(
  "spawn_wizard",
  {
    title: "Spawn a blank child wizard",
    description:
      "**从白板生**一个子 wizard —— 新的 tmux pane、自己的全局名字 (`.name`)、自己的职责, 归你管 (家谱里挂在你名下, 工单收工时可整批回收)。它**不继承你的任何上下文**, 只拿到身份。适合干一件与你手头无关的事, 或者要去别的目录 (`cwd`) / 别的聊天里干活。要一个开局就带着你读过的材料的, 用 clone_wizard。\n" +
      "带上 `task` 可以在它就位的同时把第一件活私聊派下去, 省掉一次 send_peer; 要它的回复进群, 就别带 task, 就位后用 `send_peer({public:true})` 转给它。" +
      OFFSPRING_TAIL,
    inputSchema: {
      ...offspringShape,
      cwd: z.string().optional().describe("它的工作区绝对路径。省略 = 跟你同一个目录。"),
    },
  },
  bear("spawn_wizard", false),
);

server.registerTool(
  "clone_wizard",
  {
    title: "Clone a wizard, context and all",
    description:
      "**克隆**一个 wizard 出分身 —— fork 它此刻的上下文: 分身开局就拥有它已经读过的一切 (规范、目录结构、刚啃完的那份文档), 不必重读; 被克隆的那个毫发无损。默认克隆你自己; `from` 点名就克隆别的 wizard (比如一个已经把某个模块啃透的同伴) —— 分身仍归你管 (占你的名额、随你的工单回收), 只是上下文来自它。分身留在被克隆者的工作区。\n" +
      "这是编排一组「共享同一批材料」的任务的正确姿势: 先让一个 wizard (你自己或某个同伴) 把公共材料读进上下文, 再从它克隆出 N 个分身, 材料只读一遍却进了 N 份上下文。要白纸一张、或要去别的目录, 用 spawn_wizard。被克隆者正在干活时, 分身拿到的是它此刻为止的上下文 —— 想要它读完再分, 先 wait_peer 等它停下。\n" +
      "带上 `task` 可以在它就位的同时把第一件活私聊派下去 (分叉本来就由第一句话触发, 省一次往返)。" +
      OFFSPRING_TAIL,
    inputSchema: {
      ...offspringShape,
      from: z.string().optional().describe("克隆谁 —— wizard 的名字 ('fix' / '.fix')。省略 = 克隆你自己。它必须已经有会话 (说过话), 否则返回 409。"),
    },
  },
  bear("clone_wizard", true),
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
      "开一个**工单**: 你接下来要同时派出两个以上的分身干同一件事时, 先开它。返回一个 id, 把这个 id 传给 spawn_wizard / clone_wizard / send_peer 的 `job` 参数, 它们就归到这个工单名下。\n" +
      "开了工单之后有三件事不一样: ① 群里出「开工」与 close_job 的「收工」两条气泡, 人据此读得出这批活的结构 (过程在各自的 rolepage 里, 收工那条会把成员和各自那段活列出来)。② close_job 会把为这个工单生出来的分身**整批回收**, 不必一个个 stop_wizard —— 忘记回收是常态, 每个分身都占着一个 pane 和一份上下文。③ list_jobs 能看到还开着哪些活。\n" +
      "派活的文本只写活本身: 每个分身收到的那一轮都带着信封, 已经要求它把结论收口成 `RESULT: …` (交付物写进文件就回传路径); wait_peer 摘到就只回这一行, 你汇总时不必从八百字里找结论。\n" +
      "只派一个分身、或者只是推某个同伴一把, 不用开工单。",
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
      "收工: 把汇总结论发进群 (连同成员清单和各自那段活, 每个名字挂它自己的 rolepage), 并**把为这个工单生出来的分身整批回收**。被拉来帮忙的长期 wizard 不在回收之列, 你自己也不会被收。\n" +
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
      "收掉一个 wizard/分身。mode='interrupt' 只打断它当前这一轮 (等价于群里的 /stop, 它还活着, 可以继续派活); mode='end' 结束它并回收 tmux pane (等价于 /kill, 之后再找它会重新长出一个空白会话)。活干完了就把临时分身 end 掉 —— 每个分身都占着一个 pane 和一份上下文。加 forget=true 连它的身份记录一起抹掉 (名字、职责、记忆), 只在它彻底不会再回来时用。用户说「让 .x 停下」「把那些分身收了」时调它。终结自己也是合法的 (分身干完活自我了结), 只是这次调用不会返回 —— 群里的通知就是回执。",
    inputSchema: {
      name: z.string().describe(ADDRESS_DOC),
      mode: z.enum(["end", "interrupt"]).optional().describe("'end' 结束并回收 pane (默认); 'interrupt' 只打断当前这一轮。"),
      forget: z.boolean().optional().describe("仅对 end 有效: 连身份记录 (名字/职责/记忆) 一起删除。默认 false —— 身份留着, 下次它回来还是它。"),
    },
  },
  async ({ name, mode, forget }) =>
    unwrap("stop_wizard", await daemonPost("/wizard/stop", { name, ...(mode ? { mode } : {}), ...(forget ? { forget } : {}) })),
);

server.registerTool(
  "wizard_remember",
  {
    title: "Write something into your long-term memory",
    description:
      "写一条长期记忆。它不在对话里 —— 每次 wizard (重)开会话时重新压进系统提示, 所以能跨 /clear、跨交接、跨重启活下来。三种作用域: `self` (默认) 只属于你; `chat` 是**本群共享**的记忆 (这个群里人的习惯、约定), 在这个群出生的每个 wizard 都会读到; `workspace` 是**本工作区共享**的记忆 (这个仓库的硬约束、踩过的坑、'发版前必须更新 CHANGELOG' 这种规矩), 在这个目录下干活的每个 wizard 都会读到。后两者存成 markdown (`~/.wezard/memory/…`), 人也会直接改; 你写的只是一条**提议**, 由定时的记忆整理者去重、改写、合并 (半小时内), 所以不必先读全文查重, 也别为改一个字反复提交。一条一句话, 越具体越有用; 选对作用域 —— 属于群/仓库的别只记在自己身上。传 forget (子串匹配) 删掉 / 提议删掉过时的那条。别拿它存这次任务的临时状态 —— 那种东西属于交接简报。",
    inputSchema: {
      note: z.string().optional().describe("要记住的一句话。"),
      forget: z.string().optional().describe("要忘掉的记忆里的一个子串, 命中的整条删除。"),
      scope: z.enum(["self", "chat", "workspace"]).optional().describe("记在哪: self (默认, 只属于你) / chat (本群共享) / workspace (本工作区共享)。"),
    },
  },
  async ({ note, forget, scope }) =>
    unwrap("wizard_remember", await daemonPost("/wizard/remember", {
      ...(scope ? { scope } : {}),
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
