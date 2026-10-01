# openclaw / dsh → wezard: 可迁移机制调研

> 调研日期 2026-10-02 · 作者 `.ev-claw` · 只写「机制 ↔ wezard 对应物 ↔ 差距 ↔ 迁移建议」, 不做综述。
> 文件/工具名均为 wezard 仓库现状 (main @ 92e28c9 + 工作区未提交改动)。

## 0. 先确认对象

| 名字 | 实际是什么 | 来源 |
|---|---|---|
| **openclaw** | 本机常驻的个人 agent **Gateway** (WS 控制面 :18789), 接 WhatsApp/Telegram/Discord/Matrix 等 IM; 记忆、技能全是工作区里的 md/yaml; 2026-01 发布, MIT | docs.openclaw.ai, clawdocs.org |
| **dsh** | **DeepSeek Harness** (`deepseek-ai/deepseek-harness`, 2026-08-13 发布), 跑在 Cordis 插件框架上的 agent harness, `npx @deepseek-ai/dsh web` 起 Web UI :3080。「Everything is a Plugin」 | github.com/deepseek-ai/deepseek-harness `docs/architecture.md` |
| 同类 1 | dsh **Agent Teams** (实验, `ctx.agentTeams`) 及社区版 `NanmiCoder/dsh-agent-teams` —— 与 Claude Code agent teams 同构 (roster + 任务 DAG + mailbox) | 见 §3 |
| 同类 2 | **Letta** sleep-time agent / memory blocks; **Hermes Agent** (Nous) 的自生技能 | 已被 `daemon/memory-steward.ts` 部分借鉴, 见 §4 |

dsh 能找到且公开, 无需替身。但它的 README 很薄, 机制细节来自 `docs/architecture.md`, 置信度中等; openclaw 文档完整, 置信度高。

---

## 1. 总表 (按关注点)

| 关注点 | openclaw | dsh | wezard 现状 | 结论 |
|---|---|---|---|---|
| 记忆形态 | `USER.md` / `MEMORY.md` / `memory/YYYY-MM-DD.md` / `DREAMS.md`, 开局按**预算**注入, 超了截断注入副本、磁盘不动 | session log 是 append-only `SessionEvent`, 一切状态 = 投影 (`ctx.sessionProjections`) | self: `wizards.json.memory[]` (`MEMORY_MAX=60`, `NOTE_MAX=600`, FIFO 丢最老); chat/workspace: `~/.wezard/memory/*.md` 经 inbox → steward 合并 | **学**: 注入预算 + 自记忆不再 FIFO 静默丢 |
| 压缩前刷记忆 | `compaction.memoryFlush`: 压缩前跑一轮**静默私有**回合让 agent 落盘 | 投影增量折叠, 压缩不丢事件 | 无。只有 agent 自觉调 `wizard_handoff_self`; autocompact 发生时没人提醒它先 `wizard_remember` | **学** (高收益低成本) |
| 心跳 / 主动性 | `heartbeat.every` 30m + `HEARTBEAT.md` scratch; 空 scratch 跳过; `HEARTBEAT_OK` ≤300 字静默丢弃; `activeHours`; 会话忙则跳过; `isolatedSession`/`lightContext` | 无心跳, 有 `ctx.jobs` + `job_*` 工具管后台作业 | `tasks.ts` (`trigger→gate→render→dispatch`) + `shared/trigger.ts` 的 `between` 守卫; `task-gate.ts` 返回 false 零成本; `shared/keepalive.ts` 只保温缓存、不是主动性 | **部分学**: 「无事则静默」协议 + 忙则顺延; 不学「默认开心跳」 |
| 技能/工具自描述 | `SKILL.md` frontmatter; 开局只注入 `<available_skills>` 紧凑清单, 超 `maxSkillsPromptChars` 先砍描述保名字; 全文按需 `skills_read`; `requires.bins/env/os` 加载期门控 | `ctx.tools` 注册 + `tools/pre-execute → execute → post-execute` 管线; schema 经 `ctx.systemPrompt` 组装 | MCP 描述 (`mcp/server.ts` ~44KB) + 宪章里的工具清单与编排手册 (`renderCharter`) | **学**: 分层自描述 (清单常驻、细节按需); 见 §2.3 的关键事实 |
| 会话与渠道路由 | `bindings` 最具体优先 9 级匹配 (peer > guild > account > channel > default); 会话键 `agent:<id>:main`, `dmScope`; `sessions_send`/`sessions_spawn` + `tools.agentToAgent.allow` | `ctx.webhookRuntime` 认证投递 → 建 Workspace Session | target key `chat:xxx#slot` + 全局唯一 `.name`; 每轮 `channel` 戳; `""` = 私聊; `route.ts` + `route_candidates` 给证据不拍板 | **wezard 更强**, 只学 A2A 白名单 (可选) |
| 权限审批 | `security: deny/allowlist/full` × `ask: off/on-miss/always` × `askFallback`; IM 里 ✅/♾️/❌ 反应 | 审批策略在 `dsh-base`, 走 `tools/pre-execute` 事件 | `approval.ts` 卡片 ✅/✅总是(`allow_always`)/⏱窗口/❌, `session-cache.ts`, `shared/allow-rules.ts`, `danger.ts` 逐次独占, `fallbackOnError` | **基本对齐**, 只学 per-wizard 策略轴 |
| 多 agent 协作 | 子 agent 被提醒 ~15× token; A2A 默认开 | Workflow 脚本 (`agent()/parallel()/pipeline()` + schema); Agent Teams: roster + 任务 DAG (`blockedBy`) + durable mailbox, 空闲成员自动认领 | `clone_wizard` (fork 上下文) / `spawn_wizard` / `jobs.ts` 工单 / `receipts.ts` 异步回执 / `graph.ts` | **学**: 任务依赖 + 结构化回执; 不学自动认领 |

---

## 2. openclaw

### 2.1 记忆: 预算注入 + 压缩前静默刷盘

| 项 | 内容 |
|---|---|
| 它的机制 | ① 开局注入 `USER.md`(小预算)、`MEMORY.md`(全文, 超预算截断**注入副本**)、今天+昨天的日记。② `agents.defaults.compaction.memoryFlush.enabled/model`: 自动压缩前, 在**会话私有副本**上跑一轮「把要紧的写进记忆文件」, 这轮的家务消息不出现在后续对话里。③ 「dreaming」把日记里合格的条目晋升进 `MEMORY.md`。④ `memory_search` 混合检索 (向量+关键词), `memory_get` 按行读 |
| wezard 对应 | ① `renderCharter` 把 self memory + `memory/chats/<base>.md` + `memory/workspaces/<cwd>.md` 全文注进 `--append-system-prompt`。② 无。③ `memory-steward.ts` (inbox → 合并, 30min 一轮, 白板执行体) —— 与 dreaming 同构。④ 无检索, 全靠注入 |
| 差距 | (a) 注入无总预算: 群/工作区 md 是人可编辑的, 长了直接撑大每个 wizard 的系统提示, 且 `/clear` 也甩不掉。(b) self memory 60 条满后 `slice(-60)` **静默丢最老** —— 最老的往往是最基础的事实。(c) autocompact 时 wizard 手上的结论只能靠摘要模型碰运气保留 |
| 迁移建议 | **A. 压缩前刷盘 (推荐, 低成本)**: daemon 已能算 ctx (`wizard_whoami` 的 contextTokens, `peers.ts` 认 `compact_boundary`)。在 ctx 越过阈值 (如 autocompact 线前 ~10%) 时, 借 `notices.ts` 的通路在下一条注入里挂一行 `<system-reminder wezard="flush">`: 「上下文将被压缩, 先把本轮该活下来的东西 `wizard_remember`」。不额外起轮, 不出气泡。收益: handoff/compact 前后的知识连续性; 成本: 一个阈值 + 一种 reminder kind。**不要**学它的「私有副本跑一轮」—— wezard 的会话在 tmux 里, 没法在私有副本上跑, 硬做就是多花一轮。**B. 注入预算**: `renderCharter` 给三份记忆各设字数上限, 超了截断并附「全文在 `<path>`, 需要时 Read」。收益: 系统提示有界; 成本: 十几行纯函数。**C. self memory 满额交给 steward**: 到 `MEMORY_MAX` 时不 FIFO, 而是往 steward 收件箱投一条「合并 `.x` 的自记忆」, 复用现成管线 |
| 不该学 | 向量检索 `memory_search`: wezard 的记忆量级 (每份几十条) 全量注入即可, 引 embedding 是纯负担; 真需要时 `Grep` 那几个 md 就够。按日期分日记: wezard 的「日记」就是 transcript + rolepage, 再写一份是冗余 |

### 2.2 心跳: 「无事则静默」协议

| 项 | 内容 |
|---|---|
| 它的机制 | 每 `heartbeat.every` 给主会话发心跳提示 + 该作业的 scratch (`HEARTBEAT.md`/`openclaw cron scratch`)。scratch 实际为空 → 不跑 (`reason=empty-heartbeat-file`)。回复以 `HEARTBEAT_OK` 起/止且剩余 ≤300 字 → **丢弃不投递**。目标会话有活跃/排队工作 → 跳过。`activeHours` 限时段。`isolatedSession`/`lightContext` 降成本。agent 可在心跳轮里经 `heartbeat_respond({scratch})` 改自己的清单。明确分工: 周期任务归 automations(cron), 心跳不管日程 |
| wezard 对应 | `schedule_task` → `~/.wezard/tasks/<id>.task.mjs`; `gate` (子进程+超时) 返回 false = 零成本不放枪 —— 等价「空 scratch 跳过」且更强 (可执行判断); `between`/`onDays` 守卫 = `activeHours`; 默认 `fresh` 白板 wizard = `isolatedSession` |
| 差距 | (a) **没有回复层面的静默**: gate 只能在放枪前判断; 一旦放枪, 白板 wizard 跑完「今天没什么」也会冒一条气泡 —— gate 写不出来的「要看过才知道没事」就只能吵。(b) 点名已有 wizard (`name`) 的日程, 撞上它正忙时的语义未定义 (是插队排队还是顺延)。(c) 没有「wizard 自己维护的清单」—— 但 task 文件本身就是 wizard 可直接编辑的源码, 等价 |
| 迁移建议 | **A. `QUIET` 哨兵 (推荐)**: 定义一个回复哨兵 (如末行 `RESULT: QUIET` 或 `HEARTBEAT_OK` 式 token), `tasks.ts`/mirror 出站时若一轮回复以它收尾且正文 ≤ N 字, 只进 rolepage 不推群。收益: 「每小时巡检, 有事才说」可表达; 成本: 出站一处判定 + 宪章一句约定。**B. 忙则顺延**: 点名式日程在目标 `paneIsBusy` 时按 `when:"idle"` 语义排队 (`tell_peer` 已有), 而不是硬贴 |
| 不该学 | 「默认给每个 agent 开 30 分钟心跳」: wezard 一个人常驻上百个 wizard, 默认心跳 = 每小时数百个空轮; wezard 的 gate-先行设计 (不跑 > 跑完再静默) 才是对的方向, 心跳只该作为一种 task 模板存在。把 scratch 存 SQLite: wezard「配置即源码、状态另存」(`task-state.json`) 已更好 |

### 2.3 技能自描述: 紧凑清单常驻, 全文按需

| 项 | 内容 |
|---|---|
| 它的机制 | `SKILL.md` 仅 `name`+`description` 进系统提示 (`<available_skills>`, 每项 ~24 token); 超 `skills.limits.maxSkillsPromptChars` 时**先砍描述、保名字与位置**; 全文由 `skills_read` 按需取。`metadata.openclaw.requires.{bins,env,config}` / `os` 在**加载期**过滤 —— 不满足的技能根本不出现。会话开始快照, watcher 250ms 去抖热更新。per-agent `skills` 白名单 (非空即覆盖, 不合并) |
| wezard 对应 | 工具描述在 `mcp/server.ts` (≈44KB, 单个描述常数百字, 混着用法、反例、历史); 宪章 (`renderCharter`) 再写一遍工具清单 + 编排手册 |
| **关键事实** | CLAUDE.md 说「工具描述是 wizard↔wizard 协作的全部发现机制」—— 在当前 Claude Code 上**已不成立**: MCP 工具默认是 deferred 的, 模型开局只看到工具**名字**, 描述要 `ToolSearch` 之后才加载 (本会话即如此)。所以真正被每个 wizard 读到的是**宪章里的那份清单**; `server.ts` 里的长描述只在调用前那一刻被读 |
| 差距 | 自描述没有分层: 同一信息在宪章和描述里各写一份、长度都不受约束, 改一处忘一处; 宪章每次随系统提示整份进上下文, 也没有预算 |
| 迁移建议 | **把三层显式化**: L0 宪章 = 每个工具一行「什么时候用」(就是 openclaw 的 `<available_skills>`), 设字数预算; L1 MCP description = 参数语义与边界 (调用前才加载, 可长); L2 = 罕用细节放进 `docs/` 或一个 `wizard_help(topic)`。收益: 宪章变短、两处不再漂移、新工具只需加一行 L0; 成本: 一次描述重排, 无行为改动。门控可顺手学: codebuddy 等无某能力的后端, 宪章里直接不列对应工具 (现在 `spawn-tmux` 只是不带宪章) |
| 不该学 | ClawHub 式技能市场与 `skills install`: 文档自己承认「被恶意行为者盯上」, 且 wezard 的扩展点是 MCP 工具 + task 源码, 不需要第三方分发; 技能 = 提示注入面, 对一个能操控企微的 daemon 是纯风险 |

### 2.4 路由与 A2A

| 项 | 内容 |
|---|---|
| 它的机制 | `bindings[]` 按 9 级「最具体优先」把入站映射到 `agentId`, `match` 内多字段 AND; 会话键 `agent:<id>:main`, DM 默认折到 main, `dmScope` 可拆; `sessions_send`/`sessions_spawn` 跨 agent, `tools.agentToAgent.{enabled,allow}` 白名单, `tools.sessions.visibility` 收窄可见性; per-agent `tools.allow/deny` |
| wezard 对应 | 入站: `inbound.ts` 按 chat → 默认会话, `.name` 点名跨群叫人 (`nameTokenRe`); 回复按轮 `channel` 回到发问的群 (openclaw 没有这个: 它的回复跟会话走); `tell_peer` 私聊/`public`; `route_candidates` 给分派证据 |
| 差距 | wezard 的路由是「名字即地址 + 每轮频道戳」, 比静态 bindings 灵活, 不缺。唯一缺的是**治理面**: 任何 wizard 都能 `tell_peer`/`stop_wizard` 任何 wizard, 没有可见性/许可边界 |
| 迁移建议 | 暂不迁。等出现「不可信 wizard」(比如跑第三方代码、或别人的工作区) 时, 再加一条 per-wizard `peers.allow` —— 落点是 daemon 的 `/peer/*` 路由入口一处判定。今天单用户部署下是负收益 |
| 不该学 | 静态 bindings 表: wezard 的 chat→wizard 关系由人在群里说话动态建立, 配置化反而退步 |

### 2.5 审批

| 项 | 内容 |
|---|---|
| 它的机制 | 三轴: `security` (deny/allowlist/full) × `ask` (off/on-miss/always) × `askFallback` (无 UI 或超时时的判决); allowlist 支持 `argPattern` 正则; IM 里 ✅ 一次 / ♾️ 总是 / ❌ |
| wezard 对应 | `approval.ts` ✅ / ✅总是 (`allow_always`, 写规则) / ⏱窗口 / ❌; `shared/allow-rules.ts` (Claude Code 规则语法); `danger.ts` 危险名单逐次独占、不吃窗口与缓存、fallback 降为 ask; `fallbackOnError` |
| 差距 | wezard 已对齐甚至更细 (danger 独占、批量合流)。差的只有: 策略是**全局**的, 不能说「`.doc` 这个只写文档的 wizard 一律 deny Bash」 |
| 迁移建议 | 可选: `approval.allowRules` 支持按 wizard 名覆盖 (`rules[".doc"]`), 在 hook 已带的 sessionId → wizard 名处解析。收益: 给跑腿 wizard 收窄权限、少点卡; 成本: 一层查表。优先级低 |
| 不该学 | `security: full` / `/elevated` 这类一键全放: wezard 的价值就是每次调用可见可拦 |

---

## 3. dsh (DeepSeek Harness)

### 3.1 一切状态 = 事件日志的投影

| 项 | 内容 |
|---|---|
| 它的机制 | `ctx.sessions` 是 append-only `SessionEvent` JSONL (有版本与迁移链, 已提交的生成路径永不改名/删除); `dsh-session-projection` 注册 `ctx.sessionProjections`, 各投影单元**增量折叠**已提交事件, 消费者只读一个类型化状态; `deriveMessages()` 也只是一个投影 |
| wezard 对应 | 事实源 = 各 CLI 的 transcript jsonl; 但读侧散落: `peers.ts` (`tailTurns`/`talkTurns`/`openToolUses`)、`chat-log.ts`、`detail-store`/turn store、`usage.ts`、`route.ts` 各自从尾部重读重解析 |
| 差距 | 同一份 jsonl 被多个模块各读各的 tail、各自过滤 keepalive、各自认 `compact_boundary`; 口径一致靠约定 (`shared/keepalive.ts` 的注释就是在补这个洞) |
| 迁移建议 | **把「transcript → 状态」收成一组注册式纯折叠 `(state, line) => state`**, 由 mirror-bridge 的 tail 驱动一次、多个投影共享 (busy/ctx/openToolUses/lastReply/filesRead…)。roster/peek/route 只读投影。收益: 口径单源、读放大消失、新视图只加一个 reducer —— 这恰好也是「过程即原语」的数据底座; 成本: 中等, 需要渐进迁移 (先 `openToolUses` + ctx 两个)。**不必**学 Cordis 的 DI/上下文体系, 只学「日志 + 折叠」这一个形状 |
| 不该学 | 自有 session 格式与迁移链: wezard 寄生在 Claude Code 的 jsonl 上, 不拥有格式, 自建一层持久化只会制造双写 |

### 3.2 Workflow: 模型写的确定性编排

| 项 | 内容 |
|---|---|
| 它的机制 | 模型提交 `{meta, script, args}`, 脚本在 worker 线程里跑, `agent(prompt, {schema})` 返回文本或**按 JSON Schema 校验的对象**, `parallel()` / `pipeline()` 组合; 参数非法、schema 不支持、超 agent 上限 → 整个 workflow 失败而非某个子 agent 失败 |
| wezard 对应 | 编排控制流故意留在发起 wizard 的上下文 (`jobs.ts` 不持控制流; `receipts.ts` 只是投递通路); `graph.ts` 是固定 pipeline × rounds; 回执是自由文本 + 约定的 `RESULT:` 行 |
| 差距 | (a) 回执无结构: 汇总方要从散文里抠结论, 工单「齐了」只能数份数, 不能按字段合并。(b) `graph.ts` 是声明式管线, 表达不了 fan-out→verify 这种依赖形状 |
| 迁移建议 | **A. 回执 schema (推荐)**: `tell_peer`/`clone_wizard` 可带可选 `schema`, 信封告诉对方「末尾输出一个符合该 schema 的 json 块」, `receipts.ts` 取回复时解析并校验, 失败就原文回送并标 `schemaError`。收益: `close_job` 可以机械合并、run 级去重; 成本: 信封一段 + 一个解析器, 不动控制流。**B.** 不要把 workflow 脚本引擎搬进 daemon —— 它与「reload 只丢一次重试、不复活状态机」的既定取舍冲突; wezard 的等价物就是发起 wizard 自己 (它就是那段脚本) |
| 不该学 | worker 线程里跑模型生成的 JS 编排: 在 daemon 进程里执行模型代码, 违背 wezard「daemon 只做投递与记账」; 若真需要, 已有的 `task-gate.ts` 子进程+超时模式才是正确的隔离样板 |

### 3.3 Agent Teams: 任务 DAG + 持久信箱

| 项 | 内容 |
|---|---|
| 它的机制 | 实验特性 `ctx.agentTeams`: durable roster + 共享任务 DAG (`pending/in_progress/completed/deleted`, `blockedBy`) + durable mailbox (成员直发、无需中转, 投递失败下个状态边界重试)。社区版: 成员在**第一个任务就绪时**才生; 空闲成员原子认领就绪任务; 改派会撤销旧 attempt 并等旧 worker 静默后再开新 attempt; 完成后整团归档 |
| wezard 对应 | roster = `wizard_roster`/`wizards.json`; mailbox = `tell_peer` + `receipts.ts` (回执排队到发话方空闲再贴, 已 durable 化程度不明); 工单 = `jobs.ts` (成员集 + 哪些为工单而生); 无任务依赖 |
| 差距 | `jobs.ts` 只记「谁在这单里」, 不记「哪件活依赖哪件」; 发起者得自己记住「A 回来了才能派 C」—— 上下文一压缩就可能丢 |
| 迁移建议 | `open_job` 的计划允许带 `tasks: [{id, to, after?: [id]}]`, `jobs.ts` 只**记账**依赖 (仍不持控制流), 回执信封里多一行「已解锁: C (原依赖 A)」。收益: 依赖关系不再只活在发起者上下文里, 也能画进 rolepage 关系图; 成本: ledger 多一个字段 + 信封一行 |
| 不该学 | 空闲成员**自动认领**任务: 与 wezard「控制流在发起 wizard 手里」冲突, 且自动认领把判断权交给调度器, 出错时没有一个上下文知道为什么; 「撤销旧 attempt 等静默」这套也只在自动调度下才必要 |

---

## 4. 同类里真正有启发的两点

| 来源 | 机制 | wezard 对应 | 建议 |
|---|---|---|---|
| **Letta** memory blocks / sleep-time agent | core memory 分**带标签、有字数上限**的 block, agent 用 `memory_replace`/`memory_insert` **原地改写**; 后台 sleep-time agent 异步整理 | steward 已借鉴 sleep-time (见 `memory-steward.ts` 头注释); 但 self memory 是只追加的 `string[]`, 没有改写/删除原语, 满了 FIFO | 给 `wizard_remember` 加 `replace`/`forget` (按条目序号), 让自记忆可修正而不是只增; 与 §2.1-C 合用。成本低, 收益是记忆不再随时间变脏 |
| **Hermes Agent** (Nous) | 复杂任务完成后 agent **自己把做法写成 skill** (程序性记忆), 下次按需加载 | 无程序性记忆; 「怎么做」只能以散文塞进 workspace memory, 每次全量注入 | 不急。等 §2.3 的分层自描述落地后, workspace memory 里「做法类」条目可以落成 `docs/` 下按需读的文件、宪章只留一行指针 —— 即同一个 L0/L2 分层 |

不学: Claude Code agent teams 与 dsh teams 同构 (shared task list + mailbox + 自动认领), 理由同 §3.3。

---

## 5. 落地优先级

| # | 项 | 落点 | 收益 | 成本 |
|---|---|---|---|---|
| 1 | 压缩前刷记忆提醒 | `notices.ts` 新 kind + ctx 阈值 (`peers.ts` 已能算) | 高: compact/handoff 前后知识连续 | 低 |
| 2 | 定时任务 `QUIET` 静默哨兵 | `tasks.ts` 出站判定 + 宪章一句 | 高: 「有事才说」的巡检可表达 | 低 |
| 3 | 记忆注入预算 + 自记忆满额交 steward + `replace/forget` | `renderCharter` / `wizard.ts` / `memory-steward.ts` | 中高: 系统提示有界、记忆不变脏 | 低-中 |
| 4 | 自描述三层化 (宪章一行清单 / MCP 描述 / docs) | `renderCharter` + `mcp/server.ts` | 中: 去重、防漂移; 修正「描述即发现」的过时前提 | 中 (纯文本重排) |
| 5 | 回执可选 schema | 信封 + `receipts.ts` | 中: 工单可机械汇总 | 中 |
| 6 | transcript 投影化 | `peers.ts` / `chat-log.ts` / `route.ts` 读侧 | 中长期: 原语化的数据底座 | 中-高, 渐进 |
| 7 | 工单记账依赖 `after` | `jobs.ts` + 信封 | 中 | 低-中 |
| — | per-wizard 审批策略 / A2A 白名单 | `approval.ts` / `/peer/*` | 低 (单用户) | 低 — 等需求 |

## 6. 明确不学

- 默认开启的周期心跳 (百级 wizard 下是空轮风暴; gate 先行更对)
- 向量记忆检索、按日日记 (量级不需要; transcript/rolepage 已是日记)
- 技能市场 / 第三方技能安装 (提示注入面 + 供应链风险)
- daemon 内执行模型生成的编排脚本、自动认领任务的调度器 (违背「控制流在发起 wizard 上下文」)
- 静态 bindings 路由表、一键 `full`/elevated 审批
- 自建 session 持久化格式 (wezard 不拥有 jsonl)

## 来源

- openclaw: [docs.openclaw.ai/concepts/memory](https://docs.openclaw.ai/concepts/memory) · [concepts/compaction](https://docs.openclaw.ai/concepts/compaction) · [gateway/heartbeat](https://docs.openclaw.ai/gateway/heartbeat) · [concepts/multi-agent](https://docs.openclaw.ai/concepts/multi-agent) · [tools/skills](https://docs.openclaw.ai/tools/skills) · [tools/exec-approvals](https://docs.openclaw.ai/tools/exec-approvals) · [clawdocs.org core concepts](https://clawdocs.org/getting-started/core-concepts)
- dsh: [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) · [docs/architecture.md](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md) · [NanmiCoder/dsh-agent-teams](https://github.com/NanmiCoder/dsh-agent-teams) · [tenten: workflow & agent teams](https://developer.tenten.co/deepseek-harness-workflow-agent-teams) · [dsh tools catalog](https://teamorouter.com/blogs/dsh-tools-catalog-guide)
- Letta / Hermes: 据公开文档的一般认知, 未逐页核对, 仅作 §4 旁证
