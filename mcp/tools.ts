// MCP server `wezard`: the tool surface, as a factory.
//
// `createWezardServer()` builds one McpServer with every tool registered; each tool
// just POSTs to the resident daemon over loopback — nothing here holds WeCom state.
// Two transports mount the same surface:
//   - stdio — mcp/server.ts, the per-pane child of the agent CLI (dist path is load-bearing);
//   - http  — daemon/mcp-http.ts, the daemon's own stateless StreamableHTTP endpoint.
// The caller's identity arrives differently on each (env for stdio, a request header for
// http), so it lives in `mcpIdentity` and `selfRef()` reads it there.
import { AsyncLocalStorage } from "node:async_hooks";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { DAEMON_TOKEN_HEADER, readDaemonToken } from "../shared/daemon-token.js";
import { EFFORTS } from "../shared/effort.js";
import { TIERS } from "../shared/config.js";
import { PlanInputSchema, PlanUpdateSchema } from "../shared/plan.js";
import { present, recovery } from "./output.js";

// daemon 内 loopback 调自己与 pane 里的 stdio 走同一条路径: resolveSelf 复用, 不改。
const DAEMON_BASE = process.env.WEZARD_DAEMON_BASE ?? "http://127.0.0.1:17890";

const ok = (data: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(data) }],
});

const fail = (msg: string) => ({
  isError: true,
  content: [{ type: "text" as const, text: msg }],
});

type Shape = Record<string, z.ZodTypeAny>;

const currentAddressSchema = <T extends Shape>(shape: T) => z.object(shape).strict();

// Accept user-friendly prefixes from the LLM: vid:<id> → user:<id>, chatid:<id> → chat:<id>.

// Pass anything else (already user:/chat:/group:, or empty) through unchanged.
const normalizeTarget = (raw: string | undefined): string | undefined => {
  if (!raw) return undefined;
  if (raw.startsWith("vid:")) return `user:${raw.slice(4)}`;
  if (raw.startsWith("chatid:")) return `chat:${raw.slice(7)}`;
  return raw;
};

// ── wizard ↔ wizard (一个聊天里的同伴) ────────────────────────────────────
// 每个 wizard 有一个全局唯一的名字, 人在群里写 `.fix`、wizard 之间传 `fix` 就叫到它,
// 与它住在哪个群无关; 各自可以跑不同的 CLI / 模型 / 项目。它们互为同伴 (peer): 看得见彼此, 也驱动得动
// 彼此 —— 下面这组工具就是那条通路。本进程只看得见**自己**, 所以任何关于同伴的
// 问题都要问守护进程, 它才是持有全部 attachment 的那个。
//
// 身份: 谁在问。两条来路 ——
//  - stdio (mcp/server.ts): 只能读 env。sessionId 在 MCP 进程起来时就冻住了 (/clear 后过期),
//    TMUX_PANE 在这个 pane 活着期间稳定, 所以两者总有一个能定位。
//  - http (daemon/mcp-http.ts): 一个 daemon 进程同时服务多个客户端, env 是进程级的、读它必然串;
//    所以每个请求在 mcpIdentity.run({sessionId, tmuxPane}) 里跑, 这里优先取它。
export const mcpIdentity = new AsyncLocalStorage<{ sessionId?: string; tmuxPane?: string }>();

const selfRef = (): { sessionId?: string; tmuxPane?: string } => {
  const bound = mcpIdentity.getStore();
  if (bound) return bound;
  const sessionId =
    process.env.CODEX_THREAD_ID ??
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
// is nested rather than spread at the top level.
const unwrap = (name: string, { j, status }: DaemonReply, pick?: (j: Record<string, unknown>) => unknown, input?: Record<string, unknown>) =>
  j.ok ? ok(present(name, pick ? pick(j) : j, input)) : fail(`${name} failed: ${(j.reason ?? j.error ?? `http ${status}`) as string}${Object.keys(recovery(j)).length ? `\n${JSON.stringify(recovery(j))}` : ""}`);

// 读侧工具 (名册 / 对话 / 聊天记录) 的回执是守护进程排好的**文本**, 原样交出去:
// 这些东西是给模型读的, 包一层 json 只是让它为字段名和转义的换行多付 token。
const unwrapText = (name: string, r: DaemonReply) =>
  r.j.ok && typeof r.j.text === "string" ? { content: [{ type: "text" as const, text: r.j.text }] } : unwrap(name, r);

const unwrapCandidates = (r: DaemonReply) =>
  r.j.ok && typeof r.j.text === "string"
    ? { content: [{ type: "text" as const, text: r.j.text.replace("; diagnostics 保留全量。", "。") }] }
    : unwrap("route_candidates", r);

// 地址语法只有一套, 每个吃地址的工具都把它原样重述一遍: 模型单看一个 schema
// 时没有别的地方能学到它, 而猜出来的地址会安静地指向另一个 wizard 的终端。
const ADDRESS_DOC =
  "wizard 的名字 —— 全机唯一, 它就是地址: 写裸名 `'fix'` 即可 (人面前的气泡头显示 `🧙‍♂️ fix`; wizard 之间与 rolepage 都显示裸名; 带 `'.fix'` / `'🧙‍♂️ fix'` 前缀也认), 不分它住在哪个群。`''` = 你这个聊天的默认 wizard。永远别自己拼 key: wizard_roster / spawn_wizard / clone_wizard 返回的名字 (或 409 里的 `address`) 原样传回来。";

// 生 wizard 的三个工具共用: 模型名是口语, 落地的是 `/model` 列表里最接近的那一项。
const MODEL_DOC =
  "跑在哪个模型上, 最好写确切的 id ('claude-opus-5.5' / 'deepseek-v4.1-flash')。原样带 `--model` 启动; CLI 不认 (口语名 'opus' / '最新的 opus' 也算) 就不带它重起一次, 再从它 `/model` 列表里挑最接近的一项 —— 多花一次启动, 不丢 wizard。落地的见返回的 `model`, 走了兜底或对不上时带 `modelWarning` (仍在跑, 对不上则停在默认模型)。省略 = 该 CLI 默认。之后换用 set_model。";

const EFFORT_DOC =
  "推理档位, 启动时就带上 (`--effort`), 之后它每次重启都沿用。判断密集的活给 high 以上, 跑腿的给 low。省略 = 该 CLI 默认 (克隆则跟被克隆者同档)。之后换用 set_model 的 `effort`。";

// ── room: 唯一的沟通对象 ────────────────────────────────────────────────────
// 一个 room 一份账本 (shared/room.ts), 人和 wizard 走同一个 append 口子。这些工具只负责
// 把参数变成一次 HTTP 调用 —— 发言权、status 写入权、覆盖检查、唤醒预算都在 daemon 侧。
// 三条不会变的事实: 完成只认 chat_reply 的 status; 终句没有任何路由语义 (只进 turn store
// 与 rolepage); 被唤醒的 duty 只能用 chat_reply 交代。
const HISTORY_DOC =
  '被拉者入座后第一次被唤醒时能读到的旧话范围: "none" 只看之后的 | 正整数 N 最近 N 条 | "from:<msgId>" 从那条起 | "all" 全部 (缺省)。仍受 ~6000 字未读预算截断; 更早的随时 room_read。';
const historyArg = () => z.union([z.literal("none"), z.literal("all"), z.number().int().min(1), z.string().regex(/^from:.+/)]).optional().describe(HISTORY_DOC);
const ROOM_DOC =
  "room: 绑定了企微传输的群 / 单聊 / topic 帖写 base principal 原样 (`chat:…` / `user:…`) 或聊天名; " +
  "`dm:…` 是你和某个 wizard 的两人 room, `adhoc:…` 是 room_open 开的临时 room。缺省 = 唤醒你这一轮的那条消息所在的 room; " +
  "本轮由多个 room 一起唤醒时必须显式给 (否则 400)。绑定 room 里每条消息都真的进企微, dm / adhoc 只在 rolepage。";

const TO_DOC =
  "点名的 wizard (裸名, 带 `.` 也认); chat_ask 还可点名本 room 的人 (`human:<userid>`, room_members 里能看到)。只认本 room 的成员 —— chat_say 的 `to` 只是指出对谁说, 不唤醒、不开 duty; chat_ask 的每个 `to` 各开一条 duty (人名下的那条由人的下一句话关账, 并唤醒你)。";

const INTERRUPT_DOC =
  "true = 先 Esc 打断对方当前这一轮再投本条 (不拆 pane)。限权: 只有对方的直属 parent、本 room 的 host、或人能用, 其余 403; 计入本 room 的回合预算 (10 分钟 20 次), 超了 409。被打断那一轮的 duty 不关 —— 它下次被唤醒时按游标重投, 只是那一轮白付。";

const FOR_DOC =
  "这件活为你欠着的**哪一笔**派的: 写提问方的名字, 或那条消息的 id。只作血缘记录, 不参与关账 (完成只认 status); 缺省 = 本轮唤醒你的那一条, 通常不用给。";

const STATUS_DOC =
  "done = 做完了 · passed = 无需答复 · canceled = 不做了 (这三者关账) · need = 反问, 等提问方补信息 (提问方是人时, 在人名下开一条 duty, 人回话会叫醒你) · progress = 中间进展 (后两者不关账)。";

const ASK_KIND_DOC =
  "`ask` (默认) 一个问题, `task` 一件活 —— 两者都开 duty, 区别只写在行上给读的人看。";

// 交接只有一个动词: 不点名 = 交接你自己 (你写简报), 点名 = 替别人交接 (守护进程让它写)。
const handoffSelf = (tool: string, brief: string) =>
  daemonPost("/wizard/handoff-self", { brief }).then((r) => unwrap(tool, r));

const DELEGATE_DESC =
      "派活一步到位: 给 task 或 taskFile+params。产出是一条 chat_ask —— 选中的 wizard 收到一条 duty, 只能用 chat_reply 交代, 没有别的回执通道; 返回实际决定、目标、room 与档位, dryRun 只返回决定与简短理由。lead 只在复杂任务使用。planId 只记录 event 与 plan 的关联，daemon 不会代替 owner 推进 DAG。\n" +
      "先按验收目标分清独立新活和原任务续篇。独立新活另派不等于强制新生, 允许复用近期实际材料相关、空闲且无职责占用的非 lead; 按本次难度派, 不因同项目、公共 AGENTS.md/CLAUDE.md 或词面重叠塞给已有 lead。自动复用要求实质上下文证据、无 lead/任务占用、成本合适; 其余白板 spawn。难度看所需判断而非句长: 指明函数、接口、文件、按钮等具体对象且范围清楚的低风险 coding 默认 light; 其他常规任务默认 standard; 只有复杂方案判断、疑难升级或安全/并发/架构等高风险审查才显式 hard。\n" +
      "你不同意就**显式推翻**: `to` 用于人明确指定或已确认必需的上下文连续性, `spawn:true` 硬要新的, `force:true` 只越过缓存成本门控, 不放宽自动复用的相关性。复杂任务用 `lead:true`: lead 建 plan，按阶段创建执行者并验收；简单任务直接派活、不建 plan。";

const DELEGATE_SCHEMA = {
      // task 与 taskFile 二选一 (§8): 不存在「task 作摘要」的用法 —— 旧 daemon 会把
      // task 当正文投出去, 摘要进 pane 就等于静默丢卡。选人/选档/description 由
      // daemon 用展开文本或 params.header 派生 (阶段 2)。
      task: z.string().optional().describe("这件活的正文, 与 `taskFile` 二选一。给了 `taskFile` 就别再给 task —— 守护进程用展开后的全文派生选人与默认 description。写清目标与交付, 带文件名 / 模块名帮助找上下文; 公共规则文件或同目录不构成复用理由。不要把独立核查改写成原 lead 的附加交付。"),
      taskFile: z.string().optional().describe("模板文件路径, **相对你的工作区**的相对路径 (绝对路径与 `~` 开头一律 400)。给了它, 投递正文由 daemon 用模板 + `params` 展开; 与 `task` 至少给一个。"),
      params: z.record(z.string()).optional().describe("`taskFile` 模板里 `{{name}}` 占位符的参数值 (全为字符串)。缺参数 / 多余参数都会被 400 拒绝。"),
      for: z.string().optional().describe(FOR_DOC),
      name: z.string().optional().describe("可选的新 wizard 短名, 不是已有执行者的地址 (指定已有执行者用 to)。推荐省略或空白，新建时由 daemon 分配全机唯一中性英文名，职责另存; 复用时忽略。"),
      description: z.string().optional().describe("可选的新 wizard 职责, 一句话。省略或空白 = 取 task 摘要; 复用时忽略。"),
      tier: z.enum(TIERS).optional().describe("本次任务难度及 spawn 档位 (mini / light / standard / hard / ultra)。明确代码对象且范围清楚的低风险 coding 默认 light; 其他常规任务默认 standard; lead 默认 hard。只有复杂方案判断、疑难升级或安全/并发/架构等高风险审查才 hard / ultra。显式 tier 覆盖默认, 按所需判断而非句长选。复用已有 wizard 不会切换它的模型。"),
      to: z.string().optional().describe("显式选定已有 wizard (名字), 绕过自动选人。仅在人明确指定执行者或必需上下文已确认时使用; 不能仅因同项目或已有 lead 在场。原任务续篇用 chat_ask 指回原活。"),
      spawn: z.boolean().optional().describe("推翻默认: 不看候选, 一定白板 spawn。"),
      force: z.boolean().optional().describe("越过冷门控: 缓存冷且 ctx ≥100k 的候选默认不转; 确认这件活真依赖它那段上下文才给 true。"),
      lead: z.boolean().optional().describe("复杂任务由 lead 统筹并逐阶段维护 plan；简单任务不要建 plan。产出是一条 chat_ask —— 结果由你在它交代后自己收口。"),
      planId: z.string().optional().describe("这次派活归属的 plan id。仅关联event供owner的闲时提醒判断，不会自动推进plan；补充同一event时沿用关联。"),
      room: z.string().optional().describe(ROOM_DOC + " 给了就把这条 chat_ask 落在这个 room (选中的子 wizard 以 spawn 免审入群; 你须是该 room 成员)。"),
      dryRun: z.boolean().optional().describe("只要默认决定与理由, 不执行。"),
    };

const runDelegate = async (tool: string, a: z.infer<z.ZodObject<typeof DELEGATE_SCHEMA>>) => {
  if (a.task === undefined && a.taskFile === undefined)
    return fail(`${tool}: ` + "`task` 与 `taskFile` 至少给一个 (后者是相对你工作区的模板路径, 由 daemon 展开)");
  return unwrap(tool, await daemonPost("/dispatch", a));
};

// 生孩子与分身是两个操作, 不是一个开关的两档: 一个白纸起步、可以去别的目录;
// 一个 fork 调用方此刻的上下文、必须留在原地。拆成两个工具, 模型选的是动词,
// 而不是在一个布尔上猜。两者落到同一条路由 (`inherit` 由工具定死)。
const offspringShape = {
  description: z.string().describe("它负责什么, 一句话。它会写进它的系统提示, 也会出现在名册里让别人看到。"),
  name: z.string().optional().describe("它的名字 (如 'docs'、'fix', 带不带 '.' 都行)。全机唯一。推荐省略，由 daemon 分配中性英文名，职责另存。"),
  task: z.string().optional().describe("就位后立刻开一条 duty 派下去 (等同一次 chat_ask)。省略则它就位待命。"),
  // 出生投递 (bearAs 内直接 acceptPeerDispatch) 不经 tell 的模板展开入口 —— 第一期
  // 不接 taskFile。声明出来是为了显式报错: 没声明的字段会被 zod 静默剥掉, 调用方
  // 会以为模板生效了而实际投出去的是空/残正文。
  taskFile: z.string().optional().describe("(第一期不支持, 传了报错) 模板正文请改用 delegate 的 `taskFile`+`params`。"),
  params: z.record(z.string()).optional().describe("(第一期不支持, 传了报错) 同 `taskFile`。"),
  chat: z.string().optional().describe("把它生在另一个聊天里 (wizard_roster 里的 home 聊天名)。省略 = 你自己的聊天, 这是绝大多数情况。"),
  tier: z.enum(TIERS).optional().describe("按难度选档 (由轻到重), 按 wrc.defaultCli 取 `models.backends.<backend>.tiers` 的 model / effort; mini = 机械一步, light = 有明确代码对象的范围清楚低风险 coding / 跑腿, standard = 其他常规任务, hard = 复杂方案判断、疑难升级或安全/并发/架构等高风险审查, ultra = 架构取舍、疑难排障、关键评审。coding 请显式指定 tier:light; 省略时保持 CLI 默认 (clone 继承来源档位); 显式 model / effort 优先。返回里的 via 说明每项来自显式、档位还是继承。当前各档见宪章或 config_get({path:'models'})。"),
  model: z.string().optional().describe(MODEL_DOC),
  effort: z.enum(EFFORTS).optional().describe(EFFORT_DOC),
  planId: z.string().optional().describe("若task属于现有plan，指定plan id以关联派活event；plan仍由owner显式更新。"),
  for: z.string().optional().describe(FOR_DOC),
  room: z.string().optional().describe(ROOM_DOC + " 给了就让它在那个 room 里入座 (via spawn, 免审) 并把这件活落在那儿 (你须是该 room 成员; 认不出 / 不是成员在生之前就拒, 派活失败回包 dispatched:false + dispatchError); 省略 = 你的 room。"),
};

type Offspring = { lead?: boolean; description: string; name?: string; task?: string; taskFile?: string; params?: Record<string, string>; from?: string; cwd?: string; chat?: string; room?: string; model?: string; effort?: string; tier?: string; planId?: string; for?: string };

const bear = (tool: string, inherit: boolean) => async (a: Offspring) => {
  // 见 offspringShape 的 taskFile 注释: 出生投递没有模板展开这一站。
  if (a.taskFile !== undefined || a.params !== undefined)
    return fail(`taskFile not supported on ${tool}; use delegate`);
  return unwrap(inherit ? "clone_wizard" : "spawn_wizard", await daemonPost("/wizard/clone", {
    inherit,
    description: a.description,
    ...(a.name ? { name: a.name } : {}),
    ...(a.task ? { task: a.task } : {}),
    ...(a.from ? { from: a.from } : {}),
    ...(a.planId ? { planId: a.planId } : {}),
    ...(a.cwd ? { cwd: a.cwd } : {}),
    ...(a.chat ? { chat: a.chat } : {}),
    ...(a.room ? { room: a.room } : {}),
    ...(a.model ? { model: a.model } : {}),
    ...(a.effort ? { effort: a.effort } : {}),
    ...(a.tier ? { tier: a.tier } : {}),
    ...(a.for ? { for: a.for } : {}),
    ...(a.lead ? { lead: true } : {}),
  }));
};

const OFFSPRING_TAIL =
  "名字全局唯一: 撞上的 wizard 静默超过一天就直接顶掉它、名字归新的; 撞上一个还在的 wizard 返回 409, 附 `alive` / `busy` / `idleForMs` —— 据此分辨它是真在干活 (换个名字) 还是冷绑定 (先 stop_wizard 再同名重生); 返回里的 `name` 是落定的名字。 它自己也能再生分身, 层级不限; 名下同时活着的有上限。";

// Every call builds a fresh server: the SDK binds one server to one transport (and
// JSON-RPC ids are per-connection), so a daemon-side http endpoint that serves many
// clients must not share a registry across them.
export const createWezardServer = (): McpServer => {
  const server = new McpServer(
    { name: "wezard", version: "0.0.1" },
    { capabilities: { tools: {} } },
  );

  // 人侧 / 罕用的工具 (30 天零调用: 本机会话清单与改接、聊天目录) 不进默认
  // 工具面 —— 每个注册的工具都占模型的上下文, 而这些要么人在 IM 里有对应命令 (`/sessions`
  // `/chats`), 要么由 chat_ask / room_read 覆盖。路由都还在; `WEZARD_MCP_EXTRA=1` 把它们挂回来。
  const registerRare: typeof server.registerTool =
    process.env.WEZARD_MCP_EXTRA === "1" ? server.registerTool.bind(server) : ((() => undefined) as never);

  // v3 §2: 工作区是身份属性 —— set_workspace 只记录 (pendingCwd), 此后新开的会话/化身
  // 在该目录启动; 不再驱动 handoff, 也不再有 keep 问句那一支。
  server.registerTool(
    "set_workspace",
    {
      title: "Set workspace directory for this identity",
      description:
        "设置这个 wizard 身份的工作区 (绝对路径或 ~ 开头), **此后新开的会话/化身都在这个目录启动** (由人决定何时重开; 没有活 pane 时立即在新目录起一个)。活 CLI 进程不原地切 cwd, 当前会话不受影响、不需要 handoff; 要换目录就等下一次 /new 或 respawn。",
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
      if (!j.ok) return fail(JSON.stringify({
        ok: false,
        tool: "set_workspace",
        reason: j.reason ?? "unknown",
        ...(j.pendingCwd ? { pendingCwd: j.pendingCwd } : {}),
      }));
      return ok({
        ok: true,
        target: j.target,
        sessionId: j.sessionId,
        cwd: j.cwd,
        ...(j.pendingCwd ? { pendingCwd: j.pendingCwd, appliedTo: "future-sessions" } : {}),
      });
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

  server.registerTool("plan_create", {
    title: "Create a plan",
    description: "为复杂任务创建自己的可变 DAG 计划。计划只记录状态，不自动派活或验收；可先创建空任务图，再逐步补全。task.executor 可选，写执行者 wizard 的全局名字 (.name，带不带点都行)，由你自己指派 —— daemon 不自动填。",
    inputSchema: PlanInputSchema.shape,
  }, async (a) => unwrap("plan_create", await daemonPost("/plans/create", a as Record<string, unknown>)));
  server.registerTool("plan_get", {
    title: "Get a plan",
    description: "读取 plan 完整任务图、依赖、进度和当前 revision。",
    inputSchema: { planId: z.string().trim().min(1) },
  }, async (a) => unwrap("plan_get", await daemonPost("/plans/get", a)));
  server.registerTool("plan_list", {
    title: "List plans",
    description: "列出自己的 plans；可按 wizard name 只读查询他人的 plans。",
    inputSchema: currentAddressSchema({ name: z.string().optional() }),
  }, async (a) => unwrap("plan_list", await daemonPost("/plans/list", a)));
  server.registerTool("plan_update", {
    title: "Update a plan",
    description: "以 revision 做 CAS 更新。tasks 是整份 DAG 替换；owner 显式推进、暂停、恢复、完成或取消计划。取消不等于完成。task.executor 可选，写执行者 wizard 的全局名字 (.name，带不带点都行) —— 不指派就不写，daemon 不自动填、不给旧记录补值；rolepage 上缺执行者的节点按 plan owner 展示。",
    inputSchema: { planId: z.string().trim().min(1), ...PlanUpdateSchema.innerType().shape },
  }, async (a) => unwrap("plan_update", await daemonPost("/plans/update", a as Record<string, unknown>)));

  // ── chat_* / room_*: room 是唯一的沟通对象 ────────────────────────────────
  // 这组 chat_* / room_* 工具就是全部出站与全部可见性管理 —— 没有「回执」通道, 也没有终句兜底:
  // 要谁收到什么, 就写成一行; 要关一笔账, 就给 chat_reply 的 status。
  server.registerTool(
    "chat_say",
    {
      title: "Say something in a room",
      description:
        "在一个 room 里说一句 (不开 duty、不关账)。绑定 room 里这一行就真的进企微; dm / adhoc 只在 rolepage。派活 ack / 中间进展 / 只是想让别人看见一句话, 都用它。`to` 只指出对谁说, 不唤醒、不开 duty —— 要对方交代就用 chat_ask。",
      inputSchema: currentAddressSchema({
        room: z.string().optional().describe(ROOM_DOC),
        text: z.string().describe("要说的话 (markdown)"),
        to: z.array(z.string()).optional().describe(TO_DOC),
        interrupt: z.boolean().optional().describe(INTERRUPT_DOC),
      }),
    },
    async ({ room, text, to, interrupt }) =>
      unwrap("chat_say", await daemonPost("/room/say", {
        ...(room ? { room } : {}),
        text,
        ...(to?.length ? { to } : {}),
        ...(interrupt ? { interrupt: true } : {}),
      })),
  );
  server.registerTool(
    "chat_ask",
    {
      title: "Ask a wizard in a room (opens a duty)",
      description:
        "向 room 里的一个或多个 wizard 开一条 duty —— 派活、提问、催一件没交代的事都走它; 也可点名本 room 的人 (`human:<userid>`) 向人提问 —— 人名下的 duty 不用 chat_reply, 人在本 room 的下一句话就关账 (带企微引用只关被引用的那条) 并唤醒你, 不需要了就对那条 id chat_reply canceled / passed。对方 wizard 只能用 chat_reply 交代 (done / passed / canceled 才关账)。缺省 room 的落点: `to` 全是本 room 成员 → 本 room; 单个 `to` 不是成员 → 自动落你和它的 dm room; 多个 `to` 里有非成员 wizard → 按成员集合 {你 + 它们} 复用或新开一个 adhoc (你是 host, 不会把它们拉进缺省群; 这条分支里 `interrupt` 只给被点名者的直属 parent); `to` 里含人且不全在缺省 room → 400, 要先在同一个 room。回包的 `id` 就是这一行的消息 id, 之后可以用 room_read 查、用 chat_reply 答。",
      inputSchema: currentAddressSchema({
        room: z.string().optional().describe(ROOM_DOC),
        to: z.union([z.string(), z.array(z.string())]).describe(TO_DOC),
        text: z.string().describe("这件活 / 这一问的正文。写清目标、交付与验收; 对方看不到你这一轮的上下文。"),
        kind: z.enum(["ask", "task"]).optional().describe(ASK_KIND_DOC),
        after: z.array(z.string()).describe("前置: 这些消息 id 的 duty 全部 done 之前不唤醒它 (跨 room 也行)。省略 = 无前置。").optional(),
        for: z.string().optional().describe(FOR_DOC),
        planId: z.string().optional().describe("这件活归属的 plan id, 只做关联记录 —— daemon 不替你推进 DAG。"),
        interrupt: z.boolean().optional().describe(INTERRUPT_DOC),
      }),
    },
    async ({ room, to, text, kind, after, for: lineage, planId, interrupt }) =>
      unwrap("chat_ask", await daemonPost("/room/ask", {
        ...(room ? { room } : {}),
        to: Array.isArray(to) ? to : [to],
        text,
        ...(kind ? { kind } : {}),
        ...(after?.length ? { after } : {}),
        ...(lineage ? { for: lineage } : {}),
        ...(planId ? { planId } : {}),
        ...(interrupt ? { interrupt: true } : {}),
      })),
  );
  server.registerTool(
    "chat_reply",
    {
      title: "Close (or field) a duty — the only completion signal",
      description:
        "答一条或多条 duty。room 由 `re` 定 —— 消息 id 全机唯一, 自带 room, 不用给。status: " + STATUS_DOC +
        " 只有该 duty 的处理人 (或人) 能写 status, `re` 数组里任一条不归你 → 整行 403。不带 status 且你是处理人 = 有正文记 done、没正文记 passed; 不是处理人 = 普通线程回复 (不关账)。追问用 need, 长活中间报一句用 progress。",
      inputSchema: currentAddressSchema({
        re: z.union([z.string(), z.array(z.string())]).describe("要答的那些消息 id (信封 / 注入的未读行头部的 `[<id>]`)。"),
        text: z.string().optional().describe("答复正文; 不给 (且你是处理人) = passed。"),
        status: z.enum(["done", "need", "progress", "passed", "canceled"]).optional().describe(STATUS_DOC),
      }),
    },
    async ({ re, text, status }) =>
      unwrap("chat_reply", await daemonPost("/room/reply", {
        re: Array.isArray(re) ? re : [re],
        ...(text !== undefined ? { text } : {}),
        ...(status ? { status } : {}),
      })),
  );

  server.registerTool(
    "onboard_bind",
    {
      title: "Bind a steward for a brand-new chat (onboarding only)",
      description:
        "**只有新群引导会话能调** (引导期由 daemon 起在 <chat>#guide 的那个), 其余调用 403 —— 已绑过 / 绑定完成就不要再调。"
        + "把本群管家定下来: 给 workspace (目录; 要新建就 create:true —— 只建最后一级, 父目录必须已存在, 且必须在 $HOME 下) 或给 name (已有管家)。"
        + "成功 = 绑定完成、引导结束: 管家进 room 接手, 人的原话连 duty 一起转给它; 你这一轮到此为止, 不要再说话、不要再调工具。"
        + "失败 = 4xx 带原因 (目录不存在 / 父目录不在 / 名字没认出), 引导继续, 用 chat_reply 向人追问。"
        + "绑定之外的任何要求都不要自己做 —— 绑定后连原话一起交给管家。",
      inputSchema: currentAddressSchema({
        workspace: z.string().optional().describe("管家的工作目录 (绝对路径或 ~ 开头)。要建目录就同时给 create:true。"),
        create: z.boolean().optional().describe("workspace 不存在时建它 (只建最后一级; 父目录必须已存在; 必须在 $HOME 下)。"),
        name: z.string().optional().describe("已有管家的名字 —— 给这个就不给 workspace。"),
      }),
    },
    async ({ workspace, create, name }) =>
      unwrap("onboard_bind", await daemonPost("/onboarding/bind", {
        ...(workspace ? { workspace } : {}),
        ...(create ? { create: true } : {}),
        ...(name ? { name } : {}),
      })),
  );

  // ── room 管理面 ──────────────────────────────────────────────────────────
  server.registerTool(
    "room_open",
    {
      title: "Open an adhoc room",
      description:
        "开一个 `adhoc:…` 临时 room 并把 `with` 里的人拉进来 (你按 ord=1 入座, 是这个 room 的 host)。多步的活默认开一个跟进 room 把事情关在里面 —— 只有需要人和执行者直接对话时, 才把人拉进主 room。room 没有绑定传输, 消息只在 rolepage 可见。**开 room 请起个名字** (`title`): 写这个 room 在干什么, rolepage 的关系图 / 列表上就显示它; 不给则只显示成员名 (`A·B·C`), 看不出是哪件事; 事后可用 room_name 补。",
      inputSchema: currentAddressSchema({
        with: z.array(z.string()).describe("拉进来的 wizard 名 (裸名)。"),
        title: z.string().optional().describe("room 的名字: 这个 room 在干什么, 一句话 (如「账单迁移 review」)。强烈建议给; 不给 rolepage 上只显示成员名。"),
      }),
    },
    async ({ with: members, title }) =>
      unwrap("room_open", await daemonPost("/room/open", { with: members, ...(title ? { title } : {}) })),
  );
  server.registerTool(
    "room_name",
    {
      title: "Name a room / set its notice (host only)",
      description:
        "给 room 起显示名 (`name`) 和 / 或设群公告 (`notice`), 两个至少给一个; 只有本 room 的 host 能改。名字只是别名: room 的地址永远是 id (chat:… / user:… / dm:… / adhoc:…), 名字不参与寻址, 同名也不冲突; 它只出现在 rolepage、注入头与 room_read 的标签里。公告是每个 room 一条的一句话 (本周重点 / 某条规矩), 让 room 里所有 wizard 一直知道: 改动时绑定 room 里会发一条「📌 群公告」系统行 (进企微), 在跑的成员下一次注入时随 system-reminder 收到, 新 wizard 的宪章里带着, room_read 头部也有; `notice: \"\"` 清除; 与现有相同则无变化。host 换人后由新 host 改; 人用 `/notice`。",
      inputSchema: currentAddressSchema({
        room: z.string().describe(ROOM_DOC),
        name: z.string().optional().describe("新的显示名, 一句话, 最多 60 字。"),
        notice: z.string().optional().describe("群公告正文, 最多 500 字 (空白会折成单个空格); 空串 = 清除。"),
      }),
    },
    async ({ room, name, notice }) =>
      unwrap("room_name", await daemonPost("/room/name", { room, ...(name !== undefined ? { name } : {}), ...(notice !== undefined ? { notice } : {}) })),
  );
  server.registerTool(
    "room_invite",
    {
      title: "Invite someone into a room",
      description:
        "把 `who` 拉进 room: host / 人 / 拉自己直属的子 wizard 时立即入群 (via invite / spawn); 其余成员的邀请转成一条 join-req, 等 host 批 (此时 history 不生效, 由 host 在 room_approve 时选)。",
      inputSchema: currentAddressSchema({
        room: z.string().describe(ROOM_DOC),
        who: z.string().describe("要拉进来的 wizard 名 (裸名)。"),
        history: historyArg(),
      }),
    },
    async ({ room, who, history }) => unwrap("room_invite", await daemonPost("/room/invite", { room, who, ...(history !== undefined ? { history } : {}) })),
  );
  server.registerTool(
    "room_join",
    {
      title: "Ask to join a room",
      description:
        "申请加入一个你还不是成员的 room: 写一条 join-req 并唤醒 host。批准之前你在那个 room 里的话落不成行。`reason` 是给 host 看的理由, 一句话。",
      inputSchema: currentAddressSchema({
        room: z.string().describe(ROOM_DOC),
        reason: z.string().describe("为什么需要进来, 一句话。"),
      }),
    },
    async ({ room, reason }) => unwrap("room_join", await daemonPost("/room/join", { room, reason })),
  );
  server.registerTool(
    "room_approve",
    {
      title: "Approve or reject a join request",
      description:
        "host / 人批一条 join-req: `accept:false` 拒绝。`re` 是那条 join-req 的消息 id。",
      inputSchema: currentAddressSchema({
        re: z.string().describe("join-req 的消息 id。"),
        accept: z.boolean().describe("true = 放进来, false = 拒绝。"),
        history: historyArg(),
      }),
    },
    async ({ re, accept, history }) => unwrap("room_approve", await daemonPost("/room/approve", { re, accept, ...(history !== undefined ? { history } : {}) })),
  );
  server.registerTool(
    "room_leave",
    {
      title: "Leave a room (or remove someone)",
      description:
        "退出 room, 缺省是自己; host / 人可以用 `who` 移出别人。你手上这个 room 未结的 duty 由守护进程写成 canceled 并唤醒提问者 —— 走之前能交代的先 chat_reply 交代。",
      inputSchema: currentAddressSchema({
        room: z.string().describe(ROOM_DOC),
        who: z.string().optional().describe("移出谁 (wizard 名)。省略 = 自己退出。"),
      }),
    },
    async ({ room, who }) => unwrap("room_leave", await daemonPost("/room/leave", { room, ...(who ? { who } : {}) })),
  );
  server.registerTool(
    "room_members",
    {
      title: "Who is in this room",
      description:
        "列本 room 的成员 (加入序、host、各自未结 duty 数) 与已读游标。纯文本。缺省 = 唤醒你这一轮的 room。",
      inputSchema: currentAddressSchema({ room: z.string().optional().describe(ROOM_DOC) }),
    },
    async ({ room }) => unwrapText("room_members", await daemonPost("/room/members", { ...(room ? { room } : {}) })),
  );
  server.registerTool(
    "room_transfer",
    {
      title: "Hand a duty over to another wizard",
      description:
        "把一条 duty 转给另一个 wizard (账本上写一行 move, 关账权随之过去)。`to` 不是成员时按 room_invite 的规则先入群。转出去之后这件事不再归你, 你也不需要再 chat_reply 它。",
      inputSchema: currentAddressSchema({
        re: z.string().describe("要转的那条 duty 的消息 id。"),
        to: z.string().describe("转给谁 (wizard 名, 裸名)。"),
      }),
    },
    async ({ re, to }) => unwrap("room_transfer", await daemonPost("/room/transfer", { re, to })),
  );
  server.registerTool(
    "room_read",
    {
      title: "Read a room's ledger",
      description:
        "读 room 账本, 纯文本, 一行一条 (行首 `[<id>]` 就是可以拿去 chat_reply 的 id)。默认只给游标之后你还没读过的那些; `all:true` 给全量。按时间 / 条数翻: `from` 从某条 id 之后, `since` / `until` 按时刻, `limit` 条数, `per` 单条字数上限。想读某个 wizard 会话里的原始对话用 peek_peer; 频道 (topic) 的历史用 read_channel。",
      inputSchema: currentAddressSchema({
        room: z.string().optional().describe(ROOM_DOC),
        from: z.string().optional().describe("从这条消息 id 之后开始 (不含它)。"),
        since: z.string().optional().describe("从什么时候起: `2h` / `30m` / `3d`、`14:30`、`09-30 14:30` 或 ISO 时间。"),
        until: z.string().optional().describe("到什么时候为止 (不含), 写法同 `since`。往回翻页就把回执里给的时刻传进来。"),
        limit: z.number().optional().describe("最多回多少条 (1-200)。"),
        all: z.boolean().optional().describe("true = 不看游标, 给全量 (受 limit / 时间窗约束)。"),
        per: z.number().optional().describe("单条正文最多多少字 (40-4000, 默认 500); 超出的标成 `…(+N)`。"),
      }),
    },
    async ({ room, from, since, until, limit, all, per }) =>
      unwrapText("room_read", await daemonPost("/room/read", {
        ...(room ? { room } : {}),
        ...(from ? { from } : {}),
        ...(since ? { since } : {}),
        ...(until ? { until } : {}),
        ...(limit ? { limit } : {}),
        ...(all ? { all } : {}),
        ...(per ? { per } : {}),
      })),
  );
  server.registerTool(
    "room_watch",
    {
      title: "Subscribe to a room",
      description:
        "订阅一个 room: 之后人新说一句、或有 duty 被关账时也唤醒你 (默认关)。每次唤醒都真的花你一轮, 所以不需要实时跟就看一眼 room_read —— 别顺手订阅。",
      inputSchema: currentAddressSchema({
        room: z.string().describe(ROOM_DOC),
        on: z.boolean().describe("true = 订阅, false = 退订。"),
      }),
    },
    async ({ room, on }) => unwrap("room_watch", await daemonPost("/room/watch", { room, on })),
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
        "**不打扰**地读另一个 wizard 的会话: 首行是它此刻的状态 (正在生成 / 空闲 / 停在哪个工具调用上等人点), 下面是它最近 N 个来回的正文 —— `▸` 是别人对它说的, `◂` 是它对这句最新说的一句 (跑完的是终句, 还在跑的是途中最近那句), 最后一条给得最全; 截掉的地方都标了 `…(+N)` / `…(略 N 字)…`。全部从它的 transcript 读: 只有说出来的话, 没有工具调用的过程, 回答「.fix 进展如何」「它卡在哪」, 或者判断要不要推它一把, 都读这里。这是**一个会话**的视角 (它从各处听到的都在里面); 要看**一个 room** 里谁对谁说了什么, 用 room_read。只读, 随便轮询。",
      inputSchema: currentAddressSchema({
        name: z.string().describe(ADDRESS_DOC),
        turns: z.number().optional().describe("回最近多少个来回 (1-40, 默认 6); 一个来回 = 一句问话 + 它的回答。"),
      }),
    },
    async ({ name, turns }) => unwrapText("peek_peer", await daemonPost("/peers/peek", { name, ...(turns ? { turns } : {}) })),
  );

  server.registerTool(
    "read_channel",
    {
      title: "Read a WeCom channel's history",
      description:
        "翻一个**频道**（企微 topic，不是群聊）的聊天历史，或者按关键词搜。频道里派给你的活，消息头上有 `topic=<id>` —— 注入的上下文（当前线程 + 最近若干条 + 搜索命中）不够时用它自己往前翻。先读本地缓存（daemon 为每个频道存了一份，含 reload / 断线期回填的消息）；给了 `query` 且本地不够时才走官方搜索（`aibot_topic_search` 两步：先出 jobid 再取摘要，正文再按 post_id 取回）。返回一行一条：`[HH:MM] 作者: 正文`，作者是 userid 或 `bot:<aibotid 前十位>`。这是**频道**视角；群聊 / 私聊 / dm 的账本用 room_read，单个 wizard 的会话用 peek_peer。只读，随便查。",
      inputSchema: {
        topic: z.string().describe("频道 id：`chat:<topic_id>` 或裸 topic_id —— 频道消息上下文头的 `topic=` 就是它。"),
        query: z.string().optional().describe("按关键词搜历史（先本地 grep，不够再走官方搜索）。不给 = 按时间翻最新若干条。"),
        limit: z.number().optional().describe("最多回多少条（1-100，默认 20）。"),
        since: z.string().optional().describe("从什么时候起：`2h` / `30m` / `3d`、`14:30`、`09-30 14:30` 或 ISO 时间。"),
        until: z.string().optional().describe("到什么时候为止（不含），写法同 `since`。"),
      },
    },
    async ({ topic, query, limit, since, until }) =>
      unwrapText("read_channel", await daemonPost("/channel/read", {
        topic,
        ...(query ? { query } : {}),
        ...(limit ? { limit } : {}),
        ...(since ? { since } : {}),
        ...(until ? { until } : {}),
      })),
  );

  server.registerTool(
    "notify",
    {
      title: "Post a message into a room for people to read",
      description:
        "把一段 markdown 发进一个或多个 room **给人看**: 不唤醒任何 wizard、不点名、不开 duty。绑定 room 里它作为一条消息进企微 (气泡头自动署你的名字), dm / adhoc 只在 rolepage。和 chat_say 的区别只在落点: notify 发去别的 room, chat_say 说在你此刻所在的 room。长活跑完通知另一个群、批量分身收工后把汇总播给发起方、定时任务把结论送到该看的人那里, 都用它。\n" +
        "给谁看是 room 的事 —— 说话的对象是 room, 不再是某个收件人。",
      inputSchema: currentAddressSchema({
        room: z
          .union([z.string(), z.array(z.string())])
          .optional()
          .describe(ROOM_DOC + " 可以给一组; 认不出的整条拒绝并列出来, 不会部分送达。省略 = 唤醒你这一轮的 room。"),
        markdown: z.string().describe("正文, markdown。头 (是谁发的) 由守护进程自动加, 别自己写。"),
      }),
    },
    async ({ room, markdown }) =>
      unwrap("notify", await daemonPost("/room/notify", {
        ...(room === undefined ? {} : { room: Array.isArray(room) ? room : [room] }),
        markdown,
      })),
  );

  server.registerTool(
    "send_file",
    {
      title: "Send a local file / image into a room",
      description:
        "把本机一个文件作为**图片 / 文件 / 语音 / 视频消息**发进 room —— notify 的媒体版, 同样不唤醒谁、不开 duty。截图、图表、导出报表、日志包要给人时用它, 别只在回复里写一个本地路径 (人那边打不开)。\n" +
        "`kind` 省略按扩展名定: png/jpg/jpeg/gif → image, mp4 → video, amr → voice, 其余 → file。企微上限: 图片 ≤10MB、视频 mp4 ≤10MB、语音只收 amr ≤2MB、文件 ≤20MB; 超了直接报错并告诉你怎么改 (大图改 `kind:\"file\"`)。\n" +
        "`re` 只把这行挂到那条消息的线程上 —— 它不关任何 duty, 要交代就另调 chat_reply。",
      inputSchema: currentAddressSchema({
        room: z.string().optional().describe(ROOM_DOC),
        path: z.string().describe("本机绝对路径 (`~` 可用)"),
        kind: z.enum(["image", "file", "voice", "video"]).optional().describe("省略 = 按扩展名推断"),
        caption: z.string().optional().describe("附一句说明: 先以一条带你名字的 markdown 气泡发出, 再发文件"),
        title: z.string().optional().describe("仅视频: 标题"),
        description: z.string().optional().describe("仅视频: 描述"),
        re: z.string().optional().describe("挂到哪条消息的线程上 (消息 id)。"),
      }),
    },
    async ({ room, path, kind, caption, title, description, re }) =>
      unwrap("send_file", await daemonPost("/room/file", {
        ...(room ? { room } : {}),
        path,
        ...(kind ? { kind } : {}),
        ...(caption ? { caption } : {}),
        ...(title ? { title } : {}),
        ...(description ? { description } : {}),
        ...(re ? { re } : {}),
      })),
  );

  server.registerTool(
    "handoff",
    {
      title: "Hand work over to a fresh context (yourself or another wizard)",
      description:
        "把工作压成简报并在当前轮结束后交给新上下文。没有待切换工作区时，守护进程在原 pane 清空上下文并接回简报；存在 pendingCwd 时，会启动新的 CLI 进程，在待切换目录中接回简报。\n" +
        "**不传 `name` = 交接你自己**: 简报由你写在 `brief` 里, 守护进程给这一轮一个短收尾窗口, 到点即打断并交接 (欠着的回执会在新会话里逐笔续答, 不会丢)。交接是纯上下文管理 —— 想同时换目录就先 `set_workspace({cwd})` 记下 (此后新会话生效), handoff 会顺手在新目录接回简报。简报要写到零上下文的自己仅凭它就能接着干: 总目标 / 已完成与关键决策 / 当前状态 / 有序的下一步 / 关键文件与非显然的坑。\n" +
        "**传 `name` = 替那个 wizard 交接**: 守护进程让它自己写简报 (`focus` 指定要特别交代的点), 抓到后在原 pane 清空并贴回; 返回被带过去的那份简报。",
      inputSchema: currentAddressSchema({
        name: z.string().optional().describe("替谁交接 —— wizard 的名字 ('fix' / '.fix')。省略 = 你自己。"),
        brief: z.string().optional().describe("交接你自己时必填: 简报全文, 自洽、具体、可执行。"),
        focus: z.string().optional().describe("替别人交接时可选: 简报里要特别交代的点。"),
        timeoutSec: z.number().optional().describe("替别人交接时等它写简报的上限秒数 (30-7200, 默认 600)。"),
      }),
    },
    async ({ name, brief, focus, timeoutSec }) =>
      !name
        ? brief?.trim()
          ? handoffSelf("handoff", brief)
          : fail("handoff: 交接你自己要写 `brief` (零上下文也能接手的简报); 替别人交接就传 `name`")
        : unwrap("handoff", await daemonPost("/handoff", {
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
        "成功返回任务 id、实际时间、目标和任务文件位置，不回显 prompt 正文。任务文件可直接编辑以改触发条件、配置 gate 或暂停。存成功后必须把回显的 `when` 和 `next` 念给用户确认。",
      inputSchema: currentAddressSchema({
        when: z.string().describe("什么时候跑, 人话原样传: 「每个工作日晚上9:30」「每天早上9点」「白天每隔一个小时」「工作时间每半小时」「每30分钟」「20分钟后」「明早9点」。时间窗口 (白天 / 工作时间 / 8点到20点) 会被解析成筛子, 窗外的那些枪直接吞掉。"),
        prompt: z.string().describe("到点要说给那个 wizard 听的话。写成自洽的完整指令 (要做什么、在哪个目录/文件上、做完怎么汇报), 别依赖当前对话的上下文。里面可以留 `{{名字}}` 占位, 由任务文件里的 gate 填。"),
        name: z.string().optional().describe(`点名在**哪个已有 wizard**里跑 —— 只有用户要求「在它那儿继续」时才传。省略 = 到点新建一个白板 wizard 干完就收 (默认, 也是「定时新建 wizard 干 xxx」要的那个)。传了它还想要新建, 再加 \`fresh:true\`: 那时它只当模板, 新 wizard 继承它的聊天/目录/模型。${ADDRESS_DOC}`),
        quiet: z.boolean().optional().describe("true = 有事才说: 到点不在群里预告, 那一轮私下跑, 它看完没事就只回一行 `QUIET`, 什么也不发; 有事守护进程才把它的终句转进群。巡检 / 盯梢类 (「每小时看一眼 CI, 挂了才告诉我」) 用它。没活连枪都不该放的, 写 gate。"),
        fresh: z.boolean().optional().describe("覆盖默认: true = 每次到点新建白板 wizard 执行 (给了 name 时用来表达「在它的目录下新开一个干」), false = 注入 name 指向的已有会话。默认由 name 推断 (给了 name = false, 没给 = true)。"),
        id: z.string().optional().describe("任务 id, 同时也是文件名 (`~/.wezard/tasks/<id>.task.mjs`)。省略则从 note/prompt 生成。取个好认的短名 —— 之后你要改这条任务, 改的就是那个文件。"),
        note: z.string().optional().describe("给人看的一句话备注, 在 list_tasks 里回显。"),
      }),
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
        "读 wezard 守护进程的配置, 一层一层展开: 不给 path 列各节一行说明; 给 path (点分, 如 'approval.danger' / 'models.backends.<backend>.tiers.<tier>.model', 例如 'models.backends.claude.tiers.light.model') 列这一层的子项 —— 类型、当前值、默认值、说明, 以及 ✋ (改动要人在卡片上确认) / ↻ (改完要 reload 才生效) 标记, * 标出与默认不同的项; 叶子给完整详情。`models` 下附带各档模型的实际用量做依据。想给人提配置建议时先读它, 再用 config_set 的 dryRun 拿 diff。机器人凭据与口令不可见。Keywords: 设置、配置、cfg、allowFrom、审批、窗口、danger、模型分档、tier。",
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
        path: z.string().describe("点分路径, 模型档位使用 'models.backends.<backend>.tiers.<tier>.model' (例如 'models.backends.claude.tiers.light.model')；其他如 'wrc.mirror.brief'。"),
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
        "返回当前动态状态: name、cwd / pendingCwd、model、cli、effort、contextTokens、handoffSuggested、clones 与 peers。用户问你在哪、上下文是否该交接或手上有哪些分身时调用。",
      inputSchema: {},
    },
    async () => unwrap("wizard_whoami", await daemonPost("/wizard/whoami", {})),
  );

  server.registerTool(
    "wizard_identity",
    {
      title: "Name yourself / declare your job",
      description:
        "修改 name、description 或 expertise。不给 to = 改自己; 给 to (实例名, 带不带点都认) = 改那个 wizard —— 只有它的直属 parent 或管家实例能改。目标是类实例时 name 是**新类名** (该类的全部实例同步成 新类名-N, 序号不变; 形如 X-3 的名字直接拒)。返回落定名; 类改名附类名与实例清单。",
      inputSchema: currentAddressSchema({
        to: z.string().optional().describe("要改谁: wizard 的地址 (实例名 / 类名, 例如 `wezard-2` 或 `.wezard-2`)。不传 = 改自己。"),
        name: z.string().optional().describe("新名字, 1-32 位字母/数字/`_`/`-`, 全机唯一。类实例 = 新类名 (不以 -数字 结尾)。不改就别传。"),
        description: z.string().optional().describe("一句话职责, 例如 '盯 wezard 主仓的重构与发版'。不改就别传。"),
        expertise: z.string().optional().describe("一句话专长: 熟哪块代码 / 领域, 例如 'rolepage 前端 (web/chat.js · role-view)'。名册与 delegate 候选行都显示它, 任务与它重叠时可据此选择。传 '-' 清掉。"),
      }),
    },
    async ({ to, name, description, expertise }) =>
      unwrap("wizard_identity", await daemonPost("/wizard/identity", {
        ...(to !== undefined ? { to } : {}),
        ...(name !== undefined ? { name } : {}),
        ...(description !== undefined ? { description } : {}),
        ...(expertise !== undefined ? { expertise } : {}),
      }), undefined, { name, description, expertise }),
  );

  server.registerTool(
    "wizard_roster",
    {
      title: "Roster pyramid: 在场 → 本群 → 全机",
      description:
        "名册是金字塔, 默认只给 **L0 在场** (≤12 行): 你 + 本群管家 + 本聊天 48h 内动过的化身, 各一行, 尾行全机普查 (N 身份 · M 群 · 忙/闲/冷)。\n" +
        "**升级靠显式参数**: `chat` (聊天名) = **L1 本群** 该聊天全部化身含冷的, 带职责/最近/家谱 (≤40 行); `scope:\"all\"` = **L2 组团** 每个聊天一行名字概览 (≤60 行); 单个 wizard 的详情用 `peek_peer`。\n" +
        "**自动降级**: 你的 ctx 到交接线时只回 L0 并注明 —— 那时候也别拉大表。\n" +
        "`query` 匹配名字/职责/地址, `cwd` 反查工作区, `alive:true` 只看活着的; 这些过滤器对每一层都生效。问了一个名字、它不在本群在场名单里时, L0 尾行会提示升级参数。这是你感知同伴的唯一入口 —— 拿到名字再 chat_ask / peek_peer。",
      inputSchema: {
        query: z.string().optional().describe("在名字 / 职责 / target 里做子串匹配 (不分大小写)。「让懂 X 的那个来看看」就把 X 写在这里。"),
        chat: z.string().optional().describe("升级到 L1: 只看某个聊天的全部化身 (含冷)。聊天名, 或聊天 principal 的一段。「同群有谁」就写你自己的群名。"),
        cwd: z.string().optional().describe("只看工作区路径包含这一段的 wizard —— 「谁在 /path 下干活」的反查。"),
        alive: z.boolean().optional().describe("true = 只看 pane 还活着的。默认全给 (冷会话发消息就会被唤醒)。"),
        scope: z.enum(["all"]).optional().describe("升级到 L2: 全机分群概览, 每个聊天一行 (名字串, ≤60 行)。"),
      },
    },
    async ({ query, chat, cwd, alive, scope }) =>
      unwrapText("wizard_roster", await daemonPost("/wizard/roster", {
        ...(query ? { query } : {}),
        ...(chat ? { chat } : {}),
        ...(cwd ? { cwd } : {}),
        ...(alive ? { alive } : {}),
        ...(scope ? { scope } : {}),
      })),
  );

  server.registerTool(
    "route_candidates",
    {
      title: "Who could take this task",
      description:
        "一件活要不要转给已有 wizard 时调它。只返回按 limit 截断的候选文本，不包含完整诊断或未展示候选。候选排序不等于推荐追加任务；独立新活按本次难度 delegate，同一验收目标的续篇用 chat_ask 的 \`for\\` 指回原活。",
      inputSchema: {
        task: z.string().describe("这件活及验收目标, 原话或一句概括都行。文件名 / 模块名 / 函数名帮助找线索; 公共规则文件、同工作区和关键词重叠不证明是同一任务。"),
        cwd: z.string().optional().describe("这件活落在哪个工作区。省略 = 你自己的工作区。"),
        tier: z.enum(TIERS).optional().describe("与 delegate 相同的本次任务档位；省略按任务判断。"),
        force: z.boolean().optional().describe("与 delegate 相同，仅越过冷缓存成本门槛。"),
        limit: z.number().optional().describe("最多列几个候选 (1-20, 默认 5)。"),
      },
    },
    async ({ task, cwd, limit, tier, force }) =>
      unwrapCandidates(await daemonPost("/wizard/route", { task, ...(tier ? { tier } : {}), ...(force !== undefined ? { force } : {}), ...(cwd ? { cwd } : {}), ...(limit ? { limit } : {}) })),
  );

  server.registerTool("delegate", { title: "Delegate a task (default decision by the daemon)", description: DELEGATE_DESC, inputSchema: currentAddressSchema(DELEGATE_SCHEMA) }, (a) => runDelegate("delegate", a));
  // 换模型和 spawn 时挑模型是同一条路: 守护进程在目标 pane 里打开 `/model` 列表,
  // 读出这台 CLI 此刻真有的每一项, 挑最接近的, 方向键移过去选中。
  server.registerTool(
    "set_model",
    {
      title: "Switch a wizard's model / effort",
      description:
        "给一个**已经在跑**的 wizard 换模型 (和/或推理档位 `effort`) —— 默认换你自己, `name` 点名就换那个 wizard。口语化写要什么 ('opus' / 'haiku' / 'sonnet 5' / '最新的 opus' / '默认'), 守护进程在它的 pane 里打开 `/model` 列表, 读出这台 CLI 此刻真有的每一项, 挑最接近的一项选中; 返回里的 `model` 是真正落地的那一项, `catalog` 是列表里的全部 —— 对不上时 (`ok:false`) 照着 `catalog` 重说一遍。默认只对这一个会话生效 (`scope:'session'`), 不改新开会话的默认模型; `scope:'default'` 则同时把它设成这台 CLI 此后**每个新会话**的默认模型 —— 那是全机的设置, 只在人明说「以后默认都用 X」时才用。返回里的 `scope` 是实际落在哪一档。它之后被重启也会回到这个模型上。正在干活的也能换 (从下一次请求起生效), 但换模型会让它的对话缓存整份重读一遍 —— 别来回切。用户说「换成 opus」「这个用 haiku 跑就行」「把 .fix 切到 sonnet」时调它; 你自己判断手上的活配不上/撑不起当前模型时也可以主动换。",
      inputSchema: currentAddressSchema({
        model: z.string().optional().describe("要换到哪个模型, 口语化写: 'opus' / 'haiku' / 'sonnet 5' / 'opus 4.7' / '最新的 fable' / '默认'。只写家族名 = 那个家族最新的一个。只换 effort 时省略。"),
        effort: z.enum(EFFORTS).optional().describe("顺带 (或只) 换推理档位 —— 只对这个会话生效, 不改全机默认; 之后它重启也沿用。返回里的 `effort` 是落地的那一档。"),
        name: z.string().optional().describe("换谁的 —— wizard 的名字 ('fix' / '.fix')。省略 = 换你自己。"),
        scope: z
          .enum(["session", "default"])
          .optional()
          .describe("'session' (默认) = 只换这一个会话; 'default' = 换这个会话, 并设为此后所有新会话的默认模型 (改的是 CLI 的全局设置, 不指定模型的新 wizard 都会跟着变)。"),
      }),
    },
    async ({ model, effort, name, scope }) =>
      unwrap("set_model", await daemonPost("/wizard/model", { ...(model ? { model } : {}), ...(effort ? { effort } : {}), ...(name ? { name } : {}), ...(scope ? { scope } : {}) })),
  );

  server.registerTool(
    "spawn_wizard",
    {
      title: "Spawn a blank child wizard",
      description:
        "**从白板生**一个子 wizard —— 新的 tmux pane、自己的全局名字 (裸名)、自己的职责, 归你管 (家谱里挂在你名下)。它**不继承你的任何上下文**, 只拿到身份。适合干一件与你手头无关的事, 或者要去别的目录 (`cwd`) / 别的聊天里干活。要一个开局就带着你读过的材料的, 用 clone_wizard。\n" +
        "带上 `task` 就是在它就位的同时开一条 duty (等同一次 chat_ask), 省一次往返; 不带它就位待命, 之后用 chat_ask 找它。返回 name、cwd、继承状态、实际模型/档位与警告。" +
        OFFSPRING_TAIL,
      inputSchema: currentAddressSchema({
        ...offspringShape,
        cwd: z.string().optional().describe("它的工作区绝对路径。省略 = 跟你同一个目录。创建后仍归你管理。"),
        lead: z.boolean().optional().describe("true = 它负责统筹复杂任务；只创建当前阶段需要的 wizard，并由它显式维护 plan。配 `tier:\"hard\"`。"),
      }),
    },
    bear("spawn_wizard", false),
  );

  server.registerTool(
    "clone_wizard",
    {
      title: "Clone a wizard, context and all",
      description:
        "**克隆**一个 wizard 出分身 —— fork 它此刻的上下文: 分身开局就拥有它已经读过的一切 (规范、目录结构、刚啃完的那份文档), 不必重读; 被克隆的那个毫发无损。默认克隆你自己; `from` 点名就克隆别的 wizard (比如一个已经把某个模块啃透的同伴) —— 分身仍归你管 (占你的名额), 只是上下文来自它。分身留在被克隆者的工作区。\n" +
        "要白纸一张、或要去别的目录, 用 spawn_wizard。被克隆者正在干活时, 分身拿到的是它此刻为止的上下文 —— 想要它读完再分: 等它那条 chat_reply, 或看 wizard_roster 的忙闲。\n" +
        "带上 `task` 就是在它就位的同时开一条 duty (分叉本来就由第一句话触发, 省一次往返)。返回 name、cwd、继承状态、实际模型/档位与警告。" +
        OFFSPRING_TAIL,
      inputSchema: currentAddressSchema({
        ...offspringShape,
        from: z.string().optional().describe("克隆谁 —— wizard 的名字 ('fix' / '.fix')。省略 = 克隆你自己。它必须已经有会话 (说过话), 否则返回 409。"),
      }),
    },
    bear("clone_wizard", true),
  );

  server.registerTool(
    "pending_items",
    {
      title: "What I dispatched and is still open",
      description:
        "挂起事项全表: 你派出去 (chat_ask / delegate / 带 task 的 spawn) 还没了结的每一件 —— 件号、对象、一句话题、为谁派的; 关账只认对方那条 chat_reply 的 status。已交代的、同一对改派了的自动消掉; 没结论的留着, 直到你改派、chat_ask 追问, 或用 `drop` 显式消掉。\n" +
        "管家平时只会在注入尾巴上收到必要的一行增量, 快忘的时候 (交接 / 压缩后、隔了很多轮) 收到一次全表; 其余时候想看就调它。",
      inputSchema: currentAddressSchema({
        drop: z.array(z.string()).optional().describe("要消掉的那几项: 写对方的名字 (= 你派给它、还开着的那项), 或表里每行开头的 event id: 不再需要、或已经另行处理了。"),
        why: z.string().optional().describe("消掉的理由, 一句话 (记进账本)。"),
        name: z.string().optional().describe("看别人的挂起事项 (只读)。省略 = 你自己的。"),
      }),
    },
    async ({ drop, why, name }) =>
      unwrapText("pending_items", await daemonPost("/pending", { ...(drop?.length ? { drop } : {}), ...(why ? { why } : {}), ...(name ? { name } : {}) })),
  );

  server.registerTool(
    "stop_wizard",
    {
      title: "Interrupt or end another wizard",
      description:
        "打断或强制结束一个 wizard。mode='interrupt' 只打断它当前这一轮 (等价于群里的 /stop); mode='end' 强制结束它 (等价于 /kill, 之后再找它是一个空白会话)。加 forget=true 连它的身份记录一起抹掉 (名字、职责、记忆)。",
      inputSchema: currentAddressSchema({
        name: z.string().describe(ADDRESS_DOC),
        mode: z.enum(["end", "interrupt"]).optional().describe("'end' 强制结束 (默认); 'interrupt' 只打断当前这一轮。"),
        forget: z.boolean().optional().describe("仅对 end 有效: 连身份记录 (名字/职责/记忆) 一起删除。默认 false —— 身份留着, 下次它回来还是它。"),
        turn: z.string().optional().describe("仅对 interrupt, 通常不用给: 不带 turn / force 时就是撤回你派给它、还在飞的那一笔 (唯一时); 你在它手上并发两笔才写那一笔的 event id (400 会列出来)。只撤回**你自己派的**那一件:它正在做的就是这件才按 Esc; 还排着或它在做别人的活, 就只把这件记成取消, 不碰它手上那一轮。"),
        force: z.boolean().optional().describe("仅对 interrupt: 它此刻在做别的 wizard 派的活时, 不带 turn 的打断默认被拒 (会误伤那件); 确要打断加 true。"),
      }),
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

  return server;
};
