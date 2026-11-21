# 什么时候该拉 room, 而不是私聊; 拉了之后怎么说话

> `OliveOwen` · 2026-11-22 · 应 admin 之问: 「现在一些 wizard 更喜欢和多个 wizard 私聊, 分析在什么情况下应该拉起一个 room? 适合拉 room 时, 如何在 room 中沟通效果更好? 优先思考业内优秀实践」
> 只出研究与方案: **不改 charter 文案, 不改行为**。机制改进都要 admin 拍板后再动。
> 前作: [agent-team-comms.md](agent-team-comms.md) (`Frank`, 未提交) 谈的是「结论怎么回到发起方」; 本文谈的是「几个人同时在一件事上时, 话说在哪」。

## 0. 结论先行

1. **wezard 的 room 不是 AutoGen 式的「全员共享上下文」**, 而是「发布-订阅账本 + 只唤醒被点名的人」: 没被点名的成员不会多花一轮, 下次因别的事被唤醒时才顺带读到游标之后的行 (`shared/room.ts` `wakeTargets` / `unreadFor`, 每次最多 ~6000 字)。所以多一个旁观成员的边际成本很低。私聊的省钱是「少一个人读」, room 的代价是「多读几百字」; 而私聊的真代价是**转述和决策分叉**, 这正是业内反复踩的坑。
2. **数据: 账本里 43 个 dm room, adhoc room 一个都没开过**。176 条 dm 消息里 112 条 (64%) 正文提到了第三个 wizard 的名字; 出现了 7 组「三个 wizard 两两私聊」的三角。最典型的一例: rolepage 图节点的标记位置 (视角徽标 / lead ★ / 节点半径), `IrisIrwin`、`KateKing`、`JackJones`、`LeoLane` 四个 lead/coder 在同一个文件 (`web/chat.js`) 的同一处 UI 上, 靠 6 条两两 dm 对齐, 其中一个人定下的位置后来在另一条 dm 里被改掉, 而原定者不在那条 dm 里。这就是 Cognition 说的「行动带着隐含决定, 决定冲突就出坏结果」。
3. **私聊多不是因为模型偏好, 而是默认路径这样铺**: 对单个非成员 `chat_ask` 自动落 dm, 零摩擦; 对多个非成员 `chat_ask` 返回 400「先 room_open」, 要多一步。charter 里那句「多步的活默认开一个跟进 room (`room_open`, **或对单个非成员 chat_ask 时自动落的 dm**)」又把 dm 认成了跟进 room 的合法形态。所以它们一对一地找人, 就自然一路私聊下去。
4. **判据一句话**: **一件事一旦有 ≥2 个对等方会互相影响 (同一文件 / 同一接口 / 同一个设计决定), 或者需要第三方看到全过程, 就开 room; 纯上下级的「派一件 → 交一件」留在 dm。**
5. **推荐顺序**: ① (零代码) 编排协议: lead 一开始就把自己的 coder + reviewer 放进同一个 adhoc room (spawn / delegate 已支持 `room` 参数) → ② 对多个非成员 `chat_ask` 时自动开 adhoc, 不再返回 400 → ③ 在 dm 里 `chat_ask` 第三人时给一条「建议升级成 room」提示 → ④ room 的置顶目标与决定行 → ⑤ charter 补 1~2 句 (要拍板, 和别的 charter 改动一起发)。详见 §5。

## 1. 现状数据 (2026-11-22, `~/.wezard/state/rooms/`)

| 指标 | 值 | 读法 |
|---|---|---|
| room 文件 | 绑定 2 (群 1 + 单聊 1) · dm 43 · **adhoc 0** | `room_open` 从没被用过 |
| dm 消息 | 176 条 | — |
| 正文提到第三个 wizard 的 dm 消息 | 112 (64%) | 对话里实际有第三方, 只是不在场 |
| 含「转达 / 转告 / 帮我问」类字样 | 7 | 显式传话不多, 大多是「我看到 X 在做…」这类间接引用 |
| 三个 wizard 两两都有 dm 的三角 | 7 | 本该一个 room 的话被拆成了三条线 |
| dm 度数 | `wezard-1` 25 · `Grace` 7 · `IrisIrwin` 6 · `KateKing` / `JackJones` 4 | 管家是星形中心 (派活), 这部分**本该**是 dm |

**案例: 图节点标记** (`IrisIrwin` / `KateKing` / `JackJones` / `LeoLane` / `MayaMiller`)
- `JackJones → IrisIrwin` 问「你的视角标记画在哪, 别撞」; `IrisIrwin` 答右上角蓝眼; `JackJones` 再 say 一句「我改成左上角金★」。
- `IrisIrwin` 在另一条 dm 里提醒 `KateKing`「`JackJones` 也会改 nodeHtml / GRAPH_LEGEND」; `KateKing` 再单独通知 `JackJones`。
- 之后 `LeoLane → IrisIrwin` 说 admin 要求把视角标记改成 `<O>`、★ 挪到节点正中 —— `JackJones` 定下的左上角★就这样在它不在场的 dm 里被推翻了。
- 同一时期共用的 git index 至少两次把别人的 hunk 带进自己的 commit (本仓 `9aec470` 带走了我的 CHANGELOG 行; 之前 `c966e13` 被重做后改动丢失)。
- 这几件事的共同点: **一个共享对象 (同一文件 / 同一块 UI / 同一个 index), 多个对等的写者, 各自只看到自己那条线。**

## 2. 业内实践

### 2.1 Agent 框架: 私聊 vs 共享通道

| 系统 | 共享通道 | 点对点 / 层级 | 对我们的启示 |
|---|---|---|---|
| **AutoGen** GroupChat / SelectorGroupChat | 全员共享一条线程, 每条发言广播; 由 selector (LLM 或 `selector_func`) 决定下一个谁说, 默认不连续选同一人 | Core 层 `send_message` (点对点请求/响应) 与 `publish_message` (按 topic 广播) 并存 | 共享线程 = 每人每轮读全部, token 随人数线性涨。wezard 的 room 只唤醒点名者, 比它便宜; 但「谁该接话」(speaker selection) 在 wezard 是显式 `to`, 不由 LLM 猜, 这一点更稳 |
| **MetaGPT** | 全局 message pool + 发布-订阅: 各角色发布**结构化**产物 (需求 / 设计 / 任务 / 代码), 按角色兴趣订阅, 「不靠对话」 | 无 | 最接近 wezard 账本的设计。启示: 共享池里放的是**产物与决定**, 不是寒暄; 订阅按兴趣筛 |
| **黑板架构** (LbMAS, arXiv 2507.01701; Salemi et al. arXiv 2510.01285) | 中心 agent 把请求贴上黑板, 下属按能力自荐; 被选中的 agent 读整块黑板、写回结果 | 无 | 「把请求贴出去, 让有能力的人认领」比「挨个私聊问」好: 后者报告端到端成功率有 13%~57% 的相对提升 (作者自报) |
| **LangGraph** supervisor vs swarm (LangChain 基准) | swarm: 子 agent 直接对用户说话 | supervisor: 子 agent 的话由 supervisor 转述 | supervisor 输在「翻译」这一步, 还多花 token; 加一个 `forward_message` 原样转发后, 性能提升近 50%。**转述是有损的, 能原样给就原样给** |
| **OpenAI Agents SDK** handoff | — | 移交控制权: 「新 agent 接管对话, 看到之前全部历史」, 可用 `input_filter` 裁剪 | 移交时带全历史是默认; 裁剪是显式选择 |
| **Anthropic** 多 agent 研究系统 | 子 agent 把产物写进外部存储, 只回一个轻量引用 (小节标题就叫「减少 game of telephone」) | orchestrator-worker: lead 同步等一批 subagent | ① 每个子任务要「目标、输出格式、工具与来源指引、清晰边界」, 否则「重复劳动、留空档」; ② 「需要所有 agent 共享同一上下文、或 agent 之间依赖很多的领域, 目前不适合多 agent」; ③ 多 agent 约 15× chat 的 token |
| **Cognition** (Devin) | — | — | 两条原则: 「共享上下文, 并且共享完整的 agent 轨迹, 不只是单条消息」; 「行动带着隐含决定, 决定冲突就出坏结果」。后续一篇的结论: 能 work 的多 agent 是「大家出主意, 写操作保持单线程」 |
| **Claude Code** agent teams | 共享 task list + 每人一个邮箱; lead 固定 | `SendMessage` 点名发 | 建议 3~5 人; 已知 task 状态会滞后 |

### 2.2 稀疏 vs 全连接

Google 的「Improving Multi-Agent Debate with Sparse Communication Topology」(EMNLP 2024 Findings): 邻接稀疏的辩论在 MATH 上比全连接还高约 2 分, 在 GSM8K 上持平, 推理成本更低; 让更强的模型占更中心的位置还有额外收益。**启示: 不是「人越多、全员都听」越好。room 应该小而有主 (host 是最强的那个节点), 不是把所有相关的人都拉进来。**

### 2.3 人类协作的成熟规范

| 规范 | 内容 | 映射到 wezard |
|---|---|---|
| **默认公开, 少用私信** (GitLab handbook; Slack 官方礼仪博客) | GitLab 的 Slack 培训列了「Why we avoid direct messages」并设了「非私信消息占比」目标; 建议把群私信转成 private channel, 便于以后加人、减少打扰; Slack 只留 90 天, 重要决定要落到 handbook。Slack 博客: 过度依赖私信会把信息关进私聊 | dm 只做真正一对一的事; 三人以上的事放进 room; 决定落文档或 commit (账本本身已是永久记录) |
| **Incident Command** (PagerDuty 开源手册) | IC 是「当下在发生什么、接下来要做什么」的**唯一事实来源**; 「把所有修复动作委派出去, IC 不是修的人」; Scribe 随事件推进记时间线, 把重要决定和数据记下来供事后复盘 | host = IC: 协调、定夺、不亲自改; room 账本 = scribe 的时间线; 决定要明确记一行 |
| **单线程 owner** (Amazon STO/STL; two-pizza) | 一件事一个 100% 投入、负责到底的人; 团队小 | 一个 room 一个 host, 一个 duty 一个 holder (wezard 已经是这样); room 人数保持小 |
| **ADR** (Nygard 2011) | 每个决定写成 Context / Decision / Status / Consequences 的短文件, 放进仓库, 负面后果也要写 | room 里的决定行: 决定了什么、为什么、推翻了哪条 |
| **站会式同步** | 定期「做了什么 / 要做什么 / 卡在哪」 | 长 room 由 host 周期性贴一条状态; 成员用固定模板交代 |

### 2.4 已知失败模式 (agent 侧)

- **MAST** (Cemri 等, NeurIPS 2025; 1642 条标注轨迹, 7 个框架): 14 种失败模式归成 3 类: 规格问题、**agent 之间失配** (对话重置、不追问澄清、任务偏离、忽略别人的输入等)、验证缺失。作者的结论是, 这些失败多数来自**系统设计**, 而不只是模型能力。
- **转述链 (game of telephone)**: Anthropic 改成「写文件回引用」; LangChain 的 supervisor 改成「原样转发」。
- **上下文各读一遍**: 多 agent 约 15× token (Anthropic)。wezard 的 `clone_wizard` 先读后分, 就是在解这个问题。
- **私聊数量 n² 增长 / 没人汇总 / 重复劳动 / 决策冲突**: 本仓的案例 (§1) 四样都出现了。

## 3. 判据: 什么时候开 room

**判断顺序**: 先问「这件事有没有第二个对等方会被我的决定影响」, 再问「有没有人需要看到全过程」。都没有, 就用 dm。

| 情形 | 用什么 | 理由 / 出处 |
|---|---|---|
| 上级派一件活给一个执行者, 执行者交代 | **dm** (现状) | 单线程 owner; 星形结构本来就对 |
| 短问短答、探查性质 (「你的 X 是不是 n.r?」), 一来一回就完 | **dm** | 不需要留痕给第三方 |
| 敏感 / 只与两人相关的返工指令 | **dm** | — |
| **≥2 个对等的写者在同一个共享对象上** (同一文件 / 同一接口 / 同一块 UI / 同一个设计决定) | **room** | Cognition 原则 2; 本仓案例 |
| lead 的小队: coder + reviewer (reviewer 会直接找 coder 返修) | **room**, lead 当 host | 返修往来 lead 看得见, 不用转述; reviewer 的结论和 coder 的修复在同一条时间线上 |
| 一件事需要多方评审或拍板, 决定要留痕 | **room** | ADR / IC: 决定是一条明确的行, 不散在几条 dm 里 |
| 你在 dm 里**第二次**提到同一个第三方 (「X 也在改…」「等 X 提交…」), 或者想把 A 的话转给 B | **room**, 把 X 拉进来 | 转述是有损的 (LangChain 基准; Anthropic) |
| 同一个话题已经在 ≥2 条 dm 里各说一遍 | **room** | 数据里的 7 个三角 |
| 交接后接手的人要看全过程 | **room** (或把相关 dm 的 `room_read` 指针写进 brief) | Cognition 原则 1: 共享完整轨迹 |
| 人要旁观或插话 | 绑定 room (群) 或者把人拉进来 | charter 已有: 只有需要人和执行者直接对话时才拉人进主 room |
| 只是想让对方知道一下, 不需要回 | `chat_say` / `notify`, 放在该放的 room | — |

**room 规模上限**: 一个 room 3~5 个 wizard (Claude Code teams 建议 3~5; 稀疏拓扑的结论)。超过就拆子 room, 每个子 room 的 host 代表它向上一层交代。

## 4. 在 room 里怎么说话

wezard 已经在机制上替你做了不少: 只有点名的人被唤醒、每个 duty 只有一个 holder、关账只认 `chat_reply` 的 status、唤醒有预算 (10 分钟 20 次)。下面是机制之外的**约定**。

1. **开场一行目标** (host 写, 作为 room 的第一条 `chat_say`): 目标 · 完成标准 · 成员和各自的职责 · 共享对象 (文件 / 接口) 的归属。Anthropic: 「目标、输出格式、工具、边界」, 缺了就重复劳动、留空档。
2. **host = IC**: 协调、定夺、汇总, 不亲自改代码; 共享对象一次只有一个写者 (Cognition: 写操作单线程)。谁写哪个文件, 在开场行里定死; 要改归属就明说一句。
3. **点名才唤醒**: 要谁动就 `chat_ask({to})` 开一条 duty; 只是告知就 `chat_say` (不点名, 别人下次醒来时顺带读到)。别为确认收到回一句 —— 每句都会进别人的未读里。
4. **结论先行, 决定单独一行**: 定了的事写成一行 `决定: … (因为 …; 推翻 <id>)`。下一个人醒来时, 最先要看到的是决定, 不是讨论过程。
5. **交代用固定格式**: `做了: … · commit … · 文件 …` / `需要: 谁 · 什么 · 为什么卡`。done 写在 `chat_reply` 里, 别写在 progress 里。
6. **产物不贴全文**: 写进文件或 commit, room 里放路径和一句摘要 (Anthropic: 写文件回引用)。
7. **长 room 定期总结**: 超过约 20 行, 或者在阶段边界, host 贴一条「现状: 已定 / 进行中 / 卡住」。后来的人读这一条就够。
8. **收尾**: 所有 duty 关账后, host 写一条收尾总结 (结论 + commit + 遗留), 再向上级 `chat_reply`。room 的账本就是存档, 不用另存。
9. **人怎么介入**: adhoc room 只在 rolepage 可见。要人拍板, host 去绑定 room (群) 里问, 并附上 adhoc room 的 id; 人的回答由 host 带回 room。不要在群里转贴过程。

## 5. 机制改进清单 (只出方案, 全部待拍板)

| # | 改什么 | 收益 | 风险 | 实现面 | 推荐 |
|---|---|---|---|---|---|
| **A** | **编排协议改为「lead 的小队一个 room」** (不改代码): lead 先 `room_open({with:[coder]})`, 再 `spawn_wizard({room})` 把 reviewer 放进去; reviewer 在 room 里直接对 coder 说返修 | 消掉 reviewer↔coder 的私聊, lead 看得见返修, 不用转述 | 几乎没有: 只点名唤醒, 旁观成本是多读一些未读 | 只是 lead 的派活信封 (`<system-reminder wezard="lead">`) 里加一句; 这段**不是 charter**, 每次派活都随信封带 | **1** |
| **B** | 对多个非成员 `chat_ask` 时**自动开 adhoc** (发起者当 host), 不再返回 400 | 拉 room 和私聊一样不费力; 改变默认选择 | 可能开出很多一次性 room → 配 room 列表的折叠 / 收尾 | `daemon/index.ts` 的 chat_ask 路由 + `mcp/tools.ts` 描述; 账本格式不变 (adhoc 本来就有) | **2** |
| **C** | **升级提示**: 在 dm 里 `chat_ask` / `chat_say` 的正文提到第三个 wizard (名字表现成的), 或者同一个作者 30 分钟内对 ≥2 个对象的 dm 提到同一个文件路径 → 回包里附一行「这件事牵涉 .X, 考虑 room_open({with:[对方, X]})」 | 在发生的那一刻提醒, 不靠 charter 记忆; 用的是数据里 64% 的那个信号 | 误报 (只是顺口提到) → 只提示、不拦截, 同一对象每小时最多一次 | 回包文本, 只在 `daemon/index.ts` 路由一处; 不进账本 | **3** |
| **D** | **dm 升级成 room**: `room_open({from: "dm:…", with:[X]})` 开 adhoc, 首行自动引用 dm 里的最后 N 条 (id 引用, 不复制) | GitLab 的「群私信转 private channel」; 新成员不用听转述 | dm 的 id 是按两人推出来的, 往 dm 里直接 `room_invite` 第三人会让 `dm:a\|b` 名不副实 (**未实测, 需先核**) → 所以要开新 room, 而不是改 dm | room 打开路由 + 一个引用行; 账本格式加 `from` 字段 → **要拍板** | 4 |
| **E** | **置顶目标 + 决定行**: room 加 `brief` (开场目标, `room_read` 与注入头总在最上面) 和 `decision` 行标记 (rolepage 高亮, `room_read` 能只看决定) | IC「唯一事实来源」+ ADR; 新人读一条就懂 | 改账本行 schema → **要拍板**; 前端要配合 (现由 `LeoLane` / `IrisIrwin` 改 chat.js, 要排期) | `shared/room.ts` 行类型、`room-view.ts`、`web/chat.js` | 5 |
| **F** | **收尾提示**: adhoc room 里所有 duty 关账、且 host 空闲时, 给 host 一条 `trigger` 行「写收尾总结」 | 自动收尾, 不再「没人汇总」 | 多一轮 token; 小 room 不需要 → 只在 ≥3 个成员或 ≥10 行时触发 | 和 plan-reminders 同一种 `trigger` 行机制 | 6 |
| **G** | **charter 补 1~2 句** (要拍板, 会触发全体 handoff 提醒): 把「或对单个非成员 chat_ask 时自动落的 dm」改成判据: 「纯上下级一派一交用 dm; 牵涉第二个对等方 (同一文件 / 接口 / 决定) 或要第三方看过程, 就开 room」 | 判据进入每个 wizard 的上下文 | 改 charter 要发全体提醒; `tests/charter.test.ts` 有断言要同步 | `daemon/wizard.ts` 一处 | 7 (和删 `wait_peer` 一起发) |

**不建议**:
- 自动把 dm 合并成 room, 或者禁止私聊: 纯上下级的私聊是对的 (管家 25 条 dm 大多就是这种)。
- 全员订阅 (`room_watch` 默认开): 每条人话都会花每个成员一轮, 等于退回 AutoGen 式的全员广播。
- 让 daemon 判断「两条 dm 是不是同一个话题」再自动拉人: 这是判断题, 属于模型那一边 (README 核心判断 1)。daemon 只给提示 (C)。

## 6. 验证方式 (如果采纳)

- 指标: 每周 `adhoc 数 / dm 数`, dm 消息里提到第三方的比例 (现在 64%), 三角数 (现在 7), 「共用 index 带走别人 hunk」这类事故的次数。
- A 落地后先观察一周, 再决定做不做 B/C。数据脚本是 §1 那段 node 单行脚本, 只读 `~/.wezard/state/rooms`。

## 7. 来源

外部 (2026-11-22 检索; 标「摘要」的只读到搜索摘要, 未逐页核对):
- Anthropic, How we built our multi-agent research system: <https://www.anthropic.com/engineering/multi-agent-research-system> (已核原文引语)
- Cognition, Don't Build Multi-Agents: <https://cognition.com/blog/dont-build-multi-agents> (已核); Multi-Agents: What's Actually Working: <https://cognition.ai/blog/multi-agents-working> (摘要)
- OpenAI Agents SDK, Handoffs: <https://openai.github.io/openai-agents-python/handoffs/> (已核)
- PagerDuty Incident Response, Different Roles: <https://docs.pagerduty.com/ops-guides/incident-response-guide/different-roles> (已核)
- LangChain, Benchmarking Multi-Agent Architectures: <https://www.langchain.com/blog/benchmarking-multi-agent-architectures> (摘要)
- AutoGen, Selector Group Chat: <https://microsoft.github.io/autogen/stable/user-guide/agentchat-user-guide/selector-group-chat.html> (摘要)
- MetaGPT (Hong et al., ICLR 2024): <https://arxiv.org/abs/2308.00352> (摘要)
- Han, Exploring Advanced LLM Multi-Agent Systems Based on Blackboard Architecture: <https://arxiv.org/abs/2507.01701>; Salemi et al., LLM-Based Multi-Agent Blackboard System for Information Discovery in Data Science: <https://arxiv.org/abs/2510.01285> (摘要)
- Li et al., Improving Multi-Agent Debate with Sparse Communication Topology (EMNLP 2024 Findings): <https://arxiv.org/abs/2406.11776> (摘要)
- Cemri et al., Why Do Multi-Agent LLM Systems Fail? (MAST): <https://arxiv.org/abs/2503.13657> (摘要)
- GitLab handbook: Slack 培训 <https://handbook.gitlab.com/handbook/people-group/learning-and-development/learning-initiatives/slack-training>、Slack 用法 <https://handbook.gitlab.com/handbook/tools-and-tips/slack> (摘要; 「Why we avoid direct messages」原文段落没取到); Slack 礼仪博客 <https://slack.com/intl/en-au/blog/collaboration/etiquette-tips-in-slack> (摘要)
- Amazon single-threaded leader: <https://aws.amazon.com/blogs/enterprise-strategy/two-pizza-teams-are-just-the-start-accountability-and-empowerment-are-key-to-high-performing-agile-organizations-part-2/> (摘要)
- ADR: Fowler bliki <https://www.martinfowler.com/bliki/ArchitectureDecisionRecord.html> (摘要)
- Claude Code agent teams: <https://code.claude.com/docs/en/agent-teams> (转引自 agent-team-comms.md)

内部 (HEAD `c182134` 前后): `shared/room.ts` (`wakeTargets` · `unreadFor` · `WAKE_BUDGET=20` · `UNREAD_BUDGET=6000`)、`daemon/room-hub.ts` (`render`)、`mcp/tools.ts` (chat_ask 落点规则、room_open 描述)、`daemon/wizard.ts:1004/1118` (charter 编排段)、`~/.wezard/state/rooms/*.jsonl` (§1 统计)。

## 8. 追问核实 (2026-11-22, admin 对 §5 的回复)

> admin 的回复 (经 `wezard-1` 转): A、C 不要。B 可以考虑, 取决于它们需不需要感知彼此的消息。D: 「dm 按现在的定义本来就是通过 room 聊天的, room 也支持拉人, 拉人时可以选择附带多少聊天记录」。E/F/G 未表态。以下只核实、出方案, 不改代码。

### 8.1 往 dm 里 `room_invite` 第三人: 能成功; 账本语义一致, 显示与寻址有 4 处不一致

**能成功**: `POST /room/invite` (`daemon/index.ts` ~1561) 不看 room 的类型。邀请人是 host (dm 里 ord=1 的那一方, 即最先 chat_ask 的那个) 或者被拉者的直属 parent 时, 直接写 `join`; 其余情况转成 join-req, 等 host 批。

**账本语义一致** (用 `shared/room.ts` 的纯函数在内存里跑过一遍, 不碰磁盘, 脚本见本节末):
- C 入座 ord=3, `seen=0`; host 仍是 A; 成员判定、`judge`、`wakeTargets`、duty 开关都按 fold 后的成员表算, 和 adhoc 没有区别。
- A `chat_ask` C 只唤醒 C; B 一句不点名的 `say` 谁也不唤醒; C 用 `chat_reply` 交代后唤醒 A, duty 关账。
- C 第一次被唤醒时读到的未读 = 从 `seen=0` 起最新的 ~6000 字 (实测 30 条 × 400 字, 列出最近 16 条, 并提示「更早还有 16 条没列, 用 room_read 翻」)。

**不一致的地方** (都不会让账本出错, 但会误导人或模型):
1. **注入头和标签少一个人**: daemon 的 `roomLabel` 对 `dm:` 直接按 id 拆出两个人, 渲染成「A ↔ B」, 而且这一支在 `s.title` 判断**之前**返回, 所以 `room_name` 起的名字对 dm 不生效。C 收到的注入头是【A ↔ B】, 看不出自己也在里面。rolepage 上 `roomTitle` 对 dm 只取前两个成员 (起了名则用名字); 提示行的去处写「私聊」(`shared/chat-http.ts` `roomShortOf`)。关系图按成员数画, 三个 wizard 会画成 room 节点, 这一处没问题。
2. **A↔B 以后的「私聊」都落进三人 room**: `ensureDmRoom(A,B)` 只认 id; A 之后对 B 单独 `chat_ask` 仍落进 `dm:A|B`, C 会读到。A 和 B 也没有别的「两人默认 room」了 (要私下说就只能 `room_open({with:[B]})` 再开一个)。
3. **有人离开后, 这一对就被卡死** (这个问题在两人 dm 里早就有, 拉人后更容易碰上): B `room_leave` 之后, `ensureDmRoom` 看到 room 已存在, 直接返回; A 再 `chat_ask` B, `judge` 会拒 409「不是本 room 成员」。A 和 B 之间的默认通道就此不可用, 除非有人重新邀请 B。
4. **id 不再描述成员**: `dmPeers(id)` 仍然只报两个人。目前它只被 `roomLabel` 用到, 所以只影响显示 (第 1 条)。

**推荐**: 承认「dm 也是 room, 可以拉人」这个定义, 补两处小改动 (都不改账本格式):
- (a) `roomLabel` 先看 `s.title`; dm 成员超过两个时按成员列名字 (和 adhoc 同一种写法); 前端 `roomTitle` 和 `roomShortOf` 同步。
- (b) `ensureDmRoom` 碰到「room 存在但对方不在成员里」时, 把对方补回来 (重新写 `join`), 而不是让 `judge` 返回 409。
- 第 2 条 (A↔B 的私聊落进三人 room) 我认为是这个定义的自然结果: 拉了人, 这个 room 就是这几个人的。要不要改, 由 admin 定。

### 8.2 拉人时「附带多少聊天记录」: 现在没有这个参数; 最小实现不需要改账本格式

**现状**: `room_invite` 只有 `room` 和 `who`; `room_join` 只有 `room` 和 `reason`; `room_approve` 只有 `re` 和 `accept`。实际效果是固定的: 新成员 `seen=0`, 第一次被唤醒时读到「全部历史里最新的 ~6000 字」, 外加「更早还有 N 条」的提示 (`UNREAD_BUDGET`)。另外, 直接入座**不会唤醒**被拉者 (`join` 是 op, 不是 msg 行), 它要等有人点名才第一次读到这些。`room_read` 指定了 room 时不检查成员身份, 所以要读更早的记录随时都能读。

**最小方案**: 在 `room_invite` 和 `room_approve` 上加一个 `history` 参数, 落成被拉者的**初始 `seen` 游标**:

| `history` | 游标 | 被拉者第一次被唤醒时读到 |
|---|---|---|
| `"none"` | `seen = s.seq` | 只有入座之后的新消息 |
| `N` (数字) | `seen` = 倒数第 N 条 msg 的 seq − 1 | 最近 N 条 |
| `"from:<msgId>"` | `seen = seq(msgId) − 1` | 从那一条起 |
| `"all"` / 缺省 | `seen = 0` (现状) | 全部, 仍受 ~6000 字预算截断, 超出的提示 room_read |

- **落点**: 只改 `daemon/index.ts` 的 `POST /room/invite` 直接入座那一支, 和 `POST /room/approve` 的接受那一支。在同一次 `hub.write` 里, `join` 后面紧跟一条现成的 `{op:"seen", who, seq}`。fold 对 `seen` 本来就只往前推 (`if (op.seq > m.seen)`), 新成员从 0 开始, 一定生效。`room-hub.ts` 的 `pending` / `render` / `unreadFor` 都不用动, 它们本来就从 `seen` 往后读。
- **不改账本格式**: `seen` op 已经存在, 老账本照常 fold。
- **join-req 那条路**: 申请时不带 history, 由 host 在 `room_approve({re, history})` 时决定。这样 join-req 行也不用加字段。
- **MCP**: `room_invite` 和 `room_approve` 的 schema 各加一个可选 `history` (`z.union([z.literal("none"), z.literal("all"), z.number().int().positive(), z.string().regex(/^from:/)])`); 描述里写清「这是被拉者第一次被唤醒时能读到的范围, 更早的随时可以 room_read」。
- **可选的第二步** (先不做): `history:"all"` 时让第一次投递不受 6000 字预算限制。这会让新成员第一轮的上下文变大, 所以默认仍按预算截断、提示 room_read。
- **测试**: 往 `tests/room-hub.test.ts` (或新加一个 fold 用例) 加: 入座 + `seen` 后, `unreadFor` 只列游标之后的行; 四种取值各一例。

### 8.3 B: 以「它们要不要感知彼此」为判据, 不一刀切

`chat_ask({to:[X,Y]})` 里有非成员时, 现在返回 400 (`roomTargetOf`)。一条 ask 点名多个人, 实际是两类完全相反的意图:

| 意图 | 该不该互相看得见 | 正确落点 |
|---|---|---|
| 协作: 同一个文件 / 接口 / 决定, 或者一个做、一个审 | **要** | 新开 adhoc, 发起者当 host |
| 独立并行: 互不相干的分工, 或者**刻意隔离**的独立评审 / 竞争方案 (互相看见会锚定, 独立性就没了) | **不要** | 每人一条 dm |

所以「多个非成员就自动开 room」会在第二类上出错, 正好破坏「白板 reviewer 不继承别人上下文」这条现行规矩。**最小实现**: 让发起者显式说出意图, daemon 不猜:
- `chat_ask` 的 `room` 参数接受一个保留值 `"new"`: daemon 开 `adhoc:` (`open` + 发起者 ord=1 + 各个 `to` 的 `join`, 和 `POST /room/open` 是同一段逻辑, 抽成一个函数共用), 再把这条 ask 落进去。账本格式不变。
- 400 的报错文本改成二选一的指引: 「要它们互相看得见 → `room:"new"`; 各干各的 → 对每个人分别 chat_ask (各落 dm)」。默认行为仍是 400, 不会悄悄选错。
- 可以再加 `history` 吗? 不需要: 新 room 本来就是空的。
- **风险**: ① 一次性 room 变多 → 关系图和列表上 adhoc 节点变多 (已有 2d 时间窗过滤); ② 发起者对第二类误用 `"new"` → 只能靠描述讲清楚, daemon 不替它判断; ③ `to` 里有人已经在发起者的缺省 room 里 → 仍然全部落进新 room, 这是明确的选择。
- **实现面**: `daemon/index.ts` `roomTargetOf` 加一支 (约 15 行) + `mcp/tools.ts` 描述 + 一个测试。

**推荐**: 8.2 (`history` 参数) 和 8.3 (`room:"new"` + 二选一报错) 都是小改动, 账本格式不变、无行为回退, 可以一起批; 8.1 的 (a)(b) 两处修正顺带做。都等批准后再动。

<details><summary>8.1 的内存验证脚本 (只 import 纯函数, 不写盘)</summary>

```ts
import { applyOp, unreadFor, roomHost, dmPeers, openDuties } from "../shared/room.ts";
import { room, W, uid, say, dmRoomId } from "../tests/room-fixture.ts";
const [A, B, C] = [uid(1), uid(2), uid(3)];
const id = dmRoomId(A, B), s = room(id, [W(A), W(B)]);
for (let i = 0; i < 30; i++) say(s, { author: W(i % 2 ? B : A), text: "历史 " + i + " " + "x".repeat(400) });
applyOp(s, { op: "join", at: 5000, room: id, who: W(C), ord: s.nextOrd, via: "invite", by: W(A) });
const ask = say(s, { author: W(A), kind: "ask", to: [W(C)], text: "C 来看一下" });   // wake → [C]
say(s, { author: W(B), text: "不点名的一句" });                                      // wake → []
unreadFor(s, W(C), [ask.id]);                                                          // 16 行, more 16
say(s, { author: W(C), kind: "reply", re: [ask.id], status: "done", statusGiven: true, text: "看了" }); // wake → [A], duty 关
```
</details>
