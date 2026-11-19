# wezard · room 模型重构设计稿 + 分期 (待人拍板)

> 依据: 人的 6 条原话 + 管家钉的 A–G 七个钉子 + 前稿 /tmp/wezard-wizard-comms-analysis.md (阶段 A+B)。
> 只读分析, 未改代码 / 工作树。实测基于本机 ~/.wezard (2026-11-19), 只读统计脚本 /tmp/wz-stats{,2..6}.mjs。
> 每个钉子给 2–3 个选项 + **推荐** + 代价。**推荐不是拍板**, 每个钉子末尾的「待人拍」才是要人做的决定。

---

## 0. 摘要

- **一条总原则**: 新模型里, **完成信号、出处、发言权都是账本行上的显式字段**, 不再从 transcript / 终句 / 信封里推断。前稿统计过, 199 个沟通相关 fix 几乎都落在这三类推断上。
  - **完成**: 由 reply 行的 status 表示, 只能由工具写入。
  - **出处**: 由消息行的 author 和 room 表示, 在 append 时定死。
  - **发言权**: 由 append 时的成员资格判定, 被拒的发言根本不会落成行。
- **room 是唯一的沟通对象**。
  - 企微群、单聊、topic 帖子都是**绑定了传输的 room**。
  - wizard 之间的单聊是**不绑定传输的 2 人 room**。
  - 跨群协作的做法: 加入对方的 room, 或者两边共开一个 room。
- **人和 wizard 用同一个口子**。
  - wizard 说话只走工具 (chat_say / chat_reply …, 都带 room)。
  - 人在企微说话, 由 daemon 以 inbound 来源 append 成同一种消息行。
  - room 里的每一条消息都会进企微 (人是参与者)。
  - 终句没有任何路由语义, 只进 rolepage。
- **topOnly / speech(implicit|strict) / 公开私聊降级 全部删除**。噪声控制改为结构性的: wizard 自己决定**开跟进 room** (相当于今天的私聊委派), 还是**拉人进当前 room** (相当于今天的公开)。daemon 只保留这几样: 成员 ACL、额度、去重、传输状态、挂在人话行上的气泡、义务提醒。
- **「收到」不等于「起一轮」**。会被唤醒的只有: 被点名者、被 re 的提问者、人话未点名时的 manager。其余成员只推进游标, 等下次被唤醒时附带一段未读摘要。10 成员的 room 广播一条消息, 唤醒 1 个会话; 如果全员唤醒, 约贵 7–65 倍, 而且会连锁放大成 N²。
- **分期 P0–P5**:
  - P0–P3 不改行为、可回滚: 影子账本 → 视图层 → 新工具并存。
  - P4 是唯一的 breaking 一次性切换。前提是 P3 试点里显式完成率 ≥90%。
  - P5 删除旧代码。

---

## 1. 新模型一页纸

### 1.1 实体

| 实体 | 关键字段 | 说明 |
|---|---|---|
| Room | id, kind (wecom-chat / wecom-dm / topic-post / wx-chat / adhoc / dm), bind? {bot, principal, post?}, manager, title, state (live/archived) | 绑定了传输的 room 用 principal 派生 id (如 r:chat:wr…), 无绑定的用 r:<hex>; 2 人 room 按成员对规范化 (§D) |
| Member | room, who (wizard target / human:id), since, by, via (founder/invite/approve/mention/spawn/migrate), cursor{sent, seen} | 人也是成员; seen 游标推进的依据是投递证据或工具调用 |
| Msg | room, seq, id, at, **author**, kind, text, to?[], re?(msgId 或数组), **status?**, for?(上游 msgId, 只记血缘), after?[], planId?, files?[], origin (inbound/tool/daemon) | seq 在 room 内单调递增 |
| Duty (派生) | 由 msg 派生: kind ∈ {task, ask, join-req}, 或 wecom room 里没点名的人话 (归 manager) | **不落第二份数据**: 开 = 这条 msg; 关 = holder 写一条 re 它、带终态 status 的 reply; 移交 = duty.move 行 |
| Xport | msgId, transport (wecom/pane), state (pending/sent/uncertain/failed), ack, bubble? | 传输层状态, **与完成无关** |

### 1.2 工具面 (wizard 唯一的出站口)

| 工具 | 语义 | 取代 |
|---|---|---|
| chat_say({room?, text, to?, expect?:"reply"\|"none", after?, planId?}) | 在 room 里发言; 带 to 且 expect:"reply" (缺省) 就为每个 to 开一条 duty | tell_peer (task/ask/fyi)、notify、chat_say、chat_ask |
| chat_reply({room?, re, text?, status?:"done"\|"need"\|"progress"\|"passed"}) | **唯一的完成信号**; 不带 text = passed; re 可以是数组 (一次合并关闭多条) | 终句 RESULT:/NEED:/PROGRESS:、'.name RESULT:' 分段、chat_reply 现语义 |
| room_open({with, title?, from?}) | 开跟进 room, 调用方当 manager, 被邀请者直接入群; with 为单人时复用既有 DM room | public:false 私聊委派 |
| room_invite({room, who}) / room_join({room, reason}) / room_leave({room}) / room_members({room}) | 成员管理与申请 (§E) | spawn/delegate 的 join 参数、/chat/members |
| room_transfer({re, to}) | 把 duty 移交给 to (to 不是成员时先 invite) | return:"transfer" |
| room_read({room, since?, until?, limit?, from?}) | 从账本读历史 | read_chat |
| send_file({room?, path, …}) | 带文件的消息行 | send_file |

**room 参数**有两个方案:
- (a) 必填。
- (b) 缺省 = 触发本轮的那条 msg 的 room; 本轮由多个 room 的摘要共同触发时 400, 要求显式给出。工具回包回显实际用了哪个 room。

推荐 (b)。代价是模型偶尔会依赖缺省值; 回显可以缓解, 而且这个缺省值来自账本, 不靠推断。

### 1.3 注入 (daemon → wizard pane)

- 注入头只渲染账本行 (room / seq / author / re / status) 给模型看。**任何读侧都不再把它解析回来当事实** (删掉 parseEnvelope 在 read_chat / rolepage / 恢复路径上的用途)。
- 恢复、交接、reload 只携带**游标集合** {room → seen}。出处查账本, 不再沿注入链传递。967e8c6 那一类 bug (交接后对话整段落进 p:system: 假栏) 在结构上不再成立。

---

## A. room 账本的落点与 route 映射

### A1 落点选项

| 选项 | 做法 | 好处 | 代价 |
|---|---|---|---|
| **A-1 新开 room 账本, routes.jsonl 冻结只读** (再分两种形态: a 单文件 rooms.jsonl; b **每 room 一个 rooms/<id>.jsonl** 加可重建的 registry) | 消息、成员、manager、duty.move、游标都进 room 账本; duty 是派生出来的 | 唯一真相; b 形态里一次关账 (reply) 和它关掉的 duty 在同一个文件, 原子性天然成立; 历史随 room 长期保留, 互不影响 | 要重写 router.ts 那套已经稳定的纯核心 (13 commits / 4 fix); 需要复用它的 journal 纪律 (fold、撕裂尾行丢弃、中段坏行拒绝启动、fsync) |
| A-2 room 账本 + routes.jsonl 继续当义务账, route 行加 room 字段 | 消息、成员走新账本, duty 仍是 route 行 | 迁移面小, router 不动 | **两个账本就是两个真相**: msg 和 route 行要交叉对账, 正好重演 router 想消灭的「欠账拆在多处」问题 (router.ts:3-6 的设计动机); 账本唯一这一条不成立 |
| A-3 把 chat / target / channel 三键折叠成 room id, 融进 routes.jsonl | 扩展 router 的 Op 联合类型 (room/member/msg op 同 journal、同 fold) | 单文件, 直接复用 fold/compaction | **生命周期冲突**: route 行要回收 (TOMBSTONE_TTL 7 天 gc, router.ts:602), 消息历史要长期保留; 消息和 route 混在一张 Table, compaction 要分两套规则; 单文件随消息线性膨胀 (现在 3 MB 只是 route) |

**推荐 A-1b**。代价是 router 纯核心要重写一遍, 但 duty 从 msg 派生之后状态机小很多: 没有 held/answered/handed 的投递中间态, 也没有 merge/alias。

**待人拍**: 是否接受账本换文件, 以及 routes.jsonl 冻结。

### A2 route 行到 room 模型的映射

| 现在 (router.ts) | room 模型 | 老 path 的去向 |
|---|---|---|
| Route.owner | duty holder = task msg 的 to (若有 duty.move, 以最后一次为准) | **替代** |
| receiver {kind:"chat", channel, message} | 绑定 room 里的人话 msg (author = human); 回复 = 同 room 里 re 它的 reply | **替代** |
| receiver {kind:"wizard", to, event} | to 在某个 room 里发的 task msg; event (它服务的上游那笔) 降级为 for, **只记血缘, 不自动沿链冒泡** | **替代**; 自动冒泡与孤儿 (isOrphaned / escalate, router.ts:408-431) **删除**。上游要交代, 由上游自己 chat_reply |
| return:"self" (缺省) | chat_say(to, expect:"reply") 开 duty | 替代 |
| return:"detach" | 同上, 只是不带 for。self 与 detach 的区别只在「是否沿链冒泡」, 冒泡删除后两者合一 | **删除** (参数位取消) |
| return:"transfer" | room_transfer({re, to}) 写 duty.move; to 不在 room 时先入群 | 替代; 气泡归属问题随之消失 (§C3) |
| return:"none" / kind:"fyi" | chat_say(expect:"none"), 不开 duty | 替代 |
| status held (after) | msg.after: 前置 duty 全部以 done 关闭之前, 不唤醒 holder | 保留语义, 实现简化 |
| need | reply status:"need": duty 不关, 唤醒提问者 (反向) | 替代 |
| error (CLI 报错) | daemon 以 origin:"daemon" 写一条 status:"error" 的系统 reply, duty 不关 | 替代 |
| answered → handed (outbox→收件箱两段) | reply 行落盘即完成; 投递是 Xport 的事 | **删除** (投递和完成彻底分离) |
| late / retell (追述) | 同一条 re 上再写一条 reply, 没有特例 | 删除 |
| mergedInto / alias / 同对单槽 | 不合并; 多条 duty 各自独立, 可以用 re:[…] 一次关掉 | 删除 (index.ts:3129 mergeRow、router.ts:136) |
| inputIds 覆盖 (未读补充不能结) | chat_reply(re=X) 要求 holder 在该 room 的 seen ≥ X 这条线程里最新补充的 seq, 否则 409 "先读 seq N" | 替代 (判据从事件推断变成游标比较) |
| NO_DEADLINE / 无清扫 | 不变: duty 没有 deadline; 提醒由 duty watcher 负责 (§C) | 保留 |

### A3 存量怎么迁

本机现状: routes 978 行 (973 已交付 / 5 未结, 最老的挂了 158h); 46 个 base (45 群 + 1 单聊); 1273 个身份 (worker 1229 / steward 40 / global-steward 3 / apprentice 1); members.json 251 行覆盖 11 个群; 3 个 topic 帖子。

| 选项 | 做法 | 代价 |
|---|---|---|
| M-1 一次性迁移 (切换时) | 停新派活 → 排空 → 一次性建 46 个绑定 room + 成员 → 5 条未结 route 转成 task msg → 历史只读、走 legacy 视图 | 切换窗口内派活要停; 切换后 rolepage 新旧两种历史并存 |
| **M-2 影子双写 (P1 起) + 切换时排空** | P1 起所有出入口同时写 room 账本 (不读); P4 切换只是把读写权翻过去; 未结 route 在切换时转换 | 双写期要维护两份写入点 (§G 里有对账); 但历史在切换前已经在 room 账本里, 新视图从第一天就连续 |
| M-3 懒迁移 | 切换后某个 room 第一次被用到时才建, 不回填 | 实现最省; 切换前的历史在新视图里看不到; 成员要重新拉 |

**推荐 M-2**, 外加以下几条成员回填口径:
- **home ≠ 成员**。1229 个 worker 大多是在某群 home 下生出来的分身, 全拉进群会让 room 立刻上百人。成员只回填这几类:
  - members.json 现有的行;
  - 各群绑定的管家;
  - 最近 7 天在该群有轮次的 wizard;
  - 7 天内有 route 往来的 wizard 对, 建成 DM room。
- **message-events 的去向**:
  - 103 条 uncertain 一律归档, 不迁 (已经没有流程会读它们);
  - queued 状态的 3 条改投成 room msg。

**待人拍**: 双写还是一次性; 成员回填口径 (7 天活跃 vs 只认 members.json)。

---

## B. 「每个参与者都收到」≠「每个都起一轮」

**硬约束**: 往 CLI 的上下文里塞任何文本都会起一轮 (贴进输入框 = 一次 user turn)。不起一轮、只「让它知道」的唯一办法, 是挂在下一次注入的尾巴上 (notices.ts 现在就是这么做的)。所以「收到」只能有两种实现: **唤醒**, 或者**游标加下次附带**。

### B1 唤醒判据选项

| 选项 | 唤醒谁 | 其余成员 | 适用规模 |
|---|---|---|---|
| B-1 全员唤醒 | room 里除作者外的所有 wizard | — | ≤3 人的对等讨论 |
| **B-2 点名 + manager 兜底 + 静默只读** | ① to 里的人; ② reply 唤醒被 re 那条消息的作者; ③ 绑定 room 里没点名的人话唤醒 manager; ④ 人话里的 .name 点名唤醒该 wizard (不在群就以 mention 方式自动入群); ⑤ join-req 唤醒 manager | 只推进 sent 游标; 下次被唤醒时附带「<room> 里你没看到的 N 条」摘要 (上限约 1.5k token, 超出的部分提示用 room_read) | 任意规模; 扇出 = 1 + 点名人数 |
| B-3 B-2 加可选订阅 (watch) | B-2 的全部, 再加上订阅了该 room 的成员: 只在 kind ∈ {人话, 带终态 status 的 reply} 时唤醒, 60s 防抖、每小时 ≤K 次 | 同 B-2 | 长任务旁观、需要实时跟进的 reviewer |

**推荐 B-3**, 订阅默认关, 由 wizard 用 room_watch 显式打开。代价: 摘要附带会让下一次唤醒变贵一点 (有上限); 没订阅的成员对 room 里的变化有延迟感知, 要靠宪章写明「需要实时就订阅或点名」。

### B2 防连锁 (N²) 与去重

- **结构**: reply 只唤醒被 re 的作者, 不唤醒全群; chat_say 不带 to 的话不唤醒任何 wizard。
- **回合预算**: 同一条人话 (根) 衍生出的唤醒, 在 10 分钟内超过 M 次 (建议 M = 20) 时, 后续唤醒降级为只推游标, 并写一条系统行给 manager。这样 A↔B 互相点名的乒乓不会无限下去。
- **去重**: (room, author, contentRev(text), re) 在 10 分钟内重复就返回幂等 409 (把今天 chatReplySeen 内存集合的做法 (index.ts:2243) 落进账本)。
- **额度**: 保留每轮 ≤3 条、每 room 每分钟 ≤10 条 (strict-gate.ts:42-47), 从「strict 群才有」变成全量生效。

### B3 扇出估算: 10 成员 room (1 人 + manager + 8 wizard), 人发一条没点名的消息

**估算口径**:
- 白板会话的基准: FRESH_CTX = 25k (route.ts:351)。
- 冷门控阈值: COLD_GATE = 100k (route.ts:387)。
- 按 Anthropic 计价比例: 缓存读 0.1×、缓存写 1.25×。
- 假设成员 ctx 为 100k, 唤醒一次输出约 1–2k。

| 方案 | 唤醒会话数 | 估算 token 当量 (输入) | 相对 B-2 |
|---|---|---|---|
| B-2 / B-3 (没点名的人话) | 1 (manager) | 热 ≈ 10k + 摘要 1.5k ≈ 12k; 冷 ≈ 125k | 1× |
| B-1 全员, 30% 热 / 70% 冷 | 9 | 0.3×9×12k + 0.7×9×125k ≈ 820k | 冷时约 7×, 热时约 65× (相对 12k) |
| B-1 且被唤醒者各回一句 (连锁一层) | 9 + 9×8 = 81 | 约 7.4M | N² |

**传输侧也会放大**: daemon.log 里 47 201 行排队等待, 其中 49% 是「探测位被占」、42% 是「判不出 owner 闲」。B-1 会让每条人话的 pane 注入变成 9 次, 这条瓶颈会被同比例放大。

### B4 会不会放大 34% 的 uncertain

- **今天 uncertain 会卡死**, 原因是完成依赖「这条注入有没有被消费」的证据。最大的一类 (50 条) 是「这一轮结束了却没有终句」, 拿不到结论, 也不敢重投。
- **新模型里 uncertain 不再卡死**:
  - 完成只认 chat_reply 行, 与注入暴露状态无关;
  - 暴露不确定只影响 seen 游标;
  - 下次唤醒时按 seq 补发, 标明「可能已读过」, 不再需要靠「绝不重投」来避免重复执行。
  - 注入里 duty 带 msg id, 模型再看到同一个 id 也不会当成新活。
- **绝对数量**:
  - B-2/B-3 下注入次数和今天大致持平 (今天一次委派 = 派活注入 + 回执注入; room 模型 = task 唤醒 + reply 唤醒)。
  - B-1 会把注入次数放大到约 (N−1) 倍, 不确定事件和探测争用随之同比上升。

**待人拍**: 唤醒判据 (推荐 B-3、订阅默认关); 回合预算 M 的取值。

---

## C. 出站: 删掉 topOnly 之后谁给企微发, daemon 还剩什么

### C1 谁给企微发

| 选项 | 做法 | 代价 |
|---|---|---|
| **C-1 全量镜像** | 绑定 room 里每条 msg (除系统内部行) 都由传输适配器发进企微, 气泡头署作者名 | 人能看见所有进了这个 room 的往来; 噪声只能靠 wizard 自己的结构选择 (开跟进 room) 和额度来控 |
| C-2 room 级受众开关 (mirror: all / to-humans / manager-only) | 绑定 room 可以配置只镜像部分消息 | 这就是**换了个名字的 topOnly**: 「谁的话人能看见」又成了 daemon 侧的分散判定 (前稿 D3) |
| C-3 消息级可见性 (say / whisper) | wizard 每条消息自选 | 违反「room 内每个参与者都收到」(原话 1) |

**推荐 C-1**。噪声控制写进宪章: 管家遇到多步的活**默认开跟进 room** (人不在里面), 结论由管家在主 room 里用 chat_reply 交代。只有需要人和执行者直接对话时, 才把执行者拉进主 room。这正是原话 5 的「让 wizard 自己决定」。

**待人拍**: C-1 还是 C-2。C-2 等于保留 topOnly 的影子。

### C2 终句怎么处理 (这是 P4 最大的风险点)

| 选项 | 做法 | 代价 |
|---|---|---|
| **F-1 终句零语义 + 立即提醒一次 + 升级** | 一轮结束时, 如果有唤醒它的 duty 还没关, 而这一轮又没调 chat_reply, 当场注入一次「你有 X 未交代, 用 chat_reply」(cf3e0b3 的 strictUndeliveredNotice 已经这么做); 再无动作, 就写一条系统行给 manager / 提问者 | 模型写完散文终句就忘了调工具, 是**已知的高频失误**: strict 群 6 天修了 4 次「答了没发出去」(26be339 / c1f8557 / cf3e0b3 / 8fddfa0)。代价是每次失误多起一轮 |
| F-2 终句兜底自动投递 | 这一轮没调 chat_reply 时, 把终句作为 reply(re=当前 duty, status=done) 自动投递 | **把 199 次返修的病根原样留下**: 要判轮终 (第三方 TUI 转录)、判这句是不是定论 (中途叙述 39b6dfd)、判它属于哪个 duty (出处) |
| F-3 自动投递成「草稿」 | 终句落成 status:"progress" 的 reply (不关 duty), 人和提问者能看到 | 仍然依赖轮终推断, 只是错了的代价变小; 群里会多出一堆半成品 |

**推荐 F-1**, 以 P3 试点数据作为闸门: 显式完成率要 ≥90% 才进 P4。

**待人拍**: F-1 还是 F-3。F-2 不推荐。

### C3 daemon 侧还剩什么

| 留下 | 形态 | 来源 |
|---|---|---|
| 成员 ACL | append 时校验 author ∈ members; 非成员 403 | 取代 strict-gate sayVerdict 的 403 那一支 |
| 额度 | 每轮 3 / 每 room 每分钟 10, 加回合预算 (§B2) | openSayMeter 改为全量生效 |
| 去重 | 账本幂等键 | 取代 chatReplySeen 内存集合 |
| 传输 | Xport 状态机 (企微: WS 发送 + ack; pane: 注入 + 证据) | message-events 的 execution/exposure **只留在 pane 传输这一侧** |
| 气泡 | 人话 msg 行上的 bubble {streamId, frame, expires}: **第一条 re 它的 reply 覆盖占位气泡**, 之后的 reply 作为新消息; 不论作者是谁、有没有移交过 | 取代 replyBubbles / claimReplyBubble / transferReply (mirror-bridge.ts:3285-3340)。气泡归属挂在人话上而不是 wizard 上, transfer 不需要同步任何状态 (前稿 D5 消失) |
| 义务提醒 | 一个 duty watcher: holder 闲着且 duty 没关 → 提醒 (沿用 idle-nudge 的上限 MAX_CYCLES=6) | 合并 obligation-watch / idle-nudge / strict-delivery-notices 三套 |
| 审批 / 提问卡 | 卡片发到**本轮唤醒所属 duty 的 room** (显式), 没有 duty 时发到 wizard 的绑定 home room | 取代按 channel/asker 推断 |
| 管家手闸 | 由 role (steward kind, 或绑定 room 的 manager) 触发, 不再由 topOnly‖strict 触发 | approval.ts / steward-guard.ts 触发条件改写 |

### C4 人和 wizard 是不是同一个口子

是。
- 人的企微消息由 daemon 以 origin:"inbound" append 成 msg; wizard 用工具以 origin:"tool" append。
- 两者走同一个 append 函数: ACL → 额度 → 去重 → 落盘 → 传输扇出 (企微镜像 + 按唤醒判据注入 pane)。
- 和现状的差别: 现在 strict 只覆盖部分群 (live 配置 4 个); room 模型是全量。**所有 implicit 群 (live 配置 11 项里的 7 项, 加上没有写进 chatPolicy 的存量群) 在 P4 同时改变行为**: 终句不再进群。

---

## D. 单聊退化成隐式 room, 会不会让 room 数爆炸

**实测** (routes.jsonl 现存窗口, 约 20 天):
- wizard 间的 route 有 391 行, 涉及 **230 个不同的无序对**, 其中 150 对只用过一次、41 对用过 ≥3 次;
- 派活方 60 个, 中位数只派给 1 个 worker, 最多的一个派给过 41 个;
- 跨 base 的只有 10 行。

| 选项 | 做法 | room 数 | 代价 |
|---|---|---|---|
| **D-1 每对一个持久 DM room** (按成员对规范化: dm:<a>\|<b>) | room_open({with:[b]}) 或第一次对非共同成员 chat_say 时懒创建, 之后复用; 闲置 7 天归档, 有新消息就唤醒 | ≤230 / 20 天, 活跃集在几十个 | 同一对之间的多件活混在一个 room 里 (靠 re 线程区分); 派活大户 (41 对) 在关系图上要聚合 |
| D-2 每件委派一个任务 room | 每次 delegate 开一个 room, 结论回原 room 后归档 | 约 391 / 20 天, 用完即归档 | 线程最干净; 但 room 和任务一一对应, 等于把 duty 做成了 room, 实体重叠 |
| D-3 不设隐式 DM, 一切显式 room_open | 两人 room 只是成员数为 2 的普通 room; 按**成员集规范化复用** (同一组成员复用同一个 room) | 同 D-1 | 语义最统一 (DM 只是特例); 但模型必须先 room_open 才能对另一个 wizard 说话, 多一步 |

**推荐 D-1 + D-3 的规范化规则**:
- 无绑定、2 人的 room 按成员对唯一, chat_say({to:[b]}) 在没有共同 room 时自动落进 dm:<a>|<b>;
- 3 人以上的 adhoc room 必须显式 room_open, 不做规范化复用 (同一组人可以并行好几个话题)。

**跨群用同一套语义**:
- A (群 G1 的成员) 要和 B (群 G2) 协作, 有三条路: 用 DM room; 用 room_open 拉起一个 3 人 room; 或者 room_join 申请进 G2 的绑定 room。
- 三条路是同一组原语, 没有专门的「跨群」路径。
- 现在跨 base 的 route 只有 10 行, 跨群是低频场景, 不需要专门优化。

**rolepage 层面**: 2 人的无绑定 room 画成 wizard 之间的一条**边**而不是节点 (§F), 派活大户不会把图挤爆。

**待人拍**: 没有共同 room 时, chat_say(to) 是自动落进 DM room (D-1), 还是 400 要求先 room_open (D-3)。

---

## E. manager = 第一个成员: 状态机, 以及和 parent 链的关系

### E1 manager 的定义

| 选项 | 做法 | 代价 |
|---|---|---|
| E-1 纯按入群顺序 | manager = 当前最早入群的 wizard 成员; 离开就自动轮到下一个 | 实现最简单, 可重放; 但「谁最早」常常是偶然的 (回填迁移时尤其如此) |
| **E-2 显式字段 + E-1 作为继任规则** | manager 字段在 room_open / 绑定时取第一个成员 (绑定 room = 绑定的管家实例); 可以用 room_manager({room, to}) 显式移交; manager 离开时按入群顺序继任 | 多一种 op (manager.set); 语义清楚 |
| E-3 manager 集合 (多人) | 任一 manager 都能审批 | 审批并发、谁负责提醒都要再定; 当前规模 (每群 1 个管家) 用不上 |

**推荐 E-2**, 人在 room 里有超集权限 (随时可以批准、移出、指定 manager), 但人不参与继任排序。
- **企微 room 的第一个成员**: 按原话 3 和 4, 取绑定的管家实例 (onboarding 时创建)。
- 人是这个 room 的 host, 而不是 manager。

### E2 申请状态机 (room_join)

```
none ─room_join─▶ requested ─manager/人 批准─▶ member
                     │ ├─拒绝─▶ denied (可再申请)
                     │ ├─申请者撤回─▶ withdrawn
                     │ └─manager 离开/换人─▶ requested (改派给新 manager, 不丢)
```

- join-req 本身就是给 manager 的一条 duty: 会唤醒 manager, 也能被 duty watcher 提醒。**不设超时** (延续「不清扫」原则)。
- **免审入群**:
  - manager 邀请 (room_invite);
  - 人点名 (.name);
  - 成员把**自己直属的子 wizard** 拉进来 (spawn({room}), 与 parent 链对齐)。
- 成员邀请非直属的 wizard, 也要走 manager 审批。这一条可选, 见待人拍。

### E3 离开与退役

- **成员离开**:
  - 它手上该 room 的 open duty 一律由 daemon 写一条 status:"canceled" 的系统 reply ("X 已离开"), 唤醒提问者。
  - 选项: 改成转给 manager。推荐 canceled, 理由是显式, 不替人假定接手者。
- **manager 离开**: 按入群顺序继任; 没有 wizard 成员了就由人 host; 一个成员都不剩就归档。
- **实例被 parent 结束** (现有规则: 只有自己或直属 parent 能结束, index.ts:4709/4735): 从所有 room 退出 (leaveEverywhere), 继任和 duty 取消同上。
  - 不因为它当着 manager 就阻止结束。今天 active plan 会阻止退役, 那是 plan 的规则; 这里不新增阻塞, 以免死锁。

### E4 谁管谁

- **parent 管生命周期**: 生、结束、改名、职责。
- **manager 管 room**: 入群、移出、提醒。
- **两条链正交, 冲突时 parent 优先**: manager 只能把成员移出 room, 不能结束实例; parent 可以结束一个正在当 manager 的子 wizard (触发继任)。

**待人拍**: E-2 还是 E-1; 成员拉自己的子 wizard 是否免审; 成员离开时 duty 是 canceled 还是转给 manager。

---

## F. rolepage: 关系图、room 历史、wizard 全部聊天

### F1 图数据 (WorldFacts 新增 rooms 字段)

```
rooms: [{ id, kind, title, bind?, manager, state,
          members: [{ who, kind: wizard|human, via, since }],
          last: { seq, at, author, preview }, openDuties }]
```

- 来源是 room 账本的 registry (可从各 room 文件重建), 由 daemon 推给 svr, 和现在的 world push 同一条路 (shared/world.ts:123)。
- 老 daemon 推来的快照没有 rooms 字段时, 退回旧视图。
- **图的画法**:
  - 二部图: room 节点 ↔ 参与者节点 (wizard / user)。
  - 2 人的无绑定 room 画成参与者之间的边。
  - parent 家谱边作为可切换的一层 (现在 chat.js:1795 relations / :2040 forestOf 有现成的布局, 可以复用)。

### F2 点 room 看历史

- 新接口 /api/room?id&before&limit 直接读 rooms/<id>.jsonl。每条 msg 带 turn 链接, 点开看这一轮的过程框 (工具调用仍取自 turn store)。
- **现在的 role-view.ts (804 行) 要从 turn 记录重建「消息」**: injectEchoesOf、senderOf、strictPostsOf、convKeyOf、convsOf, 全靠推断谁说的、在哪说的 (§前稿 D4)。room 模型里消息是一等行, 这些**大部分删除**, 只保留 sessionsOf / marksOf / RoleStatus。
- chat-log.ts (206 行, 现在从 transcript 按 role → chat → target 三级收窄) 改成 room_read: 按 room 从账本读, 可选 from 过滤; renderChatLog 的纯文本渲染可以复用。

### F3 点 wizard 看全部

| 选项 | 内容 | 代价 |
|---|---|---|
| **W-1 它说的 + 指向它的** | author = 它, 或 to ∋ 它, 或 re 它的消息, 跨 room 按时间合并, 每条标出 room | 量可控; 上下文要靠点进 room 去看 |
| W-2 它所在全部 room 的全部消息 | 跨 room 全量合并 | 管家在几十个 room 里, 量会爆; 没有重点 |
| W-3 W-1 加每条前后各 1 条上下文 | 折中 | 渲染复杂一些 |

**推荐 W-1 为默认, 加一个开关切到 W-2**。

### F4 前端重写量 (web/chat.js 2819 行)

| 块 | 现位置 | 处理 | 估算 |
|---|---|---|---|
| 左侧聊天列表 (convOf / convItem / renderConvs / clickItem / selectConv …) | 约 :380-690、:1545-1620 | **删除** | -400 行 |
| 关系图 | :1795-2100 | 改成 room 二部图 + 边聚合 | 重写约 350 行 |
| 消息面 (rowHTML / loadMsgs / upsertMsg / 未读) | :1250-1450 | 改用 room msg schema (author / to / re / status 胶囊) | 改约 250 行 |
| 治理 / 成员面板 (renderGov / renderMemb) | :1121-1165 | 改读 room 成员 / manager / 申请 | 改约 60 行 |
| plan 视图、用量、会话选择 | 其余 | 不动 | 0 |

合计约 1000–1100 行 (占 35–40%)。后端: role-view.ts 约 -600 / +300, chat-http.ts 新增 2 个接口。

**验收**: 照 feedback 记忆, 用 playwright 实测 DOM: 节点数 = room 数 + 参与者数; 3 个样本群的 room 历史条数与 chat-records / turn store 对得上。

**待人拍**: W-1 还是 W-2 做默认; 旧侧栏在过渡期是否保留 ?legacy=1。

---

## G. 分期

### 总表

| 期 | 内容 | 行为变化 | 回滚 | 进下一期的闸门 |
|---|---|---|---|---|
| **P0 契约** | 纯核心: room 账本 fold、ACL、duty 派生、唤醒判据、去重与预算 (纯函数加单测); 不接线 | 无 | 删文件 | 新单测全绿; 设计稿 A–F 拍板 |
| **P1 影子账本 (双写)** | 所有现有出入口同时写 room 账本: inbound 人话、tell_peer / delegate、回执落定、notify / chat_say / chat_reply / send_file、进群的终句。**不读** | 无 | 停写并删除 rooms/ | 每日对账脚本: ① 未结 duty 集合 = 未结 route 集合; ② 每个群的 msg 数 ≈ chat-records 加 turn store 的数; 连续 7 天差异为 0 (或可解释) |
| **P2 视图层别名** | rolepage 新图、room 历史、wizard 全部读影子账本; read_chat 加 room 参数 (绑定 room id = chat base, DM = dm:<a>\|<b>); 旧侧栏挂 ?legacy=1 | 只有读侧变化 | 前端切回 legacy | playwright 实测 (§F4); role-* 测试仍绿; 新增 room-view 测试 |
| **P3 新工具并存 + 试点** | MCP 加 room 系列工具, chat_say / chat_reply 在所有群可用 (今天 implicit 群会 409, index.ts:2178); **显式 chat_reply 能关 duty, 老的终句路径同时有效 (显式优先)**; 宪章把 room 工具标为首选; 选 1–2 个试点群加开关 (chatPolicy.room:true), 在这些群里终句不再进群 | 试点群改变, 其余群不变 | 关掉试点开关 | **试点 7 天显式完成率 ≥90%** (= 用 chat_reply 关闭的 duty / 全部关闭的 duty), 「答了未交付」提醒后自愈率 ≥95%; 达不到就回到 §C2 重新选 F-3 |
| **P4 一次切换 (BREAKING, 建议升主版本)** | room 账本成为唯一写者; routes.jsonl 冻结; 删掉终句路由、topOnly、speech、公开私聊降级; 所有活着的 wizard 强制 /new (宪章和 MCP schema 都变了, 老会话没有新工具); 5 条未结 route 和 3 条排队事件转成 duty | **全部群同时改变** | 只能整版回退到 P3 的二进制 + 冻结前的 routes.jsonl (切换前快照) | 见下面 P4 验收清单 |
| **P5 清理** | 删除老 path (见下表); CHANGELOG 记 BREAKING 和迁移说明 | 无 | — | typecheck 通过; 死代码扫描清零 |

### 哪些能先当视图层别名落 (低风险)

- P1 的影子写;
- P2 的全部 (图、room 历史、read_chat room 参数);
- P3 的新工具 (与老路径并存)。

### 哪些必须一次切换

- 终句路由删除;
- topOnly / speech 删除;
- 唯一写者翻转;
- 强制 /new。

**理由**: 同一个群里两种完成语义 (终句与显式) 长期并存, 正是前稿 D2 的病; 两种出站判定并存, 正是 D3 的病。所以兼容期只允许在**试点群和非试点群之间**并存, 不允许在同一个群里并存。

### P4 验收清单 (live)

1. 人在绑定 room 里发一句没点名的话 → 只唤醒 manager; 结论用 chat_reply 覆盖占位气泡。
2. .name 点名一个非成员 → 它自动以 mention 方式入群并被唤醒。
3. 管家 room_open 跟进 room 派活 → 执行者 reply → 只唤醒管家 → 管家在主 room 交代; 企微里只出现管家的话。
4. room_transfer 移交人话 duty → 接手者 reply 覆盖气泡 (原 cd95bd8 / 7bf7e9b 场景)。
5. room_join → manager 批准 / 拒绝; manager 离开后申请改派给继任者。
6. 一轮写完散文终句没调工具 → 当轮提醒一次 → 补发成功; 再不补发就有系统行给提问者。
7. reload 发生在 duty 中间 → 按游标补发, 不重复执行 (注入带同一个 msg id)。
8. 交接 (handoff) 前后, rolepage 上同一个 room 的历史连续 (原 967e8c6 场景)。
9. 连续 48 小时, 企微里没有任何一条来自终句的消息 (只有 chat_say / chat_reply / send_file / 系统行)。
10. 额度、回合预算触发时返回 409 / 写系统行, 不会静默丢消息。

### 会被打破的现有测试 / 回归, 以及怎么改

| 现有 | 原因 | 处理 |
|---|---|---|
| strict-cards / strict-channel / strict-chat / strict-default / strict-delivery-nudge / strict-detail / strict-final / strict-members / strict-new-ack / strict-obligation / strict-outbound / strict-read / strict-switch (13 个) | speech 删除 | 语义并入 room-acl / room-duty / room-budget / room-xport 新测试; strict-switch、strict-default **删除** |
| progress-receipt / receipt-unrecognized / receipt-guards / result-input-coverage / router-core-source / router-routing / router-tier | 终句结算和 router 删除 | 改写为 room-duty (reply status 四态、re 数组、游标覆盖); router-tier 若只测档位则保留 |
| receipt-inbox / receipt-timing | 已经是基线红 (引用的 daemon/receipts.js 已删) | 删除 |
| wizard-mark / merged-envelope / reminder-legacy / pane-delivery / chat-log-key / chat-record | 依赖 parseEnvelope、parseClosing、chat-log、chat-records | 把信封断言改成「注入头渲染」断言; chat-log-key 改为 room_read; chat-record 删除 |
| handoff-carry-from / handoff-round | 依赖 convKeyOf 与 carry 出处 | 改为「交接只带游标集合, 历史按 room 连续」 |
| answer-transfer-format / answer-transfer-mirror / message-footer / message-format | topOnly 尾注、transfer 气泡 | 改为人话行 bubble 断言 |
| charter / roster-pyramid / onboarding / apprentice / steward-guard / tool-hints / allow-rules | topOnly 宪章节、手闸触发条件、tell_peer 名字 | 断言改用 room 语义与新工具名; 手闸改为按 role 触发 |
| group-members / class-routing | members.json | 改读 room 成员 |
| scripts/receipt-regress/run.mjs (live) | 整套场景按回执语义写 | 改写为 room-regress: §P4 验收清单的 1–10 条 |

---

## H. 老 path 去向总表 (删除 / 替代 / 保留)

| 老 path | 去向 | 新模型里对应的显式字段 |
|---|---|---|
| router.ts onFinal / finalKind / finalReleased / retellOps (:448-545) | **删除** | reply.status (完成) |
| router.ts escalate / isOrphaned / chain 冒泡 (:408-431) | **删除** | msg.for 只记血缘 |
| router.ts step / foldJournal 的 journal 纪律 | **保留** (抽到 shared/journal) | — |
| router.ts mergeRows / alias / 同对单槽 | 删除 | re 数组 |
| peers.ts parseClosing / addressedResults / unquoteMarkLine / completionKeyword / receiptKeyword (:476-601) | **删除** (不再在关键路径上) | reply.status |
| mirror-bridge.ts eventFinalGate / turnSilent / chatOriginOnly / brief 流式气泡的终句投递 | **删除**; mirror 只写 turn store | 消息只由工具产生 |
| mirror-bridge.ts replyBubbles / claimReplyBubble / transferReply (:3285-3340) | **替代** | 人话 msg.bubble |
| message-events.ts execution × exposure | **保留但缩小**: 只管 pane 传输, 不参与完成 | Xport.state、cursor.seen |
| message-events.ts settleAddressedResults / resultCorrectionInputs / inputIds 覆盖 | 删除 / 替代 | 游标比较 |
| index.ts topOnlyMuted ×4 (:1918, :1941, :2189, :2226, :2330)、strict-gate topOnlyVerdict | **删除** | 成员资格 (发言权) |
| strict-gate sayVerdict / openSayMeter | **替代**: 403 支变成 ACL, 额度全量生效 | Member 行 |
| index.ts tellPeerAsInner 的 wantPublic / isPublic / handedChat (:3065-3073) | **删除** | msg.room |
| tell_peer / delegate / notify / chat_ask | P3 期间作为 chat_say 的语法糖, P5 删除 (delegate 的选人逻辑保留, 产出改为 chat_say) | — |
| return: self / detach / transfer / none | 替代 (§A2) | duty.move、expect |
| members.json / chat-records (state/chats) / obligations.json / strict-delivery-notices.json / idle-nudges.json | 替代 (并入 room 账本 + duty watcher) | Member / Msg / duty |
| chatPolicy.topOnly / speech / known-chats 的 strict 缺省 | **删除** (config schema BREAKING) | — |
| chatPolicy.steward / stewardBudget | 保留 (绑定 room 的 manager 和手闸来源) | Room.manager |
| shared/reminder.ts parseEnvelope 在读侧 (read_chat / rolepage / 恢复) 的使用 | **删除**; renderTail 只负责渲染 | msg.author / room |
| handoff.ts carry 的 channel / from / speaker 印章 | **替代**: 只带游标集合 | Member.cursor |
| chat-log.ts (transcript 拼装) | 替代为 room_read | — |
| shared/role-view.ts 消息重建 (allMessages / senderOf / convKeyOf / convsOf / strictPostsOf …) | 大部分删除, 换成 room-view | — |
| notices.ts (名册增量) | 保留 (名册变动不是 room 消息) | — |
| plans / plan-reminders | 保留; 「对外欠账」改为查 duty | msg.planId |
| turn-state 词表 | 保留, 对应到 duty 上 | — |
| peek_peer (transcript 读) | 保留 | — |

---

## I. 风险与未决

1. **模型忘了调 chat_reply** (§C2): 这是推荐方向最大的风险。P3 试点用数据做闸门。
2. **一个实例加入多个 room, 上下文会被污染**: 几个 room 的消息交替进同一个会话。v3 的「管家每群一个实例」已经部分回答了这个问题。宪章要写明: 话题重就开新实例, 不要把一个实例挂进十个 room。
3. **多 bot 硬隔离** (一个实例一个 bot): room 只在本实例内有效; 跨 bot 只能走企微频道, 不在本次范围内。
4. **topic 帖子**: 每个帖子一个 room (kind:topic-post), 由频道管家当 manager; 回复走 replyOk 评论到帖子上。现在只有 3 个帖子, 影响很小。
5. **微信 ClawBot 的 ctxTtlSec 出站压着**: 留在传输适配器里, 语义不变。

---

## 待人拍清单 (汇总)

| 钉子 | 推荐 | 备选 |
|---|---|---|
| A 落点 | A-1b 每 room 一个文件, routes 冻结 | A-2 双账 / A-3 并进 routes |
| A 迁移 | M-2 影子双写 + 切换时排空; 成员只回填活跃的 | M-1 一次性 / M-3 懒迁移 |
| B 唤醒 | B-3 (点名 + manager 兜底 + 静默只读 + 可选订阅), 回合预算 M=20 | B-1 全员 / B-2 不带订阅 |
| C 镜像 | C-1 全量镜像 | C-2 受众开关 (topOnly 的影子) |
| C 终句 | F-1 零语义 + 提醒 + 升级, P3 用 ≥90% 做闸门 | F-3 草稿; F-2 不推荐 |
| D 单聊 | D-1 按成员对规范化的 DM room, 自动落入 | D-3 必须先 room_open / D-2 每件活一个 room |
| E manager | E-2 显式字段 + 按入群顺序继任, 人作 host 有超集权 | E-1 纯顺序 / E-3 多 manager |
| E 细则 | 自己的子 wizard 免审; 成员离开时 duty 记 canceled | 成员离开时 duty 转给 manager |
| F 默认视图 | W-1 (它说的 + 指向它的), 可切到 W-2 | W-2 / W-3 |
| G 切换 | P0–P3 可回滚, P4 一次切换 (升主版本) | — |
