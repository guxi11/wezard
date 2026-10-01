# A2A 与主流多 agent 框架 → wezard 可迁移的经验

> 调研人 `.ev-proto` · 2026-10-02 · 范围: Google A2A 1.0、MCP 2025-11-25 (tasks / elicitation / sampling)、OpenAI Agents SDK、LangGraph、AutoGen/AG2 → Microsoft Agent Framework、CrewAI。
> 写法: 每一项只写「它的概念 ↔ wezard 现有机制 (文件 / 工具) ↔ 差距 ↔ 迁移建议 (收益 / 成本)」, 末尾单列「不该学」。

## 0. 结论先行

1. **wezard 缺的是一个「轮次即任务」的名词, 不缺通路。** A2A 的 `Task` 和 MCP 的 `tasks` 都把「一次委托」做成一个有 id、有状态机、可查可撤的东西。wezard 的同类信息散落在五个地方: `receipts.ts` 的 Slot (在等谁)、`jobs.ts` 的 JobMember (属于哪个工单)、`peers.paneIsBusy` (在不在干)、`peers.openToolUses` (卡没卡在审批上)、wait_peer 的 `stale` (停了但没答)。把它们**派生** (不新增存储) 成一个统一的状态枚举, 是收益最大、成本最低的一步。
2. **wezard 的异步回执已经就是 A2A 的 push notification + MCP 的 `model-immediate-response`。** 形状一致, 不用改通路, 只差把「状态」和「产物」写进信封。
3. **wezard 缺一个「反问」状态 (`input-required`)。** A2A、MCP tasks、LangGraph `interrupt`、MAF `request_info`、CrewAI `@human_feedback` 都有; wezard 只对**人**有 (审批卡 / AskUserQuestion 投票卡), 对**派活的 wizard** 没有 —— 分身有疑问只能把问题当 RESULT 交回去, 发起者分不清「答完了」还是「问回来了」。
4. **graph.ts 是唯一与主流方向背离的部件**: LangGraph / MAF / CrewAI Flows 的图都可 checkpoint, wezard 的 run 只在内存里。建议不是给它补持久化, 而是把它降成「job + 模板」的语法糖, 控制流回到 wizard (与 `jobs.ts` 头注释的取舍一致)。
5. **协议层 (JSON-RPC/gRPC、well-known 发现、security schemes、多租户、SSE) 一概不学** —— wezard 是单机单用户、tmux 为执行体、IM 为人机界面, 这些都是跨组织、跨网络才付得起的成本。

---

## 1. Google A2A (Agent2Agent) 1.0

A2A 定位是「不透明 agent 之间」的互操作协议 (Linux Foundation 托管; 1.0 起 RPC 改名为 `SendMessage` / `SendStreamingMessage` / `GetTask` / `ListTasks` / `CancelTask` / `SubscribeToTask`, 0.3 时代是 `message/send`、`tasks/resubscribe`)。核心名词: **AgentCard → Message(Parts) → Task(status, artifacts, history) ↔ contextId**。

### 1.1 概念对照

| A2A 概念 | 含义 | wezard 现有机制 | 差距 |
|---|---|---|---|
| **AgentCard** (`/.well-known/a2a`, `skills[]`, `capabilities{streaming,pushNotifications}`) | agent 的自我描述, 供发现与路由 | `wizard.ts` 身份 (name + 一句话 description + memory + parent); `wizard_roster` 文本名册; `route_candidates` (`daemon/route.ts`) 按职责/读过的文件/ctx 排候选 | 只有一句话职责, 没有结构化 skills; 但 route_candidates 用「读过的文件 + 最近问话」作证据, **比静态 skills 更真实** |
| **Task.id** (服务端生成) | 一次委托的身份 | 无。回执靠 `peers.replyToPeer` **按信封定位**那一句问话 | 无法引用「上次那件活」, 无法对一件活 cancel / get |
| **TaskState**: submitted / working / input-required / auth-required / completed / failed / canceled / rejected | 显式状态机, 中断态可恢复 | 隐式: `when:"idle"` 排队≈submitted; `paneIsBusy`≈working; `openToolUses` 非空≈卡在审批 (auth-required 的近亲); RESULT 回执≈completed; `stop_wizard(interrupt)`≈canceled; wait_peer `stale`≈「停了没答」 | 状态存在但**没有名字**, 模型要自己拼; 没有 input-required / rejected |
| **contextId** | 把多个 task 归到一个会话 | `TurnDetailRecord.channel` (`""`=私聊, 否则公开群 base); job id | channel 是「回复去哪」, 不是「属于哪段对话」; 多次往返的私聊没有线程概念 |
| **referenceTaskIds** | 「基于 task X 再改改」 | 无; 只能在文本里描述 | 续问只能靠对方上下文里还记得 |
| **Message.parts** (text / file / data) | 多模态内容 | 纯文本 paste; 图片走 `message.image` (人→wizard) | wizard↔wizard 只有文本, 文件靠路径 |
| **Artifact** (id, parts, 增量 append) | 任务产物, 与对话消息分离 | 约定「交付物写进文件就回传路径」+ `RESULT:` 行 | 产物没有结构, 收工气泡列不出「交了哪些文件」 |
| **Streaming** (`TaskStatusUpdateEvent` / `TaskArtifactUpdateEvent`) | 过程推送 | `notices.ts` (名册变动随下一次注入搭车); rolepage 实时看 | 发起者看不到分身的中间进度 (需要就 peek_peer), 这是**故意的** |
| **Push notification** (webhook) | 断连后的完成通知 | `receipts.ts`: 对方停下 → 取答句 → 等发起者空 → paste; 落盘、boot 续守 | **已等价, 而且更好** (投递时机避开发起者正忙) |

### 1.2 迁移建议

| # | 建议 | 落点 | 收益 | 成本 |
|---|---|---|---|---|
| A1 | **派生 `TurnState`**: `queued \| working \| blocked(审批卡/AskUserQuestion) \| needs-input \| done \| failed \| canceled \| lost`, 由 receipts Slot + paneIsBusy + openToolUses + 收口行**纯函数**算出, 不落新存储 | 新 `shared/turn-state.ts`; `wizard_roster` / `peek_peer` / `list_jobs` / 回执信封都输出它 | 模型不再拼五个字段; 人在 rolepage 一眼看出卡在哪; list_jobs 能写「3 done · 1 blocked(审批) · 1 working」 | 低: 都是现成判定 |
| A2 | **每次 tell_peer 一个 turn id** 写进信封 (`<system-reminder wezard=envelope … turn=…>`), 回执带 `re=` | `shared/reminder.ts` 已用 opening-tag 属性承载事实, 加一个属性即可; `replyToPeer` 先按 id 定位、老信封回退现状 | 回执定位从「按信封猜」变成按 id; 为 A3/A4 提供把手 | 低 |
| A3 | **`tell_peer({re: turnId})`** = referenceTaskIds: 续问时信封写明「这是对 turn X 的追问」 | `mcp/server.ts` TELL_SCHEMA + 信封渲染 | 被问方 (尤其被 handoff 过的) 知道接哪件事 | 低 |
| A4 | **产物约定**: 收口允许多行 `ARTIFACT: <path> — 一句话`, 回执信封与 close_job 气泡把它们列出来 | `receipts.ts` 提取 + `jobs.ts` 收工渲染 | 收工气泡能挂文件; 发起者汇总时不必从正文找路径 | 低 |
| A5 | AgentCard 的 `skills` **不学成静态表**; 若要结构化, 只给 description 加可选 `tags[]` 供 route_candidates 做精确匹配 | `wizard_identity` | 小 | 低; 不做也行 |

---

## 2. MCP 自身: tasks / elicitation / sampling (2025-11-25)

wezard 的 MCP server (`mcp/server.ts`) 是 stdio、无状态、全部 POST 给守护进程。MCP 新版的三个特性恰好对应 wezard 三条已有通路。

### 2.1 tasks (experimental)

| MCP tasks 概念 | wezard 现有 | 差距 / 判断 |
|---|---|---|
| **requestor-driven**: 请求加 `task:{ttl}` → 立即回 `CreateTaskResult`; `_meta["io.modelcontextprotocol/model-immediate-response"]` 让模型先拿到一句话继续干活 | `tell_peer` 立刻返回 + 「对方干完结论会作为新的一轮送来」 | **形状完全一致**, 印证 wezard 方向正确 |
| `tasks/get` 轮询 + `pollInterval` | `peek_peer` | wezard 用回执代替轮询, 更省 token; 不学轮询 |
| `tasks/result` 阻塞到终态 | `wait_peer` | 一致; wezard 已标 deprecated、只留「同一轮必须拿到」用途, 正确 |
| `tasks/cancel` (终态不可再 cancel; 一旦 cancelled 永远 cancelled) | `stop_wizard(mode:interrupt)` 打断整个 pane 的当前轮 | 差距: 打断的是**人**不是**那件活** —— 若它此刻在干别人派的活会误伤。有了 A2 的 turn id 后可做 `cancel(turn)`: 只在它正处理该 turn 时打断, 否则从 receipts/`when:idle` 队列撤掉 |
| `ttl` (过期即可删) | `receipts.ts` `TARGET_WAIT_SEC=3600`、`MAX_FRUITLESS=3` 写死 | 建议 `tell_peer({ttl})`: 长活 (调研/重构) 可设 4h, 不再被 1h 截断而丢回执 |
| `tasks/list` | `list_jobs` (只列工单) | 有 A1 后, list_jobs 不带参数时也列「我发出、未收口的零散 turn」 |
| `notifications/tasks/status` (可选, 不可依赖) | notices.ts 搭车提示 | 理念相同: **通知是提示, 真相要查** (CLAUDE.md 原话) |

### 2.2 elicitation

| 概念 | wezard 现有 | 差距 → 建议 |
|---|---|---|
| server 向**人**要结构化输入, schema 限扁平原语 (string/number/boolean/enum/多选 enum) | `approval.ts` 的 AskUserQuestion 投票卡分支 (`handleAskUserQuestion`); 审批卡 | 能力已具备, 但只由 CLI 内置工具触发; wizard 不能主动发一张**自定义**选项卡给人 |
| 三态回应 **accept / decline / cancel** (cancel = 关窗/超时, 与「明确拒绝」区分) | 审批: allow / allow_window / deny + 超时回落 `fallbackOnError=ask` | 建议把「超时」显式回成 `cancel` 而不是混进 deny/ask, 模型据此决定「再问」还是「换方案」 |
| form 模式**禁止**收密码/密钥; 敏感走 url 模式 | `redact.ts` 只做展示脱敏 | 在 wizard→人提问原语的描述里写同样的禁令即可 |
| URL 模式 + `notifications/elicitation/complete` | 无 | 不学 (见 §7); rolepage 链接已覆盖「去网页看」 |

**建议 E1: wizard 对 wizard 的 elicitation = `needs-input` 收口。** 分身在私聊轮末尾写 `NEED: <问题>` (而非 `RESULT:`), 回执信封标 `kind=needs-input`; 发起者用 `tell_peer({re})` 答, 该 turn 回到 working, 工单计数不前进。落点: `receipts.ts` 收口识别 + 信封模板 + `jobs.ts` 计数。收益: fan-out 里一个分身卡在歧义上不再被当成「交了」; 成本: 低。

### 2.3 sampling

server 反向请求 client 的 LLM 补全。wezard 的 daemon 侧需要 LLM 判断时, 现在的做法是**起一个临时无群 wizard** (`memory-steward.ts` 合并记忆; `schedule_task` 默认 fresh 白板 wizard 跑完即收)。这就是 sampling 的 wezard 版, 而且带完整工具与审批。建议只做**命名统一**: 文档与 charter 把「临时 fresh wizard」作为一个原语 (`ephemeral`), 不要再引入真正的 sampling 通道。

---

## 3. OpenAI Agents SDK

| 概念 | 含义 | wezard 现有 | 差距 → 建议 |
|---|---|---|---|
| **handoff** (`transfer_to_<agent>` 工具, 控制权 + 全部历史转给另一 agent, 同一 run 内) | 「这件事你来接」 | 名字撞了: wezard 的 `handoff` / `wizard_handoff_self` (`daemon/handoff.ts`) 是**同一 wizard 换新会话**; 「把人的这一轮转给别人」只有 `tell_peer({public:true})` 近似 | **H1 转接**: 在 `tell_peer({public:true})` 描述里明说「这是把人的问题转接给它: 你不再答, 它的回复直接进群」, 必要时加 `transfer:true` 让 daemon 把该 channel 的下一句人话也路由给它。成本低。不建议改 handoff 的名字 (地址即名字, 改名破坏习惯) |
| **input_filter** (`HandoffInputData` 裁剪历史给下家) | 控制下家看到什么 | `clone_wizard` 用 `--fork-session` **全量** fork, 不能裁剪; `spawn_wizard` 零上下文 | 两端之间缺「过滤后的上下文」。**H2**: 不在 fork 上做裁剪 (jsonl 手术风险高), 而是用 `spawn_wizard({task: brief})` + handoff_self 那套「简报」写法作为 filtered handoff, 在 spawn 描述里点明。成本: 只改描述 |
| **nest_handoff_history** (把前序历史压成摘要) | 控制上下文膨胀 | `wizard_handoff_self` 简报 | 已有, 且更彻底 (新进程) |
| **agents-as-tools** (`Agent.as_tool`, 不交出对话, 结构化入参) | 委托子任务拿结果 | `tell_peer` + 回执 (异步) / `wait_peer` (同步) | 一致 |
| **guardrails**: input / output / **tool** guardrail, tripwire 立即中止 run | 并行的策略检查 | `approval.ts` PreToolUse 卡 = 人工 tool guardrail; `danger.ts` 危险命令; `session-cache.ts` allow_window; `redact.ts` | 只有「人」一级。**G1 策略链**: 规则 (danger/allow 列表) → 可选 LLM 判 (临时 wizard / haiku) → 人卡, tripwire=deny 并在回执里写原因。收益: 减少无聊审批卡; 成本: 中 (LLM 判的延迟与误放行要设计), 优先级 P2 |
| output guardrail (校验最终输出) | — | 无 | **G2**: 工单可选 `accept` 条件 (正则/「必须有 ARTIFACT」), 回执不满足则自动 `tell_peer({re})` 打回一次。成本低, 防「分身交了个空 RESULT」 |
| **sessions** / **tracing** | 会话存储 / 可视化追踪 | jsonl transcript / rolepage + `read_chat` | 已有; rolepage 是 wezard 的 trace UI |

---

## 4. LangGraph

| 概念 | wezard 现有 | 差距 → 建议 |
|---|---|---|
| **StateGraph** (节点 + 条件边 + 共享 state + reducer) | `daemon/graph.ts` `run_agent_graph`: `nodes` + 有序 `steps` × `rounds`, `until` 子串收敛, `{{last}}` / `{{tag}}` 模板 | 无条件边、无共享 state; 且是**静态声明**, 而 wezard 真实的编排是「读完才知道分几路」(jobs.ts 头注释) |
| **checkpointer + thread_id** (每步落盘, 可恢复) | receipts / handoff / jobs 都落盘 (`json-map-store`); transcript 本身是天然 checkpoint | **graph run 只在内存**, reload 即丢 —— 而这个仓库里 wizard 常以 `build + reload` 收尾 |
| **interrupt() / Command(resume=…)** | PreToolUse 长轮询停在 `pending.ts`, 卡片点击 = resume | 一致; 且 wezard 不需要 LangGraph 的「节点从头重放、副作用须幂等」—— tmux 里的 CLI 进程一直活着, 恢复点就是那次 tool call |
| 并行 interrupt 用 id → 值的映射恢复 | 每张卡一个 pending id | 一致 |
| **time travel** (从任一 checkpoint 分叉) | `clone_wizard` 只能从「此刻」fork | **L2 (P2)**: `clone_wizard({at: turnId})` —— 复制 jsonl 截到某轮再 `--resume --fork-session`。适合「回到读完材料、还没走偏的那一刻」。需验证 CLI 对截断 jsonl 的容忍度 |
| **Send API** (动态 map-reduce) | job fan-out (`open_job` + N × `clone_wizard({task, job})` + 回执计数) | 一致, 且 wezard 的计数由 daemon 做 |

**L1 建议: graph 降格。** 不给 graph.ts 补 checkpoint (那是在 daemon 里再养一个状态机), 而是把 `run_agent_graph` 改写为调用方 wizard 能自己展开的东西: 描述里给出「review 循环 = tell_peer → 回执 → tell_peer」的写法, `rounds`/`until` 变成 job 的**预算**字段 (见 §5 M2)。收益: 少一个 reload 即丢的部件、少一套与 receipts 平行的 waitForIdle 驱动; 成本: 中 (已有用户习惯要迁)。

---

## 5. AutoGen / AG2 → Microsoft Agent Framework (MAF)

AutoGen 与 Semantic Kernel 已进维护期, 新特性只进 MAF (Team → Workflow, `ctx.request_info()` + `@response_handler` 做 HITL, workflow 可 checkpoint 跨进程恢复)。AG2 (社区分叉) 保留 GroupChat / Swarm。

| 概念 | wezard 现有 | 差距 → 建议 |
|---|---|---|
| **GroupChat + speaker selection** (round-robin / LLM selector / 状态机转移) | 群里人用 `.name` 点名; 管家 wizard 用 `route_candidates` 选人 | wezard 的「选人」是**证据表 + 模型判断**, 不出分数 —— 比 selector LLM 更可解释; 不学 round-robin |
| **Swarm handoff + context_variables** (共享黑板) | 无工单级共享变量; 共享只有 chat/workspace memory (长期, 经 memory-steward 合并) | **M1 (P2)**: 工单级便签 `job.notes` (几行 kv, 随回执信封下发)。只在多个分身需要同一个中途发现 (如「接口定为 X」) 时有用; 否则让发起者转述即可, 先不做 |
| **nested chat** (一条消息触发一段内部对话再返回) | clone/spawn 子树 + 回执 | 一致 |
| **termination conditions** (MaxMessage / TextMention / Timeout, 可 `\|` `&` 组合) | graph `rounds` + `until`; wizard↔wizard 对话**没有预算** —— 仓库里 `.fixpingpong` / `.hidepingpong` 的存在说明来回空转是真问题 | **M2 (P1)**: 给 job / tell_peer 一个预算: `maxTurns` (同一对 wizard 在该 job 内互发轮数) 与 `deadline`; 超了 daemon 不再投递, 回执改成 `failed: budget`。落点 `jobs.ts` 记数 + `/peers/tell` 闸。成本低, 防失控 |
| MAF **request_info / response_handler** | 审批卡 / 投票卡 | 同 §2.2 E1 |
| MAF **checkpoint 跨重启** | receipts / handoff 落盘 | 已有 (graph 除外, 见 L1) |

---

## 6. CrewAI

| 概念 | wezard 现有 | 差距 → 建议 |
|---|---|---|
| Agent `role / goal / backstory` | `wizard_identity` description + `renderCharter` 系统提示 | 一致; wezard 把身份放系统提示 (`--append-system-prompt`), 跨 `/clear` 存活, 更稳 |
| `allow_delegation` 自动给两件工具: **Delegate work to coworker** / **Ask question to coworker** | 只有一个 `tell_peer` | **C1 (P1)**: `tell_peer({kind})`: `task` (要 RESULT/ARTIFACT, 计入工单) / `ask` (只要一句答, 不计入工单, 回执短) / `fyi` (= `receipt:false`)。信封据 kind 换措辞。收益: 被问方知道该花多大力气, 发起者少收长回执; 成本低 |
| **hierarchical process** (manager agent 拆分 + 校验) | `.evolve` 这类总负责人 + job | 一致; wezard 的 manager 就是一个普通 wizard, 无特殊进程类型 —— 保持 |
| Flows `@listen` / `@router` / `and_` / `or_` | job 回执「全部到齐」= `and_`; `wait_peer({need:1})` = `or_` | 回执本身没有 `or_` (第一份到就提示可以先动); 可在回执信封加「已到 k/n」即可, 现状已有 |
| `@persist` + `restore_from_state_id` (按旧 state **分叉**新 id) | `clone_wizard` | 一致, 印证 fork 是一等原语 |
| memory: short-term / long-term / entity | `wizard_remember` scope `self/chat/workspace` + `memory-steward.ts` 整理 | 一致; entity memory (按人/文件建条目) 交给 `.ev-mem` 判断 |
| `@human_feedback` (自由文本经 LLM 路由到分支) | 人在群里直接回话 | 不需要: 人的话本来就进 wizard 上下文, wizard 就是那个 LLM 路由器 |

---

## 7. 不该学 (与单机 / tmux / IM 场景不符)

| 来源 | 不学的东西 | 理由 |
|---|---|---|
| A2A | JSON-RPC / gRPC / REST 三绑定、`A2A-Version` 头、`/.well-known` 发现、extended card | 所有 wizard 在同一守护进程的名册里, 名字即地址; 发现是 `wizard_roster` 一次调用 |
| A2A | securitySchemes (OAuth2/mTLS/OIDC)、`auth-required` 的凭据流转、多租户 | 单用户部署; 信任边界在 WeCom `allowFrom` + PreToolUse 审批, 不在 wizard 之间 |
| A2A | SSE streaming 的增量 artifact | 发起者看分身的每个 token 只会烧上下文; 过程留在 rolepage 给人看, 已是刻意设计 |
| A2A / MCP | 多模态 `Part` 结构化消息 | 通道是 tmux paste, 纯文本 + 文件路径就够; 结构化成本高、收益低 |
| MCP tasks | 轮询 `tasks/get` + `pollInterval` | 回执 push 已覆盖; 轮询每次都烧一轮 token |
| MCP elicitation | URL 模式 + 第三方 OAuth | 没有第三方凭据代管需求 |
| MCP sampling | 真正的反向补全通道 | wizard 本身就是 LLM; daemon 需要判断时起临时 wizard |
| OpenAI SDK | 单 run 内的同步 handoff 链 / Runner 循环 | wezard 的执行体是常驻 CLI 进程, 不是一次函数调用; 控制流在 wizard 上下文里 |
| LangGraph | 编译期图 + 类型化 state reducer + 节点重放幂等约束 | 编排是运行时才想出来的; tmux 进程不重放 |
| AutoGen | round-robin / 固定 speaker 状态机 | 群里有人在, 点名权属于人和管家 |
| CrewAI | YAML 静态 crew/task 定义 | 与「读完材料才知道分几路」相反 |

---

## 8. 优先级总表

| 优先级 | 编号 | 原语 / 改动 | 主要落点 | 成本 |
|---|---|---|---|---|
| **P0** | A1 | 派生 `TurnState` 枚举, 统一进 roster / peek / list_jobs / 回执信封 | `shared/turn-state.ts`(新)、`peers.ts`、`receipts.ts`、`jobs.ts` | 低 |
| **P0** | A2 | tell_peer turn id 进信封属性, 回执 `re=` | `shared/reminder.ts`、`receipts.ts`、`peers.replyToPeer` | 低 |
| **P0** | E1 | `NEED:` 收口 = needs-input, 不计入工单完成 | `receipts.ts`、信封模板、`jobs.ts` | 低 |
| P1 | A4 | `ARTIFACT:` 收口, 收工气泡列产物 | `receipts.ts`、`jobs.ts` | 低 |
| P1 | C1 | `tell_peer({kind: task\|ask\|fyi})` | `mcp/server.ts`、信封 | 低 |
| P1 | M2 | job / tell_peer 预算 (`maxTurns` / `deadline`) | `jobs.ts`、`/peers/tell` | 低 |
| P1 | A3 / §2.1 | `tell_peer({re})` 续问; `tell_peer({ttl})`; `cancel(turn)` | `mcp/server.ts`、`receipts.ts` | 低-中 |
| P1 | G2 | 工单 `accept` 条件, 不满足自动打回一次 | `jobs.ts`、`receipts.ts` | 低 |
| P2 | L1 | graph 降格为 job + 模板; `rounds/until` → 预算 | `graph.ts`、`mcp/server.ts` | 中 |
| P2 | H1/H2 | 转接语义写进 public tell; filtered handoff = spawn + brief | 工具描述 | 极低 |
| P2 | G1 | 审批策略链 (规则 → LLM → 人) | `approval.ts`、`danger.ts` | 中 |
| P2 | L2 | `clone_wizard({at})` 从历史点分叉 | `mirror-bridge.cloneSession` | 中, 需验证 CLI |
| P2 | M1 | 工单便签 `job.notes` | `jobs.ts` | 低, 先不做 |

P0 三项互相咬合: 有了 turn id (A2) 才能给每件活一个状态 (A1), 有了状态才有地方放 needs-input (E1)。三项都不新增落盘, 全是对现有 Slot / 信封 / 收口行的派生。

## 来源

- A2A 规范 1.0: https://a2a-protocol.org/latest/specification/
- MCP tasks (2025-11-25): https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/tasks
- MCP elicitation (2025-11-25): https://modelcontextprotocol.io/specification/2025-11-25/client/elicitation
- OpenAI Agents SDK handoffs: https://openai.github.io/openai-agents-python/handoffs/
- LangGraph interrupts: https://docs.langchain.com/oss/python/langgraph/interrupts
- Microsoft Agent Framework (AutoGen 继任): https://labs.ai.azure.com/innovations/microsoft-agent-framework · https://byteiota.com/microsoft-agent-framework-1-migrate-semantic-kernel-autogen/
- CrewAI Flows: https://docs.crewai.com/en/concepts/flows
