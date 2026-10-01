# wezard 过程与工具盘点 (事实底座)

> 盘点人 `.ev-tools` · 2026-10-02 · 范围: `mcp/server.ts`、`daemon/index.ts` 路由、`daemon/inbound.ts` IM 命令、`hooks/pre-tool-use.sh`、`shared/chat-http.ts`、charter 实物 (`~/.wezard/state/charters/*.md`)

## 0. 口径

| 项 | 方法 |
|---|---|
| 工具定义 | 直接跑 `dist/mcp/server.js` 的 `tools/list`, 量真实下发给模型的 JSON (含 zod 生成的 schema 与兼容层追加的 `tag`/`tags`) |
| token 粗估 | CJK 字符 ≈ 1 tok, 其余 ≈ 3.5 字符/tok。只做量级比较, 不是 tokenizer 精确值 |
| 使用频率 | `~/.claude*/projects`、`~/.codebuddy/projects` 下 60 天内改过的 567 个 jsonl, 抽 `tool_use` 中名字含 `wezard` 的块, **按 tool_use id 去重** (clone 的 transcript 以父会话历史开头, 不去重会重复计数)。共 1136 次, 近 7 天 546 / 近 30 天 1133 |
| charter | 取最近 40 份 charter 文件统计; 分节数据取本 wizard 自己那份 |

## 1. MCP 工具总表 (35 个)

`charter` 列 = 是否出现在 charter「我能做什么」里。`desc` = 描述 token; `def` = 整条定义 (描述+schema) token。

| # | 工具 | 做什么 | daemon 路由 | 参数 (不含兼容 `tag`) | 7d | 30d | desc | def | charter |
|---|---|---|---|---|---|---|---|---|---|
| 1 | tell_peer | 往另一个 wizard 输入框说一句, 不阻塞, 回执自动回来 | POST /peers/tell | name,text,when,waitSec,public,job,receipt | 93 | 93 | 605 | 1272 | ✓ |
| 2 | send_peer | tell_peer 的旧名 (deprecated 别名) | POST /peers/tell | 同上 | 116 | 304 | 670 | 1329 | ✗ |
| 3 | peek_peer | 只读另一个 wizard 最近 N 个来回 + 状态 | POST /peers/peek | name,turns | 89 | 210 | 291 | 540 | ✓ |
| 4 | wait_peer | 阻塞到对方空闲, 返回其最新回复 (deprecated) | POST /peers/wait | name,names,need,timeoutSec | 28 | 117 | 609 | 1036 | ✓ |
| 5 | wizard_roster | 全部 wizard 索引 (名字/忙闲/home/工作区/模型/家谱/最近) | POST /wizard/roster | query,chat,cwd,alive,limit | 66 | 69 | 406 | 679 | ✓ |
| 6 | spawn_wizard | 白板生子 wizard (可换目录/聊天) | POST /wizard/clone (inherit=false) | description,name,task,chat,cli,model,job,keepalive,cwd | 44 | 44 | 343 | 1082 | ✓ |
| 7 | clone_wizard | fork 自己或 `from` 的上下文出分身 | POST /wizard/clone (inherit=true) | 同上 −cwd +from | 1 | 1 | 480 | 1243 | ✓ |
| 8 | stop_wizard | 打断 (interrupt) / 终结 (end) / 抹身份 (forget) | POST /wizard/stop | name,mode,forget | 30 | 38 | 219 | 523 | ✓ |
| 9 | open_job | 开工单, 群里出「开工」气泡 | POST /jobs/open | title,plan | 4 | 19 | 327 | 489 | ✓ |
| 10 | close_job | 收工: 汇总进群 + 回收为工单生的分身 | POST /jobs/close | job,summary,stop | 3 | 11 | 140 | 327 | ✓ |
| 11 | list_jobs | 本聊天未关的工单 | POST /jobs/list | — | 0 | 0 | 68 | 128 | ✓ |
| 12 | read_chat | 按 role→chat→target 读聊天记录 | POST /chats/read | role,chat,target,since,until,limit,per | 18 | 18 | 535 | 909 | ✓ |
| 13 | wizard_whoami | 我是谁 + contextTokens + handoffSuggested | POST /wizard/whoami | — | 6 | 10 | 162 | 219 | ✓ |
| 14 | wizard_identity | 改名 / 写职责 | POST /wizard/identity | name,description | 5 | 8 | 170 | 337 | ✓ |
| 15 | route_candidates | 一件活该转给谁的证据表 | POST /wizard/route | task,cwd,limit | 6 | 6 | 267 | 455 | ✓ |
| 16 | wizard_remember | 写/删 self·chat·workspace 记忆 | POST /wizard/remember | note,forget,scope | 6 | 6 | 326 | 507 | ✓ |
| 17 | wizard_handoff_self | 自己写简报 → /new → 贴回简报 | POST /wizard/handoff-self | brief | 5 | 5 | 265 | 392 | ✓ |
| 18 | notify | 往聊天贴 markdown 给人看 | POST /notify | to,markdown | 5 | 5 | 252 | 445 | ✓ |
| 19 | new_claude_session | 在某目录生独立长住 wizard (≈ `/new .name`) | POST /sessions/new | cwd,name,chat,cli,model,keepalive | 0 | 12 | 334 | 1030 | ✗ |
| 20 | name_chat | 读/写/删本聊天名 | POST /chats/name (读走 /chats/list) | name | 0 | 2 | 254 | 398 | ✓ |
| 21 | list_tasks | 列定时任务 | POST /tasks/list | mine | 0 | 2 | 250 | 355 | ✓ |
| 22 | set_workspace | 换工作区 (= 往新目录 /new) 或 keep 确认 | POST /mirror/workspace | cwd,keep,target | 1 | 1 | 325 | 555 | ✓ |
| 23 | schedule_task | 排定时任务, 落成 `.task.mjs` | POST /tasks/schedule | when,prompt,name,fresh,id,note | 0 | 1 | **974** | **1706** | ✓ |
| 24 | cancel_task | 删定时任务 | POST /tasks/cancel | id | 0 | 0 | 171 | 267 | ✓ |
| 25 | set_model | 换模型 (session / 全局 default) | POST /wizard/model | model,name,scope | 0 | 0 | 361 | 636 | ✓ |
| 26 | list_chats | 跨聊天目录 | POST /chats/list | — | 0 | 0 | 148 | 212 | ✓ |
| 27 | run_agent_graph | 多 wizard 循环流水线 | POST /graph/run | nodes[{tag,cli,model,cwd}],steps,rounds,until,idleTimeoutSec | 0 | 0 | 312 | 883 | ✓ |
| 28 | graph_status | 查流水线 | GET /graph/status | runId | 0 | 0 | 97 | 202 | ✗ |
| 29 | stop_graph | 停流水线 | POST /graph/stop | runId | 0 | 0 | 76 | 173 | ✗ |
| 30 | handoff | 替**别人**交接 | POST /handoff | pane,name,focus,timeoutSec | 0 | 0 | 231 | 568 | ✗ |
| 31 | list_claude_sessions | 本机全部 tmux agent 会话 (含非 wizard) | GET /sessions/list | — | 0 | 0 | 200 | 264 | ✗ |
| 32 | switch_claude_session | 把本聊天镜像改接到某 sessionId | POST /sessions/switch | sessionId | 0 | 0 | 136 | 257 | ✗ |
| 33 | config_set | 读/改 daemon 配置 (11 个 key) | POST /config/get · /config/set | key,value,action | 0 | 0 | 234 | 474 | ✗ |
| 34 | wecom_doc_list_tools | 列企微文档/表格/通讯录 MCP 方法 | POST /wedoc/list | category,requesterUserId | 0 | 0 | 70 | 234 | ✗ |
| 35 | wecom_doc_call | 调企微文档 MCP 方法 | POST /wedoc/call | category,method,args,requesterUserId | 0 | 0 | 68 | 305 | ✗ |

**已退役但仍在被调用的名字** (旧会话的 MCP 进程是旧代码):

| 旧名 | 7d | 30d | 现状 |
|---|---|---|---|
| spawn_clone | 15 | 122 | 已拆成 spawn_wizard / clone_wizard, server.ts 不再注册 |
| list_peers | 5 | 29 | 已被 wizard_roster 取代; 路由 `POST /peers/list` 仍在 |

### 1.1 使用分布 (30 天, 1133 次)

| 档 | 工具 | 占比 |
|---|---|---|
| 高频 (≥ 90) | send_peer+tell_peer 397 · peek_peer 210 · spawn_clone+spawn_wizard+clone_wizard 167 · wait_peer 117 | **≈ 79%** |
| 中频 (10–90) | wizard_roster 69 · stop_wizard 38 · list_peers 29 · open_job 19 · read_chat 18 · new_claude_session 12 · close_job 11 · whoami 10 | ≈ 18% |
| 低频 (1–9) | identity · route_candidates · remember · handoff_self · notify · name_chat · list_tasks · set_workspace · schedule_task | ≈ 3% |
| **零调用** | list_jobs · cancel_task · set_model · list_chats · run_agent_graph · graph_status · stop_graph · handoff · list_claude_sessions · switch_claude_session · config_set · wecom_doc_list_tools · wecom_doc_call | **13 / 35** |

> 4 个动词 (说 / 看 / 生 / 等) 撑起 ~80% 的调用 —— 这就是事实上的原语核心。

### 1.2 上下文账单

| 块 | token (粗估) | 备注 |
|---|---|---|
| 35 个工具定义合计 | **≈ 20.4k** | 其中描述 ≈ 10.4k, schema/参数描述 ≈ 10k |
| ├ 零调用的 13 个 | ≈ 5.5k | 27% 的定义从没被用过 |
| ├ send_peer (纯重复) | ≈ 1.3k | 描述 = 一句「已更名」+ 完整 TELL_DESC |
| ├ schedule_task 单个 | ≈ 1.7k | 最长; 一半是 `.task.mjs` 进阶写法, 属于文档而非工具描述 |
| ├ `model` 参数描述 ×3 | ≈ 0.45k | new_claude_session / spawn / clone 各一份几乎相同的长句 |
| └ `tag`/`tags` 兼容字段 ×14 | ≈ 0.3k | 每个吃地址的工具都多一个「旧名, 同 name」 |
| charter (系统提示) | **≈ 4.4k** (中位, 4.2k–5.3k) | 见下表 |
| 合计 (工具全量加载时) | **≈ 25k** | |

charter 分节 (本 wizard 那份):

| 节 | tok | 问题 |
|---|---|---|
| 出生时同群的 wizard | **1443** (33%) | 出生快照, 只会越来越旧; 本份里 ~140 个无职责名字平铺; 真相在 `wizard_roster` |
| 我能做什么 (MCP) | 958 | 与工具描述重复 (列 26 个工具的一句话说明) |
| 怎么干活: 编排 | 855 | 与 tell_peer / open_job / clone_wizard 描述大段重复 (「派完就放手」「带 job」「409 处理」) |
| 怎么说话 | 729 | 与 tell_peer / notify 描述重复 (public vs 私聊) |
| 其余 4 节 | 625 | |

**加载方式的差异** (实测): 本会话 (Claude Code + tool search) 里 wezard 工具是 **deferred** 的 —— 开局只占名字, 用前 ToolSearch 拉 schema; 所以在 Claude Code 上真正常驻的是 charter (~4.4k) + 名字表。不支持延迟加载的后端 (claude-internal 旧版 / codebuddy) 才吃满 ~20k。这让「工具描述要自足」与「charter 要短」两条同时成立: charter 是唯一保证在场的那份。

## 2. daemon 路由 ↔ 调用方

| 路由 | MCP 工具 | 其他调用方 | 备注 |
|---|---|---|---|
| POST /peers/tell, /peers/send | tell_peer, send_peer | — | /peers/send 是旧名别名 |
| POST /peers/list | — | — | list_peers 的残留路由, 仓库内无调用方 (旧 MCP 进程仍调) |
| POST /message, /card | — | `cli/wezard.sh send`、`cli/audit.ts` (/message) | CLAUDE.md 说 MCP 暴露 `send_markdown/send_card/ask_user/daemon_status` —— **已不存在**, 文档过期 |
| POST /ask | — | AskUserQuestion → askq 卡片 | 模型侧走 CLI 自带 AskUserQuestion, 不走 MCP |
| POST /mirror/spawn, /mirror/inject | — | `cli/init.ts` | 初始化/调试入口 |
| GET /mirror/cwd, /mirror/status | — | `cli/wezard.sh` (status) | |
| POST /wedoc/invalidate | — | 无 | 疑似死路由 |
| POST /claim/* | — | `cli/init.ts` | 首次绑定 |
| GET /detail, /api/* (chat-http) | — | rolepage `web/chat.js` | **全部 GET, rolepage 是纯只读** |

## 3. 人侧入口 vs 模型侧入口

| 能力 | 人侧 (IM / 卡片 / rolepage) | 模型侧 (MCP) | 只有一侧 |
|---|---|---|---|
| 新开会话 / 生 wizard | `/new [cli] [model] [首句]`、`.x 首句` (隐式新建) | new_claude_session · spawn_wizard · clone_wizard | 人侧无「指定 cwd」; 模型侧有三把 |
| fork 上下文 | 无 (只能用自然语言让 AI 去 clone) | clone_wizard | **仅模型** |
| 清上下文 | `/clear [.x]` | tell_peer({text:"/clear"}) (描述里一笔带过) | 模型侧无一等工具 |
| 交接 | 无 `/handoff` 命令 | handoff · wizard_handoff_self | **仅模型** |
| 打断 | `/stop [.x]` | stop_wizard({mode:"interrupt"}) | |
| 终结 | `/kill [.x]` | stop_wizard({mode:"end"}) | `forget` 仅模型 |
| 按回车 | `/n` | 无 | 仅人 (模型侧可 tell_peer 空文本? 未定义) |
| 切终端窗口 | `/reveal` | 无 | 仅人 (合理) |
| 列本机会话 / 改接 | `/sessions` · `/sessions <emoji\|id>` | list_claude_sessions · switch_claude_session | 对称, 但模型侧零调用 |
| 聊天命名 | `/name` | name_chat | 对称 |
| 跨聊天目录 | `/chats` | list_chats | 对称, 模型侧零调用 |
| 列 wizard | `/peers` `/wizards` (本聊天) | wizard_roster (全机 + 过滤) | |
| 我是谁 / 目录 | `/id` `/pwd [.x]` | wizard_whoami | |
| 改名 / 职责 | 无 | wizard_identity | **仅模型** (人只能口头让它改) |
| 记忆 | 直接编辑 `~/.wezard/memory/*.md` | wizard_remember | 人侧没有 IM 入口 |
| 换工作区 | 无 IM 命令 (`/pwd` 只显示 pendingCwd) | set_workspace | **仅模型** |
| 换模型 | `/new <模型>`; `/model x` 透传给 CLI | set_model | 人侧无「给 .x 换模型」 |
| 驱动别的 wizard | `.x 文本` (公开, 回复回本群) | tell_peer (默认私聊) | 人侧无私聊 |
| 读别人 | rolepage (任意 role 视角) | peek_peer · read_chat | |
| 工单 | 只看到开工/收工气泡 | open/close/list_jobs | **仅模型** |
| 定时 | rolepage「日程」只读展示 | schedule/list/cancel_task | 人侧无列/删命令 |
| 给人发消息 | — | notify | |
| 循环流水线 | 自然语言让 AI 调 | run_agent_graph + status + stop | 仅模型, 零调用 |
| 用量 / 成本 | `/usage` `/cost` `/audit [.x]` | `wezard:audit` skill | 模型侧无额度查询 |
| 配置 | CLI `wezard config-path`, 手改 jsonc | config_set | IM 无命令 |
| 跨 CLI 配置同步 | `/cfgsync [apply]` | 无 | 仅人 |
| 审批 | 卡片 ✅ / ⏱ allow_window / ❌ | (hook 侧发起) | 仅人点 |
| 提问 | askq 投票卡片 | CLI 自带 AskUserQuestion | |
| 引用重发 | 引用消息 (前缀上下文 / 纯引用重发) | 无 | 仅人 |
| rolepage 上的写操作 | **无** (全部 GET) | — | rolepage 不能停/杀/改名/派活 |

## 4. 问题清单 (证据 → 建议)

建议词: **合并** = 两个工具变一个; **降级** = 留路由/兼容, 从 charter 和默认工具面里拿掉 (或只留一行描述); **删除**; **改名** (注意工具名是地址, 改名 = 新增新名 + 旧名降级为别名, 不能直接删)。

### 4.1 冗余

| # | 问题 | 证据 | 建议 |
|---|---|---|---|
| R1 | send_peer ≡ tell_peer | 同一 schema、同一路由 `/peers/tell`; send_peer 描述 = 一句 deprecated + 完整 TELL_DESC (≈1.3k tok)。但 30d 仍有 304 次 send_peer (大于 tell_peer 的 93), 近 7 天 116 vs 93 —— 旧名仍是主流 | **降级**: 保留注册 (旧调用不断), 描述压到一行「同 tell_peer」, 去掉 TELL_DESC 副本; 同时把其他工具描述里残留的 `send_peer` 字样全部换成 tell_peer (见 M1) —— 模型用旧名主要是被这些描述教的 |
| R2 | wait_peer 与回执机制重叠 | 描述自称 deprecated, 但 7d 仍 28 次; spawn/clone 的 OFFSPRING_TAIL、clone_wizard、open_job、wizard_roster、run_agent_graph、new_claude_session 6 处描述仍教「用 wait_peer 等」 | **降级**: 先清掉 6 处正向引导 (M1), 观察; 「同轮必须拿到答案」与 `need:1` 是真实剩余语义, 不删 |
| R3 | handoff vs wizard_handoff_self | 两个工具一个对人一个对己, 路由不同 (`/handoff` 由 daemon 让对方写简报; `/wizard/handoff-self` 由调用方自己写)。handoff 零调用, 需 `pane` 寻址 | **合并** 为一个动词 `handoff({name?, brief?, focus?})`: 无 name = 自己 (必须给 brief), 有 name = 别人。新名需新增; 两个旧名保留为别名并降级 |
| R4 | new_claude_session vs spawn_wizard | 都是「白板生 wizard」, 同一组参数 (cwd/name/chat/cli/model/keepalive)。差别只有: 是否挂家谱 (parent) 与是否必填 cwd/description。路由也分两条 (`/sessions/new` vs `/wizard/clone`)。30d new_claude_session 12 次 / spawn_wizard 44 次 | **合并**: spawn_wizard 加 `detached:true` (不挂名下、不计配额、不随工单回收) 即覆盖; new_claude_session **降级** (不在 charter 已是事实, 再把描述压到一行) |
| R5 | list_claude_sessions + switch_claude_session vs wizard_roster | list 是机器级 (含非 wizard 的终端会话), roster 是 wizard 级; switch 是「改接镜像」, 人侧 `/sessions` 已覆盖。模型侧两者 30d 零调用 | **降级**: 从默认工具面移除或合进 roster (`roster({unbound:true})` 列非 wizard 会话); switch 属于人侧操作, 留 IM 即可 |
| R6 | list_chats vs wizard_roster vs name_chat(读) | list_chats = 每个聊天 + 以它为 home 的 wizard; roster 每行已有 home 聊天; name_chat 无参读的实现就是调 `/chats/list` (`mcp/server.ts:316`) | **合并**: name_chat 的读路径回答本聊天名即可 (whoami 已含 home); list_chats 并入 roster (`roster({by:"chat"})` 或返回尾部附聊天目录)。零调用, 可降级 |
| R7 | run_agent_graph + graph_status + stop_graph | 30d 零调用; 能力 = 一串 tell_peer+wait 的固定编排, charter 已教「控制流在你手里」; 只活在内存, reload 即丢; 节点参数仍是 `tag` | **降级**: 三件套移出 charter 与默认工具面 (或合成一个 `agent_graph({op})`); 保留路由给人/脚本用。长线看它是「原语组合」的一个特例, 不该是原语 |
| R8 | list_jobs | 零调用; 回执信封已带工单进度 | 保留但描述 ≤ 1 行; 可并入 `whoami` (「我开着的工单」) |
| R9 | config_set 读写合一 + 名字叫 set | `value` 省略即读 | 见 S1, 安全问题优先于命名 |
| R10 | charter 与工具描述双写 | §1.2: charter 的「能做什么 / 编排 / 说话」三节 ≈ 2.5k tok 与 tell_peer/open_job/clone/notify 描述大段重合 | 二选一定位: charter 讲**原则与选择** (什么时候用哪个), 工具描述讲**机制与参数**; 互相引用名字, 不复述 |
| R11 | charter「出生时同群的 wizard」 | 1.4k tok, 占 charter 1/3, 快照; notices.ts 已有增量提醒, roster 是真相 | 只列**有职责**的同群 wizard (≤ 15 个), 无职责的给个数 + 「用 wizard_roster」 |

### 4.2 缺失

| # | 缺口 | 证据 | 建议 |
|---|---|---|---|
| G1 | 人侧无 handoff / 换工作区 / 换某 wizard 模型 / 列删定时 / 改职责 | §3 表 | 补 IM 命令时复用同一路由 (`/handoff .x`、`/cd <path>`、`/model .x opus`、`/tasks`、`/tasks rm id`) —— 一个能力一条路由、两侧各一个壳 |
| G2 | rolepage 纯只读 | `shared/chat-http.ts:459-476` 全 GET | 至少 stop/kill/handoff 三个按钮直通现有路由 (需鉴权票据) |
| G3 | 模型侧无一等 `/clear` | 只能 tell_peer 文本 "/clear", 描述里一句话 | 并入 handoff 语义 (`handoff({name, brief:""})` = 清空重开) 或在 stop_wizard 加 `mode:"clear"` |
| G4 | 模型侧无额度 / 成本查询 | 人有 `/usage` `/cost` `/audit` | `whoami` 已给 contextTokens; 加 `usage` 字段即可, 不新增工具 |
| G5 | 工单只能看自己聊天 | list_jobs 描述「这个聊天里」; roster/read_chat 都是全局 | 与全局寻址统一: 默认「我开的 + 我参与的」 |
| G6 | 路由 `/peers/list` `/wedoc/invalidate` 无调用方 | §2 | /peers/list 等旧 MCP 进程淡出后删; /wedoc/invalidate 确认无外部调用后删 |

### 4.3 命名 / 寻址不一致

| # | 问题 | 证据 | 建议 |
|---|---|---|---|
| N1 | 三套前缀并存: `*_peer` / `wizard_*` / `*_claude_session` / 无前缀 (notify, set_model, set_workspace) | 工具名列表 | 不改旧名 (地址)。**新增工具一律走动词优先的短名** 并在描述首行写清「同族」; 旧名保留别名。原语层 (见 §5) 再统一 |
| N2 | 地址参数不统一 | 大多 `name`; run_agent_graph 节点用 `tag` (`server.ts:495`); handoff 用 `pane` 优先 (`:562`); switch_claude_session 用 `sessionId`; set_workspace 用 `target` (`vid:`/`chatid:` 前缀, `:85`) | 地址统一为 `name`; pane/sessionId/principal 只作内部或兜底, 不出现在模型面 |
| N3 | 「聊天」参数语义漂移 | read_chat 的 `chat` 是过滤; spawn 的 `chat` 是 home; notify 的 `to` 是收件聊天; roster 的 `chat` 是过滤 | 文档化一张「chat 参数语义表」, 或 home 统一叫 `home` |
| N4 | `spawn` 一词两义 | spawn_wizard (白板) vs 旧 spawn_clone (含 fork) vs 路由 `/wizard/clone` 承载 spawn | 路由名不是地址, 可改为 `/wizard/bear` 之类中性名; 工具名不动 |
| N5 | config_set 也读 | `server.ts:661` | 描述首句写「读或改」已做到; 不改名 |
| N6 | wecom_doc_* 管的是 doc / smartsheet / **contact** | category 枚举 | 不改; 描述里说明它是「企微 MCP 透传」 |
| N7 | 「wizard / clone / peer / session / agent」五个词混用 | 工具 title: "agent sessions" / "another wizard" / "tagged agents"; IM `/peers` `/agents` `/wizards` 同义 | 模型面只留 wizard / 分身 (clone) 两词; session 只指「一段 transcript」 |

### 4.4 描述过长 / 误导

| # | 问题 | 证据 | 建议 |
|---|---|---|---|
| M1 | **过期引导**: 描述仍教旧做法 | `send_peer` 出现在 spawn_wizard (`server.ts:810` 「省掉一次 send_peer」「用 send_peer({public:true})」)、OFFSPRING_TAIL (`:802` 「用 send_peer 继续派活、wait_peer 等它做完」)、open_job (`:846` 「send_peer 的 job」、`:848` 「wait_peer 摘到就只回这一行」)、wizard_roster (`:707`)、new_claude_session (`:261`)、run_agent_graph (`:490` 「用 send_peer + wait_peer」)、read_chat (`:350`)、clone_wizard (`:826` 「先 wait_peer 等它停下」)、peek_peer 无 | 全部改 tell_peer, 删 wait_peer 正向引导。这是**最便宜、收益最大**的一项: 解释了 send_peer/wait_peer 为何「deprecated 了还是主流」 |
| M2 | run_agent_graph 描述说 `#tag` wizard、「这个聊天里的几个」 | `:490`, `:495` | 名字已全局、`#tag` 写法已废; 随 R7 降级时一并改 |
| M3 | schedule_task 描述 974 tok | `:588-595`: 一半在教 `.task.mjs` 的 when/gate 写法 | 工具描述只留「何时用 + when 人话 + 默认新建 + 必须回念 next」; gate/文件写法挪进任务文件模板头注释 (wizard 要改时 Read 它就看到) |
| M4 | `model` 参数长描述 ×3 | new_claude_session / spawn / clone 各 ~150 tok 同句 | 抽常量 + 压到 1 句: 「口语写模型, 实际落地值见返回 `model`」 |
| M5 | tell_peer 描述 605 tok 夹带编排教学 | `:403-407`: fan-out、何时 public、信封说明 | 编排与 public 判断留 charter (R10), 描述只讲机制 |
| M6 | handoff 描述让模型用 `pane` | `:560` 「按 tmux pane id (%5, 来自 wizard_roster / list_claude_sessions)」, roster 输出并不以 pane 为地址 | 随 R3 去掉 pane |
| M7 | CLAUDE.md 的 MCP 段过期 | CLAUDE.md:10 列 `send_markdown/send_card/ask_user/daemon_status`, server 已无; MCP server 名写 `wecom`, 实际 `wezard` | 改 CLAUDE.md (对人与模型都有误导) |
| M8 | IM `/help` 「协作」段说 AI 会「读它的终端」 | `inbound.ts:227`; CLAUDE.md 明确 peek 读 transcript 不读 pane | 改措辞 |

### 4.5 安全 (优先级最高)

| # | 问题 | 证据 | 建议 |
|---|---|---|---|
| S1 | **模型可自行关掉审批 / 扩授权, 无需人点卡片** | `hooks/pre-tool-use.sh:199` 对 `mcp__*wezard__*` 一律 `allow` (为解决首次绑定的鸡生蛋); `config_set` 支持 `danger_skip_all` (跳过全部审批)、`approval_mode`、`allow_from add`; 路由 `POST /config/set` (`daemon/index.ts:1832`) 无任何二次确认 | config_set 的**写**路径从模型面移除 (或 hook 白名单排除 `config_set`), 改为只走人侧 (IM `/config` 或 CLI)。读路径可保留 |
| S2 | set_model `scope:"default"` 改 CLI 全局设置, 同样免审 | `server.ts:750` | 白名单排除, 或要求人侧确认 |
| S3 | schedule_task 的 gate 在 daemon 进程里跑任意 shell | `daemon/task-gate.ts`; 写 gate 要 Edit 任务文件 (该 Edit 会走审批卡) | 现状可接受; 在描述/模板中注明「gate 不经审批运行」, 审批卡里对 `~/.wezard/tasks/*.task.mjs` 的 Edit 标危险 |

## 5. 给原语层的事实输入

按调用与语义归并, 现有 35 个工具 + IM 命令实际落在 **8 个动作 × 3 个名词** 上 (名词: wizard / chat / task):

| 原语候选 | 覆盖的现有入口 | 30d 调用 |
|---|---|---|
| `say(to, text, {public, job, when})` | tell_peer · send_peer · `.x 文本` · notify (to=chat) | 402 |
| `look(who, {turns, chat, target, since})` | peek_peer · read_chat · rolepage | 228 |
| `bear(desc, {from?, cwd, home, model, detached})` | spawn_wizard · clone_wizard · new_claude_session · `/new` · spawn_clone | 179 |
| `wait(who[], need)` | wait_peer (· graph 的 step 等待) | 117 |
| `find({query, chat, cwd, task})` | wizard_roster · route_candidates · list_chats · list_claude_sessions · `/peers` `/chats` `/sessions` | 104 |
| `end(who, mode: interrupt\|end\|forget\|clear\|handoff)` | stop_wizard · handoff · wizard_handoff_self · `/stop` `/kill` `/clear` | 43 |
| `self({name, desc, model, cwd, remember})` | whoami · identity · set_model · set_workspace · remember · name_chat | ~30 |
| `at(when, prompt, gate)` + `job(title)…close` | schedule/list/cancel_task · open/close/list_jobs | ~33 |

退出原语面的候选: run_agent_graph 三件套 (= `say`+`wait` 的循环组合)、config_set 写路径 (人侧)、switch_claude_session (人侧)、wecom_doc_* (领域插件, 不是 wizard 过程)。

## 6. 动作排序 (按 收益/代价)

| 序 | 动作 | 类型 | 代价 |
|---|---|---|---|
| 1 | S1/S2: hook 白名单排除 config_set(写)、set_model(default) | 安全 | 小 (一处 shell 判断) |
| 2 | M1: 描述里 send_peer/wait_peer 正向引导全部清掉 | 描述 | 小, 只改字符串 |
| 3 | R1/M3/M4/M5: 压缩 send_peer、schedule_task、model 参数、tell_peer 描述 | 上下文 | 小, 省 ~3k tok/会话 (全量加载时) |
| 4 | R11/R10: charter 同群名单只列有职责的; 三节去重 | 上下文 | 小, 省 ~2k tok/会话 (**每个会话都省**) |
| 5 | M7/M8: CLAUDE.md、/help 过期描述 | 文档 | 小 |
| 6 | R5/R6/R7/R8: 零调用工具降级出默认面 | 工具面 | 中, 需确认无人侧依赖 |
| 7 | R3/R4: handoff 合并、new_claude_session 并入 spawn | 合并 | 中, 新名 + 旧名别名 |
| 8 | G1/G2: 人侧补命令、rolepage 写操作 | 新增 | 中-大 |
