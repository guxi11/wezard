// Declarative config: schema (zod) + loader. Pure transforms, file IO at boundary.
// `.describe()` on a field is the prose config_get shows a model — keep it one
// sentence of "what"; the "why" stays in source comments. `knob` (config-meta.ts)
// marks who may change a subtree (`gate`) and whether a change bites without a
// reload (`apply`); both are inherited downward.
import { readFileSync, existsSync } from "node:fs";
import { parse as parseJsonc } from "jsonc-parser";
import { z } from "zod";
import { expandHome } from "./paths.js";
import { resolveCliBackend } from "./cli-backends.js";
import { EFFORTS } from "./effort.js";
import { knob } from "./config-meta.js";

// 守护进程每次用时都现读 `cfg.x` 的项 —— 逐个核实过, 没核实的一律留默认 reload。
const hot = <T extends z.ZodTypeAny>(s: T): T => knob(s, { apply: "hot" });

const CLI_NAMES = ["claude", "claude-internal", "codebuddy"] as const;
const LOG_LEVELS = ["trace", "debug", "info", "warn", "error"] as const;

// ── Schema ──────────────────────────────────────────────────────────
const Bot = z.object({
  botId: z.string().min(1).describe("企微智能机器人 botId"),
  secret: z.string().min(1).describe("企微智能机器人 secret"),
  websocketUrl: z.string().url().default("wss://openws.work.weixin.qq.com").describe("企微长连接地址"),
});

const Daemon = z.object({
  host: knob(z.string().default("127.0.0.1").describe("守护进程 HTTP 监听地址"), { gate: "card" }),
  port: knob(z.number().int().min(1).max(65535).default(17890).describe("守护进程 HTTP 监听端口"), { gate: "card" }),
  stateDir: z.string().default("~/.wezard/state").describe("守护进程状态目录"),
  logFile: z.string().default("~/.wezard/daemon.log").describe("守护进程日志文件"),
  logLevel: z.enum(LOG_LEVELS).default("info").describe("日志级别"),
  // 想让手机 WeCom 也能点开, 需要在反向代理后填外网地址。桌面端用回环即可。
  detailPublicBase: knob(z.string().default("").describe("工具调用 / 授权详情页链接的根 URL; 空 = http://<host>:<port> 回环"), { gate: "card", apply: "hot" }),
  // 每次 record*() 后 fire-and-forget POST 到 <base>/d 存到远端 store, 链接根也换成 <base>。
  // 用这条路径解决 daemon (公司内网) 和 chat 用户 (移动网络) 不同网段的场景。
  detailRemoteBase: knob(z.string().default("").describe("远端 detail svr (wezard svr) 地址; 空 = 不转发, 详情走本机"), { gate: "card" }),
  detailRemoteToken: knob(z.string().default("").describe("远端 detail svr 的口令"), { gate: "hidden" }),
  detailLinksInMirror: hot(z.boolean().default(true).describe("镜像消息里把每个 tool_use 行包成指向详情页的链接")),
});

const Mirror = z.object({
  // An escape hatch for a nonstandard location. Other installed backends always
  // use their own built-in roots; the mirror probes all of them, so setting this
  // does not narrow which CLIs can be mirrored.
  projectsDir: z.string().default("").describe("默认 CLI 的 transcript 根目录; 空 = 按 defaultCli 自动推导"),
  sessionId: z.string().default("").describe("钉死要镜像的会话 id; 空 = 取工作区下最新的 .jsonl"),
  pushChat: hot(z.string().default("").describe("实时输出推往哪个聊天; 空 = defaultChat")),
  // WeCom markdown caps `content` at 4096 UTF-8 bytes; shared/md-chunk measures
  // in bytes too — CJK is 3 bytes/char.
  chunkBytes: hot(z.number().int().positive().default(3800).describe("单条推送的字节上限, 长回复按此分页")),
  // Off by default: WeCom-sourced inbounds get dedup'd anyway, and local CLI typing
  // is rare in the bot-driven flow — keeping it on mostly produced echo noise.
  includeUser: z.boolean().default(false).describe("镜像人在 CLI 里敲的 prompt"),
  includeTools: z.boolean().default(true).describe("镜像 tool_use (Bash/Edit/Read…)"),
  includeToolResults: z.boolean().default(false).describe("镜像 tool_result (通常很吵)"),
  toolResultMaxChars: z.number().int().positive().default(400).describe("每条 tool_result 截断到多少字符"),
  // 旧值 40 太窄, 长 bash / 长 file_path 直接被截掉; 抬到 120 兼顾可读与单行。
  toolUseInlineMaxChars: z.number().int().positive().default(120).describe("工具调用气泡里 compact 一行的最大字符数"),
  // Files persist — claude reads them by absolute path.
  inboxDir: z.string().default("~/.wezard/inbox").describe("企微发来的图片 / 文件落盘目录"),
  // Restored on daemon boot + lazily on first inbound after reload — so reloading
  // the daemon doesn't re-spawn a fresh claude for an already-bound chat.
  attachmentsFile: z.string().default("~/.wezard/mirror-attachments.json").describe("镜像绑定 (聊天 → 会话/jsonl/tmux) 的持久化文件"),
  // 运行时状态 (会话生生死死), 所以落在 state 目录而不是 config.jsonc —— 与 chats 的
  // 名字表相反: 那是人手写的长期配置。
  wizardsFile: z.string().default("~/.wezard/wizards.json").describe("wizard 名册 (名字/职责/记忆/家谱) 文件"),
  // 与 wizards 分开存: wizard 是长期身份, job 是一次性的活 —— 混在一张表里, 收工
  // 清理会连身份一起抹掉。
  jobsFile: z.string().default("~/.wezard/jobs.json").describe("工单账本文件"),
  // 落盘是为了扛住 reload —— 被派活的 wizard 自己常以 reload 收尾, 纯内存的话它那
  // 一份回执就跟着旧进程没了。
  receiptsFile: z.string().default("~/.wezard/receipts.json").describe("在飞 tell_peer 回执的登记文件"),
  pendingFile: z.string().default("~/.wezard/pending.json").describe("挂起事项表: 各 wizard 派出去、还没了结的事"),
  // 同理扛 reload: 落在「杀了旧 pane、还没贴回简报」之间, 纯内存的话新会话就空着
  // 醒来, 简报跟着旧进程没了。
  handoffsFile: z.string().default("~/.wezard/handoffs.json").describe("在飞交接 (handoff) 的登记文件"),
  // 同理扛 reload: 纯内存的话 reload 之后每个 pane 头一条注入又把整段说明挂一遍。
  noticeSeenFile: z.string().default("~/.wezard/notice-seen.json").describe("每个 wizard 近几次注入尾巴上挂过哪些提示 (去重用)"),
  // 不是能力上限, 是"忘了收"的刹车: 分身能递归生分身, 而每个都是一个 tmux pane +
  // 一份上下文, 一次跑飞的编排足以把 fd 吃光 (见 launchd plist 的 NumberOfFiles)。
  cloneMax: hot(z.number().int().positive().default(8).describe("一个 wizard 名下同时活着的分身上限")),
  // 派出去的活, 对方持续闲着又没交回结论 → 守护进程代发话方同件号追问一句进展 (见 daemon/idle-nudge.ts)。
  // 每次巡检现读, 改完即用。
  idleNudge: hot(z
    .object({
      afterMin: z.number().nonnegative().default(5).describe("对方持续闲置多少分钟、仍无回执才追问; 0 = 关闭"),
      max: z.number().int().nonnegative().default(3).describe("同一件活最多追问几次"),
    })
    .default({})
    .describe("派活后对方闲置无回执时的自动追问")),
  // 没开顶层模式的群里 wizard 之间当着人说话多了 → 给那个群的管家挂一条提醒, 让它问人要不要开
  // (见 daemon/top-only-nudge.ts)。每次计数现读, 改完即用。
  topOnlyNudge: hot(z
    .object({
      windowMin: z.number().nonnegative().default(30).describe("统计窗口 (分钟); 0 = 关闭"),
      threshold: z.number().int().nonnegative().default(6).describe("窗口内 wizard 间公开往来 (公开的 tell_peer / dispatch, 一次 = 一条派活气泡 + 它的回复进群) 达到几次就提醒; 0 = 关闭"),
      cooldownH: z.number().nonnegative().default(24).describe("同一个群提醒过后多少小时内不再提 (人没开也不反复问)"),
    })
    .default({})
    .describe("没开顶层模式的群里 wizard 间公开往来过多时, 提醒该群管家问人要不要开顶层模式 (chatPolicy.<chat>.topOnly)")),
  // liveStream 仍活时不受影响——直接走 typewriter。
  standaloneDebounceMs: hot(z.number().int().nonnegative().default(30000).describe("非流式推送的防抖聚合窗口 (ms), 窗口内多条合并; 0 = 关闭")),
  // 窗口内 item 累积:
  //   • 出现 needs-approval tool_use → 立刻把 buffer 聚合成单条 standalone 推出 (赶在
  //     授权卡之前), 切到 AWAITING_APPR 等点击; 点击后再开 stream 续 tool_result+回复。
  //   • 窗口内 turn_end (纯文本快回复) → buffer 整体作为一条 standalone, 不开 stream。
  //   • 窗口超时 → 正常开 stream, 重放 buffer。
  outboundDeferMs: hot(z.number().int().nonnegative().default(3000).describe("派发后延迟开流的窗口 (ms); 0 = 立即 ack")),
  // Claude Code 的 assistant 行写盘相对 PreToolUse hook fire 有 tens-to-hundreds ms 异步
  // 抖动, 没等到的话 drain 抓空, 卡先到、思考过程后到。轮询步进 50ms。
  flushBeforeCardWaitMs: hot(z.number().int().nonnegative().default(800).describe("发卡前等目标 tool_use 落盘的最长时间 (ms); 0 = 不等")),
  // codebuddy 对 AskUserQuestion 不在提问时触发 PreToolUse hook (先弹本地面板),
  // mirror 从 jsonl 提前探测到 function_call 后直接下发 vote 卡。该卡与本地面板
  // 竞争 — 面板本就无限期阻塞 turn, 卡对齐 longPollSec 的 12h; 本地先答会作废它。
  askqVoteTimeoutSec: hot(z.number().int().positive().default(43200).describe("codebuddy 提问卡的等待上限 (s)")),
  // 必要性: Claude Code 把以 tool_use 收尾的整个 turn 攒着, 等工具 resolve 才 flush
  // 到 jsonl —— 而工具正卡在这张授权卡上, 于是前言在发卡时点既不在 jsonl 也不在
  // hook 的 transcript_tail 里, 唯一存在处是 pane。抠不到时静默退回「只发卡」(无回归)。
  panePreamble: hot(z.boolean().default(true).describe("发授权卡前先从 pane 抠出 assistant 前言推一条")),
  // 中间 tool_use / tool_result / thinking / 非 final text 全部只写进详情页, 不发气泡。
  // 授权卡照常发群 (交互无法替代)。
  brief: hot(z.boolean().default(true).describe("Brief 模式: 一轮在群里只发「本轮详情」链接 + 最终回复")),
  // 人在 CLI 手敲的那一轮 (以及它触发的斜杠命令回执) 不再下发气泡 —— 镜像改为发生在
  // 他眼前的终端 + chat 详情页。每个 attachment 首次静默时发一条带链接的提示。
  // 只在 brief=true 下生效: 抑制的前提是详情页兜住内容, 而 turn store 只有 brief 在写。
  chatOriginOnly: hot(z.boolean().default(true).describe("出处门: 只把群里发起的轮次下发到群, CLI 手敲的只进详情页")),
  slashAckFirstLine: hot(z.boolean().default(false).describe("/clear、/new 等斜杠命令回执只发第一行 ack, 不附 tip")),
  // 值越大越不容易误收 (model 思考时间长), 但用户等最终结论的延迟也越大。不设则按
  // 后端自动: codebuddy 1s (派发子 agent 期间由 openAgents guard 拦截), claude 4s。
  softTurnEndMs: hot(z.number().int().positive().optional().describe("软收口静默期 (ms): 多久没有新输出算一轮结束; 不设 = 按后端自动")),
  // 只收 pane, 保留 store 绑定 (sessionId/jsonl), 下一条消息走 dead-pane `--resume` 自愈
  // 复活, 对话不丢。与 /kill 的分界线就是那行 store.drop: reap 是"睡着", kill 是"死了"。
  // 名下有定时任务 / 挂着审批 / 正忙 / 人正盯着的不收, 所以实际数量可能暂时高于上限。
  maxPanes: z.number().int().nonnegative().default(20).describe("活着的会话 pane 上限, 超出从最久没动的收起; 0 = 关闭"),
  // ── Prompt-cache keepalive ────────────────────────────────────────────
  // Anthropic prompt caching: cache-write costs 1.25x (5min TTL) / 2x (1h TTL),
  // cache-read 0.1x. A pane that goes idle (agent parked waiting on a peer, or a
  // long background task) lets that cache expire — so the next real turn pays a
  // full re-write of the entire context. keepalive injects a tiny ping just
  // before expiry: it re-reads the cached prefix and slides the TTL forward, so
  // the eventual real turn only writes the delta.
  // Off by default: it was built for the API's 5min default, but Claude Code on a
  // subscription writes 1h entries (measured here: 1490/1491 main sessions, and
  // 229/230 requests 6–60min apart still hit in full), so idle gaps within the
  // hour need no warmer — and every ping is a real model turn in a live pane.
  // Turn it on where transcripts show 5min writes (`ephemeral_5m`, e.g. a bare API key).
  // 保温 tick 每 15s 现读整节; 只有 ping 另被启动时建成的识别表用着。
  // A cache idle past 10min is never warmed (1h entries need no warmer) — so in
  // practice only 5min entries are.
  keepalive: hot(z
    .object({
      enabled: z.boolean().default(false).describe("prompt-cache 保温总开关; 订阅下缓存本是 1h, 默认关"),
      // The warm-ping cadence follows the TTL each session's cache was actually
      // written with (`cache_creation.ephemeral_1h/5m` in its transcript — 1h on a
      // Claude Code subscription); this only applies when no such split is on record.
      ttlSec: z.number().int().positive().default(300).describe("缓存 TTL 兜底值 (s)"),
      // The ping needs slack to land and settle. Effective idle trigger = ttlSec - marginSec.
      marginSec: z.number().int().nonnegative().default(45).describe("提前 TTL 到期多少秒打 ping"),
      // Real activity resets the count, so bridging restarts from each genuine
      // turn: 6 pings = ~26min on a 5min cache. Each ping is a
      // near-free cache-read (0.1x); a single cold-rewrite of a large context
      // costs 1.25x (5min) / 2x (1h) of its full size, so a handful of pings beats
      // letting it expire while the user is still around.
      rounds: z.number().int().positive().default(6).describe("最后一次真实轮次之后最多保温几次"),
      // Tiny (small cache-write delta) and self-describing so a human glancing at
      // the pane sees why it's there. The reply is swallowed — never mirrored to
      // chat, the detail store, or usage accounting.
      ping: knob(z.string().default('keepalive — reply with just "pong", take no other action').describe("保温 ping 的文本"), { apply: "reload" }),
      // A spawn that passes the param explicitly always wins. false → useful when
      // most spawns are short-lived task runners and only a few should be kept warm,
      // at which point those few pass `keepalive:true` explicitly.
      spawnDefault: z.boolean().default(true).describe("spawn/clone 没传 keepalive 时, 新 wizard 是否保温"),
    })
    .default({})
    .describe("prompt-cache 保温: 空闲 pane 在缓存过期前打一个小 ping")),
});

const Wrc = z.object({
  allowFrom: knob(z.array(z.string()).default([]).describe("允许驱动本机的聊天 / 用户 (principal)"), { gate: "card", apply: "hot" }),
  // Still honored as a back-compat alias — resolveCliBackend picks it up when
  // cliBackends.<name>.bin is unset. Kept so existing configs keep parsing.
  claudeBin: knob(z.string().default("claude").describe("旧版单一 CLI 二进制路径 (兼容用, 优先用 cliBackends)"), { gate: "card" }),
  // NOT exclusive: the daemon mirrors sessions from every installed CLI
  // concurrently, resolving each attachment's binary + jsonl dialect from its own
  // transcript path (shared/cli-backends.ts bindCliBackends / backendForPath).
  // When unset, resolveCliBackend infers from claudeBin basename (so legacy
  // `claudeBin: "claude-internal"` configs still resolve correctly). The Wrc
  // transform below pins the inferred name back into v.defaultCli.
  defaultCli: z.enum(CLI_NAMES).optional().describe("新开会话默认用哪个 CLI; 不设 = 按 claudeBin 推断"),
  // Example: cliBackends: { codebuddy: { bin: "/usr/local/bin/codebuddy" } }
  cliBackends: knob(z
    .object({
      claude: z.object({ bin: z.string().optional().describe("二进制路径") }).optional(),
      "claude-internal": z.object({ bin: z.string().optional().describe("二进制路径") }).optional(),
      codebuddy: z.object({ bin: z.string().optional().describe("二进制路径") }).optional(),
    })
    .default({})
    .describe("各 CLI 后端的二进制路径覆盖; 缺省 = 内置默认"), { gate: "card" }),
  cwd: z.string().default("~/.wezard/workspace").describe("新会话的默认工作区"),
  // 默认摘掉 wizard 用不上、每个会话首轮白占 ~18k token 的工具 (Artifact 11.3k · Workflow/SendFeedback/ScheduleWakeup 5.6k · claude.ai Docs/Drive 1.0k)。
  // 显式写了 extraArgs 的 config 整份覆盖它, 不合并 —— 要留某个工具就把整串抄过去删掉那一项。
  extraArgs: knob(z.array(z.string()).default(["--disallowedTools=Artifact,Workflow,SendFeedback,ScheduleWakeup,mcp__claude_ai_Claude_Docs__*,mcp__claude_ai_Google_Drive__*"]).describe("启动 CLI 时追加的参数"), { gate: "card", apply: "hot" }),
  mirror: Mirror.default({}).describe("会话镜像: 推送、分页、详情页、pane 上限、保温"),
  // Auto-spawn fires when an authorized inbound finds no mirror attached for that
  // chat — allowFrom IS the authorization.
  tmuxPrefix: z.string().default("wezard").describe("自动起的 tmux 会话名前缀 (`<prefix>-<short>`)"),
  // 机器人显示名由建机器人的人自己取, 我们无法从消息里读到。群里 @ 它 / 引用它的
  // 气泡时, WeCom 会把 `@<显示名>` 塞进正文; 配上真名才能把它从 prompt 里剥干净。
  botNames: z.array(z.string()).default([]).describe("机器人在企微里的显示名 (可多个别名), 用于剥掉 @; 内置 wezard / weclaude 恒生效"),
}).transform((v) => {
  // Resolve the active backend once — honors defaultCli if set, otherwise
  // infers from claudeBin basename (legacy back-compat). Pin the inferred
  // name back into v.defaultCli so downstream readers see a concrete value
  // and so logs / sync labels can report the effective backend.
  const backend = resolveCliBackend(v);
  if (!v.defaultCli) v.defaultCli = backend.name;
  // Sync claudeBin to the resolved backend's bin so every daemon file that
  // reads cfg.wrc.claudeBin (mirror-bridge, spawn-tmux, quota)
  // spawns the correct binary — even when the user set only `defaultCli`
  // without an explicit `claudeBin`. Without this, defaultCli:"codebuddy"
  // + inherited claudeBin:"claude" would spawn the wrong CLI.
  v.claudeBin = backend.bin;

  // Auto-derive projectsDir from the resolved backend when not explicitly
  // set. Replaces the old claudeBin-basename derivation — same result for the
  // standard cases (claude → ~/.claude/projects, claude-internal →
  // ~/.claude-internal/projects), plus now supports codebuddy →
  // ~/.codebuddy/projects. Explicit projectsDir still wins.
  if (!v.mirror.projectsDir) {
    v.mirror.projectsDir = backend.projectsDir;
  }
  return v;
});

// 危险操作名单 (daemon/danger.ts)。命中者强制单次审批: 不吃 auto-window、
// 不吃 session cache、不参与批量合流、卡上没有「全过」按钮、超时不静默放行。
// patterns 都是 JS 正则源码串, 大小写不敏感; allowPatterns 优先级最高。
const Danger = z.object({
  enabled: z.boolean().default(true).describe("危险名单总开关"),
  // 与 enabled=false 的区别: 名单仍会计算 (日志/redact 用得到), 只是不再拦。
  skip: z.boolean().default(false).describe("命中危险名单也直接放行 (只豁免命中名单的调用)"),
  // 压过危险名单 / askRules / ⏱窗口 / 会话缓存 —— 比 skip 更彻底 (skip 只豁免命中名单
  // 的调用, 普通调用照审)。denyRules 与 EnterPlanMode 拦截仍生效 (拒绝不是审批);
  // AskUserQuestion / ExitPlanMode 交互卡不受影响。
  skipAll: z.boolean().default(false).describe("跳过所有审批: 命中 matcher 的调用一律静默放行"),
  builtin: z.boolean().default(true).describe("用内置危险名单; false = 只用下面的自定义规则"),
  commandPatterns: z.array(z.string()).default([]).describe("危险 Bash 命令正则 (大小写不敏感)"),
  toolPatterns: z.array(z.string()).default([]).describe("危险工具名正则"),
  pathPatterns: z.array(z.string()).default([]).describe("危险路径正则"),
  allowPatterns: z.array(z.string()).default([]).describe("豁免正则, 优先级最高"),
});

const Approval = z.object({
  enabled: z.boolean().default(true).describe("审批总开关"),
  // 名单被关掉 (danger.enabled=false) 时 "danger" 自动退回 "all" —— 否则就成了「全
  // 放行」, 与 danger.skipAll 语义重合且更隐蔽。跳过所有审批不在 mode 里 —— 用
  // danger.skipAll, 与 danger.skip 成对。
  mode: z.enum(["all", "danger"]).default("all").describe("审批粒度: all = 每个命中 matcher 的调用都发卡; danger = 只有命中危险名单的才发卡"),
  matcher: z.string().default(".*").describe("哪些工具名进入审批 (正则)"),
  approvers: z.array(z.string()).default([]).describe("可以点审批卡的人; 空 = 不限"),
  // 必须严格大于 longPollSec, 否则 daemon 还在等点击时 hook 已经返回 ask。
  hookTimeoutSec: knob(z.number().int().positive().default(43210).describe("hook curl 的超时 (s), 须大于 longPollSec; 由 `wezard sync` 写进 hook 环境"), { apply: "reload" }),
  longPollSec: z.number().int().positive().default(43200).describe("审批卡等待点击的上限 (s)"),
  sessionCacheMinutes: z.number().int().nonnegative().default(30).describe("同一会话重复调用沿用上次决定的分钟数"),
  windowMinutes: z.number().int().nonnegative().default(600).describe("点「⏱ 窗口」后该会话自动放行的分钟数"),
  sensitiveArgRedact: z.boolean().default(true).describe("发卡前脱敏参数里的敏感值"),
  fallbackOnError: z.enum(["ask", "allow", "deny"]).default("ask").describe("审批链路出错时 hook 的回答"),
  // 单次到达走单卡路径, 仅多了一次性的延迟。
  batchCoalesceMs: z.number().int().nonnegative().default(250).describe("同会话同工具并发调用合成一张批量卡的等待窗口 (ms); 0 = 关闭"),
  // 用户仍可在本地 Shift+Tab 手动进 plan mode (那条路径不过 hook)。
  blockAutoPlanMode: z.boolean().default(true).describe("拦截模型主动调用的 EnterPlanMode"),
  danger: Danger.default({}).describe("危险操作名单: 命中者强制单次审批"),
  // 语法子集见 shared/allow-rules.ts。matcher 决定哪些工具进入审批, allowRules 在其中
  // 再挖细粒度豁免 (对 Bash 可按命令前缀区分, matcher 只认工具名做不到)。
  allowRules: z.array(z.string()).default([]).describe("Claude Code 风格的放行规则, 如 \"Bash(git log *)\""),
  // Bash 复合命令任一段命中即拒。优先级最高: deny > ask > allow。
  denyRules: z.array(z.string()).default([]).describe("同语法的拒绝规则: 命中直接 deny"),
  // 用于给危险前缀 (如 "Bash(rm *)", "Bash(git push *)") 兜底 — 即使 ⏱ 窗口开着
  // 也逐条确认, 语义对齐 Claude Code 的 permissions.ask。
  askRules: z.array(z.string()).default([]).describe("同语法的强制审批规则: 命中必发卡"),
  // 这类改动会触发 Claude Code 自己的原生确认框, 而那个框**不经过 PreToolUse hook** ——
  // 规则一放行就是"不发卡 + pane 无限期阻塞"的静默死锁。开启后命中的调用必发卡, 用户
  // 点「允许」后 daemon 去 pane 上把那个框按掉; 按不掉则 Esc 取消并把原因注入会话。
  // 仅对有活 tmux pane 的镜像会话生效 —— 本地会话用户自己按掉即可。
  claudeConfigGuard: z.boolean().default(true).describe("`.claude/**` 写守卫: 必发卡, 批准后替人按掉 CC 原生确认框"),
  // CC 在 hook 返回后才渲染它, 轮询步进 200ms。太短会误判成 no_modal (框随后才
  // 出现, 于是没人按, 退回死锁), 4s 覆盖实测抖动。
  claudeConfigModalWaitMs: z.number().int().nonnegative().default(4000).describe("批准后等 CC 原生确认框出现的最长时间 (ms)"),
  // WeCom 未公开该字段上限, 发送失败会自动缩到 600 重试一次 (见 approval.ts), 所以
  // 可以放心调大。手机端只渲染 quote 区前 2~3 行, 看全命令靠「展开完整命令」。
  cardQuoteMaxChars: knob(z.number().int().positive().default(1200).describe("审批卡引用区命令/参数体的最大字符数"), { apply: "reload" }),
  // 默认关闭 —— 长命令由卡片自己承载: 引用区可点进详情页, 「⋯」菜单有「📄 展开完整
  // 命令」按需发全文。客户端不渲染 action_menu、或就是要全文落在群里时设成正数。
  fullCommandPreludeChars: z.number().int().nonnegative().default(0).describe("长 Bash 命令发卡前先推全文的字数上限; 0 = 关闭"),
});

// sync.targets[].kind 的合法值。claude-internal / custom 等旧值自动 collapse
// 为 "claude" (preprocess) — settingsPath 已经表达了具体 fork, kind 只表达家族。
const SYNC_KIND_LEGACY_TO_CLAUDE = new Set(["claude-internal", "custom"]);
const normalizeSyncKind = (v: unknown): unknown =>
  typeof v === "string" && SYNC_KIND_LEGACY_TO_CLAUDE.has(v) ? "claude" : v;

const SyncTarget = z.object({
  // 仅用于 sync 日志; 真正决定写入位置的是 settingsPath。
  kind: z.preprocess(normalizeSyncKind, z.enum(["claude", "codebuddy"])).default("claude").describe("CLI 家族标签"),
  settingsPath: z.string().describe("要写入 MCP / hook 注册的 settings.json 路径"),
  scope: z.enum(["user", "project", "local"]).default("user").describe("settings 的作用域"),
});
const Sync = z.object({
  targets: z.array(SyncTarget).default([]).describe("`wezard sync` 要写入的 settings.json 列表"),
});

// 放在 top-level 而不是塞进 daemon: svr 是独立进程, 与 daemon 生命周期解耦。CLI 参数
// (--host/--port/…) 仍可覆盖, 空则退回硬编码默认 (0.0.0.0:17891)。
const Svr = z.object({
  host: knob(z.string().default("0.0.0.0").describe("svr 监听地址"), { gate: "card" }),
  port: knob(z.number().int().min(1).max(65535).default(17891).describe("svr 监听端口"), { gate: "card" }),
  stateDir: z.string().default("~/.wezard/svr").describe("svr 状态目录"),
  tokenFile: knob(z.string().default("~/.wezard/svr-token").describe("svr 口令文件"), { gate: "hidden" }),
  token: knob(z.string().default("").describe("svr 口令"), { gate: "hidden" }),
  logLevel: z.enum(LOG_LEVELS).default("info").describe("svr 日志级别"),
});

// 微信 ClawBot 通道 (daemon/weixin.ts)。每个扫码绑定的微信用户 = 一个群聊 `chat:wx_…`。
// 送达约束全是社区实测、互相矛盾的数字 (context_token 时效、每份 token 的条数、~8 分钟 4 条
// 频控), 所以账本的每个阈值都可调, 默认取保守值。账号凭据不进这里 (会进 dotfile 仓库),
// 只在 stateFile (0600)。
const Weixin = z.object({
  // 放权: 开了才有 `/wx bind` 入口, 一次扫码 = 一个微信号能驱动本机。
  enabled: knob(z.boolean().default(false).describe("开启微信 ClawBot 通道 (扫码绑定的微信用户各成一个群聊)"), { gate: "card" }),
  maxAccounts: knob(z.number().int().min(1).max(64).default(8).describe("最多同时绑定几个微信号 (= 几个微信群聊)"), { gate: "card", apply: "hot" }),
  sendCap: hot(z.number().int().min(1).default(3).describe("人每说一句 (一份 context_token) 之后最多发几条; 超出的压着, 等人再说话时取回")),
  minGapSec: hot(z.number().int().min(0).default(15).describe("同一微信号两条出站至少隔几秒, 期间的待发合并成一条")),
  ratePauseMin: hot(z.number().int().min(1).default(10).describe("被频控 (rate limited) 后暂停出站几分钟")),
  ctxTtlHours: hot(z.number().positive().default(10).describe("人多久没说话就不再尝试主动发 (context_token 视为过期)")),
  fallbackChat: hot(z.string().default("").describe("微信发不出 / 掉线时往哪个企微聊天报; 空 = 发起绑定的那个人")),
  typing: hot(z.boolean().default(true).describe("回复生成中在微信里显示「对方正在输入」")),
  baseUrl: z.string().default("https://ilinkai.weixin.qq.com").describe("iLink API 地址 (登录后以服务端给的为准)"),
  cdnBaseUrl: hot(z.string().default("https://novac2c.cdn.weixin.qq.com/c2c").describe("iLink 媒体 CDN 地址")),
  stateFile: z.string().default("~/.wezard/weixin.json").describe("已绑定账号与收发游标 (含凭据, 0600)"),
});

// 按难度分档: spawn_wizard / clone_wizard 的 `tier` 落到这里的 {cli, model, effort};
// 显式给的 model / effort / cli 压过档位。档名固定、按由轻到重排 —— MCP 参数是 enum, 宪章逐档列。
const Tier = z.object({
  cli: z.enum(CLI_NAMES).optional().describe("用哪个 CLI; 省略 = 继承调用方 (clone 一律继承父会话)"),
  model: z.string().default("").describe("口语化模型名 ('haiku' / 'sonnet 5' / 'opus'), 只写家族 = 该家族最新; 空 = CLI 默认"),
  effort: z.enum(EFFORTS).optional().describe("推理档位; 省略 = CLI 默认"),
});
export const TIERS = ["mini", "light", "standard", "hard", "ultra"] as const;
export type TierName = (typeof TIERS)[number];
const Models = z.object({
  tiers: z.object({
    mini: Tier.default({ model: "haiku", effort: "low" }).describe("机械一步: 照单执行、不用判断"),
    light: Tier.default({ model: "sonnet", effort: "medium" }).describe("跑腿: 查找、搬运、跑命令; 也是管家的默认档"),
    standard: Tier.default({ model: "sonnet", effort: "medium" }).describe("常规实现"),
    hard: Tier.default({ model: "opus", effort: "high" }).describe("要判断: 设计、排障、审查"),
    ultra: Tier.default({ model: "opus", effort: "max" }).describe("最难: 架构取舍、疑难排障、关键评审"),
  }).default({}).describe("spawn_wizard / clone_wizard / dispatch 的 tier 档位, 由轻到重"),
  // 只在起一个新的管家会话时落地 (首条消息 / `/new` / 交接重开; 死 pane 重生只在绑定没记模型时补);
  // 已在跑的管家不自动切 (换模型会让缓存整份重读)。
  steward: z.enum(TIERS).default("light").describe("各群管家 (群的默认会话) 用哪一档 (取值同 tiers); 群里要别的档 → chatPolicy.<chat>.steward。生效: 新起 / 交接重开的管家会话按它起, 已在跑的不动 —— 要它换上就 handoff 或 set_model"),
});

// 定时任务的**旧**存法 (1.5 之前)。现在一条任务是 ~/.wezard/tasks/<id>.task.mjs
// 一份可注入代码的配置 (shared/task-file.ts) —— 触发条件可组合、放枪前可以先探一眼,
// 这两件事都写不进 json。这里留着只为把老 config 里的记录抬过去:
// daemon/tasks.ts 的 migrateLegacySchedules 抬完就把这个数组清空。
const When = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("daily"),
    days: z.array(z.number().int().min(0).max(6)).default([]), // 空 = 每天; 0 = 周日
    hour: z.number().int().min(0).max(23),
    minute: z.number().int().min(0).max(59),
  }),
  z.object({ kind: z.literal("every"), minutes: z.number().int().min(1) }),
  z.object({ kind: z.literal("once"), at: z.number() }),
]);

const Schedule = z.object({
  id: z.string(),
  when: When,
  /** 排给谁干 —— 一个 wizard 的 target key。fresh 时它只当模板: 出处聊天与
   *  cwd/cli/model 从它身上继承, 活不在它那里跑。 */
  target: z.string(),
  prompt: z.string(),
  /** 到点是新起一个白板 wizard 执行 (跑完回收), 还是注入 `target` 那个已有会话。
   *  默认 false 是为了老记录: 1.4.x 写下的定时都是「注入已有会话」语义。新建的
   *  定时由 /tasks/schedule 决定, 没点名 wizard 时写 true。 */
  fresh: z.boolean().default(false),
  createdBy: z.string().default(""),
  createdAt: z.number().default(0),
  /** 上次触发时刻 (epoch ms)。去重、重启不重放、间隔计时都以它为准。 */
  lastFired: z.number().optional(),
  /** 人写的备注, 只用于列表回显。 */
  note: z.string().default(""),
});

// 1.4.x 之前这张表里还有「定时广播」(`kind:"broadcast"`, 更老的还没有 kind)。
// topic 订阅废弃后它们没有收件人了 —— 认不出的记录整条丢掉而不是抛: 一条过期
// 定时不该把 daemon 挡在启动之外, 那会让 launchd 陷进崩溃循环。
const Schedules = z.preprocess(
  (v) => (Array.isArray(v) ? v.filter((x) => Schedule.safeParse(x).success) : []),
  z.array(Schedule),
);

export type ScheduleRecord = z.infer<typeof Schedule>;

// 方向选 name→principal 而不是反过来: 名字是寻址用的 key, 这个方向天然保证唯一, 手写
// 也更顺。有了名字, 跨 chat 的 peer 才能写成 `daily#fix` 这种稳定地址。见 daemon/chat-name.ts。
const Chats = z.record(z.string(), z.string().describe("base principal (`chat:wr…` / `user:…`)"));

// 群聊级策略, 键是 base principal (确定的聊天 id) —— 聊天名会改, 拿它当键一改名策略就悄悄失效;
// config_set 收名字, 落盘前换成它此刻指向的 principal。会进宪章 (系统提示): 已在跑的 wizard 要 handoff
// 才换上新规矩 —— config_set 落盘时按宪章前后对比点名受影响的那些。
export const ChatPolicy = z.object({
  topOnly: z.boolean().default(false).describe("顶层模式: 人只和顶层 wizard (群管家 / 人 `.name` 点名的) 对话; wizard 之间一律私聊 (tell_peer / dispatch 的 public 失效), 被派活的 wizard 不能 notify 进群, 过程只在 rolepage"),
  stewardBudget: z.number().int().min(-1).default(4).describe("群管家的手闸: 每轮自己跑命令 / 外部工具的次数上限, 用完拒并叫它 dispatch; 改文件、开子代理、读代码 (Read / Grep / Glob 与读文件的 shell 命令) 一律拒。-1 = 不设闸"),
  steward: z.enum(TIERS).optional().describe("本群管家的档位, 覆盖 models.steward; 省略 = 跟全局"),
});
export type ChatPolicy = z.infer<typeof ChatPolicy>;

// 1.4.x 之前定时表住在 `topics.schedules` (同一张表里还混着 topic 广播)。订阅与
// 广播删掉后它升到顶层, 老 config 就地抬一手 —— 否则已排好的任务会静默消失。
const liftLegacySchedules = (v: unknown): unknown => {
  if (!v || typeof v !== "object") return v;
  const o = v as Record<string, unknown>;
  const legacy = (o.topics as { schedules?: unknown } | undefined)?.schedules;
  return legacy && !o.schedules ? { ...o, schedules: legacy } : v;
};

// gate 的分界线是「放权」: 谁能驱动本机 (allowFrom)、审批怎么判 (approval.*)、跑哪个
// 二进制带什么参数 (claudeBin / cliBackends / extraArgs —— 一个 --dangerously-skip-permissions
// 就绕过了整个审批)、往哪写别的 settings (sync)、把什么暴露到哪 (监听地址 / 详情外送 /
// 出站默认聊天) —— 这些要人点卡; 口令一律 hidden; 其余 wizard 直接改。
export const ConfigSchema = z.preprocess(liftLegacySchedules, z.object({
  bot: knob(Bot.describe("企微机器人凭据"), { gate: "hidden" }),
  defaultChat: knob(z.string().default("").describe("出站默认聊天 (没有更具体去向时推往这里)"), { gate: "card", apply: "hot" }),
  chats: hot(Chats.default({}).describe("聊天命名表: 名字 → base principal")),
  chatPolicy: hot(z.record(z.string(), ChatPolicy).default({}).describe("群聊级策略: base principal (`chat:wr…` / `user:…`) → 开关; config_set 写聊天名会换成它的 principal 落盘; 进宪章, 已在跑的 wizard 要 handoff 才换上 (config_set 落盘时会点名受影响的)")),
  daemon: Daemon.default({}).describe("守护进程: 监听、日志、详情页"),
  wrc: Wrc.default({}).describe("远程驱动: 授权名单、CLI 后端、工作区、镜像"),
  approval: knob(Approval.default({}).describe("工具调用审批: 粒度、规则、危险名单、窗口"), { gate: "card", apply: "hot" }),
  models: hot(Models.default({}).describe("按任务难度分档的模型 / effort, 以及各群管家用哪一档")),
  sync: knob(Sync.default({ targets: [] }).describe("把 MCP / hook 注册写进各 CLI 的 settings.json; 改完跑 `wezard sync` 才生效"), { gate: "card" }),
  weixin: Weixin.default({}).describe("微信 ClawBot 通道: 扫码绑定、收发节流"),
  svr: Svr.default({}).describe("独立详情中转服务 (wezard svr); svr 自己启动时读, 改完重启 svr 才生效"),
  schedules: knob(Schedules, { gate: "hidden" }),
}));

export type Config = z.infer<typeof ConfigSchema>;

// ── Loader ──────────────────────────────────────────────────────────
const DEFAULT_CONFIG_PATHS = [
  "~/.wezard/config.jsonc",
  "~/.wezard/config.json",
];
const SECRETS_PATH = "~/.wezard/secrets.json";

const readJsoncIfExists = (p: string): unknown | undefined => {
  const abs = expandHome(p);
  if (!existsSync(abs)) return undefined;
  const text = readFileSync(abs, "utf8");
  return parseJsonc(text);
};

const deepMerge = <T extends Record<string, unknown>>(a: T, b: Partial<T>): T => {
  const out: Record<string, unknown> = { ...a };
  for (const [k, v] of Object.entries(b ?? {})) {
    const av = out[k];
    if (v && typeof v === "object" && !Array.isArray(v) && av && typeof av === "object" && !Array.isArray(av)) {
      out[k] = deepMerge(av as Record<string, unknown>, v as Record<string, unknown>);
    } else if (v !== undefined && v !== "") {
      out[k] = v;
    }
  }
  return out as T;
};

/** Resolve config path: explicit > $WEZARD_CONFIG > defaults. */
const resolveConfigPath = (explicit?: string): string | undefined => {
  if (explicit) return explicit;
  if (process.env.WEZARD_CONFIG) return process.env.WEZARD_CONFIG;
  for (const p of DEFAULT_CONFIG_PATHS) {
    if (existsSync(expandHome(p))) return p;
  }
  return undefined;
};

export interface LoadResult {
  config: Config;
  sourcePath: string;
}

export const loadConfig = (explicitPath?: string): LoadResult => {
  const sourcePath = resolveConfigPath(explicitPath);
  if (!sourcePath) {
    throw new Error(
      `wezard config not found. Create ~/.wezard/config.jsonc (see config.example.jsonc) or set $WEZARD_CONFIG.`,
    );
  }
  const base = (readJsoncIfExists(sourcePath) ?? {}) as Record<string, unknown>;
  const parsed = parseWithSecrets(base);
  if (!parsed.success) throw new Error(`wezard config invalid (${sourcePath}):\n${configIssues(parsed.error)}`);
  return { config: parsed.data, sourcePath: expandHome(sourcePath) };
};

/** secrets.json 的原样内容 —— config_get / config_set 据此把来自它的路径一律藏起来。 */
export const readSecrets = (): Record<string, unknown> =>
  (readJsoncIfExists(SECRETS_PATH) ?? {}) as Record<string, unknown>;

const parseWithSecrets = (base: Record<string, unknown>) => ConfigSchema.safeParse(deepMerge(base, readSecrets()));

/** 一份 config.jsonc 全文按 loadConfig 的同一口径 (叠 secrets、整份校验) 解析 —— 写之前先过它,
 *  任何一次写入都不会产出一份让守护进程起不来的配置。 */
export const parseConfigText = (text: string) =>
  parseWithSecrets((parseJsonc(text) ?? {}) as Record<string, unknown>);

export const configIssues = (e: z.ZodError): string =>
  e.issues.map((i) => `  - ${i.path.join(".") || "<root>"}: ${i.message}`).join("\n");
