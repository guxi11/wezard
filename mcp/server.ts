// MCP server `wezard`. Stdio transport, stateless: every tool POSTs to the
// resident daemon over loopback. Sessions are opened from the chat side (the
// daemon spawns the pane), so nothing here attaches a session.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { DAEMON_TOKEN_HEADER, readDaemonToken } from "../shared/daemon-token.js";
import { EFFORTS } from "../shared/effort.js";
import { TIERS } from "../shared/config.js";

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

// 人侧 / 罕用的工具 (30 天零调用: graph 三件套、本机会话清单与改接、聊天目录) 不进默认
// 工具面 —— 每个注册的工具都占模型的上下文, 而这些要么人在 IM 里有对应命令 (`/sessions`
// `/chats`), 要么由 tell_peer + 回执覆盖。路由都还在; `WEZARD_MCP_EXTRA=1` 把它们挂回来。
const registerRare: typeof server.registerTool =
  process.env.WEZARD_MCP_EXTRA === "1" ? server.registerTool.bind(server) : ((() => undefined) as never);

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
      "一步换掉这个 wizard 的**工作区**: 杀掉当前 pane, 在给定目录下重开一个全新的会话 —— 等价于往那个目录 `/new`。群里收到新会话的 📂 项目信息气泡当回执; 对话上下文**不会**带过去 (和 /new 一样是全新会话, 但身份的系统提示还在)。调用方就是被替换的那一个时, 它在调用当口就被终结 —— 这是预期行为, 群里那条气泡就是回执。用绝对路径 (或 `~` 开头)。想换目录又想保住手上的上下文: 先 handoff 把自己的工作压成简报, 或者 spawn_wizard({cwd}) 生一个子 wizard 去那边干。\n"
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
registerRare(
  "list_claude_sessions",
  {
    title: "List running agent sessions",
    description:
      "(人侧/罕用 · 同 IM `/sessions`) 本机 tmux 里所有 agent 会话, 含与企微无关的终端会话; 只在用户要「切换 session」时用。找 wizard 用 wizard_roster。",
    inputSchema: {},
  },
  async () => {
    return unwrap("list_claude_sessions", await daemonGet("/sessions/list"));
  },
);

registerRare(
  "switch_claude_session",
  {
    title: "Switch WeCom mirror to another agent session",
    description:
      "(人侧/罕用 · 同 IM `/sessions <emoji|id>`) 让本聊天改接到一个已在跑的会话 (sessionId 从 list_claude_sessions 拿)。只在用户点名要切时用。",
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
    // 口令每次现读: daemon 可能在本进程起来之后才生成它。
    headers: { "content-type": "application/json", [DAEMON_TOKEN_HEADER]: readDaemonToken() },
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

// 生 wizard 的三个工具共用: 模型名是口语, 落地的是 `/model` 列表里最接近的那一项。
const MODEL_DOC =
  "跑在哪个模型上, 口语写 ('opus' / 'haiku' / 'sonnet 5'); 落地的是它 `/model` 列表里最接近的一项, 见返回的 `model`, 对不上时带 `modelWarning` (仍在跑, 停在默认模型)。写确切的 id ('claude-opus-5-5') 或列表标签 ('Opus 5.5') 且本机跑过它时, 直接带 `--model` 启动, 省掉选择器那一来回。省略 = 该 CLI 默认。之后换用 set_model。";

const EFFORT_DOC =
  "推理档位, 启动时就带上 (`--effort`), 之后它每次重启都沿用。判断密集的活给 high 以上, 跑腿的给 low。省略 = 该 CLI 默认 (克隆则跟被克隆者同档)。不支持的 CLI (codebuddy) 忽略它。之后换用 set_model 的 `effort`。";

// 造一个 wizard: 它的 home 默认是调用方自己的聊天 (所以走 `selfRef`); 给了 `chat`
// 就落在另一个**起过名字**的聊天里。名字全局唯一, 与 home 无关。
server.registerTool(
  "new_claude_session",
  {
    title: "Spawn a blank new wizard",
    description:
      "同 `spawn_wizard({detached:true, cwd})` —— 在某个目录生一个独立长住的白板 wizard (旧名, 只为不打断正在跑的旧会话而保留)。新调用一律用 spawn_wizard。",
    inputSchema: {
      cwd: z.string().describe("工作区绝对路径, 不存在会创建。"),
      name: z.string().optional().describe("它的名字, 全机唯一。省略按目录名生成。"),
      chat: z.string().optional().describe("home 聊天名。省略 = 你的聊天。"),
      cli: z.enum(["claude", "claude-internal", "codebuddy"]).optional().describe("用哪个 CLI。省略则继承。"),
      model: z.string().optional().describe(MODEL_DOC),
      keepalive: z.boolean().optional().describe("要不要保温。省略按配置。"),
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
      "给**这个聊天**起个短名字: notify 的收件人、spawn_wizard / clone_wizard 的 `chat` 从此能指到这里。没起过名字的聊天不会一直没名字 —— 第一次有人用到时守护进程按它的工作区自动补一个 (`~/develop/foo` → `foo`, 撞名加序号), 所以这个工具的用途是**起一个更好的名字**。这里的默认 wizard 出生时取聊天名; 它若还叫旧聊天名, 会跟着改 (wizard 的名字全局唯一, 撞名加后缀, 返回里的 `wizardRenamed` 就是它的新名字)。wizard 自己的名字用 wizard_identity 改, 与这里无关。用户说「给这个群起名叫 daily」「这个群叫什么」(不传 `name` 就是读) 「取消命名」(传 '-') 时调它。名字全机唯一、大小写不敏感。",
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

registerRare(
  "list_chats",
  {
    title: "List every chat and its sessions",
    description:
      "(罕用 · 同 IM `/chats`) 每个聊天的名字与住在那里的 wizard。只在要给 notify / spawn 的 `chat` 找聊天名时用; 找 wizard 用 wizard_roster。",
    inputSchema: {},
  },
  async () => unwrap("list_chats", await daemonPost("/chats/list", {})),
);

server.registerTool(
  "peek_peer",
  {
    title: "Read what another wizard has been saying",
    description:
      "**不打扰**地读另一个 wizard 的会话: 首行是它此刻的状态 (正在生成 / 空闲 / 停在哪个工具调用上等人点), 下面是它最近 N 个来回的正文 —— `▸` 是别人对它说的, `◂` 是它对这句最新说的一句 (跑完的是终句, 还在跑的是途中最近那句), 最后一条给得最全; 截掉的地方都标了 `…(+N)` / `…(略 N 字)…`。全部从它的 transcript 读: 只有说出来的话, 没有工具调用的过程, 保温的 ping/pong 已经剔掉。回答「.fix 进展如何」「它卡在哪」, 或者判断要不要推它一把, 都读这里。这是**一个会话**的视角 (它从各处听到的都在里面); 要看**一个群**里谁对谁说了什么、或你和它的私聊往来, 用 read_chat。只读, 随便轮询。",
    inputSchema: {
      name: z.string().describe(ADDRESS_DOC),
      turns: z.number().optional().describe("回最近多少个来回 (1-40, 默认 6); 一个来回 = 一句问话 + 它的回答。"),
    },
  },
  async ({ name, turns }) => unwrapText("peek_peer", await daemonPost("/peers/peek", { name, ...(turns ? { turns } : {}) })),
);

server.registerTool(
  "read_chat",
  {
    title: "Read chat history like a person would",
    description:
      "像人翻聊天记录那样读往来, 一行一句: `[时刻] 谁 → 谁: 说了什么`。三级收窄, 每一级都可以不给: `role` (谁的视角 —— 只留它说的或听的) → `chat` (哪个群 —— 只留那个群里公开说的) → `target` (和谁 —— 只留与它的往来)。什么都不给 = 你这一轮所在的群: 人说的、各个 wizard 答的、wizard 之间公开说的都在里面。只给 `target` = 你和它的全部往来 (含 tell_peer 默认走的私聊, 群里看不见的那部分); `role` + `target` = 那两方之间; 只给 `role` = 它在所有群与私聊里的往来; 再加 `chat` 就限定在那个群里。没给 `chat` 时每行会标出这句是在哪个聊天 / 私聊里说的。一条消息一行起头, 正文的续行缩进; 还没等到回答的问话行尾标 `(还没有回复)`。\n" +
      "按时间和条数读: 默认回最新的 `limit` 条; `until` = 只看那之前的 (往回翻页), `since` = 从那时起 (只给 `since` 就从它往后数 `limit` 条)。回执末尾给出翻页用的时刻, 原样传回即可; 往回已经没有了会明说到头。\n" +
      "只有正文: 每个来回取问话和终句, 工具调用的过程不在里面, 保温的 ping/pong 已经剔掉。记录是从各个 wizard 当前会话的 transcript 现拼的: 一个 wizard `/clear` 或交接之前说的不在里面, 除点名的 role / target 外只并最近一周动过的会话。用户说「群里刚才聊了什么」「.fix 之前怎么答的」「我上次让 .docs 干了什么」, 或者你被叫进一个已经聊了一阵的群、需要来龙去脉时调它。要读**某一个 wizard** 会话里的原始对话用 peek_peer。",
    inputSchema: {
      role: z.string().optional().describe("谁的视角: wizard 的名字 ('fix' / '.fix') 或人的 userid。省略 = 不限 (给了 `target` 时默认是你自己)。"),
      chat: z.string().optional().describe("哪个群: 聊天名 (wizard_roster 里的 home 聊天名) 或裸 principal。省略 = 不限群 (公开与私聊都算); 三个都省略 = 你这一轮所在的群。"),
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

// ── 跟别的 wizard 说话 ──────────────────────────────────────────────────────
// 一个工具, 一个语义: **说一句, 不等**。注入完就返回; 对方干完那一轮, 守护进程把它
// 的结论作为新的一轮自动送回这里 (回执)。发话方的 pane 全程在自己手上。
// `send_peer` 留着当别名 —— 正在跑的 wizard 的 MCP 进程是旧代码, 换个名字不能把
// 它们的通路掐断。
const TELL_SCHEMA = {
  name: z.string().describe(ADDRESS_DOC),
  text: z.string().describe("Message to inject. Plain prompt text; slash commands like '/clear' also work."),
  priority: z
    .enum(["normal", "urgent", "now"])
    .optional()
    .describe(
      "对方**正忙**时怎么投 (它闲着三者一样, 立刻投)。`normal` (默认) 等它这一轮结束再投 —— 派新活用它, 否则你和别人的两段话会挤进同一个输入框被当成一轮读掉; 等的是你这次调用 (最多 `waitSec`)。`urgent` 先打断它这一轮 (同 stop_wizard 的 interrupt) 再投 —— 只给真紧急的改道, 它手上那一轮作废; 那一轮若是别的 wizard 派的活, 不打断, 降成 normal (回包 `urgentDowngraded`)。`now` 不等不打断, 落进它的输入框并进当前这一轮 —— 插话、补一句、答它的问。带 `re` 续问时默认 `now`。返回里 `wasBusy` / `interrupted` / `waitedMs` 说明实际怎么投的。",
    ),
  waitSec: z.number().optional().describe("`normal` 等它闲下来最多等多少秒 (10-3600, 默认 600)。等不到就返回失败, 不会强行投。"),
  public: z
    .boolean()
    .optional()
    .describe("true = 在公开频道 (你这一轮所在的群) 里说: 群里出 `.你 → .它` 气泡, 它的回复也进群 (同时照样回执给你)。默认 false = 私聊, 只记在 rolepage。需要人知道 / 该当着人讨论才用 true。带 `job` 时不起作用 —— 工单里的往来一律私聊。"),
  job: z.string().optional().describe("这次派活归到某个工单名下 (open_job 给的 id)。**fan-out 一定要带上它**: 回执里会带 `还差几份 / 全部到齐`, 「齐了吗」由守护进程数给你, 不用你自己在上下文里记。带了它就一律私聊, 往来与回执都不进群。"),
  role: z.enum(["exec", "reviewer", "expert"]).optional().describe("它在这张工单里的角色 (只在带 `job` 时有意义, 记进账本供工单页与名册显示): `exec` 执行 (默认) · `reviewer` 白板评审 · `expert` 借来答问的专家。"),
  receipt: z
    .boolean()
    .optional()
    .describe("false = 放出去就不管了, 不要回执 (纯通知、或者你根本不关心它说什么)。默认 true。"),
  kind: z
    .enum(["task", "ask", "fyi"])
    .optional()
    .describe("对方该怎么接这句话 (与 `priority` 的何时投、`receipt` 的要不要回执正交): `task` (默认) 一件活, 干完收口 `RESULT:`; `ask` 只答一个问题, 别为它开工; `fyi` 知会, 不用回 —— 自动不要回执、不进工单、不进群。"),
  re: z.string().optional().describe("续问: 回执或回包里的件号 (`t…`)。接着那件活说, 沿用它的工单与频道; 对不上就按新活发出 (`reUnknown`)。"),
  deadline: z.number().optional().describe("最多等它多少秒 (60-43200, 默认 3600); 到点没答完你收到一份 timeout 回执。"),
  force: z
    .boolean()
    .optional()
    .describe("派新活给一个缓存已冷、ctx ≥100k 的 wizard 时, 守护进程先退回一行代价说明不投递 (唤醒 ≈ 白板 spawn 的几倍)。确认这件活真依赖它那段上下文, 才带 `force:true` 重发; 否则白板 spawn。续问 (`re`)、`now`、`ask` / `fyi` 不受此限。"),
  chain: z
    .boolean()
    .optional()
    .describe("你此刻在答别的 wizard 派的活时, 这次派出的活默认算那件活的子活: 它回来之前你这一轮的终句不会先交给上游, 它回来那一轮的终句再续回上游。false = 这件活与上游无关 (顺手的测试、旁支), 回执照常回你, 但不挂住你给上游的交代。"),
};

const TELL_DESC =
  "跟另一个 wizard 说话 —— 文本原样落进它的输入框, 它当成新的一轮接手 (派活、答它的问题、叫它继续都走这里)。目标不存在就先 spawn_wizard / clone_wizard。\n" +
  "**说完就返回**: 对方干完那一轮, 它的最后一条消息作为**新的一轮**自动送到你这里 (回执, 带信封说明是谁、哪场对话、工单还差几份); 你正忙时回执排队等你说完。\n" +
  "默认私聊, 只记在双方 rolepage; 守护进程给 `text` 挂信封 (发话人、私聊/公开、`RESULT: …` 收口)。拒绝对自己发送。";

const tellBody = (a: { name: string; text: string; kind?: string; priority?: string; waitSec?: number; job?: string; role?: string; public?: boolean; receipt?: boolean; re?: string; deadline?: number; chain?: boolean; force?: boolean }) => ({
  name: a.name,
  text: a.text,
  ...(a.kind ? { kind: a.kind } : {}),
  ...(a.priority ? { priority: a.priority } : {}),
  ...(a.waitSec ? { waitSec: a.waitSec } : {}),
  ...(a.job ? { job: a.job } : {}),
  ...(a.role ? { role: a.role } : {}),
  ...(a.public ? { public: true } : {}),
  ...(a.receipt === false ? { receipt: false } : {}),
  ...(a.re ? { re: a.re } : {}),
  ...(a.deadline ? { deadline: a.deadline } : {}),
  ...(a.chain === false ? { chain: false } : {}),
  // 一律显式带上: 守护进程据「有没有这个键」认出老 MCP 进程 (见 /peers/tell 的冷门控)。
  force: a.force === true,
});

server.registerTool(
  "tell_peer",
  { title: "Say something to another wizard (reply comes back by itself)", description: TELL_DESC, inputSchema: TELL_SCHEMA },
  async (a) => unwrap("tell_peer", await daemonPost("/peers/tell", tellBody(a))),
);

server.registerTool(
  "send_peer",
  {
    title: "(deprecated) alias of tell_peer",
    description:
      "同 tell_peer (旧名, 只为不打断正在跑的旧会话而保留)。新调用一律用 tell_peer。",
    // 参数与 tell_peer 一样收, 但不再背一份参数说明: 别名只为老调用不断, 不该再占一份上下文。
    inputSchema: Object.fromEntries(Object.entries(TELL_SCHEMA).map(([k, v]) => [k, v.describe("")])) as typeof TELL_SCHEMA,
  },
  async (a) => unwrap("send_peer", await daemonPost("/peers/tell", tellBody(a))),
);

server.registerTool(
  "notify",
  {
    title: "Post a message into a chat for people to read",
    description:
      "把一段 markdown 贴进一个企微聊天**给人看**。和 tell_peer 分工明确: tell_peer 是把话塞进另一个 agent 的输入框 (驱动它干活), notify 是说给人听 —— 不会触发任何一轮对话。\n" +
      "`to` 省略 = 你这一轮所在的群 (人从哪个群叫的你就是哪个; 私聊轮则是你的 home 群); 要发到别的群就写聊天名 (wizard_roster 里的 home 聊天名), 一次可以写多个。气泡头自动写成 `emoji .你的名字` 并挂上你的 rolepage 链接, 那边的人一眼知道是谁。\n" +
      "什么时候用: 长活跑完了要通知另一个群的人; 一批分身收工后把汇总播给发起那个群; 定时任务 (schedule_task) 到点跑完把结论送到该看的人那里。",
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
    title: "(deprecated) block until another wizard stops working",
    description:
      "**一般不需要它了**: `tell_peer` 之后对方的结论会自动作为新的一轮送到你这里 (回执), 你不必守着。保留它是因为有一件事只有它做得到 —— **在同一轮里拿到答案**: 下一步硬依赖对方的结果、把工作拆成两轮会丢上下文时, 用它阻塞等; 以及 `need:1` 那种「谁先完事就先处理谁」。代价是你这个 pane 在等的过程中什么也干不了。\n" +
      "被它取走的那一份**不会再作为回执注入**一遍 (返回里 `delivered: true` = 回执已经抢先进过你的会话, 别重复处理)。\n" +
      "挂起, 直到点名的 wizard 停下来 (它的终端不再显示中断提示), 然后返回它最新的回复。超时先到则返回 `idle: false` 与原因: 它只是还在干, 你可以 peek 一眼再等。很便宜: 守护进程轮询的是 pane, 不烧 token。回的只算**你上次 tell_peer 之后**它说的: 它收口了 `RESULT: …` 就只回 `result` (`omitted` = 正文还有多少字没给, 要读用 peek_peer), 没收口才回 `lastText` (超长掐中间); `stale: true` = 它停下了却没有新回复 (卡在弹窗上, 或那句话没被接住) —— peek_peer 看一眼, 别把它当成答完了。\n" +
      "**真要等一批就用 `names` 一次等一组**, 别一个一个等: 它们本来在同时干活, 串行等的墙钟是所有人之和, 并行等只等最慢的那一个 (不过 fan-out 的常规做法是给 `tell_peer` 带 `job`, 让回执自己回来并替你数「齐了吗」)。等一组时 `results` 按你给的顺序逐个回, 只等一个则直接摊平在顶层。`need` 决定满几个就返回 (默认全部; `need:1` = 谁先完事就先处理谁, 剩下的还在跑, 再调一次接着等)。",
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

registerRare(
  "run_agent_graph",
  {
    title: "Run a loop graph over several tagged agents",
    description:
      "(罕用) 守护进程驱动的循环流水线: `steps` 依次给 `nodes` 里的 wizard 发提示、等它答完、把回复喂给下一步 (`{{last}}` / `{{<tag>}}` / `{{round}}`), 整表走 `rounds` 遍或回复含 `until` 即停。只活在内存, reload 即丢。仅当用户明说「互相迭代到收敛」时用; 平时 tell_peer + 回执就够。",
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

registerRare(
  "graph_status",
  {
    title: "Inspect running / finished agent graphs",
    description:
      "(罕用) run_agent_graph 的进度: 每步的轮次、目标、状态与回复。省略 runId = 本聊天全部。",
    inputSchema: {
      runId: z.string().optional().describe("Run id from run_agent_graph. Omit to list all runs for this chat."),
    },
  },
  async ({ runId }) => {
    const qs = runId ? `?runId=${encodeURIComponent(runId)}` : "";
    return unwrap("graph_status", await daemonGet(`/graph/status${qs}`));
  },
);

registerRare(
  "stop_graph",
  {
    title: "Cancel a running agent graph",
    description:
      "(罕用) 当前步之后停掉 run_agent_graph, 不打断正在生成的 wizard (要打断用 stop_wizard)。",
    inputSchema: { runId: z.string().describe("Run id from run_agent_graph.") },
  },
  async ({ runId }) => unwrap("stop_graph", await daemonPost("/graph/stop", { runId })),
);

// 交接只有一个动词: 不点名 = 交接你自己 (你写简报), 点名 = 替别人交接 (守护进程让它写)。
// 两条路由不变 —— 已在跑的 wizard 的 MCP 进程还在调老名字 wizard_handoff_self。
const handoffSelf = (tool: string, brief: string) =>
  daemonPost("/wizard/handoff-self", { brief }).then((r) => unwrap(tool, r));

server.registerTool(
  "handoff",
  {
    title: "Hand work over to a fresh context (yourself or another wizard)",
    description:
      "把一段工作压成简报、原地换一个全新的会话接着干 (新进程、上下文清零; 名字 / cwd / 模型 / 身份的系统提示照旧), 简报作为新会话的第一条消息贴回去。\n" +
      "**不传 `name` = 交接你自己**: 简报由你写在 `brief` 里, 守护进程等你这一轮说完再重开 (新会话里 MCP 工具也换成最新的)。简报要写到零上下文的自己仅凭它就能接着干: 总目标 / 已完成与关键决策 / 当前状态 / 有序的下一步 / 关键文件与非显然的坑。\n" +
      "**传 `name` = 替那个 wizard 交接**: 守护进程让它自己写简报 (`focus` 指定要特别交代的点), 抓到后给它重开并贴回; 返回被带过去的那份简报。",
    inputSchema: {
      name: z.string().optional().describe("替谁交接 —— wizard 的名字 ('fix' / '.fix')。省略 = 你自己。"),
      brief: z.string().optional().describe("交接你自己时必填: 简报全文, 自洽、具体、可执行。"),
      focus: z.string().optional().describe("替别人交接时可选: 简报里要特别交代的点。"),
      timeoutSec: z.number().optional().describe("替别人交接时等它写简报的上限秒数 (30-7200, 默认 600)。"),
      pane: z.string().optional().describe("(旧参数) 按 tmux pane id 指定对方, 同 `name`。"),
    },
  },
  async ({ name, brief, focus, timeoutSec, pane }) =>
    !name && !pane
      ? brief?.trim()
        ? handoffSelf("handoff", brief)
        : fail("handoff: 交接你自己要写 `brief` (零上下文也能接手的简报); 替别人交接就传 `name`")
      : unwrap("handoff", await daemonPost("/handoff", {
          ...(pane ? { pane } : {}),
          ...(name ? { name } : {}),
          ...(brief ? { brief } : {}),
          ...(focus ? { focus } : {}),
          ...(timeoutSec ? { timeoutSec } : {}),
        })),
);

// 定时任务 —— 到点把一句话说给一个 wizard 听。和人在群里 at 它说同一句话完全等价:
// pane 死了会被拉起来, 它干完的活照常出现在群里和详情页。这是 claude/codebuddy 自带
// 定时器给不了的那一半: 它们的循环活在会话里, 会话一死就没了; 这个活在 daemon 里。
server.registerTool(
  "schedule_task",
  {
    title: "Schedule a prompt to run in a wizard session, on a recurring or one-off schedule",
    description:
      "排一个**到点自动执行**的活, 归在你名下 (rolepage「日程」可见)。用户说「每个工作日晚上 9:30 跑一下 xxx」「每天早上看看 yyy」「每 2 小时同步 zzz」「明早 9 点整理 www」时调它。守护进程级, 跨 CLI 重启仍在。\n" +
      "`when` 用人话原样写, 别翻译成 cron (「每个工作日晚上9:30」「每隔两个小时」「白天每小时」「20 分钟后」「明早 9 点」都认); 解析不出会报错 —— 把原话回给用户让他重说, 别自己猜。\n" +
      "**默认到点新起一个白板 wizard** (`<你>-task-xxxx`) 执行, 干完自动收掉; 只有用户明说「在 .foo 里继续」才传 `name` 投进那个已有会话 (它到点正忙就等它这一轮结束再投, 等满 30 分钟仍忙才另起白板执行; prompt 本身要求「建 wizard 去干」时也照新建办, 除非显式传 `fresh:false`)。所以 `prompt` 要写成零上下文也能执行的完整指令。\n" +
      "「有新东西才处理」写成任务文件里的 gate (没活这一轮就不放枪), 别让到点起的 wizard 自己看一眼没有就退出 —— 那是每轮空转一个 pane。\n" +
      "存成功后**必须把回显的 `when` 和 `next` 念给用户确认**。任务落成可直接改的 `~/.wezard/tasks/<id>.task.mjs` (返回的 `file`): 组合触发条件、「有活才放枪」的 gate、暂停, 都 Read 那个文件 —— 写法在它的头注释里, 存盘即生效。",
    inputSchema: {
      when: z.string().describe("什么时候跑, 人话原样传: 「每个工作日晚上9:30」「每天早上9点」「白天每隔一个小时」「工作时间每半小时」「每30分钟」「20分钟后」「明早9点」。时间窗口 (白天 / 工作时间 / 8点到20点) 会被解析成筛子, 窗外的那些枪直接吞掉。"),
      prompt: z.string().describe("到点要说给那个 wizard 听的话。写成自洽的完整指令 (要做什么、在哪个目录/文件上、做完怎么汇报), 别依赖当前对话的上下文。里面可以留 `{{名字}}` 占位, 由任务文件里的 gate 填。"),
      name: z.string().optional().describe(`点名在**哪个已有 wizard**里跑 —— 只有用户要求「在它那儿继续」时才传。省略 = 到点新建一个白板 wizard 干完就收 (默认, 也是「定时新建 wizard 干 xxx」要的那个)。传了它还想要新建, 再加 \`fresh:true\`: 那时它只当模板, 新 wizard 继承它的聊天/目录/模型。${ADDRESS_DOC}`),
      quiet: z.boolean().optional().describe("true = 有事才说: 到点不在群里预告, 那一轮私下跑, 它看完没事就只回一行 `QUIET`, 什么也不发; 有事守护进程才把它的终句转进群。巡检 / 盯梢类 (「每小时看一眼 CI, 挂了才告诉我」) 用它。没活连枪都不该放的, 写 gate。"),
      fresh: z.boolean().optional().describe("覆盖默认: true = 每次到点新建白板 wizard 执行 (给了 name 时用来表达「在它的目录下新开一个干」), false = 注入 name 指向的已有会话。默认由 name 推断 (给了 name = false, 没给 = true)。"),
      id: z.string().optional().describe("任务 id, 同时也是文件名 (`~/.wezard/tasks/<id>.task.mjs`)。省略则从 note/prompt 生成。取个好认的短名 —— 之后你要改这条任务, 改的就是那个文件。"),
      note: z.string().optional().describe("给人看的一句话备注, 在 list_tasks 里回显。"),
    },
  },
  async ({ when, prompt, name, note, fresh, quiet, id }) =>
    unwrap("schedule_task", await daemonPost("/tasks/schedule", {
      when, prompt, name: name ?? "", note: note ?? "", id: id ?? "",
      ...(fresh === undefined ? {} : { fresh }),
      ...(quiet ? { quiet: true } : {}),
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
// 配置面: 整份 ConfigSchema 渐进式披露。说明 / 类型 / 默认 / 谁能改 / 何时生效都由守护
// 进程从 schema 读出来渲染, 这里不复述任何一项配置。
server.registerTool(
  "config_get",
  {
    title: "Read wezard config",
    description:
      "读 wezard 守护进程的配置, 一层一层展开: 不给 path 列各节一行说明; 给 path (点分, 如 'approval.danger' / 'models.tiers.light.model') 列这一层的子项 —— 类型、当前值、默认值、说明, 以及 ✋ (改动要人在卡片上确认) / ↻ (改完要 reload 才生效) 标记, * 标出与默认不同的项; 叶子给完整详情。`models` 下附带各档模型的实际用量做依据。想给人提配置建议时先读它, 再用 config_set 的 dryRun 拿 diff。机器人凭据与口令不可见。Keywords: 设置、配置、cfg、allowFrom、审批、窗口、danger、模型分档、tier、keepalive。",
    inputSchema: {
      path: z.string().optional().describe("点分路径, 省略 = 顶层各节。数组项用下标 ('sync.targets.0')。"),
    },
  },
  async ({ path }) => unwrapText("config_get", await daemonPost("/config/get", { path: path ?? "" })),
);

server.registerTool(
  "config_set",
  {
    title: "Change wezard config",
    description:
      "改一项 wezard 配置: 先过 schema 校验 (整份配置一起验, 不会写出让守护进程起不来的值), 再经 config-writer 写进 config.jsonc (注释保留)。`dryRun:true` 只返回改前→改后与 jsonc diff, 不写。权限按路径分级 (config_get 里的 ✋): 放权项 —— allowFrom、approval.*、CLI 二进制与启动参数、sync、监听 / 外送地址、defaultChat —— 守护进程会推一张确认卡给人, 点了才落盘 (几分钟没人点就先回 pending, 点了之后自动写, 结果捎在你下一条消息上, 别重发); 其余直接写。热生效的项写完即用, 其余回包会说要 reload。人让你「改个设置」时先 config_get 找到确切路径。",
    inputSchema: {
      path: z.string().describe("点分路径, 如 'models.tiers.light.model'、'wrc.mirror.keepalive.rounds'。"),
      value: z.any().optional().describe("新值, 按该项类型给 JSON (true / 5 / \"opus\" / [\"a\"] / {...}); 写成字符串的也会按类型解析。op=unset 时省略。"),
      op: z.enum(["set", "add", "remove", "unset"]).optional().describe("set (默认) 整体替换; add / remove 往数组里加 / 删一项 (value 可以是单项或数组); unset 删掉这一项, 回到默认值。"),
      dryRun: z.boolean().optional().describe("true = 只看 diff 与校验结果, 不写、不发卡。"),
    },
  },
  async ({ path, value, op, dryRun }) =>
    unwrapText("config_set", await daemonPost("/config/set", {
      path,
      ...(value !== undefined ? { value } : {}),
      ...(op ? { op } : {}),
      ...(dryRun ? { dryRun } : {}),
    })),
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
      "你自己是谁: 全局唯一的名字 (即地址, 别人用它找你)、home 聊天、工作区、职责、记忆、家谱 (谁生的你、你生了谁), 以及此刻的 contextTokens 与 handoffSuggested。用户问「你是谁」「你叫什么」「你在哪个目录」「你有几个分身」时先调它; 要做任何编排之前也先调它 —— 你得知道自己的工作区在哪、手里已经有哪些分身。handoffSuggested=true 表示上下文已过交接判断线 (200k): 手上这摊告一段落、或往后的活不再依赖前面的材料, 就 handoff。",
    inputSchema: {},
  },
  async () => unwrap("wizard_whoami", await daemonPost("/wizard/whoami", {})),
);

server.registerTool(
  "wizard_identity",
  {
    title: "Name yourself / declare your job",
    description:
      "改名字、写职责。名字就是别人喊你的那个词 (`.name`), **全机唯一**, 与聊天名无关 (给聊天起名用 name_chat): 撞名时自动加 `-N` 后缀, 返回里的 `name` 是落定的那个, `renamed` 会告诉你发生了改写。职责是一句话的「我是干什么的」—— 别的 wizard 在名册里读到它, 据此决定该不该找你。用户说「你以后叫 X」「你负责 X」时调它;只传要改的那个字段。",
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
      "这个世界上所有的 wizard 与 clone, 一个一行: 名字 (全局唯一, 即地址)、忙闲 (忙 = 正在生成 / 闲 = 活着没在跑 / 冷 = 没有 pane, 发消息会唤醒)、**home 聊天** (群 / 单聊)、**工作区**、模型 (还没应答过的没有这一项)、多久没动、家谱 (父 / 分身); 写了职责的多一行职责, 活着的多一行「最近」—— 它最近一个来回 (`▸` 问 `◂` 答, 各截到 80 字, 截了带 `…`)。跨聊天的也在里面。这是你感知同伴的唯一入口 —— 用户说「还有谁在跑」「这个群里有谁」「谁在弄那个项目」「让懂 X 的那个来看看」时先调它, 拿到目标的名字再 tell_peer / peek_peer; 要往某个群里对人说话则把那个群名交给 notify。\n" +
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

server.registerTool(
  "route_candidates",
  {
    title: "Who could take this task",
    description:
      "一件活要不要转给**已有**的 wizard, 拿不准该给谁、或拿不准值不值时调它 (刚派过同一摊活、职责正对口、人点了名只说明相关, 成本仍要看 ctx 与冷热)。守护进程替你把能算的都算好: 每个已有 wizard 的职责 / 最近的话与这件活重叠了哪些词, 它当前上下文里 (上次压缩之后) 读过哪些文件、其中哪些被这件活点到, 它在不在同一个工作区、忙闲、上下文多大 (`ctx`), 缓存冷热与唤醒要重写多少缓存 (对比白板 spawn 的倍数)。没有任何交集的不列, 列出来的按证据强弱排 (文件命中 > 职责 > 最近的话), 末尾永远附「新 spawn」; 证据弱又贵的标 ⚠「不划算」。不出分数、不替你拍板。",
    inputSchema: {
      task: z.string().describe("这件活, 原话或一句概括都行 —— 带上提到的文件名 / 模块名 / 函数名, 文件命中是最强的证据。"),
      cwd: z.string().optional().describe("这件活落在哪个工作区。省略 = 你自己的工作区。"),
      limit: z.number().optional().describe("最多列几个候选 (1-20, 默认 5)。"),
    },
  },
  async ({ task, cwd, limit }) =>
    unwrapText("route_candidates", await daemonPost("/wizard/route", { task, ...(cwd ? { cwd } : {}), ...(limit ? { limit } : {}) })),
);

server.registerTool(
  "dispatch",
  {
    title: "Dispatch a task (default decision by the daemon)",
    description:
      "派活一步到位: 守护进程查候选 (同 route_candidates) → 过成本门控 → 决定转给已有的 wizard 还是按档白板 spawn → 用 tell_peer 投出去 (默认公开: 气泡与它的回复进你这一轮的群, 回执照常回你), 返回 `decision` (existing / spawn)、`reason`、落到谁 (`name`)、件号 `turn`, spawn 的还有 `tier` / `model`。\n" +
      "默认决定: 证据够强 (读过这件活点到的文件, 或职责撞上两个以上的词)、不忙、划算、过得了冷门控的头一个候选 → 转给它; 都不是 → 白板 spawn, 档位默认 lead→hard、一句话小活→light、其余 standard。\n" +
      "你不同意就**显式推翻**: `to` 点名转给谁, `spawn:true` 硬要新的, `force:true` 越过冷门控 (真依赖它那段上下文), `tier` 换档。`lead:true` = 复杂活 (要 coder + reviewer、要来回几轮): 白板起一个 hard 档的 lead 由它组队 (带 `to` 则让那个已有 wizard 当 lead, 组队打法随这一句带过去)。",
    inputSchema: {
      task: z.string().describe("这件活, 原样转给对方的文本 —— 带上提到的文件名 / 模块名, 文件命中是转给已有 wizard 的最强证据。"),
      name: z.string().describe("若决定新 spawn, 它的名字: 这件事的短名 (全机唯一)。转给已有的时不用。"),
      description: z.string().describe("若决定新 spawn, 它往后的职责, 一句话。"),
      tier: z.enum(TIERS).optional().describe("spawn 时的档位 (由轻到重 mini / light / standard / hard / ultra), 推翻默认 (lead→hard、小活→light、其余 standard; mini / ultra 只能显式给)。"),
      to: z.string().optional().describe("推翻默认: 直接转给这个已有 wizard (名字)。"),
      spawn: z.boolean().optional().describe("推翻默认: 不看候选, 一定白板 spawn。"),
      force: z.boolean().optional().describe("越过冷门控: 缓存冷且 ctx ≥100k 的候选默认不转; 确认这件活真依赖它那段上下文才给 true。"),
      lead: z.boolean().optional().describe("复杂活交给一个 lead 组队 (见描述)。**只有它开需求根单** (回包里的 `job`), 普通小活不开单; 根单在 lead 交付后仍开着, 等人验收: `lead:true` 的往来一律私聊 (`public` 不起作用)。人认可 → `close_job(job)` 归档并回收 lead, 人说不对 → `tell_peer({name, re, job})` 给 lead 返工, 不要了 / 先放着 → `close_job({job, as:\"cancel\"|\"shelve\"})`。对人别提单号。"),
      criteria: z.string().optional().describe("验收标准 (`lead:true` 时记进根单): 做成什么样算交付。你猜的就在回复里向人复述一句再派。"),
      public: z.boolean().optional().describe("默认 true (气泡与回复进群); false = 私聊, 只记 rolepage。"),
      deadline: z.number().optional().describe("同 tell_peer 的 deadline (秒)。"),
      dryRun: z.boolean().optional().describe("只要默认决定与理由, 不执行。"),
    },
  },
  async (a) => unwrap("dispatch", await daemonPost("/dispatch", a)),
);

// 换模型和 spawn 时挑模型是同一条路: 守护进程在目标 pane 里打开 `/model` 列表,
// 读出这台 CLI 此刻真有的每一项, 挑最接近的, 方向键移过去选中。
server.registerTool(
  "set_model",
  {
    title: "Switch a wizard's model / effort",
    description:
      "给一个**已经在跑**的 wizard 换模型 (和/或推理档位 `effort`) —— 默认换你自己, `name` 点名就换那个 wizard。口语化写要什么 ('opus' / 'haiku' / 'sonnet 5' / '最新的 opus' / '默认'), 守护进程在它的 pane 里打开 `/model` 列表, 读出这台 CLI 此刻真有的每一项, 挑最接近的一项选中; 返回里的 `model` 是真正落地的那一项, `catalog` 是列表里的全部 —— 对不上时 (`ok:false`) 照着 `catalog` 重说一遍。默认只对这一个会话生效 (`scope:'session'`), 不改新开会话的默认模型; `scope:'default'` 则同时把它设成这台 CLI 此后**每个新会话**的默认模型 —— 那是全机的设置, 只在人明说「以后默认都用 X」时才用。返回里的 `scope` 是实际落在哪一档。它之后被重启也会回到这个模型上。正在干活的也能换 (从下一次请求起生效), 但换模型会让它的对话缓存整份重读一遍 —— 别来回切。用户说「换成 opus」「这个用 haiku 跑就行」「把 .fix 切到 sonnet」时调它; 你自己判断手上的活配不上/撑不起当前模型时也可以主动换。",
    inputSchema: {
      model: z.string().optional().describe("要换到哪个模型, 口语化写: 'opus' / 'haiku' / 'sonnet 5' / 'opus 4.7' / '最新的 fable' / '默认'。只写家族名 = 那个家族最新的一个。只换 effort 时省略。"),
      effort: z.enum(EFFORTS).optional().describe("顺带 (或只) 换推理档位 —— 只对这个会话生效, 不改全机默认; 之后它重启也沿用。返回里的 `effort` 是落地的那一档。"),
      name: z.string().optional().describe("换谁的 —— wizard 的名字 ('fix' / '.fix')。省略 = 换你自己。"),
      scope: z
        .enum(["session", "default"])
        .optional()
        .describe("'session' (默认) = 只换这一个会话; 'default' = 换这个会话, 并设为此后所有新会话的默认模型 (改的是 CLI 的全局设置, 不指定模型的新 wizard 都会跟着变)。"),
    },
  },
  async ({ model, effort, name, scope }) =>
    unwrap("set_model", await daemonPost("/wizard/model", { ...(model ? { model } : {}), ...(effort ? { effort } : {}), ...(name ? { name } : {}), ...(scope ? { scope } : {}) })),
);

// 生孩子与分身是两个操作, 不是一个开关的两档: 一个白纸起步、可以去别的目录;
// 一个 fork 调用方此刻的上下文、必须留在原地。拆成两个工具, 模型选的是动词,
// 而不是在一个布尔上猜。两者落到同一条路由 (`inherit` 由工具定死)。
const offspringShape = {
  description: z.string().describe("它负责什么, 一句话。它会写进它的系统提示, 也会出现在名册里让别人看到。"),
  name: z.string().optional().describe("它的名字 (如 'docs'、'fix', 带不带 '.' 都行)。全机唯一。省略则按 description 首词生成。"),
  task: z.string().optional().describe("就位后立刻派下去的第一件活 (私聊)。省略则它就位待命。"),
  chat: z.string().optional().describe("把它生在另一个聊天里 (wizard_roster 里的 home 聊天名)。省略 = 你自己的聊天, 这是绝大多数情况。"),
  cli: z.enum(["claude", "claude-internal", "codebuddy"]).optional().describe("用哪个 CLI。省略则继承。"),
  tier: z.enum(TIERS).optional().describe("按难度选档 (由轻到重), 落到配置 `models.tiers` 里那一档的 {cli, model, effort}: mini = 机械一步 (照单执行、不用判断), light = 跑腿 (查找、搬运、跑命令), standard = 常规实现, hard = 要判断 (设计、排障、审查), ultra = 最难 (架构取舍、疑难排障、关键评审)。同时给了 model / effort / cli 的, 以显式值为准; 克隆换不了 CLI。返回里的 `via` 说明每项来自显式、档位还是继承。当前各档是什么见宪章, 或 config_get({path:'models'})。"),
  model: z.string().optional().describe(MODEL_DOC),
  effort: z.enum(EFFORTS).optional().describe(EFFORT_DOC),
  job: z
    .string()
    .optional()
    .describe("归到某个工单名下 (open_job 给的 id)。过程在各自的 rolepage 与工单页, 不进群; close_job 会把它们整批回收掉。"),
  role: z.enum(["exec", "reviewer", "expert"]).optional().describe("它在这张工单里的角色 (只在带 `job` 时有意义, 记进账本供工单页与名册显示): `exec` 执行 (默认) · `reviewer` 白板评审 · `expert` 借来答问的专家。"),
  chain: z.boolean().optional().describe("同 tell_peer 的 `chain`: 带了 task 而这件活与你此刻在答的上游那件无关 (旁支、测试) 时给 false, 它的回执就不挂住你给上游的交代。"),
  keepalive: z
    .boolean()
    .optional()
    .describe("要不要被 keepalive 心跳保温 (空闲时定期 ping 一下防 prompt cache 过期)。false = 永远不保温, 省下那份 ping 的钱 —— 适合跑腿一次就收工的; true = 明确要保温 —— 适合会长期挂着、随时可能被叫醒接手的。省略则按 daemon 配置的默认值。"),
};

type Offspring = { lead?: boolean; description: string; name?: string; task?: string; from?: string; detached?: boolean; cwd?: string; chat?: string; cli?: string; model?: string; effort?: string; tier?: string; job?: string; role?: string; keepalive?: boolean; chain?: boolean };

const bear = (tool: string, inherit: boolean) => async (a: Offspring) =>
  unwrap(tool, await daemonPost("/wizard/clone", {
    inherit,
    description: a.description,
    ...(a.name ? { name: a.name } : {}),
    ...(a.task ? { task: a.task } : {}),
    ...(a.from ? { from: a.from } : {}),
    ...(a.detached ? { detached: true } : {}),
    ...(a.job ? { job: a.job } : {}),
    ...(a.role ? { role: a.role } : {}),
    ...(a.cwd ? { cwd: a.cwd } : {}),
    ...(a.chat ? { chat: a.chat } : {}),
    ...(a.cli ? { cli: a.cli } : {}),
    ...(a.model ? { model: a.model } : {}),
    ...(a.effort ? { effort: a.effort } : {}),
    ...(a.tier ? { tier: a.tier } : {}),
    ...(a.keepalive !== undefined ? { keepalive: a.keepalive } : {}),
    ...(a.chain === false ? { chain: false } : {}),
    ...(a.lead ? { lead: true } : {}),
  }));

const OFFSPRING_TAIL =
  "名字全局唯一: 撞上的 wizard 静默超过一天就直接顶掉它、名字归新的; 撞上一个还在的 wizard 返回 409, 附 `alive` / `busy` / `idleForMs` —— 据此分辨它是真在干活 (换个名字) 还是冷绑定 (先 stop_wizard 再同名重生); 返回里的 `name` 是落定的名字。 它自己也能再生分身, 层级不限; 名下同时活着的有上限。";

server.registerTool(
  "spawn_wizard",
  {
    title: "Spawn a blank child wizard",
    description:
      "**从白板生**一个子 wizard —— 新的 tmux pane、自己的全局名字 (`.name`)、自己的职责, 归你管 (家谱里挂在你名下, 工单收工时可整批回收)。它**不继承你的任何上下文**, 只拿到身份。适合干一件与你手头无关的事, 或者要去别的目录 (`cwd`) / 别的聊天里干活。要一个开局就带着你读过的材料的, 用 clone_wizard。\n" +
      "带上 `task` 可以在它就位的同时把第一件活私聊派下去, 省掉一次 tell_peer; 要它的回复进群, 就别带 task, 就位后用 `tell_peer({public:true})` 转给它。" +
      OFFSPRING_TAIL,
    inputSchema: {
      ...offspringShape,
      cwd: z.string().optional().describe("它的工作区绝对路径。省略 = 跟你同一个目录。"),
      detached: z.boolean().optional().describe("true = 独立长住: 不挂在你名下 (不占分身名额、不随工单回收、不带 job), 等价于人在群里 `/new .name` —— 要一个往后一直在的新 wizard 时用; 干完一件活就收的别用。"),
      lead: z.boolean().optional().describe("true = 它是来领一件复杂活的 lead: 宪章里多一节组队打法 (coder / 白板 reviewer / 工单 / 何时收队), 由它自己组队。配 `tier:\"hard\"`。"),
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
      "要白纸一张、或要去别的目录, 用 spawn_wizard。被克隆者正在干活时, 分身拿到的是它此刻为止的上下文 —— 想要它读完再分: 是你派的活就等它的回执, 否则先 `wait_peer` 等它停下 (或看 wizard_roster 的忙闲)。\n" +
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
// 自己汇总)。守护进程只替你记一本账 —— 谁属于这个活、谁是临时生的、各自落成了什么、
// 收工时该回收谁。工单整个不进群。
server.registerTool(
  "open_job",
  {
    title: "Open a job for a fan-out",
    description:
      "开一个**工单**: 你接下来要同时派出两个以上的分身干同一件事时, 先开它。返回一个 id, 把这个 id 传给 spawn_wizard / clone_wizard / tell_peer 的 `job` 参数, 它们就归到这个工单名下。\n" +
      "开了工单之后有三件事不一样: ① 带这个 id 的派活一律私聊, 开工、派活、回执、收工都**不进群** —— 结构在 rolepage 的工单页里, 人在群里只看到你自己那一轮的最终回复。② close_job 会把为这个工单生出来的分身**整批回收**, 不必一个个 stop_wizard —— 忘记回收是常态, 每个分身都占着一个 pane 和一份上下文。③ list_jobs 能看到还开着哪些活。④ 默认验收: 成员交上来的答复没有非空的 `RESULT:` (按 `accept`), 守护进程以你的名义同件号打回一次, 那一份不投给你、不计数, 也不占 `maxTurns`; 再交上来的照收。\n" +
      "只派一个分身、或者只是推某个同伴一把, 不用开工单。",
    inputSchema: {
      title: z.string().describe("一句话说清这个工单要干成什么 —— 工单页与收工留档的标题。"),
      plan: z.string().optional().describe("计划 (打算分几路、各干什么), 记进工单账本给工单页读。"),
      expect: z.number().optional().describe("这批一共要几份回执。分身是陆续派的, 给了它「全部到齐」就不会在派齐之前提前报。"),
      maxTurns: z.number().optional().describe("派活次数的预算: 带这张工单的每次 tell_peer (含 re 续问、答 NEED) 与带 task 的 spawn/clone 各记一次, 用完再派会被拒 —— 防反复追问兜圈。守护进程按 `accept` 代你打回的那一次不算。省略 = 不限。"),
      accept: z.enum(["result", "artifact", "none"]).optional().describe("成员交差的验收: `result` (默认) 要有非空 RESULT; `artifact` 还要列出 ARTIFACT 交付物; `none` 不验。不合格的自动打回一次。"),
      parent: z.string().optional().describe("上级工单。省略 = 自动取你作为成员领活的那张最近的开着的单 (被 dispatch 派来当 lead 的, 子单自动挂在根单下); 显式传的要求你是它的成员或开单者。工单树最深 3 层、每张单直接成员 ≤5 个: 超了就把子活交给现有成员, 让它开子单。"),
      criteria: z.string().optional().describe("这张单的验收标准 (做成什么样算数), 记进账本。"),
    },
  },
  async ({ title, plan, expect, maxTurns, accept, parent, criteria }) =>
    unwrap("open_job", await daemonPost("/jobs/open", { title, ...(plan ? { plan } : {}), ...(expect ? { expect } : {}), ...(maxTurns ? { maxTurns } : {}), ...(accept ? { accept } : {}), ...(parent ? { parent } : {}), ...(criteria ? { criteria } : {}) })),
);

server.registerTool(
  "close_job",
  {
    title: "Close a job and recycle its clones",
    description:
      "收工: 把汇总结论连同成员与各自那段活**留档** (情景记忆, 不发群), 并**把为这个工单生出来的分身整批回收**。被拉来帮忙的长期 wizard 不在回收之列, 你自己也不会被收。\n" +
      "汇总完就调它。给人的结论写在你自己这一轮的最终回复里 —— 人在群里问的, 那条回复就进群。`stop:false` 只结账不回收 (那些分身后面还有用)。需求根单做完交付后, 守护进程会隔 4h / 1 天 / 2 天… 以你的名义往原群提醒人验收 (不带单号, 同时往你的信箱挂一行带单号的); 人认可 → `as:\"accept\"`, 说不要了 → `as:\"cancel\"`, 说先放着 → `as:\"shelve\"`。",
    inputSchema: {
      job: z.string().describe("open_job 返回的工单 id。"),
      summary: z.string().optional().describe("汇总结论, 留档 (不发群): 做成了什么、有什么没做成。"),
      stop: z.boolean().optional().describe("是否回收为这个工单生出来的分身。默认 true。"),
      as: z.enum(["accept", "cancel", "shelve", "resume"]).optional().describe("怎么收 (多是需求根单, 管家用)。`accept` (默认) 收工 / 归档 —— 根单即人验收通过 (G3); `cancel` 取消: 关单、整棵子树回收, 留档标「取消」; `shelve` 搁置: **不关单**, 停止「等验收」的提醒冒泡, 账本留着; `resume` 恢复搁置 (给 lead `re` 或带 `job` 派话会自动恢复)。shelve / resume 只对需求根单有效。"),
    },
  },
  async ({ job, summary, stop, as }) =>
    unwrap("close_job", await daemonPost("/jobs/close", { job, ...(summary ? { summary } : {}), ...(stop === false ? { stop: false } : {}), ...(as ? { as } : {}) })),
);

server.registerTool(
  "list_jobs",
  {
    title: "Open jobs in this chat",
    description:
      "这个聊天里还开着的工单, 按树排 (根在前, 子单跟在父后; `depth` / `parent`): id、标题、现算阶段 `stage` (plan / build / review / clarify / deliver / closed)、验收标准、谁开的、成员 (含角色 `role`) 和各自那段活。用来回答「那批分身在干什么」「上次那个活收了没」, 以及在继续派活前拿回工单 id。",
    inputSchema: {},
  },
  async () => unwrap("list_jobs", await daemonPost("/jobs/list", {})),
);

server.registerTool(
  "pending_items",
  {
    title: "What I dispatched and is still open",
    description:
      "挂起事项全表: 你派出去 (tell_peer / 带 task 的 spawn) 还没了结的每一件 —— 件号、对象、一句话题、为谁派的, 状态由守护进程按回执算 (在飞 / 等人拍板 / 人已回话 / 它在反问 / 没结论)。回执 done 了的、同一对改派了的、工单收了的自动消掉; 没结论的留着, 直到你改派、`re` 追问, 或用 `drop` 显式消掉。\n" +
      "管家平时只会在注入尾巴上收到必要的一行增量, 快忘的时候 (交接 / 压缩后、隔了很多轮) 收到一次全表; 其余时候想看就调它。",
    inputSchema: {
      drop: z.array(z.string()).optional().describe("要消掉的件号 (`t...`): 不再需要、或已经另行处理了。"),
      why: z.string().optional().describe("消掉的理由, 一句话 (记进账本)。"),
      name: z.string().optional().describe("看别人的挂起事项 (只读)。省略 = 你自己的。"),
    },
  },
  async ({ drop, why, name }) =>
    unwrapText("pending_items", await daemonPost("/pending", { ...(drop?.length ? { drop } : {}), ...(why ? { why } : {}), ...(name ? { name } : {}) })),
);

server.registerTool(
  "stop_wizard",
  {
    title: "Interrupt or end another wizard",
    description:
      "收掉一个 wizard/分身。mode='interrupt' 只打断它当前这一轮 (等价于群里的 /stop, 它还活着, 可以继续派活); mode='end' 结束它并回收 tmux pane (等价于 /kill, 之后再找它会重新长出一个空白会话)。加 forget=true 连它的身份记录一起抹掉 (名字、职责、记忆), 只在它彻底不会再回来时用。用户说「让 .x 停下」「把那些分身收了」时调它。终结自己也是合法的 (分身干完活自我了结), 只是这次调用不会返回 (这类生命周期事件不进群, 记录在 rolepage)。",
    inputSchema: {
      name: z.string().describe(ADDRESS_DOC),
      mode: z.enum(["end", "interrupt"]).optional().describe("'end' 结束并回收 pane (默认); 'interrupt' 只打断当前这一轮。"),
      forget: z.boolean().optional().describe("仅对 end 有效: 连身份记录 (名字/职责/记忆) 一起删除。默认 false —— 身份留着, 下次它回来还是它。"),
      turn: z.string().optional().describe("仅对 interrupt: 只撤回**你自己派的**这一件 (回执 / tell_peer 回包里的件号)。它正在做的就是这件才按 Esc; 还排着或它在做别人的活, 就只把这件记成取消, 不碰它手上那一轮。"),
      force: z.boolean().optional().describe("仅对 interrupt: 它此刻在做别的 wizard 派的活时, 不带 turn 的打断默认被拒 (会误伤那件); 确要打断加 true。"),
    },
  },
  async ({ name, mode, forget, turn, force }) =>
    unwrap("stop_wizard", await daemonPost("/wizard/stop", { name, ...(mode ? { mode } : {}), ...(forget ? { forget } : {}), ...(turn ? { turn } : {}), ...(force ? { force } : {}) })),
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
    title: "(deprecated) alias of handoff for yourself",
    description: "同 `handoff({brief})` 不传 name —— 交接你自己 (旧名, 只为不打断正在跑的旧会话而保留)。新调用一律用 handoff。",
    inputSchema: { brief: z.string().describe("交接简报全文。") },
  },
  async ({ brief }) => handoffSelf("wizard_handoff_self", brief),
);

const transport = new StdioServerTransport();
await server.connect(transport);
