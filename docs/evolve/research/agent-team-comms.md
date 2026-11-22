# Agent team 通信机制对比: Claude Code 等系统 vs wezard「终句路由回执」与「严格模式显式出站」

> 调研 `.Frank` (派活 `.Carol-1`) · 2026-11-20 · 只研究、不改代码
> 代码证据基于 `v3` 分支 HEAD `cf3e0b3`; 外部资料为 2026-11-20 抓取的官方文档, 第三方逆向资料单独标注 (§7)
> 前作 `docs/evolve/research/a2a-frameworks.md` (2026-10-02) 偏「缺哪些原语」; 本文偏「结果与话怎么流动、在哪里坏」

## 0. 结论先行

1. **业界默认的收口通道是「终句 = 返回值」, 显式 send 只用于横向 / 中途的话。** Claude Code subagent 只把最终消息交回父会话; agent teams 的 teammate 停下时, idle 通知自动带上它的终答; Codex 主线程汇总各 subagent 结果; LangChain subagent 取 `messages[-1]`; OpenAI SDK 的 agent-as-tool 由 manager 收结果。显式 `SendMessage` (teams 邮箱、跨会话消息) 用于讨论、插话、续派; 跨会话消息**不自动回复**, 要收方再发一次 `SendMessage`。
2. **由模型显式写「完成状态」的那一半, 各家都承认会漏。** Claude Code agent teams 的已知限制里写着 "teammates sometimes fail to mark tasks as completed, which blocks dependent tasks"。它的补救是**轮内的门**: `TaskCompleted` / `TeammateIdle` / `Stop` hook 以 exit 2 或 `decision:"block"` 拦下, 让模型在同一段会话里继续补, 不靠事后追问。
3. **wezard 的终句路由 (implicit 群 + wizard 私聊) 是被调研系统里投递最耐久的。** 路由账是 append-only 日志的 fold (`daemon/router.ts:1-13`); 事件分 execution / exposure 两套状态, 不确定的注入不盲目重投 (`daemon/message-events.ts:72-73, 820-847`); 终句经 durable outbox 分片投递 (`daemon/message-events.ts:668-725`); 另有升级、死信、迟到追述。它的弱点在**判定**: 终句要从 transcript 尾部推断 (`daemon/index.ts:428-455`), 语义靠正则认 `RESULT:` / `NEED:` / `.name` (`daemon/peers.ts:482-594`), 外加一层层规则 (合并、追述、纠正)。
4. **严格模式把面向人的收口通道倒了过来: 终句一律丢弃, 只认 `chat_reply`。** 换来的是「人只看见刻意发出的话」, 以及成员制和频控。代价是一个**结构性**失败模式「答了没交付」, 现在靠宪章、当轮提醒、闲置追问、管家上报四层兜底 (§3.3 B1)。此外**显式出站这条路反而比终句路由更不耐久**: `chat_say` / `chat_reply` 走 fire-and-forget 的 `notifyChat` (`daemon/index.ts:963-968`); 销账不看是否发成; 幂等键只存在内存 (`daemon/index.ts:2198-2249`)。
5. **两处契约矛盾, 已用脚本复现 (§6)。**
   - (a) done 回执的信封一律写「无需 RESULT:」(`daemon/peers.ts:809`), 但服务 wizard 行的未标记终句会被路由判成 progress、零投递 (`daemon/router.ts:454`)。中间层转交因此静默卡住, 直到 idle-nudge 来追问。
   - (b) 严格群里, 顶层 wizard 收到的回执信封写着「投给群里的人」, 只字不提 `chat_reply` (`daemon/peers.ts:834-835`; 调用点 `daemon/index.ts:1450` 不传 strict)。这与宪章「终句不是交付」(`daemon/wizard.ts:997`) 正面冲突, 是回执轮「答了没交付」的直接诱因。
6. **建议主线**: 不在「终句路由」和「显式出站」之间二选一, 而是「**终句当草稿, 门由 daemon 判, 交付可以显式, 也可以兜底**」。
   - P0: 修上面两处信封矛盾; 严格出站改走同一个 durable outbox, 且投成后再销账; `re` 自动推断。
   - P1: 借 Claude Code 的 `Stop` hook (`last_assistant_message` + `decision:block`), 把收口校验搬进轮内同步完成; 给严格群一个可配置的「终句兜底交付」。
   - P2: 借 teams 的 TaskCompleted 门、跨会话消息的回环节流, 以及 artifact 引用。

---

## 1. 业界: agent team 怎么组织、怎么说话

### 1.1 五种通信原语

| 原语 | 结果 / 话怎么流 | 代表 | 优点 | 代价 |
|---|---|---|---|---|
| **R 终句即返回值** | 子 agent 跑完, 最后一条消息作为工具结果或完成通知回到调用方 | Claude Code subagent; OpenAI `Agent.as_tool()`; LangChain subagents (`messages[-1]`); CrewAI `Delegate work to coworker` / `Ask question to coworker` (以工具调用委托); Codex 主线程汇总; ADK `single_turn` / `task` 模式自动回父 | 模型不需要额外动作; 父方上下文只吃摘要 | 单向、一次性; 中途对话要靠 resume |
| **S 共享上下文 / 状态** | 所有参与者读写同一段对话或同一份 state | AutoGen AgentChat 群聊 ("all agents share the same context", 每条发言广播给全员); AutoGen Swarm; LangGraph state + `Command(update=…)`; MAF shared state (随 checkpoint 存) | 不用寻址; 天然一致 | token 随人数线性涨; 互相干扰; 难划边界 |
| **M 邮箱 + 显式 send** | 显式工具把话写进对方收件箱, 由运行时投递 | Claude Code agent teams (`~/.claude/teams/{team}/inboxes/{agent}.json` + `SendMessage`, "delivered automatically"); Claude Code 跨会话消息 (`ListAgents` / `SendMessage`, 回复不自动); AutoGen Core `send_message` (请求/响应) / `publish_message` (单向 topic); MAF executor 间的类型化消息; Codex `send_input` (第三方资料) | 能横向沟通、插话、广播, 可异步 | 模型要记得发、要发对人; 回复要另发; 回环与风暴要节流 |
| **H 控制权移交 handoff** | 把「这一轮由谁来答」连同历史交给另一个 agent | OpenAI SDK `transfer_to_<agent>` ("the new agent takes over the conversation"); AutoGen Swarm `HandoffMessage`; LangGraph `Command(goto=…, graph=Command.PARENT)`; ADK `chat` 模式 transfer | 专家直接面对用户 | 历史膨胀 (要 input_filter 或摘要); 限于单次 run 内 |
| **T 共享任务表** | 不是消息, 是协调态: 谁领了什么、依赖关系、做完没有 | Claude Code teams task list (pending / in_progress / completed、依赖、文件锁领取、做完自领下一件); wezard plans (owner-only DAG, 不自动派活) | 可并行自组织; 依赖自动解锁 | 状态写入会漏 ("task status lag"), 要有门 |

### 1.2 Claude Code (与 wezard 最近的参照物)

- **subagent**
  - 结果: "intermediate tool calls and results stay inside the subagent; only its final message returns to the parent"。
  - 执行: 默认后台跑, 工具结果先回 `async_launched`, 报告 "in a later turn" 以完成通知的形式送达。
  - 续跑与嵌套: 父方用 `SendMessage` 带 agentId 或 name 续跑它, 保留完整历史; 嵌套深度默认 3; 带名字的 subagent 之间可以互发消息。
  - 错误: 因 API 错误提前结束的 subagent, 错误 "is never delivered as its result"。
- **agent teams** (实验特性, `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`)
  - 组成: lead + teammates + 共享 task list + mailbox。
  - 投递: 消息 "delivered automatically to recipients. The lead doesn't need to poll"; 写进信箱成功才算发出。
  - 收口: teammate 停下时 "automatically notifies the lead and includes its final answer in the notification"; 以 API 错误收尾的一轮也会带着错误文本通知 lead。
  - 任务表: 三态加依赖, "Task claiming uses file locking"; teammate 做完一件会自领下一件未阻塞的。
  - hook: `TeammateIdle` / `TaskCreated` / `TaskCompleted` 以 exit 2 拒绝, 并把 stderr 作为反馈, 让它继续干。
  - 已知限制: task status lag; `/resume` 不恢复 in-process teammates; shutdown 慢; 一个会话只能有一队; 不可嵌套; lead 固定。成本 "significantly more tokens", 建议 3-5 人。
- **跨会话消息** (v2.1.224+)
  - 收发: `ListAgents` 找人, `SendMessage` 发。收方 "reads the message between tool calls during an active turn. When the receiving session is idle, Claude Code starts a new turn"。
  - **回复不自动**: 要收方再发一次 `SendMessage`。
  - 结果三态: Delivered / Held / Refused。
  - 节流: 长时间往返会暂停发送 ("this session keeps answering other sessions"); 短时间内同文重复会被丢弃。
  - 权限: 明确告诉收方这条 "came from another session, not from you"; 它不能批准任何东西、不能改配置, 斜杠命令按纯文本处理。
- **Stop / SubagentStop hook**
  - 输入带 `last_assistant_message` ("hooks can access it without parsing the transcript file"); 官方同时提醒 transcript 文件 "is written asynchronously and may lag"。
  - `decision:"block"` + `reason` 之后 "The conversation continues so Claude can act on the feedback"。
  - `stop_hook_active` 用来防死循环; 连续续跑 8 次后强制放行。
- **本次会话的实测旁证**: 这一轮我派出的 web-fetch 子 agent 有两种回法。有的报告作为 Agent 工具结果直接返回; 有的经它自己的 `SubagentHandback` 调用, 以「另一会话的消息」送到。两种都套着同一层来源框 ("model output, NOT a message from the user")。可见 Claude Code 自己也是「返回值 + 显式交回」两条通道并存, 并对来源做权限降级标注。

### 1.3 其他系统一览

| 系统 | 组织 | 结果回流 | 横向沟通 | 可靠性设施 |
|---|---|---|---|---|
| OpenAI Agents SDK | 两种: LLM 驱动 (handoff / agent-as-tool), 或代码编排 (链式、`asyncio.gather`、评审循环) | as_tool: manager 保留终答; handoff: 专家接管这一轮 | 无邮箱、无共享可变状态; "Handoffs stay within a single run" | 结构化输出 + 代码路由; guardrails 只作用于首个 / 末个 agent |
| Codex CLI subagents | 主线程 + agent thread (`default` / `worker` / `explorer`, 可用 TOML 自定义) | "The main thread collects the subagent results into its final response"; 建议 "Return summaries … instead of raw intermediate output" | 官方页没写工具名; 第三方资料: `spawn_agent` / `send_input` (可选打断或排队) / `wait` / `close_agent` | `max_concurrent_threads_per_session` 并发上限; 继承父方沙箱与审批; `/subagents` 查看 |
| AutoGen AgentChat / Core | 群聊 (RoundRobin / Selector / Swarm), 或 actor 运行时 | 群聊: 共享线程, TaskResult 收齐全部消息; Core: `send_message` 返回对方 handler 的返回值 | `publish_message` 按 topic 广播 (无响应, 异常只记日志) | 终止条件可组合; Core 无持久化 (就所读页面而言) |
| Microsoft Agent Framework | executor + edge 组成的类型化工作流 | 消息沿边流动; `request_info` 走人机回路 | edges | 每个 superstep 末 checkpoint (含 pending messages / requests), 可从 checkpoint 恢复 |
| LangGraph / LangChain | subagents (supervisor) / handoffs / router / 自定义 | subagent 作为工具, 回最后一条消息 ("the supervisor only sees the final output") | handoff 写 state 变量或 `Command(goto, update)`; 建议只传两条消息, 不传整段子历史 | checkpointer (thread 级持久化) |
| Google ADK | coordinator + subagents (`chat` / `task` / `single_turn`) | chat: 靠 transfer 手动回父; task: `finish_task` 自动回; single_turn: 自动带结果回 | 分支隔离, "cannot see what its peer agents are doing" | (页面未述) |
| CrewAI | sequential (上一件 task 的输出作下一件的 context) / hierarchical (manager 分派并验收) | task `context`; 委托工具调用 | `allow_delegation` 带来的两个工具 | 防委托回环: 专家关掉 delegation |
| Anthropic 研究系统 | orchestrator-worker, lead 同步等一批 subagent 跑完 | subagent 压缩后回给 lead; 大产物写外部存储, 只回轻量引用, 避免 "game of telephone" | 无 (同步执行; 文中点名异步难在 "result coordination, state consistency, and error propagation") | 断点续跑 + 重试; 全链路 tracing; rainbow 部署; 多 agent 约 15× chat 的 token |

### 1.4 三条共识

1. 收口的**内容**走「终句即返回值」(R), 模型不用多做什么; 显式消息 (M) 留给**过程中**的横向沟通。
2. 收口的**状态** (task completed / 交了没有) 一旦要模型显式写, 就会漏。业界的兜法是**轮内拦截** (hook exit 2 / block, 让模型在同一段会话里补上), 而不是事后追问。
3. 大产物不在对话里转述, 写成文件回引用; 广播和共享全上下文按人数线性涨价, 要慎用。

---

## 2. wezard 机制 A: 从终句按规则路由回执 (implicit 群 / wizard 私聊)

### 2.1 实际行为: 一条 tell_peer 的一生

1. **开行**: `tell_peer` 解析 `re` / `return` / `after` / `kind` (`daemon/index.ts:2999-3056`), 新开或复用一行 `<event, owner, receiver>`。同一对 owner/receiver 只保留一个未了结行, 后续派活都并成「补充」(`daemon/index.ts:3129-3131`, `daemon/router.ts:133-134`; 提交时自动 merge `daemon/router.ts:843-855`)。
2. **入队**: 注入事件 `route:<event>:input:<uuid>` 进 durable 事件库 (`daemon/index.ts:3158-3170`)。投递策略 normal / now / urgent 只在对方忙的时候有区别 (`daemon/index.ts:3079-3091`)。
3. **注入与暴露态**: 泵按 pane 互斥注入, 事件的 `exposure` 依次走 none → possible → submitted → consumed (`daemon/message-events.ts:788-853`)。注入结果不确定的永不盲目重投 (`daemon/message-events.ts:820-847`), 而且会钉住同一 pane 上后续的回执和派活 (`daemon/message-events.ts:865-875`)。
4. **终句取证**: 在 transcript 里找到带本事件 `eventId` 信封的 user 行, 它与下一条非排队 user 行之间的**最后一条 assistant 文本**就是终句。为软后端另加了轮终证据判断 (`daemon/index.ts:428-455`)。
5. **判定**: `settleFinal` 按顺序尝试 (`daemon/index.ts:1617-1694`, `daemon/router.ts:448-503`):
   1. 多收件人分段 `.name RESULT:` → 绑定 + 输入覆盖校验;
   2. 未署名的 `RESULT:` → 覆盖校验;
   3. 弱信号兜底;
   4. 都不是 → `router.onFinal` → `finalKind`。

   `finalKind` 的规则: 显式 `RESULT:` / `NEED:` / `PROGRESS:` / `WAIT:` 优先; **没有标记**时, chat 行且无子行算 done, **wizard 行一律算 progress (零投递)**。
6. **投递**: 先落盘、再投递 (`daemon/index.ts:1514-1524`)。
   - wizard 收方: 回执作为 `rcpt:<event>:<rev>` 进收件箱 (durable 事件, 等收方闲时再贴), 入箱之后才 `hand` (`daemon/index.ts:1464-1480`)。
   - chat 收方: `hand` 之后走 mirror 终句通道 (`eventFinalGate` / `finalReleased`) → durable outbox 分片发送 (`daemon/mirror-bridge.ts:3902-3916`, `daemon/message-events.ts:668-725`)。
7. **兜底**:
   - 收方已注销 → 沿链升级, 最终进死信 (`daemon/router.ts:400-422`);
   - 结论迟到 → 记为孤儿, 只有显式 `RESULT:` 才作为追述再投 (`daemon/router.ts:424-431, 505-520`);
   - pane 丢失 → resume 注入 (`daemon/index.ts:2726-2775`);
   - 闲置无回执 → idle-nudge (默认闲 5 分钟问一次, 最多 3 次; `shared/config.ts:112-118`)。

### 2.2 它做对了什么

- **一张账**: receiver 边取代了旧机制分散在三处的状态 (`daemon/router.ts:4-6`)。日志中间行损坏就拒绝启动, 理由是「丢表 = 丢回执」(`daemon/router.ts:722-735`)。
- **至多一次, 可对账**: 只有明确的负 ACK 才算未投, 超时和断线一律算 uncertain (`daemon/message-events.ts:243-246, 719-721`); 需要时用 `POST /message-events/release` 显式对账 (`daemon/message-events.ts:933-952`)。
- **最常见的路径对模型零负担**: 人在 implicit 群问顶层 wizard, 未标记的终句直接作为答复 (`daemon/router.ts:455`)。
- **回执自动回流**: Claude Code 跨会话消息要收方显式回 `SendMessage`, wezard 不需要。这是它真正的差异化优势。

### 2.3 失败模式 (附证据)

| # | 失败模式 | 机制 / 证据 | 现有兜底 | 残余代价 |
|---|---|---|---|---|
| A1 | **终句缺失**: 一轮以工具调用结束, 没有 assistant 文本 | `finished` / `observe` 把事件记成 uncertain 且不重试 (`daemon/message-events.ts:1127-1135, 732-739`), 行留在 open | idle-nudge | 至少 5 分钟静默, 外加一轮 resume |
| A2 | **终句误判 / 取错段**: 软后端的中途叙述被当成终句 (39b6dfd 修过); 只取最后一段文本 (`daemon/index.ts:439-451`), 结论写在中段、末尾只剩一句客套时, 回执就只剩那句客套 (推断, 未实测) | 启发式 `mid` / `soft` / `end` (`daemon/index.ts:441-444`) | 追述 (须显式 RESULT) | 假定论和真结论各占一个 rev |
| A3 | **收口标记解析脆弱**: 正则按行首认 `RESULT:` / `NEED:` / `.name RESULT:` (`daemon/peers.ts:482, 528-529`); 模型照抄示例时带上反引号或加粗就认不出 (e23ee2f.1: 16 分钟追问 3 次仍未落定, `daemon/message-events.ts:271-277`); 修复链 2d223aa / e7fccb2 / 550ed15 / 6b90e26 | 剥行首装饰 (`daemon/peers.ts:504-522`) + 弱信号兜底结算 (`daemon/index.ts:1670-1682`) | 规则面持续膨胀; 弱信号误结的风险靠 `topLevelText` 压住 |
| A4 | **中间层转交静默卡住** (新发现): done 回执的信封写「无需 RESULT:」(`daemon/peers.ts:809`), `up` 时还写「交给上游 wizard」(`daemon/peers.ts:833`); 但 wizard 收方行的未标记终句 = progress、零 op (`daemon/router.ts:454, 500`), 且有回归测试钉死 (`tests/progress-receipt.test.ts:80-82`) | 脚本复现 (§6): `finalKind = progress`, `onFinal = []`; 写成 `.A RESULT:` 才会 `answer` | 5 分钟后 idle-nudge 追问 | 每过一层转交多一轮并重写一次缓存; 多层树逐层叠加 |
| A5 | **重复投递**: 同一结论被两轮各报一次 (edf7056.1: 两份 rcpt 相隔 18s, `daemon/router.ts:511-515`, 现已按正文判重); rev 按内容寻址, 改了措辞就是新 rev | 正文判重; 追述只认显式 RESULT (`daemon/router.ts:516-519`) | 判不出语义重复 (换个说法再交一次仍会投) |
| A6 | **路由歧义**: 一轮吃进多条输入 (now 插话、补充合并 `daemon/message-events.ts:758-787`「请合并处理并统一回复」、回执批), 一句终句就要结多行, 靠分段署名 + `resultRoutes` 绑定 + 输入覆盖解决 (`daemon/message-events.ts:255-268, 397-436`), 对不上就发私密纠正让它重交 (`daemon/message-events.ts:313-345`)。同一对之间两件不相干的活会被并成一件 (`daemon/router.ts:133-134`); 同一对有多笔在飞时, `re` 要求写 event id (`daemon/router.ts:379-387`, `daemon/index.ts:3018-3020`) | 纠正消息 | 纠正本身又是新的一轮; 合并让「任务」粒度变粗 |
| A7 | **活性让位于安全**: uncertain 事件会一直钉住队列, 直到对账 (`daemon/message-events.ts:865-875`); 曾有一条 route 卡了 16 天, 被追问 3171 次 (`daemon/idle-nudge.ts:13`) | 追问上限 max × `MAX_CYCLES` + 上报 (`daemon/idle-nudge.ts:46-52`) | 需要人或管家来对账 |
| A8 | **复杂度本身就是负担**: settle 路径上的分支 (handoffCut / feedbackRoute / transferred / late / retold / QUIET / WAIT) 每多一个, 就要在信封里多教模型一句 | `daemon/index.ts:1570-1694`, `daemon/peers.ts:769-840` | (无) | 信封越长, 模型越容易照抄格式出错 (见 A3) |

---

## 3. wezard 机制 B: 严格模式显式出站 (`chat_say` / `chat_reply`)

### 3.1 实际行为

- **门**: 严格群里, 模型的任何发言都不会自动进群 (`daemon/mirror-bridge.ts:3882-3892`)。终句闸 `eventFinalGate` 直接返回 false (`daemon/index.ts:2701-2702`); chat 收方行的终句零 op (`daemon/router.ts:481-484`), 且 `finalReleased` 为 false (`daemon/router.ts:528-529`)。人只看得到占位气泡和 rolepage。
- **四个出站口子共用一道门**: 成员资格 (非成员 403)、额度 (每轮 3 条 / 每群每分钟 10 条; `daemon/strict-gate.ts:35-40`, `daemon/index.ts:2152-2161`)、topOnly (`daemon/strict-gate.ts:33`, `daemon/index.ts:2189-2190`)。
- **`chat_reply`**:
  - 寻址: 模型抄来的 msg id (`re`) → 义务行 (`daemon/index.ts:2094-2099`) → 目的群 (`daemon/index.ts:2211`)。
  - 自己名下的未结义务、且带 text: 覆盖占位气泡或另发一条, 然后 `answer(done)` + `hand` 销账 (`daemon/index.ts:2238-2251`)。
  - 不带 text: 记 `passed` (`daemon/index.ts:2253-2259`)。
  - 其他情况: 只发言, 不销账 (`daemon/index.ts:2261-2264`)。
  - 幂等: 键为 `chat_reply:<re>:<contentRev>`, 存在内存 Set 里 (`daemon/index.ts:2198-2200, 2230-2235`)。
- **`chat_say`**: 只发言, 从不销账 (`daemon/index.ts:2175-2197`)。
- **兜底链**:
  1. 未结义务上出现 prose 终句 → 当轮注入一次交付指引 (`daemon/index.ts:1591-1613, 1693`);
  2. 闲满 5 分钟 → 专用补发追问 1 次 (`daemon/index.ts:2782-2796`);
  3. 仍未交付 → 直投本群管家; 没有管家时才往群里发一条人话系统行 (`daemon/index.ts:2826-2852`);
  4. 从没答过的义务另走 obligation-watch: 提醒 1 次, 上报 1 次 (`daemon/index.ts:2864-2903`)。
- **账本**: 出站 tracker 在 SDK 发送成功之后才记一行聊天账本 (`daemon/last-response.ts:177-190`); `/owed` 列出本群欠账 (`daemon/index.ts:1999-2010`)。

### 3.2 它换来了什么

- **人只看到刻意发出的话**: CoT、过程、私聊转述都进不了群。0d8fa13 之后, 一条人话可以多次出站 (ack + 进展 + 结论)。
- **「说话」与「销账」解耦**: 派活 ack 不会再误耗掉义务。起因见 CHANGELOG [Unreleased]「入群即发言权」条: daily 群有两笔 done 的结论因此没进群。
- **治理**: 成员制带来权限边界和频控; 账本记的是实际发出的内容, 可以审计。

### 3.3 失败模式 (附证据)

| # | 失败模式 | 机制 / 证据 | 现有兜底 | 残余代价 |
|---|---|---|---|---|
| B1 | **终句丢失 (结构性)**: 模型的惯性通道被设计成丢弃 | 现场: 2026-11-16 sanitizer 群 e4622be.1 / e690042 / e172afa 三次「生成了答复, 只写成 prose 终句」(CHANGELOG [Unreleased] 两条); strict 上线前启动的会话, 工具表里根本没有 `chat_reply`, 空转追问了数小时 (同节, c1f8557) | 宪章 (`daemon/wizard.ts:996-1004`) + 当轮提醒 + 补发追问 + 管家上报 | 每次至少多一轮; 当轮提醒注入失败时只记一行日志 (`daemon/index.ts:1610-1612`) |
| B2 | **回执信封与严格模式互相打架** (新发现): 顶层 wizard 收到子 wizard 的回执, 信封写「终句用自己的话交代 … 无需 RESULT:」和「投给群里的人」, 还写「回执轮用 notify 正式报告」(`daemon/peers.ts:808-835`), 全程不提 `chat_reply`; 回执调用点不传 strict (`daemon/index.ts:1450-1463`); strict 的 chatlog 提醒只挂在人话和 chat_ask 上 (`daemon/index.ts:574, 2302`) | 脚本复现 (§6): 渲染结果 `mentions chat_reply: false`, 且含「投给群里的」 | 只有宪章 (远在上下文开头) | 回执轮几乎必然踩中 B1, 而「管家派活 → 收回执 → 向人收口」正是严格群的主路径 |
| B3 | **义务不销账**: 只有「`chat_reply` + 正确的 `re` + owner 是自己」才销账, `chat_say` / `notify` / `send_file` 永远不销 (`daemon/strict-gate.ts:3-8`); `re` 抄错或抄成别条 → 只发言、不销账 (`daemon/index.ts:2261-2264`)。历史上的死账: 义务 transfer 给非成员 (已修, `daemon/index.ts:2957-2962`); 下层轮 + topOnly (已修 cf3e0b3, `daemon/index.ts:2221-2227`) | 提醒 → 重发 | 重发又引出 B4 |
| B4 | **重复投递**: `chat_say` 没有幂等; `chat_reply` 的幂等只认同 re 同文、只在内存、reload 即清空 (`daemon/index.ts:2198-2200`)。现场: 2026-11-16 17:44, .sanitizer 在 40 秒内依次 notify → chat_reply → chat_say×3 → notify → chat_reply, 之后 send_file 又补一条 chat_reply, 群里出现两颗几乎一样的气泡 (CHANGELOG [Unreleased]) | 宪章「一次到位 / 不许轮换试探通道」(`daemon/wizard.ts:1003-1004`) | 全靠模型自律 |
| B5 | **静默丢失 (可靠性倒挂)**: `postAs` → `notifyChat` 是 `void sendMessage().catch(warn)` (`daemon/index.ts:963-968, 999`); `chat_say` 在真正发送之前就回 ok (`daemon/index.ts:2194-2196`); `chat_reply` 不管发没发成都 `answer+hand` 销账 (`daemon/index.ts:2244-2251`), 而且幂等键在发送**之前**就登记 (`daemon/index.ts:2233-2234`), 第一次没发出去, 同文重试反而吃 409 | SDK 层最多等 30s 重连 (`daemon/last-response.ts:166-176`) | 义务已结、群里没有, 只剩一行 warn。对比: implicit 终句走 durable outbox (`daemon/message-events.ts:668-725`) |
| B6 | **误投**: 目的群由 `re` 决定 (`daemon/index.ts:2211`); 抄到另一个严格群里的 msg, 恰好又是那个群的成员, 消息就进了那个群 | 成员门 | 跨群泄露 (低频) |
| B7 | **额度与门的副作用**: 额度「通过即记账 (发不发出去了也记)」(`daemon/index.ts:2102`), 计量只在内存 (`daemon/strict-gate.ts:50-69`); 长结论拆成多条可能撞上每轮 3 条的上限 | 409 时给出理由 | 鼓励一条讲完, 但长内容只能走 send_file |
| B8 | **模型负担**: 要知道本群是 strict; 要先经 ToolSearch 取 deferred schema (CLAUDE.md: Claude Code defers MCP tool schemas behind ToolSearch); 要抄对 `re`; 要在 4 个口子里选对; 还要守额度和礼仪 (宪章 strict 节 9 条) | (无) | 每一步都是一个失败点; 宪章随事故不断变长 (1fef6eb / d54f3cb / 0d8fa13 …) |

---

## 4. 对比与取舍

### 4.1 维度对照

| 维度 | Claude Code subagent | Claude Code teams / 跨会话 | OpenAI SDK / LangGraph | wezard 终句路由 | wezard 严格显式出站 |
|---|---|---|---|---|---|
| 结果通道 | 终句 = 工具结果 / 完成通知 | idle 通知带终答 + 显式 SendMessage | 工具返回 / handoff 接管 / state | 终句 → 路由账 → 收件箱或群 | 只认 `chat_reply` |
| 投递耐久 | 进程内 (transcript 持久, 可 resume) | 文件信箱; "no in-process teammate resumption" (第三方资料) | 进程内; LangGraph / MAF 有 checkpoint | **最强**: journal + 事件库 + outbox + 对账 | **弱于 implicit**: fire-and-forget, 幂等只在内存 |
| 重复 | 不会 (只返回一次) | 短时同文重复会被丢弃 (跨会话) | 不会 | 按内容 rev 判重, 不确定的不重投 | 内存幂等; chat_say 没有 |
| 完成判定 | 子 agent 停下即完成 | 停下就通知; 但 task 完成要显式写, 会滞后 | run 结束即完成 | 正则标记 + transcript 推断 | 显式工具调用 |
| 漏交的兜底 | 不需要 (结构上不会漏) | hook exit 2, 轮内拦截 | 代码编排 | 闲置 5 分钟后追问 | 当轮提醒 + 追问 + 上报 |
| 可观测 | 子 transcript 单独成文件 | team config / tasks 目录 | tracing | `GET /routes`、事件 status (holds / blockedBy)、rolepage、pending_items | 聊天账本、`/owed`、rolepage 治理面板; 出站没有投递态 |
| 模型负担 | 最低 | 中 (要记得发、记得回、记得标完成) | 低到中 | 顶层低; 中间层中 (要写 `.X RESULT:`) | 高 (工具 + re + 选口子 + 额度) |
| 扩展 | 深度 3, 并发 20 | 建议 3-5 人; 不可嵌套 | as_tool 可嵌套 | 任意深度的树, 有升级 / 死信, 可跨群 | 成员制 + 频控, 按群开 |

### 4.2 判断

1. **「终句即返回值」赢在它是模型总会走的那条路**: 不用记、不用选、不会漏。wezard 的 implicit 路径继承了这一点, 投递上还比所有被调研系统都更耐久。它的成本集中在「从自然语言里认出语义」(A2 / A3 / A4 / A6)。
2. **严格模式在面向人的通道上反了业界默认**, 所以「答了没交付」不是偶发 bug, 而是可以预见的主失败模式。Claude Code 自己文档里那句 "teammates sometimes fail to mark tasks as completed" 就是同一现象。差别在于 Claude Code 用 hook 在**轮内**拦住, wezard 在**轮后**追问 (至少多一轮, 常常要等 5 分钟以上)。
3. **显式不等于可靠**: 严格出站绕开了 implicit 那套 durable outbox, 可控性上去了, 投递可靠性却下来了 (B5)。门 (谁能说、能说什么) 和通道 (怎么投、投没投成) 是两件事, 两条路的通道可靠性应当对齐。
4. **显式发送真正该用在**: 中途进展、ack、一次答复多个对象、刻意的公开发言、成员治理。这些 `chat_say` / `tell_peer` 已经覆盖, 应当保留。
5. **合成方向**: 终句当草稿 (先暂存, 不丢); 门由 daemon 判 (成员 / topOnly / 额度 / 是否在服务一条义务); 交付三选一: 模型显式确认、轮内 hook 拦一次、或在配置允许时由 daemon 兜底发出。

---

## 5. 改进建议 (按优先级)

### P0: 修契约与可靠性 (成本低, 可以直接动手)

| # | 改动 | 落点 | 解决 | 成本 |
|---|---|---|---|---|
| P0-1 | **回执信封按实际去向说真话**。两种做法任选其一: (a) `up` 时信封改写「交上游须行首 `.上游 RESULT:`」; (b) 改 router: 回执轮服务的是 wizard 行、且没有在飞子行时, 未标记终句按 result 收 (「好的我开始了」的顾虑在回执轮不成立, 活已经干完了)。另外, strict 群的 chat 回执信封改写「终句不进群, 用 `chat_reply({re})` 交付」, 并附上 re | `daemon/peers.ts:798-840` 加 `strict` / `re` 参数; `daemon/index.ts:1450-1463` 传入; 补回归测试 | A4、B2 (即 B1 在回执轮的诱因) | 低 |
| P0-2 | **严格出站走同一个 durable outbox, 投成之后再销账**。`chat_reply` / `chat_say` / `notify` 统一经 `events.delivery()` 投递 (id = `finalId(re, channel, rev)`, 已经带 coverage 和分片态); `hand` 等投递 durable 入队 (或拿到 ACK) 之后再落; 幂等改为读路由账 (`hand.inbox` 里已经存了 idem, `daemon/index.ts:2249`), 不再用内存 Set; 回包像 notify 一样返回 `states` (`daemon/index.ts:1968-1992`) | `daemon/index.ts:2175-2265`, `daemon/message-events.ts:668-725` | B4、B5 | 低到中 |
| P0-3 | **`re` 自动推断, 外加同群校验**。没给 `re` 就按本轮服务的那一笔 (`servesOfTurn`, `daemon/index.ts:1274`) 定; 自己名下有多笔未结时才 400 并列出来 (同 `pickPair`); `re` 指向的群和本轮所在群不一致时, 要求显式传 `chat` | `daemon/index.ts:2201-2215` | B3、B6、B8 | 低 |

### P1: 结构改进 (成本中等)

| # | 改动 | 落点 | 解决 | 备注 |
|---|---|---|---|---|
| P1-1 | **Stop hook 做轮内收口门**。和 PreToolUse 一起注入 `Stop` hook (`shared/session-hooks.ts:36`); hook 把 `last_assistant_message` 与 `stop_hook_active` POST 给 daemon, daemon 判三种情况: (1) 严格义务未交付 → `decision:"block"`, reason 写「用 chat_reply({re:…}) 发出 / 无需答复就记 passed」; (2) wizard 行缺收口 → reason 写「行首 `.X RESULT:` / `NEED:` / `WAIT:`」; (3) 合格 → 放行。同时以 `last_assistant_message` 作为权威终句文本, transcript 只当旁证 | `shared/session-hooks.ts`、新增 `POST /turn/stop`、`daemon/index.ts` 的 settle 链 | B1, 以及 A1 / A2 / A3 / A4 的大部分 | **好处**: 在轮内修正, 不新开一轮、不等 5 分钟、缓存还是热的。**防死循环**: `stop_hook_active` + Claude 自带的连续 8 次上限。**失败处理**: daemon 不可达时一律放行 (CLAUDE.md: errors never break the workflow)。**后端覆盖**: claude-internal 走 plugin 目录同样能挂; codex 目前只注入 SessionStart / PreToolUse / PermissionRequest (`shared/codex-hooks.ts:188-189`), 保留现有追问路径。需按 CLI 版本探测是否有 `last_assistant_message` |
| P1-2 | **严格群的「终句兜底」做成可配置**: `chatPolicy.<chat>.finalFallback` 取 `"remind"` (现状) / `"draft"` / `"deliver"`。**draft**: 终句存成待发草稿, 提醒里让模型调 `chat_reply({re, useDraft:true})` 一键发原文。**deliver**: 服务义务的那一轮以 prose 收尾、且本轮没有任何出站时, daemon 过同一道门后经 outbox 发出并销账 (只放这句终句; CoT、流式和中间文本照拦) | `daemon/router.ts:481-484` 的 strict 分支、`daemon/index.ts:1617-1694` | 根治 B1 | **需要人拍板**: deliver 等于部分撤回「终句不是交付」; 建议先在一个群开 draft |
| P1-3 | **可选的结构化收口工具** `finish({to?, status, text})`: 多收件人、NEED、WAIT 这几种情况用工具, 不用文本标记。单收件人仍默认终句即返回值, 不强制用工具, 否则就等于自己造出 teams 的 task status lag | `mcp/tools.ts`、`settleFinal` | A3、A6 | 标记解析保留, 保持兼容 |
| P1-4 | **统一可观测词表**。两条路共用一套投递态 (pending / sending / waiting-ack / delivered / uncertain / failed), 进 `/owed`、`pending_items` 和 rolepage; 严格义务分成「未答 / 已答未交付 (草稿) / 已交付 (delivered 或 uncertain)」三档; 另加计数: 每条 route 的静默时长、追问次数、纠正次数, 用来量化「模型负担」 | `shared/turn-state.ts`、`owedOfBase` | 可观测性 | 同时可作 P1-1 / P1-2 的 A/B 依据 |

### P2: 借鉴与收缩

- **P2-1 plan 完成门** (借 `TaskCompleted` exit 2): `plan_update` 把节点置为 completed 时, 可以先跑 owner 写的验收条件, 不满足就拒绝并说明理由。这是前作 G2 的落点换成了 plan。
- **P2-2 wizard 之间的回环节流** (借跨会话消息): 同一对之间短时间内的同文重复直接丢弃并告知发方; 长时间往返暂停并上报。现状只有 legs>3 时的一句提示 (`daemon/peers.ts:788-789`), 而且是故意不拒绝。可以先只做「同文去重」。
- **P2-3 大产物走引用** (借 Anthropic 的 "game of telephone"): 回执正文超过阈值时, 提示改写成文件 + `ARTIFACT:`, 回执只带路径和一句话。
- **P2-4 规则面收缩**: P1-1 落地并稳定之后, 弱信号兜底结算、行首装饰剥离和部分纠正回路可以只留给 codex。

### 不建议

- **不要把 wizard 之间改成「回复必须显式 SendMessage」**(Claude Code 跨会话 / teams 的做法)。自动回执是 wezard 真正的优势, 改掉等于把 B1 引进私聊。
- **不要引入共享全上下文广播** (AutoGen 群聊式): token 随人数线性涨, 而且破坏「默认私聊」。
- **不要在 daemon 的判定链里加 LLM 分类器**来判「这句是不是结论」: 延迟和不确定性都会进账本。应当用 hook + 结构化信号。

---

## 6. 验证记录 (脚本只读仓库代码, 不改任何文件)

**A4 / P0-1: 中间层转交。** 人在 chat 问 A → A 派给 B → B 派给 C → C 用 `RESULT` 落定, B 收到 done 回执:

```ts
import { EMPTY, step, ops, onFinal, finalKind, type Table } from "./daemon/router.ts";
import { renderReceiptEnvelope } from "./daemon/peers.ts";
const D = Number.MAX_SAFE_INTEGER;
let t: Table = EMPTY;
t = step(t, ops.open({ event: "eaaaaaa", owner: "A", receiver: { kind: "chat", channel: "chat:x", message: "m1" }, deadlineAt: D, at: 1 }));
t = step(t, ops.open({ event: "eaaaaaa.1", owner: "B", receiver: { kind: "wizard", to: "A", event: "eaaaaaa" }, deadlineAt: D, at: 2 }));
t = step(t, ops.open({ event: "eaaaaaa.1.1", owner: "C", receiver: { kind: "wizard", to: "B", event: "eaaaaaa.1" }, deadlineAt: D, at: 3 }));
onFinal(t, "C", "eaaaaaa.1.1", { text: ".B RESULT: 查到了 X", result: true, source: { input: "in-c" } }).forEach((op) => { t = step(t, op); });
renderReceiptEnvelope(".C", undefined, "done", "eaaaaaa.1.1", { up: true });   // 含「无需 RESULT」与「交给上游 wizard」
finalKind(t, "eaaaaaa.1", "C 查到了 X, 我核对过, 结论是 X 成立。");              // → "progress"
onFinal(t, "B", "eaaaaaa.1", { text: "C 查到了 X …", source: { input: "in-b" } });  // → []  (A 收不到)
```

实测输出:

```text
C row status: answered
envelope says no RESULT needed: true | says hand upstream: true
finalKind(B unmarked): progress
onFinal ops (B unmarked): []
onFinal ops (B with RESULT): [ 'answer' ]
```

**B2 / P0-1: 严格群顶层收回执。** `renderReceiptEnvelope(".C", "daily", "done", "eaaaaaa.1", {}, "chat:wrX")` 的渲染结果含「无需 RESULT:」「回执轮用 notify 正式报告须显式写 RESULT:」「投给群里的人。」, 不含 `chat_reply`。实测输出:

```text
mentions chat_reply: false | says '投给群里的': true | says 无需 RESULT: true
```

---

## 7. 来源

**外部** (2026-11-20 抓取):

- Claude Code
  - agent teams: <https://code.claude.com/docs/en/agent-teams>
  - subagents: <https://code.claude.com/docs/en/sub-agents>
  - Agent SDK subagents: <https://code.claude.com/docs/en/agent-sdk/subagents>
  - 跨会话消息: <https://code.claude.com/docs/en/cross-session-messaging>
  - agent view: <https://code.claude.com/docs/en/agent-view>
  - hooks reference (Stop / SubagentStop / TeammateIdle / TaskCompleted): <https://code.claude.com/docs/en/hooks>
  - 第三方逆向 (基于 v2.1.47, 随版本可能变化, 仅作旁证, 用于信箱格式与消息类型): <https://dev.to/nwyin/reverse-engineering-claude-code-agent-teams-architecture-and-protocol-o49>
- OpenAI
  - Codex subagents: <https://developers.openai.com/codex/subagents> (308 重定向到 <https://learn.chatgpt.com/docs/agent-configuration/subagents>)。工具名 `spawn_agent` / `send_input` / `wait` / `close_agent` 来自第三方 (搜索摘要, 未逐页核对): <https://hexdocs.pm/codex_sdk/10-subagents.html>
  - Agents SDK: <https://openai.github.io/openai-agents-python/multi_agent/> · <https://openai.github.io/openai-agents-python/handoffs/> · <https://developers.openai.com/api/docs/guides/agents/orchestration>
- Microsoft
  - AutoGen: <https://microsoft.github.io/autogen/stable/user-guide/agentchat-user-guide/tutorial/teams.html> · <https://microsoft.github.io/autogen/stable/user-guide/agentchat-user-guide/swarm.html> · <https://microsoft.github.io/autogen/stable/user-guide/core-user-guide/framework/message-and-communication.html>
  - Agent Framework: <https://learn.microsoft.com/en-us/agent-framework/workflows/> · <https://learn.microsoft.com/en-us/agent-framework/workflows/checkpoints> · <https://learn.microsoft.com/en-us/agent-framework/workflows/human-in-the-loop>
- 其他
  - LangChain / LangGraph: <https://docs.langchain.com/oss/python/langchain/multi-agent> (另读了 `/handoffs` 与 `/subagents` 子页)
  - Google ADK: <https://adk.dev/workflows/collaboration/> (旧址 google.github.io/adk-docs/agents/multi-agents/ 已重定向)
  - CrewAI: <https://docs.crewai.com/en/concepts/collaboration> · <https://docs.crewai.com/en/concepts/processes>
  - Anthropic: <https://www.anthropic.com/engineering/multi-agent-research-system>

**内部**:

- 代码 (HEAD `cf3e0b3`): `daemon/router.ts`、`daemon/message-events.ts`、`daemon/index.ts`、`daemon/peers.ts`、`daemon/strict-gate.ts`、`daemon/mirror-bridge.ts`、`daemon/last-response.ts`、`daemon/idle-nudge.ts`、`daemon/wizard.ts`、`shared/turn-state.ts`、`shared/session-hooks.ts`、`shared/codex-hooks.ts`、`shared/config.ts`
- 测试: `tests/progress-receipt.test.ts:80-82`
- 现场记录: `CHANGELOG.md` [Unreleased] 中的 strict 各条 (sanitizer / aiconfig / daily 群)
- 前作: `docs/evolve/research/a2a-frameworks.md`
